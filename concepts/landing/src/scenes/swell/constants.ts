// What the Swell preset and its layer manifests (index.ts, layers.ts) share with its GLSL and sims
// (shader.ts, sim.ts), without loading them: the rig the sea is seen through and the passage that
// moves it, the light it is graded by, the gulls' flyway, where the boats ride and where the
// headland stands. The sea is worked in camera heights (the eye stands one over the still sea,
// SWELL_METRES metres), in the rig's frame: x right, z ahead, y up from the still sea; the composer's
// depths are metres.
import type { Flyway, Grade, MeteorField, Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";

/** Seconds the scene's entrance and exit take (SceneDef.passage), both played by the rig. */
export const SWELL_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/**
 * The camera: the horizon's screen height (uv.y) and the focal length (screen heights), a long lens
 * under which the world's moon stands large over the sea, its path a broad column of glitter.
 */
export const SWELL_HORIZON = 0.44;

export const SWELL_FOCAL = 3;

/** Metres in a camera height: the eye's height over the still sea. */
export const SWELL_METRES = 15;

/**
 * How far round from the sky's frame the sea faces (rad), toward moonrise: at the default hour
 * (time 0.818) the full moon stands six degrees up and six left of ahead, its path left of
 * mid-frame.
 */
export const SWELL_FACING = 0.81;

/**
 * The open sea's rig: a level pinhole SWELL_METRES over the still sea, turned toward moonrise.
 * Nothing is laid out across the frame's width, so it has no stage. Its passage: arriving, the eye
 * rises from just above the water to its height (easing out with a small overshoot) while the lens,
 * tilted down at the waves, settles onto the horizon by whole cells, so the stars keep to the dither
 * grid; leaving, the eye sinks toward the waves and the lens tips down into them. Both are exactly
 * 0 at rest.
 */
export const SWELL_RIG: Rig = {
  horizon: SWELL_HORIZON,
  focal: SWELL_FOCAL,
  eye: SWELL_METRES,
  turn: -SWELL_FACING,
  pitch: 0,
  minAspect: 1,
  passage: {
    lift: (enter, exit) => {
      const u = Math.min(Math.max(enter, 0), 1) - 1;
      const arrive = -(2.2 * u * u * u + 1.2 * u * u);
      return -SWELL_METRES * (0.65 * arrive + 0.6 * exit * exit);
    },
    shift: true,
    glsl: `
// ---- the swell's passage: the eye rising from the waves, the lens settling (constants.ts) ----
const float SWELL_PASSAGE_METRES = ${glslFloat(SWELL_METRES)};

// How far the scene has still to arrive (1 -> 0, easing out with a small overshoot) and how far it
// has left (0 -> 1, gathering speed): both exactly 0 at rest.
float swellArrive() {
  return 1.0 - passageSettle(passageIn(), 1.2);
}

float swellLeave() {
  return passageOut() * passageOut();
}

// How far under its rest height the eye is (m): 0 at rest.
float rigLift() {
  return -SWELL_PASSAGE_METRES * (0.65 * swellArrive() + 0.6 * swellLeave());
}

float rigCut() {
  return 0.0;
}

// The lens's tilt down at the waves in screen heights, by whole cells: 0 at rest.
float rigShift() {
  float tilt = -(0.07 * swellArrive() + 0.08 * swellLeave());
  return floor(tilt * uRes.y + 0.5) / uRes.y;
}
`,
  },
};

/** The sea's light: the World's sky as it is (the sea lights its own parts by it); its ink is its own. */
export const SWELL_GRADE: Grade = { ink: { gain: 1, gamma: 1 } };

/**
 * The World's gulls: 4.5 to 36 camera heights out, cruising from just over the horizon to the top of
 * the frame, a swooping party skimming the crests 3 m up, drawn twice life size; they fade into the
 * haze by 0.013 a camera height.
 */
export const SWELL_FLYWAY: Flyway = {
  depth: [4.5 * SWELL_METRES, 36 * SWELL_METRES],
  above: 0.03,
  top: 0.95,
  seed: 7.7,
  skim: 0.2 * SWELL_METRES,
  spread: 2,
  ext: 0.013 / SWELL_METRES,
};

/** Where shooting stars set out: skyAngles of the rig's ray, high over the sea, most fading first. */
export const SWELL_METEORS: MeteorField = [-0.24, 0.08, 0.48, 0.09];

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
 * The headland (the `lighthouse` layer): the plane it stands in (ahead), where its cliff meets the
 * sea (across; it runs on to the right from there), and its lighthouse's lamp (across, height).
 */
export const SWELL_CAPE = { ahead: 54, toe: 6.5, lamp: [7.7, 3.5] } as const;
