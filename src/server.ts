import { request as httpRequest } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { socketFile } from "./paths.ts";
import {
  executeInputSchema,
  executeToolDescription,
  instructions,
  searchInputSchema,
  searchToolDescription,
} from "./tools.ts";

// stdout is the MCP channel: never write logs there. Use stderr.
// This process is a proxy and nothing else. Every MCP client spawns its own
// copy, so keeping the store, the sandbox and the scheduler in one daemon is
// what stops several copies racing each other.
const startHint = `The local-kody daemon is not running, so no tool can do any work.
Ask the user to start it: \`npm run daemon:install\` installs it as a launchd agent, or \`npm run daemon\` runs it in the foreground.
Logs: \`npm run daemon:logs\`.`;

type DaemonEnvelope = { result?: unknown; error?: string };

function callDaemon(path: string, body: unknown) {
  return new Promise<DaemonEnvelope>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: socketFile,
        path,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(
              JSON.parse(
                Buffer.concat(chunks).toString("utf8") || "{}",
              ) as DaemonEnvelope,
            );
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body ?? {}));
  });
}

async function forward(path: string, body: unknown): Promise<DaemonEnvelope> {
  try {
    return await callDaemon(path, body);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return { error: startHint };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const server = new McpServer(
  { name: "local-kody", version: "0.2.0" },
  { instructions },
);

server.registerTool(
  "search",
  {
    title: "Search local-kody",
    description: searchToolDescription,
    inputSchema: searchInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => {
    const envelope = await forward("/tools/search", input);
    const text = envelope.error ?? (envelope.result as { text: string }).text;
    return {
      content: [{ type: "text" as const, text }],
      isError: envelope.error ? true : undefined,
    };
  },
);

server.registerTool(
  "execute",
  {
    title: "Execute a module",
    description: executeToolDescription,
    inputSchema: executeInputSchema.shape,
  },
  async (input) => {
    const envelope = await forward("/tools/execute", input);
    const outcome = envelope.error
      ? { error: envelope.error, logs: [], durationMs: 0 }
      : (envelope.result as { error?: string });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(outcome, null, 2) },
      ],
      isError: outcome.error ? true : undefined,
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("local-kody MCP proxy ready on stdio\n");
