import { describe, expect, test } from "bun:test";
import { workspaceLayout } from "@manifold/plugin";
import { ROOT_RING_PX, resolveTileAim, type TileAim } from "@manifold/plugin/hooks";
import { WORKSPACE_TREE_CLASSES } from "@manifold/plugin/ui";
import { validateTileLayout, type Tile, type TileLayout } from "@manifold/protocol";
import {
  PANEL_ARRANGE_RULES,
  movedPanelLayout,
  nudgedPanelLayout,
  panelArrangeMessage,
  panelsCanMove,
  type PanelArrangeOutcome,
} from "./workspace-arrange.ts";

const SIDEBAR = "core.shell.sidebar";
const MAIN = "core.shell.container-view";

/** The tree every principal starts with: sidebar left, container view right. */
function base(): TileLayout {
  return workspaceLayout({ sidebar: SIDEBAR, main: MAIN });
}

function leaf(id: string, panelId: string | null, sections?: readonly string[]): Tile {
  return {
    id,
    dir: null,
    ratios: [],
    children: [],
    ref: panelId === null ? null : { kind: "panel", panelId },
    ...(sections === undefined ? {} : { sections: [...sections] }),
  };
}

function aimAt(tileId: string, edge: TileAim["edge"], extra: Partial<TileAim> = {}): TileAim {
  return { tileId, edge, action: "place", depth: 1, ...extra };
}

/** Which panel each leaf of the tree shows, in the tree's own left-to-right order. */
function panelsInOrder(layout: TileLayout, splitId = "root"): readonly (string | null)[] {
  const node = layout[splitId];
  if (node === undefined) return [];
  if (node.dir !== null) return node.children.flatMap((childId) => panelsInOrder(layout, childId));
  const ref = node.ref;
  return [ref !== null && ref.kind === "panel" ? ref.panelId : null];
}

function assertOk(outcome: PanelArrangeOutcome): TileLayout {
  if (!outcome.ok) throw new Error(`refused: ${outcome.rule}`);
  expect(validateTileLayout(outcome.layout)).toBe(true);
  return outcome.layout;
}

describe("panel arrange: the release", () => {
  test("a same-axis edge joins the row flat and the origin seat departs", () => {
    const next = assertOk(movedPanelLayout(base(), "ws-sidebar", aimAt("ws-main", "right")));
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR]);
    // Flat, never nested: one row, two leaves, and the old sidebar seat is gone.
    expect(next["root"]?.dir).toBe("row");
    expect(next["root"]?.children).toHaveLength(2);
    expect(next["ws-sidebar"]).toBeUndefined();
  });

  test("a cross-axis edge re-splits the workspace, and the collapse promotes the split", () => {
    const next = assertOk(movedPanelLayout(base(), "ws-sidebar", aimAt("ws-main", "bottom")));
    // The sidebar's departure leaves the root with one child, which is promoted into it.
    expect(next["root"]?.dir).toBe("column");
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR]);
  });

  test("a seam middle wedges the panel between two siblings rather than splitting one", () => {
    const layout: TileLayout = {
      root: {
        id: "root",
        dir: "row",
        ratios: [0.2, 0.4, 0.4],
        children: ["a", "b", "c"],
        ref: null,
      },
      a: leaf("a", SIDEBAR),
      b: leaf("b", MAIN),
      c: leaf("c", "core.notes"),
    };
    const next = assertOk(
      movedPanelLayout(layout, "a", aimAt("b", "right", { between: true, depth: 1 })),
    );
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR, "core.notes"]);
    expect(next["root"]?.children).toHaveLength(3);
  });

  test("center trades seats: ratios stay with the seats, arrangements with the panels", () => {
    const layout = { ...base(), "ws-sidebar": leaf("ws-sidebar", SIDEBAR, ["index", "plugins"]) };
    const next = assertOk(
      movedPanelLayout(layout, "ws-sidebar", aimAt("ws-main", "center", { action: "swap" })),
    );
    expect(next["root"]?.ratios).toEqual([0.22, 0.78]);
    expect(next["ws-main"]?.ref).toEqual({ kind: "panel", panelId: SIDEBAR });
    expect(next["ws-sidebar"]?.ref).toEqual({ kind: "panel", panelId: MAIN });
    // The reader's section order followed their sidebar into its new seat.
    expect(next["ws-main"]?.sections).toEqual(["index", "plugins"]);
    expect(next["ws-sidebar"]?.sections).toBeUndefined();
  });

  test("center on a vacant leaf is a move, and the emptied origin is pruned away", () => {
    const layout: TileLayout = {
      root: {
        id: "root",
        dir: "row",
        ratios: [0.2, 0.5, 0.3],
        children: ["a", "b", "hole"],
        ref: null,
      },
      a: leaf("a", SIDEBAR, ["index"]),
      b: leaf("b", MAIN),
      hole: leaf("hole", null),
    };
    const next = assertOk(movedPanelLayout(layout, "a", aimAt("hole", "center")));
    expect(next["a"]).toBeUndefined();
    expect(next["hole"]?.ref).toEqual({ kind: "panel", panelId: SIDEBAR });
    expect(next["hole"]?.sections).toEqual(["index"]);
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR]);
  });
});

describe("panel arrange: the nudge", () => {
  test("an arrow along the split's axis trades the panel with its neighbour", () => {
    const layout = { ...base(), "ws-sidebar": leaf("ws-sidebar", SIDEBAR, ["index"]) };
    const next = assertOk(nudgedPanelLayout(layout, "ws-sidebar", "right"));
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR]);
    expect(next["root"]?.ratios).toEqual([0.22, 0.78]);
    expect(next["ws-main"]?.sections).toEqual(["index"]);
  });

  test("an arrow across the split's axis has no sibling that way", () => {
    expect(nudgedPanelLayout(base(), "ws-sidebar", "top")).toEqual({
      ok: false,
      rule: "no_sibling",
    });
    expect(nudgedPanelLayout(base(), "ws-sidebar", "left")).toEqual({
      ok: false,
      rule: "no_sibling",
    });
  });

  test("a group is not a panel to trade with: the pointer addresses those", () => {
    const layout: TileLayout = {
      root: { id: "root", dir: "row", ratios: [0.2, 0.8], children: ["a", "pair"], ref: null },
      a: leaf("a", SIDEBAR),
      pair: { id: "pair", dir: "column", ratios: [0.5, 0.5], children: ["b", "c"], ref: null },
      b: leaf("b", MAIN),
      c: leaf("c", "core.notes"),
    };
    expect(nudgedPanelLayout(layout, "a", "right")).toEqual({ ok: false, rule: "no_sibling" });
  });
});

describe("panel arrange: the refusals", () => {
  test("a lone panel has nowhere to go, and is offered no grip", () => {
    const alone: TileLayout = { root: leaf("root", SIDEBAR) };
    expect(panelsCanMove(alone)).toBe(false);
    expect(panelsCanMove(null)).toBe(false);
    expect(panelsCanMove(base())).toBe(true);
    expect(movedPanelLayout(alone, "root", aimAt("root", "right"))).toEqual({
      ok: false,
      rule: "panel_alone",
    });
    expect(nudgedPanelLayout(alone, "root", "right")).toEqual({
      ok: false,
      rule: "panel_alone",
    });
  });

  test("aiming at the panel's own seat writes nothing", () => {
    expect(movedPanelLayout(base(), "ws-sidebar", aimAt("ws-sidebar", "left"))).toEqual({
      ok: false,
      rule: "aim_unchanged",
    });
  });

  test("only an occupied panel leaf can be grabbed", () => {
    expect(movedPanelLayout(base(), "root", aimAt("ws-main", "right"))).toEqual({
      ok: false,
      rule: "not_a_panel",
    });
    const withHole = { ...base(), "ws-sidebar": leaf("ws-sidebar", null) };
    expect(movedPanelLayout(withHole, "ws-sidebar", aimAt("ws-main", "right"))).toEqual({
      ok: false,
      rule: "not_a_panel",
    });
  });

  test("a split holds structure, so its exact spot is nothing to trade with", () => {
    expect(movedPanelLayout(base(), "ws-sidebar", aimAt("root", "center"))).toEqual({
      ok: false,
      rule: "tree_refused",
    });
  });

  test("every rule can be spoken in the product", () => {
    for (const rule of PANEL_ARRANGE_RULES) {
      expect(panelArrangeMessage(rule).length).toBeGreaterThan(0);
    }
  });
});

/**
 * THE WHOLE GESTURE, minus the DOM: a pointer position over a real workspace area resolves
 * through the shared tile kernel and lands as a real tree. This is the seam the two halves
 * meet at — a policy that answers correctly for aims nobody can produce would be no proof —
 * so the numbers here are the shell's own: `WORKSPACE_TREE_CLASSES.dividerPx` and
 * `ROOT_RING_PX` measured against an area the size of a window.
 */
describe("panel arrange: pointer to tree", () => {
  const WIDTH = 1000;
  const HEIGHT = 600;

  /** `areaUnits` without a DOM: the same two fractions, off a known box. */
  function aimFor(layout: TileLayout, movedTileId: string, x: number, y: number): TileAim | null {
    return resolveTileAim(
      layout,
      { x, y },
      { carriedTileId: movedTileId, holdsTileSeat: true },
      {
        x: WORKSPACE_TREE_CLASSES.dividerPx / WIDTH,
        y: WORKSPACE_TREE_CLASSES.dividerPx / HEIGHT,
      },
      { x: ROOT_RING_PX / WIDTH, y: ROOT_RING_PX / HEIGHT },
      null,
    );
  }

  /** One whole gesture: grab, aim at a point, release — and the tree that results. */
  function released(movedTileId: string, x: number, y: number): TileLayout {
    const layout = base();
    const aim = aimFor(layout, movedTileId, x, y);
    if (aim === null) throw new Error(`nothing aimed at (${String(x)}, ${String(y)})`);
    return assertOk(movedPanelLayout(layout, movedTileId, aim));
  }

  test("the container view's right flank puts the sidebar on the right", () => {
    expect(panelsInOrder(released("ws-sidebar", 0.9, 0.5))).toEqual([MAIN, SIDEBAR]);
  });

  test("its lower flank stacks the workspace instead", () => {
    const next = released("ws-sidebar", 0.6, 0.9);
    expect(next["root"]?.dir).toBe("column");
    expect(panelsInOrder(next)).toEqual([MAIN, SIDEBAR]);
  });

  test("the area's border ring splits the whole workspace, not one pane", () => {
    // The far left is the ROOT's own band, so the container view crosses the entire tree.
    expect(panelsInOrder(released("ws-main", 0.004, 0.5))).toEqual([MAIN, SIDEBAR]);
  });

  test("a panel's own pane aims at nothing: no release there means anything", () => {
    expect(aimFor(base(), "ws-sidebar", 0.1, 0.5)).toBeNull();
  });
});
