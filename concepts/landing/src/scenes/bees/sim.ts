// The hillside's living specks: dozens of bees working three hives and a handful of butterflies.
// They are tiny (a bee is one dither cell and a wing cell above it), so the simulation draws them
// itself, into a map of dither cells that the shader reads back one texel per cell: positions are
// whole cells and only move once a bee has really left its cell (hysteresis), so a hovering bee
// never flickers between two cells.
//
// Geometry shared with shader.ts (all in screen heights, x from the middle of the view, y up):
//   the garden is a ground plane seen from the eye BEES_CAM above it with its horizon at BEES_YH, so
//   a metre at row y is beesScale(y) = (BEES_YH - y) / BEES_CAM screen heights; hives, flower patches
//   and everything else stand in it at the fractions of the stage half width given below.
//
// Bees (a small state machine each, stepped at a fixed 1/60 s):
//   inside   in the hive, waiting its turn;
//   mill     at the entrance: walking on the landing board or hovering before the slot, a small crowd;
//   orient   a young bee's orientation flight: slow loops in front of its hive, learning the place;
//   out      a forager's nearly straight, slightly wobbly beeline to a flower patch;
//   forage   hopping zig-zag from flower to flower in the patch, resting a moment on each, loading up
//            with pollen (a golden dot);
//   home     the beeline back to the landing board;
//   land     alighting on the board for a moment, then in or among the crowd.
// Butterflies: an erratic, lazy flutter with bursts of wingbeats and glides, bobbing on every beat,
// now and then settling on a flower of a patch where the wings slowly open and close.
//
// Texture:
//   uSim0  r8, one texel per dither cell (rows bottom to top, the shader's `cell`): a BEES_CODE value
//          (0 nothing), see the table below.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

/** Horizon of the garden plane (uv height), the eye's height above it (m) and the narrowest stage half width. */
export const BEES_YH = 0.47;
export const BEES_CAM = 1.6;
export const BEES_STAGE_MIN = 0.62;
export const BEES_MAX_BEES = 64;
export const BEES_MAX_BUTTERFLIES = 6;

/** Screen heights per metre of the garden at row y. */
export function beesScale(y: number): number {
  return Math.max(BEES_YH - y, 0.012) / BEES_CAM;
}

/** Half the width of the stage, screen heights: fractions `f` below are of this. */
export function beesStage(aspect: number): number {
  return Math.max(0.5 * aspect, BEES_STAGE_MIN);
}

/** A box hive on its stand, metres: stand height, one box, boxes, roof, width, slot height, board thickness. */
export const BEES_HIVE = { stand: 0.3, box: 0.3, boxes: 2, roof: 0.1, width: 0.52, slot: 0.04, board: 0.02 } as const;
/** Half the landing board's width, metres. */
export const BEES_BOARD_HALF = 0.17;
/** Hives are drawn this many times larger than a metre of the garden at their row, so entrances read. */
export const BEES_HIVE_SCALE = 1.5;

export interface BeesHive {
  /** x as a fraction of the stage half width, and the y of the hive's feet (uv). */
  f: number;
  y: number;
}

/** The three hives, left to right: white, powder blue and butter yellow, the M on the middle one. */
export const BEES_HIVES: readonly BeesHive[] = [
  { f: -0.3, y: 0.32 },
  { f: -0.09, y: 0.298 },
  { f: 0.14, y: 0.33 },
];

/** Kinds of flower patch (shader.ts paints each; the bees only care where they are). */
export const BEES_LAVENDER = 0;
export const BEES_POPPY = 1;
export const BEES_DAISY = 2;
export const BEES_WILD = 3;
export const BEES_COSMOS = 4;

export interface BeesPatch {
  f: number;
  y: number;
  /** Radii: a fraction of the stage half width, and uv height. */
  rx: number;
  ry: number;
  kind: number;
}

export const BEES_PATCHES: readonly BeesPatch[] = [
  { f: -0.66, y: 0.2, rx: 0.3, ry: 0.1, kind: BEES_LAVENDER },
  { f: 0.6, y: 0.15, rx: 0.32, ry: 0.09, kind: BEES_POPPY },
  { f: 0.0, y: 0.095, rx: 0.26, ry: 0.06, kind: BEES_DAISY },
  { f: -0.55, y: 0.348, rx: 0.4, ry: 0.022, kind: BEES_WILD },
  { f: 0.72, y: 0.285, rx: 0.22, ry: 0.05, kind: BEES_COSMOS },
];

/** What a texel of uSim0 means (the byte value; 0 is nothing). */
export const BEES_CODE = {
  bee: 1,
  beeWing: 2,
  beeLoaded: 3,
  butterflyBody: 4,
  orange: 5,
  white: 6,
  blue: 7,
  orangeDim: 8,
  whiteDim: 9,
  blueDim: 10,
  trail: 11,
} as const;

const BUTTERFLY_OPEN = [BEES_CODE.orange, BEES_CODE.white, BEES_CODE.blue] as const;
const BUTTERFLY_SHUT = [BEES_CODE.orangeDim, BEES_CODE.whiteDim, BEES_CODE.blueDim] as const;

const STEP = 1 / 60;
const MAX_STEPS = 6;
/** Seconds pre-run so the page opens with the colony at work. */
const WARM_STEPS = 30 * 60;

// Bees.
const CRUISE = 0.085;
const HOP = 0.055;
const MILL_SPEED = 0.016;
const ARRIVE = 0.006;
const ORIENT_RATE = 0.85;
/** A bee in flight leaves a dotted line: this many past positions, this far apart (s). */
const TRAIL_N = 7;
const TRAIL_EVERY = 0.05;

// Butterflies.
const BUTTERFLY_SPEED = 0.045;
const BUTTERFLY_GLIDE_SPEED = 0.02;

type BeesKnob = "bees" | "butterflies";

export class BeesSimError extends Error {}

type BeeMode = "inside" | "mill" | "orient" | "out" | "forage" | "home" | "land";

interface Bee {
  hive: number;
  mode: BeeMode;
  /** Seconds left in this mode (where it has a length), and seconds since it began. */
  hold: number;
  t: number;
  age: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  patch: number;
  visits: number;
  load: number;
  phase: number;
  pace: number;
  newbie: boolean;
  resting: boolean;
  fly: boolean;
  /** Where it is drawn: unit cell, hysteretic (NaN: not yet placed). */
  cx: number;
  cy: number;
  /** The last positions of a bee in flight (x, y pairs, newest at trailHead), sampled every TRAIL_EVERY s. */
  trail: Float64Array;
  trailHead: number;
  trailCount: number;
  trailClock: number;
}

type ButterflyMode = "fly" | "approach" | "settle";

interface Butterfly {
  active: boolean;
  kind: number;
  mode: ButterflyMode;
  t: number;
  hold: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  patch: number;
  flap: number;
  pace: number;
  glide: number;
  glideLeft: number;
  gliding: boolean;
  wayLeft: number;
  open: number;
  openStart: number;
  age: number;
  phase: number;
  quiet: number;
  cx: number;
  cy: number;
}

function newBee(hive: number): Bee {
  return {
    hive, mode: "inside", hold: 0, t: 0, age: 0, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, patch: 0, visits: 0, load: 0,
    phase: 0, pace: 1, newbie: false, resting: false, fly: false, cx: Number.NaN, cy: Number.NaN,
    trail: new Float64Array(TRAIL_N * 2), trailHead: 0, trailCount: 0, trailClock: 0,
  };
}

function newButterfly(kind: number): Butterfly {
  return {
    active: false, kind, mode: "fly", t: 0, hold: 0, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, patch: 0, flap: 0, pace: 1,
    glide: 0, glideLeft: 2, gliding: false, wayLeft: 3, open: 1, openStart: 1, age: 0, phase: 0, quiet: 0,
    cx: Number.NaN, cy: Number.NaN,
  };
}

/** The unit cell a thing at float cell position v is drawn in: it stays put until it has clearly left. */
function follow(drawn: number, v: number): number {
  return Math.abs(v - (drawn + 0.5)) <= 0.85 ? drawn : Math.floor(v);
}

const PATCH_WEIGHTS: readonly number[] = BEES_PATCHES.map((patch) => patch.rx * patch.ry);
const PATCH_WEIGHT_TOTAL = PATCH_WEIGHTS.reduce((sum, w) => sum + w, 0);

class BeesSim implements SceneSim {
  readonly #knobs: KnobReader<BeesKnob>;
  readonly #texture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #random = new Random(0x5eed);
  readonly #bees: Bee[] = Array.from({ length: BEES_MAX_BEES }, (_, i) => newBee(i % BEES_HIVES.length));
  readonly #butterflies: Butterfly[] = Array.from({ length: BEES_MAX_BUTTERFLIES }, (_, i) => newButterfly(i % 3));
  readonly #geo = { x: 0, s: 0, landY: 0, half: 0, base: 0 };
  readonly #pt = { x: 0, y: 0 };
  #cells = new Uint8Array(1);
  #written: number[] = [];
  #width = 1;
  #height = 1;
  #unit = 1;
  #stage = BEES_STAGE_MIN;
  #beeCount = 0;
  #butterflyCount = 0;
  #warm = false;
  #dirty = true;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<BeesKnob>("bees", params, ["bees", "butterflies"]);
    this.#texture = new DataTexture(gl, { width: 1, height: 1, format: "r8", filter: "nearest" });
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#beeCount = clamp(Math.round(knobs.value(frame, "bees")), 0, BEES_MAX_BEES);
    this.#butterflyCount = clamp(Math.round(knobs.value(frame, "butterflies")), 0, BEES_MAX_BUTTERFLIES);
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    if (width !== this.#width || height !== this.#height) {
      this.#width = width;
      this.#height = height;
      this.#cells = new Uint8Array(width * height);
      this.#written = [];
      this.#texture.resize(width, height);
      for (const bee of this.#bees) bee.cx = Number.NaN;
      for (const butterfly of this.#butterflies) butterfly.cx = Number.NaN;
      this.#dirty = true;
    }
    this.#unit = Math.max(1, Math.round(height / 450));
    this.#setStage(beesStage(frame.aspect > 0 ? frame.aspect : width / height));
    this.#wake();
    if (!this.#warm) {
      for (let i = 0; i < WARM_STEPS; i++) this.#step(STEP);
      this.#warm = true;
    }
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) this.#step(STEP);
    if (steps > 0 || this.#dirty) {
      this.#paint();
      this.#texture.upload(this.#cells);
      this.#dirty = false;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** A new stage width (the frame's aspect changed): everything keeps its place in the picture. */
  #setStage(stage: number): void {
    if (Math.abs(stage - this.#stage) < 1e-5) return;
    const ratio = stage / this.#stage;
    this.#stage = stage;
    for (const bee of this.#bees) {
      bee.x *= ratio;
      bee.tx *= ratio;
    }
    for (const butterfly of this.#butterflies) {
      butterfly.x *= ratio;
      butterfly.tx *= ratio;
    }
  }

  /** Butterflies the knob asks for appear at the edge of the frame; the rest leave. */
  #wake(): void {
    const rand = this.#random;
    for (const [i, g] of this.#butterflies.entries()) {
      const want = i < this.#butterflyCount;
      if (want && !g.active) {
        g.active = true;
        const side = rand.next() < 0.5 ? -1 : 1;
        g.x = side * (this.#stage + 0.02);
        g.y = rand.range(0.2, 0.5);
        g.vx = -side * 0.03;
        g.vy = 0;
        g.mode = "fly";
        g.age = rand.next() * 20;
        g.phase = rand.next() * TAU;
        g.flap = rand.next() * TAU;
        g.pace = rand.range(0.9, 1.12);
        g.gliding = false;
        g.glideLeft = rand.range(1.5, 4);
        g.glide = 0;
        g.quiet = rand.range(2, 9);
        g.cx = Number.NaN;
        this.#waypoint(g, false);
      } else if (!want) {
        g.active = false;
      }
    }
    if (!this.#warm) this.#seed();
  }

  /** The very first frame: bees start asleep inside at scattered times, butterflies in the air. */
  #seed(): void {
    const rand = this.#random;
    for (const bee of this.#bees) {
      bee.mode = "inside";
      bee.hold = rand.range(0.5, 9);
      bee.newbie = rand.next() < 0.14;
      bee.pace = rand.range(0.9, 1.12);
      bee.phase = rand.next() * TAU;
      bee.patch = this.#pickPatch();
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      g.x = rand.range(-0.8, 0.8) * this.#stage;
      g.y = rand.range(0.15, 0.55);
    }
  }

  // ---- places -------------------------------------------------------------------------------

  #locate(hive: number): void {
    const def = BEES_HIVES[hive];
    if (def === undefined) throw new BeesSimError(`no hive ${hive}`);
    const s = beesScale(def.y) * BEES_HIVE_SCALE;
    const g = this.#geo;
    g.s = s;
    g.x = def.f * this.#stage;
    g.base = def.y;
    g.landY = def.y + (BEES_HIVE.stand + 0.004) * s;
    g.half = BEES_BOARD_HALF * s;
  }

  #pickPatch(): number {
    let pick = this.#random.next() * PATCH_WEIGHT_TOTAL;
    for (const [i, w] of PATCH_WEIGHTS.entries()) {
      pick -= w;
      if (pick <= 0) return i;
    }
    return 0;
  }

  /** A flower in patch `index`: uniform over most of its ellipse, written to #pt. */
  #flowerPoint(index: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const rand = this.#random;
    const r = Math.sqrt(rand.next()) * 0.85;
    const a = rand.next() * TAU;
    this.#pt.x = (patch.f + r * Math.cos(a) * patch.rx) * this.#stage;
    this.#pt.y = patch.y + r * Math.sin(a) * patch.ry + 0.006;
  }

  // ---- stepping -----------------------------------------------------------------------------

  #step(dt: number): void {
    for (const [i, bee] of this.#bees.entries()) this.#stepBee(bee, i, dt);
    for (const g of this.#butterflies) if (g.active) this.#stepButterfly(g, dt);
  }

  /**
   * Steer toward (tx, ty) at `speed`: eased in over the first second, slowing as it arrives, with a
   * lateral weave of velocity `weave`. Returns the distance left.
   */
  #steer(b: Bee, speed: number, weave: number, dt: number): number {
    const dx = b.tx - b.x;
    const dy = b.ty - b.y;
    const dist = Math.hypot(dx, dy) + 1e-6;
    const ux = dx / dist;
    const uy = dy / dist;
    const go = speed * b.pace * (0.12 + 0.88 * smoothstep(0, 0.07, dist)) * (0.25 + 0.75 * smoothstep(0, 0.9, b.t));
    const lateral = weave * (0.55 * Math.sin(TAU * 0.37 * b.age + b.phase) + 0.25 * Math.sin(TAU * 1.3 * b.age + 2 * b.phase)) * smoothstep(0.03, 0.14, dist);
    const k = 1 - Math.exp(-dt / 0.22);
    b.vx += (ux * go - uy * lateral - b.vx) * k;
    b.vy += (uy * go + ux * lateral - b.vy) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    return dist;
  }

  /** Follow a moving target closely (orientation loops, mill-about): velocity toward it over `tau`. */
  #seek(b: Bee, tau: number, maxSpeed: number, dt: number): void {
    const dx = b.tx - b.x;
    const dy = b.ty - b.y;
    const dist = Math.hypot(dx, dy) + 1e-6;
    const go = Math.min(maxSpeed, dist / tau);
    const k = 1 - Math.exp(-dt / 0.2);
    b.vx += (dx / dist * go - b.vx) * k;
    b.vy += (dy / dist * go - b.vy) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  #enter(b: Bee, i: number): void {
    const rand = this.#random;
    b.mode = "inside";
    b.hold = rand.range(1, 4);
    b.fly = false;
    b.load = 0;
    b.vx = 0;
    b.vy = 0;
    // Now and then the bee that goes in is a young one when it comes out again.
    if (i < this.#beeCount && rand.next() < 0.1) b.newbie = true;
  }

  #begin(b: Bee, mode: BeeMode, hold: number): void {
    b.mode = mode;
    b.hold = hold;
    b.t = 0;
  }

  #millTarget(b: Bee): void {
    const rand = this.#random;
    this.#locate(b.hive);
    const g = this.#geo;
    b.tx = g.x + rand.range(-1, 1) * g.half;
    const hover = rand.next() < 0.45;
    b.ty = g.landY + (hover ? rand.range(0.02, 0.5) * g.s : 0);
    b.fly = hover;
    b.phase = rand.next() * TAU;
  }

  #depart(b: Bee): void {
    const rand = this.#random;
    if (rand.next() > 0.7) b.patch = this.#pickPatch();
    this.#flowerPoint(b.patch);
    b.tx = this.#pt.x;
    b.ty = this.#pt.y;
    b.fly = true;
    b.resting = false;
    this.#begin(b, "out", 0);
  }

  #home(b: Bee): void {
    const rand = this.#random;
    this.#locate(b.hive);
    const g = this.#geo;
    b.tx = g.x + rand.range(-0.8, 0.8) * g.half;
    b.ty = g.landY;
    b.fly = true;
    this.#begin(b, "home", 0);
  }

  #stepBee(b: Bee, i: number, dt: number): void {
    const rand = this.#random;
    b.age += dt;
    b.t += dt;
    if (b.fly && b.mode !== "inside" && Math.hypot(b.vx, b.vy) > 0.03) {
      b.trailClock += dt;
      if (b.trailClock >= TRAIL_EVERY) {
        b.trailClock = 0;
        b.trailHead = (b.trailHead + 1) % TRAIL_N;
        b.trail[b.trailHead * 2] = b.x;
        b.trail[b.trailHead * 2 + 1] = b.y;
        b.trailCount = Math.min(TRAIL_N, b.trailCount + 1);
      }
    } else {
      b.trailCount = 0;
      b.trailClock = 0;
    }
    switch (b.mode) {
      case "inside": {
        if (i >= this.#beeCount) break;
        b.hold -= dt;
        if (b.hold > 0) break;
        this.#locate(b.hive);
        const g = this.#geo;
        b.x = g.x + rand.range(-0.7, 0.7) * g.half;
        b.y = g.landY;
        b.vx = 0;
        b.vy = 0;
        if (b.newbie) {
          this.#begin(b, "orient", rand.range(9, 16));
          b.fly = true;
          b.phase = rand.next() * TAU;
        } else if (rand.next() < 0.4) {
          this.#begin(b, "mill", rand.range(4, 10));
          this.#millTarget(b);
        } else {
          this.#depart(b);
        }
        break;
      }
      case "mill": {
        b.hold -= dt;
        this.#steerMill(b, dt);
        if (b.age % 1.7 < dt) this.#millTarget(b);
        if (b.hold <= 0) {
          if (!b.newbie && i < this.#beeCount && rand.next() < 0.6) this.#depart(b);
          else this.#enter(b, i);
        }
        break;
      }
      case "orient": {
        this.#locate(b.hive);
        const g = this.#geo;
        const a = ORIENT_RATE * b.t + b.phase;
        b.tx = g.x + 0.9 * g.s * Math.cos(a);
        b.ty = g.base + (BEES_HIVE.stand + 0.1) * g.s + 0.5 * g.s * (0.6 + 0.4 * Math.sin(2 * a));
        this.#seek(b, 0.5, 0.11, dt);
        b.hold -= dt;
        if (b.hold <= 0) {
          b.newbie = false;
          this.#home(b);
        }
        break;
      }
      case "out": {
        if (this.#steer(b, CRUISE, 0.03, dt) < ARRIVE) {
          b.visits = 3 + rand.int(5);
          b.resting = true;
          b.fly = false;
          this.#begin(b, "forage", rand.range(0.6, 1.6));
        }
        break;
      }
      case "forage": {
        if (b.resting) {
          b.hold -= dt;
          b.vx *= Math.exp(-dt * 6);
          b.vy *= Math.exp(-dt * 6);
          if (b.hold > 0) break;
          if (b.visits <= 0) {
            this.#home(b);
            break;
          }
          this.#nextFlower(b);
          break;
        }
        if (this.#steer(b, HOP, 0.1, dt) < ARRIVE) {
          b.visits -= 1;
          b.load = Math.min(1, b.load + 0.22);
          b.resting = true;
          b.fly = false;
          b.hold = rand.range(0.5, 1.8);
        }
        break;
      }
      case "home": {
        if (this.#steer(b, CRUISE, 0.03, dt) < ARRIVE) {
          b.fly = false;
          this.#begin(b, "land", rand.range(0.5, 1.2));
        }
        break;
      }
      case "land": {
        b.hold -= dt;
        const k = 1 - Math.exp(-dt * 5);
        b.x += (b.tx - b.x) * k;
        b.y += (b.ty - b.y) * k;
        b.vx = 0;
        b.vy = 0;
        if (b.hold <= 0) {
          if (rand.next() < 0.65) {
            this.#begin(b, "mill", rand.range(4, 9));
            this.#millTarget(b);
            b.load = 0;
          } else {
            this.#enter(b, i);
          }
        }
        break;
      }
      default: {
        const unreachable: never = b.mode;
        throw new BeesSimError(`unknown bee mode ${String(unreachable)}`);
      }
    }
  }

  /** Walk or hover toward the mill target; returns the distance left. */
  #steerMill(b: Bee, dt: number): number {
    const dx = b.tx - b.x;
    const dy = b.ty - b.y;
    const dist = Math.hypot(dx, dy) + 1e-6;
    const go = MILL_SPEED * b.pace * smoothstep(0, 0.02, dist);
    const k = 1 - Math.exp(-dt / 0.3);
    b.vx += (dx / dist * go - b.vx) * k;
    b.vy += (dy / dist * go - b.vy) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    return dist;
  }

  /** The next flower of a foraging bee: a short zig-zag hop within its patch. */
  #nextFlower(b: Bee): void {
    const rand = this.#random;
    const patch = BEES_PATCHES[b.patch];
    if (patch === undefined) throw new BeesSimError(`no patch ${b.patch}`);
    const a = rand.next() * TAU;
    const r = rand.range(0.02, 0.055);
    let x = b.x + Math.cos(a) * r;
    let y = b.y + Math.sin(a) * r * 0.6;
    const ex = (x / this.#stage - patch.f) / patch.rx;
    const ey = (y - patch.y) / patch.ry;
    const e = Math.hypot(ex, ey);
    if (e > 0.9) {
      x = (patch.f + (ex / e) * 0.9 * patch.rx) * this.#stage;
      y = patch.y + (ey / e) * 0.9 * patch.ry;
    }
    b.tx = x;
    b.ty = y;
    b.phase = rand.next() * TAU;
    b.resting = false;
    b.fly = true;
    b.t = 0.5;
  }

  // ---- butterflies --------------------------------------------------------------------------

  #waypoint(g: Butterfly, mayPerch: boolean): void {
    const rand = this.#random;
    g.wayLeft = rand.range(2.5, 5);
    if (mayPerch && g.quiet <= 0 && rand.next() < 0.45) {
      g.patch = this.#pickPatch();
      this.#flowerPoint(g.patch);
      g.tx = this.#pt.x;
      g.ty = this.#pt.y + 0.004;
      g.mode = "approach";
      g.gliding = false;
      g.t = 0;
      return;
    }
    // Wander over the flowers, a little above them.
    this.#flowerPoint(this.#pickPatch());
    g.tx = this.#pt.x + rand.range(-0.06, 0.06);
    g.ty = clamp(this.#pt.y + rand.range(0.03, 0.12), 0.1, 0.6);
  }

  #stepButterfly(g: Butterfly, dt: number): void {
    g.age += dt;
    g.t += dt;
    const rand = this.#random;
    if (g.mode === "settle") {
      g.hold -= dt;
      g.vx *= Math.exp(-dt * 6);
      g.vy *= Math.exp(-dt * 6);
      // The wings sit open and close again, slowly, with a pause at the top.
      const slow = 0.5 + 0.5 * Math.cos(TAU * g.t / 6.5 + g.phase);
      const toward = smoothstep(0, 1.2, g.t);
      g.open = lerp(g.openStart, 0.08 + 0.92 * smoothstep(0.05, 0.75, slow), toward);
      if (g.hold <= 0) {
        g.mode = "fly";
        g.quiet = rand.range(10, 24);
        g.glide = 0;
        g.gliding = false;
        g.glideLeft = rand.range(2, 4);
        g.vy = 0.05;
        this.#waypoint(g, false);
      }
      return;
    }
    g.glideLeft -= dt;
    if (g.glideLeft <= 0 && g.mode === "fly") {
      g.gliding = !g.gliding;
      g.glideLeft = g.gliding ? rand.range(0.9, 2.2) : rand.range(2.2, 5);
    }
    g.quiet -= dt;
    g.glide += ((g.gliding ? 1 : 0) - g.glide) * (1 - Math.exp(-dt / 0.35));
    g.flap += TAU * lerp(3.1, 1.1, g.glide) * g.pace * dt;
    const beat = Math.cos(g.flap);
    g.open = lerp(0.5 + 0.5 * beat, 0.82 + 0.12 * beat, g.glide);

    let dist: number;
    let speed: number;
    if (g.mode === "fly") {
      g.wayLeft -= dt;
      dist = Math.hypot(g.tx - g.x, g.ty - g.y);
      if (dist < 0.05 || g.wayLeft <= 0) this.#waypoint(g, true);
      speed = lerp(BUTTERFLY_SPEED, BUTTERFLY_GLIDE_SPEED, g.glide);
    } else {
      dist = Math.hypot(g.tx - g.x, g.ty - g.y);
      speed = 0.03 * smoothstep(0, 0.08, dist) + 0.008;
    }
    const dx = g.tx - g.x;
    const dy = g.ty - g.y;
    dist = Math.hypot(dx, dy) + 1e-6;
    const ux = dx / dist;
    const uy = dy / dist;
    const meander = (0.05 * Math.sin(TAU * 0.31 * g.age + g.phase) + 0.03 * Math.sin(TAU * 0.83 * g.age + 2.1 * g.phase)) * (g.mode === "approach" ? smoothstep(0.02, 0.12, dist) : 1);
    const k = 1 - Math.exp(-dt / 0.55);
    g.vx += (ux * speed - uy * meander - g.vx) * k;
    g.vy += (uy * speed + ux * meander - 0.01 * g.glide - g.vy) * k;
    // Every downstroke lifts the butterfly and every upstroke lets it fall: the bobbing flight.
    const bob = -0.085 * Math.sin(g.flap) * (1 - g.glide);
    g.x += g.vx * dt;
    g.y += (g.vy + bob) * dt;
    if (g.mode === "approach" && dist < ARRIVE + 0.002) {
      g.mode = "settle";
      g.t = 0;
      g.hold = rand.range(8, 15);
      g.openStart = g.open;
      g.phase = rand.next() * TAU;
    }
  }

  // ---- drawing into the cell map ---------------------------------------------------------------

  #plot(ux: number, uy: number, code: number): void {
    const u = this.#unit;
    const w = this.#width;
    const h = this.#height;
    for (let dy = 0; dy < u; dy++) {
      const y = uy * u + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = 0; dx < u; dx++) {
        const x = ux * u + dx;
        if (x < 0 || x >= w) continue;
        const at = y * w + x;
        this.#cells[at] = code;
        this.#written.push(at);
      }
    }
  }

  #block(ux: number, uy: number, bw: number, bh: number, code: number): void {
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) this.#plot(ux + i, uy + j, code);
  }

  #paint(): void {
    for (const at of this.#written) this.#cells[at] = 0;
    this.#written.length = 0;
    const u = this.#unit;
    const h = this.#height;
    const w = this.#width;
    for (const b of this.#bees) {
      if (b.mode === "inside") continue;
      b.cx = follow(b.cx, (b.x * h + 0.5 * w) / u);
      b.cy = follow(b.cy, (b.y * h) / u);
      if (!b.fly) continue;
      for (let j = 0; j < b.trailCount; j++) {
        const s = ((b.trailHead - j + TRAIL_N) % TRAIL_N) * 2;
        const tx = Math.floor(((b.trail[s] ?? 0) * h + 0.5 * w) / u);
        const ty = Math.floor(((b.trail[s + 1] ?? 0) * h) / u);
        if (Math.abs(tx - b.cx) > 1 || Math.abs(ty - b.cy) > 1) this.#plot(tx, ty, BEES_CODE.trail);
      }
    }
    for (const b of this.#bees) {
      if (b.mode === "inside") continue;
      // A dark body two cells long (golden at the back when it carries pollen) and, in flight, a pale glint of wing above it.
      this.#plot(b.cx, b.cy, BEES_CODE.bee);
      this.#plot(b.cx + 1, b.cy, b.load > 0.5 ? BEES_CODE.beeLoaded : BEES_CODE.bee);
      if (b.fly) this.#plot(b.cx, b.cy + 1, BEES_CODE.beeWing);
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      g.cx = follow(g.cx, (g.x * h + 0.5 * w) / u);
      g.cy = follow(g.cy, (g.y * h) / u);
      const open = BUTTERFLY_OPEN[g.kind] ?? BEES_CODE.orange;
      const shut = BUTTERFLY_SHUT[g.kind] ?? BEES_CODE.orangeDim;
      // The wingbeat is the size of the speck: wide open it is five cells across, closed a sliver.
      if (g.open > 0.62) {
        this.#block(g.cx - 2, g.cy, 2, 2, open);
        this.#block(g.cx + 1, g.cy, 2, 2, open);
        this.#block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody);
      } else if (g.open > 0.3) {
        this.#block(g.cx - 1, g.cy, 1, 2, open);
        this.#block(g.cx + 1, g.cy, 1, 2, open);
        this.#block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody);
      } else {
        this.#block(g.cx, g.cy, 1, 2, shut);
      }
    }
  }
}

/** The colony's simulation, for a scene whose `params` carry the knobs BeesKnob names. */
export function beesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BeesSim(gl, params);
}
