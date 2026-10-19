import { describe, expect, test } from "bun:test";
import { lavaLampKind } from "./index.ts";
import {
  BASE,
  CAP_TOP,
  COLLAR,
  FOOT,
  GLASS,
  GLASS_WIDE,
  innerRadius,
  PARCELS,
  WIDE_AT,
} from "./shape.ts";
import { LavaWax, lavaSim } from "./sim.ts";

const cast = lavaLampKind.cast;
if (cast === undefined) throw new Error("the lava lamp casts on the CPU");
const SIZE = 0.5;
const options = { size: SIZE };
const FAR = [0, 100] as const;

describe("the lava lamp's CPU cast", () => {
  test("meets the glass at its widest from the side, facing back along the ray", () => {
    const y = (BASE + WIDE_AT * GLASS) * SIZE;
    const hit = cast(options, [-2, y, 0], [1, 0, 0], FAR);
    expect(hit?.t).toBeCloseTo(2 - GLASS_WIDE * SIZE, 6);
    // Within a cone's lean of the horizontal: the glass turns from its shoulder to its taper here.
    expect(hit?.normal[0]).toBeLessThan(-0.98);
  });

  test("meets the base's cone between its foot and its collar", () => {
    const hit = cast(options, [0, 0.5 * BASE * SIZE, -3], [0, 0, 1], FAR);
    expect(hit?.t).toBeCloseTo(3 - 0.5 * (FOOT + COLLAR) * SIZE, 6);
    // The base narrows upward: its normal leans up.
    expect(hit?.normal[1]).toBeGreaterThan(0.1);
    expect(hit?.normal[2]).toBeLessThan(-0.9);
  });

  test("meets the cap's top from straight above, and misses beside the lamp", () => {
    const hit = cast(options, [0.5 * CAP_TOP * SIZE, 3, 0], [0, -1, 0], FAR);
    expect(hit?.t).toBeCloseTo(3 - SIZE, 6);
    expect(hit?.normal).toEqual([0, 1, 0]);
    expect(cast(options, [(FOOT + 0.01) * SIZE, 3, 0], [0, -1, 0], FAR)).toBeUndefined();
    // Within its bounds' corner but outside the round lamp.
    expect(cast(options, [-2, 0.1, 0.9 * FOOT * SIZE], [1, 0, 0], FAR)).toBeUndefined();
  });

  test("keeps to the span it is given", () => {
    const y = (BASE + 0.5 * GLASS) * SIZE;
    expect(cast(options, [-2, y, 0], [1, 0, 0], [0, 1])).toBeUndefined();
  });
});

describe("the lava lamp's wax", () => {
  /** Rises of a parcel across mid-glass per minute over `seconds`, after the warm-up. */
  function run(heat: number, seconds: number, each: (wax: LavaWax) => void): number {
    const wax = new LavaWax(7);
    for (let i = 0; i < lavaSim.warmSteps; i++) wax.warm(i, { heat });
    const high = wax.wax.map((w) => w.y > 0.5);
    let rises = 0;
    for (let step = 0; step < seconds / lavaSim.step; step++) {
      wax.step({ heat });
      wax.wax.forEach((w, k) => {
        if (w.y > 0.5 && high[k] !== true) rises++;
        high[k] = w.y > 0.5;
      });
      each(wax);
    }
    return (rises * 60) / seconds;
  }

  test("stays in the glass, keeps a heap on the coil and sends blobs up and back", () => {
    let outside = 0;
    let bareCoil = 0;
    const visited = new Set<number>();
    run(0.5, 60, (wax) => {
      if (!wax.wax.some((w) => w.y - w.r < 0.05)) bareCoil++;
      wax.wax.forEach((w, k) => {
        if (w.y < 0 || w.y > 1 || Math.hypot(w.x, w.z) + 0.6 * w.r > innerRadius(w.y) + 1e-9)
          outside++;
        if (w.y > 0.75) visited.add(k);
      });
    });
    expect(outside).toBe(0);
    expect(bareCoil).toBe(0);
    // Most of the wax has been up under the cap within the minute: it circulates.
    expect(visited.size).toBeGreaterThan(PARCELS / 2);
  });

  test("a hotter bulb sends up more blobs", () => {
    const lazy = run(0, 60, () => undefined);
    const busy = run(1, 60, () => undefined);
    expect(lazy).toBeGreaterThan(0);
    expect(busy).toBeGreaterThan(1.5 * lazy);
  });
});
