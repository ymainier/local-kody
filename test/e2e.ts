// Drives the MCP server over stdio exactly as Claude Desktop would.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolText = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ExecuteResult = {
  result?: unknown;
  error?: string;
  logs: Array<string>;
  durationMs: number;
};

// Fake "GitHub" that checks the bearer token and serves public events.
const api = createServer((request, response) => {
  if (request.headers.authorization !== "Bearer gh-test-token") {
    response.statusCode = 401;
    return response.end(JSON.stringify({ message: "Bad credentials" }));
  }
  response.end(
    JSON.stringify([
      {
        id: "3",
        type: "ReleaseEvent",
        repo: { name: "kody-bot/tool" },
        payload: { action: "published" },
      },
      {
        id: "2",
        type: "PushEvent",
        repo: { name: "kody-bot/tool" },
        payload: {},
      },
      {
        id: "1",
        type: "CreateEvent",
        repo: { name: "kody-bot/new" },
        payload: { ref_type: "repository" },
      },
    ]),
  );
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

const kodyHome = mkdtempSync(join(tmpdir(), "local-kody-home-"));
writeFileSync(
  join(kodyHome, "secrets.json"),
  JSON.stringify({
    githubToken: { value: "gh-test-token", allowedHosts: ["127.0.0.1"] },
  }),
);

const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "src", "server.ts")],
    env: { ...(process.env as Record<string, string>), KODY_HOME: kodyHome },
    stderr: "ignore",
  }),
);

async function callText(name: string, args: Record<string, unknown>) {
  const response = (await client.callTool({
    name,
    arguments: args,
  })) as ToolText;
  return {
    text: response.content[0]?.text ?? "",
    isError: response.isError === true,
  };
}

async function run(code: string, params: Record<string, unknown> = {}) {
  const { text } = await callText("execute", { code, params });
  return JSON.parse(text) as ExecuteResult;
}

const report: Array<{ step: string; ok: boolean; detail: string }> = [];
async function step(name: string, check: () => Promise<string>) {
  try {
    report.push({ step: name, ok: true, detail: await check() });
  } catch (error) {
    report.push({
      step: name,
      ok: false,
      detail: (error as Error).message.slice(0, 160),
    });
  }
}

await step("tools/list exposes exactly search + execute", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "execute",
    "search",
  ]);
  return tools.map((tool) => tool.name).join(", ");
});

await step("empty search returns the domain index", async () => {
  const { text } = await callText("search", {});
  assert.match(text, /# Domains/);
  return text.split("\n").slice(1, 3).join(" | ");
});

await step('"ping me when it is done" ranks notifySelf first', async () => {
  const { text } = await callText("search", {
    query: "ping me when it is done",
  });
  assert.match(text.split("\n")[1] ?? "", /capability:notifySelf/);
  return text.split("\n")[1] ?? "";
});

await step("entity lookup returns a ready-to-run module", async () => {
  const { text } = await callText("search", {
    entity: "capability:notifySelf",
  });
  assert.match(text, /kody\.notifySelf\(params\)/);
  return "snippet present";
});

await step(
  "npm import + capability + secret placeholder in one module",
  async () => {
    const outcome = await run(
      `import { formatDistanceStrict } from 'date-fns'
import { kody } from 'kody:runtime'
export default async function main(params) {
  const secrets = await kody.secretList()
  const response = await fetch(params.url + '/users/kody-bot/events/public', {
    headers: { authorization: 'Bearer {{secret:githubToken}}' },
  })
  const events = await response.json()
  return { status: response.status, events: events.length, secrets: secrets.map((s) => s.name), age: formatDistanceStrict(new Date(2026, 0, 1), new Date(2026, 8, 19)) }
}`,
      { url: apiUrl },
    );
    assert.equal(outcome.error, undefined, outcome.error ?? "");
    assert.deepEqual(outcome.result, {
      status: 200,
      events: 3,
      secrets: ["githubToken"],
      age: "9 months",
    });
    return `${JSON.stringify(outcome.result)} in ${outcome.durationMs} ms`;
  },
);

const whatShippedSource = `import { kody } from 'kody:runtime'
export default async function whatShipped({ baseUrl, login }) {
  const sinceId = await kody.storageGet({ namespace: 'what-shipped', key: login })
  const response = await fetch(baseUrl + '/users/' + login + '/events/public', {
    headers: { authorization: 'Bearer {{secret:githubToken}}' },
  })
  const events = await response.json()
  const fresh = sinceId ? events.filter((event) => Number(event.id) > Number(sinceId)) : events
  const shipped = fresh
    .filter((event) => (event.type === 'ReleaseEvent' && event.payload.action === 'published') || (event.type === 'CreateEvent' && event.payload.ref_type === 'repository'))
    .map((event) => event.type + ' ' + event.repo.name)
  if (events[0]) await kody.storageSet({ namespace: 'what-shipped', key: login, value: events[0].id })
  return { shipped, message: shipped.length ? shipped.length + ' new' : 'nothing new' }
}`;

await step("packageSave stores the module as @me/what-shipped", async () => {
  const outcome = await run(
    `import { kody } from 'kody:runtime'
export default async function main(params) { return await kody.packageSave(params) }`,
    {
      name: "@me/what-shipped",
      description:
        "Releases and new repos a GitHub user shipped since last check",
      files: { "what-shipped.ts": whatShippedSource },
      exports: { "./whatShipped": "./what-shipped.ts" },
    },
  );
  assert.equal(outcome.error, undefined, outcome.error ?? "");
  return "saved";
});

await step(
  "search for the task now finds the saved package first",
  async () => {
    const { text } = await callText("search", {
      query: "what did kody-bot ship",
    });
    assert.match(text.split("\n")[1] ?? "", /package:@me\/what-shipped/);
    return text.split("\n")[1] ?? "";
  },
);

await step("invoking the saved export twice advances its cursor", async () => {
  const code = `import whatShipped from 'kody:@me/what-shipped/whatShipped'
export default async function main(params) { return await whatShipped(params) }`;
  const first = await run(code, { baseUrl: apiUrl, login: "kody-bot" });
  const second = await run(code, { baseUrl: apiUrl, login: "kody-bot" });
  assert.deepEqual((first.result as { shipped: Array<string> }).shipped, [
    "ReleaseEvent kody-bot/tool",
    "CreateEvent kody-bot/new",
  ]);
  assert.equal((second.result as { message: string }).message, "nothing new");
  return `1st: ${JSON.stringify(first.result)} / 2nd: ${JSON.stringify(second.result)}`;
});

await step("secret refused for a host it is not approved for", async () => {
  const outcome = await run(
    `export default async function main(params) {
  return (await fetch(params.url, { headers: { authorization: 'Bearer {{secret:githubToken}}' } })).status
}`,
    { url: apiUrl.replace("127.0.0.1", "localhost") },
  );
  assert.match(outcome.error ?? "", /not approved for host localhost/);
  return (outcome.error ?? "").split("\n")[0] ?? "";
});

await step(
  "sandbox cannot read files, env, spawn or open sockets",
  async () => {
    const outcome = await run(`export default async function main() {
  const attempt = async (fn) => { try { await fn(); return 'ALLOWED' } catch (e) { return e.name } }
  return {
    readFile: await attempt(() => Deno.readTextFile('/etc/hosts')),
    env: await attempt(() => Deno.env.get('HOME')),
    spawn: await attempt(() => new Deno.Command('ls').output()),
    socket: await attempt(() => Deno.connect({ hostname: '1.1.1.1', port: 443 })),
  }
}`);
    assert.deepEqual(outcome.result, {
      readFile: "NotCapable",
      env: "NotCapable",
      spawn: "NotCapable",
      socket: "NotCapable",
    });
    return JSON.stringify(outcome.result);
  },
);

await client.close();
api.close();
console.table(report);
process.exitCode = report.every((entry) => entry.ok) ? 0 : 1;
