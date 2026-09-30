import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const RECOVERY_GATE_FILE = "manifold.recovery-gate";
export const RECOVERY_LOCK_WAIT_MS = 5_000;
export const RECOVERY_CAPTURE_TIMEOUT_MS = 30_000;
interface GateLease {
  readonly root: string;
  active: boolean;
  release(): void;
}
const heldGate = new AsyncLocalStorage<GateLease>();

export function sqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

class RecoveryGateBusyError extends Error {
  readonly code = "SQLITE_BUSY";
  constructor() {
    super("database_busy: recovery gate is held");
  }
}

/** Kernel locks, not a PID/stale-lock heuristic. Never unlink this file. */
function tryGate(root: string): GateLease | null {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, RECOVERY_GATE_FILE), { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS gate(value INTEGER)");
    db.exec("DELETE FROM gate");
    db.exec("INSERT INTO gate VALUES (1)");
    db.exec("COMMIT");
    const lease: GateLease = {
      root,
      active: true,
      release() {
        if (!lease.active) return;
        lease.active = false;
        db.close();
      },
    };
    return lease;
  } catch (error) {
    db.close();
    if (sqliteBusy(error)) return null;
    throw error;
  }
}

export async function withRecoveryGate<T>(
  dataDir: string,
  operation: () => Promise<T>,
  deadline = performance.now() + RECOVERY_LOCK_WAIT_MS,
): Promise<T> {
  const root = resolve(dataDir);
  const inherited = heldGate.getStore();
  if (inherited?.active && inherited.root === root) return operation();
  let lease: GateLease | null;
  while ((lease = tryGate(root)) === null) {
    if (performance.now() >= deadline) throw new RecoveryGateBusyError();
    await Bun.sleep(10);
  }
  try {
    return await heldGate.run(lease, operation);
  } finally {
    lease.release();
  }
}

/** Lazy image opens/recovery may not await; fail before any filesystem transition. */
export function withRecoveryGateSync<T>(dataDir: string, operation: () => T): T {
  const root = resolve(dataDir);
  const inherited = heldGate.getStore();
  if (inherited?.active && inherited.root === root) return operation();
  const lease = tryGate(root);
  if (lease === null) throw new RecoveryGateBusyError();
  try {
    return heldGate.run(lease, operation);
  } finally {
    lease.release();
  }
}

/** Gate before main lock, always. The caller's process watchdog bounds synchronous copy. */
export async function withRecoveryCaptureFence<T>(dataDir: string, copy: () => T): Promise<T> {
  const deadline = performance.now() + RECOVERY_LOCK_WAIT_MS;
  return withRecoveryGate(
    dataDir,
    async () => {
      const fence = new Database(join(dataDir, "manifold.db"), { strict: true });
      try {
        fence.exec("PRAGMA busy_timeout = 0");
        for (;;) {
          try {
            fence.exec("BEGIN IMMEDIATE");
            break;
          } catch (error) {
            if (!sqliteBusy(error)) throw error;
            if (performance.now() >= deadline)
              throw new Error("database_busy: recovery fence is held");
            await Bun.sleep(10);
          }
        }
        return copy();
      } finally {
        try {
          if (fence.inTransaction) fence.exec("ROLLBACK");
        } finally {
          fence.close();
        }
      }
    },
    deadline,
  );
}

/** Runs in the parent: a blocked child event loop cannot postpone this deadline. */
export async function waitForRecoveryCapture(
  child: Subprocess<"ignore", "ignore", "pipe">,
  timeoutMs = RECOVERY_CAPTURE_TIMEOUT_MS,
): Promise<void> {
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGKILL");
    },
    Math.min(timeoutMs, RECOVERY_CAPTURE_TIMEOUT_MS),
  );
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (timedOut) throw new Error("checkpoint_timeout");
    if (code !== 0) throw new Error(error.trim() || "capture process failed");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
