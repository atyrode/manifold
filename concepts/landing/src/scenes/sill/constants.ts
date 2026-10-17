// The constants Sill's definition (index.ts) shares with its code (shader.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

/**
 * Seconds the entrance and the exit take (SceneDef.passage; the shader reads the same). In: the cat
 * hops up onto the sill and settles, its tail curling round. Out: it stretches and hops down out of
 * frame. At rest the cat is exactly as it always was.
 */
export const SILL_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Trigger slot of the shooting stars' "now" button (0 is the cat's, 1 lightning's, 2 the neon's). */
export const SILL_METEOR_TRIGGER = 3;

/** Trigger slot of the lightning's "now" button. */
export const SILL_LIGHTNING_TRIGGER = 1;
