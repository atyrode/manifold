// A ray against a height field on the CPU: where a line of sight first meets ground that a shader
// ray-marches, so a click lands on what the picture shows under the pointer (the face of a dune, a
// bank of gravel) rather than on a flat plane at the mean level behind or before it.
//
// The march is the one the height-field shaders here use (dunes): from where the ray enters the
// slab under `top`, steps as long as the slope bound allows, gap / (slope + |dir.y|) for ground no
// steeper than `slope`, but never shorter than minStep + relStep · t, so the far field is reached in
// `steps`; then `refine` bisections of the last step. Out of steps while still above the ground, it
// calls it there (a grazing ray skimming far sand). Give it the shader's own numbers and both find
// the same surface, the far crests a long step jumps over included: the CPU then picks exactly what
// that pixel draws.
//
//   marchHeight(height, ox, oy, oz, dx, dy, dz, march, out)
//       true with out.t (distance along the unit ray) and out.x, y, z (the point) when the ray meets
//       the ground before march.far; false when it climbs out above `top` or runs past `far`
//   sampleRepeat(data, width, rows, x, z)
//       a grid sampled as a linear, repeating GPU texture reads it: texel (i, j) centred on
//       (i + 0.5, j + 0.5) in texel units, rows bottom to top as DataTexture uploads them
//
// height(x, z) is the ground's height at a horizontal point, in the ray's units, y up. Sample a sim
// texture as the shader does (sampleRepeat for a repeating one, HeightField.sample for a clamped
// one), and build the closure once: the march allocates nothing.
//
// Usage (a scene whose shader marches uSim0 with the same numbers):
//   export const MARCH: HeightMarch = { top: 16, far: 900, slope: 0.75, minStep: 0.02, relStep: 0.01, steps: 48, refine: 5 };
//   const ground = (x: number, z: number): number => sampleRepeat(heights, 256, 256, x, z);
//   const hit: RayHit = { t: 0, x: 0, y: 0, z: 0 };
//   if (marchHeight(ground, eye.x, eye.y, eye.z, ray.x, ray.y, ray.z, MARCH, hit)) pour(hit.x, hit.z);
//   // GLSL: the same loop with ${glslFloat(MARCH.slope)}, ${MARCH.steps}, ... (dunes/shader.ts)

/** The march's numbers: keep them those of the shader that draws the ground. */
export interface HeightMarch {
  /** No ground stands higher: a ray above it climbing gives up, one coming down starts here. */
  readonly top: number;
  /** Distance past which the ray gives up. */
  readonly far: number;
  /** The steepest slope (rise over run) anywhere on the ground: the step's bound. */
  readonly slope: number;
  /** The shortest step: minStep + relStep · distance. */
  readonly minStep: number;
  readonly relStep: number;
  /** Most steps, and bisections of the step that crossed the ground. */
  readonly steps: number;
  readonly refine: number;
}

/** Where a ray met the ground: distance along the unit ray, and the point. */
export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** First meeting of the unit ray (ox, oy, oz) + t (dx, dy, dz) with y = height(x, z); see the header. */
export function marchHeight(
  height: (x: number, z: number) => number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  march: HeightMarch,
  out: RayHit,
): boolean {
  if (oy >= march.top && dy >= 0) return false;
  let t = oy > march.top ? (oy - march.top) / -dy : 0;
  let last = t;
  let crossed = false;
  for (let i = 0; i < march.steps; i++) {
    const py = oy + dy * t;
    const gap = py - height(ox + dx * t, oz + dz * t);
    if (gap < 0) {
      crossed = true;
      break;
    }
    if (dy >= 0 && py > march.top) return false;
    last = t;
    t += Math.max(gap / (march.slope + Math.abs(dy)), march.relStep * t + march.minStep);
    if (t > march.far) return false;
  }
  if (crossed) {
    let lo = last;
    let hi = t;
    for (let i = 0; i < march.refine; i++) {
      const mid = 0.5 * (lo + hi);
      if (oy + dy * mid > height(ox + dx * mid, oz + dz * mid)) lo = mid;
      else hi = mid;
    }
    t = 0.5 * (lo + hi);
  }
  out.t = t;
  out.x = ox + dx * t;
  out.y = oy + dy * t;
  out.z = oz + dz * t;
  return true;
}

/** Bilinear height at (x, z) in texel units of a repeating `width` × `rows` grid (see the header). */
export function sampleRepeat(
  data: Float32Array,
  width: number,
  rows: number,
  x: number,
  z: number,
): number {
  const fx = x - 0.5;
  const fz = z - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const i0 = ((i % width) + width) % width;
  const j0 = ((j % rows) + rows) % rows;
  const i1 = i0 + 1 === width ? 0 : i0 + 1;
  const r0 = j0 * width;
  const r1 = (j0 + 1 === rows ? 0 : j0 + 1) * width;
  const a = data[r0 + i0] ?? 0;
  const b = data[r0 + i1] ?? 0;
  const c = data[r1 + i0] ?? 0;
  const d = data[r1 + i1] ?? 0;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}
