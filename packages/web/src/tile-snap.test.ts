import { describe, expect, test } from "bun:test";

import { ROOT_TILE_ID, validateTileLayout } from "@manifold/protocol";

import {
  asTileTree,
  composeTargetAt,
  MIN_TILE_FRACTION,
  previewRect,
  resizeRatios,
  snapZone,
  SNAP_EDGE_BAND,
  type SnapNode,
} from "./tile-snap.ts";

function node(id: string, type: string, x: number, y: number, zIndex = 0, size = 100): SnapNode {
  return { id, type, position: { x, y }, width: size, height: size, zIndex };
}

describe("composeTargetAt", () => {
  const nodes: readonly SnapNode[] = [
    node("term-a", "terminal", 0, 0, 1),
    node("term-b", "terminal", 50, 50, 2),
    node("widget", "portal", 300, 0, 1),
    node("note", "text", 500, 0, 9),
    node("ink", "draw", 700, 0, 9),
  ];

  test("a pointer outside every node composes with nothing", () => {
    expect(composeTargetAt(nodes, { x: 250, y: 250 }, null)).toBeNull();
  });

  test("terminals and widgets are targets; notes and ink are not", () => {
    expect(composeTargetAt(nodes, { x: 10, y: 10 }, null)?.id).toBe("term-a");
    expect(composeTargetAt(nodes, { x: 320, y: 20 }, null)?.id).toBe("widget");
    // There is nothing to birth a container around, and the executor refuses it, so
    // offering the gesture over a note or a stroke would be a lie.
    expect(composeTargetAt(nodes, { x: 520, y: 20 }, null)).toBeNull();
    expect(composeTargetAt(nodes, { x: 720, y: 20 }, null)).toBeNull();
  });

  test("overlaps resolve to the topmost node, matching what the viewer sees", () => {
    expect(composeTargetAt(nodes, { x: 60, y: 60 }, null)?.id).toBe("term-b");
  });

  test("the dragged node is never its own target", () => {
    expect(composeTargetAt(nodes, { x: 60, y: 60 }, "term-b")?.id).toBe("term-a");
    expect(composeTargetAt([nodes[0]!], { x: 10, y: 10 }, "term-a")).toBeNull();
  });

  test("edges count as inside, so a drop on a border still composes", () => {
    expect(composeTargetAt([nodes[0]!], { x: 0, y: 0 }, null)?.id).toBe("term-a");
    expect(composeTargetAt([nodes[0]!], { x: 100, y: 100 }, null)?.id).toBe("term-a");
    expect(composeTargetAt([nodes[0]!], { x: 101, y: 100 }, null)).toBeNull();
  });
});

const rect = { x: 100, y: 200, width: 400, height: 300 } as const;

describe("snapZone", () => {
  test("the interior beyond every band is center", () => {
    expect(snapZone(rect, { x: 300, y: 350 })).toBe("center");
    // Just inside the band boundaries on both axes.
    expect(snapZone(rect, { x: 100 + 400 * SNAP_EDGE_BAND + 1, y: 350 })).toBe("center");
    expect(snapZone(rect, { x: 300, y: 200 + 300 * SNAP_EDGE_BAND + 1 })).toBe("center");
  });

  test("each edge band claims the outer quarter of its axis", () => {
    expect(snapZone(rect, { x: 110, y: 350 })).toBe("left");
    expect(snapZone(rect, { x: 490, y: 350 })).toBe("right");
    expect(snapZone(rect, { x: 300, y: 210 })).toBe("top");
    expect(snapZone(rect, { x: 300, y: 490 })).toBe("bottom");
  });

  test("band edges are inclusive of center, exclusive of the edge zone", () => {
    // dx exactly at the band boundary belongs to center, not to left.
    expect(snapZone(rect, { x: 100 + 400 * SNAP_EDGE_BAND, y: 350 })).toBe("center");
    expect(snapZone(rect, { x: 100 + 400 * SNAP_EDGE_BAND - 0.5, y: 350 })).toBe("left");
  });

  test("corners resolve to the axis penetrated more deeply", () => {
    // Band widths differ (100 wide, 75 tall); normalised depth decides.
    // 5px into a 100px horizontal band = 0.05; 5px into a 75px vertical band = 0.067.
    expect(snapZone(rect, { x: 195, y: 270 })).toBe("top");
    // 2px into the horizontal band = 0.98 depth, far deeper than 40/75 vertically.
    expect(snapZone(rect, { x: 102, y: 235 })).toBe("left");
  });

  test("the exact corner is a tie broken toward the horizontal axis", () => {
    expect(snapZone(rect, { x: 100, y: 200 })).toBe("left");
    expect(snapZone(rect, { x: 500, y: 500 })).toBe("right");
  });

  test("pointers outside the rect snap nowhere", () => {
    expect(snapZone(rect, { x: 99, y: 350 })).toBeNull();
    expect(snapZone(rect, { x: 501, y: 350 })).toBeNull();
    expect(snapZone(rect, { x: 300, y: 199 })).toBeNull();
    expect(snapZone(rect, { x: 300, y: 501 })).toBeNull();
  });

  test("a degenerate rect snaps nowhere", () => {
    expect(snapZone({ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 5 })).toBeNull();
    expect(snapZone({ x: 0, y: 0, width: 10, height: 0 }, { x: 5, y: 0 })).toBeNull();
  });
});

describe("previewRect", () => {
  test("edges preview the half the dropped surface takes", () => {
    expect(previewRect(rect, "left")).toEqual({ x: 100, y: 200, width: 200, height: 300 });
    expect(previewRect(rect, "right")).toEqual({ x: 300, y: 200, width: 200, height: 300 });
    expect(previewRect(rect, "top")).toEqual({ x: 100, y: 200, width: 400, height: 150 });
    expect(previewRect(rect, "bottom")).toEqual({ x: 100, y: 350, width: 400, height: 150 });
  });

  test("center previews the whole target", () => {
    expect(previewRect(rect, "center")).toEqual({ ...rect });
  });

  test("opposite halves tile the target exactly", () => {
    const left = previewRect(rect, "left");
    const right = previewRect(rect, "right");
    expect(left.x + left.width).toBe(right.x);
    expect(left.width + right.width).toBe(rect.width);
  });
});

describe("asTileTree", () => {
  test("lifts a terminal surface into a valid one-leaf tree", () => {
    const tree = asTileTree({ kind: "terminal", sessionId: "s1" });
    expect(Object.keys(tree)).toEqual([ROOT_TILE_ID]);
    expect(tree[ROOT_TILE_ID]).toEqual({
      id: ROOT_TILE_ID,
      dir: null,
      ratios: [],
      children: [],
      surface: { kind: "terminal", sessionId: "s1" },
    });
    expect(validateTileLayout(tree)).toBe(true);
  });

  test("a pad surface tree is valid unless it is the container itself", () => {
    const tree = asTileTree({ kind: "pad", padId: "pad-a" });
    expect(validateTileLayout(tree, "pad-b")).toBe(true);
    expect(validateTileLayout(tree, "pad-a")).toBe(false);
  });
});

describe("resizeRatios", () => {
  test("moves only the two panes the divider separates", () => {
    expect(resizeRatios([1, 1, 1], 0, 0.3)).toEqual([1.3, 0.7, 1]);
    expect(resizeRatios([1, 1, 1], 1, -0.25)).toEqual([1, 0.75, 1.25]);
  });

  test("the split's total is conserved", () => {
    const next = resizeRatios([2, 3, 5], 1, 1.5);
    expect(next.reduce((sum, ratio) => sum + ratio, 0)).toBeCloseTo(10, 10);
  });

  test("neither neighbour shrinks past the ten-percent stop", () => {
    // total 4, floor 0.4: pushing left by 3 pins the right pane at the stop.
    expect(resizeRatios([2, 2], 0, 3)).toEqual([3.6, 0.4]);
    expect(resizeRatios([2, 2], 0, -3)).toEqual([0.4, 3.6]);
  });

  test("a drag already pinned against a stop returns the same array", () => {
    const pinned: readonly number[] = [3.6, 0.4];
    expect(resizeRatios(pinned, 0, 1)).toBe(pinned);
  });

  test("a divider index with no pane on one side is inert", () => {
    const ratios: readonly number[] = [1, 1];
    expect(resizeRatios(ratios, 1, 0.5)).toBe(ratios);
    expect(resizeRatios(ratios, -1, 0.5)).toBe(ratios);
  });

  test("a split too tight to honour both stops refuses to move", () => {
    // Two neighbours holding less than 20% of a wide split have no slack.
    const ratios: readonly number[] = [0.05, 0.05, 10];
    expect(resizeRatios(ratios, 0, 0.02)).toBe(ratios);
  });

  test("the stop is the documented fraction of the whole split", () => {
    const next = resizeRatios([1, 1, 8], 0, -5);
    expect(next[0]).toBeCloseTo(10 * MIN_TILE_FRACTION, 10);
  });
});
