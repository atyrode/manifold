// A moonlit sea rolling toward the horizon: boats ride at anchor in the moon's path and a lighthouse
// can stand on a headland. A preset of the `outdoor` composer (src/composer, README "Composers"): the
// open sea (the sky over it, the air, the picture's ink), the swell (the water, its mirror and its
// glitter), the lighthouse and the boats (layers.ts). The sky, the weather and the gulls are the
// World's.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { SWELL_FLYWAY, SWELL_GRADE, SWELL_METEORS, SWELL_PASSAGE, SWELL_RIG } from "./constants.ts";

const preset: ScenePreset = {
  id: "swell",
  composer: "outdoor",
  title: "Swell",
  blurb: "A moonlit sea rolling toward the horizon, boats riding at anchor in the moon's path.",
  accent: "#4c6ef5",
  // Enter: the camera rises from just above the water to its height while one long swell rolls in from
  // the far sea. Exit: it sinks toward the waves and tips down into them.
  passage: SWELL_PASSAGE,
  planets: { group: "sky", across: [24, 56, 66], up: [1, 9, 15] },
  // A sunlit sea is bright water and sky: the copy needs dark ink on it by full daylight, as shore's.
  theme: skyTheme,
  rig: SWELL_RIG,
  grade: SWELL_GRADE,
  // The full moon six degrees up over the sea a little left of ahead (the rig faces moonrise), the
  // night just fallen; a clear sky, its stars at their densest, since the long lens shows only the
  // low sky where they fade; gulls by day.
  world: {
    time: 0.818,
    stars: 1,
    clouds: 0,
    birds: {
      kind: "gulls",
      help: "Gulls crossing over the sea by day, now and then swooping down to skim the crests, hidden by the waves nearer than they are. Few fly in rain or snow.",
    },
  },
  meteors: SWELL_METEORS,
  flyway: SWELL_FLYWAY,
  floor: "water",
  layers: ["openSea", "swell", "boats"],
  // Nothing at sea sways in the gusts, so they are off.
  values: { gusts: 0 },
  // The sea: the swell, the wind's sea and its chop tilting a mirror of the World's sky
  // (rippleSpectrum, waterMirror, worldMirrorSky) and the moon's, the sun's and the lamps' glitter on
  // it (waterGlint). The moon's phase is compiled in at every setting, a full moon's too, as in shore:
  // the glitter's narrow lobe magnifies the last bits of the moon's direction, which the phase code
  // shifts.
  features: { WATER_TIER: WATER_TIERS.mirror, SKY_MOON_PHASE: 1 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the sea: its stars and the Milky Way, the moon's phase and its path on the water, the odd shooting star glinting in the waves, and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud, rain, snow, fog and lightning over the open sea, all mirrored in it, and the wind that raises its chop: a light breeze ruffles it, a gale tops the waves with white.",
    },
  },
};

/** The swell composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const swellComposed = composeScene(outdoor, preset);

export const swellScene: SceneDef = { ...swellComposed.def, code: () => import("./code.ts") };
