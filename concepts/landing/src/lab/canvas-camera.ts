// The engine's camera as the lab's canvas mode works it on the CPU (src/engine/README.md "A frame"):
// the eye's basis, the ray through a point of the picture, a world point projected back onto the
// picture (the selection cue: an object's bounds through the document's camera), and the camera
// moves the picture's pointer and keys make (orbit about a point, pan, dolly, fly, look at). The
// picture is addressed in normalised device coordinates: x and y in -1..1 across and up, its aspect
// width over height. Yaw turns counter-clockwise seen from above, 0 looking along +z; an object's
// frame turns the same way (types.ts).
import type { Bounds, EngineCamera, Placed, Vec3 } from "../engine/types.ts";

/** Nothing nearer the eye than this projects (metres). */
export const NEAR = 0.05;
/** The camera tilts at most this far up or down (radians), short of straight. */
export const PITCH_LIMIT = Math.PI / 2 - 0.01;

export interface Basis {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** `angle` wrapped into -π..π. */
export function wrapAngle(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = angle - turn * Math.floor((angle + Math.PI) / turn);
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** The eye's forward, right and up for a yaw and pitch. */
export function cameraBasis(camera: Pick<EngineCamera, "yaw" | "pitch">): Basis {
  const [sy, cy] = [Math.sin(camera.yaw), Math.cos(camera.yaw)];
  const [sp, cp] = [Math.sin(camera.pitch), Math.cos(camera.pitch)];
  return {
    forward: [-sy * cp, sp, cy * cp],
    right: [cy, 0, sy],
    up: [sy * sp, cp, -cy * sp],
  };
}

/** The unit ray from the eye through picture point (`x`, `y`). */
export function cameraRay(camera: EngineCamera, x: number, y: number, aspect: number): Vec3 {
  const { forward, right, up } = cameraBasis(camera);
  const lens = Math.tan(camera.fov / 2);
  const d = add(forward, add(scale(right, x * lens * aspect), scale(up, y * lens)));
  return scale(d, 1 / length(d));
}

/** World point `p` on the picture, and its depth along the view; undefined nearer than NEAR. */
export function projectPoint(
  camera: EngineCamera,
  p: Vec3,
  aspect: number,
): { readonly x: number; readonly y: number; readonly depth: number } | undefined {
  const { forward, right, up } = cameraBasis(camera);
  const v = sub(p, camera.at);
  const depth = dot(v, forward);
  if (depth < NEAR) return undefined;
  const lens = Math.tan(camera.fov / 2);
  return { x: dot(v, right) / (depth * lens * aspect), y: dot(v, up) / (depth * lens), depth };
}

/** A point of an object's own frame (origin its base centre, +z its forward) in the world. */
export function objectToWorld(placed: Pick<Placed, "at" | "yaw" | "scale">, local: Vec3): Vec3 {
  const [s, c] = [Math.sin(placed.yaw), Math.cos(placed.yaw)];
  const [x, y, z] = scale(local, placed.scale);
  return [placed.at[0] + x * c - z * s, placed.at[1] + y, placed.at[2] + x * s + z * c];
}

/** The centre of an object's bounds, in the world. */
export function boundsCentre(placed: Pick<Placed, "at" | "yaw" | "scale">, bounds: Bounds): Vec3 {
  return objectToWorld(placed, scale(add(bounds.min, bounds.max), 0.5));
}

/** The eight corners of an object's bounds, in the world. */
function corners(placed: Pick<Placed, "at" | "yaw" | "scale">, bounds: Bounds): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) out.push(objectToWorld(placed, [x, y, z]));
  return out;
}

/** The box's twelve edges, as pairs of corner indices (corners' order: x, then y, then z). */
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** A rectangle on the picture, in normalised device coordinates. */
export interface PictureRect {
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
}

/**
 * The rectangle an object's bounds cover on the picture: every edge of the box, cut where it passes
 * behind the eye, projected through the camera. Undefined when the whole box is behind the eye.
 */
export function projectBounds(
  camera: EngineCamera,
  placed: Pick<Placed, "at" | "yaw" | "scale">,
  bounds: Bounds,
  aspect: number,
): PictureRect | undefined {
  const { forward, right, up } = cameraBasis(camera);
  const lens = Math.tan(camera.fov / 2);
  const view = corners(placed, bounds).map((p): Vec3 => {
    const v = sub(p, camera.at);
    return [dot(v, right), dot(v, up), dot(v, forward)];
  });
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const take = (p: Vec3) => {
    const x = p[0] / (p[2] * lens * aspect);
    const y = p[1] / (p[2] * lens);
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  };
  for (const [i, j] of EDGES) {
    let a = view[i];
    let b = view[j];
    if (!a || !b) continue;
    if (a[2] < NEAR && b[2] < NEAR) continue;
    // The part of the edge in front of the eye.
    if (a[2] < NEAR) [a, b] = [b, a];
    if (b[2] < NEAR) b = add(a, scale(sub(b, a), (a[2] - NEAR) / (a[2] - b[2])));
    take(a);
    take(b);
  }
  return x0 <= x1 ? { min: [x0, y0], max: [x1, y1] } : undefined;
}

/** Where a ray from `origin` along `dir` crosses the level plane at height `y`, ahead of it. */
export function planeHit(origin: Vec3, dir: Vec3, y: number): Vec3 | undefined {
  if (Math.abs(dir[1]) < 1e-6) return undefined;
  const t = (y - origin[1]) / dir[1];
  return t > 0 ? add(origin, scale(dir, t)) : undefined;
}

/**
 * The camera turned by `yaw` and tilted by `pitch` about `pivot`: the eye swings round the pivot as
 * the view turns, so the pivot stays where it was on the picture. The tilt stops short of straight up
 * or down.
 */
export function orbit(camera: EngineCamera, pivot: Vec3, yaw: number, pitch: number): EngineCamera {
  const before = cameraBasis(camera);
  const next = {
    yaw: wrapAngle(camera.yaw + yaw),
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch + pitch)),
  };
  const after = cameraBasis(next);
  // The eye keeps its place relative to the pivot in the camera's own frame.
  const o = sub(camera.at, pivot);
  const [r, f, u] = [dot(o, before.right), dot(o, before.forward), dot(o, before.up)];
  const at = add(
    pivot,
    add(scale(after.right, r), add(scale(after.forward, f), scale(after.up, u))),
  );
  return { ...camera, ...next, at };
}

/** The eye moved `right` and `up` metres across the view, looking the same way. */
export function pan(camera: EngineCamera, right: number, up: number): EngineCamera {
  const basis = cameraBasis(camera);
  return { ...camera, at: add(camera.at, add(scale(basis.right, right), scale(basis.up, up))) };
}

/**
 * The eye moved `share` of the way to `target` (negative: away from it), looking the same way. It
 * never reaches the target.
 */
export function dolly(camera: EngineCamera, target: Vec3, share: number): EngineCamera {
  const step = Math.min(share, 0.9);
  return { ...camera, at: add(camera.at, scale(sub(target, camera.at), step)) };
}

/**
 * The eye flown `ahead` metres along its heading (level, whatever its tilt), `right` across it and
 * `up` straight up: the WASD and QE keys.
 */
export function fly(camera: EngineCamera, ahead: number, right: number, up: number): EngineCamera {
  const [s, c] = [Math.sin(camera.yaw), Math.cos(camera.yaw)];
  return {
    ...camera,
    at: [
      camera.at[0] - s * ahead + c * right,
      camera.at[1] + up,
      camera.at[2] + c * ahead + s * right,
    ],
  };
}

/** The camera turned and tilted to look at `target`, where it stands. */
export function lookAt(camera: EngineCamera, target: Vec3): EngineCamera {
  const d = sub(target, camera.at);
  const flat = Math.hypot(d[0], d[2]);
  if (flat < 1e-9 && Math.abs(d[1]) < 1e-9) return camera;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.atan2(d[1], flat)));
  const yaw = flat < 1e-9 ? camera.yaw : Math.atan2(-d[0], d[2]);
  return { ...camera, yaw, pitch };
}
