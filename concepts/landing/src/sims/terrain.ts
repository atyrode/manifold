// A coherent landscape for a scene to draw: relief carved by running water, a river lying level in
// its bed, settlements where people would build, roads between them and the masks a shader needs
// (water, roads, yards, field parcels, woodland), all on one square map. Deterministic for its
// options; built in small units a frame's budget can spread (runBudgeted), never in one long stall.
//
// The map is `extent` metres a side on two grids: the erosion grid (size / 2 cells a side) and the
// fine grid (size texels a side) every output lives on. Texel (i, j) is centred on
// ((i + 0.5) · cell, (j + 0.5) · cell); x runs east, z north, y up; row 0 is z = 0, as DataTexture
// uploads it. Heights are metres.
//
// Stages (each a unit or a few, in this order):
//   relief      a river valley laid across the view from `vantage` (the axis enters over the far
//               hills and leaves past the near side), hills either side of fractal and ridged value
//               noise (noise.ts), a rise under the vantage and toward the far side.
//   erosion     stream-power incision, implicit in the receivers' order (Braun & Willett, "A very
//               efficient O(n), implicit and parallel method to solve the stream power equation",
//               Geomorphology 180, 2013): each cell drops toward its receiver by K·A^½ per unit of
//               distance; drainage by a priority flood (shallow.ts's LevelHeap) that fills pits and
//               gives every cell a receiver; then thermal slumping to the angle of repose
//               (heightfield.ts's relax). The river's catchment beyond the map enters at its source.
//   flow        the final receivers and drainage area.
//   detail      the erosion grid upsampled (Catmull-Rom) to the fine grid, with fine relief.
//   river       the main channel: the drainage tree's largest path from the mouth up to the source,
//               smoothed (its course, whatever the river's size), given meanders on gentle ground,
//               a width growing with its catchment and a water level running down it, never up
//               (the running minimum of the ground, smoothed); then carved: a bed under that level,
//               banks, a floodplain flattened just above it and a blend back into the valley sides.
//               The level is the same right across the channel.
//   streams     the tributaries above a catchment threshold, as a distance field, notched slightly.
//   settlements sites scored by flatness, water near but off the floodplain, distance and a clear
//               line of sight from the vantage (heightray.ts's marchHeight), all on the land as it
//               lay before the river was carved and against the river's course (off the floodplain
//               of the largest river, its meanders' widest sway included), so the river's size
//               moves none: a village (at the best site that scores at all, where none scores
//               well), a castle on a prominent hilltop, up to TERRAIN_MAX_HAMLETS hamlets and
//               TERRAIN_MAX_FARMS farms, kept apart, each chosen in that order whether or not it is
//               built, so a settlement switched on or off never moves another. Every site chosen,
//               built or not, stays a candidate (Terrain.candidates) at its nominal radius: what
//               the parcels and the land model read, so no settlement's switch or size moves a
//               field beyond its own ground.
//   roads       a minimum spanning tree over the village, hamlets, castle and one road out over the
//               far side (a crossing of the river weighed heavily), a shortcut where the tree
//               detours, and a track to each farm and down through the near field; each edge a
//               least-cost path (A* in 16 directions) on a cost grid of slope, curvature and
//               floodplain, water impassable, roads already laid cheaper; one bridge where the
//               river is narrowest near the crossing. Every route is planned whatever `roads` and
//               `tracks` say, so neither moves another way; a route switched off keeps only its
//               stretch through the village (TERRAIN_VILLAGE_STREETS), as the village's own
//               street, so no cottage moves. Each road's profile is cut and fill: the mean of the
//               ground's upper and lower Lipschitz envelopes, so no stretch is steeper than
//               TERRAIN_ROAD_MAX_SLOPE, and its bed is cut into the ground.
//   buildings   the village's cottages taken in a fixed order from its centre out along its roads
//               (so a larger village only adds cottages), its church, hamlets' cottages, farmhouses
//               and barns at the tracks' ends, the castle; each on a levelled terrace. Each draws
//               from hashes of its own place, never a shared sequence, so no settlement's size
//               moves another's buildings.
//   woods       how well woodland suits each texel (steep, high, poor ground), 0..1: the land model
//               (landuse.ts) weighs parcels for woodland by it and roughs the woods' edges with it.
//   parcels     land units: sites spread over the land, those in the water dropped (so the river's
//               size drops or keeps only sites in the water between two sizes, and moves no other),
//               smaller round every candidate settlement, each cell stretched along the contour
//               (or the road beside it), the nearest two sites per texel by that metric; each site
//               draws its own spacing and shape from hashes of its place, whatever its neighbours
//               draw, so the sites are the same under every settlement and road setting and only
//               cells beside a changed road turn. What each parcel is used for is the land model's
//               (landuse.ts), not the build's.
//
// Outputs (Terrain): ground and water level per texel; signed distance to the nearest road and
// stream edge (metres, negative on it); woodland suitability; yards (0..1 around buildings); the
// river's bed (where its own level is the water: `riverbed`); the river's centreline with its level
// and width; settlements and every candidate site, buildings, roads with their profiles, the
// bridge; parcel sites and the nearest two per texel. `packTerrain` lays them into the four
// textures `terrainGlsl` (shaders/lib/terrain.ts) reads; `packWater` dries the river's bed in them
// or fills it again.
//
// Cost (size 512, a laptop's V8; the build reports its own per stage in `timings`): relief ~15 ms,
// each of 20 erosion steps ~10 ms, detail ~20 ms, river ~40 ms, settlements ~30 ms, each road
// ~5–25 ms (every route planned, whatever is laid), parcels ~150 ms in three units (the bare cells
// with them), pack ~15 ms; ~1 s in all. Nothing allocates per texel.
// A build given an earlier one reuses what its options leave as they were: the eroded relief when
// only the river or the settlements change, the carved river and streams too when only the
// settlements and roads do.
//
// Usage (a sim building it over a few frames, keeping the last map on screen meanwhile):
//   const builder = new TerrainBuilder({ seed, relief, erosion, river, village }, previous);
//   let next = 0;
//   frame() {
//     if (next < builder.units) next = runBudgeted((i) => builder.unit(i), 8, builder.units, next);
//     if (next >= builder.units && !uploaded) upload(packTerrain(builder.terrain));
//   }
//   // or at once: const terrain = generateTerrain({ seed: 3 });
import { type HeightMarch, marchHeight, type RayHit } from "./heightray.ts";
import { HeightField } from "./heightfield.ts";
import { splitHalf } from "./half.ts";
import { clamp, hash31, hypot2, hypot3, lerp, smoothstep } from "./math.ts";
import { fbm, valueNoise } from "./noise.ts";
import { Random } from "./random.ts";
import { LevelHeap, stillWater } from "./shallow.ts";

/** The steepest grade any stretch of road may have (rise over run). */
export const TERRAIN_ROAD_MAX_SLOPE = 0.12;
/** Erosion steps (units) of a build. */
export const TERRAIN_EROSION_STEPS = 20;
/** Most hamlets a build places beyond the village. */
export const TERRAIN_MAX_HAMLETS = 3;
/** Most farms a build places among the fields. */
export const TERRAIN_MAX_FARMS = 8;
/** Most cottages the village holds round its church. */
export const TERRAIN_MAX_COTTAGES = 30;
/**
 * Metres across a cottage's gable as a consumer draws it (half again life size, so a house far off
 * still covers a few dither cells); buildings are spaced, set back and terraced by it.
 */
export const TERRAIN_HOUSE = 10;
/** Parcel sites a build can hold: ids are 1..TERRAIN_MAX_PARCELS (0: no parcel). */
export const TERRAIN_MAX_PARCELS = 2048;
/** Buildings a build can hold. */
export const TERRAIN_MAX_BUILDINGS = 128;
/** Settlements a build can hold (village, castle, the outlying ones). */
export const TERRAIN_MAX_PLACES = 16;
/** Points of the roads resampled for walkers and carts the records hold (terrainWays). */
export const TERRAIN_MAX_WAY_POINTS = 4096;
/** Kinds of building, by `TerrainBuilding.kind` (its index is the packed kind). */
export const TERRAIN_BUILDING_KINDS = ["cottage", "church", "barn", "castle"] as const;
export type TerrainBuildingKind = (typeof TERRAIN_BUILDING_KINDS)[number];
export type TerrainSettlementKind = "village" | "hamlet" | "farm" | "castle";
/**
 * The relief the map starts from, the river's axis across the vantage's view in each: a valley
 * between hills; a coast, the valley opening downstream into a bay of the sea (water level 0); a
 * plateau, a high table the river has cut a steep-sided gorge into; rolling hills all round.
 */
export const TERRAIN_BASES = ["valley", "coast", "plateau", "hills"] as const;
export type TerrainBase = (typeof TERRAIN_BASES)[number];

/** Where the landscape is seen from: the valley is laid across this view. */
export interface TerrainVantage {
  /** The camera's place on the map, metres. */
  x: number;
  z: number;
  /** Unit heading on the map. */
  dx: number;
  dz: number;
  /** Eye above the ground there, metres. */
  eye: number;
}

export interface TerrainOptions {
  seed: number;
  /** Fine grid texels a side: a power of two, 128..1024. Default 512. */
  size?: number;
  /** Metres a side. Default 3200. */
  extent?: number;
  /** Hills' height, 0 gentle .. 1 rugged. Default 0.5. */
  relief?: number;
  /** How far running water and slumping carve the hills, 0 none .. 1 deep valleys. Default 0.5. */
  erosion?: number;
  /** The river's size, 0 a brook .. 1 a broad river. Default 0.5. */
  river?: number;
  /** Cottages round the village's church, 0..TERRAIN_MAX_COTTAGES (0: no village). Default 11. */
  village?: number;
  /** Hamlets beyond the village, 0..TERRAIN_MAX_HAMLETS. Default 2. */
  hamlets?: number;
  /** Farms among the fields, 0..TERRAIN_MAX_FARMS. Default 3. */
  farms?: number;
  /** A castle on a prominent hilltop. Default true. */
  castle?: boolean;
  /** Roads joining the village, hamlets and castle, and one out over the far side. Default true. */
  roads?: boolean;
  /** Tracks out to the farms and down through the near field. Default true. */
  tracks?: boolean;
  /** Default: 6% of the extent in from the south-west corner, looking north-east, eye 30 m up. */
  vantage?: TerrainVantage;
  /** The relief it starts from (TERRAIN_BASES). Default "valley". */
  base?: TerrainBase;
}

export interface TerrainRiver {
  /** Centreline from the source (on the map's edge) to the mouth, metres. */
  x: Float32Array;
  z: Float32Array;
  /** Water level, never rising downstream. */
  level: Float32Array;
  /** Channel width, metres. */
  width: Float32Array;
  /** Distance along the centreline from the source. */
  along: Float32Array;
}

/** A settlement's site as the build chose it, built or not (Terrain.candidates). */
export interface TerrainSite {
  kind: TerrainSettlementKind;
  x: number;
  z: number;
  y: number;
  /** Its nominal spread, metres, whatever is built there. */
  radius: number;
  /** Which side of the river it lies on (a label; settlements on one side share it). */
  bank: number;
}

export interface TerrainSettlement extends TerrainSite {
  /** Roughly how far its buildings spread, metres (its site's nominal spread at least). */
  radius: number;
  /** Its buildings: TerrainBuilding indices first .. first + count - 1. */
  first: number;
  count: number;
}

export interface TerrainBuilding {
  kind: TerrainBuildingKind;
  x: number;
  z: number;
  /** Its levelled terrace's height. */
  y: number;
  /** Heading of its long wall (radians from +x toward +z). */
  facing: number;
  /** Long wall's length over the gable's width (1 a square plan). */
  length: number;
  /** 0..1, for its own variation (windows, smoke). */
  hash: number;
  settlement: number;
}

export interface TerrainRoad {
  kind: "road" | "track";
  /**
   * Settlement indices it joins; -1 the map's edge, or the open end of a village street (a route
   * switched off, its stretch through the village kept).
   */
  from: number;
  to: number;
  /** Centreline, metres, every ~4 m. */
  x: Float32Array;
  z: Float32Array;
  /** The road's surface: cut and fill, never steeper than TERRAIN_ROAD_MAX_SLOPE. */
  y: Float32Array;
  halfWidth: number;
  /** The points at the bridge's ends (the span between them is the bridge), or -1, -1. */
  bridgeStart: number;
  bridgeEnd: number;
}

export interface TerrainBridge {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** The deck's height at either end. */
  deck0: number;
  deck1: number;
  halfWidth: number;
  /** The water level under it. */
  water: number;
}

export interface TerrainParcels {
  count: number;
  x: Float32Array;
  z: Float32Array;
  /** Heading of the parcel's long axis (radians from +x toward +z), and its length over width. */
  angle: Float32Array;
  elongation: Float32Array;
  /** 1 where the site lies on the river's floodplain. */
  floodplain: Uint8Array;
  /** Mean woodland suitability over the parcel's cell on the bare land (TerrainBare), 0..1. */
  wood: Float32Array;
  /** Per texel the nearest and second-nearest site, id = index + 1 (0 none): [2·k], [2·k + 1]. */
  ids: Uint16Array;
  /**
   * Per site its clear core: the widest disc inside the parcel that keeps clear of its border,
   * water, roads, streams, yards and lone trees (a herd's ground). Centre, metres; radius 0: none.
   */
  coreX: Float32Array;
  coreZ: Float32Array;
  coreRadius: Float32Array;
}

/**
 * The land as the river and streams left it, before any road or building, and each parcel's cell
 * on it: every site at its bare heading (along the contour, or as it falls), as though no road
 * turned it. The same under every settlement, road and track setting of a landscape, so the land
 * model weighs and ranks its parcels by it and a switch elsewhere moves none of their weights.
 */
export interface TerrainBare {
  ground: Float32Array;
  level: Float32Array;
  /** Per texel its nearest parcel site by the bare metric, id = index + 1 (0 none). */
  ids: Uint16Array;
}

export interface Terrain {
  readonly size: number;
  readonly extent: number;
  /** Metres a texel. */
  readonly cell: number;
  readonly ground: Float32Array;
  /** Water surface; below the ground where there is none. */
  readonly level: Float32Array;
  /** Signed distance to the nearest road's edge (metres, negative on it), clamped to ±64. */
  readonly road: Float32Array;
  /** The same for streams. */
  readonly stream: Float32Array;
  /** Woodland suitability 0..1. */
  readonly wood: Float32Array;
  /** 0..1 around buildings (gardens, yards); -1 a lone tree (hedgerows, river banks), a texel each. */
  readonly yard: Float32Array;
  /** 1 where the river's own level is the water (its channel and banks; not the sea), else 0. */
  readonly riverbed: Uint8Array;
  readonly river: TerrainRiver;
  readonly settlements: readonly TerrainSettlement[];
  /**
   * Every settlement site chosen, built or not, in the order chosen (the village, the castle, the
   * hamlets, the farms), each at its nominal radius: what the parcels and the land model read, so
   * no settlement switched on or off, or grown, moves a field beyond its own ground.
   */
  readonly candidates: readonly TerrainSite[];
  readonly buildings: readonly TerrainBuilding[];
  readonly roads: readonly TerrainRoad[];
  readonly bridge: TerrainBridge | undefined;
  readonly parcels: TerrainParcels;
  readonly bare: TerrainBare;
  /** The vantage, with the eye's height above sea level. */
  readonly vantage: TerrainVantage & { y: number };
  /** Milliseconds each stage took (wall time). */
  readonly timings: Readonly<Record<string, number>>;
}

export class TerrainError extends Error {}

const SQRT2 = Math.SQRT2;
const DX8 = [-1, 1, 0, 0, -1, 1, -1, 1] as const;
const DZ8 = [0, 0, -1, 1, -1, -1, 1, 1] as const;
const DL8 = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2] as const;
// A*'s 16 moves: the 8 neighbours and the 8 knight's moves.
const DX16 = [-1, 1, 0, 0, -1, 1, -1, 1, -2, -2, 2, 2, -1, 1, -1, 1] as const;
const DZ16 = [0, 0, -1, 1, -1, -1, 1, 1, -1, 1, -1, 1, -2, -2, 2, 2] as const;
const ROAD_HALF = 2.6;
const TRACK_HALF = 1.6;
/** Distance fields are clamped here (metres). */
const FAR = 64;
/** Roads within this reach set a parcel's heading. */
const ROAD_ALIGN = 60;
/** Parcel site spacing, metres. */
const PARCEL_SPACING = 96;
/** How far (metres) from the village along its roads its cottages' plots reach. */
const VILLAGE_REACH = 300;
/**
 * How far (metres) from the village a route switched off is kept as the village's own street: past
 * every plot along its roads, the plot's verge and the slope it is judged on, so no cottage moves.
 */
export const TERRAIN_VILLAGE_STREETS = VILLAGE_REACH + 60;
/** Routes a build can lay: the hubs' tree and its shortcut, a track to each farm and the lane. */
const MAX_ROUTES = TERRAIN_MAX_HAMLETS + TERRAIN_MAX_FARMS + 6;
/** The river's catchment beyond the map, in extents², entering at its source. */
const RIVER_INFLOW = 0.6;
/** How far (metres, from the edge) a parcel's clear core keeps off roads and streams. */
const CORE_CLEAR = { road: 5, stream: 4 } as const;
/** The least spacing (metres) of the points a road is resampled at for the records. */
const WAY_SPACING = 4;

/** Bilinear sample of a size × size grid spread over `extent` metres (texel centres), clamped. */
export function sampleGrid(
  data: Float32Array,
  size: number,
  extent: number,
  x: number,
  z: number,
): number {
  const fx = clamp((x / extent) * size - 0.5, 0, size - 1);
  const fz = clamp((z / extent) * size - 0.5, 0, size - 1);
  const i = Math.min(size - 2, Math.floor(fx));
  const j = Math.min(size - 2, Math.floor(fz));
  const tx = fx - i;
  const tz = fz - j;
  const k = j * size + i;
  const a = data[k] ?? 0;
  const b = data[k + 1] ?? 0;
  const c = data[k + size] ?? 0;
  const d = data[k + size + 1] ?? 0;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Catmull-Rom sample of an n × n grid at continuous texel coordinates (texel i centred on i). */
function sampleCubic(data: Float32Array, n: number, cx: number, cz: number): number {
  const i = Math.floor(cx);
  const j = Math.floor(cz);
  const tx = cx - i;
  const tz = cz - j;
  let sum = 0;
  for (let b = -1; b <= 2; b++) {
    const wz = cubicWeight(b - tz);
    const row = clamp(j + b, 0, n - 1) * n;
    let line = 0;
    for (let a = -1; a <= 2; a++) {
      line += cubicWeight(a - tx) * (data[row + clamp(i + a, 0, n - 1)] ?? 0);
    }
    sum += wz * line;
  }
  return sum;
}

function cubicWeight(x: number): number {
  const a = Math.abs(x);
  if (a < 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

interface Polyline {
  x: number[];
  z: number[];
}

/** Chaikin's corner cutting, `iterations` times, the ends kept. */
function chaikin(line: Polyline, iterations: number): Polyline {
  let { x, z } = line;
  for (let it = 0; it < iterations && x.length > 2; it++) {
    const nx: number[] = [x[0] ?? 0];
    const nz: number[] = [z[0] ?? 0];
    for (let k = 0; k + 1 < x.length; k++) {
      const ax = x[k] ?? 0;
      const az = z[k] ?? 0;
      const bx = x[k + 1] ?? 0;
      const bz = z[k + 1] ?? 0;
      nx.push(0.75 * ax + 0.25 * bx, 0.25 * ax + 0.75 * bx);
      nz.push(0.75 * az + 0.25 * bz, 0.25 * az + 0.75 * bz);
    }
    nx.push(x[x.length - 1] ?? 0);
    nz.push(z[z.length - 1] ?? 0);
    x = nx;
    z = nz;
  }
  return { x, z };
}

/** Points every `ds` metres along the line (the last point kept). */
function resample(line: Polyline, ds: number): Polyline {
  const x: number[] = [line.x[0] ?? 0];
  const z: number[] = [line.z[0] ?? 0];
  let carry = 0;
  for (let k = 0; k + 1 < line.x.length; k++) {
    const ax = line.x[k] ?? 0;
    const az = line.z[k] ?? 0;
    const bx = line.x[k + 1] ?? 0;
    const bz = line.z[k + 1] ?? 0;
    const length = hypot2(bx - ax, bz - az);
    let at = ds - carry;
    while (at <= length) {
      const t = at / length;
      x.push(ax + (bx - ax) * t);
      z.push(az + (bz - az) * t);
      at += ds;
    }
    carry = length - (at - ds);
  }
  const lx = line.x[line.x.length - 1] ?? 0;
  const lz = line.z[line.z.length - 1] ?? 0;
  if (hypot2(lx - (x[x.length - 1] ?? 0), lz - (z[z.length - 1] ?? 0)) > 0.25 * ds) {
    x.push(lx);
    z.push(lz);
  } else {
    x[x.length - 1] = lx;
    z[z.length - 1] = lz;
  }
  return { x, z };
}

/** Douglas–Peucker: the points that keep the line within `tolerance` metres. */
function simplify(line: Polyline, tolerance: number): Polyline {
  const n = line.x.length;
  if (n < 3) return line;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop() ?? 0;
    const a = stack.pop() ?? 0;
    const ax = line.x[a] ?? 0;
    const az = line.z[a] ?? 0;
    const bx = line.x[b] ?? 0;
    const bz = line.z[b] ?? 0;
    let worst = -1;
    let far = tolerance;
    for (let k = a + 1; k < b; k++) {
      const d = segmentDistance(line.x[k] ?? 0, line.z[k] ?? 0, ax, az, bx, bz);
      if (d > far) {
        far = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(a, worst, worst, b);
    }
  }
  const x: number[] = [];
  const z: number[] = [];
  for (let k = 0; k < n; k++) {
    if (keep[k] === 0) continue;
    x.push(line.x[k] ?? 0);
    z.push(line.z[k] ?? 0);
  }
  return { x, z };
}

function segmentDistance(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const ex = bx - ax;
  const ez = bz - az;
  const len2 = ex * ex + ez * ez;
  const t = len2 > 0 ? clamp(((px - ax) * ex + (pz - az) * ez) / len2, 0, 1) : 0;
  return hypot2(px - ax - ex * t, pz - az - ez * t);
}

/**
 * For every fine texel within `reach(k)` metres of segment k (points k, k + 1) of the line: where
 * its distance less `inset` (a signed distance to the edge of a line `inset` wide either side) is
 * below what `dist` holds, store that and `along` = k + t, its foot on the line. Texels are visited
 * in the segments' bounding boxes only.
 */
function nearestOnLine(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  count: number,
  reach: (k: number) => number,
  inset: number,
  size: number,
  cell: number,
  dist: Float32Array,
  along: Float32Array | undefined,
): void {
  for (let k = 0; k + 1 < count; k++) {
    const ax = xs[k] ?? 0;
    const az = zs[k] ?? 0;
    const bx = xs[k + 1] ?? 0;
    const bz = zs[k + 1] ?? 0;
    const r = reach(k);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell - 0.5));
    const i1 = Math.min(size - 1, Math.ceil((Math.max(ax, bx) + r) / cell - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r) / cell - 0.5));
    const j1 = Math.min(size - 1, Math.ceil((Math.max(az, bz) + r) / cell - 0.5));
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = Math.max(ex * ex + ez * ez, 1e-9);
    for (let j = j0; j <= j1; j++) {
      const pz = (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * cell;
        const t = clamp(((px - ax) * ex + (pz - az) * ez) / len2, 0, 1);
        const qx = px - ax - ex * t;
        const qz = pz - az - ez * t;
        const d = Math.sqrt(qx * qx + qz * qz);
        if (d > r) continue;
        const at = j * size + i;
        if (d - inset >= (dist[at] ?? Infinity)) continue;
        dist[at] = d - inset;
        if (along) along[at] = k + t;
      }
    }
  }
}

/**
 * Exact Euclidean distance (in cells) from every cell of an n × n grid to the nearest cell set in
 * `seeds` (Felzenszwalb & Huttenlocher's separable transform); Infinity everywhere without seeds.
 */
function distanceField(seeds: Uint8Array, n: number): Float32Array {
  const big = 1e20;
  const out = new Float32Array(n * n);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const zb = new Float64Array(n + 1);
  const pass = (): void => {
    let k = 0;
    v[0] = 0;
    zb[0] = -Infinity;
    zb[1] = Infinity;
    for (let q = 1; q < n; q++) {
      const fq = f[q] ?? big;
      let s = 0;
      for (;;) {
        const p = v[k] ?? 0;
        s = (fq + q * q - ((f[p] ?? big) + p * p)) / (2 * q - 2 * p);
        if (s <= (zb[k] ?? 0)) {
          k--;
          if (k < 0) {
            k = 0;
            break;
          }
        } else break;
      }
      if (k === 0 && s <= (zb[0] ?? 0)) {
        v[0] = q;
        zb[0] = -Infinity;
        zb[1] = Infinity;
        continue;
      }
      k++;
      v[k] = q;
      zb[k] = s;
      zb[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while ((zb[k + 1] ?? Infinity) < q) k++;
      const p = v[k] ?? 0;
      d[q] = (q - p) * (q - p) + (f[p] ?? big);
    }
  };
  for (let x = 0; x < n; x++) {
    for (let z = 0; z < n; z++) f[z] = seeds[z * n + x] === 1 ? 0 : big;
    pass();
    for (let z = 0; z < n; z++) out[z * n + x] = d[z] ?? big;
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) f[x] = out[z * n + x] ?? big;
    pass();
    for (let x = 0; x < n; x++) {
      const sq = d[x] ?? big;
      out[z * n + x] = sq >= big * 0.5 ? Infinity : Math.sqrt(sq);
    }
  }
  return out;
}

/** The drainage of a grid: each cell's receiver, the cells in receiver-first order, the area. */
interface Drainage {
  rec: Int32Array;
  order: Int32Array;
  area: Float32Array;
}

/**
 * Priority flood from the outlets (8-connected): pits are filled to just above their spill point
 * (`eps` per cell, so they still drain) and `order` lists cells lowest first, so every cell comes
 * after all lower ones. Each cell's receiver is then its steepest lower neighbour (D8; outlets are
 * their own). Then the drainage area: `cellArea` a cell plus `inflow` at `source`, summed down the
 * receivers.
 */
function drain(
  h: Float32Array,
  n: number,
  outlet: Uint8Array,
  eps: number,
  cellArea: number,
  source: number,
  inflow: number,
  out: Drainage,
  heap: LevelHeap,
  seen: Uint8Array,
): void {
  seen.fill(0);
  for (let i = 0; i < n * n; i++) {
    if (outlet[i] === 0) continue;
    seen[i] = 1;
    out.rec[i] = i;
    heap.push(i, h[i] ?? 0);
  }
  let k = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    out.order[k++] = c;
    const hc = h[c] ?? 0;
    const x = c % n;
    const z = (c - x) / n;
    for (let d = 0; d < 8; d++) {
      const nx = x + (DX8[d] ?? 0);
      const nz = z + (DZ8[d] ?? 0);
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const j = nz * n + nx;
      if (seen[j] === 1) continue;
      seen[j] = 1;
      out.rec[j] = c;
      if ((h[j] ?? 0) <= hc) h[j] = hc + eps * (DL8[d] ?? 1);
      heap.push(j, h[j] ?? 0);
    }
  }
  for (let i = 0; i < n * n; i++) {
    if (outlet[i] === 1) continue;
    const x = i % n;
    const z = (i - x) / n;
    const hi = h[i] ?? 0;
    let steepest = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + (DX8[d] ?? 0);
      const nz = z + (DZ8[d] ?? 0);
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const j = nz * n + nx;
      const drop = (hi - (h[j] ?? 0)) / (DL8[d] ?? 1);
      if (drop > steepest) {
        steepest = drop;
        out.rec[i] = j;
      }
    }
  }
  // Area spread over every lower neighbour by slope^1.1 (Freeman's multiple flow directions, 1991):
  // on an even slope it stays a sheet instead of gathering into one-cell furrows along the grid,
  // and it still converges where the ground does.
  const area = out.area;
  area.fill(cellArea);
  area[source] = (area[source] ?? 0) + inflow;
  const share = new Float64Array(8);
  for (let q = n * n - 1; q >= 0; q--) {
    const i = out.order[q] ?? 0;
    if (outlet[i] === 1) continue;
    const x = i % n;
    const z = (i - x) / n;
    const hi = h[i] ?? 0;
    let sum = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + (DX8[d] ?? 0);
      const nz = z + (DZ8[d] ?? 0);
      let w = 0;
      if (nx >= 0 && nz >= 0 && nx < n && nz < n) {
        const drop = (hi - (h[nz * n + nx] ?? 0)) / (DL8[d] ?? 1);
        if (drop > 0) w = drop ** 1.1;
      }
      share[d] = w;
      sum += w;
    }
    if (!(sum > 0)) continue;
    const a = (area[i] ?? 0) / sum;
    for (let d = 0; d < 8; d++) {
      const w = share[d] ?? 0;
      if (w > 0) {
        const j = (z + (DZ8[d] ?? 0)) * n + x + (DX8[d] ?? 0);
        area[j] = (area[j] ?? 0) + a * w;
      }
    }
  }
}

/** A min-heap of A* nodes by score (its own: scores change as nodes are re-pushed). */
class NodeHeap {
  #nodes: Int32Array;
  #keys: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.#nodes = new Int32Array(capacity);
    this.#keys = new Float64Array(capacity);
  }

  push(node: number, key: number): void {
    if (this.size === this.#nodes.length) {
      const nodes = new Int32Array(this.#nodes.length * 2);
      const keys = new Float64Array(this.#nodes.length * 2);
      nodes.set(this.#nodes);
      keys.set(this.#keys);
      this.#nodes = nodes;
      this.#keys = keys;
    }
    const nodes = this.#nodes;
    const keys = this.#keys;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((keys[parent] ?? 0) <= key) break;
      nodes[i] = nodes[parent] ?? 0;
      keys[i] = keys[parent] ?? 0;
      i = parent;
    }
    nodes[i] = node;
    keys[i] = key;
  }

  pop(): number {
    const nodes = this.#nodes;
    const keys = this.#keys;
    const top = nodes[0] ?? 0;
    const last = --this.size;
    const node = nodes[last] ?? 0;
    const key = keys[last] ?? 0;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && (keys[child + 1] ?? 0) < (keys[child] ?? 0)) child++;
      if ((keys[child] ?? 0) >= key) break;
      nodes[i] = nodes[child] ?? 0;
      keys[i] = keys[child] ?? 0;
      i = child;
    }
    nodes[i] = node;
    keys[i] = key;
    return top;
  }
}

/** Lower and upper Lipschitz envelopes of `h` (spacing ds, grade g), averaged: cut and fill. */
function gradeProfile(
  h: Float64Array,
  ds: number,
  g: number,
  pinned: Uint8Array | undefined,
): void {
  const n = h.length;
  const lo = Float64Array.from(h);
  const hi = Float64Array.from(h);
  const step = g * ds;
  for (let k = 1; k < n; k++) {
    lo[k] = Math.min(lo[k] ?? 0, (lo[k - 1] ?? 0) + step);
    hi[k] = Math.max(hi[k] ?? 0, (hi[k - 1] ?? 0) - step);
  }
  for (let k = n - 2; k >= 0; k--) {
    lo[k] = Math.min(lo[k] ?? 0, (lo[k + 1] ?? 0) + step);
    hi[k] = Math.max(hi[k] ?? 0, (hi[k + 1] ?? 0) - step);
  }
  for (let k = 0; k < n; k++) h[k] = 0.5 * ((lo[k] ?? 0) + (hi[k] ?? 0));
  if (!pinned) return;
  // Raise the pinned stretch (a bridge's deck) where the mean sank under it, then the upper
  // envelope again: raising only, so the grade still holds.
  for (let k = 0; k < n; k++) if (pinned[k] === 1) h[k] = Math.max(h[k] ?? 0, hi[k] ?? 0);
  for (let k = 1; k < n; k++) h[k] = Math.max(h[k] ?? 0, (h[k - 1] ?? 0) - step);
  for (let k = n - 2; k >= 0; k--) h[k] = Math.max(h[k] ?? 0, (h[k + 1] ?? 0) - step);
}

interface PlannedRoute {
  a: number;
  b: number;
  kind: "road" | "track";
  /** Crosses the river: routed over the bridge. */
  crossing: boolean;
}

interface Point {
  x: number;
  z: number;
}

/**
 * The river's course whatever its size: the drainage's main path smoothed, before the meanders
 * (which sway with the width) and the carving; and per point how far the largest river (size 1)
 * reaches from it, its floodplain and its meanders' widest sway. The settlements and the way out
 * are placed against it, so a change of the river's size moves none of them.
 */
interface Course {
  x: Float32Array;
  z: Float32Array;
  widest: Float32Array;
}

/** The fine grid as the river and streams left it, which a later build keeping them starts from. */
interface Carved {
  ground: Float32Array;
  level: Float32Array;
  riverDist: Float32Array;
  riverAlong: Float32Array;
  banked: Uint8Array;
  riverbed: Uint8Array;
  stream: Float32Array;
  bank: Int32Array;
  channel: Uint8Array;
  river: TerrainRiver;
  course: Course;
  width: (along: number) => number;
  reach: (along: number) => number;
}

/**
 * A terrain built in units (see the header): call unit(0) .. unit(units - 1) in order, a few a
 * frame (runBudgeted), then read `terrain`. A builder given an earlier one with the same seed, size,
 * extent, relief, erosion and vantage reuses its eroded relief and skips those units; with the same
 * river size too, it reuses the carved river and streams, and only lays out the settlements, roads
 * and parcels again.
 */
export class TerrainBuilder {
  readonly units: number;
  readonly options: Readonly<Required<TerrainOptions>>;
  readonly #n: number;
  readonly #m: number;
  readonly #cellC: number;
  readonly #cellF: number;
  readonly #random = new Random();
  readonly #timings: Record<string, number> = {};
  readonly #stages: readonly (readonly [name: string, run: () => void])[];
  #next = 0;
  // Erosion grid.
  readonly #hf: HeightField;
  readonly #outlet: Uint8Array;
  readonly #uplift: Float32Array;
  #source = 0;
  readonly #flow: Drainage;
  readonly #heap: LevelHeap;
  readonly #seen: Uint8Array;
  #reused = false;
  /** The river and streams are an earlier build's (#carved), restored at the detail stage. */
  #watered = false;
  #carved: Carved | undefined;
  // Fine grid.
  readonly #ground: Float32Array;
  readonly #detailed: Float32Array;
  readonly #level: Float32Array;
  readonly #riverDist: Float32Array;
  readonly #riverAlong: Float32Array;
  /** 1 where the water level is the river's (its channel and banks): later stages leave these be. */
  readonly #banked: Uint8Array;
  readonly #riverbed: Uint8Array;
  readonly #stream: Float32Array;
  readonly #road: Float32Array;
  readonly #roadAngle: Float32Array;
  readonly #wood: Float32Array;
  /** Woodland suitability on the bare land (no road cut, no yard). */
  readonly #bareWood: Float32Array;
  readonly #yard: Float32Array;
  readonly #ids: Uint16Array;
  /** Per texel its nearest site by the bare metric (TerrainBare.ids). */
  readonly #bareIds: Uint16Array;
  // Layout.
  #river: TerrainRiver | undefined;
  #course: Course | undefined;
  #riverWidth: (along: number) => number = () => 0;
  #riverReach: (along: number) => number = () => 0;
  #bank: Int32Array;
  #channel: Uint8Array;
  readonly #places: TerrainSettlement[] = [];
  /** Every site chosen, built or not, at its nominal radius (Terrain.candidates). */
  readonly #candidates: TerrainSite[] = [];
  readonly #routes: PlannedRoute[] = [];
  readonly #roads: TerrainRoad[] = [];
  #bridge: TerrainBridge | undefined;
  readonly #buildings: TerrainBuilding[] = [];
  #parcels: TerrainParcels | undefined;
  #costs: Float32Array | undefined;
  #used: Uint8Array | undefined;
  #coarseGround: Float32Array | undefined;
  #terrain: Terrain | undefined;

  constructor(options: TerrainOptions, reuse?: TerrainBuilder) {
    const size = options.size ?? 512;
    if (!(Number.isInteger(Math.log2(size)) && size >= 128 && size <= 1024))
      throw new TerrainError(`terrain: size must be a power of two in 128..1024, got ${size}`);
    const extent = options.extent ?? 3200;
    if (!(extent > 0)) throw new TerrainError(`terrain: extent must be positive, got ${extent}`);
    this.options = {
      seed: options.seed,
      size,
      extent,
      relief: clamp(options.relief ?? 0.5, 0, 1),
      erosion: clamp(options.erosion ?? 0.5, 0, 1),
      river: clamp(options.river ?? 0.5, 0, 1),
      village: clamp(Math.round(options.village ?? 11), 0, TERRAIN_MAX_COTTAGES),
      hamlets: clamp(Math.round(options.hamlets ?? 2), 0, TERRAIN_MAX_HAMLETS),
      farms: clamp(Math.round(options.farms ?? 3), 0, TERRAIN_MAX_FARMS),
      castle: options.castle ?? true,
      roads: options.roads ?? true,
      tracks: options.tracks ?? true,
      base: options.base ?? "valley",
      vantage: options.vantage ?? {
        x: 0.06 * extent,
        z: 0.06 * extent,
        dx: Math.SQRT1_2,
        dz: Math.SQRT1_2,
        eye: 30,
      },
    };
    const n = size / 2;
    this.#n = n;
    this.#m = size;
    this.#cellC = extent / n;
    this.#cellF = extent / size;
    this.#hf = new HeightField(n, n, 1);
    this.#outlet = new Uint8Array(n * n);
    this.#uplift = new Float32Array(n * n);
    this.#flow = {
      rec: new Int32Array(n * n),
      order: new Int32Array(n * n),
      area: new Float32Array(n * n),
    };
    this.#heap = new LevelHeap(n * n);
    this.#seen = new Uint8Array(n * n);
    this.#bank = new Int32Array(n * n);
    this.#channel = new Uint8Array(n * n);
    const cells = size * size;
    this.#ground = new Float32Array(cells);
    this.#detailed = new Float32Array(cells);
    this.#level = new Float32Array(cells);
    this.#riverDist = new Float32Array(cells);
    this.#riverAlong = new Float32Array(cells);
    this.#banked = new Uint8Array(cells);
    this.#riverbed = new Uint8Array(cells);
    this.#stream = new Float32Array(cells);
    this.#road = new Float32Array(cells);
    this.#roadAngle = new Float32Array(cells);
    this.#wood = new Float32Array(cells);
    this.#bareWood = new Float32Array(cells);
    this.#yard = new Float32Array(cells);
    this.#ids = new Uint16Array(cells * 2);
    this.#bareIds = new Uint16Array(cells);
    if (
      reuse &&
      reuse.#reliefKey() === this.#reliefKey() &&
      reuse.#next > TERRAIN_EROSION_STEPS + 2
    ) {
      this.#hf.data.set(reuse.#hf.data);
      this.#outlet.set(reuse.#outlet);
      this.#source = reuse.#source;
      this.#flow.rec.set(reuse.#flow.rec);
      this.#flow.order.set(reuse.#flow.order);
      this.#flow.area.set(reuse.#flow.area);
      this.#detailed.set(reuse.#detailed);
      this.#reused = true;
      const carved = reuse.#carved;
      if (carved && reuse.#riverKey() === this.#riverKey()) {
        this.#carved = carved;
        this.#watered = true;
      }
    }
    const stages: (readonly [string, () => void])[] = [["relief", () => this.#relief()]];
    for (let s = 0; s < TERRAIN_EROSION_STEPS; s++) stages.push(["erosion", () => this.#erode()]);
    stages.push(["flow", () => this.#drainage()]);
    stages.push(["detail", () => this.#detail()]);
    stages.push(["river", () => this.#carveRiver()]);
    stages.push(["streams", () => this.#streams()]);
    stages.push(["settlements", () => this.#settle()]);
    stages.push(["network", () => this.#network()]);
    for (let r = 0; r < MAX_ROUTES; r++) stages.push(["roads", () => this.#route(r)]);
    stages.push(["roadbeds", () => this.#roadbeds()]);
    stages.push(["buildings", () => this.#build()]);
    stages.push(["woods", () => this.#woods()]);
    stages.push(["parcels", () => this.#parcelSites()]);
    stages.push(["parcels", () => this.#parcelIds(0, size >> 1)]);
    stages.push(["parcels", () => this.#parcelIds(size >> 1, size)]);
    stages.push(["trees", () => this.#trees()]);
    stages.push(["cores", () => this.#cores()]);
    stages.push(["finish", () => this.#finish()]);
    this.#stages = stages;
    this.units = stages.length;
  }

  /** Whether every unit has run. */
  get done(): boolean {
    return this.#next >= this.units;
  }

  /** The finished terrain; throws until every unit has run. */
  get terrain(): Terrain {
    if (!this.#terrain) throw new TerrainError("terrain: not built yet");
    return this.#terrain;
  }

  /**
   * Run unit i (they must run in order, each once; a unit run again or out of order throws).
   * Returns true once the last has run, so runBudgeted stops there.
   */
  unit(i: number): boolean {
    if (i !== this.#next)
      throw new TerrainError(`terrain: unit ${i} out of order (next ${this.#next})`);
    const stage = this.#stages[i];
    if (!stage) throw new TerrainError(`terrain: no unit ${i}`);
    const started = performance.now();
    stage[1]();
    this.#timings[stage[0]] = (this.#timings[stage[0]] ?? 0) + performance.now() - started;
    this.#next++;
    return this.done;
  }

  #reliefKey(): string {
    const o = this.options;
    const v = o.vantage;
    return [o.seed, o.size, o.extent, o.relief, o.erosion, o.base, v.x, v.z, v.dx, v.dz].join(",");
  }

  #riverKey(): string {
    return `${this.#reliefKey()},${this.options.river}`;
  }

  #mix(salt: number): number {
    return Math.imul(this.options.seed + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  }

  // ---- relief and erosion (erosion grid, heights in extents) -------------------------------------

  /** The valley's axis in map metres: control points in view space, then Catmull-Rom through them. */
  #axis(): Polyline {
    const o = this.options;
    const v = o.vantage;
    const r = this.#random;
    r.seed(this.#mix(1));
    const side = r.next() < 0.5 ? 1 : -1;
    const W = o.extent;
    // View space: u ahead of the vantage, a to its right, both in extents. The river comes out of
    // the far hills on one side, crosses the middle distance and passes close on the other.
    const view: [number, number][] = [
      [1.25 + 0.12 * r.next(), -side * (0.45 + 0.2 * r.next())],
      [0.78 + 0.1 * r.next(), -side * (0.18 + 0.1 * r.next())],
      [0.4 + 0.08 * r.next(), side * 0.08 * r.next()],
      [0.17 + 0.04 * r.next(), side * (0.1 + 0.06 * r.next())],
      [0.06 + 0.04 * r.next(), side * (0.6 + 0.1 * r.next())],
    ];
    const px = view.map(([u, a]) => v.x + (u * v.dx + a * v.dz) * W);
    const pz = view.map(([u, a]) => v.z + (u * v.dz - a * v.dx) * W);
    const x: number[] = [];
    const z: number[] = [];
    const at = (list: number[], k: number) => list[clamp(k, 0, list.length - 1)] ?? 0;
    for (let k = 0; k + 1 < px.length; k++) {
      for (let s = 0; s < 24; s++) {
        const t = s / 24;
        const t2 = t * t;
        const t3 = t2 * t;
        const w0 = -0.5 * t3 + t2 - 0.5 * t;
        const w1 = 1.5 * t3 - 2.5 * t2 + 1;
        const w2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
        const w3 = 0.5 * t3 - 0.5 * t2;
        x.push(w0 * at(px, k - 1) + w1 * at(px, k) + w2 * at(px, k + 1) + w3 * at(px, k + 2));
        z.push(w0 * at(pz, k - 1) + w1 * at(pz, k) + w2 * at(pz, k + 1) + w3 * at(pz, k + 2));
      }
    }
    x.push(px[px.length - 1] ?? 0);
    z.push(pz[pz.length - 1] ?? 0);
    return { x, z };
  }

  #relief(): void {
    if (this.#reused) return;
    const o = this.options;
    const n = this.#n;
    const W = o.extent;
    const v = o.vantage;
    const seed = o.seed;
    const relief = o.relief;
    const axis = this.#axis();
    const count = axis.x.length;
    // Along-axis distance, normalised 0 (source) .. 1 (mouth).
    const along: number[] = [0];
    for (let k = 1; k < count; k++) {
      const d = hypot2(
        (axis.x[k] ?? 0) - (axis.x[k - 1] ?? 0),
        (axis.z[k] ?? 0) - (axis.z[k - 1] ?? 0),
      );
      along.push((along[k - 1] ?? 0) + d);
    }
    const total = along[count - 1] ?? 1;
    const h = this.#hf.data;
    const cell = this.#cellC;
    // Where the axis first comes onto the map: the source cell.
    let source = -1;
    for (let k = 0; k < count && source < 0; k++) {
      const ax = axis.x[k] ?? 0;
      const az = axis.z[k] ?? 0;
      if (ax >= 0 && az >= 0 && ax < W && az < W) {
        const i = clamp(Math.floor(ax / cell), 0, n - 1);
        const j = clamp(Math.floor(az / cell), 0, n - 1);
        // Out to the nearest edge from there.
        const toEdge = Math.min(i, j, n - 1 - i, n - 1 - j);
        const ei = i === toEdge ? 0 : n - 1 - i === toEdge ? n - 1 : i;
        const ej = ei === i ? (j === toEdge ? 0 : n - 1 - j === toEdge ? n - 1 : j) : j;
        source = ej * n + ei;
      }
    }
    if (source < 0) throw new TerrainError("terrain: the valley's axis never crosses the map");
    this.#source = source;
    // Nearest point of the axis to (x, z): squared distance, along 0..1, and which side (±1).
    const nearest = (x: number, z: number, out: Float64Array): void => {
      let best = Infinity;
      for (let k = 0; k + 1 < count; k++) {
        const ax = axis.x[k] ?? 0;
        const az = axis.z[k] ?? 0;
        const ex = (axis.x[k + 1] ?? 0) - ax;
        const ez = (axis.z[k + 1] ?? 0) - az;
        const len2 = ex * ex + ez * ez;
        const s = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
        const qx = x - ax - ex * s;
        const qz = z - az - ez * s;
        const d2 = qx * qx + qz * qz;
        if (d2 < best) {
          best = d2;
          out[0] = d2;
          out[1] = lerp(along[k] ?? 0, along[k + 1] ?? 0, s) / total;
          out[2] = ex * qz - ez * qx >= 0 ? 1 : -1;
        }
      }
    };
    const found = new Float64Array(3);
    nearest(v.x, v.z, found);
    const vantageSide = found[2] ?? 1;
    const vantageAway = Math.sqrt(found[0] ?? 0) / W;
    for (let j = 0; j < n; j++) {
      const z = (j + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * cell;
        nearest(x, z, found);
        const d = Math.sqrt(found[0] ?? 0) / W;
        const t = found[1] ?? 0;
        const X = x / W;
        const Z = z / W;
        const u = ((x - v.x) * v.dx + (z - v.z) * v.dz) / W;
        const vd = hypot2(x - v.x, z - v.z) / W;
        const floor = 6 + 46 * (1 - t);
        // Hills close the view: rising far ahead, and toward the edges the vantage looks out over.
        const edges = Math.max(
          smoothstep(0.3, 0.7, v.dx) * smoothstep(0.72, 1, X),
          smoothstep(0.3, 0.7, -v.dx) * smoothstep(0.72, 1, 1 - X),
          smoothstep(0.3, 0.7, v.dz) * smoothstep(0.72, 1, Z),
          smoothstep(0.3, 0.7, -v.dz) * smoothstep(0.72, 1, 1 - Z),
        );
        const far = (90 + 90 * relief) * Math.max(smoothstep(0.8, 1.3, u), edges);
        const hill = 25 * Math.exp(-((vd / 0.07) ** 2));
        const near = (found[2] ?? 1) === vantageSide;
        let shape: number;
        let rough: number;
        if (o.base === "hills") {
          // Rolling hills everywhere, the river winding between them in a shallow vale.
          shape = floor + (35 + 55 * relief) * smoothstep(0, 0.1, d) + 0.4 * far + hill;
          rough = 8 + (45 + 95 * relief) * smoothstep(0.01, 0.07, d);
        } else if (o.base === "plateau") {
          // A table of high ground with a steep rim over the gorge, the far side a step higher.
          const rim = smoothstep(0.03, 0.085, d);
          shape = floor + (100 + 90 * relief) * rim + (near ? 0 : 30 * rim) + 0.35 * far + hill;
          rough = 4 + (10 + 30 * relief) * rim;
        } else {
          // The vantage's side falls in long rolling slopes to the river, so the eye sees down to
          // it; the far side climbs into hills.
          shape =
            floor +
            (near
              ? (90 + 70 * relief) * clamp(d / vantageAway, 0, 1) ** 1.6
              : (70 + 130 * relief) * (1 - Math.exp(-((d / 0.2) ** 2))) + 60 * d) +
            hill +
            far;
          rough = near
            ? 6 + (22 + 50 * relief) * smoothstep(0.02, 0.16, d)
            : 10 + (50 + 120 * relief) * smoothstep(0.03, 0.22, d);
          // A coast: downstream the valley floor sinks under the sea into a broad bay.
          if (o.base === "coast") {
            const bay = smoothstep(0.55, 0.92, t) * (1 - smoothstep(0.12, 0.42, d));
            shape -= (floor + 45) * bay;
            rough *= 1 - 0.7 * bay;
          }
        }
        const body = 2 * fbm(X * 4.5, Z * 4.5, seed, 5) - 1;
        const crest = 1 - Math.abs(2 * valueNoise(X * 3.1 + 7.7, Z * 3.1 + 1.3, seed + 31) - 1);
        const noise = 0.75 * body + 0.5 * (crest - 0.5);
        const at = j * n + i;
        h[at] = (shape + rough * noise) / W;
        this.#uplift[at] = smoothstep(0.04, 0.3, d) * (0.4 + 0.6 * relief);
        const edge = i === 0 || j === 0 || i === n - 1 || j === n - 1;
        this.#outlet[at] = edge ? 1 : 0;
      }
    }
    // The river comes in over the source's stretch of edge: none of it drains off the map.
    const si = source % n;
    const sj = (source - si) / n;
    for (let k = -6; k <= 6; k++) {
      if (si === 0 || si === n - 1) {
        const j = sj + k;
        if (j >= 0 && j < n) this.#outlet[j * n + si] = 0;
      } else {
        const i = si + k;
        if (i >= 0 && i < n) this.#outlet[sj * n + i] = 0;
      }
    }
    this.#hf.touch();
  }

  #erode(): void {
    if (this.#reused) return;
    const erosion = this.options.erosion;
    if (erosion <= 0) return;
    const n = this.#n;
    const h = this.#hf.data;
    const cell = 1 / n;
    drain(
      h,
      n,
      this.#outlet,
      1e-7,
      cell * cell,
      this.#source,
      RIVER_INFLOW,
      this.#flow,
      this.#heap,
      this.#seen,
    );
    const kdt = (0.002 + 0.022 * erosion) * erosion;
    const uplift = 0.0003 * erosion;
    const { rec, order, area } = this.#flow;
    for (let q = 0; q < n * n; q++) {
      const i = order[q] ?? 0;
      const r = rec[i] ?? i;
      if (r === i) continue;
      const di = Math.abs((i % n) - (r % n)) + Math.abs(Math.floor(i / n) - Math.floor(r / n));
      const dist = (di > 1 ? SQRT2 : 1) * cell;
      const f = (kdt * Math.sqrt(area[i] ?? 0)) / dist;
      h[i] = ((h[i] ?? 0) + uplift * (this.#uplift[i] ?? 0) + f * (h[r] ?? 0)) / (1 + f);
    }
    this.#hf.touch();
    // Slopes steeper than ~35° slump.
    this.#hf.relax(0.7, 30, 0.05 + 0.1 * erosion);
  }

  #drainage(): void {
    if (this.#reused) return;
    const n = this.#n;
    const cell = 1 / n;
    drain(
      this.#hf.data,
      n,
      this.#outlet,
      1e-7,
      cell * cell,
      this.#source,
      RIVER_INFLOW,
      this.#flow,
      this.#heap,
      this.#seen,
    );
  }

  /**
   * The erosion grid upsampled to the fine grid (metres), with relief finer than its cells; or,
   * when an earlier build's river and streams are kept, the fine grid as they left it.
   */
  #detail(): void {
    const carved = this.#carved;
    if (this.#watered && carved) {
      this.#ground.set(carved.ground);
      this.#level.set(carved.level);
      this.#riverDist.set(carved.riverDist);
      this.#riverAlong.set(carved.riverAlong);
      this.#banked.set(carved.banked);
      this.#riverbed.set(carved.riverbed);
      this.#stream.set(carved.stream);
      this.#bank.set(carved.bank);
      this.#channel.set(carved.channel);
      this.#river = carved.river;
      this.#course = carved.course;
      this.#riverWidth = carved.width;
      this.#riverReach = carved.reach;
      return;
    }
    if (!this.#reused) {
      const n = this.#n;
      const m = this.#m;
      const W = this.options.extent;
      const coarse = this.#hf.data;
      const seed = this.options.seed;
      const fine = this.#detailed;
      for (let j = 0; j < m; j++) {
        const cz = (j + 0.5) / 2 - 0.5;
        for (let i = 0; i < m; i++) {
          const cx = (i + 0.5) / 2 - 0.5;
          const base = sampleCubic(coarse, n, cx, cz) * W;
          const X = (i + 0.5) / m;
          const Z = (j + 0.5) / m;
          const gx =
            (coarse[clamp(Math.round(cz), 0, n - 1) * n + clamp(Math.round(cx) + 1, 0, n - 1)] ??
              0) -
            (coarse[clamp(Math.round(cz), 0, n - 1) * n + clamp(Math.round(cx) - 1, 0, n - 1)] ??
              0);
          const slope = (Math.abs(gx) * W) / (2 * this.#cellC);
          const rough = 0.6 + 2.2 * smoothstep(0.03, 0.3, slope) * (0.5 + this.options.relief);
          fine[j * m + i] = base + rough * (2 * fbm(X * 70, Z * 70, seed + 5, 3) - 1);
        }
      }
    }
    this.#ground.set(this.#detailed);
  }

  // ---- the river ------------------------------------------------------------------------------

  #carveRiver(): void {
    if (this.#watered) return;
    const o = this.options;
    const n = this.#n;
    const m = this.#m;
    const W = o.extent;
    const cellC = this.#cellC;
    const cellF = this.#cellF;
    const { rec, area } = this.#flow;
    // The mouth: the outlet draining most.
    let mouth = 0;
    let most = -1;
    for (let i = 0; i < n * n; i++) {
      if (this.#outlet[i] === 1 && (area[i] ?? 0) > most) {
        most = area[i] ?? 0;
        mouth = i;
      }
    }
    // Donors by receiver (counting sort), to walk up the trunk.
    const start = new Int32Array(n * n + 1);
    for (let i = 0; i < n * n; i++) {
      const r = rec[i] ?? i;
      if (r !== i) start[r + 1] = (start[r + 1] ?? 0) + 1;
    }
    for (let i = 0; i < n * n; i++) start[i + 1] = (start[i + 1] ?? 0) + (start[i] ?? 0);
    const fill = start.slice(0, n * n);
    const donors = new Int32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const r = rec[i] ?? i;
      if (r === i) continue;
      const slot = fill[r] ?? 0;
      donors[slot] = i;
      fill[r] = slot + 1;
    }
    const trunk: number[] = [mouth];
    const least = most * 0.04;
    for (let c = mouth; ;) {
      let best = -1;
      let bestArea = least;
      for (let q = start[c] ?? 0; q < (start[c + 1] ?? 0); q++) {
        const d = donors[q] ?? 0;
        if ((area[d] ?? 0) > bestArea) {
          bestArea = area[d] ?? 0;
          best = d;
        }
      }
      if (best < 0) break;
      trunk.push(best);
      c = best;
    }
    trunk.reverse();
    // Centreline in metres, from the edge at the source to past the edge at the mouth.
    const raw: Polyline = { x: [], z: [] };
    const rawArea: number[] = [];
    for (const c of trunk) {
      const i = c % n;
      const j = (c - i) / n;
      raw.x.push((i + 0.5) * cellC);
      raw.z.push((j + 0.5) * cellC);
      rawArea.push(area[c] ?? 0);
    }
    const pushEdge = (atStart: boolean): void => {
      const k = atStart ? 0 : raw.x.length - 1;
      const x = raw.x[k] ?? 0;
      const z = raw.z[k] ?? 0;
      const gaps = [x, W - x, z, W - z];
      const nearest = gaps.indexOf(Math.min(...gaps));
      const out = 1.5 * cellC;
      const ex = nearest === 0 ? -out : nearest === 1 ? W + out : x;
      const ez = nearest === 2 ? -out : nearest === 3 ? W + out : z;
      if (atStart) {
        raw.x.unshift(ex);
        raw.z.unshift(ez);
        rawArea.unshift(rawArea[0] ?? 0);
      } else {
        raw.x.push(ex);
        raw.z.push(ez);
        rawArea.push(rawArea[rawArea.length - 1] ?? 0);
      }
    };
    pushEdge(true);
    pushEdge(false);
    const rawAlong: number[] = [0];
    for (let k = 1; k < raw.x.length; k++) {
      rawAlong.push(
        (rawAlong[k - 1] ?? 0) +
          hypot2((raw.x[k] ?? 0) - (raw.x[k - 1] ?? 0), (raw.z[k] ?? 0) - (raw.z[k - 1] ?? 0)),
      );
    }
    const rawTotal = rawAlong[rawAlong.length - 1] ?? 1;
    const areaAt = (fraction: number): number => {
      const s = fraction * rawTotal;
      let k = 0;
      while (k + 1 < rawAlong.length && (rawAlong[k + 1] ?? 0) < s) k++;
      return rawArea[k] ?? 0;
    };
    const smooth = resample(chaikin(simplify(raw, 0.7 * cellC), 4), cellF);
    // Width from the catchment (its share of the mouth's) for a river of size `size`; the banks
    // either side of it, and the floodplain flattened beyond them.
    const mouthArea = rawArea[rawArea.length - 1] ?? 1;
    const shareAt = (fraction: number): number => clamp(areaAt(fraction) / mouthArea, 0, 1);
    const widthOf = (share: number, size: number): number =>
      lerp(3 + 6 * size, 7 + 42 * size, Math.sqrt(share));
    const bankOf = (w: number) => 2 + 0.25 * w;
    const floodplain = (w: number, share: number): number =>
      0.5 * w + bankOf(w) + (1.5 + 2.5 * Math.sqrt(share)) * w;
    const r = o.river;
    // Meanders: a sway across the line of up to `swing` widths, its wavelength ~11 widths, on
    // gentle ground only.
    const swing = 1.1;
    const count0 = smooth.x.length;
    // The course whatever the size (Course): how far the largest river reaches from each point.
    const widest = new Float32Array(count0);
    for (let k = 0; k < count0; k++) {
      const share = shareAt(k / Math.max(1, count0 - 1));
      const w = widthOf(share, 1);
      widest[k] = floodplain(w, share) + swing * w;
    }
    this.#course = { x: Float32Array.from(smooth.x), z: Float32Array.from(smooth.z), widest };
    const meandered: Polyline = { x: [], z: [] };
    this.#random.seed(this.#mix(2));
    let phase = this.#random.range(0, Math.PI * 2);
    for (let k = 0; k < count0; k++) {
      const f = k / Math.max(1, count0 - 1);
      const w = widthOf(shareAt(f), r);
      const kp = Math.max(0, k - 4);
      const kn = Math.min(count0 - 1, k + 4);
      const tx = (smooth.x[kn] ?? 0) - (smooth.x[kp] ?? 0);
      const tz = (smooth.z[kn] ?? 0) - (smooth.z[kp] ?? 0);
      const tl = hypot2(tx, tz) || 1;
      const hp = sampleGrid(this.#ground, m, W, smooth.x[kp] ?? 0, smooth.z[kp] ?? 0);
      const hn = sampleGrid(this.#ground, m, W, smooth.x[kn] ?? 0, smooth.z[kn] ?? 0);
      const grade = Math.abs(hp - hn) / tl;
      const gentle = 1 - smoothstep(0.004, 0.03, grade);
      const taper = smoothstep(0, 0.06, f) * smoothstep(0, 0.06, 1 - f);
      phase += (2 * Math.PI * cellF) / (11 * w);
      const sway = swing * w * gentle * taper * Math.sin(phase);
      meandered.x.push((smooth.x[k] ?? 0) - (tz / tl) * sway);
      meandered.z.push((smooth.z[k] ?? 0) + (tx / tl) * sway);
    }
    const line = resample(chaikin(meandered, 1), cellF);
    const count = line.x.length;
    const x = Float32Array.from(line.x);
    const z = Float32Array.from(line.z);
    const along = new Float32Array(count);
    for (let k = 1; k < count; k++)
      along[k] =
        (along[k - 1] ?? 0) + hypot2((x[k] ?? 0) - (x[k - 1] ?? 0), (z[k] ?? 0) - (z[k - 1] ?? 0));
    const width = new Float32Array(count);
    for (let k = 0; k < count; k++) width[k] = widthOf(shareAt(k / Math.max(1, count - 1)), r);
    // Level: the ground's running minimum from the source, smoothed (a mean of shifted copies of a
    // sequence that never rises never rises either), less a freeboard.
    const run = new Float64Array(count);
    let low = Infinity;
    for (let k = 0; k < count; k++) {
      const g = sampleGrid(this.#ground, m, W, x[k] ?? 0, z[k] ?? 0);
      low = Math.min(low, g);
      run[k] = low;
    }
    const level = new Float32Array(count);
    const span = 6;
    for (let k = 0; k < count; k++) {
      let sum = 0;
      for (let q = -span; q <= span; q++) sum += run[clamp(k + q, 0, count - 1)] ?? 0;
      // Never under the sea it runs into.
      level[k] = Math.max(sum / (2 * span + 1) - 0.7, o.base === "coast" ? 0 : -Infinity);
    }
    this.#river = { x, z, level, width, along };
    const at = (list: Float32Array, a: number): number => {
      const k = clamp(Math.floor(a), 0, count - 1);
      const k1 = Math.min(count - 1, k + 1);
      return lerp(list[k] ?? 0, list[k1] ?? 0, a - k);
    };
    const plainOf = (a: number): number =>
      floodplain(at(width, a), shareAt(clamp(a / Math.max(1, count - 1), 0, 1)));
    const blend = 70;
    this.#riverWidth = (a) => at(width, a);
    this.#riverReach = (a) => plainOf(a);
    // Nearest centreline point for every texel within the floodplain and its blend.
    this.#riverDist.fill(Infinity);
    this.#riverAlong.fill(-1);
    nearestOnLine(
      x,
      z,
      count,
      (k) => Math.max(plainOf(k), plainOf(k + 1)) + blend,
      0,
      m,
      cellF,
      this.#riverDist,
      this.#riverAlong,
    );
    const g = this.#ground;
    const lv = this.#level;
    for (let q = 0; q < m * m; q++) {
      const orig = g[q] ?? 0;
      lv[q] = orig - 4;
      this.#banked[q] = 0;
      this.#riverbed[q] = 0;
      const d = this.#riverDist[q] ?? Infinity;
      if (!Number.isFinite(d)) continue;
      const a = this.#riverAlong[q] ?? 0;
      const L = at(level, a);
      const w = at(width, a);
      const half = 0.5 * w;
      const bank = bankOf(w);
      const bankH = 0.8 + 0.03 * w;
      const plain = plainOf(a);
      const depth = 0.8 + 0.08 * w;
      let carved: number;
      if (d <= half) carved = L - 0.15 - depth * (1 - (d / half) ** 2);
      else if (d <= half + bank)
        carved = L - 0.15 + (bankH + 0.15) * smoothstep(0, 1, (d - half) / bank);
      else carved = L + bankH + 0.012 * (d - half - bank);
      if (d > plain) carved = lerp(carved, orig, smoothstep(plain, plain + blend, d));
      g[q] = carved;
      if (d <= half + bank + 1.5 * cellF) {
        lv[q] = L;
        this.#banked[q] = 1;
        this.#riverbed[q] = 1;
      } else lv[q] = Math.min(carved, L) - 4;
    }
    // The sea (a coast): every texel below its level connected to the map's edge, by a flood from
    // the edge (shallow.ts's stillWater); pits it fills above sea level stay land.
    if (o.base === "coast") {
      const edge = new Uint8Array(m * m);
      for (let q = 0; q < m * m; q++) {
        const i = q % m;
        const j = (q - i) / m;
        if ((i === 0 || j === 0 || i === m - 1 || j === m - 1) && (g[q] ?? 0) < 0) edge[q] = 1;
      }
      const sea = stillWater(g, m, m, edge, 0);
      for (let q = 0; q < m * m; q++) {
        if ((sea[q] ?? 0) <= 1e-3 && (g[q] ?? 0) < -0.05) {
          lv[q] = Math.max(lv[q] ?? 0, 0);
          this.#banked[q] = 1;
          this.#riverbed[q] = 0;
        }
      }
    }
    // The channel on the erosion grid (for the banks' labels and the roads' costs).
    this.#channel.fill(0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let wet = 0;
        for (let b = 0; b < 2; b++)
          for (let c = 0; c < 2; c++) {
            const q = (2 * j + b) * m + 2 * i + c;
            if ((lv[q] ?? 0) > (g[q] ?? 0)) wet = 1;
          }
        this.#channel[j * n + i] = wet;
      }
    }
    // Bank labels: the land's connected pieces with the channel between them.
    this.#bank.fill(-1);
    let label = 0;
    const queue = new Int32Array(n * n);
    for (let s = 0; s < n * n; s++) {
      if (this.#channel[s] === 1 || (this.#bank[s] ?? 0) >= 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      this.#bank[s] = label;
      while (head < tail) {
        const c = queue[head++] ?? 0;
        const ci = c % n;
        const cj = (c - ci) / n;
        for (let d = 0; d < 4; d++) {
          const ni = ci + (DX8[d] ?? 0);
          const nj = cj + (DZ8[d] ?? 0);
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nq = nj * n + ni;
          if (this.#channel[nq] === 1 || (this.#bank[nq] ?? 0) >= 0) continue;
          this.#bank[nq] = label;
          queue[tail++] = nq;
        }
      }
      label++;
    }
  }

  // ---- streams --------------------------------------------------------------------------------

  #streams(): void {
    if (this.#watered) return;
    const n = this.#n;
    const m = this.#m;
    const W = this.options.extent;
    const cellC = this.#cellC;
    const cellF = this.#cellF;
    const { rec, area } = this.#flow;
    const threshold = (900 * (cellC * cellC)) / (W * W);
    const isStream = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      if ((area[i] ?? 0) >= threshold && this.#channel[i] === 0) isStream[i] = 1;
    }
    // Heads: stream cells no stream cell drains into.
    const fed = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
      if (isStream[i] === 1) {
        const r = rec[i] ?? i;
        if (r !== i) fed[r] = 1;
      }
    }
    const taken = new Uint8Array(n * n);
    this.#stream.fill(FAR);
    for (let s = 0; s < n * n; s++) {
      if (isStream[s] === 0 || fed[s] === 1) continue;
      const line: Polyline = { x: [], z: [] };
      let c = s;
      let a = 0;
      for (;;) {
        const i = c % n;
        const j = (c - i) / n;
        line.x.push((i + 0.5) * cellC);
        line.z.push((j + 0.5) * cellC);
        a = Math.max(a, area[c] ?? 0);
        const r = rec[c] ?? c;
        if (taken[c] === 1 || r === c || this.#channel[r] === 1) {
          if (this.#channel[r] === 1) {
            const ri = r % n;
            line.x.push((ri + 0.5) * cellC);
            line.z.push(((r - ri) / n + 0.5) * cellC);
          }
          break;
        }
        taken[c] = 1;
        c = r;
      }
      if (line.x.length < 4) continue;
      const smooth = resample(chaikin(line, 3), 2 * cellF);
      const half = 0.6 + 1.4 * Math.min(1, Math.sqrt(a / threshold) / 4);
      nearestOnLine(
        smooth.x,
        smooth.z,
        smooth.x.length,
        () => half + 12,
        half,
        m,
        cellF,
        this.#stream,
        undefined,
      );
    }
    // A slight notch along each stream.
    const g = this.#ground;
    for (let q = 0; q < m * m; q++) {
      const sd = this.#stream[q] ?? FAR;
      if (sd < 6 && this.#banked[q] === 0) {
        g[q] = (g[q] ?? 0) - 0.9 * (1 - smoothstep(-1, 6, sd));
        this.#level[q] = Math.min(this.#level[q] ?? 0, (g[q] ?? 0) - 4);
      }
    }
    // What a later build keeping this river starts from (#detail).
    const river = this.#river;
    const course = this.#course;
    if (!river || !course) throw new TerrainError("terrain: a stage was skipped");
    this.#carved = {
      ground: this.#ground.slice(),
      level: this.#level.slice(),
      riverDist: this.#riverDist.slice(),
      riverAlong: this.#riverAlong.slice(),
      banked: this.#banked.slice(),
      riverbed: this.#riverbed.slice(),
      stream: this.#stream.slice(),
      bank: this.#bank.slice(),
      channel: this.#channel.slice(),
      river,
      course,
      width: this.#riverWidth,
      reach: this.#riverReach,
    };
  }

  // ---- settlements ----------------------------------------------------------------------------

  #settle(): void {
    const o = this.options;
    const m = this.#m;
    const W = o.extent;
    const v = o.vantage;
    const cellF = this.#cellF;
    const course = this.#course;
    if (!course) throw new TerrainError("terrain: a stage was skipped");
    // Sites are weighed on the land as it lay before the river was carved, and against the river's
    // course whatever its size (Course): a change of the river's size moves none of them.
    const g = this.#detailed;
    const step = 4;
    const k = m / step;
    const span = step * cellF;
    // Local mean height over ~250 m (a summed-area table), for hilltops.
    const sat = new Float64Array((m + 1) * (m + 1));
    for (let j = 0; j < m; j++) {
      let row = 0;
      for (let i = 0; i < m; i++) {
        row += g[j * m + i] ?? 0;
        sat[(j + 1) * (m + 1) + i + 1] = (sat[j * (m + 1) + i + 1] ?? 0) + row;
      }
    }
    const mean = (i: number, j: number, r: number): number => {
      const i0 = clamp(i - r, 0, m);
      const i1 = clamp(i + r + 1, 0, m);
      const j0 = clamp(j - r, 0, m);
      const j1 = clamp(j + r + 1, 0, m);
      const s =
        (sat[j1 * (m + 1) + i1] ?? 0) -
        (sat[j0 * (m + 1) + i1] ?? 0) -
        (sat[j1 * (m + 1) + i0] ?? 0) +
        (sat[j0 * (m + 1) + i0] ?? 0);
      return s / Math.max(1, (i1 - i0) * (j1 - j0));
    };
    const reach = Math.round(250 / cellF);
    const near = Math.round(30 / cellF);
    // On a coarse grid of candidates (texel i · step + 2 either way): the water, the cells the
    // course runs through and (a coast) where the land lies under the sea, for the distance to it;
    // and which the largest river's floodplain and meanders reach, 12 m beyond them.
    const wet = new Uint8Array(k * k);
    const plain = new Uint8Array(k * k);
    for (let c = 0; c < course.x.length; c++) {
      const cx = course.x[c] ?? 0;
      const cz = course.z[c] ?? 0;
      wet[clamp(Math.floor(cz / span), 0, k - 1) * k + clamp(Math.floor(cx / span), 0, k - 1)] = 1;
      const r = (course.widest[c] ?? 0) + 12;
      const i1 = Math.min(k - 1, Math.ceil((cx + r) / span));
      const j1 = Math.min(k - 1, Math.ceil((cz + r) / span));
      for (let j = Math.max(0, Math.floor((cz - r) / span)); j <= j1; j++) {
        const dz = (j * step + 2.5) * cellF - cz;
        for (let i = Math.max(0, Math.floor((cx - r) / span)); i <= i1; i++) {
          const dx = (i * step + 2.5) * cellF - cx;
          if (dx * dx + dz * dz < r * r) plain[j * k + i] = 1;
        }
      }
    }
    if (o.base === "coast")
      for (let j = 0; j < k; j++)
        for (let i = 0; i < k; i++)
          if ((g[(j * step + 2) * m + i * step + 2] ?? 0) < 0) wet[j * k + i] = 1;
    const toWater = distanceField(wet, k);
    const eye = { x: v.x, y: sampleGrid(g, m, W, v.x, v.z) + v.eye, z: v.z };
    const march: HeightMarch = {
      top: eye.y + 400,
      far: 2 * W,
      slope: 1,
      minStep: 3,
      relStep: 0.004,
      steps: 400,
      refine: 6,
    };
    const surface = (x: number, z: number): number => sampleGrid(g, m, W, x, z);
    const hit: RayHit = { t: 0, x: 0, y: 0, z: 0 };
    const seen = (x: number, z: number, y: number): boolean => {
      const dx = x - eye.x;
      const dy = y - eye.y;
      const dz = z - eye.z;
      const len = hypot3(dx, dy, dz);
      if (!marchHeight(surface, eye.x, eye.y, eye.z, dx / len, dy / len, dz / len, march, hit))
        return true;
      return hit.t > len - 25;
    };
    interface Candidate {
      /** Its texel. */
      at: number;
      x: number;
      z: number;
      y: number;
      flat: number;
      water: number;
      dist: number;
      angle: number;
      prominence: number;
      bank: number;
    }
    const candidates: Candidate[] = [];
    const n = this.#n;
    for (let j = 2; j < k - 2; j++) {
      for (let i = 2; i < k - 2; i++) {
        const fi = i * step + 2;
        const fj = j * step + 2;
        const q = fj * m + fi;
        if (plain[j * k + i] === 1 || (o.base === "coast" && (g[q] ?? 0) < 0.5)) continue;
        if ((this.#stream[q] ?? FAR) < 6) continue;
        const x = (fi + 0.5) * cellF;
        const z = (fj + 0.5) * cellF;
        const gx = ((g[q + near] ?? 0) - (g[q - near] ?? 0)) / (2 * near * cellF);
        const gz = ((g[q + near * m] ?? 0) - (g[q - near * m] ?? 0)) / (2 * near * cellF);
        const slope = hypot2(gx, gz);
        const ax = x - v.x;
        const az = z - v.z;
        const depth = ax * v.dx + az * v.dz;
        const across = ax * v.dz - az * v.dx;
        const y = g[q] ?? 0;
        candidates.push({
          at: q,
          x,
          z,
          y,
          flat: 1 - smoothstep(0.02, 0.12, slope),
          water: (toWater[j * k + i] ?? Infinity) * step * cellF,
          dist: hypot2(ax, az),
          angle: Math.atan2(Math.abs(across), depth),
          prominence: y - mean(fi, fj, reach),
          bank: this.#bank[Math.floor(fj / 2) * n + Math.floor(fi / 2)] ?? -1,
        });
      }
    }
    // Every site is chosen, in a fixed order, whether or not its settlement is built: one switched
    // on, off or added never moves another.
    const sites: TerrainSettlement[] = [];
    const deg = Math.PI / 180;
    const inView = (c: Candidate, wide: number) => 1 - smoothstep(wide - 10 * deg, wide, c.angle);
    const apart = (c: Candidate, gap: number) =>
      sites.every((p) => hypot2(p.x - c.x, p.z - c.z) >= gap + p.radius);
    const choose = (
      kind: TerrainSettlementKind,
      radius: number,
      gap: number,
      score: (c: Candidate) => number,
      visible: boolean,
    ): void => {
      const scored = candidates.map((c) => ({ c, s: apart(c, gap) ? score(c) : 0 }));
      // Sites scoring next to nothing are passed over, and a castle, hamlet or farm with no other
      // goes without; the village, the heart of every landscape, then takes those that score at
      // all (off the largest river's floodplain a narrow valley may leave no gentle ground near
      // its distance from the vantage).
      let ranked = scored.filter((e) => e.s > 1e-4);
      if (ranked.length === 0 && kind === "village") ranked = scored.filter((e) => e.s > 0);
      ranked.sort((a, b) => b.s - a.s);
      // The best in sight of the vantage, else (none among the first forty) the best.
      let pick = ranked[0]?.c;
      if (visible) {
        for (let r = 0; r < Math.min(ranked.length, 40); r++) {
          const c = ranked[r]?.c;
          if (c && seen(c.x, c.z, c.y + 6)) {
            pick = c;
            break;
          }
        }
      }
      if (!pick) return;
      sites.push({
        kind,
        x: pick.x,
        z: pick.z,
        // Its height on the land as the river and streams left it.
        y: this.#ground[pick.at] ?? 0,
        radius,
        bank: pick.bank,
        first: 0,
        count: 0,
      });
    };
    const r = this.#random;
    r.seed(this.#mix(3));
    // Seeded preferences, so seeds differ beyond the relief.
    const prefer = 520 + 260 * r.next();
    choose(
      "village",
      150,
      0,
      (c) =>
        c.flat *
        Math.exp(-(((c.water - 200) / 280) ** 2)) *
        Math.exp(-(((c.dist - prefer) / 320) ** 2)) *
        inView(c, 30 * deg),
      true,
    );
    choose(
      "castle",
      70,
      450,
      (c) =>
        smoothstep(6, 45, c.prominence) *
        (1 - smoothstep(0.12, 0.3, 1 - c.flat + 0.12)) *
        Math.exp(-(((c.dist - 1300) / 700) ** 2)) *
        inView(c, 32 * deg),
      true,
    );
    for (let h = 0; h < TERRAIN_MAX_HAMLETS; h++) {
      choose(
        "hamlet",
        70,
        420,
        (c) =>
          c.flat ** 2 *
          Math.exp(-(((c.water - 260) / 320) ** 2)) *
          Math.exp(-(((c.dist - 1100) / 700) ** 2)) *
          inView(c, 36 * deg) *
          (0.85 + 0.3 * hashOf(c.x, c.z, o.seed)),
        true,
      );
    }
    for (let f = 0; f < TERRAIN_MAX_FARMS; f++) {
      choose(
        "farm",
        35,
        230,
        (c) =>
          c.flat ** 1.5 *
          smoothstep(60, 160, c.water) *
          Math.exp(-(((c.dist - 900) / 700) ** 2)) *
          inView(c, 40 * deg) *
          (0.6 + 0.8 * hashOf(c.x * 1.3, c.z * 0.7, o.seed + 9)),
        false,
      );
    }
    let hamlets = 0;
    let farms = 0;
    const built = sites.filter((site) => {
      if (site.kind === "village") return o.village > 0;
      if (site.kind === "castle") return o.castle;
      if (site.kind === "hamlet") return hamlets++ < o.hamlets;
      return farms++ < o.farms;
    });
    this.#places.length = 0;
    this.#places.push(...built);
    // Copies: a built settlement's radius grows to its buildings, its site's stays nominal.
    this.#candidates.length = 0;
    for (const { kind, x, z, y, radius, bank } of sites)
      this.#candidates.push({ kind, x, z, y, radius, bank });
  }

  /** The eye: above the vantage's ground (as it stands now). */
  #eye(): { x: number; y: number; z: number } {
    const v = this.options.vantage;
    return {
      x: v.x,
      z: v.z,
      y: sampleGrid(this.#ground, this.#m, this.options.extent, v.x, v.z) + v.eye,
    };
  }

  // ---- roads ----------------------------------------------------------------------------------

  /**
   * The network: which settlements a road joins (a spanning tree, a shortcut, a way out) and which
   * a track serves (each farm, and the lane through the near field). Planned whatever `roads` and
   * `tracks` say, so switching either moves no other way; they only decide what is laid (#lay).
   */
  #network(): void {
    const places = this.#places;
    const o = this.options;
    const W = o.extent;
    const n = this.#n;
    const m = this.#m;
    const cellC = this.#cellC;
    // A way out: the lowest point of the far edges off the largest river's floodplain and its
    // meanders' widest sway, 12 m clear as the settlements keep (Course), on the land as it lay
    // before the river was carved, so no size of the river moves it.
    const course = this.#course;
    if (!course) throw new TerrainError("terrain: a stage was skipped");
    const bare = this.#detailed;
    let exit: Point | undefined;
    let lowest = Infinity;
    const v = o.vantage;
    for (let s = 1; s < 64; s++) {
      const t = s / 64;
      for (const [x, z] of [
        [t * W, W - 2],
        [W - 2, t * W],
      ] as const) {
        const depth = (x - v.x) * v.dx + (z - v.z) * v.dz;
        const across = (x - v.x) * v.dz - (z - v.z) * v.dx;
        if (Math.abs(Math.atan2(across, depth)) > 0.5) continue;
        let near = false;
        for (let c = 0; c < course.x.length && !near; c++) {
          const dx = (course.x[c] ?? 0) - x;
          const dz = (course.z[c] ?? 0) - z;
          const reach = (course.widest[c] ?? 0) + 12;
          near = dx * dx + dz * dz < reach * reach;
        }
        if (near) continue;
        const q =
          clamp(Math.floor(z / this.#cellF), 0, m - 1) * m +
          clamp(Math.floor(x / this.#cellF), 0, m - 1);
        const y = bare[q] ?? 0;
        if (y < lowest) {
          lowest = y;
          exit = { x, z };
        }
      }
    }
    const nodes: (Point & { bank: number; farm: boolean })[] = places.map((p) => ({
      x: p.x,
      z: p.z,
      bank: p.bank,
      farm: p.kind === "farm",
    }));
    if (exit) {
      const bank =
        this.#bank[
          clamp(Math.floor(exit.z / cellC), 0, n - 1) * n +
            clamp(Math.floor(exit.x / cellC), 0, n - 1)
        ] ?? -1;
      nodes.push({ x: exit.x, z: exit.z, bank, farm: false });
    }
    // A farm track down through the near field below the vantage, joining the network.
    const lane = { x: v.x + v.dx * 90, z: v.z + v.dz * 90 };
    nodes.push({ ...lane, bank: this.#bankAt(lane.x, lane.z), farm: true });
    this.#lane = nodes.length - 1;
    const count = nodes.length;
    this.#routes.length = 0;
    if (count < 2) return;
    // Rivers are crossed once if at all.
    const weight = (a: number, b: number): number => {
      const na = nodes[a];
      const nb = nodes[b];
      if (!na || !nb) return Infinity;
      return hypot2(na.x - nb.x, na.z - nb.z) * (na.bank !== nb.bank ? 3 : 1);
    };
    // Prim's minimum spanning tree over the village, hamlets, castle and the way out: the roads.
    // Then each farm (and the near field's lane) a track to the nearest of them. With no hub, the
    // farms' tracks join each other.
    const hubs = nodes.flatMap((node, index) => (node.farm ? [] : [index]));
    const spurs = nodes.flatMap((node, index) => (node.farm ? [index] : []));
    const tree = hubs.length > 0 ? hubs : spurs.splice(0, spurs.length);
    const inTree = new Uint8Array(count);
    const best = new Float64Array(count).fill(Infinity);
    const from = new Int32Array(count).fill(-1);
    best[tree[0] ?? 0] = 0;
    const adjacent: number[][] = nodes.map(() => []);
    for (let it = 0; it < tree.length; it++) {
      let u = -1;
      for (const q of tree)
        if (inTree[q] === 0 && (u < 0 || (best[q] ?? Infinity) < (best[u] ?? Infinity))) u = q;
      if (u < 0) break;
      inTree[u] = 1;
      const f = from[u] ?? -1;
      if (f >= 0) {
        this.#addRoute(f, u, nodes);
        adjacent[f]?.push(u);
        adjacent[u]?.push(f);
      }
      for (const q of tree) {
        if (inTree[q] === 1) continue;
        const w = weight(u, q);
        if (w < (best[q] ?? Infinity)) {
          best[q] = w;
          from[q] = u;
        }
      }
    }
    for (const s of spurs) {
      let hub = -1;
      for (const q of tree) if (hub < 0 || weight(s, q) < weight(s, hub)) hub = q;
      if (hub >= 0) this.#addRoute(hub, s, nodes);
    }
    // A shortcut where the tree detours most (same bank, not farms).
    const treeDistance = (a: number, b: number): number => {
      const dist = new Float64Array(count).fill(Infinity);
      dist[a] = 0;
      const stack = [a];
      while (stack.length > 0) {
        const u = stack.pop() ?? 0;
        for (const q of adjacent[u] ?? []) {
          if (Number.isFinite(dist[q] ?? Infinity)) continue;
          const nu = nodes[u];
          const nq = nodes[q];
          dist[q] = (dist[u] ?? 0) + (nu && nq ? hypot2(nu.x - nq.x, nu.z - nq.z) : 0);
          stack.push(q);
        }
      }
      return dist[b] ?? Infinity;
    };
    let worst = 1.6;
    let pair: [number, number] | undefined;
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const na = nodes[a];
        const nb = nodes[b];
        if (!na || !nb || na.farm || nb.farm || na.bank !== nb.bank) continue;
        if (adjacent[a]?.includes(b)) continue;
        const direct = hypot2(na.x - nb.x, na.z - nb.z);
        if (direct > 1600) continue;
        const ratio = treeDistance(a, b) / direct;
        if (ratio > worst) {
          worst = ratio;
          pair = [a, b];
        }
      }
    }
    if (pair) this.#addRoute(pair[0], pair[1], nodes);
    // Roads first, shortest first, so tracks and longer roads can join them.
    this.#routes.sort((p, q) => {
      if (p.kind !== q.kind) return p.kind === "road" ? -1 : 1;
      const lp = hypot2(
        (nodes[p.a]?.x ?? 0) - (nodes[p.b]?.x ?? 0),
        (nodes[p.a]?.z ?? 0) - (nodes[p.b]?.z ?? 0),
      );
      const lq = hypot2(
        (nodes[q.a]?.x ?? 0) - (nodes[q.b]?.x ?? 0),
        (nodes[q.a]?.z ?? 0) - (nodes[q.b]?.z ?? 0),
      );
      return lp - lq;
    });
    this.#nodes = nodes;
    this.#planCosts();
    // One bridge, if some road must cross.
    const crossing = this.#routes.find((route) => route.crossing);
    if (crossing) this.#placeBridge(nodes[crossing.a], nodes[crossing.b]);
  }

  #nodes: Point[] = [];
  /** The near field's lane in #nodes: only drawn where it finds a short way to the network. */
  #lane = -1;

  #addRoute(
    a: number,
    b: number,
    nodes: readonly (Point & { bank: number; farm: boolean })[],
  ): void {
    const na = nodes[a];
    const nb = nodes[b];
    if (!na || !nb) return;
    this.#routes.push({
      a,
      b,
      kind: na.farm || nb.farm ? "track" : "road",
      crossing: na.bank !== nb.bank,
    });
  }

  /** Per erosion-grid cell: the road cost of crossing it (Infinity: water), and the ground there. */
  #planCosts(): void {
    const n = this.#n;
    const m = this.#m;
    const g = this.#ground;
    const lv = this.#level;
    const cell = this.#cellC;
    const ground = new Float32Array(n * n);
    const costs = new Float32Array(n * n);
    const fords = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let wet = false;
        for (let b = 0; b < 2; b++)
          for (let c = 0; c < 2; c++) {
            const q = (2 * j + b) * m + 2 * i + c;
            sum += g[q] ?? 0;
            if ((lv[q] ?? 0) > (g[q] ?? 0) - 0.2) wet = true;
            if ((this.#stream[q] ?? FAR) < 0) fords[j * n + i] = 1;
          }
        ground[j * n + i] = sum / 4;
        costs[j * n + i] = wet ? Infinity : 0;
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const q = j * n + i;
        if (!Number.isFinite(costs[q] ?? 0)) continue;
        const e = ground[j * n + Math.min(n - 1, i + 1)] ?? 0;
        const w = ground[j * n + Math.max(0, i - 1)] ?? 0;
        const no = ground[Math.min(n - 1, j + 1) * n + i] ?? 0;
        const so = ground[Math.max(0, j - 1) * n + i] ?? 0;
        const c = ground[q] ?? 0;
        const slope = hypot2(e - w, no - so) / (2 * cell);
        const bend = Math.abs(e + w + no + so - 4 * c) / (cell * cell);
        const fq = (2 * j + 1) * m + 2 * i + 1;
        const plain =
          (this.#riverDist[fq] ?? Infinity) < this.#riverReach(this.#riverAlong[fq] ?? 0) ? 1 : 0;
        // A stream is crossed where it must be (a ford or a culvert), not followed.
        costs[q] =
          1 +
          2 * (slope / TERRAIN_ROAD_MAX_SLOPE) ** 2 +
          400 * bend +
          0.8 * plain +
          2.5 * (fords[q] ?? 0);
      }
    }
    this.#costs = costs;
    this.#coarseGround = ground;
    this.#used = new Uint8Array(n * n);
  }

  #placeBridge(
    a: (Point & { bank: number }) | undefined,
    b: (Point & { bank: number }) | undefined,
  ): void {
    const river = this.#river;
    if (!river || !a || !b) return;
    const count = river.x.length;
    const W = this.options.extent;
    let best = -1;
    let bestScore = Infinity;
    const direct = hypot2(a.x - b.x, a.z - b.z);
    for (let k = Math.floor(count * 0.08); k < Math.ceil(count * 0.92); k++) {
      const x = river.x[k] ?? 0;
      const z = river.z[k] ?? 0;
      if (x < 150 || z < 150 || x > W - 150 || z > W - 150) continue;
      const detour = hypot2(a.x - x, a.z - z) + hypot2(x - b.x, z - b.z) - direct;
      const score = (river.width[k] ?? 0) * 8 + detour * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best < 0) return;
    const k0 = Math.max(0, best - 3);
    const k1 = Math.min(count - 1, best + 3);
    const tx = (river.x[k1] ?? 0) - (river.x[k0] ?? 0);
    const tz = (river.z[k1] ?? 0) - (river.z[k0] ?? 0);
    const tl = hypot2(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    const w = river.width[best] ?? 0;
    const cx = river.x[best] ?? 0;
    const cz = river.z[best] ?? 0;
    // Out from the channel until both ends stand on dry erosion-grid cells, so roads reach them.
    const reachOut = (side: number): number => {
      let reach = 0.5 * w + (2 + 0.25 * w) + 4;
      const n = this.#n;
      for (let tries = 0; tries < 20; tries++, reach += 2) {
        const i = clamp(Math.floor((cx + side * nx * reach) / this.#cellC), 0, n - 1);
        const j = clamp(Math.floor((cz + side * nz * reach) / this.#cellC), 0, n - 1);
        if (this.#channel[j * n + i] === 0 && Number.isFinite(this.#costs?.[j * n + i] ?? 0)) break;
      }
      return reach;
    };
    const r0 = reachOut(-1);
    const r1 = reachOut(1);
    const water = river.level[best] ?? 0;
    this.#bridge = {
      x0: cx - nx * r0,
      z0: cz - nz * r0,
      x1: cx + nx * r1,
      z1: cz + nz * r1,
      deck0: water + 2.5,
      deck1: water + 2.5,
      halfWidth: ROAD_HALF + 1.4,
      water,
    };
  }

  /** The bank label at a point. */
  #bankAt(x: number, z: number): number {
    const n = this.#n;
    const i = clamp(Math.floor(x / this.#cellC), 0, n - 1);
    const j = clamp(Math.floor(z / this.#cellC), 0, n - 1);
    return this.#bank[j * n + i] ?? -1;
  }

  #route(index: number): void {
    const route = this.#routes[index];
    if (!route || !this.#costs) return;
    const a = this.#nodes[route.a];
    const b = this.#nodes[route.b];
    if (!a || !b) return;
    const bridge = this.#bridge;
    let line: Polyline | undefined;
    let bridgeStart = -1;
    let bridgeEnd = -1;
    if (route.crossing && bridge) {
      // To the bridge's end on a's side, over it, on from the other end.
      const aBank = this.#bankAt(a.x, a.z);
      const end0Bank = this.#bankAt(bridge.x0, bridge.z0);
      const end0 = { x: bridge.x0, z: bridge.z0 };
      const end1 = { x: bridge.x1, z: bridge.z1 };
      const end0Near =
        aBank === end0Bank ||
        (aBank !== this.#bankAt(end1.x, end1.z) &&
          hypot2(a.x - end0.x, a.z - end0.z) < hypot2(a.x - end1.x, a.z - end1.z));
      const [near, far] = end0Near ? [end0, end1] : [end1, end0];
      const first = this.#search(a, near);
      const second = this.#search(far, b);
      if (!first || !second) return;
      const deck = resample({ x: [near.x, far.x], z: [near.z, far.z] }, 4);
      const one = this.#shape(first);
      const two = this.#shape(second);
      // The span runs from `near` (the last point of the first leg) to `far` (the first of the second).
      bridgeStart = one.x.length - 1;
      bridgeEnd = bridgeStart + deck.x.length - 1;
      line = {
        x: [...one.x, ...deck.x.slice(1, -1), ...two.x],
        z: [...one.z, ...deck.z.slice(1, -1), ...two.z],
      };
    } else {
      const cells = this.#search(a, b);
      if (!cells) return;
      line = this.#shape(cells);
    }
    if (route.a === this.#lane || route.b === this.#lane) {
      let length = 0;
      for (let k = 1; k < line.x.length; k++)
        length += hypot2(
          (line.x[k] ?? 0) - (line.x[k - 1] ?? 0),
          (line.z[k] ?? 0) - (line.z[k - 1] ?? 0),
        );
      if (length > 2.5 * hypot2(a.x - b.x, a.z - b.z) + 200) return;
    }
    this.#addRoad(route, line, bridgeStart, bridgeEnd);
  }

  /** A* over the erosion grid from point a to point b: the path's points, a and b exactly. */
  #search(a: Point, b: Point): Polyline | undefined {
    const costs = this.#costs;
    const ground = this.#coarseGround;
    const used = this.#used;
    if (!costs || !ground || !used) return undefined;
    const n = this.#n;
    const cell = this.#cellC;
    const toCell = (p: Point) =>
      clamp(Math.floor(p.z / cell), 0, n - 1) * n + clamp(Math.floor(p.x / cell), 0, n - 1);
    const start = toCell(a);
    const goal = toCell(b);
    const gi = goal % n;
    const gj = (goal - gi) / n;
    const score = new Float32Array(n * n).fill(Infinity);
    const came = new Int32Array(n * n).fill(-1);
    const closed = new Uint8Array(n * n);
    const heap = new NodeHeap(4096);
    const heuristic = (q: number) => {
      const qi = q % n;
      return 0.45 * cell * hypot2(qi - gi, (q - qi) / n - gj);
    };
    const grade = TERRAIN_ROAD_MAX_SLOPE;
    for (const limit of [1.3 * grade, 2 * grade, Infinity]) {
      score.fill(Infinity);
      came.fill(-1);
      closed.fill(0);
      heap.size = 0;
      score[start] = 0;
      heap.push(start, heuristic(start));
      let found = false;
      while (heap.size > 0) {
        const c = heap.pop();
        if (closed[c] === 1) continue;
        if (c === goal) {
          found = true;
          break;
        }
        closed[c] = 1;
        const ci = c % n;
        const cj = (c - ci) / n;
        const cc = costs[c] ?? 0;
        const hc = ground[c] ?? 0;
        const sc = score[c] ?? 0;
        for (let d = 0; d < 16; d++) {
          const di = DX16[d] ?? 0;
          const dj = DZ16[d] ?? 0;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const q = nj * n + ni;
          if (closed[q] === 1) continue;
          const cq = costs[q] ?? Infinity;
          if (!Number.isFinite(cq) && q !== goal) continue;
          // No cutting corners past water.
          if (Math.abs(di) + Math.abs(dj) > 1) {
            const sx = Math.sign(di);
            const sz = Math.sign(dj);
            const m1 =
              (cj + (Math.abs(dj) === 2 ? sz : 0)) * n + ci + (Math.abs(di) === 2 ? sx : sx);
            const m2 = (cj + sz) * n + ci + (Math.abs(di) === 2 ? sx : 0);
            if (!Number.isFinite(costs[m1] ?? Infinity) || !Number.isFinite(costs[m2] ?? Infinity))
              continue;
          }
          const len = hypot2(di, dj) * cell;
          const rise = Math.abs((ground[q] ?? 0) - hc) / len;
          if (rise > limit) continue;
          const reuse = used[c] === 1 && used[q] === 1 ? 0.45 : 1;
          const step =
            len *
            0.5 *
            (cc + (Number.isFinite(cq) ? cq : cc)) *
            (1 + 2 * (rise / grade) ** 2) *
            reuse;
          const total = sc + step;
          if (total < (score[q] ?? Infinity)) {
            score[q] = total;
            came[q] = c;
            heap.push(q, total + heuristic(q));
          }
        }
      }
      if (!found) continue;
      const cells: number[] = [];
      for (let c = goal; c >= 0; c = came[c] ?? -1) {
        cells.push(c);
        if (c === start) break;
      }
      cells.reverse();
      for (const c of cells) used[c] = 1;
      const x = [a.x];
      const z = [a.z];
      for (let k = 1; k + 1 < cells.length; k++) {
        const c = cells[k] ?? 0;
        const ci = c % n;
        x.push((ci + 0.5) * cell);
        z.push(((c - ci) / n + 0.5) * cell);
      }
      x.push(b.x);
      z.push(b.z);
      return { x, z };
    }
    return undefined;
  }

  /** A path smoothed (as far as it stays dry) and resampled every 4 m. */
  #shape(path: Polyline): Polyline {
    const m = this.#m;
    const W = this.options.extent;
    for (const passes of [3, 2, 1, 0]) {
      const line = resample(chaikin(simplify(path, 0.5 * this.#cellC), passes), 4);
      let dry = true;
      for (let k = 0; k < line.x.length && dry; k++) {
        const x = line.x[k] ?? 0;
        const z = line.z[k] ?? 0;
        if (sampleGrid(this.#level, m, W, x, z) > sampleGrid(this.#ground, m, W, x, z) - 0.1)
          dry = false;
      }
      if (dry || passes === 0) return line;
    }
    return resample(path, 4);
  }

  #addRoad(route: PlannedRoute, line: Polyline, bridgeStart: number, bridgeEnd: number): void {
    const m = this.#m;
    const W = this.options.extent;
    const count = line.x.length;
    const h = new Float64Array(count);
    const smooth = new Float64Array(count);
    for (let k = 0; k < count; k++)
      h[k] = sampleGrid(this.#ground, m, W, line.x[k] ?? 0, line.z[k] ?? 0);
    for (let k = 0; k < count; k++) {
      let sum = 0;
      let weight = 0;
      for (let q = -3; q <= 3; q++) {
        const at = k + q;
        if (at < 0 || at >= count) continue;
        sum += h[at] ?? 0;
        weight++;
      }
      smooth[k] = sum / weight;
    }
    let pinned: Uint8Array | undefined;
    const bridge = this.#bridge;
    if (bridgeStart >= 0 && bridge) {
      pinned = new Uint8Array(count);
      const deck = Math.max(
        bridge.water + 2.5,
        smooth[Math.max(0, bridgeStart - 1)] ?? 0,
        smooth[Math.min(count - 1, bridgeEnd + 1)] ?? 0,
      );
      for (let k = bridgeStart; k <= bridgeEnd; k++) {
        pinned[k] = 1;
        smooth[k] = deck;
      }
    }
    gradeProfile(smooth, 4, TERRAIN_ROAD_MAX_SLOPE, pinned);
    if (bridgeStart >= 0 && bridge) {
      bridge.deck0 = smooth[bridgeStart] ?? bridge.deck0;
      bridge.deck1 = smooth[bridgeEnd] ?? bridge.deck1;
      // The deck runs from x0 at deck0: order the ends along this road.
      const sx = line.x[bridgeStart] ?? 0;
      const sz = line.z[bridgeStart] ?? 0;
      if (hypot2(sx - bridge.x0, sz - bridge.z0) > hypot2(sx - bridge.x1, sz - bridge.z1)) {
        const deck0 = bridge.deck0;
        bridge.deck0 = bridge.deck1;
        bridge.deck1 = deck0;
      }
    }
    const road: TerrainRoad = {
      kind: route.kind,
      from: route.a < this.#places.length ? route.a : -1,
      to: route.b < this.#places.length ? route.b : -1,
      x: Float32Array.from(line.x),
      z: Float32Array.from(line.z),
      y: Float32Array.from(smooth),
      halfWidth: route.kind === "road" ? ROAD_HALF : TRACK_HALF,
      bridgeStart,
      bridgeEnd,
    };
    const laid = route.kind === "road" ? this.options.roads : this.options.tracks;
    const way = laid ? road : this.#street(road);
    if (way) this.#roads.push(way);
  }

  /**
   * A route switched off: its stretch through the village, from its first point within
   * TERRAIN_VILLAGE_STREETS of the village to its last (and the bridge whole where it reaches it),
   * kept as the village's own street with the route's line, profile and width, so no cottage
   * moves. Undefined where the route keeps away from the village, or there is none.
   */
  #street(road: TerrainRoad): TerrainRoad | undefined {
    const village = this.#places.find((place) => place.kind === "village");
    if (!village) return undefined;
    const count = road.x.length;
    let k0 = -1;
    let k1 = -1;
    for (let k = 0; k < count; k++) {
      const d = hypot2((road.x[k] ?? 0) - village.x, (road.z[k] ?? 0) - village.z);
      if (d > TERRAIN_VILLAGE_STREETS) continue;
      if (k0 < 0) k0 = k;
      k1 = k;
    }
    if (k1 <= k0) return undefined;
    const bridged = road.bridgeStart >= 0 && road.bridgeStart <= k1 && road.bridgeEnd >= k0;
    if (bridged) {
      k0 = Math.min(k0, road.bridgeStart);
      k1 = Math.max(k1, road.bridgeEnd);
    }
    return {
      ...road,
      from: k0 === 0 ? road.from : -1,
      to: k1 === count - 1 ? road.to : -1,
      x: road.x.slice(k0, k1 + 1),
      z: road.z.slice(k0, k1 + 1),
      y: road.y.slice(k0, k1 + 1),
      bridgeStart: bridged ? road.bridgeStart - k0 : -1,
      bridgeEnd: bridged ? road.bridgeEnd - k0 : -1,
    };
  }

  /**
   * Cut every road's bed into the ground; the roads' distance field and headings. The bridge,
   * placed for the plan, stands only where a way laid crosses it.
   */
  #roadbeds(): void {
    if (!this.#roads.some((road) => road.bridgeStart >= 0)) this.#bridge = undefined;
    const m = this.#m;
    const cellF = this.#cellF;
    const g = this.#ground;
    const lv = this.#level;
    this.#road.fill(FAR);
    this.#roadAngle.fill(Number.NaN);
    const dist = new Float32Array(m * m);
    const along = new Float32Array(m * m);
    for (const road of this.#roads) {
      const count = road.x.length;
      const half = road.halfWidth;
      const shoulder = 7;
      dist.fill(Infinity);
      along.fill(-1);
      // Leave the bridge's span out: it is drawn on its own.
      const reach = (k: number) =>
        road.bridgeStart >= 0 && k >= road.bridgeStart && k < road.bridgeEnd ? -1 : ROAD_ALIGN;
      nearestOnLine(road.x, road.z, count, reach, 0, m, cellF, dist, along);
      for (let q = 0; q < m * m; q++) {
        const d = dist[q] ?? Infinity;
        if (!Number.isFinite(d)) continue;
        const a = along[q] ?? 0;
        const k = clamp(Math.floor(a), 0, count - 2);
        const t = a - k;
        const sd = d - half;
        if (sd < (this.#road[q] ?? FAR)) {
          this.#road[q] = sd;
          this.#roadAngle[q] = Math.atan2(
            (road.z[k + 1] ?? 0) - (road.z[k] ?? 0),
            (road.x[k + 1] ?? 0) - (road.x[k] ?? 0),
          );
        }
        if (d > half + shoulder || (lv[q] ?? 0) > (g[q] ?? 0) || this.#banked[q] === 1) continue;
        const y = lerp(road.y[k] ?? 0, road.y[k + 1] ?? 0, t);
        g[q] = lerp(y, g[q] ?? 0, smoothstep(half + 0.5, half + shoulder, d));
        lv[q] = Math.min(lv[q] ?? 0, (g[q] ?? 0) - 4);
      }
    }
  }

  // ---- buildings ------------------------------------------------------------------------------

  #build(): void {
    const o = this.options;
    const m = this.#m;
    const W = o.extent;
    const g = this.#ground;
    const buildings = this.#buildings;
    buildings.length = 0;
    // Spacings were laid out for a 7 m gable; they scale with the house as drawn.
    const k = TERRAIN_HOUSE / 7;
    // A stable 0..1 for a point and a purpose: each settlement's layout draws from its own ground,
    // never from a sequence shared with the others, so one's size never moves another's buildings.
    const draw = (x: number, z: number, salt: number): number =>
      hash31(Math.round(x * 8), Math.round(z * 8), o.seed * 131 + salt);
    const free = (x: number, z: number, clear: number): boolean => {
      if (x < 20 || z < 20 || x > W - 20 || z > W - 20) return false;
      if (sampleGrid(this.#level, m, W, x, z) > sampleGrid(g, m, W, x, z) - 1) return false;
      if (sampleGrid(this.#road, m, W, x, z) < 3.5) return false;
      if (sampleGrid(this.#stream, m, W, x, z) < 4) return false;
      const rd = sampleGrid(this.#riverDist, m, W, x, z);
      if (
        Number.isFinite(rd) &&
        rd < 0.5 * this.#riverWidth(sampleGrid(this.#riverAlong, m, W, x, z)) + 12
      )
        return false;
      return buildings.every((b) => hypot2(b.x - x, b.z - z) >= clear);
    };
    const slopeAt = (x: number, z: number): number => {
      const e = 6;
      return (
        hypot2(
          sampleGrid(g, m, W, x + e, z) - sampleGrid(g, m, W, x - e, z),
          sampleGrid(g, m, W, x, z + e) - sampleGrid(g, m, W, x, z - e),
        ) /
        (2 * e)
      );
    };
    const add = (
      kind: TerrainBuildingKind,
      x: number,
      z: number,
      facing: number,
      length: number,
      settlement: number,
    ): void => {
      if (buildings.length >= TERRAIN_MAX_BUILDINGS) return;
      buildings.push({
        kind,
        x,
        z,
        y: sampleGrid(g, m, W, x, z),
        facing,
        length,
        hash: draw(x, z, 1),
        settlement,
      });
    };
    // The heading of `road` as it leaves settlement `index`, over its first `ahead` points.
    const leaving = (road: TerrainRoad, index: number, ahead: number): number => {
      const end = road.from === index ? 0 : road.x.length - 1;
      const next =
        road.from === index ? Math.min(ahead, road.x.length - 1) : Math.max(0, end - ahead);
      return Math.atan2(
        (road.z[next] ?? 0) - (road.z[end] ?? 0),
        (road.x[next] ?? 0) - (road.x[end] ?? 0),
      );
    };
    interface Plot {
      x: number;
      z: number;
      heading: number;
      length: number;
      clear: number;
      steep: number;
      /** Its place in the order the settlement fills its plots. */
      rank: number;
    }
    this.#places.forEach((place, index) => {
      place.first = buildings.length;
      const ways = this.#roads.filter((road) => road.from === index || road.to === index);
      if (place.kind === "castle") {
        add("castle", place.x, place.z, 0, 1, index);
      } else if (place.kind === "farm") {
        const road = ways[0];
        const heading = road ? leaving(road, index, 3) : draw(place.x, place.z, 2) * Math.PI;
        const nx = -Math.sin(heading);
        const nz = Math.cos(heading);
        const hx = place.x + nx * 9 * k;
        const hz = place.z + nz * 9 * k;
        if (free(hx, hz, 10 * k)) add("cottage", hx, hz, heading, 1.5, index);
        const side = draw(place.x, place.z, 3) < 0.5 ? -1 : 1;
        const bx = place.x - nx * 10 * k + Math.cos(heading) * side * 14 * k;
        const bz = place.z - nz * 10 * k + Math.sin(heading) * side * 14 * k;
        if (free(bx, bz, 12 * k)) add("barn", bx, bz, heading + Math.PI / 2, 1.8, index);
      } else {
        const village = place.kind === "village";
        const want = village ? o.village : 3 + Math.floor(3 * draw(place.x, place.z, 4));
        // Cottages line the roads (a place with none, its tracks); the church stands beside the
        // first, set back from it.
        const roads = ways.filter((road) => road.kind === "road");
        const lined = roads.length > 0 ? roads : ways;
        let centre = { x: place.x, z: place.z };
        if (village) {
          const road = lined[0];
          const heading = road ? leaving(road, index, 4) : 0;
          for (const offset of [16 * k, -16 * k, 24 * k, -24 * k]) {
            const cx = place.x - Math.sin(heading) * offset;
            const cz = place.z + Math.cos(heading) * offset;
            if (free(cx, cz, 14 * k) && slopeAt(cx, cz) < 0.2) {
              add("church", cx, cz, heading, 2.5, index);
              centre = { x: cx, z: cz };
              break;
            }
          }
        }
        // Plots in a fixed order: either side of each road at a house's spacing, nearest the church
        // (or the hamlet's middle) first, then set back between them, nearest first. The first
        // `want` that are free are built, so a larger village keeps every cottage of a smaller one.
        const plots: Plot[] = [];
        const reach = village ? VILLAGE_REACH : place.radius;
        const spacing = (village ? 19 : 17) * k;
        for (const road of lined) {
          const forward = road.from === index;
          const count = road.x.length;
          for (let s = 6; s < count; s += Math.round(spacing / 4)) {
            const at = forward ? s : count - 1 - s;
            const kx = road.x[at] ?? 0;
            const kz = road.z[at] ?? 0;
            if (hypot2(kx - place.x, kz - place.z) > reach) break;
            if (road.bridgeStart >= 0 && at >= road.bridgeStart - 4 && at <= road.bridgeEnd + 4)
              continue;
            const ahead = clamp(at + 1, 0, count - 1);
            const behind = clamp(at - 1, 0, count - 1);
            const heading = Math.atan2(
              (road.z[ahead] ?? 0) - (road.z[behind] ?? 0),
              (road.x[ahead] ?? 0) - (road.x[behind] ?? 0),
            );
            for (const side of [1, -1]) {
              const off = road.halfWidth + (8 + 3 * draw(kx, kz, 5 + side)) * k;
              const x = kx - Math.sin(heading) * off * side;
              const z = kz + Math.cos(heading) * off * side;
              const rank = hypot2(x - centre.x, z - centre.z);
              const length = 1.3 + 0.7 * draw(x, z, 7);
              plots.push({ x, z, heading, length, clear: 13 * k, steep: 0.22, rank });
            }
          }
        }
        const back = village ? 160 : 0.8 * place.radius;
        for (let t = 0; t < 48; t++) {
          const angle = 2 * Math.PI * draw(place.x, place.z, 20 + t);
          const dist = 18 * k + ((back - 18 * k) * (t + draw(place.x, place.z, 70 + t))) / 48;
          const x = place.x + Math.cos(angle) * dist;
          const z = place.z + Math.sin(angle) * dist;
          const road =
            this.#roadAngle[
              clamp(Math.floor(z / this.#cellF), 0, m - 1) * m +
                clamp(Math.floor(x / this.#cellF), 0, m - 1)
            ] ?? Number.NaN;
          const heading = Number.isFinite(road) ? road : angle;
          const length = 1.2 + 0.6 * draw(x, z, 8);
          plots.push({ x, z, heading, length, clear: 14 * k, steep: 0.2, rank: reach + dist });
        }
        plots.sort((a, b) => a.rank - b.rank);
        let built = 0;
        for (const plot of plots) {
          if (built >= want) break;
          if (!free(plot.x, plot.z, plot.clear) || slopeAt(plot.x, plot.z) > plot.steep) continue;
          add("cottage", plot.x, plot.z, plot.heading, plot.length, index);
          built++;
        }
      }
      place.count = buildings.length - place.first;
      // Its spread as built, which the shader looks its buildings up by.
      for (let b = place.first; b < buildings.length; b++) {
        const at = buildings[b];
        if (at) place.radius = Math.max(place.radius, hypot2(at.x - place.x, at.z - place.z) + 15);
      }
    });
    // Terraces: each building's ground levelled to its base; the castle's whole hilltop.
    const cellF = this.#cellF;
    this.#yard.fill(0);
    for (const b of buildings) {
      const castle = b.kind === "castle";
      const inner = castle ? 42 : 0.5 * b.length * TERRAIN_HOUSE + 4;
      const outer = inner + (castle ? 30 : 9);
      const yardIn = castle ? 45 : (b.kind === "church" ? 16 : 9) * k;
      const yardOut = yardIn + (castle ? 25 : 16 * k);
      const reach = Math.max(outer, yardOut);
      const i0 = Math.max(0, Math.floor((b.x - reach) / cellF));
      const i1 = Math.min(m - 1, Math.ceil((b.x + reach) / cellF));
      const j0 = Math.max(0, Math.floor((b.z - reach) / cellF));
      const j1 = Math.min(m - 1, Math.ceil((b.z + reach) / cellF));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const q = j * m + i;
          const d = hypot2((i + 0.5) * cellF - b.x, (j + 0.5) * cellF - b.z);
          if (
            (this.#level[q] ?? 0) <= (g[q] ?? 0) &&
            (this.#road[q] ?? FAR) > 0 &&
            this.#banked[q] === 0
          ) {
            g[q] = lerp(b.y, g[q] ?? 0, smoothstep(inner, outer, d));
          }
          this.#yard[q] = Math.max(this.#yard[q] ?? 0, 1 - smoothstep(yardIn, yardOut, d));
        }
      }
    }
  }

  // ---- woods and parcels ----------------------------------------------------------------------

  #woods(): void {
    const m = this.#m;
    const g = this.#ground;
    const carved = this.#carved;
    if (!carved) throw new TerrainError("terrain: a stage was skipped");
    const bare = carved.ground;
    const cellF = this.#cellF;
    const seed = this.options.seed;
    const v = this.options.vantage;
    // Heights run from the land's own lowest to its highest, before any terrace or road is cut.
    let top = -Infinity;
    let bottom = Infinity;
    for (let q = 0; q < m * m; q++) {
      top = Math.max(top, bare[q] ?? 0);
      bottom = Math.min(bottom, bare[q] ?? 0);
    }
    const span = Math.max(1, top - bottom);
    // How well woodland suits texel q of relief h (e, w, n, s: the texels beside it), given the
    // rest of its terms (its patch and the vantage's open ground).
    const suit = (
      h: Float32Array,
      q: number,
      e: number,
      w: number,
      n: number,
      s: number,
      rest: number,
    ): number => {
      const slope = hypot2((h[e] ?? 0) - (h[w] ?? 0), (h[n] ?? 0) - (h[s] ?? 0)) / (2 * cellF);
      const high = ((h[q] ?? 0) - bottom) / span;
      return 0.55 * smoothstep(0.08, 0.38, slope) + 0.3 * smoothstep(0.35, 0.85, high) + rest;
    };
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const q = j * m + i;
        const e = j * m + Math.min(m - 1, i + 1);
        const w = j * m + Math.max(0, i - 1);
        const n = Math.min(m - 1, j + 1) * m + i;
        const s = Math.max(0, j - 1) * m + i;
        const X = (i + 0.5) / m;
        const Z = (j + 0.5) / m;
        const patch = 2 * fbm(X * 9, Z * 9, seed + 11, 4) - 1;
        // The vantage stands on open ground: the near slopes below it are farmland, not a wood's top.
        const open =
          1 - smoothstep(250, 550, hypot2((i + 0.5) * cellF - v.x, (j + 0.5) * cellF - v.z));
        const rest = 0.55 * patch + 0.3 - 0.9 * open;
        // On the bare land, without the roads' cuts and the yards: what the land model weighs each
        // parcel for woodland by (TerrainParcels.wood).
        const natural = suit(bare, q, e, w, n, s, rest);
        this.#bareWood[q] = clamp(natural, 0, 1);
        // As built: the same where no road's bed or terrace has touched the ground about it.
        const cut =
          g[q] !== bare[q] ||
          g[e] !== bare[e] ||
          g[w] !== bare[w] ||
          g[n] !== bare[n] ||
          g[s] !== bare[s];
        const built = cut ? suit(g, q, e, w, n, s, rest) : natural;
        this.#wood[q] = clamp(built - 0.9 * (this.#yard[q] ?? 0), 0, 1);
      }
    }
  }

  #parcelSites(): void {
    const m = this.#m;
    const W = this.options.extent;
    // The land as the river and streams left it: no road or building the settings switch moves a
    // site, turns it to the slope or drowns it.
    const carved = this.#carved;
    if (!carved) throw new TerrainError("terrain: a stage was skipped");
    const g = carved.ground;
    const r = this.#random;
    r.seed(this.#mix(5));
    // Field sizes vary over the valley, and are smaller round the settlements (old closes and
    // paddocks), every candidate's at its nominal radius, built or not: each site keeps its own
    // spacing clear of the sites before it.
    const homes = this.#candidates.filter((p) => p.kind !== "castle");
    const spacingAt = (x: number, z: number): number => {
      let s = PARCEL_SPACING * (0.68 + 0.64 * valueNoise(x / 650, z / 650, this.options.seed + 41));
      for (const p of homes)
        s *= 1 - 0.3 * (1 - smoothstep(p.radius, p.radius + 350, hypot2(p.x - x, p.z - z)));
      return s;
    };
    // Darts, each kept where it lies its spacing clear of those kept before it, in buckets half the
    // widest spacing across, each a list of its sites (two buckets either way hold every site a
    // dart could be too near). Then those in the water are dropped, so the water decides no other
    // site's place: a river of another size drops or keeps only the sites between the two.
    const bucket = 0.66 * PARCEL_SPACING;
    const nb = Math.ceil(W / bucket);
    const heads = new Int32Array(nb * nb).fill(-1);
    const links: number[] = [];
    const dartX: number[] = [];
    const dartZ: number[] = [];
    const tries = 24 * Math.ceil((W * W) / (PARCEL_SPACING * PARCEL_SPACING));
    for (let t = 0; t < tries && dartX.length < TERRAIN_MAX_PARCELS; t++) {
      const x = r.range(0, W);
      const z = r.range(0, W);
      const bi = Math.floor(x / bucket);
      const bj = Math.floor(z / bucket);
      const spacing = spacingAt(x, z);
      let near = false;
      for (let b = -2; b <= 2 && !near; b++) {
        const nj = bj + b;
        if (nj < 0 || nj >= nb) continue;
        for (let a = -2; a <= 2 && !near; a++) {
          const ni = bi + a;
          if (ni < 0 || ni >= nb) continue;
          for (let s = heads[nj * nb + ni] ?? -1; s >= 0 && !near; s = links[s] ?? -1) {
            if (hypot2((dartX[s] ?? 0) - x, (dartZ[s] ?? 0) - z) < spacing) near = true;
          }
        }
      }
      if (near) continue;
      links.push(heads[bj * nb + bi] ?? -1);
      heads[bj * nb + bi] = dartX.length;
      dartX.push(x);
      dartZ.push(z);
    }
    // The dry ones are the sites, bucketed again for the lookup.
    const xs: number[] = [];
    const zs: number[] = [];
    heads.fill(-1);
    links.length = 0;
    dartX.forEach((x, d) => {
      const z = dartZ[d] ?? 0;
      if (sampleGrid(carved.level, m, W, x, z) > sampleGrid(g, m, W, x, z)) return;
      const at = Math.floor(z / bucket) * nb + Math.floor(x / bucket);
      links.push(heads[at] ?? -1);
      heads[at] = xs.length;
      xs.push(x);
      zs.push(z);
    });
    const count = xs.length;
    const angle = new Float32Array(count);
    const bareAngle = new Float32Array(count);
    const elongation = new Float32Array(count);
    const floodplain = new Uint8Array(count);
    const seed = this.options.seed;
    for (let s = 0; s < count; s++) {
      const x = xs[s] ?? 0;
      const z = zs[s] ?? 0;
      const e = 10;
      const gx = (sampleGrid(g, m, W, x + e, z) - sampleGrid(g, m, W, x - e, z)) / (2 * e);
      const gz = (sampleGrid(g, m, W, x, z + e) - sampleGrid(g, m, W, x, z - e)) / (2 * e);
      const slope = hypot2(gx, gz);
      const q =
        clamp(Math.floor(z / this.#cellF), 0, m - 1) * m +
        clamp(Math.floor(x / this.#cellF), 0, m - 1);
      const road = this.#roadAngle[q] ?? Number.NaN;
      // Its own draws come from hashes of its place, never a shared sequence, so no site the water
      // drops or keeps re-rolls another. Along a road beside one, else along the contour on a
      // slope, else as it falls (its own roll). Without the road, its heading on the bare land
      // (TerrainBare).
      const ix = Math.round(x * 8);
      const iz = Math.round(z * 8);
      const bare = slope > 0.02 ? Math.atan2(gx, -gz) : Math.PI * hash31(ix, iz, seed * 131 + 501);
      bareAngle[s] = bare;
      angle[s] = Number.isFinite(road) && (this.#road[q] ?? FAR) < ROAD_ALIGN - 10 ? road : bare;
      elongation[s] = 1.2 + 0.8 * hash31(ix, iz, seed * 131 + 502);
      const rd = this.#riverDist[q] ?? Infinity;
      floodplain[s] =
        Number.isFinite(rd) && rd < this.#riverReach(this.#riverAlong[q] ?? 0) ? 1 : 0;
    }
    this.#parcels = {
      count,
      x: Float32Array.from(xs),
      z: Float32Array.from(zs),
      angle,
      elongation,
      floodplain,
      wood: new Float32Array(count),
      ids: this.#ids,
      coreX: new Float32Array(count),
      coreZ: new Float32Array(count),
      coreRadius: new Float32Array(count),
    };
    // The sampling's buckets serve the lookup.
    this.#siteGrid = { grid: heads, nb, bucket, next: Int32Array.from(links) };
    this.#bareAngle = bareAngle;
  }

  #siteGrid: { grid: Int32Array; nb: number; bucket: number; next: Int32Array } = {
    grid: new Int32Array(0),
    nb: 0,
    bucket: 1,
    next: new Int32Array(0),
  };
  /** Each site's heading on the bare land, without the road beside it (#parcelIds). */
  #bareAngle = new Float32Array(0);

  /**
   * The nearest two sites per texel for rows j0 .. j1 - 1, by each site's stretched metric; and the
   * nearest by the bare metric (each site at its bare heading, TerrainBare.ids), which differs
   * only beside the sites a road turns.
   */
  #parcelIds(j0: number, j1: number): void {
    const parcels = this.#parcels;
    if (!parcels) return;
    const m = this.#m;
    const cellF = this.#cellF;
    const { grid, nb, bucket, next } = this.#siteGrid;
    const cos = parcels.angle.map(Math.cos);
    const sin = parcels.angle.map(Math.sin);
    const bareCos = this.#bareAngle.map(Math.cos);
    const bareSin = this.#bareAngle.map(Math.sin);
    const turned = Uint8Array.from(this.#bareAngle, (bare, s) =>
      bare === parcels.angle[s] ? 0 : 1,
    );
    // Buckets whose search (three either way) meets a turned site: elsewhere the bare nearest is
    // the nearest.
    const reached = new Uint8Array(nb * nb);
    for (let s = 0; s < parcels.count; s++) {
      if (turned[s] === 0) continue;
      const si = Math.floor((parcels.x[s] ?? 0) / bucket);
      const sj = Math.floor((parcels.z[s] ?? 0) / bucket);
      for (let b = Math.max(0, sj - 3); b <= Math.min(nb - 1, sj + 3); b++)
        for (let a = Math.max(0, si - 3); a <= Math.min(nb - 1, si + 3); a++)
          reached[b * nb + a] = 1;
    }
    const woodSum = new Float64Array(parcels.count);
    const woodCount = new Int32Array(parcels.count);
    const limit = 2.6 * PARCEL_SPACING;
    for (let j = j0; j < j1; j++) {
      const pz = (j + 0.5) * cellF;
      const bj = Math.floor(pz / bucket);
      for (let i = 0; i < m; i++) {
        const px = (i + 0.5) * cellF;
        const bi = Math.floor(px / bucket);
        let d1 = limit;
        let d2 = limit;
        let s1 = -1;
        let s2 = -1;
        let bare1 = limit;
        let bareS = -1;
        const track = reached[bj * nb + bi] === 1;
        for (let b = -3; b <= 3; b++) {
          const nj = bj + b;
          if (nj < 0 || nj >= nb) continue;
          for (let a = -3; a <= 3; a++) {
            const ni = bi + a;
            if (ni < 0 || ni >= nb) continue;
            for (let s = grid[nj * nb + ni] ?? -1; s >= 0; s = next[s] ?? -1) {
              const dx = px - (parcels.x[s] ?? 0);
              const dz = pz - (parcels.z[s] ?? 0);
              const ca = cos[s] ?? 1;
              const sa = sin[s] ?? 0;
              const stretch = parcels.elongation[s] ?? 1;
              const u = (dx * ca + dz * sa) / stretch;
              const w = -dx * sa + dz * ca;
              const d = Math.sqrt(u * u + w * w);
              if (d < d1) {
                d2 = d1;
                s2 = s1;
                d1 = d;
                s1 = s;
              } else if (d < d2) {
                d2 = d;
                s2 = s;
              }
              if (!track) continue;
              let bare = d;
              if (turned[s] === 1) {
                const cb = bareCos[s] ?? 1;
                const sb = bareSin[s] ?? 0;
                const ub = (dx * cb + dz * sb) / stretch;
                const wb = -dx * sb + dz * cb;
                bare = Math.sqrt(ub * ub + wb * wb);
              }
              if (bare < bare1) {
                bare1 = bare;
                bareS = s;
              }
            }
          }
        }
        const q = j * m + i;
        if (!track) bareS = s1;
        this.#ids[2 * q] = s1 + 1;
        this.#ids[2 * q + 1] = s2 + 1;
        this.#bareIds[q] = bareS + 1;
        if (bareS >= 0) {
          woodSum[bareS] = (woodSum[bareS] ?? 0) + (this.#bareWood[q] ?? 0);
          woodCount[bareS] = (woodCount[bareS] ?? 0) + 1;
        }
      }
    }
    for (let s = 0; s < parcels.count; s++) {
      const c = woodCount[s] ?? 0;
      if (c === 0) continue;
      // The two halves of the rows add up: keep a running mean weighted by texels.
      const before = this.#woodTexels[s] ?? 0;
      const mean = parcels.wood[s] ?? 0;
      parcels.wood[s] = (mean * before + (woodSum[s] ?? 0)) / (before + c);
      this.#woodTexels[s] = before + c;
    }
  }

  #woodTexels = new Int32Array(TERRAIN_MAX_PARCELS);

  #trees(): void {
    const m = this.#m;
    // No tree stands in the water.
    for (let q = 0; q < m * m; q++) {
      if ((this.#level[q] ?? 0) > (this.#ground[q] ?? 0) - 0.3) this.#wood[q] = 0;
    }
    // Lone trees: along the hedges (some hedges lined with them, some bare) and the river's banks,
    // a texel each, written into the yard channel as -1 (see Terrain.yard).
    const seed = this.options.seed;
    for (let j = 1; j < m - 1; j++) {
      for (let i = 1; i < m - 1; i++) {
        const q = j * m + i;
        if ((this.#level[q] ?? 0) > (this.#ground[q] ?? 0) - 0.5) continue;
        if (
          (this.#road[q] ?? FAR) < 3 ||
          (this.#stream[q] ?? FAR) < 2 ||
          (this.#yard[q] ?? 0) > 0.3
        )
          continue;
        const id = this.#ids[2 * q] ?? 0;
        const hedge = id !== (this.#ids[2 * q + 2] ?? 0) || id !== (this.#ids[2 * (q + m)] ?? 0);
        const d = this.#riverDist[q] ?? Infinity;
        const w = this.#riverWidth(this.#riverAlong[q] ?? 0);
        const bank = Number.isFinite(d) && d > 0.5 * w + 2 && d < 0.5 * w + 2 + 0.25 * w + 9;
        const lined = valueNoise(i / 24, j / 24, seed + 59);
        const chance = hedge ? 0.32 * smoothstep(0.35, 0.75, lined) : bank ? 0.22 : 0;
        if (chance > 0 && hash31(i, j, seed + 61) < chance) this.#yard[q] = -1;
      }
    }
  }

  /**
   * Each parcel's clear core (TerrainParcels.coreX..): its texel farthest from every texel that is
   * not clear ground of its own (beside another parcel's texel or the map's edge, water, a road or
   * stream with its verge, a yard, a lone tree), at that distance less 1.5 texels, the most the
   * parcels' exact border (terrainParcel) strays from its texel outline.
   */
  #cores(): void {
    const parcels = this.#parcels;
    if (!parcels) throw new TerrainError("terrain: a stage was skipped");
    const m = this.#m;
    const cellF = this.#cellF;
    const ids = this.#ids;
    const blocked = new Uint8Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const q = j * m + i;
        const id = ids[2 * q] ?? 0;
        const edge =
          id === 0 ||
          i === 0 ||
          j === 0 ||
          i === m - 1 ||
          j === m - 1 ||
          ids[2 * (q - 1)] !== id ||
          ids[2 * (q + 1)] !== id ||
          ids[2 * (q - m)] !== id ||
          ids[2 * (q + m)] !== id;
        const taken =
          (this.#level[q] ?? 0) > (this.#ground[q] ?? 0) - 0.3 ||
          (this.#road[q] ?? FAR) < CORE_CLEAR.road ||
          (this.#stream[q] ?? FAR) < CORE_CLEAR.stream ||
          Math.abs(this.#yard[q] ?? 0) > 0.02;
        blocked[q] = edge || taken ? 1 : 0;
      }
    }
    const clear = distanceField(blocked, m);
    const best = new Float32Array(parcels.count);
    for (let q = 0; q < m * m; q++) {
      if (blocked[q] === 1) continue;
      const s = (ids[2 * q] ?? 0) - 1;
      const d = clear[q] ?? 0;
      if (d <= (best[s] ?? 0)) continue;
      best[s] = d;
      parcels.coreX[s] = ((q % m) + 0.5) * cellF;
      parcels.coreZ[s] = (Math.floor(q / m) + 0.5) * cellF;
    }
    for (let s = 0; s < parcels.count; s++)
      parcels.coreRadius[s] = Math.max(0, ((best[s] ?? 0) - 1.5) * cellF);
  }

  #finish(): void {
    const parcels = this.#parcels;
    const river = this.#river;
    const carved = this.#carved;
    if (!parcels || !river || !carved) throw new TerrainError("terrain: a stage was skipped");
    const eye = this.#eye();
    this.#terrain = {
      size: this.#m,
      extent: this.options.extent,
      cell: this.#cellF,
      ground: this.#ground,
      level: this.#level,
      road: this.#road,
      stream: this.#stream,
      wood: this.#wood,
      yard: this.#yard,
      riverbed: this.#riverbed,
      river,
      settlements: this.#places,
      candidates: this.#candidates,
      buildings: this.#buildings,
      roads: this.#roads,
      bridge: this.#bridge,
      parcels,
      bare: { ground: carved.ground, level: carved.level, ids: this.#bareIds },
      vantage: { ...this.options.vantage, y: eye.y },
      timings: this.#timings,
    };
  }
}

/** A stable 0..1 for a point and a seed. */
function hashOf(x: number, z: number, seed: number): number {
  return valueNoise(x * 0.0137 + 0.5, z * 0.0137 + 0.5, seed + 77);
}

/** Build a whole terrain at once (tests, tools). */
export function generateTerrain(options: TerrainOptions): Terrain {
  const builder = new TerrainBuilder(options);
  for (let i = 0; i < builder.units; i++) builder.unit(i);
  return builder.terrain;
}

/** A road resampled evenly (terrainWays): its points `first` .. `first + count - 1`, `spacing` apart. */
export interface TerrainWay {
  kind: "road" | "track";
  first: number;
  count: number;
  /** Metres between consecutive points: the road's length over count - 1. */
  spacing: number;
}

export interface TerrainWays {
  ways: TerrainWay[];
  /** x, y (the road's surface: its cut-and-fill profile, the bridge's deck), z per point, metres. */
  points: Float32Array;
}

/**
 * Every road and track (bridge included) as points spaced evenly along it, its ends kept, as near
 * WAY_SPACING apart as its length divides into (never farther): what walkers and carts follow by
 * arc length (terrainWayAt in GLSL). The spacing grows for a network too long for
 * TERRAIN_MAX_WAY_POINTS. A point between two consecutive ones lies on the road: off its smoothed
 * centreline by at most the sag of a 4 m chord (the roads' own vertex spacing) over a kink, within
 * its half width (terrain.test.ts).
 */
export function terrainWays(t: Terrain): TerrainWays {
  const lengths = t.roads.map((road) => {
    let length = 0;
    for (let k = 1; k < road.x.length; k++)
      length += hypot2(
        (road.x[k] ?? 0) - (road.x[k - 1] ?? 0),
        (road.z[k] ?? 0) - (road.z[k - 1] ?? 0),
      );
    return length;
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  // ceil(L / ds) + 1 points a road, so at most total / ds + 2 a road: within the records.
  const ds = Math.max(WAY_SPACING, total / (TERRAIN_MAX_WAY_POINTS - 2 * t.roads.length));
  const ways: TerrainWay[] = [];
  const points: number[] = [];
  t.roads.forEach((road, index) => {
    const length = lengths[index] ?? 0;
    const steps = Math.max(1, Math.ceil(length / ds));
    const spacing = length / steps;
    ways.push({ kind: road.kind, first: points.length / 3, count: steps + 1, spacing });
    let k = 0;
    let start = 0;
    for (let step = 0; step <= steps; step++) {
      const s = step === steps ? length : step * spacing;
      for (;;) {
        const seg = hypot2(
          (road.x[k + 1] ?? 0) - (road.x[k] ?? 0),
          (road.z[k + 1] ?? 0) - (road.z[k] ?? 0),
        );
        if (k + 2 >= road.x.length || start + seg >= s) {
          const f = seg > 0 ? clamp((s - start) / seg, 0, 1) : 0;
          points.push(
            lerp(road.x[k] ?? 0, road.x[k + 1] ?? 0, f),
            lerp(road.y[k] ?? 0, road.y[k + 1] ?? 0, f),
            lerp(road.z[k] ?? 0, road.z[k + 1] ?? 0, f),
          );
          break;
        }
        start += seg;
        k++;
      }
    }
  });
  return { ways, points: Float32Array.from(points) };
}

/**
 * The records texture's layout (rgba16f, nearest; read with texelFetch). Positions are split into
 * two halves each (half.ts) for ~22 bits. Rows from 0:
 *   sites      2 texels a parcel site, 32 a row: (x hi, x lo, z hi, z lo), (angle, elongation, use,
 *              its attribute): the use and attribute are the land model's (landuse.ts packLand), 0
 *              until it writes them
 *   buildings  4 texels a building, 16 a row: (x hi, x lo, z hi, z lo), (y, facing, kind, length),
 *              (hash, settlement, 0, 0), unused
 *   places     2 texels a settlement: (x hi, x lo, z hi, z lo), (y, radius, first building, count)
 *   misc       the bridge (x0, z0 split), (x1, z1 split), (deck0, deck1, half width, water level);
 *              the eye (x, z split), (y, settlements, bridge 1/0, buildings); (ways, 0, 0, 0)
 *   cores      a texel a parcel site, 64 a row: its clear core's centre less the site (dx, dz),
 *              radius (0 none), 0
 *   ways       a texel a road (terrainWays): (first point / 64, first point % 64, count, spacing;
 *              negative for a track)
 *   points     2 texels a way point, 32 a row: (x hi, x lo, z hi, z lo), (y, 0, 0, 0)
 */
export const TERRAIN_RECORDS = (() => {
  const buildings = TERRAIN_MAX_PARCELS / 32;
  const places = buildings + TERRAIN_MAX_BUILDINGS / 16;
  const misc = places + 1;
  const cores = misc + 1;
  const ways = cores + TERRAIN_MAX_PARCELS / 64;
  const points = ways + 1;
  const height = points + TERRAIN_MAX_WAY_POINTS / 32;
  return { width: 64, sites: 0, buildings, places, misc, cores, ways, points, height } as const;
})();

/** A terrain laid out for upload: four textures, `size` square but for the records. */
export interface TerrainPacked {
  size: number;
  /** rgba16f, linear: ground, water level, d(ground)/dx, d(ground)/dz. */
  ground: Float32Array;
  /**
   * rgba16f, linear: road and stream signed distances (metres; a dry watercourse too, see
   * packWater), the woods' canopy (the land model's, landuse.ts packLand; 0 until it writes it),
   * yard (-1 a lone tree).
   */
  cover: Float32Array;
  /**
   * rgba8, nearest: nearest parcel id (lo, hi), second nearest (lo, hi). Ids reach
   * TERRAIN_MAX_PARCELS, so the nearest's hi byte keeps its top bit for the land model's flag
   * (landuse.ts LAND_PINE_FLAG; 0 until packLand writes it).
   */
  parcels: Uint8Array;
  /** rgba16f, nearest: TERRAIN_RECORDS.width × TERRAIN_RECORDS.height (see TERRAIN_RECORDS). */
  records: Float32Array;
}

/**
 * Lay a terrain out for upload (see TerrainPacked and TERRAIN_RECORDS), its river full. The land's
 * uses, the woods and which lone trees stand are the land model's to write (landuse.ts packLand).
 */
export function packTerrain(t: Terrain): TerrainPacked {
  const m = t.size;
  const ground = new Float32Array(m * m * 4);
  const cover = new Float32Array(m * m * 4);
  const parcels = new Uint8Array(m * m * 4);
  const g = t.ground;
  const span = 2 * t.cell;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const q = j * m + i;
      const o = 4 * q;
      ground[o] = g[q] ?? 0;
      ground[o + 1] = t.level[q] ?? 0;
      ground[o + 2] =
        ((g[j * m + Math.min(m - 1, i + 1)] ?? 0) - (g[j * m + Math.max(0, i - 1)] ?? 0)) / span;
      ground[o + 3] =
        ((g[Math.min(m - 1, j + 1) * m + i] ?? 0) - (g[Math.max(0, j - 1) * m + i] ?? 0)) / span;
      cover[o] = clamp(t.road[q] ?? FAR, -FAR, FAR);
      cover[o + 1] = clamp(t.stream[q] ?? FAR, -FAR, FAR);
      cover[o + 2] = 0;
      cover[o + 3] = t.yard[q] ?? 0;
      const a = t.parcels.ids[2 * q] ?? 0;
      const b = t.parcels.ids[2 * q + 1] ?? 0;
      parcels[o] = a & 255;
      parcels[o + 1] = a >> 8;
      parcels[o + 2] = b & 255;
      parcels[o + 3] = b >> 8;
    }
  }
  const L = TERRAIN_RECORDS;
  const records = new Float32Array(L.width * L.height * 4);
  const texel = (row: number, column: number) => 4 * (row * L.width + column);
  const p = t.parcels;
  for (let s = 0; s < p.count; s++) {
    const o = texel(L.sites + Math.floor(s / 32), 2 * (s % 32));
    splitHalf(records, o, p.x[s] ?? 0);
    splitHalf(records, o + 2, p.z[s] ?? 0);
    records[o + 4] = p.angle[s] ?? 0;
    records[o + 5] = p.elongation[s] ?? 1;
    records[o + 6] = 0;
    records[o + 7] = 0;
    const c = texel(L.cores + Math.floor(s / 64), s % 64);
    if ((p.coreRadius[s] ?? 0) <= 0) continue;
    records[c] = (p.coreX[s] ?? 0) - (p.x[s] ?? 0);
    records[c + 1] = (p.coreZ[s] ?? 0) - (p.z[s] ?? 0);
    records[c + 2] = p.coreRadius[s] ?? 0;
  }
  t.buildings.forEach((b, index) => {
    const o = texel(L.buildings + Math.floor(index / 16), 4 * (index % 16));
    splitHalf(records, o, b.x);
    splitHalf(records, o + 2, b.z);
    records[o + 4] = b.y;
    records[o + 5] = b.facing;
    records[o + 6] = TERRAIN_BUILDING_KINDS.indexOf(b.kind);
    records[o + 7] = b.length;
    records[o + 8] = b.hash;
    records[o + 9] = b.settlement;
  });
  t.settlements.forEach((s, index) => {
    const o = texel(L.places, 2 * index);
    splitHalf(records, o, s.x);
    splitHalf(records, o + 2, s.z);
    records[o + 4] = s.y;
    records[o + 5] = s.radius;
    records[o + 6] = s.first;
    records[o + 7] = s.count;
  });
  const misc = texel(L.misc, 0);
  const bridge = t.bridge;
  if (bridge) {
    splitHalf(records, misc, bridge.x0);
    splitHalf(records, misc + 2, bridge.z0);
    splitHalf(records, misc + 4, bridge.x1);
    splitHalf(records, misc + 6, bridge.z1);
    records[misc + 8] = bridge.deck0;
    records[misc + 9] = bridge.deck1;
    records[misc + 10] = bridge.halfWidth;
    records[misc + 11] = bridge.water;
  }
  splitHalf(records, misc + 12, t.vantage.x);
  splitHalf(records, misc + 14, t.vantage.z);
  records[misc + 16] = t.vantage.y;
  records[misc + 17] = t.settlements.length;
  records[misc + 18] = bridge ? 1 : 0;
  records[misc + 19] = t.buildings.length;
  const { ways, points } = terrainWays(t);
  records[misc + 20] = ways.length;
  ways.forEach((way, index) => {
    const o = texel(L.ways, index);
    // Half floats hold integers exactly only up to 2048: the first point as 64s and the rest.
    records[o] = Math.floor(way.first / 64);
    records[o + 1] = way.first % 64;
    records[o + 2] = way.count;
    records[o + 3] = way.kind === "road" ? way.spacing : -way.spacing;
  });
  for (let k = 0; k < points.length / 3; k++) {
    const o = texel(L.points + Math.floor(k / 32), 2 * (k % 32));
    splitHalf(records, o, points[3 * k] ?? 0);
    splitHalf(records, o + 2, points[3 * k + 2] ?? 0);
    records[o + 4] = points[3 * k + 1] ?? 0;
  }
  return { size: m, ground, cover, parcels, records };
}

/**
 * Fill the river's bed in a packed terrain (`water`), or leave it dry: its water level sunk under
 * the bed, and the bed marked as a watercourse in the stream channel (-1, as a stream's own bed),
 * which a scene draws dry while its streams run dry too. The carved valley, the banks, the bridge
 * and the sea stay as they are; nothing else is laid out again.
 */
export function packWater(packed: TerrainPacked, t: Terrain, water: boolean): void {
  for (let q = 0; q < t.size * t.size; q++) {
    const level = t.level[q] ?? 0;
    const ground = t.ground[q] ?? 0;
    if (t.riverbed[q] !== 1 || level <= ground) continue;
    packed.ground[4 * q + 1] = water ? level : ground - 4;
    packed.cover[4 * q + 1] = water ? clamp(t.stream[q] ?? FAR, -FAR, FAR) : -1;
  }
}
