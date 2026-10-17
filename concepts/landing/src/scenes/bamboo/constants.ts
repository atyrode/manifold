// The constants Bamboo grove's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads the same). The
 * entrance: the culms sway in from the frame edges while the spout starts to run and the tube fills.
 * The exit: the tube is filled to the brim, tips and clacks, and a gust sways the grove.
 */
export const BAMBOO_PASSAGE = { enter: 2.8, exit: 1.7 } as const;
