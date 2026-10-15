// A river delta seen from above, as a satellite time-lapse: a river leaves its valley at the top of
// the frame and builds a fan of channels out into the sea below, on the GPU (sims/gpu.ts).
//
// Water. Shallow water on a grid of square cells (some 256 on the frame's short side), as "virtual
// pipes" between neighbouring cells (Mei, Decaudin & Hu, "Fast Hydraulic Erosion Simulation and
// Visualization on GPU", Pacific Graphics 2007) whose flow obeys the local inertial equations of
// Bates, Horritt & Fewtrell ("A simple inertial formulation of the shallow water equations for
// efficient two-dimensional flood inundation modelling", J. Hydrology 387, 2010): each cell keeps
// its outflow through each of its four faces, pushed by the drop of the water surface times the
// depth of water over the face, held back by bed friction (Chézy: deep water runs faster), and
// scaled so no cell gives away more water than it holds. The river enters at a fixed stage where it
// crosses the top edge; the sea's level is held at the frame's other edges, rising and falling
// with the tide and tilted a little from one side to the other, which sets the open sea drifting
// along the coast (the longshore current).
//
// Bed. The river carries sand along its bed in proportion to the flow through a face times the
// square of the velocity there (a stream-power law), plus a share that rolls downhill; the bed
// rises where more arrives than leaves (Exner's equation), so sand is laid down wherever the water
// slows: on bars at the river mouths, which split the flow, and along the banks. Every exchange is
// counted face by face, so sand is never made or lost, but for the cap on a cell's change in one
// step (MAX_CHANGE), which drops what a capped cell's neighbours still exchange with it. Measured,
// it binds only in the warm-up at the most erosive knobs (erosion and sediment 1: 41 cells in 240
// steps, 0.15 cell heights of sand lost against 559 moved), and in none of the steps sampled at the
// defaults, in a flood or after a dug ditch. Silt rides in suspension, carried through the same
// faces as the water (out of the river's mouths into the sea: the plumes), and settles
// where the water is still. Steep banks slump to an angle of repose, deposits sink slowly (the
// delta subsides, so lobes the river abandons drown again), and plants spread over dry, quiet
// ground, as much as it can carry, holding it against the current and steepening the banks they
// grow on. Floods raise the river's stage for a while and load it with silt. A morphological
// factor speeds the bed up against the water, as time-lapse models do.
//
// A fresh landscape is laid out mature (`layDelta`, on the CPU): a meandering river in a valley
// between hills, a fan of distributaries splitting toward the sea with levees, mouth bars and a
// shallow platform, an older lobe off to one side, abandoned and turned to marsh, plants on the
// old ground; then a short fixed run of the simulation (a count of steps) sets the water flowing.
//
// Textures handed to the shader (rgba16f, linear, the grid's size; the shader cover-fits the grid
// to the frame), eased toward each new state so nothing jumps under the dither:
//   uSim0  r bed height above the sea level knob (cells), g water depth (cells), b silt per unit
//          of water depth, a vegetation 0..1
//   uSim1  r fresh sediment 0..1 (recently laid or cut), g recently under water 0..1, b the
//          Manifold M's rock 0..1, a current speed (cells per model time unit)
// When float render targets are missing (GpuCompute.create returns undefined), the same layout is
// uploaded once and stands still.
import { markDistance } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { runBudgeted } from "../../sims/clock.ts";
import {
  GpuCompute,
  gridSize,
  type Pass,
  type PingPong,
  type RenderTarget,
} from "../../sims/gpu.ts";
import { smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- grid and clocks ------------------------------------------------------------------------------

/** Grid cells on the frame's short side. */
const GRID_SHORT = 256;
/** The grid is laid out afresh once the frame's aspect differs from it by more than this ratio. */
const ASPECT_SLACK = 1.12;
/** Wall-clock milliseconds the landscape knob and the frame's shape must rest before a new layout. */
const RELAYOUT_MS = 300;
/** Simulation steps per time-lapse second at speed 1. */
const STEPS_PER_SECOND = 120;
/** Most steps in one frame however long it was (a slow machine runs the time-lapse slower). */
const MAX_FRAME_STEPS = 4;
/**
 * Warm-up after a layout: PREWARM_STEPS steps, the GPU synced after every PREWARM_CHUNK. A count of
 * steps, never a duration, so the opening state does not depend on the machine's speed; PREWARM_MS
 * only caps how long one frame may block, and a slower machine takes more frames (the sim holds still
 * meanwhile).
 */
const PREWARM_STEPS = 240;
const PREWARM_MS = 60;
const PREWARM_CHUNK = 8;

// ---- physics, per step, in cells (heights too) -------------------------------------------------------

/** Step length in model time units: stable for sea depths up to some 8 cells. */
const DT = 0.25;
const GRAVITY = 1;
/** Chézy bed friction: velocity² = g · depth · slope / FRICTION. */
const FRICTION = 0.05;
/** Velocity clamp, and the depth below which velocity is taken over a thicker sheet. */
const MAX_SPEED = 1.2;
const MIN_DEPTH = 0.05;
/** Water thinner than this is a film: it evaporates and drops whatever it carries. */
const FILM = 0.01;
const EVAPORATION = 0.002;
/** How fast ground left by the water dries (per time unit). */
const DRYING = 0.01;
/** Sand carried through a face: CARRY · q · u² + SLOPE_CARRY · q · (bed drop). */
const CARRY = 0.12;
const SLOPE_CARRY = 0.05;
/** Least water depth over a face when its velocity is taken. */
const MIN_FACE = 0.05;
/** Morphological factor at the default erosion knob (bed change per unit of sand moved). */
const MORPH = 16;
/** Bed raised per unit of silt settled. */
const SILT_MORPH = 2.5;
/**
 * Silt settling rate in still water, and the speed above which it stays up (from a third of it
 * settling begins): only slack water lets it fall, so the river carries it out to sea.
 */
const SETTLE = 0.0012;
const SETTLE_SPEED = 0.1;
/** Where settling begins to fade with speed: a third of SETTLE_SPEED, as the pass has always rounded it. */
const SETTLE_FROM = 0.0333;
/** Largest bed change in one step. */
const MAX_CHANGE = 0.02;
/** Angle of repose as a drop per cell, how much roots steepen it, and the slump rate. */
const TALUS = 0.5;
const ROOT_TALUS = 0.8;
const SLUMP = 0.05;
/** Deposits above the original ground sink at this rate (the valley's twice over), and dug holes fill back. */
const SINK = 0.00003;
const FILL = 0.00005;
/** Fresh sediment: fading per time unit, and its rise per unit of bed change. */
const FRESH_FADE = 0.01;
const FRESH_GAIN = 20;
/** Vegetation: growth rate at the default knob, withering in water and current, the scouring speed. */
const GROW = 0.004;
const WITHER = 0.02;
const SCOUR = 0.25;
/** Withering per time unit once the vegetation knob is off. */
const WILT = 0.01;

// ---- the river, the sea and their events ---------------------------------------------------------

/** River stage where it enters, relative to its banks there: at discharge 0 and 1. */
const STAGE_LOW = -0.55;
const STAGE_HIGH = 0.05;
/** Silt per unit of water depth entering, at sediment 0 and 1; sand supply against capacity likewise. */
const SILT_LOW = 0.012;
const SILT_HIGH = 0.062;
const SAND_LOW = 0.6;
const SAND_HIGH = 1.9;
/** Sea level swing of the sea level knob, in cells either way. */
const SEA_RANGE = 0.6;
/** Tidal range at full amount (cells, half the swing) and period (time-lapse seconds). */
const TIDE_RANGE = 0.3;
const TIDE_PERIOD = 42;
/**
 * The longshore current at full strength: how much higher the sea stands at the left edge than
 * at the right (cells), a slope that sets the open sea drifting along the coast, plumes in tow.
 */
const CURRENT_TILT = 0.024;
/** Floods: one every FLOOD_EVERY ± FLOOD_JITTER seconds while on; rise and fall times. */
const FLOOD_EVERY = 55;
const FLOOD_JITTER = 15;
const FLOOD_RISE = 4;
const FLOOD_FALL = 16;
/** At full strength a flood lifts the stage this much, multiplies the silt, cuts the sand supply. */
const FLOOD_STAGE = 0.6;
const FLOOD_SILT = 2.5;
const FLOOD_SAND = 0.8;

// ---- the hand ----------------------------------------------------------------------------------------

/** Brush radius in cells, its strength per second, and what digging and banking work toward. */
const BRUSH_RADIUS = 5;
const BRUSH_RATE = 5;
const DIG_TO = -0.8;
const BANK_TO = 1.7;

// ---- the Manifold M ------------------------------------------------------------------------------------

/** The M's height in frame heights at size 0 and 1, its stroke half-width in mark units. */
const MARK_SMALL = 0.14;
const MARK_LARGE = 0.3;
const MARK_STROKE = 0.06;
/** How far the M stands above the delta plain around it. */
const MARK_RISE = 0.9;

/** The view eases toward the state: share per step taken. */
const VIEW_EASE = 0.35;

// ---- knobs -------------------------------------------------------------------------------------------

const DELTA_KNOBS = [
  "discharge",
  "sediment",
  "erosion",
  "floods",
  "speed",
  "landscape",
  "seaLevel",
  "tide",
  "current",
  "vegetation",
  "tool",
  "mark",
] as const;
type DeltaKnob = (typeof DELTA_KNOBS)[number];

// ---- noise ---------------------------------------------------------------------------------------------

function lattice(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(seed + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = lattice(i, j, seed);
  const b = lattice(i + 1, j, seed);
  const c = lattice(i, j + 1, seed);
  const d = lattice(i + 1, j + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal value noise, 0..1. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, seed + o * 17);
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.2;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * fbm over the whole grid, `scale` cells per noise unit, sampled every `step` cells and filled in
 * by Catmull–Rom interpolation (smooth slopes: hill shading shows no lattice), which keeps a fresh
 * layout quick.
 */
function noiseField(
  columns: number,
  rows: number,
  step: number,
  scale: number,
  seed: number,
  octaves: number,
): Float32Array {
  // Samples at (i - 1) · step, one spare beyond either end for the cubic's outer taps.
  const lx = Math.ceil(columns / step) + 4;
  const ly = Math.ceil(rows / step) + 4;
  const samples = new Float32Array(lx * ly);
  for (let j = 0; j < ly; j++)
    for (let i = 0; i < lx; i++)
      samples[j * lx + i] = fbm(((i - 1) * step) / scale, ((j - 1) * step) / scale, seed, octaves);
  const weights = (t: number): [number, number, number, number] => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      -0.5 * t3 + t2 - 0.5 * t,
      1.5 * t3 - 2.5 * t2 + 1,
      -1.5 * t3 + 2 * t2 + 0.5 * t,
      0.5 * t3 - 0.5 * t2,
    ];
  };
  // Along x for every sample row, then along y.
  const rowsX = new Float32Array(columns * ly);
  for (let x = 0; x < columns; x++) {
    const i = Math.floor(x / step);
    const [w0, w1, w2, w3] = weights(x / step - i);
    for (let j = 0; j < ly; j++) {
      const k = j * lx + i;
      rowsX[j * columns + x] =
        w0 * (samples[k] ?? 0) +
        w1 * (samples[k + 1] ?? 0) +
        w2 * (samples[k + 2] ?? 0) +
        w3 * (samples[k + 3] ?? 0);
    }
  }
  const out = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++) {
    const j = Math.floor(y / step);
    const [w0, w1, w2, w3] = weights(y / step - j);
    for (let x = 0; x < columns; x++) {
      const k = j * columns + x;
      out[y * columns + x] =
        w0 * (rowsX[k] ?? 0) +
        w1 * (rowsX[k + columns] ?? 0) +
        w2 * (rowsX[k + 2 * columns] ?? 0) +
        w3 * (rowsX[k + 3 * columns] ?? 0);
    }
  }
  return out;
}

/** Blur a field in place: a box of radius r along x, then along y, twice (close to a Gaussian). */
function boxBlur(field: Float32Array, columns: number, rows: number, r: number): void {
  const scratch = new Float32Array(field.length);
  const pass = (
    from: Float32Array,
    to: Float32Array,
    length: number,
    lines: number,
    step: number,
    stride: number,
  ): void => {
    const span = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
      const start = line * stride;
      // A running sum over the window, the ends held at the edge values.
      let sum = 0;
      for (let k = -r; k <= r; k++)
        sum += from[start + Math.max(0, Math.min(length - 1, k)) * step] ?? 0;
      for (let i = 0; i < length; i++) {
        to[start + i * step] = sum / span;
        sum +=
          (from[start + Math.min(length - 1, i + r + 1) * step] ?? 0) -
          (from[start + Math.max(0, i - r) * step] ?? 0);
      }
    }
  };
  for (let round = 0; round < 2; round++) {
    pass(field, scratch, columns, rows, 1, columns);
    pass(scratch, field, rows, columns, columns, 1);
  }
}

// ---- the M ---------------------------------------------------------------------------------------------

/** Where the M stands in grid cells and how tall it is (0: none). */
interface MarkPlace {
  x: number;
  y: number;
  size: number;
}

/** The M's rock 0..1 at a cell centre (matches deltaMarkRock in the passes). */
function markRock(mark: MarkPlace, px: number, py: number): number {
  if (mark.size <= 0) return 0;
  const d = markDistance((px - mark.x) / mark.size, (py - mark.y) / mark.size);
  return 1 - smoothstep(MARK_STROKE, MARK_STROKE + 1.5 / mark.size, d);
}

// ---- the layout ------------------------------------------------------------------------------------------

/** A straight piece of a channel's centre line, with its banks' level at both ends. */
interface Reach {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  za: number;
  zb: number;
  /** Half-width and depth of the channel, and the radius of the lobe of land it builds. */
  width: number;
  depth: number;
  lobe: number;
  /** Cut into the ground (the first stretch of an abandoned channel is silted up). */
  cut: boolean;
}

/**
 * The nearest point of a set of reaches for every cell, by Danielsson's two-pass sequential
 * propagation of nearest points ("Euclidean distance mapping", CGIP 14, 1980), seeded exactly
 * near the centre lines: distance, and the bank level, channel half-width and lobe radius there.
 */
class Nearest {
  readonly distance: Float32Array;
  readonly level: Float32Array;
  readonly width: Float32Array;
  readonly lobe: Float32Array;
  readonly #px: Float32Array;
  readonly #py: Float32Array;

  constructor(columns: number, rows: number, reaches: readonly Reach[]) {
    const n = columns * rows;
    this.distance = new Float32Array(n).fill(Infinity);
    this.level = new Float32Array(n);
    this.width = new Float32Array(n);
    this.lobe = new Float32Array(n);
    this.#px = new Float32Array(n);
    this.#py = new Float32Array(n);
    // Squared distances while seeding and sweeping; their roots at the end.
    for (const r of reaches) this.#seed(columns, rows, r);
    this.#sweep(columns, rows, 1);
    this.#sweep(columns, rows, -1);
    const dist = this.distance;
    for (let c = 0; c < n; c++) dist[c] = Math.sqrt(dist[c] ?? Infinity);
  }

  #seed(columns: number, rows: number, r: Reach): void {
    const pad = 2;
    const x0 = Math.max(0, Math.floor(Math.min(r.ax, r.bx) - pad));
    const x1 = Math.min(columns - 1, Math.ceil(Math.max(r.ax, r.bx) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(r.ay, r.by) - pad));
    const y1 = Math.min(rows - 1, Math.ceil(Math.max(r.ay, r.by) + pad));
    const dx = r.bx - r.ax;
    const dy = r.by - r.ay;
    const l2 = dx * dx + dy * dy + 1e-9;
    const dist = this.distance;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - r.ax;
        const py = y + 0.5 - r.ay;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        const d2 = ex * ex + ey * ey;
        const c = y * columns + x;
        if (d2 >= (dist[c] ?? Infinity)) continue;
        dist[c] = d2;
        this.level[c] = r.za + (r.zb - r.za) * t;
        this.width[c] = r.width;
        this.lobe[c] = r.lobe;
        this.#px[c] = r.ax + t * dx;
        this.#py[c] = r.ay + t * dy;
      }
    }
  }

  /** One sweep over the grid, forward (1) or backward (-1), each cell trying its earlier neighbours' points. */
  #sweep(columns: number, rows: number, dir: 1 | -1): void {
    const dist = this.distance;
    const level = this.level;
    const width = this.width;
    const lobe = this.lobe;
    const sxs = this.#px;
    const sys = this.#py;
    for (let k = 0; k < rows; k++) {
      const y = dir > 0 ? k : rows - 1 - k;
      for (let j = 0; j < columns; j++) {
        const x = dir > 0 ? j : columns - 1 - j;
        const c = y * columns + x;
        const cx = x + 0.5;
        const cy = y + 0.5;
        let best = dist[c] ?? Infinity;
        for (let m = 0; m < 4; m++) {
          // Earlier neighbours: behind on this row, and three on the row before.
          const nx = x + (m < 2 ? -dir : m === 2 ? 0 : dir);
          const ny = y + (m === 0 ? 0 : -dir);
          if (nx < 0 || nx >= columns || ny < 0 || ny >= rows) continue;
          const n = ny * columns + nx;
          if ((dist[n] ?? Infinity) === Infinity) continue;
          const sx = sxs[n] ?? 0;
          const sy = sys[n] ?? 0;
          const d2 = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
          if (d2 >= best) continue;
          best = d2;
          dist[c] = d2;
          level[c] = level[n] ?? 0;
          width[c] = width[n] ?? 0;
          lobe[c] = lobe[n] ?? 0;
          sxs[c] = sx;
          sys[c] = sy;
        }
      }
    }
  }
}

/** A fresh landscape: the simulation's starting state and where its features stand. */
export interface DeltaLayout {
  columns: number;
  rows: number;
  /** rgba per cell: bed, silt (per unit of water depth), vegetation, fresh sediment. */
  terrain: Float32Array;
  /** rgba per cell: water depth, velocity x, y (0), recently wet. */
  water: Float32Array;
  /**
   * rgba per cell: original ground, hardness, edge (0 inside, 1 open sea, 2 bedrock gorge, 3 the
   * river's inlet in the gorge), the plant cover the ground can carry.
   */
  ground: Float32Array;
  /** The river's bank level where it enters: its stage is taken from here. */
  inletBank: number;
  /** Where the M stands (its centre, cells) and the level of the plain there. */
  markX: number;
  markY: number;
  /** The level of the M's rock top: the plain around it, raised. */
  markTop: number;
}

/**
 * Lay out a mature delta on a `columns` × `rows` grid, sea at `sea`, the longshore current `drift`
 * (-1..1, positive to the right) bending its plumes. Everything scales with the short side; the
 * river enters at the top, the sea lies along the bottom.
 */
export function layDelta(
  columns: number,
  rows: number,
  seed: number,
  sea: number,
  plants: boolean,
  drift: number,
): DeltaLayout {
  const n = columns * rows;
  const rand = mulberry32((Math.round(seed) + 1) * 7919);
  const s = Math.min(columns, rows) / 256;
  const W = columns;
  const H = rows;

  const xIn = W * (0.5 + 0.24 * (rand() - 0.5));
  const xApex = W * (0.5 + 0.12 * (rand() - 0.5));
  const yApex = H * 0.72;
  const yFront = H * 0.2;
  const span = yApex - yFront;
  const zApex = 1.1;
  const riverSlope = 0.0045 / s;
  const deltaSlope = 0.006 / s;
  const riverWidth = 3.4 * s;
  // The coast before the delta: a wide bay under the apex. Coastal plain above it, shelf below.
  const plain = (x: number, y: number): number => {
    const t = y - (H * 0.56 + H * 0.12 * ((x - xApex) / (0.5 * W)) ** 2);
    return t > 0
      ? (0.022 / s) * t + 0.45 * (1 - Math.exp(-t / (4 * s)))
      : -3.4 * (1 - Math.exp(t / (0.12 * H)));
  };

  // The river: x as a smooth function of the way down, meandering in its valley.
  const river: Reach[] = [];
  const waves = 1.1 + 0.7 * rand();
  const amp = W * 0.07 * (0.6 + 0.8 * rand());
  const phase = rand() * Math.PI * 2;
  const points = 160;
  const rx: number[] = [];
  const ry: number[] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const e = t * t * (3 - 2 * t);
    rx.push(
      xIn +
        (xApex - xIn) * e +
        amp * Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * waves * t + phase),
    );
    ry.push(H + 3 + (yApex - H - 3) * t);
  }
  const along = [0];
  for (let i = 1; i <= points; i++)
    along.push(
      (along[i - 1] ?? 0) +
        Math.hypot((rx[i] ?? 0) - (rx[i - 1] ?? 0), (ry[i] ?? 0) - (ry[i - 1] ?? 0)),
    );
  const total = along[points] ?? 0;
  for (let i = 0; i < points; i++) {
    river.push({
      ax: rx[i] ?? 0,
      ay: ry[i] ?? 0,
      bx: rx[i + 1] ?? 0,
      by: ry[i + 1] ?? 0,
      za: zApex + riverSlope * (total - (along[i] ?? 0)),
      zb: zApex + riverSlope * (total - (along[i + 1] ?? 0)),
      width: riverWidth,
      depth: 1.25,
      lobe: 0,
      cut: true,
    });
  }
  const inletBank = zApex + riverSlope * total;
  const apexAngle = Math.atan2(
    (ry[points] ?? 0) - (ry[points - 4] ?? 0),
    (rx[points] ?? 0) - (rx[points - 4] ?? 0),
  );

  // The distributaries: each splits in two (now and then it runs on alone) down to the mouths,
  // keeping its heading, so the mouths spread round the fan's rim. A live channel then runs on
  // straight through the land its lobe builds round it, dipping out to sea (an outlet: cut, but
  // building no land of its own).
  const live: Reach[] = [];
  const old: Reach[] = [];
  const outlets: Reach[] = [];
  const mouths: { x: number; y: number; angle: number; width: number }[] = [];
  const fork = { x: xApex, y: yApex, z: zApex, angle: -Math.PI / 2 };
  const branch = (
    into: Reach[],
    x: number,
    y: number,
    heading: number,
    width: number,
    depth: number,
    level: number,
    length: number,
    z: number,
    skip: number,
  ): void => {
    const lobe = (16 + 5 * level) * s;
    const drift = Math.floor(rand() * 1e6);
    // Each channel bends to and fro about its course (mild sinuosity), its course itself drifting.
    const bend = 0.3 + 0.25 * rand();
    const wavelength = (20 + 14 * rand()) * s;
    const phase = rand() * Math.PI * 2;
    let walked = 0;
    let i = 0;
    while (walked < length && y > yFront) {
      heading +=
        0.06 * (valueNoise(walked * 0.05, level * 3.1, drift) - 0.5) +
        0.004 * (-Math.PI / 2 - heading);
      heading = Math.max(0.35 - Math.PI, Math.min(-0.35, heading));
      const angle =
        heading +
        bend *
          Math.sin((2 * Math.PI * walked) / wavelength + phase) *
          Math.min(1, walked / (6 * s));
      const nx = x + 2 * s * Math.cos(angle);
      const ny = y + 2 * s * Math.sin(angle);
      const nz = z - deltaSlope * 2 * s;
      into.push({
        ax: x,
        ay: y,
        bx: nx,
        by: ny,
        za: z,
        zb: nz,
        width,
        depth,
        lobe,
        cut: i >= skip,
      });
      x = nx;
      y = ny;
      z = nz;
      walked += 2 * s;
      i++;
    }
    if (level >= 4 || y <= yFront || width < 1.2 * s) {
      if (into !== live) return;
      for (let run = 0; run < 0.9 * lobe; run += 2 * s) {
        const nx = x + 2 * s * Math.cos(heading);
        const ny = y + 2 * s * Math.sin(heading);
        const nz = z - 3 * deltaSlope * 2 * s;
        outlets.push({
          ax: x,
          ay: y,
          bx: nx,
          by: ny,
          za: z,
          zb: nz,
          width,
          depth,
          lobe: 0,
          cut: true,
        });
        x = nx;
        y = ny;
        z = nz;
      }
      mouths.push({ x, y, angle: heading, width });
      return;
    }
    if (level === 0 && into === live) Object.assign(fork, { x, y, z, angle: heading });
    // Bifurcation: the flow splits unequally, the larger arm turning less and running further.
    if (level === 0 || rand() > 0.15) {
      const share = 0.3 + 0.4 * rand();
      const big = Math.max(share, 1 - share);
      const small = 1 - big;
      const side = share > 0.5 ? 1 : -1;
      const turnBig = side * (0.15 + 0.3 * rand());
      const turnSmall = -side * (0.4 + 0.35 * rand());
      branch(
        into,
        x,
        y,
        heading + turnBig,
        width * (0.45 + 0.6 * big),
        depth * (0.8 + 0.15 * big),
        level + 1,
        length * (0.6 + 0.4 * big),
        z,
        0,
      );
      branch(
        into,
        x,
        y,
        heading + turnSmall,
        width * (0.45 + 0.6 * small),
        depth * (0.8 + 0.15 * small),
        level + 1,
        length * (0.6 + 0.4 * small),
        z,
        0,
      );
    } else {
      branch(into, x, y, heading, width * 0.9, depth * 0.95, level + 1, length * 0.8, z, 0);
    }
  };
  branch(
    live,
    xApex,
    yApex,
    0.3 * apexAngle - 0.35 * Math.PI,
    3 * s,
    1.15,
    0,
    0.22 * span,
    zApex,
    0,
  );
  // An older lobe off the first fork, abandoned: its channel silted shut where it left, its marsh
  // a little lower than the live plain.
  const side = rand() < 0.5 ? -1 : 1;
  const oldAngle = -Math.PI / 2 + side * (0.95 + 0.2 * rand());
  branch(old, fork.x, fork.y, oldAngle, 2.4 * s, 0.55, 2, 0.2 * span, fork.z - 0.12, 5);

  const nearRiver = new Nearest(W, H, river);
  const nearLive = new Nearest(W, H, live);
  const nearOld = new Nearest(W, H, old);

  // Channels cut into the ground: the deepest cut wins where they meet.
  const carve = new Float32Array(n);
  const carveLevel = new Float32Array(n);
  const channel = new Float32Array(n);
  const cutAll = (reaches: readonly Reach[], strength: number): void => {
    for (const r of reaches) {
      if (!r.cut) continue;
      const pad = r.width + 1;
      const x0 = Math.max(0, Math.floor(Math.min(r.ax, r.bx) - pad));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(r.ax, r.bx) + pad));
      const y0 = Math.max(0, Math.floor(Math.min(r.ay, r.by) - pad));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(r.ay, r.by) + pad));
      const dx = r.bx - r.ax;
      const dy = r.by - r.ay;
      const l2 = dx * dx + dy * dy + 1e-9;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5 - r.ax;
          const py = y + 0.5 - r.ay;
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
          const d = Math.hypot(px - t * dx, py - t * dy);
          if (d >= r.width) continue;
          const c = y * W + x;
          const q = d / r.width;
          const cut = r.depth * (1 - q * q);
          if (cut > (carve[c] ?? 0)) {
            carve[c] = cut;
            carveLevel[c] = r.za + (r.zb - r.za) * t;
          }
          channel[c] = Math.max(channel[c] ?? 0, strength * (1 - q));
        }
      }
    }
  };
  cutAll(river, 1);
  cutAll(live, 1);
  cutAll(outlets, 1);
  cutAll(old, 0.3);

  // Mouth bars just off each mouth, and a jet of silt from each: out along the channel, bent
  // downstream by the longshore current, widening and fading with distance (summed, so neighbouring
  // jets merge).
  const bar = new Float32Array(n);
  const plume = new Float32Array(n);
  const fadeLength = 35 * s;
  const reach = 3.2 * fadeLength;
  for (const m of mouths) {
    const ca = Math.cos(m.angle);
    const sa = Math.sin(m.angle);
    const cx = m.x + ca * 3 * m.width;
    const cy = m.y + sa * 3 * m.width;
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(H, Math.ceil(cy + reach)); y++) {
      for (
        let x = Math.max(0, Math.floor(cx - reach));
        x < Math.min(W, Math.ceil(cx + reach));
        x++
      ) {
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const ahead = px * ca + py * sa;
        const c = y * W + x;
        const e = (ahead / (1.6 * m.width)) ** 2 + ((-px * sa + py * ca) / m.width) ** 2;
        if (e < 1) bar[c] = Math.max(bar[c] ?? 0, 1 - e);
        const behind = smoothstep(-3 * m.width, 0, ahead);
        // The jet's centre line at this distance out, drifted along the coast.
        const a = Math.max(ahead, 0);
        const off = Math.hypot(px - ca * a - drift * 0.5 * a, py - sa * a);
        const spread = 3 * m.width + 0.45 * a;
        const fade = behind * (1 - smoothstep(2.4 * fadeLength, reach, Math.hypot(px, py)));
        plume[c] =
          (plume[c] ?? 0) + fade * Math.exp(-a / fadeLength) * Math.exp(-((off / spread) ** 2));
      }
    }
  }

  // The live lobe and its shallow platform, the discs round each reach blurred into one smooth front.
  const lobes = new Float32Array(n);
  const platforms = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const ld = nearLive.distance[c] ?? Infinity;
    const lr = nearLive.lobe[c] ?? 0;
    lobes[c] = 1 - smoothstep(0.5 * lr, lr, ld);
    platforms[c] = 1 - smoothstep(0.8 * lr, 2 * lr, ld);
  }
  const blur = Math.max(1, Math.round(6 * s));
  boxBlur(lobes, W, H, blur);
  boxBlur(platforms, W, H, blur);

  const terrain = new Float32Array(n * 4);
  const water = new Float32Array(n * 4);
  const ground = new Float32Array(n * 4);
  const silt = 0.5 * (SILT_LOW + SILT_HIGH);
  const hills = noiseField(W, H, 4, 40 * s, seed * 13 + 1, 4);
  const grain = noiseField(W, H, 2, 10 * s, seed * 13 + 5, 3);
  for (let y = 0; y < H; y++) {
    const upland = smoothstep(yApex - 0.15 * H, H, y);
    const young = smoothstep(yFront, yFront + 70 * s, y);
    const valleyFloor = smoothstep(yApex - 0.1 * H, yApex + 0.05 * H, y);
    const banksHold = smoothstep(yApex - 0.02 * H, yApex + 0.08 * H, y);
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      const hillNoise = hills[c] ?? 0.5;
      const fine = grain[c] ?? 0.5;
      const rd = nearRiver.distance[c] ?? Infinity;
      const valley = 1 - smoothstep(0.035 * W, 0.15 * W, rd);
      let base =
        plain(x, y) + 5 * upland * (1 - valley) * (0.5 + hillNoise) + 0.3 * (hillNoise - 0.5);
      // The valley floor stands a little above the river's banks and rises gently to the hills.
      const floor =
        (nearRiver.level[c] ?? 0) +
        0.45 +
        1.2 * smoothstep(0.02 * W, 0.15 * W, rd) +
        0.15 * (fine - 0.5);
      base += (floor - base) * valley * valleyFloor;

      let h = base;
      const tex = 0.1 * (fine - 0.5);
      const od = nearOld.distance[c] ?? Infinity;
      const oldLobe = 1 - smoothstep(0.5 * (nearOld.lobe[c] ?? 0), nearOld.lobe[c] ?? 0, od);
      const ld = nearLive.distance[c] ?? Infinity;
      const lobe = lobes[c] ?? 0;
      const platform = platforms[c] ?? 0;
      // The abandoned lobe, a marsh just above the tides; the live delta plain, falling away from its channels.
      if (oldLobe > 0)
        h += (Math.max(h, (nearOld.level[c] ?? 0) - 0.05 + tex) - h) * oldLobe * (1 - lobe);
      if (lobe > 0)
        h +=
          (Math.max(h, (nearLive.level[c] ?? 0) - 0.12 * smoothstep(3 * s, 14 * s, ld) + tex) - h) *
          lobe;
      if (base < -0.55) h = Math.max(h, base + (-0.55 - base) * platform);
      const lw = nearLive.width[c] ?? 1;
      const levee = Math.exp(-(((ld - 1.5 * lw) / (0.8 * lw)) ** 2));
      h += 0.1 * levee * Math.max(lobe, oldLobe);
      const b = bar[c] ?? 0;
      h = Math.max(h, h + (-0.08 - h) * b);
      const cut = carve[c] ?? 0;
      const onLand = h > sea;
      if (cut > 0) h = Math.min(h, (carveLevel[c] ?? 0) - cut);

      const ch = channel[c] ?? 0;
      const stage = cut > 0.25 && ch > 0.35 ? (carveLevel[c] ?? 0) - 0.28 : -Infinity;
      const depth = Math.max(0, sea - h, stage - h);
      const dry = smoothstep(0.05, 0.3, h - sea) * (1 - smoothstep(0, 0.05, depth));
      // How much plant cover the ground can carry: patchy on the plain, wooded on the hills.
      const fertile = Math.max(
        Math.min(
          1,
          Math.max(0.3, 0.45 + 0.75 * smoothstep(0.35, 0.65, hillNoise) + 0.2 * (fine - 0.5)),
        ),
        0.9 * upland,
      );
      const veg = plants
        ? Math.min(
            fertile,
            dry *
              (1 - 0.8 * ch) *
              (0.15 + 0.6 * young + upland) *
              (0.6 + 0.8 * fine) *
              (1 - 0.6 * levee * lobe),
          )
        : 0;
      // Silt: the river's load in the channels across the land; in the sea a faint turbid halo along
      // the delta front and the jets off the mouths, merging into it.
      const turbid = 0.05 * (platform - lobe) + 0.16 * Math.min(plume[c] ?? 0, 1.5);
      const fines =
        depth > 0 ? Math.max(silt * Math.max(turbid, 0), cut > 0.25 && onLand ? silt : 0) : 0;

      terrain[c * 4] = h;
      terrain[c * 4 + 1] = fines;
      terrain[c * 4 + 2] = veg;
      terrain[c * 4 + 3] = Math.max(b, 0.6 * levee * lobe * (1 - young));
      water[c * 4] = depth;
      water[c * 4 + 3] = depth > 0.03 ? 1 : 0;
      ground[c * 4] = base;
      ground[c * 4 + 1] = smoothstep(1.3 * riverWidth, 2.6 * riverWidth, rd) * banksHold;
      ground[c * 4 + 2] =
        y >= H - 10 * s
          ? y >= H - 2 && Math.abs(x + 0.5 - xIn) < 1.2 * riverWidth
            ? 3
            : 2
          : x === 0 || x === W - 1 || y === 0
            ? 1
            : 0;
      ground[c * 4 + 3] = fertile;
    }
  }
  const markY = yApex - 0.45 * span;
  return {
    columns: W,
    rows: H,
    terrain,
    water,
    ground,
    inletBank,
    markX: xApex,
    markY,
    markTop: zApex - deltaSlope * 0.45 * span + MARK_RISE,
  };
}

// ---- GPU passes -----------------------------------------------------------------------------------------

/** Declarations every pass shares: the state textures and the M. */
const HEAD = `${gpuCommonGlsl}
uniform sampler2D uT;   // bed, silt, vegetation, fresh sediment
uniform sampler2D uW;   // water depth, velocity xy, recently wet
uniform sampler2D uF;   // outflow through the left, right, bottom and top faces
uniform sampler2D uS;   // original ground, hardness, edge (1 open sea, 2 gorge, 3 inlet), plant cover it can carry
uniform vec3 uMark;     // the M: centre in cells, height in cells (0: none)

// The Manifold M's rock at a cell centre, 0..1.
float deltaMarkRock(vec2 p) {
  if (uMark.z <= 0.0) return 0.0;
  vec2 q = (p - uMark.xy) / uMark.z;
  float d = markDistance(q);
  return 1.0 - smoothstep(${glslFloat(MARK_STROKE)}, ${glslFloat(MARK_STROKE)} + 1.5 / uMark.z, d);
}
`;

/** Outflows through the four faces (local inertial, Chézy friction, limited to the water held). */
const FLUX = `${HEAD}
uniform float uDt;
uniform float uGravity;
uniform float uFriction;

float deltaPipe(ivec2 n, float bed, float level, float flow) {
  float nb = texelFetch(uT, n, 0).x;
  float nl = nb + texelFetch(uW, n, 0).x;
  float face = max(level, nl) - max(bed, nb);
  float q = flow + uDt * uGravity * face * (level - nl);
  return q > 0.0 ? q / (1.0 + uDt * uFriction * q / max(face * face, 1e-4)) : 0.0;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  float bed = texelFetch(uT, c, 0).x;
  float depth = texelFetch(uW, c, 0).x;
  vec4 flow = texelFetch(uF, c, 0);
  float level = bed + depth;
  vec4 q = vec4(
    c.x > 0 ? deltaPipe(c - ivec2(1, 0), bed, level, flow.x) : 0.0,
    c.x < last.x ? deltaPipe(c + ivec2(1, 0), bed, level, flow.y) : 0.0,
    c.y > 0 ? deltaPipe(c - ivec2(0, 1), bed, level, flow.z) : 0.0,
    c.y < last.y ? deltaPipe(c + ivec2(0, 1), bed, level, flow.w) : 0.0);
  float total = q.x + q.y + q.z + q.w;
  fragColor = total > 0.0 ? q * min(1.0, depth / (uDt * total)) : vec4(0.0);
}
`;

/** Water depth from the outflows, velocity, the river's stage and the open sea. */
const WATER = `${HEAD}
uniform float uDt;
uniform float uSea;
uniform float uStage;
uniform float uCurrent;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec4 w = texelFetch(uW, c, 0);
  vec4 f = texelFetch(uF, c, 0);
  vec4 g = texelFetch(uS, c, 0);
  float bed = texelFetch(uT, c, 0).x;
  float inL = c.x > 0 ? texelFetch(uF, c - ivec2(1, 0), 0).y : 0.0;
  float inR = c.x < last.x ? texelFetch(uF, c + ivec2(1, 0), 0).x : 0.0;
  float inB = c.y > 0 ? texelFetch(uF, c - ivec2(0, 1), 0).w : 0.0;
  float inT = c.y < last.y ? texelFetch(uF, c + ivec2(0, 1), 0).z : 0.0;
  float depth = w.x + uDt * (inL + inR + inB + inT - (f.x + f.y + f.z + f.w));
  vec2 velocity = 0.5 * vec2(inL - f.x + f.y - inR, inB - f.z + f.w - inT) / max(0.5 * (w.x + depth), ${glslFloat(MIN_DEPTH)});
  float speed = length(velocity);
  if (speed > ${glslFloat(MAX_SPEED)}) velocity *= ${glslFloat(MAX_SPEED)} / speed;
  if (g.z > 2.5) depth = max(depth, uStage - bed);
  float sea = uSea + uCurrent * (0.5 - vUv.x);
  if (g.z > 0.5 && g.z < 1.5 && bed < sea) depth = sea - bed;
  if (depth < ${glslFloat(FILM)}) depth -= uDt * ${glslFloat(EVAPORATION)};
  depth = max(depth, 0.0);
  float wet = depth > 0.03 ? 1.0 : max(0.0, w.w - uDt * ${glslFloat(DRYING)});
  fragColor = vec4(depth, velocity, wet);
}
`;

/** The bed (sand through the faces, slumping, sinking), silt carried and settling, vegetation. */
const MORPH_PASS = `${HEAD}
uniform float uDt;
uniform float uSea;
uniform float uMorph;
uniform float uSupply;
uniform float uSilt;
uniform float uHold;
uniform float uGrow;
uniform float uWilt;

// Sand carried across a face by an outflow, the bed falling by drop across it.
float deltaCarry(float flow, float face, float drop) {
  float u = flow / face;
  return max(${glslFloat(CARRY)} * flow * u * u + ${glslFloat(SLOPE_CARRY)} * flow * drop, 0.0);
}

// How freely a cell gives up sand: plants hold it, rock below the original ground does not give.
float deltaLoose(vec4 t, vec4 g) {
  return (1.0 - uHold * t.z) * (1.0 - g.y * (1.0 - smoothstep(g.x, g.x + 0.2, t.x)));
}

// One face: sand across it both ways, slumping over it, and what flows in through it (water, silt
// and plants next door). sums: sand in minus out, slumping, vegetation around, silt in.
void deltaFace(ivec2 n, float flowOut, int back, vec4 t, float level, float loose, inout vec4 sums, inout float waterIn) {
  vec4 tn = texelFetch(uT, n, 0);
  vec4 gn = texelFetch(uS, n, 0);
  float flowIn = texelFetch(uF, n, 0)[back];
  float face = max(max(level, tn.x + texelFetch(uW, n, 0).x) - max(t.x, tn.x), ${glslFloat(MIN_FACE)});
  float lose = deltaCarry(flowOut, face, t.x - tn.x) * loose;
  float gain = deltaCarry(flowIn, face, tn.x - t.x) * deltaLoose(tn, gn) * (gn.z > 1.5 ? uSupply : 1.0);
  float drop = tn.x - t.x;
  float excess = abs(drop) - ${glslFloat(TALUS)} * (1.0 + ${glslFloat(ROOT_TALUS)} * 0.5 * (t.z + tn.z));
  sums += vec4(gain - lose, excess > 0.0 ? ${glslFloat(SLUMP)} * sign(drop) * excess : 0.0, tn.z, flowIn * tn.y);
  waterIn += flowIn;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec4 t = texelFetch(uT, c, 0);
  vec4 w = texelFetch(uW, c, 0);
  vec4 f = texelFetch(uF, c, 0);
  vec4 g = texelFetch(uS, c, 0);
  float level = t.x + w.x;
  float loose = deltaLoose(t, g);
  vec4 sums = vec4(0.0);
  float waterIn = 0.0;
  if (c.x > 0) deltaFace(c - ivec2(1, 0), f.x, 1, t, level, loose, sums, waterIn);
  if (c.x < last.x) deltaFace(c + ivec2(1, 0), f.y, 0, t, level, loose, sums, waterIn);
  if (c.y > 0) deltaFace(c - ivec2(0, 1), f.z, 3, t, level, loose, sums, waterIn);
  if (c.y < last.y) deltaFace(c + ivec2(0, 1), f.w, 2, t, level, loose, sums, waterIn);
  float change = uDt * uMorph * sums.x + sums.y
    - uDt * ${glslFloat(SINK)} * (1.0 + 2.0 * g.y) * smoothstep(0.0, 0.3, t.x - g.x)
    + uDt * ${glslFloat(FILL)} * max(g.x - t.x, 0.0);

  // Silt, as a concentration, goes wherever the water goes: the same outflows carry it, upwind,
  // so none is made or lost on the way (w.x is the depth after this step's flows, the depth before
  // is worked back from them). It enters with the river and settles where the water is still.
  float flowOut = f.x + f.y + f.z + f.w;
  float before = w.x - uDt * (waterIn - flowOut);
  float silt = t.y * max(before - uDt * flowOut, 0.0) + uDt * sums.w;
  if (g.z > 2.5) silt = uSilt * w.x;
  float speed = length(w.yz);
  if (w.x < ${glslFloat(FILM)}) {
    change += ${glslFloat(SILT_MORPH)} * silt;
    silt = 0.0;
  } else {
    float settle = ${glslFloat(SETTLE)} * silt * uDt * (1.0 - smoothstep(${glslFloat(SETTLE_FROM)}, ${glslFloat(SETTLE_SPEED)}, speed));
    change += ${glslFloat(SILT_MORPH)} * settle;
    silt = (silt - settle) / w.x;
  }
  // The gorge the river enters by is bedrock; the open sea at the edges takes what reaches it.
  bool open = g.z > 0.5 && g.z < 1.5 && t.x < uSea;
  if (g.z > 1.5 || open) change = 0.0;
  if (open) silt = 0.0;
  change = clamp(change, -${glslFloat(MAX_CHANGE)}, ${glslFloat(MAX_CHANGE)});
  float fresh = min(1.0, t.w * (1.0 - uDt * ${glslFloat(FRESH_FADE)}) + abs(change) * ${glslFloat(FRESH_GAIN)});

  // Plants take to dry, quiet ground above the tides, as much as it can carry, spreading from their
  // neighbours; water and current drown and scour them.
  float rise = t.x - uSea;
  float dry = 1.0 - smoothstep(0.01, 0.06, w.x);
  float ground = smoothstep(0.05, 0.35, rise) * (1.0 - 0.6 * smoothstep(1.5, 5.0, rise));
  float grow = uGrow * (0.03 + 0.25 * sums.z) * max(g.w - t.z, 0.0) * dry * ground;
  float wither = ${glslFloat(WITHER)} * t.z * (smoothstep(0.03, 0.3, w.x) + 3.0 * smoothstep(${glslFloat(0.7 * SCOUR)}, ${glslFloat(1.4 * SCOUR)}, speed)) + uWilt * t.z;
  float veg = clamp(t.z + uDt * (grow - wither), 0.0, 1.0);
  fragColor = vec4(t.x + change, silt, veg, fresh);
}
`;

/** The hand: dig a ditch or throw up a bank along the pointer's path. */
const BRUSH = `${HEAD}
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uRadius;
uniform float uAmount;
uniform float uTarget;
uniform float uDig;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(uT, c, 0);
  float k = uAmount * (1.0 - smoothstep(0.35 * uRadius, uRadius, segmentDistance(gl_FragCoord.xy, uFrom, uTo + vec2(1e-3, 0.0))));
  float bed = uDig > 0.5 ? mix(t.x, min(t.x, uTarget), k) : mix(t.x, max(t.x, uTarget), k);
  fragColor = vec4(bed, t.y, t.z * (1.0 - k), max(t.w, k));
}
`;

/** The ground with the M's rock in it: raised to its top and hard. */
const STAMP = `${HEAD}
uniform sampler2D uGround;
uniform float uTop;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 g = texelFetch(uGround, c, 0);
  float rock = deltaMarkRock(gl_FragCoord.xy);
  fragColor = vec4(mix(g.x, max(g.x, uTop), rock), max(g.y, rock), g.zw);
}
`;

/** The bed lifted onto the M's rock where it stands lower. */
const RAISE = `${HEAD}
uniform float uTop;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(uT, c, 0);
  float rock = deltaMarkRock(gl_FragCoord.xy);
  fragColor = vec4(mix(t.x, max(t.x, uTop), rock), t.y, t.z * (1.0 - rock), t.w);
}
`;

/** The shader's first view: bed above the sea knob, depth, silt per depth, vegetation. */
const VIEW_GROUND = `${HEAD}
uniform sampler2D uV;
uniform float uBlend;
uniform float uSeaBase;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(uT, c, 0);
  vec4 w = texelFetch(uW, c, 0);
  vec4 now = vec4(t.x - uSeaBase, w.x, t.y, t.z);
  fragColor = mix(texelFetch(uV, c, 0), now, uBlend);
}
`;

/** The shader's second view: fresh sediment, recently wet, the M's rock, current speed. */
const VIEW_SURFACE = `${HEAD}
uniform sampler2D uV;
uniform float uBlend;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(uT, c, 0);
  vec4 w = texelFetch(uW, c, 0);
  vec4 now = vec4(t.w, w.w, deltaMarkRock(gl_FragCoord.xy), length(w.yz));
  fragColor = mix(texelFetch(uV, c, 0), now, uBlend);
}
`;

// ---- the river's moods ------------------------------------------------------------------------------

/** A flood's shape over the seconds since it began: a quick rise, a long fall. */
function floodShape(age: number): number {
  if (age < 0) return 0;
  if (age < FLOOD_RISE) {
    const p = age / FLOOD_RISE;
    return p * p * (3 - 2 * p);
  }
  return Math.exp(-(age - FLOOD_RISE) / FLOOD_FALL);
}

/** How high the seasonal floods stand at time-lapse second `clock` (0..1), seeded by the landscape. */
function seasonalFlood(clock: number, seed: number): number {
  const cycle = Math.floor(clock / FLOOD_EVERY);
  let level = 0;
  // The flood of this cycle and the tail of the last one.
  for (let k = cycle - 1; k <= cycle; k++) {
    if (k < 0) continue;
    const start =
      k * FLOOD_EVERY + FLOOD_EVERY * 0.35 + FLOOD_JITTER * (lattice(k, 7, seed) - 0.5) * 2;
    level = Math.max(level, floodShape(clock - start));
  }
  return level;
}

/** The environment of the steps of one frame. */
interface DeltaEnv {
  sea: number;
  /** Sea level difference from the left edge to the right (the longshore current). */
  current: number;
  seaBase: number;
  stage: number;
  silt: number;
  supply: number;
  morph: number;
  hold: number;
  grow: number;
  wilt: number;
}

/** Map pointer uv to grid uv, the way the shader cover-fits the grid to the frame. */
function gridUv(
  u: number,
  v: number,
  frameAspect: number,
  gridAspect: number,
  out: { x: number; y: number },
): void {
  const sx = frameAspect > gridAspect ? 1 : frameAspect / gridAspect;
  const sy = frameAspect > gridAspect ? gridAspect / frameAspect : 1;
  out.x = 0.5 + (u - 0.5) * sx;
  out.y = 0.5 + (v - 0.5) * sy;
}

// ---- the simulation on the GPU ----------------------------------------------------------------------------

class DeltaField {
  readonly #gpu: GpuCompute;
  readonly #terrain: PingPong;
  readonly #water: PingPong;
  readonly #flow: PingPong;
  readonly #original: RenderTarget;
  readonly #ground: RenderTarget;
  readonly #viewGround: PingPong;
  readonly #viewSurface: PingPong;
  readonly #flux: Pass;
  readonly #waterPass: Pass;
  readonly #morph: Pass;
  readonly #brush: Pass;
  readonly #stamp: Pass;
  readonly #raise: Pass;
  readonly #viewGroundPass: Pass;
  readonly #viewSurfacePass: Pass;
  #layout: DeltaLayout;
  #mark: MarkPlace = { x: 0, y: 0, size: 0 };
  // Uniform records the brush and the views rewrite each time, so a frame allocates nothing.
  readonly #brushUniforms = {
    uFrom: new Float32Array(2),
    uTo: new Float32Array(2),
    uRadius: 0,
    uAmount: 0,
    uTarget: 0,
    uDig: 0,
  };
  readonly #brushRun = { uniforms: this.#brushUniforms };
  readonly #viewUniforms = { uBlend: 1 };
  readonly #viewRun = { uniforms: this.#viewUniforms };

  constructor(gpu: GpuCompute, layout: DeltaLayout) {
    this.#gpu = gpu;
    this.#layout = layout;
    const size = { width: layout.columns, height: layout.rows };
    const state = { ...size, format: "rgba32f", filter: "nearest" } as const;
    const view = { ...size, format: "rgba16f", filter: "linear" } as const;
    this.#terrain = gpu.pingPong(state);
    this.#water = gpu.pingPong(state);
    this.#flow = gpu.pingPong(state);
    this.#original = gpu.target(state);
    this.#ground = gpu.target(state);
    this.#viewGround = gpu.pingPong(view);
    this.#viewSurface = gpu.pingPong(view);
    this.#flux = gpu.pass(FLUX, "delta flux");
    this.#waterPass = gpu.pass(WATER, "delta water");
    this.#morph = gpu.pass(MORPH_PASS, "delta bed");
    this.#brush = gpu.pass(BRUSH, "delta brush");
    this.#stamp = gpu.pass(STAMP, "delta mark");
    this.#raise = gpu.pass(RAISE, "delta mark raise");
    this.#viewGroundPass = gpu.pass(VIEW_GROUND, "delta view ground");
    this.#viewSurfacePass = gpu.pass(VIEW_SURFACE, "delta view surface");
    // Textures are bound once: targets and ping-pong pairs are looked up at draw time.
    const state3 = { uT: this.#terrain, uW: this.#water, uF: this.#flow };
    this.#flux.bind(state3).set({ uDt: DT, uGravity: GRAVITY, uFriction: FRICTION });
    this.#waterPass.bind({ ...state3, uS: this.#ground }).set({ uDt: DT });
    this.#morph.bind({ ...state3, uS: this.#ground }).set({ uDt: DT });
    this.#brush.bind({ uT: this.#terrain });
    this.#stamp.bind({ uGround: this.#original });
    this.#raise.bind({ uT: this.#terrain });
    this.#viewGroundPass.bind({ uT: this.#terrain, uW: this.#water, uV: this.#viewGround });
    this.#viewSurfacePass.bind({ uT: this.#terrain, uW: this.#water, uV: this.#viewSurface });
    this.#seed(layout);
  }

  get layout(): DeltaLayout {
    return this.#layout;
  }

  /** The textures for the shader (they swap: read them every frame). */
  get textures(): readonly WebGLTexture[] {
    return [this.#viewGround.texture, this.#viewSurface.texture];
  }

  /** Start over from a fresh layout (resizing the grid to it). */
  reset(layout: DeltaLayout): void {
    this.#layout = layout;
    for (const pair of [
      this.#terrain,
      this.#water,
      this.#flow,
      this.#viewGround,
      this.#viewSurface,
    ])
      pair.resize(layout.columns, layout.rows);
    this.#original.resize(layout.columns, layout.rows);
    this.#ground.resize(layout.columns, layout.rows);
    this.#seed(layout);
  }

  #seed(layout: DeltaLayout): void {
    this.#terrain.seed(layout.terrain);
    this.#water.seed(layout.water);
    this.#flow.clear(0);
    this.#original.seed(layout.ground);
    this.#mark = { x: 0, y: 0, size: 0 };
    this.#stampGround();
  }

  /** Stand the M in the ground (size 0: take it away), raising the bed onto it when it appears. */
  setMark(size: number): void {
    const layout = this.#layout;
    const mark: MarkPlace = { x: layout.markX, y: layout.markY, size };
    const appears =
      size > 0 && (this.#mark.size !== size || this.#mark.x !== mark.x || this.#mark.y !== mark.y);
    this.#mark = mark;
    this.#stampGround();
    if (appears) this.#raise.run(this.#terrain);
  }

  /** Stamp the M (or its absence) into the ground; the passes that draw or raise it learn where it is. */
  #stampGround(): void {
    const uniforms = {
      uMark: [this.#mark.x, this.#mark.y, this.#mark.size],
      uTop: this.#layout.markTop,
    };
    this.#raise.set(uniforms);
    this.#viewSurfacePass.set({ uMark: uniforms.uMark });
    this.#stamp.run(this.#ground, { uniforms });
  }

  /** The river, the sea and the knobs for the coming steps. */
  setEnvironment(env: DeltaEnv): void {
    this.#waterPass.set({
      uSea: env.sea,
      uStage: this.#layout.inletBank + env.stage,
      uCurrent: env.current,
    });
    this.#morph.set({
      uSea: env.sea,
      uMorph: env.morph,
      uSupply: env.supply,
      uSilt: env.silt,
      uHold: env.hold,
      uGrow: env.grow,
      uWilt: env.wilt,
    });
    this.#viewGroundPass.set({ uSeaBase: env.seaBase });
  }

  step(): void {
    this.#flux.run(this.#flow);
    this.#waterPass.run(this.#water);
    this.#morph.run(this.#terrain);
  }

  /** Dig (or bank up) along a stretch of the pointer's path, in cells. */
  brush(
    from: { x: number; y: number },
    to: { x: number; y: number },
    amount: number,
    dig: boolean,
    seaBase: number,
  ): void {
    const scale = Math.min(this.#layout.columns, this.#layout.rows) / 256;
    const uniforms = this.#brushUniforms;
    uniforms.uFrom[0] = from.x;
    uniforms.uFrom[1] = from.y;
    uniforms.uTo[0] = to.x;
    uniforms.uTo[1] = to.y;
    uniforms.uRadius = BRUSH_RADIUS * scale;
    uniforms.uAmount = amount;
    uniforms.uTarget = seaBase + (dig ? DIG_TO : BANK_TO);
    uniforms.uDig = dig ? 1 : 0;
    this.#brush.run(this.#terrain, this.#brushRun);
  }

  /** Ease the shader's views toward the state (blend 1: show it as it is). */
  view(blend: number): void {
    this.#viewUniforms.uBlend = blend;
    this.#viewGroundPass.run(this.#viewGround, this.#viewRun);
    this.#viewSurfacePass.run(this.#viewSurface, this.#viewRun);
  }

  /**
   * Warm-up steps from step `from` on, until PREWARM_STEPS are done or PREWARM_MS has passed (checked
   * every PREWARM_CHUNK steps, the GPU synced then). Returns where to resume: PREWARM_STEPS when done.
   */
  warm(from: number): number {
    const gl = this.#gpu.gl;
    return runBudgeted(
      (i) => {
        this.step();
        if ((i + 1) % PREWARM_CHUNK === 0) gl.finish();
      },
      PREWARM_MS,
      PREWARM_STEPS,
      from,
      PREWARM_CHUNK,
    );
  }

  dispose(): void {
    this.#gpu.dispose();
  }
}

// ---- the scene's sim --------------------------------------------------------------------------------------

/** Everything a frame's steps need from the knobs. */
function environment(
  frame: SimFrame,
  knobs: KnobReader<DeltaKnob>,
  clock: number,
  flood: number,
): DeltaEnv {
  const seaBase = (knobs.value(frame, "seaLevel") - 0.5) * 2 * SEA_RANGE;
  const tide =
    TIDE_RANGE * knobs.value(frame, "tide") * Math.sin((2 * Math.PI * clock) / TIDE_PERIOD);
  const discharge = knobs.value(frame, "discharge");
  const sediment = knobs.value(frame, "sediment");
  const plants = knobs.value(frame, "vegetation");
  return {
    sea: seaBase + tide,
    current: CURRENT_TILT * knobs.value(frame, "current"),
    seaBase,
    stage: STAGE_LOW + (STAGE_HIGH - STAGE_LOW) * discharge + FLOOD_STAGE * flood,
    silt: (SILT_LOW + (SILT_HIGH - SILT_LOW) * sediment) * (1 + FLOOD_SILT * flood),
    supply:
      (SAND_LOW + (SAND_HIGH - SAND_LOW) * sediment) * (1 - FLOOD_SAND * Math.min(flood, 0.6)),
    morph: MORPH * (0.25 + 1.5 * knobs.value(frame, "erosion")),
    hold: Math.min(0.9, 1.4 * plants),
    grow: 2 * GROW * plants,
    wilt: plants > 0 ? 0 : WILT,
  };
}

/** The landscape, the grid shape and the plants a layout was made for. */
interface LayoutKey {
  seed: number;
  columns: number;
  rows: number;
}

function sameKey(a: LayoutKey, b: LayoutKey): boolean {
  return a.seed === b.seed && a.columns === b.columns && a.rows === b.rows;
}

/** The grid for a frame, into `out`: the current one while the frame's aspect stays close to it. */
function gridFor(frame: SimFrame, current: LayoutKey | undefined, out: LayoutKey): void {
  if (current !== undefined) {
    const ratio = frame.aspect / (current.columns / current.rows);
    if (ratio < ASPECT_SLACK && ratio > 1 / ASPECT_SLACK) {
      out.columns = current.columns;
      out.rows = current.rows;
      return;
    }
  }
  const { width, height } = gridSize(frame.aspect, GRID_SHORT);
  out.columns = width;
  out.rows = height;
}

/** The views of a layout as they stand, for machines without float render targets. */
function staticViews(
  layout: DeltaLayout,
  sea: number,
  mark: MarkPlace,
): { ground: Float32Array; surface: Float32Array } {
  const n = layout.columns * layout.rows;
  const ground = new Float32Array(n * 4);
  const surface = new Float32Array(n * 4);
  for (let c = 0; c < n; c++) {
    const depth = layout.water[c * 4] ?? 0;
    ground[c * 4] = (layout.terrain[c * 4] ?? 0) - sea;
    ground[c * 4 + 1] = depth;
    ground[c * 4 + 2] = layout.terrain[c * 4 + 1] ?? 0;
    ground[c * 4 + 3] = layout.terrain[c * 4 + 2] ?? 0;
    const x = (c % layout.columns) + 0.5;
    const y = Math.floor(c / layout.columns) + 0.5;
    surface[c * 4] = layout.terrain[c * 4 + 3] ?? 0;
    surface[c * 4 + 1] = layout.water[c * 4 + 3] ?? 0;
    surface[c * 4 + 2] = markRock(mark, x, y);
  }
  return { ground, surface };
}

function markSize(frame: SimFrame, knobs: KnobReader<DeltaKnob>, rows: number): number {
  const amount = knobs.value(frame, "mark");
  return amount > 0 ? (MARK_SMALL + (MARK_LARGE - MARK_SMALL) * amount) * rows : 0;
}

/** A still picture of the layout, where the GPU cannot run the simulation. */
function stillSim(gl: WebGL2RenderingContext, knobs: KnobReader<DeltaKnob>): SceneSim {
  let key: LayoutKey | undefined;
  let layout: DeltaLayout | undefined;
  let shownSea = Number.NaN;
  let shownSize = Number.NaN;
  let ground: DataTexture | undefined;
  let surface: DataTexture | undefined;
  const want: LayoutKey = { seed: 0, columns: 0, rows: 0 };
  return {
    frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
      gridFor(frame, key, want);
      want.seed = knobs.value(frame, "landscape");
      const sea = (knobs.value(frame, "seaLevel") - 0.5) * 2 * SEA_RANGE;
      if (key === undefined || layout === undefined || !sameKey(key, want)) {
        layout = layDelta(
          want.columns,
          want.rows,
          want.seed,
          sea,
          knobs.value(frame, "vegetation") > 0,
          knobs.value(frame, "current"),
        );
        key = { ...want };
        shownSea = Number.NaN;
      }
      const size = markSize(frame, knobs, layout.rows);
      if (sea !== shownSea || size !== shownSize) {
        const views = staticViews(layout, sea, { x: layout.markX, y: layout.markY, size });
        const texture = { width: layout.columns, height: layout.rows, format: "rgba16f" } as const;
        ground ??= new DataTexture(gl, texture);
        surface ??= new DataTexture(gl, texture);
        ground.resize(layout.columns, layout.rows);
        surface.resize(layout.columns, layout.rows);
        ground.upload(views.ground);
        surface.upload(views.surface);
        shownSea = sea;
        shownSize = size;
      }
      return [ground?.texture, surface?.texture];
    },
    dispose(): void {
      ground?.dispose();
      surface?.dispose();
    },
  };
}

/** The delta, for a scene whose `params` carry the knobs `DeltaKnob` names. */
export function deltaSim(params: readonly ParamDef[]): SimFactory {
  return (gl: WebGL2RenderingContext): SceneSim => {
    const knobs = new KnobReader<DeltaKnob>("delta", params, DELTA_KNOBS);
    const gpu = GpuCompute.create(gl);
    if (!gpu) return stillSim(gl, knobs);
    const floodSlot = knobs.trigger("floods");

    let field: DeltaField | undefined;
    let key: LayoutKey | undefined;
    let pending: LayoutKey | undefined;
    let pendingSince = 0;
    let clock = 0;
    let owed = 0;
    let markShown = -1;
    /** Warm-up steps taken since the last layout; the sim holds still until all PREWARM_STEPS are done. */
    let warmed = PREWARM_STEPS;
    let manualFlood = -Infinity;
    let dragging = false;
    // Scratch the frame rewrites: the grid the frame wants, where the pointer is, and where it was.
    const want: LayoutKey = { seed: 0, columns: 0, rows: 0 };
    const at = { x: 0, y: 0 };
    const cell = { x: 0, y: 0 };
    const last = { x: 0, y: 0 };

    /** Lay out afresh for the grid in `want`; the frame then runs the warm-up. */
    const relayout = (frame: SimFrame): DeltaField => {
      const sea = (knobs.value(frame, "seaLevel") - 0.5) * 2 * SEA_RANGE;
      const layout = layDelta(
        want.columns,
        want.rows,
        want.seed,
        sea,
        knobs.value(frame, "vegetation") > 0,
        knobs.value(frame, "current"),
      );
      if (field === undefined) field = new DeltaField(gpu, layout);
      else field.reset(layout);
      key = { ...want };
      markShown = -1;
      warmed = 0;
      field.setEnvironment(environment(frame, knobs, clock, 0));
      return field;
    };

    return {
      frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
        const now = performance.now();
        gridFor(frame, key, want);
        want.seed = knobs.value(frame, "landscape");
        if (pending === undefined || !sameKey(pending, want)) {
          pending = { ...want };
          pendingSince = now;
        }
        let sim = field;
        if (sim === undefined || key === undefined) sim = relayout(frame);
        else if (!sameKey(key, want) && now - pendingSince >= RELAYOUT_MS) sim = relayout(frame);
        const layout = sim.layout;

        // The warm-up: a fixed count of steps, over as many frames as the machine needs.
        if (warmed < PREWARM_STEPS) {
          warmed = sim.warm(warmed);
          sim.view(1);
          if (warmed < PREWARM_STEPS) return sim.textures;
        }

        // The M: stamped into the ground when it appears, grows or goes.
        const size = markSize(frame, knobs, layout.rows);
        if (size !== markShown) {
          sim.setMark(size);
          markShown = size;
        }

        // Time-lapse seconds, the floods (seasonal while on, and one now when asked) and the steps owed.
        const lapse = frame.dt * frame.motion * knobs.value(frame, "speed");
        clock += lapse;
        if (frame.fired[floodSlot] === true) manualFlood = clock;
        const seasonal = knobs.value(frame, "floods");
        const strength = seasonal > 0 ? seasonal : knobs.amount(frame, "floods");
        const flood =
          Math.max(
            seasonal > 0 ? seasonalFlood(clock, want.seed) : 0,
            floodShape(clock - manualFlood),
          ) * strength;
        const env = environment(frame, knobs, clock, flood);
        owed += lapse * STEPS_PER_SECOND;
        const steps = Math.min(MAX_FRAME_STEPS, Math.floor(owed));
        owed = Math.min(owed - steps, MAX_FRAME_STEPS);
        sim.setEnvironment(env);
        for (let i = 0; i < steps; i++) sim.step();

        // The hand digs a ditch, or throws up a bank, wherever it is dragged. Not while the passage's
        // camera moves: the picture is not yet (or no longer) where the pointer maps it.
        const pointer = frame.pointer;
        if (frame.passage.enter >= 1 && frame.passage.exit <= 0 && pointer.inside && pointer.down) {
          gridUv(pointer.x, pointer.y, frame.aspect, layout.columns / layout.rows, at);
          cell.x = at.x * layout.columns;
          cell.y = at.y * layout.rows;
          const amount = 1 - Math.exp(-BRUSH_RATE * Math.max(frame.dt, 1 / 120));
          sim.brush(
            dragging ? last : cell,
            cell,
            amount,
            knobs.value(frame, "tool") < 0.5,
            env.seaBase,
          );
          last.x = cell.x;
          last.y = cell.y;
          dragging = true;
        } else {
          dragging = false;
        }

        sim.view(1 - (1 - VIEW_EASE) ** Math.max(steps, 1));
        return sim.textures;
      },
      dispose(): void {
        if (field) field.dispose();
        else gpu.dispose();
      },
    };
  };
}
