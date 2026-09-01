import { describe, expect, test } from "bun:test";
import type { ComposedSection } from "@manifold/plugin";
import type { SectionNode } from "@manifold/protocol";
import { railRows, railTree, type RailNode } from "../src/rail-rows.ts";

/**
 * THE RAIL'S TWO ASSERTIONS ABOUT THE PRODUCT, without a browser.
 *
 * D4′ (ADR 0013): CHROME RENDERS ABSENCE. A disabled plugin's row leaves the sidebar
 * entirely — no tombstone, no inert body, no gap — while the Plugins section stays the one
 * ledger of what is off, and re-enabling puts the row back in the exact seat the principal
 * arranged it into. That contract used to be provable only for the three disclosure sections,
 * because everything else in the rail was hand-written floor JSX that no roster could touch.
 * Now the creators, the brand line, the status line, the key-table door and the identity footer
 * are rows too, so "disable `core.canvas`" has an observable answer about the sidebar, and it
 * is asserted here rather than only in the browser gate.
 *
 * THE COLLAPSED RAIL is the second: it keeps every PLAIN row (they draw themselves icon-only)
 * and exactly one body, the absorber. That is what makes the icon rail the same stack rather
 * than a second layout.
 *
 * THE PAINTED TREE is the third, and it is new with issue #104: an arrangement may NEST, and
 * every node the rail paints has to carry the path the drop gesture measures it by. The paths
 * are the ARRANGEMENT's own indices — never the painted list's — because the projection the
 * gesture aims at walks the same arrangement, and a numbering that closed up around an
 * invisible row would name a different seat than the DOM does.
 *
 * The ARRANGEMENT ITSELF is not tested here — it is `arrangedSections`' own contract, tested
 * in `packages/plugin/test/layout.test.ts`. This module is handed a live arrangement and
 * answers which of those rows paint, where, and which one absorbs the height.
 */

function section(
  id: string,
  plugin: string,
  presentation: "disclosure" | "plain",
  enabled = true,
  order = 0,
): ComposedSection {
  return { id, plugin, title: id, order, presentation, enabled };
}

/** The shipped rail, in its default (manifest) order. */
const BRAND = section("brand", "core.brand", "plain", true, 1);
const NEW_CANVAS = section("new-canvas", "core.canvas", "plain", true, 2);
const NEW_COMPOSITION = section("new-composition", "core.compositions", "plain", true, 3);
const NEW_FOLDER = section("new-folder", "core.index", "plain", true, 4);
const INDEX = section("index", "core.index", "disclosure", true, 10);
const MACHINES = section("machines", "core.machines", "disclosure", true, 20);
const PLUGINS = section("plugins", "core.plugins", "disclosure", true, 30);
const STATUS = section("status", "core.shell", "plain", true, 40);
const KEYS = section("keys", "core.keys", "plain", true, 50);
const IDENTITY = section("identity", "core.shell", "plain", true, 60);

const RAIL: readonly ComposedSection[] = [
  BRAND,
  NEW_CANVAS,
  NEW_COMPOSITION,
  NEW_FOLDER,
  INDEX,
  MACHINES,
  PLUGINS,
  STATUS,
  KEYS,
  IDENTITY,
];

const DEFAULT_ORDER = RAIL.map((row) => row.id);

function painted(
  declared: readonly ComposedSection[],
  order: readonly string[] = DEFAULT_ORDER,
  sidebarOpen = true,
): readonly string[] {
  return railRows(declared, order, sidebarOpen).map((row) => row.section.id);
}

function absorber(
  declared: readonly ComposedSection[],
  order: readonly string[] = DEFAULT_ORDER,
  sidebarOpen = true,
): string | undefined {
  return railRows(declared, order, sidebarOpen).find((row) => row.grow)?.section.id;
}

describe("railRows", () => {
  test("the shipped rail paints every row in the given order", () => {
    expect(painted(RAIL)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
  });

  test("disabling core.canvas VANISHES its creator and nothing else (D4′)", () => {
    const off = RAIL.map((row) =>
      row.plugin === "core.canvas" ? { ...row, enabled: false } : row,
    );

    expect(painted(off)).toEqual([
      "brand",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
    // No tombstone: the row is not present-and-marked, it is gone from the stack.
    expect(painted(off)).not.toContain("new-canvas");
  });

  test("re-enabling restores the exact seat the principal arranged it into", () => {
    // This reader dragged the canvas creator below the composition creator; the arrangement
    // is stored per principal and survives the plugin being off, because the ORDER is data
    // and only the PAINTING is filtered.
    const arranged = [
      "brand",
      "new-composition",
      "new-canvas",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ];
    const off = RAIL.map((row) =>
      row.plugin === "core.canvas" ? { ...row, enabled: false } : row,
    );

    expect(painted(off, arranged)).toEqual([
      "brand",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
    expect(painted(RAIL, arranged)).toEqual(arranged);
  });

  test("a disabled DISCLOSURE owner hands the absorber to the next body", () => {
    // The same rule the three sections have always had, now read off the live order: the
    // leftover height goes to the first row WITH a body, whichever plugin that is.
    expect(absorber(RAIL)).toBe("index");

    const indexOff = RAIL.map((row) => (row.id === "index" ? { ...row, enabled: false } : row));
    expect(absorber(indexOff)).toBe("machines");
  });

  test("a plain row never absorbs the rail's height, even in first place", () => {
    // Otherwise the brand line — first in the default order — would be stretched to fill the
    // sidebar, which is how a plain row would have broken the old `sections[0]` rule.
    expect(absorber(RAIL)).toBe("index");
    const plainOnly = RAIL.filter((row) => row.presentation === "plain");
    expect(
      absorber(
        plainOnly,
        plainOnly.map((row) => row.id),
      ),
    ).toBeUndefined();
  });

  test("an order naming a row the roster does not carry drops it, and paints the rest", () => {
    // A plugin the principal once arranged has been purged; their stored order still names it.
    expect(painted(RAIL, ["brand", "core.stranger.rows", "index"])).toEqual(["brand", "index"]);
  });

  test("the COLLAPSED rail keeps every plain row and exactly one body", () => {
    expect(painted(RAIL, DEFAULT_ORDER, false)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "index",
      "status",
      "keys",
      "identity",
    ]);
    expect(absorber(RAIL, DEFAULT_ORDER, false)).toBe("index");
  });

  test("a collapsed rail whose bodies are all off is the icon strip alone", () => {
    const bodiesOff = RAIL.map((row) =>
      row.presentation === "disclosure" ? { ...row, enabled: false } : row,
    );

    expect(painted(bodiesOff, DEFAULT_ORDER, false)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "status",
      "keys",
      "identity",
    ]);
    expect(absorber(bodiesOff, DEFAULT_ORDER, false)).toBeUndefined();
  });

  test("an empty roster paints nothing rather than throwing", () => {
    expect(painted([], [])).toEqual([]);
    expect(painted([], DEFAULT_ORDER)).toEqual([]);
  });
});

/**
 * One painted tree as a line of text: a row is `path:id` (`*` marks the absorber), a split is
 * `path[dir …]`. Reading the expectation as prose is the point — the assertions below are
 * about WHERE each node ended up, and a nested object literal buries exactly that.
 */
function shape(nodes: readonly RailNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "row"
        ? `${node.path}:${node.row.section.id}${node.row.grow ? "*" : ""}`
        : `${node.path}[${node.dir}${node.nodes.length === 0 ? "" : ` ${shape(node.nodes)}`}]`,
    )
    .join(" ");
}

function tree(
  declared: readonly ComposedSection[],
  arrangement: readonly SectionNode[],
  sidebarOpen = true,
): string {
  return shape(railTree(declared, arrangement, sidebarOpen));
}

describe("railTree", () => {
  test("a FLAT arrangement is the flat rail, each row named by its own index", () => {
    // The whole compatibility claim of issue #104 in one line: an arrangement of bare ids is
    // the stack that existed before splits did, and the paths are `n0`, `n1`, …
    expect(tree([BRAND, NEW_CANVAS, INDEX], ["brand", "new-canvas", "index"])).toBe(
      "n0:brand n1:new-canvas n2:index*",
    );
  });

  test("a SPLIT keeps its members, and they are named inside it", () => {
    expect(
      tree(
        [BRAND, NEW_CANVAS, NEW_COMPOSITION, INDEX],
        ["brand", { dir: "row", sections: ["new-canvas", "new-composition"] }, "index"],
      ),
    ).toBe("n0:brand n1[row n1.0:new-canvas n1.1:new-composition] n2:index*");
  });

  test("an EMPTY split is painted, because that is what a fresh drop from the palette is", () => {
    // Dropping "Stack row" between two rows wedges a split with no members in it. If the tree
    // dropped one for being empty, the palette's own drop would vanish on the frame after it
    // landed and there would be nothing left to aim the first row into.
    expect(tree([BRAND, INDEX], ["brand", { dir: "row", sections: [] }, "index"])).toBe(
      "n0:brand n1[row] n2:index*",
    );
  });

  test("a split emptied by the roster is a seat, not a hole", () => {
    // Same shape, arrived at the other way: the one plugin seated in the split is disabled, so
    // the split paints as the empty seat it now is and the reader can see where their row went.
    const canvasOff = [BRAND, { ...NEW_CANVAS, enabled: false }, INDEX];
    expect(tree(canvasOff, ["brand", { dir: "row", sections: ["new-canvas"] }, "index"])).toBe(
      "n0:brand n1[row] n2:index*",
    );
  });

  test("an invisible row leaves a numbering HOLE, so every other path still names its own seat", () => {
    /*
      The load-bearing property of the path: the drop gesture aims at a projection of this very
      arrangement, and the projection numbers what the ARRANGEMENT holds. Closing the gap up
      here would make `n2` mean the third stored node to the kernel and the second painted one
      to the DOM, and every band below the missing row would describe the wrong row.
    */
    const canvasOff = [BRAND, { ...NEW_CANVAS, enabled: false }, NEW_COMPOSITION, INDEX];
    expect(tree(canvasOff, ["brand", "new-canvas", "new-composition", "index"])).toBe(
      "n0:brand n2:new-composition n3:index*",
    );
  });

  test("the absorber is found wherever it sits, including inside a split", () => {
    // `railRows` names the absorber off the flattened arrangement, so nesting cannot change
    // which row gets the rail's leftover height — only where it is painted.
    expect(
      tree([BRAND, INDEX, MACHINES], ["brand", { dir: "row", sections: ["index", "machines"] }]),
    ).toBe("n0:brand n1[row n1.0:index* n1.1:machines]");
  });

  test("the COLLAPSED rail filters a nested row exactly as a flat one", () => {
    // The icon strip keeps every plain row and the one absorber, whatever depth they sit at:
    // `machines` has a body and is not the absorber, so it is left out of the split it is in.
    expect(
      tree(
        [BRAND, INDEX, MACHINES],
        ["brand", { dir: "row", sections: ["index", "machines"] }],
        false,
      ),
    ).toBe("n0:brand n1[row n1.0:index*]");
  });

  test("nesting never invents or loses a row", () => {
    const nested: readonly SectionNode[] = [
      "brand",
      { dir: "row", sections: ["new-canvas", { dir: "column", sections: ["new-composition"] }] },
      "index",
    ];
    const flat = railRows(RAIL, ["brand", "new-canvas", "new-composition", "index"], true);
    const nodes = railTree(RAIL, nested, true);
    const ids = (list: readonly RailNode[]): readonly string[] =>
      list.flatMap((node) => (node.kind === "row" ? [node.row.section.id] : ids(node.nodes)));

    expect(ids(nodes)).toEqual(flat.map((row) => row.section.id));
    expect(shape(nodes)).toBe(
      "n0:brand n1[row n1.0:new-canvas n1.1[column n1.1.0:new-composition]] n2:index*",
    );
  });
});
