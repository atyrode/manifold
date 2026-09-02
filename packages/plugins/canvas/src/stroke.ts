/**
 * INK, as this plugin authors it. The GEOMETRY moved to `@manifold/plugin/hooks`
 * (`polylineBounds`, `polylinePath`, `polylineViewBox`, `polylineRelativeTo`) once issue #117
 * found `core.draw`'s renderer carrying an equivalent private copy of it: a polyline is a
 * coordinate sequence and belongs to the element plane, while a STROKE — a freehand ink record
 * — is a domain noun the floor may not learn, so what is left here is exactly the part that
 * knows about ink.
 */
export const STROKE_MIN_DISTANCE = 2;
export const DEFAULT_STROKE_WIDTH = 3;

/**
 * Samples one pointer position into a live stroke, refusing a step shorter than
 * {@link STROKE_MIN_DISTANCE}. A pointer emits far more frames than a drawing has shape, and
 * every retained point is a number on the wire and a command in the painted path.
 */
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
