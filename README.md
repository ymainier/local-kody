# local-kody

A local, single-user take on [kentcdodds/kody](https://github.com/kentcdodds/kody): an MCP server with exactly two tools.

- `search` finds capabilities, saved packages, guides and secret names.
- `execute` runs one TypeScript module in a Deno sandbox. The sandbox has no filesystem, no env, no subprocesses, and network access to one local gateway port only.

Inside `execute`, code calls `kody.<capability>()`, imports npm packages by bare name, imports saved packages as `kody:@me/<leaf>/<export>`, and writes `{{secret:name}}` wherever a credential goes. The gateway swaps in the real value, and only for hosts you approved.

## Requirements

- macOS or Linux, Node.js 22.18 or newer (runs `.ts` directly)
- Deno comes from npm as a dependency; nothing else to install

## Setup

```bash
npm install
npm test          # end-to-end checks, driving the server over MCP stdio
```

Secrets are set by you, never by the agent:

```bash
npm run secret -- set githubToken ghp_xxx --host api.github.com
npm run secret -- allow githubToken uploads.github.com
npm run secret -- list
```

State lives in `~/.local-kody` (override with `KODY_HOME`): `packages/`, `kody.db` (SQLite), `secrets.json` (mode 0600).

## Claude Desktop

1. Run `which node` in a terminal. Claude Desktop does not inherit your shell's PATH, so use that absolute path.
2. Claude Desktop → Settings → Developer → Edit Config, which opens `~/Library/Application Support/Claude/claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "local-kody": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/<you>/src/local-kody/src/server.ts"]
    }
  }
}
```

3. Quit Claude Desktop fully (Cmd+Q) and reopen it. `local-kody` should appear with two tools.
4. If it doesn't, read `~/Library/Logs/Claude/mcp-server-local-kody.log`.

## First prompts to try

1. "Use local-kody to send me a notification saying hello." Search, then one execute calling `kody.notifySelf`. A macOS notification appears.
2. "With local-kody, how many days until Christmas? Use date-fns." Exercises an npm import. The first run downloads the package.
3. "Using local-kody, what did kody-bot ship on GitHub recently? Save it as a package so I can ask again." Uses the `githubToken` secret, then `packageSave`.

## Layout

| File                  | Role                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `src/server.ts`       | MCP stdio server: `search`, `execute`, server instructions                           |
| `src/registry.ts`     | `defineCapability`, Zod-validated host functions                                     |
| `src/capabilities.ts` | `notifySelf`, `secretList`, `packageSave`, `packageList`, `storageGet`, `storageSet` |
| `src/search.ts`       | Lexical ranking, domain index, entity detail with ready-to-run modules               |
| `src/executor.ts`     | Import scanning, import map, `deno run` with locked permissions                      |
| `src/gateway.ts`      | The sandbox's only reachable address: `/call`, `/fetch`, `/log`, `/settle`           |
| `src/secrets.ts`      | Secret store and `{{secret:name}}` substitution per approved host                    |
| `src/packages.ts`     | Saved packages and `kody:@scope/leaf/export` resolution                              |
| `src/store.ts`        | SQLite store: versioned migrations and package storage                               |
| `guides/*.md`         | Docs for the agent, found through search                                             |
