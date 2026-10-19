// The Bamboo grove preset's sims (ADR 0062 Phase 2b): everything in the grove that moves with weight
// is one simulation, the grove's (its backdrop's LayerSim, `Grove`), on one random stream for the
// seed, so a seed lets the same leaves go and fills the tube as it always did. The culms and the
// water clock hand it nothing but their knobs; they reach it through `LayerFrame.host` and take their
// data from it.
// - The grove: every culm in view, depth layer by depth layer, is a damped spring whose target is set
//   by the wind: a gentle breeze always rolling through, and the composer's one gust field (D4,
//   composer/gust.ts) where the culm stands, so the stems bow one after another as a front crosses
//   them and ring on after it passes; a press sends a breath of wind of its own downwind from where it
//   landed, and the exit a fast front across the whole grove.
// - The shishi-odoshi: a bamboo tube on a pivot, a damped rotational oscillator whose torque comes
//   from its own weight (heavier behind the pivot) and the water filling its mouth. It fills, lifts
//   off its stone, tips past its balance point as the water rushes to the mouth, pours into the
//   basin, swings back and clacks on the stone with a small bounce; or, the knock knob turned down,
//   eases onto a pad of moss on the stone with a soft knock, too soft to bounce or startle a leaf.
// - Leaves letting go of the canopy and gliding down (while the culms stand); some land on the basin
//   and float (while the water clock stands).
// - Rings on the basin's water: the pour, the clack, a leaf landing, a press (any principal's).
// - The passage (BAMBOO_PASSAGE): entering, the tube starts empty and fills to where the warm-up left
//   it as the spout's first water arrives; leaving, the spout rushes so the tube brims, tips and
//   clacks, a fast gust front crosses the grove and a couple of leaves let go. The culms' lean in and
//   out is the shader's (it needs no state).
// Knobs read: the water clock's `clock` (its period, 0 while off) and `knock`, the culms' `leaves`,
// the composer's `seed`, and the gust field's (LayerFrame.gusts: the World's wind, the composer's
// gusts).
//
// Data (shader.ts reads it):
//   the grove's field 0, and the culms' (the same texture): rg16f, BAMBOO_CELLS x layers, linear: per
//          culm (column = grid cell + BAMBOO_CELLS / 2, row = depth layer) its deflection in metres
//          at BAMBOO_SWAY_HEIGHT, and the gust on it 0..1.
//   the grove's row: texel 0 (the grove's mean gust 0..1, 0, 0, 0).
//   the culms' row, and the clock's second row: two texels a leaf (leaf i at 2i, 2i + 1). Falling or
//          lying: (screen x, y, angle, length in screen heights), (width 0..1, depth m, alpha, 1).
//          Floating: (disc u, v, angle, length in disc units), (1, depth m, alpha, 2). Unused are 0.
//   the clock's first row: texel 0 the tube (angle in radians, mouth up positive; fill relative to
//          the tipping point; pour 0..1; spout flow 0 dry, 1 steady, more while it gushes), texel 1
//          (seconds since the clack, its strength 0..1, 0, 0), then one texel per ripple (centre in
//          basin-disc units, age in seconds, strength).
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { gustAt, gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { FixedStep } from "../../sims/clock.ts";
import { approach, hash31, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { springStep, type Spring } from "../../sims/spring.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PrincipalState, ScenePoint } from "../types.ts";
import { BAMBOO_PASSAGE } from "./constants.ts";
import {
  BAMBOO_BASIN,
  BAMBOO_CELLS,
  BAMBOO_DEVICE_DEPTH,
  BAMBOO_EYE,
  BAMBOO_GUST_GAIN,
  BAMBOO_HORIZON,
  BAMBOO_LAYERS,
  BAMBOO_MAX_LEAVES,
  BAMBOO_RIPPLES,
  BAMBOO_STREAM_START,
  BAMBOO_TUBE,
  bambooDeviceScale,
  bambooPourLanding,
} from "./layout.ts";

// ---- wind ----

/** Fronts cross the grove this far off square (radians), so they reach the front rows first. */
const FRONT_SKEW = 0.35;
const SKEW_COS = Math.cos(FRONT_SKEW);
const SKEW_SIN = Math.sin(FRONT_SKEW);
/** The culms' damping ratio: low, so a passing gust leaves them swaying a few times. */
const CULM_DAMPING = 0.08;
/** The always-present breeze: two slow waves (wavenumbers per metre) rolling downwind. */
const BREEZE_LONG = (2 * Math.PI) / 22;
const BREEZE_SHORT = (2 * Math.PI) / 9;
/** A breath's leading edge rises over this many metres; its tail is set per breath. */
const GUST_RISE = 0.8;
/** The grove's fixed step; a frame's time (at most FRAME_MAX) is caught up in whole steps of it. */
const GROVE_STEP = 1 / 60;
const PREWARM_SECONDS = 6;
/** The most scene seconds one frame advances. */
const FRAME_MAX = 0.25;

/** Deflection (m at BAMBOO_SWAY_HEIGHT) per unit of breeze or gust, for the wind knob -1..1. */
function windSway(wind: number): number {
  return 0.12 + 1.5 * Math.abs(wind) ** 0.9;
}

/** How fast the breeze and a breath travel (m/s). */
function windSpeed(wind: number): number {
  return 1.8 + 2.6 * Math.abs(wind);
}

/** Peak of the breath's pulse (1 - e^(-xi/rise)) e^(-xi/tail), so its crest can be normalised. */
function pulsePeak(tail: number): number {
  const xi = GUST_RISE * Math.log(1 + tail / GUST_RISE);
  return (1 - Math.exp(-xi / GUST_RISE)) * Math.exp(-xi / tail);
}

// ---- the hands (every principal's, SimFrame.principals) ----

/** How far either side of a hand (screen heights) stems are brushed. */
const BRUSH_REACH = 0.08;
/** Deflection (m) per screen height per second of a hand's speed. */
const BRUSH_GAIN = 0.3;
const BRUSH_MAX = 2.5;
/** Smoothing of a hand's speed (s). */
const BRUSH_SMOOTH = 0.12;
/** Where a press breathes wind into the grove, uv: upwind of the middle, among the stems. */
const GROVE_POINTS: readonly ScenePoint[] = [
  { x: 0.24, y: 0.56 },
  { x: 0.46, y: 0.64 },
];

// ---- the tube (SI units: metres, kilograms, seconds) ----

/** The tube's fixed step: a clack's bounce needs it short. */
const TUBE_STEP = 1 / 240;
const GRAVITY = 9.8;
/** The empty tube's mass times its centre's distance along it from the pivot: behind it, so it rests mouth up. */
const TUBE_MOMENT = -0.05;
/** The empty tube's moment of inertia about the pivot (kg m^2). */
const TUBE_INERTIA = 0.07;
/** Water the mouth holds when full (kg). */
const WATER_MASS = 0.45;
/** Where the water's centre sits along the tube (m from the pivot): pooled against the inner node
 *  while the mouth is up, rushed to the mouth once it is down. */
const waterUp = (fill: number): number => 0.05 + 0.16 * fill;
const waterDown = (fill: number): number => 0.34 - 0.08 * fill;
/** How quickly the water slops to its new place as the tube turns (s). */
const SLOSH_TIME = 0.12;
const PIVOT_DAMPING = 0.015;
/** Extra damping per kilogram of water sloshing inside. */
const WATER_DRAG = 0.04;
/** Bounce off the striking stone, and off the soft stop below. */
const RESTITUTION = 0.32;
const SOFT_RESTITUTION = 0.15;
/**
 * The knock knob's pad of moss on the striking stone, soft enough to take up the last PAD_SPAN
 * radians of the swing back: squashed, it damps the return in proportion to how far it is squashed
 * (N m s when squashed flat, at knock 0), so the tube eases onto the stone, and it swallows the
 * bounce. At knock 1 there is no pad: bare stone.
 */
const PAD_SPAN = 0.2;
const PAD_DAMPING = 1.8;
/** Impact speeds (rad/s): slower is a silent touch, this fast a full clack. */
const CLACK_MIN = 0.25;
const CLACK_FULL = 3;
/** Fill per second poured per unit of water above what the mouth can hold at its angle. */
const POUR_RATE = 6;
/** Pour (fill per second) drawn at full width. */
const POUR_FULL = 3;
/** The fill at which the full tube lifts off its stone: the water's moment balances the tube's. */
const TIP_FILL = (() => {
  // WATER_MASS f (a + b f) = -TUBE_MOMENT, with waterUp(f) = a + b f.
  const a = waterUp(0);
  const b = waterUp(1) - a;
  const qa = WATER_MASS * b;
  const qb = WATER_MASS * a;
  return (-qb + Math.sqrt(qb * qb - 4 * qa * TUBE_MOMENT)) / (2 * qa);
})();
/** Seconds of each cycle spent lifting, tipping, pouring, swinging back and settling. */
const CYCLE_OVERHEAD = 2.2;
/** A "now": the spout gushes at this extra fill per second until the tube tips (or this long). */
const GUSH_RATE = 0.8;
const GUSH_LIMIT = 6;
/** The exit: the spout rushes this much extra fill per second for up to this long, so the tube brims and tips at once. */
const EXIT_RUSH = 6;
const EXIT_RUSH_TIME = 0.5;
/** The exit's gust front, faster than any natural one so it sweeps the grove within the exit (m/s), and its crest in metres of deflection. */
const EXIT_GUST_SPEED = 22;
const EXIT_GUST_SWAY = 0.9;
/** The entrance: seconds the first water takes to fall from the lip into the tube's mouth. */
const STREAM_REACH = 0.5;
/** Seconds between rings while the pour lands. */
const RIPPLE_EVERY = 0.11;

// ---- leaves ----

/** Sinking speed at the ends of each swing, and extra mid-swing (m/s). */
const LEAF_SINK = 0.25;
const LEAF_DIVE = 0.45;
const LEAF_FADE_IN = 0.6;
const LEAF_REST = 5;
const LEAF_FADE = 3;
const FLOAT_LIFE = 80;
const FLOAT_FADE = 6;
const MAX_FLOATING = 2;
/** Leaves let go per second at amount 1: always a few, many more in a gust. */
const RELEASE_CALM = 0.12;
const RELEASE_GUST = 1.2;
/** Share that let go above the basin, at the water clock's depth. */
const NEAR_SHARE = 0.3;
/** Depth range (m) of the other leaves. */
const LEAF_NEAR = 1.8;
const LEAF_FAR = 8;

/** Texels of the clock's first row: the tube, the clack, then the rings. */
const DEVICE_TEXELS = 2 + BAMBOO_RIPPLES;

const TAU = 2 * Math.PI;

export class BambooSimError extends Error {}

/**
 * The entrance's own clock. The warm-up runs inside the sim's first frame, which can be slow; the
 * entrance counts only frames after it, so a slow first frame does not use the filling up. Seconds
 * into the entrance, exactly BAMBOO_PASSAGE.enter once it is over and from the start when the scene
 * was not entered with a passage.
 */
class EntranceClock {
  #arriving: boolean | undefined = undefined;
  #seconds = 0;

  advance(frame: LayerFrame, ready: boolean): number {
    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1;
    if (!this.#arriving) return BAMBOO_PASSAGE.enter;
    if (ready) this.#seconds += Math.max(0, frame.dt);
    if (this.#seconds >= BAMBOO_PASSAGE.enter) {
      this.#arriving = false;
      return BAMBOO_PASSAGE.enter;
    }
    return this.#seconds;
  }
}

interface Culm {
  readonly layer: number;
  readonly depth: number;
  /** Cell centre, metres across the grove. */
  readonly x: number;
  /** Natural angular frequency (rad/s). */
  omega: number;
  /** Deflection (m at BAMBOO_SWAY_HEIGHT, `x`) and its rate, on the culm's spring. */
  readonly sway: Spring;
  /** The deflection one grove step before: the drawn one lies between the two. */
  swayWas: number;
  /** The gust on it now, 0..1. */
  gust: number;
  /** Extra deflection from the hands brushing past. */
  push: number;
}

/** A breath of wind of the grove's own: a press's, or the exit's front. */
interface Breath {
  readonly born: number;
  /** Front position along its heading when it set off (m). */
  readonly from: number;
  /** Only culms at or past this position feel it (a breath sent from a hand starts there). */
  readonly origin: number;
  /** +1 blowing toward +x, -1 toward -x. */
  readonly heading: number;
  readonly speed: number;
  /** Strength over the pulse's own peak, so its crest reaches the strength asked for. */
  readonly gain: number;
  /** e-folding length of its tail (m). */
  readonly tail: number;
}

type LeafState = "free" | "falling" | "resting" | "floating";

interface Leaf {
  state: LeafState;
  /** Let go above the basin, at the water clock's depth. */
  near: boolean;
  /** Metres across, metres up from the ground, metres deep. */
  x: number;
  y: number;
  z: number;
  /** The side-to-side swing of a falling leaf: phase, angular rate, half-width (m). */
  phase: number;
  swingRate: number;
  swing: number;
  /** Turning about its long axis (shows it edge-on now and then). */
  spin: number;
  spinRate: number;
  tilt: number;
  size: number;
  /** Seconds in its current state. */
  age: number;
  /** On the water: place in basin-disc units, and its heading there. */
  u: number;
  v: number;
  turn: number;
}

interface Ripple {
  u: number;
  v: number;
  born: number;
  strength: number;
}

type KnobKey = "clock" | "knock" | "leaves" | "seed";

/**
 * The grove's simulation (see the header): the grove backdrop's sim, and the host the culms and the
 * water clock take their data from (its affordances are itself).
 */
export class Grove implements LayerSim {
  /** The culms' sway: the grove's field, and the culms'. */
  readonly sway: DataTexture;
  /** The clock's first row as packed (DEVICE_TEXELS texels). */
  readonly device = new Float32Array(DEVICE_TEXELS * 4);
  /** The leaves as packed: the culms' row, and the clock's second (2 texels a leaf). */
  readonly leaves = new Float32Array(2 * BAMBOO_MAX_LEAVES * 4);
  /** How many times the data has been packed: the culms and the clock copy it when it moves on. */
  packs = 0;

  readonly #swayData = new Float32Array(BAMBOO_CELLS * BAMBOO_LAYERS.length * 2);
  readonly #knobs: KnobReader<KnobKey>;

  readonly #culms: Culm[] = [];
  readonly #breaths: Breath[] = [];
  readonly #leaves: Leaf[] = [];
  readonly #ripples: Ripple[] = [];
  #nextRipple = 0;

  // Knobs, as the sim follows them.
  #period = 20;
  /** 1 bare stone .. 0 the thickest pad of moss on it. */
  #knock = 1;
  #leafAmount = 0.4;
  #wind = 0.2;
  #seed = -1;
  /** The composer's gusts are on (its strength over 0): the exit then sends its front. */
  #gusting = true;
  /** Whether the culms and the water clock stand (their sims are running). */
  #culmsOn = true;
  #clockOn = true;
  /**
   * Everything drawn a frame or an event at a time (leaves letting go, ripples, the clack, breaths
   * sent by a press or the exit, the tube's opening fill), on one stream for the seed.
   */
  #random = mulberry32(1);

  /** The sim's own clock: scene seconds scaled by motion, advanced a grove step at a time. */
  #clock = 0;
  readonly #groveSteps = new FixedStep(GROVE_STEP, Math.ceil(FRAME_MAX / GROVE_STEP));
  readonly #tubeSteps = new FixedStep(TUBE_STEP, Math.ceil(FRAME_MAX / TUBE_STEP));
  #warm = false;
  #dirty = true;
  #gustMean = 0;
  /** The composer's gust field at the moment being stepped (motion seconds #tm). */
  readonly #field = newGustWind();
  #tm = 0;

  // The tube.
  #angle: number = BAMBOO_TUBE.rest;
  /** The tube's angle one tube step before: the drawn one lies between the two. */
  #angleWas: number = BAMBOO_TUBE.rest;
  #spin = 0;
  #fill = 0.5;
  #slosh = waterUp(0.5);
  #outflow = 0;
  #gushLeft = 0;
  #clackAt = -60;
  #clackStrength = 0;
  #lastPourRipple = -1;
  #restFill = 0;
  #rushLeft = 0;
  #leaving = false;
  readonly #entrance = new EntranceClock();

  // The hands, by place in SimFrame.principals: x (display units; undefined while off the page)
  // and smoothed speed.
  readonly #handX: (number | undefined)[] = new Array<number | undefined>(MAX_PRINCIPALS);
  readonly #handSpeed = new Float64Array(MAX_PRINCIPALS);
  /** Points of interest (LayerSim.interest) for #interestAspect: the basin, then GROVE_POINTS. */
  readonly #basin = { x: 0, y: 0 };
  readonly #interest: ScenePoint[] = [];
  #interestAspect = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("grove", params, ["clock", "knock", "leaves", "seed"]);
    this.sway = new DataTexture(gl, {
      width: BAMBOO_CELLS,
      height: BAMBOO_LAYERS.length,
      format: "rg16f",
    });
    for (const [layer, { depth, spacing }] of BAMBOO_LAYERS.entries()) {
      for (let cell = 0; cell < BAMBOO_CELLS; cell++) {
        this.#culms.push({
          layer,
          depth,
          x: (cell - BAMBOO_CELLS / 2 + 0.5) * spacing,
          omega: 1,
          sway: { x: 0, v: 0 },
          swayWas: 0,
          gust: 0,
          push: 0,
        });
      }
    }
    for (let i = 0; i < BAMBOO_MAX_LEAVES; i++) {
      this.#leaves.push({
        state: "free",
        near: false,
        x: 0,
        y: 0,
        z: 1,
        phase: 0,
        swingRate: 1,
        swing: 0,
        spin: 0,
        spinRate: 0,
        tilt: 0,
        size: 0,
        age: 0,
        u: 0,
        v: 0,
        turn: 0,
      });
    }
    for (let i = 0; i < BAMBOO_RIPPLES; i++)
      this.#ripples.push({ u: 0, v: 0, born: -1e4, strength: 0 });
  }

  get affordances(): Grove {
    return this;
  }

  frame(frame: LayerFrame): void {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    this.#culmsOn = frame.host("culms") !== undefined;
    this.#clockOn = frame.host("clock") !== undefined;
    this.#readKnobs(frame);
    const warming = !this.#warm;
    if (warming) {
      this.#prewarm(aspect, frame);
      this.#warm = true;
    }
    // The entrance's clock starts after the warm-up frame; once over it is exactly BAMBOO_PASSAGE.enter.
    const entering = this.#entrance.advance(frame, !warming);
    const arriving = entering < BAMBOO_PASSAGE.enter;
    if (warming && arriving) {
      // The tube starts empty and fills to where the warm-up left it as the entrance ends.
      this.#restFill = this.#fill;
      this.#fill = 0;
      this.#slosh = waterUp(0);
    }
    this.#watchTriggers(frame.fired, aspect);
    this.#trackHands(frame.principals, frame.dt, aspect);
    if (frame.passage.exit > 0 && !this.#leaving) {
      this.#leaving = true;
      this.#leave(aspect);
    }

    const advance = Math.min(Math.max(0, frame.dt) * Math.max(0, frame.motion), FRAME_MAX);
    if (advance > 0) this.#advance(advance, aspect, frame);
    // The water arrives with the stream and fills the tube (a floor: a "now" can still fill it faster).
    if (arriving) {
      this.#fill = Math.max(
        this.#fill,
        this.#restFill *
          smoothstep(BAMBOO_STREAM_START + STREAM_REACH, BAMBOO_PASSAGE.enter, entering),
      );
    }
    if (advance > 0 || this.#dirty) {
      this.#pack(aspect);
      this.sway.upload(this.#swayData);
      const row = frame.records.data;
      row[0] = this.#gustMean;
      frame.records.touch();
      this.packs++;
      this.#dirty = false;
    }
    const field = frame.fields[0];
    if (field) field.texture = this.sway.texture;
  }

  dispose(): void {
    this.sway.dispose();
  }

  /** The basin while the water clock stands (a press rings it) and the grove upwind (a press sends a breath of wind). */
  interest(aspect: number): readonly ScenePoint[] {
    if (aspect !== this.#interestAspect) {
      this.#interestAspect = aspect;
      const k = bambooDeviceScale(aspect);
      this.#basin.x = 1 + (k * BAMBOO_BASIN.x) / aspect;
      this.#basin.y = k * BAMBOO_BASIN.y;
    }
    const points = this.#interest;
    points.length = 0;
    if (this.#clockOn) points.push(this.#basin);
    for (const point of GROVE_POINTS) points.push(point);
    return points;
  }

  #readKnobs(frame: LayerFrame): void {
    const knobs = this.#knobs;
    this.#period = knobs.value(frame, "clock");
    this.#knock = knobs.value(frame, "knock");
    this.#leafAmount = this.#culmsOn ? knobs.value(frame, "leaves") : 0;
    this.#wind = frame.gusts.wind;
    this.#gusting = frame.gusts.gusts > 0;
    const seed = Math.round(knobs.value(frame, "seed"));
    if (seed !== this.#seed) {
      this.#seed = seed;
      this.#random = mulberry32(0x6c656166 ^ Math.imul(seed + 1, 0x85ebca6b));
      for (const [i, culm] of this.#culms.entries()) {
        const cell = i % BAMBOO_CELLS;
        // Thick near stems a little slower; each its own pace, so they drift out of step.
        culm.omega =
          TAU * (0.2 + 0.16 * hash31(seed, culm.layer, cell)) * (0.88 + 0.04 * culm.layer);
      }
      this.#dirty = true;
    }
  }

  /**
   * The composer's gust field at motion time `tm`, its "now" gust `nowAge` seconds old (negative:
   * none), the moment a grove step stands for: what #gustAt reads.
   */
  #fieldAt(frame: LayerFrame, tm: number, nowAge: number): void {
    const g = frame.gusts;
    gustWind(this.#field, g.wind, g.gusts, g.rate, nowAge, g.pass, g.shape);
    this.#tm = tm;
  }

  /**
   * Before the first frame: the grove has been swaying in the gust field for a while (the field as it
   * blew up to now, no "now" gust in it), two leaves are on their way down, and the tube is half
   * full, so the first seconds already live.
   */
  #prewarm(aspect: number, frame: LayerFrame): void {
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    for (const culm of this.#culms) {
      culm.sway.x = heading * sway * 0.28;
      culm.swayWas = culm.sway.x;
    }
    const steps = Math.round(PREWARM_SECONDS / GROVE_STEP);
    for (let s = 0; s < steps; s++) {
      this.#clock += GROVE_STEP;
      this.#fieldAt(frame, frame.motionTime - (steps - 1 - s) * GROVE_STEP, -1);
      this.#retireBreaths(aspect);
      this.#stepGrove(aspect);
    }
    this.#fill = TIP_FILL * (0.7 + 0.12 * this.#random());
    this.#slosh = waterUp(this.#fill);
    this.#release(aspect, true);
    this.#release(aspect, false);
    for (let s = 0; s < 25; s++) this.#stepLeaves(0.1, aspect);
  }

  #watchTriggers(fired: readonly boolean[], aspect: number): void {
    const knobs = this.#knobs;
    if (fired[knobs.trigger("clock")] === true) this.#gushLeft = GUSH_LIMIT;
    if (fired[knobs.trigger("leaves")] === true) {
      this.#release(aspect, true);
      this.#release(aspect, false);
      this.#release(aspect, false);
    }
  }

  /**
   * Every hand moving through the stems brushes them aside (their pushes add); a press sends a
   * breath of wind or rings the basin.
   */
  #trackHands(principals: readonly PrincipalState[], dt: number, aspect: number): void {
    for (const culm of this.#culms) culm.push = 0;
    for (let i = 0; i < MAX_PRINCIPALS; i++) {
      const hand = principals[i];
      if (hand === undefined || !hand.inside) {
        this.#handX[i] = undefined;
        this.#handSpeed[i] = 0;
        continue;
      }
      const px = (hand.x - 0.5) * aspect;
      const py = hand.y;
      const was = this.#handX[i];
      if (was !== undefined && dt > 0) {
        const speed = Math.min(BRUSH_MAX, Math.max(-BRUSH_MAX, (px - was) / dt));
        this.#handSpeed[i] = approach(this.#handSpeed[i] ?? 0, speed, dt, BRUSH_SMOOTH);
      }
      this.#handX[i] = px;
      const speed = this.#handSpeed[i] ?? 0;
      for (const culm of this.#culms) {
        const base = BAMBOO_HORIZON - BAMBOO_EYE / culm.depth;
        const off = (culm.x / culm.depth - px) / BRUSH_REACH;
        if (py > base && off * off < 9) culm.push += BRUSH_GAIN * speed * Math.exp(-off * off);
      }
      if (hand.pressed) this.#press(px, py, aspect);
    }
  }

  #press(px: number, py: number, aspect: number): void {
    if (this.#clockOn) {
      const k = bambooDeviceScale(aspect);
      const u = (px - (aspect / 2 + k * BAMBOO_BASIN.x)) / (k * BAMBOO_BASIN.rx);
      const v = (py - k * BAMBOO_BASIN.y) / (k * BAMBOO_BASIN.ry);
      if (u * u + 0.25 * v * v < 1.1) {
        this.#addRipple(u, Math.min(0.9, Math.max(-0.9, v)), 0.8);
        return;
      }
    }
    // A breath of wind from where the press landed, downwind only.
    const heading = this.#wind < 0 ? -1 : 1;
    const z = BAMBOO_LAYERS[2]?.depth ?? 6.4;
    const at = heading * px * z * SKEW_COS + z * SKEW_SIN;
    this.#launchBreath(at, at, Math.max(0.9, 0.5 / windSway(this.#wind)));
  }

  /** Front position just upwind of everything in view. */
  #breathStart(aspect: number): number {
    const far = BAMBOO_LAYERS[BAMBOO_LAYERS.length - 1]?.depth ?? 17;
    return far * (SKEW_SIN - (aspect / 2 + 0.3) * SKEW_COS) - 2;
  }

  /** A breath from `from`, its tail drawn from the grove's stream. */
  #launchBreath(
    from: number,
    origin: number,
    strength: number,
    speed: number = windSpeed(this.#wind),
  ): void {
    const tail = 4 + 3 * this.#random();
    this.#breaths.push({
      born: this.#clock,
      from,
      origin,
      heading: this.#wind < 0 ? -1 : 1,
      speed,
      gain: strength / pulsePeak(tail),
      tail,
    });
  }

  /**
   * The exit, as it begins: the spout rushes so the tube brims and tips at once (its clack is the
   * last thing the grove does), a gust front sweeps the grove, and a couple of leaves let go.
   */
  #leave(aspect: number): void {
    if (this.#period > 0) {
      this.#gushLeft = GUSH_LIMIT;
      this.#rushLeft = EXIT_RUSH_TIME;
    }
    if (this.#gusting) {
      this.#launchBreath(
        this.#breathStart(aspect),
        Number.NEGATIVE_INFINITY,
        Math.max(1, EXIT_GUST_SWAY / windSway(this.#wind)),
        EXIT_GUST_SPEED,
      );
    }
    if (this.#leafAmount > 0) {
      this.#release(aspect, false);
      this.#release(aspect, false);
    }
  }

  /** Retire breaths whose tails have left the far side of the view. */
  #retireBreaths(aspect: number): void {
    const far = BAMBOO_LAYERS[BAMBOO_LAYERS.length - 1]?.depth ?? 17;
    const end = far * (SKEW_SIN + (aspect / 2 + 0.3) * SKEW_COS);
    for (let i = this.#breaths.length - 1; i >= 0; i--) {
      const breath = this.#breaths[i];
      if (!breath) continue;
      if (breath.from + breath.speed * (this.#clock - breath.born) - end > 8 * breath.tail)
        this.#breaths.splice(i, 1);
    }
  }

  /**
   * The wind's push at (x, z) in the grove beyond the breeze, signed toward +x: the gust field's load
   * there (#fieldAt's moment) times BAMBOO_GUST_GAIN, the way it blows, and the breaths'.
   */
  #gustAt(x: number, z: number): number {
    const field = this.#field;
    let sum = (field.dirX < 0 ? -1 : 1) * BAMBOO_GUST_GAIN * gustAt(field, x, z, this.#tm, 0);
    for (const breath of this.#breaths) {
      const at = breath.heading * x * SKEW_COS + z * SKEW_SIN;
      if (at < breath.origin) continue;
      const xi = breath.from + breath.speed * (this.#clock - breath.born) - at;
      if (xi <= 0) continue;
      sum +=
        breath.heading *
        breath.gain *
        (1 - Math.exp(-xi / GUST_RISE)) *
        Math.exp(-xi / breath.tail);
    }
    return sum;
  }

  /**
   * `total` scene seconds: the grove and the tube in their whole fixed steps due (each grove step
   * on the clock at its own moment, in the gust field as it stood then), the leaves over the whole of
   * it in the field as it stands now.
   */
  #advance(total: number, aspect: number, frame: LayerFrame): void {
    const clock = this.#clock + total;
    const grove = this.#groveSteps;
    const nowAge = frame.gusts.nowAge;
    for (let s = 0, n = grove.advance(total); s < n; s++) {
      const lag = grove.lag(s);
      this.#clock = clock - lag;
      this.#fieldAt(frame, frame.motionTime - lag, nowAge < 0 ? -1 : nowAge - lag);
      this.#retireBreaths(aspect);
      this.#stepGrove(aspect);
    }
    this.#clock = clock;
    this.#fieldAt(frame, frame.motionTime, nowAge);

    // The tube: steady inflow from the spout at the period knob's pace, plus any gush.
    const steady = this.#period > 0 ? TIP_FILL / Math.max(this.#period - CYCLE_OVERHEAD, 3) : 0;
    const tubeSteps = this.#tubeSteps.advance(total);
    let poured = 0;
    for (let s = 0; s < tubeSteps; s++) {
      const gushing = this.#gushLeft > 0;
      if (gushing) {
        this.#gushLeft -= TUBE_STEP;
        if (this.#angle < BAMBOO_TUBE.rest - 0.15) this.#gushLeft = 0;
      }
      let inflow = steady + (gushing ? GUSH_RATE : 0);
      if (this.#rushLeft > 0) {
        this.#rushLeft -= TUBE_STEP;
        if (this.#angle < BAMBOO_TUBE.rest - 0.15) this.#rushLeft = 0;
        inflow += EXIT_RUSH;
      }
      this.#angleWas = this.#angle;
      poured += this.#stepTube(TUBE_STEP, inflow, aspect);
    }
    if (tubeSteps > 0) this.#outflow = poured / (tubeSteps * TUBE_STEP);
    if (this.#outflow > 0.3 && this.#clock - this.#lastPourRipple > RIPPLE_EVERY) {
      this.#lastPourRipple = this.#clock;
      const landing = (bambooPourLanding(this.#angle) - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
      this.#addRipple(
        landing + 0.08 * (this.#random() - 0.5),
        0.3 * (this.#random() - 0.5),
        0.4 + 0.6 * Math.min(1, this.#outflow / POUR_FULL),
      );
    }

    // Leaves let go: a few in still air, many more in a gust.
    const amount = this.#leafAmount;
    if (amount > 0) {
      const chance = amount * (RELEASE_CALM + RELEASE_GUST * this.#gustMean) * total;
      if (this.#random() < chance) this.#release(aspect, this.#random() < NEAR_SHARE);
    }
    this.#stepLeaves(total, aspect);
  }

  #stepGrove(aspect: number): void {
    const t = this.#clock;
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    const speed = windSpeed(this.#wind);
    const half = aspect / 2;
    let gustSum = 0;
    let counted = 0;
    for (const culm of this.#culms) {
      const along = heading * culm.x * SKEW_COS + culm.depth * SKEW_SIN;
      const breeze =
        0.28 +
        0.12 * Math.sin(BREEZE_LONG * (along - speed * t)) +
        0.08 * Math.sin(BREEZE_SHORT * (along - 0.8 * speed * t) + 1.7);
      const gust = this.#gustAt(culm.x, culm.depth);
      const target = sway * (heading * breeze + gust) + culm.push;
      culm.swayWas = culm.sway.x;
      springStep(culm.sway, target, culm.omega, CULM_DAMPING, GROVE_STEP);
      culm.gust = Math.min(1, Math.abs(gust));
      if (culm.layer >= 1 && culm.layer <= 3 && Math.abs(culm.x / culm.depth) < half) {
        gustSum += culm.gust;
        counted++;
      }
    }
    this.#gustMean = counted > 0 ? gustSum / counted : 0;
  }

  /** One step of the tube; returns the fill poured out over it. */
  #stepTube(h: number, inflow: number, aspect: number): number {
    const mass = WATER_MASS * this.#fill;
    const upright = smoothstep(-0.2, 0.25, this.#angle);
    const settle = waterDown(this.#fill) + (waterUp(this.#fill) - waterDown(this.#fill)) * upright;
    this.#slosh = approach(this.#slosh, settle, h, SLOSH_TIME);
    const inertia = TUBE_INERTIA + mass * this.#slosh * this.#slosh;
    let torque =
      -GRAVITY * Math.cos(this.#angle) * (TUBE_MOMENT + mass * this.#slosh) -
      (PIVOT_DAMPING + WATER_DRAG * mass) * this.#spin;
    const pad = 1 - this.#knock;
    if (pad > 0 && this.#spin > 0) {
      // Coming back down onto the moss: the deeper it squashes the pad, the harder the pad holds it back.
      const squash = Math.min(
        1,
        Math.max(0, (this.#angle - BAMBOO_TUBE.rest + PAD_SPAN) / PAD_SPAN),
      );
      torque -= PAD_DAMPING * pad * squash * this.#spin;
    }
    this.#spin += (torque / inertia) * h;
    this.#angle += this.#spin * h;

    if (this.#angle >= BAMBOO_TUBE.rest) {
      // The closed end comes down on the stone.
      this.#angle = BAMBOO_TUBE.rest;
      if (this.#spin > CLACK_MIN) {
        this.#clack(Math.min(1, this.#spin / CLACK_FULL), aspect);
        this.#spin *= -RESTITUTION * this.#knock;
      } else if (this.#spin > 0) {
        this.#spin = 0;
      }
    } else if (this.#angle <= BAMBOO_TUBE.low) {
      this.#angle = BAMBOO_TUBE.low;
      if (this.#spin < 0) this.#spin *= -SOFT_RESTITUTION;
    }

    // The mouth holds less as it dips; what it cannot hold pours out.
    this.#fill = Math.min(1, this.#fill + inflow * h);
    const holds = smoothstep(-0.12, 0.22, this.#angle);
    const out = POUR_RATE * Math.max(this.#fill - holds, 0) * h;
    this.#fill -= out;
    return out;
  }

  #clack(strength: number, aspect: number): void {
    this.#clackAt = this.#clock;
    this.#clackStrength = strength;
    // The knock carries through the stones: a soft ring across the basin.
    this.#addRipple(0, 0, 0.45 * strength);
    // A full clack sometimes startles a leaf above the basin into letting go.
    if (strength > 0.6 && this.#leafAmount > 0 && this.#random() < 0.3 + 0.6 * this.#leafAmount)
      this.#release(aspect, true);
  }

  #addRipple(u: number, v: number, strength: number): void {
    const ripple = this.#ripples[this.#nextRipple];
    if (!ripple) return;
    ripple.u = u;
    ripple.v = v;
    ripple.born = this.#clock;
    ripple.strength = strength;
    this.#nextRipple = (this.#nextRipple + 1) % BAMBOO_RIPPLES;
  }

  /** A leaf lets go of the canopy: above the basin (near) or anywhere in the grove. */
  #release(aspect: number, near: boolean): void {
    let leaf: Leaf | undefined;
    for (const candidate of this.#leaves) {
      if (candidate.state === "free") {
        leaf = candidate;
        break;
      }
    }
    if (!leaf) return;
    const random = this.#random;
    const heading = this.#wind < 0 ? -1 : 1;
    const right = aspect / 2;
    const z = near ? BAMBOO_DEVICE_DEPTH : LEAF_NEAR * (LEAF_FAR / LEAF_NEAR) ** random();
    const top = 0.88 + 0.14 * random();
    leaf.y = BAMBOO_EYE + (top - BAMBOO_HORIZON) * z;
    leaf.z = z;
    leaf.near = near;
    let across: number;
    if (near) {
      // Aim upwind of the basin by the drift the fall will bring, give or take.
      const k = bambooDeviceScale(aspect);
      const water = BAMBOO_EYE + (k * BAMBOO_BASIN.y - BAMBOO_HORIZON) * z;
      const fall = (leaf.y - water) / (LEAF_SINK + (LEAF_DIVE * 2) / Math.PI);
      const drift = (heading * (0.1 + 0.35 * windSway(this.#wind) * 0.5) * fall) / z;
      across = right + k * BAMBOO_BASIN.x - drift + (random() - 0.5) * 0.14 * k;
    } else {
      across = (random() * 2 - 1) * (right + 0.1) - heading * 0.1;
    }
    leaf.x = across * z;
    leaf.phase = random() * TAU;
    leaf.swingRate = TAU / (2.2 + 1.2 * random());
    leaf.swing = 0.12 + 0.1 * random();
    leaf.spin = random() * TAU;
    leaf.spinRate = (0.5 + 0.8 * random()) * (random() < 0.5 ? -1 : 1);
    leaf.tilt = (random() - 0.5) * 0.6;
    leaf.size = near ? 0.075 + 0.03 * random() : 0.1 + 0.06 * random();
    leaf.age = 0;
    leaf.state = "falling";
  }

  #stepLeaves(h: number, aspect: number): void {
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    const right = aspect / 2;
    const k = bambooDeviceScale(aspect);
    const pouring = Math.min(1, this.#outflow / POUR_FULL);
    const landing = (bambooPourLanding(this.#angle) - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
    for (const leaf of this.#leaves) {
      switch (leaf.state) {
        case "free":
          break;
        case "falling": {
          leaf.age += h;
          // A falling leaf swings side to side like a pendulum, diving through the middle of each
          // swing and stalling at its ends, while the wind carries it along.
          const gust = Math.abs(this.#gustAt(leaf.x, leaf.z));
          leaf.phase += leaf.swingRate * h;
          const c = Math.cos(leaf.phase);
          const drift = heading * (0.1 + 0.35 * sway * (0.4 + gust));
          leaf.x += (drift + leaf.swing * leaf.swingRate * c) * h;
          leaf.y -= (LEAF_SINK + LEAF_DIVE * Math.abs(c)) * h;
          leaf.spin += leaf.spinRate * h;
          const sx = leaf.x / leaf.z;
          const sy = BAMBOO_HORIZON + (leaf.y - BAMBOO_EYE) / leaf.z;
          if (Math.abs(sx) > right + 0.3) {
            leaf.state = "free";
          } else if (leaf.near) {
            if (sy / k <= BAMBOO_BASIN.y + 0.004) {
              const u = ((sx - right) / k - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
              // Onto the water while the water clock stands; else on down out of the frame.
              if (this.#clockOn && Math.abs(u) < 0.8) {
                leaf.state = "floating";
                leaf.age = 0;
                leaf.u = u;
                leaf.v = (this.#random() - 0.5) * 0.7;
                leaf.turn = leaf.tilt + 0.6 * Math.sin(leaf.phase);
                this.#addRipple(leaf.u, leaf.v, 0.35);
                this.#sinkOldest();
              } else if (sy < -0.05) {
                leaf.state = "free";
              }
            }
          } else if (leaf.y <= 0) {
            leaf.y = 0;
            leaf.state = "resting";
            leaf.age = 0;
          }
          break;
        }
        case "resting":
          leaf.age += h;
          if (leaf.age > LEAF_REST + LEAF_FADE) leaf.state = "free";
          break;
        case "floating": {
          leaf.age += h;
          // A slow turn about the basin; the pour pushes it away from where the water lands.
          let du = -0.05 * leaf.v;
          let dv = 0.05 * leaf.u;
          if (pouring > 0) {
            const ox = leaf.u - landing;
            const oy = leaf.v;
            const d = Math.max(Math.hypot(ox, oy), 0.1);
            du += (0.3 * pouring * ox) / d;
            dv += (0.3 * pouring * oy) / d;
          }
          leaf.u += du * h;
          leaf.v += dv * h;
          const r = Math.hypot(leaf.u, leaf.v);
          if (r > 0.75) {
            leaf.u *= 0.75 / r;
            leaf.v *= 0.75 / r;
          }
          leaf.turn += 0.04 * h;
          if (leaf.age > FLOAT_LIFE + FLOAT_FADE) leaf.state = "free";
          break;
        }
        default: {
          const unreachable: never = leaf.state;
          throw new BambooSimError(`bamboo: unknown leaf state ${String(unreachable)}`);
        }
      }
    }
  }

  /** Too many leaves on the water: the oldest starts to sink. */
  #sinkOldest(): void {
    let floating = 0;
    let oldest: Leaf | undefined;
    for (const leaf of this.#leaves) {
      if (leaf.state !== "floating" || leaf.age >= FLOAT_LIFE) continue;
      floating++;
      if (!oldest || leaf.age > oldest.age) oldest = leaf;
    }
    if (floating > MAX_FLOATING && oldest) oldest.age = FLOAT_LIFE;
  }

  #pack(aspect: number): void {
    const grove = this.#swayData;
    const groveAlpha = this.#groveSteps.alpha;
    for (let i = 0; i < this.#culms.length; i++) {
      const culm = this.#culms[i];
      if (!culm) continue;
      grove[i * 2] = culm.swayWas + (culm.sway.x - culm.swayWas) * groveAlpha;
      grove[i * 2 + 1] = culm.gust;
    }

    const device = this.device;
    device[0] = this.#angleWas + (this.#angle - this.#angleWas) * this.#tubeSteps.alpha;
    device[1] = this.#fill / TIP_FILL;
    device[2] = Math.min(1, this.#outflow / POUR_FULL);
    device[3] = (this.#period > 0 ? 1 : 0) + (this.#gushLeft > 0 ? 1.5 : 0);
    device[4] = Math.min(this.#clock - this.#clackAt, 60);
    device[5] = this.#clackStrength;
    device[6] = 0;
    device[7] = 0;
    for (let i = 0; i < this.#ripples.length; i++) {
      const ripple = this.#ripples[i];
      if (!ripple) continue;
      const o = 8 + i * 4;
      device[o] = ripple.u;
      device[o + 1] = ripple.v;
      device[o + 2] = Math.min(this.#clock - ripple.born, 30);
      device[o + 3] = ripple.strength;
    }

    const leaves = this.leaves;
    const k = bambooDeviceScale(aspect);
    for (let i = 0; i < this.#leaves.length; i++) {
      const leaf = this.#leaves[i];
      if (!leaf) continue;
      const o = i * 8;
      switch (leaf.state) {
        case "free":
          leaves.fill(0, o, o + 8);
          break;
        case "falling":
        case "resting": {
          const falling = leaf.state === "falling";
          leaves[o] = leaf.x / leaf.z;
          leaves[o + 1] = BAMBOO_HORIZON + (leaf.y - BAMBOO_EYE) / leaf.z;
          leaves[o + 2] = falling ? leaf.tilt + 0.6 * Math.sin(leaf.phase) : leaf.tilt;
          leaves[o + 3] = leaf.size / leaf.z;
          // Lying on the ground it is seen nearly edge-on; falling it turns about its long axis.
          leaves[o + 4] = falling ? 0.35 + 0.65 * Math.abs(Math.cos(leaf.spin)) : 0.45;
          leaves[o + 5] = leaf.z;
          leaves[o + 6] = falling
            ? Math.min(1, leaf.age / LEAF_FADE_IN)
            : 1 - smoothstep(LEAF_REST, LEAF_REST + LEAF_FADE, leaf.age);
          leaves[o + 7] = 1;
          break;
        }
        case "floating":
          leaves[o] = leaf.u;
          leaves[o + 1] = leaf.v;
          leaves[o + 2] = leaf.turn;
          leaves[o + 3] = Math.min(leaf.size / (BAMBOO_DEVICE_DEPTH * k * BAMBOO_BASIN.rx), 0.6);
          leaves[o + 4] = 1;
          leaves[o + 5] = leaf.z;
          leaves[o + 6] = 1 - smoothstep(FLOAT_LIFE, FLOAT_LIFE + FLOAT_FADE, leaf.age);
          leaves[o + 7] = 2;
          break;
        default: {
          const unreachable: never = leaf.state;
          throw new BambooSimError(`bamboo: unknown leaf state ${String(unreachable)}`);
        }
      }
    }
  }
}

/**
 * A layer that draws from the grove's sim: each frame it takes the grove's latest data into its
 * own rows (and its field), where its GLSL reads them; without the grove it shows nothing moving.
 */
class GroveReader implements LayerSim {
  readonly #take: (grove: Grove, frame: LayerFrame) => void;
  #packs = -1;

  constructor(take: (grove: Grove, frame: LayerFrame) => void) {
    this.#take = take;
  }

  /** Present, so the grove sees the layer stand (LayerFrame.host). */
  get affordances(): GroveReader {
    return this;
  }

  frame(frame: LayerFrame): void {
    const grove = frame.host("grove");
    if (!(grove instanceof Grove)) return;
    const field = frame.fields[0];
    if (field) field.texture = grove.sway.texture;
    if (grove.packs === this.#packs) return;
    this.#packs = grove.packs;
    this.#take(grove, frame);
    frame.records.touch();
  }

  dispose(): void {}
}

/** The grove's sim (the grove backdrop's). */
export function groveSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new Grove(gl, params);
}

/** The culms' sim: the grove's sway as its field, the leaves in the air as its row. */
export function culmsSim(): LayerSim {
  return new GroveReader((grove, frame) => frame.records.data.set(grove.leaves));
}

/** The water clock's sim: the tube, the clack and the rings as its first row, the leaves as its second. */
export function clockSim(): LayerSim {
  return new GroveReader((grove, frame) => {
    frame.records.data.set(grove.device);
    frame.records.data.set(grove.leaves, ATLAS_WIDTH * 4);
  });
}
