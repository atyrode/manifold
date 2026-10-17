import { expect, test } from "bun:test";
import { type Spring, springStep } from "./spring.ts";

const H = 1 / 60;

/** The largest stable ω h at damping ratio zeta: the root of ω²h² + 4 ζ ω h = 4. */
const bound = (zeta: number): number => 2 * (Math.sqrt(zeta * zeta + 1) - zeta);

/** The largest |x| over `steps` steps of a spring plucked to 1 from rest, at ω h `wh` and `zeta`. */
function swing(wh: number, zeta: number, steps: number): number {
  const spring: Spring = { x: 1, v: 0 };
  let most = 0;
  for (let n = 0; n < steps && Number.isFinite(spring.x); n++) {
    springStep(spring, 0, wh / H, zeta, H);
    most = Math.max(most, Math.abs(spring.x));
  }
  return Number.isFinite(spring.x) ? most : Infinity;
}

test("undamped, the step rings fast by acos(1 − ω²h²/2) / ω h: 2 % at ω h = 0.67", () => {
  for (const wh of [0.1, 0.67, 1]) {
    const spring: Spring = { x: 1, v: 0 };
    const crossings: number[] = [];
    // A crossing is a change of side; at ω h = 1 the step lands exactly on 0 every half period.
    let was = spring.x;
    for (let n = 1; n < 100_000 && crossings.length < 200; n++) {
      springStep(spring, 0, wh / H, 0, H);
      const now = spring.x;
      const above = now > 0;
      const wasAbove = was > 0;
      if (above !== wasAbove) crossings.push(n - 1 + was / (was - now));
      was = now;
    }
    // Zero crossings come every half period: π / (ω' h) steps for the step's own frequency ω'.
    const half = ((crossings.at(-1) ?? 0) - (crossings[0] ?? 0)) / (crossings.length - 1);
    const fast = Math.PI / (half * wh);
    expect(fast).toBeCloseTo(Math.acos(1 - (wh * wh) / 2) / wh, 4);
  }
  expect(Math.acos(1 - (0.67 * 0.67) / 2) / 0.67).toBeCloseTo(1.0197, 4);
});

test("stable just inside ω²h² + 4 ζ ω h < 4, diverging just outside: 0.83 at critical damping", () => {
  expect(bound(1)).toBeCloseTo(0.8284, 4);
  for (const zeta of [0, 0.3, 0.7, 1, 2]) {
    expect(swing(0.98 * bound(zeta), zeta, 20000)).toBeLessThan(10);
    expect(swing(1.02 * bound(zeta), zeta, 20000)).toBe(Infinity);
  }
});

test("critically damped at a small ω h, it settles on the target without overshooting", () => {
  for (const wh of [0.1, 0.4]) {
    const spring: Spring = { x: 1, v: 0 };
    let least = 1;
    for (let n = 0; n < 2000; n++) {
      springStep(spring, 0, wh / H, 1, H);
      least = Math.min(least, spring.x);
    }
    expect(least).toBeGreaterThanOrEqual(0);
    expect(spring.x).toBeLessThan(1e-6);
  }
});
