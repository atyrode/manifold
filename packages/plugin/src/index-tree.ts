/**
 * Workspace-index shaping — the pure fold from the flat `IndexEntry[]` the index door
 * answers with into the tree a viewer sees, plus the content comparison a poll needs.
 *
 * It lives in the ENGINE because both halves of the workspace genuinely need it and neither
 * may import the other: the shell compares index snapshots so a repeated answer never
 * reseeds the renderers below it, and the plugin that renders the index builds its rows and
 * projects its own moves from the same functions. Two copies of "are these the same index?"
 * is the drift this move exists to prevent (AGENTS.md invariant 14).
 */
import type { IndexEntry } from "@manifold/protocol";

export interface IndexBranch {
  readonly item: IndexEntry;
  readonly children: readonly IndexBranch[];
}

export function treeItemId(item: IndexEntry): string {
  return item.kind === "container" ? item.container.id : item.id;
}

function treeItemCreatedAt(item: IndexEntry): number {
  return item.kind === "container" ? item.container.createdAt : item.createdAt;
}
function treeItemKey(item: IndexEntry): string {
  return `${item.kind}:${treeItemId(item)}`;
}

function compareTreeItems(left: IndexEntry, right: IndexEntry): number {
  return (
    left.sortOrder - right.sortOrder ||
    treeItemCreatedAt(left) - treeItemCreatedAt(right) ||
    treeItemId(left).localeCompare(treeItemId(right))
  );
}

/**
 * Whether two index snapshots say the same thing. The tree is polled, so most responses repeat
 * the previous one verbatim; committing those would rebuild the headless tree — and blow away
 * an in-flight rename or drag — several times a second for no change at all. Field-by-field
 * rather than a stringify: this runs on a timer, and every field of both variants is scalar.
 */
export function sameIndexEntries(
  left: readonly IndexEntry[],
  right: readonly IndexEntry[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  // Order is the server's own ordering, not a set: a reordered index is a changed index.
  for (let index = 0; index < left.length; index += 1) {
    if (!sameIndexEntry(left[index], right[index])) return false;
  }
  return true;
}

function sameIndexEntry(left: IndexEntry | undefined, right: IndexEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.parentId !== right.parentId || left.sortOrder !== right.sortOrder) return false;
  if (left.kind === "container") {
    return (
      right.kind === "container" &&
      left.container.id === right.container.id &&
      left.container.name === right.container.name &&
      left.container.createdAt === right.container.createdAt &&
      left.container.discipline === right.container.discipline
    );
  }
  return (
    right.kind === "folder" &&
    left.id === right.id &&
    left.name === right.name &&
    left.createdAt === right.createdAt
  );
}

function placeTreeItem(item: IndexEntry, parentId: string | null, sortOrder: number): IndexEntry {
  return { ...item, parentId, sortOrder };
}

export interface IndexMove {
  readonly kind: "container" | "folder";
  readonly id: string;
}

/** Projects the server's atomic sibling move locally so a successful drop paints immediately. */
export function projectIndexMove(
  items: readonly IndexEntry[],
  moved: IndexMove,
  parentId: string | null,
  index: number,
): readonly IndexEntry[] {
  const movedKey = `${moved.kind}:${moved.id}`;
  const movedItem = items.find((item) => treeItemKey(item) === movedKey);
  if (movedItem === undefined) return items;

  const oldParentId = movedItem.parentId;
  const placements = new Map<
    string,
    { readonly parentId: string | null; readonly sortOrder: number }
  >();
  const siblings = (candidateParentId: string | null): IndexEntry[] =>
    items
      .filter((item) => item.parentId === candidateParentId && treeItemKey(item) !== movedKey)
      .sort(compareTreeItems);

  if (oldParentId !== parentId) {
    siblings(oldParentId).forEach((item, sortOrder) => {
      placements.set(treeItemKey(item), { parentId: oldParentId, sortOrder });
    });
  }

  const targetSiblings = siblings(parentId);
  targetSiblings.splice(Math.max(0, Math.min(index, targetSiblings.length)), 0, movedItem);
  targetSiblings.forEach((item, sortOrder) => {
    placements.set(treeItemKey(item), { parentId, sortOrder });
  });

  return items.map((item) => {
    const placement = placements.get(treeItemKey(item));
    return placement === undefined
      ? item
      : placeTreeItem(item, placement.parentId, placement.sortOrder);
  });
}

function hasValidParent(item: IndexEntry, folders: ReadonlyMap<string, IndexEntry>): boolean {
  if (item.parentId === null) return false;
  const seen = new Set<string>(item.kind === "folder" ? [item.id] : []);
  let parentId: string | null = item.parentId;
  while (parentId !== null) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = folders.get(parentId);
    if (parent === undefined || parent.kind !== "folder") return false;
    parentId = parent.parentId;
  }
  return true;
}

/**
 * Builds one deterministic tree and emits every item exactly once, even for malformed input.
 *
 * The tree is the sidebar's whole index: folders plus every container, container or composition alike —
 * one object, two disciplines, told apart by the row's glyph, and a folder holds either. Because no
 * sibling is hidden, an insertion index read from the rendered rows IS the server's sibling index.
 */
export function buildIndexTree(items: readonly IndexEntry[]): readonly IndexBranch[] {
  const unique = new Map<string, IndexEntry>();
  for (const item of items) {
    const key = `${item.kind}:${treeItemId(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const values = [...unique.values()];
  const folders = new Map(
    values.filter((item) => item.kind === "folder").map((item) => [item.id, item] as const),
  );
  const children = new Map<string | null, IndexEntry[]>();
  for (const item of values) {
    const parentId = hasValidParent(item, folders) ? item.parentId : null;
    const siblings = children.get(parentId);
    if (siblings === undefined) children.set(parentId, [item]);
    else siblings.push(item);
  }
  for (const siblings of children.values()) {
    siblings.sort(compareTreeItems);
  }
  const emitted = new Set<string>();
  const build = (parentId: string | null): IndexBranch[] =>
    (children.get(parentId) ?? []).flatMap((item) => {
      const key = `${item.kind}:${treeItemId(item)}`;
      if (emitted.has(key)) return [];
      emitted.add(key);
      return [{ item, children: item.kind === "folder" ? build(item.id) : [] }];
    });
  const roots = build(null);
  for (const item of values) {
    const key = `${item.kind}:${treeItemId(item)}`;
    if (!emitted.has(key)) roots.push({ item, children: [] });
  }
  return roots;
}
