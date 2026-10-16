// The verges (`verges`, off by default): clumps of cow parsley, red campion and tussock grass at the
// foot of the hedges on the parcels nearest the vantage, grown by the shared plant component
// (sims/plants.ts, shaders/lib/plants.ts). The simulation (CountryVerges) owns where they grow and
// what happens to them: which clumps stand where, their stems, leaves and flower heads, each organ
// swaying on its spring under the scene's wind and the gust bands that roll over the field each
// grows into (the flower fields' band, shaders/lib/fields.ts), and the farming year flowering,
// browning and shedding them (the scene's season knob, carried round while its year passes,
// through countryVergeYear; the harvest without one). The shader (countryVergeAt) finds the clump
// over a pixel and draws it, in the countryside's year (season.ts).
//
// Where they grow. A hedge stands where a farmed parcel (crops, a flower field or a pasture) meets
// another (shader.ts's ground branch). Each such border on the near ground (camera depth
// COUNTRY_VERGE.near..far, across the frame's width) is traced on the map from where the parcels'
// texels change hands, along the line the shader's parcel lookup puts it (terrainParcel, ported
// here: the nearest two of the sites the four texels round a point list, by each site's stretched
// metric), until a third parcel takes over or it leaves the near ground. Its slots lie every
// COUNTRY_VERGE.spacing metres along the line between the two sites, at a phase of the pair's own, so
// a slot keeps its place whatever else changes. The fullness knob takes a slot by its own hash (a
// fuller verge keeps a sparser one's clumps); other hashes pick the side it grows into, inset from
// the hedge's line, and its species. A clump grows into neither a pasture (the herds keep the
// hedge's foot bare) nor a wood, so none grows between two of them, nor across a pasture's hedge
// from the eye (the pasture's fence would stand in front of it); none roots on or by a road, a
// stream, water, a yard or the woods' canopy, nor where the parcel the shader finds at its root is
// not the one it grows into with that hedge's line the inset away (by a corner).
//
// Frame and drawing. Each clump is rooted at the origin of its own frame, x right on screen, y up,
// in metres, drawn COUNTRY_VERGE.large times life size (as the houses and walkers are drawn large),
// standing upright on the ground at its root and facing the eye. The shader looks a pixel up by its
// bearing (the pinhole's x): the frame's width is cut into COUNTRY_VERGE.bins bins, each listing the
// clumps whose width reaches into it, nearest first (at most COUNTRY_VERGE.perBin), with the highest
// any of their tops stands at rest (the entrance's raised eye only lowers them). The first clump
// nearer than the pixel's surface with an organ over the pixel is the one seen. Every organ's detail
// tier comes from its projected size at its root's depth.
//
// Records (the records atlas, atlas.ts: from the verges' first row, the atlas's width a row; texel
// k of the block at (k % width, row + k / width)):
//   texel (65, 0)   the block's first row, the bins, the first bin's left edge and a bin's width
//   texel (66, 0)   the clumps' first texel, the organ records' first row, clumps, 0
//   bins            BIN texels each: (top, count, 0, 0), then the clumps' indices four a texel
//   clumps          two texels each: root x, z (splitHalf pairs); root y (pair), 0, 0
//   organs          plant records (sims/plants.ts), COUNTRY_VERGE.organs a clump in clump order;
//                   records' a: a flexible organ's rest curl (the shader turns it by a + bend)
// Compiled in only while the knob is on (COUNTRY_HAS_VERGES, index.ts); while it is off the sim
// places and grows nothing and the atlas carries none of it.
import { seasonKnob, type SeasonKnob, yearAt, yearCycleKnob, yearNow } from "../../climate.ts";
import { effective, feature, KnobReader, type ParamDef } from "../../params.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";
import { splitHalf, toHalf } from "../../sims/half.ts";
import { LAND_USES, type LandUse } from "../../sims/landuse.ts";
import { clamp, fract, glslHash12, hash31, hypot2, lerp } from "../../sims/math.ts";
import {
  PlantHabit,
  PlantRole,
  plantClimate,
  RootedPlants,
  writePlantRecords,
  type PlantSpecies,
} from "../../sims/plants.ts";
import {
  sampleGrid,
  TERRAIN_RECORDS,
  type Terrain,
  type TerrainPacked,
} from "../../sims/terrain.ts";
import type { SimFrame } from "../types.ts";
import { COUNTRY_SEASONS } from "./season.ts";

/** The verges' layout and reach (shared with the shader). */
export const COUNTRY_VERGE = {
  /** Organ records per clump. */
  organs: 6,
  /** Metres between a hedge's slots, along the line between its two parcels' sites. */
  spacing: 5,
  /** Metres a clump stands in from the hedge's line, at its foot (a hedge is ~1.3 m half wide). */
  inset: 2.3,
  /** How far off that the shader's border may put a root (metres): further, a corner is near. */
  slack: 0.7,
  /** Camera depths (metres) the clumps keep to: the parcels nearest the vantage. */
  near: 40,
  far: 450,
  /** The most a clump reaches above its root and either side of it, life metres. */
  tall: 1.75,
  wide: 0.85,
  /** How much larger than life the clumps are drawn. */
  large: 2,
  /** Metres a root keeps from a road's edge (past the road's verge and hedge) and from a stream's. */
  road: 6,
  stream: 4,
  /** Bearing bins across the frame, and the most clumps a bin lists. */
  bins: 256,
  perBin: 24,
  /** The most clumps (their index is a whole half float). */
  most: 2048,
} as const;

/** What a record draws (its form): the shader's shape and colour. */
export const COUNTRY_VERGE_FORM = {
  parsleyStem: 0,
  parsleyLeaf: 1,
  umbel: 2,
  campionStem: 3,
  campionLeaf: 4,
  campion: 5,
  blade: 6,
  culm: 7,
  panicle: 8,
} as const;

/** The atlas texel holding the verges' layout (and the next). */
export const COUNTRY_VERGE_HEAD = TERRAIN_RECORDS.width + 1;

/**
 * The plant year (sims/plants.ts) the verges show at each of the farming year's keys (season.ts):
 * early summer at the summer's, the harvest in August at its own, mid-autumn at autumn's; from the
 * start of winter round to the start of summer, the year itself.
 */
const VERGE_YEAR = [
  [0.25, 0.25],
  [COUNTRY_SEASONS.summer, 0.3],
  [COUNTRY_SEASONS.harvest, 0.47],
  [COUNTRY_SEASONS.autumn, 0.66],
  [0.75, 0.75],
] as const;

/** The plant year the verges show at a year position: VERGE_YEAR's keys exactly, linear between. */
export function countryVergeYear(date: number): number {
  let [x0, y0]: readonly [number, number] = VERGE_YEAR[0];
  if (date < x0) return date;
  for (const [x1, y1] of VERGE_YEAR.slice(1)) {
    if (date < x1) return y0 + ((date - x0) / (x1 - x0)) * (y1 - y0);
    [x0, y0] = [x1, y1];
  }
  return date;
}

export const countryVergesKnob = feature(
  "land",
  "verges",
  "verges",
  false,
  "fullness",
  0.6,
  "Clumps of cow parsley, red campion and tussock grass at the foot of the hedges on the fields nearest the hill. They sway in the wind and bow as its gusts roll across the fields, follow the farming year (new leaves in spring, the parsley's white umbels in early summer, gone to seed at harvest with the campion still in flower, everything browning in autumn, dead stems through winter) and carry the snow; they keep off the roads, the streams and the river, the yards, the woods and the grazed pastures. Fullness: how many clumps, from one here and there to a row along every hedge.",
  { icon: "flower" },
);

/** Texels a bin takes: its head, then its clumps four a texel. */
const BIN = 1 + COUNTRY_VERGE.perBin / 4;
/** shader.ts's camera: its focal length (screen heights) for the frame's bearing. */
const FOCAL = 0.5 / Math.tan(0.78 / 2);
/** Bearing (pinhole x) the bins reach past the frame's sides. */
const MARGIN = 0.02;
/** shader.ts's COUNTRY_FIELD_UNIT: metres a unit of the shared fields' materials (their gust bands). */
const FIELD_UNIT = 60;
/** Push per unit of the wind knob: the steady breeze, the eddies on it (a share of it), and the gust bands at their strongest (the band runs -0.5..0.5). */
const BREEZE = 1;
const EDDY = 0.4;
const GUST = 1.2;
/** Seconds of still air (wind 0) after which the clumps are set exactly at rest. */
const SETTLE = 6;

const USE = (use: LandUse): number => LAND_USES.indexOf(use);
const PASTURE = USE("pasture");
const WOODLAND = USE("woodland");
const CROPS = USE("crops");

/** A hedge stands where either parcel is farmed (shader.ts: crops through pasture). */
const farmed = (use: number): boolean => use >= CROPS && use <= PASTURE;

/** The plants' builds draw no randomness of their own: the slot's hashes place everything. */
const NO_DRAWS = (): number => 0;

/**
 * Cow parsley (Anthriscus sylvestris): two hollow stems carrying flat white umbels, two ferny
 * leaves arching out low from the base. It flowers in late spring and early summer; its leaves
 * yellow and die back after it has seeded.
 */
const COW_PARSLEY: PlantSpecies = {
  id: "cow parsley",
  moisture: [0.2, 0.9],
  sway: { hz: 2.4, damping: 0.3, give: 0.5, limit: 0.6, flutter: 0.12 },
  year: { shed: 1, turn: 0.38, bloom: [0.08, 0.36] },
  life: { unfold: 12, span: 240 },
  detail: { simple: 3, min: 0.25 },
  build(plant) {
    const k = plant.site.kind ?? 0;
    const scale = 0.8 + 0.2 * plant.vigour;
    for (let j = 0; j < 2; j++) {
      const side = j === 0 ? -1 : 1;
      const h = hash31(k, j, 0x6370);
      const curl = -side * (0.9 + 0.4 * h);
      plant.organ({
        offset: [0.08 * side, 0],
        angle: Math.PI / 2 - side * (0.6 + 0.2 * h),
        length: (0.6 + 0.2 * h) * scale,
        width: 0.55 * scale,
        curl,
        a: curl,
        form: COUNTRY_VERGE_FORM.parsleyLeaf,
        role: PlantRole.leaf,
        slot: j,
      });
    }
    const stems = [0, 0].map((_, j) => {
      const h = hash31(k, j + 2, 0x6370);
      const curl = 0.3 * (fract(h * 7.3) - 0.5);
      return plant.organ({
        offset: [j === 0 ? -0.08 : 0.1, 0],
        angle: Math.PI / 2 + (j === 0 ? 0.12 : -0.25) + 0.12 * (h - 0.5),
        length: (j === 0 ? 1.15 + 0.3 * h : 0.85 + 0.25 * h) * scale,
        width: 0.035,
        curl,
        a: curl,
        form: COUNTRY_VERGE_FORM.parsleyStem,
        slot: 2 + j,
      });
    });
    stems.forEach((stem, j) => {
      plant.organ({
        parent: stem,
        angle: 0,
        length: 0.18,
        width: (j === 0 ? 0.44 : 0.36) * scale,
        form: COUNTRY_VERGE_FORM.umbel,
        role: PlantRole.bloom,
        habit: PlantHabit.rigid,
        slot: 4 + j,
      });
    });
  },
};

/**
 * Red campion (Silene dioica): two slender stems with a loose head of rose-pink flowers each, two
 * oval leaves low down. It flowers from late spring through the harvest.
 */
const RED_CAMPION: PlantSpecies = {
  id: "red campion",
  moisture: [0.2, 0.9],
  sway: { hz: 2.6, damping: 0.35, give: 0.45, limit: 0.55, flutter: 0.1 },
  year: { shed: 0.4, turn: 0.6, bloom: [0.14, 0.56] },
  life: { unfold: 10, span: 200 },
  detail: { simple: 3, min: 0.25 },
  build(plant) {
    const k = plant.site.kind ?? 0;
    const scale = 0.8 + 0.2 * plant.vigour;
    for (let j = 0; j < 2; j++) {
      const side = j === 0 ? -1 : 1;
      const h = hash31(k, j, 0x7363);
      const curl = -side * (0.3 + 0.3 * h);
      plant.organ({
        offset: [0.06 * side, 0],
        angle: Math.PI / 2 - side * (0.8 + 0.2 * h),
        length: (0.32 + 0.08 * h) * scale,
        width: 0.18 * scale,
        curl,
        a: curl,
        form: COUNTRY_VERGE_FORM.campionLeaf,
        role: PlantRole.leaf,
        slot: j,
      });
    }
    const stems = [0, 0].map((_, j) => {
      const h = hash31(k, j + 2, 0x7363);
      const curl = 0.4 * (fract(h * 5.9) - 0.5);
      return plant.organ({
        offset: [j === 0 ? -0.06 : 0.07, 0],
        angle: Math.PI / 2 + (j === 0 ? 0.12 : -0.28) + 0.12 * (h - 0.5),
        length: (j === 0 ? 0.75 + 0.15 * h : 0.6 + 0.12 * h) * scale,
        width: 0.022,
        curl,
        a: curl,
        form: COUNTRY_VERGE_FORM.campionStem,
        slot: 2 + j,
      });
    });
    stems.forEach((stem, j) => {
      plant.organ({
        parent: stem,
        angle: 0,
        length: 0.1,
        width: (j === 0 ? 0.15 : 0.12) * scale,
        form: COUNTRY_VERGE_FORM.campion,
        role: PlantRole.bloom,
        habit: PlantHabit.rigid,
        slot: 4 + j,
      });
    });
  },
};

/**
 * A tussock of cock's-foot grass (Dactylis glomerata): four blades fanning out of the root and
 * arching over, and a stiff flowering stem carrying its clustered head from early summer into the
 * harvest.
 */
const TUSSOCK: PlantSpecies = {
  id: "tussock grass",
  moisture: [0.2, 0.9],
  sway: { hz: 2.2, damping: 0.3, give: 0.7, limit: 0.8, flutter: 0.2 },
  year: { shed: 0, turn: 0.55, bloom: [0.22, 0.62] },
  life: { unfold: 8, span: 160 },
  detail: { simple: 3, min: 0.25 },
  build(plant) {
    const k = plant.site.kind ?? 0;
    const scale = 0.8 + 0.2 * plant.vigour;
    for (let j = 0; j < 4; j++) {
      const h = hash31(k, j, 0x7475);
      // Across the tussock: -1 leaning left .. 1 leaning right.
      const lean = ((j - 1.5) / 1.5) * 1.1 + 0.2 * (h - 0.5);
      plant.organ({
        angle: Math.PI / 2 - 0.65 * lean,
        length: (0.65 + 0.2 * h) * scale,
        width: 0.07,
        curl: -1.3 * lean,
        a: -1.3 * lean,
        form: COUNTRY_VERGE_FORM.blade,
        role: PlantRole.leaf,
        slot: j,
      });
    }
    const h = hash31(k, 4, 0x7475);
    const curl = 0.3 * (fract(h * 3.7) - 0.5);
    const culm = plant.organ({
      angle: Math.PI / 2 + 0.15 * (h - 0.5),
      length: (0.95 + 0.2 * h) * scale,
      width: 0.014,
      curl,
      a: curl,
      form: COUNTRY_VERGE_FORM.culm,
      slot: 4,
    });
    plant.organ({
      parent: culm,
      angle: 0,
      length: 0.2,
      width: 0.08,
      form: COUNTRY_VERGE_FORM.panicle,
      role: PlantRole.bloom,
      habit: PlantHabit.rigid,
      slot: 5,
    });
  },
};

/** common.ts `vnoise(vec2(x, y))`, its lattice hashed as the shader hashes it. */
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(glslHash12(ix, iy), glslHash12(ix + 1, iy), ux),
    lerp(glslHash12(ix, iy + 1), glslHash12(ix + 1, iy + 1), ux),
    uy,
  );
}

/** The parcel at a point as the shader finds it: sites (index, -1 none), the border's distance and the way across it. */
export interface VergeParcel {
  best: number;
  next: number;
  border: number;
  nx: number;
  nz: number;
}

/**
 * The shader's parcel lookup on the CPU (shaders/lib/terrain.ts terrainParcel) over a terrain's
 * sites, their headings and stretches as the records hand them over (half floats).
 */
export class VergeParcels {
  readonly #t: Terrain;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #stretch: Float64Array;
  readonly #grad = new Float64Array(2);
  readonly #gradB = new Float64Array(2);

  constructor(t: Terrain) {
    const p = t.parcels;
    this.#t = t;
    this.#cos = new Float64Array(p.count);
    this.#sin = new Float64Array(p.count);
    this.#stretch = new Float64Array(p.count);
    for (let s = 0; s < p.count; s++) {
      const angle = toHalf(p.angle[s] ?? 0);
      this.#cos[s] = Math.cos(angle);
      this.#sin[s] = Math.sin(angle);
      this.#stretch[s] = toHalf(p.elongation[s] ?? 1);
    }
  }

  /** Site s's stretched distance from (x, z), its gradient into grad[0], grad[1]. */
  distance(s: number, x: number, z: number, grad: Float64Array): number {
    const p = this.#t.parcels;
    const c = this.#cos[s] ?? 1;
    const n = this.#sin[s] ?? 0;
    const e = this.#stretch[s] ?? 1;
    const dx = x - (p.x[s] ?? 0);
    const dz = z - (p.z[s] ?? 0);
    const mx = (dx * c + dz * n) / e;
    const mz = -dx * n + dz * c;
    const r = Math.max(hypot2(mx, mz), 1e-3);
    grad[0] = ((mx / e) * c - mz * n) / r;
    grad[1] = ((mx / e) * n + mz * c) / r;
    return r;
  }

  /** a's distance less b's at (x, z) (negative on a's side), its gradient (toward b) into grad. */
  gap(a: number, b: number, x: number, z: number, grad: Float64Array): number {
    const gb = this.#gradB;
    const f = this.distance(a, x, z, grad) - this.distance(b, x, z, gb);
    grad[0] = (grad[0] ?? 0) - (gb[0] ?? 0);
    grad[1] = (grad[1] ?? 0) - (gb[1] ?? 0);
    return f;
  }

  /** The parcel at (x, z), as terrainParcel finds it, into hit. */
  at(x: number, z: number, hit: VergeParcel): void {
    const t = this.#t;
    const size = t.size;
    const ids = t.parcels.ids;
    const g = this.#grad;
    const bi = Math.floor((x / t.extent) * size - 0.5);
    const bj = Math.floor((z / t.extent) * size - 0.5);
    let best = 1e9;
    let next = 1e9;
    let bestId = -1;
    let nextId = -1;
    let bx = 0;
    let bz = 0;
    let nx = 0;
    let nz = 0;
    for (let k = 0; k < 4; k++) {
      const i = clamp(bi + (k % 2), 0, size - 1);
      const j = clamp(bj + (k >> 1), 0, size - 1);
      const q = j * size + i;
      for (let c = 0; c < 2; c++) {
        const id = (ids[2 * q + c] ?? 0) - 1;
        if (id < 0 || id === bestId) continue;
        const d = this.distance(id, x, z, g);
        if (d < best) {
          if (bestId >= 0) {
            next = best;
            nextId = bestId;
            nx = bx;
            nz = bz;
          }
          best = d;
          bestId = id;
          bx = g[0] ?? 0;
          bz = g[1] ?? 0;
        } else if (d < next) {
          next = d;
          nextId = id;
          nx = g[0] ?? 0;
          nz = g[1] ?? 0;
        }
      }
    }
    hit.best = bestId;
    hit.next = nextId;
    const cx = nx - bx;
    const cz = nz - bz;
    const closing = hypot2(cx, cz);
    hit.border = nextId >= 0 ? (next - best) / Math.max(closing, 0.05) : 1e3;
    hit.nx = closing > 1e-4 ? cx / closing : 1;
    hit.nz = closing > 1e-4 ? cz / closing : 0;
  }
}

/** Where the verges look from: the eye as the shader reads it, and the camera's level frame. */
export interface VergeView {
  x: number;
  y: number;
  z: number;
  /** Forward (the heading) and right on the map. */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  /** The frame's half width in bearing (pinhole x), past its sides by MARGIN. */
  reach: number;
}

/** The view the shader draws: the terrain's vantage (its height as a half float) for a frame `aspect` wide. */
export function vergeView(t: Terrain, aspect: number): VergeView {
  const v = t.vantage;
  return {
    x: v.x,
    y: toHalf(v.y),
    z: v.z,
    fx: v.dx,
    fz: v.dz,
    rx: v.dz,
    rz: -v.dx,
    reach: aspect / 2 / FOCAL + MARGIN,
  };
}

/** A slot where a clump may grow, whatever the fullness. */
export interface VergeSlot {
  /** Its root on the ground (map metres) and its camera depth. */
  x: number;
  y: number;
  z: number;
  depth: number;
  /** The parcel it grows into and the one across its hedge (site indices). */
  into: number;
  other: number;
  /** Its hash against the fullness, its species' and its build's. */
  keep: number;
  pick: number;
  kind: number;
  lush: number;
}

const SALT = { phase: 0x7650, keep: 0x7665, side: 0x7673, pick: 0x5e5e, lush: 0x6c75 } as const;

/** Whether a clump may grow into a parcel of this use (not a pasture, not a wood). */
const growable = (use: number): boolean => use !== PASTURE && use !== WOODLAND;

/**
 * Every slot at the foot of a hedge on the near ground of `t`, its parcels used as `packed`'s
 * records say, seen through `view` (see the header): the hedges traced from where their parcels'
 * texels change hands, each slot checked at its root as the shader will find it.
 */
export function vergeSlots(t: Terrain, packed: TerrainPacked, view: VergeView): VergeSlot[] {
  const V = COUNTRY_VERGE;
  const L = TERRAIN_RECORDS;
  const parcels = new VergeParcels(t);
  const use = (s: number): number =>
    packed.records[4 * ((L.sites + Math.floor(s / 32)) * L.width + 2 * (s % 32)) + 6] ?? 0;
  const m = t.size;
  const cell = t.cell;
  const ids = t.parcels.ids;
  // The camera depth and bearing of a map point, and whether it lies on the near ground (with
  // `pad` metres to spare).
  const depth = (x: number, z: number): number => (x - view.x) * view.fx + (z - view.z) * view.fz;
  const near = (x: number, z: number, pad: number): boolean => {
    const d = depth(x, z);
    const across = (x - view.x) * view.rx + (z - view.z) * view.rz;
    return d > V.near - pad && d < V.far + pad && Math.abs(across) < d * view.reach + pad;
  };
  // Seeds: the midpoints between two texels' centres whose nearest parcels differ, per pair.
  const seeds = new Map<number, number[]>();
  const lean = view.reach * (V.far + 60);
  const corners = [
    [V.near - 60, -lean],
    [V.near - 60, lean],
    [V.far + 60, -lean],
    [V.far + 60, lean],
  ].map(([d = 0, a = 0]) => [
    view.x + view.fx * d + view.rx * a,
    view.z + view.fz * d + view.rz * a,
  ]);
  const xs = corners.map(([x = 0]) => x);
  const zs = corners.map(([, z = 0]) => z);
  const i0 = clamp(Math.floor(Math.min(...xs) / cell), 0, m - 2);
  const i1 = clamp(Math.ceil(Math.max(...xs) / cell), 0, m - 2);
  const j0 = clamp(Math.floor(Math.min(...zs) / cell), 0, m - 2);
  const j1 = clamp(Math.ceil(Math.max(...zs) / cell), 0, m - 2);
  const steps = [1, m] as const;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const q = j * m + i;
      const a = (ids[2 * q] ?? 0) - 1;
      for (const step of steps) {
        const b = (ids[2 * (q + step)] ?? 0) - 1;
        if (a < 0 || b < 0 || a === b) continue;
        const x = (i + 0.5 + (step === 1 ? 0.5 : 0)) * cell;
        const z = (j + 0.5 + (step === 1 ? 0 : 0.5)) * cell;
        if (!near(x, z, 30)) continue;
        const key = Math.min(a, b) * 4096 + Math.max(a, b);
        const list = seeds.get(key);
        if (list) list.push(x, z);
        else seeds.set(key, [x, z]);
      }
    }
  }
  const slots: VergeSlot[] = [];
  const grad = new Float64Array(2);
  const hit: VergeParcel = { best: -1, next: -1, border: 0, nx: 1, nz: 0 };
  const point = new Float64Array(2);
  // Newton's steps onto the pair's border from (x, z), into point; false if it does not settle.
  const project = (a: number, b: number, x: number, z: number): boolean => {
    let px = x;
    let pz = z;
    for (let n = 0; n < 8; n++) {
      const f = parcels.gap(a, b, px, pz, grad);
      const g2 = (grad[0] ?? 0) ** 2 + (grad[1] ?? 0) ** 2;
      if (g2 < 1e-8) return false;
      px -= (f * (grad[0] ?? 0)) / g2;
      pz -= (f * (grad[1] ?? 0)) / g2;
      if (Math.abs(f) < 1e-4) break;
    }
    point[0] = px;
    point[1] = pz;
    return Math.abs(parcels.gap(a, b, px, pz, grad)) < 1e-3;
  };
  // Whether the shader finds a and b the two nearest at (x, z): the pair's border runs there.
  const theirs = (a: number, b: number, x: number, z: number): boolean => {
    parcels.at(x, z, hit);
    return (hit.best === a && hit.next === b) || (hit.best === b && hit.next === a);
  };
  const hedge = (a: number, b: number, slot: number, x: number, z: number): void => {
    const ua = use(a);
    const ub = use(b);
    if (!(farmed(ua) || farmed(ub))) return;
    const keep = hash31(a, b, slot ^ SALT.keep);
    const first = hash31(a, b, slot ^ SALT.side) < 0.5 ? a : b;
    const second = first === a ? b : a;
    const into = growable(use(first)) ? first : growable(use(second)) ? second : -1;
    if (into < 0) return;
    const other = into === a ? b : a;
    parcels.gap(a, b, x, z, grad);
    const g = hypot2(grad[0] ?? 0, grad[1] ?? 0);
    if (g < 1e-6) return;
    // The way across, from a toward b; the root lies the inset into its own parcel.
    const toward = into === a ? -V.inset / g : V.inset / g;
    const rx = x + (grad[0] ?? 0) * toward;
    const rz = z + (grad[1] ?? 0) * toward;
    if (!near(rx, rz, 0) || rx < 0 || rz < 0 || rx > t.extent || rz > t.extent) return;
    parcels.at(rx, rz, hit);
    if (hit.best !== into || hit.next !== other || Math.abs(hit.border - V.inset) > V.slack) return;
    // Across a pasture's hedge its fence stands: a clump grows there only where the eye sees past
    // it toward the fence (the root's sight line runs across the hedge, from the root's side), by
    // the hedge's normal at the root as the shader's lookup finds it (into the root's own parcel).
    const sight = (rx - view.x) * hit.nx + (rz - view.z) * hit.nz;
    if (use(other) === PASTURE && sight >= 0) return;
    const W = t.extent;
    if (sampleGrid(t.road, m, W, rx, rz) < V.road || sampleGrid(t.stream, m, W, rx, rz) < V.stream)
      return;
    const ground = sampleGrid(t.ground, m, W, rx, rz);
    if (sampleGrid(t.level, m, W, rx, rz) > ground - 0.3) return;
    if (sampleGrid(t.yard, m, W, rx, rz) > 0.05) return;
    if (Math.abs(sampleCover(packed.cover, m, W, rx, rz, 2)) > 0.2) return;
    slots.push({
      x: rx,
      y: ground,
      z: rz,
      depth: depth(rx, rz),
      into,
      other,
      keep,
      pick: hash31(a, b, slot ^ SALT.pick),
      kind: Math.imul(a, 0x2c1b3c6d) ^ Math.imul(b, 0x297a2d39) ^ Math.imul(slot, 0x5bd1e995),
      lush: 0.75 + 0.25 * hash31(a, b, slot ^ SALT.lush),
    });
  };
  for (const [key, list] of seeds) {
    const a = Math.floor(key / 4096);
    const b = key % 4096;
    const ax = t.parcels.x[a] ?? 0;
    const az = t.parcels.z[a] ?? 0;
    const bx = t.parcels.x[b] ?? 0;
    const bz = t.parcels.z[b] ?? 0;
    const span = hypot2(bx - ax, bz - az) || 1;
    // Along the border: across the line from a to b, from its midpoint.
    const ux = -(bz - az) / span;
    const uz = (bx - ax) / span;
    const mx = 0.5 * (ax + bx);
    const mz = 0.5 * (az + bz);
    const along = (x: number, z: number): number => (x - mx) * ux + (z - mz) * uz;
    const phase = hash31(a, b, SALT.phase);
    // The stretches of the border traced so far (along it, from..to), and the slots met there.
    const traced: number[] = [];
    const met = new Set<number>();
    for (let k = 0; k + 1 < list.length; k += 2) {
      if (!project(a, b, list[k] ?? 0, list[k + 1] ?? 0)) continue;
      const x0 = point[0] ?? 0;
      const z0 = point[1] ?? 0;
      const s0 = along(x0, z0);
      let covered = false;
      for (let n = 0; n + 1 < traced.length; n += 2)
        covered ||= s0 >= (traced[n] ?? 0) - 1 && s0 <= (traced[n + 1] ?? 0) + 1;
      if (covered || !theirs(a, b, x0, z0) || !near(x0, z0, 30)) continue;
      let least = s0;
      let most = s0;
      // Both ways from the seed, in steps of 1.5 m held on the border; each step takes the slots
      // between its start (left to the step before) and its end.
      for (const way of [1, -1]) {
        let x = x0;
        let z = z0;
        let s = s0;
        for (let n = 0; n < 600; n++) {
          parcels.gap(a, b, x, z, grad);
          const g = hypot2(grad[0] ?? 0, grad[1] ?? 0);
          if (g < 1e-6) break;
          // The tangent, turned to run the way `way` along the border.
          let tx = -(grad[1] ?? 0) / g;
          let tz = (grad[0] ?? 0) / g;
          if ((tx * ux + tz * uz) * way < 0) {
            tx = -tx;
            tz = -tz;
          }
          if (!project(a, b, x + 1.5 * tx, z + 1.5 * tz)) break;
          const nx = point[0] ?? 0;
          const nz = point[1] ?? 0;
          if (!theirs(a, b, nx, nz) || !near(nx, nz, 20)) break;
          const sn = along(nx, nz);
          for (
            let v = Math.ceil(Math.min(s, sn) / V.spacing - phase);
            (v + phase) * V.spacing <= Math.max(s, sn);
            v++
          ) {
            const at = (v + phase) * V.spacing;
            if (at === s || met.has(v)) continue;
            met.add(v);
            const f = (at - s) / (sn - s);
            hedge(a, b, v, x + (nx - x) * f, z + (nz - z) * f);
          }
          x = nx;
          z = nz;
          s = sn;
          least = Math.min(least, s);
          most = Math.max(most, s);
        }
      }
      traced.push(least, most);
    }
  }
  return slots;
}

/** Bilinear sample of channel `c` of an rgba grid (packed.cover), as sampleGrid samples one channel. */
function sampleCover(
  data: Float32Array,
  size: number,
  extent: number,
  x: number,
  z: number,
  c: number,
): number {
  const fx = clamp((x / extent) * size - 0.5, 0, size - 1);
  const fz = clamp((z / extent) * size - 0.5, 0, size - 1);
  const i = Math.min(size - 2, Math.floor(fx));
  const j = Math.min(size - 2, Math.floor(fz));
  const tx = fx - i;
  const tz = fz - j;
  const k = 4 * (j * size + i) + c;
  const a = data[k] ?? 0;
  const b = data[k + 4] ?? 0;
  const d = data[k + 4 * size] ?? 0;
  const e = data[k + 4 * size + 4] ?? 0;
  return (a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz;
}

/** A grown clump: its slot and the depth-sorted index the shader knows it by. */
interface Clump {
  slot: VergeSlot;
  /** Its field's hash (shader.ts: fract(id · 0.618034)), for that field's gust band. */
  field: number;
}

type VergeKnob = "verges" | "wind";

/** The verges' simulation (see the header): placed, grown and swayed while the knob is on. */
export class CountryVerges {
  readonly #knobs: KnobReader<VergeKnob>;
  /** The scene's season knob and its year's cycle, by slot (else the verges keep the harvest). */
  readonly #season: { def: SeasonKnob; at: number; cycle: number } | undefined;
  readonly #climate = plantClimate();
  #terrain: Terrain | undefined;
  /** The frame's aspect the slots were found for, and the view they were found through. */
  #aspect = 0;
  #view: VergeView | undefined;
  #slots: VergeSlot[] = [];
  /** What the clumps were grown for (slots, fullness, rows); empty: none grown. */
  #grown = "";
  #found = 0;
  #plants: RootedPlants | undefined;
  #clumps: Clump[] = [];
  /** Per bin: its clumps (indices into #clumps, nearest first) and the highest top among them. */
  #bins: number[][] = [];
  #tops = new Float64Array(0);
  #push = new Float64Array(0);
  #stillFor = 0;
  #rested = false;
  #wind = 0;
  #year = countryVergeYear(COUNTRY_SEASONS.harvest);
  #fresh = false;
  #moved = false;

  constructor(params: readonly ParamDef[]) {
    const season = seasonKnob(params);
    const cycle = yearCycleKnob(params);
    this.#season = season && {
      def: season,
      at: params.indexOf(season),
      cycle: cycle ? params.indexOf(cycle) : -1,
    };
    this.#knobs = new KnobReader<VergeKnob>("country verges", params, ["verges", "wind"]);
    this.#climate.wind = (_x, _y, out, plant) => {
      out[0] = (out[0] ?? 0) + (this.#push[plant] ?? 0);
    };
  }

  /** The plants grown now (none while the knob is off), for tests. */
  get plants(): RootedPlants | undefined {
    return this.#plants;
  }

  /** The slots on the near ground and the clumps grown in them (by depth), for tests. */
  get slots(): readonly VergeSlot[] {
    return this.#slots;
  }

  get clumps(): readonly VergeSlot[] {
    return this.#clumps.map((clump) => clump.slot);
  }

  /** Whether the latest frame changed what `write` writes. */
  get moved(): boolean {
    return this.#moved;
  }

  /**
   * One frame over the land on screen (`packed`: its textures' data, `uses`: its allocation was
   * repacked this frame): false while the knob is off, when the verges let their plants go.
   */
  frame(frame: SimFrame, terrain: Terrain, packed: TerrainPacked, uses: boolean): boolean {
    const knobs = this.#knobs;
    const fullness = knobs.value(frame, "verges");
    this.#moved = false;
    if (!(fullness > 0)) {
      this.#clear();
      return false;
    }
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const rows = frame.height > 0 ? frame.height : 540;
    const wind = knobs.value(frame, "wind");
    // The year position now (src/climate.ts): the season knob, carried round by its cycle.
    const season = this.#season;
    const date = season
      ? yearNow(
          yearAt(season.def, frame.values[season.at] ?? effective(season.def, {})),
          frame.values[season.cycle] ?? 0,
          frame.motionTime,
        )
      : COUNTRY_SEASONS.harvest;
    const year = countryVergeYear(date);
    if (terrain !== this.#terrain || uses || aspect !== this.#aspect) {
      this.#terrain = terrain;
      this.#aspect = aspect;
      this.#view = vergeView(terrain, aspect);
      this.#slots = vergeSlots(terrain, packed, this.#view);
      this.#found++;
    }
    const grown = `${this.#found}:${fullness}:${rows}`;
    if (grown !== this.#grown) {
      this.#grow(fullness, rows);
      this.#grown = grown;
      this.#moved = true;
    }
    const plants = this.#plants;
    if (!plants) return true;
    const climate = this.#climate;
    const h = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    climate.dt = h;
    climate.time = frame.motionTime;
    climate.season = year;
    climate.air.x = BREEZE * wind;
    climate.air.eddy = EDDY;
    // Each clump's gust: the band rolling over the field it grows into (fieldFlowerMaterial's),
    // drifting with the wind on the motion clock, times the wind.
    const drift = frame.motionTime * wind * 0.22;
    this.#clumps.forEach(({ slot, field }, c) => {
      const band =
        vnoise((slot.x / FIELD_UNIT - drift) * 3.2, (slot.z / FIELD_UNIT) * 1.4 + field * 9) - 0.5;
      this.#push[c] = GUST * wind * band;
    });
    // They swing while the air moves them; once it is still (wind 0) they are set exactly at rest,
    // after SETTLE seconds of swinging out, or at once while time stands still. Freshly grown, and
    // with time standing still when the wind or the year changes, they are set at rest in the air
    // as it is.
    const still = wind === 0;
    this.#stillFor = still ? this.#stillFor + h : 0;
    if (!still) this.#rested = false;
    let settle = this.#fresh || (h === 0 && (wind !== this.#wind || year !== this.#year));
    if (!settle && h > 0) {
      plants.step(climate);
      this.#moved = true;
      settle = still && !this.#rested && this.#stillFor >= SETTLE;
    } else if (!settle) {
      settle = still && !this.#rested;
    }
    if (settle) {
      plants.settle(climate);
      this.#rested = still;
      this.#moved = true;
      this.#fresh = false;
    }
    this.#wind = wind;
    this.#year = year;
    return true;
  }

  /** Rows the verges' block takes in an atlas `width` texels wide. */
  rows(width: number): number {
    const n = this.#clumps.length;
    return (
      Math.ceil((COUNTRY_VERGE.bins * BIN + 2 * n) / width) +
      4 * Math.ceil((n * COUNTRY_VERGE.organs) / width)
    );
  }

  /** Writes the verges' layout texels and their block, from row `row`, into the atlas's rgba texels (`width` a row). */
  write(data: Float32Array, width: number, row: number): void {
    const n = this.#clumps.length;
    const V = COUNTRY_VERGE;
    const view = this.#view;
    const reach = view?.reach ?? 1;
    const clumps = V.bins * BIN;
    const organRow = row + Math.ceil((clumps + 2 * n) / width);
    const texel = (k: number): number => 4 * ((row + Math.floor(k / width)) * width + (k % width));
    const head = 4 * COUNTRY_VERGE_HEAD;
    data[head] = row;
    data[head + 1] = V.bins;
    data[head + 2] = -reach;
    data[head + 3] = (2 * reach) / V.bins;
    data[head + 4] = clumps;
    data[head + 5] = organRow;
    data[head + 6] = n;
    data[head + 7] = 0;
    this.#bins.forEach((list, b) => {
      const at = texel(b * BIN);
      data[at] = this.#tops[b] ?? -1e3;
      data[at + 1] = list.length;
      data[at + 2] = 0;
      data[at + 3] = 0;
      for (let j = 0; j < V.perBin; j++)
        data[texel(b * BIN + 1 + (j >> 2)) + (j & 3)] = list[j] ?? -1;
    });
    this.#clumps.forEach(({ slot }, c) => {
      const a = texel(clumps + 2 * c);
      const b = texel(clumps + 2 * c + 1);
      splitHalf(data, a, slot.x);
      splitHalf(data, a + 2, slot.z);
      splitHalf(data, b, slot.y);
      data[b + 2] = 0;
      data[b + 3] = 0;
    });
    const records = n * V.organs;
    data.fill(0, 4 * organRow * width, 4 * (organRow + 4 * Math.ceil(records / width)) * width);
    if (this.#plants) writePlantRecords(this.#plants, data, width, organRow, records);
  }

  #clear(): void {
    this.#terrain = undefined;
    this.#view = undefined;
    this.#slots = [];
    this.#plants = undefined;
    this.#clumps = [];
    this.#bins = [];
    this.#grown = "";
  }

  /**
   * Grows a clump in each slot the fullness takes, nearest first, for a frame `rows` cells high
   * (each organ's tier), and bins them by bearing.
   */
  #grow(fullness: number, rows: number): void {
    const V = COUNTRY_VERGE;
    const view = this.#view;
    const taken = this.#slots
      .filter((slot) => slot.keep < fullness)
      .sort((a, b) => a.depth - b.depth)
      .slice(0, V.most);
    const plants = new RootedPlants(Math.max(1, taken.length * V.organs), 0x7665);
    for (const [c, slot] of taken.entries()) {
      plants.add(
        slot.pick < 0.45 ? COW_PARSLEY : slot.pick < 0.7 ? RED_CAMPION : TUSSOCK,
        {
          x: 0,
          y: 0,
          heading: Math.PI / 2,
          moisture: 0.5,
          lush: slot.lush,
          cells: (V.large * FOCAL * rows) / slot.depth,
          kind: slot.kind,
          slot: c * V.organs,
        },
        NO_DRAWS,
      );
    }
    this.#plants = plants;
    this.#clumps = taken.map((slot) => ({ slot, field: fract((slot.into + 1) * 0.618034) }));
    this.#push = new Float64Array(taken.length);
    const bins: number[][] = Array.from({ length: V.bins }, () => []);
    const tops = new Float64Array(V.bins).fill(-1e3);
    if (view) {
      const width = (2 * view.reach) / V.bins;
      taken.forEach((slot, c) => {
        const across = (slot.x - view.x) * view.rx + (slot.z - view.z) * view.rz;
        const bearing = across / slot.depth;
        const half = (V.wide * V.large + 0.3) / slot.depth;
        const top = (slot.y + V.tall * V.large - view.y) / slot.depth + 0.002;
        const b0 = Math.max(0, Math.floor((bearing - half + view.reach) / width));
        const b1 = Math.min(V.bins - 1, Math.floor((bearing + half + view.reach) / width));
        for (let b = b0; b <= b1; b++) {
          const list = bins[b];
          if (!list || list.length >= V.perBin) continue;
          list.push(c);
          tops[b] = Math.max(tops[b] ?? -1e3, top);
        }
      });
    }
    this.#bins = bins;
    this.#tops = tops;
    this.#stillFor = 0;
    this.#rested = false;
    this.#fresh = true;
  }
}

const F = COUNTRY_VERGE_FORM;

export const countryVergesGlsl = /* glsl */ `
#if COUNTRY_HAS_VERGES
${plantsGlsl}
// ---- the verges (verges.ts) ----
const int COUNTRY_VERGE_HEAD = ${COUNTRY_VERGE_HEAD};
const int COUNTRY_VERGE_ORGANS = ${COUNTRY_VERGE.organs};
const int COUNTRY_VERGE_BIN = ${BIN};
const float COUNTRY_VERGE_TALL = ${glslFloat(COUNTRY_VERGE.tall)};
const float COUNTRY_VERGE_WIDE = ${glslFloat(COUNTRY_VERGE.wide)};
const float COUNTRY_VERGE_LARGE = ${glslFloat(COUNTRY_VERGE.large)};
const float COUNTRY_VERGE_SINK = 0.5;   // metres a root may lie past the surface the ray met: its own ground

// A clump covering the pixel: cover 1 on it; z its root's camera depth (else the limit it was
// looked up against), root its root (map metres); up how much of what covers the pixel faces the
// sky (where lying snow settles).
struct CountryVerge { float cover; float z; vec3 albedo; float up; vec3 root; };

// Texel k of the verges' block (from atlas row 'row', 'width' texels a row).
vec4 countryVergeTexel(int row, int width, int k) {
  return texelFetch(uSim3, ivec2(k - (k / width) * width, row + k / width), 0);
}

// Organ o of a clump at m (life metres from the clump's root, y up); foot: a cell in those metres.
// Stems, leaves and blades are arcs turning their curl (a) plus the bend, a stem never under a cell
// and a half wide (so a swaying one stays whole once cut per cell), a leaf or blade a cell; a
// flower head an ellipse from its stem's tip along it, never under a cell. Returns the coverage;
// along: how far along the organ (0 base .. 1 tip); up: how much of it faces the sky.
float countryVergeOrgan(PlantOrgan o, vec2 m, float foot, out float along, out float up) {
  vec2 l = plantLocal(m, o);
  along = 0.0;
  up = 0.8;
  if (o.form > ${F.umbel - 0.5} && o.form < ${F.umbel + 0.5} || o.form > ${F.campion - 0.5} && o.form < ${F.campion + 0.5} || o.form > ${F.panicle - 0.5}) {
    float len = max(o.len, foot);
    float girth = max(0.5 * o.width, 0.55 * foot);
    along = clamp(l.x / len, 0.0, 1.0);
    float e = length(vec2(2.0 * l.x / len - 1.0, l.y / girth));
    float aa = 0.5 * foot / girth;
    return smoothfall(1.0 + aa, 1.0 - aa, e);
  }
  float s = 0.0;
  float dist = plantArc(l, o.len, o.a + o.bend, s);
  if (s < 0.0 || s > 1.0) return 0.0;
  along = s;
  // Its width along it: stems taper a little, the ferny parsley leaf is broad near its base, the
  // campion's leaf oval, a blade narrows to its tip.
  float shape = 1.0 - 0.35 * s;
  float least = 0.75 * foot;
  up = 0.2;
  if (o.form > ${F.parsleyLeaf - 0.5} && o.form < ${F.parsleyLeaf + 0.5}) shape = smoothstep(0.0, 0.2, s) * (1.0 - 0.85 * s);
  else if (o.form > ${F.campionLeaf - 0.5} && o.form < ${F.campionLeaf + 0.5}) shape = sin(3.14159265 * s);
  else if (o.form > ${F.blade - 0.5} && o.form < ${F.blade + 0.5}) shape = 1.0 - 0.85 * s;
  if (o.form > ${F.parsleyLeaf - 0.5} && o.form < ${F.parsleyLeaf + 0.5} || o.form > ${F.campionLeaf - 0.5} && o.form < ${F.campionLeaf + 0.5} || o.form > ${F.blade - 0.5} && o.form < ${F.blade + 0.5}) {
    least = 0.5 * foot;
    up = 0.45;
  }
  float girth = max(0.5 * o.width * shape, least);
  return smoothfall(girth + 0.5 * foot, girth - 0.5 * foot, abs(dist));
}

// An organ's colour by its form, its phenology, how far along it the pixel lies and the farming
// year (x how far toward the harvest's seed and straw, y toward autumn's browning, both back to
// green in spring: countryKeys): the parsley's stems die back brown once it has seeded, the
// campion's late in autumn, the grass and its heads go to straw.
vec3 countryVergeColour(float form, float pheno, float along, vec2 year) {
  float harvest = year.x;
  float autumn = year.y;
  vec3 c = vec3(0.86, 0.2, 0.46);
  if (form < ${F.parsleyStem + 0.5}) c = mix(vec3(0.32, 0.45, 0.17), vec3(0.5, 0.41, 0.27), 0.55 * harvest + 0.4 * autumn);
  else if (form < ${F.parsleyLeaf + 0.5}) c = plantPhenology(vec3(0.3, 0.5, 0.15), pheno);
  else if (form < ${F.umbel + 0.5}) c = vec3(0.95, 0.94, 0.87);
  else if (form < ${F.campionStem + 0.5}) c = mix(vec3(0.28, 0.4, 0.15), vec3(0.42, 0.33, 0.22), 0.5 * autumn);
  else if (form < ${F.campionLeaf + 0.5}) c = plantPhenology(vec3(0.24, 0.42, 0.13), pheno);
  else if (form < ${F.blade - 0.5}) c = vec3(0.88, 0.22, 0.5);
  else if (form < ${F.blade + 0.5}) c = mix(plantPhenology(vec3(0.36, 0.52, 0.19), pheno), vec3(0.62, 0.55, 0.32), 0.25 * harvest + 0.3 * autumn);
  else if (form < ${F.culm + 0.5}) c = mix(vec3(0.38, 0.47, 0.2), vec3(0.66, 0.58, 0.36), 0.5 * harvest + 0.3 * autumn);
  else c = mix(vec3(0.55, 0.46, 0.42), vec3(0.68, 0.6, 0.4), 0.6 * harvest + 0.4 * autumn);
  return c * (0.75 + 0.35 * along);
}

// The clump over pinhole point q (cellAngle: a cell there) nearer than camera depth zLimit (the
// pixel's first surface), from the eye: the nearest of the clumps its bearing's bin lists whose
// organs cover it. mapped: the atlas is bound.
CountryVerge countryVergeAt(bool mapped, vec3 eye, vec2 q, float cellAngle, float zLimit) {
  CountryVerge v = CountryVerge(0.0, zLimit, vec3(0.0), 0.0, vec3(0.0));
  if (!mapped || K_verges <= 0.0) return v;
  vec4 grid = texelFetch(uSim3, ivec2(COUNTRY_VERGE_HEAD, 0), 0);
  int bin = int(floor((q.x - grid.z) / grid.w));
  if (bin < 0 || bin >= int(grid.y + 0.5)) return v;
  int row = int(grid.x + 0.5);
  int width = textureSize(uSim3, 0).x;
  vec4 head = countryVergeTexel(row, width, bin * COUNTRY_VERGE_BIN);
  if (q.y > head.x) return v;
  vec4 more = texelFetch(uSim3, ivec2(COUNTRY_VERGE_HEAD + 1, 0), 0);
  int clumps = int(more.x + 0.5);
  int organs = int(more.y + 0.5);
  vec2 year = vec2(countryKeys(0.0, 1.0, 1.0, 1.0, 0.0), countryKeys(0.0, 0.0, 1.0, 1.0, 0.0));
  int count = int(head.y + 0.5);
  for (int j = 0; j < count; j++) {
    vec4 four = countryVergeTexel(row, width, bin * COUNTRY_VERGE_BIN + 1 + j / 4);
    int c = int(four[j - (j / 4) * 4] + 0.5);
    vec4 xz = countryVergeTexel(row, width, clumps + 2 * c);
    vec4 hy = countryVergeTexel(row, width, clumps + 2 * c + 1);
    vec3 root = vec3(xz.x + xz.y, hy.x + hy.y, xz.z + xz.w);
    vec3 d = root - eye;
    float zc = dot(d, countryFwd);
    // Nearest first: the rest stand behind this pixel's surface too.
    if (zc >= zLimit + COUNTRY_VERGE_SINK) break;
    float metre = COUNTRY_VERGE_LARGE / zc;
    vec2 m = (q - vec2(dot(d, countryRight), d.y) / zc) / metre;
    float foot = cellAngle / metre;
    if (abs(m.x) > COUNTRY_VERGE_WIDE + foot || m.y < -foot || m.y > COUNTRY_VERGE_TALL + foot) continue;
    // Back to front: leaves, stems, heads; the last covering organ is the one seen.
    for (int k = 0; k < COUNTRY_VERGE_ORGANS; k++) {
      PlantOrgan o = plantOrgan(uSim3, organs, c * COUNTRY_VERGE_ORGANS + k);
      if (o.tier < 0.5) continue;
      float at = 0.0;
      float up = 0.0;
      if (hardEdge(countryVergeOrgan(o, m, foot, at, up)) < 0.5) continue;
      v.cover = 1.0;
      v.albedo = countryVergeColour(o.form, o.pheno, at, year);
      v.up = up;
    }
    if (v.cover > 0.5) {
      v.z = zc;
      v.root = root;
      break;
    }
  }
  return v;
}
#endif
`;
