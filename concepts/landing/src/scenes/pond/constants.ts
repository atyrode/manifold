// The constants Pond's definition (index.ts) shares with its code (shader.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the pond's entrance and exit (SceneDef.passage). */
export const POND_PASSAGE = { enter: 3.2, exit: 1.8 } as const;
