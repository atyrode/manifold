// The constants Marbling's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

export const marblePatterns = ["stone", "gel-git", "nonpareil", "bouquet", "chevron"] as const;

/**
 * How the ink is laid and moved. Ebru: a ground colour spread over the size, then colours flicked
 * from a brush into packed stones, which the pattern's stylus and combs then work. Suminagashi: two
 * brushes touched to the water in turn, one with ink and one with clear water, so every drop pushes
 * the last out into a ring; left uncombed (the stone pattern), breath and a fan turn the rings.
 */
export const marblePractices = ["ebru", "suminagashi"] as const;

export type MarblePractice = (typeof marblePractices)[number];

/** The `practice` knob, in order: the inks' own practice, then each practice by name. */
export const marblePracticeChoices = ["by inks", ...marblePractices] as const;

export interface MarblePalette {
  label: string;
  /** CSS colours the routines draw from. */
  inks: readonly string[];
  /** The ink painted in the lab's accent colour by the two-tone palette. */
  accent: string;
  /** The practice these inks belong to: what the `practice` knob's "by inks" follows. */
  practice: MarblePractice;
  /** Dark inks: floated on clear water over a pale tray (and the page goes light), not on dark size. */
  basin: boolean;
}

// Ebru's pigments, kept clear and saturated so the dither keeps them rich: deep indigo, ochre gold,
// madder rust, cream and lamp black.
export const EBRU: MarblePalette = {
  label: "ebru",
  inks: ["#1f3a96", "#dca12c", "#b5401f", "#f2e4c2", "#151419"],
  accent: "#1f3a96",
  practice: "ebru",
  basin: false,
};

// Sumi and indigo, each pushed out into a ring by a drop of clear water.
const SUMINAGASHI: MarblePalette = {
  label: "suminagashi",
  inks: ["#1d1c21", "#2c3a6e"],
  accent: "#2c3a6e",
  practice: "suminagashi",
  basin: true,
};

// Risograph spot inks: fluorescent pink, teal, sunflower, medium blue, midnight.
const RISO: MarblePalette = {
  label: "riso",
  inks: ["#ff5c98", "#00a29a", "#ffd03d", "#3e52d0", "#1e1b3b"],
  accent: "#3e52d0",
  practice: "ebru",
  basin: false,
};

/** In `palette` knob order. */
export const marblePalettes: readonly MarblePalette[] = [EBRU, SUMINAGASHI, RISO];

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads the exit's share).
 * Entrance: the first sheet's drops land and spread on a clean bath, then the combs go to work.
 * Exit: a sheet of paper is laid on the tray and lifted off, taking the ink and leaving a clean bath.
 */
export const MARBLE_PASSAGE: { enter: number; exit: number } = { enter: 3.2, exit: 1.6 };
