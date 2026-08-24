import { Database } from "bun:sqlite";

/**
 * Current durable schema revision. Migrations advance this monotonically.
 *
 * There is exactly ONE baseline migration on purpose: manifold has never shipped, so
 * there is no deployed data to migrate. The runner below stays because the first schema
 * change AFTER real pads exist will need it — but until then, new columns belong in the
 * baseline rather than in a migration nobody will ever run.
 */
export const SCHEMA_VERSION = 1;

const MIGRATIONS: Readonly<Record<number, string>> = {
  1: `
CREATE TABLE IF NOT EXISTS pads(
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots(
  pad_id TEXT,
  epoch TEXT,
  rev INTEGER,
  ts INTEGER,
  hash TEXT,
  blob TEXT,
  PRIMARY KEY (pad_id, epoch, rev)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pad_id TEXT,
  ts INTEGER,
  principal_id TEXT,
  type TEXT,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS principals(
  id TEXT PRIMARY KEY,
  kind TEXT,
  name TEXT,
  color TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens(
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE,
  principal_id TEXT,
  caps TEXT,
  pad_id TEXT,
  created_at INTEGER,
  revoked_at INTEGER,
  minted_by TEXT
);
CREATE TABLE IF NOT EXISTS machines(
  id TEXT PRIMARY KEY,
  name TEXT,
  token_id TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  pad_id TEXT,
  element_id TEXT,
  created_by TEXT,
  status TEXT,
  exit_code INTEGER,
  created_at INTEGER,
  agent_principal_id TEXT
);
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
`,
};

interface TableRow {
  name: string;
}

interface VersionRow {
  value: string;
}

/** Opens a Bun SQLite database, enables WAL, and applies numbered migrations atomically. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  const meta = db
    .query<TableRow, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  const row =
    meta === null
      ? null
      : db.query<VersionRow, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row === null ? 0 : Number(row.value);
  if (!Number.isInteger(current) || current < 0 || current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported database schema version: ${row?.value ?? "missing"}`);
  }

  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) {
      db.close();
      throw new Error(`missing database migration ${version}`);
    }
    const migrate = db.transaction(() => {
      db.exec(sql);
    });
    migrate();
  }
  return db;
}
