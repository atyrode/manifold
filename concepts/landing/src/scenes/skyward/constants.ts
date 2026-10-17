// The constants Skyward's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the entrance (the view tips back from street level to the zenith) and the exit (it tips down toward the street again) (SceneDef.passage). */
export const SKYWARD_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** Trigger slot of the shooting stars' "now" button. */
export const SKYWARD_METEOR_TRIGGER = 0;
