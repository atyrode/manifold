// What the Campfire preset and its layer manifests (index.ts, layers.ts) share with their GLSL and
// sim (shader.ts, sim.ts), without loading them: the low seat's rig, the light guest layers are
// graded by, where the fire and the camp stand (m), the depths the campfire's parts are composed at,
// and the fuel's row of the records atlas.
import type { Grade, Rig } from "../../composer/types.ts";

/** Screen height (uv) of the far horizon, which the pines hide. */
export const CAMPFIRE_HORIZON = 0.37;
/** Vertical field of view (rad), and the focal length it gives (screen heights). */
export const CAMPFIRE_FOV = 1;
export const CAMPFIRE_FOCAL = 0.5 / Math.tan(CAMPFIRE_FOV / 2);
/** The eye: a low seat just across the flames (m). */
export const CAMPFIRE_EYE = 0.9;

/** Where a ground point at screen height y (below the horizon) lies ahead of the eye (m). */
export function campfireDepth(y: number): number {
  return (CAMPFIRE_EYE * CAMPFIRE_FOCAL) / (CAMPFIRE_HORIZON - y);
}

/** The fire's foot: straight ahead, at screen height 0.16 (the shader's campfireF). */
export const CAMPFIRE_FIRE_Z = campfireDepth(0.16);

/** The fuel's log slots (the shader draws three logs) and the atlas rows the fuel takes (one). */
export const CAMPFIRE_LOGS = 3;
export const CAMPFIRE_ROWS = 1;

/**
 * The seat's rig: the eye CAMPFIRE_EYE up, the horizon at CAMPFIRE_HORIZON, a vertical field of
 * CAMPFIRE_FOV, facing the sky's frame unturned. The camp is laid out for frames from square to
 * 1.8 wide (the shader's campfireHalf), a narrower one as if square. The passage moves the fire and
 * its light, never the eye.
 */
export const CAMPFIRE_RIG: Rig = {
  horizon: CAMPFIRE_HORIZON,
  focal: CAMPFIRE_FOCAL,
  eye: CAMPFIRE_EYE,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The light guest layers and the plain floor take at the camp (the campfire's own layers keep their
 * own, shader.ts campfireBegin, which this matches): the sky's light 1.35 times the World's over a
 * cool floor, so the dark woods still read at midnight; the campfire's ink and its vignette, a circle
 * across the frame's width.
 */
export const CAMPFIRE_GRADE: Grade = {
  skyTint: [1.35, 1.35, 1.35],
  floor: [0.012, 0.017, 0.034],
  vignette: 0.35,
  vignetteRound: { from: 0.6, to: 1.4, scale: 1.2 },
  ink: { gain: 1.5, gamma: 0.8 },
};

/** Seconds the entrance and the exit take (the preset's `passage`). */
export const CAMPFIRE_PASSAGE = { enter: 4.5, exit: 2.2 } as const;
