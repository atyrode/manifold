import type { SceneElement } from "./elements.ts";

/**
 * Element-granularity last-writer-wins. The SAME module runs on the server (canonical)
 * and in clients (optimistic + convergence) — consistency parity by construction.
 *
 * Rules:
 * - higher `version` wins;
 * - equal `version`: LOWER `versionNonce` wins as a deterministic tiebreak;
 * - deletions are ordinary LWW updates (`isDeleted: true` with a bumped version), and
 *   undo-of-delete is equally legitimate (`isDeleted: false` with a higher version).
 *
 * Tombstone permanence is a STORAGE rule, not an acceptance rule: canonical state and
 * snapshots retain deleted records forever (within an epoch), so a stale pre-delete copy
 * always has a tombstone to lose against. Pruning tombstones is what resurrects ghosts.
 */
export function shouldAccept(current: SceneElement | undefined, incoming: SceneElement): boolean {
  if (current === undefined) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  if (incoming.versionNonce !== current.versionNonce) {
    return incoming.versionNonce < current.versionNonce;
  }
  return false; // identical version+nonce: idempotent duplicate
}

export interface ReconcileResult {
  /** Incoming records that won LWW, in input order. Deduplicated by id (last wins). */
  readonly accepted: SceneElement[];
}

/**
 * Pure function: decides which incoming records the canonical state accepts.
 * The caller applies `accepted` to its own store; this module never mutates inputs.
 * Duplicate ids inside one batch are resolved by reconciling later entries against
 * earlier accepted ones.
 */
export function reconcile(
  current: ReadonlyMap<string, SceneElement>,
  incoming: readonly SceneElement[],
): ReconcileResult {
  const staged = new Map<string, SceneElement>();
  for (const el of incoming) {
    const base = staged.get(el.id) ?? current.get(el.id);
    if (shouldAccept(base, el)) staged.set(el.id, el);
  }
  return { accepted: [...staged.values()] };
}

/** Convenience for stores: applies a reconcile result into a mutable map. */
export function applyAccepted(
  state: Map<string, SceneElement>,
  accepted: readonly SceneElement[],
): void {
  for (const el of accepted) state.set(el.id, el);
}
