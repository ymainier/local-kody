import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { listPackages, savePackage } from "./packages.ts";
import { storageDir } from "./paths.ts";
import { defineCapability } from "./registry.ts";
import { listSecretNames } from "./secrets.ts";

const execFileAsync = promisify(execFile);

defineCapability({
  name: "notifySelf",
  domain: "notify",
  description:
    "Show a desktop notification to the user (macOS Notification Center). Use it to tell the user something finished or changed.",
  keywords: [
    "notify",
    "notification",
    "alert",
    "ping",
    "remind",
    "tell me",
    "message",
  ],
  inputSchema: z.object({
    title: z.string().min(1).describe("Short title"),
    message: z.string().min(1).describe("Body text"),
  }),
  async handler({ title, message }) {
    if (process.platform !== "darwin") {
      process.stderr.write(`[notifySelf] ${title}: ${message}\n`);
      return { delivered: false, reason: "Notifications need macOS" };
    }
    // argv keeps user text out of the AppleScript source.
    await execFileAsync("osascript", [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ]);
    return { delivered: true };
  },
});

defineCapability({
  name: "secretList",
  domain: "secrets",
  description:
    "List saved secret names and the hosts each one may be sent to. Values are never returned. Use a secret in fetch as {{secret:name}} in a URL, header or body.",
  keywords: ["secret", "token", "api key", "credential", "auth", "password"],
  inputSchema: z.object({}),
  async handler() {
    return listSecretNames();
  },
});

defineCapability({
  name: "packageSave",
  domain: "packages",
  description:
    'Save code as a reusable package. Each export is a module whose default export is an async function. Afterwards any execute call can `import fn from "kody:@scope/leaf/<export>"`. Read guide:packages first.',
  keywords: ["save", "package", "reuse", "persist code", "export", "publish"],
  destructive: true,
  inputSchema: z.object({
    name: z.string().describe("@scope/leaf, lowercase"),
    description: z.string().describe("One line: what it does"),
    files: z.record(z.string(), z.string()).describe("Relative path -> source"),
    exports: z
      .record(z.string(), z.string())
      .describe('"./name" -> "./file.ts"'),
  }),
  async handler(input) {
    return savePackage(input);
  },
});

defineCapability({
  name: "packageList",
  domain: "packages",
  description: "List saved packages with their descriptions and exports.",
  keywords: ["list", "packages", "saved code", "exports"],
  inputSchema: z.object({}),
  async handler() {
    return listPackages();
  },
});

// MVP storage: one JSON file per namespace. Kody stamps each module with its
// package id so code can only reach its own bucket; that comes later.
const storageInput = z.object({
  namespace: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe("Usually the package leaf"),
  key: z.string().min(1),
});

function readNamespace(namespace: string): Record<string, unknown> {
  const file = join(storageDir, `${namespace}.json`);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
}

defineCapability({
  name: "storageGet",
  domain: "storage",
  description:
    "Read a JSON value saved with storageSet. Returns null when missing.",
  keywords: ["storage", "state", "cursor", "remember", "read", "get"],
  inputSchema: storageInput,
  async handler({ namespace, key }) {
    return readNamespace(namespace)[key] ?? null;
  },
});

defineCapability({
  name: "storageSet",
  domain: "storage",
  description:
    "Save a JSON value (a cursor, last-seen id, settings) that survives between runs.",
  keywords: ["storage", "state", "cursor", "remember", "write", "set", "save"],
  inputSchema: storageInput.extend({ value: z.unknown() }),
  async handler({ namespace, key, value }) {
    const data = readNamespace(namespace);
    data[key] = value;
    writeFileSync(
      join(storageDir, `${namespace}.json`),
      JSON.stringify(data, null, 2),
    );
    return { saved: true };
  },
});
