import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { flockScene } from "./index.ts";

const EMERGENT = { emergent: 1, "emergent-amount": 7 };

/** The density field (R birds per texel, G rolled) after a frame. */
const density = (sim: HeadlessSim): Float32Array => Float32Array.from(sim.upload(0).data);

/** How much the field changed between two frames (L1 of the birds channel). */
function change(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let k = 0; k < a.length; k += 2) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum;
}

/** Total birds and rolled birds in the field. */
function totals(field: Float32Array): { birds: number; rolled: number } {
  let birds = 0;
  let rolled = 0;
  for (let k = 0; k < field.length; k += 2) {
    birds += field[k] ?? 0;
    rolled += field[k + 1] ?? 0;
  }
  return { birds, rolled };
}

test("with emergent flight off, whatever its neighbours, the flock flies its authored sheet", () => {
  const plain = new HeadlessSim(flockScene);
  const off = new HeadlessSim(flockScene);
  for (let f = 0; f < 240; f++) {
    off.step({ knobs: { emergent: 0, "emergent-amount": 12 } });
    plain.step();
    if (f % 30 === 29) expect(density(off)).toEqual(density(plain));
  }
});

test("emergent flight is its own, the same every time from the same start", () => {
  const sheet = new HeadlessSim(flockScene);
  const a = new HeadlessSim(flockScene);
  const b = new HeadlessSim(flockScene);
  for (let f = 0; f < 180; f++) {
    sheet.step();
    a.step({ knobs: EMERGENT });
    b.step({ knobs: EMERGENT });
  }
  expect(density(a)).toEqual(density(b));
  expect(change(density(a), density(sheet))).toBeGreaterThan(0.5 * totals(density(sheet)).birds);
});

test("switching flight either way hands the birds over where they are, without a jump", () => {
  const sim = new HeadlessSim(flockScene);
  const steps: number[] = [];
  let before = density(sim.step());
  for (let f = 1; f < 600; f++) {
    const knobs = f >= 200 && f < 400 ? EMERGENT : {};
    const after = density(sim.step({ knobs }));
    steps.push(change(after, before));
    before = after;
  }
  // A bird that jumped would leave its old texels and fill new ones at once: about twice the birds a
  // frame's trail lays down, many times an ordinary frame's change.
  const ordinary = (from: number): number => Math.max(...steps.slice(from - 60, from - 1));
  for (const at of [199, 399]) {
    for (const step of steps.slice(at, at + 3)) expect(step).toBeLessThan(1.5 * ordinary(at));
  }
});

test("emergent birds keep to the sky over the frame, all of them drawn", () => {
  for (const birds of [1500, 5000]) {
    const sim = new HeadlessSim(flockScene);
    let least = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 900; f++) {
      sim.step({ knobs: { ...EMERGENT, birds } });
      if (f >= 300 && f % 30 === 0) least = Math.min(least, totals(density(sim)).birds);
    }
    // Each bird lays down about its own ink once the trail has filled: none of them off the frame.
    expect(least).toBeGreaterThan(0.85 * birds);
  }
});

test("the falcon's strike starts a startle that runs through the boids and dies away", () => {
  const struck = new HeadlessSim(flockScene);
  const calm = new HeadlessSim(flockScene);
  for (let f = 0; f < 240; f++) {
    struck.step({ knobs: EMERGENT });
    calm.step({ knobs: EMERGENT });
  }
  const rolling = (sim: HeadlessSim, now: string[] = []): number => {
    const { birds, rolled } = totals(density(sim.step({ knobs: EMERGENT, now })));
    return rolled / birds;
  };
  let peak = rolling(struck, ["predator"]);
  let calmPeak = rolling(calm);
  for (let f = 0; f < 150; f++) {
    peak = Math.max(peak, rolling(struck));
    calmPeak = Math.max(calmPeak, rolling(calm));
  }
  expect(peak).toBeGreaterThan(calmPeak + 0.1);
  let after = 0;
  for (let f = 0; f < 240; f++) after = rolling(struck);
  expect(after).toBeLessThan(0.02);
});
