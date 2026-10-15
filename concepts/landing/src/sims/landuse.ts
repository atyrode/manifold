// The land model: what each parcel of a terrain (sims/terrain.ts) is used for. Every parcel is one
// land unit with exactly one use: open grassland, crops (one kind of the crops' catalogue, by its
// ground and a seeded roll), wildflowers, lavender, sunflowers, pasture (a herd of cattle or sheep)
// or woodland (broadleaf or pine). The shader draws fields, woods and herds from what this writes
// into the terrain's packed textures (packLand), and nothing else decides them.
//
// Suitability. Once per terrain (LandModel's constructor), each parcel is weighed for each use from
// its ground: slope, height, wetness (the river's floodplain and distance, the streams), aspect to
// the sun (south, -z), woodland suitability (terrain.ts's woods), how near the settlements and
// roads lie, and a seeded jitter for character (large for the field uses, so a patchwork of crops
// is mixed as a real one is; small for woodland, so woods hold together). Each use's weights are
// turned into a score by the parcel's area-weighted rank among the parcels that use may take
// (every use's scores then spread alike over the land, whatever their units) mapped through the
// Gumbel quantile, s_u(p) = -ln(-ln rank).
//
// Allocation (allocate): each parcel takes argmax_u s_u(p) + λ_u over the uses with a share, with
// the price λ_u = ln(share_u). A use's price is its own share's logarithm, never another's, so
// raising one share raises that use's price alone: it gains exactly the parcels where it was the
// next best bid (its marginal parcels, the best suited first), and no parcel changes between two
// other uses; lowering it hands its own marginal parcels back to whatever bid next there. Woods
// therefore grow outward from their best ground. With independent ranks this is the exponential
// race, whose expected area shares are exactly the normalised shares, so no λ needs iterating per
// setting. The ranks of different uses are correlated through the ground they share (crops and
// sunflowers both like it flat, woods and crops never), which biases the shares by a few points;
// the field uses' large jitter keeps that small (landuse.test.ts bounds it). Prices solved jointly
// to meet each share exactly would have to move uses' prices whose shares did not move (a use that
// borders only another loses area only by trading with it), so a turn of one knob would swap
// parcels between two other uses; this model keeps that from ever happening, and a calibration of
// fixed per-use constants measured worse over random settings than none.
//
// Shares all zero leave every parcel open grassland; woodland alone takes every parcel it may
// (all but the near slopes under the vantage, which stay open so the eye sees over them). Herds:
// round(cows × pastures) pastures graze cattle, the most cattle-suitable first (low, flat, wet
// ground), so a change of the cattle share swaps only as many herds as it must. Pines: a wood is
// pine where its pine rank (high, steep, north-facing ground, jittered) over every parcel woodland
// may take is under the pine mix, so the woods' species stand fast as the woods grow.
//
// Cost (size 512, ~800 parcels; a laptop's V8): the model ~40 ms once per terrain; allocate ~0.05
// ms; packLand a few ms (the woods' canopy texel by texel). Deterministic for the terrain, the seed
// and the options.
import type { Terrain, TerrainPacked } from "./terrain.ts";
import { TERRAIN_RECORDS } from "./terrain.ts";
import { clamp, hash31, smoothstep } from "./math.ts";

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
/** The near slopes under the vantage stay open (metres from it to a parcel's site). */
export const LAND_OPEN_NEAR = 320;

export interface LandOptions {
  /** Relative shares of the land by use (any scale); 0 or absent leaves a use out. */
  shares: Readonly<Partial<Record<SharedUse, number>>>;
  /** The pine mix of the woods, 0..1. */
  pines: number;
  /** The share of the pastures grazed by cattle rather than sheep, 0..1. */
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
  /** Square metres of clear ground per use (by LAND_USES index). */
  area: Float64Array;
  /** Square metres of clear ground the shared uses could take between them. */
  total: number;
  /** Whether woodland has a share (hedgerow and bank trees stand only then). */
  wooded: boolean;
}

const USES = LAND_SHARED.length;
const USE_INDEX: Readonly<Record<SharedUse, number>> = {
  crops: 1,
  wildflowers: 2,
  lavender: 3,
  sunflowers: 4,
  pasture: 5,
  woodland: 6,
};
const WOODLAND = USE_INDEX.woodland;
const PASTURE = USE_INDEX.pasture;
/**
 * How much seeded jitter each use's weights (about 0..1 over the land) carry, LAND_SHARED order:
 * the field uses a patchwork's worth (and it keeps their ranks near independent, so their shares
 * near exact), woodland a little, so its woods hold together on their ground.
 */
const JITTER = [0.6, 0.6, 0.6, 0.6, 0.6, 0.12] as const;

/** Gumbel quantile of a rank in (0, 1). */
function gumbel(rank: number): number {
  return -Math.log(-Math.log(clamp(rank, 1e-6, 1 - 1e-6)));
}

/** The land model of one terrain: each parcel's suitability for each use, ready to allocate. */
export class LandModel {
  /** Parcels (TerrainParcels.count). */
  readonly count: number;
  /** Per parcel: square metres of clear ground (dry, off the roads and yards). */
  readonly area: Float32Array;
  /** Per parcel and use (parcel · USES + use): its score, -Infinity where the use may not go. */
  readonly #score: Float32Array;
  readonly #crop: Uint8Array;
  /** Per parcel: how well cattle suit it (higher first). */
  readonly #cattle: Float32Array;
  /** Per parcel: its pine rank among the parcels woodland may take, 0 the most pine-like. */
  readonly #pine: Float32Array;

  constructor(terrain: Terrain, seed: number) {
    const t = terrain;
    const p = t.parcels;
    const count = p.count;
    const m = t.size;
    const cell2 = t.cell * t.cell;
    this.count = count;
    this.area = new Float32Array(count);
    this.#score = new Float32Array(count * USES);
    this.#crop = new Uint8Array(count);
    this.#cattle = new Float32Array(count);
    this.#pine = new Float32Array(count);
    // Per parcel over its clear texels: slope, height, the slope toward the sun, the nearest stream,
    // the road's distance.
    let bottom = Infinity;
    let top = -Infinity;
    for (let q = 0; q < m * m; q++) {
      bottom = Math.min(bottom, t.ground[q] ?? 0);
      top = Math.max(top, t.ground[q] ?? 0);
    }
    const span = Math.max(1, top - bottom);
    const slope = new Float64Array(count);
    const high = new Float64Array(count);
    const north = new Float64Array(count);
    const road = new Float64Array(count);
    const stream = new Float64Array(count).fill(64);
    const texels = new Int32Array(count);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const q = j * m + i;
        const id = p.ids[2 * q] ?? 0;
        if (id === 0) continue;
        const s = id - 1;
        const g = t.ground[q] ?? 0;
        if ((t.level[q] ?? 0) > g - 0.3 || (t.road[q] ?? 64) < 0 || (t.yard[q] ?? 0) > 0.3)
          continue;
        const gx =
          ((t.ground[j * m + Math.min(m - 1, i + 1)] ?? 0) -
            (t.ground[j * m + Math.max(0, i - 1)] ?? 0)) /
          (2 * t.cell);
        const gz =
          ((t.ground[Math.min(m - 1, j + 1) * m + i] ?? 0) -
            (t.ground[Math.max(0, j - 1) * m + i] ?? 0)) /
          (2 * t.cell);
        texels[s] = (texels[s] ?? 0) + 1;
        slope[s] = (slope[s] ?? 0) + Math.hypot(gx, gz);
        high[s] = (high[s] ?? 0) + (g - bottom) / span;
        // Rising to the north: the slope faces south, toward the sun.
        north[s] = (north[s] ?? 0) + gz;
        road[s] = (road[s] ?? 0) + Math.min(t.road[q] ?? 64, 64);
        stream[s] = Math.min(stream[s] ?? 64, t.stream[q] ?? 64);
      }
    }
    const river = t.river;
    const homes = t.settlements.filter((place) => place.kind !== "castle");
    const v = t.vantage;
    const weights = new Float64Array(count * USES);
    const eligible = new Uint8Array(count * USES);
    for (let s = 0; s < count; s++) {
      const n = texels[s] ?? 0;
      this.area[s] = n * cell2;
      if (n === 0) continue;
      const x = p.x[s] ?? 0;
      const z = p.z[s] ?? 0;
      const grade = (slope[s] ?? 0) / n;
      const height = (high[s] ?? 0) / n;
      const sunny = 0.5 + 0.5 * clamp((north[s] ?? 0) / n / 0.12, -1, 1);
      const access = 1 - (road[s] ?? 0) / n / 64;
      const wet = 1 - smoothstep(0, 40, stream[s] ?? 64);
      const plain = p.floodplain[s] ?? 0;
      let toRiver = Infinity;
      for (let k = 0; k < river.x.length; k += 4)
        toRiver = Math.min(toRiver, Math.hypot((river.x[k] ?? 0) - x, (river.z[k] ?? 0) - z));
      const riverside = 1 - smoothstep(60, 500, toRiver);
      let toHome = Infinity;
      for (const place of homes) toHome = Math.min(toHome, Math.hypot(place.x - x, place.z - z));
      const near = 1 - smoothstep(150, 900, toHome);
      const flat = 1 - smoothstep(0.04, 0.22, grade);
      const gentle = 1 - smoothstep(0.15, 0.4, grade);
      const wood = p.wood[s] ?? 0;
      const w = s * USES;
      // crops: flat, low, near the roads and settlements, off the floodplain
      weights[w] = 0.45 * flat + 0.2 * (1 - height) + 0.15 * access + 0.2 * near - 0.25 * plain;
      // wildflowers: moderate slopes, wet hollows, away from the roads, up the hills
      weights[w + 1] =
        0.3 * smoothstep(0.06, 0.2, grade) * gentle +
        0.3 * wet +
        0.25 * (1 - access) +
        0.15 * height;
      // lavender: sunny, dry, well-drained slopes
      weights[w + 2] = 0.45 * sunny + 0.25 * (1 - riverside) + 0.3 * smoothstep(0.04, 0.15, grade);
      // sunflowers: flat, sunny, low
      weights[w + 3] = 0.4 * flat + 0.4 * sunny + 0.2 * (1 - height);
      // pasture: by the river and the streams, on ground too wet or rolling to plough
      weights[w + 4] = 0.35 * riverside + 0.25 * wet + 0.2 * gentle + 0.2 * plain;
      // woodland: steep, high, poor ground (terrain.ts's woods), away from the settlements
      weights[w + 5] = 0.8 * wood + 0.2 * (1 - near);
      for (let u = 0; u < USES; u++) {
        weights[w + u] = (weights[w + u] ?? 0) + (JITTER[u] ?? 0) * hash31(s, u, seed * 7919 + 17);
        eligible[w + u] = 1;
      }
      if (Math.hypot(x - v.x, z - v.z) < LAND_OPEN_NEAR) eligible[w + WOODLAND - 1] = 0;
      // The crops' kind: hay and grazing on the floodplain and the steep ground, the arable
      // rotation elsewhere.
      const roll = hash31(s, 101, seed * 7919 + 23);
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
      this.#crop[s] = kind;
      this.#cattle[s] =
        0.4 * riverside + 0.3 * flat + 0.3 * (1 - height) + 0.3 * hash31(s, 102, seed * 7919 + 29);
      this.#pine[s] =
        0.35 * height +
        0.25 * smoothstep(0.1, 0.4, grade) +
        0.2 * (1 - sunny) +
        0.4 * hash31(s, 103, seed * 7919 + 31);
    }
    // Each use's weights into scores by area-weighted rank, through the Gumbel quantile.
    const order = Array.from({ length: count }, (_, s) => s);
    for (let u = 0; u < USES; u++) {
      const taken = order.filter((s) => eligible[s * USES + u] === 1 && (this.area[s] ?? 0) > 0);
      taken.sort((a, b) => (weights[a * USES + u] ?? 0) - (weights[b * USES + u] ?? 0) || a - b);
      let whole = 0;
      for (const s of taken) whole += this.area[s] ?? 0;
      let below = 0;
      for (let s = 0; s < count; s++) this.#score[s * USES + u] = -Infinity;
      for (const s of taken) {
        const a = this.area[s] ?? 0;
        this.#score[s * USES + u] = gumbel((below + 0.5 * a) / whole);
        below += a;
      }
    }
    // Pine ranks over the parcels woodland may take.
    const woods = order.filter((s) => Number.isFinite(this.#score[s * USES + WOODLAND - 1] ?? 0));
    woods.sort((a, b) => (this.#pine[b] ?? 0) - (this.#pine[a] ?? 0) || a - b);
    let wholeWood = 0;
    for (const s of woods) wholeWood += this.area[s] ?? 0;
    let pineBelow = 0;
    const pineRank = new Float32Array(count).fill(1);
    for (const s of woods) {
      pineRank[s] = (pineBelow + 0.5 * (this.area[s] ?? 0)) / Math.max(wholeWood, 1);
      pineBelow += this.area[s] ?? 0;
    }
    this.#pine.set(pineRank);
  }

  /** Every parcel's use and attribute for these options (see the header). */
  allocate(options: LandOptions): LandAllocation {
    const count = this.count;
    const use = new Uint8Array(count);
    const attr = new Uint8Array(count);
    const area = new Float64Array(LAND_USES.length);
    const price = new Float64Array(USES).fill(-Infinity);
    LAND_SHARED.forEach((name, u) => {
      const share = options.shares[name] ?? 0;
      if (share > 0) price[u] = Math.log(share);
    });
    let total = 0;
    const pastures: number[] = [];
    for (let s = 0; s < count; s++) {
      const a = this.area[s] ?? 0;
      let best = -1;
      let bestScore = -Infinity;
      let open = false;
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
      if (best < 0 || !Number.isFinite(bestScore)) continue;
      const index = best + 1;
      use[s] = index;
      area[index] = (area[index] ?? 0) + a;
      if (index === USE_INDEX.crops) attr[s] = this.#crop[s] ?? 0;
      else if (index === WOODLAND) attr[s] = (this.#pine[s] ?? 1) < options.pines ? 1 : 0;
      else if (index === PASTURE) pastures.push(s);
    }
    pastures.sort((a, b) => (this.#cattle[b] ?? 0) - (this.#cattle[a] ?? 0) || a - b);
    const cattle = Math.round(clamp(options.cows, 0, 1) * pastures.length);
    for (let k = 0; k < cattle; k++) attr[pastures[k] ?? 0] = 1;
    area[0] = Math.max(
      0,
      total - area.reduce((sum, value, index) => sum + (index > 0 ? value : 0), 0),
    );
    return { use, attr, area, total, wooded: price[WOODLAND - 1] !== -Infinity };
  }
}

/** Uses that enclose their parcel with a hedge: the farmed ones (not open grassland, not woods). */
function enclosed(use: number): boolean {
  return use >= USE_INDEX.crops && use <= PASTURE;
}

/**
 * Write a land allocation into a packed terrain (terrain.ts packTerrain): each parcel site's use and
 * attribute (TERRAIN_RECORDS sites), and texel by texel the woods' canopy (cover z: 0..1 inside
 * woodland parcels, pulled in from their edges on poor ground by up to some 18 m, so a wood's edge
 * is as ragged as its suitability, clear of water, streams, roads and yards; negative under pines)
 * and which lone trees stand (cover w -1: a hedgerow tree only where its hedge stands, between two
 * parcels of which at least one is farmed, and outside the woods; none while woodland has no
 * share). Rewrites only those; packing the terrain again is not needed.
 */
export function packLand(packed: TerrainPacked, t: Terrain, land: LandAllocation): void {
  const p = t.parcels;
  const L = TERRAIN_RECORDS;
  for (let s = 0; s < p.count; s++) {
    const o = 4 * ((L.sites + Math.floor(s / 32)) * L.width + 2 * (s % 32)) + 4;
    packed.records[o + 2] = land.use[s] ?? 0;
    packed.records[o + 3] = land.attr[s] ?? 0;
  }
  const m = t.size;
  const cos = p.angle.map(Math.cos);
  const sin = p.angle.map(Math.sin);
  // A texel's stretched distance (terrain.ts's parcel metric) to site s.
  const metric = (x: number, z: number, s: number): number => {
    const dx = x - (p.x[s] ?? 0);
    const dz = z - (p.z[s] ?? 0);
    const c = cos[s] ?? 1;
    const n = sin[s] ?? 0;
    return Math.hypot((dx * c + dz * n) / (p.elongation[s] ?? 1), -dx * n + dz * c);
  };
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const q = j * m + i;
      const o = 4 * q;
      const id = p.ids[2 * q] ?? 0;
      const other = p.ids[2 * q + 1] ?? 0;
      const use = id > 0 ? (land.use[id - 1] ?? 0) : 0;
      let canopy = 0;
      if (use === WOODLAND) {
        canopy = 1;
        if (other > 0 && (land.use[other - 1] ?? 0) !== WOODLAND) {
          const x = (i + 0.5) * t.cell;
          const z = (j + 0.5) * t.cell;
          const border = 0.5 * (metric(x, z, other - 1) - metric(x, z, id - 1));
          const inset = 2 + 16 * (1 - smoothstep(0.2, 0.8, t.wood[q] ?? 0));
          canopy = smoothstep(inset, inset + 5, border);
        }
        const dry = (t.level[q] ?? 0) <= (t.ground[q] ?? 0) - 0.3 ? 1 : 0;
        canopy *=
          dry *
          smoothstep(0.5, 3.5, t.stream[q] ?? 64) *
          smoothstep(1.5, 5, t.road[q] ?? 64) *
          (1 - smoothstep(0.1, 0.4, t.yard[q] ?? 0));
        if ((land.attr[id - 1] ?? 0) === 1) canopy = -canopy;
      }
      packed.cover[o + 2] = canopy;
      const yard = t.yard[q] ?? 0;
      if (yard >= 0) continue;
      // A lone tree: on a hedge (its texel's parcel differs from the next one's) only while the
      // hedge stands; on the river's banks while woodland has a share.
      let stands = land.wooded && Math.abs(canopy) < 0.5;
      const across =
        i + 1 < m && (p.ids[2 * (q + 1)] ?? 0) !== id
          ? (p.ids[2 * (q + 1)] ?? 0)
          : j + 1 < m && (p.ids[2 * (q + m)] ?? 0) !== id
            ? (p.ids[2 * (q + m)] ?? 0)
            : id;
      if (across !== id)
        stands &&= enclosed(use) || (across > 0 && enclosed(land.use[across - 1] ?? 0));
      packed.cover[o + 3] = stands ? -1 : 0;
    }
  }
}
