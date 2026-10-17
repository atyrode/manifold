// The damped spring every sim eases a swinging value with: a stalk bowing to the wind, a culm, a
// hanging lantern following the pointer, a prism turned back to rest, a ball dragged by its magnet.
//
//   x'' = ω² (target − x) − 2 ζ ω x'
//
// with ω the natural frequency (rad/s) and ζ the damping ratio (1 critical, below it a swing that
// rings out, above it a slow creep). One step is the equation's exact solution over h seconds with
// the target held: (x − target, x') times a 2 × 2 matrix whose four coefficients depend on ω, ζ and h
// alone. So it is stable at any ω h, and a swing rings at exactly ω √(1 − ζ²) and dies at exactly
// ζ ω, as tuned. (The semi-implicit Euler step it replaced rang 14.6 % fast and decayed 28 % fast at
// ω h = 0.67 and ζ 0.3, lost the ring altogether by ζ 0.7, and diverged past ω²h² + 4 ζ ω h = 4.)
// The target is held over each step, so step it on a FixedStep (clock.ts): the same h on every
// display gives the same motion at 60 and 144 Hz.
//
// The coefficients cost an exp, a cos and a sin. `springStep` keeps the last set it worked out and
// reuses it while ω, ζ and h stay as they were (one spring per constant, or a field of springs
// alike); springs each with an ω of its own (the plants' organs) keep theirs, worked out once by
// `springCoefficients`, and step by `springStepBy`.
//
// Usage:
//   readonly #lean: Spring = { x: 0, v: 0 };
//   readonly #clock = new FixedStep(STEP, MAX_STEPS);
//   for (let i = 0, n = this.#clock.advance(dt); i < n; i++) springStep(this.#lean, target, 6, 0.3, STEP);

/** A damped spring's position and velocity (per second). */
export interface Spring {
  x: number;
  v: number;
}

/** Numbers per spring that `springCoefficients` writes. */
export const SPRING_COEFFICIENTS = 4;

/**
 * The exact step of h seconds for natural frequency omega and damping ratio zeta, as four numbers
 * into `out` from `at`: with d = x − target, a step takes (d, v) to (k0 d + k1 v, k2 d + k3 v).
 */
export function springCoefficients(
  omega: number,
  zeta: number,
  h: number,
  out: Float64Array,
  at = 0,
): void {
  // The decay rate and the squared ring frequency ω²(1 − ζ²), negative when overdamped. Then
  // c = e^(−ah) cos(√q h) and s = e^(−ah) sin(√q h) / √q, their cosh and sinh when overdamped.
  const a = zeta * omega;
  const q = omega * omega - a * a;
  const qh2 = q * h * h;
  let c: number;
  let s: number;
  if (Math.abs(qh2) < 1e-4) {
    // About critical damping (and with no spring at all): their series, exact to rounding here.
    const e = Math.exp(-a * h);
    c = e * (1 - qh2 / 2 + (qh2 * qh2) / 24);
    s = e * h * (1 - qh2 / 6 + (qh2 * qh2) / 120);
  } else if (q > 0) {
    const w = Math.sqrt(q);
    const e = Math.exp(-a * h);
    c = e * Math.cos(w * h);
    s = (e * Math.sin(w * h)) / w;
  } else {
    // Overdamped: the slow and the fast decay, each its own exp, so neither overflows at any h.
    const w = Math.sqrt(-q);
    const slow = Math.exp(-(a - w) * h);
    const fast = Math.exp(-(a + w) * h);
    c = 0.5 * (slow + fast);
    s = (0.5 * (slow - fast)) / w;
  }
  out[at] = c + a * s;
  out[at + 1] = s;
  out[at + 2] = -omega * omega * s;
  out[at + 3] = c - a * s;
}

/** One step toward `target` (held over the step) by the coefficients at `at` in `k` (springCoefficients). */
export function springStepBy(spring: Spring, target: number, k: Float64Array, at = 0): void {
  const d = spring.x - target;
  const v = spring.v;
  spring.x = target + (k[at] ?? 1) * d + (k[at + 1] ?? 0) * v;
  spring.v = (k[at + 2] ?? 0) * d + (k[at + 3] ?? 1) * v;
}

/** The coefficients of the last (omega, zeta, h) `springStep` was given. */
const last = new Float64Array(SPRING_COEFFICIENTS);
let lastOmega = Number.NaN;
let lastZeta = Number.NaN;
let lastH = Number.NaN;

/** One step of `h` seconds toward `target` (held over the step): natural frequency omega, damping ratio zeta. */
export function springStep(
  spring: Spring,
  target: number,
  omega: number,
  zeta: number,
  h: number,
): void {
  if (omega !== lastOmega || zeta !== lastZeta || h !== lastH) {
    springCoefficients(omega, zeta, h, last);
    lastOmega = omega;
    lastZeta = zeta;
    lastH = h;
  }
  springStepBy(spring, target, last);
}
