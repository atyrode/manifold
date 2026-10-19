// The constants Prism's definition (index.ts) shares with its code (sim.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the scene's entrance and exit (SceneDef.passage). */
export const PRISM_PASSAGE = { enter: 2.8, exit: 1.6 } as const;
