/**
 * Truth over beauty: remote motion renders the freshest frame with only enough easing
 * to round off the send cadence (16ms). Local interaction never interpolates.
 */
export const GESTURE_HALF_LIFE_MS = 30;
export const CURSOR_HALF_LIFE_MS = 30;

/**
 * Half a scene unit. Exponential easing never actually arrives, so a remainder this
 * small lands on the target and lets the animation stop.
 */
export const FLOW_SNAP_EPSILON = 0.5;

/**
 * The same "half a pixel is invisible" threshold for a unit-square space, taken against
 * a 1000px view root. A fractional coordinate needs its own: 0.5 of a fraction is half
 * the entire view, so the flow epsilon snaps on every frame and silently deletes the
 * easing altogether.
 */
export const FRACTION_SNAP_EPSILON = 0.0005;

/**
 * Eases `current` toward `target` at a half-life, snapping once the remainder falls
 * below `epsilon`. The epsilon is in the CALLER's units, which is why it is a parameter
 * rather than a constant: read FRACTION_SNAP_EPSILON before easing anything that is not
 * scene pixels.
 */
export function stepToward(
  current: number,
  target: number,
  dtMs: number,
  halfLifeMs: number,
  epsilon: number = FLOW_SNAP_EPSILON,
): number {
  if (Math.abs(target - current) < epsilon) return target;
  return current + (target - current) * (1 - 2 ** (-dtMs / halfLifeMs));
}
