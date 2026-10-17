// The constants Tide pool's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the scene's entrance and exit (SceneDef.passage). */
export const TIDEPOOL_PASSAGE = { enter: 3, exit: 1.6 } as const;
