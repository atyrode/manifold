// The constants Delta's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds the entrance and the exit take (SceneDef.passage). */
export const DELTA_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };
