// The constants Kelp forest's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

export const kelpSpecies = ["giant", "bull", "mixed"] as const;

/** Seconds of the scene's entrance and exit (SceneDef.passage). */
export const KELP_PASSAGE = { enter: 3, exit: 1.8 } as const;
