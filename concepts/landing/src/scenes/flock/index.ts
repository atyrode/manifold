// Murmuration: a starling flock folding over a dusk sky. The birds fly on the CPU as a thin sheet
// that bends, twists, folds and splits (sim.ts), or, with `emergent` on, as topological boids
// (sims/boids.ts) whose shape is their own; they are inked from a density field, pale where the
// flock is stretched and black where it folds. A variant of the `outdoor` composer's baseline
// (src/composer, README "The outdoor composer"), the baseline's downs off: the roost (the World's
// sky and the low skyline it grounds) and the murmuration over it (layers.ts), which any level rig
// with enough sky offers. The sky, the weather and the birds besides the starlings are the World's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { FLOCK_FLYWAY, FLOCK_GRADE, FLOCK_METEORS, FLOCK_PASSAGE, FLOCK_RIG } from "./constants.ts";

/** The murmuration over the outdoor's baseline: its roost and flock, its eye on the bank, dusk. */
export const flockVariant: Variant = {
  id: "flock",
  base: "outdoor",
  title: "Murmuration",
  blurb: "Starlings at dusk, thousands of birds folding into one shape.",
  accent: "#ff8a3d",
  look: { color: "full", levels: 4 },
  passage: FLOCK_PASSAGE,
  planets: { group: "sky", across: [-90, -18, 5], up: [3, 24, 44] },
  layers: { remove: ["downs"], add: ["roost", "murmuration"] },
  camera: FLOCK_RIG,
  grade: FLOCK_GRADE,
  // Just after sunset under a clear sky: the stars come out over the flock after dusk, no Milky Way;
  // the World's other birds, off (the starlings are the sky's).
  world: {
    time: 0.76,
    stars: 0.45,
    milkyWay: { on: false },
    clouds: 0,
    birds: {
      kind: "rooks",
      on: false,
      help: "Rooks and other birds crossing the sky in front of the flock on their way to roost; the reeds hide any that pass behind them, and few fly in rain or snow.",
    },
  },
  meteors: FLOCK_METEORS,
  flyway: FLOCK_FLYWAY,
  floor: "water",
  // The skyline sways with the wind alone, so the gusts are off.
  values: { gusts: 0 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the stars that come out over the flock after dusk.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Wind carries the flock downwind and stirs the reeds and the water; rain and snow fall in front of the flock and grey its sky.",
    },
  },
};

/** The murmuration composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const flockComposed = composeScene(outdoor, variantPreset(outdoor.baseline, flockVariant));

export const flockScene: SceneDef = { ...flockComposed.def, code: () => import("./code.ts") };
