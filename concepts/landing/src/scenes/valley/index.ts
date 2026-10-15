// Valley: a prototype of the terrain toolbox (sims/terrain.ts, shaders/lib/terrain.ts). One map of
// a river valley carved by running water, seen from a hill at its corner: the river lying level in
// its bed and widening downstream, a village, hamlets, farms and a castle where people would build,
// roads between them over one bridge, fields hedged along the contours and woods on the steep and
// poor ground, under the shared sky, clouds and weather. Every landscape knob rebuilds the map over
// a few frames (the last one stays on screen meanwhile); woodland, the fields' mix, herds, walkers,
// carts and birds are the shader's alone, each compiled in only while on (valleyFeatures).
import { counts, choice, feature, range, seed, toggle } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { TERRAIN_BASES, TERRAIN_MAX_SETTLEMENTS } from "../../sims/terrain.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { VALLEY_PASSAGE, valleyGlsl } from "./shader.ts";
import { valleySim } from "./sim.ts";

/** A field type's relative weight (the shared fields' mix, as the countryside's). */
const fieldWeight = (key: string, label: string, value: number, swatch: string, help: string) =>
  range("fields", key, `${label} weight`, value, help, {
    max: 100,
    step: 1,
    widget: { kind: "mix", mix: "field types", part: label, swatch },
  });

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
  choice(
    "land",
    "shape",
    "land shape",
    TERRAIN_BASES.map((label, value) => ({ label, value })),
    0,
    "The relief the valley is carved from: a river valley between hills; a coast, where the valley opens downstream into a bay of the sea; a plateau, a high table with the river in a steep-sided gorge; or rolling hills all round. Rebuilds the valley.",
  ),
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
    "woodland",
    "woodland",
    "woodland cover",
    0.5,
    "How much woodland covers the steep and poor ground, from bare hills to a well-wooded valley. Woods keep off the river, roads and yards, and grow and shrink at their edges, whole trees at a time, without moving anything else; zero also fells the lone trees in the hedges.",
    { step: 0.01 },
  ),
  range(
    "woodland",
    "pines",
    "pine mix",
    0.25,
    "The share of the trees, in the woods and the hedges alike, that are evergreen pines with tiered boughs rather than broadleaf crowns; the trees stand where they stood.",
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
  fieldWeight(
    "crops",
    "crops",
    100,
    "#c8a05a",
    "Relative weight of the valley's own farming (wheat, barley, rapeseed, hay, grazing, the plough) among all fields. Weights are relative: 2 crops and 1 wildflowers gives about two crop fields for each flower field. Zero excludes a type; all zero restores crops. Fields keep their borders whatever they grow.",
  ),
  fieldWeight(
    "wildflowers",
    "wildflowers",
    0,
    "#e0719e",
    "Relative weight of colourful wildflower meadows among all fields; zero excludes them.",
  ),
  fieldWeight(
    "lavender",
    "lavender",
    0,
    "#9b86d6",
    "Relative weight of purple lavender-row fields among all fields; zero excludes them.",
  ),
  fieldWeight(
    "sunflowers",
    "sunflowers",
    0,
    "#f2c41d",
    "Relative weight of golden sunflower fields among all fields; zero excludes them.",
  ),
  fieldWeight(
    "pasture",
    "pasture",
    0,
    "#6fae5c",
    "Relative weight of fenced pasture enclosures among all fields, each with a herd of cattle or sheep grazing well inside its fence; zero excludes them.",
  ),
  range(
    "livestock",
    "cows",
    "cattle share",
    0.5,
    "The share of pasture enclosures (fields: pasture weight) grazed by cattle (Friesians, Herefords or Angus) rather than sheep. Each enclosure keeps one kind.",
    { step: 0.05 },
  ),
  range(
    "livestock",
    "herd",
    "herd size",
    0.5,
    "How many animals graze each enclosure, as many as its open ground has room for: zero empties them, 50% is three to seven cattle or five to nine sheep, 100% about twice that (at most fourteen). They graze, wander, lie down in the warm afternoon and at night, and bunch up standing in rain and snow, never leaving their field.",
    { step: 0.05 },
  ),
  feature(
    "activity",
    "walkers",
    "walkers",
    false,
    "busy",
    0.5,
    "People out walking the roads and tracks, from one party to six as it gets busier, more of them in twos and threes; half of them stop now and then to take in the view, and some carry lanterns after dark. They keep to the roads and cross the river by the bridge.",
    { step: 0.05 },
  ),
  feature(
    "activity",
    "carts",
    "carts",
    false,
    "carts",
    2,
    "Horses and carts and tractors with trailers going up and down the roads and tracks, lamps lit after dark.",
    { options: counts(1, 2, 3) },
  ),
  ...birdKnobs({
    kind: "mixed",
    mixed:
      "mostly rooks in loose parties, gulls up from the river, swallows low over the fields, now and then geese, pigeons, swifts or a buzzard circling on a thermal.",
    help: "Birds crossing the valley by day, hidden by the hills, trees and buildings nearer than them; none at night and fewer in snow and rain.",
  }),
];

/**
 * What the knobs compile in (SceneDef.featuresFor): each optional part only while it can show, so
 * the default valley's program carries none of the fields' mix, herds, figures or birds.
 */
export function valleyFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (...keys: string[]) => (keys.some((key) => (values[key] ?? 0) > 0) ? 1 : 0);
  return {
    VALLEY_HAS_ROADS: on("roads"),
    VALLEY_HAS_RAIN: on("rain"),
    VALLEY_HAS_SNOW: on("snow"),
    VALLEY_HAS_FOG: on("fog"),
    VALLEY_HAS_PINES: on("pines"),
    // Flower and pasture fields (the shared fields' mix); the herds and fences in the pastures.
    VALLEY_HAS_FIELDS: on("wildflowers", "lavender", "sunflowers", "pasture"),
    VALLEY_HAS_HERDS: on("pasture"),
    VALLEY_HAS_AGENTS: on("walkers", "carts"),
    VALLEY_HAS_BIRDS: on("birds"),
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
      blurb: "The valley's layout, how rugged its hills are and how deeply water has carved them.",
    },
    woodland: {
      title: "Woodland",
      blurb: "How much of the valley is wooded, and how many of its trees are evergreen pines.",
    },
    water: { title: "River", blurb: "How broad the river running down the valley is." },
    settlements: {
      title: "Settlements",
      blurb: "Hamlets and farms beyond the village and castle, and the roads between them.",
    },
    fields: {
      title: "Fields",
      blurb:
        "Mix the valley's crops with flower fields and pasture enclosures by relative weights; every field keeps its borders. Zero excludes a type; all zero is crops.",
    },
    livestock: {
      title: "Livestock",
      blurb:
        "The herds in the pasture enclosures (fields: pasture weight): cattle or sheep, and how many graze each.",
    },
    activity: {
      title: "People & carts",
      blurb: "Walkers and carts going up and down the roads; they stand still while motion is off.",
    },
    birds: birdsGroup,
  },
  glsl: valleyGlsl,
  entry: "sceneValley",
  sim: valleySim(params),
  // Enter: the camera comes down out of the sky and settles over the valley as the haze thins.
  // Exit: it rises back toward the clouds.
  passage: VALLEY_PASSAGE,
  featuresFor: valleyFeatures,
};
