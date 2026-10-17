// Half floats for 16-bit float textures: a number rounded to one, as its bit pattern for a
// HALF_FLOAT upload, or written as two halves, hi + lo, so one rg16f pair carries about 22
// significant bits instead of 11: positions, angles and clocks a shader needs finer than a half
// float holds.
//
//   toHalf(x)               the nearest half float to x, subnormals included; |x| ≥ 65504 gives
//                           ±65504, NaN and ±Infinity give 0
//   halfBits(x)             the binary16 bit pattern of x as a float32, rounded to nearest even as
//                           GL converts a FLOAT upload into a 16f texture: a Uint16Array of these
//                           uploads (DataTexture) exactly the texels the Float32Array would
//   halfValue(bits)         the number a binary16 bit pattern holds (halfBits' inverse on halves)
//   splitHalf(out, at, x)   out[at] = hi = toHalf(x), out[at + 1] = toHalf(x - hi)
//   unsplitHalfGlsl         GLSL: float unsplitHalf(vec2 hl)  hl.x + hl.y
//                                 vec2 unsplitHalf(vec4 v)    (v.x + v.y, v.z + v.w): two pairs per texel
//
// splitHalf's parts are exact half floats (and float32s), so the upload does not round them again.
// The shader's highp sum gives x back within 2^-22 of its size for |x| ≥ 1/8, and within 2^-25
// absolute below that (where the lo part runs into half subnormals).
// Keep |x| below 65504; a wider range needs its own scheme (shanshui's whole-number part, k · 32 + ...).
// Include `unsplitHalfGlsl` once in the scene's glsl; it needs nothing but GLSL builtins.
//
// Usage (a centre on the shader's rgba16f state texel 0):
//   splitHalf(this.#state, 0, centreX);
//   splitHalf(this.#state, 2, centreY);
//   // GLSL: vec2 centre = unsplitHalf(texelFetch(uSim0, ivec2(0, 0), 0));
// Usage (a field kept as halves beside its float32 copy, uploaded as half floats):
//   field[k] = value;
//   halves[k] = halfBits(field[k]);
//   texture.uploadRegion(halves, x, y, width, height);

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

const float32 = new Float32Array(1);
const float32Bits = new Uint32Array(float32.buffer);

/**
 * The IEEE binary16 bit pattern of x as a float32, rounded to nearest, ties to even: what GL makes
 * of a FLOAT upload into a 16f texture. ±65520 and beyond give ±Infinity, NaN a quiet NaN.
 */
export function halfBits(x: number): number {
  float32[0] = x;
  const bits = float32Bits[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const abs = bits & 0x7fffffff;
  if (abs > 0x7f800000) return sign | 0x7e00;
  if (abs >= 0x38800000) {
    // A normal half: rebias the exponent (127 → 15) and round off the 13 low mantissa bits, the
    // carry running into the exponent and from 65520 up into Infinity.
    return sign | Math.min(0x7c00, (abs - 0x38000000 + 0xfff + ((abs >>> 13) & 1)) >>> 13);
  }
  // A subnormal half (or 0): the value in units of 2^-24, exact in a double, rounded.
  const units = Math.abs(float32[0] ?? 0) * 2 ** 24;
  const whole = Math.floor(units);
  const rest = units - whole;
  return sign | (rest > 0.5 || (rest === 0.5 && whole % 2 === 1) ? whole + 1 : whole);
}

/** The number the binary16 bit pattern `bits` holds: subnormals, ±Infinity and NaN included. */
export function halfValue(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
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
