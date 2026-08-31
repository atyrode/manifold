import { expect, test } from "bun:test";
import type { IndexEntry } from "@manifold/protocol";
import {
  buildIndexTree,
  projectIndexMove,
  sameIndexEntries,
  treeItemId,
  type IndexBranch,
} from "../src/index-tree.ts";

const container = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<IndexEntry, { kind: "container" }> => ({
  kind: "container",
  container: { id, name: id, createdAt: sortOrder, discipline: "canvas" },
  parentId,
  sortOrder,
});

const folder = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<IndexEntry, { kind: "folder" }> => ({
  kind: "folder",
  id,
  name: id,
  createdAt: sortOrder,
  parentId,
  sortOrder,
});

const shape = (nodes: readonly IndexBranch[]): unknown =>
  nodes.map((node) => [`${node.item.kind}:${treeItemId(node.item)}`, shape(node.children)]);

test("builds one ordered recursive tree from mixed container and folder siblings", () => {
  expect(
    shape(
      buildIndexTree([
        container("loose", null, 2),
        folder("projects", null, 1),
        container("active", "projects", 0),
        folder("archive", "projects", 1),
        container("old", "archive", 0),
      ]),
    ),
  ).toEqual([
    [
      "folder:projects",
      [
        ["container:active", []],
        ["folder:archive", [["container:old", []]]],
      ],
    ],
    ["container:loose", []],
  ]);
});

test("emits malformed or duplicate input at most once without recursing forever", () => {
  const nodes = buildIndexTree([
    folder("cycle-a", "cycle-b", 0),
    folder("cycle-b", "cycle-a", 0),
    container("orphan", "missing", 1),
    container("same-id", "same-id", 0),
    folder("same-id", null, 2),
    container("orphan", null, 99),
  ]);
  const flattened: string[] = [];
  const visit = (entries: readonly IndexBranch[]): void => {
    for (const node of entries) {
      flattened.push(`${node.item.kind}:${treeItemId(node.item)}`);
      visit(node.children);
    }
  };
  visit(nodes);
  expect(flattened).toHaveLength(5);
  expect(new Set(flattened).size).toBe(5);
  expect(flattened).toContain("container:same-id");
  expect(flattened).toContain("folder:same-id");
});

test("projects a container move into a folder and closes both sibling orderings", () => {
  const first = container("first", null, 0);
  const moved = container("moved", null, 1);
  const target = folder("target", null, 2);
  const child = container("child", "target", 0);
  const items: IndexEntry[] = [first, moved, target, child];

  expect(projectIndexMove(items, { kind: "container", id: "moved" }, "target", 0)).toEqual([
    first,
    { ...moved, parentId: "target", sortOrder: 0 },
    { ...target, sortOrder: 1 },
    { ...child, sortOrder: 1 },
  ]);
});

test("projects folder reordering among its current siblings", () => {
  const first = folder("first", null, 0);
  const moved = folder("moved", null, 1);
  const last = container("last", null, 2);
  const items: IndexEntry[] = [first, moved, last];

  expect(projectIndexMove(items, { kind: "folder", id: "moved" }, null, 0)).toEqual([
    { ...first, sortOrder: 1 },
    { ...moved, sortOrder: 0 },
    last,
  ]);
});

const composition = (
  id: string,
  parentId: string | null,
  sortOrder: number,
): Extract<IndexEntry, { kind: "container" }> => ({
  kind: "container",
  container: { id, name: id, createdAt: sortOrder, discipline: "composition" },
  parentId,
  sortOrder,
});

test("indexes every container in one tree: folders hold containers and compositions alike", () => {
  expect(
    shape(
      buildIndexTree([
        composition("loose-composition", null, 3),
        folder("projects", null, 0),
        container("canvas", "projects", 0),
        composition("nested-composition", "projects", 1),
        container("loose-container", null, 1),
      ]),
    ),
  ).toEqual([
    [
      "folder:projects",
      [
        ["container:canvas", []],
        ["container:nested-composition", []],
      ],
    ],
    ["container:loose-container", []],
    ["container:loose-composition", []],
  ]);
});

test("a drop index over the unified rows is the stored sibling index", () => {
  const siblings: IndexEntry[] = [
    container("first", null, 0),
    composition("second", null, 1),
    container("third", null, 2),
  ];
  // Nothing is hidden, so a move projected at the index read from the rows lands exactly there:
  // the composition drops between the two containers without stepping over anything.
  expect(
    projectIndexMove(siblings, { kind: "container", id: "third" }, null, 1).map((item) => [
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
  const first: IndexEntry[] = [folder("projects", null, 0), container("notes", "projects", 0)];
  const second: IndexEntry[] = [folder("projects", null, 0), container("notes", "projects", 0)];
  expect(sameIndexEntries(first, second)).toBe(true);
  expect(sameIndexEntries(first, first)).toBe(true);
});

test("a container another tab created reaches the sidebar", () => {
  const before: IndexEntry[] = [container("notes", null, 0)];
  expect(sameIndexEntries(before, [...before, composition("build", null, 1)])).toBe(false);
});

test("every field a row paints from is compared: name, discipline, placement, order", () => {
  const row = container("notes", null, 0);
  const base: IndexEntry[] = [row];
  const withContainer = (fields: Partial<(typeof row)["container"]>): IndexEntry[] => [
    { ...row, container: { ...row.container, ...fields } },
  ];

  expect(sameIndexEntries(base, withContainer({ name: "journal" }))).toBe(false);
  expect(sameIndexEntries(base, withContainer({ discipline: "composition" }))).toBe(false);
  expect(sameIndexEntries(base, [{ ...row, parentId: "projects" }])).toBe(false);
  expect(sameIndexEntries(base, [{ ...row, sortOrder: 1 }])).toBe(false);
});

test("a reordered index is a changed index, not the same set", () => {
  const left: IndexEntry[] = [container("a", null, 0), container("b", null, 1)];
  const right: IndexEntry[] = [
    { ...container("b", null, 1), sortOrder: 0 },
    { ...container("a", null, 0), sortOrder: 1 },
  ];
  expect(sameIndexEntries(left, right)).toBe(false);
});

test("a folder and a container that share an id are never the same row", () => {
  expect(sameIndexEntries([container("shared", null, 0)], [folder("shared", null, 0)])).toBe(false);
});
