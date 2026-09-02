import {
  MAX_PANEL_SECTIONS,
  ROOT_TILE_ID,
  sectionArrangementIds,
  validSectionArrangement,
  type SectionNode,
  type Structure,
  type Tile,
  type TileLayout,
} from "@manifold/protocol";
import { withoutTileStructure } from "@manifold/scene";
import type { TileAim } from "./tile-geometry.ts";
import { releasedTileLayout } from "./tile-release.ts";

/**
 * ── The section arrangement policy ───────────────────────────────────────────────────
 *
 * HOW A PANEL'S SECTIONS ARE ARRANGED, as pure functions of two inputs: what the
 * manifests declared, and what this principal arranged. Manifest order is the DEFAULT and
 * stays it — an untouched workspace stores nothing, and a section's declared place is what
 * survives a plugin being disabled and re-enabled (D4′).
 *
 * An arrangement is a TREE since issue #104: a list of nodes, each a section id or a
 * SPLIT of more nodes, so a reader who drags a row out of the palette into the rail can
 * put two rows side by side. A list of bare ids is the flat order this field always held,
 * which is why absence and flatness both reproduce the rail exactly as it was.
 *
 * THE RAIL IS A TILE TREE IN DISGUISE, and that is the whole trick below
 * ({@link projectSectionArrangement}). A stack of rows, some of them grouped across the
 * other axis, is precisely what a `TileLayout` describes — so the rail resolves a drop
 * through the SAME seam/zone kernel a composition does (`resolveTileAim`), applies it
 * through the SAME release (`releasedTileLayout`), and reads the answer back out. The
 * hysteresis, the seam bands, the between-wedge and the center trade are not
 * reimplemented here for a second surface; there is one kernel and this is a second
 * caller of it (AGENTS.md invariants 11 and 14).
 *
 * Pure and here, rather than inline in the sidebar's callbacks, because it is exactly the
 * "nontrivial sync policy" the conventions send to a unit-tested module. The sidebar
 * renders the RESULT and never re-derives it, so a live drag and a stored arrangement
 * paint through one path — the local pointer normalizes into the same node list the wire
 * carries before anything looks at it (invariant 11).
 */

/**
 * The arrangement a panel's sections render in. `arranged` is this principal's stored
 * tree, `declared` is manifest order; the answer names ids out of `declared` alone.
 *
 * Three rules, and all three are consequences of manifest order being the default rather
 * than choices made here:
 *
 *   A stored id the manifests no longer declare is DROPPED, wherever in the tree it sits —
 *   a plugin left the roster, and its slot must not hold a gap open. The stored row keeps
 *   naming it (nobody rewrites your arrangement behind your back), so re-enabling that
 *   plugin restores your place for free.
 *
 *   A SPLIT emptied that way SURVIVES, for the same reason. It is also what a freshly
 *   dropped split IS — two seats and nothing in them — so "empty" can never mean "delete
 *   me" without the palette's own drop deleting itself.
 *
 *   A declared id the arrangement does not name lands AFTER everything it does, at the top
 *   level, in manifest order. A section contributed since you last arranged the sidebar is
 *   new information, and the honest place for it is somewhere you can see it — never
 *   displacing a slot you chose, and never buried inside a split you did not put it in.
 */
export function arrangedSections(
  declared: readonly string[],
  arranged: readonly SectionNode[] | undefined,
): readonly SectionNode[] {
  if (arranged === undefined || arranged.length === 0) return declared;
  const declaredSet = new Set(declared);
  const keep = (nodes: readonly SectionNode[]): SectionNode[] =>
    nodes.flatMap((node): SectionNode[] => {
      if (typeof node !== "string") return [{ dir: node.dir, sections: keep(node.sections) }];
      return declaredSet.has(node) ? [node] : [];
    });
  const placed = keep(arranged);
  const named = new Set(sectionArrangementIds(placed));
  if (named.size === 0) return declared;
  return [...placed, ...declared.filter((id) => !named.has(id))];
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

/**
 * ── THE RAIL AS A TILE TREE ──────────────────────────────────────────────────────────
 *
 * A synthetic {@link TileLayout} over one panel's arrangement, so a drop into the rail
 * resolves through the very kernel every other drop in the application already uses. The
 * top level is a COLUMN split — a rail is a stack — each section is a LEAF holding its own
 * `panel` ref, and a stored split is a split. Tile ids are the node's PATH, so the answer
 * reads straight back out without a side table.
 *
 * `extentOf` is how big each node is PAINTED, along its parent's axis, keyed by path. It
 * matters because the kernel resolves zones out of ratios: feeding it the measured
 * extents is what makes the synthetic rects the boxes on screen, so the band a pointer
 * is in is the band the reader sees. A node the rail did not paint — a disabled plugin's
 * row, or one the collapsed rail left out — reports {@link UNPAINTED_EXTENT}: it keeps
 * its place in the tree (D4′) while being too small for any pointer to land on.
 */
export interface SectionProjection {
  readonly layout: TileLayout;
  /** Path of the leaf showing one section; the drag's own "what am I holding". */
  readonly pathOf: ReadonlyMap<string, string>;
}

/**
 * The share an unpainted row takes of its parent. Positive because a ratio must be, and
 * small enough that its band is under a pixel in any rail a person can see.
 */
export const UNPAINTED_EXTENT = 1e-4;

export function projectSectionArrangement(
  nodes: readonly SectionNode[],
  extentOf: (path: string) => number,
): SectionProjection {
  const layout: Record<string, Tile> = {};
  const pathOf = new Map<string, string>();
  const build = (list: readonly SectionNode[], id: string, dir: "row" | "column"): void => {
    const children: string[] = [];
    const ratios: number[] = [];
    list.forEach((node, index) => {
      const childId = `${id === ROOT_TILE_ID ? "n" : `${id}.`}${String(index)}`;
      children.push(childId);
      ratios.push(Math.max(extentOf(childId), UNPAINTED_EXTENT));
      if (typeof node === "string") {
        layout[childId] = {
          id: childId,
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "panel", panelId: node },
        };
        pathOf.set(node, childId);
        return;
      }
      build(node.sections, childId, node.dir);
    });
    if (children.length === 0) {
      // A split with no members is what a freshly dropped one IS, and the kernel needs a
      // leaf to aim at — so an empty split paints one vacant seat to receive the first row.
      const seatId = `${id === ROOT_TILE_ID ? "n" : `${id}.`}0`;
      layout[seatId] = { id: seatId, dir: null, ratios: [], children: [], ref: null };
      children.push(seatId);
      ratios.push(1);
    }
    layout[id] = { id, dir, ratios, children, ref: null };
  };
  build(nodes, ROOT_TILE_ID, "column");
  return { layout, pathOf };
}

/** The arrangement a projected tree describes: the inverse of the projection above. */
export function sectionArrangementOf(layout: TileLayout): readonly SectionNode[] {
  const read = (id: string): readonly SectionNode[] => {
    const tile = layout[id];
    if (tile === undefined) return [];
    return tile.children.flatMap((childId): SectionNode[] => {
      const child = layout[childId];
      if (child === undefined) return [];
      if (child.dir !== null) return [{ dir: child.dir, sections: read(childId) }];
      // A vacant leaf is a seat nobody has filled: it is the split's emptiness, not a row.
      return child.ref !== null && child.ref.kind === "panel" ? [child.ref.panelId] : [];
    });
  };
  const root = layout[ROOT_TILE_ID];
  if (root === undefined) return [];
  if (root.dir === null) {
    return root.ref !== null && root.ref.kind === "panel" ? [root.ref.panelId] : [];
  }
  return read(ROOT_TILE_ID);
}

/** What a rail release is holding: one of its own rows, or new structure from the palette. */
export type SectionRelease =
  | { readonly kind: "section"; readonly id: string }
  | { readonly kind: "structure"; readonly structure: Structure };

/**
 * THE ARRANGEMENT ONE RELEASE MEANS, or null when nothing legal came of it.
 *
 * Project, apply the shared release, read back. Every rule a reader can see here — a row
 * lands where the pointer did, two rows trade on a center drop, a seam wedges between
 * neighbours, a dropped split arrives with seats in it — is the kernel's, not a second
 * copy of it written for the rail.
 *
 * A SPACER is refused: the rail has no ratios for an inert leaf to hold open, so a spacer
 * dropped here would be a row that renders nothing and can never be filled.
 */
export function releasedSectionArrangement(
  projection: SectionProjection,
  release: SectionRelease,
  aim: TileAim,
): readonly SectionNode[] | null {
  if (release.kind === "structure" && release.structure.kind === "spacer") return null;
  const tileRelease =
    release.kind === "structure"
      ? ({ kind: "structure", structure: release.structure } as const)
      : (() => {
          const tileId = projection.pathOf.get(release.id);
          return tileId === undefined ? null : ({ kind: "seat", tileId } as const);
        })();
  if (tileRelease === null) return null;
  const next = releasedTileLayout(projection.layout, tileRelease, aim);
  if (next === null) return null;
  const arrangement = sectionArrangementOf(next);
  return validSectionArrangement(arrangement) ? arrangement : null;
}

/**
 * THE ARRANGEMENT ONE REMOVAL MEANS, or null when the path names nothing removable: the split
 * at `path` dissolves into its parent with its members kept in order (`withoutTileStructure`,
 * the same surgery the workspace tree's own structures go through — issue #148), read back the
 * way a release is. A vacant seat is the split's own emptiness and reads back as nothing.
 */
export function removedSectionStructure(
  projection: SectionProjection,
  path: string,
): readonly SectionNode[] | null {
  const next = withoutTileStructure(projection.layout, path);
  if (next === null) return null;
  const arrangement = sectionArrangementOf(next);
  return validSectionArrangement(arrangement) ? arrangement : null;
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
): readonly SectionNode[] | undefined {
  if (layout === null) return undefined;
  return panelLeaf(layout, panelId)?.sections;
}

/**
 * THE COMMIT SHAPE: the tree that stores `arrangement` as one panel's own, ready for
 * `core.space.setLayout`. Null when the write must not happen — the tree does not show that
 * panel, or the arrangement names a section twice or nests past the bound, which are the
 * rules `validateTileLayout` would refuse it by, refused before it reaches the wire.
 *
 * An EMPTY arrangement removes the field rather than storing `[]`. "I have no arrangement"
 * and "my arrangement is nothing" are the same state, and only one of them has a
 * representation: resetting to manifest order leaves a tree indistinguishable from one
 * nobody ever arranged.
 */
export function withPanelSections(
  layout: TileLayout,
  panelId: string,
  arrangement: readonly SectionNode[],
): TileLayout | null {
  if (arrangement.length > MAX_PANEL_SECTIONS) return null;
  if (!validSectionArrangement(arrangement)) return null;
  const leaf = panelLeaf(layout, panelId);
  if (leaf === null) return null;
  const rest = { ...leaf };
  delete rest.sections;
  // Copied rather than shared: the stored tree is handed to a debounced writer, and an
  // arrangement the caller can still mutate is a write nobody can reason about.
  const copied = arrangement.map(function copy(node: SectionNode): SectionNode {
    return typeof node === "string" ? node : { dir: node.dir, sections: node.sections.map(copy) };
  });
  const next: Tile = arrangement.length === 0 ? rest : { ...rest, sections: copied };
  return { ...layout, [leaf.id]: next };
}
