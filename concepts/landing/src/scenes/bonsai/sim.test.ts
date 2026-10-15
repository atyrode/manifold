import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { BONSAI_FIELD } from "./geometry.ts";
import { bonsaiScene } from "./index.ts";

/** The largest pad deflection the sim hands the shader over `seconds` at 60 fps (after the first
 *  second), with the knobs `params` (raw, as in the URL) and an optional "now" gust at `gustAt`. */
function maxSway(params: Record<string, number>, seconds: number, gustAt?: number): number {
  const sim = new HeadlessSim(bonsaiScene);
  const dt = 1 / 60;
  let gusted = false;
  let largest = 0;
  for (let f = 0; f < seconds * 60; f++) {
    const gust = gustAt !== undefined && !gusted && f * dt >= gustAt;
    if (gust) gusted = true;
    sim.step({
      dt: f === 0 ? 0 : dt,
      aspect: 16 / 9,
      height: 270,
      knobs: params,
      now: gust ? ["breeze"] : [],
      pointer: { inside: false },
    });
    if (f < 60) continue;
    // uSim3: its field rows hold each texel's sway in r and g.
    const field = sim.upload(3).data.subarray(0, BONSAI_FIELD.width * BONSAI_FIELD.height * 4);
    for (let i = 0; i < field.length; i += 4)
      largest = Math.max(largest, Math.abs(field[i] ?? 0), Math.abs(field[i + 1] ?? 0));
  }
  sim.dispose();
  return largest;
}

test("with the breeze off the pads hang still", () => {
  for (const species of [0, 1, 2]) expect(maxSway({ breeze: 0, species }, 20)).toBe(0);
});

test("a now gust still stirs the pads with the breeze off", () => {
  expect(maxSway({ breeze: 0 }, 14, 4)).toBeGreaterThan(5e-4);
});

test("below the gust floor the pads sway more as the breeze rises", () => {
  // Scheduled gusts start 20 s in, so these 15 s are the breeze's own waves.
  const sway = [0.02, 0.05, 0.08].map((amount) =>
    maxSway({ breeze: 1, "breeze-amount": amount }, 15),
  );
  expect(sway[0]).toBeGreaterThan(0);
  expect(sway[1]).toBeGreaterThan(sway[0] ?? 0);
  expect(sway[2]).toBeGreaterThan(sway[1] ?? 0);
});
