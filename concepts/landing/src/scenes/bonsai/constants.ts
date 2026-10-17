// The constants Bonsai's definition (index.ts) shares with its code (sim.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

// ---- passage ----
/** Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the stand glides in from the right along the veranda and comes to rest, the pads leaning on its slowing and springing back; exit: the stand is pushed off to the right, the pads lagging, a gust and a few leaves left behind in the air. */
export const BONSAI_PASSAGE = { enter: 2.6, exit: 1.5 } as const;
