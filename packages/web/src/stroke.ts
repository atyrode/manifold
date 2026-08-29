export const STROKE_MIN_DISTANCE = 2;
export const DEFAULT_STROKE_WIDTH = 3;

export interface PointOrigin {
  readonly x: number;
  readonly y: number;
}

export interface StrokeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function appendPoint(points: number[], x: number, y: number): boolean {
  const lastX = points.at(-2);
  const lastY = points.at(-1);
  if (
    lastX !== undefined &&
    lastY !== undefined &&
    Math.hypot(x - lastX, y - lastY) < STROKE_MIN_DISTANCE
  ) {
    return false;
  }
  points.push(x, y);
  return true;
}

export function strokeBounds(points: readonly number[], strokeWidth: number): StrokeBounds {
  if (points.length < 2) return { x: 0, y: 0, width: 1, height: 1 };

  let minX = points[0] ?? 0;
  let maxX = minX;
  let minY = points[1] ?? 0;
  let maxY = minY;
  for (let index = 2; index + 1 < points.length; index += 2) {
    const x = points[index] ?? 0;
    const y = points[index + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  return {
    x: minX - strokeWidth,
    y: minY - strokeWidth,
    width: Math.max(1, maxX - minX + strokeWidth * 2),
    height: Math.max(1, maxY - minY + strokeWidth * 2),
  };
}

/**
 * Maps the stroke's natural bounds onto whatever box the node currently has, so a
 * resized element scales its ink instead of growing an empty frame around it. The
 * origin is carried explicitly: canonical points start at `strokeWidth`, but nothing
 * in the schema guarantees it.
 */
export function strokeViewBox(points: readonly number[], strokeWidth: number): string {
  const bounds = strokeBounds(points, strokeWidth);
  return `${String(bounds.x)} ${String(bounds.y)} ${String(bounds.width)} ${String(bounds.height)}`;
}

export function toRelativePoints(points: readonly number[], origin: PointOrigin): number[] {
  return points.map((value, index) => value - (index % 2 === 0 ? origin.x : origin.y));
}

export function pointsToPath(points: readonly number[]): string {
  const commands: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    commands.push(
      `${index === 0 ? "M" : "L"} ${String(points[index])} ${String(points[index + 1])}`,
    );
  }
  return commands.join(" ");
}
