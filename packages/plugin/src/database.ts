/**
 * PER-PLUGIN DATABASE — a plugin's own tables, beside its key-value ref (ADR 0034).
 *
 * `ctx.storage` is where a plugin keeps keys. This is where it keeps ROWS: one SQLite file
 * per declaring plugin, opened and owned by the engine, reachable through three
 * promise-returning verbs that are the same contract in-realm and across the isolate
 * boundary (ADR 0016 §4 — one contract, first-party plugins included). In-realm the statement
 * runs before the promise is handed back, so `await` costs a microtask; through the proxy the
 * same call crosses the boundary as `database.query`, `database.run` or `database.batch`.
 *
 * There is no open transaction handle on purpose. `batch` is the transaction: its statements
 * are known before it starts, it runs to completion or rolls back, and it costs one round
 * trip. A lock held across a plugin's awaits — in-realm across dispatch turns, isolated across
 * RPC — would be a second consistency model beside `compareAndSet`'s, and the ADR declines it.
 *
 * Every refusal below is a REJECTION with `PluginDatabaseError`, never a throw, so the one
 * failure path a plugin writes is a `try`/`catch` around an `await`, whichever way it runs.
 */

import { CEILING_DATABASE_MAX_BYTES } from "@manifold/protocol";

/** A bound parameter: what SQLite can hold and what crosses the isolate boundary intact. */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

/** One statement with its bound parameters, as `batch` takes them. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
}

/** A row as `query` returns it: column names to values, in the statement's own column order. */
export type SqlRow = Readonly<Record<string, SqlParam>>;

export interface PluginDatabase {
  readonly pluginId: string;
  /**
   * One statement, bound parameters, rows back. `SELECT` and any statement with `RETURNING`
   * yield their rows; every other statement yields an empty array (use `run` to learn what
   * it changed).
   */
  query<Row extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlParam[],
  ): Promise<readonly Row[]>;
  /** One statement, bound parameters, its change count and the last inserted rowid back. */
  run(sql: string, params?: readonly SqlParam[]): Promise<SqlRunResult>;
  /**
   * Several statements in ONE immediate transaction: all commit or none do, and the results
   * come back in order, each the rows that statement produced (empty for statements that
   * produce none). This is the plugin's transaction. A guard is an ordinary statement — a
   * `WHERE revision = ?` in an `UPDATE` — and the caller reads its change count through
   * `RETURNING` or a following `SELECT changes()`.
   */
  batch(statements: readonly SqlStatement[]): Promise<readonly (readonly SqlRow[])[]>;
}

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/**
 * The engine's half. `pageCount` is the uninstall guard's number (a plugin with pages is not
 * uninstalled silently, as one with keys is not); `clear` is the purge verb's hands — it closes
 * the handle and deletes the file with its journal — and `close` is what a disable or a
 * shutdown calls so the next open starts clean.
 */
export interface PluginDatabaseAdmin extends PluginDatabase {
  /** Pages the file holds right now; 0 when the file does not exist yet. */
  pageCount(): Promise<number>;
  /** Bytes on disk right now, journal included; 0 when the file does not exist yet. */
  sizeBytes(): Promise<number>;
  /** Closes the handle if open and deletes the file and its journal; reports the bytes that went. */
  clear(): Promise<number>;
  /** Closes the handle if open. Idempotent. */
  close(): void;
}

/** A refused database operation: an authoring bug, rejected rather than resolved. */
export class PluginDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDatabaseError";
  }
}

// ---------------------------------------------------------------------------- the bounds

/** A statement's text is bounded so a plugin cannot post a document through the SQL door. */
export const MAX_SQL_STATEMENT_BYTES = 64 * 1024;
/** SQLite's own default `SQLITE_MAX_VARIABLE_NUMBER` on the builds Bun ships. */
export const MAX_SQL_PARAMS = 999;
/** A batch is bounded so a runaway loop cannot hold the write lock for a full deadline. */
export const MAX_SQL_BATCH_STATEMENTS = 256;
/** Rows a single call may return; a plugin pages past this rather than the engine buffering. */
export const MAX_SQL_ROWS = 10_000;
/** Bytes a single call's result may occupy once serialized; the same reason. */
export const MAX_SQL_RESULT_BYTES = 4 * 1024 * 1024;
/** A call runs under this deadline; a batch that passes it is rolled back. */
export const SQL_DEADLINE_MS = 5_000;
/** The file's size unless the manifest asks for more; the ceiling is the wire's (`@manifold/protocol`). */
export const DEFAULT_DATABASE_MAX_BYTES = 256 * 1024 * 1024;
export { CEILING_DATABASE_MAX_BYTES };
/** SQLite's page size on every file the engine opens; the byte cap is expressed in these. */
export const DATABASE_PAGE_BYTES = 4096;

/**
 * Statements that would reach outside the plugin's own file, or change how the engine opened
 * it, are refused before execution by looking at the first keyword. This is a guard against
 * reaching out, not a sandbox: an in-realm plugin already runs in the engine's process
 * (ADR 0025) and a hardened one reaches here only through the proxy, which is the boundary.
 */
const REFUSED_LEADING_KEYWORDS: Record<string, true> = {
  ATTACH: true,
  DETACH: true,
  VACUUM: true,
  PRAGMA: true,
};
/** Function names refused anywhere in the text; `load_extension` is the one that matters. */
const REFUSED_FUNCTIONS = /\bload_extension\s*\(/i;

/** The first keyword of a statement, comments and leading whitespace removed; "" for none. */
export function leadingKeyword(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      if (end === -1) return "";
      rest = rest.slice(end + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2);
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_]+/.exec(rest);
  return match === null ? "" : match[0].toUpperCase();
}

/** Validates one statement's text a PLUGIN supplied. */
export function assertSqlStatement(sql: string): void {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new PluginDatabaseError("a statement must be a non-empty string");
  }
  const bytes = Buffer.byteLength(sql, "utf8");
  if (bytes > MAX_SQL_STATEMENT_BYTES) {
    throw new PluginDatabaseError(
      `statement is ${String(bytes)} bytes, over the ${String(MAX_SQL_STATEMENT_BYTES)}-byte limit`,
    );
  }
  const keyword = leadingKeyword(sql);
  if (REFUSED_LEADING_KEYWORDS[keyword] === true) {
    throw new PluginDatabaseError(
      `${keyword} is refused: a plugin's database is one file and the engine opened it`,
    );
  }
  if (REFUSED_FUNCTIONS.test(sql)) {
    throw new PluginDatabaseError("load_extension is refused: a plugin's database loads nothing");
  }
}

/** Validates the parameters a PLUGIN supplied for one statement. */
export function assertSqlParams(params: readonly SqlParam[] | undefined): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) {
    throw new PluginDatabaseError("parameters must be an array");
  }
  if (params.length > MAX_SQL_PARAMS) {
    throw new PluginDatabaseError(
      `${String(params.length)} parameters, over the ${String(MAX_SQL_PARAMS)} SQLite allows`,
    );
  }
  for (const value of params) {
    const kind = typeof value;
    if (
      value === null ||
      kind === "string" ||
      kind === "number" ||
      kind === "bigint" ||
      kind === "boolean" ||
      value instanceof Uint8Array
    ) {
      continue;
    }
    throw new PluginDatabaseError(
      `a parameter must be a string, number, bigint, boolean, null or Uint8Array, not ${kind}`,
    );
  }
}

/** Validates a batch a PLUGIN supplied: its length and every statement in it. */
export function assertSqlBatch(statements: readonly SqlStatement[]): void {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new PluginDatabaseError("a batch must hold at least one statement");
  }
  if (statements.length > MAX_SQL_BATCH_STATEMENTS) {
    throw new PluginDatabaseError(
      `a batch of ${String(statements.length)} statements is over the ${String(MAX_SQL_BATCH_STATEMENTS)}-statement limit`,
    );
  }
  for (const statement of statements) {
    assertSqlStatement(statement.sql);
    assertSqlParams(statement.params);
  }
}

/** The byte cap the engine grants a manifest that asked for `maxBytes`, or the default. */
export function grantedDatabaseMaxBytes(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_DATABASE_MAX_BYTES;
  return Math.min(Math.max(requested, DATABASE_PAGE_BYTES), CEILING_DATABASE_MAX_BYTES);
}
