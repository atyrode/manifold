// The constants Shore's definition (index.ts) shares with its code (shader.ts, sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** Trigger slots of the lightning's and the shooting stars' "now" buttons (after the fish's, 0). */
export const SHORE_LIGHTNING_TRIGGER = 1;

export const SHORE_METEOR_TRIGGER = 2;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Both are played by the shader alone
 * (shader.ts: the surf runs in from out at sea on a decelerating curve under a camera that settles,
 * and is drawn back out to sea on the way out), so this sim has nothing to do for them.
 */
export const SHORE_PASSAGE = { enter: 3, exit: 1.7 } as const;
