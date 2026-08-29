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
 * Leaf id showing `surface`, in tree order; null when the container does not show it.
 * Placement truth for a session lives HERE and in the element table — never on a
 * session record, which one id could only ever describe partially.
 */
export function tileIdForSurface(layout: TileLayout | null, surface: TileSurface): string | null {
  if (layout === null) return null;
  for (const tileId of tileLeafIds(layout)) {
    const found = layout[tileId]?.surface;
    if (found === undefined || found === null || found.kind !== surface.kind) continue;
    if (found.kind === "terminal" && surface.kind === "terminal") {
      if (found.sessionId === surface.sessionId) return tileId;
      continue;
    }
    if (found.kind === "pad" && surface.kind === "pad" && found.padId === surface.padId) {
      return tileId;
    }
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
 * an edge wraps the target in a new split holding the target and the new leaf.
 *
 * The root id is immovable, so splitting the root moves the root's own content
 * into a fresh leaf and turns the root into the split. Splitting any other tile
 * keeps that tile's id — only the wrapper is new.
 */
export function withTileLeaf(
  layout: TileLayout,
  surface: TileSurface,
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
