import { describe, expect, test } from "bun:test";
import {
  projectSectionArrangement,
  releasedSectionArrangement,
  UNPAINTED_EXTENT,
  type SectionProjection,
} from "@manifold/plugin";
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

describe("an occupied stack", () => {
  /*
    WHAT A STACK CONTRIBUTES TO THE RAIL, at every occupancy it can be in (issue #143).

    The operator's report was two defects with one number behind them: a stack holding a row
    reported no height, so the rail laid the next row where the stack was not — painting it
    straight over the occupant — and left the stack no band for {@link railPoint}'s descent to
    land in, so nothing could be dragged in either. The paint half is the stylesheet's (an
    occupied `.sidebar-split` keeps the content floor every other rail row keeps); this is the
    reading half, and it is the one that decides which pixel means what.

    A stack is read along TWO axes at once and that is the whole subtlety: the stack itself
    along the rail's axis, what it holds along the stack's own. Below, the same three
    occupancies are asserted for a stack that runs DOWN the rail and one that runs ACROSS it,
    because those two cases exchange which axis is which.
  */
  const ROW_H = 37.6;

  test("empty, it reports the band it paints and mints a seat to aim into", () => {
    const nodes: readonly SectionNode[] = ["brand", { dir: "row", sections: [] }, "index"];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      // A vacant stack is spaceless at rest and a 2.2rem band while the mode is armed; armed
      // is the only state a drag can happen in, so armed is what the reading is about.
      ["n1", row(48.79, 35.19)],
      ["n1.0", row(48.79, 35.19)],
      ["n2", row(90.38, 292.41)],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.get("n1")).toBeCloseTo(35.19, 2);
    // The seat is the projection's own, and it is VACANT: `ref: null` is what a centre release
    // fills, and the one aim a fresh stack exists to receive.
    expect(ground(nodes, boxes).layout["n1.0"]?.ref).toBeNull();
  });

  test("one member deep, a stack is as tall as its occupant", () => {
    const nodes: readonly SectionNode[] = ["brand", { dir: "column", sections: ["canvas"] }];
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, ROW_H)],
      ["n1.0", row(48.79, ROW_H)],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.get("n1")).toBeCloseTo(ROW_H, 2);
    expect(extents.get("n1.0")).toBeCloseTo(ROW_H, 2);
    // Not an unpainted sliver: a stack holding a row is a node a pointer can land on.
    expect(extents.get("n1") ?? 0).toBeGreaterThan(UNPAINTED_EXTENT);
  });

  test("n members deep, a stack is as tall as all of them and the gaps between", () => {
    const nodes: readonly SectionNode[] = [
      "brand",
      { dir: "column", sections: ["canvas", "notes", "index"] },
    ];
    const stacked = ROW_H * 3 + GAP * 2;
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, stacked)],
      ["n1.0", row(48.79, ROW_H)],
      ["n1.1", row(48.79 + ROW_H + GAP, ROW_H)],
      ["n1.2", row(48.79 + (ROW_H + GAP) * 2, ROW_H)],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.get("n1")).toBeCloseTo(stacked, 2);
    for (const path of ["n1.0", "n1.1", "n1.2"]) {
      expect(extents.get(path)).toBeCloseTo(ROW_H, 2);
    }
  });

  test("across the rail the axes swap: n members abreast are still one row tall", () => {
    const nodes: readonly SectionNode[] = [
      "brand",
      { dir: "row", sections: ["canvas", "notes", "index"] },
    ];
    const share = (AREA.width - GAP * 2) / 3;
    const boxes = new Map<string, RailBox>([
      ["n0", row(10.39, 32)],
      ["n1", row(48.79, ROW_H)],
      ["n1.0", { left: AREA.left, top: 48.79, width: share, height: ROW_H }],
      ["n1.1", { left: AREA.left + share + GAP, top: 48.79, width: share, height: ROW_H }],
      ["n1.2", { left: AREA.left + (share + GAP) * 2, top: 48.79, width: share, height: ROW_H }],
    ]);
    const extents = railExtents(nodes, boxes);
    expect(extents.get("n1")).toBeCloseTo(ROW_H, 2);
    for (const path of ["n1.0", "n1.1", "n1.2"]) {
      expect(extents.get(path)).toBeCloseTo(share, 2);
    }
  });

  /*
    AND IT TAKES ANOTHER ROW. There is no capacity in a rail stack — a split holds as many rows
    as the tree's own bound allows — so an occupant is never a reason to refuse, and "the stack
    stopped accepting rows" was the missing band, not a rule. Asserted through the release
    rather than the aim alone: what a drop MEANS is the arrangement it commits.
  */
  const occupied = (
    sections: readonly string[],
  ): {
    readonly nodes: readonly SectionNode[];
    readonly boxes: ReadonlyMap<string, RailBox>;
  } => {
    const share = (AREA.width - GAP * (sections.length - 1)) / sections.length;
    const top = 10.39 + ROW_H + GAP;
    const boxes = new Map<string, RailBox>([
      // A row ABOVE the stack, so the rail the release lands in is a rail: a root split left
      // holding one child dissolves it, which is the kernel's rule and not this claim's subject.
      ["n0", row(10.39, ROW_H)],
      ["n1", row(top, ROW_H)],
      ["n2", row(top + ROW_H + GAP, 292.41)],
    ]);
    sections.forEach((_, index) => {
      boxes.set(`n1.${String(index)}`, {
        left: AREA.left + (share + GAP) * index,
        top,
        width: share,
        height: ROW_H,
      });
    });
    return { nodes: ["brand", { dir: "row", sections }, "index"], boxes };
  };

  test("a stack holding one row accepts a second, and holding two accepts a third", () => {
    for (const held of [["canvas"], ["canvas", "notes"]]) {
      const { nodes, boxes } = occupied(held);
      const projection = ground(nodes, boxes);
      const last = boxes.get(`n1.${String(held.length - 1)}`);
      if (last === undefined) throw new Error("fixture");
      // The trailing member's own outer edge: "join it, after" — the aim a hand dragging a row
      // into the stack from below arrives on.
      const aim = aimAt(projection, boxes, last.left + last.width - 2, last.top + last.height / 2);
      expect(aim?.tileId).toBe(`n1.${String(held.length - 1)}`);
      expect(aim?.edge).toBe("right");
      if (aim === null) throw new Error("no aim");
      const released = releasedSectionArrangement(
        projection,
        { kind: "section", id: "index" },
        aim,
      );
      expect(released).toEqual(["brand", { dir: "row", sections: [...held, "index"] }]);
    }
  });

  /*
    EVERY PIXEL OF AN OCCUPIED STACK IS A DROP, which is the other half of "never silently
    refused": the cross axis carries no meaning and an occupied member has no centre, so a
    stack's whole painted surface answers with one of its boundaries. A dead patch here would
    be a refusal a reader cannot see, and that is what half of #124's report was.
  */
  test("no pixel of an occupied stack is a dead patch", () => {
    const { nodes, boxes } = occupied(["canvas", "notes"]);
    const projection = ground(nodes, boxes);
    const first = boxes.get("n1.0");
    const second = boxes.get("n1.1");
    if (first === undefined || second === undefined) throw new Error("fixture");
    for (let x = Math.ceil(first.left) + 1; x < second.left + second.width - 1; x += 2) {
      const aim = aimAt(projection, boxes, x, first.top + first.height / 2);
      expect(aim).not.toBeNull();
      expect(aim?.edge).not.toBe("center");
      expect(["n1.0", "n1.1"]).toContain(aim?.tileId ?? "");
    }
  });
});
