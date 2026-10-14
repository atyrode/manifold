// Material controls: one knob that moves a simulated substance between named materials (fine sand
// to grit, silky to chunky wax), changing the physics the sim steps and so the form the shader draws,
// never a look alone. The conventions every such knob keeps:
//   - It is a 0..1 `range` in the group of the thing it is about, labelled for the property (grain
//     size, wax body), and its help names both ends in plain words.
//   - Its default, 0.5, is the reference material the scene was tuned on, reproduced bit for bit:
//     at 0.5 `materialAt` returns every property exactly as the reference gives it.
//   - The ends are real materials, described in a table of physical properties beside the model,
//     and each property moves geometrically between them (equal knob steps are equal ratios).
//   - Changing it re-reads the model's constants; it does not reset the scene's arrangement.
// Controls whose reference sits at one end (edge absorption: full; a vent: off) keep the same rules
// with a mapping of their own: the default is the reference, bit for bit, and the help names the ends.
//
// Usage:
//   const SILKY = { cohesion: 0.7, stretch: 1.6 };
//   const CLASSIC = { cohesion: 1, stretch: 1 };
//   const CHUNKY = { cohesion: 1.5, stretch: 0.5 };
//   const wax = materialAt(knob, SILKY, CLASSIC, CHUNKY);   // knob 0.5: exactly CLASSIC's numbers
//   const pull = COHESION * wax.cohesion;

/** A property table with a value that is not a positive finite number (geometric steps need one). */
export class MaterialError extends Error {}

/**
 * The material `t` of the way from `low` (t = 0) through `mid` (t = 0.5, exactly its values) to
 * `high` (t = 1), each property geometric between its neighbours; t is clamped to 0..1. Writes into
 * `out` when given (a sim reading it every frame), else into a new object.
 */
export function materialAt<K extends string>(
  t: number,
  low: Readonly<Record<K, number>>,
  mid: Readonly<Record<K, number>>,
  high: Readonly<Record<K, number>>,
  out?: Record<K, number>,
): Record<K, number> {
  const s = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  const toward = s < 0.5 ? low : high;
  const share = Math.abs(s - 0.5) * 2;
  const result = out ?? ({} as Record<K, number>);
  for (const key of Object.keys(mid) as K[]) {
    const m = mid[key];
    const end = toward[key];
    if (!(m > 0 && end > 0 && Number.isFinite(m) && Number.isFinite(end))) {
      throw new MaterialError(`material: '${key}' must be a positive finite number in every table`);
    }
    // share 0 gives m · 1 exactly: the reference material is never recomputed.
    result[key] = m * Math.pow(end / m, share);
  }
  return result;
}
