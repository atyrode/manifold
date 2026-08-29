import { describe, expect, test } from "bun:test";
import { carryFrame, carryGhosts, carryPayload, carryPlacementId } from "./carry";
import type { CarrySource } from "./carry";
import type { GestureOverride } from "./remote-gestures";

const elementCarry: CarrySource = {
  id: "element-1",
  envelope: { kind: "element", padId: "pad", elementId: "element-1" },
  label: null,
};
const poolCarry: CarrySource = {
  id: "carry-uuid",
  envelope: { kind: "terminal", sessionId: "session-1" },
  label: "build",
};

function override(partial: Partial<GestureOverride>): GestureOverride {
  return {
    connId: "peer-connection",
    principalId: "peer",
    elementId: "element-1",
    kind: "carry",
    target: { x: 10, y: 20 },
    current: { x: 10, y: 20 },
    updatedAt: 0,
    ...partial,
  };
}

describe("carry", () => {
  test("keys a carry by the placement it has, and only when it has one", () => {
    expect(carryPlacementId(elementCarry.envelope)).toBe("element-1");
    expect(carryPlacementId({ kind: "tile", containerId: "view", tileId: "leaf" })).toBe("leaf");
    expect(carryPlacementId(poolCarry.envelope)).toBeNull();
    expect(carryPlacementId({ kind: "canvas", padId: "pad" })).toBeNull();
    expect(carryPlacementId({ kind: "composition", padId: "view" })).toBeNull();
  });

  test("a frame carries the surface the drop will use, and geometry only when there is any", () => {
    const placed = carryFrame(elementCarry, { x: 5, y: 6, width: 700, height: 400 }, "active");
    expect(placed).toEqual({
      kind: "carry",
      phase: "active",
      elementId: "element-1",
      x: 5,
      y: 6,
      width: 700,
      height: 400,
      carry: { surface: { kind: "element", padId: "pad", elementId: "element-1" } },
    });

    // An unplaced item has no source box: the frame is a pointer and a name.
    const pointerOnly = carryFrame(poolCarry, { x: 1, y: 2 }, "end");
    expect(pointerOnly).toEqual({
      kind: "carry",
      phase: "end",
      elementId: "carry-uuid",
      x: 1,
      y: 2,
      carry: { surface: { kind: "terminal", sessionId: "session-1" }, label: "build" },
    });
  });

  test("both container disciplines travel as one pad surface", () => {
    expect(
      carryPayload({ id: "x", envelope: { kind: "canvas", padId: "p" }, label: null }),
    ).toEqual({ surface: { kind: "pad", padId: "p" } });
    expect(
      carryPayload({ id: "x", envelope: { kind: "composition", padId: "p" }, label: null }),
    ).toEqual({ surface: { kind: "pad", padId: "p" } });
  });

  test("ghosts skip what the renderer already draws and follow the eased position", () => {
    const local = override({
      carry: { surface: { kind: "element", padId: "pad", elementId: "element-1" } },
      current: { x: 33, y: 44 },
    });
    const foreign = override({
      elementId: "carry-uuid",
      carry: { surface: { kind: "terminal", sessionId: "session-1" }, label: "build" },
      current: { x: 7, y: 8 },
    });
    const plainMove = override({ elementId: "moved", kind: "move" });

    const ghosts = carryGhosts(
      [local, foreign, plainMove],
      (surface) => surface.kind === "element",
    );
    expect(ghosts).toEqual([
      {
        key: "peer-connection:carry-uuid",
        principalId: "peer",
        kind: "terminal",
        glyph: "▣",
        label: "build",
        x: 7,
        y: 8,
      },
    ]);

    // Nothing rendered locally: the element carry becomes a ghost like anything else,
    // which is exactly how a composition (no free geometry) paints motion.
    expect(carryGhosts([local, foreign], () => false).map((ghost) => ghost.x)).toEqual([33, 7]);
  });

  test("a carry with no label falls back to its species name", () => {
    const unnamed = override({
      elementId: "leaf",
      carry: { surface: { kind: "tile", containerId: "view", tileId: "leaf" } },
    });
    expect(carryGhosts([unnamed], () => false)[0]).toMatchObject({ label: "tile", glyph: "▤" });
  });
});
