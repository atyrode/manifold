import type { CarryAim, PlacementDestination } from "@manifold/protocol";

import type { RemoteTileCarry } from "./carry.ts";
import { sameAim } from "./use-tile-drop.ts";

/**
 * The per-frame channel between a drag transport and a tile area's preview overlay.
 *
 * One store per host surface. Transports (an HTML5 `dragover`, a React Flow node drag)
 * write the pointer and — on a canvas — which widget the canvas has armed; the overlay
 * resolves the aim and publishes it back, so the transport can commit it at release AND
 * lift it onto the carry wire. That published aim is the SINGLE source of the wire aim
 * on both renderers: neither builds its own beside the one it paints.
 *
 * Consumed with `useSyncExternalStore` ONLY by the overlay: a pointer update repaints
 * the overlay alone and never re-renders the widget or its live terminals, which is what
 * allowed deleting the old node-data zone stamping (it remapped every projected node on
 * every zone change).
 */

/** What releasing right now would commit, and the bytes peers get for it. */
export interface TileDropAim {
  readonly destination: PlacementDestination;
  /** The resolved aim in wire form; `containerId` is part of it. */
  readonly tile: CarryAim;
}

/** No peer is aiming at anything here. Frozen: every empty state is the same value. */
const NO_REMOTE_CARRIES: ReadonlyMap<string, RemoteTileCarry> = new Map();

export interface TileDropSignal {
  readonly pointer: { readonly clientX: number; readonly clientY: number } | null;
  /** Canvas only: which widget the canvas armed. The route leaves it null. */
  readonly armedElementId: string | null;
  /** The overlay's answer: what releasing right now would commit. */
  readonly aim: TileDropAim | null;
  /**
   * PEER aims over this surface, keyed by the container each one addresses, freshest
   * per container. Written imperatively by the hosts feeding this store — the overlay
   * is the only subscriber, so a collaborator's 60 Hz drag never re-renders a tree or
   * its terminals. A canvas draws many widgets, which is why this is a map and not one
   * winner: a single slot let two peers aiming at two widgets mask each other.
   */
  readonly remote: ReadonlyMap<string, RemoteTileCarry>;
}

/**
 * The half a TRANSPORT writes. `remote` is not in it: peer aims arrive from N
 * independent feeds (a canvas's own room, plus every live widget's socket) and are
 * merged by {@link TileDropStore.setRemote}, so a transport spreading a stale snapshot
 * cannot clobber a feed it knows nothing about.
 */
export type TileDropIntent = Pick<TileDropSignal, "pointer" | "armedElementId" | "aim">;

export interface TileDropStore {
  get(): TileDropSignal;
  set(next: TileDropIntent): void;
  /**
   * Publishes one FEED's per-container peer aims. Feeds are additive and independent:
   * a canvas publishes what its own room hears, and each live widget publishes what its
   * container's room hears, which is how a route dragger's preview reaches the widget
   * viewers watching the same container. Freshest wins per container across feeds.
   * Publishing an empty map retires a feed (a widget unmounting).
   */
  setRemote(feedId: string, carries: ReadonlyMap<string, RemoteTileCarry>): void;
  subscribe(listener: () => void): () => void;
}

const IDLE_SIGNAL: TileDropSignal = {
  pointer: null,
  armedElementId: null,
  aim: null,
  remote: NO_REMOTE_CARRIES,
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

/**
 * Peer-aim equality, by WHO and by WHAT — never by the receipt timestamp. `updatedAt`
 * is `performance.now()` at receipt, so two frames from one peer flushed inside the
 * same sub-millisecond value (a resync burst, a batched socket read) used to compare
 * equal and the overlay skipped the repaint of a genuinely changed aim.
 */
function remoteCarriesEqual(
  a: ReadonlyMap<string, RemoteTileCarry>,
  b: ReadonlyMap<string, RemoteTileCarry>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [containerId, carry] of a) {
    const other = b.get(containerId);
    if (other === undefined) return false;
    if (other.connId !== carry.connId) return false;
    if (!sameAim(other.aim, carry.aim)) return false;
  }
  return true;
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
    if (!destinationsEqual(a.aim.destination, b.aim.destination)) return false;
    if (!sameAim(a.aim.tile, b.aim.tile)) return false;
  }
  return remoteCarriesEqual(a.remote, b.remote);
}

export function createTileDropStore(): TileDropStore {
  let signal = IDLE_SIGNAL;
  /** One entry per feed; the published `remote` is their freshest-per-container merge. */
  const feeds = new Map<string, ReadonlyMap<string, RemoteTileCarry>>();
  const listeners = new Set<() => void>();
  const publish = (next: TileDropSignal): void => {
    if (tileDropSignalsEqual(signal, next)) return;
    signal = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => signal,
    set: (next) =>
      publish({
        pointer: next.pointer,
        armedElementId: next.armedElementId,
        aim: next.aim,
        remote: signal.remote,
      }),
    setRemote: (feedId, carries) => {
      // Every feed republishes on each animation frame while any gesture eases, and
      // almost nobody is ever aiming: an empty publish against an already-absent feed
      // is the steady state and must cost nothing.
      if (carries.size === 0 && !feeds.delete(feedId)) return;
      if (carries.size > 0) feeds.set(feedId, carries);
      const merged = new Map<string, RemoteTileCarry>();
      for (const feed of feeds.values()) {
        for (const [containerId, carry] of feed) {
          const held = merged.get(containerId);
          if (held !== undefined && carry.updatedAt <= held.updatedAt) continue;
          merged.set(containerId, carry);
        }
      }
      publish({ ...signal, remote: merged.size === 0 ? NO_REMOTE_CARRIES : merged });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
