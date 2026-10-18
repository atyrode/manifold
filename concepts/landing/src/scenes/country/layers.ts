// The Countryside preset's layers (ADR 0062 Phase 2c): their manifests, which load without their
// code (shader.ts, sim.ts). The countryside is one ray march over one land, built on the worker from
// every knob of the land's shape, uses and settlements at once (sim.ts): so its code is one chunk the
// composer compiles in once (composer/outdoor-code.ts COUNTRY), the valley draws every part of it in
// its passes, and each other layer is a switch and its knobs, whose part the valley's march and its
// land model take while it is on (its LAYER_ gate; VALLEY_* in shader.ts, valleyValue here):
//   valley       backdrop: the land carved by running water (its shape, relief and erosion) under the
//                World's sky, the far ridges staged over it; the valley fog (the World's fog knob);
//                the ring of hills beyond the map; the farming year (the composer's `season`, and
//                `year` carrying it round). Drawn through the hill's rig and the bees garden's: from
//                the garden the valley lies beyond the lawn's hedge (x.groundTo), the garden a
//                terrace on the vantage's hilltop. Where it stands without the countryside's other
//                layers it shows their parts as the countryside opens them (valleyValue).
//   waterway     dressing: the river down the valley and its streams (off, they run dry: the bed, its
//                banks and the bridge stay), its wind ripples.
//   farmland     ground: every parcel given its use by the land model (crops through the year,
//                flower fields, fenced pastures, the woods and their pines, open grassland), the hedges
//                between them, the round bales; the chalk M (the countryside's Manifold M).
//   settlements  dressing: the village, hamlets, farms and castle, the roads and tracks between them
//                and the bridge, their lit windows and chimney smoke.
//   verges       cover: the clumps of cow parsley, campion and grass at the hedges' foot.
//   herds        life: the cattle and sheep grazing each pasture.
//   travellers   life: the walkers and carts on the roads.
//   starlings    life: the murmuration over the far fields at dusk.
// Every layer but the valley is drawn through the hill's rig alone.
import { layerGate } from "../../composer/compose.ts";
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { seasonKnob, yearAt, YEAR_CYCLE_RATE } from "../../climate.ts";
import type { IconName } from "../../lab/icons.ts";
import { choice, counts, effective, feature, range, toggle, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import {
  TERRAIN_BASES,
  TERRAIN_MAX_COTTAGES,
  TERRAIN_MAX_FARMS,
} from "../../sims/terrain-limits.ts";
import { BEES_RIG } from "../bees/constants.ts";
import {
  COUNTRY_BALES,
  COUNTRY_DATA,
  COUNTRY_RIG,
  COUNTRY_SEASONS,
  countryStarlingsKnob,
  countryVergesKnob,
} from "./constants.ts";

/** The hill's rig alone. */
const ON_THE_HILL: CameraRange = {
  eye: [COUNTRY_RIG.eye, COUNTRY_RIG.eye],
  horizon: [COUNTRY_RIG.horizon, COUNTRY_RIG.horizon],
  focal: [COUNTRY_RIG.focal, COUNTRY_RIG.focal],
  pitch: [COUNTRY_RIG.pitch, COUNTRY_RIG.pitch],
};

/** The valley's rigs: the hill's, and the bees garden's (its lawn on the vantage's hilltop). */
const OVER_THE_VALLEY: CameraRange = {
  eye: [BEES_RIG.eye, COUNTRY_RIG.eye],
  horizon: [BEES_RIG.horizon, COUNTRY_RIG.horizon],
  focal: [BEES_RIG.focal, COUNTRY_RIG.focal],
  pitch: [0, 0],
};

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

/**
 * Where the farming year stands: the time of year every country layer shows, the composer's
 * `season` (the old `date`), and the World's climate with it.
 */
const SEASON = range(
  "sky",
  "season",
  "time of year",
  COUNTRY_SEASONS.harvest,
  "Where the farming year stands, round from the start of spring; each field keeps its crop and shows it as the year has it, every field on dates of its own. Spring: the spring crops drilled into bare earth and coming up in green rows, the rapeseed leafy and then yellow in flower, the grass fresh, the hedges white with may and the broadleaf trees leafing out. Summer: green wheat and barley, the rapeseed in flower, the hay standing. Harvest: golden wheat, the barley and rapeseed cut to stubble and the barley's straw in round bales. Autumn: ploughed earth and winter wheat drilled in green rows, the grass duller, the hedges russet and the broadleaf trees on the turn, each its own colour, while the pines stay evergreen; the flower fields gone over. Winter: the broadleaf trees and hedges bare, the winter wheat green in its rows on dark ploughland, the grass dull and pale, and in its depth snow lying of itself and rain falling as snow.",
  {
    step: 0.005,
    icon: "leaf",
    widget: { kind: "sky", part: "season", year: { span: [0, 1] } },
  },
);

export const valleyLayer: LayerDef = {
  id: "valley",
  title: "Valley",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: OVER_THE_VALLEY,
  switch: toggle(
    "layers",
    "valley",
    "valley",
    false,
    "A river valley carved by running water, seen from a hill at its corner: its hills, woods and fields, the village and the castle, the river lying level in its bed; under the World's sky, with far ridges round it and a ring of hills beyond.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "terrain",
      "shape",
      "land shape",
      TERRAIN_BASES.map((label, value) => ({ label, value })),
      0,
      "The relief the land is carved from: a river valley between hills; a coast, where the valley opens downstream into a bay of the sea; a plateau, a high table with the river in a steep-sided gorge; or rolling hills all round. Rebuilds the land.",
    ),
    range(
      "terrain",
      "valleyRelief",
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
    feature(
      "sky",
      "year",
      "the year passes",
      false,
      "minutes per season",
      2,
      "The farming year turns on from the time of year at this pace, round and round: the land greens, ripens, is harvested, ploughed and drilled, turns and goes bare, field by field, and the climate follows (winter's snow lies and its rain falls as snow).",
      { min: 0.5, max: 10, step: 0.5, widget: { kind: "sky", part: "year" }, rate: YEAR_CYCLE_RATE },
    ),
  ],
  season: SEASON,
  groups: {
    terrain: {
      title: "Lie of the land",
      blurb:
        "The valley's layout (the arrangement under Layers), how rugged its hills are and how deeply water has carved them.",
      icon: "mountain",
    },
  },
  data: COUNTRY_DATA.valley,
  featuresFor: (values) => valleyFeatures(values),
  featuresAll: {
    COUNTRY_HAS_ROADS: 1,
    COUNTRY_HAS_FOG: 1,
    COUNTRY_HAS_PINES: 1,
    COUNTRY_HAS_FIELDS: 1,
    COUNTRY_HAS_HERDS: 1,
    COUNTRY_HAS_AGENTS: 1,
    COUNTRY_HAS_BALES: 1,
    WATER_TIER: WATER_TIERS.ripples,
    COUNTRY_HAS_LIGHTS: 1,
    COUNTRY_HAS_SMOKE: 1,
    COUNTRY_HAS_CHALK: 1,
  },
  passes: {
    begin: "valleyBegin",
    sky: "valleySky",
    far: "valleyFar",
    air: "valleyAir",
    shade: "valleyShade",
  },
};

export const waterwayLayer: LayerDef = {
  id: "waterway",
  title: "River",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: feature(
    "water",
    "waterway",
    "river",
    false,
    "size",
    0.5,
    "The river down the valley, from a brook to a wide river; it widens downstream as it gathers its side streams, and its floodplain widens with it. Its course stays where the valley takes it; a new size rebuilds the river and what stands near it. Off, the river and its streams run dry: the carved bed, its banks and the bridge stay.",
    { min: 0, max: 1, step: 0.01, icon: "waves" },
  ),
  params: [
    range(
      "water",
      "waterwayRipples",
      "wind ripples",
      0,
      "Zero: the river's own gentle shimmer of the sky. Higher lets the wind (under Wind) ruffle it: cat's-paws drift downwind and break the mirrored sky into streaks, more of them the harder it blows.",
      { step: 0.05 },
    ),
  ],
  groups: {
    water: { title: "River", blurb: "The river running down the valley, and how broad it is." },
  },
  requires: ["valley"],
  passes: {},
};

export const farmlandLayer: LayerDef = {
  id: "farmland",
  title: "Farmland",
  composers: ["outdoor"],
  role: "ground",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: toggle(
    "layers",
    "farmland",
    "farmland",
    false,
    "Every parcel of the valley given over to one use: crops through the farming year, flower fields, fenced pastures, woods, or open grassland, hedged where farmed fields meet. Off, the valley lies open grassland.",
    { icon: "fields" },
  ),
  params: [
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
      "Fenced pasture enclosures, each with a herd of cattle or sheep grazing in its clear middle (Herds): by the river and the streams first, on ground too wet or rolling to plough.",
      "fence",
    ),
    landUse(
      "farmlandWildflowers",
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
      "farmlandPines",
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
    toggle(
      "manifold",
      "chalk",
      "chalk M",
      false,
      "A giant M cut into the turf of a hillside facing the hill, in the manner of the Uffington White Horse: on the open slope that shows it best from here, clear of the woods, roads, yards and water, drawn out up the slope so it reads whole. The woods and fields there give way to open downland. None where no such slope is in sight.",
    ),
  ],
  groups: {
    land: {
      title: "Land use",
      blurb:
        "What each parcel of land is given over to, by relative shares: each use takes the ground that suits it best first, and a change of one share moves only that use's edge. All off leaves open grassland.",
      icon: "fields",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A chalk figure of the M, cut into the turf of a hillside.",
    },
  },
  mark: "chalk",
  requires: ["valley"],
  passes: {},
};

export const settlementsLayer: LayerDef = {
  id: "settlements",
  title: "Settlements",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: toggle(
    "layers",
    "settlements",
    "settlements",
    false,
    "The village round its church, hamlets, farmsteads and a castle on a hilltop, the roads and farm tracks between them over one stone bridge; their windows lit after dark and their chimneys smoking.",
    { icon: "house" },
  ),
  params: [
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
      "settlementsSmoke",
      "chimney smoke",
      true,
      "amount",
      0.5,
      "Smoke curling up from the cottages' chimneys and leaning with the wind, thicker as the evening draws in.",
    ),
  ],
  groups: {
    settlements: {
      title: "Settlements",
      blurb:
        "The village, hamlets, farms and castle, the roads and farm tracks between them, and their lit windows and chimney smoke; a change of where they stand lays them out again without moving the hills or the river.",
      icon: "house",
    },
  },
  requires: ["valley"],
  passes: {},
};

export const vergesLayer: LayerDef = {
  id: "verges",
  title: "Verges",
  composers: ["outdoor"],
  role: "cover",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: countryVergesKnob,
  params: [],
  groups: {},
  requires: ["valley", "farmland"],
  // Its clumps, compiled in only while it is placed (shader.ts: none where it is not offered).
  featuresFor: (values) => ({ COUNTRY_HAS_VERGES: valleyValue(values, "verges") > 0 ? 1 : 0 }),
  featuresAll: { COUNTRY_HAS_VERGES: 1 },
  passes: {},
};

export const herdsLayer: LayerDef = {
  id: "herds",
  title: "Herds",
  composers: ["outdoor"],
  role: "life",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: toggle(
    "layers",
    "herds",
    "herds",
    false,
    "Cattle and sheep grazing the pastures (Land use), never leaving their field.",
    { icon: "fence" },
  ),
  params: [
    range(
      "herds",
      "herd",
      "herd size",
      0.5,
      "How many animals graze each enclosure, as many as its open ground has room for: zero empties them, 50% is three to seven cattle or five to nine sheep, 100% about twice that (at most fourteen). They graze, wander, lie down in the warm afternoon and at night, and bunch up standing in rain and snow, never leaving their field.",
      { step: 0.05 },
    ),
  ],
  groups: {
    herds: {
      title: "Herds",
      blurb: "The herds in the pastures: cattle or sheep as the land use has them, and how many.",
      icon: "fence",
    },
  },
  requires: ["valley", "farmland"],
  passes: {},
};

export const travellersLayer: LayerDef = {
  id: "travellers",
  title: "People & carts",
  composers: ["outdoor"],
  role: "life",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: toggle(
    "layers",
    "travellers",
    "people and carts",
    false,
    "Walkers and carts going up and down the roads and tracks; they tread the lying snow on them.",
    { icon: "cart" },
  ),
  params: [
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
  ],
  groups: {
    activity: {
      title: "People & carts",
      blurb: "Walkers and carts going up and down the roads; they stand still while motion is off.",
    },
  },
  requires: ["valley", "settlements"],
  passes: {},
};

export const starlingsLayer: LayerDef = {
  id: "starlings",
  title: "Starlings",
  composers: ["outdoor"],
  role: "life",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_HILL,
  switch: countryStarlingsKnob,
  params: [],
  groups: {},
  requires: ["valley"],
  // Its flock, compiled in only while it is placed (shader.ts: none where it is not offered).
  featuresFor: (values) => ({
    COUNTRY_HAS_MURMURATION: valleyValue(values, "starlings") > 0 ? 1 : 0,
  }),
  featuresAll: { COUNTRY_HAS_MURMURATION: 1 },
  passes: {},
};

/** The countryside's layers whose parts the valley draws, canonical order. */
const VALLEY_PARTS: readonly LayerDef[] = [
  waterwayLayer,
  farmlandLayer,
  settlementsLayer,
  vergesLayer,
  herdsLayer,
  travellersLayer,
  starlingsLayer,
];

/** The Countryside preset's home layers: every part but the verges and the starlings. */
export const COUNTRY_HOME_LAYERS = [
  "valley",
  "waterway",
  "farmland",
  "settlements",
  "herds",
  "travellers",
] as const;

/**
 * Each knob of the valley's parts: its layer, and what the valley takes where that layer is not
 * offered (a guest valley): the countryside's own default, a home layer's switch on.
 */
const PART_KNOBS: Readonly<Record<string, { readonly layer: LayerDef; readonly guest: number }>> =
  Object.fromEntries(
    VALLEY_PARTS.flatMap((layer) => {
      const home = (COUNTRY_HOME_LAYERS as readonly string[]).includes(layer.id);
      const sw: ParamDef = layer.switch;
      const switched = !home ? 0 : sw.kind === "feature" ? sw.value : 1;
      return [
        [sw.key, { layer, guest: switched }],
        ...layer.params.map((def) => [def.key, { layer, guest: effective(def, {}) }]),
      ];
    }),
  );

/** Whether a part's layer is on in these values (keyed as the shader reads them), its hosts too. */
function partOn(values: Readonly<Record<string, number>>, layer: LayerDef): boolean {
  if ((values[layer.id] ?? 0) <= 0) return false;
  return (layer.requires ?? []).every((host) => {
    const part = VALLEY_PARTS.find((other) => other.id === host);
    return part === undefined ? true : partOn(values, part);
  });
}

/**
 * A countryside knob as the valley draws it (values keyed as the shader reads them): its own while
 * its layer is on, 0 while it is off, and the countryside's default where its layer is not offered
 * (a guest valley, the bees garden's); any other knob as it is.
 */
export function valleyValue(values: Readonly<Record<string, number>>, key: string): number {
  const part = PART_KNOBS[key];
  if (part === undefined) return values[key] ?? 0;
  if (values[part.layer.id] === undefined) return part.guest;
  return partOn(values, part.layer) ? (values[key] ?? 0) : 0;
}

/**
 * `params` with every knob of the valley's parts it lacks (a guest valley's scene) after them, each
 * as the countryside opens it: its default, a home layer's switch on. The valley's sim reads its
 * parts' knobs through these (sim.ts): a knob past the scene's own reads its default.
 */
export function withCountryDefaults(params: readonly ParamDef[]): readonly ParamDef[] {
  const keys = new Set(params.map((def) => def.key));
  const missing = VALLEY_PARTS.flatMap((layer) => {
    const home = (COUNTRY_HOME_LAYERS as readonly string[]).includes(layer.id);
    const sw = layer.switch;
    const switched: ParamDef =
      sw.kind === "feature" ? { ...sw, on: home } : { ...sw, value: home ? 1 : 0 };
    return [switched, ...layer.params].filter((def) => !keys.has(def.key));
  });
  return missing.length === 0 ? params : [...params, ...missing];
}

/** The valley's GLSL macro (`VALLEY_<NAME>`, shader.ts) for each knob of its parts, by knob key. */
const VALLEY_MACROS: Readonly<Record<string, string>> = {
  waterway: "RIVER",
  waterwayRipples: "RIPPLES",
  woodland: "WOODLAND",
  farmlandPines: "PINES",
  pasture: "PASTURE",
  chalk: "CHALK",
  village: "VILLAGE",
  roads: "ROADS",
  tracks: "TRACKS",
  lights: "LIGHTS",
  settlementsSmoke: "SMOKE",
  verges: "VERGES",
  herd: "HERD",
  walkers: "WALKERS",
  carts: "CARTS",
  starlings: "STARLINGS",
};

/**
 * The valley's macros for the knobs of its parts (shader.ts): `VALLEY_<NAME>` reads K_<key> while
 * its layer is placed (`gate` 1), 0 while it is not, and `guest` where its layer is not offered.
 */
export const VALLEY_KNOBS: readonly {
  readonly macro: string;
  readonly key: string;
  readonly gate: string;
  readonly guest: number;
}[] = Object.entries(VALLEY_MACROS).map(([key, name]) => {
  const part = PART_KNOBS[key];
  if (part === undefined) throw new Error(`country: no part holds the knob ${key}`);
  return { macro: `VALLEY_${name}`, key, gate: layerGate(part.layer.id), guest: part.guest };
});

/**
 * What the valley's knobs compile in (LayerDef.featuresFor): each optional part only while it can
 * show, so the default countryside's program carries none of the flower fields, herds, figures,
 * verges or starlings. The bales lie from the barley's cut until they are carted away (with crops),
 * or at any time of year while the year passes. The World's own parts are the World's gates.
 */
export function valleyFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (...keys: string[]) => (keys.some((key) => valleyValue(values, key) > 0) ? 1 : 0);
  const season = seasonKnob([SEASON]);
  const date = season
    ? yearAt(season, values[season.key] ?? season.value)
    : COUNTRY_SEASONS.harvest;
  const passing = (values.year ?? 0) > 0;
  return {
    // The roads' and tracks' surfaces and the bridge, and the village's own streets, which stay
    // with both off.
    COUNTRY_HAS_ROADS: on("roads", "tracks", "village"),
    // The valley fog along the river's level: the World's fog knob, drawn the valley's own way.
    COUNTRY_HAS_FOG: on("fog"),
    // Pine woods and hedgerow pines: only with woods and a pine mix.
    COUNTRY_HAS_PINES: Math.min(on("farmlandPines"), on("woodland")),
    // The flower fields' materials (the shared fields).
    COUNTRY_HAS_FIELDS: on("farmlandWildflowers", "lavender", "sunflowers"),
    // The pastures' fences and herds (the shared livestock).
    COUNTRY_HAS_HERDS: on("pasture"),
    // Walkers and carts on the roads, and the lying snow they tread there.
    COUNTRY_HAS_AGENTS: on("walkers", "carts"),
    // Round bales on the barley's stubble: from its cut until they are carted away, with crops.
    COUNTRY_HAS_BALES:
      passing || (date >= COUNTRY_BALES[0] && date < COUNTRY_BALES[1]) ? on("crops") : 0,
    // The river's wind ripples: the shared water's ripples tier, only while they are up.
    WATER_TIER: on("waterwayRipples") ? WATER_TIERS.ripples : WATER_TIERS.flat,
    // Lit windows and their glow, chimney smoke (buildings.ts).
    COUNTRY_HAS_LIGHTS: on("lights"),
    COUNTRY_HAS_SMOKE: on("settlementsSmoke"),
    // The chalk M on its hillside (chalk.ts).
    COUNTRY_HAS_CHALK: on("chalk"),
  };
}
