import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { callCapability } from "./registry.ts";
import { hostOf, substituteSecrets } from "./secrets.ts";
import { storageDelete, storageGet, storageList, storageSet } from "./store.ts";

// The sandbox's only reachable address. Deno is started with
// --allow-net=127.0.0.1:<port>, so this is the whole outside world for user code.
export type RunState = {
  logs: Array<string>;
  // Random token -> saved package name, one per package in this run's import
  // graph. The token arrives in a header from the facade module Deno remapped
  // `kody:runtime` to for that package's folder.
  tokens: Map<string, string>;
  settle: (outcome: { result?: unknown; error?: string }) => void;
};

type FetchRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

const runs = new Map<string, RunState>();

async function readJson(request: IncomingMessage) {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function proxyFetch(request: FetchRequest, run: RunState) {
  const host = hostOf(request.url);
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([key, value]) => [
      key,
      substituteSecrets(value, host),
    ]),
  );
  const method = request.method ?? "GET";
  const upstream = await fetch(substituteSecrets(request.url, host), {
    method,
    headers,
    body:
      request.body === undefined
        ? undefined
        : substituteSecrets(request.body, host),
    signal: AbortSignal.timeout(30_000),
  });
  run.logs.push(`[fetch] ${method} ${host} -> ${upstream.status}`);
  return {
    status: upstream.status,
    headers: Object.fromEntries(upstream.headers),
    body: await upstream.text(),
  };
}

type StorageRequest = { op?: string; key?: string; value?: unknown };

// The token binds a bucket to the folder the calling module came from, which
// stops one package clobbering another's keys by accident. It is not a defence
// against a hostile module: everything here runs on your own machine with your
// own code, and a determined module could read the token out of its facade.
function storageOperation(
  body: StorageRequest,
  run: RunState,
  headers: IncomingMessage["headers"],
) {
  const packageName = run.tokens.get(String(headers["x-kody-token"] ?? ""));
  if (!packageName) throw new Error("No package owns this storage call");
  const key = String(body.key ?? "");
  switch (body.op) {
    case "get":
      return storageGet(packageName, key);
    case "set":
      return storageSet(packageName, key, body.value);
    case "list":
      return storageList(packageName);
    case "delete":
      return storageDelete(packageName, key);
    default:
      throw new Error(`Unknown storage op "${String(body.op)}"`);
  }
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const reply = (body: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body ?? null));
  };
  try {
    const run = runs.get(String(request.headers["x-kody-run"] ?? ""));
    if (!run) return reply({ error: "Unknown or finished run" });
    const body = await readJson(request);
    switch (request.url) {
      case "/call":
        return reply({
          result: await callCapability(String(body.name), body.input),
        });
      case "/fetch":
        return reply(await proxyFetch(body as FetchRequest, run));
      case "/storage":
        return reply({ result: storageOperation(body, run, request.headers) });
      case "/log":
        run.logs.push(String(body.line));
        return reply({ result: null });
      case "/settle":
        run.settle(body);
        return reply({ result: null });
      default:
        return reply({ error: `No route ${request.url}` });
    }
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  }
}

let portPromise: Promise<number> | null = null;

export function startGateway() {
  portPromise ??= new Promise((resolve) => {
    const server = createServer(
      (request, response) => void handle(request, response),
    );
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
    server.unref();
  });
  return portPromise;
}

export function registerRun(runId: string, state: RunState) {
  runs.set(runId, state);
  return () => runs.delete(runId);
}
