// The flower border's simulation: the flowers in the breeze, the bees that forage them and the
// butterflies that drift between them. Everything here is drawn by shader.ts as sprites.
//
// The border. Up to BEES_MAX_FLOWERS flowers, laid out from the arrangement seed, sorted from the
// farthest to the nearest (row 0 is the farthest). Each has a depth d (0 close to the lens, 1 far
// away, where the hedge stands), which sets its size and, with the focus knob, how far out of focus
// it is. Heads sit at x (screen heights from the middle of the view) and uv height y on a stem rooted
// below the frame. A flower sways on a damped spring driven by the breeze (a slow travelling swell
// plus gusts); a second, livelier spring dips the head under a landed creature's weight and lets it
// spring back when the creature leaves.
//
// Bees (up to BEES_MAX_BEES) keep a small state machine, each step a fixed 1/60 s:
//   fly     steer to a hover point beside the flower they have chosen along a curved path (a slow
//           lateral weave on the way), the size and focus following the flower's depth as they go;
//   hover   hang in front of it a moment, wobbling a little;
//   alight  settle onto the flower, the wings folding;
//   crawl   walk the head for a few seconds (the flower dips under the weight), collecting pollen;
//   lift    wings open, the flower springs back, up and away; then the next flower is chosen.
// A flower holds one creature at a time (`claim`).
//
// Butterflies (up to BEES_MAX_BUTTERFLIES: peacock, cabbage white, swallowtail) wander between
// waypoints in an erratic lazy gait: bursts of wingbeats around 2 Hz with lift on each downstroke,
// then glides on spread wings that sink a little. Now and then one chooses a free flower, perches,
// and opens and closes its wings slowly (showing the underside as they close) before flying on.
//
// Textures (rows bottom to top; both rgba16f, nearest, read with texelFetch):
//   uSim0  BEES_FLOWER_TEXELS × BEES_MAX_FLOWERS, row = flower, far to near; inactive rows have R 0
//          and depth -1.
//          texel 0: head x, head y, stem root x, head radius R (screen heights; for lavender half the
//                   spike's length)
//          texel 1: depth, type (0 lavender, 1 cosmos, 2 poppy, 3 echinacea, 4 clover), head tilt
//                   (rad), hash 0..1
//          texel 2: petal rgb, 1;   texel 3: tip rgb, 1
//   uSim1  BEES_AGENT_TEXELS × BEES_AGENTS, row = agent (bees first, then butterflies).
//          texel 0: x, y, size (bee body length, butterfly half span), presence 0..1 (0: absent)
//          texel 1: depth, kind (0 bee, 1 peacock, 2 cabbage white, 3 swallowtail), 0, 0
//          texel 2: bee: facing -1..1 (the sign mirrors it, near 0 it turns), pitch (rad), wings
//                   0..1 (folded..a blur), pollen 0..1; butterfly: tilt (rad), wings 0..1 (closed..
//                   open), underside 0..1, 0
//          texel 3: bee: leg phase, how much it walks 0..1, 0, 0; butterfly: 0
// A flower row's depth is always at least BEES_Z_LAND apart from a creature's resting on it, so the
// shader can draw a landed creature just after its flower.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

export const BEES_MAX_FLOWERS = 32;
export const BEES_MIN_FLOWERS = 16;
export const BEES_MAX_BEES = 6;
export const BEES_MAX_BUTTERFLIES = 3;
export const BEES_AGENTS = BEES_MAX_BEES + BEES_MAX_BUTTERFLIES;
export const BEES_FLOWER_TEXELS = 4;
export const BEES_AGENT_TEXELS = 4;
/** The trigger slot of the M's bloom ("now" sends a pulse of light along it). */
export const BEES_MARK_TRIGGER = 0;
/** Size of a thing at the lens (depth 0) and at the hedge (depth 1), relative to depth 0.5's. */
export const BEES_SCALE_NEAR = 1.5;
export const BEES_SCALE_FAR = 0.45;
/** Stems are rooted this far down (uv), below the frame. */
export const BEES_ROOT_Y = -0.1;

const FLOWER_LAVENDER = 0;
const FLOWER_CLOVER = 4;
const FLOWER_TYPES = 5;
/** Head radius at scale 1 (lavender: half the spike's length), screen heights. */
const FLOWER_RADIUS: readonly number[] = [0.12, 0.058, 0.06, 0.05, 0.03];

const KIND_PEACOCK = 1;
const KIND_WHITE = 2;
const KIND_SWALLOWTAIL = 3;
const BUTTERFLY_KINDS: readonly number[] = [KIND_PEACOCK, KIND_WHITE, KIND_SWALLOWTAIL];

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

interface Variety {
  petal: Rgb;
  tip: Rgb;
}

const variety = (petal: string, tip: string): Variety => ({ petal: rgb(petal), tip: rgb(tip) });

/** How common each flower type is (indexed by type) and the colours each comes in. */
interface PalettePlan {
  weights: readonly number[];
  varieties: readonly (readonly Variety[])[];
}

const COTTAGE: PalettePlan = {
  weights: [0.2, 0.25, 0.15, 0.2, 0.2],
  varieties: [
    [variety("#7e55c8", "#b49cf0"), variety("#9a6fd8", "#d0b8f6")],
    [variety("#e8639e", "#f6a8c8"), variety("#f3ece6", "#fff6f0"), variety("#d2398a", "#ee7fb4")],
    [variety("#e23a20", "#f2704a"), variety("#f08428", "#f8b050")],
    [variety("#c4529f", "#e68fc8"), variety("#d870b4", "#f0b0dc")],
    [variety("#d77ac0", "#f2c4e8"), variety("#f4ece4", "#ffffff")],
  ],
};

const WARM: PalettePlan = {
  weights: [0.06, 0.26, 0.28, 0.26, 0.14],
  varieties: [
    [variety("#d9885a", "#f0b890")],
    [variety("#f58a2c", "#fdbb60"), variety("#f7d242", "#fff08a"), variety("#e8552a", "#f59a60")],
    [variety("#e2301c", "#f46a3a"), variety("#f0952a", "#f8c060")],
    [variety("#f2b21a", "#fad65a"), variety("#e8892a", "#f6bb62")],
    [variety("#f0aa8a", "#fad4c0")],
  ],
};

const COOL: PalettePlan = {
  weights: [0.3, 0.22, 0.14, 0.14, 0.2],
  varieties: [
    [variety("#6a5ad8", "#a89af2"), variety("#8c6ee0", "#c8b4f8")],
    [variety("#f4f0f8", "#ffffff"), variety("#b8a0ec", "#dcd0f8")],
    [variety("#4c72d8", "#88a8f0"), variety("#6c5cd0", "#a49af0")],
    [variety("#f0e6f2", "#ffffff")],
    [variety("#f0e8f0", "#ffffff"), variety("#c8a8e8", "#e6d4f8")],
  ],
};

const PALETTES: readonly PalettePlan[] = [COTTAGE, WARM, COOL];

// ---- tuning ----------------------------------------------------------------------------------

const STEP = 1 / 60;
const MAX_STEPS = 6;
/** Seconds run before the first picture (and after a new arrangement), so the creatures are spread out. */
const WARM_SECONDS = 12;
const WARM_STEPS = Math.round(WARM_SECONDS / STEP);
/** Half the width the border is laid over, screen heights (frames up to aspect 2.6). */
const FLOWER_HALF = 1.3;
/** Heads in this x range stay below the M's bloom (uv height). */
const MARK_X_MIN = 0.02;
const MARK_X_MAX = 0.66;
const MARK_BOTTOM = 0.5;

// Flowers.
/** Lean: how far a head sways per unit of lean and stem length; spring frequencies (Hz), damping. */
const LEAN_SCALE = 0.03;
const LEAN_FREQ_MIN = 0.32;
const LEAN_FREQ_SPAN = 0.25;
const LEAN_DAMPING = 0.32;
const DIP_FREQ = 0.75;
const DIP_DAMPING = 0.3;
/** Head drop per unit of dip: constant plus a share of the head radius. */
const DIP_BASE = 0.01;
const DIP_RADIUS = 0.22;
const BEE_LOAD = 1;
const BUTTERFLY_LOAD = 0.4;

// Creatures.
const BEE_LENGTH = 0.052;
const BUTTERFLY_SPAN = 0.064;
const FADE_TIME = 1.5;
/** A resting creature is this much nearer than its flower (depth). */
export const BEES_Z_LAND = 0.003;
const BEE_SPEED = 0.16;
const BEE_TAU = 0.55;
const BEE_WOBBLE = 0.05;
const WALK_RATE = 0.85;
const BUTTERFLY_SPEED_MIN = 0.05;
const BUTTERFLY_SPEED_MAX = 0.095;

interface Spring {
  x: number;
  v: number;
}

/** One semi-implicit Euler step of a damped spring toward target. */
function springStep(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  s.v += (omega * omega * (target - s.x) - 2 * zeta * omega * s.v) * dt;
  s.x += s.v * dt;
}

interface Flower {
  x: number;
  y: number;
  rootX: number;
  R: number;
  depth: number;
  type: number;
  tilt: number;
  hash: number;
  petal: Rgb;
  tip: Rgb;
  amp: number;
  side: number;
  omega: number;
  lean: Spring;
  dip: Spring;
  load: number;
  /** The creature (agent id) that has chosen or sits on it, or -1. */
  claim: number;
  hx: number;
  hy: number;
  ht: number;
}

type BeeMode = "fly" | "hover" | "alight" | "crawl" | "lift";

interface Bee {
  active: boolean;
  leaving: boolean;
  present: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  face: number;
  faceT: number;
  pitch: number;
  pitchT: number;
  wing: number;
  pollen: number;
  leg: number;
  crawl: number;
  mode: BeeMode;
  timer: number;
  age: number;
  phase: number;
  dwell: number;
  flower: number;
  side: number;
  startZ: number;
  startDist: number;
  walk: number;
}

type ButterflyMode = "flutter" | "approach" | "perch";

interface Butterfly {
  active: boolean;
  leaving: boolean;
  present: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  tilt: number;
  flap: number;
  energy: number;
  glide: number;
  flapping: boolean;
  flapTimer: number;
  wing: number;
  under: number;
  mode: ButterflyMode;
  timer: number;
  age: number;
  phase: number;
  phase2: number;
  wx: number;
  wy: number;
  wz: number;
  wayTimer: number;
  flower: number;
  startZ: number;
  startDist: number;
  dwell: number;
  restTilt: number;
}

type BeesKnob = "bees" | "butterflies" | "palette" | "flowers" | "gardenSeed" | "breeze";

export class BeesSimError extends Error {}

function newBee(): Bee {
  return {
    active: false, leaving: false, present: 0, x: 0, y: 0, z: 0.5, vx: 0, vy: 0, face: 1, faceT: 1, pitch: 0, pitchT: 0,
    wing: 1, pollen: 0.3, leg: 0, crawl: 0, mode: "fly", timer: 0, age: 0, phase: 0, dwell: 4, flower: -1, side: 1,
    startZ: 0.5, startDist: 0.5, walk: 0,
  };
}

function newButterfly(kind: number): Butterfly {
  return {
    active: false, leaving: false, present: 0, kind, x: 0, y: 0, z: 0.5, vx: 0, vy: 0, tilt: 0, flap: 0, energy: 1,
    glide: 0, flapping: true, flapTimer: 3, wing: 1, under: 0, mode: "flutter", timer: 0, age: 0, phase: 0, phase2: 0,
    wx: 0, wy: 0.5, wz: 0.5, wayTimer: 3, flower: -1, startZ: 0.5, startDist: 0.5, dwell: 9, restTilt: 0,
  };
}

/** Size scale for a depth, as the shader's beesScale. */
export function beesScale(depth: number): number {
  return lerp(BEES_SCALE_NEAR, BEES_SCALE_FAR, depth);
}

class BeesSim implements SceneSim {
  readonly #knobs: KnobReader<BeesKnob>;
  readonly #flowerTexture: DataTexture;
  readonly #agentTexture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #flowerData = new Float32Array(BEES_FLOWER_TEXELS * BEES_MAX_FLOWERS * 4);
  readonly #agentData = new Float32Array(BEES_AGENT_TEXELS * BEES_AGENTS * 4);
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #random = new Random();
  readonly #weights = new Float64Array(BEES_MAX_FLOWERS);
  readonly #pt = { x: 0, y: 0, pitch: 0, face: 1 };
  readonly #flowers: Flower[] = [];
  readonly #bees: Bee[] = Array.from({ length: BEES_MAX_BEES }, newBee);
  readonly #butterflies: Butterfly[] = BUTTERFLY_KINDS.map((kind) => newButterfly(kind));
  #layoutKey = "";
  #aspect = 16 / 9;
  #breeze = 0.4;
  #time = 0;
  #dirty = true;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<BeesKnob>("bees", params, ["bees", "butterflies", "palette", "flowers", "gardenSeed", "breeze"]);
    this.#flowerTexture = new DataTexture(gl, { width: BEES_FLOWER_TEXELS, height: BEES_MAX_FLOWERS, format: "rgba16f", filter: "nearest" });
    this.#agentTexture = new DataTexture(gl, { width: BEES_AGENT_TEXELS, height: BEES_AGENTS, format: "rgba16f", filter: "nearest" });
    this.#textures = [this.#flowerTexture.texture, this.#agentTexture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#breeze = clamp(knobs.value(frame, "breeze"), 0, 1);
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    const arrangement = Math.round(knobs.value(frame, "gardenSeed"));
    const palette = Math.round(knobs.value(frame, "palette"));
    const count = Math.round(lerp(BEES_MIN_FLOWERS, BEES_MAX_FLOWERS, clamp(knobs.value(frame, "flowers"), 0, 1)));
    const key = `${arrangement}:${palette}:${count}`;
    const rebuilt = key !== this.#layoutKey;
    if (rebuilt) {
      this.#layoutKey = key;
      this.#build(arrangement, palette, count);
    }
    const bees = clamp(Math.round(knobs.value(frame, "bees")), 0, BEES_MAX_BEES);
    const butterflies = clamp(Math.round(knobs.value(frame, "butterflies")), 0, BEES_MAX_BUTTERFLIES);
    this.#setCounts(bees, butterflies, rebuilt);
    if (rebuilt) {
      for (let i = 0; i < WARM_STEPS; i++) this.#step(STEP);
      this.#dirty = true;
    }

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) this.#step(STEP);
    if (steps > 0 || this.#dirty) {
      this.#pack();
      this.#flowerTexture.upload(this.#flowerData);
      this.#agentTexture.upload(this.#agentData);
      this.#dirty = false;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#flowerTexture.dispose();
    this.#agentTexture.dispose();
  }

  // ---- layout -----------------------------------------------------------------------------

  #build(arrangement: number, paletteIndex: number, count: number): void {
    const rand = this.#random;
    rand.seed(Math.imul(arrangement + 1, 0x9e3779b1) ^ 0x2f6b1a);
    const plan = PALETTES[paletteIndex] ?? COTTAGE;
    const slots = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = rand.int(i + 1);
      const a = slots[i];
      const b = slots[j];
      if (a === undefined || b === undefined) continue;
      slots[i] = b;
      slots[j] = a;
    }
    const total = plan.weights.reduce((sum, w) => sum + w, 0);
    this.#flowers.length = 0;
    for (let r = 0; r < count; r++) {
      const depth = 1 - (r + 0.2 + 0.6 * rand.next()) / count;
      let pick = rand.next() * total;
      let type = FLOWER_TYPES - 1;
      for (let t = 0; t < FLOWER_TYPES; t++) {
        pick -= plan.weights[t] ?? 0;
        if (pick <= 0) {
          type = t;
          break;
        }
      }
      const choice = rand.pick(plan.varieties[type] ?? COTTAGE.varieties[0] ?? []);
      const R = (FLOWER_RADIUS[type] ?? 0.05) * beesScale(depth) * (0.85 + 0.3 * rand.next());
      const x = -FLOWER_HALF + (((slots[r] ?? r) + 0.15 + 0.7 * rand.next()) / count) * 2 * FLOWER_HALF;
      let y = lerp(0.2, 0.36, depth) + rand.next() * lerp(0.48, 0.38, depth);
      y = Math.min(y, 0.84 - 1.1 * R);
      if (x > MARK_X_MIN && x < MARK_X_MAX) y = Math.max(Math.min(y, MARK_BOTTOM - 1.15 * R), 0.14);
      const lean = { x: 0, v: 0 };
      const dip = { x: 0, v: 0 };
      const tilt = (rand.next() - 0.5) * (type === FLOWER_LAVENDER ? 0.2 : 0.5);
      this.#flowers.push({
        x, y, rootX: x + (rand.next() - 0.5) * 0.12, R, depth, type, tilt, hash: rand.next(),
        petal: choice.petal, tip: choice.tip, amp: 0.7 + 0.6 * rand.next(), side: rand.next() < 0.5 ? -1 : 1,
        omega: TAU * (LEAN_FREQ_MIN + LEAN_FREQ_SPAN * rand.next()) / (0.8 + 2 * R),
        lean, dip, load: 0, claim: -1, hx: x, hy: y, ht: tilt,
      });
    }
    for (const bee of this.#bees) {
      bee.active = false;
      bee.flower = -1;
    }
    for (const butterfly of this.#butterflies) {
      butterfly.active = false;
      butterfly.flower = -1;
    }
  }

  // ---- stepping ----------------------------------------------------------------------------

  #step(dt: number): void {
    this.#time += dt;
    const tm = this.#time;
    for (const f of this.#flowers) this.#stepFlower(f, tm, dt);
    for (const [i, bee] of this.#bees.entries()) if (bee.active) this.#stepBee(bee, i, dt);
    for (const [j, butterfly] of this.#butterflies.entries()) if (butterfly.active) this.#stepButterfly(butterfly, BEES_MAX_BEES + j, dt);
  }

  #windAt(x: number, tm: number): number {
    const slow = 0.55 * Math.sin(0.62 * tm - 2.3 * x) + 0.3 * Math.sin(0.27 * tm + 1.7 * x + 1.3);
    const swell = Math.max(0, Math.sin(0.11 * tm - 1.2 * x)) ** 2;
    return this.#breeze * (slow + 0.9 * swell) + 0.07 * Math.sin(0.9 * tm + 5 * x);
  }

  #stepFlower(f: Flower, tm: number, dt: number): void {
    springStep(f.lean, this.#windAt(f.x, tm) * 0.5, f.omega, LEAN_DAMPING, dt);
    springStep(f.dip, f.load, TAU * DIP_FREQ, DIP_DAMPING, dt);
    f.hx = f.x + f.lean.x * LEAN_SCALE * f.amp * (f.y - BEES_ROOT_Y);
    f.hy = f.y - f.dip.x * (DIP_BASE + DIP_RADIUS * f.R) - Math.abs(f.hx - f.x) * 0.25;
    f.ht = f.tilt + f.lean.x * 0.14 + f.dip.x * 0.16 * f.side;
  }


  /** A free flower in view near (x, y, z), chosen at random weighted by closeness; -1 when none is free. */
  #pickFlower(x: number, y: number, z: number, exclude: number): number {
    const weights = this.#weights;
    let total = 0;
    let nearest = -1;
    let nearestDist = Infinity;
    for (const [j, f] of this.#flowers.entries()) {
      let w = 0;
      if (f.claim < 0 && j !== exclude) {
        const dist = Math.hypot(f.hx - x, f.hy - y);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = j;
        }
        const dz = Math.abs(f.depth - z);
        const visible = Math.abs(f.hx) < 0.5 * this.#aspect - 0.04 && f.hy > 0.1 && f.hy < 0.92;
        if (visible && dz <= 0.5) w = Math.exp(-dist / 0.45) * (1 - 0.8 * dz);
      }
      weights[j] = w;
      total += w;
    }
    if (total <= 0) return nearest;
    let pick = this.#random.next() * total;
    for (let j = 0; j < this.#flowers.length; j++) {
      pick -= weights[j] ?? 0;
      if (pick <= 0) return j;
    }
    return nearest;
  }

  // ---- bees ---------------------------------------------------------------------------------

  #setCounts(bees: number, butterflies: number, inView: boolean): void {
    for (const [i, bee] of this.#bees.entries()) {
      if (i < bees) {
        if (!bee.active) this.#spawnBee(bee, i, inView);
        else bee.leaving = false;
      } else if (bee.active && !bee.leaving) {
        this.#releaseFlower(bee.flower, i);
        bee.flower = -1;
        bee.leaving = true;
      }
    }
    for (const [j, butterfly] of this.#butterflies.entries()) {
      const id = BEES_MAX_BEES + j;
      if (j < butterflies) {
        if (!butterfly.active) this.#spawnButterfly(butterfly, id, inView);
        else butterfly.leaving = false;
      } else if (butterfly.active && !butterfly.leaving) {
        this.#releaseFlower(butterfly.flower, id);
        butterfly.flower = -1;
        butterfly.leaving = true;
      }
    }
  }

  #releaseFlower(index: number, id: number): void {
    const f = index >= 0 ? this.#flowers[index] : undefined;
    if (f !== undefined && f.claim === id) {
      f.claim = -1;
      f.load = 0;
    }
  }

  #spawnBee(b: Bee, id: number, inView: boolean): void {
    const rand = this.#random;
    b.active = true;
    b.leaving = false;
    b.present = inView ? 1 : 0;
    b.age = rand.next() * 20;
    b.phase = rand.next() * TAU;
    b.pollen = 0.15 + 0.4 * rand.next();
    b.leg = 0;
    b.crawl = 0;
    b.wing = 1;
    b.mode = "fly";
    b.timer = 2;
    b.walk = rand.next() * TAU;
    b.z = 0.1 + 0.8 * rand.next();
    b.y = 0.3 + 0.45 * rand.next();
    if (inView) {
      b.x = (rand.next() * 2 - 1) * 0.4 * this.#aspect;
      b.vx = 0;
    } else {
      const side = rand.next() < 0.5 ? -1 : 1;
      b.x = side * (0.5 * this.#aspect + 0.1);
      b.vx = -side * 0.1;
    }
    b.vy = 0;
    b.face = b.vx >= 0 ? 1 : -1;
    b.faceT = b.face;
    b.pitch = 0;
    b.pitchT = 0;
    b.flower = -1;
    this.#beeTarget(b, id, -1);
  }

  #beeTarget(b: Bee, id: number, exclude: number): void {
    b.mode = "fly";
    b.timer = 0;
    const j = this.#pickFlower(b.x, b.y, b.z, exclude);
    const f = j >= 0 ? this.#flowers[j] : undefined;
    if (f === undefined) {
      b.flower = -1;
      return;
    }
    f.claim = id;
    b.flower = j;
    b.side = b.x < f.hx ? -1 : 1;
    this.#landBee(f, b.walk);
    this.#hoverPoint(f, b);
    b.startZ = b.z;
    b.startDist = Math.hypot(this.#pt.x - b.x, this.#pt.y - b.y);
  }

  /** Where on flower f a bee at walk phase `walk` stands, and how it faces: written to #pt. */
  #landBee(f: Flower, walk: number): void {
    const pt = this.#pt;
    if (f.type === FLOWER_LAVENDER) {
      const along = (0.18 + 0.4 * Math.sin(walk * 0.6)) * f.R;
      pt.x = f.hx - Math.sin(f.ht) * along;
      pt.y = f.hy + Math.cos(f.ht) * along;
      pt.pitch = 1.3 * Math.tanh(4 * Math.cos(walk * 0.6));
      pt.face = 1;
    } else if (f.type === FLOWER_CLOVER) {
      const s = 0.3 * Math.sin(walk);
      pt.x = f.hx + s * f.R;
      pt.y = f.hy + 0.55 * f.R * Math.sqrt(1 - s * s);
      pt.pitch = 0.3 * Math.cos(walk);
      pt.face = Math.cos(walk) >= 0 ? 1 : -1;
    } else {
      pt.x = f.hx + 0.26 * f.R * Math.sin(walk);
      pt.y = f.hy + 0.05 * f.R + 0.08 * f.R * Math.sin(2 * walk + 0.7);
      pt.pitch = 0.12 * Math.cos(2 * walk);
      pt.face = Math.cos(walk) >= 0 ? 1 : -1;
    }
  }

  /** The bee's hover point beside flower f on its side, from the landing point left in #pt (written back to #pt). */
  #hoverPoint(f: Flower, b: Bee): void {
    const len = BEE_LENGTH * beesScale(f.depth);
    const pt = this.#pt;
    if (f.type === FLOWER_LAVENDER) {
      pt.x += b.side * (0.9 * len + 0.02);
      pt.y += 0.25 * len;
    } else {
      pt.x += b.side * (0.75 * f.R + 0.7 * len);
      pt.y += 0.2 * f.R + 0.35 * len;
    }
  }

  #stepBee(b: Bee, id: number, dt: number): void {
    b.age += dt;
    b.timer += dt;
    b.present = clamp(b.present + (b.leaving ? -dt : dt) / FADE_TIME, 0, 1);
    if (b.leaving && b.present <= 0) {
      b.active = false;
      return;
    }
    const f = b.flower >= 0 ? this.#flowers[b.flower] : undefined;
    b.crawl = b.mode === "crawl" ? Math.min(1, b.crawl + dt * 2) : Math.max(0, b.crawl - dt * 3);
    switch (b.mode) {
      case "fly":
        this.#beeFly(b, id, f, dt);
        break;
      case "hover":
        this.#beeHover(b, f, dt);
        break;
      case "alight":
        this.#beeAlight(b, f, dt);
        break;
      case "crawl":
        this.#beeCrawl(b, f, dt);
        break;
      case "lift":
        this.#beeLift(b, id, f, dt);
        break;
      default: {
        const unreachable: never = b.mode;
        throw new BeesSimError(`unknown bee mode ${String(unreachable)}`);
      }
    }
    const turn = 1 - Math.exp(-dt / 0.22);
    b.face += (b.faceT - b.face) * turn;
    b.pitch += (b.pitchT - b.pitch) * (1 - Math.exp(-dt / 0.3));
    b.leg += dt * 6 * b.crawl;
  }

  #beeFly(b: Bee, id: number, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      // Nothing free: drift in a lazy circle and look again.
      b.vx += (0.02 * Math.cos(b.age) - b.vx) * (1 - Math.exp(-dt / 0.8));
      b.vy += (0.012 * Math.sin(b.age * 1.3) - b.vy) * (1 - Math.exp(-dt / 0.8));
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.wing = 1;
      b.pitchT = 0;
      if (b.timer > 1.5) this.#beeTarget(b, id, -1);
      return;
    }
    this.#landBee(f, b.walk);
    this.#hoverPoint(f, b);
    const dx = this.#pt.x - b.x;
    const dy = this.#pt.y - b.y;
    const dist = Math.hypot(dx, dy) + 1e-6;
    const launch = smoothstep(0, 1.4, b.timer);
    const arrive = smoothstep(0, 0.32, dist);
    const speed = BEE_SPEED * (0.2 + 0.8 * launch) * (0.28 + 0.72 * arrive);
    const amp = BEE_WOBBLE * smoothstep(0.06, 0.4, dist);
    const wob = amp * (Math.sin(TAU * 0.29 * b.age + b.phase) + 0.45 * Math.sin(TAU * 0.71 * b.age + 2.3 * b.phase));
    const ux = dx / dist;
    const uy = dy / dist;
    const k = 1 - Math.exp(-dt / BEE_TAU);
    b.vx += (ux * speed - uy * wob - b.vx) * k;
    b.vy += (uy * speed + ux * wob + 0.006 * Math.sin(TAU * 1.3 * b.age + b.phase) - b.vy) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const progress = clamp(1 - dist / Math.max(b.startDist, 0.08), 0, 1);
    b.z = lerp(b.startZ, f.depth - BEES_Z_LAND, smoothstep(0, 1, progress));
    if (Math.abs(b.vx) > 0.02) b.faceT = Math.sign(b.vx);
    b.pitchT = clamp(b.vy * 2.2, -0.4, 0.4) + 0.3 * (1 - arrive);
    b.wing = 1;
    if (dist < 0.022 && launch > 0.5) {
      b.mode = "hover";
      b.timer = 0;
      b.dwell = this.#random.range(0.7, 1.3);
    }
  }

  #beeHover(b: Bee, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      b.mode = "fly";
      return;
    }
    this.#landBee(f, b.walk);
    this.#hoverPoint(f, b);
    const s = BEE_LENGTH * beesScale(f.depth);
    const tx = this.#pt.x + 0.1 * s * Math.sin(TAU * 0.9 * b.age + b.phase);
    const ty = this.#pt.y + 0.08 * s * Math.sin(TAU * 1.7 * b.age);
    const k = 1 - Math.exp(-dt / 0.25);
    b.vx = (tx - b.x) * k / dt;
    b.vy = (ty - b.y) * k / dt;
    b.x += (tx - b.x) * k;
    b.y += (ty - b.y) * k;
    b.z = f.depth - BEES_Z_LAND;
    b.faceT = -b.side;
    b.pitchT = 0.55;
    b.wing = 1;
    if (b.timer > b.dwell) {
      b.mode = "alight";
      b.timer = 0;
    }
  }

  #beeAlight(b: Bee, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      b.mode = "fly";
      return;
    }
    this.#landBee(f, b.walk);
    const rate = 1 - Math.exp(-dt * 2.4);
    b.x += (this.#pt.x - b.x) * rate;
    b.y += (this.#pt.y - b.y) * rate;
    b.vx *= Math.exp(-dt * 4);
    b.vy *= Math.exp(-dt * 4);
    b.z = f.depth - BEES_Z_LAND;
    b.faceT = this.#pt.face;
    b.pitchT = this.#pt.pitch;
    b.wing = 1 - smoothstep(0.1, 0.65, b.timer);
    if (b.timer > 0.9 && Math.hypot(this.#pt.x - b.x, this.#pt.y - b.y) < 0.01) {
      b.mode = "crawl";
      b.timer = 0;
      b.dwell = this.#random.range(3.2, 6.5);
      f.load = BEE_LOAD;
    }
  }

  #beeCrawl(b: Bee, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      b.mode = "fly";
      return;
    }
    b.walk += WALK_RATE * dt;
    this.#landBee(f, b.walk);
    const k = 1 - Math.exp(-dt * 8);
    b.x += (this.#pt.x - b.x) * k;
    b.y += (this.#pt.y - b.y) * k;
    b.z = f.depth - BEES_Z_LAND;
    b.faceT = this.#pt.face;
    b.pitchT = this.#pt.pitch;
    b.wing = 0;
    b.pollen = Math.min(0.9, b.pollen + 0.012 * dt);
    if (b.timer > b.dwell) {
      b.mode = "lift";
      b.timer = 0;
      f.load = 0;
    }
  }

  #beeLift(b: Bee, id: number, f: Flower | undefined, dt: number): void {
    const s = BEE_LENGTH * beesScale(b.z);
    b.wing = smoothstep(0, 0.4, b.timer);
    b.vx += (b.side * 0.03 - b.vx) * (1 - Math.exp(-dt / 0.3));
    b.vy += (0.06 - b.vy) * (1 - Math.exp(-dt / 0.3));
    b.x += b.vx * dt * (0.5 + s * 10);
    b.y += b.vy * dt * (0.5 + s * 10);
    b.pitchT = 0.35;
    b.faceT = -b.side;
    if (b.timer > 0.6) {
      const index = b.flower;
      if (f !== undefined) f.claim = -1;
      b.pollen = Math.min(1, b.pollen + 0.05);
      this.#beeTarget(b, id, index);
    }
  }

  // ---- butterflies -------------------------------------------------------------------------

  #spawnButterfly(g: Butterfly, id: number, inView: boolean): void {
    const rand = this.#random;
    g.active = true;
    g.leaving = false;
    g.present = inView ? 1 : 0;
    g.age = rand.next() * 30;
    g.phase = rand.next() * TAU;
    g.phase2 = rand.next() * TAU;
    g.flap = rand.next() * TAU;
    g.energy = 1;
    g.glide = 0;
    g.flapping = true;
    g.flapTimer = rand.range(1, 4);
    g.restTilt = (rand.next() - 0.5) * 0.4;
    g.mode = "flutter";
    g.timer = 0;
    g.under = 0;
    g.flower = -1;
    g.z = 0.15 + 0.7 * rand.next();
    g.y = 0.3 + 0.4 * rand.next();
    if (inView) {
      g.x = (rand.next() * 2 - 1) * 0.4 * this.#aspect;
    } else {
      const side = rand.next() < 0.5 ? -1 : 1;
      g.x = side * (0.5 * this.#aspect + 0.12);
    }
    g.vx = 0;
    g.vy = 0;
    this.#waypoint(g, id, false);
  }

  #waypoint(g: Butterfly, id: number, mayPerch: boolean): void {
    const rand = this.#random;
    g.wayTimer = rand.range(3, 6);
    if (mayPerch && rand.next() < 0.4) {
      const j = this.#pickFlower(g.x, g.y, g.z, -1);
      const f = j >= 0 ? this.#flowers[j] : undefined;
      if (f !== undefined) {
        f.claim = id;
        g.flower = j;
        g.mode = "approach";
        g.timer = 0;
        g.startZ = g.z;
        this.#perchPoint(f, BUTTERFLY_SPAN * beesScale(f.depth));
        g.startDist = Math.hypot(this.#pt.x - g.x, this.#pt.y - g.y);
        return;
      }
    }
    const half = 0.5 * this.#aspect - 0.1;
    g.wx = clamp(g.x + rand.range(-0.5, 0.5), -half, half);
    g.wy = clamp(g.y + rand.range(-0.25, 0.25), 0.26, 0.78);
    g.wz = rand.range(0.12, 0.92);
  }

  /** Where a butterfly of half-span s sits on flower f: x, y, and the tilt of its body in pitch. */
  #perchPoint(f: Flower, s: number): void {
    const pt = this.#pt;
    if (f.type === FLOWER_LAVENDER) {
      const along = 0.3 * f.R;
      pt.x = f.hx - Math.sin(f.ht) * along;
      pt.y = f.hy + Math.cos(f.ht) * along + 0.2 * s;
    } else if (f.type === FLOWER_CLOVER) {
      pt.x = f.hx;
      pt.y = f.hy + 0.6 * f.R + 0.3 * s;
    } else {
      pt.x = f.hx;
      pt.y = f.hy + 0.05 * f.R + 0.32 * s;
    }
    pt.pitch = f.ht;
  }

  #stepButterfly(g: Butterfly, id: number, dt: number): void {
    g.age += dt;
    g.timer += dt;
    g.present = clamp(g.present + (g.leaving ? -dt : dt) / FADE_TIME, 0, 1);
    if (g.leaving && g.present <= 0) {
      g.active = false;
      return;
    }
    const f = g.flower >= 0 ? this.#flowers[g.flower] : undefined;
    switch (g.mode) {
      case "flutter":
        this.#flutter(g, id, dt);
        break;
      case "approach":
        this.#approach(g, f, dt);
        break;
      case "perch":
        this.#perch(g, id, f, dt);
        break;
      default: {
        const unreachable: never = g.mode;
        throw new BeesSimError(`unknown butterfly mode ${String(unreachable)}`);
      }
    }
  }

  #flutter(g: Butterfly, id: number, dt: number): void {
    const rand = this.#random;
    g.wayTimer -= dt;
    let dx = g.wx - g.x;
    let dy = g.wy - g.y;
    let dist = Math.hypot(dx, dy) + 1e-6;
    if (dist < 0.09 || g.wayTimer <= 0) {
      this.#waypoint(g, id, g.timer > 7);
      if (g.mode !== "flutter") return;
      dx = g.wx - g.x;
      dy = g.wy - g.y;
      dist = Math.hypot(dx, dy) + 1e-6;
    }
    g.flapTimer -= dt;
    if (g.flapTimer <= 0) {
      g.flapping = !g.flapping;
      g.flapTimer = g.flapping ? rand.range(2.5, 5.5) : rand.range(1.1, 2.6);
    }
    g.energy += ((g.flapping ? 1 : 0.12) - g.energy) * (1 - Math.exp(-dt / 0.7));
    g.glide += ((g.flapping ? 0 : 1) - g.glide) * (1 - Math.exp(-dt / 0.5));
    g.flap += TAU * lerp(0.7, 2.4, g.energy) * dt;
    const speed = lerp(BUTTERFLY_SPEED_MIN, BUTTERFLY_SPEED_MAX, g.energy);
    const ux = dx / dist;
    const uy = dy / dist;
    const weave = 0.05 * Math.sin(TAU * 0.29 * g.age + g.phase) + 0.03 * Math.sin(TAU * 0.47 * g.age + g.phase2);
    const lift = 0.028 * g.energy * Math.sin(g.flap + 1) - 0.012 * g.glide;
    const k = 1 - Math.exp(-dt / 0.7);
    g.vx += (ux * speed - uy * weave - g.vx) * k;
    g.vy += (uy * speed + ux * weave + lift - g.vy) * k;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.z += (g.wz - g.z) * (1 - Math.exp(-dt / 5));
    this.#flapPose(g, false);
    g.tilt += (clamp(-g.vx * 3.2, -0.5, 0.5) - g.tilt) * (1 - Math.exp(-dt / 0.4));
  }

  /** Wing opening and underside from the wingbeat phase: flight keeps the wings at least 30% open. */
  #flapPose(g: Butterfly, perched: boolean): void {
    const raw = 0.5 + 0.5 * Math.cos(g.flap);
    if (perched) {
      g.wing = raw;
      g.under = 1 - smoothstep(0.2, 0.45, raw);
    } else {
      g.wing = lerp(0.3 + 0.7 * raw, 0.82, g.glide);
      g.under = 0;
    }
  }

  #approach(g: Butterfly, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      g.mode = "flutter";
      return;
    }
    const s = BUTTERFLY_SPAN * beesScale(f.depth);
    this.#perchPoint(f, s);
    const dx = this.#pt.x - g.x;
    const dy = this.#pt.y - g.y;
    const dist = Math.hypot(dx, dy) + 1e-6;
    const speed = 0.06 * smoothstep(0, 0.25, dist) + 0.012;
    const k = 1 - Math.exp(-dt / 0.6);
    g.vx += (dx / dist * speed - g.vx) * k;
    g.vy += (dy / dist * speed + 0.01 * Math.sin(g.flap + 1) - g.vy) * k;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.energy += (0.55 - g.energy) * (1 - Math.exp(-dt / 0.7));
    g.glide += (0 - g.glide) * (1 - Math.exp(-dt / 0.5));
    g.flap += TAU * lerp(0.7, 2.4, g.energy) * dt;
    const progress = clamp(1 - dist / Math.max(g.startDist, 0.08), 0, 1);
    g.z = lerp(g.startZ, f.depth - BEES_Z_LAND, smoothstep(0, 1, progress));
    this.#flapPose(g, false);
    g.tilt += (clamp(-g.vx * 3.2, -0.5, 0.5) - g.tilt) * (1 - Math.exp(-dt / 0.4));
    if (dist < 0.012) {
      g.mode = "perch";
      g.timer = 0;
      g.dwell = this.#random.range(7, 13);
      f.load = BUTTERFLY_LOAD;
    }
  }

  #perch(g: Butterfly, id: number, f: Flower | undefined, dt: number): void {
    if (f === undefined) {
      g.mode = "flutter";
      return;
    }
    const s = BUTTERFLY_SPAN * beesScale(f.depth);
    this.#perchPoint(f, s);
    const k = 1 - Math.exp(-dt * 5);
    g.x += (this.#pt.x - g.x) * k;
    g.y += (this.#pt.y - g.y) * k;
    g.vx = 0;
    g.vy = 0;
    g.z = f.depth - BEES_Z_LAND;
    g.energy += (0 - g.energy) * (1 - Math.exp(-dt / 0.5));
    g.flap += TAU * 0.16 * dt;
    this.#flapPose(g, true);
    g.tilt += (this.#pt.pitch + g.restTilt - g.tilt) * (1 - Math.exp(-dt / 0.5));
    if (g.timer > g.dwell) {
      f.load = 0;
      f.claim = -1;
      g.flower = -1;
      g.mode = "flutter";
      g.timer = 0;
      g.flapping = true;
      g.flapTimer = 3;
      g.vy = 0.05;
      g.glide = 0;
      g.under = 0;
      this.#waypoint(g, id, false);
    }
  }

  // ---- upload ------------------------------------------------------------------------------

  #pack(): void {
    const fd = this.#flowerData;
    fd.fill(0);
    for (let r = 0; r < BEES_MAX_FLOWERS; r++) {
      const o = r * BEES_FLOWER_TEXELS * 4;
      const f = this.#flowers[r];
      if (f === undefined) {
        fd[o + 4] = -1;
        continue;
      }
      fd[o] = f.hx;
      fd[o + 1] = f.hy;
      fd[o + 2] = f.rootX;
      fd[o + 3] = f.R;
      fd[o + 4] = f.depth;
      fd[o + 5] = f.type;
      fd[o + 6] = f.ht;
      fd[o + 7] = f.hash;
      fd[o + 8] = f.petal[0];
      fd[o + 9] = f.petal[1];
      fd[o + 10] = f.petal[2];
      fd[o + 11] = 1;
      fd[o + 12] = f.tip[0];
      fd[o + 13] = f.tip[1];
      fd[o + 14] = f.tip[2];
      fd[o + 15] = 1;
    }
    const ad = this.#agentData;
    ad.fill(0);
    for (const [i, b] of this.#bees.entries()) {
      if (!b.active || b.present <= 0) continue;
      const o = i * BEES_AGENT_TEXELS * 4;
      ad[o] = b.x;
      ad[o + 1] = b.y;
      ad[o + 2] = BEE_LENGTH * beesScale(b.z);
      ad[o + 3] = b.present;
      ad[o + 4] = b.z;
      ad[o + 8] = b.face;
      ad[o + 9] = b.pitch;
      ad[o + 10] = b.wing;
      ad[o + 11] = b.pollen;
      ad[o + 12] = b.leg;
      ad[o + 13] = b.crawl;
    }
    for (const [j, g] of this.#butterflies.entries()) {
      if (!g.active || g.present <= 0) continue;
      const o = (BEES_MAX_BEES + j) * BEES_AGENT_TEXELS * 4;
      ad[o] = g.x;
      ad[o + 1] = g.y;
      ad[o + 2] = BUTTERFLY_SPAN * beesScale(g.z);
      ad[o + 3] = g.present;
      ad[o + 4] = g.z;
      ad[o + 5] = g.kind;
      ad[o + 8] = g.tilt;
      ad[o + 9] = g.wing;
      ad[o + 10] = g.under;
    }
  }
}

/** The border's simulation, for a scene whose `params` carry the knobs BeesKnob names. */
export function beesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BeesSim(gl, params);
}
