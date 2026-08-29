/**
 * Truth over beauty: remote motion renders the freshest frame with only enough easing
 * to round off the send cadence (16ms). Local interaction never interpolates.
 */
export const GESTURE_HALF_LIFE_MS = 30;
export const CURSOR_HALF_LIFE_MS = 30;

export function stepToward(
  current: number,
  target: number,
  dtMs: number,
  halfLifeMs: number,
): number {
  if (Math.abs(target - current) < 0.5) return target;
  return current + (target - current) * (1 - 2 ** (-dtMs / halfLifeMs));
}
