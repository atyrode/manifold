// The constants Tiny island's definition (index.ts) shares with its code (shader.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the island's entrance (the camera swoops down, the gull glides in) and exit (the camera lifts away) (SceneDef.passage). */
export const ISLAND_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
