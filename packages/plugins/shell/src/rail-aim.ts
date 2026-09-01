import { ROOT_TILE_ID, type SectionNode, type TileDir, type TileLayout } from "@manifold/protocol";
import { tileChainAt, type UnitPoint, type UnitRect } from "@manifold/plugin/hooks";

/**
 * ── WHERE A POINTER IS IN THE RAIL'S OWN TREE ────────────────────────────────────────
 *
 * The rail resolves a drop by projecting itself into a `TileLayout` and asking the shared
 * seam/zone kernel (`projectSectionArrangement`, `resolveTileAim`). That kernel answers in
 * UNIT SPACE — fractions of the tile area — so somebody has to say which fraction a client
 * pixel is. This module is that somebody, and it is a module rather than three closures in
 * the panel because getting it wrong is invisible: every band still resolves, just not where
 * it is painted, and the only way to see the difference is to measure it (issue #124).
 *
 * Two readings, both pure, both driven by the boxes the panel measured:
 *
 *   {@link railPoint} maps a client pixel into the tree's unit space BY DESCENT through the
 *   painted boxes, not by one affine map against the whole rail.
 *
 *   {@link stackPoint} then reduces that point to the vocabulary a STACK actually has —
 *   boundaries — by projecting the cross axis away and folding an occupied row's centre onto
 *   the nearer of its two edges.
 */

/** One painted node's box, in client px: what the panel measured off the DOM. */
export interface RailBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How big every node is PAINTED along its parent's axis, keyed by the path the projection
 * names it by (`n0`, `n0.1`, …) — the `extentOf` the projection asks for.
 *
 * Read off the same boxes {@link railPoint} descends through, so the tree's ratios and the
 * tree's hit areas can never describe two different rails. A path with no box measures 0,
 * which the projection floors at `UNPAINTED_EXTENT`: a disabled plugin's row, or a body the
 * collapsed rail left out, keeps its place in the tree (D4′) while being too small for any
 * pointer to land on.
 */
export function railExtents(
  nodes: readonly SectionNode[],
  boxes: ReadonlyMap<string, RailBox>,
): ReadonlyMap<string, number> {
  const extents = new Map<string, number>();
  const walk = (list: readonly SectionNode[], prefix: string, dir: TileDir): void => {
    list.forEach((node, index) => {
      const path = `${prefix}${String(index)}`;
      const box = boxes.get(path);
      if (box !== undefined) extents.set(path, dir === "row" ? box.width : box.height);
      if (typeof node !== "string") walk(node.sections, `${path}.`, node.dir);
    });
  };
  walk(nodes, "n", "column");
  return extents;
}

function holds(box: RailBox, clientX: number, clientY: number): boolean {
  return (
    clientX >= box.left &&
    clientX <= box.left + box.width &&
    clientY >= box.top &&
    clientY <= box.top + box.height
  );
}

/**
 * THE POINT ONE CLIENT PIXEL MEANS, resolved by DESCENT through the painted boxes.
 *
 * One affine map against the rail's own box is what this replaces, and it was wrong for every
 * nested split (issue #124). The projection models each node's extent along its PARENT'S axis
 * and nothing else: a node's cross axis is always the parent's full span, because a stack of
 * rows has no second dimension to measure. That fiction is harmless until a split runs the
 * OTHER way — then the axis its members are laid out along is the very axis the projection
 * never measured, and any inset at all puts every band inside it somewhere else than the paint.
 * The live case is the collapse control: a split arranged into first place reserves its width
 * (`.sidebar-split:first-child`, `shell.css`), so a row split there is painted 34 px narrower
 * than the rail while the kernel resolves it as the rail's full width. Two rows abreast then
 * have their join, and the outer edge that adds a third, standing a full row-width to the
 * right of where the reader sees them — which is why "drag a second row in" only ever worked
 * by accident, on the ONE geometry (a lone member spanning the whole split) where the stretch
 * happens to leave the trailing band overlapping its own row.
 *
 * Descending fixes it at the root rather than per inset: the deepest painted box holding the
 * pointer names the node, and the pointer's position INSIDE that box is mapped onto that
 * node's own rect. Every band then lands exactly where its node is drawn, whatever padding,
 * wrapper or grow behaviour the stylesheet gives it, and a rail with no insets at all resolves
 * exactly as it did before.
 *
 * A pointer in a divider gap belongs to no child, so the descent stops at the split holding
 * that gap and maps across it — which is what makes the gap a SEAM (`tileChainAt` ends on a
 * split) instead of one neighbour's flank.
 *
 * NOT CLAMPED at the root, deliberately: a pointer outside the rail must map outside the unit
 * square so the kernel answers nothing, exactly as it did when this was one division.
 */
export function railPoint(
  layout: TileLayout,
  rects: ReadonlyMap<string, UnitRect>,
  boxes: ReadonlyMap<string, RailBox>,
  area: RailBox,
  clientX: number,
  clientY: number,
): UnitPoint {
  let box = area;
  let rect = rects.get(ROOT_TILE_ID) ?? { x: 0, y: 0, width: 1, height: 1 };
  let tileId = ROOT_TILE_ID;
  for (;;) {
    const node = layout[tileId];
    if (node === undefined || node.dir === null) break;
    const nextId = node.children.find((childId) => {
      const childBox = boxes.get(childId);
      return (
        childBox !== undefined &&
        rects.get(childId) !== undefined &&
        holds(childBox, clientX, clientY)
      );
    });
    const nextBox = nextId === undefined ? undefined : boxes.get(nextId);
    const nextRect = nextId === undefined ? undefined : rects.get(nextId);
    if (nextId === undefined || nextBox === undefined || nextRect === undefined) break;
    box = nextBox;
    rect = nextRect;
    tileId = nextId;
  }
  return {
    x: rect.x + rect.width * (box.width > 0 ? (clientX - box.left) / box.width : 0.5),
    y: rect.y + rect.height * (box.height > 0 ? (clientY - box.top) / box.height : 0.5),
  };
}

/**
 * The fraction of a leaf's own edge band the folded point sits at. Dead centre of the band, so
 * the answer is a step function of which half of the row the pointer is in and the boundary
 * between the two halves is not itself a zone with a third meaning.
 */
const FOLDED_BAND_DEPTH = 0.125;

/**
 * A RAIL IS READ ALONG THE AXIS OF THE STACK THE POINTER IS STANDING IN, and its cross axis
 * carries no meaning at all: the pointer's cross coordinate is replaced by the centre of the
 * node it is inside before the kernel ever sees it.
 *
 * This is the one place the rail's own SHAPE has to be spoken for, and it is not a tweak. The
 * kernel's zones are a quarter of each axis independently, which is right for a pane that is
 * roughly as wide as it is tall and wrong for a row that is 280 px wide and 26 px high: the
 * left and right bands of such a row cover HALF THE RAIL while its top and bottom bands are
 * three pixels each, so a hand dragging straight down the stack would spend the whole gesture
 * asking to nest rows side by side and would never once be able to say "put it here". The same
 * anisotropy hands a pointer near the rail's left edge a SEAM END — "split the whole stack
 * across" — which would fold the entire rail into one member of a new split.
 *
 * Neither of those is a gesture the rail wants to offer at all. NESTING IS THE PALETTE'S: a
 * reader who wants two rows abreast drags a stack out of the palette and drops rows into it,
 * which is a deliberate act with a visible seat, and drifting 20 px sideways in a 26 px row is
 * not. So the cross axis is projected away, and what is left is exactly the vocabulary a stack
 * has: the boundaries between its members. Inside a `row` split the axis is the other one, and
 * the same rule then reads x and flattens y — which is how a row dropped on a member's outer
 * EDGE joins it abreast while the pointer's height inside the split means nothing.
 *
 * AND AN OCCUPIED ROW HAS NO CENTRE, which is the other half of the same argument and was
 * missing (issue #124). A centre aim on an occupied leaf means "these two exchange seats", and
 * there is no trade in a stack: rows have no geometry worth preserving, so exchanging two of
 * them is a reorder said a second way. The rail therefore refused it — and because the cross
 * axis is flattened, `center` is not a small square in the middle of a pane here, it is the
 * middle HALF of every row in the rail. Refusing it made half of the surface a silent dead
 * zone: a palette stack dropped on the middle of a row produced nothing, no notice and no
 * arrangement, which is most of what "stacking often doesn't apply" was. Folded, the middle of
 * a row means the same as its nearer boundary — every pixel of the stack says "put it here",
 * and the boundary aims that are the whole vocabulary get the whole surface to be reached from.
 *
 * A VACANT seat keeps its centre, and that is the point of the exception: filling one is the
 * one drop a centre release performs, and it is exactly what a dropped split exists for.
 */
export function stackPoint(
  layout: TileLayout,
  rects: ReadonlyMap<string, UnitRect>,
  point: UnitPoint,
): UnitPoint {
  const chain = tileChainAt(layout, rects, point);
  const nodeId = chain[chain.length - 1] ?? ROOT_TILE_ID;
  const rect = rects.get(nodeId);
  if (rect === undefined) return point;
  // A LEAF takes its parent's axis; a SPLIT the pointer stands in the gap of takes its own.
  const node = layout[nodeId];
  const parentId = chain[chain.length - 2];
  const parent = parentId === undefined ? undefined : layout[parentId];
  const dir = node?.dir ?? parent?.dir ?? "column";
  const occupied = node !== undefined && node.dir === null && node.ref !== null;
  const along = dir === "row" ? point.x : point.y;
  const start = dir === "row" ? rect.x : rect.y;
  const extent = dir === "row" ? rect.width : rect.height;
  const folded =
    occupied && extent > 0
      ? start +
        extent * ((along - start) / extent < 0.5 ? FOLDED_BAND_DEPTH : 1 - FOLDED_BAND_DEPTH)
      : along;
  return dir === "column"
    ? { x: rect.x + rect.width / 2, y: folded }
    : { x: folded, y: rect.y + rect.height / 2 };
}
