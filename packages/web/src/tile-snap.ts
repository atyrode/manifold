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
 * Nothing here knows about drag payloads: the transfer format lives in `item-envelope.ts`
 * and legality in `item-drop.ts`, so this module stays geometry and is unit-testable
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
 * Element types a canvas drop can compose ONTO: a terminal (a composition is born around
 * it) or a widget (the surface joins the composition it points at). Text and ink are not
 * targets — there is nothing to birth a container around — and the executor refuses them
 * anyway, so offering the gesture would be a lie.
 */
const COMPOSE_TARGET_TYPES: Readonly<Record<string, true>> = { terminal: true, portal: true };

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
    if (COMPOSE_TARGET_TYPES[node.type] !== true) continue;
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

/**
 * The highlight rectangle for a zone: the half the dropped surface would occupy,
 * or the whole target for `center`. Coordinates match the input rect's space.
 */
export function previewRect(rect: SnapRect, zone: TileEdge): SnapRect {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  switch (zone) {
    case "left":
      return { x: rect.x, y: rect.y, width: halfWidth, height: rect.height };
    case "right":
      return { x: rect.x + halfWidth, y: rect.y, width: halfWidth, height: rect.height };
    case "top":
      return { x: rect.x, y: rect.y, width: rect.width, height: halfHeight };
    case "bottom":
      return { x: rect.x, y: rect.y + halfHeight, width: rect.width, height: halfHeight };
    case "center":
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
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
