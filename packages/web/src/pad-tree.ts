import type { PadTreeItem } from "@manifold/protocol";

export interface PadTreeNode {
  readonly item: PadTreeItem;
  readonly children: readonly PadTreeNode[];
}

export function treeItemId(item: PadTreeItem): string {
  return item.kind === "pad" ? item.pad.id : item.id;
}

function treeItemCreatedAt(item: PadTreeItem): number {
  return item.kind === "pad" ? item.pad.createdAt : item.createdAt;
}
function treeItemKey(item: PadTreeItem): string {
  return `${item.kind}:${treeItemId(item)}`;
}

function compareTreeItems(left: PadTreeItem, right: PadTreeItem): number {
  return (
    left.sortOrder - right.sortOrder ||
    treeItemCreatedAt(left) - treeItemCreatedAt(right) ||
    treeItemId(left).localeCompare(treeItemId(right))
  );
}

function placeTreeItem(item: PadTreeItem, parentId: string | null, sortOrder: number): PadTreeItem {
  return { ...item, parentId, sortOrder };
}

export interface PadTreeMove {
  readonly kind: "pad" | "folder";
  readonly id: string;
}

/** Projects the server's atomic sibling move locally so a successful drop paints immediately. */
export function projectPadTreeMove(
  items: readonly PadTreeItem[],
  moved: PadTreeMove,
  parentId: string | null,
  index: number,
): readonly PadTreeItem[] {
  const movedKey = `${moved.kind}:${moved.id}`;
  const movedItem = items.find((item) => treeItemKey(item) === movedKey);
  if (movedItem === undefined) return items;

  const oldParentId = movedItem.parentId;
  const placements = new Map<
    string,
    { readonly parentId: string | null; readonly sortOrder: number }
  >();
  const siblings = (candidateParentId: string | null): PadTreeItem[] =>
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

function hasValidParent(item: PadTreeItem, folders: ReadonlyMap<string, PadTreeItem>): boolean {
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

/** Builds one deterministic tree and emits every item exactly once, even for malformed input. */
export function buildPadTree(items: readonly PadTreeItem[]): readonly PadTreeNode[] {
  const unique = new Map<string, PadTreeItem>();
  for (const item of items) {
    const key = `${item.kind}:${treeItemId(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const values = [...unique.values()];
  const folders = new Map(
    values.filter((item) => item.kind === "folder").map((item) => [item.id, item] as const),
  );
  const children = new Map<string | null, PadTreeItem[]>();
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
  const build = (parentId: string | null): PadTreeNode[] =>
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
