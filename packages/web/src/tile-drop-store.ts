import type { PlacementDestination } from "@manifold/protocol";

/**
 * The per-frame channel between a drag transport and a tile area's preview overlay.
 *
 * One store per host surface. Transports (an HTML5 `dragover`, a React Flow node drag)
 * write the pointer and — on a canvas — which widget the canvas has armed; the overlay
 * resolves the aim and publishes the destination back, so the transport can commit it at
 * release. Consumed with `useSyncExternalStore` ONLY by the overlay: a pointer update
 * repaints the overlay alone and never re-renders the widget or its live terminals,
 * which is what allowed deleting the old node-data zone stamping (it remapped every
 * projected node on every zone change).
 */
export interface TileDropSignal {
  readonly pointer: { readonly clientX: number; readonly clientY: number } | null;
  /** Canvas only: which widget the canvas armed. The route leaves it null. */
  readonly armedElementId: string | null;
  /** The overlay's answer: what releasing right now would commit. */
  readonly aim: {
    readonly destination: PlacementDestination;
    readonly containerId: string;
  } | null;
}

export interface TileDropStore {
  get(): TileDropSignal;
  set(next: TileDropSignal): void;
  subscribe(listener: () => void): () => void;
}

const IDLE_SIGNAL: TileDropSignal = { pointer: null, armedElementId: null, aim: null };

function destinationsEqual(a: PlacementDestination, b: PlacementDestination): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "canvas":
      return b.kind === "canvas" && a.padId === b.padId && a.x === b.x && a.y === b.y;
    case "tile":
      return (
        b.kind === "tile" &&
        a.padId === b.padId &&
        a.targetTileId === b.targetTileId &&
        a.edge === b.edge
      );
    case "compose":
      return (
        b.kind === "compose" &&
        a.padId === b.padId &&
        a.targetElementId === b.targetElementId &&
        a.edge === b.edge
      );
    case "unplaced":
      return b.kind === "unplaced";
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

/** Value equality, so a republished identical frame never re-notifies (loop-proof). */
export function tileDropSignalsEqual(a: TileDropSignal, b: TileDropSignal): boolean {
  if (a === b) return true;
  if ((a.pointer === null) !== (b.pointer === null)) return false;
  if (
    a.pointer !== null &&
    b.pointer !== null &&
    (a.pointer.clientX !== b.pointer.clientX || a.pointer.clientY !== b.pointer.clientY)
  ) {
    return false;
  }
  if (a.armedElementId !== b.armedElementId) return false;
  if ((a.aim === null) !== (b.aim === null)) return false;
  if (a.aim !== null && b.aim !== null) {
    if (a.aim.containerId !== b.aim.containerId) return false;
    if (!destinationsEqual(a.aim.destination, b.aim.destination)) return false;
  }
  return true;
}

export function createTileDropStore(): TileDropStore {
  let signal = IDLE_SIGNAL;
  const listeners = new Set<() => void>();
  return {
    get: () => signal,
    set: (next) => {
      if (tileDropSignalsEqual(signal, next)) return;
      signal = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
