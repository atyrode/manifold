import {
  ROOT_TILE_ID,
  type PlacementDestination,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";

import { sameSurface, withTileSlot, withoutTileLeaf } from "@manifold/scene";
import { SNAP_EDGE_BAND, snapZone } from "./tile-snap.ts";

/**
 * Leaf-addressed drop geometry for tiled containers, DOM-free and in UNIT SPACE:
 * every rectangle and point is a fraction 0..1 of the tile area, so the same numbers
 * hold at any canvas zoom and under a widget's `transform: scale()`.
 *
 * This module answers WHERE a pointer aims inside a tile tree — any leaf at any depth,
 * every SEAM between adjacent siblings at any depth, and the area's own border ring —
 * and WHAT the panes would do about it (`paneShifts`), which is what the live preview
 * animates. It is deliberately separate from `tile-snap.ts`: that module keeps serving
 * the canvas door, whose center semantics (dissolve-to-nearest-edge for a seatless
 * carry) are now WRONG for tile targets, where five zones are always live.
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
 * Slack for every float comparison in this module. `tileRects` builds a split's
 * trailing edge by ACCUMULATION (`cursor += share + divider`), so the last child's far
 * edge lands at `1 ± ~1e-16` depending on the divider and the ratios — one realistic
 * geometry in three. Border contact and rect equality are therefore both epsilon
 * questions; an exact compare silently drops `RING_LEAF_CAP` on the right and bottom
 * borders (the 5-zones-always-live proof) for some window widths and not others, which
 * would also make the zone field differ between two viewers of the same tree.
 */
const SHIFT_EPSILON = 1e-6;

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
  /**
   * Same-axis seam-band aim: the newcomer wedges BETWEEN the target and its
   * neighbor (both cede a third) instead of splitting the target's own share.
   */
  readonly between?: boolean;
}

/** What the carry can offer, answered by the caller — this module never sees a document. */
export interface TileAimCarry {
  /** The leaf this carry currently occupies, when it is a tile carry of THIS container; else null. */
  readonly carriedTileId: string | null;
  /** True when the carry holds a tile seat (envelope kind === "tile"), i.e. it can trade. */
  readonly holdsTileSeat: boolean;
}

/**
 * The smallest extent of any leaf touching one border of the unit square, else 1.
 * Contact is an EPSILON question, never an exact one: see `SHIFT_EPSILON`.
 */
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
        ? rect.x <= SHIFT_EPSILON
        : edge === "right"
          ? rect.x + rect.width >= 1 - SHIFT_EPSILON
          : edge === "top"
            ? rect.y <= SHIFT_EPSILON
            : rect.y + rect.height >= 1 - SHIFT_EPSILON;
    if (!touches) continue;
    const extent = edge === "left" || edge === "right" ? rect.width : rect.height;
    if (extent < min) min = extent;
  }
  return min;
}

/** How far past a held zone's boundary the pointer must travel before the aim flips. */
export const ZONE_HYSTERESIS = 0.06;

/**
 * One boundary's hysteresis margin, BOUNDED BY HALF THE BAND IT MODULATES, so a held
 * aim can only ever move that boundary within [0.5, 1.5] × the band's nominal width.
 *
 * The bound is load-bearing wherever the band is derived from device px while the
 * margin is an area fraction. `ZONE_HYSTERESIS` (0.06 of a leaf) is fine against the
 * leaf's own `SNAP_EDGE_BAND` (0.25 of the same leaf) — same units, ~24 % — but it
 * DWARFS the seam band and the ring, which are ~10–20 px converted to a fraction
 * (0.006..0.04 per axis). Unbounded, those bands vanished entirely whenever anything
 * else was held — so a pointer approaching from a flank, which is exactly the state
 * "something else is held", could never enter the zone at all — and inflated ~6× once
 * held, making it violently sticky on the way out. Both directions were wrong.
 */
function heldMargin(nominal: number, wanted: number): number {
  return Math.min(wanted, 0.5 * nominal);
}

/**
 * The aim a preview is already painting, handed back so the resolver can bias every
 * boundary toward it. Structurally what `resolveTileAim` returns, minus the derived
 * fields, so a caller can simply pass its last answer.
 */
interface HeldAim {
  readonly tileId: string;
  readonly edge: TileEdge;
  readonly between?: boolean;
}

/** Is the point still inside `edge`'s zone of `rect`, grown by the hysteresis margin? */
function withinHeldZone(rect: UnitRect, point: UnitPoint, edge: TileEdge): boolean {
  const dx = point.x - rect.x;
  const dy = point.y - rect.y;
  const bandX = (SNAP_EDGE_BAND + ZONE_HYSTERESIS) * rect.width;
  const bandY = (SNAP_EDGE_BAND + ZONE_HYSTERESIS) * rect.height;
  switch (edge) {
    case "left":
      return dx < bandX;
    case "right":
      return dx > rect.width - bandX;
    case "top":
      return dy < bandY;
    case "bottom":
      return dy > rect.height - bandY;
    case "center": {
      const innerX = (SNAP_EDGE_BAND - ZONE_HYSTERESIS) * rect.width;
      const innerY = (SNAP_EDGE_BAND - ZONE_HYSTERESIS) * rect.height;
      return dx > innerX && dx < rect.width - innerX && dy > innerY && dy < rect.height - innerY;
    }
    default: {
      const exhaustive: never = edge;
      return exhaustive;
    }
  }
}

/*
  SEAMS ARE ONE OBJECT.

  A seam is the boundary between two adjacent children of a split, materialised as a
  BAND: the divider gap plus a strip `seamHalf` deep into each neighbour. Inside that
  band the answer is a pure function of position ALONG the seam and never of how far
  ACROSS it the pointer sits. That invariance is the whole point. dev.16 resolved the
  gap column and the flank strips in two different functions that disagreed: the gap
  subdivided along the seam (outer stretches split the group, the middle wedges
  between) while the flanks only measured distance across it — so at one height a
  single seam answered `t1/right/between` on its left flank, `root/bottom` in its gap
  and `t2/left/between` on its right flank. Two of those are the SAME insert addressed
  two ways and the third interleaves with them. One band, one function, one answer.

  ANCESTOR SEAMS COUNT. A flank pixel beside a grandparent's boundary belongs to that
  grandparent's seam exactly as its gap column does, so in `A | (B/C)` a pointer inside
  B can still address the root seam. Otherwise an ancestor's structural split would be
  reachable from its two-pixel gap and nowhere else.

  The MIDDLE stretch means "wedge in between these two", CANONICALLY addressed as the
  LEADING child's trailing edge: `insertLeaf`'s same-axis branch turns that into a flat
  sibling exactly where the pointer is, and naming it exactly one way is what kills the
  dual addressing. A neighbour dropped on its own seam would be a no-op, so it aims at
  nothing — never previewed, never committed. The outer ENDS mean "split the GROUP this
  seam belongs to, across": the seam is the one piece of geometry that unambiguously
  belongs to the split itself — a group's outer border is always coincident with its
  members' edge bands, but its seam is flanked by leaf centres — so pulling toward a
  seam's end is how an inner split like `(C | D)` in `A | (B / (C | D))` grows `E`
  across its whole width: `B / (C | D) / E`.

  HYSTERESIS runs on both axes of the band, always biased toward the aim already being
  painted. ACROSS: when the held aim names THIS seam the membership threshold grows by
  the margin; when it names anything else it shrinks by the same margin, so a flip must
  be earned in either direction. The margin is `ZONE_HYSTERESIS` of the point-side
  child's extent BOUNDED BY HALF THE BAND (`heldMargin`) — unbounded it is many times
  the px-derived band, which made the seam unreachable by approach from a flank and
  ~6× sticky once held. ALONG: a held middle pulls both end stretches in by
  `ZONE_HYSTERESIS`, and a held end pushes that one end out by it; those boundaries cut
  at `SNAP_EDGE_BAND` of the same extent the margin is a fraction of, so they need no
  bound. Competing seams are ranked by PENETRATION rather than by raw distance, so the
  widened threshold also wins the held seam a contested pixel.
*/

/** Which meaning of one seam a held aim names. */
type SeamHeld = "middle" | "low-end" | "high-end";

/** One seam the pointer sits in the band of, and how deeply. */
interface Seam {
  readonly split: TileNode;
  /** The split's own depth in the chain: what its structural end aims address. */
  readonly depth: number;
  /** Index of the leading child, so ties resolve to the leading boundary. */
  readonly index: number;
  readonly previousChildId: string;
  readonly nextChildId: string;
  /** 1 anywhere in the divider gap, 0 at the band's outer lip. */
  readonly score: number;
  readonly held: SeamHeld | null;
}

/**
 * Half-thickness of the seam band inside one flank, in unit space, so the band's total
 * on-screen thickness tracks the ring's (`ROOT_RING_PX`) and stays constant at any
 * zoom. Capped at half the snap band so a flank always keeps an outer stretch that
 * means "split this pane".
 */
function seamHalf(ringAxis: number, childExtent: number): number {
  return Math.min(ringAxis / 2, 0.5 * SNAP_EDGE_BAND * childExtent);
}

/** Which meaning of this seam the held aim names — the bias every boundary takes. */
function seamHeld(held: HeldAim | null, split: TileNode, previousChildId: string): SeamHeld | null {
  if (held === null) return null;
  const row = split.dir === "row";
  // A middle aim IS the leading child's trailing edge, so it names this seam exactly.
  if (held.between === true && held.tileId === previousChildId) return "middle";
  if (held.tileId !== split.id) return null;
  if (held.edge === (row ? "top" : "left")) return "low-end";
  if (held.edge === (row ? "bottom" : "right")) return "high-end";
  return null;
}

/**
 * The seam between children `index` and `index + 1` of `split`, when the pointer is a
 * member of its band. `pointSideExtent` is the extent of the child the pointer is
 * inside — what the band's depth is measured against — and is null when the pointer is
 * in the gap itself and has no side, where the narrower neighbour stands in.
 */
function seamAt(
  rects: ReadonlyMap<string, UnitRect>,
  split: TileNode,
  index: number,
  depth: number,
  point: UnitPoint,
  ring: { readonly x: number; readonly y: number },
  held: HeldAim | null,
  pointSideExtent: number | null,
): Seam | null {
  const previousChildId = split.children[index];
  const nextChildId = split.children[index + 1];
  if (previousChildId === undefined || nextChildId === undefined) return null;
  const previous = rects.get(previousChildId);
  const next = rects.get(nextChildId);
  if (previous === undefined || next === undefined) return null;

  const row = split.dir === "row";
  const p = row ? point.x : point.y;
  const gapStart = row ? previous.x + previous.width : previous.y + previous.height;
  const gapEnd = row ? next.x : next.y;
  // Distance ACROSS the seam, zero everywhere inside the divider gap.
  const distance = p < gapStart ? gapStart - p : p > gapEnd ? p - gapEnd : 0;

  const extent =
    pointSideExtent ??
    Math.min(row ? previous.width : previous.height, row ? next.width : next.height);
  const meaning = seamHeld(held, split, previousChildId);
  const band = seamHalf(row ? ring.x : ring.y, extent);
  // Bounded, so band membership always lives in [0.5, 1.5] × the band at ANY scale.
  const margin = held === null ? 0 : heldMargin(band, ZONE_HYSTERESIS * (extent > 0 ? extent : 1));
  const threshold = meaning !== null ? band + margin : band - margin;
  if (distance > threshold) return null;
  return {
    split,
    depth,
    index,
    previousChildId,
    nextChildId,
    score: threshold > 0 ? 1 - distance / threshold : 1,
    held: meaning,
  };
}

/** Deepest penetration wins; a tie goes to the deeper split, then the leading boundary. */
function closerSeam(a: Seam | null, b: Seam | null): Seam | null {
  if (b === null) return a;
  if (a === null) return b;
  if (b.score !== a.score) return b.score > a.score ? b : a;
  if (b.depth !== a.depth) return b.depth > a.depth ? b : a;
  return b.index < a.index ? b : a;
}

/** The leading child of the gap a pointer stands in, when the chain ended on this split. */
function gapIndexAt(
  rects: ReadonlyMap<string, UnitRect>,
  split: TileNode,
  point: UnitPoint,
): number | null {
  const row = split.dir === "row";
  const p = row ? point.x : point.y;
  let leading: number | null = null;
  let trailing = false;
  for (let index = 0; index < split.children.length; index += 1) {
    const childId = split.children[index];
    const rect = childId === undefined ? undefined : rects.get(childId);
    if (rect === undefined) continue;
    const start = row ? rect.x : rect.y;
    if (p >= start + (row ? rect.width : rect.height)) leading = index;
    if (p <= start) trailing = true;
  }
  return leading !== null && trailing ? leading : null;
}

/**
 * The seam whose band the pointer sits deepest in, across the whole chain: every
 * ancestor split offers the boundaries adjacent to the child the pointer descended
 * into, and a chain that ENDS on a split offers the gap the pointer stands in.
 */
function bestSeamAt(
  layout: TileLayout,
  rects: ReadonlyMap<string, UnitRect>,
  chain: readonly string[],
  point: UnitPoint,
  ring: { readonly x: number; readonly y: number },
  held: HeldAim | null,
): Seam | null {
  let best: Seam | null = null;
  for (let depth = 0; depth < chain.length; depth += 1) {
    const tileId = chain[depth];
    const split = tileId === undefined ? undefined : layout[tileId];
    if (split === undefined || split.dir === null) continue;
    const descentId = chain[depth + 1];
    if (descentId === undefined) {
      const index = gapIndexAt(rects, split, point);
      if (index === null) continue;
      best = closerSeam(best, seamAt(rects, split, index, depth, point, ring, held, null));
      continue;
    }
    const descent = rects.get(descentId);
    if (descent === undefined) continue;
    const at = split.children.indexOf(descentId);
    if (at < 0) continue;
    const extent = split.dir === "row" ? descent.width : descent.height;
    // The two boundaries the descent child touches: its leading one, then its trailing.
    best = closerSeam(best, seamAt(rects, split, at - 1, depth, point, ring, held, extent));
    best = closerSeam(best, seamAt(rects, split, at, depth, point, ring, held, extent));
  }
  return best;
}

/**
 * What releasing on one seam means — the ONLY seam logic there is, so a gap pixel and a
 * flank pixel at the same height can never answer differently.
 */
function seamAim(
  rects: ReadonlyMap<string, UnitRect>,
  seam: Seam,
  point: UnitPoint,
  carry: TileAimCarry,
): TileAim | null {
  const row = seam.split.dir === "row";
  const carriesMember =
    carry.carriedTileId === seam.previousChildId || carry.carriedTileId === seam.nextChildId;
  /*
    A member of a TWO-child split cannot aim at that split, at either meaning of its
    seam. Its own departure collapses the split — `withoutTileLeaf` promotes the lone
    survivor into the parent — so the id a seam-end aim names does not exist in the
    pruned tree, `tileProspect` remaps nothing (a split has no surface to re-find) and
    answers null: a zone that looks live for every other carry, previews nothing and
    commits nothing. The middle refuses for the simpler reason below (a no-op), so the
    whole seam is nothing to a member of a pair.
  */
  if (carriesMember && seam.split.children.length === 2) return null;
  const own = rects.get(seam.split.id);
  if (own !== undefined) {
    // Position ALONG the seam, as a fraction of the split's perpendicular extent.
    const along = row
      ? (point.y - own.y) / (own.height > 0 ? own.height : 1)
      : (point.x - own.x) / (own.width > 0 ? own.width : 1);
    let low = SNAP_EDGE_BAND;
    let high = SNAP_EDGE_BAND;
    switch (seam.held) {
      case "middle":
        low -= ZONE_HYSTERESIS;
        high -= ZONE_HYSTERESIS;
        break;
      case "low-end":
        low += ZONE_HYSTERESIS;
        break;
      case "high-end":
        high += ZONE_HYSTERESIS;
        break;
      case null:
        break;
      default: {
        const exhaustive: never = seam.held;
        return exhaustive;
      }
    }
    if (along < low) {
      return {
        tileId: seam.split.id,
        edge: row ? "top" : "left",
        action: "place",
        depth: seam.depth,
      };
    }
    if (along > 1 - high) {
      return {
        tileId: seam.split.id,
        edge: row ? "bottom" : "right",
        action: "place",
        depth: seam.depth,
      };
    }
  }
  if (carriesMember) return null;
  return {
    tileId: seam.previousChildId,
    edge: row ? "right" : "bottom",
    action: "place",
    depth: seam.depth + 1,
    between: true,
  };
}

/**
 * The tile a pointer aims at, or null when the release would mean nothing: outside the
 * area, or over the carry's own leaf (the server treats leaf-onto-itself as a no-op,
 * and null is how the client never previews or commits it).
 *
 * Three doors, tried in this order. The border RING targets the ROOT and only the
 * root: ancestors are targetable only along a border they share with the tile area
 * itself, which collapses escalation to exactly one level, because any deeper
 * ancestor's ring would be geometrically coincident with a descendant's (in
 * `A | (B/C)` the column split's left border IS C's left border) and coincident rings
 * make targeting unpredictable. A solo container has no ring — its one leaf's own bands
 * already reach every border. Then SEAMS, one band per boundary at every depth, so a
 * divider gap and the flanks beside it answer the same single insert (see above).
 * Everything else is the LEAF's own five zones, where an edge means "split this pane"
 * and never `between`: the seam bands already claimed the strips where it would.
 *
 * CORNERS BELONG TO THE RING, deliberately. Because the ring answers first, a leaf
 * touching two borders has no corner band of ITS OWN inside the ring: in a 2×2 grid
 * every leaf's outer corner is the root's, and the two ring bands there are ranked by
 * normalised penetration with a fixed tie order (left, then right, then top, then
 * bottom, strict `>`), so every viewer resolves the same pixel the same way. It is a
 * precedence, not a loss: `RING_LEAF_CAP` keeps the ring strictly inside the leaf's
 * own edge band, so the leaf's four bands stay reachable one ring-width inward and its
 * center is never touched. What a corner costs is only the choice BETWEEN two of that
 * leaf's bands within the last ~20 px of the frame, where "split the whole area" is
 * the likelier intent anyway.
 */
export function resolveTileAim(
  layout: TileLayout,
  point: UnitPoint,
  carry: TileAimCarry,
  dividers: { readonly x: number; readonly y: number },
  ring: { readonly x: number; readonly y: number },
  held: HeldAim | null = null,
): TileAim | null {
  const rects = tileRects(layout, dividers);
  const chain = tileChainAt(layout, rects, point);
  if (chain.length === 0) return null;

  const root = layout[ROOT_TILE_ID];
  if (root !== undefined && root.dir !== null) {
    /*
      Normalised penetration into each border's ring; the deepest wins a corner. The
      ring/leaf-band frontier separates the two most different previews in the system —
      "split the entire area at this border", where every pane glides, from "split this
      one pane" — so it takes the same hysteresis every other boundary does, or a
      pointer resting a ring-width from a border flutters between them on sub-pixel
      jitter. A held ROOT edge grows its own band; a held anything-else shrinks all
      four, bounded (`heldMargin`) so the ring can never collapse and latch the way the
      seam band once did.
    */
    const bias = (nominal: number, edge: TileEdge): number => {
      if (held === null || nominal <= 0) return nominal;
      const margin = heldMargin(nominal, ZONE_HYSTERESIS);
      if (held.tileId !== ROOT_TILE_ID) return nominal - margin;
      return held.edge === edge ? nominal + margin : nominal;
    };
    const rings = {
      left: bias(ringFraction(ring.x, minTouchingLeaf(layout, rects, "left")), "left"),
      right: bias(ringFraction(ring.x, minTouchingLeaf(layout, rects, "right")), "right"),
      top: bias(ringFraction(ring.y, minTouchingLeaf(layout, rects, "top")), "top"),
      bottom: bias(ringFraction(ring.y, minTouchingLeaf(layout, rects, "bottom")), "bottom"),
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

  const seam = bestSeamAt(layout, rects, chain, point, ring, held);
  if (seam !== null) return seamAim(rects, seam, point, carry);

  const leafId = chain[chain.length - 1] ?? ROOT_TILE_ID;
  const node = layout[leafId];
  // A chain ending on a split means the pointer stands in a gap, which is a seam and
  // nothing else; no seam there (a degenerate rect) means the release means nothing.
  if (node === undefined || node.dir !== null) return null;
  if (carry.carriedTileId === leafId) return null;
  const rect = rects.get(leafId);
  if (rect === undefined) return null;
  let zone = snapZone(rect, point);
  if (zone === null) return null;
  /*
    HYSTERESIS: while the FLIP glides panes around, the ZONES stay put — but an eye
    following the moving pixels drifts, and a pointer sitting near a boundary would
    flutter between aims. So a zone, once held, keeps the aim until the pointer
    travels a real margin past its boundary. Every frontier in this function has one:
    the ring's above, the seams' in `seamAt`/`seamAim`, and a leaf's own five here.
  */
  if (held !== null && held.tileId === leafId && zone !== held.edge) {
    if (withinHeldZone(rect, point, held.edge)) zone = held.edge;
  }
  const depth = chain.length - 1;
  if (zone !== "center") {
    // Past the seam band, an edge is the pane's OWN split: it cedes half, nobody moves.
    return { tileId: leafId, edge: zone, action: "place", depth, between: false };
  }
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
 * tree's content portals key pane CONTENT by this same base — but a base is NOT a
 * pane: one surface may legally occupy several leaves, so both sides disambiguate the
 * repeats by ordinal (`paneIdentities` here, `seen` there).
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
    case "panel":
      return `panel:${surface.panelId}`;
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

function sameRect(a: UnitRect, b: UnitRect): boolean {
  return (
    Math.abs(a.x - b.x) < SHIFT_EPSILON &&
    Math.abs(a.y - b.y) < SHIFT_EPSILON &&
    Math.abs(a.width - b.width) < SHIFT_EPSILON &&
    Math.abs(a.height - b.height) < SHIFT_EPSILON
  );
}

/**
 * Every occupied leaf's pane identity, in the tree's own document order and ORDINALLY
 * disambiguated: `base`, then `base#1`, `base#2` for repeats of that base.
 *
 * Duplicates are legal — a second leaf for a terminal already living in this container
 * "is simply another copy of it", says the placement executor — so a bare `surfaceKey`
 * would collapse two panes onto one seat, and a diff would then point both prospective
 * leaves at one DOM box: two transforms written to it, last one winning, while the
 * other pane never moves at all.
 *
 * The walk and the `base` / `base#N` spelling are `tile-tree.tsx`'s content-host keying
 * VERBATIM, and must stay so: the host that keying seats is the very box a shift moves,
 * so pairing panes by ordinal is pairing them the way the DOM already does.
 */
function paneIdentities(layout: TileLayout): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  const seen = new Map<string, number>();
  const walk = (tileId: string): void => {
    const node = layout[tileId];
    if (node === undefined) return;
    if (node.dir !== null) {
      for (const childId of node.children) walk(childId);
      return;
    }
    // An empty leaf has nothing on screen to glide, so it has no identity to follow.
    const base = surfaceKey(node.surface);
    if (base === null) return;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    identities.set(nth === 0 ? base : `${base}#${String(nth)}`, tileId);
  };
  walk(ROOT_TILE_ID);
  return identities;
}

/**
 * Where every occupied pane of `current` would sit under `next`, for the panes whose
 * rectangle actually changes. Matched by pane identity (see `paneIdentities`); a pane
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
  const seats = paneIdentities(current);
  const shifts: PaneShift[] = [];
  for (const [key, tileId] of paneIdentities(next)) {
    const fromTileId = seats.get(key);
    if (fromTileId === undefined) continue;
    const from = currentRects.get(fromTileId);
    const to = nextRects.get(tileId);
    if (from === undefined || to === undefined || sameRect(from, to)) continue;
    // A FLIP divides the travel by `from`'s extent, so a zero-extent `from` — dividers
    // thicker than the axis they subdivide — would emit `translate(NaN%) scale(NaN)`.
    // Nothing visible sits there to glide anyway: drop it rather than paint garbage.
    if (from.width < SHIFT_EPSILON || from.height < SHIFT_EPSILON) continue;
    shifts.push({ tileId, fromTileId, from, to });
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
  return {
    kind: "tile",
    padId: host.containerId,
    targetTileId: aim.tileId,
    edge: aim.edge,
    ...(aim.between === true ? { between: true } : {}),
  };
}

/** Everything a preview paints for one aim: the landing slot, a swap's partner, the glide. */
export interface TileProspect {
  readonly slot: UnitRect;
  /** The second rect a swap trades with, else null. */
  readonly partner: UnitRect | null;
  /** How the real panes glide and squeeze into their prospective places. */
  readonly shifts: readonly PaneShift[];
}

/**
 * The aimed tile after the carried leaf's departure reshaped the tree. Pruning can
 * retire the aimed id (a collapse promotes a survivor into its parent's — even the
 * root's — id), so the tile is re-found by WHAT IT SHOWS; null when it is gone.
 */
function remapAimedTile(
  layout: TileLayout,
  pruned: TileLayout,
  aimedTileId: string,
): string | null {
  if (pruned[aimedTileId] !== undefined) return aimedTileId;
  const aimed = layout[aimedTileId];
  if (aimed === undefined || aimed.dir !== null || aimed.surface === null) return null;
  for (const node of Object.values(pruned)) {
    if (node.dir !== null || node.surface === null) continue;
    if (sameSurface(node.surface, aimed.surface)) return node.id;
  }
  return null;
}

/**
 * The preview one aim means over one tree — THE computation behind every split
 * preview, whoever produced the aim. A local pointer and a collaborator's carry
 * frame (and an agent's, through the SDK) all resolve here, which is what makes
 * every renderer paint the same prospect: multiplayer is not a second code path.
 *
 * A carry that is a leaf of THIS container first leaves it, because the server
 * removes the origin too — and removal can collapse the origin's parent split and
 * reshape its siblings. The COMMIT still sends the unpruned aim id: the server
 * writes the landing leaf against the live tree first and prunes afterwards, so
 * preview and commit agree on the resulting SHAPE, which is all a viewer can see.
 * `center` is no structural change: the slot is the target leaf itself, and for a
 * swap the partner is the seat the carry came from — both drawn where they are.
 */
export function tileProspect(
  layout: TileLayout,
  aim: TileAim,
  carriedTileId: string | null,
  dividers: { readonly x: number; readonly y: number },
): TileProspect | null {
  if (aim.edge === "center") {
    const rects = tileRects(layout, dividers);
    const slot = rects.get(aim.tileId) ?? null;
    if (slot === null) return null;
    const partner =
      aim.action === "swap" && carriedTileId !== null ? (rects.get(carriedTileId) ?? null) : null;
    return { slot, partner, shifts: [] };
  }
  const pruned =
    carriedTileId !== null && layout[carriedTileId] !== undefined
      ? (withoutTileLeaf(layout, carriedTileId) ?? layout)
      : layout;
  const remapped = remapAimedTile(layout, pruned, aim.tileId);
  if (remapped === null) return null;
  const slotted = withTileSlot(pruned, remapped, aim.edge, aim.between === true);
  if (slotted === null) return null;
  const slot = tileRects(slotted.layout, dividers).get(slotted.slotId) ?? null;
  if (slot === null) return null;
  return { slot, partner: null, shifts: paneShifts(layout, slotted.layout, dividers) };
}
