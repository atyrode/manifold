// The tide pool's life on the shared components: kelp and surfgrass on their holdfasts and the
// anemones on the rock are rooted plants (sims/plants.ts), streaming and leaning in the water's flow
// as the sim reads it back from the GPU; with the `fish` knob, rock pool fish (sims/fish.ts, BLENNY)
// idle over the basin's floor and dart off from a touch or a surge, stepped FISH_STEP at a time and
// drawn ahead of their last step by the time left over (packFish's `ahead`), as pond's koi are.
// Holdfasts and anemones stand where the shader always placed them (its hash22 lattices, glslHash22
// here) wherever the layout gives them a home; the density knobs still pick which show, in the
// shader, by each one's rank.
//
// Everything rides one texture, uSim3 (rgba16f, TIDEPOOL_LIFE_WIDTH wide, nearest):
//   rows 0..2       the fish (FishTexture's rows: the group holds TIDEPOOL_LIFE_WIDTH fish)
//   row 3, texel 0  header: flow rows, the first record row, frond grid columns, anemone grid columns
//   rows 4..        the water's flow, coarse: TIDEPOOL_LIFE_WIDTH × flow rows over the frame
//                   (vx, vy in cells/s, depth in cells), a frame or two old
//   then            plant records (PlantTexture, shaders/lib/plants.ts): TIDEPOOL_BLADES per frond
//                   lattice cell (from cell -1, -1), then one per anemone lattice cell
// Units: frame heights, x across 0..aspect and y up 0..1 (the shader's q).
import { FixedStep } from "../../sims/clock.ts";
import { BLENNY, FishGroup, packFish } from "../../sims/fish.ts";
import { fract, glslHash22 } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import {
  PlantHabit,
  PlantRole,
  PlantTexture,
  plantClimate,
  RootedPlants,
  type PlantBuilder,
  type PlantSpecies,
} from "../../sims/plants.ts";
import type { PointerState } from "../types.ts";
import type { TidepoolLayout } from "./layout.ts";

export const TIDEPOOL_LIFE_WIDTH = 64;
/** The texel row of the header; the flow starts on the next. */
export const TIDEPOOL_LIFE_HEADER = 3;
/** Frond holdfast lattice: cell size (frame heights), blades per holdfast at most, rows (from -1). */
export const TIDEPOOL_FROND_GRID = 0.085;
export const TIDEPOOL_BLADES = 4;
export const TIDEPOOL_FROND_ROWS = Math.ceil(1 / TIDEPOOL_FROND_GRID) + 2;
export const TIDEPOOL_ANEMONE_GRID = 0.07;
/** The most fish the knob shows. */
export const TIDEPOOL_FISH_MAX = 10;
/** The water's flow (cells/s) that pushes a frond or an anemone as hard as a unit of push. */
const FLOW_PUSH = 20;
/** Plant forms in the records. */
export const TIDEPOOL_FORMS = { kelp: 0, surfgrass: 1, anemone: 2 } as const;
/** The fish's fixed step (s), and the most steps one frame catches up. */
const FISH_STEP = 1 / 60;
const FISH_MAX_STEPS = 8;

/** The holdfast being grown (the species' builds read it). */
const hold = { len: 0, salt: 0, phase: 0, rank: 0, blades: 3, grass: false };

function frondBuild(plant: PlantBuilder): void {
  for (let i = 0; i < hold.blades; i++) {
    const spread = (i - 0.5 * (hold.blades - 1)) * (hold.grass ? 0.18 : 0.42);
    plant.organ({
      angle: plant.site.heading + spread,
      length:
        hold.len * (hold.grass ? 1.15 : 1) * (0.75 + 0.25 * fract(hold.salt * 3.3 + i * 0.37)),
      // a: the flutter's phase; b: the holdfast's rank against the density knob.
      a: i * 2.1 + hold.phase,
      b: hold.rank,
      form: hold.grass ? TIDEPOOL_FORMS.surfgrass : TIDEPOOL_FORMS.kelp,
      variant: i,
      role: PlantRole.leaf,
      slot: i,
    });
  }
}

/** Brown kelp-like ribbons: annual, browning and torn away in autumn. */
const KELP: PlantSpecies = {
  id: "kelp",
  moisture: [0.6, 1],
  aquatic: true,
  sway: { hz: 0.35, damping: 0.5, give: 2.4, limit: 2.6 },
  year: { shed: 0.7, turn: 0.56, bloom: [0, 0] },
  life: { unfold: 8, span: 80 },
  detail: { simple: 6, min: 1.5 },
  build: frondBuild,
};

/** Surfgrass: perennial, combed flat by every surge. */
const SURFGRASS: PlantSpecies = {
  ...KELP,
  id: "surfgrass",
  sway: { hz: 0.5, damping: 0.5, give: 3, limit: 2.8 },
  year: { shed: 0.15, turn: 0.62, bloom: [0, 0] },
};

/** An anemone: an upright column leaning with the water; r its disc's radius, a giant 0..1, b its rank. */
const ANEMONE: PlantSpecies = {
  id: "anemone",
  moisture: [0.5, 1],
  aquatic: true,
  sway: { hz: 0.8, damping: 0.7, give: 1, limit: 0.6 },
  year: { shed: 0, turn: 2, bloom: [0, 0] },
  life: { unfold: 1, span: 1 },
  detail: { simple: 3, min: 1 },
  build(plant) {
    plant.organ({
      angle: 0,
      length: hold.len,
      a: hold.salt,
      b: hold.rank,
      form: TIDEPOOL_FORMS.anemone,
      habit: PlantHabit.upright,
      slot: 0,
    });
  },
};

/** The layout's rgba (bed, still depth, inside the basin, in the channel) at frame point (x, y), bilinear. */
function siteAt(layout: TidepoolLayout, x: number, y: number, out: Float64Array): void {
  const gx = Math.min(
    Math.max((x / (layout.columns / layout.rows)) * layout.columns - 0.5, 0),
    layout.columns - 1,
  );
  const gy = Math.min(Math.max(y * layout.rows - 0.5, 0), layout.rows - 1);
  const i = Math.min(Math.floor(gx), layout.columns - 2);
  const j = Math.min(Math.floor(gy), layout.rows - 2);
  const fx = gx - i;
  const fy = gy - j;
  for (let c = 0; c < 4; c++) {
    const at = (r: number, k: number) =>
      layout.texture[((j + r) * layout.columns + i + k) * 4 + c] ?? 0;
    out[c] =
      (at(0, 0) * (1 - fx) + at(0, 1) * fx) * (1 - fy) + (at(1, 0) * (1 - fx) + at(1, 1) * fx) * fy;
  }
}

/** The tide pool's plants and fish, and the texture that carries them with the flow (see the header). */
export class TidepoolLife {
  readonly #gl: WebGL2RenderingContext;
  readonly #plants = new RootedPlants(8192, 5);
  readonly #climate = plantClimate();
  readonly #fish = new FishGroup(BLENNY, TIDEPOOL_LIFE_WIDTH);
  readonly #fishClock = new FixedStep(FISH_STEP, FISH_MAX_STEPS);
  #records: PlantTexture | undefined;
  #layout: TidepoolLayout | undefined;
  #aspect = 16 / 9;
  /** The coarse flow (TIDEPOOL_LIFE_WIDTH × flowRows, rgba: vx, vy, depth, -), and its rows. */
  flow = new Float32Array(TIDEPOOL_LIFE_WIDTH * 4);
  flowRows = 1;
  #frondColumns = 1;
  #anemoneColumns = 1;
  #response = 1;
  #startle = 0;
  #startleX = 0;
  #startleY = 0;
  readonly #site = new Float64Array(4);
  readonly #hash = new Float64Array(2);

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#climate.current = (x, y, out) => {
      this.#flowAt(x, y, out);
      out[0] = ((out[0] ?? 0) / FLOW_PUSH) * this.#response;
      out[1] = ((out[1] ?? 0) / FLOW_PUSH) * this.#response;
    };
  }

  get texture(): WebGLTexture | undefined {
    return this.#records?.texture;
  }

  /** Rooted afresh on a new layout (the frame's shape or the rock changed): plants, fish and the texture. */
  relay(layout: TidepoolLayout, seed: number): void {
    const aspect = layout.columns / layout.rows;
    this.#layout = layout;
    this.#aspect = aspect;
    this.flowRows = Math.max(1, Math.round(TIDEPOOL_LIFE_WIDTH / aspect));
    this.flow = new Float32Array(TIDEPOOL_LIFE_WIDTH * this.flowRows * 4);
    const plants = this.#plants;
    plants.clear();
    const site = this.#site;
    const h = this.#hash;
    // Fronds: a holdfast per lattice cell where the layout gives it a home (surfgrass in the channel;
    // kelp in the basin and along the low rock at the sea's edge).
    const G = TIDEPOOL_FROND_GRID;
    this.#frondColumns = Math.ceil(aspect / G) + 2;
    for (let j = -1; j < TIDEPOOL_FROND_ROWS - 1; j++) {
      for (let i = -1; i < this.#frondColumns - 1; i++) {
        glslHash22(i + 41.7, j + 41.7, h);
        const hx = h[0] ?? 0;
        const hy = h[1] ?? 0;
        const x = (i + 0.2 + 0.6 * hx) * G;
        const y = (j + 0.2 + 0.6 * hy) * G;
        siteAt(layout, x, y, site);
        const grass = (site[3] ?? 0) > 0.4;
        const zone = grass
          ? 1
          : Math.max(
              ((site[1] ?? 0) >= 0.3 ? 1 : 0) * (site[2] ?? 0),
              (site[0] ?? 0) >= -2.6 && (site[0] ?? 0) <= 0.6 ? 1 : 0,
            );
        if (zone < 0.5) continue;
        hold.len = G * (0.7 + 0.6 * fract(hx * 13.1));
        hold.salt = hx;
        hold.phase = hy * 30;
        hold.rank = fract(hy * 7.7);
        hold.blades = grass ? 4 : 3;
        hold.grass = grass;
        const slot = ((j + 1) * this.#frondColumns + (i + 1)) * TIDEPOOL_BLADES;
        plants.add(
          grass ? SURFGRASS : KELP,
          { x, y, heading: hx * 40, moisture: 1, submerged: true, slot },
          () => 0,
        );
      }
    }
    const frondRecords = this.#frondColumns * TIDEPOOL_FROND_ROWS * TIDEPOOL_BLADES;
    // Anemones: one per lattice cell where it fits (the basin's floor, the low wet rock).
    const A = TIDEPOOL_ANEMONE_GRID;
    this.#anemoneColumns = Math.ceil(aspect / A);
    const anemoneRows = Math.ceil(1 / A);
    for (let j = 0; j < anemoneRows; j++) {
      for (let i = 0; i < this.#anemoneColumns; i++) {
        glslHash22(i + 3.7, j + 3.7, h);
        const hx = h[0] ?? 0;
        const hy = h[1] ?? 0;
        const x = (i + 0.3 + 0.4 * hx) * A;
        const y = (j + 0.3 + 0.4 * hy) * A;
        siteAt(layout, x, y, site);
        const fits =
          ((site[1] ?? 0) > 0.5 && (site[2] ?? 0) > 0.2) ||
          ((site[0] ?? 0) > -1.8 && (site[0] ?? 0) < 0.5 && (site[1] ?? 0) < 0.05);
        if (!fits) continue;
        const giant = fract(hx * 17);
        hold.len = A * (giant > 0.55 ? 0.13 + 0.05 * hy : 0.07 + 0.03 * hy);
        hold.salt = giant;
        hold.rank = fract(hy * 9.1);
        plants.add(
          ANEMONE,
          {
            x,
            y,
            heading: 0,
            moisture: 1,
            submerged: true,
            slot: frondRecords + j * this.#anemoneColumns + i,
          },
          () => 0,
        );
      }
    }
    const records = frondRecords + this.#anemoneColumns * anemoneRows;
    this.#records?.dispose();
    this.#records = new PlantTexture(this.#gl, records, {
      width: TIDEPOOL_LIFE_WIDTH,
      rowBase: TIDEPOOL_LIFE_HEADER + 1 + this.flowRows,
    });
    plants.settle(this.#climate);
    // Fish: scattered over the basin's floor, each its own size and weave.
    const rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x5f15) >>> 0);
    const pool = layout.pool;
    for (let k = 0; k < this.#fish.capacity; k++) {
      const a = rand() * Math.PI * 2;
      const r = 0.6 * Math.sqrt(rand());
      this.#fish.place(
        k,
        pool.x + Math.cos(a) * r * pool.rx,
        pool.y + Math.sin(a) * r * pool.ry,
        rand() * Math.PI * 2,
        BLENNY.cruise,
        0.016 + 0.012 * rand(),
        rand(),
      );
    }
  }

  /**
   * One frame: the fish swim (dt seconds of motion, `time` the motion clock at its end), the plants
   * stream in the flow (`flow` as last read back), then everything is packed and uploaded.
   */
  step(
    dt: number,
    time: number,
    knobs: { response: number; fish: number; season: number; growth: number },
    pointer: PointerState,
  ): void {
    const records = this.#records;
    const layout = this.#layout;
    if (!records || !layout) return;
    this.#response = knobs.response;
    const climate = this.#climate;
    climate.dt = dt;
    climate.time = time;
    climate.season = knobs.season;
    climate.growth = knobs.growth;
    // Still water still stirs a little with the swell beyond the rim.
    climate.air.calm = 0.08 * knobs.response;
    this.#plants.step(climate);
    this.#swim(dt, time, Math.round(knobs.fish), pointer);
    const data = records.data;
    packFish(this.#fish, Math.round(knobs.fish), this.#fishClock.pending, data);
    const header = TIDEPOOL_LIFE_HEADER * TIDEPOOL_LIFE_WIDTH * 4;
    data[header] = this.flowRows;
    data[header + 1] = records.rowBase;
    data[header + 2] = this.#frondColumns;
    data[header + 3] = this.#anemoneColumns;
    data.set(this.flow, (TIDEPOOL_LIFE_HEADER + 1) * TIDEPOOL_LIFE_WIDTH * 4);
    records.pack(this.#plants);
    records.upload();
  }

  dispose(): void {
    this.#records?.dispose();
  }

  /** The coarse flow at frame point (x, y), bilinear: cells/s into out[0], out[1], depth (cells) into out[2]. */
  #flowAt(x: number, y: number, out: Float32Array): void {
    const w = TIDEPOOL_LIFE_WIDTH;
    const rows = this.flowRows;
    const gx = Math.min(Math.max((x / this.#aspect) * w - 0.5, 0), w - 1);
    const gy = Math.min(Math.max(y * rows - 0.5, 0), rows - 1);
    const i = Math.min(Math.floor(gx), Math.max(w - 2, 0));
    const j = Math.min(Math.floor(gy), Math.max(rows - 2, 0));
    const fx = gx - i;
    const fy = gy - j;
    const flow = this.flow;
    const i1 = Math.min(i + 1, w - 1);
    const j1 = Math.min(j + 1, rows - 1);
    for (let c = 0; c < 3; c++) {
      const a = flow[(j * w + i) * 4 + c] ?? 0;
      const b = flow[(j * w + i1) * 4 + c] ?? 0;
      const d = flow[(j1 * w + i) * 4 + c] ?? 0;
      const e = flow[(j1 * w + i1) * 4 + c] ?? 0;
      out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
  }

  readonly #probe = new Float32Array(3);

  /** The fish: idling over the basin's floor, keeping to its water, darting from a touch or a hard surge. */
  #swim(dt: number, time: number, count: number, pointer: PointerState): void {
    const clock = this.#fishClock;
    const steps = clock.advance(dt);
    const layout = this.#layout;
    if (!layout || count <= 0) return;
    const fish = this.#fish;
    const pool = layout.pool;
    if (pointer.inside && pointer.pressed) {
      this.#startle = 1.5;
      this.#startleX = pointer.x * this.#aspect;
      this.#startleY = pointer.y;
    }
    this.#startle = Math.max(0, this.#startle - Math.max(0, dt));
    const h = FISH_STEP;
    const probe = this.#probe;
    for (let s = 0; s < steps; s++) {
      // Each step weaves at its own moment on the motion clock.
      const at = time - clock.lag(s);
      fish.clear(count);
      for (let i = 0; i < count; i++) {
        fish.wander(i, at);
        fish.within(
          i,
          pool.x - pool.rx,
          pool.y - pool.ry,
          pool.x + pool.rx,
          pool.y + pool.ry,
          0.4 * Math.min(pool.rx, pool.ry),
        );
        this.#flowAt(fish.x[i] ?? 0, fish.y[i] ?? 0, probe);
        // Out of the water's depth: back toward the middle of the basin.
        if ((probe[2] ?? 0) < 0.4) fish.gather(i, pool.x, pool.y, 0.05, 2);
        // A hard surge (or a touch) sends it darting off.
        const surge = Math.hypot(probe[0] ?? 0, probe[1] ?? 0);
        if (surge > 14)
          fish.flee(
            i,
            (fish.x[i] ?? 0) - (probe[0] ?? 0) * 0.001,
            (fish.y[i] ?? 0) - (probe[1] ?? 0) * 0.001,
            0.05,
            1,
          );
        if (this.#startle > 0) fish.flee(i, this.#startleX, this.#startleY, 0.25, 2.5);
      }
      fish.space(count);
      fish.swim(count, h);
      for (let i = 0; i < count; i++) {
        // tag.x: the tail beat's phase, quicker the faster it swims.
        fish.tag[4 * i] =
          ((fish.tag[4 * i] ?? 0) +
            h * (3 + (2.5 * (fish.speed[i] ?? 0)) / Math.max(fish.length[i] ?? 0.02, 1e-3))) %
          (Math.PI * 200);
      }
    }
  }
}
