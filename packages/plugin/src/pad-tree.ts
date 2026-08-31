/**
 * Workspace-index shaping — the pure fold from the flat `PadTreeItem[]` the index door
 * answers with into the tree a viewer sees, plus the content comparison a poll needs.
 *
 * It lives in the ENGINE because both halves of the workspace genuinely need it and neither
 * may import the other: the shell compares index snapshots so a repeated answer never
 * reseeds the renderers below it, and the plugin that renders the index builds its rows and
 * projects its own moves from the same functions. Two copies of "are these the same index?"
 * is the drift this move exists to prevent (AGENTS.md invariant 14).
 */
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

/**
 * Whether two index snapshots say the same thing. The tree is polled, so most responses repeat
 * the previous one verbatim; committing those would rebuild the headless tree — and blow away
 * an in-flight rename or drag — several times a second for no change at all. Field-by-field
 * rather than a stringify: this runs on a timer, and every field of both variants is scalar.
 */
export function samePadTreeItems(
  left: readonly PadTreeItem[],
  right: readonly PadTreeItem[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  // Order is the server's own ordering, not a set: a reordered index is a changed index.
  for (let index = 0; index < left.length; index += 1) {
    if (!samePadTreeItem(left[index], right[index])) return false;
  }
  return true;
}

function samePadTreeItem(left: PadTreeItem | undefined, right: PadTreeItem | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.parentId !== right.parentId || left.sortOrder !== right.sortOrder) return false;
  if (left.kind === "pad") {
    return (
      right.kind === "pad" &&
      left.pad.id === right.pad.id &&
      left.pad.name === right.pad.name &&
      left.pad.createdAt === right.pad.createdAt &&
      left.pad.layout === right.pad.layout
    );
  }
  return (
    right.kind === "folder" &&
    left.id === right.id &&
    left.name === right.name &&
    left.createdAt === right.createdAt
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

/**
 * Builds one deterministic tree and emits every item exactly once, even for malformed input.
 *
 * The tree is the sidebar's whole index: folders plus every container, pad or composition alike —
 * one object, two disciplines, told apart by the row's glyph, and a folder holds either. Because no
 * sibling is hidden, an insertion index read from the rendered rows IS the server's sibling index.
 */
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
