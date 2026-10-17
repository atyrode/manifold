// What the Bees preset and its layer manifests (index.ts, layers.ts) share with its GLSL and sim
// (shader.ts, sim.ts), without loading them: the rig the garden is painted through and the light it
// is graded by. The garden's layout (layout.ts: the stage, the hives, the drifts) is plain data too.
import type { Grade, Rig } from "../../composer/types.ts";
import { BEES_CAM, BEES_STAGE_MIN, BEES_YH } from "./layout.ts";

/**
 * The garden's rig: the eye BEES_CAM metres up, the horizon at BEES_YH, a focal length of one screen
 * height, turned 0.3 rad left of the sky's frame so the afternoon sun stands upper left. The stage is
 * laid out at least BEES_STAGE_MIN half widths wide (minAspect) and spreads across a wider frame.
 */
export const BEES_RIG: Rig = {
  horizon: BEES_YH,
  focal: 1,
  eye: BEES_CAM,
  turn: 0.3,
  pitch: 0,
  minAspect: 2 * BEES_STAGE_MIN,
};

/**
 * The valley's warm light: the sun's and the sky's tints and the sky's floor, the moon as the key at
 * half its colour once the sun has set (so moonlight reads on the land and the orchard throws its
 * shadows by it); a soft darkening toward the corners, the picture lifted by a tenth.
 */
export const BEES_GRADE: Grade = {
  sunTint: [1.15, 1.05, 0.88],
  skyTint: [1.05, 0.98, 0.88],
  floor: [0.04, 0.04, 0.04],
  moonlight: 0.5,
  exposure: 1.1,
  vignette: 0.22,
  ink: { gain: 1.25, gamma: 1 },
};
