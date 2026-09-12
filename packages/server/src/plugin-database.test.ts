import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDatabaseError } from "@manifold/plugin";
import { openPluginDatabase, pluginDatabasePath } from "./plugin-database.ts";

function scratch(): { dataDir: string; done: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-plugin-db-"));
  return { dataDir, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

describe("a plugin's own tables", () => {
  test("rows written through run come back through query, and the file is the plugin's own", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example" });
      await db.run(
        "CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, score INTEGER NOT NULL)",
      );
      const written = await db.run("INSERT INTO records(id, kind, score) VALUES (?, ?, ?)", [
        "rec_1",
        "proposal",
        3,
      ]);
      expect(written.changes).toBe(1);
      const rows = await db.query<{ id: string; score: number }>(
        "SELECT id, score FROM records WHERE kind = ? ORDER BY score DESC",
        ["proposal"],
      );
      expect(rows).toEqual([{ id: "rec_1", score: 3 }]);
      expect(existsSync(pluginDatabasePath(dataDir, "atyrode.example"))).toBe(true);

      const other = openPluginDatabase({ dataDir, pluginId: "atyrode.other" });
      await expect(other.query("SELECT count(*) AS n FROM records")).rejects.toBeInstanceOf(
        PluginDatabaseError,
      );
      db.close();
      other.close();
    } finally {
      done();
    }
  });

  test("a batch is one transaction: a refused statement in the middle rolls back what came before", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example" });
      await db.run("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      await expect(
        db.batch([
          { sql: "INSERT INTO t(v) VALUES (?)", params: ["first"] },
          { sql: "INSERT INTO t(v) VALUES (NULL)" },
        ]),
      ).rejects.toBeInstanceOf(PluginDatabaseError);
      const rows = await db.query("SELECT v FROM t");
      expect(rows).toEqual([]);

      const results = await db.batch([
        { sql: "INSERT INTO t(v) VALUES (?) RETURNING id", params: ["a"] },
        { sql: "UPDATE t SET v = ? WHERE v = ?", params: ["b", "a"] },
        { sql: "SELECT v FROM t" },
      ]);
      expect(results[0]).toEqual([{ id: 1 }]);
      expect(results[1]).toEqual([]);
      expect(results[2]).toEqual([{ v: "b" }]);
      db.close();
    } finally {
      done();
    }
  });

  test("statements that reach outside the file are refused before they run", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example" });
      for (const sql of [
        "ATTACH DATABASE '/etc/passwd' AS x",
        "  -- a comment first\n PRAGMA journal_mode = DELETE",
        "/* block */ VACUUM",
        "SELECT load_extension('evil')",
        "",
      ]) {
        await expect(db.query(sql)).rejects.toBeInstanceOf(PluginDatabaseError);
      }
      // Ordinary use of the same words inside a statement is not a reach.
      await db.run("CREATE TABLE pragmatic(attach TEXT)");
      await db.run("INSERT INTO pragmatic(attach) VALUES ('vacuum')");
      expect(await db.query("SELECT attach FROM pragmatic")).toEqual([{ attach: "vacuum" }]);
      db.close();
    } finally {
      done();
    }
  });

  test("the bounds are refusals, not truncations", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example" });
      await db.run("CREATE TABLE n(i INTEGER)");
      await db.run(
        "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 10001) INSERT INTO n SELECT i FROM seq",
      );
      await expect(db.query("SELECT i FROM n")).rejects.toThrow(/10000-row limit/);
      expect((await db.query("SELECT i FROM n LIMIT 10000")).length).toBe(10000);
      await expect(db.query("SELECT 1", new Array(1000).fill(1))).rejects.toThrow(/999/);
      await expect(db.batch([])).rejects.toBeInstanceOf(PluginDatabaseError);
      await expect(db.query("SELECT ?", [{} as never])).rejects.toBeInstanceOf(PluginDatabaseError);
      db.close();
    } finally {
      done();
    }
  });

  test("the file is capped at the granted size and fills itself, not the disk", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example", maxBytes: 64 * 1024 });
      await db.run("CREATE TABLE blob(b BLOB)");
      const chunk = new Uint8Array(8 * 1024);
      let refused: unknown = null;
      for (let i = 0; i < 64 && refused === null; i += 1) {
        try {
          await db.run("INSERT INTO blob(b) VALUES (?)", [chunk]);
        } catch (error) {
          refused = error;
        }
      }
      expect(refused).toBeInstanceOf(PluginDatabaseError);
      expect(String((refused as Error).message)).toMatch(/full/);
      expect(await db.pageCount()).toBeLessThanOrEqual(16);
      db.close();
    } finally {
      done();
    }
  });

  test("a batch that runs past its deadline is rolled back", async () => {
    const { dataDir, done } = scratch();
    try {
      let clock = 0;
      const db = openPluginDatabase({
        dataDir,
        pluginId: "atyrode.example",
        now: () => (clock += 3000),
      });
      await db.run("CREATE TABLE t(v TEXT)");
      await expect(
        db.batch([
          { sql: "INSERT INTO t(v) VALUES ('a')" },
          { sql: "INSERT INTO t(v) VALUES ('b')" },
          { sql: "INSERT INTO t(v) VALUES ('c')" },
        ]),
      ).rejects.toThrow(/deadline/);
      expect(await db.query("SELECT v FROM t")).toEqual([]);
      db.close();
    } finally {
      done();
    }
  });

  test("clear removes the file with its journal and reports the bytes; a fresh open starts empty", async () => {
    const { dataDir, done } = scratch();
    try {
      const db = openPluginDatabase({ dataDir, pluginId: "atyrode.example" });
      await db.run("CREATE TABLE t(v TEXT)");
      await db.run("INSERT INTO t(v) VALUES ('kept until purge')");
      expect(await db.sizeBytes()).toBeGreaterThan(0);
      const removed = await db.clear();
      expect(removed).toBeGreaterThan(0);
      expect(existsSync(pluginDatabasePath(dataDir, "atyrode.example"))).toBe(false);
      expect(await db.pageCount()).toBe(0);
      await expect(db.query("SELECT v FROM t")).rejects.toThrow(/no such table/);
      db.close();
    } finally {
      done();
    }
  });
});
