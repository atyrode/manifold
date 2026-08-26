import { Database } from "bun:sqlite";

/** Current durable schema revision. Migrations advance this monotonically. */
export const SCHEMA_VERSION = 3;

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
  2: `
ALTER TABLE pads ADD COLUMN sort_order INTEGER;
ALTER TABLE pads ADD COLUMN folder_id TEXT;
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS position
  FROM pads
)
UPDATE pads
SET sort_order = (SELECT position FROM ordered WHERE ordered.id = pads.id);
CREATE TABLE pad_folders(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
`,
  3: `
ALTER TABLE pad_folders ADD COLUMN parent_folder_id TEXT;
ALTER TABLE pad_folders ADD COLUMN sort_order INTEGER;

UPDATE pad_folders
SET sort_order = COALESCE(
  (SELECT MIN(sort_order) FROM pads WHERE pads.folder_id = pad_folders.id),
  (SELECT COUNT(*) FROM pads) + ROWID
);

CREATE TEMP TABLE tree_migration_order(kind TEXT, id TEXT, sibling_order INTEGER);
INSERT INTO tree_migration_order(kind, id, sibling_order)
SELECT kind, id, ROW_NUMBER() OVER (ORDER BY position, created_at, kind, id) - 1
FROM (
  SELECT 'pad' AS kind, id, sort_order AS position, created_at FROM pads WHERE folder_id IS NULL
  UNION ALL
  SELECT 'folder' AS kind, id, sort_order AS position, created_at FROM pad_folders
);
UPDATE pads
SET sort_order = (
  SELECT sibling_order FROM tree_migration_order
  WHERE tree_migration_order.kind = 'pad' AND tree_migration_order.id = pads.id
)
WHERE folder_id IS NULL;
UPDATE pad_folders
SET sort_order = (
  SELECT sibling_order FROM tree_migration_order
  WHERE tree_migration_order.kind = 'folder' AND tree_migration_order.id = pad_folders.id
);
DROP TABLE tree_migration_order;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY sort_order, created_at, id) - 1 AS sibling_order
  FROM pads
  WHERE folder_id IS NOT NULL
)
UPDATE pads
SET sort_order = (SELECT sibling_order FROM ranked WHERE ranked.id = pads.id)
WHERE folder_id IS NOT NULL;

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3');
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
