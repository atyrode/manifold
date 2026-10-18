// What the Stone garden preset and its layer manifests (index.ts, layers.ts) share with its GLSL,
// sims and build (shader.ts, sim.ts, build.ts), without loading them: the garden and its cameras,
// the rig the composer draws it through, the light it grades guests by, and the shared data each
// layer asks for.
import type { Flyway, Grade, Rig } from "../../composer/types.ts";

export const gardenPatterns = ["waves", "straight", "circles"] as const;
export type GardenPattern = (typeof gardenPatterns)[number];

export const gardenSeasons = ["spring", "summer", "autumn", "winter"] as const;
export type GardenSeason = (typeof gardenSeasons)[number];

/**
 * The garden and its two cameras. Garden space: X right (0..aspect), Y away from the veranda
 * (0..1), Z up, in garden depths (GARDEN_METRES each).
 *   veranda: a shifted-lens pinhole at (aspect / 2, eyeY, eyeHeight) looking along +Y, horizon at
 *            screen height `horizon`, focal length `focal` in screen heights (as viewRay's 0.5 /
 *            tan(fov / 2)); the earthen wall stands at Y = wallY.
 *   above:   a pinhole `overheadHeight` above (aspect / 2, overheadY) looking straight down; the
 *            ground spans `span` garden depths per screen height, from the drip line to the wall's cap.
 */
export const GARDEN = {
  aspect: 2.4,
  cols: 672,
  rows: 280,
  /** The pebble drip line along the veranda: garden Y below this is not raked. */
  drip: 0.03,
  wallY: 1.03,
  wallHeight: 0.125,
  capHeight: 0.032,
  focal: 1.25,
  horizon: 1.0,
  eyeHeight: 0.253,
  eyeY: -0.316,
  span: 1.06,
  overheadHeight: 1.5,
  overheadY: 0.52,
} as const;

/**
 * Metres in a garden depth, which every garden layer declares: its parts are drawn in garden space,
 * and what the composer takes from them (each cell's depth, the eye's height, the World's weather
 * and cloud shadows) is in metres at this scale.
 */
export const GARDEN_METRES = 10;

/**
 * The garden's rig: the veranda's pinhole (GARDEN), in metres. Its horizon is the frame's top edge,
 * so no open sky shows; it faces the sky's frame unturned (garden X is the sky's x, Y its z), and
 * nothing is laid out across the frame's width (minAspect 1). It stands still through the passage:
 * the maple's boughs and leaves play it.
 */
export const GARDEN_RIG: Rig = {
  horizon: GARDEN.horizon,
  focal: GARDEN.focal,
  eye: GARDEN.eyeHeight * GARDEN_METRES,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The light the plain floor (the gravel switched off) takes: the moon its key at 1.6 times the
 * World's once the sun has set, as the garden's own light has it (shader.ts gardenLight); the
 * garden's ink.
 */
export const GARDEN_GRADE: Grade = {
  moonlight: 1.6,
  ink: { gain: 1.15, gamma: 0.85 },
};

/**
 * The World's birds over the garden: they would cruise over the temple woods, above the frame's top
 * edge (the horizon), so none is seen from the veranda.
 */
export const GARDEN_FLYWAY: Flyway = {
  depth: [20, 120],
  above: 0.05,
  top: 1,
  seed: 4.1,
  skim: 3,
  spread: 1.5,
  ext: 0.01,
};

/**
 * What the layers keep in the composer's shared resources (LayerDef.data): the gravel a row of the
 * records atlas (its islands, stones and drying clock) and two fields (the raked heights, when each
 * spot was last raked); the woods and the border their plant records (four rows each, at most 512
 * records); the boughs a row (their leaves, four texels each).
 */
export const GARDEN_DATA = {
  gravel: { rows: 1, fields: 2 },
  templeWoods: { rows: 4 },
  boughs: { rows: 1 },
  border: { rows: 4 },
} as const;

/**
 * The feature a setting's programs hold while it looks down from straight above (the gravel's
 * camera at 1): the garden's own program (shader.ts gardenAboveGlsl) until the overhead composer
 * takes it as the scene `gardenabove` (ADR 0062 Phase 4).
 */
export const GARDEN_OVERHEAD = "GARDEN_OVERHEAD";

/**
 * When the white gravel is in daylight and the page is a light one: times of day (still clock)
 * from just after sunrise to just before sunset, while the rain falling (its amount; in winter it
 * comes down as snow, src/climate.ts) stays lighter than `rain`; harder rain greys and darkens the
 * garden (index.ts's theme and the shader's ink).
 */
export const GARDEN_PAPER = { from: 0.26, to: 0.745, rain: 0.35 } as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the maple's boughs sway
 * in from the top of the frame and a few leaves drift down and land. Exit: a gust, rising over the
 * whole exit, blows a flurry of leaves across the gravel while the boughs sway up out of the frame.
 */
export const GARDEN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
