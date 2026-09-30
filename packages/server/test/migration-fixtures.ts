import type { Database } from "bun:sqlite";

/** Scene persistence and live references already present by schema 12, including in empty hubs. */
export function seedHistoricalSceneTables(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS containers(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER,
  sort_order INTEGER, folder_id TEXT, discipline TEXT NOT NULL DEFAULT 'canvas');
CREATE TABLE IF NOT EXISTS scene_docs(container_id TEXT NOT NULL, epoch TEXT NOT NULL,
  rev INTEGER NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL, doc BLOB NOT NULL,
  PRIMARY KEY(container_id, epoch, rev));
CREATE TABLE IF NOT EXISTS plugin_kv(plugin_id TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY(plugin_id, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dials(id TEXT PRIMARY KEY, origin TEXT NOT NULL, secret TEXT NOT NULL,
  ref TEXT, caps TEXT NOT NULL, title TEXT, dialed_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS dials_origin_secret_unique ON dials(origin, secret);
`);
}

/** Undo schema 50 when constructing an older fixture from a freshly migrated database. */
export function dropFilesSchema(db: Database): void {
  db.exec(`
DROP TABLE reference_grant_provenance;
DROP TABLE reference_publications;
DROP TABLE reference_kind_owners;
DROP TABLE plugin_recovery_allocations;
DROP TABLE plugin_recovery_stages;
DROP TABLE native_transfers;
DROP TABLE native_admission_refusals;
`);
}
