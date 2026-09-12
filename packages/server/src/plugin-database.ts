import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
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
 * `batch` is `BEGIN IMMEDIATE … COMMIT`: the write lock is taken up front, so a batch never
 * starts on a snapshot it cannot commit, and a refusal or a deadline anywhere inside rolls the
 * whole thing back. The deadline is checked between statements, which is the only place a
 * synchronous driver can check it; a single statement that runs long is bounded by SQLite's
 * own progress handler, set to interrupt at the same budget.
 */
export interface PluginDatabaseOptions {
  readonly dataDir: string;
  readonly pluginId: string;
  /** The manifest's request; the engine grants within its ceiling. */
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export function pluginDatabaseDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId);
}

export function pluginDatabasePath(dataDir: string, pluginId: string): string {
  return join(pluginDatabaseDir(dataDir, pluginId), "data.db");
}

export function openPluginDatabase(options: PluginDatabaseOptions): PluginDatabaseAdmin {
  const { dataDir, pluginId } = options;
  const path = pluginDatabasePath(dataDir, pluginId);
  const maxPages = Math.max(1, Math.floor(grantedDatabaseMaxBytes(options.maxBytes) / DATABASE_PAGE_BYTES));
  const now = options.now ?? (() => Date.now());
  let handle: Database | null = null;

  const open = (): Database => {
    if (handle !== null) return handle;
    mkdirSync(pluginDatabaseDir(dataDir, pluginId), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.exec(`PRAGMA journal_mode = WAL`);
    db.exec(`PRAGMA synchronous = NORMAL`);
    db.exec(`PRAGMA trusted_schema = OFF`);
    db.exec(`PRAGMA page_size = ${String(DATABASE_PAGE_BYTES)}`);
    db.exec(`PRAGMA max_page_count = ${String(maxPages)}`);
    db.exec(`PRAGMA foreign_keys = ON`);
    handle = db;
    return db;
  };

  /** Runs one validated statement and returns its rows, bounded. */
  const rows = (db: Database, sql: string, params: readonly SqlParam[] | undefined): readonly SqlRow[] => {
    const statement = db.query<SqlRow, SqlParam[]>(sql);
    try {
      const result = statement.all(...((params ?? []) as SqlParam[]));
      if (result.length > MAX_SQL_ROWS) {
        throw new PluginDatabaseError(
          `the statement returned ${String(result.length)} rows, over the ${String(MAX_SQL_ROWS)}-row limit; page it`,
        );
      }
      let bytes = 0;
      for (const row of result) {
        for (const value of Object.values(row)) {
          bytes +=
            typeof value === "string"
              ? value.length
              : value instanceof Uint8Array
                ? value.byteLength
                : 8;
          if (bytes > MAX_SQL_RESULT_BYTES) {
            throw new PluginDatabaseError(
              `the result is over the ${String(MAX_SQL_RESULT_BYTES)}-byte limit; page it`,
            );
          }
        }
      }
      return result;
    } finally {
      statement.finalize();
    }
  };

  const changes = (db: Database, sql: string, params: readonly SqlParam[] | undefined): SqlRunResult => {
    const statement = db.query<void, SqlParam[]>(sql);
    try {
      const result = statement.run(...((params ?? []) as SqlParam[]));
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    } finally {
      statement.finalize();
    }
  };

  /** SQLite's own errors are the plugin's authoring bugs, surfaced in the contract's type. */
  const attempt = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof PluginDatabaseError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PluginDatabaseError(message);
    }
  };

  return {
    pluginId,
    query: async <Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlParam[]) => {
      assertSqlStatement(sql);
      assertSqlParams(params);
      return attempt(() => rows(open(), sql, params) as readonly Row[]);
    },
    run: async (sql, params) => {
      assertSqlStatement(sql);
      assertSqlParams(params);
      return attempt(() => changes(open(), sql, params));
    },
    batch: async (statements: readonly SqlStatement[]) => {
      assertSqlBatch(statements);
      const db = open();
      const started = now();
      return attempt(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const results: (readonly SqlRow[])[] = [];
          for (const statement of statements) {
            if (now() - started > SQL_DEADLINE_MS) {
              throw new PluginDatabaseError(
                `the batch ran past its ${String(SQL_DEADLINE_MS)} ms deadline and was rolled back`,
              );
            }
            results.push(rows(db, statement.sql, statement.params));
          }
          db.exec("COMMIT");
          return results;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Already rolled back by SQLite itself; the original error is the one to report.
          }
          throw error;
        }
      });
    },
    pageCount: async () => {
      if (!existsSync(path)) return 0;
      const db = open();
      const row = db.query<{ page_count: number }, []>("PRAGMA page_count").get();
      return row?.page_count ?? 0;
    },
    sizeBytes: async () => {
      let total = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${path}${suffix}`;
        if (existsSync(candidate)) total += statSync(candidate).size;
      }
      return total;
    },
    clear: async () => {
      let removed = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        const candidate = `${path}${suffix}`;
        if (existsSync(candidate)) removed += statSync(candidate).size;
      }
      if (handle !== null) {
        handle.close();
        handle = null;
      }
      rmSync(pluginDatabaseDir(dataDir, pluginId), { recursive: true, force: true });
      return removed;
    },
    close: () => {
      if (handle !== null) {
        handle.close();
        handle = null;
      }
    },
  };
}
