// The constants Autumn park's definition (index.ts) shares with its code (layout.ts, shader.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds the entrance and the exit take (SceneDef.passage). */
export const AUTUMN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** Trigger slot of the shooting stars' "now" button (0 is the gusts', 1 the leaf M's). */
export const AUTUMN_METEOR_TRIGGER = 2;
