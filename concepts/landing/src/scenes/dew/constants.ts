// The constants Dew's definition (index.ts) shares with its code (sim.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

/** Seconds the scene's entrance and exit take (SceneDef.passage); the shader reads the same. */
export const DEW_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
