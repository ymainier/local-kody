import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { packagesDir } from "./paths.ts";

// A package is a folder with a package.json whose `exports` map names the
// callable modules. Code imports them as `kody:@scope/leaf/<export>`.
export type PackageManifest = {
  name: string;
  description: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  kody?: { jobs?: Record<string, JobDefinition> };
};

export type JobDefinition = z.infer<typeof jobDefinitionSchema>;

export const jobDefinitionSchema = z.object({
  entry: z
    .string()
    .describe("Package-local module whose default export takes no arguments"),
  schedule: z.object({
    type: z.literal("cron"),
    expression: z.string().min(1).describe('Five fields, e.g. "0 8 * * *"'),
  }),
  timezone: z.string().optional().describe('IANA name, e.g. "Europe/London"'),
  enabled: z.boolean().optional(),
});

export const packageKodySchema = z.object({
  jobs: z.record(z.string(), jobDefinitionSchema).optional(),
});

const packageNamePattern = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

export function packageRoot(name: string) {
  if (!packageNamePattern.test(name)) {
    throw new Error(
      `Package name "${name}" must look like @scope/leaf (lowercase)`,
    );
  }
  return join(packagesDir, name);
}

export function listPackages(): Array<PackageManifest> {
  const manifests: Array<PackageManifest> = [];
  for (const scope of readdirSync(packagesDir)) {
    if (!scope.startsWith("@")) continue;
    for (const leaf of readdirSync(join(packagesDir, scope))) {
      const manifestPath = join(packagesDir, scope, leaf, "package.json");
      if (existsSync(manifestPath)) {
        manifests.push(
          JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest,
        );
      }
    }
  }
  return manifests;
}

export function getPackage(name: string) {
  const manifestPath = join(packageRoot(name), "package.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

// `kody:@me/what-shipped/whatShipped` -> absolute file path of that export.
export function parseKodyImport(specifier: string) {
  const match = /^kody:(@[a-z0-9-]+\/[a-z0-9-]+)\/(.+)$/.exec(specifier);
  if (!match) throw new Error(`Bad package import "${specifier}"`);
  return { name: match[1] ?? "", exportName: match[2] ?? "" };
}

export function resolveKodyImport(specifier: string) {
  const { name, exportName } = parseKodyImport(specifier);
  const manifest = getPackage(name);
  if (!manifest) throw new Error(`No saved package named ${name}`);
  const target = manifest.exports[`./${exportName}`];
  if (!target) {
    throw new Error(
      `Package ${name} has no export "./${exportName}". Exports: ${Object.keys(manifest.exports).join(", ")}`,
    );
  }
  return join(packageRoot(name), target);
}
