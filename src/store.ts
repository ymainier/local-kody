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
