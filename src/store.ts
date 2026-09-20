import { DatabaseSync } from "node:sqlite";
import { dbFile } from "./paths.ts";

// One SQLite file under the kody home, opened by a single writer (the daemon).
// Migrations are an ordered list: the index of the last applied one is the
// schema version, so adding a step means appending a string.
const migrations: Array<string> = [
  `create table package_storage (
     package_name text not null,
     key text not null,
     value_json text not null,
     updated_at text not null,
     primary key (package_name, key)
   )`,
  `create table runs (
     id text primary key,
     surface text not null,
     package_name text,
     job_name text,
     idempotency_key text,
     status text not null,
     started_at text not null,
     finished_at text,
     duration_ms integer,
     result_json text,
     error text,
     logs_json text
   );
   create unique index runs_idempotency_key
     on runs (idempotency_key) where idempotency_key is not null;
   create index runs_started_at on runs (started_at desc);`,
  `create table jobs (
     package_name text not null,
     job_name text not null,
     enabled integer not null default 0,
     expression text,
     timezone text,
     enabled_at text,
     last_scheduled_for text,
     primary key (package_name, job_name)
   )`,
  `create table secrets (
     name text primary key,
     allowed_hosts text not null,
     created_at text not null
   )`,
  `create table integrations (
     id text primary key,
     auth_url text not null,
     token_url text not null,
     client_id text not null,
     scopes text not null,
     allowed_hosts text not null,
     auth_params text,
     token_auth text,
     redirect_port integer,
     expires_at text,
     status text not null,
     last_error text,
     created_at text not null
   )`,
  `create table mcp_servers (
     name text primary key,
     transport text not null,
     command text,
     args text,
     env text,
     url text,
     auth text not null default 'none',
     enabled integer not null default 1,
     instructions text,
     tool_names text,
     created_at text not null
   )`,
];

let database: DatabaseSync | null = null;

function migrate(db: DatabaseSync) {
  db.exec(
    "create table if not exists schema_version (version integer not null)",
  );
  const row = db.prepare("select version from schema_version").get() as
    { version: number } | undefined;
  if (!row) db.prepare("insert into schema_version (version) values (0)").run();
  const current = row?.version ?? 0;
  for (let version = current; version < migrations.length; version += 1) {
    db.exec("begin");
    try {
      db.exec(migrations[version] ?? "");
      db.prepare("update schema_version set version = ?").run(version + 1);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
}

export function getDatabase() {
  if (database) return database;
  const db = new DatabaseSync(dbFile);
  db.exec("pragma journal_mode = WAL");
  db.exec("pragma busy_timeout = 5000");
  migrate(db);
  database = db;
  return db;
}

export function closeDatabase() {
  database?.close();
  database = null;
}

export function storageGet(packageName: string, key: string): unknown {
  const row = getDatabase()
    .prepare(
      "select value_json from package_storage where package_name = ? and key = ?",
    )
    .get(packageName, key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as unknown) : null;
}

export function storageSet(packageName: string, key: string, value: unknown) {
  getDatabase()
    .prepare(
      `insert into package_storage (package_name, key, value_json, updated_at)
       values (?, ?, ?, ?)
       on conflict (package_name, key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(
      packageName,
      key,
      JSON.stringify(value ?? null),
      new Date().toISOString(),
    );
  return { saved: true };
}

export function storageList(packageName: string) {
  const rows = getDatabase()
    .prepare(
      "select key, updated_at from package_storage where package_name = ? order by key",
    )
    .all(packageName) as Array<{ key: string; updated_at: string }>;
  return rows.map((row) => ({ key: row.key, updatedAt: row.updated_at }));
}

export function storageDelete(packageName: string, key: string) {
  const info = getDatabase()
    .prepare("delete from package_storage where package_name = ? and key = ?")
    .run(packageName, key);
  return { deleted: info.changes > 0 };
}

export type RunStatus = "running" | "success" | "error";

export type RunRecord = {
  id: string;
  surface: "execute" | "job";
  packageName: string | null;
  jobName: string | null;
  idempotencyKey: string | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: string | null;
  logs: Array<string>;
};

type RunRow = {
  id: string;
  surface: string;
  package_name: string | null;
  job_name: string | null;
  idempotency_key: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result_json: string | null;
  error: string | null;
  logs_json: string | null;
};

const maxResultBytes = 100_000;

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    surface: row.surface as "execute" | "job",
    packageName: row.package_name,
    jobName: row.job_name,
    idempotencyKey: row.idempotency_key,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error,
    logs:
      row.logs_json === null
        ? []
        : (JSON.parse(row.logs_json) as Array<string>),
  };
}

export function startRun(run: {
  id: string;
  surface: "execute" | "job";
  packageName?: string | null;
  jobName?: string | null;
  idempotencyKey?: string | null;
  startedAt?: string;
}) {
  getDatabase()
    .prepare(
      `insert into runs (id, surface, package_name, job_name, idempotency_key, status, started_at)
       values (?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      run.id,
      run.surface,
      run.packageName ?? null,
      run.jobName ?? null,
      run.idempotencyKey ?? null,
      run.startedAt ?? new Date().toISOString(),
    );
}

export function finishRun(
  id: string,
  outcome: {
    result?: unknown;
    error?: string;
    logs?: Array<string>;
    durationMs?: number;
  },
) {
  const resultJson = JSON.stringify(outcome.result ?? null);
  getDatabase()
    .prepare(
      `update runs
       set status = ?, finished_at = ?, duration_ms = ?, result_json = ?, error = ?, logs_json = ?
       where id = ?`,
    )
    .run(
      outcome.error ? "error" : "success",
      new Date().toISOString(),
      outcome.durationMs ?? null,
      resultJson.length > maxResultBytes
        ? JSON.stringify(`[dropped: ${resultJson.length} bytes]`)
        : resultJson,
      outcome.error ?? null,
      JSON.stringify(outcome.logs ?? []),
      id,
    );
}

export function getRun(id: string) {
  const row = getDatabase()
    .prepare("select * from runs where id = ?")
    .get(id) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

export function findRunByIdempotencyKey(key: string) {
  const row = getDatabase()
    .prepare("select * from runs where idempotency_key = ?")
    .get(key) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

export function listRuns(filter: {
  packageName?: string;
  jobName?: string;
  status?: RunStatus;
  limit?: number;
}) {
  const clauses: Array<string> = [];
  const values: Array<string> = [];
  if (filter.packageName) {
    clauses.push("package_name = ?");
    values.push(filter.packageName);
  }
  if (filter.jobName) {
    clauses.push("job_name = ?");
    values.push(filter.jobName);
  }
  if (filter.status) {
    clauses.push("status = ?");
    values.push(filter.status);
  }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = getDatabase()
    .prepare(
      `select * from runs ${where} order by started_at desc limit ${Math.min(filter.limit ?? 20, 200)}`,
    )
    .all(...values) as Array<RunRow>;
  return rows.map(toRunRecord);
}

// A `running` row whose sandbox died with the daemon never settles on its own.
// Anything older than one execute timeout plus a margin cannot still be alive.
export function reconcileStrandedRuns(staleBefore: string) {
  const info = getDatabase()
    .prepare(
      `update runs
       set status = 'error', error = 'interrupted', finished_at = ?
       where status = 'running' and started_at < ?`,
    )
    .run(new Date().toISOString(), staleBefore);
  return { reconciled: Number(info.changes) };
}

// Schedule state only. A job's name and entry live in the package manifest,
// which stays the source of truth for what the job is.
export type JobState = {
  packageName: string;
  jobName: string;
  enabled: boolean;
  expression: string | null;
  timezone: string | null;
  enabledAt: string | null;
  lastScheduledFor: string | null;
};

type JobRow = {
  package_name: string;
  job_name: string;
  enabled: number;
  expression: string | null;
  timezone: string | null;
  enabled_at: string | null;
  last_scheduled_for: string | null;
};

function toJobState(row: JobRow): JobState {
  return {
    packageName: row.package_name,
    jobName: row.job_name,
    enabled: row.enabled === 1,
    expression: row.expression,
    timezone: row.timezone,
    enabledAt: row.enabled_at,
    lastScheduledFor: row.last_scheduled_for,
  };
}

export function getJobState(packageName: string, jobName: string) {
  const row = getDatabase()
    .prepare("select * from jobs where package_name = ? and job_name = ?")
    .get(packageName, jobName) as JobRow | undefined;
  return row ? toJobState(row) : null;
}

export function saveJobState(state: JobState) {
  getDatabase()
    .prepare(
      `insert into jobs (package_name, job_name, enabled, expression, timezone, enabled_at, last_scheduled_for)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (package_name, job_name) do update set
         enabled = excluded.enabled,
         expression = excluded.expression,
         timezone = excluded.timezone,
         enabled_at = excluded.enabled_at,
         last_scheduled_for = excluded.last_scheduled_for`,
    )
    .run(
      state.packageName,
      state.jobName,
      state.enabled ? 1 : 0,
      state.expression,
      state.timezone,
      state.enabledAt,
      state.lastScheduledFor,
    );
  return state;
}

export function setLastScheduledFor(
  packageName: string,
  jobName: string,
  when: string,
) {
  getDatabase()
    .prepare(
      "update jobs set last_scheduled_for = ? where package_name = ? and job_name = ?",
    )
    .run(when, packageName, jobName);
}

export function lastRunOf(packageName: string, jobName: string) {
  const row = getDatabase()
    .prepare(
      "select * from runs where package_name = ? and job_name = ? order by started_at desc limit 1",
    )
    .get(packageName, jobName) as RunRow | undefined;
  return row ? toRunRecord(row) : null;
}

export function hasSuccessfulRun(packageName: string, jobName: string) {
  const row = getDatabase()
    .prepare(
      "select id from runs where package_name = ? and job_name = ? and status = 'success' limit 1",
    )
    .get(packageName, jobName);
  return row !== undefined;
}

// Secret metadata only. The value lives in the Keychain (src/keychain.ts), so
// listing secrets and building the search index never touch it.
export type SecretMeta = {
  name: string;
  allowedHosts: Array<string>;
  createdAt: string;
};

type SecretRow = {
  name: string;
  allowed_hosts: string;
  created_at: string;
};

function toSecretMeta(row: SecretRow): SecretMeta {
  return {
    name: row.name,
    allowedHosts: JSON.parse(row.allowed_hosts) as Array<string>,
    createdAt: row.created_at,
  };
}

export function listSecretMeta() {
  const rows = getDatabase()
    .prepare("select * from secrets order by name")
    .all() as Array<SecretRow>;
  return rows.map(toSecretMeta);
}

export function getSecretMeta(name: string) {
  const row = getDatabase()
    .prepare("select * from secrets where name = ?")
    .get(name) as SecretRow | undefined;
  return row ? toSecretMeta(row) : null;
}

export function saveSecretMeta(name: string, allowedHosts: Array<string>) {
  getDatabase()
    .prepare(
      `insert into secrets (name, allowed_hosts, created_at)
       values (?, ?, ?)
       on conflict (name) do update set allowed_hosts = excluded.allowed_hosts`,
    )
    .run(name, JSON.stringify(allowedHosts), new Date().toISOString());
  return getSecretMeta(name);
}

export function deleteSecretMeta(name: string) {
  const info = getDatabase()
    .prepare("delete from secrets where name = ?")
    .run(name);
  return { deleted: Number(info.changes) > 0 };
}

// An integration is a saved OAuth connection. Everything secret about it (the
// client secret and both tokens) is in the Keychain under integration:<id>:*;
// what is here is the provider config, when the access token expires, and
// whether the connection still works.
export type IntegrationStatus =
  "not_connected" | "connected" | "needs_reconnect";

export type Integration = {
  id: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: Array<string>;
  allowedHosts: Array<string>;
  authParams: Record<string, string>;
  tokenAuth: "body" | "basic";
  redirectPort: number | null;
  expiresAt: string | null;
  status: IntegrationStatus;
  lastError: string | null;
  createdAt: string;
};

type IntegrationRow = {
  id: string;
  auth_url: string;
  token_url: string;
  client_id: string;
  scopes: string;
  allowed_hosts: string;
  auth_params: string | null;
  token_auth: string | null;
  redirect_port: number | null;
  expires_at: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
};

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    authUrl: row.auth_url,
    tokenUrl: row.token_url,
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes) as Array<string>,
    allowedHosts: JSON.parse(row.allowed_hosts) as Array<string>,
    authParams:
      row.auth_params === null
        ? {}
        : (JSON.parse(row.auth_params) as Record<string, string>),
    tokenAuth: row.token_auth === "basic" ? "basic" : "body",
    redirectPort: row.redirect_port,
    expiresAt: row.expires_at,
    status: row.status as IntegrationStatus,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export function listIntegrations() {
  const rows = getDatabase()
    .prepare("select * from integrations order by id")
    .all() as Array<IntegrationRow>;
  return rows.map(toIntegration);
}

export function getIntegration(id: string) {
  const row = getDatabase()
    .prepare("select * from integrations where id = ?")
    .get(id) as IntegrationRow | undefined;
  return row ? toIntegration(row) : null;
}

export function saveIntegration(config: {
  id: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: Array<string>;
  allowedHosts: Array<string>;
  authParams?: Record<string, string>;
  tokenAuth?: "body" | "basic";
  redirectPort?: number | null;
}) {
  getDatabase()
    .prepare(
      `insert into integrations (id, auth_url, token_url, client_id, scopes, allowed_hosts, auth_params, token_auth, redirect_port, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_connected', ?)
       on conflict (id) do update set
         auth_url = excluded.auth_url,
         token_url = excluded.token_url,
         client_id = excluded.client_id,
         scopes = excluded.scopes,
         allowed_hosts = excluded.allowed_hosts,
         auth_params = excluded.auth_params,
         token_auth = excluded.token_auth,
         redirect_port = excluded.redirect_port`,
    )
    .run(
      config.id,
      config.authUrl,
      config.tokenUrl,
      config.clientId,
      JSON.stringify(config.scopes),
      JSON.stringify(config.allowedHosts),
      JSON.stringify(config.authParams ?? {}),
      config.tokenAuth ?? "body",
      config.redirectPort ?? null,
      new Date().toISOString(),
    );
  return getIntegration(config.id);
}

export function setIntegrationState(
  id: string,
  state: {
    status: IntegrationStatus;
    expiresAt?: string | null;
    lastError?: string | null;
  },
) {
  getDatabase()
    .prepare(
      "update integrations set status = ?, expires_at = ?, last_error = ? where id = ?",
    )
    .run(state.status, state.expiresAt ?? null, state.lastError ?? null, id);
  return getIntegration(id);
}

export function deleteIntegration(id: string) {
  const info = getDatabase()
    .prepare("delete from integrations where id = ?")
    .run(id);
  return { deleted: Number(info.changes) > 0 };
}

// Another MCP server this one can call. The agent reaches its tools from
// sandbox code as kody.mcp.<server>.<tool>(args); they never become MCP tools
// of local-kody's own.
export type McpServerConfig = {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: Array<string>;
  env: Record<string, string>;
  url: string | null;
  auth: string;
  enabled: boolean;
  instructions: string | null;
  toolNames: Array<string>;
  createdAt: string;
};

type McpServerRow = {
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  auth: string;
  enabled: number;
  instructions: string | null;
  tool_names: string | null;
  created_at: string;
};

function toMcpServer(row: McpServerRow): McpServerConfig {
  return {
    name: row.name,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command,
    args: row.args === null ? [] : (JSON.parse(row.args) as Array<string>),
    env:
      row.env === null ? {} : (JSON.parse(row.env) as Record<string, string>),
    url: row.url,
    auth: row.auth,
    enabled: row.enabled === 1,
    instructions: row.instructions,
    toolNames:
      row.tool_names === null
        ? []
        : (JSON.parse(row.tool_names) as Array<string>),
    createdAt: row.created_at,
  };
}

export function listMcpServers() {
  const rows = getDatabase()
    .prepare("select * from mcp_servers order by name")
    .all() as Array<McpServerRow>;
  return rows.map(toMcpServer);
}

export function getMcpServer(name: string) {
  const row = getDatabase()
    .prepare("select * from mcp_servers where name = ?")
    .get(name) as McpServerRow | undefined;
  return row ? toMcpServer(row) : null;
}

export function saveMcpServer(config: {
  name: string;
  transport: "stdio" | "http";
  command?: string | null;
  args?: Array<string>;
  env?: Record<string, string>;
  url?: string | null;
  auth?: string;
}) {
  getDatabase()
    .prepare(
      `insert into mcp_servers (name, transport, command, args, env, url, auth, enabled, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 1, ?)
       on conflict (name) do update set
         transport = excluded.transport,
         command = excluded.command,
         args = excluded.args,
         env = excluded.env,
         url = excluded.url,
         auth = excluded.auth`,
    )
    .run(
      config.name,
      config.transport,
      config.command ?? null,
      JSON.stringify(config.args ?? []),
      JSON.stringify(config.env ?? {}),
      config.url ?? null,
      config.auth ?? "none",
      new Date().toISOString(),
    );
  return getMcpServer(config.name);
}

// Cached at add time so search can describe a server without starting it.
export function setMcpDiscovery(
  name: string,
  discovery: { instructions: string | null; toolNames: Array<string> },
) {
  getDatabase()
    .prepare(
      "update mcp_servers set instructions = ?, tool_names = ? where name = ?",
    )
    .run(discovery.instructions, JSON.stringify(discovery.toolNames), name);
  return getMcpServer(name);
}

export function setMcpEnabled(name: string, enabled: boolean) {
  getDatabase()
    .prepare("update mcp_servers set enabled = ? where name = ?")
    .run(enabled ? 1 : 0, name);
  return getMcpServer(name);
}

export function deleteMcpServer(name: string) {
  const info = getDatabase()
    .prepare("delete from mcp_servers where name = ?")
    .run(name);
  return { deleted: Number(info.changes) > 0 };
}
