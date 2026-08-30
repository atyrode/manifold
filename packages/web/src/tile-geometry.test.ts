import { describe, expect, test } from "bun:test";
import { ROOT_TILE_ID, type TileLayout, type TileNode, type TileSurface } from "@manifold/protocol";
import { withTileSlot } from "@manifold/scene";

import {
  RING_AXIS_CAP,
  RING_LEAF_CAP,
  paneShifts,
  resolveTileAim,
  ringFraction,
  tileChainAt,
  tileDestinationFor,
  tileRects,
  type TileAim,
  type TileAimCarry,
} from "./tile-geometry.ts";

const terminal = (sessionId: string): TileSurface => ({ kind: "terminal", sessionId });

function leaf(id: string, surface: TileSurface | null = null): TileNode {
  return { id, dir: null, ratios: [], children: [], surface };
}

function split(
  id: string,
  dir: "row" | "column",
  children: readonly string[],
  ratios: readonly number[],
): TileNode {
  return { id, dir, ratios: [...ratios], children: [...children], surface: null };
}

/** `A | B`: a root row of two occupied leaves. */
function rowLayout(ratios: readonly number[] = [1, 1]): TileLayout {
  return {
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t1", "t2"], ratios),
    t1: leaf("t1", terminal("s1")),
    t2: leaf("t2", terminal("s2")),
  };
}

/** `A | (B/C)`: a nested column inside the root row. */
function nestedLayout(): TileLayout {
  return {
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t1", "t3"], [1, 1]),
    t1: leaf("t1", terminal("s1")),
    t3: split("t3", "column", ["t2", "t4"], [1, 1]),
    t2: leaf("t2", terminal("s2")),
    t4: leaf("t4", terminal("s3")),
  };
}

const NO_DIVIDERS = { x: 0, y: 0 } as const;
const NO_CARRY: TileAimCarry = { carriedTileId: null, holdsTileSeat: false };
const SEAT_CARRY: TileAimCarry = { carriedTileId: null, holdsTileSeat: true };
const RING = { x: 0.05, y: 0.05 } as const;

describe("tileRects", () => {
  test("a row split divides the free width by its ratios after subtracting the divider", () => {
    const rects = tileRects(rowLayout([1, 3]), { x: 0.04, y: 0.04 });
    expect(rects.get("t1")).toEqual({ x: 0, y: 0, width: 0.24, height: 1 });
    expect(rects.get("t2")?.x).toBeCloseTo(0.28, 12);
    expect(rects.get("t2")?.width).toBeCloseTo(0.72, 12);
    expect(rects.get("t2")?.height).toBe(1);
  });

  test("a nested split yields the exact grandchild rects", () => {
    const rects = tileRects(nestedLayout(), { x: 0.05, y: 0.1 });
    expect(rects.get("t1")).toEqual({ x: 0, y: 0, width: 0.475, height: 1 });
    expect(rects.get("t2")).toEqual({ x: 0.525, y: 0, width: 0.475, height: 0.45 });
    expect(rects.get("t4")).toEqual({ x: 0.525, y: 0.55, width: 0.475, height: 0.45 });
    // The SPLIT's union rect is present too, which is what makes an ancestor addressable.
    expect(rects.get("t3")).toEqual({ x: 0.525, y: 0, width: 0.475, height: 1 });
  });

  test("a single-leaf tree is exactly the unit square and nothing else", () => {
    const rects = tileRects({ [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) }, NO_DIVIDERS);
    expect([...rects.keys()]).toEqual([ROOT_TILE_ID]);
    expect(rects.get(ROOT_TILE_ID)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("degenerate ratios fall back to equal shares with no NaN", () => {
    const rects = tileRects(rowLayout([0, 0]), NO_DIVIDERS);
    expect(rects.get("t1")).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
    expect(rects.get("t2")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
  });
});

describe("tileChainAt", () => {
  test("walks root to leaf for a deep point", () => {
    const layout = nestedLayout();
    const rects = tileRects(layout, NO_DIVIDERS);
    expect(tileChainAt(layout, rects, { x: 0.75, y: 0.8 })).toEqual([ROOT_TILE_ID, "t3", "t4"]);
  });

  test("a single-leaf tree answers with the root alone", () => {
    const layout: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) };
    const rects = tileRects(layout, NO_DIVIDERS);
    expect(tileChainAt(layout, rects, { x: 0.5, y: 0.5 })).toEqual([ROOT_TILE_ID]);
  });

  test("a point outside the area is nowhere", () => {
    const layout = rowLayout();
    const rects = tileRects(layout, NO_DIVIDERS);
    expect(tileChainAt(layout, rects, { x: 1.2, y: 0.5 })).toEqual([]);
    expect(tileChainAt(layout, rects, { x: 0.5, y: -0.1 })).toEqual([]);
  });
});

describe("ringFraction", () => {
  test("the leaf cap binds before the axis cap on a four-way split", () => {
    // 0.25-wide leaves: the ring is 0.2 × 0.25 = 0.05 — strictly less than the leaf's own
    // 0.25 × 0.25 = 0.0625 edge band, so the leaf keeps a reachable band AND its whole
    // center. This is the 5-zones-always-live proof, and the regression test for a
    // 2.5 px dead zone at zoom 0.5.
    const fraction = ringFraction(0.12, 0.25);
    expect(fraction).toBe(RING_LEAF_CAP * 0.25);
    expect(fraction).toBeLessThan(0.25 * 0.25);
    // With roomy leaves the axis cap binds instead.
    expect(ringFraction(0.5, 1)).toBe(RING_AXIS_CAP);
    // And a thin on-screen ring is simply itself.
    expect(ringFraction(0.02, 1)).toBe(0.02);
  });
});

describe("resolveTileAim", () => {
  test("the border ring targets the root and never a descendant", () => {
    const layout = rowLayout();
    const left = resolveTileAim(layout, { x: 0.02, y: 0.5 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(left).toEqual({ tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 });
    const bottom = resolveTileAim(layout, { x: 0.3, y: 0.98 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(bottom).toEqual({ tileId: ROOT_TILE_ID, edge: "bottom", action: "place", depth: 0 });
    // The ring never offers center: every ring aim is one of the four borders.
    expect(left?.edge).not.toBe("center");
  });

  test("one ring-width inward resolves to the leaf's own band", () => {
    const layout = rowLayout();
    const aim = resolveTileAim(layout, { x: 0.07, y: 0.5 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(aim).toEqual({ tileId: "t1", edge: "left", action: "place", depth: 1 });
  });

  test("a nested leaf keeps all five zones live", () => {
    const layout = nestedLayout();
    const over = (x: number, y: number): TileAim | null =>
      resolveTileAim(layout, { x, y }, SEAT_CARRY, NO_DIVIDERS, RING);
    // Leaf t2 occupies x 0.5..1, y 0..0.5. Sample its four bands and its center.
    expect(over(0.56, 0.25)?.tileId).toBe("t2");
    expect(over(0.56, 0.25)?.edge).toBe("left");
    // x 0.93 sits in t2's right band but OUTSIDE the root ring (x ≥ 0.95) — the ring
    // only ever consumes edge-band area, so the leaf's own band stays reachable.
    expect(over(0.93, 0.25)).toEqual({ tileId: "t2", edge: "right", action: "place", depth: 2 });
    expect(over(0.75, 0.08)?.edge).toBe("top");
    expect(over(0.75, 0.44)?.edge).toBe("bottom");
    expect(over(0.75, 0.25)).toEqual({ tileId: "t2", edge: "center", action: "swap", depth: 2 });
  });

  test("a solo container has no ring", () => {
    const layout: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) };
    const aim = resolveTileAim(layout, { x: 0.02, y: 0.5 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(aim).toEqual({ tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 });
  });

  test("center on an empty leaf is a fill for any carry", () => {
    const layout: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID) };
    for (const carry of [NO_CARRY, SEAT_CARRY]) {
      const aim = resolveTileAim(layout, { x: 0.5, y: 0.5 }, carry, NO_DIVIDERS, RING);
      expect(aim).toEqual({ tileId: ROOT_TILE_ID, edge: "center", action: "place", depth: 0 });
    }
  });

  test("center on an occupied leaf trades with a seat and evicts without one", () => {
    const layout = rowLayout();
    const seated = resolveTileAim(layout, { x: 0.25, y: 0.5 }, SEAT_CARRY, NO_DIVIDERS, RING);
    expect(seated).toEqual({ tileId: "t1", edge: "center", action: "swap", depth: 1 });
    const seatless = resolveTileAim(layout, { x: 0.25, y: 0.5 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(seatless).toEqual({ tileId: "t1", edge: "center", action: "replace", depth: 1 });
  });

  test("every zone over the carry's own leaf returns null", () => {
    const layout = rowLayout();
    const carry: TileAimCarry = { carriedTileId: "t1", holdsTileSeat: true };
    // Leaf t1 occupies x 0..0.5: its left band, center, and bottom band all refuse.
    for (const point of [
      { x: 0.07, y: 0.5 },
      { x: 0.25, y: 0.5 },
      { x: 0.25, y: 0.93 },
    ]) {
      expect(resolveTileAim(layout, point, carry, NO_DIVIDERS, RING)).toBeNull();
    }
    // The area's own ring still works: moving a leaf to a root border is a real move.
    const ringAim = resolveTileAim(layout, { x: 0.3, y: 0.98 }, carry, NO_DIVIDERS, RING);
    expect(ringAim?.tileId).toBe(ROOT_TILE_ID);
  });

  test("a point on a divider aims at nothing", () => {
    const aim = resolveTileAim(
      rowLayout(),
      { x: 0.5, y: 0.5 },
      NO_CARRY,
      { x: 0.04, y: 0.04 },
      {
        x: 0,
        y: 0,
      },
    );
    expect(aim).toBeNull();
  });
});

describe("paneShifts", () => {
  const DIVIDERS = { x: 0.02, y: 0.02 } as const;

  test("a root split reports exactly one shift carrying the renamed pane's old rect", () => {
    const current: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) };
    const slotted = withTileSlot(current, ROOT_TILE_ID, "right");
    expect(slotted).not.toBeNull();
    const shifts = paneShifts(current, slotted?.layout ?? {}, DIVIDERS);
    expect(shifts).toHaveLength(1);
    const shift = shifts[0];
    // The NEW id with the OLD rect as `from`: this pins the root-rename against a
    // spurious unmount — an id-matched diff would lose the one pane that must move.
    expect(shift?.tileId).not.toBe(ROOT_TILE_ID);
    expect(slotted?.layout[shift?.tileId ?? ""]?.surface).toEqual(terminal("s1"));
    expect(shift?.fromTileId).toBe(ROOT_TILE_ID);
    expect(shift?.from).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(shift?.to.width).toBeCloseTo(0.49, 6);
  });

  test("an untouched sibling produces no shift", () => {
    const current = rowLayout();
    const slotted = withTileSlot(current, "t2", "bottom");
    const shifts = paneShifts(current, slotted?.layout ?? {}, DIVIDERS);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]?.tileId).toBe("t2");
    expect(shifts[0]?.fromTileId).toBe("t2");
  });

  test("a structurally identical next layout shifts nothing", () => {
    expect(paneShifts(rowLayout(), rowLayout(), DIVIDERS)).toEqual([]);
  });
});

describe("tileDestinationFor", () => {
  const aim: TileAim = { tileId: "t2", edge: "left", action: "place", depth: 1 };

  test("a multi-tile container is a tile destination naming the aimed leaf", () => {
    expect(
      tileDestinationFor(aim, { containerId: "view-1", widget: null, rootIsLeaf: false }),
    ).toEqual({ kind: "tile", padId: "view-1", targetTileId: "t2", edge: "left" });
    // A widget over a MULTI-tile container also addresses the leaf directly.
    expect(
      tileDestinationFor(aim, {
        containerId: "view-1",
        widget: { padId: "canvas-1", elementId: "el-1" },
        rootIsLeaf: false,
      }),
    ).toEqual({ kind: "tile", padId: "view-1", targetTileId: "t2", edge: "left" });
  });

  test("a solo canvas widget keeps the compose door", () => {
    const solo: TileAim = { tileId: ROOT_TILE_ID, edge: "bottom", action: "place", depth: 0 };
    expect(
      tileDestinationFor(solo, {
        containerId: "view-1",
        widget: { padId: "canvas-1", elementId: "el-1" },
        rootIsLeaf: true,
      }),
    ).toEqual({ kind: "compose", padId: "canvas-1", targetElementId: "el-1", edge: "bottom" });
  });

  test("a solo container on the fullscreen route addresses its own root leaf", () => {
    const solo: TileAim = { tileId: ROOT_TILE_ID, edge: "right", action: "place", depth: 0 };
    expect(
      tileDestinationFor(solo, { containerId: "view-1", widget: null, rootIsLeaf: true }),
    ).toEqual({ kind: "tile", padId: "view-1", targetTileId: ROOT_TILE_ID, edge: "right" });
  });
});
