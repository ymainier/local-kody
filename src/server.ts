import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "./capabilities.ts";
import { execute } from "./executor.ts";
import { importLegacyStorage } from "./package-storage.ts";
import { search, searchInputSchema } from "./search.ts";

// stdout is the MCP channel: never write logs there. Use stderr.
importLegacyStorage();

const instructions = `local-kody gives you a durable home: saved code (packages), secrets you can use but never read, and small state.
Two tools only:
1. search: find capabilities, saved packages, guides and secret names. Call it first. Open an entity ref to get its input type and a ready-to-run module.
2. execute: run ONE TypeScript ES module in a locked-down Deno sandbox. Default-export an async function main(params). Put varying values in params, not in the code.
Inside execute:
- import { kody } from 'kody:runtime' and call capabilities as await kody.<name>(input).
- Import npm packages by bare name (e.g. import { parse } from 'date-fns'); they resolve from npm.
- fetch works only through the host; write {{secret:name}} where a credential goes. You never see values.
- Import saved packages with import fn from 'kody:@scope/leaf/<export>'.
Prefer reusing a saved package over rewriting the logic. Offer to save working code as a package (read guide:packages first).`;

const executeInputSchema = z.object({
  code: z
    .string()
    .describe("One ES module. Default-export async function main(params)."),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Passed as the first argument to main"),
});

const server = new McpServer(
  { name: "local-kody", version: "0.1.0" },
  { instructions },
);

server.registerTool(
  "search",
  {
    title: "Search local-kody",
    description:
      "Find capabilities, saved packages, guides and secret names. Empty input lists domains. Pass entity refs to open details and a ready-to-run execute module.",
    inputSchema: searchInputSchema.shape,
    annotations: { readOnlyHint: true },
  },
  async (input) => ({ content: [{ type: "text", text: search(input) }] }),
);

server.registerTool(
  "execute",
  {
    title: "Execute a module",
    description:
      "Run one TypeScript ES module in a sandbox (no filesystem, no env, network only via the host). `import { kody } from 'kody:runtime'` for capabilities; npm packages import by bare name; fetch supports {{secret:name}} placeholders.",
    inputSchema: executeInputSchema.shape,
  },
  async (input) => {
    const outcome = await execute(input);
    return {
      content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
      isError: outcome.error ? true : undefined,
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("local-kody MCP server ready on stdio\n");
