// The constants Above the clouds's definition (index.ts) shares with its code (shader.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the climb out of the deck and of the sinking back in (SceneDef.passage). */
export const CLOUDS_PASSAGE = { enter: 3.0, exit: 1.5 } as const;
