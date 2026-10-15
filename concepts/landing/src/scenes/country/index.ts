// Countryside: one map of a river valley carved by running water (the terrain toolbox,
// sims/terrain.ts and shaders/lib/terrain.ts), seen from a hill at its corner: the river lying level
// in its bed and widening downstream, a village, hamlets, farms and a castle where people would
// build, roads between them over one bridge, and every parcel of land given over to one use by the
// land model (sims/landuse.ts): crops, flower fields, pasture with its herd, woodland, or open
// grassland. Under the shared sky, clouds and weather.
//
// Knobs and what they rebuild (sim.ts): the land's shape, seed, relief and erosion rebuild the map
// over a few frames (the last one stays on screen meanwhile); the river's size the river and what
// stands near it; the settlements and roads only those and the parcels; the land's uses, the pine
// mix and the cattle share only the allocation, packed and uploaded within the frame; the river
// switched off only dries its bed. Herds' size, walkers, carts and birds are the shader's alone,
// each compiled in only while on (countryFeatures).
import type { IconName } from "../../lab/icons.ts";
import { counts, choice, feature, range, seed, toggle } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { TERRAIN_BASES, TERRAIN_MAX_COTTAGES, TERRAIN_MAX_FARMS } from "../../sims/terrain.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { COUNTRY_PASSAGE, countryGlsl } from "./shader.ts";
import { countrySim } from "./sim.ts";

/** One part of the land's uses: a relative share (the lab's "land use" bar), switched on or off. */
const landUse = (
  key: string,
  on: boolean,
  share: number,
  swatch: string,
  help: string,
  icon?: IconName,
) =>
  feature("land", key, key, on, "share", share, help, {
    min: 0,
    max: 100,
    step: 1,
    widget: { kind: "mix", mix: "land use", part: key, swatch },
    ...(icon === undefined ? {} : { icon }),
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
    "terrain",
    "shape",
    "land shape",
    TERRAIN_BASES.map((label, value) => ({ label, value })),
    0,
    "The relief the land is carved from: a river valley between hills; a coast, where the valley opens downstream into a bay of the sea; a plateau, a high table with the river in a steep-sided gorge; or rolling hills all round. Rebuilds the land.",
  ),
  seed(
    "terrain",
    "landscape",
    "landscape",
    "The land's layout: its hills, the river's course, where the settlements stand, how the roads run and how the land is parcelled. The same number always returns to the same countryside.",
  ),
  range(
    "terrain",
    "relief",
    "relief",
    0.5,
    "How high and rugged the hills are, from gentle downs to steep valley sides. Rebuilds the land.",
  ),
  range(
    "terrain",
    "erosion",
    "erosion",
    0.5,
    "How deeply running water has carved the hills: zero leaves the raw rolling relief, higher cuts branching side valleys and sharper spurs, and the slopes slump where they grow too steep. Rebuilds the land.",
  ),
  landUse(
    "crops",
    true,
    60,
    "#c8a05a",
    "Arable and hay fields, hedged: wheat, barley, rapeseed, hay meadows, grazing and the plough, each field's crop chosen by its ground (hay and grazing on the floodplain and the steep slopes). Shares are relative: crops 60 and woodland 30 give crops two parcels of land for each wooded one. The flattest, lowest ground near the roads and settlements is the crops' first.",
    "fields",
  ),
  landUse(
    "woodland",
    true,
    30,
    "#4a7a3a",
    "Woods on the steep, high and poor ground first, growing outward from it as the share rises and giving way at their edges as it falls, whole parcels at a time; nothing else moves. Woods keep off the river, the roads and the yards, and leave the slopes under the vantage open. Off, it also fells the lone trees in the hedges and on the river's banks.",
  ),
  landUse(
    "pasture",
    false,
    25,
    "#6fae5c",
    "Fenced pasture enclosures, each with a herd of cattle or sheep grazing in its clear middle: by the river and the streams first, on ground too wet or rolling to plough.",
    "fence",
  ),
  landUse(
    "wildflowers",
    false,
    20,
    "#e0719e",
    "Wildflower meadows, on moderate slopes, in wet hollows and away from the roads first.",
  ),
  landUse(
    "lavender",
    false,
    20,
    "#9b86d6",
    "Lavender in rows, on sunny, dry, well-drained slopes first.",
    "flower",
  ),
  landUse(
    "sunflowers",
    false,
    20,
    "#f2c41d",
    "Sunflower fields, on flat, sunny, low ground first.",
    "flower",
  ),
  range(
    "land",
    "pines",
    "pine mix",
    0.25,
    "The share of the woods that are evergreen pine plantations with tiered boughs rather than broadleaf woods: pine on the high, steep, north-facing ground first. A wood keeps its species as the woods grow; the hedgerow trees take the same mix.",
    { step: 0.01, when: "woodland" },
  ),
  range(
    "land",
    "cows",
    "cattle share",
    0.5,
    "The share of the pastures grazed by cattle (Friesians, Herefords or Angus) rather than sheep, cattle on the low, flat, wet ground first. Each enclosure keeps one kind; a change swaps only as many herds as it must.",
    { step: 0.05, when: "pasture" },
  ),
  range(
    "land",
    "herd",
    "herd size",
    0.5,
    "How many animals graze each enclosure, as many as its open ground has room for: zero empties them, 50% is three to seven cattle or five to nine sheep, 100% about twice that (at most fourteen). They graze, wander, lie down in the warm afternoon and at night, and bunch up standing in rain and snow, never leaving their field.",
    { step: 0.05, when: "pasture" },
  ),
  feature(
    "water",
    "river",
    "river",
    true,
    "size",
    0.5,
    "The river down the valley, from a brook to a wide river; it widens downstream as it gathers its side streams, and its floodplain widens with it. Its course stays where the valley takes it; a new size rebuilds the river and what stands near it. Off, the river and its streams run dry: the carved bed, its banks and the bridge stay.",
    { min: 0, max: 1, step: 0.01 },
  ),
  feature(
    "settlements",
    "village",
    "village",
    true,
    "cottages",
    11,
    "The village round its church. More cottages line its roads outward from the church, each new one beyond the last, so none moves as it grows. Rebuilds the settlements and roads.",
    { min: 1, max: TERRAIN_MAX_COTTAGES, step: 1 },
  ),
  feature(
    "settlements",
    "hamlets",
    "hamlets",
    true,
    "hamlets",
    2,
    "Clusters of three to five cottages on open level ground near water, in sight from the hill. Each keeps its place as others come and go. Rebuilds the settlements and roads.",
    { options: counts(1, 2, 3) },
  ),
  feature(
    "settlements",
    "farms",
    "farms",
    true,
    "farms",
    3,
    "Farmsteads among the fields, a farmhouse and a barn at the end of a farm track. More adds farms without moving the others. Rebuilds the settlements and roads.",
    { min: 1, max: TERRAIN_MAX_FARMS, step: 1 },
  ),
  toggle(
    "settlements",
    "castle",
    "castle",
    true,
    "A castle on a prominent hilltop in sight from the vantage, its walls and keep against the sky. Rebuilds the settlements and roads; the hilltop stays its own either way.",
  ),
  toggle(
    "settlements",
    "roads",
    "roads",
    true,
    "The roads joining the village, hamlets and castle, and one out over the far side, climbing no steeper than one in eight, cut into the hillsides, over the stone bridge where they cross the river. Rebuilds the settlements and roads.",
  ),
  toggle(
    "settlements",
    "tracks",
    "farm tracks",
    true,
    "Tracks out to the farms and down through the near field. Rebuilds the settlements and roads.",
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
 * the default countryside's program carries none of the flower fields, herds, figures or birds.
 */
export function countryFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (...keys: string[]) => (keys.some((key) => (values[key] ?? 0) > 0) ? 1 : 0);
  return {
    // The roads' and tracks' surfaces and the bridge.
    COUNTRY_HAS_ROADS: on("roads", "tracks"),
    COUNTRY_HAS_RAIN: on("rain"),
    COUNTRY_HAS_SNOW: on("snow"),
    COUNTRY_HAS_FOG: on("fog"),
    // Pine woods and hedgerow pines: only with woods and a pine mix.
    COUNTRY_HAS_PINES: Math.min(on("pines"), on("woodland")),
    // The flower fields' materials (the shared fields).
    COUNTRY_HAS_FIELDS: on("wildflowers", "lavender", "sunflowers"),
    // The pastures' fences and herds (the shared livestock).
    COUNTRY_HAS_HERDS: on("pasture"),
    COUNTRY_HAS_AGENTS: on("walkers", "carts"),
    COUNTRY_HAS_BIRDS: on("birds"),
    CLOUD_TIER: on("shadows") ? CLOUD_TIERS.shadows : CLOUD_TIERS.lit,
    ...((values.moon ?? 1) < 1 ? { SKY_MOON_PHASE: 1 } : {}),
  };
}

/**
 * Every optional part compiled in (SceneDef.featuresAll): each part's runtime test of its knobs
 * decides, so this program draws every setting as that setting's own program does.
 */
export const COUNTRY_ALL = countryFeatures({
  roads: 1,
  rain: 1,
  snow: 1,
  fog: 1,
  pines: 1,
  woodland: 1,
  wildflowers: 1,
  pasture: 1,
  walkers: 1,
  birds: 1,
  shadows: 1,
  moon: 0.5,
});

export const countryScene: SceneDef = {
  id: "country",
  title: "Countryside",
  blurb:
    "A river valley carved by water: fields, woods and pastures, a village, a castle and roads over a bridge.",
  // Lamplight in the windows.
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sky: atmosphereGroups.skyNight,
    weather: atmosphereGroups.weather,
    terrain: {
      title: "Lie of the land",
      blurb: "The valley's layout, how rugged its hills are and how deeply water has carved them.",
      icon: "mountain",
    },
    land: {
      title: "Land use",
      blurb:
        "What each parcel of land is given over to, by relative shares: each use takes the ground that suits it best first, and a change of one share moves only that use's edge. All off leaves open grassland.",
      icon: "fields",
    },
    water: { title: "River", blurb: "The river running down the valley, and how broad it is." },
    settlements: {
      title: "Settlements",
      blurb:
        "The village, hamlets, farms and castle, and the roads and farm tracks between them; a change lays them out again without moving the hills or the river.",
    },
    activity: {
      title: "People & carts",
      blurb: "Walkers and carts going up and down the roads; they stand still while motion is off.",
    },
    birds: birdsGroup,
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  sim: countrySim(params),
  // Enter: the camera comes down out of the sky and settles over the valley as the haze thins.
  // Exit: it rises back toward the clouds.
  passage: COUNTRY_PASSAGE,
  featuresFor: countryFeatures,
  featuresAll: COUNTRY_ALL,
};
