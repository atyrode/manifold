// The constants Meadow's definition (index.ts) shares with its code (shader.ts, sim.ts,
// wildflowers.ts), kept apart from that code so that the scene registry loads without it
// (SceneDef.code).

/** Seconds the entrance and the exit take (SceneDef.passage; the shader reads them too). */
export const MEADOW_PASSAGE = { enter: 3, exit: 1.6 } as const;

/** Trigger slots: a big gust now, and the mown M caught by the light. */
export const GUST_TRIGGER = 0;
export const MARK_TRIGGER = 1;
/** Trigger slots of the shooting stars' and the lightning's "now" buttons (after the gusts' and the mown M's). */
export const MEADOW_METEOR_TRIGGER = 2;
export const MEADOW_LIGHTNING_TRIGGER = 3;

/** The most dandelion clocks the field holds (the `dandelions` knob's top count). */
export const MAX_CLOCKS = 5;
