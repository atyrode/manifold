import type { TileAim } from "@manifold/plugin/hooks";
import {
  validateTileLayout,
  type TileEdge,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";
import {
  tileLeafIds,
  tileParentId,
  withTileLeaf,
  withTilesSwapped,
  withoutTileLeaf,
} from "@manifold/scene";

/**
 * ── THE PANEL LEG OF ARRANGE MODE ────────────────────────────────────────────────────
 *
 * WHERE A GRABBED PANEL LANDS, as pure functions of three inputs: the workspace tree, the
 * panel leaf in hand, and the aim the pointer (or an arrow key) resolved. The answer is
 * either the next `TileLayout` — ready for `core.space.setLayout`, the one door — or a
 * NAMED refusal, because a gesture that cannot land owes the reader the rule that stopped
 * it rather than a silent no-op.
 *
 * Pure and here, rather than inline in the shell's pointer callbacks, for the reason the
 * conventions give: this is the "nontrivial sync policy" that belongs in a unit-tested
 * module. The shell previews the RESULT and commits the same value, so the tree the eye
 * was shown is the tree that is written.
 *
 * IT FORKS NO LEGALITY. Every structural answer comes from the tile surgery that already
 * exists — `withTileLeaf` for a split, `withTilesSwapped` for an exchange, `withoutTileLeaf`
 * for the origin's departure — and the result is handed to `validateTileLayout`, the same
 * predicate `core.space.setLayout` gates every write with. There is no second tree algebra
 * for panels: the sidebar and the container view are panes of an ordinary tile tree (D2),
 * and this module is only the ORDER those operations run in.
 *
 * THAT ORDER IS THE SERVER'S. An edge aim inserts into the LIVE tree first and prunes the
 * origin afterwards, exactly as the composition executor does for a tile that moves inside
 * its own container — which is why the aim never needs remapping through a collapse, and
 * why the shape this commits is the shape `tileProspect` previewed (`tile-geometry.ts`:
 * the preview prunes first and the commit sends the unpruned aim id; both agree on shape,
 * which is all a viewer can see).
 */

/**
 * WHAT SCOPE A PUBLISHED REF MEANS, resolved rather than trusted.
 *
 * `vantage.arrangeScope` carries a panel ref and nothing else — absent is the root, where the
 * workspace's own panels are what a gesture reaches. A ref is a live scope only while the
 * composition still says that panel holds an arrangement: a plugin can be disabled, or its
 * panel dropped from the tree, while a reader is standing inside it. An unresolvable ref
 * therefore reads as the ROOT rather than as a workspace with nothing to reach and no way to
 * say why.
 *
 * Pure, and keyed by the declared TITLE, because the title is the whole of what the floor may
 * learn about somebody else's arrangement: it is the crumb the chrome prints and the word the
 * way-in control is labelled with, and there is deliberately nothing else to resolve.
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
] as const;

export type PanelArrangeRule = (typeof PANEL_ARRANGE_RULES)[number];

/** The next tree, or the rule that refused it. */
export type PanelArrangeOutcome =
  | { readonly ok: true; readonly layout: TileLayout }
  | { readonly ok: false; readonly rule: PanelArrangeRule };

/**
 * One sentence per rule, keyed by the union so a rule cannot ship without prose — the
 * table `item-drop.ts` keeps for placement refusals, applied to this gesture's own five.
 */
const RULE_PROSE: Readonly<Record<PanelArrangeRule, string>> = {
  panel_alone: "This workspace shows one panel, so there is nowhere to move it.",
  not_a_panel: "That pane holds no panel to move.",
  aim_unchanged: "That is where the panel already sits.",
  no_sibling: "No panel sits on that side of this one.",
  tree_refused: "The workspace tree cannot take the panel there.",
};

/** The refusal in prose, for the notice the shell raises when a release lands nowhere. */
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
 * A LEAF'S SECTION ARRANGEMENT TRAVELS WITH THE PANEL, never with the seat.
 *
 * `sections` is this principal's order for the sections that PANEL hosts — legal on a panel
 * leaf and nowhere else (protocol `layout.ts`) — so it is part of the occupant, exactly as
 * the ref is. The tile surgery below cannot know that: `withTilesSwapped` trades two `ref`
 * fields and `withTileLeaf` seats a bare one, both written for compositions, whose leaves
 * hold terminals and containers and therefore never carry an arrangement at all. Moving the
 * sidebar without this would silently reset the arrangement the reader just spent a gesture
 * making, which is the one outcome an arrange gesture may not have.
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
 * TWO PANELS TRADE SEATS — the ONE exchange, whether a pointer released on a leaf's exact
 * spot or an arrow key named the sibling. Ids, splits and ratios are untouched by
 * `withTilesSwapped`, so each panel adopts the other's share, and the arrangements travel
 * with the refs rather than staying behind on the seats.
 */
function tradedSeats(layout: TileLayout, aTileId: string, bTileId: string): TileLayout | null {
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
