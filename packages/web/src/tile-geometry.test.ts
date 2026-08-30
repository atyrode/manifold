import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  type TileEdge,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";
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
    expect(aim).toEqual({ tileId: "t1", edge: "left", action: "place", depth: 1, between: false });
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
    expect(over(0.93, 0.25)).toEqual({
      tileId: "t2",
      edge: "right",
      action: "place",
      depth: 2,
      between: false,
    });
    expect(over(0.75, 0.08)?.edge).toBe("top");
    expect(over(0.75, 0.44)?.edge).toBe("bottom");
    expect(over(0.75, 0.25)).toEqual({ tileId: "t2", edge: "center", action: "swap", depth: 2 });
  });

  test("a solo container has no ring", () => {
    const layout: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) };
    const aim = resolveTileAim(layout, { x: 0.02, y: 0.5 }, NO_CARRY, NO_DIVIDERS, RING);
    expect(aim).toEqual({
      tileId: ROOT_TILE_ID,
      edge: "left",
      action: "place",
      depth: 0,
      between: false,
    });
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

  test("a divider aims between its two siblings as a flat insert", () => {
    const dividers = { x: 0.04, y: 0.04 } as const;
    const noRing = { x: 0, y: 0 } as const;
    // The seam of `A | B` means "wedge in after A": the leading neighbor's trailing edge.
    const aim = resolveTileAim(rowLayout(), { x: 0.5, y: 0.5 }, NO_CARRY, dividers, noRing);
    expect(aim).toEqual({
      tileId: "t1",
      edge: "right",
      action: "place",
      depth: 1,
      between: true,
    });
    // A nested split's own divider inserts into THAT split.
    const nested = resolveTileAim(
      nestedLayout(),
      { x: 0.75, y: 0.5 },
      NO_CARRY,
      { x: 0, y: 0.04 },
      noRing,
    );
    expect(nested).toEqual({
      tileId: "t2",
      edge: "bottom",
      action: "place",
      depth: 2,
      between: true,
    });
  });

  test("a neighbor dropped on its own seam aims at nothing", () => {
    const dividers = { x: 0.04, y: 0.04 } as const;
    const noRing = { x: 0, y: 0 } as const;
    for (const carriedTileId of ["t1", "t2"]) {
      const carry: TileAimCarry = { carriedTileId, holdsTileSeat: true };
      expect(resolveTileAim(rowLayout(), { x: 0.5, y: 0.5 }, carry, dividers, noRing)).toBeNull();
    }
  });

  test("a seam's ends split the GROUP the seam belongs to (#60)", () => {
    // The reported tree: `A | (B / (C | D))` — the (C|D) group's own bottom border is
    // coincident with C's and D's bottom bands, so the group is addressable only
    // through the one geometry that is unambiguously ITS OWN: the C/D seam.
    const layout: TileLayout = {
      [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["tA", "tCol"], [1, 1]),
      tA: leaf("tA", terminal("sA")),
      tCol: split("tCol", "column", ["tB", "tRow"], [1, 1]),
      tB: leaf("tB", terminal("sB")),
      tRow: split("tRow", "row", ["tC", "tD"], [1, 1]),
      tC: leaf("tC", terminal("sC")),
      tD: leaf("tD", terminal("sD")),
    };
    const dividers = { x: 0.02, y: 0 } as const;
    const over = (x: number, y: number): TileAim | null =>
      resolveTileAim(layout, { x, y }, NO_CARRY, dividers, { x: 0.05, y: 0.05 });
    // The seam sits at x ≈ 0.75, spanning y 0.5..1. Its middle inserts between C and D…
    expect(over(0.75, 0.7)).toEqual({
      tileId: "tC",
      edge: "right",
      action: "place",
      depth: 3,
      between: true,
    });
    // …its bottom end grows a pane across the whole group ( -> B / (C|D) / E )…
    expect(over(0.75, 0.9)).toEqual({ tileId: "tRow", edge: "bottom", action: "place", depth: 2 });
    // …and its top end the same, above.
    expect(over(0.75, 0.55)).toEqual({ tileId: "tRow", edge: "top", action: "place", depth: 2 });
    // The insert the aim addresses is the flat same-axis splice into the column.
    const slotted = withTileSlot(layout, "tRow", "bottom");
    expect(slotted?.layout["tCol"]?.children).toEqual(["tB", "tRow", slotted?.slotId ?? ""]);
    expect(slotted?.layout["tCol"]?.ratios).toEqual([1, 0.5, 0.5]);
  });

  test("a held zone keeps the aim until the pointer clears a real margin", () => {
    const layout = rowLayout();
    const over = (
      x: number,
      held: { tileId: string; edge: "center" | "left" } | null,
    ): TileAim | null =>
      resolveTileAim(layout, { x, y: 0.5 }, SEAT_CARRY, NO_DIVIDERS, { x: 0, y: 0 }, held);
    // t1 spans x 0..0.5; its left band ends at 0.125. Just inside the band…
    expect(over(0.115, null)?.edge).toBe("left");
    // …a HELD center keeps the center: the boundary grew by the hysteresis margin.
    expect(over(0.115, { tileId: "t1", edge: "center" })?.edge).toBe("center");
    // Past the margin the flip is real, held or not.
    expect(over(0.08, { tileId: "t1", edge: "center" })?.edge).toBe("left");
    // And the mirror: a held LEFT stretches into what would already be center.
    expect(over(0.14, null)?.edge).toBe("center");
    expect(over(0.14, { tileId: "t1", edge: "left" })?.edge).toBe("left");
    // A hold never crosses tiles.
    expect(over(0.6, { tileId: "t1", edge: "center" })?.tileId).toBe("t2");
  });

  test("a same-axis flank tells the seam band from the pane's own split (#60)", () => {
    const layout = rowLayout();
    const ring = { x: 0.04, y: 0.04 } as const;
    const over = (x: number): TileAim | null =>
      resolveTileAim(layout, { x, y: 0.5 }, NO_CARRY, NO_DIVIDERS, ring);
    // t1 spans x 0..0.5; seamHalf = min(ring/2 = 0.02, half its band = 0.0625) = 0.02,
    // so the seam band claims 0.48..0.5 and the rest of the band means "split t1".
    expect(over(0.49)).toEqual({
      tileId: "t1",
      edge: "right",
      action: "place",
      depth: 1,
      between: true,
    });
    expect(over(0.4)).toEqual({
      tileId: "t1",
      edge: "right",
      action: "place",
      depth: 1,
      between: false,
    });
    // The neighbor's flank mirrors it: near-seam wedges, deeper splits t2 alone.
    expect(over(0.51)?.between).toBe(true);
    expect(over(0.6)?.between).toBe(false);
    // An outer border has no neighbor to wedge against: never between.
    expect(over(0.07)?.between).toBe(false);
  });

  test("the between boundary holds under its own hysteresis margin", () => {
    const layout = rowLayout();
    const ring = { x: 0.04, y: 0.04 } as const;
    const over = (
      x: number,
      held: { tileId: string; edge: TileEdge; between?: boolean } | null,
    ): TileAim | null => resolveTileAim(layout, { x, y: 0.5 }, NO_CARRY, NO_DIVIDERS, ring, held);
    // Seam band boundary at 0.48; margin = 0.06 × 0.5 = 0.03. A held BETWEEN keeps
    // wedging down to 0.45, while an unheld pointer there already reads split.
    expect(over(0.46, { tileId: "t1", edge: "right", between: true })?.between).toBe(true);
    expect(over(0.46, { tileId: "t1", edge: "right", between: false })?.between).toBe(false);
    // A held SPLIT shrinks the seam strip away entirely: even 0.49 stays split.
    expect(over(0.49, { tileId: "t1", edge: "right", between: false })?.between).toBe(false);
    // Past the margin the flip is real, held or not.
    expect(over(0.4, { tileId: "t1", edge: "right", between: true })?.between).toBe(false);
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

  test("a between aim rides the wire destination; a split aim stays lean", () => {
    const wedge: TileAim = { tileId: "t2", edge: "left", action: "place", depth: 1, between: true };
    expect(
      tileDestinationFor(wedge, { containerId: "view-1", widget: null, rootIsLeaf: false }),
    ).toEqual({ kind: "tile", padId: "view-1", targetTileId: "t2", edge: "left", between: true });
    const split: TileAim = {
      tileId: "t2",
      edge: "left",
      action: "place",
      depth: 1,
      between: false,
    };
    expect(
      tileDestinationFor(split, { containerId: "view-1", widget: null, rootIsLeaf: false }),
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
