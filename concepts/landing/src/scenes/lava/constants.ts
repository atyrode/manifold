// The constants the lava lamp's definition (index.ts, layers.ts) shares with its code (sim.ts,
// shader.ts), kept apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/** Seconds the entrance and the exit take (SceneDef.passage). Both play in the simulation: the
 * shader draws whatever the wax does. */
export const LAVA_PASSAGE = { enter: 3, exit: 1.8 } as const;

/**
 * The room's rig (README "The interior composer"): a level eye 0.248 m over the sideboard's top and
 * 1.28 m from where the lamp stands (0.62 and 3.2 lamp heights of 0.4 m), so the lamp's foot stands
 * at uv 0.118 and the lamp 0.76 screen heights tall: we look down a little on the base and the
 * sideboard and up a little at the cap.
 */
export const LAVA_RIG: Rig = {
  horizon: 0.5892,
  focal: 2.432,
  eye: 0.248,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/** The room: dark, papered, no lamp of its own but the lava lamp, a little moonlight about. */
export const LAVA_ROOM: Room = {
  distance: 1.28,
  wall: [0.46, 0.405, 0.37],
  ambient: [0.008, 0.009, 0.014],
};

/** The lamp's room's own layers are drawn on its frame, through this rig alone. */
export const ON_THE_SIDEBOARD = {
  eye: [LAVA_RIG.eye, LAVA_RIG.eye],
  horizon: [LAVA_RIG.horizon, LAVA_RIG.horizon],
  focal: [LAVA_RIG.focal, LAVA_RIG.focal],
} as const;
