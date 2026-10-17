// The constants Swell's definition (index.ts) shares with its code (shader.ts, sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code). Lengths are in camera
// heights (the eye stands one over the still sea, some 15 m), in the camera's frame: x right, z
// ahead, y up from the still sea.

/** Trigger slots of the shooting stars' and the lightning's "now" buttons. */
export const SWELL_METEOR_TRIGGER = 0;

export const SWELL_LIGHTNING_TRIGGER = 1;

/**
 * The camera: the horizon's screen height (uv.y) and the focal length (screen heights), a long lens
 * under which the world's moon stands large over the sea, its path a broad column of glitter.
 */
export const SWELL_HORIZON = 0.44;

export const SWELL_FOCAL = 3;

/** Metres in a camera height: the world's unit is its inverse. */
export const SWELL_METRES = 15;

/**
 * A boat at anchor: where it rides (across, ahead), its length, its kind (0 a small sloop with its
 * sail furled on the boom, 1 a fishing boat with a wheelhouse) and its own phase for the rocking.
 */
export type SwellBoat = readonly [
  across: number,
  ahead: number,
  length: number,
  kind: number,
  phase: number,
];

/**
 * The boats, in the order the `boats` knob brings them in: the first, a yacht, rides out where the
 * moon's path blazes at the default hour, so its hull and mast stand black against the glitter.
 */
export const SWELL_BOATS: readonly SwellBoat[] = [
  [-3.85, 36, 1, 0, 0.3],
  [3, 22.5, 0.62, 1, 0.7],
  [2.2, 13.5, 0.5, 0, 0.1],
  [-9, 57, 0.7, 1, 0.5],
  [-1.9, 10.5, 0.45, 0, 0.9],
];

/** Height of a boat's middle over the sea, where an agent goes to it (a share of its length). */
export const SWELL_BOAT_MIDDLE = 0.25;

/**
 * The headland (the `lighthouse` knob): the plane it stands in (ahead), where its cliff meets the sea
 * (across; it runs on to the right from there), and its lighthouse's lamp (across, height).
 */
export const SWELL_CAPE = { ahead: 54, toe: 6.5, lamp: [7.7, 3.5] } as const;
