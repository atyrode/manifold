import { expect, test } from "bun:test";
import { pendulumAngle, pendulumFadingSwings, pendulumStretch } from "./pendulum.ts";

/** θ'' = −sin θ from rest at `amplitude` (small-angle period 2π), RK4: the angle every `h` for `steps` steps. */
function swing(amplitude: number, h: number, steps: number): Float64Array {
  const out = new Float64Array(steps + 1);
  let angle = amplitude;
  let rate = 0;
  out[0] = angle;
  for (let i = 1; i <= steps; i++) {
    const k1a = rate;
    const k1r = -Math.sin(angle);
    const k2a = rate + 0.5 * h * k1r;
    const k2r = -Math.sin(angle + 0.5 * h * k1a);
    const k3a = rate + 0.5 * h * k2r;
    const k3r = -Math.sin(angle + 0.5 * h * k2a);
    const k4a = rate + h * k3r;
    const k4r = -Math.sin(angle + h * k3a);
    angle += (h / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);
    rate += (h / 6) * (k1r + 2 * k2r + 2 * k3r + k4r);
    out[i] = angle;
  }
  return out;
}

test("a wide swing takes as long as the integrated pendulum's and follows its path", () => {
  for (const amplitude of [0.14, 0.4, 1.07, Math.PI / 2]) {
    const stretch = pendulumStretch(amplitude);
    const h = (2 * Math.PI) / 4000;
    const path = swing(amplitude, h, 3 * 4000 + 400);
    // A quarter period after release the bob passes the bottom.
    let quarter = Number.NaN;
    for (let i = 1; i < path.length && Number.isNaN(quarter); i++) {
      const a = path[i - 1] ?? 0;
      const b = path[i] ?? 0;
      if (a > 0 && b <= 0) quarter = (i - 1 + a / (a - b)) * h;
    }
    expect((4 * quarter) / (2 * Math.PI)).toBeCloseTo(stretch, 6);
    for (let i = 0; i < path.length; i += 37) {
      expect(Math.abs((path[i] ?? 0) - pendulumAngle(amplitude, (i * h) / (2 * Math.PI * stretch)))).toBeLessThan(1e-5);
    }
  }
  // A mirror release swings the other way.
  expect(pendulumAngle(-0.6, 0.3)).toBeCloseTo(-pendulumAngle(0.6, 0.3), 12);
});

test("a small swing is the small-angle cosine, and its period is the small-angle period", () => {
  // The period stretch is 1 + θ²/16 + …: 6.25e-10 above 1 at θ = 1e-4.
  expect(pendulumStretch(1e-4)).toBeCloseTo(1 + 1e-8 / 16, 12);
  for (const phase of [0, 0.1, 0.25, 0.6, 3.85]) expect(pendulumAngle(0.002, phase)).toBeCloseTo(0.002 * Math.cos(2 * Math.PI * phase), 9);
});

test("swings while the amplitude fades are the integral of the inverse stretch", () => {
  for (const [amplitude, decay, time] of [[0.4, 0.05, 10], [1.07, 0.1, 6], [0.8, 0, 5]] as const) {
    let swings = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) swings += time / n / pendulumStretch(amplitude * Math.exp((-decay * (i + 0.5) * time) / n));
    expect(Math.abs(pendulumFadingSwings(amplitude, decay, time) - swings) / time).toBeLessThan(1e-6);
  }
});
