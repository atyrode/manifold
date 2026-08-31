import { describe, expect, test } from "bun:test";
import {
  carryFrame,
  carryGhosts,
  carryPayload,
  carryPlacementId,
  remoteTileCarries,
  surfaceDisplayLabel,
} from "./carry";
import type { CarrySource } from "./carry";
import type { GestureOverride } from "./remote-gestures";

/** Every fixture names its item, exactly as a real grab site resolves it once. */
const TEXT_ITEM = { kind: "text", containerId: null } as const;
const TERMINAL_ITEM = { kind: "terminal", containerId: "home-1" } as const;
const TILE_ITEM = { kind: "tile", containerId: null } as const;
const VIEW_ITEM = { kind: "view", containerId: "p" } as const;

const elementCarry: CarrySource = {
  id: "element-1",
  envelope: { kind: "element", padId: "pad", elementId: "element-1" },
  item: TEXT_ITEM,
  label: null,
};
const poolCarry: CarrySource = {
  id: "carry-uuid",
  envelope: { kind: "terminal", sessionId: "session-1" },
  item: TERMINAL_ITEM,
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
      carry: {
        surface: { kind: "element", padId: "pad", elementId: "element-1" },
        item: TEXT_ITEM,
      },
    });

    // An unplaced item has no source box: the frame is a pointer and a name.
    const pointerOnly = carryFrame(poolCarry, { x: 1, y: 2 }, "end");
    expect(pointerOnly).toEqual({
      kind: "carry",
      phase: "end",
      elementId: "carry-uuid",
      x: 1,
      y: 2,
      carry: {
        surface: { kind: "terminal", sessionId: "session-1" },
        item: TERMINAL_ITEM,
        label: "build",
      },
    });
  });

  test("both container disciplines travel as one pad surface", () => {
    expect(
      carryPayload({
        id: "x",
        envelope: { kind: "canvas", padId: "p" },
        item: VIEW_ITEM,
        label: null,
      }),
    ).toEqual({ surface: { kind: "pad", padId: "p" }, item: VIEW_ITEM });
    expect(
      carryPayload({
        id: "x",
        envelope: { kind: "composition", padId: "p" },
        item: VIEW_ITEM,
        label: null,
      }),
    ).toEqual({ surface: { kind: "pad", padId: "p" }, item: VIEW_ITEM });
  });

  test("ghosts skip what the renderer already draws and follow the eased position", () => {
    const local = override({
      carry: {
        surface: { kind: "element", padId: "pad", elementId: "element-1" },
        item: TEXT_ITEM,
      },
      current: { x: 33, y: 44 },
    });
    const foreign = override({
      elementId: "carry-uuid",
      carry: {
        surface: { kind: "terminal", sessionId: "session-1" },
        item: TERMINAL_ITEM,
        label: "build",
      },
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
      carry: {
        surface: { kind: "tile", containerId: "view", tileId: "leaf" },
        item: TILE_ITEM,
      },
    });
    expect(carryGhosts([unnamed], () => false)[0]).toMatchObject({ label: "tile" });
  });

  test("an armed aim rides the frame; without one the payload stays lean", () => {
    const aim = {
      containerId: "view",
      tileId: "t1",
      edge: "right",
      action: "place",
      between: true,
    } as const;
    const framed = carryFrame(poolCarry, { x: 1, y: 2 }, "active", aim);
    expect(framed.carry?.aim).toEqual(aim);
    expect(carryFrame(poolCarry, { x: 1, y: 2 }, "active").carry?.aim).toBeUndefined();
    expect(carryPayload(poolCarry)).not.toHaveProperty("aim");
  });

  test("the freshest aim wins PER CONTAINER, so two peers over two areas cannot mask each other", () => {
    const stale = override({
      connId: "old",
      updatedAt: 10,
      carry: {
        surface: { kind: "terminal", sessionId: "s1" },
        item: TERMINAL_ITEM,
        aim: { containerId: "view", tileId: "t1", edge: "left", action: "place" },
      },
    });
    const fresh = override({
      connId: "new",
      updatedAt: 20,
      carry: {
        surface: { kind: "tile", containerId: "view", tileId: "t9" },
        item: TILE_ITEM,
        label: "build",
        aim: { containerId: "view", tileId: "t2", edge: "center", action: "swap" },
      },
    });
    // Another container entirely: an older frame, and it must still be visible — the
    // widget it addresses is a different tile area on the same canvas.
    const elsewhere = override({
      connId: "third",
      elementId: "other",
      updatedAt: 5,
      carry: {
        surface: { kind: "terminal", sessionId: "s3" },
        item: TERMINAL_ITEM,
        aim: { containerId: "other-view", tileId: "t1", edge: "top", action: "place" },
      },
    });
    const aimless = override({
      connId: "no-aim",
      updatedAt: 30,
      carry: {
        surface: { kind: "terminal", sessionId: "s2" },
        item: TERMINAL_ITEM,
      },
    });

    const carries = remoteTileCarries([stale, fresh, elsewhere, aimless]);
    expect(carries.size).toBe(2);
    expect(carries.get("view")).toEqual({
      connId: "new",
      principalId: "peer",
      aim: { containerId: "view", tileId: "t2", edge: "center", action: "swap" },
      surface: { kind: "tile", containerId: "view", tileId: "t9" },
      // The item travels: this is the value a viewer judges the drop with.
      item: TILE_ITEM,
      label: "build",
      updatedAt: 20,
    });
    expect(carries.get("other-view")?.connId).toBe("third");
    // A peer with no armed aim is invisible here however fresh their geometry is.
    expect(remoteTileCarries([aimless]).size).toBe(0);
  });

  test("every tiled species is named by one switch, and an unknown name is null", () => {
    const lookups = {
      sessionName: (sessionId: string) => (sessionId === "s1" ? "build" : null),
      padName: (padId: string) => (padId === "p1" ? "Sketches" : null),
      noteText: (elementId: string) => (elementId === "e1" ? "Groceries\nmilk\neggs" : null),
    };
    expect(surfaceDisplayLabel({ kind: "terminal", sessionId: "s1" }, lookups)).toBe("build");
    expect(surfaceDisplayLabel({ kind: "pad", padId: "p1" }, lookups)).toBe("Sketches");
    // A note borrows its FIRST line, which is the only handle a note has.
    expect(surfaceDisplayLabel({ kind: "text", elementId: "e1" }, lookups)).toBe("Groceries");
    expect(surfaceDisplayLabel({ kind: "text", elementId: "gone" }, lookups)).toBeNull();
    expect(surfaceDisplayLabel(null, lookups)).toBeNull();
  });
});
