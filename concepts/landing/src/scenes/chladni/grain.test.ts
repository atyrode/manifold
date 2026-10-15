import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { chladniScene } from "./index.ts";
import { CHLADNI_SAND_TEXELS } from "./sim.ts";

interface Sand {
  /** Texels holding at least a grain at rest: how wide the lines lie. */
  occupied: number;
  /** The deepest heap, grains per texel. */
  peak: number;
  /** Share of the resting sand lying thin (under half a grain per texel): the loose halo. */
  halo: number;
  /** Grains still on the move. */
  moving: number;
  /** The grain's relief handed to the shader (uSim2 texel 1 w). */
  relief: number;
}

/**
 * The plate at the default seed, built with `grainSize`, then (optionally) switched to `next` and
 * run `seconds` at motion 0 with the clock running, as a user dragging the knob on a still lab. Read
 * on the headless stand-in: the sim's real output, without a GPU.
 */
function plate(grainSize: number, next?: number, seconds = 0): Sand {
  const sim = new HeadlessSim(chladniScene);
  const frame: HeadlessFrame = {
    dt: 0,
    motion: 0,
    aspect: 16 / 9,
    height: 360,
    knobs: { grainSize },
    pointer: { inside: false },
  };
  // Paused frames finish the (time-budgeted) settling of the opening figure: a slow machine takes more.
  sim.step(frame);
  while (!sim.uploaded(0)) sim.step(frame);
  if (next !== undefined) {
    for (let t = 0; t < seconds; t += 0.05)
      sim.step({ ...frame, dt: 0.05, knobs: { grainSize: next } });
  }
  const sand = sim.upload(0).data;
  const state = sim.upload(2).data;
  let occupied = 0;
  let peak = 0;
  let resting = 0;
  let thin = 0;
  let moving = 0;
  for (let k = 0; k < CHLADNI_SAND_TEXELS * CHLADNI_SAND_TEXELS; k++) {
    const rest = sand[2 * k] ?? 0;
    resting += rest;
    moving += sand[2 * k + 1] ?? 0;
    if (rest >= 1) occupied++;
    if (rest > 0 && rest < 0.5) thin += rest;
    peak = Math.max(peak, rest);
  }
  return { occupied, peak, halo: thin / resting, moving, relief: state[7] ?? Number.NaN };
}

test("finer sand settles into thinner, denser lines; grit into broad bands with a loose halo", () => {
  const fine = plate(0);
  const sand = plate(0.5);
  const grit = plate(1);
  // Measured at the default seed: occupied 5761 / 7203 / 8653, peak 28.9 / 24.1 / 13.1, halo 3.3% / 6.0% / 10.5%.
  expect(fine.occupied).toBeLessThan(0.9 * sand.occupied);
  expect(grit.occupied).toBeGreaterThan(1.1 * sand.occupied);
  expect(fine.peak).toBeGreaterThan(sand.peak);
  expect(grit.peak).toBeLessThan(0.75 * sand.peak);
  expect(fine.halo).toBeLessThan(0.75 * sand.halo);
  expect(grit.halo).toBeGreaterThan(1.4 * sand.halo);
  // The shader raises grit's ridges and lowers fine sand's by their angle of repose; dry sand is untouched.
  expect(sand.relief).toBe(1);
  expect(fine.relief).toBeLessThan(1);
  expect(grit.relief).toBeGreaterThan(1.2);
});

test("a new grain is strewn and sung into the figure even with motion off, grit arriving first", () => {
  const fineSoon = plate(0.5, 0, 3);
  const gritSoon = plate(0.5, 1, 3);
  // Three seconds in, fine sand is still creeping in (measured 11225 grains moving) while grit has
  // mostly arrived (3052).
  expect(fineSoon.moving).toBeGreaterThan(2 * gritSoon.moving);
  expect(gritSoon.moving).toBeGreaterThan(250);
  // Twelve seconds in both have gathered into their lines, as wide as a plate built with that grain.
  const fine = plate(0.5, 0, 12);
  const grit = plate(0.5, 1, 12);
  expect(fine.moving).toBeLessThan(250);
  expect(grit.moving).toBeLessThan(250);
  expect(grit.occupied).toBeGreaterThan(1.3 * fine.occupied);
});
