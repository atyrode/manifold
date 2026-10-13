// A number written into a 16-bit float texture as two halves, hi + lo, so one rg16f pair carries
// about 22 significant bits instead of 11: positions, angles and clocks a shader needs finer than a
// half float holds.
//
//   toHalf(x)               the nearest half float to x, subnormals included; |x| ≥ 65504 gives
//                           ±65504, NaN and ±Infinity give 0
//   splitHalf(out, at, x)   out[at] = hi = toHalf(x), out[at + 1] = toHalf(x - hi)
//   unsplitHalfGlsl         GLSL: float unsplitHalf(vec2 hl)  hl.x + hl.y
//                                 vec2 unsplitHalf(vec4 v)    (v.x + v.y, v.z + v.w): two pairs per texel
//
// Both parts are exact half floats (and float32s), so the upload does not round them again. The
// shader's highp sum gives x back within 2^-22 of its size for |x| ≥ 1/8, and within 2^-25 absolute
// below that (where the lo part runs into half subnormals).
// Keep |x| below 65504; a wider range needs its own scheme (shanshui's whole-number part, k · 32 + ...).
// Include `unsplitHalfGlsl` once in the scene's glsl; it needs nothing but GLSL builtins.
//
// Usage (a centre on the shader's rgba16f state texel 0):
//   splitHalf(this.#state, 0, centreX);
//   splitHalf(this.#state, 2, centreY);
//   // GLSL: vec2 centre = unsplitHalf(texelFetch(uSim0, ivec2(0, 0), 0));

/** The nearest half-precision float (exact in float32 too); subnormals and overflow included. */
export function toHalf(x: number): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  const a = Math.abs(x);
  if (a >= 65504) return Math.sign(x) * 65504;
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e -= 1;
  else if (2 ** (e + 1) <= a) e += 1;
  const q = 2 ** (Math.max(e, -14) - 10);
  return Math.round(x / q) * q;
}

/** Writes x as two halves, hi + lo, at out[at] and out[at + 1]. */
export function splitHalf(out: Float32Array, at: number, x: number): void {
  const hi = toHalf(x);
  out[at] = hi;
  out[at + 1] = toHalf(x - hi);
}

/** GLSL decoding splitHalf: `float unsplitHalf(vec2 hl)` and `vec2 unsplitHalf(vec4 v)` for two pairs. */
export const unsplitHalfGlsl = `
// A number a sim wrote with splitHalf (sims/half.ts): two half floats, hi + lo.
float unsplitHalf(vec2 hl) {
  return hl.x + hl.y;
}

// Two such numbers in one texel: (x hi, x lo, y hi, y lo).
vec2 unsplitHalf(vec4 v) {
  return vec2(v.x + v.y, v.z + v.w);
}
`;
