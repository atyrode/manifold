// The damped spring every sim eases a swinging value with: a stalk bowing to the wind, a culm, a
// hanging lantern following the pointer, a prism turned back to rest, a ball dragged by its magnet.
//
//   x'' = ω² (target − x) − 2 ζ ω x'
//
// with ω the natural frequency (rad/s) and ζ the damping ratio (1 critical, below it a swing that
// rings out, above it a slow creep). One step is semi-implicit (symplectic) Euler over h seconds with
// the target held: the velocity first, then the position by the new velocity. The damping is
// explicit, so the step is stable only while ω²h² + 4 ζ ω h < 4: ω h under 2 undamped, 1.49 at
// ζ 0.3, 1.04 at ζ 0.7, 0.83 at critical damping and 0.47 at ζ 2. Undamped it rings fast by a
// factor acos(1 − ω²h²/2) / (ω h): 0.7 % at ω h = 0.4, 1.97 % at 0.67, 4.7 % at 1. So step it on a
// FixedStep (clock.ts) with ω h well inside the bound: the same h on every display gives the same
// motion at 60 and 144 Hz.
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

/** One step of `h` seconds toward `target` (held over the step): natural frequency omega, damping ratio zeta. */
export function springStep(
  spring: Spring,
  target: number,
  omega: number,
  zeta: number,
  h: number,
): void {
  spring.v += (omega * omega * (target - spring.x) - 2 * zeta * omega * spring.v) * h;
  spring.x += spring.v * h;
}
