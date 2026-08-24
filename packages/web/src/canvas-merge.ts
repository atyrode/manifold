import { compareElements, shouldAccept, type SceneElement } from "@manifold/protocol";

/**
 * The version stamp a live Excalidraw element must expose for last-writer-wins merging.
 * Structural on purpose: the canvas hands us `OrderedExcalidrawElement`s, the SDK hands us
 * protocol `SceneElement`s, and this module must never depend on either package's zoo.
 */
export interface CanvasSceneStamp {
  readonly id: string;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly index?: string | null | undefined;
}

export interface CanvasMerge<T extends CanvasSceneStamp> {
  /** Full next canvas: live elements with winners substituted, new winners appended, in canonical order. */
  readonly elements: readonly (T | SceneElement)[];
  /** Canonical records that beat the live canvas — the only ids whose bookkeeping may advance. */
  readonly winners: readonly SceneElement[];
}

function stampOf(element: CanvasSceneStamp): SceneElement {
  return {
    id: element.id,
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: element.isDeleted,
    index: element.index ?? null,
  };
}

/**
 * Merges the canonical scene into the LIVE canvas instead of replacing it.
 *
 * Replacing wholesale was the multiplayer-killing bug: the canvas is always ahead of the
 * canonical scene while a gesture is in flight (sends are throttled), so painting
 * `client.scene` verbatim reverted every stroke/drag to the last flushed partial — and the
 * caller's bookkeeping then discarded the newer local state so it was never sent at all.
 *
 * Rules (same LWW as protocol reconcile, by construction — `shouldAccept` decides):
 * - a canonical record is applied only if it beats the live element's version/nonce;
 * - live elements the canonical scene has never seen (unflushed local edits) survive;
 * - returns null when nothing canonical wins, so callers can skip painting entirely —
 *   which makes the echo of our own optimistic updates a strict no-op mid-gesture.
 */
export function mergeCanonicalScene<T extends CanvasSceneStamp>(
  canvas: readonly T[],
  canonical: ReadonlyMap<string, SceneElement>,
): CanvasMerge<T> | null {
  const liveById = new Map<string, T>();
  for (const element of canvas) liveById.set(element.id, element);

  const winners: SceneElement[] = [];
  const winnerById = new Map<string, SceneElement>();
  for (const incoming of canonical.values()) {
    const live = liveById.get(incoming.id);
    if (shouldAccept(live === undefined ? undefined : stampOf(live), incoming)) {
      winners.push(incoming);
      winnerById.set(incoming.id, incoming);
    }
  }
  if (winners.length === 0) return null;

  const merged: (T | SceneElement)[] = canvas.map(
    (element) => winnerById.get(element.id) ?? element,
  );
  for (const winner of winners) {
    if (!liveById.has(winner.id)) merged.push(winner);
  }
  merged.sort((a, b) => compareElements(stampOf(a), stampOf(b)));
  return { elements: merged, winners };
}
