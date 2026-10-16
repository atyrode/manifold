import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { ferroScene } from "./index.ts";
import { FERRO_BLOBS, FERRO_STATE_HEAD } from "./sim.ts";

const KNOBS = { follow: 1, breath: 0, drift: 0 };

/** The pool settled under a pointer in the middle, then one second chasing it off to the side, in frames of 1/rate s. */
function chase(rate: number): { start: Float32Array; state: Float32Array; field: Float32Array } {
  const sim = new HeadlessSim(ferroScene);
  sim.step({ dt: 0, knobs: KNOBS, pointer: { x: 0.5, y: 0.5, inside: true } });
  const start = Float32Array.from(sim.upload(1).data);
  for (let f = 0; f < rate; f++)
    sim.step({ dt: 1 / rate, knobs: KNOBS, pointer: { x: 0.75, y: 0.4, inside: true } });
  const state = Float32Array.from(sim.upload(1).data);
  const field = Float32Array.from(sim.upload(0).data);
  sim.dispose();
  return { start, state, field };
}

/** Largest distance between the same blob in two state textures. */
function blobGap(a: Float32Array, b: Float32Array): number {
  let gap = 0;
  for (let i = 0; i < FERRO_BLOBS; i++) {
    const o = (FERRO_STATE_HEAD + i) * 4;
    gap = Math.max(gap, Math.hypot((a[o] ?? 0) - (b[o] ?? 0), (a[o + 1] ?? 0) - (b[o + 1] ?? 0)));
  }
  return gap;
}

test("the pool sloshes and the spikes ring the same at 60 and 144 frames a second", () => {
  const slow = chase(60);
  const fast = chase(144);
  // The blobs swing well across the dish on their springs...
  const moved = blobGap(slow.start, slow.state);
  expect(moved).toBeGreaterThan(0.1);
  // ...to the same places at either frame rate (variable substeps left them ~1e-2 apart).
  expect(blobGap(slow.state, fast.state)).toBeLessThan(1e-4 * moved);
  // And every spike stands as high (r: its height).
  let peak = 0;
  let worst = 0;
  for (let k = 0; k < slow.field.length; k += 4) {
    peak = Math.max(peak, slow.field[k] ?? 0);
    worst = Math.max(worst, Math.abs((slow.field[k] ?? 0) - (fast.field[k] ?? 0)));
  }
  expect(peak).toBeGreaterThan(0.05);
  expect(worst).toBeLessThan(1e-4 * peak);
});
