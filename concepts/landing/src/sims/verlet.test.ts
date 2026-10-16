import { expect, test } from "bun:test";
import { VerletSystem, type VerletStepOptions } from "./verlet.ts";

const G = 9.81;

/** Kinetic plus potential energy of the free points, with the scheme's own staggered pair: the last move's velocity, at its midpoint height. */
function energy(sys: VerletSystem): number {
  const pos = sys.positions;
  const prev = sys.previous;
  const inv = sys.inverseMass;
  const rate = 1 / sys.substep;
  let e = 0;
  for (let i = 0; i < sys.count; i++) {
    if ((inv[i] ?? 0) === 0) continue;
    const o = 3 * i;
    const vx = ((pos[o] ?? 0) - (prev[o] ?? 0)) * rate;
    const vy = ((pos[o + 1] ?? 0) - (prev[o + 1] ?? 0)) * rate;
    const vz = ((pos[o + 2] ?? 0) - (prev[o + 2] ?? 0)) * rate;
    e += 0.5 * (vx * vx + vy * vy + vz * vz) + G * 0.5 * ((pos[o + 1] ?? 0) + (prev[o + 1] ?? 0));
  }
  return e;
}

/** Frequency (Hz) of one point of inverse mass 1 on a constraint of `compliance` to a pinned point, plucked along it. */
function ring(compliance: number, substep: number): number {
  const sys = new VerletSystem({ substep });
  const anchor = sys.addPoint(0, 0, 0, 0);
  const bob = sys.addPoint(0, -0.1, 0, 1);
  sys.addConstraint(anchor, bob, compliance, 0.1);
  sys.place(bob, 0, -0.11, 0);
  const options: VerletStepOptions = { gravity: [0, 0, 0], damping: 0, iterations: 1 };
  let last = -0.01;
  let crossings = 0;
  let first = 0;
  let latest = 0;
  for (let s = 1; s * substep <= 3; s++) {
    sys.step(options);
    const off = (sys.positions[4] ?? 0) + 0.1;
    if (last * off < 0) {
      crossings++;
      if (crossings === 1) first = s * substep;
      latest = s * substep;
    }
    last = off;
  }
  return (crossings - 1) / 2 / (latest - first);
}

test("an undamped chain swings on: at least 85 % of its energy over 10 s", () => {
  const sys = new VerletSystem();
  // Ten rigid links a metre long, hung from a pin and let go 45° out.
  const out = Math.SQRT1_2;
  sys.addChain([0, 0, 0], [out, -out, 0], 10, { pinFirst: true });
  const options: VerletStepOptions = { gravity: [0, -G, 0], damping: 0, iterations: 1 };
  let hanging = 0;
  for (let i = 1; i <= 10; i++) hanging -= G * i * 0.1;
  sys.step(options);
  const swing = energy(sys) - hanging;
  let least = Infinity;
  const tenth = Math.round(0.1 / sys.substep);
  for (let s = 1; s * sys.substep <= 10; s++) {
    sys.step(options);
    if (s % tenth === 0) least = Math.min(least, (energy(sys) - hanging) / swing);
  }
  expect(least).toBeGreaterThan(0.85);
  // Damping is the damping asked for: a rate of 0.1 on the velocity takes a swing's energy (half of
  // it moving on average) down by about e^(-0.1 · 10) over the 10 s, and the solver adds little.
  const damped = new VerletSystem();
  damped.addChain([0, 0, 0], [out, -out, 0], 10, { pinFirst: true });
  const slowed: VerletStepOptions = { ...options, damping: 0.1 };
  damped.step(slowed);
  const start = energy(damped) - hanging;
  for (let s = 1; s * damped.substep <= 10; s++) damped.step(slowed);
  const left = (energy(damped) - hanging) / start;
  expect(left).toBeGreaterThan(Math.exp(-1) * 0.8);
  expect(left).toBeLessThan(Math.exp(-1) * 1.1);
});

test("a compliance rings at the same frequency whatever the substep", () => {
  // Compliance 0.01 on inverse mass 1 rings at sqrt(1 / 0.01) = 10 rad/s, 1.59 Hz.
  const expected = 10 / (2 * Math.PI);
  const coarse = ring(0.01, 1 / 60);
  const fine = ring(0.01, 1 / 480);
  expect(Math.abs(coarse / fine - 1)).toBeLessThan(0.02);
  expect(Math.abs(fine / expected - 1)).toBeLessThan(0.01);
  // A stiffer one still within a few per cent at the steps the scenes run.
  expect(Math.abs(ring(0.001, 1 / 120) / ring(0.001, 1 / 480) - 1)).toBeLessThan(0.03);
});
