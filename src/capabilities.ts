import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { listJobs, runJobOnce, updateJob } from "./jobs.ts";
import {
  describeIntegrations,
  revokeIntegration,
  startIntegration,
} from "./integrations.ts";
import {
  addMcpServer,
  describeMcpServers,
  removeMcpServer,
  updateMcpServer,
} from "./mcp.ts";
import { listPackages, packageKodySchema } from "./packages.ts";
import { savePackage } from "./publish.ts";
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
    if (process.platform !== "darwin" || process.env.KODY_NOTIFY === "stderr") {
      process.stderr.write(`[notifySelf] ${title}: ${message}\n`);
      return { delivered: false, reason: "No Notification Center here" };
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
  name: "integrationList",
  domain: "integrations",
  description:
    'List saved OAuth connections: id, status ("not_connected", "connected" or "needs_reconnect"), scopes, approved hosts and when the access token expires. Tokens are never returned. Spend one in fetch by writing {{integration:id}} where the bearer token goes. Read guide:integrations first.',
  keywords: [
    "integration",
    "oauth",
    "connect",
    "google",
    "calendar",
    "gmail",
    "linear",
    "notion",
    "account",
    "login",
  ],
  inputSchema: z.object({}),
  async handler() {
    return describeIntegrations();
  },
});

defineCapability({
  name: "integrationStart",
  domain: "integrations",
  description:
    'Begin connecting an OAuth integration. Returns the authorize URL and opens it in the user\'s browser; only the user can approve it, so say so and stop. Poll integrationList afterwards: the status becomes "connected" when they have, or lastError says what went wrong.',
  keywords: [
    "integration",
    "oauth",
    "connect",
    "authorize",
    "reconnect",
    "login",
  ],
  destructive: true,
  inputSchema: z.object({
    id: z.string().describe('Integration id, e.g. "google"'),
    scopes: z
      .array(z.string())
      .optional()
      .describe("Override the scopes the integration was configured with"),
  }),
  async handler(input) {
    return startIntegration(input);
  },
});

defineCapability({
  name: "integrationRevoke",
  domain: "integrations",
  description:
    "Forget an integration's tokens. Its provider config stays, so integrationStart can connect it again without the user re-entering anything.",
  keywords: ["integration", "revoke", "disconnect", "forget", "sign out"],
  destructive: true,
  inputSchema: z.object({ id: z.string() }),
  async handler({ id }) {
    return revokeIntegration(id);
  },
});

defineCapability({
  name: "mcpList",
  domain: "mcp",
  description:
    "List the MCP servers local-kody can call, with their transport, whether they are enabled and the tools each one offers. Call one from sandbox code as await kody.mcp['<server>'].<tool>(args). Open search entity mcp-server:<name> for input types. Read guide:mcp first.",
  keywords: [
    "mcp",
    "server",
    "tool",
    "external",
    "connect",
    "linear",
    "filesystem",
  ],
  inputSchema: z.object({}),
  async handler() {
    return describeMcpServers();
  },
});

defineCapability({
  name: "mcpAdd",
  domain: "mcp",
  description:
    "Register another MCP server so packages can call its tools. The server is started once straight away to check it works and to read its tool list; if it will not start, nothing is saved. Ask the user before adding a server that is not already on their machine.",
  keywords: ["mcp", "add", "register", "server", "install", "connect"],
  destructive: true,
  inputSchema: z.object({
    name: z.string().describe("Short lowercase id you will call it by"),
    transport: z
      .enum(["stdio", "http"])
      .optional()
      .describe("Defaults to http when url is given, stdio otherwise"),
    command: z.string().optional().describe('For stdio, e.g. "npx"'),
    args: z.array(z.string()).optional(),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'For stdio. A value of "{{secret:name}}" is replaced with that secret when the server starts.',
      ),
    url: z.string().optional().describe("For http"),
    auth: z
      .string()
      .optional()
      .describe('"none", "secret:<name>" or "integration:<id>" (http only)'),
  }),
  async handler(input) {
    return addMcpServer(input);
  },
});

defineCapability({
  name: "mcpUpdate",
  domain: "mcp",
  description:
    "Turn an MCP server on or off. A disabled server refuses calls and keeps its configuration.",
  keywords: ["mcp", "enable", "disable", "pause", "server"],
  destructive: true,
  inputSchema: z.object({ name: z.string(), enabled: z.boolean() }),
  async handler(input) {
    return updateMcpServer(input);
  },
});

defineCapability({
  name: "mcpRemove",
  domain: "mcp",
  description: "Forget an MCP server entirely.",
  keywords: ["mcp", "remove", "delete", "forget", "server"],
  destructive: true,
  inputSchema: z.object({ name: z.string() }),
  async handler({ name }) {
    return removeMcpServer(name);
  },
});

defineCapability({
  name: "packageSave",
  domain: "packages",
  description:
    'Save code as a reusable package. Each export is a module whose default export is an async function. Afterwards any execute call can `import fn from "kody:@scope/leaf/<export>"`. `files` is the whole package: it replaces the previous version. The save is checked (exports exist, npm versions pinned, deno check, dry import) and rejected as a whole if any check fails, so a bad save leaves the old version running. Read guide:packages first.',
  keywords: ["save", "package", "reuse", "persist code", "export", "publish"],
  destructive: true,
  inputSchema: z.object({
    name: z.string().describe("@scope/leaf, lowercase"),
    description: z.string().describe("One line: what it does"),
    files: z
      .record(z.string(), z.string())
      .describe("Relative path -> source. The complete package."),
    exports: z
      .record(z.string(), z.string())
      .describe('"./name" -> "./file.ts"'),
    dependencies: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Exact npm versions to pin. Anything missing is resolved to the latest.",
      ),
    kody: packageKodySchema
      .optional()
      .describe("Package manifest extras, currently { jobs }. See guide:jobs."),
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

defineCapability({
  name: "jobList",
  domain: "jobs",
  description:
    "List the jobs saved packages declare, with their schedule, whether they are enabled, when they run next and how the last run went.",
  keywords: ["job", "schedule", "cron", "daily", "recurring", "automation"],
  inputSchema: z.object({}),
  async handler() {
    return listJobs();
  },
});

defineCapability({
  name: "jobRunNow",
  domain: "jobs",
  description:
    "Run one declared job immediately and record it. A job must succeed here at least once before it can be enabled.",
  keywords: ["job", "run", "now", "test", "try", "trigger"],
  destructive: true,
  inputSchema: z.object({
    packageName: z.string().describe("@scope/leaf"),
    jobName: z.string(),
  }),
  async handler({ packageName, jobName }) {
    const outcome = await runJobOnce(packageName, jobName);
    return {
      runId: outcome.runId,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
      logs: outcome.logs,
      durationMs: outcome.durationMs,
    };
  },
});

defineCapability({
  name: "jobUpdate",
  domain: "jobs",
  description:
    "Turn a job on or off, or override its cron expression and timezone. The job's name and entry stay in the package; this only changes when it runs.",
  keywords: [
    "job",
    "enable",
    "disable",
    "schedule",
    "cron",
    "timezone",
    "pause",
  ],
  destructive: true,
  inputSchema: z.object({
    packageName: z.string().describe("@scope/leaf"),
    jobName: z.string(),
    enabled: z.boolean().optional(),
    expression: z
      .string()
      .optional()
      .describe('Five cron fields, e.g. "0 8 * * *"'),
    timezone: z.string().optional().describe('IANA name, e.g. "Europe/London"'),
  }),
  async handler(input) {
    return updateJob(input);
  },
});
