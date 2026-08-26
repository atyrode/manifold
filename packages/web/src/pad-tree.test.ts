import { expect, test } from "bun:test";
import type { PadTreeItem } from "@manifold/protocol";
import { buildPadTree, projectPadTreeMove, treeItemId, type PadTreeNode } from "./pad-tree.ts";

const pad = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<PadTreeItem, { kind: "pad" }> => ({
  kind: "pad",
  pad: { id, name: id, createdAt: sortOrder },
  parentId,
  sortOrder,
});

const folder = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<PadTreeItem, { kind: "folder" }> => ({
  kind: "folder",
  id,
  name: id,
  createdAt: sortOrder,
  parentId,
  sortOrder,
});

const shape = (nodes: readonly PadTreeNode[]): unknown =>
  nodes.map((node) => [`${node.item.kind}:${treeItemId(node.item)}`, shape(node.children)]);

test("builds one ordered recursive tree from mixed pad and folder siblings", () => {
  expect(
    shape(
      buildPadTree([
        pad("loose", null, 2),
        folder("projects", null, 1),
        pad("active", "projects", 0),
        folder("archive", "projects", 1),
        pad("old", "archive", 0),
      ]),
    ),
  ).toEqual([
    [
      "folder:projects",
      [
        ["pad:active", []],
        ["folder:archive", [["pad:old", []]]],
      ],
    ],
    ["pad:loose", []],
  ]);
});

test("emits malformed or duplicate input at most once without recursing forever", () => {
  const nodes = buildPadTree([
    folder("cycle-a", "cycle-b", 0),
    folder("cycle-b", "cycle-a", 0),
    pad("orphan", "missing", 1),
    pad("same-id", "same-id", 0),
    folder("same-id", null, 2),
    pad("orphan", null, 99),
  ]);
  const flattened: string[] = [];
  const visit = (entries: readonly PadTreeNode[]): void => {
    for (const node of entries) {
      flattened.push(`${node.item.kind}:${treeItemId(node.item)}`);
      visit(node.children);
    }
  };
  visit(nodes);
  expect(flattened).toHaveLength(5);
  expect(new Set(flattened).size).toBe(5);
  expect(flattened).toContain("pad:same-id");
  expect(flattened).toContain("folder:same-id");
});

test("projects a pad move into a folder and closes both sibling orderings", () => {
  const first = pad("first", null, 0);
  const moved = pad("moved", null, 1);
  const target = folder("target", null, 2);
  const child = pad("child", "target", 0);
  const items: PadTreeItem[] = [first, moved, target, child];

  expect(projectPadTreeMove(items, { kind: "pad", id: "moved" }, "target", 0)).toEqual([
    first,
    { ...moved, parentId: "target", sortOrder: 0 },
    { ...target, sortOrder: 1 },
    { ...child, sortOrder: 1 },
  ]);
});

test("projects folder reordering among its current siblings", () => {
  const first = folder("first", null, 0);
  const moved = folder("moved", null, 1);
  const last = pad("last", null, 2);
  const items: PadTreeItem[] = [first, moved, last];

  expect(projectPadTreeMove(items, { kind: "folder", id: "moved" }, null, 0)).toEqual([
    { ...first, sortOrder: 1 },
    { ...moved, sortOrder: 0 },
    last,
  ]);
});
