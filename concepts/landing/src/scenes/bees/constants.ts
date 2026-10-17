// The constants the Bees scene's definition (index.ts) shares with its code (shader.ts, sim.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code). The
// definition also reads the garden's layout (layout.ts: the passage, where the lush plants start),
// which is plain data.

/** Trigger slots of the shooting stars' and the lightning's "now" buttons. */
export const BEES_METEOR_TRIGGER = 0;
export const BEES_LIGHTNING_TRIGGER = 1;
/** Trigger slot of the swarm's "now" button (swarm.ts). */
export const BEES_SWARM_TRIGGER = 2;
