// The constants the lava lamp's definition (index.ts, layers.ts) shares with its code (sim.ts,
// shader.ts), kept apart from that code so that the scene registry loads without it (SceneDef.code).
import { PAINTED } from "../../composer/camera.ts";
import type { CameraRange, LightElement, Rig, Room } from "../../composer/types.ts";

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

/**
 * The room: dark, papered, the back wall 1.55 m ahead where the sideboard's top meets it (frame
 * uv 0.2), the top's front edge 1.2 m ahead (uv 0.088); no lamp of its own but the lava lamp; turned
 * so that the World's full moon at midnight comes in through the window off to the left and lies on
 * the wall as a pale pane.
 */
export const LAVA_ROOM: Room = {
  distance: 1.28,
  back: 1.55,
  facing: -2.26,
  wall: [0.5, 0.44, 0.4],
  material: "papered",
  ambient: [0.008, 0.009, 0.014],
  ledge: { kind: "sideboard", front: 1.2, half: 3, thick: 0.02, albedo: [0.42, 0.23, 0.12] },
};

/**
 * The window off to the left, beside the eye: the moon's way in, a mullion and a transom across it,
 * placed so that the World's full moon at midnight lays its pane on the wall left of the sleeve,
 * where the room's own pane always lay (its centre about 0.23 m left of the middle, 0.25 m up).
 */
export const LAVA_WINDOW: LightElement = {
  kind: "window",
  at: [-1.1, 0.86, 0.84],
  colour: [0.85, 0.95, 1.2],
  power: 0.55,
  reach: 1,
  flicker: 0,
  shadow: true,
  window: { wall: "left", size: [0.24, 0.3], bars: [2, 2] },
};

/**
 * The lamp's room's own layers are drawn on its frame, through this rig alone; a live camera moves
 * them only within the painted tolerance (composer/camera.ts).
 */
export const ON_THE_SIDEBOARD: CameraRange = {
  eye: [LAVA_RIG.eye, LAVA_RIG.eye],
  horizon: [LAVA_RIG.horizon, LAVA_RIG.horizon],
  focal: [LAVA_RIG.focal, LAVA_RIG.focal],
  tolerance: PAINTED,
};
