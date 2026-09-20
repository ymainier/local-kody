// A minimal stdio MCP server for the suite to call through local-kody.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "echo-fixture", version: "0.0.0" },
  { instructions: "A fixture server. It echoes text and reports its token." },
);

server.registerTool(
  "echo",
  {
    description: "Return the text you sent",
    inputSchema: { text: z.string().describe("Anything at all") },
  },
  async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
);

server.registerTool(
  "whoami",
  {
    description: "Report the credential this server was started with",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "text" as const, text: process.env.ECHO_TOKEN ?? "no token" },
    ],
  }),
);

await server.connect(new StdioServerTransport());
