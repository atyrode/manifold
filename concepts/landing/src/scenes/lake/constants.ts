// The constants Frozen lake's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** Trigger slot of the shooting stars' "now" button (0 substorms, 1 singing ice, 2 the M). */
export const LAKE_METEOR_TRIGGER = 3;

/** Trigger slot of the drapes' corona's "now" button. */
export const LAKE_CORONA_TRIGGER = 4;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads both). Entrance:
 * the camera tilts down from the aurora onto the ice, and a crack sings across it. Exit: a gust of
 * snow streams across the ice while the camera tilts back up to the sky.
 */
export const LAKE_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };
