// TS → GLSL literal emitters, for constants a scene's shader shares with its sim or a palette table.
//
//   glslFloat(x)                       a float literal that reads back as x: the shortest decimal that
//                                      round-trips, ".0" added to whole numbers, exponent form where
//                                      JS uses it (5e-7, 1e+21). Never cut to a fixed number of places
//                                      (`toFixed(4)` turns anything below 5e-5 into 0.0).
//   glslVec3("#rrggbb")                a CSS hex colour as a vec3 of display-sRGB channels 0..1 (the
//                                      pipeline works in display sRGB, as the canvas does)
//   glslVec3([r, g, b])                three numbers as a vec3 of glslFloat literals
//   glslPick(knob, cases, fallback?)   a choice knob's table: `if (K_<knob> < i.5) return <case i>;`
//                                      per case, then `return <fallback>;` when given
//
// Usage (a palette knob whose choices are 0, 1, 2, ...):
//   const inks = palettes.map((palette) => glslVec3(palette.ink));
//   export const sceneGlsl = `
//   const float SCENE_EDGE = ${glslFloat(SCENE_EDGE)};
//   vec3 sceneInk() {
//   ${glslPick("palette", inks, "vec3(0.0)")}
//   }
//   `;

/** A number or colour with no GLSL literal (non-finite, out of float range, not "#rrggbb"). */
export class GlslError extends Error {}

/** Largest finite float32: beyond it a highp float overflows. */
const FLOAT_MAX = 3.4028234663852886e38;
/** Smallest normal float32: below it a GPU may flush the constant to 0. */
const FLOAT_MIN = 1.1754943508222875e-38;

/** A GLSL float literal that reads back as `x` (see the header). Throws GlslError for 0 < |x| < 2^-126, |x| > float max, NaN. */
export function glslFloat(x: number): string {
  const size = Math.abs(x);
  if (!(size <= FLOAT_MAX) || (size > 0 && size < FLOAT_MIN))
    throw new GlslError(`glslFloat: ${x} has no exact highp float literal`);
  if (Object.is(x, -0)) return "-0.0";
  const text = String(x);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/**
 * A vec3 literal. A "#rrggbb" colour writes each 8-bit channel c as (c / 255).toFixed(4): four places
 * keep all 256 levels apart (round(v * 255) gives c back) and match the literals scenes already emit.
 * A tuple writes each number with glslFloat.
 */
export function glslVec3(colour: string | readonly [number, number, number]): string {
  if (typeof colour !== "string")
    return `vec3(${glslFloat(colour[0])}, ${glslFloat(colour[1])}, ${glslFloat(colour[2])})`;
  if (!/^#[0-9a-f]{6}$/i.test(colour))
    throw new GlslError(`glslVec3: '${colour}' is not a #rrggbb colour`);
  const value = Number.parseInt(colour.slice(1), 16);
  const channel = (c: number): string => (c / 255).toFixed(4);
  return `vec3(${channel((value >> 16) & 255)}, ${channel((value >> 8) & 255)}, ${channel(value & 255)})`;
}

/**
 * The body of a function returning a choice knob's entry: `  if (K_<knob> < i.5) return <cases[i]>;`
 * per case, one per line, then `  return <fallback>;` when given. Case i stands for the choice value
 * i, so the knob's values must run 0, 1, 2, ... in the order of `cases`.
 */
export function glslPick(knob: string, cases: readonly string[], fallback?: string): string {
  const lines = cases.map((value, i) => `  if (K_${knob} < ${i}.5) return ${value};`);
  if (fallback !== undefined) lines.push(`  return ${fallback};`);
  return lines.join("\n");
}
