# local-kody

A local, single-user take on [kentcdodds/kody](https://github.com/kentcdodds/kody): an MCP server with exactly two tools.

- `search` finds capabilities, saved packages, guides and secret names.
- `execute` runs one TypeScript module in a Deno sandbox. The sandbox has no filesystem, no env, no subprocesses, and network access to one local gateway port only.

Saved code can also carry jobs: a cron schedule the daemon runs with no model in the loop, notifying you only when something happened.

The MCP server you point a client at is a thin proxy. All the work happens in a background daemon that owns the SQLite store, the gateway and the sandbox, so it outlives the app and several clients can share one copy of the state.

Inside `execute`, code calls `kody.<capability>()`, imports npm packages by bare name, imports saved packages as `kody:@me/<leaf>/<export>`, keeps state in `packageStorage()`, and writes `{{secret:name}}` wherever a credential goes. The gateway swaps in the real value, and only for hosts you approved.

## Requirements

- macOS or Linux, Node.js 22.18 or newer (runs `.ts` directly)
- Deno comes from npm as a dependency; nothing else to install

## Setup

```bash
npm install
npm test               # scheduler checks, then end-to-end over MCP stdio
npm run daemon:install # launchd agent: starts at login, restarts on crash
```

`npm run daemon` runs the daemon in the foreground instead; `npm run daemon:logs` tails its log and `npm run daemon:uninstall` removes the agent.

Secrets are set by you, never by the agent:

```bash
npm run secret -- set githubToken ghp_xxx --host api.github.com
npm run secret -- allow githubToken uploads.github.com
npm run secret -- list
```

State lives in `~/.local-kody` (override with `KODY_HOME`): `packages/`, `kody.db` (SQLite), `secrets.json` (mode 0600), `daemon.sock` (mode 0600, override with `KODY_SOCKET`) and `logs/`.

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

3. Quit Claude Desktop fully (Cmd+Q) and reopen it. `local-kody` should appear with two tools. The daemon keeps running while the app is closed.
4. If it doesn't, read `~/Library/Logs/Claude/mcp-server-local-kody.log`.

## First prompts to try

1. "Use local-kody to send me a notification saying hello." Search, then one execute calling `kody.notifySelf`. A macOS notification appears.
2. "With local-kody, how many days until Christmas? Use date-fns." Exercises an npm import. The first run downloads the package.
3. "Using local-kody, what did kody-bot ship on GitHub recently? Save it as a package so I can ask again." Uses the `githubToken` secret, then `packageSave`.

## Layout

| File                  | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `src/server.ts`       | MCP stdio proxy: forwards `search` and `execute` to the daemon socket      |
| `src/daemon.ts`       | Long-lived host: store, gateway, executor, search over a Unix socket       |
| `src/tools.ts`        | The two tool schemas and the server instructions, shared by both           |
| `src/launchd.ts`      | `daemon:install` / `daemon:uninstall` / `daemon:logs`                      |
| `src/registry.ts`     | `defineCapability`, Zod-validated host functions                           |
| `src/capabilities.ts` | `notifySelf`, `secretList`, `packageSave`, `packageList`                   |
| `src/search.ts`       | Lexical ranking, domain index, entity detail with ready-to-run modules     |
| `src/executor.ts`     | Import scanning, import map, `deno run` with locked permissions            |
| `src/gateway.ts`      | The sandbox's only reachable address: `/call`, `/fetch`, `/log`, `/settle` |
| `src/secrets.ts`      | Secret store and `{{secret:name}}` substitution per approved host          |
| `src/packages.ts`     | Saved packages and `kody:@scope/leaf/export` resolution                    |
| `src/store.ts`        | SQLite store: versioned migrations and package storage                     |
| `guides/*.md`         | Docs for the agent, found through search                                   |
