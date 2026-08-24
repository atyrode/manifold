/**
 * What to do with locally-pending (unflushed) edits when the SDK adopts a scene via
 * init/resync (`scene_reset`). Three distinct lineage situations, three invariants:
 *
 * - FIRST adoption ("" → epoch): edits made while connecting are legitimate; flush them
 *   into the adopted epoch (the SDK independently rebases its own optimistic records).
 *   Paint replaces wholesale — the canvas has never seen canonical state.
 * - SAME-epoch reconnect: the SDK preserved optimistic state via rebase; pending edits
 *   are current-lineage and must be flushed. Paint MERGES — a wholesale replace would
 *   revert canvas-ahead state mid-gesture (the original revert bug, reintroduced on
 *   reconnect).
 * - Epoch CHANGE (restore/reset): old-lineage pending edits must be DISCARDED, not
 *   flushed — re-stamping them into the new epoch bypasses the SDK's lineage fence and
 *   resurrects content the epoch change deliberately dropped. Paint replaces wholesale.
 */
export interface SceneResetAction {
  /** Send pending edits through the normal flush path. Mutually exclusive with discard. */
  readonly flushPending: boolean;
  /** Drop pending edits and version bookkeeping — they belong to a dead lineage. */
  readonly discardPending: boolean;
  /** Whole-canvas replace (epoch adoption) vs LWW merge (reconnect convergence). */
  readonly repaint: "replace" | "merge";
}

export function sceneResetAction(previousEpoch: string, adoptedEpoch: string): SceneResetAction {
  if (previousEpoch === "") {
    return { flushPending: true, discardPending: false, repaint: "replace" };
  }
  if (previousEpoch === adoptedEpoch) {
    return { flushPending: true, discardPending: false, repaint: "merge" };
  }
  return { flushPending: false, discardPending: true, repaint: "replace" };
}
