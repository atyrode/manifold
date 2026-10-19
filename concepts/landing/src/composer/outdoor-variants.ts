// The outdoor's variants (ADR 0062 "Baselines and variants", D14): the scenes over the outdoor
// baseline (outdoor.ts), each in its folder with code of its own, keyed by scene id. The rest of the
// outdoor scenes are scene presets of their own until they are ported (ADR 0062 "Order of work",
// step 5), and none is promoted yet (D15: promotion is the interior's).
import { autumnVariant } from "../scenes/autumn/index.ts";
import { bambooVariant } from "../scenes/bamboo/index.ts";
import { beesVariant } from "../scenes/bees/index.ts";
import { campfireVariant } from "../scenes/campfire/index.ts";
import { countryVariant } from "../scenes/country/index.ts";
import { dewVariant } from "../scenes/dew/index.ts";
import { dunesVariant } from "../scenes/dunes/index.ts";
import { fallsVariant } from "../scenes/falls/index.ts";
import { firefliesVariant } from "../scenes/fireflies/index.ts";
import { flockVariant } from "../scenes/flock/index.ts";
import { forestVariant } from "../scenes/forest/index.ts";
import { gardenVariant } from "../scenes/garden/index.ts";
import { lakeVariant } from "../scenes/lake/index.ts";
import { landVariant } from "../scenes/land/index.ts";
import { meadowVariant } from "../scenes/meadow/index.ts";
import { skywardVariant } from "../scenes/skyward/index.ts";
import type { Variant } from "./types.ts";

/** The outdoor scenes stored as variants, by scene id: the baseline's own scene (`land`) first. */
export const outdoorVariants = {
  land: landVariant,
  meadow: meadowVariant,
  autumn: autumnVariant,
  bamboo: bambooVariant,
  bees: beesVariant,
  campfire: campfireVariant,
  country: countryVariant,
  dew: dewVariant,
  dunes: dunesVariant,
  falls: fallsVariant,
  fireflies: firefliesVariant,
  flock: flockVariant,
  forest: forestVariant,
  garden: gardenVariant,
  lake: lakeVariant,
  skyward: skywardVariant,
} as const satisfies Readonly<Record<string, Variant>>;
