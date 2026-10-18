// The constants Bonsai's definition (index.ts, layers.ts) shares with its code (sim.ts, shader.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

// ---- passage ----
/** Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the stand glides in from the right along the veranda and comes to rest, the pads leaning on its slowing and springing back; exit: the stand is pushed off to the right, the pads lagging, a gust and a few leaves left behind in the air. */
export const BONSAI_PASSAGE = { enter: 2.6, exit: 1.5 } as const;

/**
 * The room's rig (README "The interior composer"): a level eye 0.167 m over the stand's top and
 * 1.19 m from where the pot stands, so the stand's top lies on the seat line at uv 0.217 (display
 * rim 0.3 less the stand's 0.083 on a wide frame), 1.175 screen heights a metre (the 47 cm pot 0.47
 * of a display unit), and the eye's height over its distance is the display's tilt (0.14): we look
 * down a little on the stand and the moss. The bonsai's layers are drawn on its display, laid out on
 * the frame (geometry.ts bonsaiPlacement), so they are locked to this rig.
 */
export const BONSAI_RIG: Rig = {
  horizon: 0.4133,
  focal: 1.4,
  eye: 0.1667,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: no wall of its own shows (the veranda covers it), no lamp out of frame (the paper lamp
 * is the veranda's), the light all round the veranda's too.
 */
export const BONSAI_ROOM: Room = {
  distance: 1.4 / 1.175,
  wall: [0.5, 0.41, 0.31],
  ambient: [0, 0, 0],
};

/** The bonsai's layers are drawn on its display, through this rig alone. */
export const ON_THE_VERANDA = {
  eye: [BONSAI_RIG.eye, BONSAI_RIG.eye],
  horizon: [BONSAI_RIG.horizon, BONSAI_RIG.horizon],
  focal: [BONSAI_RIG.focal, BONSAI_RIG.focal],
} as const;
