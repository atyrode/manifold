import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { meadowScene } from "./index.ts";
import { MAX_SEEDS } from "./sim.ts";

const ASPECT = 16 / 9;
/** A fresh wind over the default gusts; the pointer off the page, so nothing breathes on the grass. */
const KNOBS = { wind: 0.5 };
const AWAY = { inside: false };

interface Seen {
  u: number;
  y: number;
  opacity: number;
  tilt: number;
  z: number;
}

interface Drawn {
  seeds: Seen[];
  blades: Float32Array;
  clocks: Float32Array;
}

/**
 * The meadow as drawn after one second in frames of 1/rate s. Both open on the same frame (the
 * pre-run ends on the clock the scene opens at, which no frame rate should decide), then pace apart.
 */
function second(rate: number): Drawn {
  const sim = new HeadlessSim(meadowScene);
  sim.step({ dt: 1 / 60, aspect: ASPECT, knobs: KNOBS, pointer: AWAY });
  for (let f = 0; f < rate; f++)
    sim.step({ dt: 1 / rate, aspect: ASPECT, knobs: KNOBS, pointer: AWAY });
  const packed = sim.upload(0).data;
  const seeds: Seen[] = [];
  for (let n = 0; n < MAX_SEEDS; n++) {
    const opacity = packed[n * 4 + 3] ?? 0;
    if (opacity <= 1e-6) continue;
    const row1 = (MAX_SEEDS + n) * 4;
    seeds.push({
      u: packed[n * 4] ?? 0,
      y: packed[n * 4 + 1] ?? 0,
      opacity,
      tilt: packed[row1] ?? 0,
      z: packed[row1 + 1] ?? 0,
    });
  }
  const drawn = {
    seeds,
    blades: Float32Array.from(sim.upload(1).data),
    clocks: Float32Array.from(sim.upload(2).data),
  };
  sim.dispose();
  return drawn;
}

/** The largest difference between two same-sized fields, and the largest value of the first. */
function apart(a: Float32Array, b: Float32Array): { worst: number; peak: number } {
  expect(b.length).toBe(a.length);
  let worst = 0;
  let peak = 0;
  for (let k = 0; k < a.length; k++) {
    peak = Math.max(peak, Math.abs(a[k] ?? 0));
    worst = Math.max(worst, Math.abs((a[k] ?? 0) - (b[k] ?? 0)));
  }
  return { worst, peak };
}

test("the grass, the clocks and the seeds move the same at 60 and 144 frames a second", () => {
  const slow = second(60);
  const fast = second(144);

  // The near grass: every column's lean and bow, well within a ten-thousandth of the sway.
  const blades = apart(slow.blades, fast.blades);
  expect(blades.peak).toBeGreaterThan(0.01);
  expect(blades.worst).toBeLessThan(1e-4 * blades.peak);

  // The clocks: root and head, size, presence, opening and each sector's fill.
  const clocks = apart(slow.clocks, fast.clocks);
  expect(clocks.peak).toBeGreaterThan(0.1);
  expect(clocks.worst).toBeLessThan(1e-5);

  // The seeds in the air: the same ones, each where the other rate draws it, as bright and tilted.
  expect(slow.seeds.length).toBeGreaterThan(3);
  expect(fast.seeds.length).toBe(slow.seeds.length);
  let place = 0;
  let look = 0;
  for (const seed of slow.seeds) {
    let best = Infinity;
    let at = seed;
    for (const other of fast.seeds) {
      const d = Math.hypot((other.u - seed.u) * ASPECT, other.y - seed.y, other.z - seed.z);
      if (d < best) {
        best = d;
        at = other;
      }
    }
    place = Math.max(place, best);
    look = Math.max(look, Math.abs(at.opacity - seed.opacity), Math.abs(at.tilt - seed.tilt));
  }
  // Screen heights (and world depth): far under a dither cell of the 540-row frame.
  expect(place).toBeLessThan(1e-5);
  expect(look).toBeLessThan(1e-5);
});
