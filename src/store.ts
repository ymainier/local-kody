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
