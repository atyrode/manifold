// Grains of one size, for simulations of sand: sand thrown about on a singing plate, heaped and
// slumping on a table, raked into gravel, blown into dunes. Three materials span a grain-size knob
// (material.ts conventions): fine sand, the dry sand every scene was tuned on (the reference, at the
// knob's middle) and grit; `grainAt` gives the grain at any point between them.
//
// Properties (the mobility ones relative to dry sand, so a model built on sand keeps its constants
// and multiplies them):
//   diameter  typical grain, mm
//   talus     tangent of the angle of repose, how steep a dry heap of it stands (dry sand 0.62,
//             about 32°; fine sand 30°; grit 38°)
//   grip      how hard a shaken surface must swing before a grain moves, × sand's: fine grains are
//             set going by less and settle closer to where the surface stands still
//   spread    how that grip varies within one batch: a grain's grip is grip·r^spread for a uniform
//             draw r, so a larger spread keeps most grains near zero (a tight core of sand) with a
//             sparse few clinging further out (a halo of loose grains)
//   hop       how far each throw carries a grain (its bounce and scatter), × sand's
//   pace      how fast grains travel across a shaken surface, × sand's: air holds the fine ones back
//
// Usage:
//   const grain = grainAt(knobs.value(frame, "grainSize"));   // 0 fine sand, 0.5 dry sand, 1 grit
//   const threshold = THRESHOLD_MAX * grain.grip * Math.pow(draw, grain.spread);
//   heights.relax(dt, grain.talus, SLUMP_RATE);                // a heap stands at its own repose
//
// Adopters to come: the sand table, the raked garden, the delta and the dunes each fix one talus
// today (sandtable 0.62 is SAND's); reading it from grainAt would give them the same knob.
import { materialAt } from "./material.ts";

export interface Grain {
  diameter: number;
  talus: number;
  grip: number;
  spread: number;
  hop: number;
  pace: number;
}

/** Fine dry sand, about 0.1 mm: thin, crisp lines, slow to gather. */
export const FINE_SAND: Readonly<Grain> = { diameter: 0.1, talus: 0.58, grip: 0.55, spread: 4, hop: 0.55, pace: 0.75 };
/** Dry sand, about 0.3 mm: the reference every scene's constants were tuned on. */
export const SAND: Readonly<Grain> = { diameter: 0.3, talus: 0.62, grip: 1, spread: 3, hop: 1, pace: 1 };
/** Grit, about 2 mm: broad, rough bands, grains thrown far and quick to arrive. */
export const GRIT: Readonly<Grain> = { diameter: 2, talus: 0.78, grip: 1.7, spread: 2, hop: 1.8, pace: 1.3 };

/** The grain `size` of the way from fine sand (0) through dry sand (0.5, exactly SAND) to grit (1). */
export function grainAt(size: number, out?: Grain): Grain {
  return materialAt(size, FINE_SAND, SAND, GRIT, out);
}
