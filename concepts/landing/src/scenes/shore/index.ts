// A beach by moonlight, looking out to sea: surf rolls in, breaks and runs up the sand, and plankton
// (Noctiluca scintillans) flashes electric blue wherever the water is disturbed. By default the moon
// has just risen over the sea, right of ahead, and lays its path across the breakers. By day it is
// an ordinary turquoise seaside. A variant of the `outdoor` composer's baseline (src/composer,
// README "The outdoor composer"), the sea and the sand in place of its downs and its lawn: the sea
// (its sky staging, the surf, the hands' wake in the plankton), the beach it runs up (the wet sand,
// the M drawn in it), the agents' cairns on it, and a school of fish to switch on (layers.ts). The
// sky, the weather and the gulls are the World's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { SHORE_FLYWAY, SHORE_GRADE, SHORE_PASSAGE, SHORE_RIG } from "./constants.ts";

/** The shore over the outdoor's baseline: its sea, beach and cairns, its moonrise. */
export const shoreVariant: Variant = {
  id: "shore",
  base: "outdoor",
  title: "Shore",
  blurb: "Surf on a night beach, flashing blue wherever the water breaks.",
  accent: "#2ee6ff",
  // Designed in full colour; the plankton light is the accent in two-tone mode.
  look: { color: "full", levels: 4 },
  // Entrance: the lens settles from the sand up to the horizon as the surf, stood out to sea, runs
  // in and up the beach, the plankton flashing blue as it comes. Exit: the surf draws back out to sea.
  passage: SHORE_PASSAGE,
  planets: { group: "sky", across: [-2, 18, 60], up: [0, 7, 14] },
  // A sunlit beach is bright sand and sea: the copy needs dark ink on it, from the time the sun is
  // about 12 degrees up (full daylight in the sky library) until it sinks back there. With the day
  // cycle running the light keeps changing, so the page stays on the night theme. The shader's ink
  // follows the page (inkOf).
  theme: skyTheme,
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the sea: its stars and the Milky Way, glinting in the wet sand, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows on the sand and the sea, rain, snow, fog and lightning out of a storm bank at sea, all mirrored in the water and the wet sand. Rain greys the sky and hangs in shafts out at sea, rings the water and soaks the beach; snow settles on the dry sand.",
    },
  },
  layers: { remove: ["downs"], add: ["sea", "beach", "cairns"] },
  camera: SHORE_RIG,
  grade: SHORE_GRADE,
  floor: "sand",
  // The evening moon six degrees up, in frame (the rig faces moonrise); fair-weather cloud; gulls by
  // day.
  world: {
    time: 0.82,
    birds: {
      kind: "gulls",
      help: "Gulls crossing over the sea by day, now and then swooping down to skim the water, dipping behind the breakers nearer than they are; mirrored in the wet sand a backwash leaves. Few fly in rain or snow.",
    },
  },
  // Shooting stars set out high over the sea.
  meteors: [-0.45, 0.16, 0.9, 0.08],
  // The gulls' flyway, which the sea's mirror flies whole (shader.ts seaFlyway), but its top: the
  // baseline's.
  flyway: {
    depth: SHORE_FLYWAY.depth,
    above: SHORE_FLYWAY.above,
    seed: SHORE_FLYWAY.seed,
    skim: SHORE_FLYWAY.skim,
    spread: SHORE_FLYWAY.spread,
    ext: SHORE_FLYWAY.ext,
  },
  // The sea: wind ripples tilting a mirror of the sky and the moon's glitter (rippleSpectrum,
  // waterMirror, waterGlint); the breakers and the swash are the sea's own. The moon's phase is
  // compiled in at every setting, a full moon's too (where the World leaves it out): the glitter's
  // narrow lobe magnifies the last bits of the moon's direction, which the phase code's presence
  // shifts, so a full moon's own program would not draw byte for byte as the all-features one does.
  features: { WATER_TIER: WATER_TIERS.mirror, SKY_MOON_PHASE: 1 },
};

/** The shore composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const shoreComposed = composeScene(outdoor, variantPreset(outdoor.baseline, shoreVariant));

export const shoreScene: SceneDef = { ...shoreComposed.def, code: () => import("./code.ts") };
