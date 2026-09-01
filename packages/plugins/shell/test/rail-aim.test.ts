import { describe, expect, test } from "bun:test";
import { projectSectionArrangement, type SectionProjection } from "@manifold/plugin";
import { resolveTileAim, tileRects, type TileAim } from "@manifold/plugin/hooks";
import type { SectionNode } from "@manifold/protocol";
import { railExtents, railPoint, stackPoint, type RailBox } from "../src/rail-aim.ts";

/**
 * WHERE THE RAIL'S DROP BANDS ARE, as arithmetic.
 *
 * Both failures issue #124 reported were geometry, and both were invisible to every assertion
 * that only asked whether a band resolved: the bands DID resolve, tens of pixels away from the
 * rows they were painted over. So these tests do not check that an aim exists — they check WHICH
 * PIXEL means what, against boxes measured off the real rail, which is the only form the bug had.
 *
 * The rail's own reading is two functions and they compose in one order: {@link railPoint} maps a
 * client pixel into the projected tree's unit space by descending the painted boxes, and
 * {@link stackPoint} then reduces that point to the vocabulary a stack has — boundaries.
 */

/** The rail as measured in a 1440×900 headless window: `.sidebar-sections` and its rows. */
const AREA: RailBox = { left: 10.39, top: 10.39, width: 293.78, height: 792.22 };
const GAP = 6.4;

const dividers = { x: GAP / AREA.width, y: GAP / AREA.height };
const RING = { x: 0, y: 0 } as const;
const CARRY = { carriedTileId: null, holdsTileSeat: false } as const;

function row(top: number, height: number, left = AREA.left, width = AREA.width): RailBox {
  return { left, top, width, height };
}

/** One resolution, exactly as `aimedHold` performs it. */
function aimAt(
  projection: SectionProjection,
  boxes: ReadonlyMap<string, RailBox>,
  clientX: number,
  clientY: number,
): TileAim | null {
  const layout = projection.layout;
  const rects = tileRects(layout, dividers);
  return resolveTileAim(
    layout,
    stackPoint(layout, rects, railPoint(layout, rects, boxes, AREA, clientX, clientY)),
    CARRY,
    dividers,
    RING,
    null,
  );
}

function ground(
  nodes: readonly SectionNode[],
  boxes: ReadonlyMap<string, RailBox>,
): SectionProjection {
  const extents = railExtents(nodes, boxes);
  return projectSectionArrangement(nodes, (path) => extents.get(path) ?? 0);
}

describe("railExtents", () => {
  test("measures every node along its parent's own axis", () => {
    const nodes: readonly SectionNode[] = ["brand", { dir: "row", sections: ["a", "b"] }];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, 37.6)],
      // Inside a `row` split the members' extent is their WIDTH, not their height.
      ["n1.0", { left: 10.39, top: 48.79, width: 126.89, height: 37.6 }],
      ["n1.1", { left: 143.68, top: 48.79, width: 126.9, height: 37.6 }],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.get("n0")).toBeCloseTo(32, 2);
    expect(extents.get("n1")).toBeCloseTo(37.6, 2);
    expect(extents.get("n1.0")).toBeCloseTo(126.89, 2);
    expect(extents.get("n1.1")).toBeCloseTo(126.9, 2);
  });

  test("a node the rail did not paint measures nothing, and keeps its place", () => {
    const nodes: readonly SectionNode[] = ["brand", "hidden", "identity"];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n2", row(48.79, 36)],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.has("n1")).toBe(false);
    expect(ground(nodes, boxes).pathOf.get("hidden")).toBe("n1");
  });
});

describe("railPoint", () => {
  /*
    THE REGRESSION, AS ONE NUMBER. A split arranged into first place reserves the collapse
    control's width (`.sidebar-split:first-child`, `shell.css`), so its two members are painted
    inside 260 px of a 294 px rail. The projection models extents along each parent's axis only —
    a stack of rows has no second dimension — so before this the pointer was normalised against
    the RAIL's width and every band inside that split sat 34 px to the right of the row it was
    drawn over: aiming at the trailing member's own visible right edge answered `center`, which
    the rail refuses, so "drag a second row in" and "reorder inside the stack" did nothing.
  */
  const nested: readonly SectionNode[] = [{ dir: "row", sections: ["brand", "canvas"] }, "index"];
  const nestedBoxes = new Map<string, RailBox>([
    // The split's border box spans the rail; its members stop 33.6 px short of it.
    ["n0", row(10.39, 37.6)],
    ["n0.0", { left: 10.39, top: 10.39, width: 126.89, height: 37.6 }],
    ["n0.1", { left: 143.68, top: 10.39, width: 126.9, height: 37.6 }],
    ["n1", row(54.39, 292.41)],
  ]);

  test("the trailing member's own right edge means 'join it, after'", () => {
    const projection = ground(nested, nestedBoxes);
    const aim = aimAt(projection, nestedBoxes, 270.58 - 6, 29.19);
    expect(aim?.tileId).toBe("n0.1");
    expect(aim?.edge).toBe("right");
  });

  test("the leading member's own left edge means 'join it, before'", () => {
    const projection = ground(nested, nestedBoxes);
    const aim = aimAt(projection, nestedBoxes, 10.39 + 4, 29.19);
    expect(aim?.tileId).toBe("n0.0");
    expect(aim?.edge).toBe("left");
  });

  test("every pixel of a nested member resolves to that member", () => {
    const projection = ground(nested, nestedBoxes);
    for (let x = 144; x <= 270; x += 2) {
      expect(aimAt(projection, nestedBoxes, x, 29.19)?.tileId).toBe("n0.1");
    }
  });

  /*
    THE CROSS AXIS CARRIES NO MEANING, and that includes being outside it: a row grab is a
    window gesture, so a hand that drifts off the rail sideways still means the row at that
    HEIGHT. Past the stack's own axis there is nothing to mean, and the kernel says so.
  */
  test("beside the rail still means the row at that height; past its end means nothing", () => {
    const projection = ground(nested, nestedBoxes);
    expect(aimAt(projection, nestedBoxes, 900, 200)?.tileId).toBe("n1");
    expect(aimAt(projection, nestedBoxes, 150, 1_400)).toBeNull();
    expect(aimAt(projection, nestedBoxes, 150, -50)).toBeNull();
  });

  test("a vacant seat is aimed at where the seat is drawn, not where its split is", () => {
    const nodes: readonly SectionNode[] = ["brand", { dir: "row", sections: [] }, "index"];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, 35.19)],
      // The seat is what the split paints, and it names the path the projection mints for it.
      ["n1.0", { left: 10.39, top: 48.79, width: 260.19, height: 35.19 }],
      ["n2", row(90.38, 292.41)],
    ]);
    const projection = ground(nodes, boxes);
    const aim = aimAt(projection, boxes, 140, 66);
    expect(aim?.tileId).toBe("n1.0");
    expect(aim?.edge).toBe("center");
  });
});

describe("stackPoint", () => {
  const flat: readonly SectionNode[] = ["brand", "canvas", "index"];
  const flatBoxes = new Map<string, RailBox>([
    ["n0", row(10.39, 32)],
    ["n1", row(48.79, 37.6)],
    ["n2", row(92.79, 292.41)],
  ]);

  /*
    AN OCCUPIED ROW HAS NO CENTRE. The cross axis is projected away, so `center` in the rail is
    the middle HALF of a row rather than a small square inside a pane — and the rail refuses a
    centre release (there is no trade in a stack). Unfolded that made half the surface a silent
    dead zone: a palette stack dropped on the middle of a row produced nothing at all.
  */
  test("the middle of a row means its nearer boundary, never a centre", () => {
    const projection = ground(flat, flatBoxes);
    const index = flatBoxes.get("n2");
    if (index === undefined) throw new Error("fixture");
    for (let y = Math.ceil(index.top) + 1; y < index.top + index.height; y += 3) {
      const aim = aimAt(projection, flatBoxes, 150, y);
      expect(aim).not.toBeNull();
      expect(aim?.edge).not.toBe("center");
      expect(aim?.tileId).toBe("n2");
    }
  });

  test("the upper half asks for 'above', the lower half for 'below'", () => {
    const projection = ground(flat, flatBoxes);
    const index = flatBoxes.get("n2");
    if (index === undefined) throw new Error("fixture");
    expect(aimAt(projection, flatBoxes, 150, index.top + index.height * 0.3)?.edge).toBe("top");
    expect(aimAt(projection, flatBoxes, 150, index.top + index.height * 0.7)?.edge).toBe("bottom");
  });

  test("a row's cross axis carries no meaning: left and right never answer in a column", () => {
    const projection = ground(flat, flatBoxes);
    for (const x of [12, 60, 150, 240, 302]) {
      const aim = aimAt(projection, flatBoxes, x, 60);
      expect(["top", "bottom"]).toContain(aim?.edge ?? "");
    }
  });

  test("inside a row split the axes swap: the height of the pointer means nothing", () => {
    const nodes: readonly SectionNode[] = [{ dir: "row", sections: ["brand", "canvas"] }, "index"];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 37.6)],
      ["n0.0", { left: 10.39, top: 10.39, width: 126.89, height: 37.6 }],
      ["n0.1", { left: 143.68, top: 10.39, width: 126.9, height: 37.6 }],
      ["n1", row(54.39, 292.41)],
    ]);
    const projection = ground(nodes, boxes);
    for (const y of [12, 20, 29, 38, 47]) {
      expect(aimAt(projection, boxes, 265, y)?.edge).toBe("right");
      expect(aimAt(projection, boxes, 14, y)?.edge).toBe("left");
    }
  });

  test("a VACANT seat keeps its centre, because filling one is what a centre release does", () => {
    const nodes: readonly SectionNode[] = ["brand", { dir: "row", sections: [] }];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, 35.19)],
      ["n1.0", { left: 10.39, top: 48.79, width: 293.78, height: 35.19 }],
    ]);
    const projection = ground(nodes, boxes);
    expect(aimAt(projection, boxes, 150, 66)?.edge).toBe("center");
  });
});
