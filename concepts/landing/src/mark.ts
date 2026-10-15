// The Manifold M, after the app icon: one source for the sims that stamp, trace or steer toward it
// and for the shaders that draw it (shaders/common.ts interpolates `markGlsl`).
//
// Mark units: the M is one unit tall, centred, y up: x in [-0.47, 0.47], y in [-0.5, 0.5]. It is a
// single polyline through the five vertices, four strokes from vertex k to k + 1: the left leg up,
// down to the middle, up again, the right leg down.
//
//   MARK_VERTICES                              the five vertices, [x, y]
//   markVertex(i)                              vertex i, as GLSL markVertex (any i but 0..3 gives the last)
//   segmentDistance(px, py, ax, ay, bx, by)    distance from p to the segment a–b
//   markDistance(x, y)                         distance from (x, y) to the M, as GLSL markDistance
//   markGlsl                                   GLSL: segmentDistance, M0..M4, markDistance, markVertex
//
// Usage (the M `size` view heights tall, centred on (cx, cy)):
//   const d = markDistance((x - cx) / size, (y - cy) / size) * size; // view heights
//   for (let k = 0; k < 4; k++) trace(markVertex(k), markVertex(k + 1));
import { glslFloat } from "./shaders/glsl.ts";

export type MarkVertex = readonly [x: number, y: number];

export const MARK_VERTICES: readonly [MarkVertex, MarkVertex, MarkVertex, MarkVertex, MarkVertex] =
  [
    [-0.47, -0.5],
    [-0.47, 0.5],
    [0, -0.08],
    [0.47, 0.5],
    [0.47, -0.5],
  ];

const [M0, M1, M2, M3, M4] = MARK_VERTICES;

/** Vertex i of the M; like GLSL markVertex, any i other than 0..3 gives the last vertex. */
export function markVertex(i: number): MarkVertex {
  return MARK_VERTICES[i] ?? M4;
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by); a zero-length segment gives the distance to a. */
export function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0;
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}

/** Distance from (x, y) to the M, both in mark units. */
export function markDistance(x: number, y: number): number {
  return Math.min(
    Math.min(
      segmentDistance(x, y, M0[0], M0[1], M1[0], M1[1]),
      segmentDistance(x, y, M1[0], M1[1], M2[0], M2[1]),
    ),
    Math.min(
      segmentDistance(x, y, M2[0], M2[1], M3[0], M3[1]),
      segmentDistance(x, y, M3[0], M3[1], M4[0], M4[1]),
    ),
  );
}

const vec2 = (v: MarkVertex): string => `vec2(${glslFloat(v[0])}, ${glslFloat(v[1])})`;

/** The M in GLSL, the same names and maths as above. Needs nothing but GLSL builtins. */
export const markGlsl = `
float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// The Manifold M, after the app icon, in mark units: x in [-0.47, 0.47], y in [-0.5, 0.5].
const vec2 M0 = ${vec2(M0)};
const vec2 M1 = ${vec2(M1)};
const vec2 M2 = ${vec2(M2)};
const vec2 M3 = ${vec2(M3)};
const vec2 M4 = ${vec2(M4)};

float markDistance(vec2 q) {
  return min(min(segmentDistance(q, M0, M1), segmentDistance(q, M1, M2)), min(segmentDistance(q, M2, M3), segmentDistance(q, M3, M4)));
}

vec2 markVertex(int i) {
  return i == 0 ? M0 : i == 1 ? M1 : i == 2 ? M2 : i == 3 ? M3 : M4;
}
`;
