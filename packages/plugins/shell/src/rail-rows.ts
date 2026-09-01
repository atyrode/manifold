import { sectionArrangementIds, type SectionNode, type TileDir } from "@manifold/protocol";
import type { ComposedSection } from "@manifold/plugin";

/**
 * WHICH ROWS THE RAIL PAINTS, and which one absorbs its leftover height — the sidebar's whole
 * visibility policy, as a function of three inputs and nothing else.
 *
 * It is a module rather than arithmetic inside the panel for the reason `arrangedSections`
 * is one: this is the only place the rail decides that a disabled plugin's row VANISHES
 * (D4′ — chrome renders absence; the Plugins section is the one ledger of what is off) and
 * that a collapsed rail keeps its icon-only rows while showing one body. Both rules are
 * assertions about the product, and both are now testable without a browser
 * (`test/rail-rows.test.ts`).
 *
 * THE ARRANGEMENT IS NOT DECIDED HERE. The caller hands in the live id order — manifest order,
 * overridden by this principal's stored arrangement, overridden by a gesture in flight —
 * because that merge is the engine's own tested policy and a second answer to it would be a
 * second arrangement (invariant 14). This module only resolves, filters and names the
 * absorber; {@link railTree} below applies it to an arrangement that nests.
 */
export interface RailRow {
  readonly section: ComposedSection;
  /** The stack's height absorber; exactly one row is it, or none. */
  readonly grow: boolean;
}

/**
 * The rows to paint, in the order given.
 *
 * `order` may name a row the roster no longer carries and a row whose owner is off; both are
 * dropped, and dropping rather than tombstoning is the point — a stored arrangement keeps the
 * seat it dropped, so re-enabling a plugin restores the exact place the principal chose
 * without the rail ever drawing a slot for something that is not there.
 *
 * THE ABSORBER is the first DISCLOSURE row in the live order. A `plain` row draws itself end
 * to end and has nothing to absorb — a create strip stretched to fill the rail would be a
 * button the height of the screen — so the leftover height goes to the first row that has a
 * body, whichever plugin that turns out to be. Read off the order rather than a hardcoded id,
 * which is what makes the rule survive a plugin being disabled, added or rearranged.
 *
 * A COLLAPSED RAIL keeps every plain row and exactly the absorber: the plain rows are the
 * icon strip (each draws itself icon-only when the rail is collapsed — the brand's mark, the
 * three creators, the key table's door, the identity dot), and one body is what the rail has
 * room for. That is not a second layout: it is the same stack with the rows that need a
 * header's width left out.
 */
export function railRows(
  declared: readonly ComposedSection[],
  order: readonly string[],
  sidebarOpen: boolean,
): readonly RailRow[] {
  const byId = new Map(declared.map((section) => [section.id, section]));
  const live = order.flatMap((id) => {
    const section = byId.get(id);
    return section === undefined || !section.enabled ? [] : [section];
  });
  const absorber = live.find((section) => section.presentation === "disclosure");
  return live.flatMap((section) => {
    const grow = section === absorber;
    if (!sidebarOpen && !grow && section.presentation !== "plain") return [];
    return [{ section, grow }];
  });
}

/**
 * ONE NODE OF THE RAIL AS IT IS PAINTED: a row that survived the filter above, or a SPLIT
 * holding more of them. It is the arrangement tree with the invisible rows taken out and the
 * absorber named, which is precisely what the stack walks.
 */
export type RailNode =
  | { readonly kind: "row"; readonly path: string; readonly row: RailRow }
  | {
      readonly kind: "split";
      readonly path: string;
      readonly dir: TileDir;
      readonly nodes: readonly RailNode[];
    };

/**
 * The rail's painted TREE: {@link railRows}' visibility policy applied to an arrangement that
 * may nest (issue #104), so a reader who dropped a split into the rail sees two rows side by
 * side instead of one flattened order.
 *
 * `path` IS THE POINT of this shape. Every node carries the id `projectSectionArrangement`
 * mints for it — top-level index `i` is `n<i>`, a child of `p` at index `i` is `p.<i>` — and
 * the panel paints it as `data-section-path`, because that attribute is how the drop gesture
 * measures a node's box and matches it back to the tile the kernel resolved against. The
 * indices are the ARRANGEMENT's own, never the painted list's: a disabled plugin's row leaves
 * a numbering hole on purpose, since the projection walks the same arrangement and would
 * otherwise name a different seat than the DOM does.
 *
 * A split with no painted members comes back with none, rather than being dropped. That is
 * what a freshly dropped split IS — seats and nothing in them — so emptiness has to survive
 * being painted or the palette's own drop would vanish on the frame after it landed.
 */
export function railTree(
  declared: readonly ComposedSection[],
  arrangement: readonly SectionNode[],
  sidebarOpen: boolean,
): readonly RailNode[] {
  const rows = new Map(
    railRows(declared, sectionArrangementIds(arrangement), sidebarOpen).map((row) => [
      row.section.id,
      row,
    ]),
  );
  const walk = (nodes: readonly SectionNode[], prefix: string): readonly RailNode[] =>
    nodes.flatMap((node, index): RailNode[] => {
      const path = `${prefix}${String(index)}`;
      if (typeof node !== "string") {
        return [{ kind: "split", path, dir: node.dir, nodes: walk(node.sections, `${path}.`) }];
      }
      const row = rows.get(node);
      return row === undefined ? [] : [{ kind: "row", path, row }];
    });
  return walk(arrangement, "n");
}
