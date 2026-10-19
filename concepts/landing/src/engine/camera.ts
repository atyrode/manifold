// The camera on the CPU, the twin of the shader's (src/engine/glsl.ts `engineCamera`): its axes, the
// ray through a cell, and where a point lands on the cell grid. Cells are gl_FragCoord's: origin at
// the bottom left, x right, y up, cell i's centre at i + 0.5. Yaw turns counter-clockwise seen from
// above (0 looks along +z, a positive yaw toward -x), pitch tilts up.
import type { EngineCamera, Vec3 } from "./types.ts";

/** The camera's axes in the world (each unit length) and the tangent of half its vertical field. */
export interface CameraBasis {
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly tan: number;
}

export function cameraBasis(camera: EngineCamera): CameraBasis {
  const sy = Math.sin(camera.yaw);
  const cy = Math.cos(camera.yaw);
  const sp = Math.sin(camera.pitch);
  const cp = Math.cos(camera.pitch);
  return {
    forward: [-sy * cp, sp, cy * cp],
    right: [cy, 0, sy],
    up: [sy * sp, cp, -cy * sp],
    tan: Math.tan(camera.fov / 2),
  };
}

/** A ray: its origin and unit direction. */
export interface Ray {
  readonly o: Vec3;
  readonly d: Vec3;
}

/** The ray from the eye through cell point (`cellX`, `cellY`) of a `width` x `height` grid. */
export function cameraRay(
  camera: EngineCamera,
  cellX: number,
  cellY: number,
  width: number,
  height: number,
): Ray {
  const { forward, right, up, tan } = cameraBasis(camera);
  const x = ((2 * cellX) / width - 1) * tan * (width / height);
  const y = ((2 * cellY) / height - 1) * tan;
  const d: Vec3 = [
    forward[0] + right[0] * x + up[0] * y,
    forward[1] + right[1] * x + up[1] * y,
    forward[2] + right[2] * x + up[2] * y,
  ];
  const length = Math.hypot(d[0], d[1], d[2]);
  return { o: camera.at, d: [d[0] / length, d[1] / length, d[2] / length] };
}

/**
 * Where world point `p` lands on a `width` x `height` grid: its cell point and its depth along the
 * camera's forward axis (metres); undefined behind the eye.
 */
export function projectPoint(
  camera: EngineCamera,
  p: Vec3,
  width: number,
  height: number,
): readonly [cellX: number, cellY: number, depth: number] | undefined {
  const { forward, right, up, tan } = cameraBasis(camera);
  const q: Vec3 = [p[0] - camera.at[0], p[1] - camera.at[1], p[2] - camera.at[2]];
  const depth = q[0] * forward[0] + q[1] * forward[1] + q[2] * forward[2];
  if (depth <= 1e-6) return undefined;
  const x =
    (q[0] * right[0] + q[1] * right[1] + q[2] * right[2]) / (depth * tan * (width / height));
  const y = (q[0] * up[0] + q[1] * up[1] + q[2] * up[2]) / (depth * tan);
  return [((x + 1) * width) / 2, ((y + 1) * height) / 2, depth];
}
