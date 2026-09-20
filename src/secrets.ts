import { existsSync, readFileSync, rmSync } from "node:fs";
import { keychain } from "./keychain.ts";
import { secretsFile } from "./paths.ts";
import {
  deleteSecretMeta,
  getSecretMeta,
  listSecretMeta,
  saveSecretMeta,
} from "./store.ts";

// The name is also the Keychain account and goes into a `security` command
// line, so keep it to the characters the placeholder already allows.
const namePattern = /^[a-zA-Z0-9_]+$/;
const placeholderPattern = /\{\{secret:([a-zA-Z0-9_]+)\}\}/g;

export async function setSecret(
  name: string,
  value: string,
  allowedHosts: Array<string>,
) {
  if (!namePattern.test(name)) {
    throw new Error(`Secret name "${name}" must match ${String(namePattern)}`);
  }
  await keychain().set(name, value);
  // A write that cannot be read back is worse than a failed write: the
  // placeholder would resolve to nothing at 9am inside a job.
  if ((await keychain().get(name)) !== value) {
    throw new Error(`Stored "${name}" but could not read it back unchanged`);
  }
  return saveSecretMeta(name, allowedHosts);
}

export function allowSecretHost(name: string, host: string) {
  const secret = getSecretMeta(name);
  if (!secret) throw new Error(`No secret named "${name}"`);
  return saveSecretMeta(name, [...new Set([...secret.allowedHosts, host])]);
}

export async function removeSecret(name: string) {
  await keychain().remove(name);
  return deleteSecretMeta(name);
}

// Names and hosts only. There is deliberately no way to read a value back.
export function listSecretNames() {
  return listSecretMeta().map((secret) => ({
    name: secret.name,
    allowedHosts: secret.allowedHosts,
  }));
}

export function hostOf(url: string) {
  return new URL(url.replace(placeholderPattern, "placeholder")).hostname;
}

export async function substituteSecrets(text: string, host: string) {
  const names = new Set(
    [...text.matchAll(placeholderPattern)].map((match) => match[1] ?? ""),
  );
  if (names.size === 0) return text;
  const values = new Map<string, string>();
  for (const name of names) {
    const secret = getSecretMeta(name);
    if (!secret) {
      throw new Error(
        `Missing secret "${name}". Ask the user to run: npm run secret -- set ${name} <value> --host ${host}`,
      );
    }
    if (!secret.allowedHosts.includes(host)) {
      throw new Error(
        `Secret "${name}" is not approved for host ${host}. Ask the user to run: npm run secret -- allow ${name} ${host}`,
      );
    }
    const value = await keychain().get(name);
    if (value === null) {
      throw new Error(
        `Secret "${name}" is known but its value is not in the Keychain. Ask the user to run: npm run secret -- set ${name} <value> --host ${host}`,
      );
    }
    values.set(name, value);
  }
  return text.replace(placeholderPattern, (_, name: string) =>
    String(values.get(name)),
  );
}

// One-way trip out of the phase 1 plaintext file. Every value is written to
// the Keychain and read back before the file goes, so a half-migration cannot
// lose a secret.
export async function migrateSecretsFile() {
  if (!existsSync(secretsFile)) {
    return { migrated: [], removed: false as boolean };
  }
  const store = JSON.parse(readFileSync(secretsFile, "utf8")) as Record<
    string,
    { value: string; allowedHosts?: Array<string> }
  >;
  const migrated: Array<string> = [];
  for (const [name, record] of Object.entries(store)) {
    await setSecret(name, record.value, record.allowedHosts ?? []);
    migrated.push(name);
  }
  rmSync(secretsFile);
  return { migrated, removed: true as boolean };
}
