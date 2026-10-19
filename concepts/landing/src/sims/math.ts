// Scalar helpers for sims, each written once with the operation order the scenes' own copies used,
// so a sim that switches to them computes bit for bit what it did before.
//
//   clamp(x, lo, hi)         min(hi, max(lo, x))
//   lerp(a, b, t)            a + (b - a) · t (GLSL mix)
//   smoothstep(e0, e1, x)    GLSL smoothstep; smoothstep(0, 1, x) is the clamped `smooth(x)` too
//   fract(x)                 x - floor(x) (GLSL fract)
//   easeFactor(dt, tau)      1 - exp(-dt / tau): the share an exponential ease covers in dt seconds
//   approach(x, to, dt, tau) x + (to - x) · easeFactor(dt, tau): x eased toward `to` with time
//                            constant tau, the same at any frame rate (a lag, a smoothing, a fade
//                            toward 0 or 1). Pass dt = 0 for no move; tau = 0 is not a number of
//                            seconds (0 / 0 is NaN at dt = 0)
//   hash31(a, b, c)          a stable number in [0, 1) for three integers (a lattice hash)
//   glslHash12(x, y)         common.ts `hash12(vec2(x, y))` in float32 steps, as the shader runs it:
//                            for a sim that must agree with what its shader hashes (pond's koi
//                            loops, falls' bank ferns)
//   glslHash22(x, y, out)    common.ts `hash22(vec2(x, y))` the same way, into out[0], out[1] (tide
//                            pool's holdfasts)
//   glslVnoise(x, y)         common.ts `vnoise(vec2(x, y))` and `fbm3(vec2(x, y))` on glslHash12's
//   glslFbm3(x, y)           lattice (the blend in float64): falls' near bank's top, where the drops
//                            off its ferns land
//   hypot2(x, y)             √(x² + y²) and √(x² + y² + z²) with the bits of V8's Math.hypot (the
//   hypot3(x, y, z)          page's in Chrome) in every engine: for a seeded layout that must come
//                            out the same in every browser (country's terrain, land use, chalk M,
//                            verges and fog floor)
//   atan2(y, x)              the angle of (x, y) with the bits of V8's Math.atan2 in every engine
//                            (country's building headings)
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

/** 1 - exp(-dt / tau): the share of the way to its target an exponential ease with time constant tau covers in dt seconds. */
export function easeFactor(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

/**
 * `current` eased toward `target` for dt seconds with time constant tau (seconds to cover 1 - 1/e of
 * the gap), as `current + (target - current) * (1 - exp(-dt / tau))`: frame-rate independent, since two
 * steps of dt cover what one of 2 dt does. For one factor across many values, use easeFactor.
 */
export function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * easeFactor(dt, tau);
}

/**
 * A stable number in [0, 1) for three integers (each taken as its low 32 bits), mixed with the murmur3
 * finaliser: for per-cell or per-item variation that must not change with the order of the calls.
 */
export function hash31(a: number, b: number, c: number): number {
  let h =
    Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
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

/** common.ts `vnoise(vec2(x, y))`: glslHash12's lattice round (x, y), blended smoothly. */
export function glslVnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = glslHash12(ix, iy);
  const b = glslHash12(ix + 1, iy);
  const c = glslHash12(ix, iy + 1);
  const d = glslHash12(ix + 1, iy + 1);
  return a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uy;
}

/** common.ts `fbm3(vec2(x, y))`: three octaves of glslVnoise. */
export function glslFbm3(x: number, y: number): number {
  return (
    (0.5 * glslVnoise(x, y) +
      0.25 * glslVnoise(x * 2.03 + 17.1, y * 2.03 + 9.2) +
      0.125 * glslVnoise(x * 4.11 + 4.3, y * 4.11 + 31.7)) /
    0.875
  );
}

// Math.hypot is only approximated, each engine its own way: JavaScriptCore (Safari, bun) rounds a
// third of the map's distances otherwise than V8 (Chrome, node), enough that one seed built two
// different countrysides. hypot2 and hypot3 are V8's algorithm (src/builtins/math.tq, MathHypot:
// each magnitude over the largest, squared and summed, the third square Kahan-compensated) in
// arithmetic IEEE 754 rounds alike in every engine. The argument count is part of it:
// hypot3(x, y, 0) may round otherwise than hypot2(x, y), as Math.hypot does in V8.

/** √(x² + y²), with the bits V8's `Math.hypot(x, y)` gives, in any engine. */
export function hypot2(x: number, y: number): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  const max = Math.max(a, b);
  if (Number.isNaN(max)) return Number.NaN;
  if (max === 0) return 0;
  const p = a / max;
  const q = b / max;
  return Math.sqrt(p * p + q * q) * max;
}

/** √(x² + y² + z²), with the bits V8's `Math.hypot(x, y, z)` gives, in any engine. */
export function hypot3(x: number, y: number, z: number): number {
  const a = Math.abs(x);
  const b = Math.abs(y);
  const c = Math.abs(z);
  if (a === Infinity || b === Infinity || c === Infinity) return Infinity;
  const max = Math.max(a, b, c);
  if (Number.isNaN(max)) return Number.NaN;
  if (max === 0) return 0;
  const p = a / max;
  const q = b / max;
  const r = c / max;
  const pp = p * p;
  const qq = q * q;
  // What rounding lost from the first two squares' sum, taken back from the third.
  const lost = pp + qq - pp - qq;
  return Math.sqrt(pp + qq + (r * r - lost)) * max;
}

// Math.atan2 is a library call, each engine its own: V8 runs fdlibm (src/base/ieee754.cc), while
// JavaScriptCore calls the system's libm, which rounds some of the country's building headings up
// to 8 ulps otherwise. atan2 is fdlibm's (e_atan2.c, s_atan.c) in IEEE 754 arithmetic alone, which
// every engine rounds alike, so V8's bits in any engine.

/** atan(odd and even parts): fdlibm's coefficients of its polynomial on the reduced argument. */
const ATAN_T = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1,
  -1.1111110405462355788e-1, 9.09088713343650656196e-2, -7.69187620504482999495e-2,
  6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2,
  -3.6531572744216915527e-2, 1.62858201153657823623e-2,
] as const;
/** atan(0.5), atan(1), atan(1.5) and atan(∞) as high and low parts. */
const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
] as const;
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
] as const;
const PI_LO = 1.2246467991473532e-16;
/** A double's high 32 bits (sign, exponent, top of the significand). */
const words = new DataView(new ArrayBuffer(8));
function high(x: number): number {
  words.setFloat64(0, x);
  return words.getInt32(0);
}

/** x · (s1 + s2): what atan(x) ≈ x falls short by, for a reduced |x| < 7/16 (s_atan.c's poly). */
function atanTail(x: number): number {
  const z = x * x;
  const w = z * z;
  const [t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10] = ATAN_T;
  const s1 = z * (t0 + w * (t2 + w * (t4 + w * (t6 + w * (t8 + w * t10)))));
  const s2 = w * (t1 + w * (t3 + w * (t5 + w * (t7 + w * t9))));
  return x * (s1 + s2);
}

/** fdlibm's atan(x) (s_atan.c): reduced to |x| < 7/16 about 0, 0.5, 1, 1.5 or ∞, then a polynomial. */
function atan(x: number): number {
  const hx = high(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x44100000) {
    // |x| ≥ 2^66, or NaN.
    if (Number.isNaN(x)) return x + x;
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) {
    // |x| < 7/16; below 2^-27 atan(x) rounds to x.
    return ix < 0x3e400000 ? x : x - atanTail(x);
  }
  const a = Math.abs(x);
  let id: 0 | 1 | 2 | 3;
  let t: number;
  if (ix < 0x3fe60000) {
    // 7/16 ≤ |x| < 11/16.
    id = 0;
    t = (2 * a - 1) / (2 + a);
  } else if (ix < 0x3ff30000) {
    // 11/16 ≤ |x| < 19/16.
    id = 1;
    t = (a - 1) / (a + 1);
  } else if (ix < 0x40038000) {
    // 19/16 ≤ |x| < 39/16.
    id = 2;
    t = (a - 1.5) / (1 + 1.5 * a);
  } else {
    // 39/16 ≤ |x| < 2^66.
    id = 3;
    t = -1 / a;
  }
  const r = ATAN_HI[id] - (atanTail(t) - ATAN_LO[id] - t);
  return hx < 0 ? -r : r;
}

/** The angle of (x, y) from +x, in [-π, π]: the bits of V8's `Math.atan2(y, x)`, in any engine. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return x + y;
  if (x === 1) return atan(y);
  const hx = high(x);
  const hy = high(y);
  const ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;
  // Bit 0 the sign of y, bit 1 the sign of x (a zero's too).
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2);
  if (y === 0) {
    if (m < 2) return y;
    return m === 2 ? Math.PI : -Math.PI;
  }
  if (x === 0 || iy === 0x7ff00000) {
    if (ix === 0x7ff00000) {
      // Both infinite.
      const a = m < 2 ? Math.PI / 4 : 3 * (Math.PI / 4);
      return m & 1 ? -a : a;
    }
    return hy < 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  if (ix === 0x7ff00000) {
    const a = m < 2 ? 0 : Math.PI;
    return m & 1 ? -a : a;
  }
  // y/x's binary orders apart.
  const k = (iy - ix) >> 20;
  let z: number;
  let quadrant = m;
  if (k > 60) {
    z = Math.PI / 2 + 0.5 * PI_LO;
    quadrant &= 1;
  } else if (hx < 0 && k < -60) z = 0;
  else z = atan(Math.abs(y / x));
  switch (quadrant) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return Math.PI - (z - PI_LO);
    default:
      return z - PI_LO - Math.PI;
  }
}
