export const GESTURE_HALF_LIFE_MS = 60;
export const CURSOR_HALF_LIFE_MS = 80;

export function stepToward(
  current: number,
  target: number,
  dtMs: number,
  halfLifeMs: number,
): number {
  if (Math.abs(target - current) < 0.5) return target;
  return current + (target - current) * (1 - 2 ** (-dtMs / halfLifeMs));
}
