// The damped spring every sim eases a swinging value with: a stalk bowing to the wind, a culm, a
// hanging lantern following the pointer, a prism turned back to rest, a ball dragged by its magnet.
//
//   x'' = ω² (target − x) − 2 ζ ω x'
//
// with ω the natural frequency (rad/s) and ζ the damping ratio (1 critical, below it a swing that
// rings out, above it a slow creep). One step is semi-implicit (symplectic) Euler over h seconds with
// the target held: the velocity first, then the position by the new velocity. It is stable while
// ω h stays under about 2 and rings a little fast as ω h grows (some 15 % at ω h = 0.67), so step it
// on a FixedStep (clock.ts): the same h on every display gives the same motion at 60 and 144 Hz.
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
