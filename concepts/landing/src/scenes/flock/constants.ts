// What the Murmuration preset and its layer manifests (index.ts, layers.ts) share with its GLSL and
// sim (shader.ts, sim.ts), without loading them: the flock sizes, the passage, the eye on the bank and
// the rig it is, the light guest layers take, the World's birds and shooting stars over the roost,
// how far out the flock and each part of the skyline stand, and what the murmuration keeps in the
// composer's shared resources.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";

/** The flock sizes on offer (the `murmuration` switch's amount). */
export const FLOCK_SIZES = [1500, 3000, 5000] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the flock streams in
 * from beyond the nearer side edge, head first, in a loose file that folds into its sheet as the
 * birds slow. Exit: it pours down head first, funnelling together, to roost below the horizon, where
 * the skyline hides it. Both are worked out when the density is splatted, so they follow the frame
 * clock smoothly; at rest (enter 1, exit 0) the birds are exactly where the flight puts them.
 */
export const FLOCK_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };

/** Screen height (uv) of the horizon, behind the skyline; the vertical field of view (rad). */
export const FLOCK_HORIZON = 0.08;
const FLOCK_FOV = 1;

/**
 * The roost's rig: a level pinhole 3 m up on the bank, the horizon low at FLOCK_HORIZON so the sky
 * fills the frame, a field of FLOCK_FOV, turned 0.75 rad toward where the sun sets. The skyline is
 * laid out across the frame's width at any aspect (minAspect 1). The passage moves the birds, never
 * the eye.
 */
export const FLOCK_RIG: Rig = {
  horizon: FLOCK_HORIZON,
  focal: 0.5 / Math.tan(0.5 * FLOCK_FOV),
  eye: 3,
  turn: 0.75,
  pitch: 0,
  minAspect: 1,
};

/** The roost's light: the World's sky as it is; the murmuration's ink. */
export const FLOCK_GRADE: Grade = { ink: { gain: 1.4, gamma: 1 } };

/**
 * The World's birds over the roost (off in the preset): flights 60 to 400 metres out, in front of
 * the skyline and the flock, from just over the skyline to near the top of the frame, never swooping.
 */
export const FLOCK_FLYWAY: Flyway = {
  depth: [60, 400],
  above: 0.1,
  top: 0.95,
  seed: 3.1,
  skim: 1e9,
  spread: 1.5,
  ext: 0.002,
};

/** Where the shooting stars set out (skyAngles): high over the flock's band of sky. */
export const FLOCK_METEORS = [-0.7, 0.4, 1.4, 0.3] as const;

/**
 * How far out each part stands (m), for the depth the composer composes at: the reeds in the water
 * along the frame's foot, the city's near and far rows of roofs, the reed bed's far shore (where its
 * water ends), the headland and its lighthouse, the open sea's surface as far as it is told apart,
 * and the murmuration, beyond all of them so the skyline hides it as it goes down to roost.
 */
export const ROOST_DEPTHS = {
  reeds: 34,
  nearCity: 900,
  farCity: 2000,
  shore: 1500,
  headland: 2400,
  sea: 2500,
} as const;
export const MURMURATION_DEPTH = 3000;

/**
 * What the murmuration keeps in the composer's shared resources (LayerDef.data): a row of the
 * records atlas (texels 0..2: the falcon, the falcon and the reference density, the M) and one field
 * (the density, rg16f, linear).
 */
export const MURMURATION_DATA = { rows: 1, fields: 1 } as const;
