// Scalar helpers for sims, each written once with the operation order the scenes' own copies used,
// so a sim that switches to them computes bit for bit what it did before.
//
//   clamp(x, lo, hi)         min(hi, max(lo, x))
//   lerp(a, b, t)            a + (b - a) · t (GLSL mix)
//   smoothstep(e0, e1, x)    GLSL smoothstep; smoothstep(0, 1, x) is the clamped `smooth(x)` too
//   fract(x)                 x - floor(x) (GLSL fract)
//   hash31(a, b, c)          a stable number in [0, 1) for three integers (a lattice hash)
//   glslHash12(x, y)         common.ts `hash12(vec2(x, y))` in float32 steps, as the shader runs it:
//                            for a sim that must agree with what its shader hashes (pond's koi
//                            loops, falls' bank ferns)
//   glslHash22(x, y, out)    common.ts `hash22(vec2(x, y))` the same way, into out[0], out[1] (tide
//                            pool's holdfasts)
//
// Usage:
//   const fade = smoothstep(0.2, 0.6, age / life);
//   const sway = lerp(0.8, 1.2, hash31(column, row, seed));
//
// Leave a sim's own value-noise hashes alone unless they are this exact one: a different hash moves
// every seeded layout built on it.

/** x limited to [lo, hi]: min(hi, max(lo, x)). */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** a + (b - a) · t: a at t = 0, b at t = 1 (GLSL mix). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * GLSL's smoothstep: 0 below edge0, 1 above edge1, Hermite between. smoothstep(0, 1, x) equals the
 * clamped `t * t * (3 - 2 * t)` exactly. Reversed edges fall from 1 to 0 (GLSL leaves them undefined);
 * equal edges step, with NaN exactly at the edge.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** x - floor(x), as GLSL fract: in [0, 1), except that a tiny negative x rounds up to exactly 1. */
export function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * A stable number in [0, 1) for three integers (each taken as its low 32 bits), mixed with the murmur3
 * finaliser: for per-cell or per-item variation that must not change with the order of the calls.
 */
export function hash31(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const f32 = Math.fround;

/** common.ts `hash12(vec2(x, y))`, step by step in float32 as the shader runs it. */
export function glslHash12(x: number, y: number): number {
  const k = f32(0.1031);
  const s = f32(33.33);
  let a = f32(f32(f32(x) * k) - Math.floor(f32(f32(x) * k)));
  let b = f32(f32(f32(y) * k) - Math.floor(f32(f32(y) * k)));
  let c = a;
  const d = f32(f32(f32(a * f32(b + s)) + f32(b * f32(c + s))) + f32(c * f32(a + s)));
  a = f32(a + d);
  b = f32(b + d);
  c = f32(c + d);
  const h = f32(f32(a + b) * c);
  return f32(h - Math.floor(h));
}

/** common.ts `hash22(vec2(x, y))`, step by step in float32, into out[0] and out[1]. */
export function glslHash22(x: number, y: number, out: Float64Array): void {
  const fx = f32(f32(x) * f32(0.1031));
  const fy = f32(f32(y) * f32(0.103));
  const fz = f32(f32(x) * f32(0.0973));
  let a = f32(fx - Math.floor(fx));
  let b = f32(fy - Math.floor(fy));
  let c = f32(fz - Math.floor(fz));
  const s = f32(33.33);
  const d = f32(f32(f32(a * f32(b + s)) + f32(b * f32(c + s))) + f32(c * f32(a + s)));
  a = f32(a + d);
  b = f32(b + d);
  c = f32(c + d);
  const u = f32(f32(a + b) * c);
  const v = f32(f32(a + c) * b);
  out[0] = f32(u - Math.floor(u));
  out[1] = f32(v - Math.floor(v));
}
