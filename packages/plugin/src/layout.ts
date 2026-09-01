import { MAX_PANEL_SECTIONS, type Tile, type TileLayout } from "@manifold/protocol";

/**
 * The two panels a default workspace is built from, as DATA the caller supplies.
 *
 * `sidebar` and `main` are the two roles the arrangement below has, not two plugins: a
 * fully-qualified panel id goes in each, and the floor never learns which plugin wrote it.
 */
export interface WorkspacePanels {
  readonly sidebar: string;
  readonly main: string;
}

/**
 * The workspace a principal gets before it has ever arranged one: sidebar left, main view
 * right, at the width the hand-written shell used to hard-code.
 *
 * It returns a plain `TileLayout` whose leaves are PANEL refs, which is the whole point — the
 * shell is not a bespoke frame with a resizable sidebar inside it, it is one tile tree
 * rendered by the same component every composition uses, and the sidebar is a panel like any
 * other. Dragging the divider therefore edits ratios, and a plugin can be given half the
 * workspace without the shell learning a new arrangement.
 *
 * THE FLOOR OWNS THE ARRANGEMENT; THE REGISTRATION FILES OWN THE NAMES. Two leaves in a row
 * at `[0.22, 0.78]`, under the tile ids `root`, `ws-sidebar` and `ws-main`, is engine grammar:
 * it is unchanged if every plugin in the tree is replaced by different plugins, which is the
 * neutrality criterion (AXIOMS.md §Foundation law). WHICH panels fill the two leaves is plugin
 * data, and plugin data reaches the floor only as an argument — the two `assembly.ts` files
 * are the sole places allowed to name a plugin (REGISTRY.md §Foundation, gate S2), so they pass the ids in
 * and this function stays a function of them.
 *
 * A layout referencing a panel no live plugin provides is legal and renders a placeholder
 * (protocol layout.ts:33-41), so a default built from ids the assembly happens not to hold is
 * still a writable tree rather than a boot failure — that is what keeps this function honest
 * with plugins missing. `verify:axioms` (S1) nonetheless asserts the ids the real assemblies
 * pass do resolve, because the DEFAULT must never be the broken case.
 */
export function workspaceLayout(panels: WorkspacePanels): TileLayout {
  return {
    root: {
      id: "root",
      dir: "row",
      ratios: [0.22, 0.78],
      children: ["ws-sidebar", "ws-main"],
      ref: null,
    },
    "ws-sidebar": {
      id: "ws-sidebar",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: panels.sidebar },
    },
    "ws-main": {
      id: "ws-main",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: panels.main },
    },
  };
}

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
