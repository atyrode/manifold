import { expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SimFrame } from "../types.ts";
import { gardenScene } from "./index.ts";
import { GARDEN_ISLANDS } from "./sim.ts";

// The garden's drying clock goes to the shader in uSim1 (the texel after the islands): fresh gravel's
// damp fades with `clock - when raked`. These run the sim through a WebGL stand-in and read it there;
// `knobs` are as in the URL (a feature: 1 for on, and `<key>-amount`).

function dryingClock(knobs: Record<string, number>, seconds: number): number {
  let stones: Float32Array | undefined;
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, key: string) {
      if (key === "createTexture") return () => ({});
      // uSim1: 2 × GARDEN_ISLANDS by 1 + GARDEN_STONES rgba16f texels.
      if (key === "texSubImage2D") return (...args: unknown[]) => {
        const data = args[8] as Float32Array;
        if (args[4] === 2 * GARDEN_ISLANDS && args[5] === 4) stones = Float32Array.from(data);
      };
      if (/^[A-Z0-9_]+$/.test(key)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
  const values = gardenScene.params.map((p) => effective(p, knobs));
  const sim = gardenScene.sim?.(gl);
  if (!sim) throw new Error("garden has no sim");
  for (let n = 0; n < seconds * 60; n++) {
    const frame: SimFrame = {
      dt: 1 / 60,
      time: n / 60,
      motionTime: n / 60,
      motion: 1,
      width: 960,
      height: 540,
      aspect: 16 / 9,
      values,
      params: {},
      triggers: [],
      fired: [],
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      parallax: { x: 0, y: 0 },
      passage: { enter: 1, exit: 0 },
    };
    sim.frame(frame);
  }
  sim.dispose();
  return stones?.[GARDEN_ISLANDS * 4] ?? Number.NaN;
}

test("by default fresh gravel dries on garden time, whatever the weather", () => {
  expect(dryingClock({}, 4)).toBeCloseTo(4, 3);
  expect(dryingClock({ rain: 1, "rain-amount": 0.7, time: 0 }, 4)).toBeCloseTo(4, 3);
});

test("drying with the weather: rain stops it, the night slows it, more weathering hurries it", () => {
  const on = { drying: 1, "drying-amount": 0.5, wind: 0 };
  expect(dryingClock({ ...on, rain: 1, "rain-amount": 0.7 }, 3)).toBe(0);
  const noon = dryingClock({ ...on, time: 0.5 }, 3);
  // A still midday at the weathering knob's default dries at the garden's own pace.
  expect(noon).toBeCloseTo(3, 3);
  expect(dryingClock({ ...on, time: 0 }, 3)).toBeLessThan(0.5 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 1 }, 3)).toBeGreaterThan(2 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 0 }, 3)).toBeLessThan(0.5 * noon);
});
