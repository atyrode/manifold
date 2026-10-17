import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { meadowScene } from "./index.ts";
import { MAX_SEEDS } from "./sim.ts";

/** Gusty, so the grass, the clocks and the seeds all move; the pointer away, so its breath stays out. */
const KNOBS = { wind: 0.6, gusts: 1, "gusts-amount": 1, gustRate: 1 };
const POINTER = { inside: false };

/** A meadow stepped in frames of 1/rate s, the first running its pre-run (HeadlessSim's budget is Infinity). */
function meadow(rate: number): { sim: HeadlessSim; frame: () => Float32Array[] } {
  const sim = new HeadlessSim(meadowScene);
  return {
    sim,
    // uSim0..uSim2 after one more frame: the seeds, the grass, the clocks.
    frame: () => {
      sim.step({ dt: 1 / rate, knobs: KNOBS, pointer: POINTER });
      return [0, 1, 2].map((slot) => Float32Array.from(sim.upload(slot).data));
    },
  };
}

function furthest(a: Float32Array, b: Float32Array): number {
  expect(b.length).toBe(a.length);
  let most = 0;
  for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return most;
}

/** Seeds in the air: those drawn with a pappus (uSim0 row 0, radius in b). */
function airborne(seeds: Float32Array): number {
  let n = 0;
  for (let i = 0; i < MAX_SEEDS; i++) if ((seeds[i * 4 + 2] ?? 0) > 0) n++;
  return n;
}

test("the meadow stands the same after three seconds at 60 and at 144 frames a second", () => {
  const drawn = [60, 144].map((rate) => {
    const { sim, frame } = meadow(rate);
    let last: Float32Array[] = [];
    for (let f = 0; f < 3 * rate; f++) last = frame();
    sim.dispose();
    return last;
  });
  const [slow, fast] = drawn;
  if (!slow || !fast) throw new Error("no frames");
  const [seeds, blades] = slow;
  if (!seeds || !blades) throw new Error("no textures");
  // Something to compare: seeds in the air and grass bent by the gusts.
  expect(airborne(seeds)).toBeGreaterThan(3);
  expect(Math.max(...blades.map(Math.abs))).toBeGreaterThan(0.01);
  // The pre-run ends where the first frame began whatever its length, and the steps fall on the
  // same moments of the motion clock: the seeds, the grass and the clocks agree to rounding.
  for (const slot of [0, 1, 2]) {
    const a = slow[slot];
    const b = fast[slot];
    if (!a || !b) throw new Error(`no uSim${slot}`);
    expect({ slot, apart: furthest(a, b) < 1e-5 }).toEqual({ slot, apart: true });
  }
});

test("a 144 Hz frame draws the grass between the 60 Hz steps around it", () => {
  // At 60 Hz each frame takes one step and draws the step before it (alpha 0): frame j shows step
  // j - 1. A 144 Hz frame at time t = f / 144 has taken floor(60 t) steps and draws
  // 60 t - floor(60 t) of the way from the step before the last to the last.
  const slow = meadow(60);
  const steps: Float32Array[] = [new Float32Array(0)];
  for (let j = 1; j <= 62; j++) steps.push(slow.frame()[1] ?? new Float32Array(0));
  slow.sim.dispose();
  const fast = meadow(144);
  let worst = 0;
  for (let f = 1; f <= 144; f++) {
    const blades = fast.frame()[1];
    if (!blades) throw new Error("no uSim1");
    const n = Math.floor((5 * f) / 12);
    if (n < 1) continue;
    const share = ((5 * f) % 12) / 12;
    const was = steps[n];
    const now = steps[n + 1];
    if (!was || !now) throw new Error(`no 60 Hz frame ${n}`);
    const between = was.map((x, i) => x + ((now[i] ?? 0) - x) * share);
    worst = Math.max(worst, furthest(between, blades));
  }
  fast.sim.dispose();
  expect(worst).toBeLessThan(1e-5);
});
