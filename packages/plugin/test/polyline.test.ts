import { describe, expect, test } from "bun:test";
import {
  polylineBounds,
  polylinePath,
  polylineRelativeTo,
  polylineViewBox,
} from "@manifold/plugin/hooks";

describe("polyline", () => {
  test("bounds contain the point extents, grown by the pad on every side", () => {
    expect(polylineBounds([10, 20, 30, 25, 15, 50], 3)).toEqual({
      x: 7,
      y: 17,
      width: 26,
      height: 36,
    });
    // A degenerate polyline still needs a box an SVG viewBox stays valid at.
    expect(polylineBounds([], 3)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("converts scene points into element-local coordinates and an SVG path", () => {
    const relative = polylineRelativeTo([10, 20, 15, 25, 18, 21], { x: 7, y: 17 });
    expect(relative).toEqual([3, 3, 8, 8, 11, 4]);
    expect(polylinePath(relative)).toBe("M 3 3 L 8 8 L 11 4");
    expect(polylinePath([])).toBe("");
  });

  test("viewBox carries the origin so a resized element scales its drawing", () => {
    // Canonical stored points are already element-relative: origin lands on 0,0.
    const relative = polylineRelativeTo([10, 20, 30, 25], { x: 7, y: 17 });
    expect(polylineViewBox(relative, 3)).toBe("0 0 26 11");
    // Points that never went through `polylineRelativeTo` must not shift the drawing.
    expect(polylineViewBox([10, 20, 30, 25], 3)).toBe("7 17 26 11");
  });
});
