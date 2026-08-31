import { expect, test } from "bun:test";
import type { PadTreeItem } from "@manifold/protocol";
import {
  buildPadTree,
  projectPadTreeMove,
  samePadTreeItems,
  treeItemId,
  type PadTreeNode,
} from "../src/pad-tree.ts";

const pad = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<PadTreeItem, { kind: "pad" }> => ({
  kind: "pad",
  pad: { id, name: id, createdAt: sortOrder, layout: "canvas" },
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

const composition = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<PadTreeItem, { kind: "pad" }> => ({
  kind: "pad",
  pad: { id, name: id, createdAt: sortOrder, layout: "tiled" },
  parentId,
  sortOrder,
});

test("indexes every container in one tree: folders hold pads and compositions alike", () => {
  expect(
    shape(
      buildPadTree([
        composition("loose-composition", null, 3),
        folder("projects", null, 0),
        pad("board", "projects", 0),
        composition("nested-composition", "projects", 1),
        pad("loose-pad", null, 1),
      ]),
    ),
  ).toEqual([
    [
      "folder:projects",
      [
        ["pad:board", []],
        ["pad:nested-composition", []],
      ],
    ],
    ["pad:loose-pad", []],
    ["pad:loose-composition", []],
  ]);
});

test("a drop index over the unified rows is the stored sibling index", () => {
  const siblings: PadTreeItem[] = [
    pad("first", null, 0),
    composition("second", null, 1),
    pad("third", null, 2),
  ];
  // Nothing is hidden, so a move projected at the index read from the rows lands exactly there:
  // the composition drops between the two pads without stepping over anything.
  expect(
    projectPadTreeMove(siblings, { kind: "pad", id: "third" }, null, 1).map((item) => [
      treeItemId(item),
      item.sortOrder,
    ]),
  ).toEqual([
    ["first", 0],
    ["second", 2],
    ["third", 1],
  ]);
});

/**
 * The index is polled, so this comparison is what keeps an unchanged workspace from rebuilding
 * the sidebar every couple of seconds — and what guarantees a real change still gets through.
 */
test("two identical index snapshots compare equal across fetches", () => {
  const first: PadTreeItem[] = [folder("projects", null, 0), pad("notes", "projects", 0)];
  const second: PadTreeItem[] = [folder("projects", null, 0), pad("notes", "projects", 0)];
  expect(samePadTreeItems(first, second)).toBe(true);
  expect(samePadTreeItems(first, first)).toBe(true);
});

test("a container another tab created reaches the sidebar", () => {
  const before: PadTreeItem[] = [pad("notes", null, 0)];
  expect(samePadTreeItems(before, [...before, composition("build", null, 1)])).toBe(false);
});

test("every field a row paints from is compared: name, discipline, placement, order", () => {
  const row = pad("notes", null, 0);
  const base: PadTreeItem[] = [row];
  const withPad = (fields: Partial<(typeof row)["pad"]>): PadTreeItem[] => [
    { ...row, pad: { ...row.pad, ...fields } },
  ];

  expect(samePadTreeItems(base, withPad({ name: "journal" }))).toBe(false);
  expect(samePadTreeItems(base, withPad({ layout: "tiled" }))).toBe(false);
  expect(samePadTreeItems(base, [{ ...row, parentId: "projects" }])).toBe(false);
  expect(samePadTreeItems(base, [{ ...row, sortOrder: 1 }])).toBe(false);
});

test("a reordered index is a changed index, not the same set", () => {
  const left: PadTreeItem[] = [pad("a", null, 0), pad("b", null, 1)];
  const right: PadTreeItem[] = [
    { ...pad("b", null, 1), sortOrder: 0 },
    { ...pad("a", null, 0), sortOrder: 1 },
  ];
  expect(samePadTreeItems(left, right)).toBe(false);
});

test("a folder and a pad that share an id are never the same row", () => {
  expect(samePadTreeItems([pad("shared", null, 0)], [folder("shared", null, 0)])).toBe(false);
});
