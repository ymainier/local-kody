# local-kody

A local, single-user take on [kentcdodds/kody](https://github.com/kentcdodds/kody): an MCP server with exactly two tools.

- `search` finds capabilities, saved packages, guides and secret names.
- `execute` runs one TypeScript module in a Deno sandbox. The sandbox has no filesystem, no env, no subprocesses, and network access to one local gateway port only.

Inside `execute`, code calls `kody.<capability>()`, imports npm packages by bare name, imports saved packages as `kody:@me/<leaf>/<export>`, keeps state in `packageStorage()`, and writes `{{secret:name}}` wherever a credential goes. The gateway swaps in the real value, and only for hosts you approved.

Saved code can carry jobs. A job is a cron schedule the daemon runs with no model in the loop, and it notifies you only when something happened.

## How it fits together

```
Claude Desktop / Claude Code / Cursor
   └─ src/server.ts: thin stdio MCP proxy ──unix socket──► src/daemon.ts (launchd, KeepAlive)
                                                              ├─ gateway + Deno executor
                                                              ├─ scheduler
                                                              └─ SQLite store (~/.local-kody/kody.db)
```

The process your MCP client spawns is a proxy and nothing else. Claude Desktop owns that process, so it dies with the app, and every client spawns its own copy. Jobs need something that outlives the app, and one writer keeps those copies from racing each other on the store.

## Requirements

- macOS or Linux, Node.js 22.18 or newer (runs `.ts` directly)
- Deno comes from npm as a dependency; nothing else to install

## Setup

```bash
npm install
npm test               # 32 checks: the scheduler with a fake clock, then end-to-end over MCP stdio
npm run daemon:install # launchd agent: starts at login, restarts after a crash
```

`npm run daemon` runs it in the foreground instead. `npm run daemon:logs` prints the last 200 lines of the log, and `npm run daemon:uninstall` removes the agent.

Secrets are set by you, never by the agent:

```bash
npm run secret -- set githubToken ghp_xxx --host api.github.com
npm run secret -- allow githubToken uploads.github.com
npm run secret -- list
```

## Where state lives

`~/.local-kody`:

| Path           | What                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `packages/`    | One folder per saved package. The folder is the source of truth.       |
| `kody.db`      | SQLite (WAL): package storage, run records, job schedule state         |
| `secrets.json` | Secret values and their approved hosts, mode 0600                      |
| `daemon.sock`  | The daemon's only listener, mode 0600. There is no TCP port.           |
| `logs/`        | `daemon.log`, where launchd sends stdout and stderr                    |
| `staging/`     | Where a package is written and checked before it is swapped into place |

Environment variables, all optional:

| Variable                     | Default                      | Why you would set it                                    |
| ---------------------------- | ---------------------------- | ------------------------------------------------------- |
| `KODY_HOME`                  | `~/.local-kody`              | Run against a scratch home                              |
| `KODY_DB`                    | `$KODY_HOME/kody.db`         | Point at another database file                          |
| `KODY_SOCKET`                | `$KODY_HOME/daemon.sock`     | Run a second daemon alongside the real one              |
| `KODY_DENO_BIN`              | the npm-installed Deno       | Use your own Deno                                       |
| `KODY_NPM_REGISTRY`          | `https://registry.npmjs.org` | Pin versions from a private registry                    |
| `KODY_NOTIFY`                | unset                        | `stderr` keeps notifications out of Notification Center |
| `KODY_SCHEDULER_INTERVAL_MS` | `30000`                      | Tick the scheduler faster                               |

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

3. Quit Claude Desktop fully (Cmd+Q) and reopen it. `local-kody` should appear with two tools. The daemon keeps running while the app is closed, which is what lets jobs fire.
4. If it doesn't appear, read `~/Library/Logs/Claude/mcp-server-local-kody.log`. If the tools answer with "the daemon is not running", start it with `npm run daemon:install`.

## First prompts to try

1. "Use local-kody to send me a notification saying hello." Search, then one execute calling `kody.notifySelf`. A macOS notification appears.
2. "With local-kody, how many days until Christmas? Use date-fns." Exercises an npm import. The first run downloads the package.
3. "Using local-kody, what did kody-bot ship on GitHub recently? Save it as a package so I can ask again." Uses the `githubToken` secret, then `packageSave`.
4. "Have local-kody run that every morning at 8 and only tell me when something shipped." Adds a job to the package, runs it once by hand, then enables it.

## What the agent can call

Capabilities are host functions the sandbox reaches as `kody.<name>(input)`. They are never MCP tools of their own: `search` surfaces them and `execute` calls them.

| Domain     | Capabilities                        |
| ---------- | ----------------------------------- |
| `notify`   | `notifySelf`                        |
| `secrets`  | `secretList`                        |
| `packages` | `packageSave`, `packageList`        |
| `runs`     | `runList`, `runGet`                 |
| `jobs`     | `jobList`, `jobRunNow`, `jobUpdate` |

The guides in `guides/` are written for the agent and come back through `search`: `guide:packages` for saving code, `guide:storage` for state, `guide:jobs` for schedules.

For how the machine itself works, read [docs/how-it-works.md](docs/how-it-works.md).

## Runs and recovering from a timeout

Every job run is recorded. An `execute` is recorded when it fails, and when the caller passes an `idempotencyKey`:

- the first call with a key runs the code and returns a `runId`,
- the same key after it finished returns the stored result with `replayed: true` and starts no second sandbox,
- the same key while it is still going returns `inProgress: true` and the `runId`.

So an MCP client that times out on a slow call can ask again with the same key instead of running the work twice. A run left `running` by a daemon that died becomes an error marked `interrupted` once it is older than the execute timeout. `kody.runList()` and `kody.runGet({ id })` read the history.

## Testing

```bash
npm test          # test/scheduler.ts, then test/e2e.ts
npm run typecheck
npx prettier --check .
```

`test/scheduler.ts` runs in-process with an injected clock, which is the only way to check the things you cannot wait for: enabling a job that has never run, three missed occurrences coalescing into one run, and the notification a failed job sends. `test/e2e.ts` starts a real daemon on a temp home and socket and drives the proxy over MCP stdio, with a fake GitHub and a fake npm registry so nothing reaches the network.

To poke at it by hand, the daemon's socket takes plain JSON:

```bash
KODY_HOME=/tmp/kody-scratch KODY_SOCKET=/tmp/kody.sock KODY_NOTIFY=stderr node src/daemon.ts &
curl -s --unix-socket /tmp/kody.sock -X POST http://localhost/tools/search -d '{"query":"daily"}'
curl -s --unix-socket /tmp/kody.sock -X POST http://localhost/scheduler/tick -d '{"now":"2026-12-25T09:00:00Z"}'
```

`/scheduler/tick` takes an optional `now`, which is how you watch a schedule catch up without waiting for the wall clock. It is a daemon route, not an MCP tool.

## Layout

| File                     | Role                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `src/server.ts`          | MCP stdio proxy: forwards `search` and `execute` to the daemon socket                  |
| `src/daemon.ts`          | Long-lived host: store, gateway, executor, search, scheduler                           |
| `src/tools.ts`           | The two tool schemas and the server instructions, shared by both                       |
| `src/launchd.ts`         | `daemon:install` / `daemon:uninstall` / `daemon:logs`                                  |
| `src/registry.ts`        | `defineCapability`, Zod-validated host functions                                       |
| `src/capabilities.ts`    | The nine capabilities listed above                                                     |
| `src/search.ts`          | Lexical ranking, domain index, entity detail with ready-to-run modules                 |
| `src/executor.ts`        | Import scanning, import map and scopes, `deno run` with locked permissions             |
| `src/gateway.ts`         | The sandbox's only reachable address: `/call`, `/fetch`, `/storage`, `/log`, `/settle` |
| `src/secrets.ts`         | Secret store and `{{secret:name}}` substitution per approved host                      |
| `src/packages.ts`        | Reading saved packages, `kody:@scope/leaf/export` resolution, job schema               |
| `src/publish.ts`         | `packageSave`: staging, pinned versions, `deno check`, dry import, swap                |
| `src/package-storage.ts` | Which package owns a bucket, and the one-time import of phase 1 JSON                   |
| `src/store.ts`           | SQLite: versioned migrations, package storage, runs, job state                         |
| `src/runs.ts`            | Recording a run, replay by key, reconciling interrupted runs                           |
| `src/jobs.ts`            | Package-declared jobs: listing, running, enabling, the coalescing tick                 |
| `guides/*.md`            | Docs for the agent, found through search                                               |
