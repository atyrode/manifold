// The constants Lantern river's definition (index.ts) shares with its code (shader.ts, sim.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).

/** Trigger slot of the shooting stars' "now" button (0 is the flotillas', 1 the M lantern's). */
export const LANTERNS_METEOR_TRIGGER = 2;

/** The lantern counts on offer (the `lanterns` knob). */
export const LANTERN_COUNTS = [6, 12, 18, 24, 30] as const;

/** Seconds the entrance and the exit take (the scene's `passage`). */
export const PASSAGE_ENTER = 4.5;

export const PASSAGE_EXIT = 2.2;
