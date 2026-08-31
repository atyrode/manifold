import { describe, expect, test } from "bun:test";
import {
  appendPoint,
  pointsToPath,
  strokeBounds,
  strokeViewBox,
  toRelativePoints,
} from "../src/stroke.ts";

describe("stroke", () => {
  test("appendPoint rejects only points below the minimum distance", () => {
    const points: number[] = [];
    expect(appendPoint(points, 10, 20)).toBe(true);
    expect(appendPoint(points, 11, 20)).toBe(false);
    expect(appendPoint(points, 12, 20)).toBe(true);
    expect(points).toEqual([10, 20, 12, 20]);
  });

  test("strokeBounds pads the point extents by the stroke width", () => {
    expect(strokeBounds([10, 20, 30, 25, 15, 50], 3)).toEqual({
      x: 7,
      y: 17,
      width: 26,
      height: 36,
    });
    expect(strokeBounds([], 3)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("converts scene points into element-local coordinates and an SVG path", () => {
    const relative = toRelativePoints([10, 20, 15, 25, 18, 21], { x: 7, y: 17 });
    expect(relative).toEqual([3, 3, 8, 8, 11, 4]);
    expect(pointsToPath(relative)).toBe("M 3 3 L 8 8 L 11 4");
    expect(pointsToPath([])).toBe("");
  });

  test("viewBox carries the stroke origin so a resized element scales its ink", () => {
    // Canonical stored points are already element-relative: origin lands on 0,0.
    const relative = toRelativePoints([10, 20, 30, 25], { x: 7, y: 17 });
    expect(strokeViewBox(relative, 3)).toBe("0 0 26 11");
    // Points that never went through `toRelativePoints` must not shift the drawing.
    expect(strokeViewBox([10, 20, 30, 25], 3)).toBe("7 17 26 11");
  });
});
