import {
  ROOT_TILE_ID,
  type PlacementDestination,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";

import { snapZone } from "./tile-snap.ts";

/**
 * Leaf-addressed drop geometry for tiled containers, DOM-free and in UNIT SPACE:
 * every rectangle and point is a fraction 0..1 of the tile area, so the same numbers
 * hold at any canvas zoom and under a widget's `transform: scale()`.
 *
 * This module answers WHERE a pointer aims inside a tile tree — any leaf, at any
 * depth, plus the area's own border ring for root-level splits — and WHAT the panes
 * would do about it (`paneShifts`), which is what the live preview animates. It is
 * deliberately separate from `tile-snap.ts`: that module keeps serving the canvas
 * door, whose center semantics (dissolve-to-nearest-edge for a seatless carry) are
 * now WRONG for tile targets, where five zones are always live.
 */

/** A rectangle in unit space: fractions of the tile area. */
export interface UnitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A pointer position in the same unit space. */
export interface UnitPoint {
  readonly x: number;
  readonly y: number;
}

/** Constant on-screen ring thickness, in device px, converted to a fraction by the caller. */
export const ROOT_RING_PX = 20;

/** The ring never eats more than this fraction of an axis (small widgets stay targetable). */
export const RING_AXIS_CAP = 0.15;

/**
 * The ring never eats more than this fraction of the smallest leaf touching that border.
 * 0.2 < `SNAP_EDGE_BAND` (0.25), which is what PROVES the ring can only ever consume
 * edge-band area and never a leaf's center — the 5-zones-always-live guarantee.
 */
export const RING_LEAF_CAP = 0.2;

/**
 * Every tile's rectangle, splits included — a split's union rect is what makes an
 * ancestor addressable at all. `dividers` is one divider's thickness as a fraction of
 * the AREA, per axis, so nested splits lose the same absolute thickness per divider.
 */
export function tileRects(
  layout: TileLayout,
  dividers: { readonly x: number; readonly y: number },
): ReadonlyMap<string, UnitRect> {
  const rects = new Map<string, UnitRect>();
  const walk = (tileId: string, rect: UnitRect): void => {
    const node = layout[tileId];
    if (node === undefined) return;
    rects.set(tileId, rect);
    if (node.dir === null) return;
    const row = node.dir === "row";
    const axis = row ? rect.width : rect.height;
    const divider = row ? dividers.x : dividers.y;
    const free = Math.max(0, axis - divider * (node.children.length - 1));
    let total = 0;
    for (const ratio of node.ratios) total += Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
    let cursor = row ? rect.x : rect.y;
    node.children.forEach((childId, index) => {
      const ratio = node.ratios[index] ?? 0;
      const share =
        total > 0
          ? (free * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0)) / total
          : free / node.children.length;
      walk(
        childId,
        row
          ? { x: cursor, y: rect.y, width: share, height: rect.height }
          : { x: rect.x, y: cursor, width: rect.width, height: share },
      );
      cursor += share + divider;
    });
  };
  walk(ROOT_TILE_ID, { x: 0, y: 0, width: 1, height: 1 });
  return rects;
}

function contains(rect: UnitRect, point: UnitPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Root -> leaf chain of tile ids containing the point; `[]` when the point is outside
 * the area. A point on a divider ends the chain at the split holding that divider.
 */
export function tileChainAt(
  layout: TileLayout,
  rects: ReadonlyMap<string, UnitRect>,
  point: UnitPoint,
): readonly string[] {
  const root = rects.get(ROOT_TILE_ID);
  if (root === undefined || !contains(root, point)) return [];
  const chain: string[] = [];
  let tileId: string | undefined = ROOT_TILE_ID;
  while (tileId !== undefined) {
    chain.push(tileId);
    const node: TileNode | undefined = layout[tileId];
    if (node === undefined || node.dir === null) break;
    tileId = node.children.find((childId) => {
      const rect = rects.get(childId);
      return rect !== undefined && contains(rect, point);
    });
  }
  return chain;
}

/** The ring's usable thickness on one border, all caps applied. */
export function ringFraction(pxRingAsFraction: number, minTouchingLeafFraction: number): number {
  return Math.min(pxRingAsFraction, RING_AXIS_CAP, RING_LEAF_CAP * minTouchingLeafFraction);
}

/** What releasing on a resolved tile aim will DO; center on an occupied leaf trades or evicts. */
export type TileAction = "place" | "swap" | "replace";

/** A resolved tile drop: which tile, which zone, what releasing there means. */
export interface TileAim {
  readonly tileId: string;
  readonly edge: TileEdge;
  readonly action: TileAction;
  /** Tree depth of the aimed tile; 0 is the root. */
  readonly depth: number;
}

/** What the carry can offer, answered by the caller — this module never sees a document. */
export interface TileAimCarry {
  /** The leaf this carry currently occupies, when it is a tile carry of THIS container; else null. */
  readonly carriedTileId: string | null;
  /** True when the carry holds a tile seat (envelope kind === "tile"), i.e. it can trade. */
  readonly holdsTileSeat: boolean;
}

/** The smallest extent of any leaf touching one border of the unit square, else 1. */
function minTouchingLeaf(
  layout: TileLayout,
  rects: ReadonlyMap<string, UnitRect>,
  edge: TileEdge,
): number {
  let min = 1;
  for (const [tileId, rect] of rects) {
    const node = layout[tileId];
    if (node === undefined || node.dir !== null) continue;
    const touches =
      edge === "left"
        ? rect.x <= 0
        : edge === "right"
          ? rect.x + rect.width >= 1
          : edge === "top"
            ? rect.y <= 0
            : rect.y + rect.height >= 1;
    if (!touches) continue;
    const extent = edge === "left" || edge === "right" ? rect.width : rect.height;
    if (extent < min) min = extent;
  }
  return min;
}

/**
 * The tile a pointer aims at, or null when the release would mean nothing: outside the
 * area, on a divider, or anywhere over the carry's own leaf (the server treats
 * leaf-onto-itself as a no-op, and null is how the client never previews or commits it).
 *
 * The border ring targets the ROOT and only the root. Ancestors are targetable only
 * along a border they share with the tile area itself, which collapses escalation to
 * exactly one level: any deeper ancestor's ring would be geometrically coincident with a
 * descendant's ring (in `A | (B/C)` the column split's left border IS C's left border),
 * and coincident rings make targeting unpredictable. A solo container has no ring —
 * its one leaf's own bands already reach every border.
 */
export function resolveTileAim(
  layout: TileLayout,
  point: UnitPoint,
  carry: TileAimCarry,
  dividers: { readonly x: number; readonly y: number },
  ring: { readonly x: number; readonly y: number },
): TileAim | null {
  const rects = tileRects(layout, dividers);
  const chain = tileChainAt(layout, rects, point);
  if (chain.length === 0) return null;

  const root = layout[ROOT_TILE_ID];
  if (root !== undefined && root.dir !== null) {
    // Normalised penetration into each border's ring; the deepest wins a corner.
    const rings = {
      left: ringFraction(ring.x, minTouchingLeaf(layout, rects, "left")),
      right: ringFraction(ring.x, minTouchingLeaf(layout, rects, "right")),
      top: ringFraction(ring.y, minTouchingLeaf(layout, rects, "top")),
      bottom: ringFraction(ring.y, minTouchingLeaf(layout, rects, "bottom")),
    };
    const depths: readonly (readonly [TileEdge, number])[] = [
      ["left", rings.left > 0 ? 1 - point.x / rings.left : 0],
      ["right", rings.right > 0 ? 1 - (1 - point.x) / rings.right : 0],
      ["top", rings.top > 0 ? 1 - point.y / rings.top : 0],
      ["bottom", rings.bottom > 0 ? 1 - (1 - point.y) / rings.bottom : 0],
    ];
    let ringEdge: TileEdge | null = null;
    let deepest = 0;
    for (const [edge, depth] of depths) {
      if (depth > deepest) {
        deepest = depth;
        ringEdge = edge;
      }
    }
    if (ringEdge !== null) {
      return { tileId: ROOT_TILE_ID, edge: ringEdge, action: "place", depth: 0 };
    }
  }

  const leafId = chain[chain.length - 1] ?? ROOT_TILE_ID;
  const node = layout[leafId];
  // A chain ending on a split means the pointer sits on a divider: no zone there.
  if (node === undefined || node.dir !== null) return null;
  if (carry.carriedTileId === leafId) return null;
  const rect = rects.get(leafId);
  if (rect === undefined) return null;
  const zone = snapZone(rect, point);
  if (zone === null) return null;
  const depth = chain.length - 1;
  if (zone !== "center") return { tileId: leafId, edge: zone, action: "place", depth };
  // Center never dissolves on a tile target: five zones are always live here.
  if (node.surface === null) return { tileId: leafId, edge: "center", action: "place", depth };
  return {
    tileId: leafId,
    edge: "center",
    action: carry.holdsTileSeat ? "swap" : "replace",
    depth,
  };
}

/**
 * A pane's identity is what it SHOWS, never its tile id: splitting the root reassigns
 * the old root content to a fresh id, and pruning can promote a survivor into its
 * parent's id, so an id-matched diff would report spurious unmounts for panes that
 * visibly must move. Empty leaves have no identity to follow. Exported because the
 * tree's content portals key pane CONTENT by the same identity (`tile-tree.tsx`).
 */
export function surfaceKey(surface: TileSurface | null): string | null {
  if (surface === null) return null;
  switch (surface.kind) {
    case "terminal":
      return `terminal:${surface.sessionId}`;
    case "pad":
      return `pad:${surface.padId}`;
    case "text":
      return `text:${surface.elementId}`;
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/** One pane's travel between the live layout and a prospective one. */
export interface PaneShift {
  /** The pane's tile id in the PROSPECTIVE layout. */
  readonly tileId: string;
  /** The same pane's tile id in the CURRENT layout — what the DOM is keyed by. */
  readonly fromTileId: string;
  readonly from: UnitRect;
  readonly to: UnitRect;
}

const SHIFT_EPSILON = 1e-6;

function sameRect(a: UnitRect, b: UnitRect): boolean {
  return (
    Math.abs(a.x - b.x) < SHIFT_EPSILON &&
    Math.abs(a.y - b.y) < SHIFT_EPSILON &&
    Math.abs(a.width - b.width) < SHIFT_EPSILON &&
    Math.abs(a.height - b.height) < SHIFT_EPSILON
  );
}

/**
 * Where every occupied pane of `current` would sit under `next`, for the panes whose
 * rectangle actually changes. Matched by surface identity (see `surfaceKey`); a pane
 * with no counterpart — the carried surface entering, an occupant leaving — is simply
 * not a shift, because there is nothing on screen to glide.
 */
export function paneShifts(
  current: TileLayout,
  next: TileLayout,
  dividers: { readonly x: number; readonly y: number },
): readonly PaneShift[] {
  const currentRects = tileRects(current, dividers);
  const nextRects = tileRects(next, dividers);
  const seats = new Map<string, { readonly tileId: string; readonly rect: UnitRect }>();
  for (const [tileId, rect] of currentRects) {
    const node = current[tileId];
    if (node === undefined || node.dir !== null) continue;
    const key = surfaceKey(node.surface);
    if (key !== null) seats.set(key, { tileId, rect });
  }
  const shifts: PaneShift[] = [];
  for (const [tileId, rect] of nextRects) {
    const node = next[tileId];
    if (node === undefined || node.dir !== null) continue;
    const key = surfaceKey(node.surface);
    if (key === null) continue;
    const seat = seats.get(key);
    if (seat === undefined || sameRect(seat.rect, rect)) continue;
    shifts.push({ tileId, fromTileId: seat.tileId, from: seat.rect, to: rect });
  }
  return shifts;
}

/**
 * The wire destination one resolved aim means for one host container.
 *
 * A multi-tile container is a tile destination naming THE LEAF THE POINTER IS OVER;
 * `targetTileId` is never null. A SOLO container on a canvas keeps the canvas
 * `compose` door — preserving the ratified "A + B" birth, home absorption and
 * in-place portal repointing — while a solo container on the fullscreen route has no
 * element to compose onto and addresses its own root leaf directly.
 */
export function tileDestinationFor(
  aim: TileAim,
  host: {
    readonly containerId: string;
    readonly widget: { readonly padId: string; readonly elementId: string } | null;
    readonly rootIsLeaf: boolean;
  },
): PlacementDestination {
  if (host.rootIsLeaf && host.widget !== null) {
    return {
      kind: "compose",
      padId: host.widget.padId,
      targetElementId: host.widget.elementId,
      edge: aim.edge,
    };
  }
  return { kind: "tile", padId: host.containerId, targetTileId: aim.tileId, edge: aim.edge };
}
