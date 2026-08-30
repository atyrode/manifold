import {
  ROOT_TILE_ID,
  TileLayoutSchema,
  validateTileLayout,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";
import * as Y from "yjs";

/**
 * The ONLY Yjs code for tiled containers. Split/collapse math is pure and lives
 * beside the doc writers so it can be unit-tested without a document; the doc
 * writers are thin appliers that diff the pure result into the shared map.
 *
 * Structural writes are server-authored (they arrive over HTTP), so tile ids are
 * allocated deterministically from the current node table — one writer, no
 * id races. Ratio drags are the only client-authored mutation.
 */

/** Yjs root key holding a tiled container's node table; canvases never allocate it. */
export const LAYOUT_KEY = "layout";

export function layoutMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(LAYOUT_KEY);
}

// ------------------------------------------------------------------ pure math

/** A fresh tree: the root is one empty leaf that renders as a drop hint. */
export function emptyTileLayout(): TileLayout {
  return { [ROOT_TILE_ID]: tileLeaf(ROOT_TILE_ID, null) };
}

export function tileLeaf(id: string, surface: TileSurface | null): TileNode {
  return { id, dir: null, ratios: [], children: [], surface };
}

/** Parent of `tileId`, or null for the root and for unreachable garbage. */
export function tileParentId(layout: TileLayout, tileId: string): string | null {
  for (const node of Object.values(layout)) {
    if (node.children.includes(tileId)) return node.id;
  }
  return null;
}

/** Leaf ids in tree order; the bubble rules count these. */
export function tileLeafIds(layout: TileLayout): string[] {
  const leaves: string[] = [];
  const walk = (id: string): void => {
    const node = layout[id];
    if (node === undefined) return;
    if (node.dir === null) {
      leaves.push(node.id);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(ROOT_TILE_ID);
  return leaves;
}

/**
 * Do two surfaces name the SAME item? Exhaustive over the union by construction, so a
 * new tileable form cannot be added without deciding what its identity is.
 */
export function sameSurface(a: TileSurface, b: TileSurface): boolean {
  switch (a.kind) {
    case "terminal":
      return b.kind === "terminal" && a.sessionId === b.sessionId;
    case "pad":
      return b.kind === "pad" && a.padId === b.padId;
    case "text":
      return b.kind === "text" && a.elementId === b.elementId;
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

/**
 * Leaf id showing `surface`, in tree order; null when the container does not show it.
 * Placement truth for a session lives HERE and in the element table — never on a
 * session record, which one id could only ever describe partially.
 */
export function tileIdForSurface(layout: TileLayout | null, surface: TileSurface): string | null {
  if (layout === null) return null;
  for (const tileId of tileLeafIds(layout)) {
    const found = layout[tileId]?.surface ?? null;
    if (found !== null && sameSurface(found, surface)) return tileId;
  }
  return null;
}

/** Smallest unused `t<n>` id, so ids stay stable and readable across writes. */
export function nextTileId(layout: TileLayout, taken: ReadonlySet<string> = new Set()): string {
  for (let index = 1; ; index += 1) {
    const id = `t${index}`;
    if (layout[id] === undefined && !taken.has(id)) return id;
  }
}

export interface TileInsert {
  readonly layout: TileLayout;
  /** Tile id of the inserted surface; the placement id callers hand back. */
  readonly tileId: string;
}

/**
 * Insert `surface` next to `targetTileId`. `center` fills an empty leaf in place;
 * a CROSS-axis edge wraps the target in a new two-way split, while a SAME-axis
 * edge joins the parent split as a flat sibling (see the branch note below).
 *
 * The root id is immovable, so splitting the root moves the root's own content
 * into a fresh leaf and turns the root into the split. Splitting any other tile
 * keeps that tile's id — only a cross-axis wrapper is ever new.
 */
export function withTileLeaf(
  layout: TileLayout,
  surface: TileSurface,
  targetTileId: string,
  edge: TileEdge,
): TileInsert | null {
  return insertLeaf(layout, surface, targetTileId, edge);
}

/**
 * The layout that would result from dropping SOMETHING at `edge` of `targetTileId`,
 * with the landing leaf left EMPTY. Preview-only: the same tree surgery `withTileLeaf`
 * performs — one private implementation, two public entry points — so a preview can
 * never describe a shape the write would not produce. `withTileLeaf` keeps its
 * non-null `surface` on purpose: it underlies the server's only structural tile
 * write, and a nullable surface must never be able to reach a doc write.
 */
export function withTileSlot(
  layout: TileLayout,
  targetTileId: string,
  edge: TileEdge,
): { readonly layout: TileLayout; readonly slotId: string } | null {
  const inserted = insertLeaf(layout, null, targetTileId, edge);
  return inserted === null ? null : { layout: inserted.layout, slotId: inserted.tileId };
}

/** The one tree surgery behind both entry points above. */
function insertLeaf(
  layout: TileLayout,
  surface: TileSurface | null,
  targetTileId: string,
  edge: TileEdge,
): TileInsert | null {
  const target = layout[targetTileId];
  if (target === undefined) return null;

  if (edge === "center") {
    if (target.dir !== null || target.surface !== null) return null;
    return {
      layout: { ...layout, [targetTileId]: { ...target, surface } },
      tileId: targetTileId,
    };
  }

  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const leading = edge === "left" || edge === "top";
  const leafId = nextTileId(layout);
  const leaf = tileLeaf(leafId, surface);

  if (targetTileId === ROOT_TILE_ID) {
    const movedId = nextTileId(layout, new Set([leafId]));
    return {
      layout: {
        ...layout,
        [leafId]: leaf,
        [movedId]: { ...target, id: movedId },
        [ROOT_TILE_ID]: {
          id: ROOT_TILE_ID,
          dir,
          ratios: [0.5, 0.5],
          children: leading ? [leafId, movedId] : [movedId, leafId],
          surface: null,
        },
      },
      tileId: leafId,
    };
  }

  const parentId = tileParentId(layout, targetTileId);
  if (parentId === null) return null;
  const parent = layout[parentId];
  if (parent === undefined) return null;

  /*
    SAME AXIS JOINS THE ROW, it never nests (#60). A row inside a row is pure
    structural noise — it looks identical to the flat row at drop time, then
    behaves worse: its dividers only rebalance within the nest and collapses
    leave deeper trees. So when the requested split runs the parent's own way,
    the new leaf is spliced in BESIDE the target, which cedes half its share —
    the exact geometry the wrap would have painted, minus the wrapper. This is
    also how a drop on a DIVIDER lands between two siblings: it is addressed as
    the leading neighbor's trailing edge, which is this branch. Cross-axis
    edges keep wrapping below — that IS the nesting gesture — and the root
    keeps its wrap in the branch above, so grouping a whole composition under
    a fresh split stays reachable at the area's ring.
  */
  if (parent.dir === dir) {
    const index = parent.children.indexOf(targetTileId);
    if (index < 0) return null;
    const targetRatio = parent.ratios[index] ?? 1;
    const children = [...parent.children];
    const ratios = [...parent.ratios];
    children.splice(leading ? index : index + 1, 0, leafId);
    ratios.splice(leading ? index : index + 1, 0, targetRatio / 2);
    ratios[leading ? index + 1 : index] = targetRatio / 2;
    return {
      layout: {
        ...layout,
        [leafId]: leaf,
        [parentId]: { ...parent, children, ratios },
      },
      tileId: leafId,
    };
  }

  const splitId = nextTileId(layout, new Set([leafId]));
  return {
    layout: {
      ...layout,
      [leafId]: leaf,
      [splitId]: {
        id: splitId,
        dir,
        ratios: [0.5, 0.5],
        children: leading ? [leafId, targetTileId] : [targetTileId, leafId],
        surface: null,
      },
      [parentId]: {
        ...parent,
        children: parent.children.map((child) => (child === targetTileId ? splitId : child)),
      },
    },
    tileId: leafId,
  };
}

/**
 * Remove a leaf and collapse the split it leaves behind: a split down to one
 * child is replaced by that child in the grandparent's slot, and a collapse that
 * reaches the root promotes the survivor's content into the root id. Removing
 * the root leaf itself empties it instead — the root always exists.
 */
export function withoutTileLeaf(layout: TileLayout, tileId: string): TileLayout | null {
  const node = layout[tileId];
  if (node === undefined || node.dir !== null) return null;

  if (tileId === ROOT_TILE_ID) {
    if (node.surface === null) return null;
    return { ...layout, [ROOT_TILE_ID]: tileLeaf(ROOT_TILE_ID, null) };
  }

  const next: Record<string, TileNode> = { ...layout };
  delete next[tileId];
  return pruneFromParent(next, layout, tileId);
}

/** Detach `childId` from its parent, then collapse the parent when it thins out. */
function pruneFromParent(
  next: Record<string, TileNode>,
  layout: TileLayout,
  childId: string,
): TileLayout | null {
  const parentId = tileParentId(layout, childId);
  if (parentId === null) return next;
  const parent = next[parentId];
  if (parent === undefined) return next;

  const index = parent.children.indexOf(childId);
  const children = parent.children.filter((child) => child !== childId);
  const ratios = parent.ratios.filter((_, position) => position !== index);

  if (children.length > 1) {
    next[parentId] = { ...parent, children, ratios };
    return next;
  }

  const survivorId = children[0];
  if (survivorId === undefined) {
    // A childless split is structurally dead: prune it the same way.
    delete next[parentId];
    return pruneFromParent(next, layout, parentId);
  }
  const survivor = next[survivorId];
  if (survivor === undefined) return next;

  if (parentId === ROOT_TILE_ID) {
    delete next[survivorId];
    next[ROOT_TILE_ID] = { ...survivor, id: ROOT_TILE_ID };
    return next;
  }

  const grandparentId = tileParentId(layout, parentId);
  if (grandparentId === null) return next;
  const grandparent = next[grandparentId];
  if (grandparent === undefined) return next;
  delete next[parentId];
  next[grandparentId] = {
    ...grandparent,
    children: grandparent.children.map((child) => (child === parentId ? survivorId : child)),
  };
  return next;
}

/**
 * Exchange what two leaves hold. This is what CENTER means on an occupied target: the
 * carried surface takes the exact spot it was released on and the occupant takes the seat
 * the carry came from. Only the two `surface` fields move — ids, splits and ratios are
 * untouched — so every collaborator's tree keeps the same shape and the same identities.
 *
 * Both ids must name LEAVES: a split holds structure, never content, so there is nothing
 * in one to trade. Naming the same leaf twice is refused rather than answered with the
 * layout unchanged, because an exchange with itself is exactly the silent no-op the
 * placement algebra refuses to have.
 */
export function withTilesSwapped(
  layout: TileLayout,
  aTileId: string,
  bTileId: string,
): TileLayout | null {
  if (aTileId === bTileId) return null;
  const a = layout[aTileId];
  const b = layout[bTileId];
  if (a === undefined || b === undefined) return null;
  if (a.dir !== null || b.dir !== null) return null;
  return {
    ...layout,
    [aTileId]: { ...a, surface: b.surface },
    [bTileId]: { ...b, surface: a.surface },
  };
}

/**
 * Replace one leaf's occupant. This is the half of a swap that CROSSES containers: two
 * documents cannot share a transaction, so an exchange between two trees is written as
 * one of these per side and each room fans its own update out. Within a single tree
 * `withTilesSwapped` is the whole operation and this is not the way to spell it.
 */
export function withTileLeafSurface(
  layout: TileLayout,
  tileId: string,
  surface: TileSurface | null,
): TileLayout | null {
  const node = layout[tileId];
  if (node === undefined || node.dir !== null) return null;
  return { ...layout, [tileId]: { ...node, surface } };
}

/** Resize a split; ratios must stay parallel to its children and strictly positive. */
export function withTileRatios(
  layout: TileLayout,
  splitId: string,
  ratios: readonly number[],
): TileLayout | null {
  const split = layout[splitId];
  if (split === undefined || split.dir === null) return null;
  if (ratios.length !== split.children.length) return null;
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) return null;
  return { ...layout, [splitId]: { ...split, ratios: [...ratios] } };
}

// ------------------------------------------------------------------ doc access

/** Parses and structurally validates the stored tree; invalid or absent → null. */
export function readTileLayout(doc: Y.Doc, containerId?: string): TileLayout | null {
  const map = layoutMap(doc);
  if (map.size === 0) return null;
  const parsed = TileLayoutSchema.safeParse(map.toJSON());
  if (!parsed.success) return null;
  return validateTileLayout(parsed.data, containerId) ? parsed.data : null;
}

/**
 * Seeds a tiled container with a single empty leaf. A tree that fails validation
 * is unusable, so it is replaced rather than left stranding the room.
 */
export function initTiledLayout(doc: Y.Doc, origin: unknown): void {
  if (readTileLayout(doc) !== null) return;
  applyTileLayout(doc, emptyTileLayout(), origin);
}

/** Places `surface` per `edge`; returns the new tile id, or null when rejected. */
export function writeTileLeaf(
  doc: Y.Doc,
  surface: TileSurface,
  targetTileId: string,
  edge: TileEdge,
  origin: unknown,
): string | null {
  const layout = readTileLayout(doc) ?? emptyTileLayout();
  const inserted = withTileLeaf(layout, surface, targetTileId, edge);
  if (inserted === null) return null;
  applyTileLayout(doc, inserted.layout, origin);
  return inserted.tileId;
}

export function removeTileLeaf(doc: Y.Doc, tileId: string, origin: unknown): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withoutTileLeaf(layout, tileId);
  if (next === null) return false;
  applyTileLayout(doc, next, origin);
  return true;
}

/** Exchanges two leaves' occupants in one transaction; false when either refuses. */
export function swapTileLeaves(
  doc: Y.Doc,
  aTileId: string,
  bTileId: string,
  origin: unknown,
): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withTilesSwapped(layout, aTileId, bTileId);
  if (next === null) return false;
  applyTileLayout(doc, next, origin);
  return true;
}

/** Writes one leaf's occupant: the per-document half of a cross-container exchange. */
export function writeTileLeafSurface(
  doc: Y.Doc,
  tileId: string,
  surface: TileSurface | null,
  origin: unknown,
): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withTileLeafSurface(layout, tileId, surface);
  if (next === null) return false;
  applyTileLayout(doc, next, origin);
  return true;
}

export function setTileRatios(
  doc: Y.Doc,
  splitId: string,
  ratios: readonly number[],
  origin: unknown,
): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withTileRatios(layout, splitId, ratios);
  if (next === null) return false;
  applyTileLayout(doc, next, origin);
  return true;
}

/**
 * Diffs a whole node table into the doc: only changed fields are written, so a
 * ratio drag touches one key and never churns the tiles around it.
 */
export function applyTileLayout(doc: Y.Doc, next: TileLayout, origin: unknown): void {
  const map = layoutMap(doc);
  doc.transact(() => {
    for (const id of [...map.keys()]) {
      if (next[id] === undefined) map.delete(id);
    }
    for (const node of Object.values(next)) {
      const existing = map.get(node.id);
      if (existing instanceof Y.Map) {
        updateTileFields(existing, node);
      } else {
        // A fresh map is not integrated yet, so it is filled blind: reading a
        // detached Yjs type is an invalid access.
        const created = new Y.Map<unknown>();
        created.set("id", node.id);
        created.set("dir", node.dir);
        created.set("ratios", [...node.ratios]);
        created.set("children", [...node.children]);
        created.set("surface", node.surface === null ? null : { ...node.surface });
        map.set(node.id, created);
      }
    }
  }, origin);
}

/** Writes only the fields that actually changed, so untouched tiles never churn. */
function updateTileFields(map: Y.Map<unknown>, node: TileNode): void {
  if (map.get("id") !== node.id) map.set("id", node.id);
  if (map.get("dir") !== node.dir) map.set("dir", node.dir);
  if (!sameJson(map.get("ratios"), node.ratios)) map.set("ratios", [...node.ratios]);
  if (!sameJson(map.get("children"), node.children)) map.set("children", [...node.children]);
  if (!sameJson(map.get("surface"), node.surface)) {
    map.set("surface", node.surface === null ? null : { ...node.surface });
  }
}

/** Structural comparison for the plain arrays/objects stored inside tile nodes. */
function sameJson(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (current === null || next === null || current === undefined || next === undefined) {
    return false;
  }
  if (typeof current !== "object" || typeof next !== "object") return false;
  return JSON.stringify(current) === JSON.stringify(next);
}
