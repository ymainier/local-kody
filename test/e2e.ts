// Drives the MCP proxy over stdio exactly as Claude Desktop would, against a
// daemon started here on a temp home and socket.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolText = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ExecuteResult = {
  result?: unknown;
  error?: string;
  logs: Array<string>;
  durationMs: number;
  runId?: string;
  replayed?: boolean;
};
type RunSummary = {
  id: string;
  surface: string;
  status: string;
  error: string | null;
};

// A fake OAuth provider: it does a real PKCE check on the code exchange, hands
// out a token that is always inside the refresh margin, and can be told to
// refuse the next refresh.
const oauth = {
  challenge: "",
  refreshes: 0,
  failRefresh: false,
  accessToken: "at-1",
};

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function pkceChallengeOf(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function serveOauth(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (path === "/oauth/authorize") {
    const query = new URL(request.url ?? "", "http://127.0.0.1").searchParams;
    oauth.challenge = query.get("code_challenge") ?? "";
    const back = new URL(query.get("redirect_uri") ?? "");
    back.searchParams.set("code", "fake-code");
    back.searchParams.set("state", query.get("state") ?? "");
    response.statusCode = 302;
    response.setHeader("location", back.toString());
    return response.end();
  }
  const form = new URLSearchParams(await readBody(request));
  const fail = (error: string) => {
    response.statusCode = 400;
    response.end(JSON.stringify({ error }));
  };
  if (form.get("client_id") !== "cid" || form.get("client_secret") !== "csec") {
    return fail("invalid_client");
  }
  if (form.get("grant_type") === "refresh_token") {
    if (oauth.failRefresh) return fail("invalid_grant");
    if (form.get("refresh_token") !== "rt-1") return fail("invalid_grant");
    oauth.refreshes += 1;
    oauth.accessToken = `at-${oauth.refreshes + 1}`;
    // Always inside the 60 s refresh margin, so every use exercises refresh.
    return response.end(
      JSON.stringify({ access_token: oauth.accessToken, expires_in: 30 }),
    );
  }
  if (pkceChallengeOf(form.get("code_verifier") ?? "") !== oauth.challenge) {
    return fail("invalid_grant");
  }
  response.end(
    JSON.stringify({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 30,
    }),
  );
}

// Fake "GitHub" that checks the bearer token and serves public events, plus a
// fake npm registry under /npm so dependency pinning never touches the network.
const api = createServer((request, response) => {
  const path = (request.url ?? "").split("?")[0] ?? "";
  if (path.startsWith("/oauth/")) {
    return void serveOauth(path, request, response);
  }
  // Echoes the credential it was shown, so a test can prove which token the
  // gateway substituted.
  if (path === "/whoami") {
    return response.end(
      JSON.stringify({ saw: request.headers.authorization ?? null }),
    );
  }
  const npmMatch = /^\/npm\/(.+)\/latest$/.exec(request.url ?? "");
  if (npmMatch) {
    const versions: Record<string, string> = { "date-fns": "4.1.0" };
    const version = versions[decodeURIComponent(npmMatch[1] ?? "")];
    if (!version) {
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: "Not found" }));
    }
    return response.end(JSON.stringify({ version }));
  }
  if (request.headers.authorization !== "Bearer gh-test-token") {
    response.statusCode = 401;
    return response.end(JSON.stringify({ message: "Bad credentials" }));
  }
  response.end(JSON.stringify(events));
});

const events: Array<Record<string, unknown>> = [
  {
    id: "3",
    type: "ReleaseEvent",
    repo: { name: "kody-bot/tool" },
    payload: { action: "published" },
  },
  { id: "2", type: "PushEvent", repo: { name: "kody-bot/tool" }, payload: {} },
  {
    id: "1",
    type: "CreateEvent",
    repo: { name: "kody-bot/new" },
    payload: { ref_type: "repository" },
  },
];
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

const kodyHome = mkdtempSync(join(tmpdir(), "local-kody-home-"));
writeFileSync(
  join(kodyHome, "secrets.json"),
  JSON.stringify({
    githubToken: { value: "gh-test-token", allowedHosts: ["127.0.0.1"] },
  }),
);

// A phase 1 storage file, plus the package whose leaf names it, so the daemon
// has something to import into that package's bucket on first start.
mkdirSync(join(kodyHome, "storage"), { recursive: true });
writeFileSync(
  join(kodyHome, "storage", "legacy-notes.json"),
  JSON.stringify({ greeting: "from the json era" }),
);
const legacyPackageDir = join(kodyHome, "packages", "@me", "legacy-notes");
mkdirSync(legacyPackageDir, { recursive: true });
writeFileSync(
  join(legacyPackageDir, "package.json"),
  JSON.stringify({
    name: "@me/legacy-notes",
    description: "Notes kept before the SQLite store existed",
    exports: { "./readNote": "./notes.ts" },
  }),
);
writeFileSync(
  join(legacyPackageDir, "notes.ts"),
  `import { packageStorage } from 'kody:runtime'
export default async function readNote({ key }) {
  return await packageStorage().get(key)
}`,
);

// A run left `running` by a daemon that died. Seeding it before the daemon
// starts is what a crash mid-execute leaves behind.
process.env.KODY_HOME = kodyHome;
const store = await import("../src/store.ts");
store.startRun({
  id: "stranded-run",
  surface: "execute",
  idempotencyKey: "stranded-key",
  startedAt: new Date(Date.now() - 600_000).toISOString(),
});
store.closeDatabase();

// A Unix socket path has about 100 characters to play with, so it goes
// straight under /tmp rather than inside the (long) temp home.
const socketFile = join("/tmp", `kody-e2e-${randomUUID().slice(0, 8)}.sock`);
const childEnv = {
  ...(process.env as Record<string, string>),
  KODY_HOME: kodyHome,
  KODY_SOCKET: socketFile,
  KODY_NPM_REGISTRY: `${apiUrl}/npm`,
  // Keep the suite out of Notification Center, and off the real Keychain.
  KODY_NOTIFY: "stderr",
  KODY_KEYCHAIN: "file",
  // Nothing here may open a browser window.
  KODY_OPEN: "none",
};

const daemon = spawn(
  process.execPath,
  [join(import.meta.dirname, "..", "src", "daemon.ts")],
  { env: childEnv, stdio: ["ignore", "ignore", "pipe"] },
);
let daemonStderr = "";
daemon.stderr.on("data", (chunk: Buffer) => (daemonStderr += chunk.toString()));

function ping() {
  return new Promise<boolean>((resolve) => {
    const probe = httpRequest(
      { socketPath: socketFile, path: "/health", method: "POST" },
      () => resolve(true),
    );
    probe.on("error", () => resolve(false));
    probe.end("{}");
  });
}

function daemonPost(path: string, body: unknown) {
  return new Promise<{ result?: unknown; error?: string }>(
    (resolve, reject) => {
      const outgoing = httpRequest(
        { socketPath: socketFile, path, method: "POST" },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(body ?? {}));
    },
  );
}

const readyBy = Date.now() + 10_000;
while (!(await ping())) {
  if (Date.now() > readyBy) {
    throw new Error(`Daemon never came up. stderr:\n${daemonStderr}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function connectClient(name: string) {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "server.ts")],
      env: childEnv,
      stderr: "ignore",
    }),
  );
  return client;
}

const client = await connectClient("e2e");

async function callTextOn(
  target: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = (await target.callTool({
    name,
    arguments: args,
  })) as ToolText;
  return {
    text: response.content[0]?.text ?? "",
    isError: response.isError === true,
  };
}

async function callText(name: string, args: Record<string, unknown>) {
  return await callTextOn(client, name, args);
}

// The real CLIs, talking to this daemon over its socket.
function runScript(script: string, args: Array<string>) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "src", script), ...args],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `cli exited ${String(code)}`)),
    );
  });
}

function runCli(args: Array<string>) {
  return runScript("cli.ts", args);
}

function runIntegrationCli(args: Array<string>) {
  return runScript("integration-cli.ts", args);
}

async function run(
  code: string,
  params: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const { text } = await callText("execute", { code, params, ...extra });
  return JSON.parse(text) as ExecuteResult;
}

const report: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, check: () => Promise<string>) {
  try {
    report.push({ step: name, ok: true, detail: await check() });
  } catch (error) {
    report.push({
      step: name,
      ok: false,
      detail: (error as Error).message.slice(0, 160),
    });
  }
}

await step("tools/list exposes exactly search + execute", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "execute",
    "search",
  ]);
  return tools.map((tool) => tool.name).join(", ");
});

await step("empty search returns the domain index", async () => {
  const { text } = await callText("search", {});
  assert.match(text, /# Domains/);
  return text.split("\n").slice(1, 3).join(" | ");
});

await step('"ping me when it is done" ranks notifySelf first', async () => {
  const { text } = await callText("search", {
    query: "ping me when it is done",
  });
  assert.match(text.split("\n")[1] ?? "", /capability:notifySelf/);
  return text.split("\n")[1] ?? "";
});

await step("entity lookup returns a ready-to-run module", async () => {
  const { text } = await callText("search", {
    entity: "capability:notifySelf",
  });
  assert.match(text, /kody\.notifySelf\(params\)/);
  return "snippet present";
});

await step("the CLI moves secrets.json into the Keychain", async () => {
  assert.equal(existsSync(join(kodyHome, "secrets.json")), true);
  const output = await runCli(["migrate"]);
  assert.match(output, /githubToken/);
  assert.equal(
    existsSync(join(kodyHome, "secrets.json")),
    false,
    "secrets.json survived the migration",
  );
  const { text } = await callText("search", { entity: "secret:githubToken" });
  assert.match(text, /Allowed hosts: 127\.0\.0\.1/);
  return output.trim();
});

await step(
  "a secret set through the CLI is refused until allowed",
  async () => {
    const fetchIt = `export default async function main(params) {
  return (await fetch(params.url, { headers: { authorization: 'Bearer {{secret:rotated}}' } })).status
}`;
    await runCli(["set", "rotated", "gh-test-token"]);
    const refused = await run(fetchIt, { url: apiUrl });
    assert.match(refused.error ?? "", /not approved for host 127\.0\.0\.1/);
    await runCli(["allow", "rotated", "127.0.0.1"]);
    const allowed = await run(fetchIt, { url: apiUrl });
    assert.equal(allowed.result, 200);
    const listed = await run(
      `import { kody } from 'kody:runtime'
export default async function main() { return await kody.secretList() }`,
    );
    assert.ok(
      !JSON.stringify(listed.result).includes("gh-test-token"),
      "secretList leaked a value",
    );
    return `refused, then ${String(allowed.result)} once allowed`;
  },
);

await step(
  "npm import + capability + secret placeholder in one module",
  async () => {
    const outcome = await run(
      `import { formatDistanceStrict } from 'date-fns'
import { kody } from 'kody:runtime'
export default async function main(params) {
  const secrets = await kody.secretList()
  const response = await fetch(params.url + '/users/kody-bot/events/public', {
    headers: { authorization: 'Bearer {{secret:githubToken}}' },
  })
  const events = await response.json()
  return { status: response.status, events: events.length, secrets: secrets.map((s) => s.name), age: formatDistanceStrict(new Date(2026, 0, 1), new Date(2026, 8, 19)) }
}`,
      { url: apiUrl },
    );
    assert.equal(outcome.error, undefined, outcome.error ?? "");
    assert.deepEqual(outcome.result, {
      status: 200,
      events: 3,
      secrets: ["githubToken", "rotated"],
      age: "9 months",
    });
    return `${JSON.stringify(outcome.result)} in ${outcome.durationMs} ms`;
  },
);

const whatShippedSource = `import { packageStorage } from 'kody:runtime'
export default async function whatShipped({ baseUrl, login }) {
  const storage = packageStorage()
  const sinceId = await storage.get(login)
  const response = await fetch(baseUrl + '/users/' + login + '/events/public', {
    headers: { authorization: 'Bearer {{secret:githubToken}}' },
  })
  const events = await response.json()
  const fresh = sinceId ? events.filter((event) => Number(event.id) > Number(sinceId)) : events
  const shipped = fresh
    .filter((event) => (event.type === 'ReleaseEvent' && event.payload.action === 'published') || (event.type === 'CreateEvent' && event.payload.ref_type === 'repository'))
    .map((event) => event.type + ' ' + event.repo.name)
  if (events[0]) await storage.set(login, events[0].id)
  return { shipped, message: shipped.length ? shipped.length + ' new' : 'nothing new' }
}`;

await step("packageSave stores the module as @me/what-shipped", async () => {
  const outcome = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.packageSave(params) }`,
    {
      name: "@me/what-shipped",
      description:
        "Releases and new repos a GitHub user shipped since last check",
      files: { "what-shipped.ts": whatShippedSource },
      exports: { "./whatShipped": "./what-shipped.ts" },
    },
  );
  assert.equal(outcome.error, undefined, outcome.error ?? "");
  return "saved";
});

await step(
  "search for the task now finds the saved package first",
  async () => {
    const { text } = await callText("search", {
      query: "what did kody-bot ship",
    });
    assert.match(text.split("\n")[1] ?? "", /package:@me\/what-shipped/);
    return text.split("\n")[1] ?? "";
  },
);

await step("invoking the saved export twice advances its cursor", async () => {
  const code = `import whatShipped from 'kody:@me/what-shipped/whatShipped'
export default async function main(params) { return await whatShipped(params) }`;
  const first = await run(code, { baseUrl: apiUrl, login: "kody-bot" });
  const second = await run(code, { baseUrl: apiUrl, login: "kody-bot" });
  assert.deepEqual((first.result as { shipped: Array<string> }).shipped, [
    "ReleaseEvent kody-bot/tool",
    "CreateEvent kody-bot/new",
  ]);
  assert.equal((second.result as { message: string }).message, "nothing new");
  return `1st: ${JSON.stringify(first.result)} / 2nd: ${JSON.stringify(second.result)}`;
});

const counterSource = `import { packageStorage } from 'kody:runtime'
export default async function bump({ value }) {
  const storage = packageStorage()
  await storage.set('cursor', value)
  return { cursor: await storage.get('cursor'), keys: await storage.list() }
}`;

await step("two packages keep separate values for the same key", async () => {
  const save = `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.packageSave(params) }`;
  for (const leaf of ["counter-a", "counter-b"]) {
    const saved = await run(save, {
      name: `@me/${leaf}`,
      description: `Counter ${leaf}`,
      files: { "bump.ts": counterSource },
      exports: { "./bump": "./bump.ts" },
    });
    assert.equal(saved.error, undefined, saved.error ?? "");
  }
  const outcome = await run(
    `import bumpA from 'kody:@me/counter-a/bump'
import bumpB from 'kody:@me/counter-b/bump'
export default async function main() {
  const a = await bumpA({ value: 'alpha' })
  const b = await bumpB({ value: 'beta' })
  return { a: a.cursor, b: b.cursor, again: (await bumpA({ value: 'alpha' })).cursor }
}`,
  );
  assert.equal(outcome.error, undefined, outcome.error ?? "");
  assert.deepEqual(outcome.result, { a: "alpha", b: "beta", again: "alpha" });
  return JSON.stringify(outcome.result);
});

const savePackage = `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.packageSave(params) }`;

await step(
  "a save with a type error is rejected, old version survives",
  async () => {
    const broken = await run(savePackage, {
      name: "@me/what-shipped",
      description: "Broken rewrite",
      files: {
        "what-shipped.ts": `export default async function whatShipped() {
  const count: number = 'not a number'
  return count
}`,
      },
      exports: { "./whatShipped": "./what-shipped.ts" },
    });
    assert.match(broken.error ?? "", /nothing changed on disk/);
    assert.match(broken.error ?? "", /deno check failed/);
    const still = await run(
      `import whatShipped from 'kody:@me/what-shipped/whatShipped'
export default async function main(params) { return await whatShipped(params) }`,
      { baseUrl: apiUrl, login: "kody-bot" },
    );
    assert.equal(still.error, undefined, still.error ?? "");
    assert.equal((still.result as { message: string }).message, "nothing new");
    return (broken.error ?? "").split("\n")[1] ?? "";
  },
);

await step("a save whose export file is missing is rejected", async () => {
  const outcome = await run(savePackage, {
    name: "@me/typo",
    description: "Points at a file that was never sent",
    files: { "there.ts": "export default async function there() { return 1 }" },
    exports: { "./there": "./not-there.ts" },
  });
  assert.match(outcome.error ?? "", /missing file \.\/not-there\.ts/);
  const listed = await run(
    `import { kody } from 'kody:runtime'
export default async function main() { return await kody.packageList() }`,
  );
  const names = (listed.result as Array<{ name: string }>).map(
    (manifest) => manifest.name,
  );
  assert.ok(!names.includes("@me/typo"), "the rejected package was written");
  return (outcome.error ?? "").split("\n")[1] ?? "";
});

await step(
  "a clean save pins every npm import to an exact version",
  async () => {
    const saved = await run(savePackage, {
      name: "@me/until-christmas",
      description: "Days from a date to Christmas",
      files: {
        "days.ts": `import { differenceInCalendarDays } from 'date-fns'
export default async function days({ from }) {
  const start = new Date(from)
  return differenceInCalendarDays(new Date(start.getFullYear(), 11, 25), start)
}`,
      },
      exports: { "./days": "./days.ts" },
    });
    assert.equal(saved.error, undefined, saved.error ?? "");
    assert.deepEqual((saved.result as { dependencies: unknown }).dependencies, {
      "date-fns": "4.1.0",
    });
    const used = await run(
      `import days from 'kody:@me/until-christmas/days'
export default async function main(params) { return await days(params) }`,
      { from: "2026-12-01T00:00:00.000Z" },
    );
    assert.equal(used.result, 24);
    return `date-fns pinned to 4.1.0, ${String(used.result)} days to go`;
  },
);

await step("ad hoc code calling packageStorage() is told to save", async () => {
  const outcome = await run(
    `import { packageStorage } from 'kody:runtime'
export default async function main() { return await packageStorage().get('cursor') }`,
  );
  assert.match(outcome.error ?? "", /belongs to a saved package/);
  assert.match(outcome.error ?? "", /kody\.packageSave/);
  return (outcome.error ?? "").split("\n")[0]?.slice(0, 80) ?? "";
});

await step("phase 1 storage json lands in its package's bucket", async () => {
  const outcome = await run(
    `import readNote from 'kody:@me/legacy-notes/readNote'
export default async function main(params) { return await readNote(params) }`,
    { key: "greeting" },
  );
  assert.equal(outcome.result, "from the json era");
  return String(outcome.result);
});

await step("secret refused for a host it is not approved for", async () => {
  const outcome = await run(
    `export default async function main(params) {
  return (await fetch(params.url, { headers: { authorization: 'Bearer {{secret:githubToken}}' } })).status
}`,
    { url: apiUrl.replace("127.0.0.1", "localhost") },
  );
  assert.match(outcome.error ?? "", /not approved for host localhost/);
  return (outcome.error ?? "").split("\n")[0] ?? "";
});

await step(
  "sandbox cannot read files, env, spawn or open sockets",
  async () => {
    const outcome = await run(`export default async function main() {
  const attempt = async (fn) => { try { await fn(); return 'ALLOWED' } catch (e) { return e.name } }
  return {
    readFile: await attempt(() => Deno.readTextFile('/etc/hosts')),
    env: await attempt(() => Deno.env.get('HOME')),
    spawn: await attempt(() => new Deno.Command('ls').output()),
    socket: await attempt(() => Deno.connect({ hostname: '1.1.1.1', port: 443 })),
  }
}`);
    assert.deepEqual(outcome.result, {
      readFile: "NotCapable",
      env: "NotCapable",
      spawn: "NotCapable",
      socket: "NotCapable",
    });
    return JSON.stringify(outcome.result);
  },
);

await step("the same idempotencyKey replays one sandbox run", async () => {
  const code = `export default async function main() {
  return { nonce: crypto.randomUUID() }
}`;
  const first = await run(code, {}, { idempotencyKey: "replay-me" });
  const second = await run(code, {}, { idempotencyKey: "replay-me" });
  assert.equal(first.error, undefined, first.error ?? "");
  assert.equal(second.replayed, true);
  assert.equal(second.runId, first.runId);
  assert.deepEqual(second.result, first.result);
  return `${JSON.stringify(first.result)} replayed as run ${second.runId}`;
});

await step("a failed execute is recorded and listed", async () => {
  const failed = await run(`export default async function main() {
  throw new Error('kaboom from the sandbox')
}`);
  assert.match(failed.error ?? "", /kaboom from the sandbox/);
  const listed = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.runList(params) }`,
    { status: "error", limit: 50 },
  );
  const runs = listed.result as Array<RunSummary>;
  const match = runs.find((record) => record.id === failed.runId);
  assert.ok(match, `run ${String(failed.runId)} not in runList`);
  assert.match(match.error ?? "", /kaboom/);
  const detail = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.runGet(params) }`,
    { id: failed.runId },
  );
  assert.match(
    (detail.result as { error: string }).error,
    /kaboom from the sandbox/,
  );
  return match.error ?? "";
});

await step("a run stranded by a dead daemon is reconciled", async () => {
  const listed = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.runGet(params) }`,
    { id: "stranded-run" },
  );
  const record = listed.result as RunSummary;
  assert.equal(record.status, "error");
  assert.equal(record.error, "interrupted");
  return `${record.status}: ${record.error ?? ""}`;
});

type JobView = {
  jobName: string;
  enabled: boolean;
  expression: string;
  nextRun: string | null;
  lastRun: { status: string } | null;
};
type JobRunResult = {
  runId: string;
  result: { notified: boolean; message: string } | null;
  error: string | null;
};
type DigestResult = { notified: boolean; message: string };

const callCapability = `import { kody } from 'kody:runtime'
export default async function main({ name, input }) { return await kody[name](input) }`;

await step("a package can declare a daily job, disabled to start", async () => {
  const saved = await run(savePackage, {
    name: "@me/daily-shipped",
    description: "Tells me each morning what kody-bot shipped",
    files: {
      "what-shipped.ts": whatShippedSource,
      "digest.ts": `import { kody } from 'kody:runtime'
import whatShipped from './what-shipped.ts'
export default async function digest() {
  const found = await whatShipped({ baseUrl: ${JSON.stringify(apiUrl)}, login: 'kody-bot' })
  if (found.shipped.length === 0) return { notified: false, message: found.message }
  await kody.notifySelf({ title: 'kody-bot shipped', message: found.message })
  return { notified: true, message: found.message }
}`,
    },
    exports: { "./whatShipped": "./what-shipped.ts" },
    kody: {
      jobs: {
        "daily-digest": {
          entry: "./digest.ts",
          schedule: { type: "cron", expression: "0 8 * * *" },
          timezone: "UTC",
        },
      },
    },
  });
  assert.equal(saved.error, undefined, saved.error ?? "");
  const listed = await run(callCapability, { name: "jobList", input: {} });
  const job = (listed.result as Array<JobView>).find(
    (candidate) => candidate.jobName === "daily-digest",
  );
  assert.ok(job, "daily-digest not listed");
  assert.equal(job.enabled, false);
  assert.equal(job.nextRun, null);
  return `${job.jobName} on "${job.expression}", disabled`;
});

await step("a job must run by hand before it can be enabled", async () => {
  const refused = await run(callCapability, {
    name: "jobUpdate",
    input: {
      packageName: "@me/daily-shipped",
      jobName: "daily-digest",
      enabled: true,
    },
  });
  assert.match(refused.error ?? "", /never run successfully/);
  const ranNow = await run(callCapability, {
    name: "jobRunNow",
    input: { packageName: "@me/daily-shipped", jobName: "daily-digest" },
  });
  const outcome = ranNow.result as JobRunResult;
  assert.equal(outcome.error, null, outcome.error ?? "");
  assert.deepEqual(outcome.result, { notified: true, message: "2 new" });
  const enabled = await run(callCapability, {
    name: "jobUpdate",
    input: {
      packageName: "@me/daily-shipped",
      jobName: "daily-digest",
      enabled: true,
    },
  });
  assert.equal((enabled.result as JobView).enabled, true);
  assert.ok((enabled.result as JobView).nextRun, "no next run computed");
  return `ran by hand, then enabled for ${String((enabled.result as JobView).nextRun)}`;
});

await step("a scheduler tick runs the job and stays quiet", async () => {
  const tick = await daemonPost("/scheduler/tick", {
    now: new Date(Date.now() + 26 * 3600_000).toISOString(),
  });
  const ran = (tick.result as { ran: Array<{ jobName: string }> }).ran;
  assert.equal(ran.length, 1, `ran ${ran.length} times`);
  const listed = await run(callCapability, {
    name: "runList",
    input: { packageName: "@me/daily-shipped", jobName: "daily-digest" },
  });
  const latest = (listed.result as Array<RunSummary>)[0];
  const detail = await run(callCapability, {
    name: "runGet",
    input: { id: latest?.id },
  });
  assert.deepEqual((detail.result as { result: DigestResult }).result, {
    notified: false,
    message: "nothing new",
  });
  return "one run, nothing new, no notification";
});

await step("a tick notifies once the fake API has a new release", async () => {
  events.unshift({
    id: "4",
    type: "ReleaseEvent",
    repo: { name: "kody-bot/tool" },
    payload: { action: "published" },
  });
  const tick = await daemonPost("/scheduler/tick", {
    now: new Date(Date.now() + 50 * 3600_000).toISOString(),
  });
  assert.equal(
    (tick.result as { ran: Array<unknown> }).ran.length,
    1,
    "expected exactly one catch-up run",
  );
  const listed = await run(callCapability, {
    name: "runList",
    input: { packageName: "@me/daily-shipped", jobName: "daily-digest" },
  });
  const latest = (listed.result as Array<RunSummary>)[0];
  const detail = await run(callCapability, {
    name: "runGet",
    input: { id: latest?.id },
  });
  const digest = (detail.result as { result: DigestResult }).result;
  assert.equal(digest.notified, true);
  assert.equal(digest.message, "1 new");
  return `notified: ${digest.message}`;
});

type IntegrationView = {
  id: string;
  status: string;
  scopes: Array<string>;
  allowedHosts: Array<string>;
  lastError: string | null;
};

const integrationList = `import { kody } from 'kody:runtime'
export default async function main() { return await kody.integrationList() }`;

const callWhoami = `export default async function main(params) {
  const response = await fetch(params.url + '/whoami', {
    headers: { authorization: 'Bearer {{integration:fake}}' },
  })
  return await response.json()
}`;

await step("the CLI configures a provider, not yet connected", async () => {
  await runIntegrationCli([
    "add",
    "fake",
    "--client-id",
    "cid",
    "--client-secret",
    "csec",
    "--auth-url",
    `${apiUrl}/oauth/authorize`,
    "--token-url",
    `${apiUrl}/oauth/token`,
    "--host",
    "127.0.0.1",
    "--scope",
    "read",
  ]);
  const listed = await run(integrationList);
  const fake = (listed.result as Array<IntegrationView>).find(
    (candidate) => candidate.id === "fake",
  );
  assert.ok(fake, "fake integration not listed");
  assert.equal(fake.status, "not_connected");
  assert.deepEqual(fake.scopes, ["read"]);
  const { text } = await callText("search", { entity: "integration:fake" });
  assert.match(text, /Status: not_connected/);
  assert.match(text, /\{\{integration:fake\}\}/);
  return `${fake.id}: ${fake.status} for ${fake.allowedHosts.join(", ")}`;
});

await step("approving in the browser connects the integration", async () => {
  const started = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.integrationStart(params) }`,
    { id: "fake" },
  );
  assert.equal(started.error, undefined, started.error ?? "");
  const { authorizeUrl } = started.result as { authorizeUrl: string };
  const query = new URL(authorizeUrl).searchParams;
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.ok(query.get("state"), "no state in the authorize URL");
  // Play the browser: follow the redirect into the daemon's loopback listener.
  const approved = await fetch(authorizeUrl);
  assert.match(await approved.text(), /Connected/);
  const listed = await run(integrationList);
  const fake = (listed.result as Array<IntegrationView>).find(
    (candidate) => candidate.id === "fake",
  );
  assert.equal(fake?.status, "connected");
  assert.ok(
    !/at-|rt-/.test(JSON.stringify(listed.result)),
    "integrationList leaked a token",
  );
  return "connected, and the listing carries no token";
});

await step("two parallel calls refresh the token exactly once", async () => {
  const before = oauth.refreshes;
  const outcome = await run(
    `export default async function main(params) {
  const call = async () => (await fetch(params.url + '/whoami', {
    headers: { authorization: 'Bearer {{integration:fake}}' },
  })).json()
  return await Promise.all([call(), call()])
}`,
    { url: apiUrl },
  );
  assert.equal(outcome.error, undefined, outcome.error ?? "");
  assert.deepEqual(outcome.result, [
    { saw: "Bearer at-2" },
    { saw: "Bearer at-2" },
  ]);
  assert.equal(
    oauth.refreshes - before,
    1,
    "the refresh was not single-flight",
  );
  return "both saw the refreshed token, one refresh";
});

await step("the same placeholder to another host is refused", async () => {
  const before = oauth.refreshes;
  const outcome = await run(callWhoami, {
    url: apiUrl.replace("127.0.0.1", "localhost"),
  });
  assert.match(outcome.error ?? "", /not approved for host localhost/);
  assert.match(outcome.error ?? "", /npm run integration -- allow fake/);
  assert.equal(oauth.refreshes, before, "a refused host still cost a refresh");
  return (outcome.error ?? "").split("\n")[0] ?? "";
});

await step("a refresh the provider refuses asks for a reconnect", async () => {
  oauth.failRefresh = true;
  const outcome = await run(callWhoami, { url: apiUrl });
  assert.match(outcome.error ?? "", /could not refresh its token/);
  assert.match(
    outcome.error ?? "",
    /kody\.integrationStart\(\{ id: 'fake' \}\)/,
  );
  const listed = await run(integrationList);
  const fake = (listed.result as Array<IntegrationView>).find(
    (candidate) => candidate.id === "fake",
  );
  assert.equal(fake?.status, "needs_reconnect");
  assert.match(fake?.lastError ?? "", /invalid_grant/);
  return `needs_reconnect: ${fake?.lastError ?? ""}`;
});

await step("revoking forgets the tokens and keeps the config", async () => {
  const revoked = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.integrationRevoke(params) }`,
    { id: "fake" },
  );
  assert.equal(revoked.error, undefined, revoked.error ?? "");
  const outcome = await run(callWhoami, { url: apiUrl });
  assert.match(outcome.error ?? "", /is not connected yet/);
  const listed = await run(integrationList);
  const fake = (listed.result as Array<IntegrationView>).find(
    (candidate) => candidate.id === "fake",
  );
  assert.equal(fake?.status, "not_connected");
  assert.deepEqual(fake?.allowedHosts, ["127.0.0.1"]);
  return "tokens gone, provider config still there";
});

await step("two proxies share one daemon concurrently", async () => {
  const second = await connectClient("e2e-second");
  const code = `import bump from 'kody:@me/counter-a/bump'
export default async function main(params) {
  await bump({ value: params.key })
  return params.key
}`;
  const [first, other, index] = await Promise.all([
    callTextOn(client, "execute", { code, params: { key: "one" } }),
    callTextOn(second, "execute", { code, params: { key: "two" } }),
    callTextOn(second, "search", {}),
  ]);
  await second.close();
  assert.equal((JSON.parse(first.text) as ExecuteResult).result, "one");
  assert.equal((JSON.parse(other.text) as ExecuteResult).result, "two");
  assert.match(index.text, /# Domains/);
  return "both proxies got their own result";
});

await step("a proxy with no daemon says how to start one", async () => {
  const orphan = new Client({ name: "e2e-orphan", version: "0.0.0" });
  await orphan.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "server.ts")],
      env: { ...childEnv, KODY_SOCKET: join("/tmp", "kody-e2e-absent.sock") },
      stderr: "ignore",
    }),
  );
  const { text, isError } = await callTextOn(orphan, "search", {});
  await orphan.close();
  assert.equal(isError, true);
  assert.match(text, /daemon is not running/);
  assert.match(text, /npm run daemon:install/);
  return text.split("\n")[0] ?? "";
});

await client.close();
daemon.kill("SIGTERM");
rmSync(socketFile, { force: true });
api.close();
console.table(report);
process.exitCode = report.every((entry) => entry.ok) ? 0 : 1;
