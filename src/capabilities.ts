import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { listPackages, savePackage } from "./packages.ts";
import { defineCapability } from "./registry.ts";
import { listSecretNames } from "./secrets.ts";
import { getRun, listRuns } from "./store.ts";

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

defineCapability({
  name: "runList",
  domain: "runs",
  description:
    "List recorded runs, newest first: every job run, plus every execute that failed or carried an idempotencyKey. Results and logs are summarised; use runGet for one in full.",
  keywords: ["run", "history", "log", "failed", "job", "last", "record"],
  inputSchema: z.object({
    packageName: z.string().optional().describe("@scope/leaf"),
    jobName: z.string().optional(),
    status: z.enum(["running", "success", "error"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async handler(input) {
    return listRuns(input).map((run) => ({
      id: run.id,
      surface: run.surface,
      packageName: run.packageName,
      jobName: run.jobName,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      error: run.error ? run.error.split("\n")[0] : null,
    }));
  },
});

defineCapability({
  name: "runGet",
  domain: "runs",
  description:
    "Open one recorded run by id: its result, its error and the lines it logged.",
  keywords: ["run", "detail", "result", "error", "logs", "why"],
  inputSchema: z.object({ id: z.string().min(1) }),
  async handler({ id }) {
    return getRun(id);
  },
});
