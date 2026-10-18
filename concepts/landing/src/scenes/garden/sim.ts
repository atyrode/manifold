// What the Stone garden's layer sims (gravel.ts, raking.ts, boughs.ts, planting.ts) and its GLSL
// (shader.ts) share: the parts' sizes and records, the views a screen point is taken through, and
// the gusts the plants and the leaves feel.
//
// Units: garden space (constants.ts GARDEN), garden depths; the composer's gust field is in metres
// of the rig's frame (x right of the view's centre line, z away from the eye: GARDEN_METRES a
// garden depth). The gusts are the composer's one field (ADR 0062 D4): each part takes its load
// where it stands (`fieldPush`), its 'now' included; the exit's gust is the garden's own
// (`exitFront`, the passage's), a front setting out from the garden's upwind end and crossing it.
import { GUST, gustAt, type GustField, type GustWind } from "../../composer/gust.ts";
import { clamp } from "../../sims/math.ts";
import { gustPulse } from "../../sims/wind.ts";
import { GA, OX } from "./build.ts";
import { GARDEN, GARDEN_METRES } from "./constants.ts";

/** Moss: a low cushion out to clear × (base + grow × moss knob). */
export const GARDEN_MOSS = { height: 0.009, base: 0.25, grow: 0.7 } as const;

/**
 * The maple's foliage, as clumps (x, y, z, radius) in garden space: a tree standing beyond the wall
 * at the far left, one limb reaching over the wall toward the middle, another higher over the
 * garden (out of the veranda's frame, in view from above).
 */
export const GARDEN_CANOPY: readonly (readonly [number, number, number, number])[] = [
  [0.05, 1.1, 0.27, 0.1],
  [0.3, 1.04, 0.21, 0.085],
  [0.52, 1.0, 0.17, 0.07],
  [0.66, 0.93, 0.225, 0.075],
  [0.88, 0.86, 0.245, 0.07],
  [1.08, 0.8, 0.262, 0.06],
  [0.2, 0.9, 0.3, 0.09],
  [0.45, 0.82, 0.29, 0.08],
  [0.72, 0.74, 0.31, 0.07],
  [0.38, 1.14, 0.15, 0.08],
];

/**
 * The woods over the wall, as the shader draws them (x in screen heights from the frame's left edge,
 * y in uv height): two rows of rounded crowns, crown k of a row spanning [k, k + 1) of the phase
 * x · rate + wobble · noise (the shader's, 0..1), the far row 6 to a screen height, the near row 9.
 * Each crown is a tree: one stem from `foot`, where its trunk stands behind the wall, `length` up to
 * the row's crown tops. The far row's crown k is record k, the near row's `crowns` + k; crowns past
 * `crowns` (a frame over 4.4 screen heights wide) stand still.
 */
export const GARDEN_WOODS = {
  crowns: 40,
  far: { rate: 6, wobble: 0.4, foot: 0.875, length: 0.113 },
  near: { rate: 9, wobble: 0.5, foot: 0.815, length: 0.137 },
} as const;

/**
 * The border planting along the wall's foot: in some of the gutter's `bins` bins, `pitch` garden
 * depths along X each, a clump of fern or mondo grass, standing in the plane Y = `y` between the
 * gravel's curb and the wall, at most `reach` tall. Plant frame: garden X, height above the gutter.
 * Bin b's organs are records `organs` · b + 0..organs - 1.
 */
export const GARDEN_BORDER = {
  pitch: 0.1,
  bins: 24,
  organs: 7,
  y: 1.015,
  reach: 0.07,
} as const;

/** The border's species, as its records' form: the shader draws a fern's fronds with plantFrond, mondo grass's blades with plantArc. */
export const GARDEN_BORDER_FORM = { fern: 0, mondo: 1 } as const;

/**
 * Islands and stones per island the gravel's row holds (the shader's loops and struct match): island
 * i at texel i, the drying clock at texel GARDEN_ISLANDS, stone j of island i at texels
 * GARDEN_STONE_TEXEL + 2 (GARDEN_STONES i + j) and the next.
 */
export const GARDEN_ISLANDS = 4;
export const GARDEN_STONES = 3;
export const GARDEN_STONE_TEXEL = 8;
/** Leaves the boughs' row holds, four texels each. */
export const GARDEN_LEAF_SLOTS = 24;

/** Leaf kinds, as packed for the shader. */
export const GARDEN_LEAF_KIND = { maple: 0, petal: 1, green: 2, withered: 3 } as const;

/** Seconds the exit's gust (sims/wind.ts gustPulse) takes to rise to its peak: the leaves', the plants' and the maple's sway in the shader. */
export const GARDEN_GUST_RISE = 1.0;
/**
 * Where the maple's canopy feels the composer's gust field (metres, rig frame: the clumps' middle,
 * over the wall left of the centre line), and the share of the field's load the garden's parts take
 * as their gust (its 'now' peaks a little over 1).
 */
export const GARDEN_MAPLE_AT = [-6.8, 12.6] as const;
export const GARDEN_GUST_GAIN = 0.8;

/** How fast the exit gust's front crosses the garden from its upwind end (garden depths per second), and its push at its peak (push units). */
const GUST_FRONT = 1.6;
const GUST_PUSH = 1.0;

/** Garden X and Y as metres in the rig's frame: across the view's centre line, and away from the eye. */
export const metresAcross = (x: number): number => (x - OX) * GARDEN_METRES;
export const metresAhead = (y: number): number => (y - GARDEN.eyeY) * GARDEN_METRES;

/** The composer's gust field's push at (x, z) metres, the way it blows, as the garden's parts take it. */
export function fieldPush(wind: GustWind, x: number, z: number, time: number): number {
  return (wind.dirX < 0 ? -1 : 1) * GARDEN_GUST_GAIN * gustAt(wind, x, z, time, 0);
}

/**
 * The exit's gust at garden X `x` (`sign` the way it blows, sims/wind.ts windSign): a front setting
 * out from the garden's upwind end as the exit begins and crossing it at GUST_FRONT, rising over the
 * whole exit, so the plants bow one after another, reaching what stands beyond either end with that
 * end; GUST_PUSH at its peak, 0 outside the exit.
 */
export function exitFront(exit: number, sign: number, x: number): number {
  if (!(exit > 0)) return 0;
  const from = clamp(sign > 0 ? x : GA - x, 0, GA);
  return (
    sign * GUST_PUSH * gustPulse(exit * GARDEN_GUST_RISE - from / GUST_FRONT, GARDEN_GUST_RISE)
  );
}

/** Whether any gust is about: the field's gusts on, its 'now' still blowing, or the exit's. */
export function gustAbout(gusts: GustField, exit: number): boolean {
  return gusts.gusts > 0 || (gusts.nowAge >= 0 && gusts.nowAge < GUST.nowLife) || exit > 0;
}

/**
 * The view a screen point is taken through and a garden point seen in: from the veranda, or from
 * above (the gravel's camera), in a frame of `aspect`. The gravel's sim keeps the garden's (its
 * camera knob); a layer without the gravel takes the veranda's.
 */
export class GardenView {
  aspect = 16 / 9;
  overhead = false;

  /** The garden point under screen uv (u, v) into `out` (x, y); false off the gravel. */
  groundUnder(u: number, v: number, out: Float64Array): boolean {
    let x: number;
    let y: number;
    if (this.overhead) {
      x = OX + (u - 0.5) * this.aspect * GARDEN.span;
      y = GARDEN.overheadY + (v - 0.5) * GARDEN.span;
    } else {
      const down = GARDEN.horizon - v;
      if (down <= 1e-3) return false;
      const s = GARDEN.eyeHeight / down;
      x = OX + (u - 0.5) * this.aspect * s;
      y = GARDEN.eyeY + GARDEN.focal * s;
    }
    if (y < GARDEN.drip + 0.01 || y > 1.0 || x < 0 || x > GA) return false;
    out[0] = x;
    out[1] = y;
    return true;
  }

  /** Screen uv of garden point (x, y, z) in this view, or undefined behind the camera. */
  project(x: number, y: number, z: number): { u: number; v: number } | undefined {
    if (this.overhead) {
      const s = GARDEN.overheadHeight / Math.max(GARDEN.overheadHeight - z, 1e-3);
      return {
        u: 0.5 + ((x - OX) * s) / GARDEN.span / this.aspect,
        v: 0.5 + ((y - GARDEN.overheadY) * s) / GARDEN.span,
      };
    }
    const depth = y - GARDEN.eyeY;
    if (depth <= 0.02) return undefined;
    return {
      u: 0.5 + (GARDEN.focal * (x - OX)) / depth / this.aspect,
      v: GARDEN.horizon + (GARDEN.focal * (z - GARDEN.eyeHeight)) / depth,
    };
  }
}
