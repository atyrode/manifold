// A dewy orb web at dawn: a Verlet net (sims/verlet.ts) spun between two grass stems, billowing out
// of its plane in the breeze, and the big drops of dew on it, kept here on the CPU.
//
// The web is built the way an orb weaver builds hers: radii and a capture spiral (VerletSystem
// addWeb), the radii tied to a polygon of frame threads, the frame's corners moored to the stems
// (and one to a twig above the frame). The stems are kinematic: they nod in the breeze and their
// mooring points glide with them, so the whole web shifts gently; the breeze itself presses on every
// point out of the web's plane, with a slow ripple running across, and the weight of the big drops
// pulls on the threads they hang from (they spring back when a drop lets go).
//
// Dew: every thread carries a wetness 0..1 that sets the beads strung along it (drawn by the shader
// from a hash of the segment and the bead's index, so they cost nothing here). Big drops are a small
// pool: one condenses where the beads are heavy (taking them up), grows, and once heavy enough for
// the thread's slope it creeps downhill, sweeping up the beads in its path (the thread behind it is
// left bare, and slowly beads up again), turns onto the steepest way down at each crossing, merges
// with drops it meets and falls when it gets too heavy, is shaken loose by a gust or a pluck, or
// hangs at a low point too long.
//
// The scene's passage (DEW_PASSAGE, #swingWeb): the web is drawn swung on a long pendulum above the
// frame. It comes in from beyond the right edge on its anchor threads, the moorings staying on their
// stems so the threads stretch, over the middle with a small overshoot, settling as a gust dies away;
// a gust swings it out the same way at the exit. The Verlet net itself is not moved, no drop is shaken
// loose while it swings, and at rest none of this runs.
//
// Textures (all nearest, read with texelFetch):
//   uSim0  rgba16f segments, DEW_SEG_TEXELS texels each, DEW_SEG_ROW per row; segment s starts at
//          (3 (s % DEW_SEG_ROW), s / DEW_SEG_ROW). Positions are split hi + lo (hi a multiple of
//          1/64, exact in half floats, lo the remainder) so threads stay put to a hundredth of a cell:
//          t0 = (a.x, a.y, b.x, b.y) hi; t1 = the same, lo; t2 = (a.z, b.z, wet, code). Threads:
//          wet = round(wetness × DEW_WET_LEVELS) + 0.5 + 0.45 × dry, where dry > 0 means beads at
//          t < dry are gone and dry < 0 beads at t > -dry (a drop is sweeping the thread); code =
//          kind × DEW_CODE + beads along it. Stems (stalk, leaf blades, seed head, awns; sim.ts
//          #packStems): wet = the radius at b in DEW_STEM_UNIT + DEW_CODE × the piece (DEW_PIECE_*),
//          code = kind × DEW_CODE + the radius at a in DEW_STEM_UNIT.
//   uSim1  r16f bins (sims/bins.ts BinLists): a grid of square bins one 1/rows of the frame height
//          across, from the frame's bottom-left corner, each listing what reaches into it: s + 1 for
//          segment s, -(d + 1) for drop d, 0 ends the list. As many pages of BIN_PAGE entries as the
//          fullest bin needs (header t2.z), so the hub, where every radius meets, keeps them all.
//   uSim2  rgba16f drops, two texels each: (x, y) hi, (x, y) lo of the centre; (radius, z,
//          stretch, squash). Radius 0 = no drop.
//   uSim3  rgba16f header: t0 = hub (x, y) hi, lo; t1 = (hub z, focus z, the hub's turn (radians),
//          web radius); t2 = (gust 0..1, breeze 0..1, pages of bin lists, 0).
//
// Units: frame heights, x from the frame's left edge, y up from its bottom, z toward the viewer.
import { KnobReader, type ParamDef } from "../../params.ts";
import { BinLists } from "../../sims/bins.ts";
import { BuildSlot } from "../../sims/build.ts";
import { FixedStep } from "../../sims/clock.ts";
import { approach } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { VerletForce, VerletStepOptions } from "../../sims/verlet.ts";
import type { PrincipalState, SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  BEAD_SPACING,
  breezeAt,
  breezePush,
  CORNER_REACH,
  CORNER_REACH_JITTER,
  DAMPING,
  DEW_CODE,
  DEW_KIND_FRAME,
  DEW_KIND_SPIRAL,
  DEW_KIND_SPOKE,
  DEW_KIND_STEM,
  type DewAir,
  DewError,
  DewWeb,
  type DewWebState,
  dewSpin,
  GRAVITY,
  GUST_SECONDS,
  gustLevel,
  ITERATIONS,
  stemAt,
  SUBSTEP,
  swayStems,
  TAU,
} from "./build.ts";
import { DEW_PASSAGE } from "./constants.ts";

// ---- shared with the shader -----------------------------------------------------------------------

export const DEW_SEG_TEXELS = 3;
export const DEW_SEG_ROW = 512;
export const DEW_DROPS = 48;
/** A stem's radius unit in its code, frame heights. */
export const DEW_STEM_UNIT = 1 / 4000;
/** What a stem capsule is: the stalk, a leaf blade, the seed head's spindle, an awn (a bristle of the head). */
export const DEW_PIECE_STALK = 0;
export const DEW_PIECE_LEAF = 1;
export const DEW_PIECE_HEAD = 2;
export const DEW_PIECE_AWN = 3;
export const DEW_WET_LEVELS = 31;
/** Depth of field: blur radius (frame heights) per unit of depth off the focus at full knob; its cap. */
export const DEW_DOF = 1.2;
export const DEW_BLUR_MAX = 0.01;
/**
 * Bead radius (frame heights) on a fully wet capture thread in the heaviest dew, before its own
 * ±15%: 2–3 cells at 540 rows, so a bead reads as a bead (a lit body and a spark) under the dither.
 */
export const DEW_BEAD_R = 0.0045;
/** Bead radius by kind (spoke, spiral, frame): the dry radii and frame carry finer dew. */
export const DEW_BEAD_SCALE = [0.75, 1, 0.85] as const;
/** Share of a thread's bead places that hold a bead, by kind: base + slope × dew. The sticky spiral nearly all. */
export const DEW_PRESENCE_BASE = [0.35, 0.75, 0.5] as const;
export const DEW_PRESENCE_DEW = [0.35, 0.25, 0.3] as const;
/** Share of their radius beads and big drops hang below their thread. */
export const DEW_BEAD_HANG = 0.3;
export const DEW_DROP_HANG = 0.55;
/** Thread half-widths in cells (radii and spiral, frame and moorings) and how much a glint swells them. */
export const DEW_SILK_HALF = 0.5;
export const DEW_FRAME_HALF = 0.6;
export const DEW_GLINT_SWELL = 0.6;

// ---- the passage ------------------------------------------------------------------------------------

/**
 * The spider's walk down the top radius to the hub, in seconds into the entrance (she sets off and
 * arrives), and where she starts (web radii above the hub). The M she weaves there finishes with the entrance.
 */
export const DEW_WALK = { from: 0.7, to: 2.4, start: 1.25 } as const;
/** The swing's pendulum: its length above the hub (frame heights), and the angle's phase (radians) that brings the web over the middle a third of the way through. */
const SWING_LENGTH = 6;
const SWING_PHI = 4.9;
/** Seconds the lowest points of the web lag the highest, and the room (frame heights) left beyond the frame's edge when the web is out: just enough that none of it shows (its perspective and blur included), so the swing is in sight from the first moment of the entrance to the last of the exit. */
const SWING_LAG = 0.16;
const SWING_MARGIN = 0.05;
/** The gusts of the entrance (as it dies away) and the exit (as it takes hold), × a full gust's pressure. */
const ENTER_GUST = 0.7;
const EXIT_GUST = 0.9;

/** Largest bead radius the shader can draw for a kind at this dew (its own variation peaks at 1.15). */
export function dewBeadMax(kind: number, dew: number): number {
  return DEW_BEAD_R * (DEW_BEAD_SCALE[kind] ?? 1) * (0.55 + 0.45 * dew) * 1.15;
}

// ---- the web ----------------------------------------------------------------------------------------

/** The most web substeps a frame catches up (0.1 s). */
const MAX_SUBSTEPS = 48;
/**
 * The drops' own fixed step (s), and the most a frame catches up: its 0.1 s and the step left over,
 * so no time is ever dropped and the drops' clock keeps pace with the breeze's. Every draw of their
 * chance (a drop letting go, a new one gathering, a natural gust) is made a step at a time, at the
 * step's own time, so a seed plays out the same at any frame rate; at 60 Hz a step is a frame.
 */
const DROP_STEP = 1 / 60;
const MAX_DROP_STEPS = 7;
/** Seconds of drop life a new web fast-forwards (#adopt), and the step. */
const PREWARM_DROPS = 50;
const PREWARM_DROP_STEP = 0.25;
/**
 * The frame shape the opening web (the scene's own seed) is spun for and gathers its dew on, before
 * it is spun again for the frame's own shape keeping that dew (DewSim #respin).
 */
const OPENING_ASPECT = 16 / 9;
/**
 * Milliseconds a new frame shape must rest before the web respins for it (a dragged window edge),
 * as the garden waits before it re-lays; the web on show stays up meanwhile.
 */
const RESPIN_MS = 220;
/**
 * Camera distance in frame heights: a point swinging toward the viewer grows by z / distance. Far,
 * so the out-of-plane breathing shows as focus and glints rather than as threads sliding about.
 */
const CAMERA_DISTANCE = 10;

// ---- breeze -----------------------------------------------------------------------------------------

/** Seconds between natural gusts at breeze 0 and 1. */
const GUST_RARE = 80;
const GUST_OFTEN = 24;

// ---- drops ------------------------------------------------------------------------------------------

/** A drop of this radius on a vertical thread pulls with 1 against the pinning PIN (contact-angle hysteresis). */
const R_SLIDE = 0.006;
const PIN = 0.4;
/** Creeping speed (frame heights/s per unit of excess pull), and the time it takes to get going. */
const SLIDE_SPEED = 0.012;
const SLIDE_EASE = 0.8;
/** At a crossing a drop only goes on down a thread at least this steep; turning keeps this much speed. */
const SLOPE_MIN = 0.15;
const CORNER_KEEP = 0.6;
/** Radius at which a drop falls at once (about 9 cells across); above R_HANG one parked at a low point lets go after ~HANG s. */
const R_FALL = 0.0085;
const R_HANG = 0.007;
const HANG_SECONDS = 15;
/** Condensation onto a drop: r³ per second at dew 1. */
const GROW = 7e-9;
/** With more drops than the dew feeds (it was turned down) they dry: r³ per second; gone below R_GONE. */
const EVAPORATE = 4e-8;
const R_GONE = 0.002;
/** A new drop's radius (about 5 cells across once gathered), how long it takes to gather, the share of its thread's beads it takes up. */
const SPAWN_R = 0.0045;
const BIRTH_SECONDS = 3;
const SPAWN_TAKE = 0.6;
/** Seconds between new drops while the web holds fewer than its share. */
const SPAWN_GAP = 2.2;
/** Beads regrow: wetness per second at dew 0 and the extra at dew 1. */
const WET_REGROW = 0.01;
const WET_REGROW_DEW = 0.03;
/** Fall: gravity (frame heights/s²) and the upward kick its thread gets from a drop of R_FALL. */
const FALL_GRAVITY = 1.4;
const RECOIL = 0.2;
const RECOIL_RADIUS = 0.04;
/** A drop of R_FALL weighs this much on its thread (frame heights/s² on the two points). */
const WEIGHT = 0.25;
/** Thread speed (frame heights/s) that shakes a drop of R_FALL loose (smaller drops need (R_FALL / r)² more). */
const SHAKE_FALL = 0.35;
/** Wobble: amplitude per unit thread speed, its cap, the kick a merge gives, decay (s) and frequency (Hz). */
const SHIVER_GAIN = 0.3;
const SHIVER_MAX = 0.2;
const SHIVER_MERGE = 0.1;
const SHIVER_DECAY = 1;
const SHIVER_HZ = 1.2;
/** During a gust, drops bigger than this may be blown off, at up to GUST_SHED per second for a drop of R_FALL. */
const GUST_SHED_R = 0.005;
const GUST_SHED = 0.25;

// ---- the pointer ------------------------------------------------------------------------------------

/** A pluck: reach and out-of-plane kick (frame heights/s); dragging strums every STRUM_STEP with STRUM_V. */
const PLUCK_RADIUS = 0.05;
const PLUCK_V = 1.2;
const PLUCK_PULL = 0.25;
const STRUM_STEP = 0.03;
const STRUM_V = 0.5;
/** Drops within this reach of a pluck shiver, and heavy ones may drop. */
const PLUCK_SHAKE = 0.12;

// ---- bins -------------------------------------------------------------------------------------------

/**
 * About this many cells per bin, between these many rows; a bin's list grows by pages of BIN_PAGE
 * entries up to BIN_PAGES. At 540 rows the fullest bin of a 16:9 frame holds about 26 entries; small
 * or portrait frames, where the web's threads lie a few cells apart, need two or three pages near
 * the hub (four below about 90 rows).
 */
const BIN_CELLS = 14;
const BIN_ROWS_MIN = 12;
const BIN_ROWS_MAX = 64;
const BIN_PAGES = 4;

// ---- helpers ----------------------------------------------------------------------------------------

/** The part of x a half float holds exactly (a multiple of 1/64); the shader adds the remainder back. */
function hi(x: number): number {
  return Math.floor(x * 64) / 64;
}

/** The swing's progress 0..1 (1: carried out of frame, 0: at rest) on the way in: out of frame, over the middle in about a third of the time, a small overshoot, then to rest with no velocity. */
function swingIn(u: number): number {
  const r = 1 - u;
  return r * r * Math.cos(SWING_PHI * u);
}

/** The swing's progress on the way out: from rest with no velocity, gathering speed as the gust takes it; 1 is out of frame. */
function swingOut(u: number): number {
  return u * u * (0.8 + 0.2 * u);
}

const STEM_SEGMENTS = 10;
const LEAF_SEGMENTS = 5;
const HEAD_SEGMENTS = 4;
/** The seed head's radius at each of its joints (the first is the stalk's own tip), then the awns' length, spread off the head (radians) and radius. */
const HEAD_RADII: readonly number[] = [0, 0.0052, 0.0056, 0.0042, 0.0008];
const AWN_LENGTH = 0.022;
const AWN_SPREAD = 0.55;
const AWN_RADIUS = 0.0012;

/** A leaf blade's half-width along it (t: 0 at the stalk, 1 at the tip), as a share of its full half-width: narrow at the base, widest a quarter along, then drawn out to a point. */
function leafProfile(t: number): number {
  return (0.6 + 0.4 * Math.min(1, t * 4)) * Math.pow(1 - t, 0.7);
}

// ---- the simulation ---------------------------------------------------------------------------------

type DewKnob = "breeze" | "dew" | "dof" | "webSeed";

const RIDING = 1;
const FALLING = 2;
/** What the sim hands the renderer before its first web is up: nothing (the shader draws no web). */
const NO_TEXTURES: readonly (WebGLTexture | undefined)[] = [
  undefined,
  undefined,
  undefined,
  undefined,
];

class DewSim implements SceneSim {
  readonly #knobs: KnobReader<DewKnob>;
  /** The trigger slot of the breeze's "now" (a gust). */
  readonly #gustSlot: number;
  readonly #segTex: DataTexture;
  readonly #binTex: DataTexture;
  readonly #dropTex: DataTexture;
  readonly #headTex: DataTexture;
  #segData = new Float32Array(4);
  /** What reaches into each bin of the frame, for uSim1. */
  readonly #lists = new BinLists(BIN_PAGES);
  readonly #dropData = new Float32Array(DEW_DROPS * 2 * 4);
  readonly #headData = new Float32Array(3 * 4);
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined, undefined];

  /** The web on show; undefined until the first one lands. */
  #web: DewWeb | undefined;
  /** Spinning webs on the build worker (sims/build.ts): the opening one, a new seed's, a new shape's. */
  readonly #spinning = new BuildSlot(dewSpin);
  /** The scene's own seed: its web opens the scene (#respin). */
  readonly #openingSeed: number;
  /** A new frame shape (its aspect) waiting to rest RESPIN_MS before the web respins for it, since when (ms). */
  #pendingAspect = 0;
  #pendingSince = 0;
  /** Whether a web has been on show for the frame's shape: until then the sim is not ready. */
  #fitted = false;
  /**
   * The drops' chance, reseeded with every web and drawn only on the drops' fixed steps (and by
   * plucks), so a seed always plays out the same, at any frame rate.
   */
  #rand = mulberry32(0);
  /** Extra force per point this frame: the weight of the drops (y). */
  #load = new Float32Array(1);
  readonly #opts: VerletStepOptions;
  /** The web's clock: whole substeps of SUBSTEP, the drawn web blended by its alpha. */
  readonly #steps = new FixedStep(SUBSTEP, MAX_SUBSTEPS);
  /** The drops' steps: whole steps of DROP_STEP, the drops drawn ahead of the last by its pending. */
  readonly #dropSteps = new FixedStep(DROP_STEP, MAX_DROP_STEPS);
  /** The moment of the drops' last step: their steps taken, in seconds of the breeze's clock. */
  #dropClock = 0;
  /** The web's blend (its clock's alpha) as a drop lets go: at its drop step, or the frame's end. */
  #recoilBlend = 0;
  #fz = 0;
  #fx = 0;

  /** Motion-scaled clock of the breeze and the drops. */
  #clock = 0;
  #breeze = 0;
  #dew = 0;
  #dof = 0;
  #gustAt = -1e4;
  #gustAmp = 1;
  #nextGust = 30;
  #gust = 0;
  #focus = 0;
  #strumX = 0;
  #strumY = 0;
  #prewarming = false;

  // The passage (see #swingWeb): the progress of the entrance and exit, whether either is playing, and
  // whether the gust of each has been blown.
  #enter = 1;
  #exit = 0;
  #passing = false;
  #born = false;
  #leaving = false;

  // The drop pool (structure of arrays).
  readonly #state = new Uint8Array(DEW_DROPS);
  readonly #seg = new Int32Array(DEW_DROPS);
  readonly #t = new Float32Array(DEW_DROPS);
  /** End of its thread a riding drop came in by, or gathered at: 0 at a, 1 at b. */
  readonly #from = new Uint8Array(DEW_DROPS);
  /** Speed along the thread, frame heights/s, positive toward b. */
  readonly #v = new Float32Array(DEW_DROPS);
  readonly #r = new Float32Array(DEW_DROPS);
  readonly #birth = new Float32Array(DEW_DROPS);
  readonly #shiver = new Float32Array(DEW_DROPS);
  readonly #phase = new Float32Array(DEW_DROPS);
  /** Centre (drawn, or falling) and fall velocity. */
  readonly #x = new Float32Array(DEW_DROPS);
  readonly #y = new Float32Array(DEW_DROPS);
  readonly #z = new Float32Array(DEW_DROPS);
  readonly #vx = new Float32Array(DEW_DROPS);
  readonly #vy = new Float32Array(DEW_DROPS);
  #spawnIn = 0;
  readonly #vel = new Float32Array(3);
  readonly #vel2 = new Float32Array(3);
  readonly #at = new Float64Array(3);

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<DewKnob>) {
    this.#knobs = knobs;
    this.#gustSlot = knobs.trigger("breeze");
    this.#segTex = new DataTexture(gl, {
      width: DEW_SEG_ROW * DEW_SEG_TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    // Sized to the bin lists before each upload.
    this.#binTex = new DataTexture(gl, { width: 1, height: 1, format: "r16f", filter: "nearest" });
    this.#dropTex = new DataTexture(gl, {
      width: DEW_DROPS * 2,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#headTex = new DataTexture(gl, {
      width: 3,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#openingSeed = Math.round(knobs.initial("webSeed"));
    this.#opts = {
      gravity: [0, GRAVITY, 0],
      damping: DAMPING,
      iterations: ITERATIONS,
      force: this.#force,
    };
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#breeze = Math.max(0, knobs.value(frame, "breeze"));
    this.#dew = Math.min(1, Math.max(0, knobs.value(frame, "dew")));
    this.#dof = Math.max(0, knobs.value(frame, "dof"));
    const aspect = Number.isFinite(frame.aspect) && frame.aspect > 0 ? frame.aspect : 16 / 9;
    const seed = Math.round(knobs.value(frame, "webSeed"));
    this.#respin(frame.now, frame.budget, aspect, seed);
    // Nothing shows, and no clock runs, until a web for the frame's shape is up.
    if (!this.#fitted) return NO_TEXTURES;
    this.#fitBins(frame.height, aspect);

    // The passage: the web swings in on its anchor threads as a gust settles, and out again on another.
    // None of it runs at rest, and the web's own simulation is untouched.
    const enter = Math.min(1, Math.max(0, frame.passage.enter));
    const exit = Math.min(1, Math.max(0, frame.passage.exit));
    if (!this.#born) {
      this.#born = true;
      if (enter < 1) this.#blow(GUST_SECONDS - DEW_PASSAGE.enter, ENTER_GUST);
    }
    if (exit > 0 && !this.#leaving) {
      this.#leaving = true;
      this.#blow(0, EXIT_GUST);
    }
    this.#enter = enter;
    this.#exit = exit;
    this.#passing = enter < 1 || exit > 0;

    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const sdt = dt * Math.min(1, Math.max(0, frame.motion));
    if (frame.fired[this.#gustSlot] === true) {
      this.#gustAt = this.#clock;
      this.#gustAmp = 1;
    }
    this.#advance(sdt);
    if (!this.#passing) this.#play(frame.pointer, aspect);

    this.#pack(frame.height);
    this.#textures[0] = this.#segTex.texture;
    this.#textures[1] = this.#binTex.texture;
    this.#textures[2] = this.#dropTex.texture;
    this.#textures[3] = this.#headTex.texture;
    return this.#textures;
  }

  ready(): boolean {
    return this.#fitted;
  }

  dispose(): void {
    this.#spinning.dispose();
    this.#segTex.dispose();
    this.#binTex.dispose();
    this.#dropTex.dispose();
    this.#headTex.dispose();
  }

  // ---- building -----------------------------------------------------------------------------------

  /** The breeze as it stands, for a web spun now. */
  #air(): DewAir {
    return {
      clock: this.#clock,
      breeze: this.#breeze,
      gustAt: this.#gustAt,
      gustAmp: this.#gustAmp,
    };
  }

  /**
   * The web for the frame's shape and the seed, spun on the build worker while the web on show (if
   * any) stays up. The opening web, the scene's own seed, is spun for the usual landscape frame
   * (OPENING_ASPECT) and its dew gathered there (#adopt); then, as for every web until one fits the
   * frame, the frame's own shape is spun at once, keeping the dew. Another seed is spun for the
   * frame's shape at once. A new shape after that waits until it has rested RESPIN_MS (a dragged
   * window edge); a newer shape supersedes it, and the shape coming back to the web's own drops it.
   * Twice at most a frame: the opening web, landing at once (no worker, or an Infinity budget), is
   * spun for the frame's shape in the same frame.
   */
  #respin(now: number, budget: number, aspect: number, seed: number): void {
    for (let pass = 0; pass < 2; pass++) {
      this.#ask(now, aspect, seed);
      const landed = this.#spinning.advance(budget);
      if (landed === undefined) return;
      const web = this.#adopt(landed.result, this.#web);
      if (Math.abs(aspect - web.aspect) <= 1e-3) {
        this.#fitted = true;
        return;
      }
    }
  }

  /** Ask the spinning slot for the web this frame wants next, if any (see #respin). */
  #ask(now: number, aspect: number, seed: number): void {
    const web = this.#web;
    if (web === undefined || seed !== web.seed) {
      const opening = web === undefined && seed === this.#openingSeed;
      this.#spin(opening ? OPENING_ASPECT : aspect, seed);
    } else if (Math.abs(aspect - web.aspect) <= 1e-3) {
      this.#spinning.cancel();
      this.#fitted = true;
    } else if (!this.#fitted) {
      this.#spin(aspect, seed);
    } else {
      if (aspect !== this.#pendingAspect) {
        this.#pendingAspect = aspect;
        this.#pendingSince = now;
      }
      if (now - this.#pendingSince >= RESPIN_MS) this.#spin(aspect, seed);
    }
  }

  /** Spin a web for this shape and seed (the one asked for already, or landed last, goes on). */
  #spin(aspect: number, seed: number): void {
    this.#spinning.request(`${aspect}|${seed}`, { aspect, seed, air: this.#air() });
  }

  /** The web on show; only asked for while one is (the sim does nothing before the first lands). */
  get #shown(): DewWeb {
    const web = this.#web;
    if (web === undefined) throw new DewError("dew: no web is on show yet");
    return web;
  }

  /**
   * A spun web (dewSpin) on show, its dew fast-forwarded so the first frame already glistens. Spun
   * again for a new frame shape (`from`, the same seed), it keeps its dew: a web's threads are the
   * same, thread for thread, at any size (the frame polygon scales about the hub with the radius),
   * so every drop stays on its thread at its place along it, as large and as far gathered, and every
   * thread as wet and as bared; only the web around them moves to the new frame.
   */
  #adopt(state: DewWebState, from: DewWeb | undefined): DewWeb {
    const web = new DewWeb(state);
    const keep =
      from !== undefined &&
      from.seed === web.seed &&
      from.threads === web.threads &&
      from.kind.every((kind, c) => web.kind[c] === kind);
    this.#passing = false;
    this.#web = web;
    this.#load = new Float32Array(web.sys.count);
    this.#prewarming = true;
    // The breeze as the spin left it (as #weather leaves it): the drops' fast-forward reads its gust.
    const air = breezeAt(this.#air());
    this.#gust = air.gust;
    this.#fx = air.fx;
    this.#fz = air.fz;
    this.#steps.reset();
    this.#focus = (web.sys.positions[web.layout.hub * 3 + 2] ?? 0) * 0.8;
    if (keep) {
      web.wet.set(from.wet);
      web.dry.set(from.dry);
      for (let d = 0; d < DEW_DROPS; d++) {
        if (this.#state[d] === RIDING) this.#place(d);
        else this.#state[d] = 0;
      }
    } else {
      // Seed some dew already gathered into drops, then let them run for a while.
      this.#rand = mulberry32((Math.imul(web.seed + 7, 0x85ebca6b) ^ 0x6472) >>> 0);
      this.#state.fill(0);
      this.#spawnIn = 0;
      for (let i = 0; i < 6; i++) this.#spawn(0.4 + 0.6 * this.#rand());
      for (let time = 0; time < PREWARM_DROPS; time += PREWARM_DROP_STEP)
        this.#drops(PREWARM_DROP_STEP, this.#gust);
      for (let d = 0; d < DEW_DROPS; d++) if (this.#state[d] === FALLING) this.#state[d] = 0;
    }
    this.#prewarming = false;
    return web;
  }

  #fitBins(heightCells: number, aspect: number): void {
    const rows = Math.min(
      BIN_ROWS_MAX,
      Math.max(BIN_ROWS_MIN, Math.round(heightCells / BIN_CELLS)),
    );
    this.#lists.fit(rows, Math.ceil(aspect * rows));
  }

  // ---- the breeze ---------------------------------------------------------------------------------

  /** Breeze, gusts and the stems' nodding for the clock as it stands; moves the moorings. */
  #weather(): void {
    const air = breezeAt(this.#air());
    this.#gust = air.gust;
    this.#fz = air.fz;
    this.#fx = air.fx;
    swayStems(this.#shown, this.#clock, this.#breeze, this.#gust, this.#at);
  }

  /** Breeze pressure (out of plane, a ripple running across) and the drops' weight. */
  readonly #force: VerletForce = (i, x, y, _z, out) =>
    breezePush(out, x, y, this.#shown.sys.time, this.#fx, this.#load[i] ?? 0, this.#fz);

  /**
   * `dt` seconds of the breeze's clock. The web runs its substeps up to each of the drop layer's
   * fixed steps due (in the breeze and under the drops' weight as they stand then), the drops step
   * there, and the web runs on to the frame's end: at any frame rate the drops see the web as it
   * was at their step's moment, so a seed plays out the same. At 60 Hz that is one stretch and one
   * step, as a frame always was.
   */
  #advance(dt: number): void {
    const end = this.#clock + dt;
    const web = this.#shown;
    const webSteps = this.#steps;
    const substeps = webSteps.advance(dt);
    const dropSteps = this.#dropSteps;
    const n = dropSteps.advance(dt);
    let ran = 0;
    for (let s = 0; s <= n; s++) {
      // After the last drop step, only the substeps left (or, with none due at all, the frame's).
      if (s === n && n > 0 && ran === substeps) break;
      const lag = s < n ? dropSteps.lag(s) : 0;
      let due = ran;
      while (due < substeps && webSteps.lag(due) >= lag - SUBSTEP / 2) due++;
      this.#clock = end - lag;
      this.#weather();
      this.#weigh(web);
      web.sys.step(this.#opts, due - ran);
      ran = due;
      if (s === n) break;
      // The web's blend at this moment, as a pluck has the frame's: a drop letting go kicks its
      // thread around it (#fall).
      let before = webSteps.pending;
      if (due > 0) before = webSteps.lag(due - 1);
      else if (substeps > 0) before = webSteps.lag(0) + SUBSTEP;
      this.#recoilBlend = Math.min(1, Math.max(0, (before - lag) / SUBSTEP));
      // The drops' clock counts whole steps, so their moments are the same at every frame rate.
      this.#dropClock += DROP_STEP;
      this.#dropStep(this.#dropClock);
    }
    this.#clock = end;
    this.#recoilBlend = webSteps.alpha;
    if (dt > 0) {
      // Focus follows the hub (an autofocus on the spider), lagging a little.
      const hubZ = web.sys.positions[web.layout.hub * 3 + 2] ?? 0;
      this.#focus = approach(this.#focus, hubZ * 0.8, dt, 1.5);
    }
  }

  /** The riding drops hang their weight on their threads' two points (#load, read by #force). */
  #weigh(web: DewWeb): void {
    const load = this.#load;
    load.fill(0);
    const ca = web.sys.constraintA;
    const cb = web.sys.constraintB;
    for (let d = 0; d < DEW_DROPS; d++) {
      if (this.#state[d] !== RIDING) continue;
      const c = this.#seg[d] ?? 0;
      const t = this.#t[d] ?? 0;
      const k = (this.#r[d] ?? 0) / R_FALL;
      const w = WEIGHT * k * k * k;
      const a = ca[c] ?? 0;
      const b = cb[c] ?? 0;
      load[a] = (load[a] ?? 0) - w * (1 - t);
      load[b] = (load[b] ?? 0) - w * t;
    }
  }

  /**
   * One step of the drop layer at `time` on the breeze's clock: a natural gust now and then (the more
   * often the stronger the breeze), the drops riding, letting go and gathering in the gust as it
   * stands then, the beads growing back, and the drops' wobble dying away.
   */
  #dropStep(time: number): void {
    const h = DROP_STEP;
    const breeze = this.#breeze;
    if (breeze > 0.02 && time >= this.#nextGust) {
      this.#gustAt = time;
      this.#gustAmp = 0.35 + 0.35 * this.#rand();
      this.#nextGust =
        time + (GUST_RARE + (GUST_OFTEN - GUST_RARE) * breeze) * (0.6 + 0.8 * this.#rand());
    }
    this.#drops(h, gustLevel(time, this.#gustAt, this.#gustAmp));
    const web = this.#shown;
    const regrow = (WET_REGROW + WET_REGROW_DEW * this.#dew) * h;
    const wet = web.wet;
    for (let c = 0; c < web.threads; c++) wet[c] = Math.min(1, (wet[c] ?? 0) + regrow);
    for (let d = 0; d < DEW_DROPS; d++)
      this.#shiver[d] = (this.#shiver[d] ?? 0) * Math.exp(-h / SHIVER_DECAY);
  }

  // ---- the pointer --------------------------------------------------------------------------------

  /** Press: pluck the threads under the pointer. Drag: strum them. */
  #play(pointer: PrincipalState, aspect: number): void {
    if (!pointer.inside) return;
    const x = pointer.x * aspect;
    const y = pointer.y;
    if (pointer.pressed) {
      this.#pluck(x, y, PLUCK_V);
      this.#strumX = x;
      this.#strumY = y;
    } else if (pointer.down && Math.hypot(x - this.#strumX, y - this.#strumY) > STRUM_STEP) {
      this.#pluck(x, y, STRUM_V);
      this.#strumX = x;
      this.#strumY = y;
    }
  }

  #pluck(x: number, y: number, v: number): void {
    const sys = this.#shown.sys;
    if (sys.nearestXY(x, y, PLUCK_RADIUS * 1.5, true) < 0) return;
    sys.impulseXY(x, y, PLUCK_RADIUS, 0, -PLUCK_PULL * v, v, this.#steps.alpha);
    for (let d = 0; d < DEW_DROPS; d++) {
      if (this.#state[d] !== RIDING) continue;
      const dist = Math.hypot((this.#x[d] ?? 0) - x, (this.#y[d] ?? 0) - y);
      if (dist > PLUCK_SHAKE) continue;
      const near = 1 - dist / PLUCK_SHAKE;
      this.#shiver[d] = Math.min(
        SHIVER_MAX,
        (this.#shiver[d] ?? 0) + SHIVER_MAX * near * (v / PLUCK_V),
      );
      const k = (this.#r[d] ?? 0) / R_FALL;
      if (this.#rand() < near * k * k * 1.2 * (v / PLUCK_V)) this.#fall(d);
    }
  }

  // ---- the drops ----------------------------------------------------------------------------------

  /** The drops over `dt` seconds, in a gust of `gust` 0..1 (it shakes the heavy ones off). */
  #drops(dt: number, gust: number): void {
    const web = this.#shown;
    const sys = web.sys;
    const pos = sys.positions;
    const ca = sys.constraintA;
    const cb = sys.constraintB;
    const dew = this.#dew;
    let riding = 0;
    // More drops than the dew now feeds (it was turned down): they dry away.
    const share = Math.round(DEW_DROPS * 0.55 * dew * dew + 3 * dew);
    let held = 0;
    for (let d = 0; d < DEW_DROPS; d++) if (this.#state[d] === RIDING) held++;
    const drying = held > share ? EVAPORATE * dt : 0;
    for (let d = 0; d < DEW_DROPS; d++) {
      const state = this.#state[d];
      if (state === FALLING) {
        const vy = (this.#vy[d] ?? 0) - FALL_GRAVITY * dt;
        this.#vy[d] = vy;
        this.#vx[d] = (this.#vx[d] ?? 0) * Math.exp(-dt);
        this.#x[d] = (this.#x[d] ?? 0) + (this.#vx[d] ?? 0) * dt;
        this.#y[d] = (this.#y[d] ?? 0) + vy * dt;
        if ((this.#y[d] ?? 0) < -0.1) this.#state[d] = 0;
        continue;
      }
      if (state !== RIDING) continue;
      riding++;
      this.#birth[d] = Math.min(1, (this.#birth[d] ?? 0) + dt / BIRTH_SECONDS);
      let c = this.#seg[d] ?? 0;
      let a = ca[c] ?? 0;
      let b = cb[c] ?? 0;
      let r = this.#r[d] ?? 0;
      // Dew condensing on it, and on its thread's beads as it takes them up.
      let volume = Math.max(0, r * r * r + GROW * dew * dt - drying);
      const ay = pos[a * 3 + 1] ?? 0;
      const by = pos[b * 3 + 1] ?? 0;
      const len = Math.max(1e-6, sys.distance(a, b));
      const slope = (ay - by) / len; // > 0: downhill toward b
      const k = r / R_SLIDE;
      const drive = Math.abs(slope) * k * k;
      const target = drive > PIN ? SLIDE_SPEED * (drive - PIN) * Math.sign(slope) : 0;
      let v = approach(this.#v[d] ?? 0, target, dt, SLIDE_EASE);
      let t = (this.#t[d] ?? 0) + (v * dt) / len;
      const kind = web.kind[c] ?? DEW_KIND_SPIRAL;
      volume += Math.abs(v * dt) * this.#sweep(kind, web.wet[c] ?? 0);
      const from = this.#from[d] ?? 0;
      if (from === 0 && v > 0) web.dry[c] = Math.min(1, Math.max(0, t));
      else if (from === 1 && v < 0) web.dry[c] = -Math.min(1, Math.max(0, t));
      if (t >= 1 || t <= 0) {
        // A crossing: the thread behind is bare now; go on down the steepest way, if any.
        const here = t >= 1 ? b : a;
        if ((from === 0 && t >= 1) || (from === 1 && t <= 0)) web.wet[c] = 0;
        web.dry[c] = 0;
        const hy = pos[here * 3 + 1] ?? 0;
        let best = -1;
        let bestSlope = SLOPE_MIN;
        for (let j = web.adjStart[here] ?? 0, end = web.adjStart[here + 1] ?? 0; j < end; j++) {
          const c2 = web.adjList[j] ?? 0;
          if (c2 === c) continue;
          const other = (ca[c2] ?? 0) === here ? (cb[c2] ?? 0) : (ca[c2] ?? 0);
          const s2 = (hy - (pos[other * 3 + 1] ?? 0)) / Math.max(1e-6, sys.distance(here, other));
          if (s2 > bestSlope) {
            bestSlope = s2;
            best = c2;
          }
        }
        if (best >= 0 && !sys.isPinned(here)) {
          c = best;
          a = ca[c] ?? 0;
          b = cb[c] ?? 0;
          const atA = a === here;
          t = atA ? 0 : 1;
          this.#from[d] = atA ? 0 : 1;
          v = Math.abs(v) * CORNER_KEEP * (atA ? 1 : -1);
          this.#seg[d] = c;
        } else {
          t = t >= 1 ? 1 : 0;
          v = 0;
        }
      }
      this.#t[d] = t;
      this.#v[d] = v;
      r = Math.cbrt(volume);
      this.#r[d] = r;
      if (r < R_GONE) {
        this.#state[d] = 0;
        riding--;
        continue;
      }
      this.#place(d);

      // Too heavy, hanging too long, shaken off by the thread, or blown off in a gust.
      sys.velocity(a, this.#vel);
      sys.velocity(b, this.#vel2);
      const shake = Math.hypot(
        (this.#vel[0] ?? 0) * (1 - t) + (this.#vel2[0] ?? 0) * t,
        (this.#vel[1] ?? 0) * (1 - t) + (this.#vel2[1] ?? 0) * t,
        (this.#vel[2] ?? 0) * (1 - t) + (this.#vel2[2] ?? 0) * t,
      );
      this.#shiver[d] = Math.max(this.#shiver[d] ?? 0, Math.min(SHIVER_MAX, shake * SHIVER_GAIN));
      const heavy = r / R_FALL;
      if (
        r >= R_FALL ||
        (v === 0 && r > R_HANG && this.#rand() < dt / HANG_SECONDS) ||
        shake * heavy * heavy > SHAKE_FALL ||
        (r > GUST_SHED_R && this.#rand() < dt * GUST_SHED * gust * heavy * heavy * heavy)
      ) {
        this.#fall(d);
        riding--;
      }
    }
    this.#merge();
    // New drops gather where the dew is heavy, while the web holds fewer than its share.
    this.#spawnIn -= dt;
    if (riding < share && this.#spawnIn <= 0) {
      this.#spawn(0);
      this.#spawnIn = SPAWN_GAP * (0.6 + 0.8 * this.#rand());
    }
  }

  /** r³ a drop takes up per frame height of thread swept, at the thread's wetness (the shader's beads). */
  #sweep(kind: number, wet: number): number {
    const dew = this.#dew;
    const presence = (DEW_PRESENCE_BASE[kind] ?? 1) + (DEW_PRESENCE_DEW[kind] ?? 0) * dew;
    const mean = DEW_BEAD_R * (DEW_BEAD_SCALE[kind] ?? 1) * (0.55 + 0.45 * dew);
    return (presence * mean * mean * mean * wet) / (BEAD_SPACING[kind] ?? 0.0105);
  }

  /**
   * A new drop on a heavily beaded thread, gathering at its upper crossing (where dew collects), so
   * when it runs it runs down the thread and bares it; `grown` 0..1 starts it partway gathered.
   */
  #spawn(grown: number): void {
    const d = this.#state.indexOf(0);
    if (d < 0) return;
    const web = this.#shown;
    let c = -1;
    for (let tries = 0; tries < 10 && c < 0; tries++) {
      const pick = Math.floor(this.#rand() * web.threads);
      const kind = web.kind[pick];
      if (kind === DEW_KIND_FRAME || (web.wet[pick] ?? 0) < 0.7 || (web.beads[pick] ?? 0) < 2)
        continue;
      if (kind === DEW_KIND_SPOKE && this.#rand() < 0.6) continue;
      c = pick;
    }
    if (c < 0) return;
    this.#state[d] = RIDING;
    this.#seg[d] = c;
    const pos = web.sys.positions;
    const upper =
      (pos[(web.sys.constraintA[c] ?? 0) * 3 + 1] ?? 0) >=
      (pos[(web.sys.constraintB[c] ?? 0) * 3 + 1] ?? 0)
        ? 0
        : 1;
    this.#t[d] = upper === 0 ? 0.04 : 0.96;
    this.#from[d] = upper;
    this.#v[d] = 0;
    this.#r[d] = SPAWN_R * (0.85 + 0.4 * this.#rand()) * (1 + 0.5 * grown);
    this.#birth[d] = grown;
    this.#shiver[d] = 0;
    this.#phase[d] = this.#rand() * TAU;
    web.wet[c] = (web.wet[c] ?? 0) * (1 - SPAWN_TAKE);
    this.#place(d);
  }

  /** A riding drop's centre: on its thread, hanging below it. */
  #place(d: number): void {
    const sys = this.#shown.sys;
    const pos = sys.positions;
    const c = this.#seg[d] ?? 0;
    const a = (sys.constraintA[c] ?? 0) * 3;
    const b = (sys.constraintB[c] ?? 0) * 3;
    const t = this.#t[d] ?? 0;
    const r = this.#r[d] ?? 0;
    this.#x[d] = (pos[a] ?? 0) + ((pos[b] ?? 0) - (pos[a] ?? 0)) * t;
    this.#y[d] =
      (pos[a + 1] ?? 0) + ((pos[b + 1] ?? 0) - (pos[a + 1] ?? 0)) * t - r * DEW_DROP_HANG;
    this.#z[d] = (pos[a + 2] ?? 0) + ((pos[b + 2] ?? 0) - (pos[a + 2] ?? 0)) * t;
  }

  /** Let a drop go: it falls, and its thread springs up. */
  #fall(d: number): void {
    if (this.#state[d] !== RIDING) return;
    // Nothing is shaken loose while the web swings: it is drawn displaced from where the sim holds it.
    if (this.#passing) return;
    const sys = this.#shown.sys;
    const c = this.#seg[d] ?? 0;
    const t = this.#t[d] ?? 0;
    sys.velocity(sys.constraintA[c] ?? 0, this.#vel);
    sys.velocity(sys.constraintB[c] ?? 0, this.#vel2);
    this.#vx[d] = 0.5 * ((this.#vel[0] ?? 0) * (1 - t) + (this.#vel2[0] ?? 0) * t);
    this.#vy[d] = 0.5 * ((this.#vel[1] ?? 0) * (1 - t) + (this.#vel2[1] ?? 0) * t) - 0.04;
    this.#state[d] = FALLING;
    this.#shiver[d] = 0;
    if (this.#prewarming) return;
    const k = (this.#r[d] ?? 0) / R_FALL;
    const x = this.#x[d] ?? 0;
    const y = (this.#y[d] ?? 0) + (this.#r[d] ?? 0) * DEW_DROP_HANG;
    sys.impulse(
      x,
      y,
      this.#z[d] ?? 0,
      RECOIL_RADIUS,
      0,
      RECOIL * k * k * k,
      0.3 * RECOIL * k * k * k,
      this.#recoilBlend,
    );
  }

  /** Drops that touch run together into the bigger one. */
  #merge(): void {
    for (let d = 0; d < DEW_DROPS; d++) {
      if (this.#state[d] !== RIDING) continue;
      for (let e = d + 1; e < DEW_DROPS; e++) {
        if (this.#state[e] !== RIDING) continue;
        const rd = this.#r[d] ?? 0;
        const re = this.#r[e] ?? 0;
        if (
          Math.hypot((this.#x[d] ?? 0) - (this.#x[e] ?? 0), (this.#y[d] ?? 0) - (this.#y[e] ?? 0)) >
          (rd + re) * 0.85
        )
          continue;
        const keep = rd >= re ? d : e;
        const gone = keep === d ? e : d;
        this.#r[keep] = Math.cbrt(rd * rd * rd + re * re * re);
        this.#birth[keep] = Math.max(this.#birth[d] ?? 0, this.#birth[e] ?? 0);
        this.#shiver[keep] = SHIVER_MERGE;
        this.#state[gone] = 0;
        this.#place(keep);
        if (gone === d) break;
      }
    }
  }

  /** Blur (frame heights) of something at depth z: how far it lies off the focus, capped. */
  #blurAt(z: number): number {
    return Math.min(DEW_BLUR_MAX, Math.abs(z - this.#focus) * (DEW_DOF * this.#dof));
  }

  /** One stem capsule a–b (raw positions, depths az and bz) of the given piece, radius ra at a and rb at b; seen with the web's perspective. */
  #piece(
    seg: Float32Array,
    id: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    ra: number,
    rb: number,
    piece: number,
    cx: number,
    cell: number,
    dew: number,
  ): void {
    const ga = 1 + az / CAMERA_DISTANCE;
    const gb = 1 + bz / CAMERA_DISTANCE;
    const pax = cx + (ax - cx) * ga;
    const pay = 0.5 + (ay - 0.5) * ga;
    const pbx = cx + (bx - cx) * gb;
    const pby = 0.5 + (by - 0.5) * gb;
    const codeA = Math.min(DEW_CODE - 1, Math.max(1, Math.round(ra / DEW_STEM_UNIT)));
    const codeB = Math.min(DEW_CODE - 1, Math.max(1, Math.round(rb / DEW_STEM_UNIT)));
    this.#writeSegment(
      seg,
      id,
      pax,
      pay,
      az,
      pbx,
      pby,
      bz,
      codeB + DEW_CODE * piece,
      DEW_KIND_STEM * DEW_CODE + codeA,
    );
    this.#lists.add(
      id + 1,
      pax,
      pay,
      pbx,
      pby,
      Math.max(codeA, codeB) * DEW_STEM_UNIT +
        dewBeadMax(DEW_KIND_SPIRAL, dew) * 2 +
        Math.max(this.#blurAt(az), this.#blurAt(bz)) +
        2 * cell,
    );
  }

  /**
   * Every stem's capsules, after the threads' records: the stalk (tapering from r0 to r1), the leaf
   * blades (a long arc that lifts, bends over and comes to a point), the seed head (a spindle nodding
   * off the stalk's tip) and its awns (bristles either side). Leaves and head sway a little more than
   * the stalk they grow from.
   */
  #packStems(seg: Float32Array, cx: number, cell: number, dew: number): void {
    const web = this.#shown;
    const at = this.#at;
    let id = web.threads;
    for (const stem of web.stems) {
      stemAt(stem, 0, at);
      let ax = at[0] ?? 0;
      let ay = at[1] ?? 0;
      let az = at[2] ?? 0;
      for (let k = 0; k < STEM_SEGMENTS; k++) {
        const u0 = k / STEM_SEGMENTS;
        const u1 = (k + 1) / STEM_SEGMENTS;
        stemAt(stem, u1, at);
        const bx = at[0] ?? 0;
        const by = at[1] ?? 0;
        const bz = at[2] ?? 0;
        this.#piece(
          seg,
          id++,
          ax,
          ay,
          az,
          bx,
          by,
          bz,
          stem.r0 + (stem.r1 - stem.r0) * u0,
          stem.r0 + (stem.r1 - stem.r0) * u1,
          DEW_PIECE_STALK,
          cx,
          cell,
          dew,
        );
        ax = bx;
        ay = by;
        az = bz;
      }

      for (const leaf of stem.leaves) {
        stemAt(stem, leaf.u, at);
        const rz = at[2] ?? 0;
        let px = at[0] ?? 0;
        let py = at[1] ?? 0;
        let ex = px;
        let ey = py;
        let ez = rz;
        const step = leaf.length / LEAF_SEGMENTS;
        for (let j = 0; j < LEAF_SEGMENTS; j++) {
          const t0 = j / LEAF_SEGMENTS;
          const t1 = (j + 1) / LEAF_SEGMENTS;
          const angle = leaf.lift + leaf.droop * Math.pow((t0 + t1) / 2, 1.4);
          px += leaf.side * Math.sin(angle) * step;
          py += Math.cos(angle) * step;
          const swing = 0.5 * t1 * t1;
          const nx = px + stem.sx * swing;
          const nz = rz + stem.sz * swing;
          this.#piece(
            seg,
            id++,
            ex,
            ey,
            ez,
            nx,
            py,
            nz,
            leaf.width * leafProfile(t0),
            leaf.width * leafProfile(t1),
            DEW_PIECE_LEAF,
            cx,
            cell,
            dew,
          );
          ex = nx;
          ey = py;
          ez = nz;
        }
      }

      // The seed head carries on from the stalk's tip, along its tangent, nodding further over.
      stemAt(stem, 1, at);
      const tipX = at[0] ?? 0;
      const tipY = at[1] ?? 0;
      const tipZ = at[2] ?? 0;
      stemAt(stem, 0.96, at);
      const lean = Math.atan2(tipX - (at[0] ?? 0), tipY - (at[1] ?? 0));
      const headStep = stem.head / HEAD_SEGMENTS;
      let hx = tipX;
      let hy = tipY;
      let hz = tipZ;
      for (let j = 0; j < HEAD_SEGMENTS; j++) {
        const t0 = j / HEAD_SEGMENTS;
        const t1 = (j + 1) / HEAD_SEGMENTS;
        const angle = lean + stem.nod * (t0 + t1) * 0.5;
        const dx = Math.sin(angle);
        const dy = Math.cos(angle);
        const nx = hx + dx * headStep + stem.sx * 0.4 * (t1 * t1 - t0 * t0);
        const ny = hy + dy * headStep;
        const nz = tipZ + stem.sz * 0.4 * t1 * t1;
        const r0 = j === 0 ? stem.r1 : (HEAD_RADII[j] ?? 0.001);
        const r1 = HEAD_RADII[j + 1] ?? 0.001;
        this.#piece(seg, id++, hx, hy, hz, nx, ny, nz, r0, r1, DEW_PIECE_HEAD, cx, cell, dew);
        const rad = (r0 + r1) * 0.5;
        const mx = (hx + nx) * 0.5;
        const my = (hy + ny) * 0.5;
        const mz = (hz + nz) * 0.5;
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? -1 : 1;
          // The normal (-dy, dx) is to the left of the head's direction; the awn leans out that way.
          const ax = mx - dy * side * rad * 0.6;
          const ay = my + dx * side * rad * 0.6;
          const out = angle - side * AWN_SPREAD;
          this.#piece(
            seg,
            id++,
            ax,
            ay,
            mz,
            ax + Math.sin(out) * AWN_LENGTH,
            ay + Math.cos(out) * AWN_LENGTH,
            mz,
            AWN_RADIUS,
            AWN_RADIUS * 0.4,
            DEW_PIECE_AWN,
            cx,
            cell,
            dew,
          );
        }
        hx = nx;
        hy = ny;
        hz = nz;
      }
    }
  }

  // ---- the passage --------------------------------------------------------------------------------

  /** Start a gust `age` seconds into its course, at this share of a full one's pressure. */
  #blow(age: number, amplitude: number): void {
    this.#gustAt = this.#clock - age;
    this.#gustAmp = amplitude;
  }

  /**
   * The passage's swing, applied to the drawn points. The web hangs from a long pendulum above the
   * frame; a gust has carried it out past the right edge, and the entrance brings it back in, over
   * the middle with a small overshoot and to rest (swingIn), while the exit is the next gust taking it
   * out the same way (swingOut), every point gathering speed until it is out as the exit ends. The
   * moorings stay on their stems and the twig, so the anchor threads stretch and the web comes in on
   * them; the beads and the drops on it go along. Lower points lag the upper ones a little, so the web
   * flexes instead of turning as a board. The sim's own points are not touched.
   */
  #swingWeb(drawn: Float32Array): void {
    const web = this.#shown;
    const sys = web.sys;
    const reach = web.radius * (CORNER_REACH + CORNER_REACH_JITTER) + SWING_MARGIN;
    const theta0 = Math.asin(Math.min(0.95, (web.aspect - web.hubX + reach) / SWING_LENGTH));
    const px = web.hubX;
    const py = web.hubY + SWING_LENGTH;
    const span = web.radius * 1.4;
    const inSeconds = this.#enter * DEW_PASSAGE.enter;
    const outSeconds = this.#exit * DEW_PASSAGE.exit;
    for (let i = 0, n = sys.count; i < n; i++) {
      if (sys.isPinned(i)) continue;
      const o = i * 3;
      const x = drawn[o] ?? 0;
      const y = drawn[o + 1] ?? 0;
      const lag = SWING_LAG * Math.min(1, Math.max(0, 0.5 + (0.5 * (web.hubY - y)) / span));
      let s = 0;
      if (this.#enter < 1)
        s = swingIn(Math.min(1, Math.max(0, (inSeconds - lag) / (DEW_PASSAGE.enter - SWING_LAG))));
      if (this.#exit > 0)
        s +=
          (1 - s) *
          swingOut(Math.min(1, Math.max(0, (outSeconds - lag) / (DEW_PASSAGE.exit - lag))));
      const theta = theta0 * s;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      const dx = x - px;
      const dy = y - py;
      drawn[o] = px + dx * c - dy * sn;
      drawn[o + 1] = py + dx * sn + dy * c;
    }
  }

  // ---- packing ------------------------------------------------------------------------------------

  #pack(heightCells: number): void {
    const web = this.#shown;
    const sys = web.sys;
    const aspect = web.aspect;
    const cell = 1 / Math.max(1, heightCells);
    const dew = this.#dew;
    const focus = this.#focus;

    // Drawn positions: blended between the last two substeps by the clock's alpha (as PointTexture
    // does), seen with a little perspective about the frame's centre.
    const pos = sys.positions;
    const prev = sys.previous;
    const blend = this.#steps.alpha;
    const drawn = web.drawn;
    const cx = aspect / 2;
    for (let i = 0, n = sys.count * 3; i < n; i += 3) {
      const px = prev[i] ?? 0;
      const py = prev[i + 1] ?? 0;
      const pz = prev[i + 2] ?? 0;
      const x = px + ((pos[i] ?? 0) - px) * blend;
      const y = py + ((pos[i + 1] ?? 0) - py) * blend;
      const z = pz + ((pos[i + 2] ?? 0) - pz) * blend;
      const grow = 1 + z / CAMERA_DISTANCE;
      drawn[i] = cx + (x - cx) * grow;
      drawn[i + 1] = 0.5 + (y - 0.5) * grow;
      drawn[i + 2] = z;
    }
    if (this.#passing) this.#swingWeb(drawn);

    const segRows = Math.ceil(
      (web.threads +
        web.stems.reduce(
          (n, stem) => n + STEM_SEGMENTS + stem.leaves.length * LEAF_SEGMENTS + HEAD_SEGMENTS * 3,
          0,
        )) /
        DEW_SEG_ROW,
    );
    const segWidth = DEW_SEG_ROW * DEW_SEG_TEXELS;
    if (this.#segTex.height !== segRows) this.#segTex.resize(segWidth, segRows);
    if (this.#segData.length !== segWidth * segRows * 4)
      this.#segData = new Float32Array(segWidth * segRows * 4);
    const seg = this.#segData;
    const lists = this.#lists;
    lists.clear();
    // Drops first, so a bin fuller than its last page never loses one.
    const drop = this.#dropData;
    drop.fill(0);
    const clock = this.#clock;
    // The drops are drawn at the frame's own time: carried on from their last step by the time left
    // over (DROP_STEP's pending, none at 60 Hz), along their thread or their fall, as that step would.
    const ahead = this.#dropSteps.pending;
    for (let d = 0; d < DEW_DROPS; d++) {
      const state = this.#state[d];
      if (state !== RIDING && state !== FALLING) continue;
      let x = this.#x[d] ?? 0;
      let y = this.#y[d] ?? 0;
      const z = this.#z[d] ?? 0;
      const birth = this.#birth[d] ?? 1;
      const r = (this.#r[d] ?? 0) * (0.35 + 0.65 * birth * birth * (3 - 2 * birth));
      let stretch = 1.08;
      if (state === FALLING) {
        const grow = 1 + z / CAMERA_DISTANCE;
        x += (this.#vx[d] ?? 0) * Math.exp(-ahead) * ahead;
        y += ((this.#vy[d] ?? 0) - FALL_GRAVITY * ahead) * ahead;
        x = cx + (x - cx) * grow;
        y = 0.5 + (y - 0.5) * grow;
        stretch = 1 + Math.min(2.5, (Math.abs(this.#vy[d] ?? 0) * 0.012) / Math.max(r, 1e-4));
      } else {
        // Riding drops follow their thread as drawn.
        const c = this.#seg[d] ?? 0;
        const pa = sys.constraintA[c] ?? 0;
        const pb = sys.constraintB[c] ?? 0;
        const a = pa * 3;
        const b = pb * 3;
        const along = ((this.#v[d] ?? 0) * ahead) / Math.max(1e-6, sys.distance(pa, pb));
        const t = Math.min(1, Math.max(0, (this.#t[d] ?? 0) + along));
        x = (drawn[a] ?? 0) + ((drawn[b] ?? 0) - (drawn[a] ?? 0)) * t;
        y =
          (drawn[a + 1] ?? 0) + ((drawn[b + 1] ?? 0) - (drawn[a + 1] ?? 0)) * t - r * DEW_DROP_HANG;
      }
      const squash =
        (this.#shiver[d] ?? 0) * Math.sin(clock * SHIVER_HZ * TAU + (this.#phase[d] ?? 0));
      const o = d * 8;
      drop[o] = hi(x);
      drop[o + 1] = hi(y);
      drop[o + 2] = x - hi(x);
      drop[o + 3] = y - hi(y);
      drop[o + 4] = r;
      drop[o + 5] = z;
      drop[o + 6] = stretch;
      drop[o + 7] = squash;
      const reach = r * stretch * (1 + Math.abs(squash)) * 1.25 + this.#blurAt(z) + 1.5 * cell;
      lists.add(-(d + 1), x, y, x, y, reach);
    }

    // Stems: stalk, leaf blades, seed head and its awns.
    this.#packStems(seg, cx, cell, dew);

    // Threads.
    const ca = sys.constraintA;
    const cb = sys.constraintB;
    for (let c = 0; c < web.threads; c++) {
      const a = (ca[c] ?? 0) * 3;
      const b = (cb[c] ?? 0) * 3;
      const kind = web.kind[c] ?? DEW_KIND_SPIRAL;
      const ax = drawn[a] ?? 0;
      const ay = drawn[a + 1] ?? 0;
      const az = drawn[a + 2] ?? 0;
      const bx = drawn[b] ?? 0;
      const by = drawn[b + 1] ?? 0;
      const bz = drawn[b + 2] ?? 0;
      const wet = Math.round((web.wet[c] ?? 0) * DEW_WET_LEVELS) + 0.5 + 0.45 * (web.dry[c] ?? 0);
      this.#writeSegment(
        seg,
        c,
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        wet,
        kind * DEW_CODE + (web.beads[c] ?? 0),
      );
      const silk =
        ((kind === DEW_KIND_FRAME ? DEW_FRAME_HALF : DEW_SILK_HALF) * (1 + DEW_GLINT_SWELL) + 1) *
        cell;
      const bead = dewBeadMax(kind, dew) * (1 + DEW_BEAD_HANG) + cell;
      lists.add(
        c + 1,
        ax,
        ay,
        bx,
        by,
        Math.max(silk, bead) + Math.max(this.#blurAt(az), this.#blurAt(bz)),
      );
    }
    this.#segTex.upload(seg);
    this.#binTex.resize(lists.width, lists.height);
    this.#binTex.upload(lists.data);
    this.#dropTex.upload(drop);

    // The header: the hub, the focus, how the hub has turned (for the spider and her M).
    const hub = web.layout.hub * 3;
    const hx = drawn[hub] ?? 0;
    const hy = drawn[hub + 1] ?? 0;
    const up = (web.layout.spiral + 2) * 3;
    const turn = Math.atan2((drawn[up + 1] ?? 0) - hy, (drawn[up] ?? 0) - hx) - Math.PI / 2;
    const head = this.#headData;
    head[0] = hi(hx);
    head[1] = hi(hy);
    head[2] = hx - hi(hx);
    head[3] = hy - hi(hy);
    head[4] = drawn[hub + 2] ?? 0;
    head[5] = focus;
    head[6] = turn;
    head[7] = web.radius;
    head[8] = this.#gust;
    head[9] = this.#breeze;
    head[10] = lists.pages;
    head[11] = 0;
    this.#headTex.upload(head);
  }

  #writeSegment(
    data: Float32Array,
    id: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    wet: number,
    code: number,
  ): void {
    const o =
      ((id % DEW_SEG_ROW) * DEW_SEG_TEXELS +
        Math.floor(id / DEW_SEG_ROW) * DEW_SEG_ROW * DEW_SEG_TEXELS) *
      4;
    const hax = hi(ax);
    const hay = hi(ay);
    const hbx = hi(bx);
    const hby = hi(by);
    data[o] = hax;
    data[o + 1] = hay;
    data[o + 2] = hbx;
    data[o + 3] = hby;
    data[o + 4] = ax - hax;
    data[o + 5] = ay - hay;
    data[o + 6] = bx - hbx;
    data[o + 7] = by - hby;
    data[o + 8] = az;
    data[o + 9] = bz;
    data[o + 10] = wet;
    data[o + 11] = code;
  }
}

/** The dewy web's simulation, for a scene whose `params` carry the knobs `DewKnob` names. */
export function dewSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<DewKnob>("dew", params, ["breeze", "dew", "dof", "webSeed"]);
  return (gl) => new DewSim(gl, knobs);
}
