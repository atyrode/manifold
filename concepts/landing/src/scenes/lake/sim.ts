// The frozen lake's simulation, all on the CPU: the crack network and the singing ice, the snow the
// wind drifts across the ice, and the aurora's substorms (the scene is index.ts, the picture
// shader.ts).
//
// Field coordinates. The ice is addressed by where it shows on screen with the camera at rest
// (CAMERA, a LevelCamera, sims/camera.ts): fu = F x / z (screenX), screen heights right of the
// centre, and fv = E F / z (groundDrop), screen heights below the horizon (x across and z ahead on the
// ice in metres, F the focal length in screen heights, E the eye's height). A texel is then about a
// dither cell near and far, a straight crack on the ice is a straight line in the field, and the
// shader finds a pixel's texel at its own screen position.
//
// The crack network. Lake ice shrinks as the night deepens and cracks: long pressure cracks run
// right across the lake, branches leave them at steep angles and stop where they meet another
// crack, and short hairlines web the near ice between them. Each crack grows as a jagged walk on
// the ice (a gently bending heading with a fresh jag at every step, a step being about four cells
// on screen) and may sprout a branch at any step. The network grows once per seed and fractures
// setting, before the first frame, so the lake opens already cracked. Then the ice sings: now and
// then a crack zips across it (a branch out of an old crack, or a long crack from beyond the
// frame), two run out from where a click knocked on the ice, and once the night has used its share
// of new cracks the ice sings along old ones instead. A zipping crack is stamped into the field as
// its front passes and glows behind the front. The M (the landmark) is a crack of its own that
// zips in stroke by stroke a moment after it is switched on.
//
// Drifting snow, on a coarser grid over the same field. Packed snow lies in wind-shaped patches
// that only the pointer's broom moves. Loose snow on and around them is lifted where gusts push the
// wind over a threshold, carried downwind as drifting snow (streamers trailing off every patch,
// each row at its own on-screen pace), and settles again where it is more than the wind can carry
// and as the wind drops, mostly on snow (on bare black ice it slides on). Air from beyond the frame
// brings its own share, and falling snow adds to both.
// Dragging on the ice sweeps it clear and heaps the snow either side of the stroke.
//
// The aurora. A quiet arc brightens slowly for most of a minute, then breaks up: the light surges,
// curtains spread overhead and ripple faster, and over a couple of minutes the display recovers.
// Substorms come at random, every few minutes at the default frequency; "now" starts one at once.
// The sim keeps the aurora's own clock (motion time, sped up through a breakup) for the shader.
//
// Time: schedules, the snow and the aurora's clock run on dt * motion; a zipping crack, its glow
// and a substorm's surge play on dt, so a "now" still plays at motion 0. Everything depends only on
// the seed, the knobs and the clocks, except what the pointer does.
//
// Textures:
//   uSim0  rgba8 FIELD_W × FIELD_H, linear: R the distance to the nearest crack (DIST_RANGE = 1);
//          G how far up the screen the nearest crack above is (ABOVE_RANGE = 1: none within it);
//          B the nearest crack's class (1 a pressure crack .. ~0.2 a hairline); A the class of the
//          crack above, whose fracture plane the shader hangs down into the ice.
//   uSim1  rgba8, the same field, nearest: R the nearest crack's id / 255, G how far along it
//          (0..1); B and A the same for the crack above.
//   uSim2  rgba16f CRACK_SLOTS × 2, nearest. Row 0, texel id: how far that crack's front has run
//          (0..1 along it), its glow 0..1, and how far behind the front the glow reaches (a share of
//          its length). Row 1: texel 0 the aurora (gain, clock = G + B, substorm 0..1); texel 1 the
//          drifting snow (streamer offset downwind = R + G metres, wind m/s).
//   uSim3  rgba8 SNOW_W × SNOW_H, linear, the same field: R lying snow (SNOW_MAX = 1), G drifting
//          snow (DRIFT_MAX = 1), B the share of the lying snow that is loose.
//
// Cost (V8 estimates): the first frame grows the network (~2-3k steps, stamped twice), packs and
// uploads both fields (1.3 MB each) and prewarms the snow: ~20-30 ms. Each frame then steps the
// snow (20k texels, ~1 ms) and uploads it (80 KB) and the state row (8 KB); a zipping crack
// stamps a few segments and uploads the few columns they touch. A change of seed, fractures or the
// M re-stamps the whole field (~10 ms). Nothing is allocated per frame outside those events.
import type { ParamDef } from "../../params.ts";
import { LevelCamera } from "../../sims/camera.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- The view and the fields, shared with the shader ----

/** Screen height (uv) of the horizon, the vertical field of view (rad) and its focal length (screen heights). */
export const HORIZON = 0.4;
export const FOV = 1.08;
export const FOCAL = 0.5 / Math.tan(FOV / 2);
/** The eye's height over the ice (m). */
export const EYE = 1.6;
/** The eye at rest, which lays out the fields: world on the ice ↔ field (screen) coordinates. */
const CAMERA = new LevelCamera({ horizon: HORIZON, eye: EYE, focal: FOCAL });
/** Refractive index of ice, and how far down the deepest fracture planes and bubbles reach (m). */
export const ICE_INDEX = 1.31;
export const ICE_DEPTH = 0.7;
/** The crack field: its size in texels, and the screen it spans (half-width, and depth below the horizon, in screen heights). */
export const FIELD_W = 1280;
export const FIELD_H = 256;
export const FIELD_FU = 1.3;
export const FIELD_FV = 0.41;
/** What encodes as 1 (screen heights): the distance to the nearest crack, and up to the crack above. */
export const DIST_RANGE = 0.01;
export const ABOVE_RANGE = 0.07;
/** The snow grid over the same field, and the lying depth and drifting density that encode as 1. */
export const SNOW_W = 256;
export const SNOW_H = 80;
export const SNOW_MAX = 2;
export const DRIFT_MAX = 1.5;
/** Crack ids: 0 is none, MARK_ID the M. */
export const CRACK_SLOTS = 256;
export const MARK_ID = 255;

// ---- Fields ----

const FIELD_N = FIELD_W * FIELD_H;
const TEXEL_U = (2 * FIELD_FU) / FIELD_W;
const TEXEL_V = FIELD_FV / FIELD_H;
/** Within this distance (screen heights) of a texel's centre a crack runs through it: half a texel's height, so every crossing of a column marks a row. */
const LINE_HIT = 0.0009;
/** Rows below a crack that its fracture plane can reach on screen. */
const ABOVE_ROWS = Math.ceil(ABOVE_RANGE / TEXEL_V) + 1;

// ---- Growing cracks ----

/** A step covers about this much screen (screen heights), and never more than this much ice (m). */
const STEP_SH = 0.008;
const STEP_MAX_M = 9;
/** The jag of each step (rad, standard deviation), the heading's bend (rad per metre) and its drift per step. */
const JAG = 0.17;
const BEND = 0.01;
const BEND_DRIFT = 0.003;
/** The ice the network covers: from just under the frame's bottom edge out to here (m). */
const Z_NEAR = 3;
const Z_FAR = 170;
/** A crack meets another within this distance (screen heights). */
const MEET = 0.0022;
/** Chance per step of a branch, at fractures 0 and 1; the share of its parent's class a branch keeps; the faintest crack grown. */
const BRANCH_FEW = 0.008;
const BRANCH_MANY = 0.04;
const BRANCH_KEEP = 0.62;
const CLASS_MIN = 0.22;
/** Pressure cracks and near hairlines at fractures 1. */
const MAINS_MAX = 5;
const WEB_MAX = 40;
/** Ids the first network may use; the night's new cracks take the rest below MARK_ID. */
const BASE_MAX = 170;
const STEPS_MAX = 600;

// ---- Singing ice ----

/** How fast a crack's front runs (screen heights per second); the M's, slower so it reads. */
const ZIP_SPEED = 1.2;
const MARK_ZIP_SPEED = 0.32;
/** Seconds the glow takes to fade (per e-fold) once the front stops, and how far behind the front it reaches (screen heights). */
const GLOW_FADE = 1.1;
const MARK_GLOW_FADE = 2.6;
const GLOW_REACH = 0.07;
/** Mean seconds between songs at frequency 0 and 1 (each varied by ±40%), and before the first. */
const SONG_RARE = 240;
const SONG_OFTEN = 14;
const SONG_FIRST = 9;
/** Seconds after the M is switched on before it sings in. */
const MARK_DELAY = 1.5;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads both). Entrance:
 * the camera tilts down from the aurora onto the ice, and a crack sings across it. Exit: a gust of
 * snow streams across the ice while the camera tilts back up to the sky.
 */
export const LAKE_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };
/** How far into the entrance (0..1) a crack starts to sing, and how fast its front runs (screen heights per second). */
const ENTRANCE_SING_AT = 0.4;
const ENTRANCE_ZIP_SPEED = 2;

/** The M: its height (screen heights), centre below the horizon, and the jag of its strokes. */
const MARK_SIZE = 0.13;
const MARK_DEPTH = 0.215;
const MARK_JAG = 0.0005;
/** A press that moves less than this (screen heights) before it lifts knocks on the ice. */
const KNOCK_MOVE = 0.012;
/** The pointer reaches the ice from this far below the horizon (screen heights; ~45 m out). */
const POINTER_FAR = 0.03;

// ---- Drifting snow ----

const SNOW_N = SNOW_W * SNOW_H;
const SNOW_TEXEL_U = (2 * FIELD_FU) / SNOW_W;
/** The wind at wind 1 (m/s), and how fast the snow follows the knob (s). */
const WIND_SPEED = 8;
const WIND_EASE = 2;
/** Wind below LIFT (m/s) moves no snow; LIFT + LIFT_SPAN moves all it can. */
const LIFT = 0.9;
const LIFT_SPAN = 3.5;
/** Erosion of loose snow (1/s), the drifting snow the wind can carry, settling above that (1/s) and in still air (1/s). */
const ERODE = 1.5;
const CARRY = 0.6;
const SETTLE = 0.9;
const CALM_SETTLE = 0.35;
/** Streamers move at this share of the wind; the air from beyond the frame brings this share of a full load. */
const SALTATION = 0.65;
const INFLOW = 0.5;
/** Most loose snow a texel holds. */
const LOOSE_MAX = 1;
/** Gust fronts: their size along the wind (m) and the pace they travel at (share of the wind). */
const GUST_LEN = 16;
const GUST_PACE = 0.8;
const GUST_CELLS = 512;
/** The broom: radius (m), how much a pass takes, the reach of the heaps beside it (radii), the share thrown into the air. */
const SWEEP_RADIUS = 0.32;
const SWEEP_TAKE = 0.92;
const SWEEP_HEAP = 1.8;
const SWEEP_PUFF = 0.2;
/** Snowfall: depth per second at snow 1. */
const SNOWFALL = 0.03;
/** Prewarm: steps and their length (s). */
const SNOW_PREWARM = 16;
const SNOW_PREWARM_DT = 0.4;

// ---- The aurora ----

/** Mean seconds between substorms at frequency 0 and 1 (each varied by ±40%), and before the first. */
const SUBSTORM_RARE = 480;
const SUBSTORM_OFTEN = 60;
const SUBSTORM_FIRST = 38;
/** Seconds of slow growth before onset and its share of a full surge; the breakup's rise, how long it stays active, and the recovery's e-fold (s). */
const GROWTH = 45;
const GROWTH_SHARE = 0.18;
const BREAKUP = 6;
const ACTIVE = 25;
const RECOVERY = 50;
/** The surge follows its course with this lag (s). */
const SURGE_EASE = 1.2;
/** The aurora's brightness quiet, the extra at the peak of a surge, and its extra pace there. */
const GAIN_QUIET = 0.9;
const GAIN_SURGE = 1.6;
const PACE_SURGE = 1.4;

// ---- Time ----

/** Longest frame step taken (s). */
const DT_MAX = 0.1;
/** Frames a fractures setting must hold before the network regrows (a dragged slider regrows once). */
const SETTLE_FRAMES = 8;
/** Clocks handed to the shader in half floats wrap here (s, m): 9 hours. */
const CLOCK_WRAP = 32768;
const SEED_BASE = 0x1ce1a4e;

type KnobKey = "substorm" | "cracks" | "fractures" | "drift" | "iceSeed" | "wind" | "snow" | "mark";

/** The simulation was set up wrong: a knob it reads is missing. */
export class LakeSimError extends Error {}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** mulberry32: a small seeded generator, so the same seed always gives the same night. */
class Random {
  #state = 0;

  seed(seed: number): void {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Roughly normal, mean 0, standard deviation 1 (three uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
}

/** A hash of a lattice point to 0..1. */
function hash2(i: number, j: number, salt: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise 0..1. */
function noise2(x: number, y: number, salt: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, salt);
  const b = hash2(i + 1, j, salt);
  const c = hash2(i, j + 1, salt);
  const d = hash2(i + 1, j + 1, salt);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * One octave of the snow patches at (x, z) on the ice (m): noise stretched sx by sz metres, eased to
 * its mean where a texel spans more than about a third of it (`across` by `along` metres).
 */
function patchOctave(x: number, z: number, across: number, along: number, sx: number, sz: number, salt: number): number {
  const keep = 1 - smoothstep(0.3, 0.8, Math.max(across / sx, along / sz));
  return 0.5 + (noise2(x / sx, z / sz, salt) - 0.5) * keep;
}

/** A clock for the shader as two half floats: a multiple of 32 (exact) and the rest (to ~1/64). */
function splitClock(value: number, out: Float32Array, at: number): void {
  const wrapped = value - CLOCK_WRAP * Math.floor(value / CLOCK_WRAP + 0.5);
  const high = 32 * Math.floor(wrapped / 32);
  out[at] = high;
  out[at + 1] = wrapped - high;
}

/** A crack's start: where on the ice (m), heading (rad from +x toward +z), class, how much screen it may cover, and the crack it leaves. */
interface Sprout {
  x: number;
  z: number;
  angle: number;
  cls: number;
  reach: number;
  parent: number;
}

class Crack {
  /** Field points (screen heights) and the arc length up to each. */
  u: number[] = [];
  v: number[] = [];
  s: number[] = [];
  length = 0;
  /** Segments stamped into the field so far. */
  stamped = 0;
  /** How far the front has run (screen heights), its pace, seconds before it starts. */
  front = Number.POSITIVE_INFINITY;
  speed = ZIP_SPEED;
  delay = 0;
  /** Glowing: zipping, or fading for `since` seconds over `fade`. */
  singing = false;
  since = 0;
  fade = GLOW_FADE;

  constructor(
    readonly id: number,
    readonly cls: number,
  ) {}

  add(u: number, v: number): void {
    this.u.push(u);
    this.v.push(v);
  }

  /** Lay `back`, grown from the same start the other way, in front of this walk. */
  prepend(back: Crack): void {
    const u = back.u.slice(1).reverse();
    const v = back.v.slice(1).reverse();
    this.u = u.concat(this.u);
    this.v = v.concat(this.v);
  }

  /** Arc lengths, once the walk is done. */
  finish(): void {
    const n = this.u.length;
    this.s = new Array<number>(n);
    let run = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) run += Math.hypot((this.u[i] ?? 0) - (this.u[i - 1] ?? 0), (this.v[i] ?? 0) - (this.v[i - 1] ?? 0));
      this.s[i] = run;
    }
    this.length = run;
  }

  /** Start singing: the front runs from the start at `speed` after `delay`. */
  sing(speed: number, fade: number, delay: number): void {
    this.front = 0;
    this.speed = speed;
    this.fade = fade;
    this.delay = delay;
    this.since = 0;
    this.singing = true;
  }
}

/** The crack field: the nearest crack and the crack above at every texel, packed for uSim0 and uSim1. */
class CrackField {
  readonly dist = new Float32Array(FIELD_N);
  readonly id = new Uint8Array(FIELD_N);
  readonly arc = new Uint8Array(FIELD_N);
  readonly cls = new Uint8Array(FIELD_N);
  readonly near = new Uint8Array(FIELD_N * 4);
  readonly ids = new Uint8Array(FIELD_N * 4);
  /** Columns and rows stamped since the last flush. */
  #i0 = 0;
  #i1 = FIELD_W - 1;
  #j0 = 0;
  #j1 = FIELD_H - 1;
  /** The rectangle the last flush repacked: x, y, width, height (width 0: nothing). */
  readonly rect = new Int32Array(4);

  clear(): void {
    this.dist.fill(Number.POSITIVE_INFINITY);
    this.id.fill(0);
    this.arc.fill(0);
    this.cls.fill(0);
    this.#i0 = 0;
    this.#i1 = FIELD_W - 1;
    this.#j0 = 0;
    this.#j1 = FIELD_H - 1;
  }

  /** The texel nearest field point (u, v), or -1 off the field. */
  at(u: number, v: number): number {
    const i = Math.round((u + FIELD_FU) / TEXEL_U - 0.5);
    const j = Math.round(v / TEXEL_V - 0.5);
    if (i < 0 || i >= FIELD_W || j < 0 || j >= FIELD_H) return -1;
    return j * FIELD_W + i;
  }

  /** One segment of crack `crackId` from (u0, v0) to (u1, v1), `a0`..`a1` along it (0..1). */
  stamp(u0: number, v0: number, u1: number, v1: number, a0: number, a1: number, crackId: number, crackCls: number): void {
    const i0 = Math.max(0, Math.floor((Math.min(u0, u1) - DIST_RANGE + FIELD_FU) / TEXEL_U - 0.5));
    const i1 = Math.min(FIELD_W - 1, Math.ceil((Math.max(u0, u1) + DIST_RANGE + FIELD_FU) / TEXEL_U - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(v0, v1) - DIST_RANGE) / TEXEL_V - 0.5));
    const j1 = Math.min(FIELD_H - 1, Math.ceil((Math.max(v0, v1) + DIST_RANGE) / TEXEL_V - 0.5));
    if (i0 > i1 || j0 > j1) return;
    const du = u1 - u0;
    const dv = v1 - v0;
    const len2 = Math.max(du * du + dv * dv, 1e-12);
    const c = Math.round(clamp(crackCls, 0, 1) * 255);
    for (let j = j0; j <= j1; j++) {
      const pv = (j + 0.5) * TEXEL_V - v0;
      for (let i = i0; i <= i1; i++) {
        const pu = (i + 0.5) * TEXEL_U - FIELD_FU - u0;
        const t = clamp((pu * du + pv * dv) / len2, 0, 1);
        const eu = pu - du * t;
        const ev = pv - dv * t;
        const d = Math.sqrt(eu * eu + ev * ev);
        const k = j * FIELD_W + i;
        if (d >= DIST_RANGE || d >= (this.dist[k] ?? 0)) continue;
        this.dist[k] = d;
        this.id[k] = crackId;
        this.arc[k] = Math.round(clamp(a0 + (a1 - a0) * t, 0, 1) * 255);
        this.cls[k] = c;
      }
    }
    this.#i0 = Math.min(this.#i0, i0);
    this.#i1 = Math.max(this.#i1, i1);
    this.#j0 = Math.min(this.#j0, j0);
    this.#j1 = Math.max(this.#j1, j1);
  }

  /** Work out the crack above for the stamped columns and pack them; `rect` says what to upload. */
  flush(): void {
    const rect = this.rect;
    if (this.#i0 > this.#i1) {
      rect[2] = 0;
      return;
    }
    const i0 = this.#i0;
    const i1 = this.#i1;
    const j0 = this.#j0;
    const j1 = Math.min(FIELD_H - 1, this.#j1 + ABOVE_ROWS);
    for (let i = i0; i <= i1; i++) {
      let lineV = -1;
      let lineId = 0;
      let lineArc = 0;
      let lineCls = 0;
      for (let j = 0; j <= j1; j++) {
        const k = j * FIELD_W + i;
        const d = this.dist[k] ?? Number.POSITIVE_INFINITY;
        const v = (j + 0.5) * TEXEL_V;
        if (d < LINE_HIT) {
          lineV = v;
          lineId = this.id[k] ?? 0;
          lineArc = this.arc[k] ?? 0;
          lineCls = this.cls[k] ?? 0;
        } else if (lineV >= 0 && v - lineV >= ABOVE_RANGE) {
          lineV = -1;
        }
        if (j < j0) continue;
        const o = k * 4;
        const has = lineV >= 0;
        this.near[o] = d < DIST_RANGE ? Math.round((d / DIST_RANGE) * 255) : 255;
        this.near[o + 1] = has ? Math.round(((v - lineV) / ABOVE_RANGE) * 255) : 255;
        this.near[o + 2] = this.cls[k] ?? 0;
        this.near[o + 3] = has ? lineCls : 0;
        this.ids[o] = this.id[k] ?? 0;
        this.ids[o + 1] = this.arc[k] ?? 0;
        this.ids[o + 2] = has ? lineId : 0;
        this.ids[o + 3] = has ? lineArc : 0;
      }
    }
    rect[0] = i0;
    rect[1] = j0;
    rect[2] = i1 - i0 + 1;
    rect[3] = j1 - j0 + 1;
    this.#i0 = FIELD_W;
    this.#i1 = -1;
    this.#j0 = FIELD_H;
    this.#j1 = -1;
  }
}

/** Upload rectangle (x, y, w, h) of a FIELD_W-wide rgba8 array into its texture. */
function uploadRect(gl: WebGL2RenderingContext, texture: WebGLTexture, data: Uint8Array, rect: Int32Array): void {
  const x = rect[0] ?? 0;
  const y = rect[1] ?? 0;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, FIELD_W);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rect[2] ?? 0, rect[3] ?? 0, gl.RGBA, gl.UNSIGNED_BYTE, data, (y * FIELD_W + x) * 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
}

/** Snow on the ice: packed patches, loose snow, and the snow drifting over it. */
class DriftingSnow {
  readonly hard = new Float32Array(SNOW_N);
  readonly loose = new Float32Array(SNOW_N);
  readonly drift = new Float32Array(SNOW_N);
  readonly data = new Uint8Array(SNOW_N * 4);
  readonly #next = new Float32Array(SNOW_N);
  /** This step's streamer speed (m/s, signed) and how far the wind is over the threshold (0..1). */
  readonly #speed = new Float32Array(SNOW_N);
  readonly #lift = new Float32Array(SNOW_N);
  /** Where each texel lies on the ice (m). */
  readonly #x = new Float32Array(SNOW_N);
  readonly #z = new Float32Array(SNOW_N);
  /** Texels a row moves per metre of drift. */
  readonly #rowRate = new Float32Array(SNOW_H);
  readonly #gusts = new Float32Array(GUST_CELLS);

  constructor() {
    for (let j = 0; j < SNOW_H; j++) {
      const fv = ((j + 0.5) / SNOW_H) * FIELD_FV;
      const z = CAMERA.groundDepth(fv);
      this.#rowRate[j] = fv / EYE / SNOW_TEXEL_U;
      for (let i = 0; i < SNOW_W; i++) {
        const fu = (i + 0.5) * SNOW_TEXEL_U - FIELD_FU;
        const k = j * SNOW_W + i;
        this.#x[k] = CAMERA.worldX(fu, z);
        this.#z[k] = z;
      }
    }
  }

  /** Lay the night's snow for a seed: packed patches drawn out along the wind, snowier toward the far shore. */
  reset(seed: number): void {
    const salt = seed * 7 + 3;
    for (let k = 0; k < SNOW_N; k++) {
      const x = this.#x[k] ?? 0;
      const z = this.#z[k] ?? 1;
      // The ice one texel spans (m): octaves finer than a few texels give way to their mean.
      const across = CAMERA.worldX(SNOW_TEXEL_U, z);
      const along = (FIELD_FV / SNOW_H) * ((z * z) / (EYE * FOCAL));
      const n =
        0.5 * patchOctave(x, z, across, along, 9, 3, salt) +
        0.32 * patchOctave(x, z, across, along, 3.5, 1.2, salt + 1) +
        0.18 * patchOctave(x, z, across, along, 1.4, 0.5, salt + 2) +
        0.08 * smoothstep(30, 120, z);
      const hard = clamp((n - 0.3) / 0.42, 0, 1);
      this.hard[k] = hard;
      this.loose[k] = 0.2 * hard + 0.02;
      this.drift[k] = 0;
    }
    for (let g = 0; g < GUST_CELLS; g++) this.#gusts[g] = hash2(g, 17, salt);
  }

  /** How hard the wind blows here, as a share of its mean: gust fronts riding downwind. */
  #gust(x: number, z: number, offset: number): number {
    const p = (x - offset) / GUST_LEN + z * 0.037;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.#gusts[i & (GUST_CELLS - 1)] ?? 0;
    const b = this.#gusts[(i + 1) & (GUST_CELLS - 1)] ?? 0;
    return 0.45 + 1.1 * smoothstep(0.3, 0.8, a + (b - a) * f * f * (3 - 2 * f));
  }

  /** Advance dt seconds: wind (m/s, signed), drift amount 0..1, snowfall 0..1, gust fronts' offset (m). */
  step(dt: number, wind: number, amount: number, snowfall: number, gustOffset: number): void {
    if (dt <= 0) return;
    const speed = Math.abs(wind);
    const sign = wind < 0 ? -1 : 1;
    const hard = this.hard;
    const loose = this.loose;
    const drift = this.drift;
    for (let k = 0; k < SNOW_N; k++) {
      const ue = speed * this.#gust(this.#x[k] ?? 0, this.#z[k] ?? 0, gustOffset);
      const ex = clamp((ue - LIFT) / LIFT_SPAN, 0, 1);
      this.#lift[k] = ex;
      this.#speed[k] = sign * ue * SALTATION;
      const l = loose[k] ?? 0;
      const d = drift[k] ?? 0;
      const erode = ERODE * amount * ex * Math.min(l, 0.5);
      const carry = CARRY * amount * ex;
      // Snow settles mostly on snow: on bare black ice it slides on.
      const grip = 0.2 + 0.8 * Math.min(1, ((hard[k] ?? 0) + l) * 1.6);
      const settle = (SETTLE * Math.max(d - carry, 0) + CALM_SETTLE * d * (1 - ex)) * grip;
      loose[k] = clamp(l + (settle - erode + snowfall * SNOWFALL) * dt, 0, LOOSE_MAX);
      drift[k] = clamp(d + (erode - settle + 0.6 * snowfall * SNOWFALL) * dt, 0, DRIFT_MAX);
    }
    // Downwind, row by row (the wind blows along x, which runs along the rows).
    const next = this.#next;
    for (let j = 0; j < SNOW_H; j++) {
      const rate = (this.#rowRate[j] ?? 0) * dt;
      const row = j * SNOW_W;
      for (let i = 0; i < SNOW_W; i++) {
        const k = row + i;
        const src = i - (this.#speed[k] ?? 0) * rate;
        if (src < 0 || src > SNOW_W - 1) {
          next[k] = CARRY * amount * (this.#lift[k] ?? 0) * INFLOW;
          continue;
        }
        const s0 = Math.floor(src);
        const f = src - s0;
        const a = drift[row + s0] ?? 0;
        const b = drift[row + Math.min(s0 + 1, SNOW_W - 1)] ?? 0;
        next[k] = a + (b - a) * f;
      }
    }
    drift.set(next);
  }

  /** The broom from (x0, z0) to (x1, z1) on the ice (m): clear the snow, heap it either side, throw a little into the air. */
  sweep(x0: number, z0: number, x1: number, z1: number): void {
    const reach = SWEEP_RADIUS * SWEEP_HEAP;
    const zNear = Math.max(Math.min(z0, z1) - reach, 0.5);
    const zFar = Math.max(z0, z1) + reach;
    const jA = clamp(Math.floor((CAMERA.groundDrop(zFar) / FIELD_FV) * SNOW_H - 0.5), 0, SNOW_H - 1);
    const jB = clamp(Math.ceil((CAMERA.groundDrop(zNear) / FIELD_FV) * SNOW_H - 0.5), 0, SNOW_H - 1);
    const xMin = Math.min(x0, x1) - reach;
    const xMax = Math.max(x0, x1) + reach;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = Math.max(dx * dx + dz * dz, 1e-9);
    let removed = 0;
    let ring = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = jA; j <= jB; j++) {
        const fv = ((j + 0.5) / SNOW_H) * FIELD_FV;
        const z = CAMERA.groundDepth(fv);
        const iA = clamp(Math.floor((CAMERA.screenX(xMin, z) + FIELD_FU) / SNOW_TEXEL_U - 0.5), 0, SNOW_W - 1);
        const iB = clamp(Math.ceil((CAMERA.screenX(xMax, z) + FIELD_FU) / SNOW_TEXEL_U - 0.5), 0, SNOW_W - 1);
        for (let i = iA; i <= iB; i++) {
          const k = j * SNOW_W + i;
          const px = (this.#x[k] ?? 0) - x0;
          const pz = (this.#z[k] ?? 0) - z0;
          const t = clamp((px * dx + pz * dz) / len2, 0, 1);
          const d = Math.hypot(px - dx * t, pz - dz * t);
          if (pass === 0) {
            if (d < SWEEP_RADIUS) {
              const take = SWEEP_TAKE * (1 - (d / SWEEP_RADIUS) ** 2);
              const h = this.hard[k] ?? 0;
              const l = this.loose[k] ?? 0;
              removed += (h + l) * take;
              this.hard[k] = h * (1 - take);
              this.loose[k] = l * (1 - take);
              this.drift[k] = Math.min((this.drift[k] ?? 0) + (h + l) * take * SWEEP_PUFF, DRIFT_MAX);
            } else if (d < reach) {
              ring += 1 - (d - SWEEP_RADIUS) / (reach - SWEEP_RADIUS);
            }
          } else if (d >= SWEEP_RADIUS && d < reach && ring > 0) {
            const share = (1 - (d - SWEEP_RADIUS) / (reach - SWEEP_RADIUS)) / ring;
            this.loose[k] = Math.min((this.loose[k] ?? 0) + removed * (1 - SWEEP_PUFF) * share, LOOSE_MAX);
          }
        }
      }
    }
  }

  pack(): void {
    const data = this.data;
    for (let k = 0; k < SNOW_N; k++) {
      const h = this.hard[k] ?? 0;
      const l = this.loose[k] ?? 0;
      const total = h + l;
      const o = k * 4;
      data[o] = Math.round(clamp(total / SNOW_MAX, 0, 1) * 255);
      data[o + 1] = Math.round(clamp((this.drift[k] ?? 0) / DRIFT_MAX, 0, 1) * 255);
      data[o + 2] = total > 1e-3 ? Math.round(clamp(l / total, 0, 1) * 255) : 0;
      data[o + 3] = 255;
    }
  }
}

class FrozenLake implements SceneSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #knob: Readonly<Record<KnobKey, number>>;
  readonly #nearTexture: DataTexture;
  readonly #idTexture: DataTexture;
  readonly #stateTexture: DataTexture;
  readonly #snowTexture: DataTexture;
  readonly #state = new Float32Array(CRACK_SLOTS * 2 * 4);
  readonly #field = new CrackField();
  readonly #snow = new DriftingSnow();
  /** The network's growth, the night's songs and its substorms draw from separate streams. */
  readonly #growth = new Random();
  readonly #songs = new Random();
  readonly #storms = new Random();
  readonly #cracks: Crack[] = [];
  readonly #byId: (Crack | undefined)[] = new Array<Crack | undefined>(CRACK_SLOTS).fill(undefined);
  #mark: Crack | undefined;
  #nextId = 1;
  #branchChance = BRANCH_FEW;

  #primed = false;
  /** Whether this sim was built for an entrance whose crack has yet to sing (undefined until the first frame). */
  #arriving: boolean | undefined = undefined;
  #seed = Number.NaN;
  #fractures = Number.NaN;
  #wantFractures = Number.NaN;
  #steadyFrames = 0;
  #aspect = 16 / 9;
  #markAspect = Number.NaN;
  #markOn = false;

  /** Motion-scaled time (s): schedules, snow, the aurora's clock. */
  #clock = 0;
  #nextSong = Number.POSITIVE_INFINITY;
  #nextStorm = Number.POSITIVE_INFINITY;
  /** Seconds since the current substorm's onset (scene time), its eased surge, the aurora's clock. */
  #stormAge = 1e4;
  #surge = 0;
  #auroraClock = 0;
  /** The snow's wind (m/s, eased), the streamers' offset downwind and the gust fronts' (m). */
  #wind = 0;
  #windOffset = 0;
  #gustOffset = 0;

  /** The pointer: a press on the ice, how far it has moved, and where it was last frame (field). */
  #pressing = false;
  #pressU = 0;
  #pressV = 0;
  #moved = 0;
  #lastU = 0;
  #lastV = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new LakeSimError(`lake: the scene has no '${key}' knob`);
      return at;
    };
    this.#knob = {
      substorm: index("substorm"),
      cracks: index("cracks"),
      fractures: index("fractures"),
      drift: index("drift"),
      iceSeed: index("iceSeed"),
      wind: index("wind"),
      snow: index("snow"),
      mark: index("mark"),
    };
    this.#gl = gl;
    this.#nearTexture = new DataTexture(gl, { width: FIELD_W, height: FIELD_H, format: "rgba8", filter: "linear" });
    this.#idTexture = new DataTexture(gl, { width: FIELD_W, height: FIELD_H, format: "rgba8", filter: "nearest" });
    this.#stateTexture = new DataTexture(gl, { width: CRACK_SLOTS, height: 2, format: "rgba16f", filter: "nearest" });
    this.#snowTexture = new DataTexture(gl, { width: SNOW_W, height: SNOW_H, format: "rgba8", filter: "linear" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const values = frame.values;
    const knob = this.#knob;
    const dt = clamp(frame.dt, 0, DT_MAX);
    const motion = clamp(frame.motion, 0, 1);
    const mdt = dt * motion;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    const substorm = clamp(values[knob.substorm] ?? 0, 0, 1);
    const songs = clamp(values[knob.cracks] ?? 0, 0, 1);
    const fractures = clamp(values[knob.fractures] ?? 0.5, 0, 1);
    const drift = clamp(values[knob.drift] ?? 0, 0, 1);
    const seed = Math.round(values[knob.iceSeed] ?? 0);
    const wind = clamp(values[knob.wind] ?? 0, -1, 1) * WIND_SPEED;
    const snowfall = clamp(values[knob.snow] ?? 0, 0, 1);
    const markOn = (values[knob.mark] ?? 0) > 0.5;

    if (!this.#primed) {
      this.#prime(seed, fractures, markOn, wind, drift, snowfall);
    } else {
      // A dragged fractures slider regrows the network once it comes to rest; a new seed at once.
      if (fractures !== this.#wantFractures) {
        this.#wantFractures = fractures;
        this.#steadyFrames = 0;
      } else if (fractures !== this.#fractures && ++this.#steadyFrames >= SETTLE_FRAMES) {
        this.#fractures = fractures;
        this.#grow(false);
      }
      if (seed !== this.#seed) {
        this.#seed = seed;
        this.#fractures = fractures;
        this.#grow(false);
        this.#snow.reset(seed);
      }
      if (markOn !== this.#markOn) {
        this.#markOn = markOn;
        if (markOn) this.#placeMark(true);
        else this.#removeMark();
      } else if (markOn && this.#aspect !== this.#markAspect) {
        this.#removeMark();
        this.#placeMark(false);
      }
      if (frame.fired[0]) this.#stormAge = 0;
      if (frame.fired[1]) this.#sing();
      if (frame.fired[2] && this.#mark) this.#mark.sing(MARK_ZIP_SPEED, MARK_GLOW_FADE, 0);
    }

    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1;
    if (this.#arriving && frame.passage.enter >= ENTRANCE_SING_AT) {
      this.#arriving = false;
      this.#singEntrance();
    }

    // The camera is tilting while the scene comes in or goes out: the screen is not the ice's view then.
    if (frame.passage.enter >= 1 && frame.passage.exit <= 0) this.#follow(frame);
    this.#clock += mdt;

    // The ice sings on its own schedule.
    if (songs <= 0) this.#nextSong = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextSong)) this.#nextSong = this.#clock + SONG_FIRST * (0.8 + 0.4 * this.#songs.next());
    if (this.#clock >= this.#nextSong) {
      this.#sing();
      this.#nextSong = this.#clock + SONG_RARE * Math.pow(SONG_OFTEN / SONG_RARE, songs) * (0.6 + 0.8 * this.#songs.next());
    }
    this.#zip(dt);
    this.#auroraStep(dt, mdt, substorm);

    this.#wind += (wind - this.#wind) * (1 - Math.exp(-mdt / WIND_EASE));
    this.#windOffset += this.#wind * SALTATION * mdt;
    this.#gustOffset += this.#wind * GUST_PACE * mdt;
    this.#snow.step(mdt, this.#wind, drift, snowfall, this.#gustOffset);

    this.#upload();
    return [this.#nearTexture.texture, this.#idTexture.texture, this.#stateTexture.texture, this.#snowTexture.texture];
  }

  dispose(): void {
    this.#nearTexture.dispose();
    this.#idTexture.dispose();
    this.#stateTexture.dispose();
    this.#snowTexture.dispose();
  }

  /** The first frame: grow the network, lay and settle the snow, schedule the first surge and the M. */
  #prime(seed: number, fractures: number, markOn: boolean, wind: number, drift: number, snowfall: number): void {
    this.#primed = true;
    this.#seed = seed;
    this.#fractures = fractures;
    this.#wantFractures = fractures;
    this.#markOn = markOn;
    this.#storms.seed(SEED_BASE ^ Math.imul(seed + 7, 0x85ebca6b));
    this.#grow(true);
    this.#snow.reset(seed);
    this.#wind = wind;
    for (let s = 0; s < SNOW_PREWARM; s++) {
      this.#gustOffset += wind * GUST_PACE * SNOW_PREWARM_DT;
      this.#snow.step(SNOW_PREWARM_DT, wind, drift, snowfall, this.#gustOffset);
    }
    this.#surge = GROWTH_SHARE * 0.3;
  }

  // ---- The crack network ----

  /**
   * Grow the night's first network for the seed and fractures (the night's songs so far are
   * forgotten), with the M if it is on: singing in if `markSings`, else already formed.
   */
  #grow(markSings: boolean): void {
    const random = this.#growth;
    random.seed(SEED_BASE ^ Math.imul(this.#seed + 1, 0x9e3779b1));
    this.#songs.seed(SEED_BASE ^ Math.imul(this.#seed + 3, 0x27d4eb2d));
    const field = this.#field;
    field.clear();
    this.#cracks.length = 0;
    this.#byId.fill(undefined);
    this.#nextId = 1;
    const f = this.#fractures;
    this.#branchChance = BRANCH_FEW + (BRANCH_MANY - BRANCH_FEW) * f;
    const sprouts: Sprout[] = [];

    // Pressure cracks: each crosses the frame through a point spread from near to far, at a slant.
    const mains = 1 + Math.round((MAINS_MAX - 1) * f);
    for (let m = 0; m < mains; m++) {
      const z = 4.5 * Math.pow(14, (m + 0.2 + 0.6 * random.next()) / mains);
      const x = CAMERA.worldX((random.next() - 0.5) * 1.1, z);
      const angle = (random.next() - 0.5) * 1.7;
      const crack = this.#newCrack(1);
      if (!crack) break;
      const back = new Crack(crack.id, crack.cls);
      this.#walk(crack, { x, z, angle, cls: 1, reach: 4, parent: 0 }, true, sprouts, 0, random);
      this.#walk(back, { x, z, angle: angle + Math.PI, cls: 1, reach: 4, parent: 0 }, true, sprouts, 0, random);
      crack.prepend(back);
    }
    // Their branches, and the branches' branches.
    for (let s = 0; s < sprouts.length; s++) {
      const sprout = sprouts[s];
      if (!sprout) continue;
      const crack = this.#newCrack(sprout.cls);
      if (!crack) break;
      this.#walk(crack, sprout, true, sprouts, 0, random);
    }
    // Hairlines webbing the near ice between them.
    const web = Math.round(WEB_MAX * f);
    for (let w = 0; w < web; w++) {
      const sprout = this.#sproutFrom(random, 0.15, 0.3);
      if (!sprout) continue;
      sprout.reach = 0.05 + 0.16 * random.next();
      const crack = this.#newCrack(sprout.cls);
      if (!crack) break;
      this.#walk(crack, sprout, true, undefined, 0, random);
    }
    // Drop walks too short to show, and stamp the rest again with where along each crack it is.
    for (let c = this.#cracks.length - 1; c >= 0; c--) {
      const crack = this.#cracks[c];
      if (!crack) continue;
      crack.finish();
      if (crack.u.length < 2 || crack.length < STEP_SH * 0.5) {
        this.#cracks.splice(c, 1);
        this.#byId[crack.id] = undefined;
      }
    }
    this.#mark = undefined;
    this.#restamp();
    if (this.#markOn) this.#placeMark(markSings);
  }

  /** A fresh crack with the next id, or undefined once the ids for this purpose are spent. */
  #newCrack(cls: number, limit = BASE_MAX): Crack | undefined {
    if (this.#nextId > limit) return undefined;
    const crack = new Crack(this.#nextId++, cls);
    this.#cracks.push(crack);
    this.#byId[crack.id] = crack;
    return crack;
  }

  /** Stamp every crack (the M included) into a clear field, each as far as its front has run. */
  #restamp(): void {
    this.#field.clear();
    for (const crack of this.#cracks) {
      crack.stamped = 0;
      this.#stampTo(crack);
    }
  }

  /** Stamp the segments of a crack its front has reached. */
  #stampTo(crack: Crack): void {
    const n = crack.u.length - 1;
    const length = Math.max(crack.length, 1e-6);
    while (crack.stamped < n && (crack.s[crack.stamped] ?? 0) < crack.front) {
      const i = crack.stamped;
      this.#field.stamp(crack.u[i] ?? 0, crack.v[i] ?? 0, crack.u[i + 1] ?? 0, crack.v[i + 1] ?? 0, (crack.s[i] ?? 0) / length, (crack.s[i + 1] ?? 0) / length, crack.id, crack.cls);
      crack.stamped++;
    }
  }

  /**
   * Walk a crack across the ice from `sprout`, adding its points; stamp each step if `stamp`. It
   * stops where it meets another crack of class `stopBelow` or more (not its parent at the start),
   * leaves the ice in view, or has covered its reach. Branches go to `sprouts`.
   */
  #walk(crack: Crack, sprout: Sprout, stamp: boolean, sprouts: Sprout[] | undefined, stopBelow: number, random: Random): void {
    const field = this.#field;
    let x = sprout.x;
    let z = sprout.z;
    let heading = sprout.angle;
    let bend = random.gauss() * BEND;
    let u = CAMERA.screenX(x, z);
    let v = CAMERA.groundDrop(z);
    crack.add(u, v);
    let run = 0;
    const stop = Math.round(stopBelow * 255);
    for (let step = 0; step < STEPS_MAX && run < sprout.reach; step++) {
      // A step long enough to cover about STEP_SH of screen along this heading here.
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      const zz = z * z;
      const rate = Math.hypot((FOCAL * (c * z - x * s)) / zz, (EYE * FOCAL * s) / zz);
      const len = Math.min(STEP_SH / Math.max(rate, 1e-6), STEP_MAX_M);
      heading += bend * len;
      bend = bend * 0.97 + random.gauss() * BEND_DRIFT;
      const a = heading + random.gauss() * JAG;
      const nx = x + Math.cos(a) * len;
      const nz = z + Math.sin(a) * len;
      if (nz > Z_FAR) break;
      const nu = CAMERA.screenX(nx, Math.max(nz, 0.5));
      const nv = CAMERA.groundDrop(Math.max(nz, 0.5));
      let hit = false;
      let hu = nu;
      let hv = nv;
      for (let q = 1; q <= 3 && !hit; q++) {
        const pu = u + ((nu - u) * q) / 3;
        const pv = v + ((nv - v) * q) / 3;
        const k = field.at(pu, pv);
        if (k < 0) continue;
        const other = field.id[k] ?? 0;
        if (other === 0 || other === crack.id || (field.dist[k] ?? 1) > MEET) continue;
        if (other === sprout.parent && step < 4) continue;
        if ((field.cls[k] ?? 0) < stop) continue;
        hit = true;
        hu = pu;
        hv = pv;
      }
      crack.add(hu, hv);
      if (stamp) field.stamp(u, v, hu, hv, 0, 0, crack.id, crack.cls);
      run += Math.hypot(hu - u, hv - v);
      u = hu;
      v = hv;
      x = nx;
      z = nz;
      if (hit || nz < Z_NEAR || Math.abs(nu) > FIELD_FU) break;
      if (sprouts && crack.cls * BRANCH_KEEP >= CLASS_MIN && random.next() < this.#branchChance) {
        const side = random.next() < 0.5 ? -1 : 1;
        sprouts.push({
          x,
          z,
          angle: heading + side * (0.75 + 0.75 * random.next()),
          cls: crack.cls * BRANCH_KEEP,
          reach: (0.1 + 0.55 * random.next()) * crack.cls,
          parent: crack.id,
        });
      }
    }
  }

  /** A start on an existing crack, heading off it at a steep angle, where the crack shows below `nearV` in the frame. */
  #sproutFrom(random: Random, nearV: number, cls: number): Sprout | undefined {
    const half = this.#aspect / 2 - 0.03;
    for (let tries = 0; tries < 16; tries++) {
      const host = this.#cracks[Math.floor(random.next() * this.#cracks.length)];
      if (!host || host.id === MARK_ID || host.u.length < 3) continue;
      const i = 1 + Math.floor(random.next() * (host.u.length - 2));
      const u = host.u[i] ?? 0;
      const v = host.v[i] ?? 0;
      if (Math.abs(u) > half || v < nearV || v > FIELD_FV - 0.02) continue;
      // The host's heading on the ice there.
      const za = CAMERA.groundDepth(host.v[i - 1] ?? v);
      const zb = CAMERA.groundDepth(host.v[i + 1] ?? v);
      const xa = CAMERA.worldX(host.u[i - 1] ?? u, za);
      const xb = CAMERA.worldX(host.u[i + 1] ?? u, zb);
      const z = CAMERA.groundDepth(v);
      const side = random.next() < 0.5 ? -1 : 1;
      return {
        x: CAMERA.worldX(u, z),
        z,
        angle: Math.atan2(zb - za, xb - xa) + side * (Math.PI / 2 + (random.next() - 0.5) * 0.8),
        cls,
        reach: 0.2,
        parent: host.id,
      };
    }
    return undefined;
  }

  // ---- Singing ice ----

  /** The ice sings: a new crack zips across it while the night has cracks to spare, else an old one sings again. */
  #sing(): void {
    const random = this.#songs;
    if (this.#nextId < MARK_ID && random.next() < 0.75) {
      let sprout: Sprout | undefined;
      let stopBelow = 0;
      if (random.next() < 0.6) {
        sprout = this.#sproutFrom(random, 0.04, 0.55 + 0.2 * random.next());
        if (sprout) sprout.reach = 0.3 + 0.7 * random.next();
      } else {
        // A long crack from beyond the frame's edge, crossing all but the main cracks.
        const side = random.next() < 0.5 ? -1 : 1;
        const u = side * (this.#aspect / 2 + 0.02);
        const v = 0.05 + 0.27 * random.next();
        const z = CAMERA.groundDepth(v);
        sprout = { x: CAMERA.worldX(u, z), z, angle: (side > 0 ? Math.PI : 0) + (random.next() - 0.5) * 0.9, cls: 0.85, reach: 4, parent: 0 };
        stopBelow = 0.7;
      }
      if (sprout && this.#songFrom(sprout, stopBelow)) return;
    }
    this.#singAgain(undefined);
  }

  /** Two cracks running out from a knock on the ice at (x, z), or the nearest old crack singing if the night has none to spare. */
  #knock(x: number, z: number): void {
    const random = this.#songs;
    const angle = random.next() * Math.PI;
    if (this.#nextId + 1 < MARK_ID) {
      this.#songFrom({ x, z, angle, cls: 0.7, reach: 0.2 + 0.25 * random.next(), parent: 0 }, 0);
      this.#songFrom({ x, z, angle: angle + Math.PI + (random.next() - 0.5) * 0.6, cls: 0.7, reach: 0.2 + 0.25 * random.next(), parent: 0 }, 0);
      return;
    }
    const k = this.#field.at(CAMERA.screenX(x, z), CAMERA.groundDrop(z));
    this.#singAgain(k >= 0 && (this.#field.dist[k] ?? 1) < DIST_RANGE ? this.#byId[this.#field.id[k] ?? 0] : undefined);
  }

  /** Walk a new crack from `sprout` against the ice as it is now and set it zipping; false if it came to nothing. */
  #songFrom(sprout: Sprout, stopBelow: number): boolean {
    const crack = this.#newCrack(sprout.cls, MARK_ID - 1);
    if (!crack) return false;
    this.#walk(crack, sprout, false, undefined, stopBelow, this.#songs);
    crack.finish();
    if (crack.u.length < 3) {
      this.#cracks.pop();
      this.#byId[crack.id] = undefined;
      this.#nextId--;
      return false;
    }
    crack.stamped = 0;
    crack.sing(ZIP_SPEED, GLOW_FADE, 0);
    return true;
  }

  /** An old crack sings again: `crack`, or one with a good stretch in view. */
  #singAgain(crack: Crack | undefined): void {
    let pick = crack;
    const half = this.#aspect / 2;
    for (let tries = 0; !pick && tries < 24; tries++) {
      const c = this.#cracks[Math.floor(this.#songs.next() * this.#cracks.length)];
      if (!c || c.id === MARK_ID || c.singing || c.cls < 0.5) continue;
      const mid = Math.floor(c.u.length / 2);
      if (Math.abs(c.u[mid] ?? 9) < half && (c.v[mid] ?? 0) > 0.05) pick = c;
    }
    pick?.sing(ZIP_SPEED, GLOW_FADE, 0);
  }

  /**
   * The entrance's song: the longest pressure crack with a good stretch in view sings across, its
   * front running fast. An old crack and no draw from the night's streams, so what follows is the
   * night it would have been.
   */
  #singEntrance(): void {
    const half = this.#aspect / 2;
    let pick: Crack | undefined;
    for (const c of this.#cracks) {
      if (c.id === MARK_ID || c.singing || c.length <= 0) continue;
      const mid = Math.floor(c.u.length / 2);
      if (Math.abs(c.u[mid] ?? 9) >= half || (c.v[mid] ?? 0) <= 0.05) continue;
      if (!pick || c.cls > pick.cls || (c.cls === pick.cls && c.length > pick.length)) pick = c;
    }
    pick?.sing(ENTRANCE_ZIP_SPEED, GLOW_FADE, 0);
  }

  /** Run the fronts of singing cracks on dt (so a "now" plays at motion 0), stamping what they reach. */
  #zip(dt: number): void {
    for (const crack of this.#cracks) {
      if (!crack.singing) continue;
      if (crack.delay > 0) {
        crack.delay -= dt;
        continue;
      }
      if (crack.front < crack.length) {
        crack.front = Math.min(crack.front + crack.speed * dt, crack.length);
        this.#stampTo(crack);
        if (crack.front >= crack.length) crack.since = 0;
      } else {
        crack.since += dt;
        if (crack.since > crack.fade * 7) crack.singing = false;
      }
    }
  }

  /** The M as a crack, stroke by stroke from its bottom left, placed for the frame's aspect; it sings in if `sing`, else lies already formed. */
  #placeMark(sing: boolean): void {
    const random = new Random();
    random.seed(SEED_BASE ^ Math.imul(this.#seed + 11, 0x165667b1));
    const half = this.#aspect / 2;
    const size = Math.min(MARK_SIZE, 0.3 * half);
    const cu = Math.min(0.2, half - 0.6 * size - 0.03);
    const corners = [-0.47, -0.5, -0.47, 0.5, 0, -0.08, 0.47, 0.5, 0.47, -0.5];
    const crack = new Crack(MARK_ID, 0.9);
    crack.add(cu + size * (corners[0] ?? 0), MARK_DEPTH - size * (corners[1] ?? 0));
    for (let c = 0; c < 4; c++) {
      const u0 = cu + size * (corners[c * 2] ?? 0);
      const v0 = MARK_DEPTH - size * (corners[c * 2 + 1] ?? 0);
      const u1 = cu + size * (corners[c * 2 + 2] ?? 0);
      const v1 = MARK_DEPTH - size * (corners[c * 2 + 3] ?? 0);
      const len = Math.hypot(u1 - u0, v1 - v0);
      const steps = Math.max(2, Math.round(len / (STEP_SH * 0.75)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const jag = s < steps ? random.gauss() * MARK_JAG : 0;
        crack.add(u0 + (u1 - u0) * t + ((v1 - v0) / len) * jag, v0 + (v1 - v0) * t - ((u1 - u0) / len) * jag);
      }
    }
    crack.finish();
    crack.front = Number.POSITIVE_INFINITY;
    if (sing) crack.sing(MARK_ZIP_SPEED, MARK_GLOW_FADE, MARK_DELAY);
    this.#mark = crack;
    this.#markAspect = this.#aspect;
    this.#cracks.push(crack);
    this.#byId[MARK_ID] = crack;
    this.#stampTo(crack);
  }

  #removeMark(): void {
    const mark = this.#mark;
    if (!mark) return;
    this.#mark = undefined;
    const at = this.#cracks.indexOf(mark);
    if (at >= 0) this.#cracks.splice(at, 1);
    this.#byId[MARK_ID] = undefined;
    this.#restamp();
  }

  // ---- The pointer ----

  /** A press on the ice that lifts where it went down knocks; one that moves sweeps the snow. */
  #follow(frame: SimFrame): void {
    const pointer = frame.pointer;
    const u = (pointer.x - 0.5) * this.#aspect;
    const v = CAMERA.horizon - pointer.y;
    const onIce = pointer.inside && v > POINTER_FAR && v < FIELD_FV;
    if (pointer.pressed && onIce) {
      this.#pressing = true;
      this.#pressU = u;
      this.#pressV = v;
      this.#lastU = u;
      this.#lastV = v;
      this.#moved = 0;
    }
    if (this.#pressing && pointer.down && onIce) {
      this.#moved = Math.max(this.#moved, Math.hypot(u - this.#pressU, v - this.#pressV));
      if (this.#moved > KNOCK_MOVE) {
        const z0 = CAMERA.groundDepth(this.#lastV);
        const z1 = CAMERA.groundDepth(v);
        this.#snow.sweep(CAMERA.worldX(this.#lastU, z0), z0, CAMERA.worldX(u, z1), z1);
      }
      this.#lastU = u;
      this.#lastV = v;
    }
    if (this.#pressing && (pointer.released || !pointer.down)) {
      this.#pressing = false;
      if (this.#moved <= KNOCK_MOVE) {
        const z = CAMERA.groundDepth(this.#pressV);
        this.#knock(CAMERA.worldX(this.#pressU, z), z);
      }
    }
  }

  // ---- The aurora ----

  #auroraStep(dt: number, mdt: number, frequency: number): void {
    if (frequency <= 0) this.#nextStorm = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.#nextStorm)) this.#nextStorm = this.#clock + SUBSTORM_FIRST * (0.8 + 0.4 * this.#storms.next());
    if (this.#clock >= this.#nextStorm) {
      this.#stormAge = 0;
      this.#nextStorm = this.#clock + SUBSTORM_RARE * Math.pow(SUBSTORM_OFTEN / SUBSTORM_RARE, frequency) * (0.6 + 0.8 * this.#storms.next());
    }
    this.#stormAge += dt;
    const a = this.#stormAge;
    const breakup = smoothstep(0, BREAKUP, a) * (a < ACTIVE ? 1 : Math.exp(-(a - ACTIVE) / RECOVERY));
    const growth = Number.isFinite(this.#nextStorm) ? GROWTH_SHARE * smoothstep(GROWTH, 0, this.#nextStorm - this.#clock) : 0;
    const target = Math.max(breakup, growth);
    this.#surge += (target - this.#surge) * (1 - Math.exp(-dt / SURGE_EASE));
    this.#auroraClock += mdt * (1 + PACE_SURGE * this.#surge);
  }

  // ---- Upload ----

  #upload(): void {
    const field = this.#field;
    field.flush();
    if ((field.rect[2] ?? 0) > 0) {
      uploadRect(this.#gl, this.#nearTexture.texture, field.near, field.rect);
      uploadRect(this.#gl, this.#idTexture.texture, field.ids, field.rect);
    }

    const state = this.#state;
    for (let id = 0; id < CRACK_SLOTS; id++) {
      const crack = this.#byId[id];
      const o = id * 4;
      if (!crack?.singing) {
        state[o] = 1;
        state[o + 1] = 0;
        state[o + 2] = 1;
        state[o + 3] = 0;
        continue;
      }
      const length = Math.max(crack.length, 1e-6);
      state[o] = crack.delay > 0 ? 0 : Math.min(crack.front / length, 1);
      state[o + 1] = crack.delay > 0 ? 0 : crack.front < crack.length ? 1 : Math.exp(-crack.since / crack.fade);
      state[o + 2] = GLOW_REACH / length;
      state[o + 3] = 0;
    }
    const g = CRACK_SLOTS * 4;
    state[g] = GAIN_QUIET + GAIN_SURGE * this.#surge;
    splitClock(this.#auroraClock, state, g + 1);
    state[g + 3] = this.#surge;
    splitClock(this.#windOffset, state, g + 4);
    state[g + 6] = this.#wind;
    state[g + 7] = 0;
    this.#stateTexture.upload(state);

    this.#snow.pack();
    this.#snowTexture.upload(this.#snow.data);
  }
}

/** The frozen lake's simulation for a scene whose knobs are `params` (looked up by key). */
export function lakeSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new FrozenLake(gl, params);
}
