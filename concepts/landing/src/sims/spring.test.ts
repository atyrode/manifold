import { expect, test } from "bun:test";
import {
  type Spring,
  SPRING_COEFFICIENTS,
  springCoefficients,
  springStep,
  springStepBy,
} from "./spring.ts";

const H = 1 / 60;

/**
 * x'' = ω² (target − x) − 2 ζ ω x' integrated by classical Runge–Kutta for `t` seconds, in steps of at
 * most 1e-4 s and 0.002 / ω (its own error then far below the checks').
 */
function integrate(start: Spring, target: number, omega: number, zeta: number, t: number): Spring {
  const accel = (x: number, v: number): number =>
    omega * omega * (target - x) - 2 * zeta * omega * v;
  const n = Math.ceil(t / Math.min(1e-4, 0.002 / omega));
  const h = t / n;
  let { x, v } = start;
  for (let i = 0; i < n; i++) {
    const a1 = accel(x, v);
    const a2 = accel(x + 0.5 * h * v, v + 0.5 * h * a1);
    const a3 = accel(x + 0.5 * h * (v + 0.5 * h * a1), v + 0.5 * h * a2);
    const a4 = accel(x + h * (v + 0.5 * h * a2), v + h * a3);
    x += h * (v + (h / 6) * (a1 + a2 + a3));
    v += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
  }
  return { x, v };
}

test("steps land on the equation's own solution, rung, critical or overdamped, at any ω h", () => {
  // ζ 0.999999 and 1.000001 sit either side of the critical branch's series.
  for (const zeta of [0, 0.3, 0.7, 0.999999, 1, 1.000001, 2]) {
    for (const wh of [0.1, 0.67, 3]) {
      const spring: Spring = { x: 1.2, v: -0.7 };
      const steps = 30;
      for (let n = 0; n < steps; n++) springStep(spring, 0.25, wh / H, zeta, H);
      const truth = integrate({ x: 1.2, v: -0.7 }, 0.25, wh / H, zeta, steps * H);
      expect(Math.abs(spring.x - truth.x)).toBeLessThan(1e-9);
      expect(Math.abs(spring.v - truth.v) / (wh / H)).toBeLessThan(1e-9);
    }
  }
});

test("a plucked spring rings at ω √(1 − ζ²) and dies at ζ ω, as tuned, at the plants' old cap", () => {
  // ω 40 rad/s at h 1/60 (ω h 0.67), ζ 0.3: the old explicit step rang 14.6 % fast here.
  const omega = 40;
  const zeta = 0.3;
  const ring = omega * Math.sqrt(1 - zeta * zeta);
  const spring: Spring = { x: 1, v: 0 };
  for (let n = 1; n <= 120; n++) {
    springStep(spring, 0, omega, zeta, H);
    const t = n * H;
    const x =
      Math.exp(-zeta * omega * t) *
      (Math.cos(ring * t) + ((zeta * omega) / ring) * Math.sin(ring * t));
    expect(spring.x).toBeCloseTo(x, 10);
  }
});

test("stable at any ω h: the energy never grows, and undamped it is kept", () => {
  for (const zeta of [0, 0.3, 1, 2]) {
    for (const wh of [0.5, 2, 10, 1000]) {
      const omega = wh / H;
      const spring: Spring = { x: 1, v: 0.5 * omega };
      const energy = (): number => spring.x * spring.x + (spring.v / omega) ** 2;
      const start = energy();
      let was = start;
      for (let n = 0; n < 2000; n++) {
        springStep(spring, 0, omega, zeta, H);
        expect(energy()).toBeLessThanOrEqual(was * (1 + 1e-12));
        was = energy();
      }
      if (zeta === 0) expect(was).toBeCloseTo(start, 9);
    }
  }
});

test("critically damped, it settles on the target without overshooting, however coarse the step", () => {
  for (const wh of [0.1, 0.4, 3]) {
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

test("springs stepped in turn each keep their own ω, ζ and h", () => {
  // Interleaved calls, as a scene's springs make them: each must step as if it were alone.
  const kinds: readonly (readonly [number, number, number])[] = [
    [6, 0.3, H],
    [6, 0.3, H / 4],
    [6, 0.9, H],
    [11, 0.3, H],
  ];
  const mixed = kinds.map((): Spring => ({ x: 1, v: 0 }));
  const alone = kinds.map((): Spring => ({ x: 1, v: 0 }));
  const k = new Float64Array(SPRING_COEFFICIENTS * kinds.length);
  kinds.forEach(([omega, zeta, h], i) =>
    springCoefficients(omega, zeta, h, k, SPRING_COEFFICIENTS * i),
  );
  for (let n = 0; n < 50; n++) {
    kinds.forEach(([omega, zeta, h], i) => {
      const spring = mixed[i];
      if (spring) springStep(spring, 0.5, omega, zeta, h);
    });
  }
  alone.forEach((spring, i) => {
    for (let n = 0; n < 50; n++) springStepBy(spring, 0.5, k, SPRING_COEFFICIENTS * i);
    expect(mixed[i]).toEqual(spring);
  });
});
