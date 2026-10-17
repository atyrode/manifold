import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";

const autumnScene = await loadScene("autumn");

// A "now" gust as the park's shader reads it from uSim3's first texel (x: the gust's signed strength),
// sampled every frame for six seconds after the press: the shared gust pulse (sims/wind.ts) at the
// park's 1.6 s rise, blowing the way the wind is set, and played in real time whatever the motion.
function gust(knobs: Record<string, number>, motion: number): { peak: number; at: number } {
  const sim = new HeadlessSim(autumnScene);
  sim.step({ knobs, motion });
  let peak = 0;
  let at = 0;
  for (let n = 1; n <= 6 * 60; n++) {
    const value =
      sim.step({ knobs, motion, now: n === 1 ? ["gusts"] : [] }).upload(3).data[0] ?? Number.NaN;
    if (Math.abs(value) > Math.abs(peak)) {
      peak = value;
      at = n / 60;
    }
  }
  sim.dispose();
  return { peak, at };
}

test("a gust peaks 1.6 s after 'now' at its strength, blowing with the wind, motion or not", () => {
  // The default strength 0.5: a gust of 0.55 + 0.45 * 0.5.
  const left = gust({ wind: -0.6 }, 1);
  expect(left.peak).toBeCloseTo(-0.775, 3);
  expect(Math.abs(left.at - 1.6)).toBeLessThan(1.5 / 60);
  const right = gust({ wind: 0.4, "gusts-amount": 1 }, 0);
  expect(right.peak).toBeCloseTo(1, 3);
  expect(Math.abs(right.at - 1.6)).toBeLessThan(1.5 / 60);
  // A breath of wind to the left, inside the dead band, still blows right.
  expect(gust({ wind: -0.04 }, 1).peak).toBeGreaterThan(0);
});
