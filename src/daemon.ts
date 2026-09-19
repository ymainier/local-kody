import { chmodSync, existsSync, unlinkSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import "./capabilities.ts";
import { execute } from "./executor.ts";
import { importLegacyStorage } from "./package-storage.ts";
import { socketFile } from "./paths.ts";
import { search } from "./search.ts";
import { executeInputSchema, searchInputSchema } from "./tools.ts";

// The long-lived half of local-kody: it outlives every MCP client, owns the
// SQLite store as the single writer, and runs the gateway and the sandbox.
// Clients reach it over a 0600 Unix socket; there is no TCP listener.
async function readJson(request: IncomingMessage) {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
}

async function route(path: string, body: unknown) {
  switch (path) {
    case "/health":
      return { result: { ok: true, pid: process.pid } };
    case "/tools/search":
      return { result: { text: search(searchInputSchema.parse(body)) } };
    case "/tools/execute":
      return { result: await execute(executeInputSchema.parse(body)) };
    default:
      return { error: `No route ${path}` };
  }
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  let payload: unknown;
  try {
    payload = await route(request.url ?? "", await readJson(request));
  } catch (error) {
    payload = { error: error instanceof Error ? error.message : String(error) };
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

// A socket file left behind by a crash looks identical to a live one; the only
// way to tell them apart is to try to connect.
function isSocketLive(path: string) {
  return new Promise<boolean>((resolve) => {
    const probe = httpRequest(
      { socketPath: path, path: "/health", method: "POST", timeout: 1000 },
      () => resolve(true),
    );
    probe.on("error", () => resolve(false));
    probe.on("timeout", () => {
      probe.destroy();
      resolve(false);
    });
    probe.end("{}");
  });
}

if (existsSync(socketFile)) {
  if (await isSocketLive(socketFile)) {
    process.stderr.write(
      `local-kody daemon already running on ${socketFile}\n`,
    );
    process.exit(0);
  }
  unlinkSync(socketFile);
}

importLegacyStorage();

const server = createServer((request, response) => {
  void handle(request, response);
});
await new Promise<void>((resolve) => server.listen(socketFile, resolve));
chmodSync(socketFile, 0o600);
process.stderr.write(`local-kody daemon listening on ${socketFile}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    if (existsSync(socketFile)) unlinkSync(socketFile);
    process.exit(0);
  });
}
