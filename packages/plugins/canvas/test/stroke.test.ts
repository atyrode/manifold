import { describe, expect, test } from "bun:test";
import { appendPoint } from "../src/stroke.ts";

/**
 * The polyline GEOMETRY these points feed is the engine's, and is covered by
 * `packages/plugin/test/polyline.test.ts` (issue #117). What is this plugin's own is the
 * sampling rule: a pointer emits far more frames than a drawing has shape.
 */
describe("stroke", () => {
  test("appendPoint rejects only points below the minimum distance", () => {
    const points: number[] = [];
    expect(appendPoint(points, 10, 20)).toBe(true);
    expect(appendPoint(points, 11, 20)).toBe(false);
    expect(appendPoint(points, 12, 20)).toBe(true);
    expect(points).toEqual([10, 20, 12, 20]);
  });
});
