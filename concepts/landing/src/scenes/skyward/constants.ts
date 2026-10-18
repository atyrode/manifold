// What the Skyward preset and its layer manifests (index.ts, layers.ts) share with their GLSL
// (shader.ts), without loading it: the camera lying at the crossing and the rig it is, the passage
// that tips it, the light guest layers would take, where the shooting stars set out.
import type { Flyway, Grade, MeteorField, Rig } from "../../composer/types.ts";

/** Seconds of the entrance (the view tips back from street level to the zenith) and the exit (it tips down toward the street again) (SceneDef.passage). */
export const SKYWARD_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The camera's focal length (screen heights): 0.5 / tan(fov / 2) for a vertical field of 1.5 rad. */
export const SKYWARD_FOCAL = 0.5367;
/** The eye, lying on the road (m). */
export const SKYWARD_EYE = 0.2;
/** How far off the zenith the camera looks, toward the feet (rad). */
export const SKYWARD_PITCH = 0.28;
/** The turn from the street's frame to the sky's (skyFacing): the sun's noon path runs down the avenue. */
export const SKYWARD_SKY_YAW = -3.19;

/**
 * The crossing's rig: the eye SKYWARD_EYE over the road, pitched up SKYWARD_PITCH short of the zenith
 * (lying on your back), the screen's middle on the camera's axis (no horizon in a view looking up),
 * its frame the street's, turned SKYWARD_SKY_YAW back into the sky's. The camera's own heading in the
 * street, the passage's tip toward the street and the pointer's sway are the crossroads' (shader.ts
 * crossroadsBegin), which also hands the World its view along each ray (x.v) and the axes the rain
 * and snow are seen through (`precip.seen`). Nothing is laid out across the frame, so no stage.
 */
export const SKYWARD_RIG: Rig = {
  horizon: 0.5,
  focal: SKYWARD_FOCAL,
  eye: SKYWARD_EYE,
  turn: -SKYWARD_SKY_YAW,
  pitch: 0.5 * Math.PI - SKYWARD_PITCH,
  minAspect: 1,
};

/** The light guest layers and the plain floor take at the crossing (its own layers keep their own): the World's, with skyward's ink. */
export const SKYWARD_GRADE: Grade = { ink: { gain: 1.15, gamma: 0.85 } };

/**
 * The World's flyway over the crossing, never flown: its flights cross a level camera's view, and
 * the street's birds are the crossroads' own (wheeling pigeons and looping swifts seen from below, on
 * the World's birds knobs), so the World's are compiled out wherever the crossroads stands
 * (index.ts).
 */
export const SKYWARD_FLYWAY: Flyway = {
  depth: [30, 200],
  above: 0.05,
  top: 0.95,
  seed: 2.3,
  skim: 1e9,
  spread: 1,
  ext: 0.002,
};

/** Where shooting stars set out: skyAngles of the camera's ray (bearing, elevation), the upper half of the strip of sky. */
export const SKYWARD_METEORS: MeteorField = [-0.84, 0.18, 1.68, 0.46];
