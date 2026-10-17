// The constants Mystic forest's definition (index.ts) shares with its code (build.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/**
 * The scene's passage (SceneDef.passage), one source for index.ts, the shader and the sim. Coming in,
 * the camera starts `back` m behind where it rests and dollies forward between the trunks over `settle`
 * s (arriving at speed and braking, a small overshoot, a settle), and the spirits pop up on their
 * perches one after another as it comes to rest; going out, the spirits turn their heads and vanish
 * one by one while the camera drifts `drift` m back into the mist, gathering speed.
 */
export const FOREST_PASSAGE = { enter: 3.2, exit: 1.6 } as const;
