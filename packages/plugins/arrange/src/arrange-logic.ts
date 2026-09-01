import type { TileAim } from "@manifold/plugin/hooks";
import {
  ROOT_TILE_ID,
  validateTileLayout,
  type TileDir,
  type TileEdge,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";
import {
  tileLeafIds,
  tileParentId,
  withTileLeaf,
  withTileRatios,
  withTilesSwapped,
  withoutTileLeaf,
} from "@manifold/scene";

/**
 * ── THE PANEL LEG OF ARRANGE MODE, AS PURE POLICY ────────────────────────────────────
 *
 * Ported whole from the floor host it used to live inside (`packages/web/src/workspace.tsx`,
 * `workspace-arrange.ts`) when the F8 editor became `core.arrange` (issue #89). Nothing here
 * changed shape in the move: the same tree in, the same tree or the same named refusal out,
 * still unit-testable without a DOM. What is NEW below the pointer-gesture section is the
 * toolbar's own verbs — Stack, Spacer, Equalize, Swap, Shelf — each a small pure transform
 * over the same kernel, so a click commits through exactly the door a drag always has.
 */

/**
 * WHAT SCOPE A PUBLISHED REF MEANS, resolved rather than trusted.
 *
 * `vantage.arrangeScope` is a panel ref a reader zoomed into, but the panel it names may have
 * been disabled or dropped from the tree since — so this reads the LIVE roster rather than
 * trusting the wire value, and an unresolvable ref reads as the root. The root is the only
 * scope the workspace itself understands: everything else is a panel's own word, borrowed off
 * its manifest (`contributes.panels[].arranges`), never enumerated here.
 */
export interface ArrangeScope {
  /** The panel whose own parts are reachable, or null for the workspace's panels. */
  readonly panelId: string | null;
  /** What that panel calls its arrangement; null at the root. */
  readonly title: string | null;
}

export const ROOT_ARRANGE_SCOPE: ArrangeScope = { panelId: null, title: null };

export function resolveArrangeScope(
  panels: ReadonlyMap<string, { readonly arranges?: { readonly title: string } | undefined }>,
  ref: string | null,
): ArrangeScope {
  if (ref === null) return ROOT_ARRANGE_SCOPE;
  const title = panels.get(ref)?.arranges?.title;
  if (title === undefined) return ROOT_ARRANGE_SCOPE;
  return { panelId: ref, title };
}

/**
 * The refusal classes this policy can answer with. A class, never a sentence, for the same
 * reason a placement denial is one (ADR 0013 §2): a caller switches on the class and reads
 * the prose only to show it.
 */
export const PANEL_ARRANGE_RULES = [
  "panel_alone",
  "not_a_panel",
  "aim_unchanged",
  "no_sibling",
  "tree_refused",
  "nothing_selected",
] as const;

export type PanelArrangeRule = (typeof PANEL_ARRANGE_RULES)[number];

/** The next tree, or the rule that refused it. */
export type PanelArrangeOutcome =
  | { readonly ok: true; readonly layout: TileLayout }
  | { readonly ok: false; readonly rule: PanelArrangeRule };

/**
 * One sentence per rule, keyed by the union so a rule cannot ship without prose — the
 * table `item-drop.ts` keeps for placement refusals, applied to this gesture's own six.
 */
const RULE_PROSE: Readonly<Record<PanelArrangeRule, string>> = {
  panel_alone: "This workspace shows one panel, so there is nowhere to move it.",
  not_a_panel: "That pane holds no panel to move.",
  aim_unchanged: "That is where the panel already sits.",
  no_sibling: "No panel sits on that side of this one.",
  tree_refused: "The workspace tree cannot take the panel there.",
  nothing_selected: "Select the seat this tool acts on first.",
};

/** The refusal in prose, for the notice the toolbar raises when a tool cannot act. */
export function panelArrangeMessage(rule: PanelArrangeRule): string {
  return RULE_PROSE[rule];
}

const refuse = (rule: PanelArrangeRule): PanelArrangeOutcome => ({ ok: false, rule });

/** The panel a leaf shows, or null when the leaf is a split, empty, or holds something else. */
function panelRefAt(layout: TileLayout, tileId: string): TileRef | null {
  const tile = layout[tileId];
  if (tile === undefined || tile.dir !== null) return null;
  const ref = tile.ref;
  if (ref === null || ref.kind !== "panel") return null;
  return ref;
}

/**
 * Is there anything to arrange? A workspace showing ONE panel has no second seat for it to
 * take, so no grip is offered at all — the same honesty the section leg already practises
 * on the collapsed rail, which is one section and therefore offers no grip either. The
 * refusal below covers the tree that changed under a grab already in hand.
 */
export function panelsCanMove(layout: TileLayout | null): boolean {
  if (layout === null) return false;
  let occupied = 0;
  for (const tileId of tileLeafIds(layout)) {
    if (layout[tileId]?.ref !== null) occupied += 1;
    if (occupied > 1) return true;
  }
  return false;
}

/** The result, gated by the same predicate the layout door gates every write with. */
function settled(next: TileLayout | null): PanelArrangeOutcome {
  if (next === null || !validateTileLayout(next)) return refuse("tree_refused");
  return { ok: true, layout: next };
}

/**
 * A LEAF'S SECTION ARRANGEMENT TRAVELS WITH THE PANEL, never with the seat. Exported: the
 * toolbar's Swap tool needs the exact same carry-along a pointer trade always got.
 */
function withLeafSections(
  layout: TileLayout,
  tileId: string,
  sections: readonly string[] | undefined,
): TileLayout | null {
  const tile = layout[tileId];
  if (tile === undefined) return null;
  const seat = { ...tile };
  delete seat.sections;
  return {
    ...layout,
    [tileId]: sections === undefined ? seat : { ...seat, sections: [...sections] },
  };
}

/**
 * TWO SEATS TRADE OCCUPANTS — the ONE exchange, whether a pointer released on a leaf's exact
 * spot, an arrow key named the sibling, or the toolbar's Swap tool named two selected tiles.
 * Ids, splits and ratios are untouched by `withTilesSwapped`, so each occupant adopts the
 * other's share, and the arrangements travel with the refs rather than staying behind on the
 * seats.
 */
export function tradedSeats(layout: TileLayout, aTileId: string, bTileId: string): TileLayout | null {
  const aSections = layout[aTileId]?.sections;
  const bSections = layout[bTileId]?.sections;
  const swapped = withTilesSwapped(layout, aTileId, bTileId);
  const seated = swapped === null ? null : withLeafSections(swapped, bTileId, aSections);
  return seated === null ? null : withLeafSections(seated, aTileId, bSections);
}

/**
 * THE RELEASE: the tree a grabbed panel's aim means.
 *
 * `aim` is whatever `resolveTileAim` answered — leaf zones, seam ends, seam middles
 * (`between`) and the area's border ring, one vocabulary shared with every composition's own
 * drag. Two shapes come out of it:
 *
 *   CENTER means THIS EXACT SPOT: the two panels trade seats (see {@link tradedSeats}), so
 *   ids, splits and ratios are untouched and each panel adopts the other's share — the
 *   established meaning of a center release everywhere else. On a
 *   vacant leaf the panel simply moves in and its origin leaf departs.
 *
 *   EVERY OTHER EDGE means a SPLIT: the panel joins the tree at that edge (flat along the
 *   parent's own axis, nesting across it, wedged between two siblings for a seam middle),
 *   and then leaves the seat it came from.
 */
export function movedPanelLayout(
  layout: TileLayout,
  movedTileId: string,
  aim: TileAim,
): PanelArrangeOutcome {
  const ref = panelRefAt(layout, movedTileId);
  if (ref === null) return refuse("not_a_panel");
  if (!panelsCanMove(layout)) return refuse("panel_alone");
  if (aim.tileId === movedTileId) return refuse("aim_unchanged");

  const movedSections = layout[movedTileId]?.sections;
  const landing = layout[aim.tileId];

  if (aim.edge === "center") {
    if (landing === undefined || landing.dir !== null) return refuse("tree_refused");
    const traded = tradedSeats(layout, movedTileId, aim.tileId);
    // A VACANT landing leaf is a move rather than a trade: the empty origin then departs.
    if (traded === null || landing.ref !== null) return settled(traded);
    return settled(withoutTileLeaf(traded, movedTileId));
  }

  /*
    Insert first, prune second — the server's own order for a leaf moving inside its own
    tree. An insert never retires an existing leaf id (splitting the ROOT renames the root
    SPLIT, never its children), so the origin is still there to remove afterwards and the
    aim needs no remapping through a collapse.
  */
  const inserted = withTileLeaf(layout, ref, aim.tileId, aim.edge, aim.between === true);
  if (inserted === null) return refuse("tree_refused");
  const seated = withLeafSections(inserted.layout, inserted.tileId, movedSections);
  return settled(seated === null ? null : withoutTileLeaf(seated, movedTileId));
}

/**
 * THE NUDGE: an arrow key trades a panel with the sibling on that side of its own split.
 *
 * Deliberately the shape-PRESERVING subset of the release above, and deliberately the same
 * door: trading two seats is what a center release already means, so a nudge is that same
 * release addressed by key instead of by pointer — ratios stay with the
 * seats, each panel adopting the other's share. Re-splitting the tree is the pointer's job,
 * because a split is a choice about WHERE inside a pane, which a keypress cannot express.
 *
 * Two shapes refuse, and both are "the tree does not allow it" rather than a missing
 * feature: an arrow across the split's own axis (there is no sibling that way), and a
 * sibling that is a SPLIT rather than a leaf — exchanging with a whole group is not two
 * panels trading seats, and the pointer already addresses any tile at any depth.
 */
export function nudgedPanelLayout(
  layout: TileLayout,
  movedTileId: string,
  direction: Exclude<TileEdge, "center">,
): PanelArrangeOutcome {
  if (panelRefAt(layout, movedTileId) === null) return refuse("not_a_panel");
  if (!panelsCanMove(layout)) return refuse("panel_alone");

  const parentId = tileParentId(layout, movedTileId);
  const parent = parentId === null ? undefined : layout[parentId];
  if (parent === undefined || parent.dir === null) return refuse("no_sibling");

  const axis = direction === "left" || direction === "right" ? "row" : "column";
  if (parent.dir !== axis) return refuse("no_sibling");

  const index = parent.children.indexOf(movedTileId);
  const siblingId = parent.children[index + (direction === "left" || direction === "top" ? -1 : 1)];
  if (index < 0 || siblingId === undefined) return refuse("no_sibling");
  if (layout[siblingId]?.dir !== null) return refuse("no_sibling");

  return settled(tradedSeats(layout, movedTileId, siblingId));
}

/**
 * ── THE TOOLBAR'S OWN VERBS ───────────────────────────────────────────────────────────
 *
 * Six of the seven tools act on the ROOT split specifically — the workspace's own top-level
 * arrangement, the one every reader sees without zooming into anything — rather than on an
 * arbitrarily nested one, and Swap acts on exactly two tiles the toolbar's own selection
 * names. That is a deliberate, documented scope: the pointer-driven grip above already
 * reaches ANY depth for a reader who wants to restructure a nested stack by hand, and a
 * click-button editor that tried to match it would need a second addressing scheme for
 * "which stack" beside the one the grip already has. Root-scoped commands cover exactly what
 * the issue asks for — "rearrange the sidebar rows and workspace panels to arbitrary stacks
 * with spacers using only the toolbar" is a claim about the WORKSPACE's own arrangement, and
 * every default and every grip-built tree the toolbar might inherit has its structure at the
 * root the reader is looking at.
 */

/** Appends `ref` as a new, flat child of the root split — Spacer and Shelf's re-seat share it. */
function appendedToRoot(layout: TileLayout, ref: TileRef): TileLayout | null {
  const root = layout[ROOT_TILE_ID];
  if (root === undefined) return null;
  if (root.dir === null) {
    // A single-leaf root: the root branch of `withTileLeaf` wraps it into a fresh row split.
    const inserted = withTileLeaf(layout, ref, ROOT_TILE_ID, "right");
    return inserted === null ? null : inserted.layout;
  }
  const edge: TileEdge = root.dir === "row" ? "right" : "bottom";
  const lastChild = root.children.at(-1);
  if (lastChild === undefined) return null;
  // Root's own axis, so `withTileLeaf` JOINS the row flat rather than nesting (#60).
  const inserted = withTileLeaf(layout, ref, lastChild, edge);
  return inserted === null ? null : inserted.layout;
}

/** Spacer: a first-class inert leaf, appended to the workspace's own top-level arrangement. */
export function addedSpacer(layout: TileLayout | null): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  return settled(appendedToRoot(layout, { kind: "spacer" }));
}

/** Stack row / Stack column: re-orients the root split without touching its children. */
export function rootStacked(layout: TileLayout | null, dir: TileDir): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  const root = layout[ROOT_TILE_ID];
  if (root === undefined || root.dir === null) return refuse("panel_alone");
  if (root.dir === dir) return refuse("aim_unchanged");
  return settled({ ...layout, [ROOT_TILE_ID]: { ...root, dir } });
}

/** Equalize: normalizes the root split's ratios to one even share each. */
export function rootEqualized(layout: TileLayout | null): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  const root = layout[ROOT_TILE_ID];
  if (root === undefined || root.dir === null) return refuse("panel_alone");
  const share = 1 / root.children.length;
  return settled(withTileRatios(layout, ROOT_TILE_ID, root.children.map(() => share)));
}

/** Swap: trades exactly two selected seats, occupied or not — the toolbar's own Swap tool. */
export function swappedSeats(
  layout: TileLayout | null,
  selected: readonly string[],
): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  if (selected.length !== 2) return refuse("nothing_selected");
  const [a, b] = selected;
  if (a === undefined || b === undefined || layout[a] === undefined || layout[b] === undefined) {
    return refuse("tree_refused");
  }
  if (layout[a]?.dir !== null || layout[b]?.dir !== null) return refuse("tree_refused");
  return settled(tradedSeats(layout, a, b));
}

/** Every declared panel with no leaf in the tree right now — Shelf's own listing. */
export function shelvedPanels(
  layout: TileLayout | null,
  panels: ReadonlyMap<string, { readonly title: string }>,
): readonly { readonly panelId: string; readonly title: string }[] {
  const seated = new Set<string>();
  if (layout !== null) {
    for (const tile of Object.values(layout)) {
      if (tile.ref?.kind === "panel") seated.add(tile.ref.panelId);
    }
  }
  return [...panels]
    .filter(([panelId]) => !seated.has(panelId))
    .map(([panelId, panel]) => ({ panelId, title: panel.title }));
}

/** Shelf's unseat: removes one panel's leaf, which is what puts it on the shelf. */
export function shelved(layout: TileLayout | null, tileId: string): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  if (panelRefAt(layout, tileId) === null) return refuse("not_a_panel");
  return settled(withoutTileLeaf(layout, tileId));
}

/** Shelf's re-seat: appends a shelved panel back onto the workspace's own arrangement. */
export function reseated(layout: TileLayout | null, panelId: string): PanelArrangeOutcome {
  if (layout === null) return refuse("tree_refused");
  return settled(appendedToRoot(layout, { kind: "panel", panelId }));
}
