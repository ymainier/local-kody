import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { keychain } from "./keychain.ts";
import { oauthPresetsFile } from "./paths.ts";
import {
  getIntegration,
  listIntegrations,
  saveIntegration,
  setIntegrationState,
  type Integration,
} from "./store.ts";

// An integration is a saved OAuth connection. The agent can spend its token
// through a {{integration:id}} placeholder but can never read one, the same
// deal secrets get.
const refreshMarginMs = 60_000;
const approvalWindowMs = 5 * 60_000;

export type Preset = {
  authUrl: string;
  tokenUrl: string;
  scopes: Array<string>;
  allowedHosts: Array<string>;
  authParams?: Record<string, string>;
  tokenAuth?: "body" | "basic";
  redirectPort?: number;
  note: string;
};

export function readPresets() {
  return JSON.parse(readFileSync(oauthPresetsFile, "utf8")) as Record<
    string,
    Preset
  >;
}

// The id becomes a Keychain account name and goes into a `security` command
// line, so keep it to characters that cannot be read as another argument.
const idPattern = /^[a-z0-9][a-z0-9_-]*$/;

function keyFor(id: string, part: string) {
  return `integration:${id}:${part}`;
}

export function addIntegration(input: {
  id: string;
  clientId: string;
  clientSecret?: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: Array<string>;
  allowedHosts?: Array<string>;
  redirectPort?: number | null;
  tokenAuth?: "body" | "basic";
}) {
  if (!idPattern.test(input.id)) {
    throw new Error(
      `Integration id "${input.id}" must match ${String(idPattern)}`,
    );
  }
  const preset = readPresets()[input.id];
  const authUrl = input.authUrl ?? preset?.authUrl;
  const tokenUrl = input.tokenUrl ?? preset?.tokenUrl;
  if (!authUrl || !tokenUrl) {
    throw new Error(
      `No preset for "${input.id}", so pass --auth-url and --token-url. Presets: ${Object.keys(readPresets()).join(", ")}`,
    );
  }
  const allowedHosts = input.allowedHosts?.length
    ? input.allowedHosts
    : (preset?.allowedHosts ?? []);
  if (allowedHosts.length === 0) {
    throw new Error(
      `No approved hosts for "${input.id}". Pass --host <hostname> at least once.`,
    );
  }
  return saveIntegration({
    id: input.id,
    authUrl,
    tokenUrl,
    clientId: input.clientId,
    scopes: input.scopes?.length ? input.scopes : (preset?.scopes ?? []),
    allowedHosts,
    authParams: preset?.authParams ?? {},
    tokenAuth: input.tokenAuth ?? preset?.tokenAuth ?? "body",
    redirectPort:
      input.redirectPort === undefined
        ? (preset?.redirectPort ?? null)
        : input.redirectPort,
  });
}

export async function setClientSecret(id: string, clientSecret: string) {
  if (!getIntegration(id)) throw new Error(`No integration "${id}"`);
  await keychain().set(keyFor(id, "client_secret"), clientSecret);
  return { saved: true };
}

export function allowIntegrationHost(id: string, host: string) {
  const config = getIntegration(id);
  if (!config) throw new Error(`No integration "${id}"`);
  return saveIntegration({
    ...config,
    allowedHosts: [...new Set([...config.allowedHosts, host])],
  });
}

// Tokens are never in here, by design: this is what both the CLI and the
// agent's integrationList see.
export function describeIntegrations() {
  return listIntegrations().map((integration) => ({
    id: integration.id,
    status: integration.status,
    scopes: integration.scopes,
    allowedHosts: integration.allowedHosts,
    expiresAt: integration.expiresAt,
    lastError: integration.lastError,
  }));
}

type TokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function requestToken(
  config: Integration,
  clientSecret: string,
  fields: Record<string, string>,
) {
  const form = new URLSearchParams({ client_id: config.clientId, ...fields });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    // GitHub answers form-encoded without this; everyone else ignores it.
    accept: "application/json",
  };
  if (config.tokenAuth === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    form.set("client_secret", clientSecret);
  }
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `token endpoint returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const payload = JSON.parse(text) as TokenPayload;
  // Some providers answer 200 with an error body.
  if (payload.error) {
    throw new Error(payload.error_description ?? payload.error);
  }
  if (!payload.access_token)
    throw new Error("token endpoint returned no access_token");
  return payload;
}

async function storeTokens(id: string, payload: TokenPayload) {
  await keychain().set(keyFor(id, "access_token"), payload.access_token ?? "");
  // A refresh response often omits the refresh token, which means keep the one
  // you have rather than forget it.
  if (payload.refresh_token) {
    await keychain().set(keyFor(id, "refresh_token"), payload.refresh_token);
  }
  return setIntegrationState(id, {
    status: "connected",
    expiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : null,
    lastError: null,
  });
}

const pending = new Map<string, Server>();

function listenForCallback(config: Integration) {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(config.redirectPort ?? 0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

// The agent cannot click "Allow", so this returns the URL and gets out of the
// way: the listener keeps waiting in the daemon while the human approves, and
// integrationList is where the outcome shows up.
export async function startIntegration(input: {
  id: string;
  scopes?: Array<string>;
}) {
  const config = getIntegration(input.id);
  if (!config) {
    throw new Error(
      `No integration "${input.id}". Ask the user to run: npm run integration -- add ${input.id} --client-id <id> --client-secret <secret>`,
    );
  }
  const clientSecret = await keychain().get(keyFor(input.id, "client_secret"));
  if (clientSecret === null) {
    throw new Error(
      `Integration "${input.id}" has no client secret. Ask the user to run: npm run integration -- add ${input.id} --client-id <id> --client-secret <secret>`,
    );
  }
  pending.get(input.id)?.close();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const { server, port } = await listenForCallback(config);
  pending.set(input.id, server);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const scopes = input.scopes?.length ? input.scopes : config.scopes;

  const finish = (status: "connected" | "failed", detail: string) => {
    pending.delete(input.id);
    server.close();
    if (status === "failed") {
      setIntegrationState(input.id, {
        status: getIntegration(input.id)?.status ?? "not_connected",
        expiresAt: getIntegration(input.id)?.expiresAt,
        lastError: detail,
      });
    }
  };

  const timer = setTimeout(() => {
    finish(
      "failed",
      `No approval within ${approvalWindowMs / 60_000} minutes. Run integrationStart again.`,
    );
  }, approvalWindowMs);
  timer.unref();

  server.on("request", (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        response.statusCode = 404;
        return response.end("Not the callback.");
      }
      const say = (message: string) => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<!doctype html><meta charset="utf-8"><title>local-kody</title><body style="font:16px system-ui;padding:3rem"><p>${message}</p><p>You can close this tab.</p>`,
        );
      };
      try {
        if (url.searchParams.get("state") !== state) {
          throw new Error("state did not match; ignoring this callback");
        }
        const denied = url.searchParams.get("error");
        if (denied) throw new Error(denied);
        const code = url.searchParams.get("code");
        if (!code) throw new Error("callback carried no code");
        const payload = await requestToken(config, clientSecret, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        });
        await storeTokens(input.id, payload);
        clearTimeout(timer);
        say(`Connected <strong>${input.id}</strong>.`);
        finish("connected", "");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        clearTimeout(timer);
        say(`Could not connect <strong>${input.id}</strong>: ${detail}`);
        finish("failed", detail);
      }
    })();
  });

  const authorizeUrl = new URL(config.authUrl);
  const query = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...config.authParams,
    ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
  };
  for (const [key, value] of Object.entries(query)) {
    authorizeUrl.searchParams.set(key, value);
  }
  const href = authorizeUrl.toString();
  if (process.platform === "darwin" && process.env.KODY_OPEN !== "none") {
    execFile("open", [href], () => {});
  }
  return {
    id: input.id,
    authorizeUrl: href,
    redirectUri,
    expiresAt: new Date(Date.now() + approvalWindowMs).toISOString(),
    message: `Ask the user to approve ${input.id} in the browser (the tab should already be open, otherwise send them the URL). You cannot do this step. Then call kody.integrationList() to see whether the status became "connected".`,
  };
}

export async function revokeIntegration(id: string) {
  if (!getIntegration(id)) throw new Error(`No integration "${id}"`);
  pending.get(id)?.close();
  pending.delete(id);
  await keychain().remove(keyFor(id, "access_token"));
  await keychain().remove(keyFor(id, "refresh_token"));
  setIntegrationState(id, {
    status: "not_connected",
    expiresAt: null,
    lastError: null,
  });
  return { id, status: "not_connected" };
}

// One refresh per integration at a time: two parallel runs hitting an expired
// token must not both spend the refresh token, since providers that rotate it
// would invalidate the loser's.
const refreshing = new Map<string, Promise<string>>();

async function performRefresh(id: string) {
  const config = getIntegration(id);
  if (!config) throw new Error(`No integration "${id}"`);
  const reconnect = `Run kody.integrationStart({ id: '${id}' }) and ask the user to approve it in the browser.`;
  const clientSecret = await keychain().get(keyFor(id, "client_secret"));
  const refreshToken = await keychain().get(keyFor(id, "refresh_token"));
  if (clientSecret === null || refreshToken === null) {
    setIntegrationState(id, {
      status: "needs_reconnect",
      lastError: "no refresh token stored",
    });
    throw new Error(
      `Integration "${id}" has no refresh token, so its access token cannot be renewed. ${reconnect}`,
    );
  }
  try {
    const payload = await requestToken(config, clientSecret, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    await storeTokens(id, payload);
    return payload.access_token ?? "";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setIntegrationState(id, {
      status: "needs_reconnect",
      expiresAt: config.expiresAt,
      lastError: detail,
    });
    throw new Error(
      `Integration "${id}" could not refresh its token (${detail}). ${reconnect}`,
    );
  }
}

function refreshAccessToken(id: string) {
  const running = refreshing.get(id);
  if (running) return running;
  const started = performRefresh(id).finally(() => refreshing.delete(id));
  refreshing.set(id, started);
  return started;
}

// What the gateway calls for each {{integration:id}} it finds. The host check
// comes first so an unapproved host never costs a refresh.
export async function accessTokenFor(id: string, host: string) {
  const config = getIntegration(id);
  if (!config) {
    throw new Error(
      `No integration "${id}". Ask the user to run: npm run integration -- add ${id} --client-id <id> --client-secret <secret>, then call kody.integrationStart({ id: '${id}' }).`,
    );
  }
  if (!config.allowedHosts.includes(host)) {
    throw new Error(
      `Integration "${id}" is not approved for host ${host}. Ask the user to run: npm run integration -- allow ${id} ${host}`,
    );
  }
  const reconnect = `Run kody.integrationStart({ id: '${id}' }) and ask the user to approve it in the browser.`;
  if (config.status === "not_connected") {
    throw new Error(`Integration "${id}" is not connected yet. ${reconnect}`);
  }
  if (config.status === "needs_reconnect") {
    throw new Error(
      `Integration "${id}" needs reconnecting (${config.lastError ?? "refresh failed"}). ${reconnect}`,
    );
  }
  const token = await keychain().get(keyFor(id, "access_token"));
  const expiresInMs = config.expiresAt
    ? Date.parse(config.expiresAt) - Date.now()
    : Infinity;
  if (token !== null && expiresInMs > refreshMarginMs) return token;
  return await refreshAccessToken(id);
}
