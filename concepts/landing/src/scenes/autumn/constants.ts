// What the Autumn park preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sims (shader.ts, sim.ts), without loading them: the rig the park is seen through and moved by in
// its passage, the light the composer grades guest layers by, and the shared data each layer asks
// for. The park's geometry (layout.ts) is plain data too.
import type { Grade, Rig } from "../../composer/types.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { AUTUMN_TILT, AUTUMN_VIEW, AUTUMN_WIDE } from "./layout.ts";

/**
 * The park's rig: the eye AUTUMN_VIEW.eye up, the horizon at AUTUMN_VIEW.horizon, a focal length of
 * one screen height, facing the sky's frame unturned (the low sun behind the canopy), laid out at
 * least AUTUMN_WIDE wide. Its passage is a lens shift of the whole image plane (`rigShift`; a level
 * camera, so the rain's paths stay parallel): the entrance starts raised into the canopy and settles
 * onto the path, easing out into a long, gentle tail; the exit tilts back up, gathering speed to the
 * end. The eye never moves (no lift) and no cell cuts its edges for it (the park cuts them always).
 */
export const AUTUMN_RIG: Rig = {
  horizon: AUTUMN_VIEW.horizon,
  focal: AUTUMN_VIEW.focal,
  eye: AUTUMN_VIEW.eye,
  turn: 0,
  pitch: 0,
  minAspect: AUTUMN_WIDE,
  passage: {
    lift: () => 0,
    shift: true,
    glsl: `
// ---- the park's passage: the lens shifted up into the canopy and back (constants.ts) ----
const vec3 AUTUMN_TILT = vec3(${glslFloat(AUTUMN_TILT.enter)}, ${glslFloat(AUTUMN_TILT.exit)}, ${glslFloat(AUTUMN_TILT.exitFrom)});
float rigLift() {
  return 0.0;
}
float rigCut() {
  return 0.0;
}
// The lens shift in screen heights, up, exactly 0 at rest.
float rigShift() {
  float pin = passageIn();
  float pout = passageOut();
  float shift = 0.0;
  if (pin < 1.0) shift += AUTUMN_TILT.x * (1.0 - pin) * (1.0 - pin) * (1.0 - pin);
  if (pout > 0.0) {
    float t = clamp((pout - AUTUMN_TILT.z) / (1.0 - AUTUMN_TILT.z), 0.0, 1.0);
    shift += AUTUMN_TILT.y * t * t;
  }
  return shift;
}
`,
  },
};

/**
 * The light guest layers and the plain floor take in the park (the park's own layers keep their own
 * model, shader.ts autumnBegin): the low sun and the moon (its key once the sun has set) at 1.2 times
 * the World's, the sky's light a little warmer; the park's ink.
 */
export const AUTUMN_GRADE: Grade = {
  sunTint: [1.2, 1.2, 1.2],
  skyTint: [1.01, 0.99, 0.95],
  moonlight: 1.92,
  ink: { gain: 1.3, gamma: 0.8 },
};

/**
 * What the layers keep in the composer's shared resources (LayerDef.data): the maple a row of the
 * records atlas (its leaves in the air, layout.ts AUTUMN_SLOTS of four texels), the litter its two
 * carpet layers as fields.
 */
export const AUTUMN_DATA = { maple: { rows: 1 }, litter: { fields: 2 } } as const;
