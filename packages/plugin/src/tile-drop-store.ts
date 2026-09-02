import type { CarryAim, PlacementDestination } from "@manifold/protocol";

import type { RemoteTileCarry } from "./carry.ts";
import { AIM_TTL_MS } from "./presence/index.ts";
import { sameAim } from "./use-tile-drop.ts";

/**
 * The per-frame channel between a drag transport and a tile area's preview overlay.
 *
 * One store per host ref. Transports (an HTML5 `dragover`, a React Flow node drag)
 * write the pointer and — on a canvas — which portal the canvas has armed; the overlay
 * resolves the aim and publishes it back, so the transport can commit it at release AND
 * lift it onto the carry wire. That published aim is the SINGLE source of the wire aim
 * on both renderers: neither builds its own beside the one it paints.
 *
 * Consumed with `useSyncExternalStore` ONLY by the overlay: a pointer update repaints
 * the overlay alone and never re-renders the portal or its live terminals, which is what
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
  /** Canvas only: which portal the canvas armed. The route leaves it null. */
  readonly armedElementId: string | null;
  /** The overlay's answer: what releasing right now would commit. */
  readonly aim: TileDropAim | null;
  /**
   * PEER aims over this ref, keyed by the container each one addresses, freshest
   * per container. Written imperatively by the hosts feeding this store — the overlay
   * is the only subscriber, so a collaborator's 60 Hz drag never re-renders a tree or
   * its terminals. A canvas draws many portals, which is why this is a map and not one
   * winner: a single slot let two peers aiming at two portals mask each other.
   */
  readonly remote: ReadonlyMap<string, RemoteTileCarry>;
}

/**
 * The half a TRANSPORT writes. `remote` is not in it: peer aims arrive from N
 * independent feeds (a canvas's own room, plus every live portal's socket) and are
 * merged by {@link TileDropStore.setRemote}, so a transport spreading a stale snapshot
 * cannot clobber a feed it knows nothing about.
 */
export type TileDropIntent = Pick<TileDropSignal, "pointer" | "armedElementId" | "aim">;

export interface TileDropStore {
  get(): TileDropSignal;
  set(next: TileDropIntent): void;
  /**
   * How long the pointer a transport last wrote stays believable, in ms — negative once
   * it is stale, null when there is no pointer at all. The STORE answers this rather than
   * its reader because the store is what stamped the pointer: one owner of the clock, and
   * a render-phase consumer that reads a value instead of taking a reading.
   *
   * `AIM_TTL_MS` is the bound, and it is the same one for local and remote input alike —
   * it is already how long a PEER's aim survives with no frame behind it
   * (`expireGestures`), and a producer that believed its own pointer longer than its
   * viewers believe the aim built from it would be exactly the divergence invariant 11
   * forbids: the dragger keeps a preview, and the FLIP transforms that ride it, while
   * every collaborator's has already cleared.
   *
   * It is also the backstop the route never had. Three paths clear the pointer (the
   * window `dragend`, `dragleave`, `drop`) and they are adequate; none is a guarantee,
   * and a pointer left behind by a missed clear used to keep an overlay armed
   * INDEFINITELY — holding transforms on real panes for a gesture that had ended.
   *
   * The stamp behind it is deliberately NOT a field of the signal: it moves on every
   * frame while the coordinates frequently do not, so putting it in the snapshot would
   * either churn value equality (a re-render per frame in the drag hot path, the loop
   * hazard that equality exists to close) or freeze whenever a frame repeated a
   * coordinate — and a stationary pointer under a live drag is exactly that frame.
   *
   * Answers the remainder rather than a boolean because the overlay needs both halves: it
   * gates arming on the sign and schedules its own wake-up from the magnitude.
   */
  pointerFreshness(): number | null;
  /**
   * Publishes one FEED's per-container peer aims. Feeds are additive and independent:
   * a canvas publishes what its own room hears, and each live portal publishes what its
   * container's room hears, which is how a route dragger's preview reaches the portal
   * viewers watching the same container. Freshest wins per container across feeds.
   * Publishing an empty map retires a feed (a portal unmounting).
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
      return b.kind === "canvas" && a.containerId === b.containerId && a.x === b.x && a.y === b.y;
    case "tile":
      return (
        b.kind === "tile" &&
        a.containerId === b.containerId &&
        a.targetTileId === b.targetTileId &&
        a.edge === b.edge &&
        (a.between === true) === (b.between === true)
      );
    case "compose":
      return (
        b.kind === "compose" &&
        a.containerId === b.containerId &&
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

/**
 * `now` is a seam, not a parameter anybody passes in production: `useState(createTileDropStore)`
 * calls this with no arguments, and a unit test drives the staleness backstop with a clock
 * it controls instead of sleeping.
 */
export function createTileDropStore(now: () => number = () => performance.now()): TileDropStore {
  let signal = IDLE_SIGNAL;
  /** See {@link TileDropStore.pointerAt}: refreshed on every write, snapshot-free. */
  let pointerAt: number | null = null;
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
    pointerFreshness: () => (pointerAt === null ? null : AIM_TTL_MS - (now() - pointerAt)),
    set: (next) => {
      // Stamped before the equality gate, so a frame that merely repeats a coordinate —
      // a stationary pointer under a live drag — still says the gesture is alive.
      pointerAt = next.pointer === null ? null : now();
      publish({
        pointer: next.pointer,
        armedElementId: next.armedElementId,
        aim: next.aim,
        remote: signal.remote,
      });
    },
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
