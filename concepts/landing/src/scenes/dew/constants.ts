// What the Dew preset and its layer manifests (index.ts, layers.ts) share with its GLSL and sim
// (shader.ts, sim.ts), without loading them: the passage, the macro rig the web is seen through,
// the light guest layers would take, the World's birds behind it, the depths the composer is handed
// and where the web keeps its records.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";

/** Seconds the scene's entrance and exit take (SceneDef.passage); the shader reads the same. */
export const DEW_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** Screen height (uv) of the horizon behind the web, and the vertical field of view (rad). */
export const DEW_HORIZON = 0.4;
export const DEW_FOV = 0.6;

/**
 * The macro rig: the eye among the grass tops, 0.6 m up, level, the horizon at DEW_HORIZON and the
 * field of DEW_FOV the backdrop is drawn through (shader.ts dewBackdrop's viewRay). It is turned by
 * no fixed yaw: the camera keeps the low sun off the frame's right edge whatever the hour, so the
 * backdrop turns the World's view to it each cell (dewBegin). Nothing in it stands on the floor: the
 * web hangs between two grass stems half a metre off, everything behind is far out of focus, and the
 * floor is under the out-of-focus grass (bokehBegin closes it).
 */
export const DEW_RIG: Rig = {
  horizon: DEW_HORIZON,
  focal: 0.5 / Math.tan(DEW_FOV / 2),
  eye: 0.6,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The depths (m) the composer is handed, for the World's fog, rain and snow and its birds: the web's
 * plane (a frame height spans 0.3 m there), the meadow's grass tops and the hedge behind.
 */
export const DEW_WEB_Z = 0.3 * DEW_RIG.focal;
export const DEW_GRASS_Z = 6;
export const DEW_HEDGE_Z = 20;

/**
 * The light the plain floor and any guest would take: the World's sky as it is. The web and its
 * backdrop light themselves by the low sun the camera keeps to the right (shader.ts dewLight); the
 * ink of a picture that goes to the paper theme in the mist.
 */
export const DEW_GRADE: Grade = { ink: { gain: 1.3, gamma: 0.8, paper: [0.92, 0.8] } };

/**
 * The World's birds behind the web: 30 to 300 metres out, over the hedge's crown up to near the top
 * of the frame, never swooping, life size, fading into the morning haze by 1 / 400 a metre.
 */
export const DEW_FLYWAY: Flyway = {
  depth: [30, 300],
  above: 0.17,
  top: 0.95,
  seed: 5.3,
  skim: 1e9,
  spread: 1,
  ext: 0.0025,
};

/** Where the World's shooting stars set out (skyAngles): high over the hedge. */
export const DEW_METEORS = [-0.5, 0.25, 1, 0.15] as const;

/**
 * What the web keeps in the composer's shared resources (LayerDef.data): a row of the records atlas
 * (texels 0..DEW_DROPS·2-1 the drops, then the header at DEW_HEAD_AT) and two fields (the threads'
 * and stems' segments, the bin lists). sim.ts writes them, shader.ts reads them.
 */
export const DEW_DATA = { web: { rows: 1, fields: 2 } } as const;
