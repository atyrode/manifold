// Valley: a prototype of the terrain toolbox (sims/terrain.ts, shaders/lib/terrain.ts). One map of
// a river valley carved by running water, seen from a hill at its corner: the river lying level in
// its bed and widening downstream, a village, hamlets, farms and a castle where people would build,
// roads between them over one bridge, fields hedged along the contours and woods on the steep and
// poor ground, under the shared sky, clouds and weather. Every landscape knob rebuilds the map over
// a few frames (the last one stays on screen meanwhile); woodland is the shader's alone.
import { range, seed, toggle } from "../../params.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { TERRAIN_MAX_SETTLEMENTS } from "../../sims/terrain.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { VALLEY_PASSAGE, valleyGlsl } from "./shader.ts";
import { valleySim } from "./sim.ts";

const params = [
  ...skyKnobs({ time: 0.68, stars: 0.5, moon: 1 }),
  ...weatherKnobs({
    clouds: 0.35,
    shadows: true,
    rain: true,
    snow: true,
    fog: true,
    wind: true,
  }),
  seed(
    "land",
    "landscape",
    "landscape",
    "The valley's layout: its hills, the river's course, where the settlements stand and how the roads and fields run. The same number always returns to the same valley.",
  ),
  range(
    "land",
    "relief",
    "relief",
    0.5,
    "How high and rugged the hills are, from gentle downs to steep valley sides. Rebuilds the valley.",
  ),
  range(
    "land",
    "erosion",
    "erosion",
    0.5,
    "How deeply running water has carved the hills: zero leaves the raw rolling relief, higher cuts branching side valleys and sharper spurs, and the slopes slump where they grow too steep. Rebuilds the valley.",
  ),
  range(
    "land",
    "woodland",
    "woodland",
    0.5,
    "How much woodland covers the steep and poor ground, from bare hills to a well-wooded valley. Woods keep off the river, roads and yards, and grow and shrink at their edges without moving anything else.",
    { step: 0.01 },
  ),
  range(
    "water",
    "river",
    "river size",
    0.5,
    "How broad the river is, from a brook to a wide river; it widens downstream as it gathers its side streams, and its floodplain widens with it. Its course stays where the valley takes it. Rebuilds the valley's river and what stands near it.",
  ),
  range(
    "settlements",
    "settlements",
    "settlements",
    5,
    "How many hamlets and farms stand beyond the village and the castle, each on open level ground (hamlets near water, the castle on a prominent hilltop), clear of the floodplain and kept apart. Rebuilds the settlements and roads.",
    { min: 0, max: TERRAIN_MAX_SETTLEMENTS, step: 1 },
  ),
  toggle(
    "settlements",
    "roads",
    "roads",
    true,
    "The roads between the settlements (tracks out to the farms), climbing no steeper than one in eight, cut into the hillsides, and the stone bridge where the network crosses the river.",
  ),
];

/** What the knobs compile in (SceneDef.featuresFor): each optional part only while it can show. */
export function valleyFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (key: string) => ((values[key] ?? 0) > 0 ? 1 : 0);
  return {
    VALLEY_HAS_ROADS: on("roads"),
    VALLEY_HAS_RAIN: on("rain"),
    VALLEY_HAS_SNOW: on("snow"),
    VALLEY_HAS_FOG: on("fog"),
    CLOUD_TIER: on("shadows") ? CLOUD_TIERS.shadows : CLOUD_TIERS.lit,
    ...((values.moon ?? 1) < 1 ? { SKY_MOON_PHASE: 1 } : {}),
  };
}

export const valleyScene: SceneDef = {
  id: "valley",
  title: "Valley",
  blurb: "A river valley carved by water, with a village, a castle and roads over a bridge.",
  // Lamplight in the windows.
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sky: atmosphereGroups.skyNight,
    weather: atmosphereGroups.weather,
    land: {
      title: "Land",
      blurb:
        "The valley's layout, how rugged its hills are, how deeply water has carved them, and how wooded they are.",
    },
    water: { title: "River", blurb: "How broad the river running down the valley is." },
    settlements: {
      title: "Settlements",
      blurb: "Hamlets and farms beyond the village and castle, and the roads between them.",
    },
  },
  glsl: valleyGlsl,
  entry: "sceneValley",
  sim: valleySim(params),
  // Enter: the camera comes down out of the sky and settles over the valley as the haze thins.
  // Exit: it rises back toward the clouds.
  passage: VALLEY_PASSAGE,
  featuresFor: valleyFeatures,
};
