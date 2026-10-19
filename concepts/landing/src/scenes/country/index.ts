// Countryside: one map of a river valley carved by running water (the terrain toolbox,
// sims/terrain.ts and shaders/lib/terrain.ts), seen from a hill at its corner: the river lying level
// in its bed and widening downstream, a village, hamlets, farms and a castle where people would
// build, roads between them over one bridge, and every parcel of land given over to one use by the
// land model (sims/landuse.ts): crops, flower fields, pasture with its herd, woodland, or open
// grassland. Under the World's sky, clouds and weather.
//
// A variant of the `outdoor` composer's baseline (src/composer, README "The outdoor composer", ADR
// 0062 Phase 2c), the baseline's downs off: the valley (the backdrop: the land, its sim and every
// part's drawing), the waterway, the farmland, the settlements, the verges, the herds, the
// travellers and the starlings, each a layer (layers.ts) drawn through the hill's rig (constants.ts
// COUNTRY_RIG), the camera coming down out of the sky on the way in and rising back toward the
// clouds on the way out. The World's sky, rain, snow and birds replace the countryside's own (D10);
// its valley fog stays its own, on the World's fog knob.
//
// Knobs and what they rebuild (sim.ts): the land's shape, the arrangement (the composer's seed),
// relief and erosion rebuild the map over a few frames (the last one stays on screen meanwhile); the
// river's size the river and what stands near it; the settlements and roads only those and the
// parcels; the land's uses, the pine mix, the cattle share and the chalk M (which keeps the woods
// and fields off its hillside) only the allocation, packed and uploaded within the frame (the
// woodland share the woods' line, and the few parcels it turns into woods or back); the river
// switched off only dries its bed. Herds' size, walkers, carts, the time of year (the composer's
// season, carried round while the year passes: the crops, grass, hedges and trees through the
// farming year, the harvest's bales, and the climate that turns a winter's rain to snow; season.ts),
// the river's wind ripples, the lit windows and the chimney smoke are the shader's alone, but for the
// verges' year. Each optional part is compiled in only while on (the valley's featuresFor). The
// verges at the hedges' foot (verges.ts) and the starling murmuration at dusk (murmuration.ts) are
// compiled in only while on too; the sim grows their plants and flies their flock then, packed beside
// the terrain's records (atlas.ts).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import {
  COUNTRY_FLYWAY,
  COUNTRY_GRADE,
  COUNTRY_METEORS,
  COUNTRY_PASSAGE,
  COUNTRY_RIG,
} from "./constants.ts";
import { COUNTRY_HOME_LAYERS } from "./layers.ts";

/** The countryside over the outdoor's baseline: the valley's layers, the hill's rig, its World. */
export const countryVariant: Variant = {
  id: "country",
  base: "outdoor",
  title: "Countryside",
  blurb:
    "A river valley carved by water: fields, woods and pastures, a village, a castle and roads over a bridge.",
  // Lamplight in the windows.
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  // Enter: the camera comes down out of the sky and settles over the valley as the haze thins.
  // Exit: it rises back toward the clouds.
  passage: COUNTRY_PASSAGE,
  planets: { group: "sky", across: [-33, 14, 33], up: [0, 8, 16] },
  layers: { remove: ["downs"], add: COUNTRY_HOME_LAYERS },
  camera: COUNTRY_RIG,
  grade: COUNTRY_GRADE,
  // The World as the countryside opens it: a late afternoon, its fair-weather cloud and the deck's
  // shadows over the land, fewer stars (the moon the World's own, full); its birds (a mix, mostly
  // rooks) off.
  world: {
    time: 0.68,
    stars: 0.5,
    clouds: 0.35,
    on: { shadows: true },
    birds: {
      kind: "mixed",
      on: false,
      mixed:
        "mostly rooks in loose parties, gulls up from the river, swallows low over the fields, now and then geese, pigeons, swifts or a buzzard circling on a thermal.",
      help: "Birds crossing the valley by day, hidden by the hills, trees and buildings nearer than them; none at night and fewer in snow and rain.",
    },
  },
  meteors: COUNTRY_METEORS,
  flyway: COUNTRY_FLYWAY,
  // No gusts: nothing in the valley moves in the composer's gust field.
  values: { gusts: 0 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day and of the farming year, whether the days and the year pass, and the night sky over the valley: its stars and constellations, the Milky Way, the moon's phase, its planets, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and the shadows it sweeps over the land, rain and snow (a winter's rain falls as snow, and deep winter lays snow by itself), the valley fog lying along the river at dawn, the wind that ruffles the river and leans the smoke, and lightning.",
    },
    birds: {
      ...worldGroups.birds,
      blurb: "Flights of birds crossing the valley by day.",
    },
  },
};

/** The countryside composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const countryComposed = composeScene(
  outdoor,
  variantPreset(outdoor.baseline, countryVariant),
);

export const countryScene: SceneDef = {
  ...countryComposed.def,
  code: () => import("./code.ts"),
};
