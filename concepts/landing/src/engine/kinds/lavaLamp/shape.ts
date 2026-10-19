// The lava lamp's shape, shared by its manifest (bounds, the CPU cast), its GLSL and its wax's sim:
// the classic rocket, in lamp units (1 tall from the foot of its base to the top of its cap; the
// `size` option is that height in metres), as the lava scene drew it (src/scenes/lava/sim.ts SHAPE).
// A lathe: a metal cone narrowing up from its foot to the collar, the glass bottle from the collar
// (a rounded shoulder low down, then a long straight taper), a metal cone of a cap on it.
//
// The wax lives in glass units: gy 0 at the bottom of the liquid (the collar) .. 1 under the cap,
// across from the glass's axis on the same scale (one glass unit is GLASS lamp units).
import type { Vec3 } from "../../types.ts";

/** Heights of the base, the glass and the cap, lamp units. */
export const BASE = 0.3;
export const GLASS = 0.58;
export const CAP = 0.12;
/** The base's radius at its foot and at its collar. */
export const FOOT = 0.165;
export const COLLAR = 0.09;
/** The glass's outer radius at the collar, at its widest (WIDE_AT of the way up) and under the cap. */
export const GLASS_BOTTOM = 0.088;
export const GLASS_WIDE = 0.148;
export const WIDE_AT = 0.2;
export const GLASS_TOP = 0.066;
/** The glass's thickness. */
export const WALL = 0.006;
/** The cap's radius at its rim and at its top. */
export const CAP_BOTTOM = 0.074;
export const CAP_TOP = 0.034;

/** Parcels of wax per lamp (sim.ts), and the texels of its state block (KindDef.state). */
export const PARCELS = 20;
export const STATE_TEXELS = 1 + 2 * PARCELS;

/** The glass's outer radius (lamp units) at s, 0 at the collar .. 1 under the cap. */
export function glassRadius(s: number): number {
  const t = Math.min(1, Math.max(0, s));
  if (t < WIDE_AT) {
    const a = 1 - t / WIDE_AT;
    return GLASS_BOTTOM + (GLASS_WIDE - GLASS_BOTTOM) * (1 - a * a);
  }
  return GLASS_WIDE + ((GLASS_TOP - GLASS_WIDE) * (t - WIDE_AT)) / (1 - WIDE_AT);
}

/** The liquid's radius (glass units) at glass height gy. */
export function innerRadius(gy: number): number {
  return (glassRadius(gy) - WALL) / GLASS;
}

/** What a piece of the lathe is: its index in the `part` a hit reports (the cap's top is the last). */
export const PART = { base: 0, glass: 1, cap: 2, top: 3 } as const;

/** A piece of the lathe: a cone from radius r0 at height y0 up to r1 at y1 (lamp units). */
export interface LatheSegment {
  readonly y0: number;
  readonly r0: number;
  readonly y1: number;
  readonly r1: number;
  readonly part: (typeof PART)["base" | "glass" | "cap"];
}

/** The glass's shoulder as cones between these shares of its height; then the taper to the cap. */
const SHOULDER = [0, WIDE_AT / 3, (2 * WIDE_AT) / 3, WIDE_AT, 1] as const;

/** The lathe, bottom to top: the base, the glass's cones, the cap (its top a disc of CAP_TOP). */
export const LATHE: readonly LatheSegment[] = [
  { y0: 0, r0: FOOT, y1: BASE, r1: COLLAR, part: PART.base },
  ...SHOULDER.slice(1).map((s, k) => {
    const from = SHOULDER[k] ?? 0;
    return {
      y0: BASE + from * GLASS,
      r0: glassRadius(from),
      y1: BASE + s * GLASS,
      r1: glassRadius(s),
      part: PART.glass,
    };
  }),
  { y0: BASE + GLASS, r0: CAP_BOTTOM, y1: 1, r1: CAP_TOP, part: PART.cap },
];

/**
 * Where the ray ro + rd t (lamp units, rd unit) first meets the lathe's outside with t in span, and
 * the unit normal there: the CPU twin of the GLSL's lavaLampLathe (code.ts), cone by cone.
 */
export function castLathe(
  ro: Vec3,
  rd: Vec3,
  span: readonly [number, number],
): { readonly t: number; readonly normal: Vec3 } | undefined {
  const [ox, oy, oz] = ro;
  const [dx, dy, dz] = rd;
  let best: { t: number; normal: Vec3 } | undefined;
  const take = (t: number, normal: () => Vec3) => {
    if (t < span[0] || t > span[1] || (best !== undefined && t >= best.t)) return;
    best = { t, normal: normal() };
  };
  for (const { y0, r0, y1, r1 } of LATHE) {
    // |xz(t)| = r(y(t)), r linear in y: a quadratic in t; roots off the cone's span or on its
    // mirrored half (r < 0) do not count.
    const k = (r1 - r0) / (y1 - y0);
    const a = r0 + (oy - y0) * k;
    const b = dy * k;
    const A = dx * dx + dz * dz - b * b;
    const B = ox * dx + oz * dz - a * b;
    const C = ox * ox + oz * oz - a * a;
    const disc = B * B - A * C;
    if (disc < 0 || Math.abs(A) < 1e-12) continue;
    const q = Math.sqrt(disc);
    for (const t of [(-B - q) / A, (-B + q) / A]) {
      const y = oy + dy * t;
      if (y < y0 || y > y1 || a + b * t < 0) continue;
      take(t, () => {
        const x = ox + dx * t;
        const z = oz + dz * t;
        const r = Math.hypot(x, z);
        const n = Math.hypot(x, r * k, z);
        return [x / n, (-r * k) / n, z / n];
      });
    }
  }
  // The cap's top, a disc facing up.
  if (Math.abs(dy) > 1e-12) {
    const t = (1 - oy) / dy;
    if (Math.hypot(ox + dx * t, oz + dz * t) <= CAP_TOP) take(t, () => [0, 1, 0]);
  }
  return best;
}
