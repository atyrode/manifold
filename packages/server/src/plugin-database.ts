import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  type PluginDatabase,
  assertSqlBatch,
  assertSqlParams,
  assertSqlStatement,
  DATABASE_PAGE_BYTES,
  grantedDatabaseMaxBytes,
  MAX_SQL_RESULT_BYTES,
  MAX_SQL_ROWS,
  PluginDatabaseError,
  SQL_DEADLINE_MS,
  type PluginDatabaseAdmin,
  type SqlParam,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
} from "@manifold/plugin";
import type { PluginDatabaseJournal, ServerStore } from "./stores.ts";
import { MAX_MIGRATION_STORAGE_OPERATIONS } from "@manifold/protocol";
import { RecoveryBudget, boundedWalFamily } from "./recovery-budget.ts";
import { sqliteBusy, withRecoveryGateSync } from "./recovery-gate.ts";

/**
 * One plugin's own SQLite file, opened and owned by the engine (ADR 0034).
 *
 * The file lives at `<dataDir>/plugins/<pluginId>/data.db`, opened lazily on first use with
 * WAL journaling, `strict` mode, `trusted_schema` off and a page cap from the manifest's
 * granted `maxBytes`. Every verb validates the plugin's input first (the contract's bounds,
 * as rejections), then runs synchronously inside the promise it returns — the ordering a
 * caller reads off its own statements is the ordering the file saw, exactly as `pluginStorage`
 * promises for keys.
 *
 * Every SQL verb uses BEGIN IMMEDIATE and validates its result before COMMIT, including
 * query's DML RETURNING. Bounded recovery additionally truncates the prior WAL before
 * admitting another transaction. The cooperative deadline is not SQL preemption: a single
 * synchronous statement can exceed the budget and block the host thread.
 */
export interface PluginDatabaseOptions {
  readonly dataDir: string;
  readonly pluginId: string;
  /** The manifest's request; the engine grants within its ceiling. */
  readonly maxBytes?: number;
  readonly recovery?: { readonly profile: "bounded-wal-v1" };
  /** Host-owned ledger; never part of a plugin/guest context. */
  readonly recoveryBudget?: RecoveryBudget;
  readonly now?: () => number;
}

export function pluginDatabaseDir(dataDir: string, pluginId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId))
    throw new PluginDatabaseError("invalid plugin database id");
  return join(dataDir, "plugins", pluginId);
}

export function pluginDatabasePath(dataDir: string, pluginId: string): string {
  return join(pluginDatabaseDir(dataDir, pluginId), "data.db");
}

interface SqlResultBudget {
  rows: number;
  bytes: number;
}

/** Counts a string's JSON wire form without allocating that second representation. */
function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Measures the JSON-safe representation the isolate boundary uses for one SQLite value. */
function sqlValueWireBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PluginDatabaseError("database returned a non-finite number");
    }
    return String(value).length;
  }
  if (typeof value === "bigint") {
    return 42 + value.toString().length;
  }
  if (typeof value === "boolean") return value ? 4 : 5;
  if (value instanceof Uint8Array) {
    return 39 + Math.ceil(value.byteLength / 3) * 4;
  }
  throw new PluginDatabaseError("database returned an unsupported SQL value");
}

function claimResultBytes(budget: SqlResultBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > MAX_SQL_RESULT_BYTES) {
    throw new PluginDatabaseError(
      `the result is over the ${String(MAX_SQL_RESULT_BYTES)}-byte limit; page it`,
    );
  }
}

export function openPluginDatabase(options: PluginDatabaseOptions): PluginDatabaseAdmin {
  const { dataDir, pluginId } = options;
  return openDatabaseImage(options, pluginDatabasePath(dataDir, pluginId));
}

/** Only the engine chooses image paths; guests never get an alternate-file open verb. */
function openDatabaseImage(options: PluginDatabaseOptions, path: string): PluginDatabaseAdmin {
  const { pluginId } = options;
  const maxPages = Math.max(
    1,
    Math.floor(grantedDatabaseMaxBytes(options.maxBytes) / DATABASE_PAGE_BYTES),
  );
  const now = options.now ?? (() => Date.now());
  let handle: Database | null = null;
  let activeMaxPages = maxPages;
  let outcomeUnknown = false;
  const profiled = options.recovery?.profile === "bounded-wal-v1";
  if (profiled) boundedWalFamily(options.maxBytes ?? 0);

  const open = (): Database => {
    if (outcomeUnknown)
      throw new PluginDatabaseError("outcome_unknown: reopen and reconcile durable operation identity");
    if (handle !== null) return handle;
    return withRecoveryGateSync(options.dataDir, () => {
    let admittedPages = maxPages;
    if (profiled) {
      const retainedBytes = options.recoveryBudget?.allocation(pluginId) ?? null;
      const allocation = options.recoveryBudget?.ensureAllocation(pluginId, options.maxBytes!);
      if (allocation === undefined || !allocation.ok) {
        if (retainedBytes === null)
          throw new PluginDatabaseError(`${allocation?.reason ?? "recovery_unavailable"}: recovery allocation refused`);
        // Expansion admission cannot strand retained data. Keep SQLite's old physical cap;
        // growth beyond it remains impossible until admitRecovery durably expands the ledger.
        admittedPages = Math.min(maxPages, retainedBytes / DATABASE_PAGE_BYTES);
      }
    }
    mkdirSync(pluginDatabaseDir(options.dataDir, pluginId), { recursive: true });
    const db = new Database(path, { create: true, strict: true, safeIntegers: true });
    try {
      db.exec(`PRAGMA page_size = ${String(DATABASE_PAGE_BYTES)}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA trusted_schema = OFF");
      db.exec("PRAGMA temp_store = MEMORY");
      db.exec("PRAGMA cache_size = -2048");
      db.exec("PRAGMA mmap_size = 0");
      db.exec("PRAGMA journal_size_limit = 0");
      db.exec(`PRAGMA wal_autocheckpoint = ${profiled ? "0" : "256"}`);
      if (profiled) {
        db.exec("PRAGMA cache_spill = OFF");
        db.exec("PRAGMA busy_timeout = 0");
      }
      const size = db.query<{ page_size: bigint }, []>("PRAGMA page_size").get();
      const pages = db.query<{ page_count: bigint }, []>("PRAGMA page_count").get();
      if (
        size?.page_size !== BigInt(DATABASE_PAGE_BYTES) ||
        (pages?.page_count ?? 0n) > BigInt(admittedPages)
      )
        throw new PluginDatabaseError("database exceeds the candidate manifest page budget");
      db.exec(`PRAGMA max_page_count = ${String(admittedPages)}`);
    } catch (error) {
      db.close();
      throw error;
    }
    db.exec(`PRAGMA foreign_keys = ON`);
    handle = db;
    activeMaxPages = admittedPages;
    return db;
    });
  };

  /** Runs one validated statement and charges every returned row to the call's wire budget. */
  const rows = (
    db: Database,
    sql: string,
    params: readonly SqlParam[] | undefined,
    budget: SqlResultBudget,
  ): readonly SqlRow[] => {
    const statement = db.query<SqlRow, SqlParam[]>(sql);
    try {
      const result: SqlRow[] = [];
      claimResultBytes(budget, 2);
      for (const row of statement.iterate(...((params ?? []) as SqlParam[]))) {
        budget.rows += 1;
        if (budget.rows > MAX_SQL_ROWS)
          throw new PluginDatabaseError(
            `the call exceeded the ${String(MAX_SQL_ROWS)}-row limit; page it`,
          );
        let rowBytes = 3;
        let columns = 0;
        for (const [column, value] of Object.entries(row)) {
          rowBytes +=
            (columns === 0 ? 0 : 1) + jsonStringBytes(column) + 1 + sqlValueWireBytes(value);
          columns += 1;
        }
        claimResultBytes(budget, rowBytes);
        result.push(row);
      }
      return result;
    } finally {
      statement.finalize();
    }
  };

  const changes = (
    db: Database,
    sql: string,
    params: readonly SqlParam[] | undefined,
  ): SqlRunResult => {
    const statement = db.query<void, SqlParam[]>(sql);
    try {
      const result = statement.run(...((params ?? []) as SqlParam[]));
      if (!Number.isSafeInteger(Number(result.changes)) || Number(result.changes) < 0)
        throw new PluginDatabaseError("database returned an invalid change count");
      return {
        changes: Number(result.changes),
        lastInsertRowid: BigInt(result.lastInsertRowid),
      };
    } finally {
      statement.finalize();
    }
  };

  /** Every result is validated while rollback is still possible, including DML RETURNING. */
  const transaction = <T>(work: (db: Database, started: number) => T): T => {
    const db = open();
    if (profiled) {
      const checkpoint = db.query<{ busy: bigint }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy !== 0n || (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size !== 0))
        throw new PluginDatabaseError("database_busy: bounded WAL cannot be truncated");
    }
    const started = now();
    db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const result = work(db, started);
      if (now() - started > SQL_DEADLINE_MS)
        throw new PluginDatabaseError("the database call exceeded its deadline and was rolled back");
      committing = true;
      db.exec("COMMIT");
      // Nothing fallible may run here: a committed DML result is always success.
      return result;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const uncertainCommit = committing && !sqliteBusy(error) && code !== "SQLITE_FULL";
      let rollbackFailed = false;
      if (db.inTransaction) {
        try { db.exec("ROLLBACK"); } catch { rollbackFailed = true; }
      }
      if (uncertainCommit || rollbackFailed) {
        outcomeUnknown = true;
        throw new PluginDatabaseError("outcome_unknown: database commit requires durable reconciliation");
      }
      throw error;
    }
  };

  /** SQLite's own errors are the plugin's authoring bugs, surfaced in the contract's type. */
  const attempt = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof PluginDatabaseError) throw error;
      if (sqliteBusy(error)) throw new PluginDatabaseError("database_busy: database is locked");
      if (error instanceof Error && "code" in error && error.code === "SQLITE_FULL")
        throw new PluginDatabaseError("database_full: SQLite or the filesystem is full");
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginDatabaseError(message);
    }
  };

  return {
    pluginId,
    admitRecovery: async () => {
      if (outcomeUnknown) throw new PluginDatabaseError("outcome_unknown: reopen and reconcile");
      if (!profiled || options.recoveryBudget === undefined)
        return { ok: false, reason: "recovery_unavailable" };
      const allocated = options.recoveryBudget.ensureAllocation(pluginId, options.maxBytes!);
      if (!allocated.ok) return allocated;
      const admission = options.recoveryBudget.admit(pluginId);
      if (admission.ok && handle !== null && activeMaxPages < maxPages) {
        try {
          handle.exec(`PRAGMA max_page_count = ${String(maxPages)}`);
          activeMaxPages = maxPages;
        } catch (error) {
          if (sqliteBusy(error)) return { ok: false, reason: "database_busy" };
          return attempt(() => { throw error; });
        }
      }
      return admission;
    },
    query: async <Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlParam[]) => {
      assertSqlStatement(sql);
      assertSqlParams(params);
      return attempt(() => transaction((db) => rows(db, sql, params, { rows: 0, bytes: 0 }) as readonly Row[]));
    },
    run: async (sql, params) => {
      assertSqlStatement(sql);
      assertSqlParams(params);
      return attempt(() => transaction((db) => changes(db, sql, params)));
    },
    batch: async (statements: readonly SqlStatement[]) => {
      assertSqlBatch(statements);
      return attempt(() => transaction((db, started) => {
        const budget = { rows: 0, bytes: 2 };
        const results: (readonly SqlRow[])[] = [];
        for (const statement of statements) {
          if (now() - started > SQL_DEADLINE_MS)
            throw new PluginDatabaseError("the batch exceeded its deadline and was rolled back");
          claimResultBytes(budget, 1);
          results.push(rows(db, statement.sql, statement.params, budget));
        }
        return results;
      }));
    },
    pageCount: async () => {
      if (!existsSync(path)) return 0;
      const db = open();
      const row = db.query<{ page_count: bigint }, []>("PRAGMA page_count").get();
      return Number(row?.page_count ?? 0n);
    },
    sizeBytes: async () => {
      let total = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${path}${suffix}`;
        if (existsSync(candidate)) total += statSync(candidate).size;
      }
      return total;
    },
    clear: async () => withRecoveryGateSync(options.dataDir, () => {
      let removed = 0;
      if (handle !== null) {
        handle.close();
        handle = null;
      }
      for (const image of ["", ".stage", ".backup"]) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const candidate = `${path}${image}${suffix}`;
          if (existsSync(candidate)) removed += statSync(candidate).size;
        }
        removeImage(`${path}${image}`);
      }
      const dir = pluginDatabaseDir(options.dataDir, pluginId);
      if (existsSync(dir)) syncPath(dir);
      options.recoveryBudget?.releaseAfterPurge(pluginId);
      return removed;
    }),
    close: () => {
      if (handle !== null) {
        const closing = handle;
        handle = null;
        try {
          const checkpoint = closing
            .query<{ busy: bigint }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
            .get();
          if (checkpoint?.busy !== 0n) throw new PluginDatabaseError("database checkpoint is busy");
        } finally {
          closing.close();
        }
      }
    },
  };
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeImage(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    rmSync(`${path}${suffix}`, { force: true });
}

/** Constant-memory hashing: a permitted database can be much larger than the JS heap. */
function fingerprint(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular database image: ${path}`);
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) !== 0)
      hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function assertClosedImage(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (existsSync(`${path}${suffix}`))
      throw new Error(`database image has an unexpected journal: ${path}${suffix}`);
}

/**
 * Idempotent recovery, with every image verified before any destructive operation.
 * Prepared rolls back; committed rolls forward. Unknown bytes are operator evidence,
 * never an invitation to guess which file to overwrite.
 */
export function recoverPluginDatabase(
  dataDir: string,
  store: ServerStore,
  journal: PluginDatabaseJournal,
): void {
  return withRecoveryGateSync(dataDir, () => {
  const live = pluginDatabasePath(dataDir, journal.plugin_id);
  const stage = `${live}.stage`;
  const backup = `${live}.backup`;
  for (const path of [live, stage, backup]) assertClosedImage(path);
  const current = fingerprint(live);
  const staged = fingerprint(stage);
  const saved = fingerprint(backup);
  const { previous, next } = journal;
  if (
    (current !== null && current !== previous && current !== next) ||
    (staged !== null && staged !== next) ||
    (saved !== null && saved !== previous)
  )
    throw new Error(`unknown database image for ${journal.plugin_id}; recovery refused`);

  if (journal.phase === "prepared") {
    if (previous !== null && current !== previous && saved !== previous)
      throw new Error(`missing previous database image for ${journal.plugin_id}`);
    if (previous === null) {
      rmSync(live, { force: true });
    } else if (current !== previous) {
      renameSync(backup, live);
    }
  } else {
    if (next !== null && current !== next && staged !== next)
      throw new Error(`missing committed database image for ${journal.plugin_id}`);
    if (next === null) rmSync(live, { force: true });
    else if (current !== next) renameSync(stage, live);
  }
  if (existsSync(live)) syncPath(live);
  // Persist the recovered canonical name before removing its last alternate image.
  syncPath(pluginDatabaseDir(dataDir, journal.plugin_id));
  rmSync(stage, { force: true });
  rmSync(backup, { force: true });
  syncPath(pluginDatabaseDir(dataDir, journal.plugin_id));
  store.forgetPluginDatabase(journal.plugin_id);
  new RecoveryBudget(dataDir, store.db).releaseStageAfterCleanup(journal.plugin_id);
  });
}

/** Must precede module loading, migration planning, and any plugin database open at boot. */
export function recoverPluginDatabases(dataDir: string, store: ServerStore): void {
  return withRecoveryGateSync(dataDir, () => {
  for (const journal of store.pluginDatabaseJournals())
    recoverPluginDatabase(dataDir, store, journal);
  const root = join(dataDir, "plugins");
  if (existsSync(root)) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const live = pluginDatabasePath(dataDir, entry.name);
    removeImage(`${live}.stage`);
    removeImage(`${live}.backup`);
    syncPath(pluginDatabaseDir(dataDir, entry.name));
  }
  }
  const budget = new RecoveryBudget(dataDir, store.db);
  for (const row of store.db.query<{ plugin_id: string }, []>(
    "SELECT plugin_id FROM plugin_recovery_stages",
  ).all()) budget.releaseStageAfterCleanup(row.plugin_id);
  });
}

export interface PluginDatabaseStage {
  readonly database: PluginDatabase;
  activate(): void;
  committed(): void;
  finish(): void;
  discard(): void;
}

/** A private closed-file copy, never an awaited SQLite transaction or a live admin handle. */
export function stagePluginDatabase(
  options: PluginDatabaseOptions,
  store: ServerStore,
): PluginDatabaseStage {
  return withRecoveryGateSync(options.dataDir, () => {
  const { dataDir, pluginId } = options;
  const live = pluginDatabasePath(dataDir, pluginId);
  const stage = `${live}.stage`;
  const backup = `${live}.backup`;
  const dir = pluginDatabaseDir(dataDir, pluginId);
  mkdirSync(dir, { recursive: true });
  // Persist newly created directory entries as well as the eventual image rename.
  syncPath(join(dataDir, "plugins"));
  syncPath(dataDir);
  for (const path of [stage, backup]) assertClosedImage(path);
  if (existsSync(stage) || existsSync(backup) || store.pluginDatabaseJournal(pluginId) !== null)
    throw new Error("plugin database staging requires recovery");
  if (options.recovery !== undefined) {
    if (options.recoveryBudget === undefined)
      throw new PluginDatabaseError("recovery_unavailable: no recovery ledger");
    options.recoveryBudget.reserveStage(pluginId, options.maxBytes!);
  }
  let previous: string | null;
  let database: PluginDatabaseAdmin;
  try {
  if (existsSync(live)) {
    if (!lstatSync(live).isFile()) throw new Error("not a regular plugin database");
    // After a process crash there may be a WAL but no cached host admin to close.
    const db = new Database(live, { strict: true });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      db.exec("PRAGMA cache_size = -2048");
      const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy !== 0) throw new Error("plugin database checkpoint is busy");
    } finally {
      db.close();
    }
    if (statSync(live).size > grantedDatabaseMaxBytes(options.maxBytes))
      throw new PluginDatabaseError("database exceeds the candidate manifest page budget");
  }
  assertClosedImage(live);
    previous = fingerprint(live);
    if (previous !== null) copyFileSync(live, stage);
    database = openDatabaseImage(options, stage);
  } catch (error) {
    removeImage(stage);
    syncPath(dir);
    options.recoveryBudget?.releaseStageAfterCleanup(pluginId);
    throw error;
  }
  let journal: PluginDatabaseJournal | undefined;
  let closed = false;
  let operations = 0;
  const check = (): void => {
    if (closed) throw new PluginDatabaseError("plugin database migration is closed");
    if (++operations > MAX_MIGRATION_STORAGE_OPERATIONS) {
      closed = true;
      throw new PluginDatabaseError("plugin database migration exceeded its operation budget");
    }
  };
  return {
    database: {
      pluginId,
      admitRecovery: async () => {
        check();
        return database.admitRecovery();
      },
      query: async <Row extends SqlRow>(sql: string, params?: readonly SqlParam[]) => {
        check();
        return database.query<Row>(sql, params);
      },
      run: async (sql, params) => {
        check();
        return database.run(sql, params);
      },
      batch: async (statements) => {
        check();
        return database.batch(statements);
      },
    },
    activate: () => withRecoveryGateSync(dataDir, () => {
      if (closed) throw new Error("plugin database staging is closed");
      closed = true;
      database.close();
      assertClosedImage(live);
      assertClosedImage(stage);
      assertClosedImage(backup);
      if (existsSync(backup))
        throw new Error("unexpected plugin database backup; activation refused");
      if (fingerprint(live) !== previous)
        throw new Error("plugin database changed while migration was staged");
      const next = fingerprint(stage);
      if (next !== null) syncPath(stage);
      if (previous !== null) syncPath(live);
      syncPath(dir);
      store.preparePluginDatabase({ plugin_id: pluginId, previous, next });
      journal = { plugin_id: pluginId, previous, next, phase: "prepared" };
      if (previous !== null) {
        renameSync(live, backup);
        syncPath(dir);
      }
      if (next !== null) renameSync(stage, live);
      syncPath(dir);
    }),
    committed: () => {
      if (journal === undefined) throw new Error("plugin database is not prepared");
      store.commitPluginDatabase(pluginId);
    },
    finish: () => {
      if (journal === undefined) throw new Error("plugin database is not prepared");
      recoverPluginDatabase(dataDir, store, { ...journal, phase: "committed" });
      journal = undefined;
    },
    discard: () => withRecoveryGateSync(dataDir, () => {
      closed = true;
      database.close();
      if (journal !== undefined) {
        // A lost metadata COMMIT acknowledgement is not proof that publication rolled back.
        // Reconcile the actual journal rather than blindly applying this object's old phase.
        if (store.db.inTransaction)
          throw new PluginDatabaseError("outcome_unknown: migration metadata requires recovery");
        const durable = store.pluginDatabaseJournal(pluginId);
        if (durable === null)
          throw new PluginDatabaseError("outcome_unknown: migration journal requires recovery");
        recoverPluginDatabase(dataDir, store, durable);
        journal = undefined;
      } else {
        removeImage(stage);
        syncPath(dir);
        options.recoveryBudget?.releaseStageAfterCleanup(pluginId);
      }
    }),
  };
  });
}
