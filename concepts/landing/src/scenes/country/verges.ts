// The verges (`verges`, off by default): clumps of cow parsley, red campion and tussock grass at
// the foot of the hedges on the two near ridges, grown by the shared plant component
// (sims/plants.ts, shaders/lib/plants.ts). The simulation (CountryVerges) owns what happens: which
// clumps grow where, their stems, leaves and flower heads, each organ swaying on its spring under
// the scene's wind and the gust bands that roll across the crops (the same band as
// countryCropColor's, in the field each clump grows into), and the farming year (K_season)
// flowering, browning and shedding them. The shader (countryVerge) owns where they stand on screen
// and how they look, and keeps them off what they must not grow on.
//
// Layout. A field border between two of countryCells' fields carries two clump slots, a sixth of a
// field either side of the midpoint between the fields' sites (the hedgerow trees stand at the
// midpoint and three tenths out), set in from the hedge line into one of the two fields. The
// border belongs to the cell whose neighbour across it lies east, north-west, north or north-east
// of it, so each border is counted once: slot ((cell · 4 + border) · 2 + clump) of a window of
// cells per ridge that covers everything the ridge can show (countryVergeWindow: the frame's width
// with the pointer's parallax, from the crest down to the frame's foot or the first ridge's lowest
// crest). The sim grows a clump in a slot when the slot lies on its border (well clear of every
// other border, so the pixels around it see the same two fields) and the fullness knob takes it,
// the slots' own hashes deciding (a fuller verge keeps a sparser one's clumps). The side it grows
// into is a hash the shader and the sim both take; a clump on the side of a grazed pasture grows
// into the other field instead, and none grows between two pastures (the herds keep the hedge foot
// bare). The shader draws nothing where the slot's root falls on a track, a farm track or the
// lane, in the river or its reeds, or by a building's footprint.
//
// Frame. Each clump is rooted at the origin of its own frame, x right on screen, y up, in metres
// drawn COUNTRY_VERGE.large times life size (twice, as the scene draws its birds, so they read
// across the fields), standing upright on the slope as the hedgerow trees and the walkers do.
// Every organ's tier comes from its projected size at its root's depth.
//
// Textures: uSim2 rgba16f PlantTexture, 256 wide. Row 0: texel i the window of near ridge i (its
// first cell x and y in field space, columns, rows). From row 1 the organ records
// (sims/plants.ts), COUNTRY_VERGE.organs per slot, ridge 0's slots first; an empty slot's records
// draw nothing. Records' a: a flexible organ's rest curl (the shader turns it by a + bend).
//
// The sim is composed with the murmuration's flock into one SimFactory (countrySim): uSim0 and
// uSim1 stay the flock's. The verges' code is compiled in only while the knob is on
// (COUNTRY_HAS_VERGES, index.ts), so the default program and frame carry none of it; while it is
// off the sim grows no plants and hands the shader no texture.
import { KnobReader, type ParamDef } from "../../params.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";
import { clamp, fract, glslHash12, glslHash22, hash31, lerp, smoothstep } from "../../sims/math.ts";
import {
  PlantHabit,
  PlantRole,
  PlantTexture,
  RootedPlants,
  plantClimate,
  type PlantSite,
  type PlantSpecies,
} from "../../sims/plants.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** The verges' layout and reach (shared with the shader). */
export const COUNTRY_VERGE = {
  /** Organ records per clump slot. */
  organs: 6,
  /** Field units either side of a border's midpoint along it, where its two clumps stand. */
  along: 1 / 6,
  /** Field units a clump stands in from the hedge line, into its field. */
  inset: 0.035,
  /** Field units a slot's root keeps from every other border (sim): its pixels see its own two fields. */
  clear: 0.06,
  /** The most a clump reaches above its root and either side of it, metres. */
  tall: 1.6,
  wide: 0.8,
  /** How much larger than life the clumps are drawn. */
  large: 2,
  /** World units a root keeps from a track's edge, the reeds or a building's footprint. */
  keep: 0.006,
  /** The most cells a ridge's window holds across and down the slope (a very wide frame's ends go bare). */
  cols: 28,
  rows: 14,
} as const;

/** Clump slots per window cell: four borders, two clumps each. */
const SLOTS = 8;
/** Records a row of uSim2 holds. */
const WIDTH = 256;

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

// The countryside's world, as shader.ts has it.
const METRES = 120;
/** The clumps' metres a world unit, drawn large. */
const SCALE = METRES / COUNTRY_VERGE.large;
const FIELDS_X = 3;
const FIELDS_Y = 4.2;
const SLOPE = 1.25;
const ROUND = 0.004;

/** Ridge i's depth and the bounds of its crest: countryLayer's baseline ± swell. */
function layer(i: number): { depth: number; low: number; high: number } {
  const depth = 1.65 ** i;
  const base = 0.62 - 0.36 / depth;
  const swell = 0.16 / Math.sqrt(depth);
  return { depth, low: base - swell, high: base + swell };
}

/** countryDown: the slope distance (world) at screen drop s below the crest of a ridge at depth d. */
function down(s: number, d: number): number {
  return d * SLOPE * (Math.sqrt(Math.max(s, 0) + ROUND) - Math.sqrt(ROUND));
}

/** countryDrop: the screen drop below the crest of slope distance v. */
function drop(v: number, d: number): number {
  const r = Math.max(v, 0) / (d * SLOPE) + Math.sqrt(ROUND);
  return r * r - ROUND;
}

/** a + b as the shader adds two floats. */
const f32add = (a: number, b: number): number => Math.fround(Math.fround(a) + Math.fround(b));

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

/** The site of field-space cell (x, y), as countryCells places it, into out[0], out[1]. */
function fieldSite(x: number, y: number, out: Float64Array): void {
  out[0] = x + 0.15 + 0.7 * glslHash12(f32add(x, 0.31), f32add(y, 0.31));
  out[1] = y + 0.15 + 0.7 * glslHash12(f32add(x, 5.77), f32add(y, 5.77));
}

/** Field (x, y)'s hash, as countryCells returns it (countryFieldCrop's input). */
const fieldHash = (x: number, y: number): number =>
  glslHash12(f32add(x, 0.71), f32add(y, 0.71));

/** The landscape knob's field-space offset (countrySeed) into out. */
function landscapeSeed(landscape: number, out: Float64Array): void {
  if (landscape < 0.5) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  glslHash22(landscape, 17.3, out);
  out[0] = ((out[0] ?? 0.5) - 0.5) * 32;
  out[1] = ((out[1] ?? 0.5) - 0.5) * 32;
}

/** A ridge's window of field-space cells: its first cell and how many across and down. */
export interface VergeWindow {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

/**
 * The cells whose borders' clumps near ridge `ridge` (0 or 1) can show in a frame `aspect` wide,
 * for the landscape offset (seedX, seedY): what countryVerge can look up, wherever the pointer's
 * parallax and the passage move the land. A border's owner is at most a cell from the cell a pixel
 * looks it up in.
 */
export function countryVergeWindow(
  ridge: number,
  aspect: number,
  seedX: number,
  seedY: number,
): VergeWindow {
  const { depth, high } = layer(ridge);
  const reach = COUNTRY_VERGE.tall / (SCALE * 0.65 * depth);
  const wide = COUNTRY_VERGE.wide / (SCALE * 0.65 * depth);
  // The lowest the ridge shows: the frame's foot, or for the second the first's lowest crest; the
  // pointer moves each ridge up to 0.01 / depth.
  const bottom = ridge === 0 ? -0.01 : layer(0).low - 0.02;
  const half = aspect / 2 + 0.022 / depth + wide;
  // Field space round the lookups: the warp moves a point up to a quarter field, a root lies up to
  // along + inset from its border's midpoint.
  const pad = 0.25 + COUNTRY_VERGE.along + COUNTRY_VERGE.inset;
  const x0 = -half * depth * FIELDS_X + 31.7 * ridge + seedX - pad;
  const x1 = half * depth * FIELDS_X + 31.7 * ridge + seedX + pad;
  const y0 = 7.3 * ridge + seedY - pad;
  const y1 = down(high - bottom + reach, depth) * FIELDS_Y + 7.3 * ridge + seedY + pad;
  let x = Math.floor(x0) - 1;
  let y = Math.floor(y0) - 1;
  let cols = Math.floor(x1) + 2 - x;
  const rows = Math.min(Math.floor(y1) + 2 - y, COUNTRY_VERGE.rows);
  if (cols > COUNTRY_VERGE.cols) {
    x += Math.floor((cols - COUNTRY_VERGE.cols) / 2);
    cols = COUNTRY_VERGE.cols;
  }
  return { x, y, cols, rows };
}

// ---- the plants -------------------------------------------------------------------------------

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

/** The plant year (sims/plants.ts) for each of K_season's farming seasons: early summer, the harvest in August, mid-autumn. */
export const COUNTRY_VERGE_YEAR = [0.3, 0.47, 0.66] as const;
/** Push per unit of the wind knob: the steady breeze, the eddies on it (a share of it), and the gust bands at their strongest (the band runs -0.5..0.5). */
const BREEZE = 1;
const EDDY = 0.4;
const GUST = 1.2;
/** Seconds of still air (wind 0) after which the clumps are set exactly at rest. */
const SETTLE = 6;

/** Where a clump grows, for the gust bands it stands in. */
interface VergeRoot {
  /** Its slope point (world). */
  x: number;
  y: number;
  /** The hashes of the field it grows into first and of the other (countryFieldCrop's input). */
  into: number;
  other: number;
}

type VergeKnob =
  | "verges"
  | "wind"
  | "season"
  | "landscape"
  | "crops"
  | "wildflowers"
  | "lavender"
  | "sunflowers"
  | "pasture";

/** The verges' simulation (see the header): uSim2, or nothing while the knob is off. */
export class CountryVerges {
  readonly #gl: WebGL2RenderingContext;
  readonly #knobs: KnobReader<VergeKnob>;
  readonly #climate = plantClimate();
  #plants: RootedPlants | undefined;
  #records: PlantTexture | undefined;
  #roots: VergeRoot[] = [];
  #push = new Float64Array(0);
  /** What the plants were grown for (aspect, rows, landscape, fullness); empty: none grown. */
  #layout = "";
  #stillFor = 0;
  #rested = false;
  #wind = 0;
  #year: number = COUNTRY_VERGE_YEAR[1];
  /** Set by #grow: this frame sets the new plants at rest in its air. */
  #fresh = false;
  readonly #site = new Float64Array(2);
  readonly #seed = new Float64Array(2);

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#gl = gl;
    this.#knobs = new KnobReader<VergeKnob>("country verges", params, [
      "verges",
      "wind",
      "season",
      "landscape",
      "crops",
      "wildflowers",
      "lavender",
      "sunflowers",
      "pasture",
    ]);
    this.#climate.wind = (_x, _y, out, plant) => {
      out[0] = (out[0] ?? 0) + (this.#push[plant] ?? 0);
    };
  }

  /** The plants grown now (none while the knob is off), for tests. */
  get plants(): RootedPlants | undefined {
    return this.#plants;
  }

  frame(frame: SimFrame): WebGLTexture | undefined {
    const knobs = this.#knobs;
    const fullness = knobs.value(frame, "verges");
    if (!(fullness > 0)) {
      this.#clear();
      return undefined;
    }
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const rows = frame.height > 0 ? frame.height : 540;
    const landscape = Math.round(knobs.value(frame, "landscape"));
    const wind = knobs.value(frame, "wind");
    const year =
      COUNTRY_VERGE_YEAR[clamp(Math.round(knobs.value(frame, "season")), 0, 2)] ??
      COUNTRY_VERGE_YEAR[1];
    const climate = this.#climate;
    const h = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    climate.dt = h;
    climate.time = frame.motionTime;
    climate.season = year;
    climate.air.x = BREEZE * wind;
    climate.air.eddy = EDDY;
    const layout = `${aspect}:${rows}:${landscape}:${fullness}`;
    if (layout !== this.#layout) {
      this.#grow(aspect, rows, landscape, fullness);
      this.#layout = layout;
    }
    const plants = this.#plants;
    const records = this.#records;
    if (!plants || !records) return undefined;
    this.#gusts(frame, wind);
    // They swing while the air moves them; once it is still (wind 0) they are set exactly at rest,
    // after SETTLE seconds of swinging out, or at once while time stands still. Freshly grown, and
    // with time standing still when the wind or the year changes, they are set at rest in the air
    // as it is.
    const still = wind === 0;
    this.#stillFor = still ? this.#stillFor + h : 0;
    if (!still) this.#rested = false;
    let settle = this.#fresh || (h === 0 && (wind !== this.#wind || year !== this.#year));
    let moved = false;
    if (!settle && h > 0) {
      plants.step(climate);
      moved = true;
      settle = still && !this.#rested && this.#stillFor >= SETTLE;
    } else if (!settle) {
      settle = still && !this.#rested;
    }
    if (settle) {
      plants.settle(climate);
      this.#rested = still;
      moved = true;
      this.#fresh = false;
    }
    this.#wind = wind;
    this.#year = year;
    if (moved) {
      records.pack(plants);
      records.upload();
    }
    return records.texture;
  }

  dispose(): void {
    this.#clear();
  }

  #clear(): void {
    this.#records?.dispose();
    this.#records = undefined;
    this.#plants = undefined;
    this.#roots = [];
    this.#layout = "";
  }

  /**
   * Grows the clumps for a frame `aspect` wide and `rows` cells high (each organ's tier), the
   * landscape and the fullness (see the header), and writes the windows into uSim2's first row.
   */
  #grow(aspect: number, rows: number, landscape: number, fullness: number): void {
    this.#records?.dispose();
    const seed = this.#seed;
    landscapeSeed(landscape, seed);
    const seedX = seed[0] ?? 0;
    const seedY = seed[1] ?? 0;
    const windows = [0, 1].map((ridge) => countryVergeWindow(ridge, aspect, seedX, seedY));
    const grown: { species: PlantSpecies; site: PlantSite; root: VergeRoot }[] = [];
    let first = 0;
    windows.forEach((win, ridge) => {
      const sites = this.#sites(win);
      const at = (x: number, y: number, c: 0 | 1): number =>
        sites.data[((y - sites.y) * sites.cols + (x - sites.x)) * 2 + c] ?? 0;
      const d = 1.65 ** ridge;
      for (let cy = 0; cy < win.rows; cy++) {
        for (let cx = 0; cx < win.cols; cx++) {
          const ax = win.x + cx;
          const ay = win.y + cy;
          for (let border = 0; border < 4; border++) {
            // East, then north-west, north and north-east.
            const bx = ax + (border === 0 ? 1 : border - 2);
            const by = ay + (border === 0 ? 0 : 1);
            const sax = at(ax, ay, 0);
            const say = at(ax, ay, 1);
            const sbx = at(bx, by, 0);
            const sby = at(bx, by, 1);
            const gap = Math.hypot(sbx - sax, sby - say);
            const abx = (sbx - sax) / gap;
            const aby = (sby - say) / gap;
            for (let j = 0; j < 2; j++) {
              const n = border * 2 + j;
              const toward = j === 0 ? -COUNTRY_VERGE.along : COUNTRY_VERGE.along;
              const px = 0.5 * (sax + sbx) - aby * toward;
              const py = 0.5 * (say + sby) + abx * toward;
              if (!onBorder(px, py, ax, ay, bx, by, at)) continue;
              const salt = (ridge * SLOTS + n) ^ 0x7665;
              if (hash31(ax, ay, salt) >= fullness) continue;
              // countryVerge's hash: the field it grows into (-1 the owner's), before pastures.
              const side = glslHash12(ax + 0.25 * n + 0.125, ay + 0.375) < 0.5 ? -1 : 1;
              const rx = px + abx * side * COUNTRY_VERGE.inset;
              const ry = py + aby * side * COUNTRY_VERGE.inset;
              const w = this.#slopePoint(ridge, rx, ry, seedX, seedY);
              const z = d * (1 - 0.35 * smoothstep(0, 0.2, drop(w[1] ?? 0, d)));
              const pick = hash31(ax, ay, salt ^ 0x5e5e);
              const kind = Math.imul(ax, 0x2c1b3c6d) ^ Math.imul(ay, 0x297a2d39) ^ salt;
              const hA = fieldHash(ax, ay);
              const hB = fieldHash(bx, by);
              grown.push({
                species: pick < 0.45 ? COW_PARSLEY : pick < 0.7 ? RED_CAMPION : TUSSOCK,
                site: {
                  x: 0,
                  y: 0,
                  heading: Math.PI / 2,
                  moisture: 0.5,
                  lush: 0.75 + 0.25 * hash31(ax, ay, salt ^ 0x6c75),
                  cells: rows / (z * SCALE),
                  kind,
                  slot: ((first + cy * win.cols + cx) * SLOTS + n) * COUNTRY_VERGE.organs,
                },
                root: {
                  x: w[0] ?? 0,
                  y: w[1] ?? 0,
                  into: side < 0 ? hA : hB,
                  other: side < 0 ? hB : hA,
                },
              });
            }
          }
        }
      }
      first += win.cols * win.rows;
    });
    const plants = new RootedPlants(Math.max(1, grown.length * COUNTRY_VERGE.organs), landscape);
    for (const { species, site } of grown) plants.add(species, site, NO_DRAWS);
    const records = new PlantTexture(this.#gl, Math.max(1, first * SLOTS * COUNTRY_VERGE.organs), {
      width: WIDTH,
      rowBase: 1,
    });
    windows.forEach((win, ridge) => {
      records.data.set([win.x, win.y, win.cols, win.rows], ridge * 4);
    });
    this.#plants = plants;
    this.#records = records;
    this.#roots = grown.map((entry) => entry.root);
    this.#push = new Float64Array(grown.length);
    this.#stillFor = 0;
    this.#rested = false;
    this.#fresh = true;
  }

  /** The field sites of the window and two cells round it: data[(row · cols + col) · 2 + 0..1]. */
  #sites(win: VergeWindow): { x: number; y: number; cols: number; data: Float64Array } {
    const x = win.x - 2;
    const y = win.y - 2;
    const cols = win.cols + 5;
    const rows = win.rows + 5;
    const data = new Float64Array(cols * rows * 2);
    const site = this.#site;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        fieldSite(x + c, y + r, site);
        data[(r * cols + c) * 2] = site[0] ?? 0;
        data[(r * cols + c) * 2 + 1] = site[1] ?? 0;
      }
    }
    return { x, y, cols, data };
  }

  /** countryFieldSpace inverted (countryFieldPoint's three steps): the slope point of field point (fx, fy) on ridge i. */
  #slopePoint(i: number, fx: number, fy: number, seedX: number, seedY: number): Float64Array {
    let x = fx;
    let y = fy;
    for (let k = 0; k < 3; k++) {
      const nx = fx - 0.5 * (vnoise(x * 0.55 + 3.1, y * 0.55 + 3.1) - 0.5);
      const ny = fy - 0.5 * (vnoise(x * 0.55 + 8.7, y * 0.55 + 8.7) - 0.5);
      x = nx;
      y = ny;
    }
    const out = this.#site;
    out[0] = (x - 31.7 * i - seedX) / FIELDS_X;
    out[1] = (y - 7.3 * i - seedY) / FIELDS_Y;
    return out;
  }

  /**
   * Each clump's gust this frame: countryCropColor's band in the field it grows into (the other
   * one where that is a grazed pasture, as countryVerge places it), drifting with the wind on the
   * motion clock, times the wind.
   */
  #gusts(frame: SimFrame, wind: number): void {
    const knobs = this.#knobs;
    const pasture = knobs.value(frame, "pasture");
    const total =
      knobs.value(frame, "crops") +
      knobs.value(frame, "wildflowers") +
      knobs.value(frame, "lavender") +
      knobs.value(frame, "sunflowers") +
      pasture;
    // countryFieldCrop: a field is a pasture from this hash up.
    const grazed = pasture > 0 && total > 0 ? 1 - pasture / total : 2;
    const drift = frame.motionTime * wind * 0.35;
    const push = this.#push;
    this.#roots.forEach((root, p) => {
      const field = root.into >= grazed ? root.other : root.into;
      const band = vnoise((root.x - drift) * 3.2, root.y * 1.4 + field * 9) - 0.5;
      push[p] = GUST * wind * band;
    });
  }
}

/**
 * Whether field point (px, py), on the bisector of cells a and b, sees them as its two nearest
 * fields with COUNTRY_VERGE.clear to spare against every other site round them (`at` reads a site).
 */
function onBorder(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  at: (x: number, y: number, c: 0 | 1) => number,
): boolean {
  const sax = at(ax, ay, 0);
  const say = at(ax, ay, 1);
  const own = (px - sax) ** 2 + (py - say) ** 2;
  for (let y = Math.min(ay, by) - 2; y <= Math.max(ay, by) + 2; y++) {
    for (let x = Math.min(ax, bx) - 2; x <= Math.max(ax, bx) + 2; x++) {
      if ((x === ax && y === ay) || (x === bx && y === by)) continue;
      const sx = at(x, y, 0);
      const sy = at(x, y, 1);
      // How far the point lies on a's side of the bisector between a and this site.
      const margin = ((px - sx) ** 2 + (py - sy) ** 2 - own) / (2 * Math.hypot(sx - sax, sy - say));
      if (margin < COUNTRY_VERGE.clear) return false;
    }
  }
  return true;
}

/**
 * The countryside's simulation: the murmuration's flock (`flock`: uSim0, uSim1) and the verges
 * (uSim2), each idle while its knob is off.
 */
export function countrySim(flock: SimFactory, params: readonly ParamDef[]): SimFactory {
  return (gl): SceneSim => {
    const birds = flock(gl);
    const verges = new CountryVerges(gl, params);
    const textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined];
    return {
      frame(frame) {
        const flown = birds.frame(frame);
        textures[0] = flown[0];
        textures[1] = flown[1];
        textures[2] = verges.frame(frame);
        return textures;
      },
      dispose() {
        birds.dispose();
        verges.dispose();
      },
    };
  };
}

const F = COUNTRY_VERGE_FORM;

export const countryVergesGlsl = /* glsl */ `
#if COUNTRY_HAS_VERGES
${plantsGlsl}
// ---- the verges (verges.ts) ----
const int COUNTRY_VERGE_ORGANS = ${COUNTRY_VERGE.organs};
const float COUNTRY_VERGE_ALONG = ${glslFloat(COUNTRY_VERGE.along)};
const float COUNTRY_VERGE_INSET = ${glslFloat(COUNTRY_VERGE.inset)};
const float COUNTRY_VERGE_TALL = ${glslFloat(COUNTRY_VERGE.tall)};
const float COUNTRY_VERGE_WIDE = ${glslFloat(COUNTRY_VERGE.wide)};
const float COUNTRY_VERGE_SCALE = ${glslFloat(SCALE)};    // the clumps' metres a world unit, drawn large
const float COUNTRY_VERGE_KEEP = ${glslFloat(COUNTRY_VERGE.keep)};

// A clump covering the pixel: cover 1 on it; drop how far below the pixel its root lies on screen
// (of two, the lower root stands nearer); z its root's depth; up how much of what covers the pixel
// faces the sky (where lying snow settles).
struct CountryVerge { float cover; float drop; float z; vec3 albedo; float up; };

CountryVerge countryVergeNone() {
  return CountryVerge(0.0, -1e3, 0.0, vec3(0.0), 0.0);
}

// Organ o of a clump at m (metres from the clump's root, y up); foot: a cell in metres. Stems,
// leaves and blades are arcs turning their curl (a) plus the bend, a stem never under a cell and a
// half wide (so a swaying one stays whole once cut per cell), a leaf or blade a cell; a flower
// head an ellipse from its stem's tip along it, never under a cell. Returns the coverage; along:
// how far along the organ (0 base .. 1 tip); up: how much of it faces the sky.
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
// year (K_season: 0 summer, 1 harvest, 2 autumn): the parsley's stems die back brown once it has
// seeded, the campion's late in autumn, the grass and its heads go to straw.
vec3 countryVergeColour(float form, float pheno, float along, float season) {
  float harvest = step(0.5, season);
  float autumn = step(1.5, season);
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

// The clump covering pixel qi of near ridge i (bare crest c), standing up over the face and its
// crest; the nearest root wins. Each slot's root is placed from the field border the pixel sees
// half a clump's height below it, as the sim placed it (verges.ts), and is not drawn on a track,
// the lane or a farm track, in the river or its reeds, or by a building.
CountryVerge countryVerge(float i, vec2 qi, float c, vec2 spots) {
  CountryVerge v = countryVergeNone();
  if (K_verges <= 0.0 || uSimOn.z < 0.5) return v;
  float d = countryLayer(i).x;
  // The tallest clump on screen, and its reach either side, where the face comes nearest.
  float reach = COUNTRY_VERGE_TALL / (COUNTRY_VERGE_SCALE * 0.65 * d);
  float wide = COUNTRY_VERGE_WIDE / (COUNTRY_VERGE_SCALE * 0.65 * d);
  float s = c - qi.y;
  if (s < -reach) return v;
  float sL = max(s + 0.5 * reach, 0.0);
  float rate = countryDownRate(sL, d);
  vec2 wL = vec2(qi.x * d, countryDown(sL, d));
  vec2 fL = countryFieldSpace(i, wL);
  vec2 site = vec2(0.0);
  vec2 other = vec2(0.0);
  vec2 axis = vec2(0.0);
  countryCells(fL, site, other, axis);
  // The border's owner: the cell whose neighbour across it lies east, north-west, north or
  // north-east.
  vec2 a = floor(site);
  vec2 toward = floor(other) - a;
  if (toward.y < 0.0 || (toward.y == 0.0 && toward.x < 0.0)) {
    vec2 swap = site;
    site = other;
    other = swap;
    a = floor(site);
    toward = -toward;
  }
  if (toward.y > 1.5 || abs(toward.x) > 1.5) return v;
  float border = toward.y < 0.5 ? 0.0 : toward.x + 2.0;
  vec4 win0 = texelFetch(uSim2, ivec2(0, 0), 0);
  vec4 win = i < 0.5 ? win0 : texelFetch(uSim2, ivec2(1, 0), 0);
  vec2 cell = a - win.xy;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= win.z || cell.y >= win.w) return v;
  float slots = ((i < 0.5 ? 0.0 : win0.z * win0.w) + cell.y * win.z + cell.x) * 8.0 + border * 2.0;
  vec2 ab = normalize(other - site);
  vec2 along = vec2(-ab.y, ab.x);
  vec2 mid = 0.5 * (site + other);
  // A clump on a grazed pasture's side (countryFieldCrop 9) grows into the other field; none
  // between two pastures.
  bool grazedA = countryFieldCrop(hash12(a + 0.71), K_season) > 8.5;
  bool grazedB = countryFieldCrop(hash12(a + toward + 0.71), K_season) > 8.5;
  if (grazedA && grazedB) return v;
  float pxl = 1.0 / uRes.y;
  for (int j = 0; j < 2; j++) {
    float n = border * 2.0 + float(j);
    float side = hash12(a + vec2(0.25 * n + 0.125, 0.375)) < 0.5 ? -1.0 : 1.0;
    if (side < 0.0 ? grazedA : grazedB) side = -side;
    vec2 root = mid + along * (j == 0 ? -COUNTRY_VERGE_ALONG : COUNTRY_VERGE_ALONG) + ab * side * COUNTRY_VERGE_INSET;
    // The pixel from the root on screen (y up), field space taken as COUNTRY_FIELDS per world unit
    // about the lookup, as the hedgerow trees take it.
    vec2 dw = (fL - root) / COUNTRY_FIELDS;
    vec2 rel = vec2(dw.x / d, (sL - s) - dw.y / rate);
    if (rel.y < -pxl || rel.y > reach || abs(rel.x) > wide || rel.y <= v.drop) continue;
    vec2 wR = wL - dw;
    if (countryRouteDistance(i, wR, spots) < COUNTRY_LANE + COUNTRY_VERGE_KEEP) continue;
    if (i > 0.5 && countryRiverScale() > 0.0) {
      float bank = countryRiverBank(max(wR.y, 0.0));
      float broad = countryRiverScale();
      if (countryRiverDistance(i, wR, spots) < countryRiverReeds(bank, broad) - bank * broad + COUNTRY_VERGE_KEEP) continue;
    }
#if COUNTRY_HAS_SETTLEMENTS
    if (countrySettlementDistance(i, wR, spots) < COUNTRY_VERGE_KEEP) continue;
#endif
    float z = countryFaceDepth(max(s + rel.y, 0.0), d);
    float metre = 1.0 / (z * COUNTRY_VERGE_SCALE);
    vec2 m = rel / metre;
    float foot = pxl / metre;
    int first = int(slots + float(j)) * COUNTRY_VERGE_ORGANS;
    // Back to front: leaves, stems, heads; the last covering organ is the one seen.
    for (int k = 0; k < COUNTRY_VERGE_ORGANS; k++) {
      PlantOrgan o = plantOrgan(uSim2, 1, first + k);
      if (o.tier < 0.5) continue;
      float at = 0.0;
      float up = 0.0;
      if (hardEdge(countryVergeOrgan(o, m, foot, at, up)) < 0.5) continue;
      v.cover = 1.0;
      v.drop = rel.y;
      v.z = z;
      v.albedo = countryVergeColour(o.form, o.pheno, at, K_season);
      v.up = up;
    }
  }
  return v;
}
#endif
`;
