import type { Database } from "bun:sqlite";

/**
 * Execute source-authored statements inside the caller's migration transaction.
 * Bun 1.4.2's multi-statement exec can lose an intermediate sqlite_step error;
 * preparing each statement separately makes that error reach the rollback boundary.
 * Trigger bodies stay whole array entries, never semicolon-split SQL.
 */
export function executeMigrationStatements(db: Database, statements: readonly string[]): void {
  for (const sql of statements) {
    const statement = db.prepare(sql);
    try {
      statement.run();
    } finally {
      statement.finalize();
    }
  }
}
