import { type Structure, type Tile, type TileLayout } from "@manifold/protocol";
import {
  withTileLeaf,
  withTileStructure,
  withTilesSwapped,
  withoutTileLeaf,
} from "@manifold/scene";
import type { TileAim } from "./tile-geometry.ts";

/**
 * ── WHAT A RELEASE MEANS OVER A TILE TREE ────────────────────────────────────────────
 *
 * One function, because there is one answer. A carry resolves to a {@link TileAim}
 * through the shared seam/zone kernel wherever it is dragged — a composition's own tree,
 * the workspace shell's tree, or the projection of a panel's row arrangement — and the
 * tree that release produces cannot depend on which of those it was. Three copies of
 * "insert at the aim, then prune the seat it came from" is exactly the second door
 * docs/CONTRACTS.md §One authoritative implementation forbids, and it is what this module retired.
 *
 * Pure and total over its inputs: no DOM, no document, no notion of a producer. A refusal
 * is `null`, and the CALLER names it — the workspace's editor answers with its own rule
 * classes and the rail with its own, because the prose belongs to the surface a reader is
 * looking at, not to the arithmetic.
 */

/** What is being released: an existing seat in THIS tree, or new structure from a palette. */
export type TileRelease =
  | { readonly kind: "seat"; readonly tileId: string }
  | { readonly kind: "structure"; readonly structure: Structure };

/**
 * WHAT A PANEL LEAF HOLDS BESIDE ITS REF: this reader's section arrangement, and the
 * argument the panel is showing something for (`arg`, issue #516).
 *
 * One type because both fields answer "what is this panel doing here", and both are
 * governed by the same rule: they are legal on a panel leaf and nowhere else (protocol
 * `validateTileLayout`).
 */
export type PanelLeafState = Pick<Tile, "sections" | "arg">;

/**
 * A PANEL LEAF'S OWN STATE TRAVELS WITH THE PANEL, never with the seat: a reader who
 * arranged the sidebar's rows and then moved the sidebar keeps that arrangement, and a
 * reader who opened a record and then moved the tile keeps the record.
 *
 * Exported because the two writers of a panel leaf need the same rule — a release, here,
 * and an opening (`openedPanel`) — and an absent field is DELETED rather than stored as
 * `undefined`: the tree is persisted as JSON, where those two are the same state and only
 * one of them has a spelling.
 */
export function withPanelLeafState(
  layout: TileLayout,
  tileId: string,
  state: PanelLeafState,
): TileLayout | null {
  const tile = layout[tileId];
  if (tile === undefined) return null;
  const seat = { ...tile };
  delete seat.sections;
  delete seat.arg;
  return {
    ...layout,
    [tileId]: {
      ...seat,
      ...(state.sections === undefined ? {} : { sections: [...state.sections] }),
      ...(state.arg === undefined ? {} : { arg: { ...state.arg } }),
    },
  };
}

/**
 * TWO SEATS TRADE OCCUPANTS — the ONE exchange, whether a pointer released on a leaf's
 * exact spot, an arrow key named the sibling, or a row was dropped on another row. Ids,
 * splits and ratios are untouched by `withTilesSwapped`, so each occupant adopts the
 * other's share, and each panel's own state travels with its ref rather than staying behind.
 */
export function tradedSeats(
  layout: TileLayout,
  aTileId: string,
  bTileId: string,
): TileLayout | null {
  const a = panelLeafState(layout[aTileId]);
  const b = panelLeafState(layout[bTileId]);
  const swapped = withTilesSwapped(layout, aTileId, bTileId);
  const seated = swapped === null ? null : withPanelLeafState(swapped, bTileId, a);
  return seated === null ? null : withPanelLeafState(seated, aTileId, b);
}

/** The state a tile carries for its panel; an absent tile carries none. */
function panelLeafState(tile: Tile | undefined): PanelLeafState {
  return {
    ...(tile?.sections === undefined ? {} : { sections: tile.sections }),
    ...(tile?.arg === undefined ? {} : { arg: tile.arg }),
  };
}

/**
 * THE RELEASE: the tree an aim means, or null when the tree refuses it.
 *
 * `aim` is whatever `resolveTileAim` answered — leaf zones, seam ends, seam middles
 * (`between`) and the area's border ring, one vocabulary shared with every drag in the
 * application. Two shapes come out of it:
 *
 *   CENTER MEANS THIS EXACT SPOT. Two occupied leaves trade seats (see
 *   {@link tradedSeats}); a vacant landing leaf is a move, and the emptied origin departs.
 *   NEW STRUCTURE has no origin, so a center release simply becomes that leaf.
 *
 *   EVERY OTHER EDGE MEANS A SPLIT: the newcomer joins the tree at that edge — flat along
 *   the parent's own axis, nesting across it, wedged between two siblings for a seam
 *   middle — and a moved seat then leaves the one it came from.
 *
 * Insert first, prune second, which is the server's own order for a leaf moving inside its
 * own tree: an insert never retires an existing leaf id, so the origin is still there to
 * remove afterwards and the aim needs no remapping through a collapse.
 */
export function releasedTileLayout(
  layout: TileLayout,
  release: TileRelease,
  aim: TileAim,
): TileLayout | null {
  if (release.kind === "structure") {
    const inserted = withTileStructure(
      layout,
      release.structure,
      aim.tileId,
      aim.edge,
      aim.between === true,
    );
    return inserted === null ? null : inserted.layout;
  }

  const moved = layout[release.tileId];
  const ref = moved?.ref ?? null;
  if (moved === undefined || moved.dir !== null || ref === null) return null;
  if (aim.tileId === release.tileId) return null;

  const landing = layout[aim.tileId];
  if (aim.edge === "center") {
    if (landing === undefined || landing.dir !== null) return null;
    const traded = tradedSeats(layout, release.tileId, aim.tileId);
    if (traded === null || landing.ref !== null) return traded;
    return withoutTileLeaf(traded, release.tileId);
  }

  const inserted = withTileLeaf(layout, ref, aim.tileId, aim.edge, aim.between === true);
  if (inserted === null) return null;
  const seated = withPanelLeafState(inserted.layout, inserted.tileId, panelLeafState(moved));
  return seated === null ? null : withoutTileLeaf(seated, release.tileId);
}
