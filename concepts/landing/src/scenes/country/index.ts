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
// mix, the cattle share and the chalk M (which keeps the woods and fields off its hillside) only the
// allocation, packed and uploaded within the frame (the woodland share the woods' line, and the few
// parcels it turns into woods or back); the river switched off only dries its bed.
// Herds' size, walkers, carts, birds, the time of year (the date, carried round while the year
// passes: the crops, grass, hedges and trees through the farming year, the harvest's bales, and the
// climate that turns a winter's rain to snow; season.ts), the river's wind ripples, the lit windows
// and the chimney smoke are the shader's alone, but for the verges' year. Each optional part is
// compiled in only while on (countryFeatures). The verges at the hedges' foot (verges.ts) and the
// starling murmuration at dusk (murmuration.ts) are compiled in only while on too; the sim grows
// their plants and flies their flock then, packed beside the terrain's records (atlas.ts).
import {
  climateCold,
  fallingRain,
  fallingSnow,
  seasonKnob,
  yearAt,
  YEAR_CYCLE_RATE,
} from "../../climate.ts";
import type { IconName } from "../../lab/icons.ts";
import { counts, choice, feature, range, seed, toggle } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import {
  TERRAIN_BASES,
  TERRAIN_MAX_COTTAGES,
  TERRAIN_MAX_FARMS,
} from "../../sims/terrain-limits.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import {
  COUNTRY_BALES,
  COUNTRY_PASSAGE,
  COUNTRY_SEASONS,
  countryMurmurationKnob,
  countryVergesKnob,
} from "./constants.ts";

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
  ...skyKnobs({
    time: 0.68,
    stars: 0.5,
    moon: 1,
    constellations: true,
  }),
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
    "Arable and hay fields, hedged: wheat, barley, rapeseed, hay meadows, grazing and the plough, each field's crop chosen by its ground (hay and grazing on the floodplain and the steep slopes). Shares are relative: crops 60 and woodland 30 give crops twice the land the woods take. The flattest, lowest ground near the roads and settlements is the crops' first.",
    "fields",
  ),
  landUse(
    "woodland",
    true,
    30,
    "#4a7a3a",
    "Woods as a layer of their own, the wildwood the fields were cleared from: on the steep, high ground far from the settlements first, with shaws along the streams and copses between, growing outward as the share rises and giving way at their edges as it falls. A field they reach into keeps its use and loses that corner; one they all but cover becomes a wood. Woods keep off the river, the streams, the roads and the yards, wherever the hill looks. Off, it also fells the lone trees in the hedges and on the river's banks.",
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
    0.3,
    "The share of the grazing land given to cattle (Friesians, Herefords or Angus) rather than sheep, cattle on the low, flat, wet ground first. Each enclosure keeps its kind whatever the other shares do; raising this turns only sheep to cattle, lowering it only cattle to sheep.",
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
    "A castle on a prominent hilltop in sight from the vantage: battlemented curtain walls with a round tower at each corner, a gatehouse, a keep with its turret and a hall, a few windows lit after dark. The woods clear round it. Rebuilds the settlements and roads; the hilltop stays its own either way.",
  ),
  toggle(
    "settlements",
    "roads",
    "roads",
    true,
    "The roads joining the village, hamlets and castle, and one out over the far side, climbing no steeper than one in eight, cut into the hillsides, over the stone bridge where they cross the river. Off, the village keeps its own street, so no cottage moves. Rebuilds the settlements and roads.",
  ),
  toggle(
    "settlements",
    "tracks",
    "farm tracks",
    true,
    "Tracks out to the farms and down through the near field. Off, the village keeps their stretch through it as its own lane, so no cottage moves. Rebuilds the settlements and roads.",
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
  countryVergesKnob,
  countryMurmurationKnob,
  range(
    "land",
    "date",
    "time of year",
    COUNTRY_SEASONS.harvest,
    "Where the farming year stands, round from the start of spring; each field keeps its crop and shows it as the year has it, every field on dates of its own. Spring: the spring crops drilled into bare earth and coming up in green rows, the rapeseed leafy and then yellow in flower, the grass fresh, the hedges white with may and the broadleaf trees leafing out. Summer: green wheat and barley, the rapeseed in flower, the hay standing. Harvest: golden wheat, the barley and rapeseed cut to stubble and the barley's straw in round bales. Autumn: ploughed earth and winter wheat drilled in green rows, the grass duller, the hedges russet and the broadleaf trees on the turn, each its own colour, while the pines stay evergreen; the flower fields gone over. Winter: the broadleaf trees and hedges bare, the winter wheat green in its rows on dark ploughland, the grass dull and pale, and in its depth snow lying of itself and rain falling as snow.",
    {
      step: 0.005,
      icon: "leaf",
      widget: { kind: "sky", part: "season", year: { span: [0, 1] } },
    },
  ),
  feature(
    "land",
    "year",
    "the year passes",
    false,
    "minutes per season",
    2,
    "The farming year turns on from the time of year at this pace, round and round: the land greens, ripens, is harvested, ploughed and drilled, turns and goes bare, field by field, and the climate follows (winter's snow lies and its rain falls as snow).",
    { min: 0.5, max: 10, step: 0.5, widget: { kind: "sky", part: "year" }, rate: YEAR_CYCLE_RATE },
  ),
  range(
    "water",
    "ripples",
    "wind ripples",
    0,
    "Zero: the river's own gentle shimmer of the sky. Higher lets the wind (under Weather) ruffle it: cat's-paws drift downwind and break the mirrored sky into streaks, more of them the harder it blows.",
    { step: 0.05, when: "river" },
  ),
  feature(
    "settlements",
    "lights",
    "village lights",
    true,
    "windows lit",
    0.7,
    "Windows light up one by one as dusk falls, in the village, the hamlets, the farmhouses and the castle, and most go dark late at night; lit ones warm the walls and the ground around. The amount is the share of windows that ever light, the church's and the castle's half that.",
  ),
  feature(
    "settlements",
    "smoke",
    "chimney smoke",
    true,
    "amount",
    0.5,
    "Smoke curling up from the cottages' chimneys and leaning with the wind, thicker as the evening draws in.",
  ),
  toggle(
    "manifold",
    "chalk",
    "chalk M",
    false,
    "A giant M cut into the turf of a hillside facing the hill, in the manner of the Uffington White Horse: on the open slope that shows it best from here, clear of the woods, roads, yards and water, drawn out up the slope so it reads whole. The woods and fields there give way to open downland. None where no such slope is in sight.",
  ),
];

/**
 * What the knobs compile in (SceneDef.featuresFor): each optional part only while it can show, so
 * the default countryside's program carries none of the flower fields, herds, figures or birds.
 * Rain and snow fall as the climate makes them of the knobs (src/climate.ts) at the date, or at any
 * time of year while the year passes; so do the bales lie.
 */
export function countryFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (...keys: string[]) => (keys.some((key) => (values[key] ?? 0) > 0) ? 1 : 0);
  const season = seasonKnob(params);
  const date = season
    ? yearAt(season, values[season.key] ?? season.value)
    : COUNTRY_SEASONS.harvest;
  const passing = (values.year ?? 0) > 0;
  // The least and most cold the land can show, a little wider than the date's own so that a
  // float's rounding on the GPU never lets fall what the gate left out.
  const cold = climateCold(date);
  const least = passing ? 0 : Math.max(0, cold - 0.01);
  const most = passing ? 1 : Math.min(1, cold + 0.01);
  const rain = values.rain ?? 0;
  const snow = values.snow ?? 0;
  return {
    // The roads' and tracks' surfaces and the bridge, and the village's own streets, which stay
    // with both off.
    COUNTRY_HAS_ROADS: on("roads", "tracks", "village"),
    COUNTRY_HAS_RAIN: fallingRain(rain, least) > 0 ? 1 : 0,
    COUNTRY_HAS_SNOW: fallingSnow(rain, snow, most) > 0 ? 1 : 0,
    COUNTRY_HAS_FOG: on("fog"),
    // Pine woods and hedgerow pines: only with woods and a pine mix.
    COUNTRY_HAS_PINES: Math.min(on("pines"), on("woodland")),
    // The flower fields' materials (the shared fields).
    COUNTRY_HAS_FIELDS: on("wildflowers", "lavender", "sunflowers"),
    // The pastures' fences and herds (the shared livestock).
    COUNTRY_HAS_HERDS: on("pasture"),
    // Walkers and carts on the roads, and the lying snow they tread there.
    COUNTRY_HAS_AGENTS: on("walkers", "carts"),
    COUNTRY_HAS_BIRDS: on("birds"),
    // The clumps at the hedges' foot (verges.ts) and the starlings at dusk (murmuration.ts).
    COUNTRY_HAS_VERGES: on("verges"),
    COUNTRY_HAS_MURMURATION: on("murmuration"),
    // Round bales on the barley's stubble: from its cut until they are carted away, with crops.
    COUNTRY_HAS_BALES:
      passing || (date >= COUNTRY_BALES[0] && date < COUNTRY_BALES[1]) ? on("crops") : 0,
    // The river's wind ripples: the shared water's ripples tier, only while they are up.
    WATER_TIER: on("ripples") ? WATER_TIERS.ripples : WATER_TIERS.flat,
    // Lit windows and their glow, chimney smoke (buildings.ts).
    COUNTRY_HAS_LIGHTS: on("lights"),
    COUNTRY_HAS_SMOKE: on("smoke"),
    // The chalk M on its hillside (chalk.ts).
    COUNTRY_HAS_CHALK: on("chalk"),
    CLOUD_TIER: on("shadows") ? CLOUD_TIERS.shadows : CLOUD_TIERS.lit,
    ...((values.moon ?? 1) !== 1 ? { SKY_MOON_PHASE: 1 } : {}),
  };
}

/**
 * Every optional part compiled in (SceneDef.featuresAll): each part's runtime test of its knobs
 * decides, so this program draws every setting as that setting's own program does.
 */
export const COUNTRY_ALL = countryFeatures({
  roads: 1,
  crops: 1,
  year: 1,
  ripples: 1,
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
  lights: 1,
  smoke: 1,
  chalk: 1,
  moon: 0.5,
  verges: 1,
  murmuration: 1,
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
  planets: { group: "sky", across: [-33, 14, 33], up: [0, 8, 16] },
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
        "The village, hamlets, farms and castle, the roads and farm tracks between them, and their lit windows and chimney smoke; a change of where they stand lays them out again without moving the hills or the river.",
    },
    activity: {
      title: "People & carts",
      blurb: "Walkers and carts going up and down the roads; they stand still while motion is off.",
    },
    birds: {
      ...birdsGroup,
      blurb: "Flights of birds crossing the valley by day, and a starling murmuration at dusk.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A chalk figure of the M, cut into the turf of a hillside.",
    },
  },
  code: () => import("./code.ts"),
  // Enter: the camera comes down out of the sky and settles over the valley as the haze thins.
  // Exit: it rises back toward the clouds.
  passage: COUNTRY_PASSAGE,
  featuresFor: countryFeatures,
  featuresAll: COUNTRY_ALL,
};
