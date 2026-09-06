import { describe, expect, test } from "bun:test";
import { FLIP_EPSILON, flipKeyframes, flipShifts, type FlipRect } from "../src/flip.ts";

/**
 * THE ARITHMETIC OF MOTION, with no browser in the room.
 *
 * A FLIP is two measurements and a subtraction, and everything that can be WRONG about it is
 * in that subtraction: the sign (an inversion that adds where it should subtract slides every
 * row the wrong way), which keys take part (a row that just appeared has no old place, and
 * animating it from a neighbour's box animates a lie), and what counts as movement at all
 * (sub-pixel drift from a reflow that changed nothing must not repaint the whole stack).
 *
 * So the unit under test is the pure half — rects in, shifts and keyframes out — and the
 * browser half is left to the browser. The player has no branch worth a fake DOM: it measures
 * offsets, calls this function, and hands each answer to `Element.animate`.
 */

function rects(...rows: readonly (readonly [string, number, number])[]): Map<string, FlipRect> {
  return new Map(rows.map(([key, left, top]) => [key, { left, top }]));
}

describe("flipShifts", () => {
  test("a swap inverts both rows: each is offset BACK to where the reader last saw it", () => {
    // Two rows of one stack traded places: 40px apart, so one moves down and one moves up.
    const first = rects(["brand", 0, 0], ["status", 0, 40]);
    const last = rects(["status", 0, 0], ["brand", 0, 40]);

    // In `last`'s order — the order the DOM is in now — and each `dy` is old minus new.
    expect(flipShifts(first, last)).toEqual([
      { key: "status", dx: 0, dy: 40 },
      { key: "brand", dx: 0, dy: -40 },
    ]);
  });

  test("an untouched row yields no shift, so a reflow animates only what moved", () => {
    const first = rects(["brand", 0, 0], ["index", 0, 40], ["keys", 0, 200]);
    const last = rects(["brand", 0, 0], ["index", 0, 40], ["keys", 0, 200]);

    expect(flipShifts(first, last)).toEqual([]);
  });

  test("a row that has just APPEARED gets no shift: it has no old place to be put back to", () => {
    // Exactly the enable/disable reflow: `new-canvas` returned when its plugin came back on,
    // and the rows below it slid down to make room. The returning row must not slide in from
    // a box it never occupied; its neighbours are the ones that moved.
    const first = rects(["brand", 0, 0], ["index", 0, 40]);
    const last = rects(["brand", 0, 0], ["new-canvas", 0, 40], ["index", 0, 80]);

    expect(flipShifts(first, last)).toEqual([{ key: "index", dx: 0, dy: -40 }]);
  });

  test("a row that is GONE contributes nothing: there is no element left to move", () => {
    const first = rects(["brand", 0, 0], ["machines", 0, 40], ["keys", 0, 80]);
    const last = rects(["brand", 0, 0], ["keys", 0, 40]);

    expect(flipShifts(first, last)).toEqual([{ key: "keys", dx: 0, dy: 40 }]);
  });

  test("sub-pixel drift is not movement, at the boundary and on both axes", () => {
    const first = rects(["a", 0, 0], ["b", 0, 40]);
    // `a` drifts by exactly the epsilon on BOTH axes (not movement); `b` moves a whole pixel.
    const last = rects(["a", FLIP_EPSILON, FLIP_EPSILON], ["b", 0, 41]);

    expect(flipShifts(first, last)).toEqual([{ key: "b", dx: 0, dy: -1 }]);
  });

  test("a horizontal reflow inverts on x too — the rail is not the only stack this serves", () => {
    const first = rects(["a", 0, 0], ["b", 120, 0]);
    const last = rects(["b", 0, 0], ["a", 90, 0]);

    expect(flipShifts(first, last)).toEqual([
      { key: "b", dx: 120, dy: 0 },
      { key: "a", dx: -90, dy: 0 },
    ]);
  });

  test("an empty stack is not an error: nothing measured, nothing played", () => {
    expect(flipShifts(new Map(), new Map())).toEqual([]);
    expect(flipShifts(rects(["a", 0, 0]), new Map())).toEqual([]);
  });
});

describe("flipKeyframes", () => {
  test("two frames: the old place, then none — a closed statement about `transform`", () => {
    expect(flipKeyframes({ key: "index", dx: -12.5, dy: 40 })).toEqual([
      { transform: "translate(-12.5px, 40px)" },
      { transform: "translate(0px, 0px)" },
    ]);
  });

  test("the resting frame is written out, so the row never blends with the stylesheet", () => {
    const frames = flipKeyframes({ key: "index", dx: 0, dy: -40 });
    expect(frames.at(-1)).toEqual({ transform: "translate(0px, 0px)" });
  });
});
