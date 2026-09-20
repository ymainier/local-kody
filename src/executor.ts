import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, parse } from "es-module-lexer";
import { registerRun, startGateway } from "./gateway.ts";
import {
  getPackage,
  packageRoot,
  parseKodyImport,
  resolveKodyImport,
} from "./packages.ts";
import { denoBin } from "./paths.ts";

// A folder whose files count as one package: they get that package's storage
// bucket and its pinned dependency versions. Saved packages produce these from
// the import graph; packageSave produces one for the staging folder it is about
// to check.
export type PackageScope = {
  folder: string;
  packageName: string;
  dependencies?: Record<string, string>;
};

export type ExecuteOutcome = {
  result?: unknown;
  error?: string;
  logs: Array<string>;
  durationMs: number;
};

const maxResultBytes = 100_000;
export const defaultExecuteTimeoutMs = 60_000;

// One core module per run holds the gateway plumbing, so its side effects (the
// fetch and console patches) happen exactly once however many facades import
// it. Each facade re-exports the core bound to one package's token.
function runtimeCoreSource(gatewayPort: number, runId: string) {
  return `
const gatewayUrl = 'http://127.0.0.1:${gatewayPort}'
const nativeFetch = globalThis.fetch.bind(globalThis)
export async function post(path, body, token) {
  const headers = { 'x-kody-run': '${runId}' }
  if (token) headers['x-kody-token'] = token
  const response = await nativeFetch(gatewayUrl + path, {
    method: 'POST',
    headers,
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
export function makeKody(token) {
  const mcp = new Proxy({}, {
    get: (_, server) => new Proxy({}, {
      get: (_, tool) => async (args) => (await post('/mcp', { server: String(server), tool: String(tool), args }, token)).result,
    }),
  })
  return new Proxy({}, {
    get: (_, name) => name === 'mcp' ? mcp : async (input) => (await post('/call', { name: String(name), input }, token)).result,
  })
}
export function packageStorageFor(token) {
  if (!token) {
    throw new Error(
      'packageStorage() belongs to a saved package, and this code is not one yet. ' +
      'Save it with kody.packageSave({ name, description, files, exports }) and call packageStorage() from the saved module, ' +
      'or import an export of a saved package and let it keep the state.',
    )
  }
  const call = async (op, body) => (await post('/storage', { op, ...body }, token)).result
  return {
    get: (key) => call('get', { key }),
    set: (key, value) => call('set', { key, value }),
    list: () => call('list', {}),
    delete: (key) => call('delete', { key }),
  }
}
`;
}

// `token` is empty for ad hoc code, which is what makes packageStorage() throw
// its "save this first" error there.
function runtimeFacadeSource(token: string) {
  return `
import { makeKody, packageStorageFor, post } from './runtime-core.js'
export { post }
export const kody = makeKody('${token}')
export function packageStorage() {
  return packageStorageFor('${token}')
}
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

// The npm package a bare specifier belongs to, or null when the specifier is
// relative, absolute or already carries a scheme.
export function npmPackageOf(specifier: string) {
  if (/^(\.|\/|kody:|npm:|jsr:|node:|https?:|data:)/.test(specifier)) {
    return null;
  }
  const parts = specifier.split("/");
  return (
    (specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]) ?? null
  );
}

// Pinned versions turn into import-map entries so a package keeps running
// against the versions it was checked with.
function pinnedImports(dependencies: Record<string, string> | undefined) {
  const entries: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies ?? {})) {
    entries[name] = `npm:${name}@${version}`;
    entries[`${name}/`] = `npm:/${name}@${version}/`;
  }
  return entries;
}

// Like Kody: scan literal imports. Bare names become npm packages at latest,
// `kody:@scope/leaf/export` becomes the saved package file (scanned transitively).
// Every package met on the way gets an import-map scope so that files inside its
// folder — and only those — resolve `kody:runtime` to that package's facade.
async function buildImportMap(code: string, rootRuntimePath: string) {
  await init;
  const imports: Record<string, string> = { "kody:runtime": rootRuntimePath };
  const packageNames = new Set<string>();
  const queue = [code];
  while (queue.length > 0) {
    const [found] = parse(queue.pop() ?? "");
    for (const { specifier } of found) {
      if (!specifier || specifier in imports) continue;
      if (specifier.startsWith("kody:@")) {
        const file = resolveKodyImport(specifier);
        imports[specifier] = file;
        packageNames.add(parseKodyImport(specifier).name);
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
  return { imports, packageNames: [...packageNames] };
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
  extraImports?: Record<string, string>;
  extraScopes?: Array<PackageScope>;
}): Promise<ExecuteOutcome> {
  const startedAt = performance.now();
  const gatewayPort = await startGateway();
  const runId = randomUUID();
  const logs: Array<string> = [];
  const tokens = new Map<string, string>();
  let settled: { result?: unknown; error?: string } | null = null;
  const unregister = registerRun(runId, {
    logs,
    tokens,
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
    const rootRuntimePath = join(runDir, "runtime-root.js");
    await writeFile(
      join(runDir, "runtime-core.js"),
      runtimeCoreSource(gatewayPort, runId),
    );
    await writeFile(rootRuntimePath, runtimeFacadeSource(""));
    await writeFile(join(runDir, "entry.ts"), input.code);
    await writeFile(join(runDir, "main.ts"), mainSource);
    const { imports, packageNames } = await buildImportMap(
      input.code,
      rootRuntimePath,
    );
    const scopeList: Array<PackageScope> = [
      ...packageNames.map((packageName) => ({
        folder: packageRoot(packageName),
        packageName,
        dependencies: getPackage(packageName)?.dependencies,
      })),
      ...(input.extraScopes ?? []),
    ];
    const scopes: Record<string, Record<string, string>> = {};
    for (const scope of scopeList) {
      const token = randomUUID();
      tokens.set(token, scope.packageName);
      const facadePath = join(runDir, `runtime-${token}.js`);
      await writeFile(facadePath, runtimeFacadeSource(token));
      scopes[`${scope.folder}/`] = {
        "kody:runtime": facadePath,
        ...pinnedImports(scope.dependencies),
      };
    }
    await writeFile(
      join(runDir, "deno.json"),
      JSON.stringify({
        imports: { ...imports, ...(input.extraImports ?? {}) },
        scopes,
      }),
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
    const timeoutMs = input.timeoutMs ?? defaultExecuteTimeoutMs;
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
