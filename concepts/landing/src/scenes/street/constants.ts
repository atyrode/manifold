// The constants City crossing's definition (index.ts) shares with its code (sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds the entrance and the exit take (SceneDef.passage). The shader eases the same tilt from
 *  passageIn() and passageOut() with the constants below: keep passageTilt and its GLSL twin in step. */
export const STREET_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
