import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, parse } from "es-module-lexer";
import { registerRun, startGateway } from "./gateway.ts";
import { resolveKodyImport } from "./packages.ts";
import { denoBin } from "./paths.ts";

export type ExecuteOutcome = {
  result?: unknown;
  error?: string;
  logs: Array<string>;
  durationMs: number;
};

const maxResultBytes = 100_000;

function runtimeSource(gatewayPort: number, runId: string) {
  return `
const gatewayUrl = 'http://127.0.0.1:${gatewayPort}'
const nativeFetch = globalThis.fetch.bind(globalThis)
export async function post(path, body) {
  const response = await nativeFetch(gatewayUrl + path, {
    method: 'POST',
    headers: { 'x-kody-run': '${runId}' },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (data && data.error) throw new Error(data.error)
  return data
}
globalThis.fetch = async (input, init = {}) => {
  const request = new Request(input, init)
  const data = await post('/fetch', {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body === null ? undefined : await request.text(),
  })
  return new Response(data.body, { status: data.status, headers: data.headers })
}
const format = (parts) => parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...parts) => void post('/log', { line: (level === 'log' ? '' : '[' + level + '] ') + format(parts) })
}
export const kody = new Proxy({}, {
  get: (_, name) => async (input) => (await post('/call', { name: String(name), input })).result,
})
`;
}

const mainSource = `
import { post } from 'kody:runtime'
import main from './entry.ts'
const params = JSON.parse(Deno.args[0] ?? '{}')
try {
  const result = await main(params)
  await post('/settle', { result: result ?? null })
} catch (error) {
  await post('/settle', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
}
`;

// Like Kody: scan literal imports. Bare names become npm packages at latest,
// `kody:@scope/leaf/export` becomes the saved package file (scanned transitively).
async function buildImportMap(code: string, runtimePath: string) {
  await init;
  const imports: Record<string, string> = { "kody:runtime": runtimePath };
  const queue = [code];
  while (queue.length > 0) {
    const [found] = parse(queue.pop() ?? "");
    for (const { specifier } of found) {
      if (!specifier || specifier in imports) continue;
      if (specifier.startsWith("kody:@")) {
        const file = resolveKodyImport(specifier);
        imports[specifier] = file;
        queue.push(await readFile(file, "utf8"));
        continue;
      }
      if (/^(\.|\/|kody:|npm:|jsr:|node:|https?:|data:)/.test(specifier))
        continue;
      const parts = specifier.split("/");
      const name = specifier.startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0];
      imports[name] = `npm:${name}`;
      imports[`${name}/`] = `npm:/${name}/`;
    }
  }
  return { imports };
}

function sandboxEnv() {
  const passThrough = [
    "HOME",
    "PATH",
    "DENO_DIR",
    "DENO_CERT",
    "HTTPS_PROXY",
    "HTTP_PROXY",
  ];
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const key of passThrough) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(",");
  return env;
}

export async function execute(input: {
  code: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecuteOutcome> {
  const startedAt = performance.now();
  const gatewayPort = await startGateway();
  const runId = randomUUID();
  const logs: Array<string> = [];
  let settled: { result?: unknown; error?: string } | null = null;
  const unregister = registerRun(runId, {
    logs,
    settle: (outcome) => (settled = outcome),
  });
  const runDir = await mkdtemp(join(tmpdir(), "kody-run-"));
  const finish = (outcome: {
    result?: unknown;
    error?: string;
  }): ExecuteOutcome => {
    const durationMs = Math.round(performance.now() - startedAt);
    const size = JSON.stringify(outcome.result ?? null).length;
    if (size > maxResultBytes) {
      return {
        error: `Result is ${size} bytes; return less than ${maxResultBytes}.`,
        logs,
        durationMs,
      };
    }
    return { ...outcome, logs, durationMs };
  };
  try {
    const runtimePath = join(runDir, "runtime.js");
    await writeFile(runtimePath, runtimeSource(gatewayPort, runId));
    await writeFile(join(runDir, "entry.ts"), input.code);
    await writeFile(join(runDir, "main.ts"), mainSource);
    await writeFile(
      join(runDir, "deno.json"),
      JSON.stringify(await buildImportMap(input.code, runtimePath)),
    );
    const child = spawn(
      denoBin,
      [
        "run",
        "--quiet",
        "--no-prompt",
        `--allow-net=127.0.0.1:${gatewayPort}`,
        "--config",
        join(runDir, "deno.json"),
        join(runDir, "main.ts"),
        JSON.stringify(input.params ?? {}),
      ],
      { env: sandboxEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) =>
      logs.push(chunk.toString("utf8").trimEnd()),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr += chunk.toString("utf8")),
    );
    const timeoutMs = input.timeoutMs ?? 60_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    if (timedOut)
      return finish({ error: `Execution timed out after ${timeoutMs} ms` });
    if (settled) return finish(settled);
    return finish({
      error: stderr.trim() || "Sandbox exited without a result",
    });
  } catch (error) {
    return finish({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    unregister();
    await rm(runDir, { recursive: true, force: true });
  }
}
