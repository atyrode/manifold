import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db.ts";
import { ServerStore } from "./stores.ts";
import {
  openPluginDatabase,
  pluginDatabasePath,
  recoverPluginDatabases,
  stagePluginDatabase,
} from "./plugin-database.ts";
import { RecoveryBudget, MAX_CHECKPOINT_FILES } from "./recovery-budget.ts";

const IMAGE = 64 * 1024 * 1024;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "manifold-recovery-budget-"));
  const store = new ServerStore(openDatabase(join(root, "manifold.db")));
  const budget = new RecoveryBudget(root, store.db);
  return {
    root,
    store,
    budget,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("durable whole-image recovery allocation", () => {
  test("missing and disabled images remain charged after reopening, and the fourth 64 MiB allocation refuses", () => {
    const f = fixture();
    try {
      for (const id of ["test.one", "test.two", "test.three"])
        expect(f.budget.ensureAllocation(id, IMAGE)).toEqual({ ok: true });
      expect(existsSync(pluginDatabasePath(f.root, "test.one"))).toBe(false);
      // This is the crash boundary between committed allocation and writable image creation.
      const reopened = new RecoveryBudget(f.root, f.store.db);
      expect(reopened.ensureAllocation("test.four", IMAGE)).toEqual({
        ok: false,
        reason: "backup_capacity",
      });
      expect(reopened.allocation("test.four")).toBeNull();
      expect(reopened.allocation("test.one")).toBe(IMAGE);
      reopened.releaseAfterPurge("test.one");
      expect(reopened.ensureAllocation("test.four", IMAGE)).toEqual({ ok: true });
    } finally {
      f.close();
    }
  });

  test("fresh unrelated retained growth refuses admission but read, deletion and purge still work", async () => {
    const f = fixture();
    const pluginId = "test.cleanup";
    const db = openPluginDatabase({
      dataDir: f.root,
      pluginId,
      maxBytes: IMAGE,
      recovery: { profile: "bounded-wal-v1" },
      recoveryBudget: f.budget,
    });
    try {
      await db.run("CREATE TABLE t(value TEXT)");
      await db.run("INSERT INTO t VALUES ('retained')");
      expect(await db.admitRecovery()).toEqual({ ok: true });
      const unrelated = join(f.root, "retained-ordinary-file");
      writeFileSync(unrelated, "");
      truncateSync(unrelated, 200 * 1024 * 1024);
      expect(await db.admitRecovery()).toEqual({ ok: false, reason: "backup_capacity" });
      expect(await db.query("SELECT value FROM t")).toEqual([{ value: "retained" }]);
      expect((await db.run("DELETE FROM t")).changes).toBe(1);
      db.close();
      expect(f.budget.allocation(pluginId)).toBe(IMAGE);
      await db.clear();
      expect(f.budget.allocation(pluginId)).toBeNull();
      expect(existsSync(pluginDatabasePath(f.root, pluginId))).toBe(false);
    } finally {
      db.close();
      f.close();
    }
  });

  test("a migration obligation survives process loss until stage cleanup is durable", async () => {
    const f = fixture();
    const pluginId = "test.stage";
    const options = {
      dataDir: f.root,
      pluginId,
      maxBytes: IMAGE,
      recovery: { profile: "bounded-wal-v1" as const },
      recoveryBudget: f.budget,
    };
    const live = openPluginDatabase(options);
    try {
      await live.run("CREATE TABLE t(value TEXT)");
      await live.run("INSERT INTO t VALUES ('old')");
      live.close();
      expect(f.budget.ensureAllocation("test.other", IMAGE)).toEqual({ ok: true });
      const stage = stagePluginDatabase(options, f.store);
      await stage.database.run("UPDATE t SET value='candidate'");
      stage.activate();
      // Prepared, not committed: after a crash the original is recovered, never the candidate.
      expect(new RecoveryBudget(f.root, f.store.db).ensureAllocation("test.third", IMAGE)).toEqual({
        ok: false,
        reason: "backup_capacity",
      });
      expect(() => f.budget.releaseStageAfterCleanup(pluginId)).toThrow(/retained/);
      recoverPluginDatabases(f.root, f.store);
      expect(await live.query("SELECT value FROM t")).toEqual([{ value: "old" }]);
      expect(f.budget.allocation(pluginId)).toBe(IMAGE);
      expect(f.store.db.query("SELECT * FROM plugin_recovery_stages").all()).toEqual([]);
      expect(f.budget.ensureAllocation("test.third", IMAGE)).toEqual({ ok: true });
    } finally {
      live.close();
      f.close();
    }
  });

  test("a rejected smaller migration releases its stage charge before another migration", async () => {
    const f = fixture();
    const pluginId = "test.stage-cap";
    const options = {
      dataDir: f.root,
      pluginId,
      maxBytes: IMAGE,
      recovery: { profile: "bounded-wal-v1" as const },
      recoveryBudget: f.budget,
    };
    const live = openPluginDatabase(options);
    try {
      await live.run("CREATE TABLE t(value TEXT)");
      await live.run("INSERT INTO t VALUES ('retained')");
      live.close();
      expect(() => stagePluginDatabase({ ...options, maxBytes: 4096 }, f.store)).toThrow(
        /candidate manifest page budget/,
      );
      expect(f.store.db.query("SELECT * FROM plugin_recovery_stages").all()).toEqual([]);
      expect(f.budget.allocation(pluginId)).toBe(IMAGE);
      expect(existsSync(`${pluginDatabasePath(f.root, pluginId)}.stage`)).toBe(false);
      const retry = stagePluginDatabase(options, f.store);
      try {
        expect(await retry.database.query("SELECT value FROM t")).toEqual([{ value: "retained" }]);
      } finally {
        retry.discard();
      }
      expect(await live.query("SELECT value FROM t")).toEqual([{ value: "retained" }]);
    } finally {
      live.close();
      f.close();
    }
  });

  test("a busy pre-copy checkpoint releases its stage charge without changing the retained WAL", async () => {
    const f = fixture();
    const pluginId = "test.stage-busy";
    const options = {
      dataDir: f.root,
      pluginId,
      maxBytes: IMAGE,
      recovery: { profile: "bounded-wal-v1" as const },
      recoveryBudget: f.budget,
    };
    const live = openPluginDatabase(options);
    let writer: Database | undefined;
    let reader: Database | undefined;
    try {
      await live.run("CREATE TABLE t(value TEXT)");
      await live.run("INSERT INTO t VALUES ('old')");
      live.close();
      const path = pluginDatabasePath(f.root, pluginId);
      writer = new Database(path);
      writer.exec("PRAGMA wal_autocheckpoint=0");
      writer.exec("UPDATE t SET value='retained'");
      reader = new Database(path, { readonly: true });
      reader.exec("BEGIN");
      expect(reader.query("SELECT value FROM t").all()).toEqual([{ value: "retained" }]);
      writer.close();
      writer = undefined;
      expect(() => stagePluginDatabase(options, f.store)).toThrow(/checkpoint is busy/);
      expect(f.store.db.query("SELECT * FROM plugin_recovery_stages").all()).toEqual([]);
      expect(f.budget.allocation(pluginId)).toBe(IMAGE);
      expect(reader.query("SELECT value FROM t").all()).toEqual([{ value: "retained" }]);
      reader.exec("ROLLBACK");
      reader.close();
      reader = undefined;
      const retry = stagePluginDatabase(options, f.store);
      try {
        expect(await retry.database.query("SELECT value FROM t")).toEqual([{ value: "retained" }]);
      } finally {
        retry.discard();
      }
    } finally {
      reader?.close();
      writer?.close();
      live.close();
      f.close();
    }
  });

  test("refused expansion preserves reads and deletion under the old cap until durable admission succeeds", async () => {
    const f = fixture();
    const pluginId = "test.expand";
    const oldBytes = 64 * 1024;
    const options = {
      dataDir: f.root,
      pluginId,
      maxBytes: oldBytes,
      recovery: { profile: "bounded-wal-v1" as const },
      recoveryBudget: f.budget,
    };
    const original = openPluginDatabase(options);
    const expanded = openPluginDatabase({ ...options, maxBytes: IMAGE });
    try {
      await original.run("CREATE TABLE t(value BLOB)");
      await original.run("INSERT INTO t VALUES (zeroblob(16384))");
      original.close();
      const unrelated = join(f.root, "retained-expansion-blocker");
      writeFileSync(unrelated, "");
      truncateSync(unrelated, 200 * 1024 * 1024);
      expect(await expanded.query("SELECT length(value) AS bytes FROM t")).toEqual([
        { bytes: 16384n },
      ]);
      expect(await expanded.admitRecovery()).toEqual({ ok: false, reason: "backup_capacity" });
      expect(f.budget.allocation(pluginId)).toBe(oldBytes);
      expect((await expanded.run("DELETE FROM t")).changes).toBe(1);
      await expect(expanded.run("INSERT INTO t VALUES (zeroblob(131072))")).rejects.toThrow(
        /database_full/,
      );
      expect(await expanded.query("SELECT count(*) AS count FROM t")).toEqual([{ count: 0n }]);
      rmSync(unrelated);
      expect(await expanded.admitRecovery()).toEqual({ ok: true });
      expect(f.budget.allocation(pluginId)).toBe(IMAGE);
      await expanded.run("INSERT INTO t VALUES (zeroblob(131072))");
      expect(await expanded.query("SELECT length(value) AS bytes FROM t")).toEqual([
        { bytes: 131072n },
      ]);
    } finally {
      expanded.close();
      original.close();
      f.close();
    }
  });

  test("file-count admission includes not-yet-created allocated image paths", () => {
    const f = fixture();
    try {
      const files = join(f.root, "ordinary");
      mkdirSync(files);
      for (let index = 0; index < MAX_CHECKPOINT_FILES - 1; index++)
        writeFileSync(join(files, String(index)), "");
      expect(f.budget.ensureAllocation("test.future", 4096)).toEqual({
        ok: false,
        reason: "backup_capacity",
      });
      expect(f.budget.allocation("test.future")).toBeNull();
      rmSync(join(files, "0"));
      expect(f.budget.ensureAllocation("test.future", 4096)).toEqual({ ok: true });
    } finally {
      f.close();
    }
  });
});
