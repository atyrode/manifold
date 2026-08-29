import type { Carry, Gesture, PlacementSurface } from "@manifold/protocol";
import { envelopeSurface, type ItemEnvelope } from "./item-envelope.ts";
import type { GestureOverride } from "./remote-gestures.ts";

/**
 * The dynamic half of the placement algebra, as pure functions.
 *
 * Grabbing anything by its chrome is ONE carry: the source container mutates live, the
 * carried representation renders under the cursor, and the gesture streams to
 * collaborators over the room's existing gesture channel. This module owns the two
 * translations that would otherwise be re-invented per renderer and per element type —
 * a local grab into a wire frame, and a peer's frames into the ghosts a renderer paints.
 *
 * Everything here is coordinate-space agnostic. A canvas streams flow coordinates and a
 * composition streams tile-area fractions, exactly as each already does for cursors; a
 * carry frame is read back in the space it was written in, so neither renderer has to
 * know the other exists.
 */

/** Where a carried representation renders, in the room's own coordinate space. */
export interface CarryPoint {
  readonly x: number;
  readonly y: number;
  /** The source box, when the carried object still has one here (a canvas element). */
  readonly width?: number;
  readonly height?: number;
}

/** One live grab: what is held, what to call it, and the placement id it streams under. */
export interface CarrySource {
  /**
   * The gesture's key. It is the carried object's PLACEMENT id wherever it has one, so
   * a viewer's override lands on the very thing being moved — which is what makes the
   * source container mutate live rather than needing a second gesture beside the carry.
   */
  readonly id: string;
  readonly envelope: ItemEnvelope;
  readonly label: string | null;
}

/**
 * The placement id an envelope carries under, or null when the item is unplaced (a
 * pooled terminal) or named by identity alone (a container dragged from the sidebar).
 * A null gets a synthetic id from the caller: a carry always has a key, because a
 * carry with no key could not be ended.
 */
export function carryPlacementId(envelope: ItemEnvelope): string | null {
  switch (envelope.kind) {
    case "element":
      return envelope.elementId;
    case "tile":
      return envelope.tileId;
    case "terminal":
    case "canvas":
    case "composition":
      return null;
    default: {
      const exhaustive: never = envelope;
      return exhaustive;
    }
  }
}

/** The wire payload of one grab. */
export function carryPayload(source: CarrySource): Carry {
  const surface = envelopeSurface(source.envelope);
  return source.label === null ? { surface } : { surface, label: source.label };
}

/**
 * One frame. Geometry says where the carried representation is right now: for an object
 * still drawn in its source container that is the object's own live box, so the frame
 * doubles as the move it used to send; for everything else it is the pointer, which is
 * where the ghost belongs.
 */
export function carryFrame(source: CarrySource, at: CarryPoint, phase: Gesture["phase"]): Gesture {
  return {
    kind: "carry",
    phase,
    elementId: source.id,
    x: at.x,
    y: at.y,
    ...(at.width === undefined ? {} : { width: at.width }),
    ...(at.height === undefined ? {} : { height: at.height }),
    carry: carryPayload(source),
  };
}

/**
 * Fallback names for a carry whose sender sent none. The MARK a ghost wears is not here:
 * a renderer looks it up from the surface kind (`SurfaceIcon`), so the object's picture
 * comes from the one icon vocabulary instead of travelling as a glyph over the wire.
 */
const SURFACE_NAMES: Record<PlacementSurface["kind"], string> = {
  terminal: "terminal",
  pad: "view",
  tile: "tile",
  element: "item",
};

/** What a collaborator paints under a carrier's pointer. */
export interface CarryGhost {
  readonly key: string;
  readonly principalId: string;
  readonly kind: PlacementSurface["kind"];
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The ghosts one renderer owes its viewers, out of the same override map that drives
 * remote geometry. `rendersSurface` is the renderer's single question: does this room
 * already draw the carried object? When it does, the override IS the representation —
 * the element moves under the peer's pointer — and a second chip on top of it would be
 * the same object drawn twice. When it does not (a pooled terminal, a tile lifted off a
 * widget, a container dragged in from the sidebar), the ghost is the only thing there is.
 */
export function carryGhosts(
  overrides: Iterable<GestureOverride>,
  rendersSurface: (surface: PlacementSurface, override: GestureOverride) => boolean,
): readonly CarryGhost[] {
  const ghosts: CarryGhost[] = [];
  for (const override of overrides) {
    const carry = override.carry;
    if (override.kind !== "carry" || carry === undefined) continue;
    if (rendersSurface(carry.surface, override)) continue;
    ghosts.push({
      key: `${override.connId}:${override.elementId}`,
      principalId: override.principalId,
      kind: carry.surface.kind,
      label: carry.label ?? SURFACE_NAMES[carry.surface.kind],
      x: override.current.x,
      y: override.current.y,
    });
  }
  return ghosts;
}
