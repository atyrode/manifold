// What the Lantern river preset and its layer manifests (index.ts, layers.ts) share with their GLSL
// and sim (shader.ts, sim.ts), without loading them: the rig the river is seen through and the light
// it is graded by, the far bank's distance, the lantern counts, the passage's seconds and the
// lanterns' row of the records atlas.
import type { Grade, Rig } from "../../composer/types.ts";

/** Screen height (uv) of the horizon. */
export const HORIZON = 0.56;
/** Vertical field of view (rad), and the focal length it gives (screen heights). */
export const FOV = 0.5;
export const FOCAL = 0.5 / Math.tan(FOV / 2);
/** Eye height over the water, and the distance to the far bank's waterline (m): where the land ends. */
export const EYE = 2;
export const FAR_BANK = 130;

/** The lantern counts on offer (the `lanterns` switch's amount). */
export const LANTERN_COUNTS = [6, 12, 18, 24, 30] as const;

/** Seconds the entrance and the exit take (the scene's `passage`). */
export const PASSAGE_ENTER = 4.5;

export const PASSAGE_EXIT = 2.2;

/** Rows of the composer's records atlas the lanterns layer writes (LayerDef.data): one, every slot and stone. */
export const LANTERNS_ROWS = 1;

/**
 * The river's rig: standing on a low bank EYE metres over the water, turned 20 degrees left of the
 * sky's frame toward the sunset, so the afterglow stands in the left of the frame and the lanterns
 * drift toward it. Nothing is laid out across the frame's width, so no stage (minAspect 1); the
 * passage moves the light and the flames, never the eye.
 */
export const LANTERNS_RIG: Rig = {
  horizon: HORIZON,
  focal: FOCAL,
  eye: EYE,
  turn: 0.35,
  pitch: 0,
  minAspect: 1,
};

/**
 * The dusk's light for a layer of another scene on the river (the river's own layers keep the light
 * they were painted in: the World's sky, the sun above the horizon and the moon's light): the moon
 * as the key at 0.6 of its colour once the sun has set, the ink gained 1.3 with a gamma of 0.8.
 */
export const LANTERNS_GRADE: Grade = {
  moonlight: 0.6,
  ink: { gain: 1.3, gamma: 0.8 },
};
