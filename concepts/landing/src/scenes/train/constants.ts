// The constants Night train's definition (index.ts, layers.ts) shares with its code (sim.ts,
// shader.ts), kept apart from that code so that the scene registry loads without it
// (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/** Seconds the scene's entrance and exit take (SceneDef.passage; shader.ts reads the same): out of a tunnel, into a tunnel. */
export const TRAIN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The `line` choice, in the order the shader reads K_line: the country line as it always ran, a rural branch line, a mountain line. */
export const TRAIN_LINES = [
  { label: "country", value: 0 },
  { label: "rural", value: 1 },
  { label: "mountain", value: 2 },
] as const;

/**
 * The room's rig (README "The interior composer"): the table under the window is the ledge, its back
 * edge (0.26 screen heights under the frame's middle) the seat line, 0.7 m ahead of an eye 0.265 m
 * over its top, the horizon at uv 0.55 (shader.ts TRAIN_HORIZON) and the view's focal 0.82 (sim.ts
 * TRAIN_FOCAL): 1.17 screen heights a metre there. The compartment is drawn in screen space and the
 * country through the view's own pinhole, so the train's layers are locked to this rig.
 */
export const TRAIN_RIG: Rig = {
  horizon: 0.55,
  focal: 0.82,
  eye: 0.265,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: no wall of its own shows (the compartment covers it), no lamp out of frame and no light
 * all round of its own (the reading lamp is the compartment's own).
 */
export const TRAIN_ROOM: Room = {
  distance: 0.7,
  wall: [0.03, 0.02, 0.013],
  ambient: [0, 0, 0],
};

/** The train's layers are drawn on its frame and through its view's pinhole, by this rig alone. */
export const BY_THE_WINDOW = {
  eye: [TRAIN_RIG.eye, TRAIN_RIG.eye],
  horizon: [TRAIN_RIG.horizon, TRAIN_RIG.horizon],
  focal: [TRAIN_RIG.focal, TRAIN_RIG.focal],
} as const;
