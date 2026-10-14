// A pendulum swinging beyond the small-angle approximation, for sims (TS) and shaders (`pendulumGlsl`,
// the same names and maths).
//
// Phases count swings (whole periods) since release, the bob held at +amplitude (radians, below a
// half turn) and let go. A small swing has the period 2π√(L/g); a swing of amplitude a takes
// pendulumStretch(a) = 2K(k)/π times as long, k = sin(a/2), K the complete elliptic integral of the
// first kind (by the arithmetic–geometric mean): 1.0012 at 8°, 1.010 at 23°, 1.077 at 61°, 1.18 at
// 90°. A row of bobs released at one angle all stretch alike, so a pattern tuned for small swings
// keeps its timing, only slower; released at different angles (a board drawing them back the same
// distance), they drift apart. The swing itself follows sin(θ/2) = k·cd(4Kφ, k) (Jacobi), summed as
// a cosine series in the nome q: within 1e-5 rad of a numerical integration up to 90°, a little
// flatter topped than a cosine (by 0.13% of the amplitude at 23°, 1% at 61°).
//
//   pendulumStretch(amplitude)                     the period over the small-angle period
//   pendulumAngle(amplitude, phase)                the angle (radians) `phase` swings after release
//                                                  (only its fraction is used)
//   pendulumFadingSwings(amplitude, decay, time)   swings made by `time` (counted in small-angle
//                                                  periods) while the amplitude fades as
//                                                  amplitude · e^(−decay · time): ∫ 1 / stretch, as a
//                                                  series in a² (within 1e-6 per period below 1.1 rad)
//   pendulumGlsl                                   GLSL: the same three functions
//
// Usage (pendulum n of a row tuned to make n swings per cycle when swinging small, released at a):
//   const swings = (n * time) / (cycle * pendulumStretch(a));
//   const theta = pendulumAngle(a, swings);
import { glslFloat } from "../shaders/glsl.ts";

/** Coefficients of 1 / stretch(a) = 1 − a²/16 + a⁴/3072 − 23a⁶/737280 + O(a⁸). */
const INVERSE_STRETCH = [1 / 16, 1 / 3072, 23 / 737280] as const;
/** Arithmetic–geometric mean steps: quadratic convergence, exact in floats below a half turn. */
const AGM_STEPS = 5;
/** Amplitudes are held below this (a pendulum released upright never falls). */
const MOST = 3.1;

/** The arithmetic–geometric mean of 1 and b. */
function agm(b: number): number {
  let a = 1;
  for (let i = 0; i < AGM_STEPS; i++) {
    const mean = 0.5 * (a + b);
    b = Math.sqrt(a * b);
    a = mean;
  }
  return a;
}

/** The period of a swing of `amplitude` radians over the small-angle period: 2K(sin(a/2))/π. */
export function pendulumStretch(amplitude: number): number {
  const s = Math.sin(0.25 * Math.min(Math.abs(amplitude), MOST));
  return 1 / agm(1 - 2 * s * s);
}

/** The angle, radians, of a pendulum released from +amplitude, `phase` swings later. */
export function pendulumAngle(amplitude: number, phase: number): number {
  // k′ = cos(a/2) and the nome's leading term e = (1 − √k′) / (2 (1 + √k′)) from sin(a/4): written
  // as 1 − √cos, a small swing's e cancels away on a GPU whose cos is off by 2e-4 (SwiftShader's).
  const s = Math.sin(0.25 * Math.min(Math.abs(amplitude), MOST));
  const kp = 1 - 2 * s * s;
  const root = Math.sqrt(kp);
  const e = (s / (1 + root)) ** 2;
  const e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  // sin(θ/2) = (2π / K) Σ (−1)ⁿ q^(n+½) / (1 − q^(2n+1)) cos((2n+1) 2πφ), and 2π / K = 4 agm.
  const c = 2 * Math.PI * (phase - Math.floor(phase));
  const rq = Math.sqrt(q);
  const q2 = q * q;
  const sum =
    (rq / (1 - q)) * Math.cos(c) -
    ((rq * q) / (1 - q * q2)) * Math.cos(3 * c) +
    ((rq * q2) / (1 - q * q2 * q2)) * Math.cos(5 * c) -
    ((rq * q * q2) / (1 - q * q2 * q2 * q2)) * Math.cos(7 * c);
  const half = Math.min(Math.max(4 * agm(kp) * sum, -1), 1);
  return Math.sign(amplitude) * 2 * Math.asin(half);
}

/** ∫₀ᵗ e^(−rate s) ds, t itself when the rate is (nearly) 0. */
function faded(rate: number, time: number): number {
  const x = rate * time;
  return Math.abs(x) < 1e-6 ? time : -Math.expm1(-x) / rate;
}

/**
 * Swings made by `time` (small-angle periods) by a pendulum whose amplitude fades as
 * amplitude · e^(−decay · time): ∫₀ᵗ ds / stretch(amplitude · e^(−decay · s)).
 */
export function pendulumFadingSwings(amplitude: number, decay: number, time: number): number {
  const a2 = amplitude * amplitude;
  const [c2, c4, c6] = INVERSE_STRETCH;
  return time - c2 * a2 * faded(2 * decay, time) + c4 * a2 * a2 * faded(4 * decay, time) - c6 * a2 * a2 * a2 * faded(6 * decay, time);
}

/** The functions above in GLSL, the same names and maths. Needs nothing but GLSL builtins. */
export const pendulumGlsl = `
float pendulumAgm(float b) {
  float a = 1.0;
  for (int i = 0; i < ${AGM_STEPS}; i++) {
    float mean = 0.5 * (a + b);
    b = sqrt(a * b);
    a = mean;
  }
  return a;
}

// The period of a swing of amplitude radians over the small-angle period: 2K(sin(a/2))/pi.
float pendulumStretch(float amplitude) {
  float s = sin(0.25 * min(abs(amplitude), ${glslFloat(MOST)}));
  return 1.0 / pendulumAgm(1.0 - 2.0 * s * s);
}

// The angle (radians) of a pendulum released from +amplitude, phase swings later (any size: only
// its fraction is used).
float pendulumAngle(float amplitude, float phase) {
  float s = sin(0.25 * min(abs(amplitude), ${glslFloat(MOST)}));
  float kp = 1.0 - 2.0 * s * s;
  float root = sqrt(kp);
  float e = s / (1.0 + root);
  e *= e;
  float e4 = e * e * e * e;
  float q = e * (1.0 + e4 * (2.0 + e4 * (15.0 + 150.0 * e4)));
  float c = 6.283185307179586 * fract(phase);
  float rq = sqrt(q);
  float q2 = q * q;
  float sum = rq / (1.0 - q) * cos(c)
    - rq * q / (1.0 - q * q2) * cos(3.0 * c)
    + rq * q2 / (1.0 - q * q2 * q2) * cos(5.0 * c)
    - rq * q * q2 / (1.0 - q * q2 * q2 * q2) * cos(7.0 * c);
  return sign(amplitude) * 2.0 * asin(clamp(4.0 * pendulumAgm(kp) * sum, -1.0, 1.0));
}

// The integral of exp(-rate s) ds over 0..time.
float pendulumFaded(float rate, float time) {
  float x = rate * time;
  return abs(x) < 1e-3 ? time * (1.0 - 0.5 * x + x * x / 6.0) : (1.0 - exp(-x)) / rate;
}

// Swings made by time (small-angle periods) while the amplitude fades as amplitude * exp(-decay * time).
float pendulumFadingSwings(float amplitude, float decay, float time) {
  float a2 = amplitude * amplitude;
  return time - ${glslFloat(INVERSE_STRETCH[0])} * a2 * pendulumFaded(2.0 * decay, time)
    + ${glslFloat(INVERSE_STRETCH[1])} * a2 * a2 * pendulumFaded(4.0 * decay, time)
    - ${glslFloat(INVERSE_STRETCH[2])} * a2 * a2 * a2 * pendulumFaded(6.0 * decay, time);
}
`;
