import type { CarryAim, PlacementDestination } from "@manifold/protocol";

import type { RemoteTileCarry } from "./carry.ts";
import type { TileAim } from "./tile-geometry.ts";

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
    /** The kernel's resolved aim, so the transport can lift it onto the carry wire. */
    readonly tile: TileAim;
  } | null;
  /**
   * The freshest PEER aim over this surface, written imperatively by the host from
   * its gesture frames — the overlay is the only subscriber, so a collaborator's
   * 60 Hz drag never re-renders the tree or its terminals. Local always outranks it.
   */
  readonly remote: RemoteTileCarry | null;
}

export interface TileDropStore {
  get(): TileDropSignal;
  set(next: TileDropSignal): void;
  subscribe(listener: () => void): () => void;
}

const IDLE_SIGNAL: TileDropSignal = {
  pointer: null,
  armedElementId: null,
  aim: null,
  remote: null,
};

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
        a.edge === b.edge &&
        (a.between === true) === (b.between === true)
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
    if (a.aim.tile.action !== b.aim.tile.action || a.aim.tile.tileId !== b.aim.tile.tileId) {
      return false;
    }
  }
  if ((a.remote === null) !== (b.remote === null)) return false;
  if (a.remote !== null && b.remote !== null) {
    if (a.remote.connId !== b.remote.connId || a.remote.updatedAt !== b.remote.updatedAt) {
      return false;
    }
  }
  return true;
}

/**
 * The carry-wire form of a published aim: what a transport stamps onto its next
 * gesture frame so every viewer re-derives this drag's preview. Null aim — no armed
 * target — sends no aim, which is itself the signal that drops peers' previews.
 */
export function wireCarryAim(aim: TileDropSignal["aim"]): CarryAim | undefined {
  if (aim === null) return undefined;
  return {
    containerId: aim.containerId,
    tileId: aim.tile.tileId,
    edge: aim.tile.edge,
    action: aim.tile.action,
    ...(aim.tile.between === true ? { between: true } : {}),
  };
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
