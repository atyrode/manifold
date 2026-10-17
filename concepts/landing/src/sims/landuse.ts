// The land model: what each parcel of a terrain (sims/terrain.ts) is used for, and where the woods
// stand. The woods are a layer of their own, the wildwood the farms were cleared from: they stand
// wherever the clearance (Terrain.clearance: how late farming would clear a texel's wildwood) lies
// above the woods' line, which the woodland share sets, and a parcel whose cell on the bare land
// they cover WOOD_PARCEL of is a wood (woodland). Every other parcel is one land unit with one
// field use: open grassland, crops (one kind of the crops' catalogue, by its ground and a seeded
// roll), wildflowers, lavender, sunflowers or pasture (a herd of cattle or sheep), its ground
// bitten into by the woods where they reach it (an assart). The shader draws fields, woods and
// herds from what this writes into the terrain's packed textures (packLand) and the clearance
// packTerrain lays there, and nothing else decides them.
//
// The woods. Their line is the clearance at the area quantile the woodland share takes (woodland /
// Σ shares, the mix's own meaning) of the land the shared uses may take: the dry land on the bare
// land and the river's bed, which no settlement, road or river size moves (landGround keeps its
// clearance at LEVELS quantiles, once per land and river). The shader takes the clearance itself
// against the line (trees.ts countryWoods: smoothstep(line ± LAND_WOOD_EDGE), landCanopy here), so
// a change of the woodland share writes one value (the line, in the records) and the records of
// the few parcels that become or stop being woods; and a wood's edge, the contour of a smooth field
// filtered between texels, is smooth at any distance, not a parcel's outline. Raising the share
// lowers the line, so the woods only grow, outward from the ground cleared last; lowering it only
// fells them; no texel turns between two other uses. The woods keep off the water, the streams, the
// roads and the yards (the shader's mask of them) and the ground a parcel is opened on (openLand:
// the chalk M's, LAND_FELLED); the view has no say in them.
//
// Suitability. Once per terrain (LandModel's constructor), each parcel is weighed for each field
// use from its ground: slope, height, wetness (the river's floodplain and distance, the streams),
// aspect to the sun (south, -z), how near the settlements and roads lie, and a seeded jitter for
// character (a patchwork of crops is mixed as a real one is). Each use's weights are turned into a
// score by the parcel's rank among the parcels that use may take, weighted by their ground (every
// use's scores then spread alike over the land, whatever their units), mapped through the Gumbel
// quantile, s_u(p) = -ln(-ln rank).
//
// Stability under edits. A parcel's ground is its cell on the bare land (terrain.ts's TerrainBare:
// the land as the river and streams left it, each site at its bare heading), and its settlements
// are every candidate site (Terrain.candidates), built or not: so no settlement, road or track
// switched, no village grown, no terrace or yard cut moves any parcel's weights, nor the ranks,
// which are of those weights over that ground, nor the clearance or the woods' line, nor whether a
// parcel is a wood, which the woods' share of that cell decides (the parcel as drawn, which a road
// or a yard reshapes, would turn whole parcels far from it). Only a parcel's nearness to the roads
// as laid (crops lean toward them, wildflowers away: ROAD_LEAN) and its clear ground (the share of
// it the woods cover) are read from the build: the lean moves the parcel's score along the fixed
// ranking (interpolated between the weights about it), so a road laid or lifted re-weighs only the
// parcels within 64 m of it, and no other parcel changes use. What the shares count is each
// parcel's clear ground as drawn (dry, off the roads and yards). A parcel's seeded draws (its
// jitter, crop, herd and species) are hashes of its site's place, never of its index among the
// sites; the river's size moves no settlement and drops or keeps only the sites in its water
// (terrain.ts), so a new size re-weighs the parcels by the river, and elsewhere only the few whose
// bids were all but tied may turn, nudged by the ranks they share with the riverside parcels.
//
// Allocation (allocate): each parcel the woods leave a field takes argmax_u s_u(p) + λ_u over the
// field uses with a share, with the price λ_u = ln(share_u). A use's price is its own share's
// logarithm, never another's, so raising one share raises that use's price alone: it gains exactly
// the parcels where it was the next best bid (its marginal parcels, the best suited first), and no
// parcel changes between two other uses; lowering it hands its own marginal parcels back to
// whatever bid next there. With independent ranks this is the exponential race, whose expected
// area shares are exactly the normalised shares, so no λ needs iterating per setting. The ranks of
// different uses are correlated through the ground they share (crops and sunflowers both like it
// flat), which biases the shares by a few points; the jitter keeps that small (landuse.test.ts
// bounds it). Prices solved jointly to meet each share exactly would have to move uses' prices
// whose shares did not move (a use that borders only another loses area only by trading with it),
// so a turn of one knob would swap parcels between two other uses; this model keeps that from ever
// happening, and a calibration of fixed per-use constants measured worse over random settings than
// none. A share other than woodland's still moves the woods' line (woodland's share of the whole
// is what the line keeps), but only ever fells woods or lets them grow.
//
// Shares all zero leave every parcel open grassland; woodland alone takes all the land. Herds:
// cattle graze a pasture whose cattle rank (low, flat, wet ground first, area-weighted over every
// parcel pasture may take) lies under the cattle share, sheep the rest, so the cattle share is a
// share of the grazing land (the pastures, taken best first, are mostly the cattle's kind of
// ground); a pasture keeps its herd's kind whatever any share does, and the cattle share turns only
// sheep to cattle and back. Pines: a parcel's woods are pine where its pine rank (high, steep,
// north-facing ground, jittered) over the land is under the pine mix, so the woods' species stand
// fast as the woods grow.
//
// Cost (size 512, ~800 parcels; a laptop's V8): the model ~60 ms once per terrain, most of it its
// ground (landGround: the weights, the ranks and the clearance's quantiles), which the next terrain
// of the same land and river keeps (TerrainBuilder.riverKey); allocate ~0.1 ms; packLand a few ms
// (texel by texel), repackLand only the parcels a new allocation moves (landTexels, once per
// terrain, lists each parcel's texels). Deterministic for the terrain, the seed and the options;
// LandModel's arrays hand over to the page as `data` (a worker).
import { toHalf } from "./half.ts";
import type { Terrain, TerrainPacked } from "./terrain.ts";
import { TERRAIN_RECORDS } from "./terrain.ts";
import { clamp, hash31, hypot2, smoothstep } from "./math.ts";

/** A parcel's use, by index: the packed use. */
export const LAND_USES = [
  "open",
  "crops",
  "wildflowers",
  "lavender",
  "sunflowers",
  "pasture",
  "woodland",
] as const;
export type LandUse = (typeof LAND_USES)[number];
/** The uses the land is shared out among (every use but open grassland). */
export const LAND_SHARED = [
  "crops",
  "wildflowers",
  "lavender",
  "sunflowers",
  "pasture",
  "woodland",
] as const satisfies readonly LandUse[];
export type SharedUse = (typeof LAND_SHARED)[number];
/** A crops parcel's kind (its packed attribute). */
export const LAND_CROPS = ["wheat", "barley", "grazing", "hay", "ploughed", "rapeseed"] as const;
/**
 * The bit packLand sets in a texel's nearest parcel id's high byte (TerrainPacked.parcels) where
 * that parcel's woods are pine; ids stop at TERRAIN_MAX_PARCELS (2048), so it is free.
 */
export const LAND_PINE_FLAG = 128;
/**
 * Half the clearance a wood's edge ramps over: its canopy is smoothstep(line - LAND_WOOD_EDGE,
 * line + LAND_WOOD_EDGE, clearance) (landCanopy, trees.ts countryWoods).
 */
export const LAND_WOOD_EDGE = 0.012;
/** The clearance packLand writes where the woods are felled (openLand: the chalk M's ground). */
export const LAND_FELLED = -1;

export interface LandOptions {
  /** Relative shares of the land by use (any scale); 0 or absent leaves a use out. */
  shares: Readonly<Partial<Record<SharedUse, number>>>;
  /** The pine mix of the woods, 0..1. */
  pines: number;
  /**
   * The share of the grazing land given to cattle rather than sheep, 0..1: cattle graze a pasture
   * whose cattle rank is under it.
   */
  cows: number;
}

export interface LandAllocation {
  /** Per parcel (index id - 1): its LAND_USES index. */
  use: Uint8Array;
  /**
   * Per parcel: a crop's LAND_CROPS index, a pasture's herd (1 cattle, 0 sheep), a wood's species
   * (1 pine, 0 broadleaf); 0 otherwise.
   */
  attr: Uint8Array;
  /** Per parcel: the share of its clear ground the woods cover, 0..1. */
  canopy: Float32Array;
  /** Per parcel: 1 where its woods are pine (LAND_PINE_FLAG), wherever they reach it. */
  pine: Uint8Array;
  /** Per parcel: 1 where its woods are felled (openLand). */
  felled: Uint8Array;
  /** Square metres of clear ground per use (by LAND_USES index); woodland's is the woods'. */
  area: Float64Array;
  /** Square metres of clear ground the shared uses could take between them. */
  total: number;
  /** Whether woodland has a share (hedgerow and bank trees stand only then). */
  wooded: boolean;
  /** The woods' line: the clearance they stand above, in half floats as the records hold it. */
  line: number;
}

/** The uses the parcels the woods leave are shared out among (LAND_SHARED but woodland). */
const FIELDS = [
  "crops",
  "wildflowers",
  "lavender",
  "sunflowers",
  "pasture",
] as const satisfies readonly SharedUse[];
const USES = FIELDS.length;
/** Field use u's LAND_USES index is u + 1. */
const CROPS = LAND_USES.indexOf("crops");
const PASTURE = LAND_USES.indexOf("pasture");
const WOODLAND = LAND_USES.indexOf("woodland");
/** How much seeded jitter each field use's weights (about 0..1 over the land) carry, FIELDS order. */
const JITTER = [0.6, 0.6, 0.6, 0.6, 0.6] as const;
/**
 * How much each field use's weight leans toward the roads as laid, by its access (1 on a road, 0
 * beyond 64 m of every one), FIELDS order: crops near them, wildflowers away from them.
 */
const ROAD_LEAN = [0.15, -0.25, 0, 0, 0] as const;
/** A parcel the woods cover this share of is a wood. */
const WOOD_PARCEL = 0.7;
/** The woods' line without woods: above any clearance, and finite in half floats. */
const NO_WOODS = 64;
/** Area quantiles of the land's clearance landGround keeps (the woods' line lies between them). */
const LEVELS = 1024;
/** Quantiles of a parcel's clear ground's clearance LandModel keeps (its wooded share between). */
const TENTHS = 10;
/** The woods' line in the records: TERRAIN_RECORDS' misc texel 5, z. */
const LINE = 4 * (TERRAIN_RECORDS.misc * TERRAIN_RECORDS.width + 5) + 2;

/** Gumbel quantile of a rank in (0, 1). */
function gumbel(rank: number): number {
  return -Math.log(-Math.log(clamp(rank, 1e-6, 1 - 1e-6)));
}

/** How much of the woods' canopy stands at clearance `c` under the woods' line `line`, 0..1. */
export function landCanopy(c: number, line: number): number {
  return smoothstep(line - LAND_WOOD_EDGE, line + LAND_WOOD_EDGE, c);
}

/** The woods' line a packed terrain holds (packLand). */
export function landWoodLine(packed: TerrainPacked): number {
  return packed.records[LINE] ?? NO_WOODS;
}

/**
 * Each parcel's rank by `weight`, heaviest first, among the parcels with ground (`texels`), each
 * weighted by its texels: the middle of its own span of the land, 0..1; 1 where it has none.
 */
function rankBy(weight: Float64Array, texels: Int32Array): Float32Array {
  const count = texels.length;
  const order: number[] = [];
  let whole = 0;
  for (let s = 0; s < count; s++) {
    if ((texels[s] ?? 0) === 0) continue;
    order.push(s);
    whole += texels[s] ?? 0;
  }
  order.sort((a, b) => (weight[b] ?? 0) - (weight[a] ?? 0) || a - b);
  const rank = new Float32Array(count).fill(1);
  let below = 0;
  for (const s of order) {
    rank[s] = (below + 0.5 * (texels[s] ?? 0)) / whole;
    below += texels[s] ?? 0;
  }
  return rank;
}

/**
 * Per parcel, the clearance of the texels `owner` gives it (its index; -1 none) at TENTHS + 1
 * quantiles, lowest first, -Infinity where it has none: the share of them the woods cover under any
 * line, between them (woodedShare).
 */
function clearanceTenths(t: Terrain, owner: Int32Array): Float32Array {
  const count = t.parcels.count;
  const m = t.size;
  const start = new Int32Array(count + 1);
  for (let q = 0; q < m * m; q++) {
    const s = owner[q] ?? -1;
    if (s >= 0) start[s + 1] = (start[s + 1] ?? 0) + 1;
  }
  for (let s = 0; s < count; s++) start[s + 1] = (start[s + 1] ?? 0) + (start[s] ?? 0);
  const fill = start.slice(0, count);
  const values = new Float32Array(start[count] ?? 0);
  for (let q = 0; q < m * m; q++) {
    const s = owner[q] ?? -1;
    if (s < 0) continue;
    const at = fill[s] ?? 0;
    values[at] = t.clearance[q] ?? 0;
    fill[s] = at + 1;
  }
  const tenths = new Float32Array(count * (TENTHS + 1)).fill(-Infinity);
  for (let s = 0; s < count; s++) {
    const own = values.subarray(start[s] ?? 0, start[s + 1] ?? 0).sort();
    if (own.length === 0) continue;
    for (let k = 0; k <= TENTHS; k++)
      tenths[s * (TENTHS + 1) + k] = own[Math.round((k / TENTHS) * (own.length - 1))] ?? 0;
  }
  return tenths;
}

/** The share of parcel s's texels the woods cover under `line`, by its clearanceTenths. */
function woodedShare(tenths: Float32Array, s: number, line: number): number {
  const o = s * (TENTHS + 1);
  if (line < (tenths[o] ?? 0)) return 1;
  if (line >= (tenths[o + TENTHS] ?? 0)) return 0;
  let k = 0;
  while (k < TENTHS - 1 && line >= (tenths[o + k + 1] ?? 0)) k++;
  const lo = tenths[o + k] ?? 0;
  const hi = tenths[o + k + 1] ?? lo;
  return 1 - (k + (hi > lo ? (line - lo) / (hi - lo) : 1)) / TENTHS;
}

/**
 * A land model's state as plain arrays: what the build worker hands the page (sims/build.ts) and
 * `new LandModel(data)` takes back.
 */
export interface LandModelData {
  readonly count: number;
  readonly area: Float32Array;
  readonly score: Float32Array;
  readonly crop: Uint8Array;
  readonly cattle: Float32Array;
  readonly pine: Float32Array;
  readonly woods: Float32Array;
  readonly cells: Float32Array;
  readonly levels: Float32Array;
}

/** One field use's ranking (LandGround): the parcels it may take by weight, lightest first. */
interface LandRanking {
  readonly taken: readonly number[];
  /** Each one's weight but for its lean toward the roads, and its rank by ground there. */
  readonly knots: Float64Array;
  readonly ranks: Float64Array;
}

/**
 * A terrain's parcels weighed on their ground alone, for a seed: the half of the land model no
 * settlement, road or track switched moves (see the header). The same for every terrain of one
 * TerrainBuilder.riverKey, so a build keeping its land and river (sims/terrain.ts) may keep this.
 */
export interface LandGround {
  readonly count: number;
  /** Per parcel: its dry texels on the bare land. */
  readonly texels: Int32Array;
  /** Per field use (FIELDS order). */
  readonly ranked: readonly LandRanking[];
  readonly crop: Uint8Array;
  /** Per parcel: its cattle rank over the parcels pasture may take (rankBy; 1 none). */
  readonly cattle: Float32Array;
  /** Per parcel: its pine rank over the land (rankBy; 1 none). */
  readonly pine: Float32Array;
  /** Per parcel: clearanceTenths over its dry cell on the bare land. */
  readonly cells: Float32Array;
  /**
   * The clearance of the land the shared uses may take (dry on the bare land, or the river's bed)
   * at LEVELS + 1 area quantiles, lowest first: the woods' line between them (see the header).
   */
  readonly levels: Float32Array;
}

/** Weigh a terrain's parcels on their ground for `seed` (LandGround). */
export function landGround(terrain: Terrain, seed: number): LandGround {
  const t = terrain;
  const p = t.parcels;
  const count = p.count;
  const m = t.size;
  const crop = new Uint8Array(count);
  const cattle = new Float64Array(count);
  const pine = new Float64Array(count);
  // Per parcel over its cell on the bare land (TerrainBare), dry there: slope, height, the slope
  // toward the sun, the nearest stream and the clearance; and the clearance of the land the woods
  // may take.
  const bare = t.bare;
  let bottom = Infinity;
  let top = -Infinity;
  for (let q = 0; q < m * m; q++) {
    bottom = Math.min(bottom, bare.ground[q] ?? 0);
    top = Math.max(top, bare.ground[q] ?? 0);
  }
  const span = Math.max(1, top - bottom);
  const slope = new Float64Array(count);
  const high = new Float64Array(count);
  const north = new Float64Array(count);
  const stream = new Float64Array(count).fill(64);
  const texels = new Int32Array(count);
  const owner = new Int32Array(m * m).fill(-1);
  const land: number[] = [];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const q = j * m + i;
      const g = bare.ground[q] ?? 0;
      const dry = (bare.level[q] ?? 0) <= g - 0.3;
      if (dry || t.riverbed[q] === 1) land.push(t.clearance[q] ?? 0);
      const cell = bare.ids[q] ?? 0;
      if (cell === 0 || !dry) continue;
      const s = cell - 1;
      const gx =
        ((bare.ground[j * m + Math.min(m - 1, i + 1)] ?? 0) -
          (bare.ground[j * m + Math.max(0, i - 1)] ?? 0)) /
        (2 * t.cell);
      const gz =
        ((bare.ground[Math.min(m - 1, j + 1) * m + i] ?? 0) -
          (bare.ground[Math.max(0, j - 1) * m + i] ?? 0)) /
        (2 * t.cell);
      texels[s] = (texels[s] ?? 0) + 1;
      owner[q] = s;
      slope[s] = (slope[s] ?? 0) + hypot2(gx, gz);
      high[s] = (high[s] ?? 0) + (g - bottom) / span;
      // Rising to the north: the slope faces south, toward the sun.
      north[s] = (north[s] ?? 0) + gz;
      stream[s] = Math.min(stream[s] ?? 64, t.stream[q] ?? 64);
    }
  }
  const sorted = Float32Array.from(land).sort();
  const levels = new Float32Array(LEVELS + 1);
  for (let k = 0; k <= LEVELS; k++)
    levels[k] = sorted[Math.round((k / LEVELS) * (sorted.length - 1))] ?? NO_WOODS;
  const river = t.river;
  const homes = t.candidates.filter((place) => place.kind !== "castle");
  // Each field use's weight but for its lean toward the roads (ROAD_LEAN · access).
  const weights = new Float64Array(count * USES);
  for (let s = 0; s < count; s++) {
    const n = texels[s] ?? 0;
    if (n === 0) continue;
    const x = p.x[s] ?? 0;
    const z = p.z[s] ?? 0;
    const grade = (slope[s] ?? 0) / n;
    const height = (high[s] ?? 0) / n;
    const sunny = 0.5 + 0.5 * clamp((north[s] ?? 0) / n / 0.12, -1, 1);
    const wet = 1 - smoothstep(0, 40, stream[s] ?? 64);
    const plain = p.floodplain[s] ?? 0;
    let toRiver = Infinity;
    for (let k = 0; k < river.x.length; k += 4)
      toRiver = Math.min(toRiver, hypot2((river.x[k] ?? 0) - x, (river.z[k] ?? 0) - z));
    const riverside = 1 - smoothstep(60, 500, toRiver);
    let toHome = Infinity;
    for (const place of homes) toHome = Math.min(toHome, hypot2(place.x - x, place.z - z));
    const near = 1 - smoothstep(150, 900, toHome);
    const flat = 1 - smoothstep(0.04, 0.22, grade);
    const gentle = 1 - smoothstep(0.15, 0.4, grade);
    const w = s * USES;
    // crops: flat, low, near the roads (ROAD_LEAN) and settlements, off the floodplain
    weights[w] = 0.45 * flat + 0.2 * (1 - height) + 0.2 * near - 0.25 * plain;
    // wildflowers: moderate slopes, wet hollows, away from the roads (ROAD_LEAN), up the hills
    weights[w + 1] = 0.3 * smoothstep(0.06, 0.2, grade) * gentle + 0.3 * wet + 0.25 + 0.15 * height;
    // lavender: sunny, dry, well-drained slopes
    weights[w + 2] = 0.45 * sunny + 0.25 * (1 - riverside) + 0.3 * smoothstep(0.04, 0.15, grade);
    // sunflowers: flat, sunny, low
    weights[w + 3] = 0.4 * flat + 0.4 * sunny + 0.2 * (1 - height);
    // pasture: by the river and the streams, on ground too wet or rolling to plough
    weights[w + 4] = 0.35 * riverside + 0.25 * wet + 0.2 * gentle + 0.2 * plain;
    // Its draws come from hashes of its site's place, never its index among the sites, so no
    // site added or dropped elsewhere (the river's size drops those in its water) re-rolls it.
    const ix = Math.round(x * 8);
    const iz = Math.round(z * 8);
    for (let u = 0; u < USES; u++) {
      const jitter = hash31(ix, iz, seed * 7919 + 17 + u);
      weights[w + u] = (weights[w + u] ?? 0) + (JITTER[u] ?? 0) * jitter;
    }
    // The crops' kind: hay and grazing on the floodplain and the steep ground, the arable
    // rotation elsewhere.
    const roll = hash31(ix, iz, seed * 7919 + 23);
    const kind = plain
      ? roll < 0.6
        ? 3
        : 2
      : grade > 0.3
        ? roll < 0.75
          ? 2
          : 3
        : roll < 0.3
          ? 0
          : roll < 0.45
            ? 1
            : roll < 0.67
              ? 2
              : roll < 0.78
                ? 3
                : roll < 0.9
                  ? 4
                  : 5;
    crop[s] = kind;
    cattle[s] =
      0.4 * riverside + 0.3 * flat + 0.3 * (1 - height) + 0.3 * hash31(ix, iz, seed * 7919 + 29);
    pine[s] =
      0.35 * height +
      0.25 * smoothstep(0.1, 0.4, grade) +
      0.2 * (1 - sunny) +
      0.4 * hash31(ix, iz, seed * 7919 + 31);
  }
  // Each field use's weights ranked among the parcels it may take (every one with ground), each
  // weighted by its dry ground on the bare land.
  const taken: number[] = [];
  for (let s = 0; s < count; s++) if ((texels[s] ?? 0) > 0) taken.push(s);
  let whole = 0;
  for (const s of taken) whole += texels[s] ?? 0;
  const ranked = FIELDS.map((_, u): LandRanking => {
    const order = taken.slice();
    order.sort((a, b) => (weights[a * USES + u] ?? 0) - (weights[b * USES + u] ?? 0) || a - b);
    const knots = new Float64Array(order.length);
    const ranks = new Float64Array(order.length);
    let below = 0;
    order.forEach((s, k) => {
      const a = texels[s] ?? 0;
      knots[k] = weights[s * USES + u] ?? 0;
      ranks[k] = (below + 0.5 * a) / whole;
      below += a;
    });
    return { taken: order, knots, ranks };
  });
  return {
    count,
    texels,
    ranked,
    crop,
    cattle: rankBy(cattle, texels),
    pine: rankBy(pine, texels),
    cells: clearanceTenths(t, owner),
    levels,
  };
}

/** The land model of one terrain: each parcel's suitability for each use, ready to allocate. */
export class LandModel {
  /** Parcels (TerrainParcels.count). */
  readonly count: number;
  /** Per parcel: square metres of clear ground (dry, off the roads and yards). */
  readonly area: Float32Array;
  /** Per parcel and field use (parcel · USES + use): its score, -Infinity where it may not go. */
  readonly #score: Float32Array;
  readonly #crop: Uint8Array;
  /** Per parcel: its cattle rank over the parcels pasture may take, 0 the most cattle-like. */
  readonly #cattle: Float32Array;
  /** Per parcel: its pine rank over the land, 0 the most pine-like. */
  readonly #pine: Float32Array;
  /**
   * Per parcel: its clear ground's clearance at TENTHS + 1 quantiles (clearanceTenths): the share
   * of it the woods cover under any line, between them.
   */
  readonly #woods: Float32Array;
  /** LandGround.cells: whether the woods make it a wood. */
  readonly #cells: Float32Array;
  /** LandGround.levels. */
  readonly #levels: Float32Array;

  /**
   * Weigh every parcel of a terrain (see the header), its ground weighed afresh for a seed or as
   * weighed already for its land and river (landGround); or take a model weighed already (`data`).
   */
  constructor(terrain: Terrain, ground: number | LandGround);
  constructor(data: LandModelData);
  constructor(source: Terrain | LandModelData, ground: number | LandGround = 0) {
    const data =
      "parcels" in source
        ? LandModel.#weigh(source, typeof ground === "number" ? landGround(source, ground) : ground)
        : source;
    this.count = data.count;
    this.area = data.area;
    this.#score = data.score;
    this.#crop = data.crop;
    this.#cattle = data.cattle;
    this.#pine = data.pine;
    this.#woods = data.woods;
    this.#cells = data.cells;
    this.#levels = data.levels;
  }

  /** The model's own arrays (not copies), as `new LandModel(data)` takes them. */
  get data(): LandModelData {
    return {
      count: this.count,
      area: this.area,
      score: this.#score,
      crop: this.#crop,
      cattle: this.#cattle,
      pine: this.#pine,
      woods: this.#woods,
      cells: this.#cells,
      levels: this.#levels,
    };
  }

  /** The terrain's parcels on their ground and on what its build laid (clear ground, roads). */
  static #weigh(terrain: Terrain, ground: LandGround): LandModelData {
    const t = terrain;
    const p = t.parcels;
    const count = ground.count;
    const m = t.size;
    const cell2 = t.cell * t.cell;
    const area = new Float32Array(count);
    const score = new Float32Array(count * USES);
    // Its clear ground as drawn (its own texels, dry, off the roads and yards), all its use's area
    // counts and the woods' share of it; and how far the roads as laid are over its dry cell on the
    // bare land (its access), all its weights lean by.
    const bare = t.bare;
    const road = new Float64Array(count);
    const clear = new Int32Array(count);
    const owner = new Int32Array(m * m).fill(-1);
    for (let q = 0; q < m * m; q++) {
      const id = p.ids[2 * q] ?? 0;
      if (
        id > 0 &&
        (t.level[q] ?? 0) <= (t.ground[q] ?? 0) - 0.3 &&
        (t.road[q] ?? 64) >= 0 &&
        (t.yard[q] ?? 0) <= 0.3
      ) {
        clear[id - 1] = (clear[id - 1] ?? 0) + 1;
        owner[q] = id - 1;
      }
      const cell = bare.ids[q] ?? 0;
      if (cell === 0 || (bare.level[q] ?? 0) > (bare.ground[q] ?? 0) - 0.3) continue;
      road[cell - 1] = (road[cell - 1] ?? 0) + clamp(t.road[q] ?? 64, 0, 64);
    }
    const access = new Float64Array(count);
    for (let s = 0; s < count; s++) {
      area[s] = (clear[s] ?? 0) * cell2;
      const n = ground.texels[s] ?? 0;
      if (n > 0) access[s] = 1 - (road[s] ?? 0) / n / 64;
    }
    const woods = clearanceTenths(t, owner);
    // Each use's weights into scores by rank, through the Gumbel quantile. A parcel the roads reach
    // leans off its own rank by ROAD_LEAN · access, read off the same ranking between the two
    // weights about it, so the ranking itself never moves with the roads.
    ground.ranked.forEach(({ taken, knots, ranks }, u) => {
      // The rank a weight would take: interpolated between the knots about it, held at the ends.
      const rankAt = (weight: number): number => {
        let lo = 0;
        let hi = knots.length - 1;
        if (weight <= (knots[lo] ?? 0)) return ranks[lo] ?? 0;
        if (weight >= (knots[hi] ?? 0)) return ranks[hi] ?? 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if ((knots[mid] ?? 0) <= weight) lo = mid;
          else hi = mid;
        }
        const k0 = knots[lo] ?? 0;
        const k1 = knots[hi] ?? 0;
        const f = k1 > k0 ? (weight - k0) / (k1 - k0) : 0;
        return (ranks[lo] ?? 0) + f * ((ranks[hi] ?? 0) - (ranks[lo] ?? 0));
      };
      for (let s = 0; s < count; s++) score[s * USES + u] = -Infinity;
      taken.forEach((s, k) => {
        const lean = (ROAD_LEAN[u] ?? 0) * (access[s] ?? 0);
        const rank = lean === 0 ? (ranks[k] ?? 0) : rankAt((knots[k] ?? 0) + lean);
        score[s * USES + u] = gumbel(rank);
      });
    });
    // Copies: the ground is kept for the next build, the model's arrays go to the page.
    return {
      count,
      area,
      score,
      crop: ground.crop.slice(),
      cattle: ground.cattle.slice(),
      pine: ground.pine.slice(),
      woods,
      cells: ground.cells.slice(),
      levels: ground.levels.slice(),
    };
  }

  /**
   * The woods' line for woodland's share `f` (0 < f ≤ 1) of the land: the clearance at that area
   * quantile from the top (between LandGround.levels), in half floats as the records hold it; under
   * every clearance at f = 1.
   */
  #line(f: number): number {
    const levels = this.#levels;
    if (f >= 1) return toHalf((levels[0] ?? 0) - 2 * LAND_WOOD_EDGE);
    const u = (1 - f) * LEVELS;
    const k = Math.min(LEVELS - 1, Math.floor(u));
    const lo = levels[k] ?? 0;
    return toHalf(lo + (u - k) * ((levels[k + 1] ?? lo) - lo));
  }

  /** Every parcel's use and attribute, and the woods, for these options (see the header). */
  allocate(options: LandOptions): LandAllocation {
    const count = this.count;
    const use = new Uint8Array(count);
    const attr = new Uint8Array(count);
    const canopy = new Float32Array(count);
    const pine = new Uint8Array(count);
    const area = new Float64Array(LAND_USES.length);
    const price = new Float64Array(USES).fill(-Infinity);
    FIELDS.forEach((name, u) => {
      const share = options.shares[name] ?? 0;
      if (share > 0) price[u] = Math.log(share);
    });
    let whole = 0;
    for (const name of LAND_SHARED) whole += Math.max(0, options.shares[name] ?? 0);
    const woodland = Math.max(0, options.shares.woodland ?? 0);
    const wooded = woodland > 0;
    const line = wooded ? this.#line(woodland / whole) : NO_WOODS;
    const cows = clamp(options.cows, 0, 1);
    let total = 0;
    for (let s = 0; s < count; s++) {
      const a = this.area[s] ?? 0;
      const share = wooded ? woodedShare(this.#woods, s, line) : 0;
      canopy[s] = share;
      pine[s] = wooded && (this.#pine[s] ?? 1) < options.pines ? 1 : 0;
      area[WOODLAND] = (area[WOODLAND] ?? 0) + share * a;
      let best = -1;
      let bestScore = -Infinity;
      let open = wooded;
      for (let u = 0; u < USES; u++) {
        const score = this.#score[s * USES + u] ?? -Infinity;
        if (!Number.isFinite(score)) continue;
        if (Number.isFinite(price[u] ?? -Infinity)) open = true;
        const bid = score + (price[u] ?? -Infinity);
        if (bid > bestScore) {
          bestScore = bid;
          best = u;
        }
      }
      if (open) total += a;
      if (wooded && woodedShare(this.#cells, s, line) >= WOOD_PARCEL) {
        use[s] = WOODLAND;
        attr[s] = pine[s] ?? 0;
        continue;
      }
      if (best < 0 || !Number.isFinite(bestScore)) continue;
      const index = best + 1;
      use[s] = index;
      area[index] = (area[index] ?? 0) + (1 - share) * a;
      if (index === CROPS) attr[s] = this.#crop[s] ?? 0;
      else if (index === PASTURE) attr[s] = (this.#cattle[s] ?? 1) < cows ? 1 : 0;
    }
    area[0] = Math.max(
      0,
      total - area.reduce((sum, value, index) => sum + (index > 0 ? value : 0), 0),
    );
    return {
      use,
      attr,
      canopy,
      pine,
      felled: new Uint8Array(count),
      area,
      total,
      wooded,
      line,
    };
  }
}

/**
 * Open `parcels` (TerrainParcels indices) in a land allocation: open grassland, their woods felled
 * (LAND_FELLED: the chalk M keeps its ground so, chalk.ts), their area moved to open grassland.
 */
export function openLand(land: LandAllocation, model: LandModel, parcels: readonly number[]): void {
  for (const s of parcels) {
    const a = model.area[s] ?? 0;
    const use = land.use[s] ?? 0;
    const wood = (land.canopy[s] ?? 0) * a;
    // A field's own ground moves too; a wood's or open parcel's clearings count as open already.
    const field = use > 0 && use !== WOODLAND ? a - wood : 0;
    land.area[WOODLAND] = (land.area[WOODLAND] ?? 0) - wood;
    land.area[use] = (land.area[use] ?? 0) - field;
    land.area[0] = (land.area[0] ?? 0) + wood + field;
    land.use[s] = 0;
    land.attr[s] = 0;
    land.canopy[s] = 0;
    land.felled[s] = 1;
  }
}

/** Uses that enclose their parcel with a hedge: the farmed ones (not open grassland, not woods). */
function enclosed(use: number): boolean {
  return use >= CROPS && use <= PASTURE;
}

/**
 * The parcel across a lone tree's hedge from texel q of parcel `id`: the next texel's to the right,
 * else the one above's, where it differs; else `id` itself.
 */
function hedgeAcross(ids: Uint16Array, m: number, q: number, id: number): number {
  const right = ids[2 * (q + 1)] ?? 0;
  if ((q % m) + 1 < m && right !== id) return right;
  const above = ids[2 * (q + m)] ?? 0;
  return q + m < m * m && above !== id ? above : id;
}

/** What landWriter's texel changed: its cover (clearance, lone tree), its species flag. */
const COVER_CHANGED = 1;
const SPECIES_CHANGED = 2;

/**
 * packLand's writes for one terrain and allocation: a site's record; a texel's clearance (felled or
 * not), species and lone tree, returning what changed (COVER_CHANGED | SPECIES_CHANGED).
 */
function landWriter(
  packed: TerrainPacked,
  t: Terrain,
  land: LandAllocation,
): { site(s: number): void; texel(q: number): number } {
  const p = t.parcels;
  const L = TERRAIN_RECORDS;
  const m = t.size;
  return {
    site(s) {
      const o = 4 * ((L.sites + Math.floor(s / 32)) * L.width + 2 * (s % 32)) + 4;
      packed.records[o + 2] = land.use[s] ?? 0;
      packed.records[o + 3] = land.attr[s] ?? 0;
    },
    texel(q) {
      const o = 4 * q;
      const id = p.ids[2 * q] ?? 0;
      const use = id > 0 ? (land.use[id - 1] ?? 0) : 0;
      const was = packed.parcels[o + 1] ?? 0;
      const high = was & ~LAND_PINE_FLAG;
      const flagged = id > 0 && land.pine[id - 1] === 1 ? high | LAND_PINE_FLAG : high;
      packed.parcels[o + 1] = flagged;
      let tree = packed.cover[o + 3] ?? 0;
      if ((t.yard[q] ?? 0) < 0) {
        // A lone tree: on a hedge (its texel's parcel differs from the next one's) only while the
        // hedge stands; on the river's banks while woodland has a share. Inside the woods the
        // shader leaves it to them (trees.ts).
        let stands = land.wooded;
        const across = hedgeAcross(p.ids, m, q, id);
        if (across !== id)
          stands &&= enclosed(use) || (across > 0 && enclosed(land.use[across - 1] ?? 0));
        tree = stands ? -1 : 0;
      }
      const clearance = id > 0 && land.felled[id - 1] === 1 ? LAND_FELLED : (t.clearance[q] ?? 0);
      const cover = packed.cover[o + 2] !== clearance || packed.cover[o + 3] !== tree;
      packed.cover[o + 2] = clearance;
      packed.cover[o + 3] = tree;
      return (cover ? COVER_CHANGED : 0) | (flagged !== was ? SPECIES_CHANGED : 0);
    },
  };
}

/**
 * Write a land allocation into a packed terrain (terrain.ts packTerrain): the woods' line (the
 * records' misc row: TERRAIN_RECORDS), each parcel site's use and attribute (TERRAIN_RECORDS
 * sites), and texel by texel the clearance (cover z: the terrain's, LAND_FELLED on a parcel whose
 * woods are felled), the woods' species (LAND_PINE_FLAG in the parcels' map where the texel's
 * parcel's woods are pine) and which lone trees stand (cover w -1: a hedgerow tree only where its
 * hedge stands, between two parcels of which at least one is farmed; none while woodland has no
 * share). Rewrites only those; packing the terrain again is not needed, and a later allocation of
 * the same terrain need not rewrite it all (repackLand). The species stays out of the clearance,
 * which the shader samples filtered.
 */
export function packLand(packed: TerrainPacked, t: Terrain, land: LandAllocation): void {
  const write = landWriter(packed, t, land);
  packed.records[LINE] = land.line;
  for (let s = 0; s < t.parcels.count; s++) write.site(s);
  for (let q = 0; q < t.size * t.size; q++) write.texel(q);
}

/**
 * Per parcel (index id - 1), the texels packLand reads its allocation for: those it is the nearest
 * site of, and the lone trees whose hedge it lies across. Parcel s's are texels[start[s] ..
 * start[s + 1]).
 */
export interface LandTexels {
  readonly start: Int32Array;
  readonly texels: Int32Array;
}

/** A terrain's LandTexels, once per terrain (a few milliseconds at size 512). */
export function landTexels(t: Terrain): LandTexels {
  const ids = t.parcels.ids;
  const m = t.size;
  const start = new Int32Array(t.parcels.count + 1);
  const texels = new Int32Array(2 * m * m);
  // Counted first, then filled from each parcel's start: `visit` per parcel a texel depends on.
  const each = (visit: (s: number, q: number) => void): void => {
    for (let q = 0; q < m * m; q++) {
      const id = ids[2 * q] ?? 0;
      if (id > 0) visit(id - 1, q);
      if ((t.yard[q] ?? 0) >= 0) continue;
      const across = hedgeAcross(ids, m, q, id);
      if (across > 0 && across !== id) visit(across - 1, q);
    }
  };
  each((s) => {
    start[s + 1] = (start[s + 1] ?? 0) + 1;
  });
  for (let s = 0; s < t.parcels.count; s++) start[s + 1] = (start[s + 1] ?? 0) + (start[s] ?? 0);
  const fill = start.slice(0, t.parcels.count);
  each((s, q) => {
    const at = fill[s] ?? 0;
    texels[at] = q;
    fill[s] = at + 1;
  });
  return { start, texels: texels.slice(0, start[t.parcels.count] ?? 0) };
}

/** The texel rows repackLand changed, first and last, per texture; undefined where none. */
export interface LandRows {
  /** The cover's, where a texel's clearance or lone tree changed (TerrainPacked.cover). */
  readonly cover: readonly [number, number] | undefined;
  /** The parcels' map's, where a texel's species flag (LAND_PINE_FLAG) changed. */
  readonly parcels: readonly [number, number] | undefined;
}

/**
 * Rewrite a packed terrain holding allocation `before` (packLand) for `land`, another allocation of
 * the same terrain, where it differs: the woods' line, the records of the sites whose use,
 * attribute, species or felling changed and the texels those decide (`texels`, landTexels); the
 * whole land where woodland gains or loses its share (every lone tree and species stands by it).
 * The bytes are packLand's. Returns the rows whose bytes changed, per texture: a change of the
 * woodland share alone moves the line and the few parcels that become or stop being woods, and
 * so leaves both textures all but untouched.
 */
export function repackLand(
  packed: TerrainPacked,
  t: Terrain,
  land: LandAllocation,
  before: LandAllocation,
  texels: LandTexels,
): LandRows {
  const m = t.size;
  const write = landWriter(packed, t, land);
  let first = m;
  let last = -1;
  let firstFlag = m;
  let lastFlag = -1;
  const texel = (q: number): void => {
    const changed = write.texel(q);
    const row = Math.floor(q / m);
    if ((changed & COVER_CHANGED) !== 0) {
      first = Math.min(first, row);
      last = Math.max(last, row);
    }
    if ((changed & SPECIES_CHANGED) !== 0) {
      firstFlag = Math.min(firstFlag, row);
      lastFlag = Math.max(lastFlag, row);
    }
  };
  packed.records[LINE] = land.line;
  if (land.wooded !== before.wooded) {
    for (let s = 0; s < t.parcels.count; s++) write.site(s);
    for (let q = 0; q < m * m; q++) texel(q);
  } else {
    for (let s = 0; s < t.parcels.count; s++) {
      if (
        land.use[s] === before.use[s] &&
        land.attr[s] === before.attr[s] &&
        land.pine[s] === before.pine[s] &&
        land.felled[s] === before.felled[s]
      )
        continue;
      write.site(s);
      for (let k = texels.start[s] ?? 0; k < (texels.start[s + 1] ?? 0); k++)
        texel(texels.texels[k] ?? 0);
    }
  }
  return {
    cover: last < 0 ? undefined : [first, last],
    parcels: lastFlag < 0 ? undefined : [firstFlag, lastFlag],
  };
}
