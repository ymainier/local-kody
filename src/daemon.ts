import { chmodSync, existsSync, unlinkSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import "./capabilities.ts";
import { tickScheduler } from "./jobs.ts";
import { importLegacyStorage } from "./package-storage.ts";
import { socketFile } from "./paths.ts";
import { executeRecorded, reconcileOnStartup } from "./runs.ts";
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
    case "/scheduler/tick": {
      // Not an MCP tool: the daemon's own maintenance surface, which is also
      // how a test drives the scheduler without waiting for the wall clock.
      const { now } = (body ?? {}) as { now?: string };
      return { result: await tickScheduler(now ? new Date(now) : new Date()) };
    }
    case "/tools/search":
      return { result: { text: search(searchInputSchema.parse(body)) } };
    case "/tools/execute":
      return { result: await executeRecorded(executeInputSchema.parse(body)) };
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
const reconciled = reconcileOnStartup();
if (reconciled.reconciled > 0) {
  process.stderr.write(
    `marked ${reconciled.reconciled} interrupted run(s) as errors\n`,
  );
}

const server = createServer((request, response) => {
  void handle(request, response);
});
await new Promise<void>((resolve) => server.listen(socketFile, resolve));
chmodSync(socketFile, 0o600);
process.stderr.write(`local-kody daemon listening on ${socketFile}\n`);

// One tick every 30 s. Occurrences missed between ticks coalesce into one run,
// so a slept Mac or a restarted daemon catches up rather than storming.
const schedulerIntervalMs = Number(
  process.env.KODY_SCHEDULER_INTERVAL_MS ?? 30_000,
);
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  void tickScheduler()
    .catch((error: unknown) => {
      process.stderr.write(`scheduler tick failed: ${String(error)}\n`);
    })
    .finally(() => {
      ticking = false;
    });
}, schedulerIntervalMs).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    if (existsSync(socketFile)) unlinkSync(socketFile);
    process.exit(0);
  });
}
