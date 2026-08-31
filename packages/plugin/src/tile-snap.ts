import { ROOT_TILE_ID, type TileEdge, type TileLayout, type TileSurface } from "@manifold/protocol";

/**
 * Pure snap geometry and hit-testing, shared by the composition renderer and the canvas
 * compose gesture.
 *
 * MODEL RULE (see the container-primitives plan): uniformity lives in the composition
 * layer, not storage. Every tileable surface — a canvas terminal element, a canvas, a note,
 * later a browser pane — is treated by drag, preview and compose logic as a one-leaf tile
 * tree via `asTileTree`, while the stored object stays a plain element until composition
 * actually happens.
 *
 * Nothing here knows about drag payloads: the transfer format and its legality both live in
 * the engine (`@manifold/plugin/hooks`), so this module stays geometry and is unit-testable
 * without a DOM.
 */

/** No divider drag may shrink a pane below this fraction of its split. */
export const MIN_TILE_FRACTION = 0.1;

/** A drop target's viewport rectangle, in CSS pixels. */
export interface SnapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A pointer position in the same coordinate space as the rect. */
export interface SnapPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The shape of a projected canvas node this module needs to hit-test. Structural rather
 * than the renderer's own node type, so the geometry stays independent of React Flow —
 * and the caller gets its own node type back, because only it knows what to do with one.
 */
export interface SnapNode {
  readonly id: string;
  readonly type: string;
  readonly position: SnapPoint;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

/**
 * The ONE element type a canvas drop can compose onto: a widget, which is a portal onto
 * the container the surface would join. There is no second species — a canvas terminal
 * IS a portal onto its solo home, so the composition it births is the container behind
 * that same portal. Notes and ink are not targets (there is nothing to birth a container
 * around, and the executor refuses them anyway), so offering the gesture would be a lie.
 */
const COMPOSE_TARGET_TYPE = "portal";

/**
 * Topmost composable node under a flow-space point. React Flow gives no node-over-node
 * hit-testing, so the pointer is tested against the projected rects — the same rect test
 * the drag-stop park check runs against the sidebar.
 */
export function composeTargetAt<T extends SnapNode>(
  nodes: readonly T[],
  point: SnapPoint,
  excludeId: string | null,
): T | null {
  let hit: T | null = null;
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    if (node.type !== COMPOSE_TARGET_TYPE) continue;
    if (
      point.x < node.position.x ||
      point.x > node.position.x + node.width ||
      point.y < node.position.y ||
      point.y > node.position.y + node.height
    ) {
      continue;
    }
    if (hit === null || node.zIndex >= hit.zIndex) hit = node;
  }
  return hit;
}

/** Fraction of each side claimed by its edge band; the remainder is `center`. */
export const SNAP_EDGE_BAND = 0.25;

/**
 * Which zone a pointer falls in over a drop target, or null when the pointer is
 * outside the rect (release there aborts with no mutation).
 *
 * The four edge bands take the outer 25% of each axis. Corners are resolved by
 * whichever axis the pointer has penetrated more deeply, measured as a fraction
 * of that axis' band, so a 45-degree approach into a corner is a coin flip
 * decided by the longer overlap rather than by axis order.
 */
export function snapZone(rect: SnapRect, pointer: SnapPoint): TileEdge | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dx = pointer.x - rect.x;
  const dy = pointer.y - rect.y;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;

  const bandX = rect.width * SNAP_EDGE_BAND;
  const bandY = rect.height * SNAP_EDGE_BAND;
  // Depth into a band, normalised to it, so unequal band widths compare fairly.
  const left = dx < bandX ? 1 - dx / bandX : 0;
  const right = dx > rect.width - bandX ? 1 - (rect.width - dx) / bandX : 0;
  const top = dy < bandY ? 1 - dy / bandY : 0;
  const bottom = dy > rect.height - bandY ? 1 - (rect.height - dy) / bandY : 0;

  const horizontal = Math.max(left, right);
  const vertical = Math.max(top, bottom);
  if (horizontal === 0 && vertical === 0) return "center";
  if (horizontal >= vertical) return left >= right ? "left" : "right";
  return top >= bottom ? "top" : "bottom";
}

/** What releasing on a resolved zone will DO; `swap` is the center-on-occupied case. */
export type SnapAction = "place" | "swap";

/** A resolved drop: the zone the wire will carry, and what that zone means here. */
export interface SnapTarget {
  readonly zone: TileEdge;
  readonly action: SnapAction;
}

/**
 * What the carry can offer at one target. Both answers come from the caller because both
 * are state this module deliberately cannot see — a tree's leaf, a canvas's elements —
 * which is what keeps the resolution pure and testable without a DOM.
 */
export interface SnapCarry {
  /** True when the exact spot is already taken: an occupied leaf, or any canvas element. */
  readonly occupied: boolean;
  /**
   * True when the carry holds a PLACEMENT of the target's own species — a leaf for a leaf,
   * a canvas element for a canvas element — so there is a seat to give the occupant back.
   * False for identity forms (a sidebar row, a bare session id), which name an item
   * without naming any placement of it and therefore have nothing to trade.
   */
  readonly canSwap: boolean;
}

/**
 * The zone a release means, with what it would do. CENTER MEANS THIS EXACT SPOT: on an
 * empty target it fills it, on a taken one it exchanges the two occupants.
 *
 * A carry with no seat to give back gets no center band at all — it DISSOLVES into the
 * edge it is nearest, so the whole target stays droppable and the gesture keeps meaning
 * something. Offering the exchange and refusing it on release is the lying affordance this
 * function exists to remove, so the same rule runs for the highlight and for the drop.
 */
export function resolveSnapTarget(
  rect: SnapRect,
  pointer: SnapPoint,
  carry: SnapCarry,
): SnapTarget | null {
  const zone = snapZone(rect, pointer);
  if (zone === null) return null;
  if (zone !== "center" || !carry.occupied) return { zone, action: "place" };
  if (carry.canSwap) return { zone, action: "swap" };
  return { zone: nearestEdge(rect, pointer), action: "place" };
}

/**
 * The edge a point is closest to, in a fixed order so a pointer dead in the middle of a
 * square resolves the same way for every viewer rather than by float noise.
 */
function nearestEdge(rect: SnapRect, pointer: SnapPoint): TileEdge {
  const left = pointer.x - rect.x;
  const right = rect.x + rect.width - pointer.x;
  const top = pointer.y - rect.y;
  const bottom = rect.y + rect.height - pointer.y;
  const nearest = Math.min(left, right, top, bottom);
  if (nearest === left) return "left";
  if (nearest === right) return "right";
  if (nearest === top) return "top";
  return "bottom";
}

/**
 * Lifts a single surface into the one-leaf tile tree the preview and compose
 * layers reason over. Nothing is stored: a canvas terminal element only becomes
 * a real layout tree when the server composes a view around it.
 */
export function asTileTree(surface: TileSurface): TileLayout {
  return {
    [ROOT_TILE_ID]: {
      id: ROOT_TILE_ID,
      dir: null,
      ratios: [],
      children: [],
      surface,
    },
  };
}

/**
 * Moves the divider that sits between children `index` and `index + 1` by `delta`,
 * expressed in the same units as `ratios`. Only the two adjacent panes change, so a
 * drag never disturbs the rest of the split, and neither may fall below
 * `MIN_TILE_FRACTION` of the split's total. Returns the input array unchanged when
 * the drag is already pinned against a stop, letting callers skip a redundant write.
 */
export function resizeRatios(
  ratios: readonly number[],
  index: number,
  delta: number,
): readonly number[] {
  const before = ratios[index];
  const after = ratios[index + 1];
  if (before === undefined || after === undefined) return ratios;

  let total = 0;
  for (const ratio of ratios) total += ratio;
  const min = total * MIN_TILE_FRACTION;
  const pair = before + after;
  // A split so tight that both stops overlap has no room left to give.
  if (pair < min * 2) return ratios;

  const upper = pair - min;
  const nextBefore = Math.min(Math.max(before + delta, min), upper);
  if (nextBefore === before) return ratios;
  const next = [...ratios];
  next[index] = nextBefore;
  // Pinned drags land on the stop exactly; subtracting instead would leave the
  // partner a float hair under the documented floor.
  next[index + 1] = nextBefore === upper ? min : pair - nextBefore;
  return next;
}

/**
 * A divider drag, snapshotted when the pointer went down. `originPx` and `sizePx` are
 * client pixels — the pointer's coordinate and the split box's measured extent along
 * the drag axis — and `ratios` is the split's ratio array as it stood at that moment,
 * so a stream of moves resolves against one fixed origin instead of accumulating
 * rounding.
 */
export interface DividerDrag {
  /** The divider between children `index` and `index + 1`. */
  readonly index: number;
  readonly originPx: number;
  readonly sizePx: number;
  /** The split's ratio total, which is the unit `resizeRatios` works in. */
  readonly total: number;
  readonly ratios: readonly number[];
}

/**
 * Where a divider drag has moved to: the pointer's travel as a fraction of the split,
 * scaled into ratio units. Both terms are client pixels — the caller measures the box
 * with `getBoundingClientRect()`, which reports it already transformed — so the same
 * math holds for a tree drawn 1:1 and one drawn inside a scaled, zoomed canvas widget.
 * Returns `drag.ratios` itself when the drag is pinned, so callers can skip the write.
 */
export function dividerRatios(drag: DividerDrag, pointerPx: number): readonly number[] {
  if (drag.sizePx <= 0) return drag.ratios;
  const delta = ((pointerPx - drag.originPx) / drag.sizePx) * drag.total;
  return resizeRatios(drag.ratios, drag.index, delta);
}
