// The constants Frost's definition (index.ts) shares with its code (shader.ts, sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** Trigger slot of the shooting stars' "now" button (slot 0 is the traced M's). */
export const FROST_METEOR_TRIGGER = 1;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the glass opens clear
 * and the frost grows in from the frame (the growth clock is run up from FROST_EMERGE_FROM to the
 * opening state, FROST_START, in these seconds, quickly at first and settling). Exit: a warm breath
 * clears a small patch that spreads over the whole pane.
 */
export const FROST_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.6 };
