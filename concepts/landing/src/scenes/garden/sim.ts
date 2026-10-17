// A dry stone garden (karesansui), kept by an unseen rake, under a maple letting go of its leaves.
//
// The gravel is a HeightField (src/sims/heightfield.ts) over a fixed garden 2.4 depths wide and 1
// deep (Y runs away from the veranda, X to the right; the rest level is 0; a garden depth is about
// ten metres). The rake follows a choreographed plan built from the stone islands and the pattern
// knob: long passes across the garden, straight or in waves, the rake lifted over the ring zones,
// then a lap of five rings around every island; or, for "circles", rings spreading out from every
// stone until they meet the rings of the next. Every frame the rake moves a little along the plan:
// a board just ahead of it levels the old pattern (the field helper has no leveling tool, so that
// is done here on the field's data), then five tines cut fresh grooves with HeightField.rake, in
// short pieces so the banks stay even round a bend. Behind it the grooves slump to the angle of
// repose (relax, a band of rows per frame) and soften slowly (smooth, every couple of seconds), so
// the garden is crisp where the rake has just been and softer the longer since it passed. A coarser
// grid (an AgeField) remembers when each spot was last raked: freshly turned gravel is darker and
// dries back on a drying clock, which runs with garden time, or, drying with the weather, faster
// with the weathering knob, in sun and wind, slower at dusk and night, not at all in rain (rain as
// it falls: in winter it comes down as snow, src/climate.ts).
//
// Raking the whole garden through the tool would cost a few hundred milliseconds, so a layout (the
// first, and when the pattern, the stones or the M change) is laid straight from the same plan, on
// the build worker (gardenLayout): each texel takes the groove phase the plan leaves there, with a
// weathered profile, then rounded here by one smoothing pass. The garden on show stays until a new
// layout lands; until the first has, the sim is not ready and nothing runs. The rake then starts
// left of centre and re-cuts it for real, crisp.
//
// Leaves fall as flat plates (the shared fluttering-plate model, sims/flutter.ts, as autumn's leaves
// fall), each in its own vertical plane that slowly turns, carried by the wind and the gusts (the
// shared gust pulse, sims/wind.ts). Light leaves flutter, swinging from side to side and gliding up
// at the end of each swing; heavier ones tumble end over end. They land, settle flat, lie a while and
// fade, or are pushed away by the rake. The leaves are packed into an rgba16f texture, four texels a
// leaf.
//
// The woods over the wall and the border planting along its foot are rooted plants of the shared
// plant component (sims/plants.ts). Every crown of the woods' two rows is a tree: one stem from where
// its trunk stands behind the wall up to the row's crown tops, its crown drawn by the shader where
// the stem's tip carries it. The border (off unless its knob is on) is clumps of fern and mondo grass
// rooted in the gutter, following the season and, with growth, replacing their fronds and blades.
// Both sway with the wind knob and its eddies, and the garden's gust (the leaves' "now", the exit's
// flurry) crosses them as a front from the garden's upwind end. In still air, once they have swung
// out, they are set exactly at rest: the woods then stand exactly as the shader always drew them.
//
// Uploads: uSim0 r16f heights (GARDEN.cols × rows); uSim1 a PlantTexture (RECORD_WIDTH wide, rgba16f)
// whose first GARDEN_RECORD_ROW rows are the scene's own, islands and stones (8 × 4) plus the drying
// clock, then the plant records (GARDEN_WOODS, GARDEN_BORDER); uSim2 rgba16f leaves (4 ×
// GARDEN_LEAF_SLOTS); uSim3 r16f when each spot was last raked, on the drying clock (half resolution).
import { climateCold, fallingRain, seasonKnob, yearAt, type SeasonKnob } from "../../climate.ts";
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { AgeField, dryingPace } from "../../sims/agefield.ts";
import { type BuildKind, BuildSlot } from "../../sims/build.ts";
import { Settle } from "../../sims/clock.ts";
import { FlutterPlates } from "../../sims/flutter.ts";
import { HeightField, type RakeOptions } from "../../sims/heightfield.ts";
import { clamp, fract, hash31, lerp, smoothstep } from "../../sims/math.ts";
import {
  PLANT_SUMMER,
  PlantHabit,
  PlantRole,
  PlantTexture,
  plantClimate,
  RootedPlants,
  type PlantSpecies,
} from "../../sims/plants.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import { gustPulse, windSign } from "../../sims/wind.ts";
import { dateShift, skyAnchor, skyState, timeOfDay, type SkyState } from "../../world-clock.ts";
import type { PrincipalState, SceneSim, SimFactory, SimFrame } from "../types.ts";

export const gardenPatterns = ["waves", "straight", "circles"] as const;
export type GardenPattern = (typeof gardenPatterns)[number];
export const gardenSeasons = ["spring", "summer", "autumn", "winter"] as const;
export type GardenSeason = (typeof gardenSeasons)[number];

/**
 * The garden and its two cameras, shared with the shader. Garden space: X right (0..aspect), Y away
 * from the veranda (0..1), Z up, in garden depths.
 *   veranda: a shifted-lens pinhole at (aspect / 2, eyeY, eyeHeight) looking along +Y, horizon at
 *            screen height `horizon`, focal length `focal` in screen heights (as viewRay's 0.5 /
 *            tan(fov / 2)); the earthen wall stands at Y = wallY.
 *   above:   a pinhole `overheadHeight` above (aspect / 2, overheadY) looking straight down; the
 *            ground spans `span` garden depths per screen height, from the drip line to the wall's cap.
 */
export const GARDEN = {
  aspect: 2.4,
  cols: 672,
  rows: 280,
  /** The pebble drip line along the veranda: garden Y below this is not raked. */
  drip: 0.03,
  wallY: 1.03,
  wallHeight: 0.125,
  capHeight: 0.032,
  focal: 1.25,
  horizon: 1.0,
  eyeHeight: 0.253,
  eyeY: -0.316,
  span: 1.06,
  overheadHeight: 1.5,
  overheadY: 0.52,
} as const;

/**
 * When the white gravel is in daylight and the page is a light one: times of day (still clock)
 * from just after sunrise to just before sunset, while the rain falling (its amount; in winter it
 * comes down as snow, src/climate.ts) stays lighter than `rain`; harder rain greys and darkens the
 * garden (index.ts's theme and the shader's ink).
 */
export const GARDEN_PAPER = { from: 0.26, to: 0.745, rain: 0.35 } as const;

/**
 * The Manifold M: where it lies when it is on (that patch of gravel is kept clear of islands), its
 * height in garden depths at the size knob's ends (small + grow × size), its slate's half stroke
 * width in M heights, and how far the slate stands above the gravel: a few centimetres, nearly
 * flush.
 */
export const GARDEN_MARK = {
  x: 1.5,
  y: 0.36,
  reserve: 0.32,
  small: 0.12,
  grow: 0.16,
  stroke: 0.055,
  slate: 0.004,
} as const;

/** Moss: a low cushion out to clear × (base + grow × moss knob). */
export const GARDEN_MOSS = { height: 0.009, base: 0.25, grow: 0.7 } as const;

/**
 * The maple's foliage, as clumps (x, y, z, radius) in garden space: a tree standing beyond the wall
 * at the far left, one limb reaching over the wall toward the middle, another higher over the
 * garden (out of the veranda's frame, in view from above).
 */
export const GARDEN_CANOPY: readonly (readonly [number, number, number, number])[] = [
  [0.05, 1.1, 0.27, 0.1],
  [0.3, 1.04, 0.21, 0.085],
  [0.52, 1.0, 0.17, 0.07],
  [0.66, 0.93, 0.225, 0.075],
  [0.88, 0.86, 0.245, 0.07],
  [1.08, 0.8, 0.262, 0.06],
  [0.2, 0.9, 0.3, 0.09],
  [0.45, 0.82, 0.29, 0.08],
  [0.72, 0.74, 0.31, 0.07],
  [0.38, 1.14, 0.15, 0.08],
];

/**
 * The woods over the wall, as the shader draws them (x in screen heights from the frame's left edge,
 * y in uv height): two rows of rounded crowns, crown k of a row spanning [k, k + 1) of the phase
 * x · rate + wobble · noise (the shader's, 0..1), the far row 6 to a screen height, the near row 9.
 * Each crown is a tree: one stem from `foot`, where its trunk stands behind the wall, `length` up to
 * the row's crown tops. The far row's crown k is record k, the near row's `crowns` + k; crowns past
 * `crowns` (a frame over 4.4 screen heights wide) stand still.
 */
export const GARDEN_WOODS = {
  crowns: 40,
  far: { rate: 6, wobble: 0.4, foot: 0.875, length: 0.113 },
  near: { rate: 9, wobble: 0.5, foot: 0.815, length: 0.137 },
} as const;

/**
 * The border planting along the wall's foot (off unless its knob is on): in some of the gutter's
 * `bins` bins, `pitch` garden depths along X each, a clump of fern or mondo grass, standing in the
 * plane Y = `y` between the gravel's curb and the wall, at most `reach` tall. Plant frame: garden X,
 * height above the gutter. Bin b's organs are records `first` + `organs` · b + 0..organs - 1.
 */
export const GARDEN_BORDER = {
  pitch: 0.1,
  bins: 24,
  organs: 7,
  y: 1.015,
  reach: 0.07,
  first: 2 * GARDEN_WOODS.crowns,
} as const;

/** Islands and stones per island the stone texture holds (the shader's loops and struct match). */
export const GARDEN_ISLANDS = 4;
export const GARDEN_STONES = 3;
export const GARDEN_LEAF_SLOTS = 24;
/**
 * uSim1, a PlantTexture RECORD_WIDTH texels wide: its first GARDEN_RECORD_ROW rows are the scene's own
 * (a row of islands and the drying clock, then a row per stone, two texels each), then the plant
 * records, the woods' stems and the border's organs.
 */
export const GARDEN_RECORD_ROW = 1 + GARDEN_STONES;
const RECORD_WIDTH = 64;
const RECORDS = GARDEN_BORDER.first + GARDEN_BORDER.bins * GARDEN_BORDER.organs;
/** The "when was it raked" grid (an AgeField): half the height field's resolution. */
const GARDEN_FRESH = { cols: 336, rows: 140 } as const;

/** Leaf kinds, as packed for the shader. */
export const GARDEN_LEAF_KIND = { maple: 0, petal: 1, green: 2, withered: 3 } as const;
type LeafKind = (typeof GARDEN_LEAF_KIND)[keyof typeof GARDEN_LEAF_KIND];

const GA = GARDEN.aspect;
/** Positions are packed relative to the garden's centre, where half floats are finest. */
const OX = GA / 2;
const OY = 0.5;
const TAU = Math.PI * 2;

// ---- the rake ------------------------------------------------------------------------------------

/** The garden rake: five tines; a groove 3 mm deep would be invisible, so these are stage-sized. */
const RAKE: RakeOptions = { width: 0.012, depth: 0.003, ridge: 0.012, tines: 5, spacing: 0.024 };
/** The grooves' spacing: below it on screen the shader lets their light and water melt away. */
export const GARDEN_GROOVE = RAKE.spacing;
/** One pass of the rake covers this width: passes and ring laps are laid this far apart. */
const SWATH = RAKE.tines * RAKE.spacing;
/** The leveling board: half its width (reaching half-way into the bank beyond the outer tines), its soft edge, and how far it runs ahead of the tines. */
const LEVEL_HALF = 0.066;
const LEVEL_SOFT = 0.008;
const LEAD = 0.03;
/** The hand rake the pointer draws with: three tines. */
const HAND: RakeOptions = { width: 0.011, depth: 0.0028, ridge: 0.011, tines: 3, spacing: 0.022 };
const HAND_LEVEL_HALF = 0.04;
/** Shortest pointer move that rakes, garden depths. */
const HAND_STEP = 0.003;
/** Centre of the nearest pass; passes then every SWATH out to the wall. */
const PASS_FIRST = 0.1;
const PASSES = 8;
/** Groove centres of the line patterns start here (the nearest pass's nearest tine). */
const LINE_FIRST = PASS_FIRST - 0.5 * (RAKE.tines - 1) * RAKE.spacing;
/** Waves: amplitude and wavelength of the passes' meander. */
const WAVE_AMPLITUDE = 0.028;
const WAVE_LENGTH = 0.62;
/** Laps of rings around each island (and the M) in the line patterns: five rings. */
const RING_LAPS = 1;
/** The first ring's innermost groove sits this far outside an island's clear radius... */
const RING_GAP = 0.012;
/** ...so the rake's centre runs this far out on the first lap, and a SWATH further on each next. */
const RING_FIRST = RING_GAP + 0.5 * (RAKE.tines - 1) * RAKE.spacing;
/**
 * Plan polylines are sampled this finely: the tool lays each piece's banks square to that piece, so
 * a coarse bend would leave beads where the pieces meet at an angle.
 */
const PLAN_STEP = 0.006;
/** Pieces of a pass shorter than this between ring zones are not worth setting the rake down for. */
const MIN_STROKE = 0.04;
/** Between strokes the rake is lifted and carried: this much plan distance of rest. */
const STROKE_PAUSE = 0.05;
/** Garden depths per second at the raking knob's full travel. */
const RAKE_SPEED = 0.08;
/** Longest piece the rake cuts in one go (garden depths): a slow frame is cut in several. */
const MAX_PIECE = 0.0015;
/** Where the rake starts after a layout (the plan point nearest it): left of centre, in both views. */
const LIVE_START = { x: 0.66, y: 0.56 } as const;
/** Weathered groove amplitude a layout starts with (a fresh cut is RAKE.depth deep). */
const LAID_AMPLITUDE = 0.0022;

/** Angle of repose of the gravel (rise over run), the slumping rate, and rows relaxed per frame. */
const TALUS = 0.8;
const SLUMP_RATE = 2.5;
const RELAX_ROWS = 6;
/** Seconds between weathering passes, and their diffusion per second at the knob's full travel. */
const SMOOTH_EVERY = 2;
const SMOOTH_RATE = 0.012;
/** Milliseconds between uploads of the heights and the drying grid while they change. */
const UPLOAD_EVERY_MS = 1000 / 30;
/** Knobs that re-lay the garden must rest this long first (a dragged slider). */
const RELAYOUT_MS = 220;

// ---- the leaves ----------------------------------------------------------------------------------

interface LeafSpec {
  /** Drawn radius, garden depths. */
  radius: number;
  /** The plate's aerodynamic chord: sets the swing and the speed of descent. */
  chord: number;
  /** Real seconds per model time unit: sets the pace of the swing. */
  pace: number;
  /** Mass per span (the dimensionless moment of inertia I*): flutter below ~0.6, tumble above. */
  flutter: readonly [number, number];
  tumble: readonly [number, number];
  /** Share of leaves that tumble. */
  tumbling: number;
  /** Seconds a leaf lies on the gravel before it fades. */
  life: readonly [number, number];
}

const SPECS: Readonly<Record<LeafKind, LeafSpec>> = {
  [GARDEN_LEAF_KIND.maple]: {
    radius: 0.013,
    chord: 0.046,
    pace: 0.17,
    flutter: [0.2, 0.42],
    tumble: [0.72, 0.9],
    tumbling: 0.15,
    life: [45, 85],
  },
  [GARDEN_LEAF_KIND.petal]: {
    radius: 0.0068,
    chord: 0.024,
    pace: 0.13,
    flutter: [0.12, 0.3],
    tumble: [0.6, 0.75],
    tumbling: 0.08,
    life: [25, 50],
  },
  [GARDEN_LEAF_KIND.green]: {
    radius: 0.0135,
    chord: 0.046,
    pace: 0.17,
    flutter: [0.25, 0.45],
    tumble: [0.72, 0.9],
    tumbling: 0.12,
    life: [45, 85],
  },
  [GARDEN_LEAF_KIND.withered]: {
    radius: 0.0115,
    chord: 0.034,
    pace: 0.15,
    flutter: [0.35, 0.55],
    tumble: [0.7, 0.9],
    tumbling: 0.4,
    life: [60, 100],
  },
};

/** Leaves let go per second at the leaf-fall knob's full travel, by season. */
const FALL_RATE: Readonly<Record<GardenSeason, number>> = {
  spring: 1.6,
  summer: 0.2,
  autumn: 1.0,
  winter: 0.1,
};
const SEASON_KIND: Readonly<Record<GardenSeason, LeafKind>> = {
  spring: GARDEN_LEAF_KIND.petal,
  summer: GARDEN_LEAF_KIND.green,
  autumn: GARDEN_LEAF_KIND.maple,
  winter: GARDEN_LEAF_KIND.withered,
};

/** Leaf states. */
const FREE = 0;
const FALLING = 1;
const LANDED = 2;
const LEAVING = 3;

/** Wind drift (garden depths per second) at wind = 1; a gust's peak and updraft. */
const WIND_DRIFT = 0.12;
const GUST_DRIFT = 0.22;
const GUST_LIFT = 0.03;
/** Seconds a gust (sims/wind.ts gustPulse) takes to rise to its peak: the leaves here, the maple's sway in the shader. */
export const GARDEN_GUST_RISE = 1.0;
/** Seconds a gust keeps shaking leaves loose, how many, and how long it keeps the leaves moving at motion 0. */
const GUST_SHAKE = 1.8;
const GUST_SHOWER = 12;
const GUST_BUSY = 14;
/** A landed leaf lies this far above the ground it rests on. */
const LEAF_LIFT = 0.0012;
/** Seconds to settle flat after touching down, to fade in, to fade out, and to be swept away. */
const SETTLE_SECONDS = 0.5;
const FADE_IN = 0.4;
const FADE_OUT = 6;
const SWEEP_SECONDS = 1.6;
/** How far a falling leaf rocks about its chord (radians), on its own slow swing. */
const ROLL = 0.3;
/** Leaves on the gravel when a garden is first laid out, and in the air. */
const PREWARM_LANDED = 9;
const PREWARM_FALLING = 4;
/** Most leaves lying on the gravel at once; past it the oldest fades, leaving slots for the air. */
const LANDED_MAX = 12;
/** The share of lying leaves (the lightest, by hue) a full gust picks up and blows away. */
const GUST_CARRY = 0.4;

/** Where a passage's leaf lets go (see #spawn). */
type SpawnMode = "entrance" | "flurry";

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the maple's boughs sway
 * in from the top of the frame and a few leaves drift down and land. Exit: a gust, rising over the
 * whole exit, blows a flurry of leaves across the gravel while the boughs sway up out of the frame.
 */
export const GARDEN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
/**
 * The entrance's leaves: up to this many (fewer in the sparse seasons) let go from the boughs, the
 * first this far into the entrance, the rest this far apart (seconds).
 */
const ENTRANCE_LEAVES = 5;
const ENTRANCE_FIRST = 0.1;
const ENTRANCE_GAP = 0.2;
/** The exit's flurry: this many leaves blown in from upwind over this many seconds of the gust, which pushes them this many times harder than a "now" gust does. */
const FLURRY_LEAVES = 14;
const FLURRY_SPAN = 0.6;
const FLURRY_BOOST = 4;

// ---- the woods and the border (the shared plant component) ---------------------------------------

/** How fast the gust's front crosses the garden from its upwind end (garden depths per second), and its push at its peak (push units). */
const GUST_FRONT = 1.6;
const GUST_PUSH = 1.0;
/** The breeze's eddies on the woods and the border, as a share of it; in still air they stand still. */
const PLANT_EDDY = 0.6;
/** Seconds of still air (no wind, no gust about) after which the woods and the border are set exactly at rest. */
const PLANT_SETTLE = 6;
/** The plant component's year (0..1 from the start of spring) for the season knob: mid-spring, high summer, mid-autumn, deep winter. */
const PLANT_SEASON: Readonly<Record<GardenSeason, number>> = {
  spring: 0.15,
  summer: PLANT_SUMMER,
  autumn: 0.66,
  winter: 0.88,
};
/** The border's species, as its records' form: the shader draws a fern's fronds with plantFrond, mondo grass's blades with plantArc. */
export const GARDEN_BORDER_FORM = { fern: 0, mondo: 1 } as const;
/** The plants' builds draw no randomness of their own (the layout and hashes place everything). */
const NO_DRAWS = (): number => 0;

/** A tree of the temple woods (cedar, camphor): one stem carrying its crown, which the shader draws; evergreen. */
const WOODS_TREE: PlantSpecies = {
  id: "temple tree",
  moisture: [0, 1],
  sway: { hz: 0.45, damping: 0.25, give: 0.12, limit: 0.3 },
  year: { shed: 0, turn: 2, bloom: [0, 0] },
  life: { unfold: 10, span: 600 },
  detail: { simple: 2, min: 0.5 },
  build(plant) {
    const row = plant.site.kind === 1 ? GARDEN_WOODS.near : GARDEN_WOODS.far;
    plant.organ({ angle: Math.PI / 2, length: row.length, form: 0, slot: 0 });
  },
};

/**
 * A shield fern in the gutter (Dryopteris): five to seven rigid fronds from its crown, in pairs from
 * the outside in, the inner ones shorter and more upright; half of them die back over winter. Its
 * record's a and b are a frond's lift and droop (plantFrond).
 */
const BORDER_FERN: PlantSpecies = {
  id: "shield fern",
  moisture: [0.5, 1],
  sway: { hz: 0.6, damping: 0.4, give: 0.14, limit: 0.5 },
  year: { shed: 0.5, turn: 0.58, bloom: [0, 0] },
  life: { unfold: 10, span: 120 },
  detail: { simple: 6, min: 1.5 },
  build(plant) {
    const bin = plant.site.kind ?? 0;
    const fronds = 5 + Math.floor(3 * hash31(bin, 0, 0x6665));
    const scale = 0.6 + 0.4 * plant.vigour;
    for (let j = 0; j < fronds; j++) {
      const h = hash31(bin, j + 1, 0x6665);
      const inner = Math.floor(j / 2);
      const lift = 1.4 + 0.35 * inner + 0.6 * h;
      const droop = 1.3 + 0.7 * fract(h * 7.3);
      const side = j % 2 === 0 ? -1 : 1;
      plant.organ({
        angle: Math.atan2(lift - droop, side),
        length: (0.036 + 0.014 * fract(h * 3.1)) * (1 - 0.14 * inner) * scale,
        a: lift,
        b: droop,
        form: GARDEN_BORDER_FORM.fern,
        variant: j,
        side,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
        slot: j,
      });
    }
  },
};

/**
 * A tuft of mondo grass (Ophiopogon): seven narrow evergreen blades fanning out of the root and
 * arching over, the outer ones furthest. Its record's a is a blade's curl (its turn at rest).
 */
const BORDER_MONDO: PlantSpecies = {
  id: "mondo grass",
  moisture: [0.3, 1],
  sway: { hz: 0.8, damping: 0.35, give: 0.2, limit: 0.6 },
  year: { shed: 0, turn: 0.7, bloom: [0, 0] },
  life: { unfold: 8, span: 90 },
  detail: { simple: 4, min: 1 },
  build(plant) {
    const bin = plant.site.kind ?? 0;
    const scale = 0.7 + 0.3 * plant.vigour;
    for (let j = 0; j < GARDEN_BORDER.organs; j++) {
      const h = hash31(bin, j, 0x6d6f);
      // Across the tuft: -1 leaning left .. 1 leaning right.
      const lean = (j - 3) / 3 + 0.25 * (h - 0.5);
      plant.organ({
        angle: Math.PI / 2 - 0.6 * lean,
        length: (0.017 + 0.009 * fract(h * 5.1)) * scale,
        width: 0.0016,
        curl: -1.5 * lean,
        a: -1.5 * lean,
        form: GARDEN_BORDER_FORM.mondo,
        variant: j,
        role: PlantRole.leaf,
        slot: j,
      });
    }
  },
};

/**
 * The woods' trees: a stem for every crown of both rows, rooted under the middle of its crown as the
 * shader's phase places it on average (its noise moves a crown by under a twelfth of a screen height,
 * which only shifts when the gust's front reaches it).
 */
function growWoods(woods: RootedPlants): void {
  woods.clear();
  for (const [kind, row] of [GARDEN_WOODS.far, GARDEN_WOODS.near].entries()) {
    for (let k = 0; k < GARDEN_WOODS.crowns; k++) {
      const x = (k + 0.5 - 0.5 * row.wobble) / row.rate;
      woods.add(
        WOODS_TREE,
        { x, y: row.foot, heading: Math.PI / 2, kind, slot: kind * GARDEN_WOODS.crowns + k },
        NO_DRAWS,
      );
    }
  }
}

/**
 * The border for its knob's fullness (0: off, nothing planted): a clump in each bin the fullness
 * plants (the bins' own hashes decide which, so a fuller border keeps the clumps of a sparser one),
 * a fern in two bins of five, mondo grass in the rest, rooted off the bin's middle.
 */
function growBorder(border: RootedPlants, fullness: number): void {
  border.clear();
  if (!(fullness > 0)) return;
  for (let bin = 0; bin < GARDEN_BORDER.bins; bin++) {
    if (hash31(bin, 1, 0x626f) >= fullness) continue;
    const species = hash31(bin, 2, 0x626f) < 0.4 ? BORDER_FERN : BORDER_MONDO;
    const x = (bin + 0.5 + 0.5 * (hash31(bin, 3, 0x626f) - 0.5)) * GARDEN_BORDER.pitch;
    const site = {
      x,
      y: 0,
      heading: Math.PI / 2,
      moisture: 0.8,
      lush: 0.7 + 0.3 * hash31(bin, 4, 0x626f),
      kind: bin,
      slot: GARDEN_BORDER.first + GARDEN_BORDER.organs * bin,
    };
    border.add(species, site, NO_DRAWS);
  }
}

// ---- small helpers -------------------------------------------------------------------------------

/** The meander of the "waves" passes at X. */
const waveAt = (x: number): number => WAVE_AMPLITUDE * Math.sin((TAU * x) / WAVE_LENGTH);

/** Distance from (px, py) to the M of height `size` centred on GARDEN_MARK, and the unit gradient. */
function markField(px: number, py: number, size: number, out: Float64Array): number {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let k = 0; k < 4; k++) {
    const a = markVertex(k);
    const b = markVertex(k + 1);
    const ax = GARDEN_MARK.x + a[0] * size;
    const ay = GARDEN_MARK.y + a[1] * size;
    const ex = GARDEN_MARK.x + b[0] * size - ax;
    const ey = GARDEN_MARK.y + b[1] * size - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((px - ax) * ex + (py - ay) * ey) / l2, 0, 1) : 0;
    const qx = ax + t * ex;
    const qy = ay + t * ey;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) {
      best = d;
      bx = qx;
      by = qy;
    }
  }
  const inv = 1 / Math.max(best, 1e-9);
  out[0] = (px - bx) * inv;
  out[1] = (py - by) * inv;
  return best;
}

// ---- islands -------------------------------------------------------------------------------------

interface GardenStone {
  x: number;
  y: number;
  /** Half-axes of the stone's footprint. */
  rx: number;
  ry: number;
  height: number;
  /** Turn of the footprint's long axis. */
  angle: number;
  /** 0..1: the shape of its weathering. */
  seed: number;
}

interface GardenIsland {
  x: number;
  y: number;
  /** The gravel is left smooth within this radius; the rings start just outside it. */
  clear: number;
  stones: GardenStone[];
}

/**
 * A stone's height at (x, y): a steep-sided dome on a wobbly footprint, cut by a tilted top plane
 * and three steep side planes, so it stands as a weathered block with flat faces. The shader's
 * gardenStone is the same shape.
 */
function stoneHeight(stone: GardenStone, x: number, y: number): number {
  const dx = x - stone.x;
  const dy = y - stone.y;
  const c = Math.cos(stone.angle);
  const s = Math.sin(stone.angle);
  const qx = (c * dx + s * dy) / stone.rx;
  const qy = (-s * dx + c * dy) / stone.ry;
  const angle = Math.atan2(qy, qx);
  const r =
    Math.hypot(qx, qy) /
    (1 +
      0.1 * Math.sin(3 * angle + TAU * stone.seed) +
      0.06 * Math.sin(5 * angle + 2 * TAU * stone.seed));
  if (r >= 1) return 0;
  const tilt = TAU * stone.seed * 3.1;
  let h = Math.min(
    1.25 * Math.pow(1 - Math.pow(r, 2.6), 0.45),
    0.88 + 0.14 * (qx * Math.cos(tilt) + qy * Math.sin(tilt)),
  );
  for (let k = 0; k < 3; k++) {
    const a = TAU * (stone.seed + k / 3) + 0.4 * Math.sin(17 * stone.seed + k);
    h = Math.min(h, 2.2 * (1.08 - (qx * Math.cos(a) + qy * Math.sin(a))));
  }
  return stone.height * Math.max(h, 0);
}

/** The composition the default arrangement shows: four islands after the Ryōan-ji groups. */
function defaultIslands(): GardenIsland[] {
  return [
    {
      x: 0.8,
      y: 0.66,
      clear: 0.135,
      stones: [
        { x: 0.805, y: 0.675, rx: 0.043, ry: 0.034, height: 0.105, angle: 0.35, seed: 0.13 },
        { x: 0.735, y: 0.632, rx: 0.03, ry: 0.024, height: 0.05, angle: -0.4, seed: 0.61 },
        { x: 0.872, y: 0.622, rx: 0.024, ry: 0.018, height: 0.026, angle: 0.9, seed: 0.37 },
      ],
    },
    {
      x: 1.3,
      y: 0.86,
      clear: 0.1,
      stones: [
        { x: 1.285, y: 0.858, rx: 0.06, ry: 0.028, height: 0.033, angle: -0.15, seed: 0.82 },
        { x: 1.355, y: 0.872, rx: 0.027, ry: 0.024, height: 0.076, angle: 0.6, seed: 0.45 },
      ],
    },
    {
      x: 0.95,
      y: 0.3,
      clear: 0.075,
      stones: [{ x: 0.95, y: 0.3, rx: 0.036, ry: 0.028, height: 0.04, angle: 1.1, seed: 0.29 }],
    },
    {
      x: 1.74,
      y: 0.72,
      clear: 0.1,
      stones: [
        { x: 1.735, y: 0.73, rx: 0.036, ry: 0.03, height: 0.088, angle: -0.5, seed: 0.71 },
        { x: 1.8, y: 0.69, rx: 0.022, ry: 0.02, height: 0.034, angle: 0.2, seed: 0.05 },
      ],
    },
  ];
}

/**
 * Another arrangement: three or four islands of one to three stones, inside what the veranda sees,
 * clear of each other and of the M's patch. Seed 0 is the default composition.
 */
function layIslands(seed: number): GardenIsland[] {
  if (seed === 0) return defaultIslands();
  const rand = mulberry32(Math.imul(seed + 7, 0x9e3779b1));
  const count = rand() < 0.6 ? 4 : 3;
  const islands: GardenIsland[] = [];
  for (let attempt = 0; attempt < 400 && islands.length < count; attempt++) {
    const first = islands.length === 0;
    const clear = first ? 0.11 + 0.03 * rand() : 0.07 + 0.05 * rand();
    const y = 0.26 + 0.6 * rand();
    const half = Math.min(0.62 * (y - GARDEN.eyeY), 0.82) - clear - 0.04;
    if (half <= 0) continue;
    const x = OX + (2 * rand() - 1) * half;
    if (Math.hypot(x - GARDEN_MARK.x, y - GARDEN_MARK.y) < GARDEN_MARK.reserve + clear) continue;
    if (islands.some((o) => Math.hypot(x - o.x, y - o.y) < clear + o.clear + 0.12)) continue;
    const stones: GardenStone[] = [];
    const n = 1 + Math.floor(rand() * (clear > 0.1 ? 3 : 2));
    const mainR = clear * (0.28 + 0.08 * rand());
    const tall = first || rand() < 0.5;
    stones.push({
      x: x + (rand() - 0.5) * 0.02,
      y: y + (rand() - 0.5) * 0.02,
      rx: mainR,
      ry: mainR * (0.7 + 0.25 * rand()),
      height: tall ? 0.07 + 0.04 * rand() : 0.03 + 0.02 * rand(),
      angle: rand() * Math.PI,
      seed: rand(),
    });
    for (let k = 1; k < n; k++) {
      const r = mainR * (0.45 + 0.25 * rand());
      const a = rand() * TAU;
      const reach = Math.min(mainR + r * 0.9, clear - r - 0.01);
      stones.push({
        x: x + Math.cos(a) * reach,
        y: y + Math.sin(a) * reach,
        rx: r,
        ry: r * (0.7 + 0.25 * rand()),
        height: 0.02 + 0.035 * rand(),
        angle: rand() * Math.PI,
        seed: rand(),
      });
    }
    islands.push({ x, y, clear, stones });
  }
  return islands;
}

// ---- the plan ------------------------------------------------------------------------------------

/** A stretch the rake is drawn along without lifting: a polyline with cumulative distances. */
interface Stroke {
  readonly xy: Float64Array;
  readonly at: Float64Array;
  readonly length: number;
}

function strokeOf(points: readonly number[]): Stroke {
  const n = points.length >> 1;
  const xy = Float64Array.from(points);
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    at[i] =
      (at[i - 1] ?? 0) +
      Math.hypot(
        (xy[2 * i] ?? 0) - (xy[2 * i - 2] ?? 0),
        (xy[2 * i + 1] ?? 0) - (xy[2 * i - 1] ?? 0),
      );
  }
  return { xy, at, length: at[n - 1] ?? 0 };
}

interface Layout {
  pattern: GardenPattern;
  islands: GardenIsland[];
  /** The M's height, 0 when it is off. */
  mark: number;
}

/** The ring zone around island i (line patterns): its rings reach this far from the centre. */
const ringReach = (island: GardenIsland): number => island.clear + RING_LAPS * SWATH;
/** The M's slate half width, and the reach of its rings, from its strokes. */
const markSlate = (mark: number): number => GARDEN_MARK.stroke * mark;
const markReach = (mark: number): number => markSlate(mark) + RING_GAP + RING_LAPS * SWATH;

/** Inside some ring zone (where the line patterns lift the rake). */
function inRingZone(layout: Layout, x: number, y: number, grad: Float64Array): boolean {
  for (const island of layout.islands) {
    if (Math.hypot(x - island.x, y - island.y) < ringReach(island)) return true;
  }
  return layout.mark > 0 && markField(x, y, layout.mark, grad) < markReach(layout.mark);
}

/** Within the raked part of the field (a margin beyond the sides, so the edges are raked through). */
const inField = (x: number, y: number): boolean =>
  x > -0.06 && x < GA + 0.06 && y > PASS_FIRST - 0.06 && y < 1.0;

/**
 * Trace the closed contour at distance r around the M (marching along the level set, pulled back
 * onto it after every step), as plan points.
 */
function markContour(mark: number, r: number, grad: Float64Array): number[] {
  let x = GARDEN_MARK.x - 0.47 * mark - r;
  let y = GARDEN_MARK.y;
  const points = [x, y];
  let travelled = 0;
  const limit = 8 * (mark + TAU * r) + 1;
  while (travelled < limit) {
    markField(x, y, mark, grad);
    const mx = x + 0.5 * PLAN_STEP * (grad[1] ?? 0);
    const my = y - 0.5 * PLAN_STEP * (grad[0] ?? 0);
    markField(mx, my, mark, grad);
    x += PLAN_STEP * (grad[1] ?? 0);
    y -= PLAN_STEP * (grad[0] ?? 0);
    const d = markField(x, y, mark, grad);
    x -= (d - r) * (grad[0] ?? 0);
    y -= (d - r) * (grad[1] ?? 0);
    travelled += PLAN_STEP;
    points.push(x, y);
    if (
      travelled > 2 * mark &&
      Math.hypot(x - (points[0] ?? 0), y - (points[1] ?? 0)) < 1.5 * PLAN_STEP
    )
      break;
  }
  // Close it, and run on past the start so the lap's ends overlap.
  for (let k = 0; k < 16 && k < points.length; k++) points.push(points[k] ?? 0);
  return points;
}

/** A circle around (cx, cy), kept only where `keep` says, split into strokes. */
function ringStrokes(
  cx: number,
  cy: number,
  r: number,
  keep: (x: number, y: number) => boolean,
  strokes: Stroke[],
): boolean {
  const n = Math.max(12, Math.ceil((TAU * r) / PLAN_STEP));
  const kept: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    kept.push(keep(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  if (!kept.includes(true)) return false;
  // Start just after a gap (or anywhere on a full circle), so a run never straddles the seam.
  const gap = kept.indexOf(false);
  const start = gap < 0 ? 0 : gap;
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 4) {
      const stroke = strokeOf(run);
      if (stroke.length >= MIN_STROKE) strokes.push(stroke);
    }
    run = [];
  };
  // A full circle laps on past its start, so the lap's ends overlap.
  const total = gap < 0 ? n + 8 : n + 1;
  for (let k = 0; k <= total; k++) {
    const i = (start + k) % n;
    if (kept[i] === true) {
      const a = (i / n) * TAU;
      run.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    } else {
      flush();
    }
  }
  flush();
  return true;
}

/** The rake's choreography for a layout: every stroke of one full tending of the garden. */
function buildPlan(layout: Layout): Stroke[] {
  const strokes: Stroke[] = [];
  const grad = new Float64Array(2);
  const islands = layout.islands;
  if (layout.pattern === "circles") {
    // Rings spread out from every stone (and the M) at once, lap by lap, each kept to the gravel
    // nearer its own centre than any other (a power diagram on the clear radii).
    const own =
      (k: number) =>
      (x: number, y: number): boolean => {
        if (!inField(x, y)) return false;
        const mine =
          k < islands.length
            ? Math.hypot(x - (islands[k]?.x ?? 0), y - (islands[k]?.y ?? 0)) -
              (islands[k]?.clear ?? 0)
            : markField(x, y, layout.mark, grad) - markSlate(layout.mark);
        for (let j = 0; j < islands.length; j++) {
          const o = islands[j];
          if (j === k || o === undefined) continue;
          if (Math.hypot(x - o.x, y - o.y) - o.clear < mine) return false;
        }
        if (
          k < islands.length &&
          layout.mark > 0 &&
          markField(x, y, layout.mark, grad) - markSlate(layout.mark) < mine
        )
          return false;
        return true;
      };
    const centres = islands.length + (layout.mark > 0 ? 1 : 0);
    const live = new Array<boolean>(centres).fill(true);
    for (let lap = 0; lap < 40 && live.includes(true); lap++) {
      for (let k = 0; k < centres; k++) {
        if (live[k] !== true) continue;
        const island = islands[k];
        if (island !== undefined) {
          live[k] = ringStrokes(
            island.x,
            island.y,
            island.clear + RING_FIRST + lap * SWATH,
            own(k),
            strokes,
          );
        } else {
          const r = markSlate(layout.mark) + RING_FIRST + lap * SWATH;
          const run: number[] = [];
          const contour = markContour(layout.mark, r, grad);
          const keep = own(k);
          let any = false;
          for (let i = 0; i < contour.length; i += 2) {
            const x = contour[i] ?? 0;
            const y = contour[i + 1] ?? 0;
            if (keep(x, y)) {
              run.push(x, y);
              any = true;
            } else if (run.length > 0) {
              const stroke = strokeOf(run);
              if (stroke.length >= MIN_STROKE) strokes.push(stroke);
              run.length = 0;
            }
          }
          if (run.length >= 4) {
            const stroke = strokeOf(run);
            if (stroke.length >= MIN_STROKE) strokes.push(stroke);
          }
          live[k] = any;
        }
      }
    }
    return strokes;
  }

  // Line patterns: passes across the whole width, far to near, back and forth, the rake lifted over
  // the ring zones; then the rings around each island, inner lap first; then the M's.
  const waves = layout.pattern === "waves";
  for (let k = PASSES - 1; k >= 0; k--) {
    const y0 = PASS_FIRST + k * SWATH;
    const forward = (PASSES - 1 - k) % 2 === 0;
    const run: number[] = [];
    const flush = (): void => {
      if (run.length >= 4) {
        const stroke = strokeOf(run);
        if (stroke.length >= MIN_STROKE) strokes.push(stroke);
      }
      run.length = 0;
    };
    const n = Math.ceil((GA + 0.12) / PLAN_STEP);
    for (let i = 0; i <= n; i++) {
      const x = forward ? -0.06 + i * PLAN_STEP : GA + 0.06 - i * PLAN_STEP;
      const y = y0 + (waves ? waveAt(x) : 0);
      if (inRingZone(layout, x, y, grad)) flush();
      else run.push(x, y);
    }
    flush();
  }
  for (const island of islands) {
    for (let lap = 0; lap < RING_LAPS; lap++) {
      ringStrokes(island.x, island.y, island.clear + RING_FIRST + lap * SWATH, inField, strokes);
    }
  }
  if (layout.mark > 0) {
    for (let lap = 0; lap < RING_LAPS; lap++) {
      const contour = markContour(
        layout.mark,
        markSlate(layout.mark) + RING_FIRST + lap * SWATH,
        grad,
      );
      strokes.push(strokeOf(contour));
    }
  }
  return strokes;
}

/**
 * The groove phase the plan leaves at (x, y): grooves at whole numbers, NaN where the gravel is
 * left smooth (inside an island's clear radius, under the M, outside the raked field).
 */
function phaseAt(layout: Layout, x: number, y: number, grad: Float64Array): number {
  if (y < LINE_FIRST - 0.5 * RAKE.spacing || y > 1.0) return Number.NaN;
  const islands = layout.islands;
  const markOn = layout.mark > 0;
  const slate = markSlate(layout.mark);
  if (layout.pattern === "circles") {
    let best = Infinity;
    let phase = Number.NaN;
    for (const island of islands) {
      const d = Math.hypot(x - island.x, y - island.y) - island.clear;
      if (d < best) {
        best = d;
        phase = d < 0 ? Number.NaN : (d - RING_GAP) / RAKE.spacing;
      }
    }
    if (markOn) {
      const d = markField(x, y, layout.mark, grad) - slate;
      if (d < best) phase = d < 0 ? Number.NaN : (d - RING_GAP) / RAKE.spacing;
    }
    return phase;
  }
  // Later strokes win where ring zones overlap: the M, then the islands from last to first.
  if (markOn) {
    const d = markField(x, y, layout.mark, grad);
    if (d < markReach(layout.mark))
      return d < slate ? Number.NaN : (d - slate - RING_GAP) / RAKE.spacing;
  }
  for (let i = islands.length - 1; i >= 0; i--) {
    const island = islands[i];
    if (island === undefined) continue;
    const d = Math.hypot(x - island.x, y - island.y);
    if (d < ringReach(island))
      return d < island.clear ? Number.NaN : (d - island.clear - RING_GAP) / RAKE.spacing;
  }
  return (y - (layout.pattern === "waves" ? waveAt(x) : 0) - LINE_FIRST) / RAKE.spacing;
}

/**
 * A weathered groove across one period, phase 0 at the groove's centre: a rounded cut over half
 * the period, the spoil heaped in a hump between (equal volumes).
 */
function grooveProfile(phase: number): number {
  const u = Math.abs(phase - Math.round(phase));
  if (u < 0.25) {
    const s = u / 0.25;
    return -(1 - s * s);
  }
  return (Math.PI / 3) * Math.sin((Math.PI * (u - 0.25)) / 0.5);
}

/** A garden to lay out: its pattern, the arrangement of its stones (seed) and the M's height (0: off). */
export interface GardenLayoutRequest {
  readonly pattern: GardenPattern;
  readonly seed: number;
  readonly mark: number;
}

/** A garden laid out: its islands, the rake's plan, and the gravel laid from it (not yet smoothed). */
interface GardenLaid {
  readonly layout: Layout;
  readonly plan: Stroke[];
  readonly heights: Float32Array;
}

/** Rows of gravel a layout lays between looks at the build worker's messages. */
const LAY_ROWS = 40;

/**
 * Laying a garden out as a build (sims/build.ts): its islands, the rake's plan, and every texel of
 * the gravel at the groove phase the plan leaves there, with a weathered profile. The page smooths
 * it once and sets the rake down (GardenSim #relay).
 */
export const gardenLayout: BuildKind<GardenLayoutRequest, GardenLaid> = {
  name: "garden",
  builder: () => ({
    *build({ pattern, seed, mark }) {
      const layout: Layout = { pattern, islands: layIslands(seed), mark };
      const plan = buildPlan(layout);
      const w = GARDEN.cols;
      const h = GARDEN.rows;
      const heights = new Float32Array(w * h);
      const grad = new Float64Array(2);
      for (let j = 0; j < h; j++) {
        if (j % LAY_ROWS === 0) yield undefined;
        const y = (j + 0.5) / h;
        for (let i = 0; i < w; i++) {
          const phase = phaseAt(layout, ((i + 0.5) / w) * GA, y, grad);
          heights[j * w + i] = Number.isNaN(phase) ? 0 : LAID_AMPLITUDE * grooveProfile(phase);
        }
      }
      return { layout, plan, heights };
    },
  }),
};

// ---- the simulation ------------------------------------------------------------------------------

type GardenKnob =
  | "pattern"
  | "speed"
  | "soften"
  | "drying"
  | "moss"
  | "border"
  | "growth"
  | "stones"
  | "season"
  | "leaves"
  | "camera"
  | "time"
  | "rain"
  | "snow"
  | "wind"
  | "mark";
const KNOBS: readonly GardenKnob[] = [
  "pattern",
  "speed",
  "soften",
  "drying",
  "moss",
  "border",
  "growth",
  "stones",
  "season",
  "leaves",
  "camera",
  "time",
  "rain",
  "snow",
  "wind",
  "mark",
];

interface Settings {
  pattern: GardenPattern;
  season: GardenSeason;
  seed: number;
  /** Rake travel, garden depths per second (before motion). */
  speed: number;
  /** Diffusion per second for weathering. */
  soften: number;
  /** The weathering knob itself, 0..1. */
  weathering: number;
  /** "Drying with weather": its dampness while on, 0 while off. */
  drying: number;
  moss: number;
  /** The border planting's fullness while on, 0 while off. */
  border: number;
  /** The plants' growth pace while on, 0 while off. */
  growth: number;
  /** Leaf-fall knob 0..1. */
  leaves: number;
  overhead: boolean;
  /**
   * The sky clock: the hour knob and the days the day cycle has run (its phase), the date (SKY_YEAR;
   * -1 none) and the rain as it falls (snow in winter), for the drying pace.
   */
  time: number;
  days: number;
  year: number;
  rain: number;
  wind: number;
  /** The M's height, 0 when off. */
  mark: number;
  /** What a layout is made from: a change lays the garden out afresh. */
  signature: string;
}

class GardenSim implements SceneSim {
  readonly #knobs: KnobReader<GardenKnob>;
  /** The season knob, whose time of year sets what falls (src/climate.ts). */
  readonly #seasonDef: SeasonKnob | undefined;
  /** The trigger slot of the leaves knob: its "now" button shakes a gust loose. */
  readonly #gustSlot: number;
  /** The knobs as the sim reads them, rewritten in place each frame so frames allocate nothing. */
  readonly #current: Settings = {
    pattern: "waves",
    season: "autumn",
    seed: 0,
    speed: 0,
    soften: 0,
    weathering: 0,
    drying: 0,
    moss: 0,
    border: 0,
    growth: 0,
    leaves: 0,
    overhead: false,
    time: 0,
    days: 0,
    year: -1,
    rain: 0,
    wind: 0,
    mark: 0,
    signature: "",
  };
  /** What `#current.signature` was last built from, so the string is built only when one changes. */
  #signedPattern: GardenPattern | undefined = undefined;
  #signedSeed = -1;
  #signedMark = -1;
  /** The textures handed to the renderer every frame, in slot order. */
  readonly #textures: readonly (WebGLTexture | undefined)[];

  // The gravel, the drying grid and their textures.
  readonly #field = new HeightField(GARDEN.cols, GARDEN.rows, GA);
  readonly #heights: DataTexture;
  /**
   * When each spot was last raked, on the drying clock: seconds of garden time (dt × motion), or,
   * drying with the weather, run at the weather's pace (#dryingRate).
   */
  readonly #fresh = new AgeField(GARDEN_FRESH.cols, GARDEN_FRESH.rows, GA, 1);
  readonly #freshTexture: DataTexture;
  #freshAt = -Infinity;
  #heightsAt = -Infinity;

  // uSim1: the islands and stones, then the plant records.
  readonly #records: PlantTexture;
  // The woods over the wall (in the frame: screen heights from its left edge, uv height) and the
  // border (garden X, height above the gutter), each in its own air, which the gust's front crosses.
  readonly #woods = new RootedPlants(2 * GARDEN_WOODS.crowns, 0);
  readonly #border = new RootedPlants(GARDEN_BORDER.bins * GARDEN_BORDER.organs, 1);
  readonly #woodsAir = plantClimate();
  readonly #borderAir = plantClimate();
  /** The fullness the border was planted for (0: nothing planted). */
  #fullness = 0;
  /** Seconds the air has been still (no wind, no gust about), and whether the plants were set at rest in it since. */
  #stillFor = 0;
  #rested = false;
  /** The wind and season the plants last moved in; undefined before the first frame. */
  #plantWind: number | undefined = undefined;
  #plantSeason: GardenSeason = "autumn";

  // The plan and the rake on it.
  #layout: Layout = { pattern: "waves", islands: [], mark: 0 };
  /** Laying out a garden on the build worker (sims/build.ts), and whether one has been laid yet. */
  readonly #laying = new BuildSlot(gardenLayout);
  #laid = false;
  readonly #settle = new Settle<string>(RELAYOUT_MS);
  #plan: Stroke[] = [];
  #stroke = 0;
  #along = 0;
  /** Index of the plan vertex at or before #along on the current stroke. */
  #vertex = 0;
  #pause = 0;
  /** The rake has just been set down: level the stretch ahead of its tines before the first cut. */
  #landing = true;
  /** Where the rake's tines are and which way they travel (for sweeping up leaves); on while raking. */
  #rakeX = 0;
  #rakeY = 0;
  #rakeDX = 1;
  #rakeDY = 0;
  #rakeOn = false;
  #smoothDue = 0;
  readonly #grad = new Float64Array(2);
  readonly #segA = new Float64Array(2);
  readonly #segB = new Float64Array(2);
  /** The garden point under the pointer (x, y), written by #groundUnder. */
  readonly #ground = new Float64Array(2);

  // The pointer's hand rake.
  #handOn = false;
  #handX = 0;
  #handY = 0;

  // Leaves.
  readonly #state = new Uint8Array(GARDEN_LEAF_SLOTS);
  readonly #kind = new Uint8Array(GARDEN_LEAF_SLOTS);
  readonly #x = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #y = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #z = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Each leaf's plate in flight: its plane, pitch, spin, rock, mass, chord, pace and the pitch it lands and rests at. */
  readonly #plates = new FlutterPlates(GARDEN_LEAF_SLOTS, ROLL);
  /** A leaf's position for the plates (x, y, z), and its frame from them (#packLeaves). */
  readonly #pos = new Float64Array(3);
  readonly #frame = new Float64Array(9);
  /** Where a falling leaf touches down: on the gravel, a moss cushion or a stone, as it lies there. */
  readonly #floor = (x: number, y: number): number =>
    this.#groundAt(x, y, this.#current.moss) + LEAF_LIFT;
  readonly #radius = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #hue = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Seconds since it landed. */
  readonly #lain = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #life = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #alpha = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Slide velocity on the gravel (swept by the rake or skittering in a gust). */
  readonly #vx = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #vy = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #leafData = new Float32Array(GARDEN_LEAF_SLOTS * 4 * 4);
  readonly #leafTexture: DataTexture;
  #leafRand = mulberry32(1);
  #nextLeaf = 0;
  #season: GardenSeason = "autumn";

  // Gusts.
  #gustAge = Infinity;
  #gustSign = 1;
  #shower = 0;
  // The scene's passage (see GARDEN_PASSAGE): the leaves it adds draw from their own sequence.
  readonly #passageRand = mulberry32(0x70617373);
  /** Whether this sim was built while the scene came in; undefined until its first frame. */
  #arriving: boolean | undefined = undefined;
  /** Entrance leaves let go so far, and flurry leaves. */
  #strewn = 0;
  #flurried = 0;
  #leaving = false;
  /** How many times harder than a "now" gust the current one pushes leaves: 1, but the exit's flurry. */
  #gustPush = 1;

  #aspect = 16 / 9;
  #overhead = false;
  /** The sky's staged date (skyAnchor; -1 none); the sky the drying last read, its hour and date. */
  readonly #anchor: number;
  #sky: SkyState | undefined = undefined;
  #skyTod = Number.NaN;
  #skyYear = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden", params, KNOBS);
    this.#seasonDef = seasonKnob(params);
    this.#anchor = skyAnchor(params) ?? -1;
    this.#gustSlot = this.#knobs.trigger("leaves");
    this.#heights = new DataTexture(gl, {
      width: GARDEN.cols,
      height: GARDEN.rows,
      format: "r16f",
    });
    this.#freshTexture = new DataTexture(gl, {
      width: GARDEN_FRESH.cols,
      height: GARDEN_FRESH.rows,
      format: "r16f",
    });
    this.#records = new PlantTexture(gl, RECORDS, {
      width: RECORD_WIDTH,
      rowBase: GARDEN_RECORD_ROW,
    });
    this.#leafTexture = new DataTexture(gl, {
      width: 4,
      height: GARDEN_LEAF_SLOTS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [
      this.#heights.texture,
      this.#records.texture,
      this.#leafTexture.texture,
      this.#freshTexture.texture,
    ];
    // The gust's front where an organ is: the woods' x across the frame taken at the wall, the
    // border's garden X as it is.
    this.#woodsAir.wind = (x, _y, out) => {
      out[0] =
        (out[0] ?? 0) +
        this.#gustFront(
          OX + ((x - 0.5 * this.#aspect) * (GARDEN.wallY - GARDEN.eyeY)) / GARDEN.focal,
        );
    };
    this.#borderAir.wind = (x, _y, out) => {
      out[0] = (out[0] ?? 0) + this.#gustFront(x);
    };
    // The plants standing in the air; the garden itself is laid out on the build worker (#relay).
    const settings = this.#settings(undefined);
    this.#season = settings.season;
    growWoods(this.#woods);
    this.#plantAir(0, 0, settings);
    this.#fullness = settings.border;
    growBorder(this.#border, settings.border);
    this.#woods.settle(this.#woodsAir);
    this.#border.settle(this.#borderAir);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = this.#settings(frame);
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.#aspect = frame.aspect;
    this.#overhead = settings.overhead;
    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const now = frame.now;

    // The garden for the pattern, the arrangement and the M, laid out on the build worker: the first
    // at once, a change once its knob has rested RELAYOUT_MS, the garden on show staying meanwhile.
    const signature = settings.signature;
    if (this.#settle.stands(signature)) this.#laying.cancel();
    else if (this.#settle.due(signature, now)) {
      const { pattern, seed, mark } = settings;
      this.#laying.request(signature, { pattern, seed, mark });
    }
    const laid = this.#laying.advance(frame.budget);
    if (laid) {
      this.#relay(laid.key, laid.result);
      if (!this.#laid) {
        // The first garden shows leaves already lying about, and a few on their way down.
        this.#laid = true;
        this.#season = settings.season;
        this.#prewarmLeaves(settings);
      }
    }
    if (!this.#laid) {
      // Nothing runs until the first garden is laid: the gravel lies flat and bare meanwhile.
      this.#packIslandsAndPlants();
      return this.#textures;
    }
    if (settings.season !== this.#season) this.#reskin(settings.season);

    this.#watchGust(frame.fired, settings);
    this.#passage(frame, settings);
    const step = dt * frame.motion;
    this.#fresh.advance(settings.drying > 0 ? step * this.#dryingRate(settings) : step);

    this.#tend(step, settings);
    this.#handRake(frame.pointer, settings);
    // A "now" gust plays even with motion off.
    const busy = this.#gustAge < GUST_BUSY;
    const air = dt * Math.max(frame.motion, busy ? 1 : 0);
    this.#leaves(air, settings);
    this.#sway(air, frame, settings);
    if (this.#gustAge < GUST_BUSY) this.#gustAge += dt;

    if (now - this.#heightsAt >= UPLOAD_EVERY_MS && this.#field.upload(this.#heights))
      this.#heightsAt = now;
    if (now - this.#freshAt >= UPLOAD_EVERY_MS && this.#fresh.upload(this.#freshTexture))
      this.#freshAt = now;
    this.#packIslandsAndPlants();
    this.#packLeaves();
    return this.#textures;
  }

  /** Ready once the first garden is laid out (on the build worker). */
  ready(): boolean {
    return this.#laid;
  }

  dispose(): void {
    this.#laying.dispose();
    this.#heights.dispose();
    this.#freshTexture.dispose();
    this.#records.dispose();
    this.#leafTexture.dispose();
  }

  // ---- knobs ---------------------------------------------------------------------------------------

  #settings(frame: SimFrame | undefined): Settings {
    const s = this.#current;
    const pattern = gardenPatterns[Math.round(this.#knob(frame, "pattern"))] ?? "waves";
    const seed = Math.max(0, Math.round(this.#knob(frame, "stones")));
    const markKnob = this.#knob(frame, "mark");
    const mark = markKnob > 0 ? GARDEN_MARK.small + GARDEN_MARK.grow * markKnob : 0;
    s.pattern = pattern;
    s.season = gardenSeasons[Math.round(this.#knob(frame, "season"))] ?? "autumn";
    s.seed = seed;
    s.speed = RAKE_SPEED * clamp(this.#knob(frame, "speed"), 0, 1);
    s.soften = SMOOTH_RATE * clamp(this.#knob(frame, "soften"), 0, 1);
    s.weathering = clamp(this.#knob(frame, "soften"), 0, 1);
    s.drying = this.#knob(frame, "drying");
    s.moss = clamp(this.#knob(frame, "moss"), 0, 1);
    s.border = this.#knob(frame, "border");
    s.growth = this.#knob(frame, "growth");
    s.leaves = clamp(this.#knob(frame, "leaves"), 0, 1);
    s.overhead = this.#knob(frame, "camera") > 0.5;
    s.time = this.#knob(frame, "time");
    s.days = frame?.phases?.["cycle"] ?? 0;
    const season = this.#seasonDef;
    s.year = season ? yearAt(season, this.#knob(frame, "season")) : -1;
    const cold = climateCold(s.year);
    s.rain = fallingRain(this.#knob(frame, "rain"), cold);
    s.wind = clamp(this.#knob(frame, "wind"), -1, 1);
    s.mark = mark;
    if (pattern !== this.#signedPattern || seed !== this.#signedSeed || mark !== this.#signedMark) {
      this.#signedPattern = pattern;
      this.#signedSeed = seed;
      this.#signedMark = mark;
      s.signature = `${pattern}|${seed}|${mark.toFixed(3)}`;
    }
    return s;
  }

  /** A knob as the shader sees it; before the first frame, as it reads at the scene's defaults. */
  #knob(frame: SimFrame | undefined, key: GardenKnob): number {
    return frame === undefined ? this.#knobs.initial(key) : this.#knobs.value(frame, key);
  }

  /**
   * The drying clock's pace while drying with the weather: dryingPace for the sky as the shader has
   * it (skyState at its hour and, the garden's sky being dated, its date), the wind and the rain,
   * times the weathering knob's own pace, 1 at its default and doubling with every 0.3 more, so the
   * one knob ages a mark's relief and its damp alike. The sky is worked out again only as its hour or
   * date moves.
   */
  #dryingRate(settings: Settings): number {
    const tod = timeOfDay(settings.time, settings.days);
    if (this.#sky === undefined || tod !== this.#skyTod || settings.year !== this.#skyYear) {
      this.#sky = skyState(tod, { shift: dateShift(settings.year, this.#anchor) });
      this.#skyTod = tod;
      this.#skyYear = settings.year;
    }
    const weathering = 2 ** ((settings.weathering - this.#knobs.initial("soften")) / 0.3);
    return weathering * dryingPace(this.#sky, settings.wind, settings.rain);
  }

  // ---- laying out ----------------------------------------------------------------------------------

  /**
   * A garden laid out (gardenLayout, under `signature`) set down: its islands and plan, the gravel
   * laid from it and rounded off, the rake set down to begin.
   */
  #relay(signature: string, { layout, plan, heights }: GardenLaid): void {
    this.#settle.lay(signature);
    this.#layout = layout;
    this.#plan = plan;
    const field = this.#field;
    field.data.set(heights);
    field.touch();
    // Round the profile off, as weather would.
    field.smooth(0.6);
    this.#fresh.reset();
    this.#smoothDue = SMOOTH_EVERY;
    this.#rakeOn = false;
    this.#packIslandsAndPlants();
    // The rake begins at the plan point nearest LIVE_START, where both views see it at work.
    let best = Infinity;
    let start = 0;
    let offset = 0;
    for (const stroke of this.#plan) {
      const n = stroke.xy.length >> 1;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(
          (stroke.xy[2 * i] ?? 0) - LIVE_START.x,
          (stroke.xy[2 * i + 1] ?? 0) - LIVE_START.y,
        );
        if (d < best) {
          best = d;
          start = offset + (stroke.at[i] ?? 0);
        }
      }
      offset += stroke.length + STROKE_PAUSE;
    }
    this.#seek(start);
  }

  /** Set the rake down at plan distance `at` (pauses count STROKE_PAUSE each). */
  #seek(at: number): void {
    this.#landing = true;
    let rest = at;
    for (let k = 0; k < this.#plan.length; k++) {
      const stroke = this.#plan[k];
      if (stroke === undefined) continue;
      if (rest < stroke.length) {
        this.#stroke = k;
        this.#along = rest;
        this.#pause = 0;
        this.#vertex = 0;
        while ((stroke.at[this.#vertex + 1] ?? Infinity) <= rest) this.#vertex++;
        return;
      }
      rest -= stroke.length;
      if (rest < STROKE_PAUSE) {
        this.#stroke = (k + 1) % this.#plan.length;
        this.#along = 0;
        this.#vertex = 0;
        this.#pause = STROKE_PAUSE - rest;
        return;
      }
      rest -= STROKE_PAUSE;
    }
    this.#stroke = 0;
    this.#along = 0;
    this.#vertex = 0;
    this.#pause = 0;
  }

  // ---- raking --------------------------------------------------------------------------------------

  /** One frame of tending: the rake moves on (sweeping up leaves in its way), the grooves slump and weather. */
  #tend(step: number, settings: Settings): void {
    if (!(step > 0)) return;
    if (settings.speed > 0) {
      this.#advance(settings.speed * step);
      if (this.#rakeOn)
        this.#sweep(
          this.#rakeX,
          this.#rakeY,
          this.#rakeDX,
          this.#rakeDY,
          LEVEL_HALF,
          settings.speed,
        );
    } else {
      this.#rakeOn = false;
    }
    this.#field.relax(TALUS, SLUMP_RATE, step, RELAX_ROWS);
    this.#smoothDue -= step;
    if (this.#smoothDue <= 0) {
      this.#field.smooth(settings.soften * (SMOOTH_EVERY - this.#smoothDue));
      this.#smoothDue = SMOOTH_EVERY;
    }
  }

  /**
   * Move the rake `distance` along the plan: level ahead, cut, note the freshly raked gravel. It
   * goes in steps of at most MAX_PIECE, so on a bend each piece's banks meet the next's evenly.
   */
  #advance(distance: number): void {
    const plan = this.#plan;
    let budget = distance;
    let guard = 0;
    this.#rakeOn = false;
    while (budget > 1e-9 && plan.length > 0 && guard++ < 10_000) {
      if (this.#pause > 0) {
        const rest = Math.min(this.#pause, budget);
        this.#pause -= rest;
        budget -= rest;
        continue;
      }
      const stroke = plan[this.#stroke];
      if (stroke === undefined) {
        this.#stroke = 0;
        continue;
      }
      const s0 = this.#along;
      const s1 = Math.min(stroke.length, s0 + Math.min(budget, MAX_PIECE));
      if (this.#landing) {
        this.#pieces(stroke, s0, Math.min(s0 + LEAD, stroke.length), this.#vertex, false);
        this.#landing = false;
      }
      this.#pieces(
        stroke,
        Math.min(s0 + LEAD, stroke.length),
        Math.min(s1 + LEAD, stroke.length),
        this.#vertex,
        false,
      );
      this.#vertex = this.#pieces(stroke, s0, s1, this.#vertex, true);
      budget -= s1 - s0;
      this.#along = s1;
      if (s1 >= stroke.length) {
        this.#stroke = (this.#stroke + 1) % plan.length;
        this.#along = 0;
        this.#vertex = 0;
        this.#pause = STROKE_PAUSE;
        this.#landing = true;
      }
    }
  }

  /** Point at distance s along a stroke into `out`, searching from vertex index `from`. */
  #pointAt(stroke: Stroke, s: number, from: number, out: Float64Array): number {
    let i = Math.max(0, from);
    const last = (stroke.xy.length >> 1) - 1;
    while (i < last - 1 && (stroke.at[i + 1] ?? Infinity) <= s) i++;
    const a = stroke.at[i] ?? 0;
    const b = stroke.at[i + 1] ?? a;
    const t = b > a ? clamp((s - a) / (b - a), 0, 1) : 0;
    out[0] = lerp(stroke.xy[2 * i] ?? 0, stroke.xy[2 * i + 2] ?? 0, t);
    out[1] = lerp(stroke.xy[2 * i + 1] ?? 0, stroke.xy[2 * i + 3] ?? 0, t);
    return i;
  }

  /** Visit the polyline pieces of a stroke between distances s0 and s1: cut each with the tines (`rake`), or level it. */
  #pieces(stroke: Stroke, s0: number, s1: number, from: number, rake: boolean): number {
    if (!(s1 > s0)) return from;
    const a = this.#segA;
    const b = this.#segB;
    let i = this.#pointAt(stroke, s0, from, a);
    let s = s0;
    while (s < s1) {
      const next = Math.min(s1, stroke.at[i + 1] ?? s1);
      i = this.#pointAt(stroke, next, i, b);
      if (rake) this.#rakePiece(a[0] ?? 0, a[1] ?? 0, b[0] ?? 0, b[1] ?? 0);
      else this.#level(a[0] ?? 0, a[1] ?? 0, b[0] ?? 0, b[1] ?? 0, LEVEL_HALF);
      a[0] = b[0] ?? 0;
      a[1] = b[1] ?? 0;
      if (next <= s) break;
      s = next;
      if ((stroke.at[i + 1] ?? Infinity) <= s) i++;
    }
    return i;
  }

  /** The tines cut one piece of the plan, and the gravel it turned over is stamped fresh. */
  #rakePiece(ax: number, ay: number, bx: number, by: number): void {
    this.#field.rake(ax / GA, ay, bx / GA, by, RAKE);
    const length = Math.hypot(bx - ax, by - ay);
    this.#fresh.stamp(ax, ay, bx, by, LEVEL_HALF);
    if (length > 1e-9) {
      this.#rakeDX = (bx - ax) / length;
      this.#rakeDY = (by - ay) / length;
    }
    this.#rakeX = bx;
    this.#rakeY = by;
    this.#rakeOn = true;
  }

  /**
   * The leveling board: drawn from (ax, ay) to (bx, by), it eases the gravel within `half` of its
   * centre line back to the rest level, softly at its ends of the board, so the old pattern goes
   * before the tines cut the new one. Half-open along the stroke, so consecutive pieces tile.
   */
  #level(ax: number, ay: number, bx: number, by: number, half: number): void {
    const field = this.#field;
    const w = field.width;
    const h = field.height;
    const data = field.data;
    const tw = GA / w;
    const th = 1 / h;
    let ux = bx - ax;
    let uy = by - ay;
    const length = Math.hypot(ux, uy);
    if (!(length > 1e-9)) return;
    ux /= length;
    uy /= length;
    const nx = -uy;
    const ny = ux;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - half) / tw - 0.5));
    const i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + half) / tw - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - half) / th - 0.5));
    const j1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + half) / th - 0.5));
    if (i0 > i1 || j0 > j1) return;
    const inner = half - LEVEL_SOFT;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * th - ay;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * tw - ax;
        const t = px * ux + py * uy;
        if (t < 0 || t >= length) continue;
        const d = Math.abs(px * nx + py * ny);
        if (d >= half) continue;
        const e = d <= inner ? 1 : (half - d) / LEVEL_SOFT;
        const k = row + i;
        data[k] = (data[k] ?? 0) * (1 - e * e * (3 - 2 * e));
      }
    }
    field.touch();
  }

  /** Drag on the gravel: rake your own lines with a hand rake. */
  #handRake(pointer: PrincipalState, settings: Settings): void {
    const at = this.#ground;
    if (
      !(pointer.inside && pointer.down && this.#groundUnder(pointer.x, pointer.y, at)) ||
      this.#onStone(at[0] ?? 0, at[1] ?? 0)
    ) {
      this.#handOn = false;
      return;
    }
    const x = at[0] ?? 0;
    const y = at[1] ?? 0;
    if (!this.#handOn || pointer.pressed) {
      this.#handOn = true;
      this.#handX = x;
      this.#handY = y;
      return;
    }
    const length = Math.hypot(x - this.#handX, y - this.#handY);
    if (length < HAND_STEP) return;
    this.#level(this.#handX, this.#handY, x, y, HAND_LEVEL_HALF);
    this.#field.rake(this.#handX / GA, this.#handY, x / GA, y, HAND);
    this.#fresh.stamp(this.#handX, this.#handY, x, y, HAND_LEVEL_HALF);
    this.#sweep(
      x,
      y,
      (x - this.#handX) / length,
      (y - this.#handY) / length,
      HAND_LEVEL_HALF,
      Math.max(settings.speed, 0.05),
    );
    this.#handX = x;
    this.#handY = y;
  }

  /** Within an island's clear radius, where the rake is lifted. */
  #onStone(x: number, y: number): boolean {
    for (const island of this.#layout.islands) {
      if (Math.hypot(x - island.x, y - island.y) < island.clear * 0.85) return true;
    }
    return (
      this.#layout.mark > 0 &&
      markField(x, y, this.#layout.mark, this.#grad) < markSlate(this.#layout.mark) + 0.01
    );
  }

  /** The garden point under screen uv (u, v) into `out` (x, y); false off the gravel. */
  #groundUnder(u: number, v: number, out: Float64Array): boolean {
    let x: number;
    let y: number;
    if (this.#overhead) {
      x = OX + (u - 0.5) * this.#aspect * GARDEN.span;
      y = GARDEN.overheadY + (v - 0.5) * GARDEN.span;
    } else {
      const down = GARDEN.horizon - v;
      if (down <= 1e-3) return false;
      const s = GARDEN.eyeHeight / down;
      x = OX + (u - 0.5) * this.#aspect * s;
      y = GARDEN.eyeY + GARDEN.focal * s;
    }
    if (y < GARDEN.drip + 0.01 || y > 1.0 || x < 0 || x > GA) return false;
    out[0] = x;
    out[1] = y;
    return true;
  }

  /** Screen uv of garden point (x, y, z) in the current view, or undefined behind the camera. */
  #project(x: number, y: number, z: number): { u: number; v: number } | undefined {
    if (this.#overhead) {
      const s = GARDEN.overheadHeight / Math.max(GARDEN.overheadHeight - z, 1e-3);
      return {
        u: 0.5 + ((x - OX) * s) / GARDEN.span / this.#aspect,
        v: 0.5 + ((y - GARDEN.overheadY) * s) / GARDEN.span,
      };
    }
    const depth = y - GARDEN.eyeY;
    if (depth <= 0.02) return undefined;
    return {
      u: 0.5 + (GARDEN.focal * (x - OX)) / depth / this.#aspect,
      v: GARDEN.horizon + (GARDEN.focal * (z - GARDEN.eyeHeight)) / depth,
    };
  }

  // ---- islands -------------------------------------------------------------------------------------

  /** What a leaf comes to rest on at (x, y): gravel, a moss cushion or a stone. */
  #groundAt(x: number, y: number, moss: number): number {
    let top = this.#field.sample(x / GA, y);
    const cover = smoothstep(0, 0.15, moss);
    for (const island of this.#layout.islands) {
      const r = Math.hypot(x - island.x, y - island.y);
      if (r >= island.clear) continue;
      const reach = island.clear * (GARDEN_MOSS.base + GARDEN_MOSS.grow * moss);
      if (r < reach) {
        const s = 1 - (r / reach) * (r / reach);
        top = Math.max(top, GARDEN_MOSS.height * cover * s * s);
      }
      for (const stone of island.stones) top = Math.max(top, stoneHeight(stone, x, y));
    }
    if (
      this.#layout.mark > 0 &&
      markField(x, y, this.#layout.mark, this.#grad) < markSlate(this.#layout.mark)
    )
      top = Math.max(top, GARDEN_MARK.slate);
    return top;
  }

  /**
   * uSim1, a PlantTexture RECORD_WIDTH texels a row. Row 0: island i at column i (x, y relative to
   * the garden's centre, clear radius, tallest stone; clear 0 = none), then at column GARDEN_ISLANDS
   * (drying clock, 0, 0, 0). Row 1 + j: stone j of island i at columns 2i (x, y, rx, ry) and 2i + 1
   * (height, angle, seed, 0); height 0 = none. From row GARDEN_RECORD_ROW on: the records of the
   * woods' stems and of the border's organs (GARDEN_WOODS, GARDEN_BORDER).
   */
  #packIslandsAndPlants(): void {
    const records = this.#records;
    const data = records.data;
    data.fill(0, 0, GARDEN_RECORD_ROW * RECORD_WIDTH * 4);
    const islands = this.#layout.islands;
    for (let i = 0; i < GARDEN_ISLANDS; i++) {
      const island = islands[i];
      if (island === undefined) continue;
      let tallest = 0;
      for (let j = 0; j < Math.min(GARDEN_STONES, island.stones.length); j++) {
        const stone = island.stones[j];
        if (stone === undefined) continue;
        tallest = Math.max(tallest, stone.height);
        const a = ((1 + j) * RECORD_WIDTH + 2 * i) * 4;
        data[a] = stone.x - OX;
        data[a + 1] = stone.y - OY;
        data[a + 2] = stone.rx;
        data[a + 3] = stone.ry;
        data[a + 4] = stone.height;
        data[a + 5] = stone.angle;
        data[a + 6] = stone.seed;
      }
      const k = i * 4;
      data[k] = island.x - OX;
      data[k + 1] = island.y - OY;
      data[k + 2] = island.clear;
      data[k + 3] = 1.03 * tallest + 0.004;
    }
    data[GARDEN_ISLANDS * 4] = this.#fresh.clock;
    records.pack(this.#woods, this.#border);
    records.upload();
  }

  // ---- the woods and the border --------------------------------------------------------------------

  /** The air both plant systems stand in for `h` seconds at the motion clock `time` (see #sway). */
  #plantAir(h: number, time: number, settings: Settings): void {
    for (let n = 0; n < 2; n++) {
      const climate = n === 0 ? this.#woodsAir : this.#borderAir;
      climate.dt = h;
      climate.time = time;
      climate.season = PLANT_SEASON[settings.season];
      climate.growth = settings.growth;
      climate.air.x = settings.wind;
      climate.air.eddy = PLANT_EDDY;
    }
  }

  /**
   * The garden's gust at garden X: a front setting out from the garden's upwind end as the gust
   * begins (a "now", the exit's flurry) and crossing it at GUST_FRONT, so the plants bow one after
   * another, reaching what stands beyond either end with that end; signed with the gust, GUST_PUSH
   * at its peak. It is over everywhere within GUST_BUSY.
   */
  #gustFront(x: number): number {
    const from = clamp(this.#gustSign > 0 ? x : GA - x, 0, GA);
    return (
      this.#gustSign * GUST_PUSH * gustPulse(this.#gustAge - from / GUST_FRONT, GARDEN_GUST_RISE)
    );
  }

  /**
   * The woods and the border for `h` seconds in the garden's air: the wind knob's breeze with its
   * eddies, and the gust's front. They swing while the air moves them; once the air is still (no
   * wind, no gust about) they are set exactly at rest, after PLANT_SETTLE seconds of swinging out or
   * at once while time stands still (h = 0), and stepping then keeps them there. On the first frame,
   * and with time standing still when the wind or the season changes, they are set at rest in the
   * air as it is (a still step). The border is planted afresh when its fullness changes.
   */
  #sway(h: number, frame: SimFrame, settings: Settings): void {
    const woods = this.#woods;
    const border = this.#border;
    // Dither cells per unit, for the organs' tiers: the woods' unit is a screen height, the border's a
    // garden depth, seen across the garden from the veranda or from above.
    const cells = frame.height > 0 ? frame.height : woods.cells;
    const borderCells =
      cells *
      (settings.overhead ? 1 / GARDEN.span : GARDEN.focal / (GARDEN_BORDER.y - GARDEN.eyeY));
    const retier = cells !== woods.cells || borderCells !== border.cells;
    woods.cells = cells;
    border.cells = borderCells;
    this.#plantAir(h, frame.motionTime, settings);
    if (settings.border !== this.#fullness) {
      this.#fullness = settings.border;
      growBorder(border, settings.border);
      border.settle(this.#borderAir);
    }
    const still = settings.wind === 0 && !(this.#gustAge < GUST_BUSY);
    this.#stillFor = still ? this.#stillFor + h : 0;
    if (!still) this.#rested = false;
    let settle =
      this.#plantWind === undefined ||
      (h === 0 && (settings.wind !== this.#plantWind || settings.season !== this.#plantSeason));
    if (!settle && h > 0) {
      woods.step(this.#woodsAir);
      border.step(this.#borderAir);
      settle = still && !this.#rested && this.#stillFor >= PLANT_SETTLE;
    } else if (!settle) {
      settle = still && !this.#rested;
    }
    if (settle) {
      woods.settle(this.#woodsAir);
      border.settle(this.#borderAir);
      this.#rested = still;
    } else if (h === 0 && retier) {
      woods.pose();
      border.pose();
    }
    this.#plantWind = settings.wind;
    this.#plantSeason = settings.season;
  }

  // ---- leaves --------------------------------------------------------------------------------------

  #watchGust(fired: readonly boolean[], settings: Settings): void {
    if (!fired[this.#gustSlot]) return;
    this.#gustAge = 0;
    this.#gustSign = windSign(settings.wind);
    this.#shower = GUST_SHOWER;
  }

  /**
   * The scene's passage. A sim built while the scene comes in lets a few leaves go from the boughs
   * as it arrives; once it leaves, a gust (the "now" gust, its rise drawn out over the whole exit so
   * it is at its strongest as the scene goes; the shader's boughs lean with it on the same clock)
   * blows a flurry of leaves in from upwind and carries off the ones lying on the gravel. Nothing
   * here runs at rest.
   */
  #passage(frame: SimFrame, settings: Settings): void {
    const { enter, exit } = frame.passage;
    if (this.#arriving === undefined) this.#arriving = enter < 1;
    if (this.#arriving) {
      if (enter >= 1) {
        this.#arriving = false;
      } else {
        const total =
          settings.leaves > 0
            ? Math.round(ENTRANCE_LEAVES * Math.min(1, 2 * FALL_RATE[settings.season]))
            : 0;
        const seconds = enter * GARDEN_PASSAGE.enter;
        while (this.#strewn < total && seconds >= ENTRANCE_FIRST + ENTRANCE_GAP * this.#strewn) {
          this.#strewn++;
          this.#spawn(settings, false, this.#passageRand, "entrance");
        }
      }
    }
    if (exit > 0) {
      const seconds = exit * GARDEN_PASSAGE.exit;
      if (!this.#leaving) {
        this.#leaving = true;
        this.#gustSign = windSign(settings.wind);
        this.#gustPush = FLURRY_BOOST;
      }
      this.#gustAge = exit * GARDEN_GUST_RISE;
      while (
        this.#flurried < FLURRY_LEAVES &&
        seconds >= (FLURRY_SPAN * this.#flurried) / FLURRY_LEAVES
      ) {
        this.#flurried++;
        this.#spawn(settings, false, this.#passageRand, "flurry");
      }
    } else if (this.#leaving) {
      this.#leaving = false;
      this.#gustPush = 1;
    }
  }

  /** Give the leaves on the ground (and in the air) the new season's colours. */
  #reskin(season: GardenSeason): void {
    this.#season = season;
    const kind = SEASON_KIND[season];
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] === FREE) continue;
      this.#kind[i] = kind;
      this.#radius[i] = SPECS[kind].radius * (0.85 + 0.3 * this.#leafRand());
    }
  }

  #leaves(dt: number, settings: Settings): void {
    if (!(dt > 0)) return;
    const rand = this.#leafRand;
    // Let go: leaves at the knob's pace, and a gust's shower over its first moments.
    const rate = settings.leaves * FALL_RATE[settings.season];
    if (rate > 0) {
      this.#nextLeaf -= dt;
      if (this.#nextLeaf <= 0) {
        this.#spawn(settings, false);
        this.#nextLeaf = -Math.log(1 - 0.999 * rand()) / rate;
      }
    }
    // The shower comes down over the gust's first moments, as slots free up (the gust blows some
    // lying leaves away).
    if (this.#shower > 0 && this.#gustAge < GUST_SHAKE + 3) {
      const due =
        this.#gustAge < GUST_SHAKE ? Math.ceil(GUST_SHOWER * (1 - this.#gustAge / GUST_SHAKE)) : 0;
      while (this.#shower > due && this.#spawn(settings, true) !== undefined) this.#shower--;
    }
    // Keep room in the air: past LANDED_MAX on the ground, the oldest starts to fade.
    let landed = 0;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++)
      if (this.#state[i] === LANDED && (this.#lain[i] ?? 0) < (this.#life[i] ?? 0)) landed++;
    if (landed > LANDED_MAX) this.#retireOldest();

    const gust = gustPulse(this.#gustAge, GARDEN_GUST_RISE) * this.#gustSign;
    const windX = settings.wind * WIND_DRIFT + gust * GUST_DRIFT * this.#gustPush;
    const lift = Math.abs(gust) * GUST_LIFT * this.#gustPush;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      const state = this.#state[i];
      if (state === FALLING) {
        this.#alpha[i] = Math.min(1, (this.#alpha[i] ?? 0) + dt / FADE_IN);
        this.#fall(i, dt, windX, lift, settings);
      } else if (state === LANDED) {
        this.#lie(i, dt, gust, settings);
      } else if (state === LEAVING) {
        this.#leave(i, dt);
      }
    }
  }

  /** A free slot; when there is none, the oldest leaf lying on the gravel is made to fade. */
  #slot(): number | undefined {
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) if (this.#state[i] === FREE) return i;
    this.#retireOldest();
    return undefined;
  }

  /** Start the oldest lying leaf fading, unless one already is. */
  #retireOldest(): void {
    let oldest = -1;
    let oldestAge = -1;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] !== LANDED) continue;
      const lain = this.#lain[i] ?? 0;
      if (lain >= (this.#life[i] ?? 0)) return;
      if (lain > oldestAge) {
        oldestAge = lain;
        oldest = i;
      }
    }
    if (oldest >= 0) this.#life[oldest] = oldestAge;
  }

  /**
   * A leaf lets go: from the maple's foliage, or (on the veranda) from the boughs overhead, out of
   * frame; a gust also brings some in from upwind. The passage's leaves (`mode`) draw from their
   * own `rand`, so the garden's leaf sequence is the same with or without a passage: an entrance's
   * let go from the boughs over the gravel's left half, an exit's are blown in low, from upwind.
   * Returns its slot, if one was free.
   */
  #spawn(
    settings: Settings,
    gust: boolean,
    rand: () => number = this.#leafRand,
    mode?: SpawnMode,
  ): number | undefined {
    const i = this.#slot();
    if (i === undefined) return undefined;
    const kind = SEASON_KIND[settings.season];
    const spec = SPECS[kind];
    const zone = rand();
    if (mode === "entrance" && !settings.overhead) {
      // Over the gravel's left, under the boughs swinging in, above the veranda's frame.
      const y = 0.08 + 0.4 * rand();
      const half = (0.5 * this.#aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX + half * (1.5 * rand() - 1);
      this.#y[i] = y;
      this.#z[i] = GARDEN.eyeHeight + 0.03 + 0.03 * (y - GARDEN.eyeY) + 0.05 * rand();
    } else if (mode === "flurry") {
      // Past the frame's upwind edge, low: the gust carries it across.
      const y = 0.12 + 0.6 * rand();
      const half = settings.overhead
        ? 0.5 * this.#aspect * GARDEN.span
        : (0.5 * this.#aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX - this.#gustSign * (half + 0.02 + 0.2 * rand());
      this.#y[i] = y;
      this.#z[i] = 0.08 + 0.2 * rand();
    } else if (!settings.overhead && zone < 0.55) {
      // Overhead boughs, above the veranda's frame.
      const y = 0.06 + 0.42 * rand();
      this.#x[i] = OX + (rand() - 0.5) * 1.1 * (y - GARDEN.eyeY) * 1.4;
      this.#y[i] = y;
      this.#z[i] = GARDEN.eyeHeight + 0.03 + 0.03 * (y - GARDEN.eyeY) + 0.05 * rand();
    } else if (gust && zone > 0.7) {
      // Blown in from upwind, past the frame's edge.
      const y = 0.25 + 0.6 * rand();
      const half = settings.overhead
        ? 0.5 * this.#aspect * GARDEN.span
        : (0.5 * this.#aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX - this.#gustSign * (half + 0.05);
      this.#y[i] = y;
      this.#z[i] = 0.12 + 0.12 * rand();
    } else {
      // From inside a clump of the maple, on the garden's side of the wall.
      const [cx, cy, cz, r] =
        GARDEN_CANOPY[Math.floor(rand() * GARDEN_CANOPY.length)] ?? ([0.5, 1, 0.2, 0.08] as const);
      const a = rand() * TAU;
      const d = 0.6 * r * Math.sqrt(rand());
      this.#x[i] = cx + Math.cos(a) * d;
      this.#y[i] = Math.min(cy + Math.sin(a) * d, 0.99);
      this.#z[i] = cz - 0.3 * r * rand();
    }
    const p = this.#plates;
    this.#state[i] = FALLING;
    this.#kind[i] = kind;
    const tumbles = rand() < spec.tumbling;
    const range = tumbles ? spec.tumble : spec.flutter;
    p.mass[i] = lerp(range[0], range[1], rand());
    p.chord[i] = spec.chord * (0.85 + 0.3 * rand());
    p.pace[i] = spec.pace * (0.9 + 0.2 * rand());
    this.#radius[i] = spec.radius * (0.85 + 0.3 * rand());
    p.psi[i] = rand() * TAU;
    p.dpsi[i] = (rand() - 0.5) * 0.6;
    p.start(i);
    p.th[i] = (rand() - 0.5) * 1.2;
    p.sigma[i] = rand() * TAU;
    p.dsigma[i] = (rand() - 0.5) * 0.9;
    p.roll[i] = rand() * TAU;
    p.rollRate[i] = 1.2 + 1.6 * rand();
    this.#hue[i] = rand();
    this.#lain[i] = 0;
    this.#life[i] = lerp(spec.life[0], spec.life[1], rand());
    this.#alpha[i] = 0;
    this.#vx[i] = 0;
    this.#vy[i] = 0;
    p.rest[i] = (rand() - 0.5) * 0.14;
    return i;
  }

  /** Flutter or tumble down: the plate in the leaf's plane, the plane turning, the wind carrying it. */
  #fall(i: number, dt: number, windX: number, lift: number, settings: Settings): void {
    const pos = this.#pos;
    pos[0] = this.#x[i] ?? 0;
    pos[1] = this.#y[i] ?? 0;
    pos[2] = this.#z[i] ?? 0;
    const landed = this.#plates.fly(i, dt, pos, windX, 0, lift, this.#floor);
    const x = pos[0] ?? 0;
    const y = pos[1] ?? 0;
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = Math.min(pos[2] ?? 0, 0.8);
    if (x < -0.3 || x > GA + 0.3 || y < -0.25 || y > 1.4) {
      this.#state[i] = FREE;
      return;
    }
    if (landed) this.#land(i, settings);
  }

  /** Touch down: rest on what lies there, or vanish if nobody would see it lie. */
  #land(i: number, settings: Settings): void {
    const x = this.#x[i] ?? 0;
    const y = this.#y[i] ?? 0;
    const seen = this.#project(x, y, 0);
    const offGravel = y < 0 || y > GARDEN.wallY - 0.01;
    if (
      seen === undefined ||
      offGravel ||
      seen.u < -0.05 ||
      seen.u > 1.05 ||
      seen.v < -0.05 ||
      seen.v > 1.05
    ) {
      this.#state[i] = FREE;
      return;
    }
    this.#state[i] = LANDED;
    this.#z[i] = this.#groundAt(x, y, settings.moss) + LEAF_LIFT;
    this.#plates.touchDown(i);
    this.#lain[i] = 0;
  }

  /** On the gravel: settle flat, skitter in a gust, get swept up by the rake, fade at the end. */
  #lie(i: number, dt: number, gust: number, settings: Settings): void {
    const lain = (this.#lain[i] ?? 0) + dt;
    this.#lain[i] = lain;
    // Face up or face down, whichever is nearer.
    const p = this.#plates;
    p.settle(i, smoothstep(0, SETTLE_SECONDS, lain));
    if (Math.abs(gust) > 0.05) {
      // Skitter downwind a little, turning, each leaf by its own share; at the gust's height the
      // lightest are carried off along the gravel.
      const share = 0.15 + 0.35 * (this.#hue[i] ?? 0);
      this.#x[i] = (this.#x[i] ?? 0) + gust * GUST_DRIFT * this.#gustPush * share * dt;
      p.sigma[i] = (p.sigma[i] ?? 0) + gust * share * 2.5 * dt;
      this.#z[i] = this.#groundAt(this.#x[i] ?? 0, this.#y[i] ?? 0, settings.moss) + LEAF_LIFT;
      if (Math.abs(gust) > 0.7 && (this.#hue[i] ?? 0) > 1 - GUST_CARRY) {
        this.#state[i] = LEAVING;
        this.#vx[i] = gust * GUST_DRIFT * 2 * share * this.#gustPush;
        this.#vy[i] = 0;
      }
    }
    if (lain > (this.#life[i] ?? 60)) {
      this.#alpha[i] = Math.max(0, (this.#alpha[i] ?? 0) - dt / FADE_OUT);
      if ((this.#alpha[i] ?? 0) <= 0) this.#state[i] = FREE;
    }
  }

  /** Swept away by a rake: slide on ahead of it and fade. */
  #leave(i: number, dt: number): void {
    this.#x[i] = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * dt;
    this.#y[i] = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * dt;
    this.#vx[i] = (this.#vx[i] ?? 0) * Math.exp(-1.5 * dt);
    this.#vy[i] = (this.#vy[i] ?? 0) * Math.exp(-1.5 * dt);
    const p = this.#plates;
    p.sigma[i] = (p.sigma[i] ?? 0) + (p.dsigma[i] ?? 0) * 2 * dt;
    this.#alpha[i] = Math.max(0, (this.#alpha[i] ?? 0) - dt / SWEEP_SECONDS);
    if ((this.#alpha[i] ?? 0) <= 0) this.#state[i] = FREE;
  }

  /** Leaves lying in the rake's way (at (x, y), heading (dx, dy), `half` wide) are swept up. */
  #sweep(x: number, y: number, dx: number, dy: number, half: number, speed: number): void {
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] !== LANDED) continue;
      const px = (this.#x[i] ?? 0) - x;
      const py = (this.#y[i] ?? 0) - y;
      const along = px * dx + py * dy;
      const across = Math.abs(px * dy - py * dx);
      if (across > half || along < -0.01 || along > LEAD + 0.02) continue;
      this.#state[i] = LEAVING;
      const push = 1.5 * speed + 0.03;
      this.#vx[i] = dx * push;
      this.#vy[i] = dy * push;
    }
  }

  /** The first frame shows leaves already lying about, and a few on their way down in plain view. */
  #prewarmLeaves(settings: Settings): void {
    this.#leafRand = mulberry32(0x6c656166 ^ settings.seed);
    const rand = this.#leafRand;
    for (let n = 0; n < PREWARM_FALLING; n++) {
      const i = this.#spawn(settings, false);
      if (i === undefined) break;
      // In the air over the gravel, between the top of the veranda's frame and half way down it.
      const y = 0.12 + 0.5 * rand();
      const depth = y - GARDEN.eyeY;
      this.#x[i] = OX + (2 * rand() - 1) * 0.5 * depth;
      this.#y[i] = y;
      this.#z[i] = Math.max(
        0.1,
        GARDEN.eyeHeight + ((0.72 + 0.26 * rand() - GARDEN.horizon) * depth) / GARDEN.focal,
      );
      // Let it fall a moment, so it is in its swing.
      const seconds = 0.5 + 0.8 * rand();
      for (let t = 0; t < seconds && this.#state[i] === FALLING; t += 0.05)
        this.#fall(i, 0.05, settings.wind * WIND_DRIFT, 0, settings);
      this.#alpha[i] = 1;
    }
    for (let n = 0; n < PREWARM_LANDED; n++) {
      const i = this.#spawn(settings, false);
      if (i === undefined) break;
      // Somewhere both views see, off the stones.
      let x = OX;
      let y = 0.5;
      for (let tries = 0; tries < 20; tries++) {
        y = 0.12 + 0.72 * rand();
        x = OX + (2 * rand() - 1) * (Math.min(0.6 * (y - GARDEN.eyeY), 0.85) - 0.05);
        if (!this.#onStone(x, y)) break;
      }
      this.#x[i] = x;
      this.#y[i] = y;
      this.#plates.th[i] = (this.#plates.rest[i] ?? 0) + (rand() < 0.3 ? Math.PI : 0);
      this.#land(i, settings);
      if (this.#state[i] !== LANDED) continue;
      this.#lain[i] = (this.#life[i] ?? 60) * rand();
      this.#alpha[i] = 1;
    }
    this.#nextLeaf = 1 + 2 * rand();
  }

  /**
   * uSim2, 4 × GARDEN_LEAF_SLOTS rgba16f, one row per leaf: (x, y relative to the garden's centre, z,
   * alpha; alpha 0 = none), (first in-plane axis, radius), (second in-plane axis, kind), (hue, age on
   * the ground 0..1, landed 0..1, 0).
   */
  #packLeaves(): void {
    const data = this.#leafData;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      const o = i * 16;
      const state = this.#state[i] ?? FREE;
      if (state === FREE) {
        data.fill(0, o, o + 16);
        continue;
      }
      // The plate's chord and span axes (x, y, z), its rock about the chord fading as it settles.
      const settle = state === FALLING ? 1 : 1 - smoothstep(0, SETTLE_SECONDS, this.#lain[i] ?? 0);
      const f = this.#frame;
      this.#plates.orient(i, settle, f);
      data[o] = (this.#x[i] ?? 0) - OX;
      data[o + 1] = (this.#y[i] ?? 0) - OY;
      data[o + 2] = this.#z[i] ?? 0;
      data[o + 3] = this.#alpha[i] ?? 0;
      data[o + 4] = f[0] ?? 0;
      data[o + 5] = f[1] ?? 0;
      data[o + 6] = f[2] ?? 0;
      data[o + 7] = this.#radius[i] ?? 0.01;
      data[o + 8] = f[3] ?? 0;
      data[o + 9] = f[4] ?? 0;
      data[o + 10] = f[5] ?? 0;
      data[o + 11] = this.#kind[i] ?? 0;
      data[o + 12] = this.#hue[i] ?? 0;
      data[o + 13] =
        state === FALLING
          ? 0
          : clamp((this.#lain[i] ?? 0) / Math.max(this.#life[i] ?? 60, 1), 0, 1);
      data[o + 14] = state === FALLING ? 0 : 1;
      data[o + 15] = 0;
    }
    this.#leafTexture.upload(data);
  }
}

/** The dry garden, for a scene whose `params` carry the knobs GardenKnob names. */
export function gardenSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new GardenSim(gl, params);
}
