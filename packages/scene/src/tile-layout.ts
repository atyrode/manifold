import {
  ROOT_TILE_ID,
  TileLayoutSchema,
  validateTileLayout,
  type Tile,
  type TileEdge,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";
import * as Y from "yjs";

/**
 * The ONLY Yjs code for compositions. Split/collapse math is pure and lives
 * beside the doc writers so it can be unit-tested without a document; the doc
 * writers are thin appliers that diff the pure result into the shared map.
 *
 * Structural writes are server-authored (they arrive over HTTP), so tile ids are
 * allocated deterministically from the current tile table — one writer, no
 * id races. Ratio drags are the only client-authored mutation.
 */

/** Yjs root key holding a composition's tile table; canvases never allocate it. */
export const LAYOUT_KEY = "layout";

export function layoutMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(LAYOUT_KEY);
}

// ------------------------------------------------------------------ pure math

/** A fresh tree: the root is one empty leaf that renders as a drop hint. */
export function emptyTileLayout(): TileLayout {
  return { [ROOT_TILE_ID]: tileLeaf(ROOT_TILE_ID, null) };
}

export function tileLeaf(id: string, ref: TileRef | null): Tile {
  return { id, dir: null, ratios: [], children: [], ref };
}

/** Parent of `tileId`, or null for the root and for unreachable garbage. */
export function tileParentId(layout: TileLayout, tileId: string): string | null {
  for (const tile of Object.values(layout)) {
    if (tile.children.includes(tileId)) return tile.id;
  }
  return null;
}

/** Leaf ids in tree order; the bubble rules count these. */
export function tileLeafIds(layout: TileLayout): string[] {
  const leaves: string[] = [];
  const walk = (id: string): void => {
    const tile = layout[id];
    if (tile === undefined) return;
    if (tile.dir === null) {
      leaves.push(tile.id);
      return;
    }
    for (const child of tile.children) walk(child);
  };
  walk(ROOT_TILE_ID);
  return leaves;
}

/**
 * Do two refs name the SAME item? Exhaustive over the union by construction, so a
 * new tileable form cannot be added without deciding what its identity is.
 */
export function sameTileRef(a: TileRef, b: TileRef): boolean {
  switch (a.kind) {
    case "terminal":
      return b.kind === "terminal" && a.terminalId === b.terminalId;
    case "container":
      return b.kind === "container" && a.containerId === b.containerId;
    case "text":
      return b.kind === "text" && a.elementId === b.elementId;
    case "panel":
      return b.kind === "panel" && a.panelId === b.panelId;
    case "spacer":
      // Every spacer is interchangeable with every other — the same reason the identity
      // question has no per-instance data to compare.
      return b.kind === "spacer";
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

/**
 * Leaf id showing `ref`, in tree order; null when the container does not show it.
 * Placement truth for a terminal lives HERE and in the element table — never on a
 * terminal record, which one id could only ever describe partially.
 */
export function tileIdForRef(layout: TileLayout | null, ref: TileRef): string | null {
  if (layout === null) return null;
  for (const tileId of tileLeafIds(layout)) {
    const found = layout[tileId]?.ref ?? null;
    if (found !== null && sameTileRef(found, ref)) return tileId;
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
  /** Tile id of the inserted ref; the placement id callers hand back. */
  readonly tileId: string;
}

/**
 * Insert `ref` next to `targetTileId`. `center` fills a vacant leaf in place;
 * a CROSS-axis edge wraps the target in a new two-way split, while a SAME-axis
 * edge joins the parent split as a flat sibling (see the branch note below).
 * `between` picks the interior same-axis ratio rule: wedge between both neighbors
 * (thirds) instead of splitting the target's own share.
 *
 * The root id is immovable, so splitting the root moves the root's own content
 * into a fresh leaf and turns the root into the split. Splitting any other tile
 * keeps that tile's id — only a cross-axis wrapper is ever new.
 */
export function withTileLeaf(
  layout: TileLayout,
  ref: TileRef,
  targetTileId: string,
  edge: TileEdge,
  between = false,
): TileInsert | null {
  return insertLeaf(layout, ref, targetTileId, edge, between);
}

/**
 * The layout that would result from dropping SOMETHING at `edge` of `targetTileId`,
 * with the landing leaf left VACANT. Preview-only: the same tree surgery `withTileLeaf`
 * performs — one private implementation, two public entry points — so a preview can
 * never describe a shape the write would not produce. `withTileLeaf` keeps its
 * non-null `ref` on purpose: it underlies the server's only structural tile
 * write, and a nullable ref must never be able to reach a doc write.
 */
export function withVacantLeaf(
  layout: TileLayout,
  targetTileId: string,
  edge: TileEdge,
  between = false,
): { readonly layout: TileLayout; readonly vacantLeafId: string } | null {
  const inserted = insertLeaf(layout, null, targetTileId, edge, between);
  return inserted === null ? null : { layout: inserted.layout, vacantLeafId: inserted.tileId };
}

/** The one tree surgery behind both entry points above. */
function insertLeaf(
  layout: TileLayout,
  ref: TileRef | null,
  targetTileId: string,
  edge: TileEdge,
  between: boolean,
): TileInsert | null {
  const target = layout[targetTileId];
  if (target === undefined) return null;

  if (edge === "center") {
    if (target.dir !== null || target.ref !== null) return null;
    return {
      layout: { ...layout, [targetTileId]: { ...target, ref } },
      tileId: targetTileId,
    };
  }

  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const leading = edge === "left" || edge === "top";
  const leafId = nextTileId(layout);
  const leaf = tileLeaf(leafId, ref);

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
          ref: null,
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
    the new leaf is spliced in BESIDE the target. Cross-axis edges keep wrapping
    below — that IS the nesting gesture — and the root keeps its wrap in the
    branch above, so grouping a whole composition under a fresh split stays
    reachable at the area's ring.

    The share the newcomer takes says what the gesture MEANT, and distance from the
    seam is what says it (`between`). A drop ON the seam band wedges the newcomer
    BETWEEN the two siblings: both cede a third and it arrives an equal citizen
    (equal neighbors yield exact thirds). A drop deeper into the target's flank —
    or at a row's end, where there is no neighbor — splits the TARGET's own space:
    it cedes half and nobody else moves, which is the `(A|C)|B`-shaped outcome
    that reads as splitting one pane.
  */
  if (parent.dir === dir) {
    const index = parent.children.indexOf(targetTileId);
    if (index < 0) return null;
    const targetRatio = parent.ratios[index] ?? 1;
    const children = [...parent.children];
    const ratios = [...parent.ratios];
    const neighborIndex = leading ? index - 1 : index + 1;
    const neighborRatio = parent.ratios[neighborIndex];
    if (between && neighborIndex >= 0 && neighborIndex < parent.children.length) {
      // Between: the newcomer sits between target and neighbor; both cede a third.
      const grown = (targetRatio + (neighborRatio ?? 1)) / 3;
      ratios[index] = (targetRatio * 2) / 3;
      ratios[neighborIndex] = ((neighborRatio ?? 1) * 2) / 3;
      children.splice(leading ? index : index + 1, 0, leafId);
      ratios.splice(leading ? index : index + 1, 0, grown);
    } else {
      children.splice(leading ? index : index + 1, 0, leafId);
      ratios.splice(leading ? index : index + 1, 0, targetRatio / 2);
      ratios[leading ? index + 1 : index] = targetRatio / 2;
    }
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
        ref: null,
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
 * child is replaced by that child in the grandparent's seat, and a collapse that
 * reaches the root promotes the survivor's content into the root id. Removing
 * the root leaf itself empties it instead — the root always exists.
 */
export function withoutTileLeaf(layout: TileLayout, tileId: string): TileLayout | null {
  const tile = layout[tileId];
  if (tile === undefined || tile.dir !== null) return null;

  if (tileId === ROOT_TILE_ID) {
    if (tile.ref === null) return null;
    return { ...layout, [ROOT_TILE_ID]: tileLeaf(ROOT_TILE_ID, null) };
  }

  const next: Record<string, Tile> = { ...layout };
  delete next[tileId];
  return pruneFromParent(next, layout, tileId);
}

/** Detach `childId` from its parent, then collapse the parent when it thins out. */
function pruneFromParent(
  next: Record<string, Tile>,
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
 * carried ref takes the exact spot it was released on and the occupant takes the seat
 * the carry came from. Only the two `ref` fields move — ids, splits and ratios are
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
    [aTileId]: { ...a, ref: b.ref },
    [bTileId]: { ...b, ref: a.ref },
  };
}

/**
 * Replace one leaf's occupant. This is the half of a swap that CROSSES containers: two
 * documents cannot share a transaction, so an exchange between two trees is written as
 * one of these per side and each room fans its own update out. Within a single tree
 * `withTilesSwapped` is the whole operation and this is not the way to spell it.
 */
export function withTileLeafRef(
  layout: TileLayout,
  tileId: string,
  ref: TileRef | null,
): TileLayout | null {
  const tile = layout[tileId];
  if (tile === undefined || tile.dir !== null) return null;
  return { ...layout, [tileId]: { ...tile, ref } };
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
 * Seeds a composition with a single vacant leaf. A tree that fails validation
 * is unusable, so it is replaced rather than left stranding the room.
 *
 * The seed is valid by construction, so `applyTileLayout` can never refuse it and
 * there is nothing here for a caller to handle: this stays void.
 */
export function initCompositionLayout(doc: Y.Doc, origin: unknown): void {
  if (readTileLayout(doc) !== null) return;
  applyTileLayout(doc, emptyTileLayout(), origin);
}

/** Places `ref` per `edge`; returns the new tile id, or null when rejected. */
export function writeTileLeaf(
  doc: Y.Doc,
  ref: TileRef,
  targetTileId: string,
  edge: TileEdge,
  origin: unknown,
  between = false,
): string | null {
  const layout = readTileLayout(doc) ?? emptyTileLayout();
  const inserted = withTileLeaf(layout, ref, targetTileId, edge, between);
  if (inserted === null) return null;
  if (!applyTileLayout(doc, inserted.layout, origin)) return null;
  return inserted.tileId;
}

export function removeTileLeaf(doc: Y.Doc, tileId: string, origin: unknown): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withoutTileLeaf(layout, tileId);
  if (next === null) return false;
  if (!applyTileLayout(doc, next, origin)) return false;
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
  if (!applyTileLayout(doc, next, origin)) return false;
  return true;
}

/** Writes one leaf's occupant: the per-document half of a cross-container exchange. */
export function writeTileLeafRef(
  doc: Y.Doc,
  tileId: string,
  ref: TileRef | null,
  origin: unknown,
): boolean {
  const layout = readTileLayout(doc);
  if (layout === null) return false;
  const next = withTileLeafRef(layout, tileId, ref);
  if (next === null) return false;
  if (!applyTileLayout(doc, next, origin)) return false;
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
  if (!applyTileLayout(doc, next, origin)) return false;
  return true;
}

/**
 * Diffs a whole tile table into the doc: only changed fields are written, so a
 * ratio drag touches one key and never churns the tiles around it.
 *
 * REFUSES a table the read side could not read back, before touching the doc, and
 * answers false. This is the only door into the stored tree and a CRDT keeps no
 * prior state to fall back to, so a persisted invalid table is not a failed write —
 * it is a permanently empty container for EVERY peer, with no undo. Refusing costs
 * one gesture; persisting costs the room. The pure surgery above is total, but it
 * gained a `between` parameter recently and the next one is an off-by-one away, so
 * the write gate is defence in depth rather than a restatement of it. It is not
 * only hypothetical today: `insertLeaf`'s same-axis branch splices a sibling into a
 * flat row with no fan-out bound, so a 17th child would clear every pure guard and
 * then fail `MAX_TILE_CHILDREN` on read.
 *
 * The gate is `readTileLayout`'s own predicate, reused rather than restated: the
 * schema carries runtime facts the TS type does not (positive ratios, non-empty
 * ids, `MAX_TILE_CHILDREN`), so re-deriving them here would be a second copy of the
 * document's shape, free to drift from the one that decides readability. Only
 * `.success` is consumed; the parsed clone is discarded. Cost is ~6 µs on a typical
 * table and ~24 µs on the widest legal one, which a divider drag can afford once
 * per pointer frame.
 *
 * `containerId`'s self-reference rule is deliberately NOT enforced here: doc access
 * never learns which container it writes. `readTileLayout` enforces it where the
 * caller knows the id, and a container tiling itself renders as a hole rather than
 * bricking the tree, so it is not this gate's business.
 */
export function applyTileLayout(doc: Y.Doc, next: TileLayout, origin: unknown): boolean {
  if (!TileLayoutSchema.safeParse(next).success || !validateTileLayout(next)) return false;
  const map = layoutMap(doc);
  doc.transact(() => {
    for (const id of [...map.keys()]) {
      if (next[id] === undefined) map.delete(id);
    }
    for (const tile of Object.values(next)) {
      const existing = map.get(tile.id);
      if (existing instanceof Y.Map) {
        updateTileFields(existing, tile);
      } else {
        // A fresh map is not integrated yet, so it is filled blind: reading a
        // detached Yjs type is an invalid access.
        const created = new Y.Map<unknown>();
        created.set("id", tile.id);
        created.set("dir", tile.dir);
        created.set("ratios", [...tile.ratios]);
        created.set("children", [...tile.children]);
        created.set("ref", tile.ref === null ? null : { ...tile.ref });
        map.set(tile.id, created);
      }
    }
  }, origin);
  return true;
}

/**
 * Writes only the fields that actually changed, so untouched tiles never churn.
 *
 * `sections` is deliberately NOT among them. A tile's section arrangement is PER-PRINCIPAL
 * workspace data (protocol layout.ts): it lives on the tree `core.space.setLayout` stores
 * per principal, and a composition document is shared state every occupant merges into. One
 * reader's arrangement written there would be everyone's, so the composition writer drops it
 * on the floor on purpose — the field cannot reach this path today, and the day something
 * tries, this is the line that says the answer is no rather than yes-by-omission.
 */
function updateTileFields(map: Y.Map<unknown>, tile: Tile): void {
  if (map.get("id") !== tile.id) map.set("id", tile.id);
  if (map.get("dir") !== tile.dir) map.set("dir", tile.dir);
  if (!sameJson(map.get("ratios"), tile.ratios)) map.set("ratios", [...tile.ratios]);
  if (!sameJson(map.get("children"), tile.children)) map.set("children", [...tile.children]);
  if (!sameJson(map.get("ref"), tile.ref)) {
    map.set("ref", tile.ref === null ? null : { ...tile.ref });
  }
}

/** Structural comparison for the plain arrays/objects stored inside tiles. */
function sameJson(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (current === null || next === null || current === undefined || next === undefined) {
    return false;
  }
  if (typeof current !== "object" || typeof next !== "object") return false;
  return JSON.stringify(current) === JSON.stringify(next);
}
