// The constants Lava lamp's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds the entrance and the exit take (SceneDef.passage). Both play in the simulation: the
 * shader draws whatever the wax does. */
export const LAVA_PASSAGE = { enter: 3, exit: 1.8 } as const;
