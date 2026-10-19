// What the Mystic forest preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sim (shader.ts, sim.ts, build.ts), without loading them: its passage, the rig the forest is seen
// through and dollied by, the light guest layers are graded by, and what the kodama keeps in the
// composer's shared resources. The forest's geometry (layout.ts) is plain data too.
import type { Grade, LayerData, Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { FOREST_DOLLY, FOREST_EYE, FOREST_HORIZON, FOREST_MIN_ASPECT } from "./layout.ts";

/**
 * The scene's passage (SceneDef.passage), one source for index.ts, the rig and the sim. Coming in,
 * the camera starts `back` m behind where it rests and dollies forward between the trunks over
 * `settle` s (arriving at speed and braking, a small overshoot, a settle), and the spirits pop up on
 * their perches one after another as it comes to rest; going out, the spirits turn their heads and
 * vanish one by one while the camera drifts `drift` m back into the mist, gathering speed
 * (FOREST_DOLLY).
 */
export const FOREST_PASSAGE = { enter: 3.2, exit: 1.6 } as const;

/**
 * The forest's rig: the eye FOREST_EYE up, the horizon at FOREST_HORIZON, a focal length of one
 * screen height (a point at depth z and height y lands at FOREST_HORIZON + (y - FOREST_EYE) / z),
 * facing the sky's frame unturned, laid out at least FOREST_MIN_ASPECT wide (the cedar, the beech and
 * the boulders keep to the frame's edges). Its passage is a dolly: the camera's advance from where it
 * rests (forestCamera, m, exactly 0 at rest; FOREST_DOLLY), which the forest's layers place every
 * part by (shader.ts forestAt). The eye never rises (no lift) and no cell cuts its edges for it.
 */
export const FOREST_RIG: Rig = {
  horizon: FOREST_HORIZON,
  focal: 1,
  eye: FOREST_EYE,
  turn: 0,
  pitch: 0,
  minAspect: FOREST_MIN_ASPECT,
  passage: {
    lift: () => 0,
    glsl: `
// ---- the forest's passage: the dolly in between the trunks and back into the mist (forest/constants.ts) ----
// Seconds the entrance takes (the exit needs only its progress); metres the camera starts back,
// seconds its dolly takes, metres it drifts back on the way out.
const float FOREST_ENTER = ${glslFloat(FOREST_PASSAGE.enter)};
const vec3 FOREST_DOLLY = vec3(${glslFloat(FOREST_DOLLY.back)}, ${glslFloat(FOREST_DOLLY.settle)}, ${glslFloat(FOREST_DOLLY.drift)});
float forestCamMove;   // 0..1: how fast the camera is moving (the floor's fine pattern would crawl past, so it calms)

// The dolly's progress 0..1 over x = 0..1: arriving at speed and braking (an ease-out), an arrival a
// little early with a small overshoot (to about 1.05) and a settle back, exactly 1 from x = 1.
float forestSettle(float x) {
  x = clamp(x, 0.0, 1.0);
  float bob = smoothstep(0.5, 1.0, x);
  float u = 1.0 - min(x / 0.8, 1.0);
  return 1.0 - u * u + 0.05 * sin(0.5 * TAU * bob);
}

// The camera's advance (m) from where it rests, with forestCamMove: exactly 0 at rest.
float forestCamera() {
  float pin = passageIn();
  float pout = passageOut();
  forestCamMove = 0.0;
  if (pin >= 1.0 && pout <= 0.0) return 0.0;
  float d = 0.0;
  if (pin < 1.0) {
    float x = pin * FOREST_ENTER / FOREST_DOLLY.y;
    float u = clamp(x / 0.8, 0.0, 1.0);
    d -= FOREST_DOLLY.x * (1.0 - forestSettle(x));
    forestCamMove = 1.0 - u;
  }
  if (pout > 0.0) {
    // Drifting back from rest and still gathering speed as the scene goes (an ease-in).
    d -= FOREST_DOLLY.z * pout * pout;
    forestCamMove = max(forestCamMove, pout);
  }
  return d;
}

// The eye stays at its height, and no cell cuts its edges for the motion.
float rigLift() {
  return 0.0;
}
float rigCut() {
  return 0.0;
}
`,
  },
};

/**
 * The light guest layers and the plain floor take under the canopy (the forest's own layers keep
 * their own model, shader.ts forestBegin): the sun, or once it has set the moon, as the key through
 * the leaves at about the share a shaft-less floor takes of it, warmed to the sunlight through the
 * cedars; the sky's light lifted to the gaps' light on what faces up; the forest's ink
 * (pow(1.6 lum, 0.8) as gain and gamma).
 */
export const FOREST_GRADE: Grade = {
  sunTint: [0.83, 0.79, 0.66],
  skyTint: [1.7, 1.9, 1.6],
  moonlight: 1,
  ink: { gain: Math.pow(1.6, 0.8), gamma: 0.8 },
};

/**
 * What the kodama keeps in the composer's shared resources (LayerData): one row of the records atlas
 * (its spirits and the stag, three texels each), and two fields of its own, the motes binned over the
 * screen and the mist's banks (sim.ts).
 */
export const KODAMA_DATA: LayerData = { rows: 1, fields: 2 };
