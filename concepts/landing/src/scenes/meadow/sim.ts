// The meadow's layer sims (ADR 0062; the composer's LayerSim, src/composer/types.ts): the grass's
// near blades in the wind (GrassSim) and the dandelion clocks with the seeds the gusts carry off them
// (DandelionsSim).
//
// One gust field drives it all: the composer's (composer/gust.ts), meadow's own honami field
// promoted, a deterministic function of a point on the ground and the motion clock, mirrored line
// for line in the shader, so the waves of light the shader rolls across the field, the gusts that
// bow the near blades, rock the clocks and pull their seeds, and the air the seeds ride are one and
// the same wind. Each sim steps it at its own steps' moments (gustWind, gustAt), the 'now' gust's
// age lagging the frame's as each step does, the passage's front as the composer hands it over.
//
// Ground: x to the right, z away from the viewer (metres), the eye the rig's height above the ground
// looking level over the grass (LayerFrame.rig, at rest). Screen positions here are in screen
// heights from the bottom-left corner (x in 0..aspect, y in 0..1).
//
// Near grass (GrassSim): two layers of blades rooted below the frame, one per column `pitch` apart.
// Each column is a pair of damped springs (lean sideways, bow away from the viewer) pushed by the gust
// at its root and by the pointer's breath; the shader draws each blade with its column's bend. They
// are underdamped, so a blade overshoots a little and settles after each gust.
//
// Dandelion clocks (DandelionsSim): up to MAX_CLOCKS on long stalks (springs too), each head a sphere
// of SECTORS × SEEDS_PER_SECTOR seeds. Gusts and the breath pull seeds off one at a time, mostly from
// the downwind side, so a head goes lopsided before it goes bare; a click blows a handful off the
// nearest one. Rain, from the first drizzle, closes the heads and holds the seeds. A bare clock wilts
// and fades; a fresh one rises close by as a closed bud and opens. Seeds: at most MAX_SEEDS in the
// air, each a little parachute with drag, moving in the world and seen through the rig. It relaxes
// toward the air around it: a breeze and the gusts blowing along the gust direction, so it drifts
// across the view and away from it as one motion, gusts that lift it, slow eddies of its own, a gentle
// sink. Receding, it slows across the frame and closes in on the horizon, and it fades into the haze.
//
// The breath (Breath): the pointer over the page blows softly on whatever is near it; each sim
// follows it alike, frame by frame, as input does, so it parts the grass even with the motion at 0.
//
// Time runs in fixed steps of STEP on the shader's clock (the motion clock, uMotionTime), each step
// at its own moment on it, so the sims and the picture evaluate the gusts alike. The first frame
// pre-runs PREWARM seconds (a fixed count of steps, spread over frames only when one frame cannot
// hold them all; the blades only the last BLADE_PREWARM of them) up to the moment that frame began,
// where the live steps take over, so the page opens with seeds already in the air. Everything is
// drawn between its last two steps by the clock's alpha, so the meadow moves the same at 60 and 144
// Hz.
//
// Passage: the rig is lowered into the grass on arrival and rises above it on leaving
// (LayerFrame.lift, the preset's meadowDrop); the clocks and the seeds sit that much lower in the
// frame, nearer ones by more (focal length × lift / depth). Arriving, the passage's gust lifts the
// first seeds off; leaving, a burst of them goes with the strong one. At rest none of it is in effect.
//
// Data:
//   grass       record row 0, texel 0: the breath (uv x, uv y, strength, 0). Field 0: rg16f
//               columns×2, nearest: per column of near grass (row = layer) the lean and the bow.
//   dandelions  record rows 0–1: the seeds sorted by x (row 0: uv x, uv y, pappus radius in screen
//               heights, alpha; row 1: tilt, depth, squash, 0); row 2: texels 0–3 the uv bounding box
//               of each group of eight (min x, min y, max x, max y; inverted when empty). From row
//               SEED_ROWS, one row per clock: texel 0 root uv xy and head uv xy; texel 1 head radius
//               (screen heights), presence, open 0..1, fullness 0..1; texels 2–17 the share of seeds
//               left in each sector (r), sector k centred (k + 0.5) / 16 of a turn from +x,
//               anticlockwise; texel 2 also carries the clock's depth (g, m) and how closed it is (b).
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import {
  gustAt,
  gustWind,
  newGustWind,
  NO_PASSAGE_GUST,
  type GustField,
  type GustWind,
  type PassageGust,
} from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import type { LevelCamera } from "../../sims/camera.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { springStep, type Spring } from "../../sims/spring.ts";
import { DataTexture } from "../../sims/texture.ts";
import { MAX_CLOCKS, MEADOW_MOVE, MEADOW_PASSAGE } from "./constants.ts";

/** The pointer as a frame hands it over (the visitor's). */
type Pointer = LayerFrame["pointer"];

const TAU = Math.PI * 2;
/** Floats in a row of the records atlas. */
const ROW = ATLAS_WIDTH * 4;

// ---- the near grass (shared with shader.ts) -----------------------------------------------------

/** A layer of near grass. Lengths in screen heights (heights before the grass-height knob). */
export interface MeadowLayer {
  /** Depth, for the gust at its roots. */
  readonly z: number;
  /** Where the roots are, below the frame. */
  readonly root: number;
  /** One blade per column this wide. */
  readonly pitch: number;
  readonly hMin: number;
  readonly hMax: number;
  /** Half-width of a blade at its root. */
  readonly width: number;
  /** Length and half-width of the seed head on a flowering stalk. */
  readonly spike: number;
  readonly spikeWidth: number;
  /** Share of the edge density kept in the middle of the frame, which stays open onto the field. */
  readonly centre: number;
  /** Share of the edge height the blades keep in the middle of the frame. */
  readonly low: number;
  /** Share of flowering stalks with a seed head (the rest are leaf blades). */
  readonly stalks: number;
  /** Darker toward the viewer: the nearest grass stands in its own shade. */
  readonly shade: number;
}

export const MEADOW_LAYERS: readonly MeadowLayer[] = [
  // The nearest grass: wide dark blades and seed heads, tall at the sides where they rise past the
  // horizon, short along the bottom in the middle, so they frame the view without closing it.
  {
    z: 1.6,
    root: -0.06,
    pitch: 0.036,
    hMin: 0.16,
    hMax: 0.7,
    width: 0.012,
    spike: 0.06,
    spikeWidth: 0.008,
    centre: 0.6,
    low: 0.3,
    stalks: 0.3,
    shade: 0.65,
  },
  // A little further: mostly flowering grasses, their seed heads against the bright field.
  {
    z: 3,
    root: -0.03,
    pitch: 0.045,
    hMin: 0.12,
    hMax: 0.34,
    width: 0.006,
    spike: 0.045,
    spikeWidth: 0.0055,
    centre: 0.45,
    low: 0.6,
    stalks: 0.65,
    shade: 0.9,
  },
];

/** Grass height knob k scales every blade by MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN × k. */
export const MEADOW_HEIGHT_MIN = 0.45;
export const MEADOW_HEIGHT_SPAN = 1.1;
/** Largest lean (tip offset / (BEND_SHAPE × height)) and bow; a bow of 1 would fold the blade down by MEADOW_BOW of its height. */
export const MEADOW_LEAN_MAX = 0.55;
export const MEADOW_AWAY_MAX = 0.7;
export const MEADOW_BEND_SHAPE = 0.6;
export const MEADOW_BOW = 0.45;
/** How far a blade's centreline can stray from its root, per screen height above the roots. */
export const MEADOW_REACH =
  (MEADOW_BEND_SHAPE * MEADOW_LEAN_MAX) / (1 - MEADOW_BOW * MEADOW_AWAY_MAX);
/** Extra reach per layer: a leaning seed head and the blade's own width. */
export const MEADOW_LAYER_PAD: readonly number[] = MEADOW_LAYERS.map(
  (layer) =>
    layer.spike * (MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN) * 0.8 +
    layer.width * 1.5 +
    layer.spikeWidth,
);
/** Columns either side of the frame in the grass's field, enough for the tallest blades leaning their furthest. */
export const MEADOW_MARGIN =
  1 +
  Math.max(
    ...MEADOW_LAYERS.map((layer, l) => {
      const scale = MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN;
      const top = (layer.hMax + layer.spike) * scale;
      return Math.ceil((MEADOW_REACH * top + (MEADOW_LAYER_PAD[l] ?? 0)) / layer.pitch);
    }),
  );

// ---- clocks and seeds (shared with shader.ts) ---------------------------------------------------

export const SECTORS = 16;
export const MAX_SEEDS = 32;
export const SEED_GROUP = 8;
export const SEED_GROUPS = MAX_SEEDS / SEED_GROUP;
/** Rows of the dandelions' records the seeds take; the clocks' rows follow. */
export const SEED_ROWS = 3;
const SEEDS_PER_SECTOR = 4;
const CLOCK_SEEDS = SECTORS * SEEDS_PER_SECTOR;

// ---- the simulation's own tuning ----------------------------------------------------------------

/** Simulated seconds per step, and the most steps one frame may take (a hitch drops time). */
const STEP = 1 / 60;
const MAX_STEPS = 8;
/** Seconds pre-run before a meadow is first shown, and on a reseed (the blades only need the last few). */
const PREWARM = 16;
const BLADE_PREWARM = 3;
const PREWARM_STEPS = Math.round(PREWARM / STEP);
const BLADE_FROM = PREWARM_STEPS - Math.round(BLADE_PREWARM / STEP);
/**
 * The pre-run is a count of steps, never a duration, so the opening meadow does not depend on how
 * fast the machine is: this is only how long one frame may spend on the first meadow's (at least;
 * the frame's own budget raises it, to all of it under test) before the rest waits for the next
 * frame. A reseed's, with the old meadow still on screen, takes the frame's budget alone. Until it
 * is done the sim holds its clock and uploads nothing new.
 */
const PREWARM_BUDGET_MS = 90;
/** Seeds let go this much more readily while pre-running, so the page opens with some in the air. */
const PREWARM_DETACH = 3;

// Near grass springs.
/**
 * Natural frequencies (Hz) and damping ratio: a slow, heavy sway with a little overshoot. Kept slow
 * and small so a moving blade's edge crosses a dither cell at most once or twice a second.
 */
const BLADE_FREQ_MIN = 0.28;
const BLADE_FREQ_MAX = 0.5;
const BLADE_DAMPING = 0.45;
/** Lean and bow per unit of gust (along the wind's sideways and away components). */
const BLADE_BEND = 0.32;
const BLADE_BOW = 0.7;
/** The breeze's own slow sway, at no wind and added per unit of wind. */
const BLADE_FLUTTER = 0.01;
const BLADE_FLUTTER_WIND = 0.03;

// Dandelion clocks.
/** Where the clocks stand: share of the width, head height (uv), head radius (screen heights), depth. The first stands in the sky above the horizon, well clear of the low sun's glare (left of centre at golden hour) and of the mown M. */
const CLOCK_SLOTS: readonly { share: number; head: number; radius: number; z: number }[] = [
  { share: 0.52, head: 0.56, radius: 0.046, z: 3 },
  { share: 0.77, head: 0.37, radius: 0.04, z: 3.4 },
  { share: 0.16, head: 0.31, radius: 0.054, z: 2.4 },
  { share: 0.62, head: 0.27, radius: 0.034, z: 4 },
  { share: 0.45, head: 0.21, radius: 0.03, z: 4.6 },
];
/** Lifecycle (s): bud to open clock, appearing, fading when no longer wanted, standing bare, wilting, gone before the next. */
const OPEN_TIME = 10;
const APPEAR_TIME = 1.5;
const LEAVE_TIME = 2;
const BARE_HOLD = 10;
const WILT_TIME = 6;
const GONE_HOLD = 4;
/** How each slot starts: the share of its seeds left, and how far it has opened (below 0: still a closed bud). */
const CLOCK_START: readonly { fill: number; open: number }[] = [
  { fill: 0.92, open: 1 },
  { fill: 1, open: 0.45 - PREWARM / OPEN_TIME },
  { fill: 0.5, open: 1 },
  { fill: 0.8, open: 1 },
  { fill: 0.3, open: 1 },
];
/** Stalk roots, below the frame. */
const CLOCK_ROOT = -0.04;
/** A new clock's place, size and height wander this much from its slot. */
const CLOCK_JITTER_SHARE = 0.06;
const CLOCK_JITTER_HEAD = 0.05;
const CLOCK_JITTER_RADIUS = 0.2;
/** The stalks nod slowly and only a little: the heads' fine spokes must not slide across the cells. */
const CLOCK_FREQ = 0.35;
const CLOCK_DAMPING = 0.5;
const CLOCK_BEND = 0.16;
const CLOCK_BOW = 0.25;
const CLOCK_FLUTTER = 0.012;
/** A wilting stalk droops this far (bow) and leans downwind. */
const WILT_DROOP = 0.7;
const WILT_LEAN = 0.3;
/** A clock counts as bare with this many seeds left. */
const BARE_LEFT = 5;
/** Seeds let go per second in a lull, and in a gust (load between DETACH_FROM and DETACH_TO). */
const DETACH_CALM = 0.05;
const DETACH_GUST = 1.3;
const DETACH_FROM = 0.15;
const DETACH_TO = 0.85;
/** The sectors' shown fill follows the seeds left at this rate (/s), so a seed visibly pulls away. */
const FILL_EASE = 3;
/**
 * Rain closes the heads over CLOSE_TIME seconds and holds the seeds: the first drizzle closes them
 * this far, more with the amount; a closed head is this much smaller (and folded narrow in the shader).
 */
const CLOSE_DRIZZLE = 0.55;
const CLOSE_PER_RAIN = 0.6;
const CLOSE_SHARE = 0.35;
const CLOSE_TIME = 4;

// Seeds in the air (screen heights per second unless stated). The air's speeds are paces seen at
// SEED_REF_DEPTH; see there.
/** Pappus radius, metres; never drawn below this many cells across its radius. */
const SEED_RADIUS = 0.034;
const SEED_MIN_CELLS = 2.2;
/** Seconds for a seed to take up the speed of the air around it. */
const SEED_DRAG = 0.7;
/** Drift along the wind: the breeze (at no wind, added at full wind), and per unit of gust. */
const SEED_BREEZE = 0.035;
const SEED_BREEZE_WIND = 0.05;
const SEED_GUST = 0.2;
/** Climb per unit of gust, a warm afternoon's updraft, the settling speed (raised by rain). */
const SEED_LIFT = 0.085;
const SEED_THERMAL = 0.012;
const SEED_SINK = 0.02;
const SEED_RAIN_SINK = 3;
/** The seed's own eddies: speed, and their rates (rad/s). */
const SEED_EDDY = 0.02;
const SEED_EDDY_RATE = 0.45;
/**
 * The air moves every seed in the world, along the gust direction (across the view and away from
 * it), so drifting off and drifting away are one motion. Its speeds above are given as paces seen at
 * this depth: metres per screen height there are SEED_REF_DEPTH / the rig's focal.
 */
const SEED_REF_DEPTH = 3;
/** Life (s): at least, plus up to; fading out over the last FADE seconds. Depth over which seeds fade into the haze. */
const SEED_LIFE = 26;
const SEED_LIFE_SPAN = 18;
const SEED_FADE = 3;
const SEED_DEPTH_FADE_FROM = 9;
const SEED_DEPTH_FADE_TO = 14;
/** Tilt (rad) per unit of sideways speed, and how quickly it follows. */
const SEED_TILT = 1.6;
const SEED_TILT_TIME = 0.6;
/** Outward speed a seed leaves its head with. */
const SEED_POP = 0.02;
/** Seeds within this margin (screen heights) outside the frame are kept; beyond, let go. */
const SEED_MARGIN = 0.12;

// The breath: the pointer over the page blows softly on whatever is near it.
/** Radius (screen heights), strength at rest, the speed (screen heights/s) for a full breath, extra while held. */
const BREATH_RADIUS = 0.14;
const BREATH_REST = 0.35;
const BREATH_FULL_SPEED = 0.8;
const BREATH_HELD = 0.6;
/** Seconds to fade in and out, and to follow the pointer's speed. */
const BREATH_IN = 0.25;
const BREATH_OUT = 0.5;
const BREATH_FOLLOW = 0.2;
/** Lean and bow per unit of breath on grass and clocks; push on seeds; extra pull on a clock's seeds. */
const BREATH_BEND = 0.5;
const BREATH_BOW = 0.35;
const BREATH_CLOCK = 0.35;
const BREATH_SEED = 0.25;
const BREATH_DETACH = 0.6;

// A click: seeds blown off the nearest clock.
const CLICK_BURST = 7;
const CLICK_SPEED = 0.2;
const CLICK_LIFT = 0.05;
const CLICK_SHOVE = 1.2;

// The passage (MEADOW_MOVE and the gust's shape are the preset's, constants.ts).
/** Arriving, while the first gust sweeps: seeds come away this many times more readily, and are lifted (screen heights per second). */
const ENTRY_DETACH = 3;
const ENTRY_LIFT = 0.1;
/**
 * Leaving, a burst of seeds from every ripe clock: per clock per second, between these seconds of
 * the exit (ramped over 0.15 and 0.2 s), kicked downwind at this speed with a little lift; the air
 * pushes every seed along the wind and lifts it as the exit's gust passes.
 */
const EXIT_BURST = 12;
const EXIT_BURST_FROM = 0.1;
const EXIT_BURST_TO = 1.1;
const EXIT_KICK = 0.45;
const EXIT_KICK_LIFT = 0.08;
const EXIT_PUSH = 0.9;
const EXIT_LIFT = 0.12;

export class MeadowSimError extends Error {}

/** A stable 0..1 per (a, b): a column's own sway, unchanged by resizes or re-seeding. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The 'now' gust's age at a step `lag` seconds before the frame's moment (negative while idle). */
function nowAgeAt(gusts: GustField, lag: number): number {
  return gusts.nowAge < 0 ? -1 : gusts.nowAge - lag;
}

/**
 * The pointer's breath: present over the page, stronger as it moves or while held, following it
 * frame by frame on the scene clock. Each sim follows it alike (see the header).
 */
class Breath {
  strength = 0;
  x = 0;
  y = 0;
  /** Unit direction away from the breath at the last `at` sample. */
  pushX = 0;
  pushY = 0;
  #presence = 0;
  #speed = 0;
  #lastX = 0;
  #lastY = 0;
  #hadPointer = false;

  /** Follow the pointer over a frame of `dt` seconds; false while the clock stands still. */
  follow(pointer: Pointer, dt: number, aspect: number): boolean {
    if (dt <= 0) return false;
    const x = pointer.x * aspect;
    const y = pointer.y;
    let speed = 0;
    if (pointer.inside && this.#hadPointer)
      speed = Math.hypot(x - this.#lastX, y - this.#lastY) / dt;
    this.#hadPointer = pointer.inside;
    this.#lastX = x;
    this.#lastY = y;
    this.#speed +=
      (Math.min(speed, 2 * BREATH_FULL_SPEED) - this.#speed) * (1 - Math.exp(-dt / BREATH_FOLLOW));
    this.#presence +=
      ((pointer.inside ? 1 : 0) - this.#presence) *
      (1 - Math.exp(-dt / (pointer.inside ? BREATH_IN : BREATH_OUT)));
    const target =
      this.#presence *
        (BREATH_REST + (1 - BREATH_REST) * Math.min(1, this.#speed / BREATH_FULL_SPEED)) +
      (pointer.inside && pointer.down ? BREATH_HELD : 0);
    this.strength += (target - this.strength) * (1 - Math.exp(-dt / BREATH_FOLLOW));
    if (pointer.inside) {
      this.x = x;
      this.y = y;
    }
    return true;
  }

  /** The breath's strength at (x, y); leaves the unit direction away from it in pushX, pushY. */
  at(x: number, y: number): number {
    this.pushX = 0;
    this.pushY = 0;
    if (this.strength <= 0.001) return 0;
    const dx = x - this.x;
    const dy = y - this.y;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2) + 1e-4;
    this.pushX = dx / d;
    this.pushY = dy / d;
    return this.strength * Math.exp(-d2 / (BREATH_RADIUS * BREATH_RADIUS));
  }
}

/**
 * The pre-run both sims share in shape (see the header): PREWARM_STEPS steps ending at the moment
 * the frame it starts in began, over as many frames as the budget needs; `from` the first step a sim
 * takes of them.
 */
class Prewarm {
  done = false;
  #next = 0;
  #clock = Number.NaN;
  readonly #from: number;

  constructor(from: number) {
    this.#from = from;
    this.#next = from;
  }

  restart(): void {
    this.done = false;
    this.#next = this.#from;
    this.#clock = Number.NaN;
  }

  /** Run the steps this frame's budget holds; true once all are done. */
  run(frame: LayerFrame, shown: boolean, step: (tm: number) => void): boolean {
    if (this.done) return true;
    const motion = Math.max(0, frame.motion);
    if (Number.isNaN(this.#clock)) this.#clock = frame.motionTime - Math.max(0, frame.dt) * motion;
    const clock = this.#clock;
    this.#next = runBudgeted(
      (k) => step(clock - (PREWARM_STEPS - 1 - k) * STEP),
      shown ? frame.budget : Math.max(PREWARM_BUDGET_MS, frame.budget),
      PREWARM_STEPS,
      this.#next,
      32,
    );
    this.done = this.#next >= PREWARM_STEPS;
    return this.done;
  }
}

interface Blade {
  lean: Spring;
  bow: Spring;
  /** Lean and bow a step before: drawn between them and the springs'. */
  leanWas: number;
  bowWas: number;
  omega: number;
  phase: number;
}

/** The grass's near blades (see the header): its record (the breath) and field 0 (the columns' bend). */
class GrassSim implements LayerSim {
  readonly #knobs: KnobReader<"seed">;
  readonly #texture: DataTexture;
  #data = new Float32Array(2 * 2);
  #width = 1;
  readonly #blades: Blade[][] = MEADOW_LAYERS.map(() => []);
  readonly #breath = new Breath();
  readonly #wind: GustWind = newGustWind();
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #warm = new Prewarm(BLADE_FROM);
  #camera: LevelCamera | undefined;
  #aspect = 16 / 9;
  #arrangement = Number.NaN;
  #shown = false;
  #dirty = true;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("meadow grass", params, ["seed"]);
    this.#texture = new DataTexture(gl, {
      width: 1,
      height: 2,
      format: "rg16f",
      filter: "nearest",
    });
  }

  frame(frame: LayerFrame): void {
    this.#camera = frame.rig;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#fit();
    const arrangement = Math.round(this.#knobs.value(frame, "seed"));
    if (arrangement !== this.#arrangement) this.#reset(arrangement);
    const gusts = frame.gusts;
    const field = frame.fields[0];
    if (field) field.texture = this.#texture.texture;
    if (!this.#warm.run(frame, this.#shown, (tm) => this.#step(tm, -1, NO_PASSAGE_GUST, gusts)))
      return;
    if (this.#breath.follow(frame.pointer, frame.dt, this.#aspect)) this.#dirty = true;
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) {
      const lag = this.#clock.lag(i);
      this.#step(frame.motionTime - lag, nowAgeAt(gusts, lag), gusts.pass, gusts);
    }
    if (advance > 0 || this.#dirty) {
      this.#pack(this.#clock.alpha, frame);
      this.#texture.upload(this.#data);
      this.#dirty = false;
      this.#shown = true;
    }
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** Columns of near grass for the frame's width (the margins cover blades leaning in from outside). */
  #fit(): void {
    let width = 1;
    MEADOW_LAYERS.forEach((layer, l) => {
      const columns = Math.ceil(this.#aspect / layer.pitch) + 2 * MEADOW_MARGIN;
      width = Math.max(width, columns);
      const blades = this.#blades[l];
      if (!blades || blades.length === columns) return;
      blades.length = 0;
      for (let j = 0; j < columns; j++) {
        const column = j - MEADOW_MARGIN;
        const omega =
          TAU * (BLADE_FREQ_MIN + (BLADE_FREQ_MAX - BLADE_FREQ_MIN) * hash01(column, l));
        blades.push({
          lean: { x: 0, v: 0 },
          bow: { x: 0, v: 0 },
          leanWas: 0,
          bowWas: 0,
          omega,
          phase: TAU * hash01(column, l + 17),
        });
      }
      this.#dirty = true;
    });
    if (width !== this.#width) {
      this.#width = width;
      this.#data = new Float32Array(width * MEADOW_LAYERS.length * 2);
      this.#texture.resize(width, MEADOW_LAYERS.length);
      this.#dirty = true;
    }
  }

  /** A fresh meadow for this arrangement: every blade at rest, the pre-run to run again. */
  #reset(arrangement: number): void {
    this.#arrangement = arrangement;
    for (const blades of this.#blades)
      for (const blade of blades) {
        blade.lean.x = 0;
        blade.lean.v = 0;
        blade.bow.x = 0;
        blade.bow.v = 0;
        blade.leanWas = 0;
        blade.bowWas = 0;
      }
    this.#clock.reset();
    this.#warm.restart();
    this.#dirty = true;
  }

  #step(tm: number, nowAge: number, pass: Readonly<PassageGust>, gusts: GustField): void {
    const camera = this.#camera;
    if (!camera) return;
    const wind = gustWind(
      this.#wind,
      gusts.wind,
      gusts.gusts,
      gusts.rate,
      nowAge,
      pass,
      gusts.shape,
    );
    const aspect = this.#aspect;
    const breath = this.#breath;
    const flutter = BLADE_FLUTTER + BLADE_FLUTTER_WIND * Math.abs(gusts.wind);
    MEADOW_LAYERS.forEach((layer, l) => {
      const blades = this.#blades[l];
      if (!blades) return;
      const breathY = layer.root + 0.3 * (layer.hMin + layer.hMax);
      blades.forEach((blade, j) => {
        const x = (j - MEADOW_MARGIN + 0.5) * layer.pitch;
        const g = gustAt(wind, camera.worldX(x - 0.5 * aspect, layer.z), layer.z, tm, 0);
        const push = breath.at(x, breathY);
        const sway = flutter * Math.sin(tm * blade.omega * 0.37 + blade.phase);
        blade.leanWas = blade.lean.x;
        blade.bowWas = blade.bow.x;
        springStep(
          blade.lean,
          clamp(
            wind.dirX * BLADE_BEND * g + sway + breath.pushX * push * BREATH_BEND,
            -MEADOW_LEAN_MAX,
            MEADOW_LEAN_MAX,
          ),
          blade.omega,
          BLADE_DAMPING,
          STEP,
        );
        springStep(
          blade.bow,
          clamp(wind.dirZ * BLADE_BOW * g + push * BREATH_BOW, -0.2, MEADOW_AWAY_MAX),
          blade.omega,
          BLADE_DAMPING,
          STEP,
        );
      });
    });
  }

  /** The breath into its record and the columns' bend into its field, `alpha` of the way through the step. */
  #pack(alpha: number, frame: LayerFrame): void {
    const record = frame.records.data;
    record[0] = this.#breath.x / this.#aspect;
    record[1] = this.#breath.y;
    record[2] = this.#breath.strength;
    record[3] = 0;
    frame.records.touch();
    const width = this.#width;
    const blades = this.#data;
    blades.fill(0);
    this.#blades.forEach((layer, l) => {
      layer.forEach((blade, j) => {
        const o = (l * width + j) * 2;
        blades[o] = lerp(blade.leanWas, blade.lean.x, alpha);
        blades[o + 1] = lerp(blade.bowWas, blade.bow.x, alpha);
      });
    });
  }
}

type ClockPhase = "gone" | "opening" | "ripe" | "bare" | "wilting";

interface Clock {
  phase: ClockPhase;
  /** Seconds in the current phase. */
  timer: number;
  presence: number;
  /** Below 0 a closed bud, 0..1 opening, 1 open. */
  open: number;
  wilt: number;
  /** Root x as a share of the width, head height at rest (uv), head radius (screen heights), depth. */
  share: number;
  head: number;
  radius: number;
  z: number;
  /** Seeds left per sector, and the fill shown (easing after them). */
  counts: number[];
  shown: number[];
  lean: Spring;
  bow: Spring;
  phaseOffset: number;
  headX: number;
  headY: number;
  headVX: number;
  headVY: number;
  /** What is drawn of it as it stood a step before: drawn between that and now. */
  presenceWas: number;
  openWas: number;
  shownWas: number[];
  leanWas: number;
  bowWas: number;
}

interface Seed {
  live: boolean;
  /** World position (x right of the view's centre line, y above the ground, z away from the eye) and velocity, metres and per second. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Where it is drawn, between its last two steps: screen heights right of the frame's centre line (for sorting and packing). */
  sx: number;
  age: number;
  life: number;
  /** Pappus radius, metres. */
  size: number;
  /** The tuft turning over: phase and rate (rad, rad/s). */
  tumble: number;
  tumbleRate: number;
  /** Phase of its own eddies. */
  drift: number;
  tilt: number;
  /** Position, age, tumble and tilt a step before: drawn between them and now. */
  xWas: number;
  yWas: number;
  zWas: number;
  ageWas: number;
  tumbleWas: number;
  tiltWas: number;
}

function remaining(clock: Clock): number {
  let n = 0;
  for (const count of clock.counts) n += count;
  return n;
}

/** A seed as it stands becomes the step before: the next step is drawn from it. */
function keepSeed(seed: Seed): void {
  seed.xWas = seed.x;
  seed.yWas = seed.y;
  seed.zWas = seed.z;
  seed.ageWas = seed.age;
  seed.tumbleWas = seed.tumble;
  seed.tiltWas = seed.tilt;
}

const byX = (a: Seed, b: Seed): number => a.sx - b.sx;

type DandelionKnob = "dandelions" | "seed" | "rain";

/** The dandelion clocks and their seeds (see the header), into the dandelions' records. */
class DandelionsSim implements LayerSim {
  readonly #knobs: KnobReader<DandelionKnob>;
  readonly #random = new Random();
  readonly #wind: GustWind = newGustWind();
  readonly #breath = new Breath();
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #warm = new Prewarm(0);
  #camera: LevelCamera | undefined;
  /** Metres per screen height at SEED_REF_DEPTH through the rig: turns the air's paces into speeds. */
  #seedAir = 1;
  /** This frame's passage: how freely seeds come away (x), the burst rate per clock, the air's extra push and lift on seeds, and the rig's lift above rest. */
  #boost = 1;
  #burst = 0;
  #push = 0;
  #lift = 0;
  #drop = 0;
  readonly #clocks: Clock[] = Array.from({ length: MAX_CLOCKS }, (): Clock => ({
    phase: "gone",
    timer: GONE_HOLD,
    presence: 0,
    open: 0,
    wilt: 0,
    share: 0,
    head: 0,
    radius: 0,
    z: 1,
    counts: new Array<number>(SECTORS).fill(0),
    shown: new Array<number>(SECTORS).fill(0),
    lean: { x: 0, v: 0 },
    bow: { x: 0, v: 0 },
    phaseOffset: 0,
    headX: 0,
    headY: 0,
    headVX: 0,
    headVY: 0,
    presenceWas: 0,
    openWas: 0,
    shownWas: new Array<number>(SECTORS).fill(0),
    leanWas: 0,
    bowWas: 0,
  }));
  readonly #seeds: Seed[] = Array.from({ length: MAX_SEEDS }, (): Seed => ({
    live: false,
    x: 0,
    y: 0,
    z: 1,
    vx: 0,
    vy: 0,
    vz: 0,
    sx: 0,
    age: 0,
    life: 1,
    size: SEED_RADIUS,
    tumble: 0,
    tumbleRate: 0,
    drift: 0,
    tilt: 0,
    xWas: 0,
    yWas: 0,
    zWas: 1,
    ageWas: 0,
    tumbleWas: 0,
    tiltWas: 0,
  }));
  readonly #sorted: Seed[] = [];

  // Knobs, as of this frame.
  #windKnob = 0;
  #rain = 0;
  #count = 0;
  #arrangement = Number.NaN;

  #aspect = 16 / 9;
  #rows = 540;
  /** Whether a meadow has been uploaded: a reseed's pre-run then takes the frame's budget alone. */
  #shown = false;
  #dirty = true;
  /** How closed the heads are against the rain, 0..1, now and a step before. */
  #closed = 0;
  #closedWas = 0;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<DandelionKnob>("meadow dandelions", params, [
      "dandelions",
      "seed",
      "rain",
    ]);
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const gusts = frame.gusts;
    this.#camera = frame.rig;
    this.#seedAir = SEED_REF_DEPTH / frame.rig.focal;
    this.#windKnob = gusts.wind;
    this.#rain = knobs.value(frame, "rain");
    this.#count = Math.round(clamp(knobs.value(frame, "dandelions"), 0, MAX_CLOCKS));
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#rows = Math.max(1, frame.height);

    const arrangement = Math.round(knobs.value(frame, "seed"));
    if (arrangement !== this.#arrangement) this.#reset(arrangement);

    const enter = frame.passage.enter;
    const exit = frame.passage.exit;
    if (!this.#warm.done) {
      if (
        !this.#warm.run(frame, this.#shown, (tm) =>
          this.#step(tm, -1, PREWARM_DETACH, NO_PASSAGE_GUST, gusts),
        )
      )
        return;
      // Arriving, the sky starts clear of the pre-run's seeds: the first gust lifts the first ones.
      if (enter < 1) for (const seed of this.#seeds) seed.live = false;
    }

    this.#choreograph(enter, exit, gusts.pass, frame.lift);
    if (this.#breath.follow(frame.pointer, frame.dt, this.#aspect)) this.#dirty = true;
    if (frame.pointer.pressed && frame.pointer.inside) this.#blowNearest(frame.pointer);

    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) {
      const lag = this.#clock.lag(i);
      this.#step(frame.motionTime - lag, nowAgeAt(gusts, lag), this.#boost, gusts.pass, gusts);
    }

    // Drawn between the last two steps, so every frame that moves the clock repaints.
    if (advance > 0 || this.#dirty) {
      this.#pack(this.#clock.alpha, frame.records.data);
      frame.records.touch();
      this.#dirty = false;
      this.#shown = true;
    }
  }

  // Records only: nothing of its own to release.
  dispose(): void {}

  /** A fresh meadow for this arrangement: clocks in their starting states, no seeds in the air. */
  #reset(arrangement: number): void {
    this.#arrangement = arrangement;
    this.#random.seed(Math.imul(arrangement + 1, 0x9e3779b1) ^ 0x6d2b79f5);
    for (const seed of this.#seeds) seed.live = false;
    const side = this.#windKnob < 0 ? -1 : 1;
    this.#clocks.forEach((clock, i) => {
      this.#regrow(clock, i);
      const start = CLOCK_START[i] ?? { fill: 1, open: 1 };
      if (i >= this.#count) {
        this.#vanish(clock);
        clock.timer = GONE_HOLD;
        return;
      }
      clock.presence = 1;
      clock.open = start.open;
      if (start.open >= 1) {
        clock.open = 1;
        clock.phase = "ripe";
        const gone = Math.round((1 - start.fill) * CLOCK_SEEDS);
        for (let n = 0; n < gone; n++) {
          const sector = this.#pickSector(clock, Math.atan2(0.35, side));
          if (sector < 0) break;
          clock.counts[sector] = (clock.counts[sector] ?? 1) - 1;
        }
        clock.counts.forEach((count, k) => {
          clock.shown[k] = count / SEEDS_PER_SECTOR;
        });
      }
    });
    for (const clock of this.#clocks) this.#keepClock(clock);
    // The pre-run ends where the frame it starts in began, and the live steps go on from there.
    this.#clock.reset();
    this.#warm.restart();
    this.#dirty = true;
  }

  /** This frame's part of the passage: the seeds' freedom, burst and lift, and the rig's height. */
  #choreograph(enter: number, exit: number, pass: Readonly<PassageGust>, lift: number): void {
    const leaving = exit > 0;
    const tout = exit * MEADOW_PASSAGE.exit;
    const sweep = enter < 1 && !leaving ? pass.amp / MEADOW_MOVE.gustInAmp : 0;
    const rise = smoothstep(0.05, 0.45, tout);
    this.#boost = 1 + ENTRY_DETACH * sweep;
    this.#burst = leaving
      ? EXIT_BURST *
        smoothstep(EXIT_BURST_FROM, EXIT_BURST_FROM + 0.15, tout) *
        (1 - smoothstep(EXIT_BURST_TO - 0.2, EXIT_BURST_TO, tout))
      : 0;
    this.#push = leaving ? EXIT_PUSH * rise : 0;
    this.#lift = leaving ? EXIT_LIFT * rise : ENTRY_LIFT * sweep;
    if (lift !== this.#drop) {
      this.#drop = lift;
      this.#dirty = true;
    }
  }

  #step(
    tm: number,
    nowAge: number,
    detachBoost: number,
    pass: Readonly<PassageGust>,
    gusts: GustField,
  ): void {
    const wind = gustWind(
      this.#wind,
      gusts.wind,
      gusts.gusts,
      gusts.rate,
      nowAge,
      pass,
      gusts.shape,
    );
    const closing = this.#rain > 0 ? Math.min(1, CLOSE_DRIZZLE + CLOSE_PER_RAIN * this.#rain) : 0;
    this.#closedWas = this.#closed;
    this.#closed += (closing - this.#closed) * (1 - Math.exp(-STEP / CLOSE_TIME));
    this.#stepClocks(tm, wind, detachBoost);
    this.#stepSeeds(tm, wind);
  }

  #stepClocks(tm: number, wind: GustWind, detachBoost: number): void {
    const camera = this.#camera;
    if (!camera) return;
    const aspect = this.#aspect;
    const breath = this.#breath;
    const side = wind.dirX < 0 ? -1 : 1;
    // Seeds leave from the downwind side of a head, a little above its equator.
    const downwind = Math.atan2(0.35, side);
    const omega = TAU * CLOCK_FREQ;
    const ease = 1 - Math.exp(-STEP * FILL_EASE);
    this.#clocks.forEach((clock, i) => {
      const wanted = i < this.#count;
      this.#keepClock(clock);
      this.#live(clock, i, wanted);
      if (clock.phase === "gone" && clock.presence <= 0) return;

      const g = gustAt(wind, camera.worldX(clock.headX - 0.5 * aspect, clock.z), clock.z, tm, 0);
      const push = breath.at(clock.headX, clock.headY);
      const sway = CLOCK_FLUTTER * Math.sin(tm * 1.3 + clock.phaseOffset);
      springStep(
        clock.lean,
        clamp(
          wind.dirX * CLOCK_BEND * g +
            sway +
            breath.pushX * push * BREATH_CLOCK +
            side * WILT_LEAN * clock.wilt,
          -MEADOW_LEAN_MAX,
          MEADOW_LEAN_MAX,
        ),
        omega,
        CLOCK_DAMPING,
        STEP,
      );
      springStep(
        clock.bow,
        clamp(
          wind.dirZ * CLOCK_BOW * g + push * BREATH_BOW + WILT_DROOP * clock.wilt,
          -0.2,
          MEADOW_AWAY_MAX,
        ),
        omega,
        CLOCK_DAMPING,
        STEP,
      );
      const x0 = clock.headX;
      const y0 = clock.headY;
      this.#placeHead(clock);
      clock.headVX = (clock.headX - x0) / STEP;
      clock.headVY = (clock.headY - y0) / STEP;

      if (wanted && (clock.phase === "ripe" || clock.phase === "bare")) {
        const left = remaining(clock);
        if (left > 0) {
          const load = Math.max(g, 0) + push * BREATH_DETACH;
          const rate =
            (DETACH_CALM + DETACH_GUST * smoothstep(DETACH_FROM, DETACH_TO, load)) *
            (0.35 + (0.65 * left) / CLOCK_SEEDS) *
            (1 - this.#closed) *
            detachBoost;
          if (this.#random.next() < rate * STEP) this.#detach(clock, downwind, 0, 0);
          if (this.#burst > 0 && this.#random.next() < this.#burst * STEP) {
            const kick = EXIT_KICK * (0.6 + 0.8 * this.#random.next());
            this.#detach(clock, downwind, side * kick, EXIT_KICK_LIFT * this.#random.next());
          }
        }
      }
      const opened = clamp(clock.open, 0, 1);
      clock.counts.forEach((count, k) => {
        const shown = clock.shown[k] ?? 0;
        clock.shown[k] = shown + (opened * (count / SEEDS_PER_SECTOR) - shown) * ease;
      });
    });
  }

  /** The clock's life: a bud opens, the seeds go, the bare stalk wilts, and a new one comes up. */
  #live(clock: Clock, slot: number, wanted: boolean): void {
    clock.timer += STEP;
    if (!wanted && clock.phase !== "gone") {
      clock.presence = Math.max(0, clock.presence - STEP / LEAVE_TIME);
      if (clock.presence <= 0) this.#vanish(clock);
      return;
    }
    switch (clock.phase) {
      case "gone":
        if (wanted && clock.timer >= GONE_HOLD) this.#regrow(clock, slot);
        break;
      case "opening":
        clock.presence = Math.min(1, clock.presence + STEP / APPEAR_TIME);
        clock.open += STEP / OPEN_TIME;
        if (clock.open >= 1) {
          clock.open = 1;
          clock.phase = "ripe";
          clock.timer = 0;
        }
        break;
      case "ripe":
        clock.presence = Math.min(1, clock.presence + STEP / APPEAR_TIME);
        if (remaining(clock) <= BARE_LEFT) {
          clock.phase = "bare";
          clock.timer = 0;
        }
        break;
      case "bare":
        if (clock.timer >= BARE_HOLD) {
          clock.phase = "wilting";
          clock.timer = 0;
        }
        break;
      case "wilting":
        clock.wilt = Math.min(1, clock.wilt + STEP / WILT_TIME);
        clock.presence = 1 - smoothstep(0.45, 1, clock.wilt);
        if (clock.wilt >= 1) this.#vanish(clock);
        break;
      default: {
        const unreachable: never = clock.phase;
        throw new MeadowSimError(`meadow: unknown clock phase ${String(unreachable)}`);
      }
    }
  }

  /** A new clock near its slot: a closed bud on a fresh stalk, every seed in place. */
  #regrow(clock: Clock, slot: number): void {
    const random = this.#random;
    const at = CLOCK_SLOTS[slot] ?? { share: 0.5, head: 0.3, radius: 0.03, z: 3 };
    clock.phase = "opening";
    clock.timer = 0;
    clock.presence = 0;
    clock.open = 0;
    clock.wilt = 0;
    clock.share = at.share + (random.next() - 0.5) * CLOCK_JITTER_SHARE;
    clock.head = at.head + (random.next() - 0.5) * CLOCK_JITTER_HEAD;
    clock.radius =
      at.radius * (1 - 0.5 * CLOCK_JITTER_RADIUS + CLOCK_JITTER_RADIUS * random.next());
    clock.z = at.z;
    clock.counts.fill(SEEDS_PER_SECTOR);
    clock.shown.fill(0);
    clock.lean.x = 0;
    clock.lean.v = 0;
    clock.bow.x = 0;
    clock.bow.v = 0;
    clock.phaseOffset = random.next() * TAU;
    this.#placeHead(clock);
    clock.headVX = 0;
    clock.headVY = 0;
    // Drawn where it comes up, not slid there from where the last one stood.
    this.#keepClock(clock);
  }

  /** What is drawn of the clock as it stands becomes the step before: the next step is drawn from it. */
  #keepClock(clock: Clock): void {
    clock.presenceWas = clock.presence;
    clock.openWas = clock.open;
    clock.leanWas = clock.lean.x;
    clock.bowWas = clock.bow.x;
    clock.shown.forEach((fill, k) => {
      clock.shownWas[k] = fill;
    });
  }

  #vanish(clock: Clock): void {
    clock.phase = "gone";
    clock.timer = 0;
    clock.presence = 0;
  }

  /** The head sits on the bent stalk's tip; the shader draws the stalk to it with the same curve. */
  #placeHead(clock: Clock): void {
    clock.headX = this.#headX(clock, clock.lean.x);
    clock.headY = this.#headY(clock, clock.bow.x);
  }

  /** The head's x on a stalk leaning `lean` (screen heights from the frame's left edge). */
  #headX(clock: Clock, lean: number): number {
    const tall = clock.head - CLOCK_ROOT;
    return (
      clock.share * this.#aspect +
      MEADOW_BEND_SHAPE * clamp(lean, -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX) * tall
    );
  }

  /** The head's height on a stalk bowed `bow` away (screen heights). */
  #headY(clock: Clock, bow: number): number {
    const tall = clock.head - CLOCK_ROOT;
    return CLOCK_ROOT + tall * (1 - MEADOW_BOW * clamp(bow, -0.2, MEADOW_AWAY_MAX));
  }

  /** A sector with seeds left, favouring those facing `toward` (radians) and the fuller ones; -1 if bare. */
  #pickSector(clock: Clock, toward: number): number {
    let best = -1;
    let bestScore = 0;
    clock.counts.forEach((count, k) => {
      if (count <= 0) return;
      const angle = ((k + 0.5) / SECTORS) * TAU;
      const score =
        (1.25 + Math.cos(angle - toward)) *
        (0.4 + this.#random.next()) *
        (0.5 + count / SEEDS_PER_SECTOR);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    return best;
  }

  /** Let one seed go from the side facing `toward`, with an extra kick; false if none could go. */
  #detach(clock: Clock, toward: number, kickX: number, kickY: number): boolean {
    const camera = this.#camera;
    if (!camera) return false;
    const seed = this.#seeds.find((candidate) => !candidate.live);
    if (!seed) return false;
    const sector = this.#pickSector(clock, toward);
    if (sector < 0) return false;
    clock.counts[sector] = (clock.counts[sector] ?? 1) - 1;
    const random = this.#random;
    const angle = ((sector + 0.5 + (random.next() - 0.5) * 0.8) / SECTORS) * TAU;
    const reach = clock.radius * (1 - CLOSE_SHARE * this.#closed) * 0.85;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    seed.live = true;
    // Released where the head is seen, at its own depth, moving as the head and the kick move it on
    // screen there.
    seed.z = clock.z * (0.95 + 0.1 * random.next());
    const perHeight = 1 / camera.scale(seed.z);
    seed.x = camera.worldX(clock.headX + cos * reach - 0.5 * this.#aspect, seed.z);
    seed.y = camera.worldY(clock.headY + sin * reach, seed.z);
    seed.vx = (clock.headVX + cos * SEED_POP + kickX) * perHeight;
    seed.vy = (clock.headVY + sin * SEED_POP + kickY) * perHeight;
    seed.vz = 0;
    seed.age = 0;
    seed.life = SEED_LIFE + SEED_LIFE_SPAN * random.next();
    seed.size = SEED_RADIUS * (0.85 + 0.3 * random.next());
    seed.tumble = random.next() * TAU;
    seed.tumbleRate = (0.3 + 0.5 * random.next()) * (random.next() < 0.5 ? -1 : 1);
    seed.drift = random.next() * TAU;
    seed.tilt = 0;
    // Drawn from where it leaves the head.
    keepSeed(seed);
    return true;
  }

  #stepSeeds(tm: number, wind: GustWind): void {
    const camera = this.#camera;
    if (!camera) return;
    const aspect = this.#aspect;
    const breath = this.#breath;
    const air = this.#seedAir;
    const breeze = SEED_BREEZE + SEED_BREEZE_WIND * Math.abs(this.#windKnob);
    const sink = SEED_SINK * (1 + SEED_RAIN_SINK * this.#closed);
    const follow = 1 - Math.exp(-STEP / SEED_DRAG);
    const turn = 1 - Math.exp(-STEP / SEED_TILT_TIME);
    for (const seed of this.#seeds) {
      if (!seed.live) continue;
      keepSeed(seed);
      const g = gustAt(wind, seed.x, seed.z, tm, 0);
      const lift = Math.max(g, 0);
      const eddy = tm * SEED_EDDY_RATE * (1 + 0.5 * Math.abs(seed.tumbleRate)) + seed.drift;
      // The air runs along the gust direction: for every unit it carries a seed across the view it
      // carries it dirZ / |dirX| away.
      const across = (breeze + SEED_GUST * Math.max(g, -0.1) + this.#push) * air;
      const along = across / Math.abs(wind.dirX);
      let airX = wind.dirX * along + SEED_EDDY * Math.sin(eddy) * air;
      let airY =
        (SEED_LIFT * lift +
          SEED_THERMAL -
          sink +
          SEED_EDDY * Math.cos(eddy * 0.77 + seed.drift) +
          this.#lift) *
        air;
      const airZ = wind.dirZ * along;
      // The breath blows in the frame: the same push on screen whatever the seed's depth.
      const push =
        (breath.at(camera.screenX(seed.x, seed.z) + 0.5 * aspect, camera.screenY(seed.y, seed.z)) *
          BREATH_SEED) /
        camera.scale(seed.z);
      airX += breath.pushX * push;
      airY += breath.pushY * push;
      seed.vx += (airX - seed.vx) * follow;
      seed.vy += (airY - seed.vy) * follow;
      seed.vz += (airZ - seed.vz) * follow;
      seed.x += seed.vx * STEP;
      seed.y += seed.vy * STEP;
      seed.z += seed.vz * STEP;
      seed.age += STEP;
      seed.tumble += seed.tumbleRate * STEP;
      // The tuft leads, the seed hangs behind it: the stalk tilts with the drift across the frame.
      const tilt =
        clamp(-camera.screenVX(seed.x, seed.z, seed.vx, seed.vz) * SEED_TILT, -0.7, 0.7) +
        0.12 * Math.sin(seed.tumble);
      seed.tilt += (tilt - seed.tilt) * turn;
      const sx = camera.screenX(seed.x, seed.z);
      const sy = camera.screenY(seed.y, seed.z);
      const out =
        Math.abs(sx) > 0.5 * aspect + SEED_MARGIN || sy < -SEED_MARGIN || sy > 1 + SEED_MARGIN;
      if (out || seed.age >= seed.life || seed.z >= SEED_DEPTH_FADE_TO) seed.live = false;
    }
  }

  /** A click blows a handful of seeds off the clock nearest the pointer, away from it. */
  #blowNearest(pointer: Pointer): void {
    const x = pointer.x * this.#aspect;
    const y = pointer.y;
    let best: Clock | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const clock of this.#clocks) {
      if (
        clock.presence < 0.5 ||
        (clock.phase !== "ripe" && clock.phase !== "bare") ||
        remaining(clock) === 0
      )
        continue;
      const d = Math.hypot(clock.headX - x, clock.headY - y);
      if (d < nearest) {
        nearest = d;
        best = clock;
      }
    }
    if (!best) return;
    const away = Math.atan2(best.headY - y, best.headX - x);
    const random = this.#random;
    for (let n = 0; n < CLICK_BURST; n++) {
      const speed = CLICK_SPEED * (0.6 + 0.8 * random.next());
      const spread = (random.next() - 0.5) * 0.9;
      if (
        !this.#detach(
          best,
          away,
          Math.cos(away + spread) * speed,
          Math.sin(away + spread) * speed + CLICK_LIFT,
        )
      )
        break;
    }
    best.lean.v += Math.cos(away) * CLICK_SHOVE;
    best.bow.v += 0.5 * CLICK_SHOVE;
    this.#dirty = true;
  }

  /** The records, `alpha` of the way from the step before last to the last (FixedStep.alpha). */
  #pack(alpha: number, data: Float32Array): void {
    const camera = this.#camera;
    if (!camera) return;
    const aspect = this.#aspect;
    const drop = this.#drop;
    data.fill(0);
    const sorted = this.#sorted;
    sorted.length = 0;
    for (const seed of this.#seeds) {
      if (!seed.live) continue;
      seed.sx = camera.screenX(lerp(seed.xWas, seed.x, alpha), lerp(seed.zWas, seed.z, alpha));
      sorted.push(seed);
    }
    sorted.sort(byX);
    const minRadius = SEED_MIN_CELLS / this.#rows;
    const groupRow = 2 * ROW;
    for (let g = 0; g < SEED_GROUPS; g++) {
      const o = groupRow + g * 4;
      data[o] = 2;
      data[o + 1] = 2;
      data[o + 2] = -1;
      data[o + 3] = -1;
    }
    sorted.forEach((seed, n) => {
      const z = lerp(seed.zWas, seed.z, alpha);
      const age = lerp(seed.ageWas, seed.age, alpha);
      const y = camera.screenY(lerp(seed.yWas, seed.y, alpha) - drop, z);
      const radius = Math.max((seed.size * camera.focal) / z, minRadius);
      const opacity =
        (1 - smoothstep(seed.life - SEED_FADE, seed.life, age)) *
        (1 - smoothstep(SEED_DEPTH_FADE_FROM, SEED_DEPTH_FADE_TO, z));
      const u = seed.sx / aspect + 0.5;
      const o0 = n * 4;
      data[o0] = u;
      data[o0 + 1] = y;
      data[o0 + 2] = radius;
      data[o0 + 3] = opacity;
      const o1 = ROW + n * 4;
      data[o1] = lerp(seed.tiltWas, seed.tilt, alpha);
      data[o1 + 1] = z;
      data[o1 + 2] = 0.55 + 0.45 * Math.abs(Math.cos(lerp(seed.tumbleWas, seed.tumble, alpha)));
      // The group's box, in uv, wide enough for the seed's halo and hanging stalk.
      const reach = 3 * radius;
      const o = groupRow + Math.floor(n / SEED_GROUP) * 4;
      data[o] = Math.min(data[o] ?? 2, u - reach / aspect);
      data[o + 1] = Math.min(data[o + 1] ?? 2, y - reach);
      data[o + 2] = Math.max(data[o + 2] ?? -1, u + reach / aspect);
      data[o + 3] = Math.max(data[o + 3] ?? -1, y + reach);
    });

    const closed = lerp(this.#closedWas, this.#closed, alpha);
    this.#clocks.forEach((clock, c) => {
      // Placed again here so a resize moves the clocks even while the scene stands still.
      this.#placeHead(clock);
      const o = (SEED_ROWS + c) * ROW;
      // The rig's height over rest lowers a clock in the frame, by its own depth.
      const rise = (camera.focal * drop) / clock.z;
      data[o] = clock.share;
      data[o + 1] = CLOCK_ROOT - rise;
      data[o + 2] = this.#headX(clock, lerp(clock.leanWas, clock.lean.x, alpha)) / aspect;
      data[o + 3] = this.#headY(clock, lerp(clock.bowWas, clock.bow.x, alpha)) - rise;
      let fullness = 0;
      clock.shown.forEach((fill, k) => {
        const shown = lerp(clock.shownWas[k] ?? fill, fill, alpha);
        data[o + (2 + k) * 4] = shown;
        fullness += shown;
      });
      data[o + 2 * 4 + 1] = clock.z;
      data[o + 2 * 4 + 2] = closed;
      data[o + 4] = clock.radius * (1 - CLOSE_SHARE * closed);
      data[o + 5] = lerp(clock.presenceWas, clock.presence, alpha);
      data[o + 6] = clamp(lerp(clock.openWas, clock.open, alpha), 0, 1);
      data[o + 7] = fullness / SECTORS;
    });
  }
}

/** The grass layer's sim (LayerCode.sim). */
export function grassSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new GrassSim(gl, params);
}

/** The dandelions layer's sim (LayerCode.sim): records only, no texture of its own. */
export function dandelionsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new DandelionsSim(params);
}
