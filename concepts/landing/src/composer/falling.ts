// The composer's falling things (README "Falling things", ADR 0062 "Falling things (W1)"): one pool
// of particles for every layer on screen, stepped on a fixed step and drawn as points into the
// composed sim's shared speck map (sims/specks.ts) under codes of the composer's own
// (Allocation.falling), which the program's speck pass colours (`fallingGlsl`): no layer loops over
// them per pixel. It runs on the CPU: the layers name their drip points and surfaces from their own
// sims each frame, and a landing reaches another layer's sim (a water layer's strike), both of
// which a pool on the GPU would read back every frame, while a few hundred particles step here in a
// fraction of a millisecond.
//
// Drips (FallingWriter.drip). Water gathers at each drip point a layer names, its lane holding a
// beat of its own fixed in time (BEAT_FALL + BEAT_GATHER × a jitter 0.7..1.3, on the pool's step
// count): a bead swells there through the beat's gathering and lets go at its end, falling under
// gravity and drag in the air. The World's rain and the wetness it leaves decide which beats let go
// (amount = max(rain, 0.4 × wet), the edges' rule, README "Weather in the world"), at the rate the
// shared edge drips had (rainDrips: a beat kept with chance (0.35 + 0.65 a) · P / (0.8 + mix(3.2,
// 0.6, a) · jitter)). A beat's moment never moves with the amount, so no drop runs backward as the
// world dries (the bug 4bf629be fixed in the shaders' drips): the pool only ever steps forward.
//
// The air. Every particle is drawn toward the air's velocity with its own time constant (a drop
// DROP_TAU: it falls at about 6 m/s at most and the wind barely bends it; a droplet thrown up by a
// splash the same): the wind along the gust field's heading at WIND_DRIFT m/s for wind 1, and the
// gust field's load where the particle is (composer/gust.ts gustAt, its 'now' and the passage's
// front included, ADR 0062 D4) at GUST_DRIFT m/s a unit, on the motion clock as the shader's.
//
// Landings (FallingWriter.surface: the surfaces every layer on names this frame). A falling drop
// meets the highest surface it crosses within the surface's footprint: on a plane or a ledge it
// splashes, a crown for CROWN_LIFE and SPLASH_DROPLETS droplets thrown up and out that fall back
// and vanish where they meet the surface again, and leaves a wet mark that dries over MARK_LIFE; on
// water it strikes the sim of the layer the surface names (FallingWater, through its affordances),
// with a crown. A drop that meets nothing falls on until it is FALL_FLOOR below the floor or
// MAX_AGE old.
//
// Drawing (`paint`), every frame, between the last two steps by the clock's alpha: each particle in
// the cell its rig-frame position projects to through the rig at rest (LevelCamera), lifted with the
// passage's eye and moved by its lens shift (Composition.falling.shift), slid with the pointer's
// parallax as its layer slides (LayerFalling.slide), at its depth in SPECK_DEPTH_STEP-ths of a metre
// (the speck pass hides it behind whatever stands nearer). A drop is a head DROP_CELLS wide where it
// is at least half a cell across, else one, with a streak behind it as long as it moves in
// STREAK_SECONDS and, at two cells, a cell of its body either side (the streak's code: the rim that
// reads against bright spray); a bead a cell under its point (two cells wide at its fullest where
// it is big enough, with the drop's rim); a crown a cup of five cells; a droplet a cell; a wet mark
// a smear MARK_METRES wide, a cell nearer than its surface so its own surface does not hide it,
// fading through three codes.
//
// Leaves (FallingWriter.leaves, FallingWriter.leaf). A layer's crown lets leaves go on the pool's
// own steps, each step a beat that lets one go with the chance the crown's rate gives it (rate ×
// FALL_STEP; while fewer than its `least` are in the air, at least LEAF_LEAST_RATE): the rate only
// chooses which steps let go, so nothing runs backward as it changes. The layer fills each leaf in
// from the leaf's own stream of chance (hash31 of the crown, the step and the seed), and may hand
// the pool a leaf at once (lifted off the ground, blown in). A leaf is a fluttering plate under heavy
// drag (sims/flutter.ts, as the garden's and the park's always fell): light ones flutter, heavy ones
// tumble, the plane turning, rocking about its chord, spinning in its plane, carried by its layer's
// air (FallLeaves.air at the step's moment on the motion clock; the gust field's drift where it
// names none). It comes down on the highest surface under it no higher than itself, eases flat over
// LEAF_SETTLE (face up or face down, whichever is nearer), and then joins the litter of the layer the
// surface names where that layer's affordances take it (FallingLitter.lay), else lies there
// LEAF_REST and fades. It is drawn as its outline (FALL_LEAF_SHAPES: the plate's two axes through
// the rig, cell by cell), one code a cell: its hue in FALL_LEAF_HUES bands of its layer's palette
// and the face it shows, flat or standing (FALL_LEAF_SHADES); it dissolves in over LEAF_FADE_IN as
// it lets go and out as it fades, a cell at a time.
//
// Determinism: everything is drawn from the pool's step count, the lanes and the seed (hash31),
// never from the frame: a seed plays the same at any frame rate. The fixed step runs on the fall
// clock's pace (README "Time and motion": dt × min(1, 2.5 × motion)), as the World's rain falls.
import { SPECK_DEPTH_STEP } from "./caps.ts";
import { gustAt, gustWind, newGustWind, type GustField, type GustWind } from "./gust.ts";
import { glslFloat } from "../shaders/glsl.ts";
import { FixedStep } from "../sims/clock.ts";
import { FlutterPlates } from "../sims/flutter.ts";
import { hash31, smoothstep } from "../sims/math.ts";
import { mulberry32 } from "../sims/random.ts";
import type { LevelCamera } from "../sims/camera.ts";
import type {
  FallKind,
  FallLeaf,
  FallLeaves,
  FallSurface,
  FallingLitter,
  FallingWater,
} from "./types.ts";

/** Seconds a step of the pool; most steps one frame runs. */
export const FALL_STEP = 1 / 60;
const MAX_STEPS = 8;
/** Particles the pool holds at once: past it a new one is not born. */
export const FALL_CAPACITY = 512;
/** Surfaces and drip points a frame holds (a bank's top in short ledges): past them the rest are dropped. */
const MAX_SURFACES = 128;
const MAX_DRIPS = 256;

const GRAVITY = 9.81;
/** A drop's radius (m): a heavy drip, a bead as the edges' drips drew theirs. */
export const DROP_RADIUS = 0.004;
/** Seconds a drop and a droplet take to reach the air's velocity (a drop's terminal speed ≈ g · tau). */
const DROP_TAU = 0.6;
/** The air: m/s of drift at wind 1, and a gust's at a load of 1 (autumn's leaves' values). */
const WIND_DRIFT = 1.2;
const GUST_DRIFT = 2.2;
/** A drip point's beat: seconds a drop takes to fall away, and to gather (times a jitter 0.7..1.3). */
const BEAT_FALL = 0.8;
const BEAT_GATHER = 1.2;
/** Share of the gathering after which the bead shows. */
const BEAD_SHOWS = 0.35;
/** A splash: the crown's life (s), its droplets, their speed up and out (m/s), their size (of a drop's). */
const CROWN_LIFE = 0.07;
const SPLASH_DROPLETS = 3;
const SPLASH_UP: readonly [number, number] = [0.7, 1.3];
const SPLASH_OUT: readonly [number, number] = [0.25, 0.7];
const DROPLET_SIZE = 0.5;
/** A wet mark: seconds it takes to dry, and how wide it is (m). */
const MARK_LIFE = 3;
const MARK_METRES = 0.03;
/** Where a drop that met nothing ends: metres below the floor, or its age (s). */
const FALL_FLOOR = 2;
const MAX_AGE = 6;
/** The drawn streak: seconds of motion behind the head, at most this many cells. */
const STREAK_SECONDS = 0.012;
const STREAK_CELLS = 8;
/** A drop's head: cells across where it is at least half a cell across. */
const DROP_CELLS = 2;
/** A drop of water's mass (kg) per cubic metre of it. */
const WATER_DENSITY = 1000;

/** How far a leaf rocks about its chord in flight (radians). */
const LEAF_ROCK = 0.3;
/** The fewest leaves a second a crown lets go while fewer than its `least` are in the air. */
const LEAF_LEAST_RATE = 1 / 0.45;
/** Seconds a leaf takes to dissolve in as it lets go, to ease flat once down, to lie, and to fade at the end of it. */
const LEAF_FADE_IN = 0.9;
const LEAF_SETTLE = 0.7;
const LEAF_REST = 8;
const LEAF_FADE_OUT = 3;
/** Where a leaf is gone: higher it does not rise (m), nearer, farther and farther aside, older (s). */
const LEAF_TOP = 12;
const LEAF_NEAR = 1.5;
const LEAF_FAR = 60;
const LEAF_ASIDE = 40;
const LEAF_MAX_AGE = 60;
/** Below this many cells across a leaf is a dot of a cell or two. */
const LEAF_DOT = 3;
/**
 * A leaf's outlines, in leaf units (radius about 1, tip toward +y, the stalk toward -y), as the park
 * drew its leaves: a five-lobed maple's, a ginkgo's fan, an oak's long lobed blade.
 */
export const FALL_LEAF_SHAPES = 3;
/** A leaf's hue bands (of its palette, 0..1), and its codes a band: the face it shows (top, underside) × flat or standing. */
export const FALL_LEAF_HUES = 8;
export const FALL_LEAF_SHADES = 4;

/** The pool's particles: a drop's family, then a leaf flying, easing flat and lying. */
const enum Kind {
  free = 0,
  drop = 1,
  droplet = 2,
  crown = 3,
  mark = 4,
  leaf = 5,
  settling = 6,
  lying = 7,
}

/**
 * The falling things' codes in the speck map (1-based, from Allocation.falling's base), by kind:
 * the drop's head, its streak, a bead at a drip point, a splash's crown and droplets, and the wet
 * mark fresh, drying and nearly dry. A leaf's are its kind's own from 1: band × FALL_LEAF_SHADES +
 * shade + 1 (fallingGlsl).
 */
export const FALL_CODE = {
  drop: 1,
  streak: 2,
  bead: 3,
  splash: 4,
  wet: 5,
  drying: 6,
  dry: 7,
} as const;

/** Every kind, in the order their codes follow each other (each kind's codes from 1). */
export const FALL_KINDS: readonly FallKind[] = ["drop", "leaf"];

/** Codes each kind takes. */
export const FALL_CODES: Readonly<Record<FallKind, number>> = {
  drop: 7,
  leaf: FALL_LEAF_HUES * FALL_LEAF_SHADES,
};

/** Where `kind`'s codes start among the falling things' when `kinds` are on (FALL_KINDS' order): codes before its own. */
export function fallOffset(kinds: readonly FallKind[], kind: FallKind): number {
  let offset = 0;
  for (const each of FALL_KINDS) {
    if (each === kind) return offset;
    if (kinds.includes(each)) offset += FALL_CODES[each];
  }
  return offset;
}

/** What the composed sim hands the pool for a frame's steps. */
export interface FallFrame {
  /** Scene-clock seconds since the previous frame, and the lab's motion amount. */
  readonly dt: number;
  readonly motion: number;
  readonly motionTime: number;
  /** The seed knob's value (0 where the preset lists none). */
  readonly seed: number;
  /** The World's rain falling now and how wet it has left the world (SimFrame.weather). */
  readonly rain: number;
  readonly wet: number;
  readonly gusts: GustField;
}

/** What the pool is drawn through, a frame. */
export interface FallView {
  readonly rig: LevelCamera;
  /** How far the passage lifts the eye (m), and its lens shift (screen heights, uv read lower). */
  readonly lift: number;
  readonly shift: number;
  readonly width: number;
  readonly height: number;
  /** The pointer's parallax (SimFrame.parallax), -1..1 each way. */
  readonly parallaxX: number;
  readonly parallaxY: number;
  /** The kinds whose codes the speck map holds (Allocation.falling): the others are not drawn. */
  readonly kinds: readonly FallKind[];
}

/** Where the pool plots: the speck map, a code from its allocated base (1-based codes). */
export interface FallPlot {
  plot(cx: number, cy: number, code: number, depth: number): void;
}

/** A drip point named this frame. */
interface Drip {
  key: number;
  x: number;
  y: number;
  z: number;
  slideX: number;
  slideY: number;
}

/** A surface named this frame, as the pool tests it. */
interface Surface {
  surface: FallSurface;
  /** The ledge's segment, unit along it and its length (for the strip test). */
  ux: number;
  uz: number;
  length: number;
}

/** A layer's leaves named this frame: its lanes' first key, and how its leaves slide. */
interface Crown {
  key: number;
  leaves: FallLeaves;
  slideX: number;
  slideY: number;
}

/** Whether `host` (a layer's affordances) lends the falling things its water. */
function isFallingWater(host: object | undefined): host is FallingWater {
  return host !== undefined && typeof (host as Partial<FallingWater>).strike === "function";
}

/** Whether `host` (a layer's affordances) takes leaves into its litter. */
function isFallingLitter(host: object | undefined): host is FallingLitter {
  return host !== undefined && typeof (host as Partial<FallingLitter>).lay === "function";
}

/** A fresh leaf to fill in (FallLeaves.shed): still, flat, shown at once. */
const FRESH_LEAF: Readonly<FallLeaf> = {
  x: 0,
  y: 0,
  z: 0,
  radius: 0.1,
  hue: 0,
  shape: 0,
  mass: 0.3,
  chord: 0.3,
  pace: 0.2,
  psi: 0,
  dpsi: 0,
  th: 0,
  sigma: 0,
  dsigma: 0,
  roll: 0,
  rollRate: 0,
  rest: 0,
  phase: 0,
  shown: true,
  ahead: 0,
};

/**
 * Signed distance (leaf units, negative inside) to outline `shape`'s edge at leaf point (qx, qy),
 * the stalk included (FALL_LEAF_SHAPES): the park's leaves' outlines (autumn/shader.ts autumnLeafD)
 * at a middling leaf of each.
 */
function leafEdge(qx: number, qy: number, shape: number): number {
  let blade: number;
  if (shape === 0) {
    const a = Math.abs(Math.atan2(qx, qy + 1e-5));
    let r = 0.36;
    r = Math.max(r, Math.max(1 - a / 0.46, 0) ** 1.2);
    r = Math.max(r, 0.89 * Math.max(1 - Math.abs(a - 1.08) / 0.42, 0) ** 1.2);
    r = Math.max(r, 0.58 * Math.max(1 - Math.abs(a - 2.1) / 0.38, 0) ** 1.2);
    r *= 1 - 0.8 * smoothstep(2.65, 3.1, a);
    blade = (Math.hypot(qx, qy) - r) * 0.9;
  } else if (shape === 1) {
    const fy = qy + 0.7;
    const a = Math.atan2(qx, fy + 1e-5);
    const rr = Math.hypot(qx, fy);
    const outer = rr - (1.35 - 0.3 * Math.exp((-a * a) / 0.012));
    const wedge = (Math.abs(a) - 0.92) * Math.max(rr, 0.25);
    blade = Math.max(Math.max(outer, wedge), 0.18 - rr) * 0.85;
  } else {
    const t = Math.min(1, Math.max(0, (qy + 0.95) / 1.9));
    const lobes = 0.78 + 0.22 * Math.cos(18 * t + 1.4);
    const w = 0.64 * Math.max(Math.sin(Math.PI * t ** 0.85), 0) ** 0.75 * lobes;
    blade = Math.max(Math.abs(qx) - w, Math.abs(qy) - 0.95) * 0.85;
  }
  // The stalk: a short segment from the blade's foot.
  const y0 = shape === 0 ? -0.25 : shape === 1 ? -0.6 : -0.85;
  const sx = 0.03;
  const sy = -0.55;
  const u = Math.min(1, Math.max(0, (qx * sx + (qy - y0) * sy) / (sx * sx + sy * sy)));
  const stalk = Math.hypot(qx - sx * u, qy - y0 - sy * u) - 0.045;
  return Math.min(blade, stalk);
}

/** Texels along a side of each outline's mask, over leaf units -LEAF_SPAN..LEAF_SPAN each way. */
const LEAF_MASK = 48;
const LEAF_SPAN = 1.4;
/** Each outline as a mask (1 inside, rows up), drawn once: a leaf's cells read it, not the outline's sums. */
const LEAF_MASKS = ((): Uint8Array => {
  const masks = new Uint8Array(FALL_LEAF_SHAPES * LEAF_MASK * LEAF_MASK);
  const texel = (2 * LEAF_SPAN) / LEAF_MASK;
  for (let shape = 0; shape < FALL_LEAF_SHAPES; shape++)
    for (let my = 0; my < LEAF_MASK; my++)
      for (let mx = 0; mx < LEAF_MASK; mx++) {
        const qx = -LEAF_SPAN + (mx + 0.5) * texel;
        const qy = -LEAF_SPAN + (my + 0.5) * texel;
        if (leafEdge(qx, qy, shape) <= 0) masks[(shape * LEAF_MASK + my) * LEAF_MASK + mx] = 1;
      }
  return masks;
})();

/** The pool (see the header). */
export class FallingPool {
  readonly #clock = new FixedStep(FALL_STEP, MAX_STEPS);
  readonly #wind = newGustWind();
  readonly #kind = new Uint8Array(FALL_CAPACITY);
  readonly #x = new Float64Array(FALL_CAPACITY);
  readonly #y = new Float64Array(FALL_CAPACITY);
  readonly #z = new Float64Array(FALL_CAPACITY);
  readonly #px = new Float64Array(FALL_CAPACITY);
  readonly #py = new Float64Array(FALL_CAPACITY);
  readonly #pz = new Float64Array(FALL_CAPACITY);
  readonly #vx = new Float64Array(FALL_CAPACITY);
  readonly #vy = new Float64Array(FALL_CAPACITY);
  readonly #vz = new Float64Array(FALL_CAPACITY);
  readonly #age = new Float64Array(FALL_CAPACITY);
  readonly #radius = new Float64Array(FALL_CAPACITY);
  /** A droplet's surface height (it vanishes back there), a mark's surface height. */
  readonly #floor = new Float64Array(FALL_CAPACITY);
  readonly #slideX = new Float64Array(FALL_CAPACITY);
  readonly #slideY = new Float64Array(FALL_CAPACITY);
  /** A leaf's plate, its hue, outline, eddy phase, lane (its layer's key + lane), whether it shows at once, its serial, and the litter it may join. */
  readonly #plates = new FlutterPlates(FALL_CAPACITY, LEAF_ROCK);
  readonly #hue = new Float64Array(FALL_CAPACITY);
  readonly #shape = new Uint8Array(FALL_CAPACITY);
  readonly #phase = new Float64Array(FALL_CAPACITY);
  readonly #lane = new Int32Array(FALL_CAPACITY);
  readonly #shown = new Uint8Array(FALL_CAPACITY);
  readonly #serial = new Float64Array(FALL_CAPACITY);
  readonly #litter: (string | undefined)[] = [];
  /** Free slots, a stack; the slots above `#top` have never been used. */
  readonly #free = new Int32Array(FALL_CAPACITY);
  #freeCount = 0;
  #top = 0;
  #live = 0;
  /** Steps run since the pool began: its clock (FALL_STEP seconds each). */
  #steps = 0;
  /** Particles born since the pool began: each one's own stream of chance. */
  #born = 0;
  #seed = 0;
  #amount = 0;
  readonly #drips: Drip[] = [];
  #dripCount = 0;
  readonly #surfaces: Surface[] = [];
  #surfaceCount = 0;
  readonly #crowns: Crown[] = [];
  #crownCount = 0;
  /** A leaf to fill in, the air at a leaf (x, y, z), a leaf's position for its plate (x, z, y) and its frame. */
  readonly #leafOut: FallLeaf = { ...FRESH_LEAF };
  readonly #air = new Float64Array(3);
  readonly #at = new Float64Array(3);
  readonly #frame = new Float64Array(9);
  /** The height a leaf starts its step at (it lands on nothing above it), and the surface it last came down on. */
  #leafFrom = 0;
  #leafOn: Surface | undefined;
  /** Where a leaf comes down (FlutterFloor): the highest surface under (x, z) no higher than it was. */
  readonly #leafFloor = (x: number, z: number): number => {
    let best = -Infinity;
    this.#leafOn = undefined;
    for (let k = 0; k < this.#surfaceCount; k++) {
      const s = this.#surfaces[k];
      if (s === undefined) continue;
      const sy = s.surface.y;
      if (sy > this.#leafFrom || sy <= best || !this.#within(s, x, z)) continue;
      best = sy;
      this.#leafOn = s;
    }
    return best;
  };
  /** A water surface's layer's affordances, a litter's (LayerFrame.host). */
  readonly #host: (layer: string) => object | undefined;

  constructor(host: (layer: string) => object | undefined) {
    this.#host = host;
  }

  /** Particles alive now. */
  get live(): number {
    return this.#live;
  }

  /** Steps run since the pool began. */
  get steps(): number {
    return this.#steps;
  }

  /** Forget this frame's drip points, surfaces and crowns: the layers name them afresh. */
  begin(): void {
    this.#dripCount = 0;
    this.#surfaceCount = 0;
    this.#crownCount = 0;
  }

  /** A layer's leaves this frame: `key` its lanes' first (its crown's lane), how they slide. */
  leaves(key: number, leaves: FallLeaves, slideX: number, slideY: number): void {
    const c = (this.#crowns[this.#crownCount] ??= { key, leaves, slideX, slideY });
    c.key = key;
    c.leaves = leaves;
    c.slideX = slideX;
    c.slideY = slideY;
    this.#crownCount++;
  }

  /** A leaf let go now under lane `key` (its layer's first key + its lane); false when the pool is full. */
  leaf(key: number, leaf: FallLeaf, slideX: number, slideY: number): boolean {
    return this.#spawnLeaf(key, leaf, slideX, slideY) >= 0;
  }

  /** Leaves of lane `key` in the air now (not yet come down). */
  aloft(key: number): number {
    let n = 0;
    for (let i = 0; i < this.#top; i++)
      if (this.#kind[i] === Kind.leaf && this.#lane[i] === key) n++;
    return n;
  }

  /** A drip point this frame: `key` its lane among every layer's, (x, y, z) rig frame, metres. */
  drip(key: number, x: number, y: number, z: number, slideX: number, slideY: number): void {
    if (this.#dripCount >= MAX_DRIPS) return;
    const d = (this.#drips[this.#dripCount] ??= {
      key: 0,
      x: 0,
      y: 0,
      z: 0,
      slideX: 0,
      slideY: 0,
    });
    d.key = key;
    d.x = x;
    d.y = y;
    d.z = z;
    d.slideX = slideX;
    d.slideY = slideY;
    this.#dripCount++;
  }

  /** A surface this frame. */
  surface(surface: FallSurface): void {
    if (this.#surfaceCount >= MAX_SURFACES) return;
    const s = (this.#surfaces[this.#surfaceCount] ??= { surface, ux: 1, uz: 0, length: 0 });
    s.surface = surface;
    if (surface.kind === "ledge") {
      const dx = surface.to[0] - surface.from[0];
      const dz = surface.to[1] - surface.from[1];
      const length = Math.hypot(dx, dz);
      s.length = length;
      s.ux = length > 0 ? dx / length : 1;
      s.uz = length > 0 ? dz / length : 0;
    }
    this.#surfaceCount++;
  }

  /** Run the steps this frame owes (see the header). */
  step(frame: FallFrame): void {
    this.#seed = Math.round(frame.seed * 1000);
    this.#amount = Math.max(frame.rain, 0.4 * frame.wet);
    const pace = Math.min(1, 2.5 * frame.motion);
    const clock = this.#clock;
    const n = clock.advance(Math.max(0, frame.dt) * pace);
    if (n === 0) return;
    const g = frame.gusts;
    const wind = gustWind(this.#wind, g.wind, g.gusts, g.rate, g.nowAge, g.pass, g.shape);
    // The air's drift along the gusts' heading: the wind's own, then each particle's gust load.
    const drift = WIND_DRIFT * Math.abs(g.wind);
    // Motion seconds a fall second, to sample the gusts at each step's moment on the motion clock.
    const motionPerFall = pace > 0 ? frame.motion / pace : 0;
    for (let i = 0; i < n; i++) {
      const tm = frame.motionTime - clock.lag(i) * motionPerFall;
      this.#stepOnce(wind, drift, g.gusts > 0, tm);
    }
  }

  #stepOnce(wind: GustWind, drift: number, gusty: boolean, tm: number): void {
    const h = FALL_STEP;
    const t0 = this.#steps * h;
    this.#steps++;
    this.#release(t0, t0 + h);
    const kind = this.#kind;
    const x = this.#x;
    const y = this.#y;
    const z = this.#z;
    const vx = this.#vx;
    const vy = this.#vy;
    const vz = this.#vz;
    const top = this.#top;
    for (let i = 0; i < top; i++) {
      const k = kind[i] ?? Kind.free;
      if (k === Kind.free) continue;
      const age = (this.#age[i] ?? 0) + h;
      this.#age[i] = age;
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      const pz = z[i] ?? 0;
      this.#px[i] = px;
      this.#py[i] = py;
      this.#pz[i] = pz;
      if (k === Kind.crown) {
        if (age >= CROWN_LIFE) this.#kill(i);
        continue;
      }
      if (k === Kind.mark) {
        if (age >= MARK_LIFE) this.#kill(i);
        continue;
      }
      if (k >= Kind.leaf) {
        this.#stepLeaf(i, k, age, px, py, pz, wind, drift, gusty, tm);
        continue;
      }
      // Drawn toward the air (the wind and the gust where it is), and down.
      const load = gusty ? gustAt(wind, px, pz, tm, 0) : 0;
      const air = drift + GUST_DRIFT * load;
      const pull = h / DROP_TAU;
      const nvx = (vx[i] ?? 0) + (air * wind.dirX - (vx[i] ?? 0)) * pull;
      const nvz = (vz[i] ?? 0) + (air * wind.dirZ - (vz[i] ?? 0)) * pull;
      const nvy = (vy[i] ?? 0) - GRAVITY * h - (vy[i] ?? 0) * pull;
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      const nx = px + nvx * h;
      const ny = py + nvy * h;
      const nz = pz + nvz * h;
      x[i] = nx;
      y[i] = ny;
      z[i] = nz;
      if (k === Kind.droplet) {
        if ((nvy < 0 && ny < (this.#floor[i] ?? 0)) || age >= MAX_AGE) this.#kill(i);
        continue;
      }
      if (nvy < 0 && this.#land(i, px, py, pz, nx, ny, nz)) continue;
      if (ny < -FALL_FLOOR || age >= MAX_AGE || nz < 0.05) this.#kill(i);
    }
    this.#shed();
  }

  /** Leaf i's step (see the header): flying in its layer's air, easing flat, lying. */
  #stepLeaf(
    i: number,
    k: Kind,
    age: number,
    px: number,
    py: number,
    pz: number,
    wind: GustWind,
    drift: number,
    gusty: boolean,
    tm: number,
  ): void {
    if (k === Kind.leaf) {
      if (age >= LEAF_MAX_AGE) {
        this.#kill(i);
        return;
      }
      const air = this.#air;
      const lane = this.#lane[i] ?? 0;
      const crown = this.#crownOf(lane - (lane & 0xffff));
      if (crown !== undefined) crown.leaves.air(px, py, pz, tm, this.#phase[i] ?? 0, air);
      else {
        const load = gusty ? gustAt(wind, px, pz, tm, 0) : 0;
        const speed = drift + GUST_DRIFT * load;
        air[0] = speed * wind.dirX;
        air[1] = 0;
        air[2] = speed * wind.dirZ;
      }
      this.#flyLeaf(i, air[0] ?? 0, air[1] ?? 0, air[2] ?? 0);
      return;
    }
    if (k === Kind.lying) {
      if (age >= LEAF_REST) this.#kill(i);
      return;
    }
    const p = this.#plates;
    const eased = smoothstep(0, LEAF_SETTLE, age);
    p.settle(i, eased);
    p.sigma[i] = (p.sigma[i] ?? 0) + (p.dsigma[i] ?? 0) * FALL_STEP * (1 - eased);
    if (age < LEAF_SETTLE) return;
    const f = this.#frame;
    p.orient(i, 0, f);
    const litter = this.#litter[i];
    const host = litter === undefined ? undefined : this.#host(litter);
    const face = (f[8] ?? 1) >= 0 ? 1 : -1;
    const angle = Math.atan2(f[1] ?? 0, f[0] ?? 1);
    if (isFallingLitter(host) && host.lay(px, pz, angle, this.#hue[i] ?? 0, face)) {
      this.#kill(i);
      return;
    }
    this.#kind[i] = Kind.lying;
    this.#age[i] = 0;
  }

  /** Leaf i flies a step in the air (m/s): it comes down on a surface, or is gone out of the picture. */
  #flyLeaf(i: number, airX: number, airY: number, airZ: number): void {
    const at = this.#at;
    at[0] = this.#x[i] ?? 0;
    at[1] = this.#z[i] ?? 0;
    at[2] = this.#y[i] ?? 0;
    this.#leafFrom = at[2];
    const landed = this.#plates.fly(i, FALL_STEP, at, airX, airZ, airY, this.#leafFloor);
    const x = at[0];
    const z = at[1];
    const y = Math.min(at[2], LEAF_TOP);
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = z;
    if (Math.abs(x) > LEAF_ASIDE || z < LEAF_NEAR || z > LEAF_FAR || y < -FALL_FLOOR) {
      this.#kill(i);
      return;
    }
    if (!landed) return;
    const on = this.#leafOn?.surface;
    this.#kind[i] = Kind.settling;
    this.#age[i] = 0;
    this.#litter[i] = on !== undefined && on.kind !== "water" ? on.litter : undefined;
    this.#plates.touchDown(i);
  }

  /** The crown named this frame whose lanes start at `key`, if any. */
  #crownOf(key: number): Crown | undefined {
    for (let c = 0; c < this.#crownCount; c++) {
      const crown = this.#crowns[c];
      if (crown?.key === key) return crown;
    }
    return undefined;
  }

  /**
   * Each crown's beat this step: a leaf lets go with the chance its rate gives a step, at least
   * LEAF_LEAST_RATE's while fewer than its `least` are in the air (see the header).
   */
  #shed(): void {
    for (let c = 0; c < this.#crownCount; c++) {
      const crown = this.#crowns[c];
      if (crown === undefined || !(crown.leaves.rate > 0)) continue;
      const { key, leaves } = crown;
      const least = leaves.least > 0 && this.aloft(key) < leaves.least;
      const rate = least ? Math.max(leaves.rate, LEAF_LEAST_RATE) : leaves.rate;
      if (hash31(key, this.#steps, this.#seed + 21) >= rate * FALL_STEP) continue;
      const leaf = Object.assign(this.#leafOut, FRESH_LEAF);
      leaves.shed(
        mulberry32(Math.floor(hash31(key, this.#steps, this.#seed + 23) * 2 ** 32)),
        leaf,
      );
      this.#spawnLeaf(key, leaf, crown.slideX, crown.slideY);
    }
  }

  /** A leaf into a free slot (its plate as `leaf` seeds it), flown ahead as it says; -1 when none is free. */
  #spawnLeaf(key: number, leaf: FallLeaf, slideX: number, slideY: number): number {
    const i = this.#spawn(Kind.leaf, leaf.x, leaf.y, leaf.z, 0, 0, 0, leaf.radius, slideX, slideY);
    if (i < 0) return -1;
    const p = this.#plates;
    p.start(i);
    p.mass[i] = leaf.mass;
    p.chord[i] = leaf.chord;
    p.pace[i] = leaf.pace;
    p.psi[i] = leaf.psi;
    p.dpsi[i] = leaf.dpsi;
    p.th[i] = leaf.th;
    p.sigma[i] = leaf.sigma;
    p.dsigma[i] = leaf.dsigma;
    p.roll[i] = leaf.roll;
    p.rollRate[i] = leaf.rollRate;
    p.rest[i] = leaf.rest;
    this.#hue[i] = leaf.hue;
    this.#shape[i] = leaf.shape;
    this.#phase[i] = leaf.phase;
    this.#lane[i] = key;
    this.#shown[i] = leaf.shown ? 1 : 0;
    this.#serial[i] = this.#born;
    this.#litter[i] = undefined;
    // Already on its way down: flown that long in still air.
    for (let t = 0; t < leaf.ahead && this.#kind[i] === Kind.leaf; t += FALL_STEP)
      this.#flyLeaf(i, 0, 0, 0);
    this.#px[i] = this.#x[i] ?? 0;
    this.#py[i] = this.#y[i] ?? 0;
    this.#pz[i] = this.#z[i] ?? 0;
    return i;
  }

  /**
   * The drip points whose beat lets a drop go within [t0, t1) of the pool's clock: beat n of a lane
   * of period P and phase f lets go at (n + f) · P + gather, kept as the amount says.
   */
  #release(t0: number, t1: number): void {
    const a = this.#amount;
    if (a <= 0) return;
    for (let k = 0; k < this.#dripCount; k++) {
      const d = this.#drips[k];
      if (d === undefined) continue;
      const beat = this.#beat(d.key);
      const n = Math.floor((t1 - beat.gather) / beat.period - beat.phase);
      const at = (n + beat.phase) * beat.period + beat.gather;
      if (at < t0 || at >= t1) continue;
      if (hash31(d.key, n, this.#seed + 5) > this.#keep(beat.jitter, beat.period)) continue;
      this.#spawn(Kind.drop, d.x, d.y, d.z, 0, 0, 0, DROP_RADIUS, d.slideX, d.slideY);
    }
  }

  readonly #beatOut = { period: 1, phase: 0, gather: 1, jitter: 1 };

  /** A lane's beat: its period, its phase, the share of it spent gathering, and its jitter. */
  #beat(key: number): { period: number; phase: number; gather: number; jitter: number } {
    const b = this.#beatOut;
    const jitter = 0.7 + 0.6 * hash31(key, 13, this.#seed);
    b.jitter = jitter;
    b.gather = BEAT_GATHER * jitter;
    b.period = BEAT_FALL + b.gather;
    b.phase = hash31(key, 7, this.#seed);
    return b;
  }

  /** The chance a beat of this lane lets go at the amount now: the edges' rate (see the header). */
  #keep(jitter: number, period: number): number {
    const a = Math.min(1, this.#amount);
    return ((0.35 + 0.65 * a) * period) / (BEAT_FALL + (3.2 + (0.6 - 3.2) * a) * jitter);
  }

  /** Whether particle i, moving from p to n this step, met a surface: it lands there. */
  #land(
    i: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): boolean {
    let best: Surface | undefined;
    let bestY = -Infinity;
    for (let k = 0; k < this.#surfaceCount; k++) {
      const s = this.#surfaces[k];
      if (s === undefined) continue;
      const sy = s.surface.y;
      if (!(py >= sy && ny < sy) || sy <= bestY) continue;
      const u = (py - sy) / (py - ny);
      const cx = px + (nx - px) * u;
      const cz = pz + (nz - pz) * u;
      if (!this.#within(s, cx, cz)) continue;
      best = s;
      bestY = sy;
    }
    if (best === undefined) return false;
    const u = (py - bestY) / (py - ny);
    const cx = px + (nx - px) * u;
    const cz = pz + (nz - pz) * u;
    const speed = -(this.#vy[i] ?? 0);
    const radius = this.#radius[i] ?? DROP_RADIUS;
    const slideX = this.#slideX[i] ?? 0;
    const slideY = this.#slideY[i] ?? 0;
    const serial = this.#born;
    this.#kill(i);
    const surface = best.surface;
    if (surface.kind === "water") {
      const host = this.#host(surface.strikes);
      if (isFallingWater(host))
        host.strike(cx, cz, (4 / 3) * Math.PI * radius ** 3 * WATER_DENSITY, speed);
    } else {
      this.#spawn(Kind.mark, cx, bestY, cz, 0, 0, 0, radius, slideX, slideY);
      for (let k = 0; k < SPLASH_DROPLETS; k++) {
        const up = SPLASH_UP[0] + (SPLASH_UP[1] - SPLASH_UP[0]) * hash31(serial, k, this.#seed + 1);
        const out =
          SPLASH_OUT[0] + (SPLASH_OUT[1] - SPLASH_OUT[0]) * hash31(serial, k, this.#seed + 2);
        const side = (k % 2 === 0 ? -1 : 1) * out;
        const across = 0.3 * out * (hash31(serial, k, this.#seed + 3) - 0.5);
        const j = this.#spawn(
          Kind.droplet,
          cx,
          bestY,
          cz,
          side,
          up * Math.min(1.4, Math.sqrt(speed / 3)),
          across,
          radius * DROPLET_SIZE,
          slideX,
          slideY,
        );
        if (j >= 0) this.#floor[j] = bestY;
      }
    }
    this.#spawn(Kind.crown, cx, bestY, cz, 0, 0, 0, radius, slideX, slideY);
    return true;
  }

  /** Whether the floor point (x, z) lies on surface s's footprint. */
  #within(s: Surface, x: number, z: number): boolean {
    const surface = s.surface;
    if (surface.kind !== "ledge") {
      const { x: xs, z: zs } = surface;
      return (
        (xs === undefined || (x >= xs[0] && x <= xs[1])) &&
        (zs === undefined || (z >= zs[0] && z <= zs[1]))
      );
    }
    const rx = x - surface.from[0];
    const rz = z - surface.from[1];
    const along = rx * s.ux + rz * s.uz;
    const across = rx * s.uz - rz * s.ux;
    return along >= 0 && along <= s.length && Math.abs(across) <= 0.5 * surface.depth;
  }

  #spawn(
    k: Kind,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    radius: number,
    slideX: number,
    slideY: number,
  ): number {
    let i: number;
    if (this.#freeCount > 0) i = this.#free[--this.#freeCount] ?? 0;
    else if (this.#top < FALL_CAPACITY) i = this.#top++;
    else return -1;
    this.#kind[i] = k;
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = z;
    this.#px[i] = x;
    this.#py[i] = y;
    this.#pz[i] = z;
    this.#vx[i] = vx;
    this.#vy[i] = vy;
    this.#vz[i] = vz;
    this.#age[i] = 0;
    this.#radius[i] = radius;
    this.#floor[i] = y;
    this.#slideX[i] = slideX;
    this.#slideY[i] = slideY;
    this.#born++;
    this.#live++;
    return i;
  }

  #kill(i: number): void {
    if (this.#kind[i] === Kind.free) return;
    this.#kind[i] = Kind.free;
    this.#free[this.#freeCount++] = i;
    this.#live--;
  }

  /** Every particle and bead into the speck map, between the last two steps (see the header). */
  paint(plot: FallPlot, view: FallView): void {
    const alpha = this.#clock.alpha;
    const rig = view.rig;
    const H = view.height;
    const eye = rig.eye + view.lift;
    const half = 0.5 * view.width;
    const cellX = (x: number, z: number, slide: number): number =>
      ((rig.focal * x) / z + slide * view.parallaxX) * H + half;
    const cellY = (y: number, z: number, slide: number): number =>
      (rig.horizon + (rig.focal * (y - eye)) / z - view.shift + slide * view.parallaxY) * H;
    const depthOf = (z: number): number => Math.min(255, Math.floor(z * SPECK_DEPTH_STEP));
    const drops = view.kinds.includes("drop");
    const leaves = view.kinds.includes("leaf");
    const leafFrom = fallOffset(view.kinds, "leaf");
    const top = this.#top;
    for (let i = 0; i < top; i++) {
      const k = this.#kind[i] ?? Kind.free;
      if (k === Kind.free || !(k >= Kind.leaf ? leaves : drops)) continue;
      const x0 = this.#px[i] ?? 0;
      const y0 = this.#py[i] ?? 0;
      const z0 = this.#pz[i] ?? 0;
      const x = x0 + ((this.#x[i] ?? 0) - x0) * alpha;
      const y = y0 + ((this.#y[i] ?? 0) - y0) * alpha;
      const z = z0 + ((this.#z[i] ?? 0) - z0) * alpha;
      if (z < 0.05) continue;
      const sx = this.#slideX[i] ?? 0;
      const sy = this.#slideY[i] ?? 0;
      const cx = cellX(x, z, sx);
      const cy = cellY(y, z, sy);
      const ix = Math.floor(cx);
      const iy = Math.floor(cy);
      const depth = depthOf(z);
      const scale = (rig.focal / z) * H;
      const across = (this.#radius[i] ?? 0) * 2 * scale;
      if (k === Kind.drop) {
        // The streak first, back along the way it moves on the screen, and the body either side of
        // a head two cells across (the streak's code); then the head over them.
        const vxs = (this.#vx[i] ?? 0) * scale;
        const vys = (this.#vy[i] ?? 0) * scale;
        const len = Math.min(STREAK_CELLS, Math.hypot(vxs, vys) * STREAK_SECONDS);
        const steps = Math.floor(len);
        const norm = Math.hypot(vxs, vys) || 1;
        for (let s = 1; s <= steps; s++)
          plot.plot(
            Math.floor(cx - (vxs / norm) * s),
            Math.floor(cy - (vys / norm) * s),
            FALL_CODE.streak,
            depth,
          );
        if (across >= 0.5 && DROP_CELLS > 1) {
          plot.plot(ix - 1, iy, FALL_CODE.streak, depth);
          plot.plot(ix + DROP_CELLS, iy, FALL_CODE.streak, depth);
          for (let c = 0; c < DROP_CELLS; c++) plot.plot(ix + c, iy, FALL_CODE.drop, depth);
        } else plot.plot(ix, iy, FALL_CODE.drop, depth);
      } else if (k === Kind.droplet) {
        plot.plot(ix, iy, FALL_CODE.splash, depth);
      } else if (k === Kind.crown) {
        plot.plot(ix - 1, iy, FALL_CODE.splash, depth);
        plot.plot(ix, iy, FALL_CODE.splash, depth);
        plot.plot(ix + 1, iy, FALL_CODE.splash, depth);
        plot.plot(ix - 1, iy + 1, FALL_CODE.splash, depth);
        plot.plot(ix + 1, iy + 1, FALL_CODE.splash, depth);
      } else if (k >= Kind.leaf) {
        // Off the map, a leaf draws nothing: its cells lie within 1.55 radii of its middle.
        const out = 0.78 * across + 1;
        if (cx + out >= 0 && cx - out < view.width && cy + out >= 0 && cy - out < H)
          this.#paintLeaf(plot, i, k, cx, cy, x / z, (y - eye) / z, scale, depth, leafFrom);
      } else {
        const share = (this.#age[i] ?? 0) / MARK_LIFE;
        const code = share < 0.34 ? FALL_CODE.wet : share < 0.67 ? FALL_CODE.drying : FALL_CODE.dry;
        const w = Math.max(2, Math.round(MARK_METRES * scale));
        const nearer = Math.max(0, depth - 1);
        for (let s = 0; s < w; s++) plot.plot(ix - (w >> 1) + s, iy, code, nearer);
      }
    }
    if (drops) this.#paintBeads(plot, cellX, cellY, depthOf, rig, H);
  }

  /**
   * Leaf i as its outline, cell by cell (see the header): (cx, cy) the cell it is at, (wx, wy) its
   * place over the depth (x / z, (y - eye) / z) that folds the view's perspective into its axes'
   * images, `scale` cells a metre at its depth, `from` the leaf codes' place among the falling's.
   */
  #paintLeaf(
    plot: FallPlot,
    i: number,
    k: Kind,
    cx: number,
    cy: number,
    wx: number,
    wy: number,
    scale: number,
    depth: number,
    from: number,
  ): void {
    const f = this.#frame;
    const age = this.#age[i] ?? 0;
    const rock =
      k === Kind.leaf ? 1 : k === Kind.settling ? 1 - smoothstep(0, LEAF_SETTLE, age) : 0;
    this.#plates.orient(i, rock, f);
    // The chord axis (toward the tip) and the span axis on the screen, in cells: a point `a` along an
    // axis moves its image by (ax - wx az, ay - wy az) times the scale. The frame's axes are (x, z, y).
    const r = (this.#radius[i] ?? 0) * scale;
    const tx = r * ((f[0] ?? 0) - wx * (f[1] ?? 0));
    const ty = r * ((f[2] ?? 0) - wy * (f[1] ?? 0));
    const sx = r * ((f[3] ?? 0) - wx * (f[4] ?? 0));
    const sy = r * ((f[5] ?? 0) - wy * (f[4] ?? 0));
    const det = tx * sy - ty * sx;
    const band = Math.min(FALL_LEAF_HUES - 1, Math.floor((this.#hue[i] ?? 0) * FALL_LEAF_HUES));
    const shade = (det > 0 ? 0 : 2) + (Math.abs(f[8] ?? 1) < 0.5 ? 1 : 0);
    const code = from + band * FALL_LEAF_SHADES + shade + 1;
    // How much of it shows: dissolving in as it lets go, out as it fades where it lies.
    const shown =
      k === Kind.lying
        ? Math.min(1, (LEAF_REST - age) / LEAF_FADE_OUT)
        : k === Kind.leaf && this.#shown[i] === 0
          ? Math.min(1, age / LEAF_FADE_IN)
          : 1;
    const serial = this.#serial[i] ?? 0;
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    if (2 * r < LEAF_DOT) {
      if (shown >= 1 || hash31(ix, iy, serial) < shown) plot.plot(ix, iy, code, depth);
      return;
    }
    // Edge on, it is a sliver a tenth of it wide (the park's leaves were drawn so). The cells within
    // reach of its middle, each read in its outline's mask at the leaf point it shows.
    const dm = (det >= 0 ? 1 : -1) * Math.max(Math.abs(det), 0.1 * r * r);
    const reach = 2.4 * r * r;
    const ex = Math.ceil(Math.min(1.4 * (Math.abs(tx) + Math.abs(sx)), 1.55 * r));
    const ey = Math.ceil(Math.min(1.4 * (Math.abs(ty) + Math.abs(sy)), 1.55 * r));
    const mask = (this.#shape[i] ?? 0) * LEAF_MASK * LEAF_MASK;
    const texels = LEAF_MASK / (2 * LEAF_SPAN);
    // Mask texels a cell to the right and a cell up.
    const qxRight = (-ty / dm) * texels;
    const qyRight = (sy / dm) * texels;
    const qxUp = (tx / dm) * texels;
    const qyUp = (-sx / dm) * texels;
    for (let py = iy - ey; py <= iy + ey; py++) {
      const dy = py + 0.5 - cy;
      const dx0 = ix - ex + 0.5 - cx;
      let mx = LEAF_MASK / 2 + dx0 * qxRight + dy * qxUp;
      let my = LEAF_MASK / 2 + dx0 * qyRight + dy * qyUp;
      for (let px = ix - ex; px <= ix + ex; px++, mx += qxRight, my += qyRight) {
        const dx = px + 0.5 - cx;
        if (dx * dx + dy * dy > reach || mx < 0 || my < 0 || mx >= LEAF_MASK || my >= LEAF_MASK)
          continue;
        if (LEAF_MASKS[mask + Math.floor(my) * LEAF_MASK + Math.floor(mx)] === 0) continue;
        if (shown < 1 && hash31(px, py, serial) >= shown) continue;
        plot.plot(px, py, code, depth);
      }
    }
  }

  /** The beads swelling at the drip points whose beat will let go (see the header). */
  #paintBeads(
    plot: FallPlot,
    cellX: (x: number, z: number, slide: number) => number,
    cellY: (y: number, z: number, slide: number) => number,
    depthOf: (z: number) => number,
    rig: LevelCamera,
    H: number,
  ): void {
    if (this.#amount <= 0) return;
    const t = (this.#steps + this.#clock.alpha) * FALL_STEP;
    for (let k = 0; k < this.#dripCount; k++) {
      const d = this.#drips[k];
      if (d === undefined || d.z < 0.05) continue;
      const beat = this.#beat(d.key);
      const ph = t / beat.period - beat.phase;
      const n = Math.floor(ph);
      const into = (ph - n) * beat.period;
      if (into >= beat.gather) continue;
      const grown = into / beat.gather;
      if (grown < BEAD_SHOWS) continue;
      if (hash31(d.key, n, this.#seed + 5) > this.#keep(beat.jitter, beat.period)) continue;
      const ix = Math.floor(cellX(d.x, d.z, d.slideX));
      const iy = Math.floor(cellY(d.y, d.z, d.slideY)) - 1;
      const depth = depthOf(d.z);
      const across = DROP_RADIUS * 2 * grown * (rig.focal / d.z) * H;
      if (across >= 0.5 && grown > 0.8) {
        plot.plot(ix - 1, iy, FALL_CODE.streak, depth);
        plot.plot(ix + 2, iy, FALL_CODE.streak, depth);
        plot.plot(ix + 1, iy, FALL_CODE.bead, depth);
      }
      plot.plot(ix, iy, FALL_CODE.bead, depth);
    }
  }
}

/**
 * A drop's lens (`fallingSpeck`): its highlight shows the brightest light behind and over the eye
 * small and inverted, at the brightness it has (a lens keeps it): the brighter of the backdrop's drop
 * light and the sky wet things mirror, then LENS_KEY of the key while it is up and LENS_LAMP of the
 * lamps' light at the drop.
 */
const LENS_KEY = 0.4;
const LENS_LAMP = 1.5;
/** A drop's body (its rim and its streak): the share of what lies behind it that it passes, and of its lens. */
const BODY_SEE = 0.35;
const BODY_LENS = 0.05;
/**
 * A fresh wet mark: how much it darkens what it lies on, the share of its cells that glint with the
 * sky, and how brightly; less as it dries.
 */
const WET_DARK = 0.45;
const WET_GLINTS = 0.3;
const WET_GLINT = 0.7;

/**
 * The falling things' colours in the program (README "Falling things"): `vec3 fallingSpeck(int code,
 * vec3 under, float z, Ctx x)` for the kinds on (FALL_KINDS' order, each kind's codes from its base),
 * which the composer's speck pass calls for a code of the composer's range (glsl.ts), z the speck's
 * depth. A drop is a lens: its head, a bead and a splash's crown and droplets show the brightest
 * light behind and over the eye (LENS_*). Its body, the rim either side of the head and its streak,
 * passes a third of what lies behind it: a darker rim and trail against bright spray, lost in dark
 * rock, where the head alone shows. A wet mark darkens what it lies on and glosses it, the bright
 * sky (x.air.deck) glinting on some of its cells; both fade as it dries. A leaf takes the palette
 * its layer names (LayerFalling.leaf: the hue band's middle, its shade code 0..3), a plain brown
 * where none does.
 */
export function fallingGlsl(falling: {
  readonly kinds: readonly FallKind[];
  readonly leaf?: string | undefined;
}): string {
  const { kinds, leaf } = falling;
  const drops = kinds.includes("drop");
  const from = fallOffset(kinds, "leaf");
  const leaves = kinds.includes("leaf")
    ? `  if (code > ${from} && code <= ${from + FALL_CODES.leaf}) {
    int k = code - ${from + 1};
    int band = k / ${FALL_LEAF_SHADES};
${
  leaf === undefined
    ? `    return vec3(${glslFloat(0.45)}, ${glslFloat(0.25)}, ${glslFloat(0.1)}) * (k - band * ${FALL_LEAF_SHADES} < 2 ? 1.0 : 1.2);`
    : `    return ${leaf}((float(band) + 0.5) / ${glslFloat(FALL_LEAF_HUES)}, k - band * ${FALL_LEAF_SHADES}, z, x);`
}
  }
`
    : "";
  return `
// ---- the falling things (composer/falling.ts) ----
${leaf === undefined || leaves === "" ? "" : `vec3 ${leaf}(float hue, int shade, float z, Ctx x);\n`}vec3 fallingSpeck(int code, vec3 under, float z, Ctx x) {
${leaves}${
    drops
      ? `  vec3 at = vec3((x.uv.x - 0.5) * x.aspect, x.uv.y - RIG_HORIZON, 0.0) * (z / RIG_FOCAL) + vec3(0.0, x.eye, z);
  vec3 lens = max(x.air.drop, x.air.deck) + x.light.sun * (${glslFloat(LENS_KEY)} * x.light.keyUp) + localLight(at, vec3(0.0)) * ${glslFloat(LENS_LAMP)};
  if (code == ${FALL_CODE.drop} || code == ${FALL_CODE.bead} || code == ${FALL_CODE.splash}) return lens;
  if (code == ${FALL_CODE.streak}) return under * ${glslFloat(BODY_SEE)} + lens * ${glslFloat(BODY_LENS)};
  float wet = code == ${FALL_CODE.wet} ? 1.0 : (code == ${FALL_CODE.drying} ? 0.66 : 0.33);
  float glint = step(hash12(x.cell), ${glslFloat(WET_GLINTS)} * (1.5 * wet - 0.5));
  return under * (1.0 - ${glslFloat(WET_DARK)} * wet) + x.air.deck * (${glslFloat(WET_GLINT)} * glint);`
      : "  return under;"
  }
}
`;
}
