// Dew: one orb web up close at dawn, strung with dew between two grass stems, against a meadow far
// out of focus. The web is a Verlet net billowing in the breeze and its big drops creep, merge and
// fall (sim.ts); the shader (shader.ts) draws the glinting silk, the beads and drops as little
// lenses, the grass (stalk, leaves, seed head), and the wasp spider at the hub. A variant of the
// `outdoor` composer's baseline (src/composer, README "The outdoor composer"), the baseline's downs
// off: the meadow out of focus behind (the bokeh) and the web in front of it (layers.ts), through a
// macro rig of their own. The sky's hour and light, the weather and the birds are the World's, seen
// out of focus.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { DEW_FLYWAY, DEW_GRADE, DEW_METEORS, DEW_PASSAGE, DEW_RIG } from "./constants.ts";

/** The dewy web over the outdoor's baseline: its web and bokeh through its macro rig, its dawn. */
export const dewVariant: Variant = {
  id: "dew",
  base: "outdoor",
  title: "Dew",
  blurb: "An orb web at dawn, strung with dew, glinting as it breathes in the breeze.",
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  // Entrance: the web swings in on its anchor threads as a gust settles, the dew swinging with it, and
  // the spider walks down to the hub. Exit: a gust swings the web aside and out of frame.
  passage: DEW_PASSAGE,
  // Mist is pale: the page copy goes dark on it.
  theme: (params) => paletteTheme(params, "backdrop", (index) => index === 2),
  layers: { remove: ["downs"], add: ["bokeh", "web"] },
  camera: DEW_RIG,
  grade: DEW_GRADE,
  // Just after sunrise under a clear sky; swallows to switch on.
  world: {
    time: 0.27,
    clouds: 0,
    birds: {
      kind: "swallows",
      on: false,
      help: "Swallows hawking over the meadow far behind the web, dark against the dawn sky over the hedge; the hedge hides any that pass behind it, and few fly in rain or snow.",
    },
  },
  meteors: DEW_METEORS,
  flyway: DEW_FLYWAY,
  // The web sways in its own breeze, whose gusts are its own: nothing here moves in the composer's
  // gust field, so its gusts are off.
  values: { gusts: 0 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb: "Time of day: the low sun sets the glints and the colour of the light.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain and snow grey the sky behind the web and fall past it, rain darkens the grass, snow whitens the meadow and the stems; fog fades the meadow; lightning flashes on the dew. The cloud deck, the stars and the cumulus are lost in the blur.",
    },
  },
};

/** The dewy web composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const dewComposed = composeScene(outdoor, variantPreset(outdoor.baseline, dewVariant));

export const dewScene: SceneDef = { ...dewComposed.def, code: () => import("./code.ts") };
