// What the Waterfall preset and its layer manifests (index.ts, layers.ts) share with its GLSL and sim
// (shader.ts, sim.ts), without loading them: the rig the gorge is seen through, its passage, and the
// near bank's fern records.
import type { Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";

/** Seconds of the waterfall's entrance (the camera tilts down the fall to the pool) and exit (it tilts back up into the spray); SceneDef.passage. */
export const FALLS_PASSAGE = { enter: 2.8, exit: 1.4 } as const;

/** Eye level: the camera's horizon line (uv.y). */
export const FALLS_EYE = 0.34;
/** The vertical field of view (radians). */
export const FALLS_FOV = 0.9;
/** The eye's height over the pool (m): a pool-plane unit. */
export const FALLS_CAM = 2;

/** Clumps of ferns on the near bank, and fronds a clump (the greenery's records, sim.ts). */
export const FALLS_CLUMPS = 4;
export const FALLS_FRONDS = 5;
/** The bank's ferns: metres to them, and metres to a screen height there (for the gusts). */
export const FALLS_FERN_Z = 2.2;
export const FALLS_FERN_M = 2.1;
/** Rows of the composer's records atlas the greenery writes: one organ record a frond (PlantTexture's four texels). */
export const FALLS_ROWS = 4;

/** Screen heights the frame starts above its rest view at the entrance, and how far the exit lifts it. */
const TILT_IN = 0.4;
const TILT_OUT = 0.34;

/**
 * Something springing up, or the camera coming to rest (the GLSL's fallsSpring, line for line): 0 at
 * x = 0 and already moving, a gentle overshoot past 1, exactly 1 (and still) at x = 1.
 */
export function fallsSpring(x: number): number {
  const u = Math.min(Math.max(x, 0), 1) - 1;
  return 1 + u * u * (2.2 * u + 1.2);
}

/**
 * The gorge's rig: level at the pool's edge, the eye FALLS_CAM metres over the water and the horizon
 * at FALLS_EYE, a vertical field of view of FALLS_FOV, turned half a turn from the sky's frame so the
 * sun stands behind the viewer whenever it is up (it lights the cliff and the spray from the front,
 * and the rainbow's centre lies ahead, below the horizon). Nothing of it is laid out across the
 * frame's width. Its passage is a lens shift (rigShift): the frame starts up at the lip and, already
 * moving, tilts down the fall to the pool, settling a touch past rest and back (fallsSpring); leaving,
 * it tilts back up the fall, ever faster. The eye itself never moves.
 */
export const FALLS_RIG: Rig = {
  horizon: FALLS_EYE,
  focal: 0.5 / Math.tan(0.5 * FALLS_FOV),
  eye: FALLS_CAM,
  turn: Math.PI,
  pitch: 0,
  minAspect: 1,
  passage: {
    lift: () => 0,
    shift: true,
    shiftAt: (enter, exit) => TILT_IN * (1 - fallsSpring(enter / 0.85)) + TILT_OUT * exit * exit,
    glsl: `
// ---- the waterfall's passage: a tilt down the fall and back up it (falls/constants.ts) ----
const float FALLS_TILT_IN = ${glslFloat(TILT_IN)};
const float FALLS_TILT_OUT = ${glslFloat(TILT_OUT)};

// Something springing up, or the camera coming to rest: 0 at x = 0 and already moving, a gentle
// overshoot past 1, exactly 1 (and still) at x = 1. The ferns' spring up uses it too (shader.ts).
float fallsSpring(float x) {
  float u = clamp(x, 0.0, 1.0) - 1.0;
  return 1.0 + u * u * (2.2 * u + 1.2);
}

// The eye stays where it is, and no cell cuts its edges for the motion.
float rigLift() {
  return 0.0;
}
float rigCut() {
  return 0.0;
}

// The lens's shift (screen heights; exactly 0 at rest): up at the lip as the scene arrives, settling
// onto the pool; lifted back up the fall as it leaves.
float rigShift() {
  return FALLS_TILT_IN * (1.0 - fallsSpring(passageIn() / 0.85)) + FALLS_TILT_OUT * passageOut() * passageOut();
}
`,
  },
};
