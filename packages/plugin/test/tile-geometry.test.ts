import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  type TileEdge,
  type TileLayout,
  type Tile,
  type TileRef,
} from "@manifold/protocol";
import { withVacantLeaf } from "@manifold/scene";

import {
  RING_AXIS_CAP,
  RING_LEAF_CAP,
  ROOT_RING_PX,
  layoutRevision,
  paneShifts,
  resolveTileAim,
  ringFraction,
  tileChainAt,
  tileDestinationFor,
  tileRects,
  type TileAim,
  type TileAimCarry,
  type UnitPoint,
} from "../src/tile-geometry.ts";

const terminal = (terminalId: string): TileRef => ({ kind: "terminal", terminalId });

function leaf(id: string, ref: TileRef | null = null): Tile {
  return { id, dir: null, ratios: [], children: [], ref };
}

function split(
  id: string,
  dir: "row" | "column",
  children: readonly string[],
  ratios: readonly number[],
): Tile {
  return { id, dir, ratios: [...ratios], children: [...children], ref: null };
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

/** `A | (B/(C|D))`: the tree reported in #60, three levels deep. */
function deepLayout(): TileLayout {
  return {
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["tA", "tCol"], [1, 1]),
    tA: leaf("tA", terminal("sA")),
    tCol: split("tCol", "column", ["tB", "tRow"], [1, 1]),
    tB: leaf("tB", terminal("sB")),
    tRow: split("tRow", "row", ["tC", "tD"], [1, 1]),
    tC: leaf("tC", terminal("sC")),
    tD: leaf("tD", terminal("sD")),
  };
}

/** A 2×2 grid: two rows in a column, so four seams meet at one junction. */
function gridLayout(): TileLayout {
  return {
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "column", ["rowTop", "rowBottom"], [1, 1]),
    rowTop: split("rowTop", "row", ["tA", "tB"], [1, 1]),
    tA: leaf("tA", terminal("sA")),
    tB: leaf("tB", terminal("sB")),
    rowBottom: split("rowBottom", "row", ["tC", "tD"], [1, 1]),
    tC: leaf("tC", terminal("sC")),
    tD: leaf("tD", terminal("sD")),
  };
}

const NO_DIVIDERS = { x: 0, y: 0 } as const;
const NO_CARRY: TileAimCarry = { carriedTileId: null, holdsTileSeat: false };
const SEAT_CARRY: TileAimCarry = { carriedTileId: null, holdsTileSeat: true };
const RING = { x: 0.05, y: 0.05 } as const;

/*
  The seam fixtures every band test shares. With these dividers a root row of equal
  halves puts its gap at x 0.49..0.51, and seamHalf = min(ring.x / 2 = 0.02,
  0.5 × SNAP_EDGE_BAND × 0.49 = 0.06125) = 0.02, so the band spans 0.47..0.53 and the
  five offsets below sample both flanks and the gap itself.
*/
const SEAM_DIVIDERS = { x: 0.02, y: 0.02 } as const;
const SEAM_RING = { x: 0.04, y: 0.04 } as const;
const ACROSS_THE_BAND = [0.475, 0.481, 0.5, 0.519, 0.525] as const;

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
    const layout = deepLayout();
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
    const slotted = withVacantLeaf(layout, "tRow", "bottom");
    expect(slotted?.layout["tCol"]?.children).toEqual(["tB", "tRow", slotted?.vacantLeafId ?? ""]);
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
    // so the seam band claims 0.48..0.52 and the rest of the band means "split t1".
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
    // The TRAILING flank answers the SAME seam by the SAME name — one insert has one
    // address, whichever side of the gap the pointer came from.
    expect(over(0.51)).toEqual({
      tileId: "t1",
      edge: "right",
      action: "place",
      depth: 1,
      between: true,
    });
    // Beyond the band, the flank is the pane's own split again.
    expect(over(0.6)).toEqual({
      tileId: "t2",
      edge: "left",
      action: "place",
      depth: 1,
      between: false,
    });
    // An outer border has no neighbor to wedge against: never between.
    expect(over(0.07)?.between).toBe(false);
  });

  test("a seam's hysteresis holds both of its boundaries", () => {
    const layout = rowLayout();
    const over = (
      x: number,
      y: number,
      held: { tileId: string; edge: TileEdge; between?: boolean } | null,
    ): TileAim | null => resolveTileAim(layout, { x, y }, NO_CARRY, NO_DIVIDERS, SEAM_RING, held);
    /*
      ACROSS the band: t1 spans x 0..0.5, so seamHalf is min(SEAM_RING.x / 2 = 0.02,
      0.5 × 0.25 × 0.5 = 0.0625) = 0.02 and the band's lip sits at 0.48. The margin is
      BOUNDED by half the band it modulates (0.01 here, not 0.06 × 0.5 = 0.03), so
      membership only ever spans [0.5, 1.5] × seamHalf: 0.03 deep while this seam is
      the aim already painted, 0.01 deep while anything else is.

      The bound is the fix for a latch. `ZONE_HYSTERESIS` is an AREA fraction while the
      band is device px converted to one, so the unbounded margin was ~3× the whole
      band: with any other aim held the band collapsed to nothing, and a pointer
      approaching a seam from inside a flank IS "another aim held", so the seam could
      not be entered by approach at all — only by crossing in from the neighbour.
    */
    const seamHalf = 0.02;
    const heldSeam = { tileId: "t1", edge: "right", between: true } as const;
    const heldSplit = { tileId: "t1", edge: "right", between: false } as const;
    // A held NON-seam aim still leaves half the band: the seam stays enterable.
    expect(over(0.5 - seamHalf * 0.4, 0.5, { tileId: "t1", edge: "left" })?.between).toBe(true);
    expect(over(0.5 - seamHalf * 0.4, 0.5, heldSplit)?.between).toBe(true);
    // …and no more than half, so a held split still earns the strip it stands in.
    expect(over(0.5 - seamHalf * 0.6, 0.5, heldSplit)?.between).toBe(false);
    // A held seam reaches 1.5 × seamHalf outward, and not one margin beyond.
    expect(over(0.5 - seamHalf * 1.4, 0.5, heldSeam)?.between).toBe(true);
    expect(over(0.5 - seamHalf * 1.6, 0.5, heldSeam)?.between).toBe(false);
    // The nominal lip is where an unheld pointer flips, between those two.
    expect(over(0.5 - seamHalf * 0.9, 0.5, null)?.between).toBe(true);
    expect(over(0.5 - seamHalf * 1.1, 0.5, null)?.between).toBe(false);
    /*
      ALONG the seam, now measured in the SAME px-derived units as the band across it: the
      end stretch is four ring-widths (0.16 here) out of a root row spanning the whole
      height, its margin is bounded by half of that (0.06, `ZONE_HYSTERESIS` × 1 being the
      smaller of the two), and the ROOT RING owns the outer ring-width (y < 0.04) as it
      always has. So the end is live in y 0.04..0.16, a held middle pulls it back to 0.10,
      and a held end pushes it out to 0.22 — a full ring-width of it survives even the
      held-middle state, which is what keeps a pointer travelling out of the middle able to
      reach the end at all.
    */
    const rootTop: TileAim = { tileId: ROOT_TILE_ID, edge: "top", action: "place", depth: 0 };
    expect(over(0.5, 0.14, null)).toEqual(rootTop);
    expect(over(0.5, 0.14, { tileId: "t1", edge: "right", between: true })?.between).toBe(true);
    expect(over(0.5, 0.18, null)?.between).toBe(true);
    expect(over(0.5, 0.18, rootTop)).toEqual(rootTop);
    // Inside the held-middle boundary the end answers whatever is held.
    expect(over(0.5, 0.06, { tileId: "t1", edge: "right", between: true })).toEqual(rootTop);
  });

  test("a seam band answers by position ALONG the seam, never by perpendicular offset", () => {
    /*
      THE SEAM INVARIANT, and the regression test for dev.16's split brain: the gap
      column was resolved by one function that subdivided ALONG the seam (outer
      stretches -> split the group, middle -> between) while the flank strips were
      resolved by another that only measured distance ACROSS it. So a single seam
      answered three different things at one height — t1/right/between on the left
      flank, root/bottom in the gap, t2/left/between on the right flank — which is
      both an interleaving and a DUAL ADDRESSING of one insert. A seam is ONE object.
    */
    const layout = rowLayout([0.5, 0.5]);
    const cases: readonly (readonly [number, TileAim])[] = [
      // The middle of the seam: wedge in after t1, canonically addressed ONCE.
      [0.5, { tileId: "t1", edge: "right", action: "place", depth: 1, between: true }],
      // Both outer stretches: split the GROUP the seam belongs to, across. Three ring-widths
      // deep (0.88..0.96 here), the outer ring-width of which is the root ring's.
      [0.9, { tileId: ROOT_TILE_ID, edge: "bottom", action: "place", depth: 0 }],
      [0.94, { tileId: ROOT_TILE_ID, edge: "bottom", action: "place", depth: 0 }],
    ];
    for (const [along, expected] of cases) {
      const answers = ACROSS_THE_BAND.map((x) =>
        resolveTileAim(layout, { x, y: along }, NO_CARRY, SEAM_DIVIDERS, SEAM_RING),
      );
      for (const [index, answer] of answers.entries()) {
        expect(answer, `x=${ACROSS_THE_BAND[index] ?? 0} at along=${along}`).toEqual(expected);
      }
    }
  });

  test("both flanks of a seam middle name the LEADING child's trailing edge", () => {
    const layout = rowLayout([0.5, 0.5]);
    const leading: TileAim = {
      tileId: "t1",
      edge: "right",
      action: "place",
      depth: 1,
      between: true,
    };
    for (const x of ACROSS_THE_BAND) {
      const aim = resolveTileAim(layout, { x, y: 0.5 }, NO_CARRY, SEAM_DIVIDERS, SEAM_RING);
      expect(aim, `x=${x}`).toEqual(leading);
    }
    // The trailing child's own name for the very same insert is never produced.
    const trailing = resolveTileAim(
      layout,
      { x: 0.525, y: 0.5 },
      NO_CARRY,
      SEAM_DIVIDERS,
      SEAM_RING,
    );
    expect(trailing?.tileId).not.toBe("t2");
    expect(trailing?.edge).not.toBe("left");
  });

  test("an ancestor's seam band reaches through a descendant's flank", () => {
    const layout: TileLayout = {
      [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["tA", "tCol"], [1, 1]),
      tA: leaf("tA", terminal("sA")),
      tCol: split("tCol", "column", ["tB", "tC"], [1, 1]),
      tB: leaf("tB", terminal("sB")),
      tC: leaf("tC", terminal("sC")),
    };
    const over = (x: number, y: number): TileAim | null =>
      resolveTileAim(layout, { x, y }, NO_CARRY, SEAM_DIVIDERS, SEAM_RING);
    /*
      tB is the column's TOP half, so x 0.52 is a flank of the ROOT's seam that happens
      to lie inside a grandchild. dev.16 read a split of tB there and could not answer
      between at all, while the two-pixel gap column beside it could — the same
      divergence as the interleaving, one level up.
    */
    const middle: TileAim = {
      tileId: "tA",
      edge: "right",
      action: "place",
      depth: 1,
      between: true,
    };
    for (const x of [0.48, 0.5, 0.52]) expect(over(x, 0.4), `x=${x}`).toEqual(middle);
    // And the seam's top end splits the ROOT across, from every offset alike.
    const end: TileAim = { tileId: ROOT_TILE_ID, edge: "top", action: "place", depth: 0 };
    for (const x of [0.48, 0.5, 0.52]) expect(over(x, 0.1), `x=${x}`).toEqual(end);
  });

  test("crossing seams at a junction answer deterministically", () => {
    const layout = gridLayout();
    const over = (x: number, y: number): TileAim | null =>
      resolveTileAim(layout, { x, y }, NO_CARRY, SEAM_DIVIDERS, SEAM_RING);
    /*
      In a 2×2 grid the root's seam and both row seams overlap around (0.5, 0.5). A tie
      on penetration goes to the DEEPER split, so the row the pointer is inside wins —
      and the pointer sits at the far end of that row's own seam, which grows a
      full-width pane between the two rows. The quadrant only decides which row cedes.
    */
    const underTop: TileAim = { tileId: "rowTop", edge: "bottom", action: "place", depth: 1 };
    const overBottom: TileAim = { tileId: "rowBottom", edge: "top", action: "place", depth: 1 };
    expect(over(0.48, 0.48)).toEqual(underTop);
    expect(over(0.52, 0.48)).toEqual(underTop);
    expect(over(0.48, 0.52)).toEqual(overBottom);
    expect(over(0.52, 0.52)).toEqual(overBottom);
    // The junction itself is inside no row at all, so it is the root's own seam middle.
    expect(over(0.5, 0.5)).toEqual({
      tileId: "rowTop",
      edge: "bottom",
      action: "place",
      depth: 1,
      between: true,
    });
  });

  test("a seam end answers the group aim across the band's full thickness (#60)", () => {
    const layout = deepLayout();
    const over = (x: number, y: number): TileAim | null =>
      resolveTileAim(layout, { x, y }, NO_CARRY, SEAM_DIVIDERS, SEAM_RING);
    /*
      tRow spans x 0.51..1 and y 0.51..1, and its own gap is x 0.745..0.765. At y 0.95
      the pointer is in that seam's bottom end stretch, where the answer must be the
      group's split whether the pointer stands in the gap or on either flank — dev.16
      answered the group from the gap alone and `between` from both flanks.
    */
    const group: TileAim = { tileId: "tRow", edge: "bottom", action: "place", depth: 2 };
    for (const x of [0.735, 0.755, 0.775]) expect(over(x, 0.95), `x=${x}`).toEqual(group);
    const wedge: TileAim = {
      tileId: "tC",
      edge: "right",
      action: "place",
      depth: 3,
      between: true,
    };
    for (const x of [0.735, 0.755, 0.775]) expect(over(x, 0.75), `x=${x}`).toEqual(wedge);
  });

  test("a 60×60 sweep never throws and every between answer is canonical", () => {
    for (const layout of [rowLayout([0.5, 0.5]), nestedLayout(), deepLayout()]) {
      for (let column = 0; column < 60; column += 1) {
        for (let row = 0; row < 60; row += 1) {
          const point = { x: (column + 0.5) / 60, y: (row + 0.5) / 60 };
          const aim = resolveTileAim(layout, point, NO_CARRY, SEAM_DIVIDERS, SEAM_RING);
          if (aim === null || aim.between !== true) continue;
          const where = `${aim.tileId}/${aim.edge} at ${point.x},${point.y}`;
          /*
            CANONICAL FORM: a between aim is always a seam's LEADING child, so it names
            a leaf that has a same-axis trailing neighbour under some split. Anything
            else would be a second address for an insert that already has one.
          */
          expect(layout[aim.tileId]?.dir, where).toBeNull();
          expect(aim.edge === "right" || aim.edge === "bottom", where).toBe(true);
          const dir = aim.edge === "right" ? "row" : "column";
          const hasTrailingNeighbour = Object.values(layout).some((node) => {
            if (node.dir !== dir) return false;
            const index = node.children.indexOf(aim.tileId);
            return index >= 0 && index + 1 < node.children.length;
          });
          expect(hasTrailingNeighbour, where).toBe(true);
        }
      }
    }
  });

  test("every column across a seam band is uniform, swept along the whole seam", () => {
    /*
      The band invariance, swept: 50 positions ALONG a seam × the 5 offsets ACROSS it,
      which is also how "no between answer exists in an end stretch" is proven — the
      ends are asserted structural at every one of those positions. Where two bands
      OVERLAP (a T-junction) the deeper seam legitimately governs the side it exists
      on, so each sweep skips the positions its crossing seam claims, and that crossing
      seam is then swept in its own right.

      `endFraction` is the end stretch expressed in the split's own extent, and it is a
      COMPUTED number now rather than the flat 0.25 it used to be: the stretch is three
      ring-widths of the perpendicular axis, capped at `SNAP_EDGE_BAND`, so it tracks
      device px exactly as the band across the seam does.
    */
    const uniform = (
      layout: TileLayout,
      alongs: readonly number[],
      at: (across: number, along: number) => UnitPoint,
      fraction: (along: number) => number,
      endFraction: number,
    ): void => {
      for (const along of alongs) {
        const answers = ACROSS_THE_BAND.map((across) =>
          resolveTileAim(layout, at(across, along), NO_CARRY, SEAM_DIVIDERS, SEAM_RING),
        );
        const first = answers[0] ?? null;
        for (const [index, answer] of answers.entries()) {
          expect(answer, `across=${ACROSS_THE_BAND[index] ?? 0} along=${along}`).toEqual(first);
        }
        const atFraction = fraction(along);
        if (atFraction < endFraction || atFraction > 1 - endFraction) {
          expect(first?.between, `end stretch at along=${along}`).not.toBe(true);
        }
      }
    };
    const alongs = Array.from({ length: 50 }, (_, index) => (index + 0.5) / 50);
    const unitFraction = (along: number): number => along;
    // Four ring-widths out of a full-height root row: the ends are y < 0.16 and y > 0.84.
    const rootEnd = 4 * SEAM_RING.y;
    // `A | B`: one seam, with nothing crossing it anywhere.
    uniform(
      rowLayout([0.5, 0.5]),
      alongs,
      (across, along) => ({ x: across, y: along }),
      unitFraction,
      rootEnd,
    );
    // `A | (B/C)`: the root seam, minus the positions the inner column's seam claims…
    const nested = nestedLayout();
    uniform(
      nested,
      alongs.filter((along) => along < 0.46 || along > 0.54),
      (across, along) => ({ x: across, y: along }),
      unitFraction,
      rootEnd,
    );
    // …and that inner seam swept in turn, along t3's own rect (x 0.51..1). Four ring-widths
    // would be a larger fraction of a narrower split, so here the `SNAP_EDGE_BAND` cap is
    // what binds instead — the middle keeps half the seam whatever the ring measures.
    uniform(
      nested,
      alongs.filter((along) => along > 0.54),
      (across, along) => ({ x: along, y: across }),
      (along) => (along - 0.51) / 0.49,
      Math.min((4 * SEAM_RING.x) / 0.49, 0.25),
    );
  });

  test("a seam's ends are a constant on-screen length, not a fraction of the seam", () => {
    /*
      Audit 2.6, and the whole of what "one unit derivation" buys. The band ACROSS a seam
      has always been px-derived (`ROOT_RING_PX` converted against the area), while the end
      stretches ALONG it cut at a flat `SNAP_EDGE_BAND` of the split's perpendicular extent
      — so on a 1600 px composition the "split this group across" target was 400 px long
      and 20 px thin, and on a 400 px one it was 100 px long: two unit spaces on one object,
      and an aspect ratio no pointer gesture matches. Measured in px it is now the same
      target at any size, which is the assertion.
    */
    const layout = rowLayout([0.5, 0.5]);
    const endBoundaryPx = (areaPx: number): number => {
      const ring = { x: ROOT_RING_PX / areaPx, y: ROOT_RING_PX / areaPx } as const;
      for (let px = 1; px < areaPx / 2; px += 1) {
        const aim = resolveTileAim(
          layout,
          { x: 0.5, y: px / areaPx },
          NO_CARRY,
          SEAM_DIVIDERS,
          ring,
        );
        // Walking inward from the seam's low end: the first pixel that means "wedge
        // between these two" is where the end stretch stops.
        if (aim?.between === true) return px;
      }
      return -1;
    };
    /*
      Three ring-widths, to within the pixel that float wobble in the unit conversion can
      move a boundary, on two areas a factor of four apart. The old rule answered 400 px
      on the wide one and 100 px on the narrow one.
    */
    const wide = endBoundaryPx(1600);
    const narrow = endBoundaryPx(400);
    for (const measured of [wide, narrow]) {
      expect(measured).toBeGreaterThanOrEqual(4 * ROOT_RING_PX);
      expect(measured).toBeLessThan(4 * ROOT_RING_PX + 2);
    }
    expect(Math.abs(wide - narrow)).toBeLessThanOrEqual(1);
  });

  test("the layout revision follows structure and occupancy, never proportions", () => {
    /*
      Audit 3.3's input. The stamp exists so a viewer can tell a tree it can re-derive an
      aim against from one it cannot, and it is DERIVED rather than counted because a
      document revision moves when a note is dragged three rooms away.
    */
    expect(layoutRevision(rowLayout())).toBe(layoutRevision(rowLayout()));
    // Ratios move continuously under a divider drag and change no aim's meaning, so
    // suppressing every peer's preview for the duration would be the wrong trade.
    expect(layoutRevision(rowLayout([1, 3]))).toBe(layoutRevision(rowLayout()));
    // Structure, order and what a leaf shows all change what an aim's tile id means.
    expect(layoutRevision(nestedLayout())).not.toBe(layoutRevision(rowLayout()));
    const swapped: TileLayout = {
      ...rowLayout(),
      [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t2", "t1"], [1, 1]),
    };
    expect(layoutRevision(swapped)).not.toBe(layoutRevision(rowLayout()));
    const reoccupied: TileLayout = { ...rowLayout(), t2: leaf("t2", terminal("other")) };
    expect(layoutRevision(reoccupied)).not.toBe(layoutRevision(rowLayout()));
  });

  test("a seam band stays enterable at a real on-screen ring width", () => {
    /*
      The latch in the units, measured the way it ships: a 20 px ring on a 1600 px area
      is 0.0125 of the axis, so seamHalf is 0.00625 — a fifth of `ZONE_HYSTERESIS`.
      Before the bound, "something else is held" (which is every pointer approaching
      from inside a flank) drove the threshold to 0 and the seam was reachable only by
      crossing the divider from the neighbour. Bounded, it is always half the band.
    */
    const ring = { x: 20 / 1600, y: 20 / 1600 } as const;
    const seamHalfPx = ring.x / 2;
    const over = (
      x: number,
      held: { tileId: string; edge: TileEdge; between?: boolean } | null,
    ): TileAim | null =>
      resolveTileAim(rowLayout(), { x, y: 0.5 }, NO_CARRY, NO_DIVIDERS, ring, held);
    // Half the band survives a rival aim…
    expect(over(0.5 - seamHalfPx * 0.4, { tileId: "t1", edge: "left" })?.between).toBe(true);
    // …the nominal band answers an unheld pointer…
    expect(over(0.5 - seamHalfPx * 0.9, null)?.between).toBe(true);
    // …and holding the seam itself stretches it to 1.5×, never further.
    const heldSeam = { tileId: "t1", edge: "right", between: true } as const;
    expect(over(0.5 - seamHalfPx * 1.4, heldSeam)?.between).toBe(true);
    expect(over(0.5 - seamHalfPx * 1.6, heldSeam)?.between).toBe(false);
  });

  test("the root ring holds its frontier against the leaf's own band", () => {
    /*
      The ring/leaf frontier separates a whole-area reflow from a one-pane split, so it
      needs hysteresis more than any other boundary, not less. `RING` is 0.05 and the
      left leaf is 0.5 wide, so the nominal band is 0.05 and the bounded margin 0.025.
    */
    const layout = rowLayout();
    const ring = { x: 0.05, y: 0 } as const;
    const over = (x: number, held: { tileId: string; edge: TileEdge } | null): TileAim | null =>
      resolveTileAim(layout, { x, y: 0.5 }, NO_CARRY, NO_DIVIDERS, ring, held);
    const rootLeft: TileAim = { tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 };
    const leafLeft: TileAim = {
      tileId: "t1",
      edge: "left",
      action: "place",
      depth: 1,
      between: false,
    };
    // Just outside the nominal ring: the leaf's band, unless the ring is the held aim.
    expect(over(0.06, null)).toEqual(leafLeft);
    expect(over(0.06, rootLeft)).toEqual(rootLeft);
    // Just inside it: the ring, unless something else is held.
    expect(over(0.03, null)).toEqual(rootLeft);
    expect(over(0.03, { tileId: "t1", edge: "left" })).toEqual(leafLeft);
    // The shrink is bounded at half the band, so a held leaf can never erase the ring.
    expect(over(0.02, { tileId: "t1", edge: "left" })).toEqual(rootLeft);
    // Growth is per-border: holding the LEFT ring does not widen the right one.
    expect(over(0.94, rootLeft)?.tileId).toBe("t2");
  });

  test("the leaf cap binds on a trailing border whose accumulated edge lands short of 1", () => {
    /*
      `tileRects` accumulates `cursor += share + divider`, so a split's far edge is
      1 ± ~1e-16 — here provably BELOW 1. An exact `>= 1` contact test found no leaf on
      that border, `minTouchingLeaf` stayed 1 and `RING_LEAF_CAP` silently stopped
      binding: the ring grew to the axis cap and swallowed the leaf's own right band, on
      some window widths and not others. Which is to say two viewers of one tree saw
      different zones.
    */
    const layout: TileLayout = {
      [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t1", "t2", "t3", "t4"], [1, 1, 1, 1]),
      t1: leaf("t1", terminal("s1")),
      t2: leaf("t2", terminal("s2")),
      t3: leaf("t3", terminal("s3")),
      t4: leaf("t4", terminal("s4")),
    };
    const dividers = { x: 8 / 1200, y: 0 } as const;
    const trailing = tileRects(layout, dividers).get("t4");
    // The precondition this test exists for; without it the assertion below is vacuous.
    expect((trailing?.x ?? 0) + (trailing?.width ?? 0)).toBeLessThan(1);
    expect(ringFraction(0.15, trailing?.width ?? 0)).toBeCloseTo(RING_LEAF_CAP * 0.245, 12);
    // x 0.945 is 0.055 from the border: past the leaf-capped ring (0.049), so it is
    // t4's own right band. Uncapped (0.15, the axis cap) the root would claim it.
    expect(
      resolveTileAim(layout, { x: 0.945, y: 0.5 }, NO_CARRY, dividers, { x: 0.15, y: 0 }),
    ).toEqual({ tileId: "t4", edge: "right", action: "place", depth: 1, between: false });
  });

  test("a member of a two-child split aims at nothing along its whole seam", () => {
    /*
      The seam ENDS mean "split this group across", but a pair's member cannot: its own
      departure collapses the split, so the id the aim names is gone from the pruned
      tree and `tileProspect` answers null — a zone that paints nothing and commits
      nothing while looking live. The middle already refused as a no-op; the ends now do
      too, and only for a PAIR: a wider split survives its member leaving.
    */
    const dividers = { x: 0.02, y: 0 } as const;
    // Both axes carry a ring now: the ALONG axis is what the end stretch is derived from,
    // so a zero there would leave the seam with no ends to refuse in the first place.
    const ring = { x: 0.04, y: 0.04 } as const;
    const pair = rowLayout();
    const overPair = (y: number, carriedTileId: string | null): TileAim | null =>
      resolveTileAim(pair, { x: 0.5, y }, { carriedTileId, holdsTileSeat: true }, dividers, ring);
    // Both ends of the seam are live structural targets for an outside carry…
    expect(overPair(0.1, null)).toEqual({
      tileId: ROOT_TILE_ID,
      edge: "top",
      action: "place",
      depth: 0,
    });
    expect(overPair(0.9, null)?.edge).toBe("bottom");
    // …and nothing at all for either member of the pair, at either end or the middle.
    for (const carried of ["t1", "t2"]) {
      expect(overPair(0.1, carried), `end at ${carried}`).toBeNull();
      expect(overPair(0.9, carried), `end at ${carried}`).toBeNull();
      expect(overPair(0.5, carried), `middle at ${carried}`).toBeNull();
    }
    // A THREE-child split survives its member's departure, so its seam ends stay live.
    const trio: TileLayout = {
      [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t1", "t2", "t3"], [1, 1, 1]),
      t1: leaf("t1", terminal("s1")),
      t2: leaf("t2", terminal("s2")),
      t3: leaf("t3", terminal("s3")),
    };
    // x 0.33 stands in the t1/t2 gap (t1 ends at 0.32, t2 starts at 0.34).
    const carried: TileAimCarry = { carriedTileId: "t1", holdsTileSeat: true };
    expect(resolveTileAim(trio, { x: 0.33, y: 0.1 }, carried, dividers, ring)).toEqual({
      tileId: ROOT_TILE_ID,
      edge: "top",
      action: "place",
      depth: 0,
    });
    // Its middle is still the no-op it always was.
    expect(resolveTileAim(trio, { x: 0.33, y: 0.5 }, carried, dividers, ring)).toBeNull();
  });
});

describe("paneShifts", () => {
  const DIVIDERS = { x: 0.02, y: 0.02 } as const;

  test("a root split reports exactly one shift carrying the renamed pane's old rect", () => {
    const current: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s1")) };
    const slotted = withVacantLeaf(current, ROOT_TILE_ID, "right");
    expect(slotted).not.toBeNull();
    const shifts = paneShifts(current, slotted?.layout ?? {}, DIVIDERS);
    expect(shifts).toHaveLength(1);
    const shift = shifts[0];
    // The NEW id with the OLD rect as `from`: this pins the root-rename against a
    // spurious unmount — an id-matched diff would lose the one pane that must move.
    expect(shift?.tileId).not.toBe(ROOT_TILE_ID);
    expect(slotted?.layout[shift?.tileId ?? ""]?.ref).toEqual(terminal("s1"));
    expect(shift?.fromTileId).toBe(ROOT_TILE_ID);
    expect(shift?.from).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(shift?.to.width).toBeCloseTo(0.49, 6);
  });

  test("an untouched sibling produces no shift", () => {
    const current = rowLayout();
    const slotted = withVacantLeaf(current, "t2", "bottom");
    const shifts = paneShifts(current, slotted?.layout ?? {}, DIVIDERS);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]?.tileId).toBe("t2");
    expect(shifts[0]?.fromTileId).toBe("t2");
  });

  test("a structurally identical next layout shifts nothing", () => {
    expect(paneShifts(rowLayout(), rowLayout(), DIVIDERS)).toEqual([]);
  });

  /** `s1` shown twice in one container, which the placement executor allows outright. */
  const twinLayout = (): TileLayout => ({
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "row", ["t1", "t2"], [1, 1]),
    t1: leaf("t1", terminal("s1")),
    t2: leaf("t2", terminal("s1")),
  });

  /** The same pair, squeezed into the top half by a newcomer below. */
  const twinSplitLayout = (): TileLayout => ({
    [ROOT_TILE_ID]: split(ROOT_TILE_ID, "column", ["inner", "slot"], [1, 1]),
    inner: split("inner", "row", ["t1", "t2"], [1, 1]),
    t1: leaf("t1", terminal("s1")),
    t2: leaf("t2", terminal("s1")),
    slot: leaf("slot"),
  });

  test("one ref in two leaves is two panes, each shifting from its own box", () => {
    /*
      A second leaf for a terminal already living here "is simply another copy of it" —
      duplicates are legal, so a seat table keyed by bare ref identity kept only the
      last leaf and pointed BOTH prospective panes at it: two transforms written to one
      box, last one winning, the other pane frozen. Ordinals, in `tile-tree.tsx`'s own
      document order, are what make a pane a pane.
    */
    const shifts = paneShifts(twinLayout(), twinSplitLayout(), DIVIDERS);
    expect(shifts).toHaveLength(2);
    expect(shifts.map((shift) => shift.fromTileId).sort()).toEqual(["t1", "t2"]);
    // Each copy glides from its OWN box to its own place, never from its twin's.
    for (const shift of shifts) {
      expect(shift.fromTileId, shift.tileId).toBe(shift.tileId);
      expect(shift.from.height).toBe(1);
      expect(shift.to.height).toBeCloseTo(0.49, 12);
    }
  });

  test("a zero-extent origin is dropped rather than divided by", () => {
    // Dividers thicker than the axis they subdivide leave every child zero-wide. A FLIP
    // divides travel by the origin's extent, so such a shift would paint `scale(NaN)`.
    const degenerate = { x: 1, y: 0 } as const;
    const rects = tileRects(twinLayout(), degenerate);
    expect(rects.get("t1")?.width).toBe(0);
    expect(paneShifts(twinLayout(), twinSplitLayout(), degenerate)).toEqual([]);
    // The same pair of layouts really does shift when the geometry is sane.
    expect(paneShifts(twinLayout(), twinSplitLayout(), DIVIDERS)).toHaveLength(2);
  });
});

describe("tileDestinationFor", () => {
  const aim: TileAim = { tileId: "t2", edge: "left", action: "place", depth: 1 };

  test("a multi-tile container is a tile destination naming the aimed leaf", () => {
    expect(
      tileDestinationFor(aim, { containerId: "view-1", portal: null, rootIsLeaf: false }),
    ).toEqual({ kind: "tile", containerId: "view-1", targetTileId: "t2", edge: "left" });
    // A portal over a MULTI-tile container also addresses the leaf directly.
    expect(
      tileDestinationFor(aim, {
        containerId: "view-1",
        portal: { containerId: "canvas-1", elementId: "el-1" },
        rootIsLeaf: false,
      }),
    ).toEqual({ kind: "tile", containerId: "view-1", targetTileId: "t2", edge: "left" });
  });

  test("a between aim rides the wire destination; a split aim stays lean", () => {
    const wedge: TileAim = { tileId: "t2", edge: "left", action: "place", depth: 1, between: true };
    expect(
      tileDestinationFor(wedge, { containerId: "view-1", portal: null, rootIsLeaf: false }),
    ).toEqual({
      kind: "tile",
      containerId: "view-1",
      targetTileId: "t2",
      edge: "left",
      between: true,
    });
    const split: TileAim = {
      tileId: "t2",
      edge: "left",
      action: "place",
      depth: 1,
      between: false,
    };
    expect(
      tileDestinationFor(split, { containerId: "view-1", portal: null, rootIsLeaf: false }),
    ).toEqual({ kind: "tile", containerId: "view-1", targetTileId: "t2", edge: "left" });
  });

  test("a solo canvas portal keeps the compose door", () => {
    const solo: TileAim = { tileId: ROOT_TILE_ID, edge: "bottom", action: "place", depth: 0 };
    expect(
      tileDestinationFor(solo, {
        containerId: "view-1",
        portal: { containerId: "canvas-1", elementId: "el-1" },
        rootIsLeaf: true,
      }),
    ).toEqual({
      kind: "compose",
      containerId: "canvas-1",
      targetElementId: "el-1",
      edge: "bottom",
    });
  });

  test("a solo container on the fullscreen route addresses its own root leaf", () => {
    const solo: TileAim = { tileId: ROOT_TILE_ID, edge: "right", action: "place", depth: 0 };
    expect(
      tileDestinationFor(solo, { containerId: "view-1", portal: null, rootIsLeaf: true }),
    ).toEqual({ kind: "tile", containerId: "view-1", targetTileId: ROOT_TILE_ID, edge: "right" });
  });
});
