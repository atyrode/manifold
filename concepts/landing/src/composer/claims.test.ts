import { describe, expect, test } from "bun:test";
import {
  CLEAR_FEATHER,
  coverAt,
  moveShape,
  overlaps,
  placeClaim,
  signedDistance,
} from "./claims.ts";
import type { PlacedClaim, Shape } from "./types.ts";

const disc = (x: number, z: number, r: number): Shape => ({ kind: "disc", at: [x, z], r });
const box = (x: number, z: number, hx: number, hz: number, turn = 0): Shape => ({
  kind: "box",
  at: [x, z],
  half: [hx, hz],
  turn,
});
const strip = (points: readonly (readonly [number, number])[], half: number): Shape => ({
  kind: "strip",
  points,
  half,
});
const claim = (kind: PlacedClaim["kind"], shape: Shape): PlacedClaim => ({
  name: `a ${kind} claim`,
  kind,
  shape,
  layer: "test",
});

describe("claim outlines", () => {
  test("overlap exactly, touching counting as overlapping, either way round", () => {
    const cases: [Shape, Shape, boolean][] = [
      [disc(0, 5, 1), disc(2, 5, 1), true],
      [disc(0, 5, 1), disc(2.01, 5, 1), false],
      [box(0, 5, 1, 1), box(2, 5, 1, 1), true],
      [box(0, 5, 1, 1), box(2.01, 5, 1, 1), false],
      // A box turned 45 degrees reaches sqrt(2) along its diagonal.
      [box(0, 5, 1, 1, Math.PI / 4), disc(2.4, 5, 1), true],
      [box(0, 5, 1, 1, Math.PI / 4), disc(2.5, 5, 1), false],
      [box(0, 5, 1, 1), disc(0, 5, 0.1), true],
      [
        strip(
          [
            [-3, 2],
            [3, 2],
          ],
          0.5,
        ),
        disc(0, 3.4, 0.9),
        true,
      ],
      [
        strip(
          [
            [-3, 2],
            [3, 2],
          ],
          0.5,
        ),
        disc(0, 3.5, 0.9),
        false,
      ],
      [
        strip(
          [
            [-3, 2],
            [0, 6],
            [3, 2],
          ],
          0.2,
        ),
        box(0, 3, 0.5, 0.5),
        false,
      ],
      [
        strip(
          [
            [-3, 2],
            [0, 6],
            [3, 2],
          ],
          0.2,
        ),
        box(-1.5, 4, 0.5, 0.5),
        true,
      ],
    ];
    for (const [a, b, expected] of cases) {
      expect({ a, b, overlaps: overlaps(a, b) }).toEqual({ a, b, overlaps: expected });
      expect({ a, b, overlaps: overlaps(b, a) }).toEqual({ a, b, overlaps: expected });
    }
  });

  test("measure a signed distance: negative inside, 0 on the outline", () => {
    expect(signedDistance(disc(0, 5, 1), [0, 5])).toBeCloseTo(-1, 9);
    expect(signedDistance(disc(0, 5, 1), [3, 5])).toBeCloseTo(2, 9);
    expect(signedDistance(box(0, 5, 2, 1), [0, 5])).toBeCloseTo(-1, 9);
    expect(signedDistance(box(0, 5, 2, 1), [2, 5])).toBeCloseTo(0, 9);
    expect(signedDistance(box(0, 5, 2, 1), [4, 5])).toBeCloseTo(2, 9);
    expect(
      signedDistance(
        strip(
          [
            [0, 0],
            [0, 10],
          ],
          0.5,
        ),
        [2, 5],
      ),
    ).toBeCloseTo(1.5, 9);
  });

  test("move with their anchor and stretch across a wider frame in x alone", () => {
    expect(moveShape(disc(1, 5, 1), [2, 3])).toEqual(disc(3, 8, 1));
    expect(moveShape(box(1, 5, 1, 1), [0, 0], 2)).toEqual(box(2, 5, 1, 1));
    expect(
      moveShape(
        strip(
          [
            [1, 2],
            [3, 4],
          ],
          0.5,
        ),
        [1, 0],
        1.5,
      ),
    ).toEqual(
      strip(
        [
          [3, 2],
          [6, 4],
        ],
        0.5,
      ),
    );
    expect(
      placeClaim({ name: "a", kind: "shared", shape: disc(0, 1, 1) }, "apiary", [2, 3]),
    ).toEqual({ name: "a", kind: "shared", shape: disc(2, 4, 1), layer: "apiary" });
  });
});

describe("what a cover may grow", () => {
  const hives = claim("exclusive", box(0, 8, 1, 0.5));
  const path = claim(
    "clears",
    strip(
      [
        [0, 1],
        [0, 7],
      ],
      0.6,
    ),
  );
  const drift = claim("shared", box(-3, 6, 1.5, 1));

  test("is all of it outside every claim, and nothing in an exclusive claim", () => {
    expect(coverAt([hives, path, drift], 6, 6, 0.35)).toBe(1);
    expect(coverAt([hives, path, drift], 0, 8, 0.35)).toBe(0);
    expect(coverAt([hives], 0.5, 8.2, 1)).toBe(0);
  });

  test("thins to nothing in a clearing's core and comes back over the feather outside it", () => {
    expect(coverAt([path], 0, 4)).toBe(0);
    expect(coverAt([path], 0.6, 4)).toBe(0);
    const half = coverAt([path], 0.6 + 0.5 * CLEAR_FEATHER, 4);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(coverAt([path], 0.6 + CLEAR_FEATHER, 4)).toBeCloseTo(1, 9);
  });

  test("is the cover's overgrowth inside a shared claim, and the least of the claims it stands in", () => {
    expect(coverAt([drift], -3, 6, 0.35)).toBe(0.35);
    expect(coverAt([drift], -3, 6)).toBe(1);
    const overlapping = claim("clears", disc(-3, 6, 0.6 + 0.5 * CLEAR_FEATHER));
    expect(coverAt([drift, overlapping], -3, 6, 0.8)).toBe(0);
    expect(coverAt([drift, overlapping], -3 + 0.6 + 0.25 * CLEAR_FEATHER, 6, 0.8)).toBeLessThan(
      0.8,
    );
  });
});
