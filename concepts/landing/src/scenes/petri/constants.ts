// The constants Petri dish's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).
import { grayScottRegimes } from "../../sims/grayscott.ts";

export const petriChemistries = ["Turing", "BZ"] as const;

export const petriPalettes = ["stain", "ink", "UV"] as const;

/** The `regime` knob, in order: wandering along the loop, then each of grayScottRegimes. */
export const petriRegimes = ["wander", ...grayScottRegimes.map((regime) => regime.label)] as const;

/** The Advanced feed and kill knobs are in thousandths (37 = 0.037). */
export const PETRI_FEED_KILL_UNIT = 1000;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads them all).
 * Entrance: the dish slides in from the right across the bench, under the lamp, and settles with a
 * touch of overshoot (`slide`); once it is nearly home the pattern spreads from a seed point over
 * the dish (`spreadStart` seconds in, over `spread` seconds of the sim's own clock, which starts
 * after the prewarm). Exit: the dish slides off to the left, gathering speed.
 */
export const PETRI_PASSAGE = {
  enter: 2.8,
  exit: 1.4,
  slide: 1.5,
  spreadStart: 0.6,
  spread: 1.8,
} as const;
