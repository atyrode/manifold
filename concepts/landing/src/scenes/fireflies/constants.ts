// What the Fireflies preset and its layer manifests (index.ts, layers.ts) share with their GLSL and
// sims (shader.ts, sim.ts), without loading them: the rig the river is seen through and the light it
// is graded by, the bank's lattice, the lights nearer than the bank, the atlas rows and the passage.
import type { Grade, Rig } from "../../composer/types.ts";

/** Lattice pitch in screen heights: one firefly per square cell (5–6 dither cells at 540 rows). */
export const FIREFLIES_CELL = 0.01;
/** The far bank's waterline, in uv height. */
export const FIREFLIES_WATER = 0.34;
/** Lattice rows, from the waterline to the top of the frame. */
export const FIREFLIES_ROWS = Math.ceil((1 - FIREFLIES_WATER) / FIREFLIES_CELL);
/** Forest profile texels per lattice column. */
export const FIREFLIES_PROFILE_RES = 4;
/** The prop roots' lattice (screen heights): an apex now and then in each bin, as the shader always hashed them. */
export const FIREFLIES_ROOT_PITCH = 0.012;
/**
 * Lights nearer than the bank, one texel each of the swarm's state: first FIREFLIES_DRIFTERS
 * fireflies drifting low over the river, then out-of-focus ones close to us (the `near` knob shows
 * some of those).
 */
export const FIREFLIES_NEAR = 16;
export const FIREFLIES_DRIFTERS = 10;
/**
 * The camera: eye height above the river (m), focal length (screen heights per unit of slope), the
 * far bank's distance (m) and the aperture that blurs whatever is nearer into a disc of radius
 * APERTURE · FOCAL · (1/z − 1/BANK) screen heights.
 */
export const FIREFLIES_EYE = 1.2;
export const FIREFLIES_FOCAL = 1.2;
export const FIREFLIES_BANK = 60;
export const FIREFLIES_APERTURE = 0.15;
/** The true horizon, hidden behind the far bank: where the river would meet the sky. */
export const FIREFLIES_HORIZON =
  FIREFLIES_WATER + (FIREFLIES_EYE / FIREFLIES_BANK) * FIREFLIES_FOCAL;
/** The swarm's state texels (its row of the records atlas): the nearer lights, then the lantern and the bank. */
export const FIREFLIES_STATE_LANTERN = FIREFLIES_NEAR;
export const FIREFLIES_STATE_BANK = FIREFLIES_NEAR + 1;

/** Seconds the scene's entrance and exit take (its `passage`). */
export const FIREFLIES_PASSAGE = { enter: 2.8, exit: 1.5 };

/**
 * The river's rig: a level pinhole FIREFLIES_EYE metres over the water, the far bank's waterline
 * FIREFLIES_BANK metres ahead at uv FIREFLIES_WATER. Nothing is laid out across the frame's width (the
 * lattice grows with it), so no stage. Its passage moves no eye: the camera's settling zoom and pan
 * about the waterline are the river's own (shader.ts firefliesBegin).
 */
export const FIREFLIES_RIG: Rig = {
  horizon: FIREFLIES_HORIZON,
  focal: FIREFLIES_FOCAL,
  eye: FIREFLIES_EYE,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The river's light for a layer of another scene on it (the river's own layers keep the palette they
 * were painted in, lit by the World only as the night lifts): the moon as the key at 0.6 of its colour
 * once the sun has set, the ink gained 3.2, linear, so the night's few lit cells read.
 */
export const FIREFLIES_GRADE: Grade = {
  moonlight: 0.6,
  ink: { gain: 3.2, gamma: 1 },
};

/** Rows of the records atlas: the mangroves' (the breeze), the swarm's (its state). */
export const MANGROVES_ROWS = 1;
export const FIREFLY_SWARM_ROWS = 1;
