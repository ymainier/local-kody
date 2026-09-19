import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { listPackages } from "./packages.ts";
import { storageDir } from "./paths.ts";
import { storageSet } from "./store.ts";

// Phase 1 addressed storage by a free-form namespace. A namespace that matches
// a saved package's leaf belongs to that package; anything else is kept under a
// `legacy:` owner so nothing silently claims a package's bucket.
export function storageOwnerFor(namespace: string) {
  const owner = listPackages().find(
    (manifest) => manifest.name.split("/")[1] === namespace,
  );
  return owner ? owner.name : `legacy:${namespace}`;
}

// One-time move of ~/.local-kody/storage/*.json into the database. The folder
// is renamed once it lands so a later start finds nothing to do.
export function importLegacyStorage() {
  if (!existsSync(storageDir)) return { imported: 0 };
  let imported = 0;
  for (const file of readdirSync(storageDir)) {
    if (!file.endsWith(".json")) continue;
    const namespace = file.replace(/\.json$/, "");
    const owner = storageOwnerFor(namespace);
    const data = JSON.parse(
      readFileSync(join(storageDir, file), "utf8"),
    ) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      storageSet(owner, key, value);
      imported += 1;
    }
  }
  const archive = existsSync(`${storageDir}.imported`)
    ? `${storageDir}.imported-${Date.now()}`
    : `${storageDir}.imported`;
  renameSync(storageDir, archive);
  return { imported };
}
