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
  readonly mutation: boolean;
  active: boolean;
  readonly owner: AbortSignal | undefined;
  release(): void;
}
const heldGate = new AsyncLocalStorage<GateLease>();
// Synchronous mutation entries can share this process's exclusion from capture, even when
// called from another async context (lazy live reads and shutdown cleanup). Async owners
// never borrow it, and capture leases are never published here.
const mutations = new Map<string, GateLease>();

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
function tryGate(root: string, mutation: boolean, owner?: AbortSignal): GateLease | null {
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
      mutation,
      active: true,
      owner,
      release() {
        if (!lease.active) return;
        lease.active = false;
        if (mutations.get(root) === lease) mutations.delete(root);
        db.close();
      },
    };
    if (mutation) mutations.set(root, lease);
    return lease;
  } catch (error) {
    db.close();
    if (sqliteBusy(error)) return null;
    throw error;
  }
}

async function acquireGate(
  root: string,
  mutation: boolean,
  check: () => void,
  owner?: AbortSignal,
  deadline = performance.now() + RECOVERY_LOCK_WAIT_MS,
): Promise<GateLease> {
  const inherited = heldGate.getStore();
  for (;;) {
    check();
    if (inherited?.root === root && inherited.owner?.aborted)
      throw new Error("the recovery gate owner is closed");
    const lease = tryGate(root, mutation, owner);
    if (lease !== null) return lease;
    if (performance.now() >= deadline) throw new RecoveryGateBusyError();
    await Bun.sleep(10);
  }
}

/**
 * An async mutation owns capture exclusion until settlement or confirmed shutdown cleanup,
 * not until a retired plugin callback happens to return. A failed close retains the fence.
 */
export class RecoveryGateLifetime {
  private retired = false;
  private cleanupConfirmed = false;
  // IPC resources can outlive a normally completed lease. Fence their owner generation,
  // rather than treating every released lease as a retired host.
  private readonly revoked = new AbortController();
  private lease: GateLease | undefined;

  async run<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
    const root = resolve(dataDir);
    const inherited = heldGate.getStore();
    const check = (): void => {
      if (this.retired || (inherited?.root === root && inherited.owner?.aborted))
        throw new Error("the recovery gate owner is closed");
    };
    const lease = await acquireGate(root, true, check, this.revoked.signal);
    this.lease = lease;
    try {
      check();
      return await heldGate.run(lease, operation);
    } finally {
      // close() releases only after cleanup succeeds. Neither a late callback nor a failed
      // cleanup may release a successor's fence or turn unconfirmed retirement into success.
      if (!this.retired || this.cleanupConfirmed) lease.release();
      if (!lease.active && this.lease === lease) this.lease = undefined;
    }
  }

  close(cleanup: () => void): void {
    this.retired = true;
    try {
      cleanup();
      this.cleanupConfirmed = true;
      this.lease?.release();
    } finally {
      this.revoked.abort();
      if (this.lease !== undefined && !this.lease.active) this.lease = undefined;
    }
  }
}

/** Lazy image opens/recovery may not await; fail before any filesystem transition. */
export function withRecoveryGateSync<T>(dataDir: string, operation: () => T): T {
  const root = resolve(dataDir);
  const inherited = heldGate.getStore();
  if (inherited?.root === root) {
    if (inherited.owner?.aborted) throw new Error("the recovery gate owner is closed");
    if (!inherited.mutation) throw new RecoveryGateBusyError();
    if (inherited.active) return operation();
  }
  const borrowed = mutations.get(root);
  if (borrowed !== undefined) {
    if (borrowed.owner?.aborted) throw new RecoveryGateBusyError();
    return heldGate.run(borrowed, operation);
  }
  const lease = tryGate(root, true, inherited?.root === root ? inherited.owner : undefined);
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
  const lease = await acquireGate(resolve(dataDir), false, () => {}, undefined, deadline);
  try {
    return await heldGate.run(lease, async () => {
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
    });
  } finally {
    lease.release();
  }
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
