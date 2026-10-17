// The constants Waterfall's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the waterfall's entrance (the camera tilts down the fall to the pool) and exit (it tilts back up into the spray); SceneDef.passage. */
export const FALLS_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/** Trigger slot of the shooting stars' "now" button. */
export const FALLS_METEOR_TRIGGER = 0;
