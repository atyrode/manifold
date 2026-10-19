import { describe, expect, test } from "bun:test";
import type { Vec3 } from "../../types.ts";
import { optionValues } from "../index.ts";
import { roomKind } from "./index.ts";
import { castRoom, PIECE, ROOM, roomValues } from "./shape.ts";

// A 4 x 4 m room, 2.6 m high, as the manifest's defaults place its openings: one window centred in
// the far wall (x 0, 1 m wide, its foot 0.85 m over the floor, 1.3 m high), a door in the near one.
const options = (more: Readonly<Record<string, number>> = {}) =>
  optionValues(roomKind, {
    id: "room",
    kind: "room",
    at: [0, 0, 0],
    yaw: 0,
    scale: 1,
    options: { width: 4, depth: 4, height: 2.6, ...more },
  });

const cast = (ro: Vec3, to: Vec3, more?: Readonly<Record<string, number>>) => {
  const d: Vec3 = [to[0] - ro[0], to[1] - ro[1], to[2] - ro[2]];
  const length = Math.hypot(...d);
  return roomKind.cast?.(
    options(more),
    ro,
    [d[0] / length, d[1] / length, d[2] / length],
    [0, 100],
  );
};

const near = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toBeDefined();
  expected.forEach((value, k) => expect(actual?.[k]).toBeCloseTo(value, 6));
};

/** The far wall's inner face, the glass in it and its window's foot, metres. */
const FAR = 2;
const GLASS = FAR + ROOM.glassAt * ROOM.wall;
const FOOT = ROOM.floor + 0.85;

describe("the room's cast", () => {
  test("a ray through a window's pane passes it and leaves the room", () => {
    expect(cast([0.25, 1.4, 0], [0.25, 1.4, 1], { panes: 0 })).toBeUndefined();
    // Through a pane of four: either side of the mullion, under and over the transom.
    expect(cast([0.25, FOOT + 0.3, 0], [0.25, FOOT + 0.3, 1])).toBeUndefined();
    expect(cast([-0.25, FOOT + 1.1, 0], [-0.25, FOOT + 1.1, 1])).toBeUndefined();
  });

  test("a ray at a window's mullion meets the bar, in front of the glass", () => {
    const hit = cast([0, 1.4, 0], [0, 1.4, 1]);
    expect(hit?.t).toBeCloseTo(GLASS - ROOM.bar[1] / 2, 6);
    near(hit?.normal, [0, 0, -1]);
  });

  test("a ray at a wall meets its inner face from inside and its outer face from outside", () => {
    const inside = cast([1.5, 1.4, 0], [1.5, 1.4, 1]);
    expect(inside?.t).toBeCloseTo(FAR, 6);
    near(inside?.normal, [0, 0, -1]);
    const outside = cast([1.5, 1.4, 10], [1.5, 1.4, 0]);
    expect(outside?.t).toBeCloseTo(10 - FAR - ROOM.wall, 6);
    near(outside?.normal, [0, 0, 1]);
    // The left wall, between the far and near ones.
    const left = cast([0, 1.4, 0], [-1, 1.4, 0]);
    expect(left?.t).toBeCloseTo(2, 6);
    near(left?.normal, [1, 0, 0]);
  });

  test("a ray slanting into a window meets the reveal at the opening's side", () => {
    const side = 0.5;
    const z = FAR + 0.04;
    const hit = cast([0, 1.6, 0], [side, 1.6, z], { panes: 0 });
    expect(hit?.t).toBeCloseTo(Math.hypot(side, z), 6);
    near(hit?.normal, [-1, 0, 0]);
    expect(
      castRoom(
        roomValues(options({ panes: 0 })),
        [0, 1.6, 0],
        [side / Math.hypot(side, z), 0, z / Math.hypot(side, z)],
        [0, 100],
        false,
      )?.piece,
    ).toBe(PIECE.reveal);
  });

  test("the floor's top is what things rest on", () => {
    const hit = cast([1, 1.6, 1], [1, 0, 1]);
    expect(hit?.t).toBeCloseTo(1.6 - ROOM.floor, 6);
    near(hit?.normal, [0, 1, 0]);
  });

  test("a closed door stops a ray, a doorway lets it through", () => {
    const door = cast([0, 1, 0], [0, 1, -1]);
    expect(door?.t).toBeCloseTo(FAR + ROOM.wall / 2 - ROOM.leaf / 2, 6);
    near(door?.normal, [0, 0, 1]);
    expect(cast([0, 1, 0], [0, 1, -1], { nearDoor: 1 })).toBeUndefined();
  });

  test("the glass, counted, stops a ray at its plane", () => {
    const glass = castRoom(
      roomValues(options({ panes: 0 })),
      [0.25, 1.4, 0],
      [0, 0, 1],
      [0, 100],
      true,
    );
    expect(glass?.piece).toBe(PIECE.glass);
    expect(glass?.t).toBeCloseTo(GLASS, 6);
  });

  test("its bounds hold every piece: its sills outside, its ceiling over it", () => {
    const { min, max } = roomKind.bounds(options());
    near(min, [-2 - ROOM.wall - ROOM.outside, 0, -2 - ROOM.wall - ROOM.outside]);
    near(max, [
      2 + ROOM.wall + ROOM.outside,
      ROOM.floor + 2.6 + ROOM.ceiling,
      2 + ROOM.wall + ROOM.outside,
    ]);
    // Straight down onto the far window's stone sill, just outside the wall.
    const sill = cast([0, 3, FAR + ROOM.wall + 0.02], [0, 0, FAR + ROOM.wall + 0.02], {
      ceiling: 0,
    });
    expect(sill?.t).toBeCloseTo(3 - FOOT - 0.005, 6);
  });
});
