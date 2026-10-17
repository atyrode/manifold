// The constants Fireflies's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** The "now" slot of the shared shooting stars (K_meteors): the breeze has 0 and the M 1. */
export const FIREFLIES_METEOR_TRIGGER = 2;

/** Seconds the scene's entrance and exit take (its `passage`). */
export const FIREFLIES_PASSAGE = { enter: 2.8, exit: 1.5 };
