// The hillside's living specks: dozens of bees working three hives and a handful of butterflies, flying
// in the garden's own three-dimensional space and drawn at the size and place that space projects to.
//
// The world. The garden is a ground plane seen through CAMERA (a LevelCamera, sims/camera.ts): the eye
// BEES_CAM metres above it, its horizon at uv height BEES_YH and a focal length of one screen height. A
// world point (X, Z, H) (metres: right, away from the viewer, above the ground) therefore lies at
// screen (x, y) = (X / Z, BEES_YH - (BEES_CAM - H) / Z) in screen heights from the middle of the view:
// the ground at depth Z is at BEES_YH - BEES_CAM / Z, and a metre there is 1 / Z screen heights, the
// shader's own ground mapping (beesS). Hives, flower drifts and the blossom in the orchard's crowns
// are laid out on screen as fractions of the stage half width (shader.ts paints them there) and
// converted to world targets through CAMERA, so a bee lands exactly on the landing board it is drawn
// next to and hovers at the height of the flowers it works.
//
// Size. A worker is BEE_LENGTH long and a butterfly BUTTERFLY_SPAN across, so at the hives' distance a
// bee is about one dither cell, and fewer the farther off: far traffic is one cell of a fainter dark,
// a bee within a few metres of the lens two or three with a glint of wing. There is no other scale.
// The map (SpeckMap, sims/specks.ts) carries, with each cell's code, the depth of what it draws
// (BEES_DEPTH_STEP bytes per metre) so the shader can hide a bee behind the wall, a tree or a hive.
// Where two insects fall in one cell the nearer one is drawn, whichever was plotted first: the shader
// sees one depth per cell, so a farther insect hidden behind a hive must not take the cell of a
// nearer one flying in front of it.
//
// Bees (a small state machine each, stepped at a fixed 1/60 s):
//   inside   in the hive, waiting its turn;
//   mill     at the entrance: walking on the landing board or hovering before the slot, a small crowd;
//   orient   a young bee's orientation flight: slow loops in front of its hive, learning the place;
//   out      a forager's nearly straight, slightly wobbly beeline to a flower patch (now and then via a
//            pass close to the lens);
//   forage   hopping zig-zag from flower to flower in the patch, resting a moment on each, loading up
//            with pollen;
//   home     the beeline back to the landing board;
//   land     alighting on the board for a moment, then in or among the crowd.
// Butterflies: an erratic, lazy flutter above the flowers with bursts of wingbeats and glides, bobbing
// on every beat, now and then settling on a flower where the wings slowly open and close.
//
// A thing is drawn in the cell its projection falls in, and only changes cell once it has clearly left
// it (hysteresis, followCell), so a hovering bee never flickers between two. It is drawn between its
// last two steps by the clock's alpha, so the traffic moves as smoothly at 144 Hz as at 60.
//
// Passage (BEES_PASSAGE). An entrance skips the pre-run: the colony starts asleep and nearly every bee
// comes out of its hive within the first two seconds and flies at once for its flowers (a little hurried,
// easing to the usual pace), while the butterflies fly in over the edges of the screen. An exit sends the
// foragers home at speed, files the crowd at the entrances in, keeps everyone inside and has the
// butterflies bolt for the nearest edge. At rest none of it applies and the random draws are unchanged.
//
// Texture:
//   uSim0  rg8, one texel per dither cell (rows bottom to top, the shader's `cell`): R a BEES_CODE value
//          (0 nothing), G the depth of what is drawn there in BEES_DEPTH_STEP-ths of a metre.
import { KnobReader, type ParamDef } from "../../params.ts";
import { LevelCamera } from "../../sims/camera.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { followCell, SpeckMap } from "../../sims/specks.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

/** Horizon of the garden plane (uv height), the eye's height above it (m) and the narrowest stage half width. */
export const BEES_YH = 0.47;
export const BEES_CAM = 1.6;
export const BEES_STAGE_MIN = 0.62;
export const BEES_MAX_BEES = 64;
export const BEES_MAX_BUTTERFLIES = 6;
/** Bytes of depth per metre in the map's second channel. */
export const BEES_DEPTH_STEP = 4;
/** The garden's eye: everything flies in the world and is drawn where this projects it. */
const CAMERA = new LevelCamera({ horizon: BEES_YH, eye: BEES_CAM, focal: 1 });

/** Seconds the scene's entrance and its exit take (SceneDef.passage; the shader reads the same). */
export const BEES_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Half the width of the stage, screen heights: fractions `f` below are of this. */
export function beesStage(aspect: number): number {
  return Math.max(0.5 * aspect, BEES_STAGE_MIN);
}

/** A box hive on its stand, metres: stand height, one box, boxes, roof, width, slot height, board thickness. */
export const BEES_HIVE = {
  stand: 0.3,
  box: 0.3,
  boxes: 2,
  roof: 0.1,
  width: 0.52,
  slot: 0.04,
  board: 0.02,
} as const;
/** Half the landing board's width, metres. */
export const BEES_BOARD_HALF = 0.17;
/** Hives are built this many times larger than the metres above, so the entrances read. */
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
/** Apple blossom in the orchard's crowns, and a meadow on the hill beyond the wall: flowers the foragers fly up to (the shader paints them as part of the trees and the hill). */
export const BEES_BLOSSOM = 5;
export const BEES_HILL = 6;

export interface BeesPatch {
  f: number;
  y: number;
  /** Radii: a fraction of the stage half width, and uv height. */
  rx: number;
  ry: number;
  kind: number;
  /** How often a forager (or butterfly, for the first BEES_GROUND_PATCHES) picks it. */
  weight: number;
  /** Height of the flower heads above the ground (m) for a drift on the ground. */
  top: number;
  /**
   * For flowers in the air (a crown, a hill): the uv y of the ground they stand over, which sets their
   * depth; the ellipse's y is then where they are on screen, and their height follows from the two.
   */
  footY?: number;
}

/** The first this many patches are drifts on the garden's ground; butterflies keep to them. */
export const BEES_GROUND_PATCHES = 5;

export const BEES_PATCHES: readonly BeesPatch[] = [
  { f: -0.62, y: 0.17, rx: 0.32, ry: 0.1, kind: BEES_LAVENDER, weight: 0.3, top: 0.32 },
  { f: 0.6, y: 0.15, rx: 0.32, ry: 0.09, kind: BEES_POPPY, weight: 0.2, top: 0.5 },
  { f: 0.0, y: 0.095, rx: 0.26, ry: 0.06, kind: BEES_DAISY, weight: 0.12, top: 0.3 },
  { f: -0.55, y: 0.348, rx: 0.4, ry: 0.022, kind: BEES_WILD, weight: 0.06, top: 0.3 },
  { f: 0.72, y: 0.285, rx: 0.22, ry: 0.05, kind: BEES_COSMOS, weight: 0.08, top: 0.6 },
  { f: -0.22, y: 0.56, rx: 0.12, ry: 0.045, kind: BEES_BLOSSOM, weight: 0.1, top: 0, footY: 0.378 },
  { f: 0.2, y: 0.54, rx: 0.1, ry: 0.04, kind: BEES_BLOSSOM, weight: 0.08, top: 0, footY: 0.378 },
  { f: 0.45, y: 0.47, rx: 0.3, ry: 0.025, kind: BEES_HILL, weight: 0.08, top: 0, footY: 0.4 },
];

/** What a texel of uSim0's red channel means (the byte value; 0 is nothing). */
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
  /** A bee a little farther off, and one far off: a fainter dark. */
  beeDim: 11,
  beeFaint: 12,
} as const;

const BUTTERFLY_OPEN = [BEES_CODE.orange, BEES_CODE.white, BEES_CODE.blue] as const;
const BUTTERFLY_SHUT = [BEES_CODE.orangeDim, BEES_CODE.whiteDim, BEES_CODE.blueDim] as const;

const STEP = 1 / 60;
const MAX_STEPS = 6;
/** Seconds pre-run so the page opens with the colony at work. */
const WARM_STEPS = 30 * 60;

// Sizes (m).
const BEE_LENGTH = 0.015;
const BUTTERFLY_SPAN = 0.05;

// Bees (m and m/s). Speeds are scaled by depth (see `pace`) so on screen they read the same near and far.
const CRUISE = 0.9;
const HOP = 0.55;
const MILL_SPEED = 0.15;
const ARRIVE = 0.07;
const ORIENT_RATE = 0.85;
/** Share of foragers that fly a pass close to the lens on their way out, and where (m). */
const PASS_SHARE = 0.12;
const PASS_Z_MIN = 1.8;
const PASS_Z_MAX = 3.2;

// Butterflies.
const BUTTERFLY_SPEED = 0.45;
const BUTTERFLY_GLIDE_SPEED = 0.2;

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
  /** World position (m): right, depth away from the viewer, height above the ground; and velocity. */
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  vh: number;
  tx: number;
  tz: number;
  th: number;
  patch: number;
  visits: number;
  load: number;
  phase: number;
  pace: number;
  newbie: boolean;
  resting: boolean;
  fly: boolean;
  /** On its way out it first flies a pass close to the lens. */
  via: boolean;
  /** Its first time out of the hive (an entrance): straight for the flowers. */
  pour: boolean;
  /** Where it is drawn: cell, hysteretic (NaN: not yet placed). */
  cx: number;
  cy: number;
  /** World position one step before (drawn between it and x, z, h). */
  px: number;
  pz: number;
  ph: number;
}

type ButterflyMode = "fly" | "approach" | "settle";

interface Butterfly {
  active: boolean;
  kind: number;
  mode: ButterflyMode;
  t: number;
  hold: number;
  x: number;
  z: number;
  h: number;
  vx: number;
  vz: number;
  vh: number;
  tx: number;
  tz: number;
  th: number;
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
  /** World position one step before (drawn between it and x, z, h). */
  px: number;
  pz: number;
  ph: number;
}

function newBee(hive: number): Bee {
  return {
    hive,
    mode: "inside",
    hold: 0,
    t: 0,
    age: 0,
    x: 0,
    z: 10,
    h: 0,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 10,
    th: 0,
    patch: 0,
    visits: 0,
    load: 0,
    phase: 0,
    pace: 1,
    newbie: false,
    resting: false,
    fly: false,
    via: false,
    pour: false,
    cx: Number.NaN,
    cy: Number.NaN,
    px: 0,
    pz: 10,
    ph: 0,
  };
}

function newButterfly(kind: number): Butterfly {
  return {
    active: false,
    kind,
    mode: "fly",
    t: 0,
    hold: 0,
    x: 0,
    z: 8,
    h: 1,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 8,
    th: 1,
    patch: 0,
    flap: 0,
    pace: 1,
    glide: 0,
    glideLeft: 2,
    gliding: false,
    wayLeft: 3,
    open: 1,
    openStart: 1,
    age: 0,
    phase: 0,
    quiet: 0,
    cx: Number.NaN,
    cy: Number.NaN,
    px: 0,
    pz: 8,
    ph: 1,
  };
}

/** Draw a bee or butterfly from where it is now, as if it had been there a step ago too. */
function settle(thing: {
  x: number;
  z: number;
  h: number;
  px: number;
  pz: number;
  ph: number;
}): void {
  thing.px = thing.x;
  thing.pz = thing.z;
  thing.ph = thing.h;
}

/** How fast a thing at depth z moves, as a share of its nominal speed: the same on screen near and far. */
function depthPace(z: number): number {
  return clamp(z / 8, 0.45, 1.3);
}

const PATCH_WEIGHTS: readonly number[] = BEES_PATCHES.map((patch) => patch.weight);
const PATCH_WEIGHT_TOTAL = PATCH_WEIGHTS.reduce((sum, w) => sum + w, 0);
const GROUND_WEIGHT_TOTAL = PATCH_WEIGHTS.slice(0, BEES_GROUND_PATCHES).reduce(
  (sum, w) => sum + w,
  0,
);

class BeesSim implements SceneSim {
  readonly #knobs: KnobReader<BeesKnob>;
  readonly #texture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #random = new Random(0x5eed);
  readonly #bees: Bee[] = Array.from({ length: BEES_MAX_BEES }, (_, i) =>
    newBee(i % BEES_HIVES.length),
  );
  readonly #butterflies: Butterfly[] = Array.from({ length: BEES_MAX_BUTTERFLIES }, (_, i) =>
    newButterfly(i % 3),
  );
  /** The hive last asked about: world position of its entrance, its landing board and how wide it is. */
  readonly #geo = { x: 0, z: 0, landZ: 0, landH: 0, half: 0 };
  readonly #pt = { x: 0, z: 0, h: 0 };
  readonly #pc = { ex: 0, ey: 0 };
  readonly #specks = new SpeckMap();
  #stage = BEES_STAGE_MIN;
  #beeCount = 0;
  #butterflyCount = 0;
  #warm = false;
  #dirty = true;
  #born = false;
  /** The sim's first frame fell inside an entrance: the colony opens asleep and pours out of the hives, the butterflies come in from the edges. */
  #arriving = false;
  /** The scene is leaving: the foragers fly home, the butterflies bolt for the edge of the frame and nobody comes out. */
  #leaving = false;
  #aspect = 1;
  /** Speed multipliers (bees on their way out and home, butterflies): 1 at rest, more while the scene arrives or leaves. */
  #rush = 1;
  #flit = 1;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<BeesKnob>("bees", params, ["bees", "butterflies"]);
    this.#texture = new DataTexture(gl, { width: 1, height: 1, format: "rg8", filter: "nearest" });
    this.#specks.resize(1, 1);
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#beeCount = clamp(Math.round(knobs.value(frame, "bees")), 0, BEES_MAX_BEES);
    this.#butterflyCount = clamp(
      Math.round(knobs.value(frame, "butterflies")),
      0,
      BEES_MAX_BUTTERFLIES,
    );
    const width = Math.max(1, Math.round(frame.width));
    const height = Math.max(1, Math.round(frame.height));
    if (width !== this.#specks.width || height !== this.#specks.height) {
      this.#specks.resize(width, height);
      this.#texture.resize(width, height);
      for (const bee of this.#bees) bee.cx = Number.NaN;
      for (const butterfly of this.#butterflies) butterfly.cx = Number.NaN;
      this.#dirty = true;
    }
    const aspect = frame.aspect > 0 ? frame.aspect : width / height;
    this.#aspect = aspect;
    this.#setStage(beesStage(aspect));
    this.#passage(frame);
    this.#wake();
    if (!this.#warm) {
      // An entrance skips the pre-run: the colony is to be seen coming out of its hives.
      if (!this.#arriving) for (let i = 0; i < WARM_STEPS; i++) this.#step(STEP);
      this.#warm = true;
    }
    this.#arriving = false;
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) this.#step(STEP);
    // Drawn between the last two steps, so every frame that moves the clock repaints.
    if (advance > 0 || this.#dirty) {
      this.#paint(this.#clock.alpha);
      // Only the tiles whose cells changed go up (the whole map after a resize): a few KB a frame.
      this.#specks.upload(this.#texture);
      this.#dirty = false;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** A new stage width (the frame's aspect changed): the layout widens, so every X (which scales with it) follows. */
  #setStage(stage: number): void {
    if (Math.abs(stage - this.#stage) < 1e-5) return;
    const ratio = stage / this.#stage;
    this.#stage = stage;
    for (const bee of this.#bees) {
      bee.x *= ratio;
      bee.px *= ratio;
      bee.tx *= ratio;
    }
    for (const butterfly of this.#butterflies) {
      butterfly.x *= ratio;
      butterfly.px *= ratio;
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
        g.z = rand.range(4.5, 10);
        // Arriving, they come in over the very edge of the screen, not of the stage.
        const edge = this.#arriving ? 0.5 * this.#aspect + 0.04 : this.#stage + 0.03;
        g.x = side * edge * g.z;
        g.h = rand.range(0.6, 1.5);
        g.vx = -side * 0.3;
        g.vz = 0;
        g.vh = 0;
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
        settle(g);
        this.#waypoint(g, false);
      } else if (!want) {
        g.active = false;
      }
    }
    if (!this.#warm) this.#seed();
  }

  /** The very first frame: bees start asleep inside at scattered times, butterflies in the air over the flowers. */
  #seed(): void {
    const rand = this.#random;
    for (const bee of this.#bees) {
      bee.mode = "inside";
      bee.hold = rand.range(0.5, 9);
      bee.newbie = rand.next() < 0.14;
      bee.pace = rand.range(0.9, 1.12);
      bee.phase = rand.next() * TAU;
      bee.patch = this.#pickPatch(false);
    }
    if (this.#arriving) {
      this.#pourOut();
      return;
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      this.#flowerPoint(this.#pickPatch(true));
      g.x = this.#pt.x;
      g.z = this.#pt.z;
      g.h = this.#pt.h + rand.range(0.3, 1.2);
      settle(g);
    }
  }

  // ---- places -------------------------------------------------------------------------------------

  #locate(hive: number): void {
    const def = BEES_HIVES[hive];
    if (def === undefined) throw new BeesSimError(`no hive ${hive}`);
    const g = this.#geo;
    g.z = CAMERA.groundDepth(BEES_YH - def.y);
    g.x = CAMERA.worldX(def.f * this.#stage, g.z);
    // The board is drawn at the hive's own depth; a bee on it stands a hair in front.
    g.landZ = g.z - 0.1;
    g.landH = (BEES_HIVE.stand + 0.004) * BEES_HIVE_SCALE;
    g.half = BEES_BOARD_HALF * BEES_HIVE_SCALE;
  }

  /** A patch by weight: any, or (for butterflies) only a drift on the ground. */
  #pickPatch(groundOnly: boolean): number {
    let pick = this.#random.next() * (groundOnly ? GROUND_WEIGHT_TOTAL : PATCH_WEIGHT_TOTAL);
    for (const [i, w] of PATCH_WEIGHTS.entries()) {
      if (groundOnly && i >= BEES_GROUND_PATCHES) break;
      pick -= w;
      if (pick <= 0) return i;
    }
    return 0;
  }

  /** The world point at (ex, ey) in patch `index`'s ellipse (unit disc), written to #pt. */
  #patchPoint(index: number, ex: number, ey: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const sx = (patch.f + ex * patch.rx) * this.#stage;
    const sy = patch.y + ey * patch.ry;
    const pt = this.#pt;
    if (patch.footY === undefined) {
      // On the ground: the point is the plant's foot at screen row sy, its head a little above it.
      pt.z = CAMERA.groundDepth(BEES_YH - sy);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = patch.top + 0.05 + 0.12 * this.#random.next();
    } else {
      pt.z = CAMERA.groundDepth(BEES_YH - patch.footY);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = CAMERA.worldY(sy, pt.z);
    }
  }

  /** Where a world point lies in patch `index`'s ellipse (unit disc), written to #pc. */
  #patchCoords(index: number, x: number, z: number, h: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const sx = CAMERA.screenX(x, z);
    const sy = CAMERA.screenY(patch.footY === undefined ? 0 : h, z);
    this.#pc.ex = (sx / this.#stage - patch.f) / patch.rx;
    this.#pc.ey = (sy - patch.y) / patch.ry;
  }

  /** A flower in patch `index`: uniform over most of its ellipse, written to #pt. */
  #flowerPoint(index: number): void {
    const rand = this.#random;
    const r = Math.sqrt(rand.next()) * 0.85;
    const a = rand.next() * TAU;
    this.#patchPoint(index, r * Math.cos(a), r * Math.sin(a));
  }

  // ---- the passage -------------------------------------------------------------------------------

  /** Where the scene stands in its entrance and exit: how hurried the traffic is, and the moment the exit begins. */
  #passage(frame: SimFrame): void {
    const enter = clamp(frame.passage.enter, 0, 1);
    const leave = clamp(frame.passage.exit, 0, 1);
    if (!this.#born) {
      this.#born = true;
      this.#arriving = enter < 1;
    }
    const leaving = leave > 0;
    if (leaving && !this.#leaving) this.#recall();
    this.#leaving = leaving;
    this.#rush = 1;
    this.#flit = 1;
    if (leaving) {
      this.#rush = 1 + 5 * smoothstep(0, 0.2, leave);
      this.#flit = 1 + 6 * smoothstep(0, 0.25, leave);
    } else if (enter < 1) {
      // Quick at first, easing back to their ordinary pace over the last of the entrance.
      this.#rush = 1 + 1.5 * (1 - smoothstep(0.7, 1, enter));
      this.#flit = 1 + 2 * (1 - smoothstep(0.5, 1, enter));
    }
  }

  /** An entrance opens on a colony yet to come out: nearly every bee leaves its hive within the first two seconds, young ones to loop before it. */
  #pourOut(): void {
    const rand = this.#random;
    for (const [i, bee] of this.#bees.entries()) {
      if (i >= this.#beeCount) continue;
      if (bee.newbie) {
        bee.hold = rand.range(0.6, 2.2);
      } else if (rand.next() < 0.85) {
        bee.pour = true;
        bee.hold = rand.range(0.3, 2.2);
      }
    }
  }

  /** The exit begins: foragers and young bees turn for their hive, the crowd at the entrances files in, the butterflies bolt for the nearest edge. */
  #recall(): void {
    const rand = this.#random;
    for (const bee of this.#bees) {
      if (bee.mode === "out" || bee.mode === "forage" || bee.mode === "orient") {
        this.#home(bee);
        bee.t = 1;
      } else if (bee.mode === "mill") {
        bee.hold = Math.min(bee.hold, rand.range(0.1, 0.9));
      }
    }
    const edge = 0.5 * this.#aspect + 0.4;
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      if (g.mode !== "fly") {
        g.mode = "fly";
        g.vh = 0.4;
      }
      g.gliding = false;
      g.glideLeft = 99;
      g.tz = clamp(g.z * 0.7, 3, 14);
      g.tx = (g.x < 0 ? -1 : 1) * edge * g.tz;
      g.th = g.h + 0.8;
    }
  }

  // ---- stepping -----------------------------------------------------------------------------------

  #step(dt: number): void {
    for (const [i, bee] of this.#bees.entries()) {
      settle(bee);
      this.#stepBee(bee, i, dt);
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      settle(g);
      this.#stepButterfly(g, dt);
    }
  }

  /**
   * Steer toward (tx, tz, th) at `speed` m/s: eased in over the first second, slowing as it arrives,
   * with a lateral weave of velocity `weave` (and a little vertical wobble). Returns the distance left.
   */
  #steer(b: Bee, speed: number, weave: number, dt: number): number {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const ux = dx / dist;
    const uz = dz / dist;
    const uh = dh / dist;
    const pace = depthPace(b.z);
    const go =
      speed *
      pace *
      b.pace *
      (0.12 + 0.88 * smoothstep(0, 0.7, dist)) *
      (0.25 + 0.75 * smoothstep(0, 0.9, b.t));
    const far = smoothstep(0.3, 1.4, dist);
    const lateral =
      weave *
      pace *
      (0.55 * Math.sin(TAU * 0.37 * b.age + b.phase) +
        0.25 * Math.sin(TAU * 1.3 * b.age + 2 * b.phase)) *
      far;
    const wobble = 0.3 * weave * pace * Math.sin(TAU * 0.53 * b.age + 1.7 * b.phase) * far;
    const flat = Math.hypot(ux, uz) + 1e-6;
    const k = 1 - Math.exp(-dt / 0.22);
    b.vx += (ux * go - (uz / flat) * lateral - b.vx) * k;
    b.vz += (uz * go + (ux / flat) * lateral - b.vz) * k;
    b.vh += (uh * go + wobble - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h = Math.max(0, b.h + b.vh * dt);
    return dist;
  }

  /** Follow a moving target closely (orientation loops): velocity toward it over `tau`. */
  #seek(b: Bee, tau: number, maxSpeed: number, dt: number): void {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const go = Math.min(maxSpeed, dist / tau);
    const k = 1 - Math.exp(-dt / 0.2);
    b.vx += ((dx / dist) * go - b.vx) * k;
    b.vz += ((dz / dist) * go - b.vz) * k;
    b.vh += ((dh / dist) * go - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h = Math.max(0, b.h + b.vh * dt);
  }

  #enter(b: Bee, i: number): void {
    const rand = this.#random;
    b.mode = "inside";
    b.hold = rand.range(1, 4);
    b.fly = false;
    b.load = 0;
    b.vx = 0;
    b.vz = 0;
    b.vh = 0;
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
    b.tz = g.landZ - (hover ? rand.range(0, 0.2) : 0);
    b.th = g.landH + (hover ? rand.range(0.03, 0.75) : 0);
    b.fly = hover;
    b.phase = rand.next() * TAU;
  }

  #depart(b: Bee): void {
    const rand = this.#random;
    if (rand.next() > 0.7) b.patch = this.#pickPatch(false);
    b.fly = true;
    b.resting = false;
    b.via = rand.next() < PASS_SHARE;
    if (b.via) {
      // A pass close to the lens: out toward the viewer, then on to the flowers.
      b.tz = rand.range(PASS_Z_MIN, PASS_Z_MAX);
      b.tx = rand.range(-0.7, 0.7) * this.#stage * b.tz;
      b.th = rand.range(0.6, 1.5);
    } else {
      this.#flowerPoint(b.patch);
      b.tx = this.#pt.x;
      b.tz = this.#pt.z;
      b.th = this.#pt.h;
    }
    this.#begin(b, "out", 0);
  }

  #home(b: Bee): void {
    const rand = this.#random;
    this.#locate(b.hive);
    const g = this.#geo;
    b.tx = g.x + rand.range(-0.8, 0.8) * g.half;
    b.tz = g.landZ;
    b.th = g.landH;
    b.fly = true;
    b.via = false;
    this.#begin(b, "home", 0);
  }

  #stepBee(b: Bee, i: number, dt: number): void {
    const rand = this.#random;
    b.age += dt;
    b.t += dt;
    switch (b.mode) {
      case "inside": {
        if (i >= this.#beeCount || this.#leaving) break;
        b.hold -= dt;
        if (b.hold > 0) break;
        this.#locate(b.hive);
        const g = this.#geo;
        b.x = g.x + rand.range(-0.7, 0.7) * g.half;
        b.z = g.landZ;
        b.h = g.landH;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        // Out of the hive: drawn from here, not from where it went in.
        settle(b);
        if (b.newbie) {
          this.#begin(b, "orient", rand.range(9, 16));
          b.fly = true;
          b.phase = rand.next() * TAU;
        } else if (b.pour) {
          b.pour = false;
          this.#depart(b);
          b.t = 0.6;
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
          if (this.#leaving) this.#enter(b, i);
          else if (!b.newbie && i < this.#beeCount && rand.next() < 0.6) this.#depart(b);
          else this.#enter(b, i);
        }
        break;
      }
      case "orient": {
        this.#locate(b.hive);
        const g = this.#geo;
        const a = ORIENT_RATE * b.t + b.phase;
        b.tx = g.x + 0.9 * BEES_HIVE_SCALE * Math.cos(a);
        b.tz = g.z - 0.9 + 0.7 * Math.sin(a);
        b.th = (BEES_HIVE.stand + 0.1) * BEES_HIVE_SCALE + 0.75 * (0.6 + 0.4 * Math.sin(2 * a));
        this.#seek(b, 0.5, 1.4, dt);
        b.hold -= dt;
        if (b.hold <= 0) {
          b.newbie = false;
          this.#home(b);
        }
        break;
      }
      case "out": {
        if (this.#steer(b, CRUISE * this.#rush, 0.3, dt) < ARRIVE * (b.via ? 4 : 1)) {
          if (b.via) {
            b.via = false;
            this.#flowerPoint(b.patch);
            b.tx = this.#pt.x;
            b.tz = this.#pt.z;
            b.th = this.#pt.h;
            b.t = 0.5;
            break;
          }
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
          b.vz *= Math.exp(-dt * 6);
          b.vh *= Math.exp(-dt * 6);
          if (b.hold > 0) break;
          if (b.visits <= 0) {
            this.#home(b);
            break;
          }
          this.#nextFlower(b);
          break;
        }
        if (this.#steer(b, HOP, 1.0, dt) < ARRIVE) {
          b.visits -= 1;
          b.load = Math.min(1, b.load + 0.22);
          b.resting = true;
          b.fly = false;
          b.hold = rand.range(0.5, 1.8);
        }
        break;
      }
      case "home": {
        if (this.#steer(b, CRUISE * this.#rush, 0.3, dt) < ARRIVE) {
          b.fly = false;
          this.#begin(b, "land", rand.range(0.5, 1.2));
        }
        break;
      }
      case "land": {
        b.hold -= dt;
        if (this.#leaving && b.hold > 0.15) b.hold = 0.15;
        const k = 1 - Math.exp(-dt * 5);
        b.x += (b.tx - b.x) * k;
        b.z += (b.tz - b.z) * k;
        b.h += (b.th - b.h) * k;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        if (b.hold <= 0) {
          if (!this.#leaving && rand.next() < 0.65) {
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
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const go = MILL_SPEED * b.pace * smoothstep(0, 0.2, dist);
    const k = 1 - Math.exp(-dt / 0.3);
    b.vx += ((dx / dist) * go - b.vx) * k;
    b.vz += ((dz / dist) * go - b.vz) * k;
    b.vh += ((dh / dist) * go - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h += b.vh * dt;
    return dist;
  }

  /** The next flower of a foraging bee: a short zig-zag hop within its patch, toward or away from the viewer as often as across. */
  #nextFlower(b: Bee): void {
    const rand = this.#random;
    const a = rand.next() * TAU;
    const r = rand.range(0.2, 0.55);
    this.#patchCoords(
      b.patch,
      b.x + Math.cos(a) * r,
      b.z + Math.sin(a) * r,
      b.h + (rand.next() - 0.5) * 0.15,
    );
    let ex = this.#pc.ex;
    let ey = this.#pc.ey;
    const e = Math.hypot(ex, ey);
    if (e > 0.9) {
      ex *= 0.9 / e;
      ey *= 0.9 / e;
    }
    this.#patchPoint(b.patch, ex, ey);
    b.tx = this.#pt.x;
    b.tz = this.#pt.z;
    b.th = this.#pt.h;
    b.phase = rand.next() * TAU;
    b.resting = false;
    b.fly = true;
    b.t = 0.5;
  }

  // ---- butterflies --------------------------------------------------------------------------------

  #waypoint(g: Butterfly, mayPerch: boolean): void {
    const rand = this.#random;
    g.wayLeft = rand.range(2.5, 5);
    if (mayPerch && g.quiet <= 0 && rand.next() < 0.45) {
      g.patch = this.#pickPatch(true);
      this.#flowerPoint(g.patch);
      g.tx = this.#pt.x;
      g.tz = this.#pt.z;
      g.th = this.#pt.h;
      g.mode = "approach";
      g.gliding = false;
      g.t = 0;
      return;
    }
    // Wander over the flowers, a metre or so above them.
    this.#flowerPoint(this.#pickPatch(true));
    g.tx = this.#pt.x + rand.range(-0.8, 0.8);
    g.tz = clamp(this.#pt.z + rand.range(-0.8, 0.8), 3, 13);
    g.th = clamp(this.#pt.h + rand.range(0.3, 1.3), 0.3, 2.4);
  }

  #stepButterfly(g: Butterfly, dt: number): void {
    g.age += dt;
    g.t += dt;
    const rand = this.#random;
    if (g.mode === "settle") {
      g.hold -= dt;
      g.vx *= Math.exp(-dt * 6);
      g.vz *= Math.exp(-dt * 6);
      g.vh *= Math.exp(-dt * 6);
      // The wings sit open and close again, slowly, with a pause at the top.
      const slow = 0.5 + 0.5 * Math.cos((TAU * g.t) / 6.5 + g.phase);
      const toward = smoothstep(0, 1.2, g.t);
      g.open = lerp(g.openStart, 0.08 + 0.92 * smoothstep(0.05, 0.75, slow), toward);
      if (g.hold <= 0) {
        g.mode = "fly";
        g.quiet = rand.range(10, 24);
        g.glide = 0;
        g.gliding = false;
        g.glideLeft = rand.range(2, 4);
        g.vh = 0.4;
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

    let dist = Math.hypot(g.tx - g.x, g.tz - g.z, g.th - g.h);
    let speed: number;
    if (g.mode === "fly") {
      g.wayLeft -= dt;
      if (!this.#leaving && (dist < 0.5 || g.wayLeft <= 0)) this.#waypoint(g, true);
      speed = lerp(BUTTERFLY_SPEED, BUTTERFLY_GLIDE_SPEED, g.glide);
    } else {
      speed = 0.3 * smoothstep(0, 0.8, dist) + 0.08;
    }
    speed *= this.#flit;
    const pace = depthPace(g.z);
    const dx = g.tx - g.x;
    const dz = g.tz - g.z;
    const dh = g.th - g.h;
    dist = Math.hypot(dx, dz, dh) + 1e-6;
    const ux = dx / dist;
    const uz = dz / dist;
    const uh = dh / dist;
    const flat = Math.hypot(ux, uz) + 1e-6;
    const meander =
      (0.5 * Math.sin(TAU * 0.31 * g.age + g.phase) +
        0.3 * Math.sin(TAU * 0.83 * g.age + 2.1 * g.phase)) *
      (g.mode === "approach" ? smoothstep(0.2, 1.2, dist) : 1);
    const k = 1 - Math.exp(-dt / (this.#leaving ? 0.3 : 0.55));
    g.vx += (ux * speed * pace - (uz / flat) * meander * pace - g.vx) * k;
    g.vz += (uz * speed * pace + (ux / flat) * meander * pace - g.vz) * k;
    g.vh += (uh * speed * pace - 0.1 * g.glide - g.vh) * k;
    // Every downstroke lifts the butterfly and every upstroke lets it fall: the bobbing flight.
    const bob = -0.8 * pace * Math.sin(g.flap) * (1 - g.glide);
    g.x += g.vx * dt;
    g.z = clamp(g.z + g.vz * dt, 2.8, 14);
    g.h = Math.max(0.2, g.h + (g.vh + bob) * dt);
    if (g.mode === "approach" && dist < ARRIVE + 0.05) {
      g.mode = "settle";
      g.t = 0;
      g.hold = rand.range(8, 15);
      g.openStart = g.open;
      g.phase = rand.next() * TAU;
    }
  }

  // ---- drawing into the cell map ------------------------------------------------------------------------

  /** Every insect into the cell map, `alpha` of the way from where it was a step ago to where it is. */
  #paint(alpha: number): void {
    const specks = this.#specks;
    specks.clear();
    const h = specks.height;
    const w = specks.width;
    for (const b of this.#bees) {
      if (b.mode === "inside") continue;
      const z = b.pz + (b.z - b.pz) * alpha;
      if (z < 0.8) continue;
      const x = b.px + (b.x - b.px) * alpha;
      const lift = b.ph + (b.h - b.ph) * alpha;
      // Its projection (the shader's own ground mapping) in cells, and its real size in cells there.
      b.cx = followCell(b.cx, CAMERA.screenX(x, z) * h + 0.5 * w);
      b.cy = followCell(b.cy, CAMERA.screenY(lift, z) * h);
      const depth = Math.min(255, Math.round(z * BEES_DEPTH_STEP));
      const n = (BEE_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(
          b.cx,
          b.cy,
          n >= 0.8 ? BEES_CODE.bee : n >= 0.5 ? BEES_CODE.beeDim : BEES_CODE.beeFaint,
          depth,
        );
        continue;
      }
      // Close to the lens: a dark body two or three cells long (two tall when very near), golden at the back with pollen, and a glint of wing above it in flight.
      const length = n < 3.2 ? 2 : 3;
      const tall = n < 3.2 ? 1 : 2;
      specks.block(b.cx, b.cy, length, tall, BEES_CODE.bee, depth);
      if (b.load > 0.5) specks.block(b.cx + length - 1, b.cy, 1, tall, BEES_CODE.beeLoaded, depth);
      if (b.fly) specks.block(b.cx, b.cy + tall, length - 1, 1, BEES_CODE.beeWing, depth);
    }
    for (const g of this.#butterflies) {
      if (!g.active) continue;
      const z = g.pz + (g.z - g.pz) * alpha;
      if (z < 0.8) continue;
      const x = g.px + (g.x - g.px) * alpha;
      const lift = g.ph + (g.h - g.ph) * alpha;
      g.cx = followCell(g.cx, CAMERA.screenX(x, z) * h + 0.5 * w);
      g.cy = followCell(g.cy, CAMERA.screenY(lift, z) * h);
      const depth = Math.min(255, Math.round(z * BEES_DEPTH_STEP));
      const open = BUTTERFLY_OPEN[g.kind] ?? BEES_CODE.orange;
      const shut = BUTTERFLY_SHUT[g.kind] ?? BEES_CODE.orangeDim;
      // The wingbeat is the size of the speck: its half span in cells decides how many cells each wing is.
      const half = (0.5 * (BUTTERFLY_SPAN * h) * CAMERA.focal) / z;
      if (half < 0.75) {
        specks.plot(g.cx, g.cy, g.open > 0.45 ? open : shut, depth);
      } else if (half < 1.5) {
        if (g.open > 0.62) {
          specks.plot(g.cx - 1, g.cy, open, depth);
          specks.plot(g.cx + 1, g.cy, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else {
          specks.plot(g.cx, g.cy, g.open > 0.3 ? open : shut, depth);
        }
      } else if (half < 2.5) {
        if (g.open > 0.62) {
          specks.block(g.cx - 2, g.cy, 2, 1, open, depth);
          specks.block(g.cx + 1, g.cy, 2, 1, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else if (g.open > 0.3) {
          specks.plot(g.cx - 1, g.cy, open, depth);
          specks.plot(g.cx + 1, g.cy, open, depth);
          specks.plot(g.cx, g.cy, BEES_CODE.butterflyBody, depth);
        } else {
          specks.block(g.cx, g.cy, 1, 2, shut, depth);
        }
      } else if (g.open > 0.62) {
        specks.block(g.cx - 2, g.cy, 2, 2, open, depth);
        specks.block(g.cx + 1, g.cy, 2, 2, open, depth);
        specks.block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody, depth);
      } else if (g.open > 0.3) {
        specks.block(g.cx - 1, g.cy, 1, 2, open, depth);
        specks.block(g.cx + 1, g.cy, 1, 2, open, depth);
        specks.block(g.cx, g.cy, 1, 2, BEES_CODE.butterflyBody, depth);
      } else {
        specks.block(g.cx, g.cy, 1, 2, shut, depth);
      }
    }
  }
}

/** The colony's simulation, for a scene whose `params` carry the knobs BeesKnob names. */
export function beesSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BeesSim(gl, params);
}
