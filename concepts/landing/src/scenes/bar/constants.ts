// The constants Late bar's definition (index.ts, layers.ts) shares with its code (sim.ts,
// shader.ts), kept apart from that code so that the scene registry loads without it
// (SceneDef.code).
import { PAINTED } from "../../composer/camera.ts";
import type { CameraRange, Rig, Room } from "../../composer/types.ts";

/** Seconds the scene's entrance and exit take (SceneDef.passage), shared with the shader. */
export const PASSAGE = { enter: 2.8, exit: 1.7 } as const;

/**
 * The room's rig (README "The interior composer"): the booth's table is the ledge, its far edge the
 * seat line, 1 m ahead of an eye 0.33 m over its top (the table's own eye, sim.ts TABLE_EYE 1.09 m
 * over the floor, over the 0.76 m table), the horizon at uv 0.53 (sim.ts HORIZON) and the bar's
 * focal 0.85 (FOCAL): the seat line at -0.25 screen heights, 0.85 screen heights a metre. The bar's
 * layers are drawn through the bar's own pinhole (shader.ts), so they are locked to this rig.
 */
export const BAR_RIG: Rig = {
  horizon: 0.53,
  focal: 0.85,
  eye: 0.33,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: no wall of its own shows (the storefront draws the whole shell), no lamp out of frame
 * and no light all round of its own (the bar's lamps are its own); a guest's light reaches nothing of
 * the bar's (its surfaces keep their own light).
 */
export const BAR_ROOM: Room = {
  distance: 1,
  // Its own shell layers cover the composer's wall; it lets no World in through a window element.
  back: 1,
  facing: 0,
  material: "plaster",
  wall: [0.02, 0.016, 0.014],
  ambient: [0, 0, 0],
};

/**
 * The bar's layers are drawn through the bar's own camera, by this rig alone; a live camera moves
 * them only within the painted tolerance (composer/camera.ts).
 */
export const IN_THE_BOOTH: CameraRange = {
  eye: [BAR_RIG.eye, BAR_RIG.eye],
  horizon: [BAR_RIG.horizon, BAR_RIG.horizon],
  focal: [BAR_RIG.focal, BAR_RIG.focal],
  tolerance: PAINTED,
};
