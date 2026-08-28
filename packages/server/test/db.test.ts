import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";

/** Builds the subset of a schema-v3 database that migration 4 operates on. */
function seedPreV4(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
CREATE TABLE machines(id TEXT PRIMARY KEY, name TEXT, token_id TEXT, last_seen INTEGER);
CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE, principal_id TEXT, caps TEXT,
  pad_id TEXT, created_at INTEGER, revoked_at INTEGER, minted_by TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY, machine_id TEXT, pad_id TEXT, element_id TEXT,
  created_by TEXT, status TEXT, exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT);
CREATE TABLE snapshots(pad_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, blob TEXT,
  PRIMARY KEY(pad_id, epoch, rev));
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key, value) VALUES ('schema_version', '3');

INSERT INTO tokens(id, hash, principal_id, created_at, revoked_at)
VALUES ('t-old', 'h-old', 'm-old', 1, NULL),
       ('t-new', 'h-new', 'm-new', 2, NULL),
       ('t-solo', 'h-solo', 'm-solo', 3, NULL),
       ('t-tie-a', 'h-tie-a', 'm-tie-a', 4, NULL),
       ('t-tie-b', 'h-tie-b', 'm-tie-b', 5, NULL);

-- 'dup-node' exists twice from the pre-#43 always-mint path; the live agent is
-- the most recently seen row. 'tie-node' duplicates share last_seen.
INSERT INTO machines(id, name, token_id, last_seen)
VALUES ('m-old', 'dup-node', 't-old', 100),
       ('m-new', 'dup-node', 't-new', 200),
       ('m-solo', 'solo-node', 't-solo', 50),
       ('m-tie-a', 'tie-node', 't-tie-a', 300),
       ('m-tie-b', 'tie-node', 't-tie-b', 300);

INSERT INTO sessions(id, machine_id, pad_id, element_id, created_by, status, created_at)
VALUES ('s-old', 'm-old', 'p', 'e1', 'c', 'running', 1),
       ('s-new', 'm-new', 'p', 'e2', 'c', 'running', 2),
       ('s-solo', 'm-solo', 'p', 'e3', 'c', 'exited', 3);
`);
  db.close();
}

describe("migration 4: machines.name uniqueness", () => {
  test("retires losers by rename keeping all rows, revokes their tokens, enforces the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-migration-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV4(path);
      const db = openDatabase(path);

      const version = db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      expect(version?.value).toBe(String(SCHEMA_VERSION));

      const machines = db
        .query<{ id: string; name: string }, []>("SELECT id, name FROM machines ORDER BY id")
        .all();
      expect(machines).toEqual([
        { id: "m-new", name: "dup-node" },
        // Retired, never deleted: losers keep their row under a collision-proof name.
        { id: "m-old", name: "dup-node#m-old" },
        { id: "m-solo", name: "solo-node" },
        // Equal last_seen: the newer rowid (later enrollment) keeps the bare name.
        { id: "m-tie-a", name: "tie-node#m-tie-a" },
        { id: "m-tie-b", name: "tie-node" },
      ]);

      const revoked = db
        .query<{ id: string; revoked_at: number | null }, []>(
          "SELECT id, revoked_at FROM tokens ORDER BY id",
        )
        .all();
      expect(revoked.filter((row) => row.revoked_at !== null).map((row) => row.id)).toEqual([
        "t-old",
        "t-tie-a",
      ]);

      // Session history is untouched — including sessions of retired machines.
      const sessions = db
        .query<{ id: string }, []>("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((row) => row.id);
      expect(sessions).toEqual(["s-new", "s-old", "s-solo"]);

      expect(() => {
        db.query("INSERT INTO machines(id, name, token_id, last_seen) VALUES (?, ?, ?, ?)").run(
          "m-dup",
          "solo-node",
          "t-x",
          1,
        );
      }).toThrow();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
