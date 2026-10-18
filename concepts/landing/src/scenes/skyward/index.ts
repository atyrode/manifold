// Skyward: lying on your back at a busy crossroads, looking up between the buildings. The facades
// rise and lean together toward a patch of sky; trams' wires, a signal gantry and a streetlamp cross
// it overhead, a plane draws its contrail across the clouds, pigeons wheel and swifts scream by, and
// the traffic below is felt only as light and shadow sliding over the lower floors.
//
// A preset of the `outdoor` composer (src/composer, README "Composers"), its rig lying on the road
// and pitched up toward the zenith: the crossroads (the facades, the World's sky staged over the strip
// between them, the airliners, the street's birds and the banner), the street tree and the tram wires
// as layers (layers.ts), everything analytic (shader.ts, no simulation). The sky and the weather are
// the World's: its rain streams out of the zenith, its snow too with 'snow from overhead'; its birds
// knobs fly the street's own birds, seen from below, so the World's level flights are compiled out
// wherever the crossroads stands.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import {
  SKYWARD_FLYWAY,
  SKYWARD_GRADE,
  SKYWARD_METEORS,
  SKYWARD_PASSAGE,
  SKYWARD_RIG,
} from "./constants.ts";

const preset: ScenePreset = {
  id: "skyward",
  composer: "outdoor",
  title: "Skyward",
  blurb:
    "Lying on your back at a crossroads: the buildings lean in, wires cross a strip of sky, pigeons wheel and a plane draws a line.",
  accent: "#ff8a4a",
  look: { color: "full", levels: 4 },
  // Lying down, the view tips back from street level up to the zenith and the facades swing into
  // their lean; leaving, you sit back up and it tips down toward the street (crossroadsBegin).
  passage: SKYWARD_PASSAGE,
  // In the sky's frame, turned half round from the street's (SKYWARD_SKY_YAW): high over the avenue.
  planets: { group: "sky", across: [-180, 177, 180], up: [50, 82, 90] },
  // A sunlit sky puts the page in its paper theme (ink dark on light); pagePaper() follows it.
  theme: (params) => skyTheme(params, { from: 0.33, to: 0.67, rainBelow: 0.2 }),
  rig: SKYWARD_RIG,
  grade: SKYWARD_GRADE,
  // An afternoon over the crossing, a few clouds; no Milky Way over the city's glow; the street's
  // pigeons and swifts by day.
  world: {
    time: 0.58,
    stars: 0.3,
    milkyWay: { on: false },
    clouds: 0.35,
    birds: {
      kind: "mixed",
      mixed: "the street's own: pigeons wheeling over the crossing in a loose chain, swifts looping high above them.",
      on: true,
      often: 0.5,
      help: "Birds over the crossroads seen from below, by day and in the golden hour, fewer in rain or snow: pigeons wheeling over the street and a few swifts higher up, or one kind flying both their paths (they keep to their paths, whatever the formation).",
    },
  },
  meteors: SKYWARD_METEORS,
  flyway: SKYWARD_FLYWAY,
  floor: "asphalt",
  layers: ["crossroads", "streetTree", "tramway"],
  // The gusts reach only the street tree, and off: it sways a little in the wind alone.
  values: { gusts: 0 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky in the strip between the roofs behind the city's glow: its stars and constellations, the moon's phase, its planets, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain comes down out of the strip of sky straight at you, streaks the glass and darkens the stone; snow drifts down, and settles on the ledges.",
    },
  },
};

/** Skyward composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const skywardComposed = composeScene(outdoor, preset);

const { featuresFor, featuresAllFor } = skywardComposed.def;

// The World's birds fly a level camera's view, so they are left out: the crossroads (the preset's one
// backdrop, which always stands) flies the street's own on the World's birds knobs, seen from below.
export const skywardScene: SceneDef = {
  ...skywardComposed.def,
  featuresFor: (values) => ({ ...featuresFor?.(values), WORLD_BIRDS: 0 }),
  featuresAllFor: (values) => ({ ...featuresAllFor?.(values), WORLD_BIRDS: 0 }),
  code: () => import("./code.ts"),
};
