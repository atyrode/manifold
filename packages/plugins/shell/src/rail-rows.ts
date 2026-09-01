import type { ComposedSection } from "@manifold/plugin";

/**
 * WHICH ROWS THE RAIL PAINTS, and which one absorbs its leftover height — the sidebar's whole
 * visibility policy, as a function of three inputs and nothing else.
 *
 * It is a module rather than arithmetic inside the panel for the reason `arrangedSectionIds`
 * is one: this is the only place the rail decides that a disabled plugin's row VANISHES
 * (D4′ — chrome renders absence; the Plugins section is the one ledger of what is off) and
 * that a collapsed rail keeps its icon-only rows while showing one body. Both rules are
 * assertions about the product, and both are now testable without a browser
 * (`test/rail-rows.test.ts`).
 *
 * ORDER IS NOT DECIDED HERE. The caller hands in the live id order — manifest order, overridden
 * by this principal's stored arrangement, overridden by a grab in flight — because that merge
 * is the engine's own tested policy and a second answer to it would be a second arrangement
 * (invariant 14). This module only resolves, filters and names the absorber.
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
