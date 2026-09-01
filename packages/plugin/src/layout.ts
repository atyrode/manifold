import { MAX_PANEL_SECTIONS, type Tile, type TileLayout } from "@manifold/protocol";

/**
 * ── The section arrangement policy ───────────────────────────────────────────────────
 *
 * WHAT ORDER A PANEL'S SECTIONS ARE IN, as pure functions of two inputs: what the
 * manifests declared, and what this principal arranged. Manifest order is the DEFAULT and
 * stays it — an untouched workspace stores nothing, and a section's declared place is what
 * survives a plugin being disabled and re-enabled (D4′).
 *
 * Pure and here, rather than inline in the sidebar's callbacks, because it is exactly the
 * "nontrivial sync policy" the conventions send to a unit-tested module: a merge over two
 * lists that disagree, plus the transition one grab makes. The sidebar renders the RESULT
 * and never re-derives it, so a live drag and a stored arrangement paint through one path —
 * the local pointer normalizes into the same `readonly string[]` the wire carries before
 * anything looks at it (AGENTS.md invariant 11).
 */

/**
 * The order a panel's sections render in. `arranged` is this principal's stored order,
 * `declared` is manifest order; the answer is a permutation of `declared` alone.
 *
 * Two rules, and both are consequences of manifest order being the default rather than
 * choices made here:
 *
 *   A stored id the manifests no longer declare is DROPPED — a plugin left the roster, and
 *   its slot must not hold a gap open. The stored row keeps naming it (nobody rewrites your
 *   arrangement behind your back), so re-enabling that plugin restores your place for free.
 *
 *   A declared id the arrangement does not name lands AFTER everything it does, in manifest
 *   order. A section contributed since you last arranged the sidebar is new information, and
 *   the honest place for it is somewhere you can see it — never displacing a slot you chose.
 */
export function arrangedSectionIds(
  declared: readonly string[],
  arranged: readonly string[] | undefined,
): readonly string[] {
  if (arranged === undefined || arranged.length === 0) return declared;
  const declaredSet = new Set(declared);
  const placed = arranged.filter((id) => declaredSet.has(id));
  if (placed.length === 0) return declared;
  const placedSet = new Set(placed);
  return [...placed, ...declared.filter((id) => !placedSet.has(id))];
}

/**
 * The order one grab produces: `moved` taken out and dropped where `over` sits. This is the
 * whole of the drag's arithmetic — the preview renders it per frame and the release commits
 * the same value, so what you let go of is what is written.
 *
 * The input order is returned UNCHANGED when the move is a no-op or names an id the order
 * does not hold, so a pointer wandering over chrome that is not a section cannot invent a
 * write, and referential equality is a usable "nothing happened" signal.
 */
export function movedSectionIds(
  order: readonly string[],
  moved: string,
  over: string,
): readonly string[] {
  const from = order.indexOf(moved);
  const to = order.indexOf(over);
  if (from === -1 || to === -1 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** One painted unit of a section stack: a lone row, or the members of one declared cluster. */
export interface SectionCluster<T> {
  /** The declared word, or null for a row that declared none — its own unit by definition. */
  readonly cluster: string | null;
  readonly rows: readonly T[];
}

/**
 * THE CLUSTER POLICY: an ordered stack of rows becomes an ordered stack of PAINTED UNITS, where
 * rows declaring the same word are one unit.
 *
 * Two rules, and both follow from a cluster being DECLARED rather than positional:
 *
 *   A cluster sits where its EARLIEST member sits. The rail's foot is "status, then the utility
 *   cluster, then identity" because `core.keys` is the first utility row in the live order — so
 *   a reader who arranges one member to the top moves the whole cluster there, which is the
 *   only answer that keeps one order for one stack.
 *
 *   Members keep the stack's own order INSIDE the unit, and a member that drifted away from its
 *   neighbour in the arrangement is pulled back beside it. Membership is a manifest fact; a
 *   stack cannot half-honour it, and an arrangement that could break a cluster apart would make
 *   two rows that declared they belong together depend on where a pointer let go.
 *
 * Generic over the row, with the word read through `clusterOf`, because the caller paints
 * whatever it already resolved — a composed section, or a section wrapped in the rail's own
 * visibility decision — and a policy that demanded one shape would push the panel into
 * re-deriving the other (`railRows`, `@manifold-plugin/shell`).
 *
 * A row with no word, and a word with one live member, both yield a one-row unit: an unclustered
 * stack comes back out of here as it went in, one unit per row, which is what makes the field's
 * absence byte-identical to the rail before it existed.
 */
export function clusteredSections<T>(
  rows: readonly T[],
  clusterOf: (row: T) => string | undefined,
): readonly SectionCluster<T>[] {
  const units: { cluster: string | null; rows: T[] }[] = [];
  const byCluster = new Map<string, { cluster: string | null; rows: T[] }>();
  for (const row of rows) {
    const cluster = clusterOf(row);
    if (cluster === undefined) {
      units.push({ cluster: null, rows: [row] });
      continue;
    }
    const existing = byCluster.get(cluster);
    if (existing !== undefined) {
      existing.rows.push(row);
      continue;
    }
    const unit = { cluster, rows: [row] };
    byCluster.set(cluster, unit);
    units.push(unit);
  }
  return units;
}

/** One row's vertical extent, in whatever coordinate space the pointer is reported in. */
export interface SectionBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

/**
 * How far PAST a neighbour's midpoint the pointer must be before the stack answers, in the
 * pointer's own units.
 *
 * The midpoint rule is already self-stabilising for a row with height: swapping past a
 * neighbour puts that neighbour's new midpoint a whole held-row-height back up the way the
 * pointer came, so undoing the swap costs real travel. A ZERO-HEIGHT row — `core.shell.status`
 * with nothing to report is exactly one — has no height to spend, so its band would be the
 * width of a jitter. This margin is the floor under that band and nothing else; it is not a
 * feel constant, and a row with height never notices it.
 */
export const SECTION_CROSS_MARGIN = 4;

/**
 * WHICH ROW A HELD ROW HAS CROSSED, or null for "the stack has not been asked to move".
 *
 * The drag's whole hit test, and the reason it is a pure function of measured boxes rather
 * than an `elementFromPoint` at the pointer: what a pointer is OVER is not what a reorder
 * should answer to. Two rules, and both are the fix for a real oscillation (issue #94):
 *
 *   The held row is never a candidate. It is the REFERENCE — the scan starts at its
 *   neighbours — so a frame that lands back inside the row in hand asks for nothing.
 *
 *   A neighbour is crossed only once the pointer is past its MIDPOINT (by
 *   {@link SECTION_CROSS_MARGIN}), never merely inside its box. Entering a box was the old
 *   rule, and it has no hysteresis at all: the swap it triggers slides the displaced
 *   neighbour under the very pointer that displaced it, and the next frame swaps it back.
 *   Past the midpoint, the swap moves the neighbour a full held-row-height clear of the
 *   threshold that would undo it, so a slow drag back and forth over a boundary crosses it
 *   once each way instead of ringing.
 *
 * The scan continues while successive neighbours are crossed and returns the FARTHEST one, so
 * a fast drag that outruns the frames lands where the pointer is rather than one row behind
 * it. `boxes` are the rows as they are PAINTED right now, in painted order.
 */
export function crossedSectionId(
  boxes: readonly SectionBox[],
  moved: string,
  pointerY: number,
  margin: number = SECTION_CROSS_MARGIN,
): string | null {
  const from = boxes.findIndex((box) => box.id === moved);
  if (from === -1) return null;
  let crossed: string | null = null;
  for (let index = from + 1; index < boxes.length; index++) {
    const box = boxes[index];
    if (box === undefined || pointerY <= (box.top + box.bottom) / 2 + margin) break;
    crossed = box.id;
  }
  if (crossed !== null) return crossed;
  for (let index = from - 1; index >= 0; index--) {
    const box = boxes[index];
    if (box === undefined || pointerY >= (box.top + box.bottom) / 2 - margin) break;
    crossed = box.id;
  }
  return crossed;
}

/** The leaf a panel occupies, in key order; null when the tree does not show that panel. */
function panelLeaf(layout: TileLayout, panelId: string): Tile | null {
  for (const tile of Object.values(layout)) {
    if (tile.ref !== null && tile.ref.kind === "panel" && tile.ref.panelId === panelId) {
      return tile;
    }
  }
  return null;
}

/** This principal's stored arrangement for one panel, or undefined for "the manifests decide". */
export function panelSections(
  layout: TileLayout | null,
  panelId: string,
): readonly string[] | undefined {
  if (layout === null) return undefined;
  return panelLeaf(layout, panelId)?.sections;
}

/**
 * THE COMMIT SHAPE: the tree that stores `order` as one panel's arrangement, ready for
 * `core.space.setLayout`. Null when the write must not happen — the tree does not show that
 * panel, or the order names a section twice, which is the one thing an order may not do
 * (the same rule `validateTileLayout` would refuse it by, refused before it reaches the wire).
 *
 * An EMPTY order removes the field rather than storing `[]`. "I have no arrangement" and
 * "my arrangement is nothing" are the same state, and only one of them has a representation:
 * resetting to manifest order leaves a tree indistinguishable from one nobody ever arranged.
 */
export function withPanelSections(
  layout: TileLayout,
  panelId: string,
  order: readonly string[],
): TileLayout | null {
  if (order.length > MAX_PANEL_SECTIONS) return null;
  if (new Set(order).size !== order.length) return null;
  const leaf = panelLeaf(layout, panelId);
  if (leaf === null) return null;
  const rest = { ...leaf };
  delete rest.sections;
  const next: Tile = order.length === 0 ? rest : { ...rest, sections: [...order] };
  return { ...layout, [leaf.id]: next };
}
