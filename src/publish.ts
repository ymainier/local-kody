import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { init, parse } from "es-module-lexer";
import { execute, npmPackageOf } from "./executor.ts";
import {
  getPackage,
  packageKodySchema,
  packageRoot,
  type PackageManifest,
} from "./packages.ts";
import { denoBin, stagingDir } from "./paths.ts";

const execFileAsync = promisify(execFile);

// A package that only breaks when a job fires at 8am is a package that was
// saved without being checked. Everything here runs against a staging folder;
// the live folder is replaced only once every check passes.
export type SavePackageInput = {
  name: string;
  description: string;
  files: Record<string, string>;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  kody?: unknown;
};

const registryBase =
  process.env.KODY_NPM_REGISTRY ?? "https://registry.npmjs.org";

// Loose on purpose: the declaration exists so `deno check` can see a package's
// own mistakes, not to type the capability surface. Tightening it from the Zod
// schemas comes later.
const runtimeDeclaration = `export declare const kody: Record<
  string,
  (input?: any) => Promise<any>
>;
export declare function packageStorage(): {
  get(key: string): Promise<any>;
  set(key: string, value: unknown): Promise<{ saved: boolean }>;
  list(): Promise<Array<{ key: string; updatedAt: string }>>;
  delete(key: string): Promise<{ deleted: boolean }>;
};
`;

function writeStagedFiles(root: string, files: Record<string, string>) {
  for (const [relativePath, source] of Object.entries(files)) {
    const target = normalize(join(root, relativePath));
    if (!target.startsWith(root + "/")) {
      throw new Error(`File path "${relativePath}" escapes the package folder`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
}

function sourceFilesUnder(root: string): Array<string> {
  const found: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function checkManifest(root: string, input: SavePackageInput) {
  const failures: Array<string> = [];
  for (const [exportName, target] of Object.entries(input.exports)) {
    if (!exportName.startsWith("./")) {
      failures.push(`Export "${exportName}" must start with ./`);
      continue;
    }
    if (!existsSync(join(root, target))) {
      failures.push(`Export "${exportName}" points at missing file ${target}`);
    }
  }
  if (Object.keys(input.exports).length === 0) {
    failures.push("A package needs at least one export");
  }
  const parsed = packageKodySchema.safeParse(input.kody ?? {});
  if (!parsed.success) {
    failures.push(
      `kody manifest: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
    return { failures, kody: undefined };
  }
  for (const [jobName, job] of Object.entries(parsed.data.jobs ?? {})) {
    if (!existsSync(join(root, job.entry))) {
      failures.push(`Job "${jobName}" points at missing entry ${job.entry}`);
    }
  }
  return { failures, kody: parsed.data };
}

async function latestVersion(name: string) {
  const response = await fetch(
    `${registryBase}/${encodeURIComponent(name)}/latest`,
  );
  if (!response.ok) {
    throw new Error(
      `npm has no package "${name}" (registry answered ${response.status})`,
    );
  }
  const data = (await response.json()) as { version?: string };
  if (!data.version) throw new Error(`npm gave no version for "${name}"`);
  return data.version;
}

// Every bare import the package makes, pinned to an exact version. Versions
// already pinned (by the caller, or by the previous save) are kept.
async function resolveDependencies(
  root: string,
  pinned: Record<string, string>,
) {
  await init;
  const wanted = new Set<string>();
  for (const file of sourceFilesUnder(root)) {
    const [found] = parse(readFileSync(file, "utf8"));
    for (const { specifier } of found) {
      const name = specifier ? npmPackageOf(specifier) : null;
      if (name) wanted.add(name);
    }
  }
  const dependencies: Record<string, string> = {};
  const failures: Array<string> = [];
  for (const name of [...wanted].sort()) {
    if (pinned[name]) {
      dependencies[name] = pinned[name];
      continue;
    }
    try {
      dependencies[name] = await latestVersion(name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { dependencies, failures };
}

async function typeCheck(root: string, manifest: PackageManifest) {
  const workspace = join(stagingDir, `check-${randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  try {
    const declarationPath = join(workspace, "kody-runtime.d.ts");
    writeFileSync(declarationPath, runtimeDeclaration);
    const imports: Record<string, string> = { "kody:runtime": declarationPath };
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      imports[name] = `npm:${name}@${version}`;
      imports[`${name}/`] = `npm:/${name}@${version}/`;
    }
    // noImplicitAny off: packages are small scripts whose params arrive as
    // JSON, and demanding annotations would reject most honest saves. What is
    // being caught here is breakage — a missing import, a typo, a wrong shape.
    writeFileSync(
      join(workspace, "deno.json"),
      JSON.stringify({ imports, compilerOptions: { noImplicitAny: false } }),
    );
    const targets = Object.values(manifest.exports).map((target) =>
      join(root, target),
    );
    await execFileAsync(
      denoBin,
      [
        "check",
        "--quiet",
        "--no-lock",
        "--config",
        join(workspace, "deno.json"),
        ...targets,
      ],
      { env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 8_000_000 },
    );
    return [];
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
    return [`deno check failed:\n${stderr || String(error)}`];
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// Import every export in the real sandbox without calling it: a module that
// throws while loading, or whose default export is not a function, is not
// something a job should discover at 8am.
async function dryImport(root: string, manifest: PackageManifest) {
  const exportNames = Object.keys(manifest.exports);
  const extraImports: Record<string, string> = {};
  const lines: Array<string> = [];
  exportNames.forEach((exportName, index) => {
    const specifier = `kody:staged/${index}`;
    extraImports[specifier] = join(root, manifest.exports[exportName] ?? "");
    lines.push(`import candidate${index} from '${specifier}'`);
  });
  const body = exportNames
    .map(
      (exportName, index) =>
        `  kinds[${JSON.stringify(exportName)}] = typeof candidate${index}`,
    )
    .join("\n");
  const outcome = await execute({
    code: `${lines.join("\n")}
export default async function main() {
  const kinds = {}
${body}
  return kinds
}`,
    timeoutMs: 30_000,
    extraImports,
    extraScopes: [
      {
        folder: root,
        packageName: manifest.name,
        dependencies: manifest.dependencies,
      },
    ],
  });
  if (outcome.error) return [`dry import failed:\n${outcome.error}`];
  const kinds = outcome.result as Record<string, string>;
  return Object.entries(kinds)
    .filter(([, kind]) => kind !== "function")
    .map(
      ([exportName, kind]) =>
        `Export "${exportName}" default-exports a ${kind}, not a function`,
    );
}

// Swap in one rename so a reader never sees a half-written package, keeping the
// old folder aside until the new one is in place.
function swapIntoPlace(staging: string, root: string) {
  const previous = `${staging}-previous`;
  mkdirSync(dirname(root), { recursive: true });
  if (existsSync(root)) renameSync(root, previous);
  try {
    renameSync(staging, root);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, root);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}

export async function savePackage(
  input: SavePackageInput,
): Promise<PackageManifest> {
  const root = packageRoot(input.name);
  const staging = join(stagingDir, `save-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  try {
    writeStagedFiles(staging, input.files);
    const manifestCheck = checkManifest(staging, input);
    if (manifestCheck.failures.length > 0)
      throw failure(manifestCheck.failures);

    const previous = getPackage(input.name);
    const resolved = await resolveDependencies(staging, {
      ...previous?.dependencies,
      ...input.dependencies,
    });
    if (resolved.failures.length > 0) throw failure(resolved.failures);

    const manifest: PackageManifest = {
      name: input.name,
      description: input.description,
      exports: input.exports,
      dependencies: resolved.dependencies,
      ...(manifestCheck.kody?.jobs ? { kody: manifestCheck.kody } : {}),
    };
    writeFileSync(
      join(staging, "package.json"),
      JSON.stringify(manifest, null, 2),
    );

    const failures = [
      ...(await typeCheck(staging, manifest)),
      ...(await dryImport(staging, manifest)),
    ];
    if (failures.length > 0) throw failure(failures);

    swapIntoPlace(staging, root);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function failure(failures: Array<string>) {
  const listed = failures.map((line) => `- ${line}`).join("\n");
  return new Error(
    `Package not saved; nothing changed on disk. Fix these and save again:\n${listed}`,
  );
}
