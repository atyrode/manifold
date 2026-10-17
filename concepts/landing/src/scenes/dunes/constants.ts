// The constants Dunes's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/**
 * Seconds of the dunes' entrance and exit (SceneDef.passage). Arriving, the camera glides in low
 * over the crests and settles while a veil of blown sand streams away downwind and clears; leaving,
 * the wind rises and a veil of sand streams in across the picture.
 */
export const DUNES_PASSAGE = { enter: 2.6, exit: 1.5 } as const;

/** Trigger slots of the shooting stars' and the lightning's "now" buttons. */
export const DUNES_METEOR_TRIGGER = 0;

export const DUNES_LIGHTNING_TRIGGER = 1;
