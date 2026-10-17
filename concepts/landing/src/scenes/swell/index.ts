// A moonlit sea rolling toward the horizon, on the shared water library (its mirror tier), under the
// shared world's sky and weather (scenes/world.ts, shaders/lib/world.ts): boats ride at anchor in the
// moon's path and a lighthouse can stand on a headland.
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";
import { SWELL_BOATS, SWELL_LIGHTNING_TRIGGER, SWELL_METEOR_TRIGGER } from "./constants.ts";

const params: ParamDef[] = [
  range(
    "sea",
    "height",
    "swell",
    0.5,
    "Height of the long swells rolling in from far off: the taller, the sharper their crests, until they break white.",
  ),
  range(
    "sea",
    "relief",
    "relief",
    0,
    "0: the waves are painted on a flat sea. Higher gives the nearer waves real height: crests hide the troughs behind them and the arriving swell stands up. Far waves stay flat.",
  ),
  feature(
    "boats",
    "boats",
    "boats",
    true,
    "how many",
    2,
    "Small boats riding the swell at anchor, heaving and rocking on the waves under them, bows to the wind. The first rides in the moon's path, black against its glitter.",
    { min: 1, max: SWELL_BOATS.length, step: 1 },
  ),
  toggle(
    "boats",
    "lanterns",
    "lanterns",
    false,
    "A lantern lit on each boat once it is dark, its warm light trembling down the water toward you.",
    { when: "boats" },
  ),
  toggle(
    "coast",
    "lighthouse",
    "lighthouse",
    false,
    "A lighthouse on a headland off to the right. By night its two beams sweep round, flashing as they pass you; in fog, rain or snow they light the air as long cones.",
  ),
  // The shared world: 0.818, the full moon six degrees up over the sea a little left of ahead (the
  // shader faces the sky toward moonrise), the night just fallen; a clear sky, its stars at their
  // densest, since the long lens shows only the low sky where they fade; gulls by day.
  ...worldKnobs({
    time: 0.818,
    stars: 1,
    clouds: 0,
    meteors: { trigger: SWELL_METEOR_TRIGGER },
    lightning: SWELL_LIGHTNING_TRIGGER,
    birds: {
      kind: "gulls",
      help: "Gulls crossing over the sea by day, now and then swooping down to skim the crests, hidden by the waves nearer than they are. Few fly in rain or snow.",
    },
  }),
  toggle("manifold", "mmoon", "M on the moon", false, "The moon's dark seas form the Manifold M."),
];

export const swellScene: SceneDef = {
  id: "swell",
  title: "Swell",
  blurb: "A moonlit sea rolling toward the horizon, boats riding at anchor in the moon's path.",
  accent: "#4c6ef5",
  params,
  planets: { group: "sky", across: [24, 56, 66], up: [1, 9, 15] },
  groups: {
    sea: {
      title: "Sea",
      blurb:
        "The long swell, and the waves the wind raises on it: wind sea and chop, whitecaps once it blows hard.",
    },
    boats: { title: "Boats", blurb: "Small boats at anchor, and their lanterns by night." },
    coast: { title: "Coast", blurb: "A headland off to the right, and its lighthouse." },
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
    birds: worldGroups.birds,
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this night." },
  },
  code: () => import("./code.ts"),
  // Enter: the camera rises from just above the water to its height while one long swell rolls in from
  // the far sea. Exit: it sinks toward the waves and tips down into them.
  passage: { enter: 2.8, exit: 1.5 },
  // A sunlit sea is bright water and sky: the copy needs dark ink on it by full daylight, as shore's.
  theme: skyTheme(params),
  // The sea: the swell, the wind's sea and its chop tilting a mirror of the world's sky (rippleSpectrum,
  // waterMirror, worldMirrorSky) and the moon's, the sun's and the lamps' glitter on it (waterGlint).
  // The moon's phase is compiled in at every setting, a full moon's too, as in shore: the glitter's
  // narrow lobe magnifies the last bits of the moon's direction, which the phase code shifts.
  features: { WATER_TIER: WATER_TIERS.mirror, SKY_MOON_PHASE: 1 },
  // The world's parts only while their knobs can show them (worldFeatures); the relief's march, the
  // boats (their lanterns apart) and the headland only while they are on.
  featuresFor: (values) => ({
    ...worldFeatures(values),
    SWELL_RELIEF: (values["relief"] ?? 0) > 0 ? 1 : 0,
    SWELL_BOATS: (values["boats"] ?? 0) > 0 ? 1 : 0,
    SWELL_LANTERNS: (values["boats"] ?? 0) > 0 && (values["lanterns"] ?? 0) > 0 ? 1 : 0,
    SWELL_LIGHTHOUSE: (values["lighthouse"] ?? 0) > 0 ? 1 : 0,
  }),
  featuresAll: {
    ...WORLD_ALL,
    SWELL_RELIEF: 1,
    SWELL_BOATS: 1,
    SWELL_LANTERNS: 1,
    SWELL_LIGHTHOUSE: 1,
  },
};
