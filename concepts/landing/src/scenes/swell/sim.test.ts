import { describe, expect, test } from "bun:test";
import { SWELL_BOATS, SWELL_HORIZON } from "./constants.ts";
import { swellInterest } from "./sim.ts";

describe("swell's points of interest", () => {
  test("are the boats the knob brings in, then the lighthouse while it stands", () => {
    expect(swellInterest(16 / 9, 0, false)).toEqual([]);
    expect(swellInterest(16 / 9, 2, false)).toHaveLength(2);
    expect(swellInterest(16 / 9, SWELL_BOATS.length, true)).toHaveLength(SWELL_BOATS.length + 1);
  });

  test("lie in the frame, the boats on the sea and the lamp over the horizon", () => {
    const points = swellInterest(16 / 9, SWELL_BOATS.length, true);
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(1);
    }
    const lamp = points.at(-1);
    expect(lamp?.y).toBeGreaterThan(SWELL_HORIZON);
    for (const boat of points.slice(0, -1)) expect(boat.y).toBeLessThan(SWELL_HORIZON);
  });

  test("leave out what a narrow frame crops", () => {
    expect(swellInterest(0.6, SWELL_BOATS.length, true).length).toBeLessThan(
      SWELL_BOATS.length + 1,
    );
  });
});
