// The constants Orbit's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the orbit's entrance and exit (SceneDef.passage). */
export const ORBIT_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
