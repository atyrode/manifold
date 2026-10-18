// What the Bamboo grove preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sims (shader.ts, sim.ts), without loading them: its passage, the rig the grove is seen through, the
// light the composer grades guest layers by, and the shared data each layer asks for. The grove's
// geometry (layout.ts) is plain data too.
import type { Grade, Rig } from "../../composer/types.ts";
import { BAMBOO_CORNER_FIT, BAMBOO_EYE, BAMBOO_HORIZON } from "./layout.ts";

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads the same). The
 * entrance: the culms sway in from the frame edges while the spout starts to run and the tube fills.
 * The exit: the tube is filled to the brim, tips and clacks, and a gust sways the grove.
 */
export const BAMBOO_PASSAGE = { enter: 2.8, exit: 1.7 } as const;

/**
 * The grove's rig: the eye BAMBOO_EYE metres up, the horizon at BAMBOO_HORIZON, a focal length of one
 * screen height (the culms' and the floor's), facing the sky's frame unturned. Its claims are laid
 * out for a frame BAMBOO_CORNER_FIT.aspect wide, where the corner group (the water clock and the
 * lantern) takes its full size. The passage moves the culms and the water clock, never the eye.
 */
export const BAMBOO_RIG: Rig = {
  horizon: BAMBOO_HORIZON,
  focal: 1,
  eye: BAMBOO_EYE,
  turn: 0,
  pitch: 0,
  minAspect: BAMBOO_CORNER_FIT.aspect,
};

/**
 * The light guest layers and the plain floor take in the grove (the grove's own layers keep its own
 * model, shader.ts bambooBegin): the sun reaching under the canopy in its rays alone and turned
 * gold-green by the leaves, the sky's light greened by them; the grove's ink.
 */
export const BAMBOO_GRADE: Grade = {
  sunTint: [0.48, 0.46, 0.3],
  skyTint: [0.8, 1.0, 0.88],
  ink: { gain: 1.5, gamma: 1 },
};

/**
 * What the layers keep in the composer's shared resources (LayerDef.data): the grove its record row
 * (the gusts over the stems) and the culms' sway as a field; the culms the same sway and a row of the
 * leaves in the air; the water clock its two rows (the tube, the clack and the rings; the leaves
 * floating on the basin). The grove's sim writes them all (sim.ts).
 */
export const BAMBOO_DATA = {
  grove: { rows: 1, fields: 1 },
  culms: { rows: 1, fields: 1 },
  clock: { rows: 2 },
} as const;
