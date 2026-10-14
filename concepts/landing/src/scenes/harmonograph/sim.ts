// The harmonograph: two damped pendulums (and, optionally, a rotary one) swing a pen across a sheet
// of paper, drawing a slowly dying Lissajous figure. This file integrates the pendulums at a fixed
// step, rasterises the pen's path into an ink texture in the sheet's own coordinates, and runs the
// sheet's life: draw, (sign with the Manifold M), rest, slide the sheet off, slide a fresh one in,
// lower the pen, draw again. The shader (shader.ts) paints the desk, the paper, the ink and the pen.
//
// Units: "p units" are view heights on a landscape screen (on a portrait one, divided by its fit
// scale, see harmonographScale): the sheet is 2 * HARMONOGRAPH.half = 0.8 across, centred at (cx, 0)
// and tilted by `tilt`; the ink texture covers exactly the sheet.
//
// Uploads:
//   uSim0  rg8, HARMONOGRAPH.grid square, in the sheet's frame (row 0 = the sheet's bottom):
//          r  the figure's ink 0..1 (coverage; pooled and overlapped ink is deeper)
//          g  the signature's ink 0..1 (the Manifold M, drawn by hand)
//   uSim1  rgba16f, 2 texels (positions are splitHalf pairs, decode with unsplitHalf):
//          0  the pen's tip in the world: x hi, x lo, y hi, y lo
//          1  the sheet's centre x hi, lo; its tilt (radians); the pen's height above the paper
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { splitHalf } from "../../sims/half.ts";
import { clamp, lerp } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

export class HarmonographError extends Error {}

const TAU = Math.PI * 2;

/** The desk, in p units; the shader draws with the same numbers. */
export const HARMONOGRAPH = {
  /** Side of the ink texture, texels. */
  grid: 1024,
  /** Half the sheet's side. */
  half: 0.4,
  /** The view is scaled by min(1, fit * aspect), so a portrait screen still holds the whole sheet. */
  fit: 1.05,
  /** The pen's height above the paper while drawing, and how much higher it rises when lifted. */
  down: 0.01,
  rise: 0.06,
} as const;

/** The scale the shader divides the view by: p = (view heights) / harmonographScale(aspect). */
export function harmonographScale(aspect: number): number {
  return Math.min(1, HARMONOGRAPH.fit * aspect);
}

export const harmonographFigures = ["random", "1:2", "2:3", "3:4", "4:5", "3:5"] as const;
export const harmonographInks = ["sepia", "indigo", "vermilion"] as const;
export const harmonographPapers = ["cream", "vellum", "kraft"] as const;

type Knob = "figure" | "lasting" | "swing" | "rotary" | "renew" | "drawings" | "nib" | "mark";
const KNOBS: readonly Knob[] = ["figure", "lasting", "swing", "rotary", "renew", "drawings", "nib", "mark"];

/** The knobs as the sim uses them. */
interface Settings {
  /** Index into harmonographFigures. */
  figure: number;
  /** 0..1: how long a drawing lasts. */
  lasting: number;
  /** Time-lapse of the pendulums. */
  swing: number;
  /** The rotary pendulum's amount; 0 while it is off. */
  rotary: number;
  /** Seconds a finished sheet rests before it is replaced; undefined while "next sheet" is off. */
  pause: number | undefined;
  seed: number;
  nib: number;
  /** The M signs every sheet while this is above 0. */
  mark: number;
  /** The M's height, p units, from the knob's amount even while it is off (its "now" button). */
  markSize: number;
}

function readSettings(knobs: KnobReader<Knob>, frame: SimFrame, out: Settings): void {
  const renew = knobs.value(frame, "renew");
  out.figure = Math.round(knobs.value(frame, "figure"));
  out.lasting = clamp(knobs.value(frame, "lasting"), 0, 1);
  out.swing = clamp(knobs.value(frame, "swing"), 0.25, 4);
  out.rotary = Math.max(0, knobs.value(frame, "rotary"));
  out.pause = renew > 0 ? REST_MIN + REST_RANGE * renew : undefined;
  out.seed = Math.round(knobs.value(frame, "drawings"));
  out.nib = clamp(knobs.value(frame, "nib"), 0, 1);
  out.mark = Math.max(0, knobs.value(frame, "mark"));
  out.markSize = 0.1 + 0.26 * clamp(knobs.amount(frame, "mark"), 0, 1);
}

// ---- timing --------------------------------------------------------------------------------------

/** The fixed step, seconds, and the most steps a frame may run. */
const STEP = 1 / 60;
const MAX_STEPS = 12;
/** A frame never advances more than this, seconds. */
const MAX_FRAME = 0.1;
/** A sheet rests REST_MIN + REST_RANGE * (the "pause" amount) seconds when it is done. */
const REST_MIN = 3;
const REST_RANGE = 40;
/** Seconds the sheet takes to slide off, and a fresh one to slide in. */
const SLIDE_SECONDS = 6.5;
/** Seconds the pen takes to hover across to the next sheet's starting point as the old one leaves. */
const SLIDE_HOVER_SECONDS = 2.6;
/** Seconds the pen takes to travel to the M's start or back to the figure's, lowering at the end. */
const HOVER_SECONDS = 2.0;
/** Of which the last HOVER_LOWER seconds are the pen going down. */
const HOVER_LOWER = 0.8;
/** Seconds to lower the pen onto a fresh sheet. */
const LOWER_SECONDS = 1.0;
/** How briskly the pen rises and falls (per second). */
const LIFT_RATE = 5;
/** The pen marks the paper below this lift. */
const DOWN_LIFT = 0.3;

// ---- pendulums -----------------------------------------------------------------------------------

/** A drawing is over once the swings' reach falls below this, p units. */
const END_REACH = 0.035;
/** The rotary pendulum's radius at amount 1, p units. */
const ROTARY_RADIUS = 0.2;
/** Seconds for the swing to fall to 1/e at "lasting" 0, and the factor per unit of lasting. */
const DECAY_BASE = 28;
const DECAY_GROWTH = 6;
/** A fresh load starts this far into a drawing (seconds of swing, capped at this share of the decay time). */
const PREWARM_MIN = 14;
const PREWARM_MAX = 46;
const PREWARM_SHARE = 0.6;

const RATIOS: readonly (readonly [number, number])[] = [[1, 2], [2, 3], [3, 4], [4, 5], [3, 5]];
/** "Random" picks from here: the simple ratios twice, so the figures stay open and the rest are rare. */
const RANDOM_RATIOS: readonly (readonly [number, number])[] = [[2, 3], [2, 3], [3, 4], [3, 4], [1, 2], [4, 5], [3, 5]];

/** One sheet's pendulums. */
interface Plan {
  /** The frequency ratio a:b, x against y. */
  readonly a: number;
  readonly b: number;
  /** Frequencies, Hz of swing time, each a hair off its small integer ratio. */
  readonly fx: number;
  readonly fy: number;
  readonly fr: number;
  /** Starting phases, radians. */
  readonly px: number;
  readonly py: number;
  readonly pr: number;
  /** Amplitudes, p units. */
  readonly ax: number;
  readonly ay: number;
  /** Each pendulum's decay rate against the drawing's. */
  readonly dx: number;
  readonly dy: number;
  readonly dr: number;
  /** Which way the rotary pendulum turns, +1 or -1. */
  readonly spin: number;
  /** How the sheet lies on the desk, radians. */
  readonly tilt: number;
}

function makePlan(seed: number, index: number, figure: number, previous: Plan | undefined): Plan {
  const rng = new Random(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ 0x2f6c1d);
  const preset = figure >= 1 ? RATIOS[figure - 1] : undefined;
  const pool = RANDOM_RATIOS.filter(([a, b]) => previous === undefined || a !== previous.a || b !== previous.b);
  const [a, b] = preset ?? rng.pick(pool);
  const fastest = rng.range(0.17, 0.23);
  const unit = fastest / b;
  const detune = (): number => (rng.next() < 0.5 ? -1 : 1) * rng.range(0.005, 0.016);
  const fx = a * unit * (1 + detune());
  const fy = b * unit * (1 + detune());
  // The rotary pendulum turns at a small whole multiple of the base frequency, no faster than the fastest swing.
  const multiples = [...new Set([1, a, b, 2 * a])].filter((m) => m * unit <= 1.3 * fastest);
  const fr = rng.pick(multiples) * unit * (1 + detune());
  const ax = rng.range(0.25, 0.28);
  return {
    a, b, fx, fy, fr,
    px: rng.range(0, TAU),
    py: rng.range(0, TAU),
    pr: rng.range(0, TAU),
    ax,
    ay: ax * rng.range(0.84, 1),
    dx: rng.range(0.85, 1.2),
    dy: rng.range(0.85, 1.2),
    dr: rng.range(1, 1.5),
    spin: rng.next() < 0.5 ? -1 : 1,
    tilt: rng.range(-0.03, 0.03),
  };
}

interface Point {
  x: number;
  y: number;
}

/** The pendulums' state: phases and what is left of each swing (0..1), integrated step by step. */
class Swing {
  #tx = 0;
  #ty = 0;
  #tr = 0;
  #ex = 1;
  #ey = 1;
  #er = 1;

  reset(plan: Plan): void {
    this.#tx = plan.px;
    this.#ty = plan.py;
    this.#tr = plan.pr;
    this.#ex = 1;
    this.#ey = 1;
    this.#er = 1;
  }

  /** `time` seconds of swing; `rate` is the drawing's decay rate (per second). */
  step(plan: Plan, time: number, rate: number): void {
    this.#tx += TAU * plan.fx * time;
    this.#ty += TAU * plan.fy * time;
    this.#tr += TAU * plan.fr * time;
    this.#ex *= Math.exp(-plan.dx * rate * time);
    this.#ey *= Math.exp(-plan.dy * rate * time);
    this.#er *= Math.exp(-plan.dr * rate * time);
  }

  /** The pen, in the sheet's frame: the x and y pendulums plus the rotary one's circle of `radius`. */
  position(plan: Plan, radius: number, out: Point): void {
    out.x = plan.ax * this.#ex * Math.sin(this.#tx) + radius * this.#er * Math.cos(this.#tr);
    out.y = plan.ay * this.#ey * Math.sin(this.#ty) + radius * this.#er * plan.spin * Math.sin(this.#tr);
  }

  /** How far the pen can still reach from the middle. */
  reach(plan: Plan, radius: number): number {
    return plan.ax * this.#ex + plan.ay * this.#ey + radius * this.#er;
  }

  /** The x and y swings' share left, 0..1: how freshly the pen is inked. */
  fullness(plan: Plan): number {
    return (plan.ax * this.#ex + plan.ay * this.#ey) / (plan.ax + plan.ay);
  }
}

// ---- ink -----------------------------------------------------------------------------------------

/** Texels per p unit. */
const TEXELS = HARMONOGRAPH.grid / (2 * HARMONOGRAPH.half);
/** Nib diameter in texels at "nib" 0 and 1: thin lines, about a dither cell wide. */
const NIB_THIN = 2.4;
const NIB_BOLD = 5.2;

/** The ink the pen has laid on the sheet, two channels (figure, signature). */
class InkSheet {
  readonly data = new Uint8Array(HARMONOGRAPH.grid * HARMONOGRAPH.grid * 2);
  dirty = true;

  clear(): void {
    this.data.fill(0);
    this.dirty = true;
  }

  /** Wipe the signature channel only. */
  clearSignature(): void {
    for (let i = 1; i < this.data.length; i += 2) this.data[i] = 0;
    this.dirty = true;
  }

  /**
   * Lay a stroke from (ax, ay) to (bx, by), sheet-frame p units, `radius` texels either side at
   * `alpha`. A flat stroke (the figure, a smooth curve of many tiny pieces) covers its own span
   * only and adds on top of what lies there, so crossings run deeper and joints do not bead; a
   * round one (the signature, with corners) has round ends and keeps the stronger ink.
   */
  stroke(channel: 0 | 1, ax: number, ay: number, bx: number, by: number, radius: number, alpha: number, flat: boolean): void {
    const size = HARMONOGRAPH.grid;
    const mid = size / 2;
    const x0 = ax * TEXELS + mid;
    const y0 = ay * TEXELS + mid;
    const x1 = bx * TEXELS + mid;
    const y1 = by * TEXELS + mid;
    const ex = x1 - x0;
    const ey = y1 - y0;
    const len2 = ex * ex + ey * ey;
    if (flat && len2 < 1e-4) return;
    const len = Math.sqrt(len2);
    const reach = radius + 1;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + reach));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + reach));
    const data = this.data;
    for (let iy = minY; iy <= maxY; iy++) {
      const qy = iy + 0.5 - y0;
      for (let ix = minX; ix <= maxX; ix++) {
        const qx = ix + 0.5 - x0;
        let t = len2 > 0 ? (qx * ex + qy * ey) / len2 : 0;
        let d: number;
        if (flat) {
          if (t < 0 || t >= 1) continue;
          d = Math.abs(qx * ey - qy * ex) / len;
        } else {
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(qx - ex * t, qy - ey * t);
        }
        const cover = (radius + 0.5 - d) * alpha;
        if (cover <= 0) continue;
        const c = cover > alpha ? alpha : cover;
        const at = (iy * size + ix) * 2 + channel;
        const v = data[at] ?? 0;
        data[at] = Math.round(flat ? v + c * (255 - v) : Math.max(v, c * 255));
      }
    }
    this.dirty = true;
  }
}

// ---- the signature -------------------------------------------------------------------------------

const MARK_SEGMENTS = [0, 1, 2, 3].map((k) => {
  const a = markVertex(k);
  const b = markVertex(k + 1);
  return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
});
const MARK_LENGTH = MARK_SEGMENTS.reduce((sum, segment) => sum + segment.length, 0);
/** The M's height is its size; the pen draws it this fast, p units per second. */
const MARK_PACE = 0.12;
/** The M stands this far from the sheet's corner, p units. */
const MARK_MARGIN = 0.055;

/** The point `distance` along the M (mark units from its left foot) laid out `size` tall in the sheet's lower right corner. */
function markPoint(distance: number, size: number, out: Point): void {
  const cx = HARMONOGRAPH.half - MARK_MARGIN - 0.47 * size;
  const cy = -HARMONOGRAPH.half + MARK_MARGIN + 0.5 * size;
  let rest = clamp(distance, 0, MARK_LENGTH);
  for (const segment of MARK_SEGMENTS) {
    if (rest <= segment.length) {
      const f = rest / segment.length;
      out.x = cx + size * (segment.a[0] + (segment.b[0] - segment.a[0]) * f);
      out.y = cy + size * (segment.a[1] + (segment.b[1] - segment.a[1]) * f);
      return;
    }
    rest -= segment.length;
  }
  const end = markVertex(4);
  out.x = cx + size * end[0];
  out.y = cy + size * end[1];
}

// ---- the sheet's life ----------------------------------------------------------------------------

/**
 * draw      the pendulums swing and the pen inks
 * hover     the pen, lifted, crosses to the M's start ("mark") or back to the figure's start ("start")
 * sign      the pen is led along the M
 * rest      the finished sheet waits
 * slideOut  the sheet leaves; the pen drifts to the next figure's start
 * slideIn   a fresh sheet arrives
 * lower     the pen comes down on it
 */
type Phase = "draw" | "hover" | "sign" | "rest" | "slideOut" | "slideIn" | "lower";
type HoverTo = "mark" | "start";

const ease = (s: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp(s, 0, 1));

function toWorld(lx: number, ly: number, tilt: number, cx: number, out: Point): void {
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  out.x = cx + cos * lx - sin * ly;
  out.y = sin * lx + cos * ly;
}

class HarmonographSim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #ink = new InkSheet();
  readonly #inkTexture: DataTexture;
  readonly #stateTexture: DataTexture;
  readonly #stateData = new Float32Array(8);
  readonly #textures: readonly WebGLTexture[];
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #settings: Settings = { figure: 0, lasting: 0.4, swing: 1, rotary: 0, pause: undefined, seed: 0, nib: 0.5, mark: 0, markSize: 0.23 };
  readonly #renewSlot: number;
  readonly #markSlot: number;
  readonly #swing = new Swing();
  readonly #probe = new Swing();
  readonly #pos: Point = { x: 0, y: 0 };
  readonly #spot: Point = { x: 0, y: 0 };
  readonly #world: Point = { x: 0, y: 0 };

  #plan: Plan = makePlan(0, 0, 0, undefined);
  #next: Plan | undefined;
  #phase: Phase = "draw";
  #phaseT = 0;
  #hoverTo: HoverTo = "mark";
  #sheet = 0;
  #seedWas: number | undefined;
  #figureWas: number | undefined;
  #markWas = false;
  #markEvent = false;
  #renewEvent = false;
  #signed = false;
  #figureStarted = true;
  /** The sheet's centre, as a share of the slide distance (-1 gone left, 0 in place, +1 waiting right), and its tilt. */
  #u = 0;
  #tilt = 0;
  #slide = 2;
  #gain = 0;
  #lift = 0;
  #liftTarget = 0;
  #bob = 0;
  #drawT = 0;
  /** The pen's tip in the world, and where a hover set out from. */
  #penX = 0;
  #penY = 0;
  #fromX = 0;
  #fromY = 0;
  /** Where the pen last inked, in the sheet's frame; valid only while it was down. */
  #lastX = 0;
  #lastY = 0;
  #lastDown = false;
  #signSeconds = 1;
  #signSize = 0.23;

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<Knob>) {
    this.#knobs = knobs;
    this.#renewSlot = knobs.trigger("renew");
    this.#markSlot = knobs.trigger("mark");
    this.#inkTexture = new DataTexture(gl, { width: HARMONOGRAPH.grid, height: HARMONOGRAPH.grid, format: "rg8" });
    this.#stateTexture = new DataTexture(gl, { width: 2, height: 1, format: "rgba16f", filter: "nearest" });
    this.#textures = [this.#inkTexture.texture, this.#stateTexture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const st = this.#settings;
    readSettings(this.#knobs, frame, st);
    const aspect = Number.isFinite(frame.aspect) && frame.aspect > 0 ? frame.aspect : 16 / 9;
    // How far the sheet must slide to be wholly off screen.
    this.#slide = (0.5 * aspect) / harmonographScale(aspect) + HARMONOGRAPH.half * 1.04 + 0.1;

    const markOn = st.mark > 0;
    if (markOn && !this.#markWas) this.#markEvent = true;
    if (!markOn && this.#markWas) this.#unsign();
    this.#markWas = markOn;
    if (frame.fired[this.#markSlot] === true) this.#markEvent = true;
    if (frame.fired[this.#renewSlot] === true) this.#renewEvent = true;

    if (st.seed !== this.#seedWas || st.figure !== this.#figureWas) {
      this.#seedWas = st.seed;
      this.#figureWas = st.figure;
      this.#restart(st);
    }

    const dt = Math.min(Math.max(Number.isFinite(frame.dt) ? frame.dt : 0, 0), MAX_FRAME);
    const steps = this.#clock.advance(dt * frame.motion);
    for (let i = 0; i < steps; i++) this.#step(STEP, st);

    if (this.#ink.dirty) {
      this.#inkTexture.upload(this.#ink.data);
      this.#ink.dirty = false;
    }
    this.#writeState();
    return this.#textures;
  }

  dispose(): void {
    this.#inkTexture.dispose();
    this.#stateTexture.dispose();
  }

  // ---- sheets ------------------------------------------------------------------------------------

  /** The first sheet of a run, already part way through its drawing so the picture is there at once. */
  #restart(st: Settings): void {
    this.#sheet = 0;
    this.#plan = makePlan(st.seed, 0, st.figure, undefined);
    this.#next = undefined;
    this.#beginSheet();
    this.#gain = st.rotary;
    this.#lift = 0;
    this.#liftTarget = 0;
    this.#phase = "draw";
    this.#phaseT = 0;
    this.#figureStarted = true;
    this.#markEvent = st.mark > 0;
    this.#renewEvent = false;
    this.#clock.reset();
    const rate = this.#rate(st);
    const seconds = clamp(PREWARM_SHARE * (1 / rate), PREWARM_MIN, PREWARM_MAX);
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      if (this.#swing.reach(this.#plan, ROTARY_RADIUS * this.#gain) < END_REACH) break;
      this.#drawStep(STEP, st);
    }
  }

  /** A blank sheet for the current plan, the pendulums at rest at their start. */
  #beginSheet(): void {
    this.#swing.reset(this.#plan);
    this.#tilt = this.#plan.tilt;
    this.#u = 0;
    this.#ink.clear();
    this.#signed = false;
    this.#drawT = 0;
    this.#lastDown = false;
  }

  /** The switch went off: the M goes from the sheet. */
  #unsign(): void {
    const signing = this.#phase === "sign" || (this.#phase === "hover" && this.#hoverTo === "mark");
    if (!this.#signed && !signing) return;
    this.#ink.clearSignature();
    this.#signed = false;
    if (signing) this.#enterRest();
  }

  #rate(st: Settings): number {
    return 1 / (DECAY_BASE * DECAY_GROWTH ** st.lasting);
  }

  // ---- the clock ---------------------------------------------------------------------------------

  #step(h: number, st: Settings): void {
    this.#phaseT += h;
    this.#bob += h * TAU * 0.31;
    this.#lift += (this.#liftTarget - this.#lift) * (1 - Math.exp(-h * LIFT_RATE));
    if (this.#phase === "draw") this.#gain += (st.rotary - this.#gain) * (1 - Math.exp(-h * 1.2));
    else this.#gain = st.rotary;

    const phase = this.#phase;
    switch (phase) {
      case "draw":
        this.#stepDraw(h, st);
        break;
      case "hover":
        this.#stepHover();
        break;
      case "sign":
        this.#stepSign(st);
        break;
      case "rest":
        this.#stepRest(st);
        break;
      case "slideOut":
        this.#stepSlideOut();
        break;
      case "slideIn":
        this.#stepSlideIn();
        break;
      case "lower":
        this.#stepLower(st);
        break;
      default: {
        const unreachable: never = phase;
        throw new HarmonographError(`harmonograph: unknown phase ${String(unreachable)}`);
      }
    }
  }

  #enterRest(): void {
    this.#phase = "rest";
    this.#phaseT = 0;
    this.#liftTarget = 1;
    this.#lastDown = false;
  }

  #stepDraw(h: number, st: Settings): void {
    if (this.#renewEvent) {
      this.#renewEvent = false;
      this.#startSlide(st);
      return;
    }
    if (this.#markEvent && !this.#signed) {
      this.#startHover("mark", st);
      return;
    }
    this.#drawStep(h, st);
    if (this.#swing.reach(this.#plan, ROTARY_RADIUS * this.#gain) >= END_REACH) return;
    if (st.mark > 0 && !this.#signed) this.#startHover("mark", st);
    else this.#enterRest();
  }

  /** One step of swing and ink. */
  #drawStep(h: number, st: Settings): void {
    const plan = this.#plan;
    const time = h * st.swing;
    this.#swing.step(plan, time, this.#rate(st));
    this.#drawT += time;
    const pos = this.#pos;
    this.#swing.position(plan, ROTARY_RADIUS * this.#gain, pos);
    const down = this.#lift < DOWN_LIFT;
    if (down && this.#lastDown) {
      const t = this.#drawT;
      // Pressure drifts slowly; ink pools and the line swells where the pen lingers; the pen runs dry.
      const pressure = 0.92 + 0.1 * Math.sin(0.7 * t + 1.3) + 0.06 * Math.sin(1.9 * t + 0.4);
      const slow = clamp(1 - (Math.hypot(pos.x - this.#lastX, pos.y - this.#lastY) * TEXELS) / 7, 0, 1);
      const radius = 0.5 * lerp(NIB_THIN, NIB_BOLD, st.nib) * pressure * (1 + 0.25 * slow);
      const alpha = Math.min(1, (0.62 + 0.33 * this.#swing.fullness(plan)) * (1 + 0.12 * slow));
      this.#ink.stroke(0, this.#lastX, this.#lastY, pos.x, pos.y, radius, alpha, true);
    }
    this.#lastX = pos.x;
    this.#lastY = pos.y;
    this.#lastDown = down;
    this.#liftTarget = 0;
    this.#penFromSheet(pos.x, pos.y);
  }

  #penFromSheet(lx: number, ly: number): void {
    toWorld(lx, ly, this.#tilt, this.#u * this.#slide, this.#world);
    this.#penX = this.#world.x;
    this.#penY = this.#world.y;
  }

  // ---- the signature -----------------------------------------------------------------------------

  #startHover(to: HoverTo, st: Settings): void {
    if (to === "mark") {
      this.#markEvent = false;
      this.#signSize = st.markSize;
    }
    this.#hoverTo = to;
    this.#phase = "hover";
    this.#phaseT = 0;
    this.#fromX = this.#penX;
    this.#fromY = this.#penY;
    this.#lastDown = false;
  }

  #stepHover(): void {
    const t = this.#phaseT;
    const spot = this.#spot;
    if (this.#hoverTo === "mark") markPoint(0, this.#signSize, spot);
    else {
      this.#swing.position(this.#plan, ROTARY_RADIUS * this.#gain, spot);
    }
    toWorld(spot.x, spot.y, this.#tilt, this.#u * this.#slide, this.#world);
    const e = ease(t / HOVER_SECONDS);
    this.#penX = lerp(this.#fromX, this.#world.x, e);
    this.#penY = lerp(this.#fromY, this.#world.y, e);
    this.#liftTarget = t < HOVER_SECONDS - HOVER_LOWER ? 1 : 0;
    if (t < HOVER_SECONDS) return;
    this.#penX = this.#world.x;
    this.#penY = this.#world.y;
    this.#lastX = spot.x;
    this.#lastY = spot.y;
    this.#lastDown = false;
    this.#phaseT = 0;
    if (this.#hoverTo === "mark") {
      this.#signSeconds = Math.max(5, (MARK_LENGTH * this.#signSize) / MARK_PACE);
      this.#phase = "sign";
    } else {
      this.#figureStarted = true;
      this.#phase = "draw";
    }
  }

  #stepSign(st: Settings): void {
    const progress = clamp(this.#phaseT / this.#signSeconds, 0, 1);
    // A hand's pace: a little slower at either end.
    const along = 0.5 * progress + 0.5 * ease(progress);
    const pos = this.#pos;
    markPoint(along * MARK_LENGTH, this.#signSize, pos);
    this.#liftTarget = 0;
    const down = this.#lift < DOWN_LIFT;
    if (down && this.#lastDown) {
      const radius = 0.55 * lerp(NIB_THIN, NIB_BOLD, st.nib) * (1 + 0.06 * Math.sin(2.1 * this.#phaseT));
      this.#ink.stroke(1, this.#lastX, this.#lastY, pos.x, pos.y, radius, 0.96, false);
    }
    this.#lastX = pos.x;
    this.#lastY = pos.y;
    this.#lastDown = down;
    this.#penFromSheet(pos.x, pos.y);
    if (progress < 1) return;
    this.#signed = true;
    this.#markEvent = false;
    this.#liftTarget = 1;
    if (this.#figureStarted) this.#enterRest();
    else this.#startHover("start", st);
  }

  // ---- rest and replacement ----------------------------------------------------------------------

  #stepRest(st: Settings): void {
    this.#liftTarget = 1;
    if (!this.#signed && (st.mark > 0 || this.#markEvent)) {
      this.#startHover("mark", st);
      return;
    }
    this.#markEvent = false;
    if (this.#renewEvent || (st.pause !== undefined && this.#phaseT >= st.pause)) {
      this.#renewEvent = false;
      this.#startSlide(st);
    }
  }

  #startSlide(st: Settings): void {
    this.#next = makePlan(st.seed, this.#sheet + 1, st.figure, this.#plan);
    this.#phase = "slideOut";
    this.#phaseT = 0;
    this.#liftTarget = 1;
    this.#fromX = this.#penX;
    this.#fromY = this.#penY;
    this.#lastDown = false;
  }

  /** Where the pen starts a sheet laid by `plan`, in the world, once the sheet has settled. */
  #startOf(plan: Plan): Point {
    this.#probe.reset(plan);
    this.#probe.position(plan, ROTARY_RADIUS * this.#gain, this.#spot);
    toWorld(this.#spot.x, this.#spot.y, plan.tilt, 0, this.#world);
    return this.#world;
  }

  #stepSlideOut(): void {
    const next = this.#next ?? this.#plan;
    const s = this.#phaseT / SLIDE_SECONDS;
    this.#u = -ease(s);
    const start = this.#startOf(next);
    const e = ease(this.#phaseT / SLIDE_HOVER_SECONDS);
    this.#penX = lerp(this.#fromX, start.x, e);
    this.#penY = lerp(this.#fromY, start.y, e);
    if (s < 1) return;
    // The old sheet is wholly off screen: lay the fresh one and slide it in from the other side.
    this.#sheet++;
    this.#plan = next;
    this.#next = undefined;
    this.#beginSheet();
    this.#figureStarted = false;
    this.#u = 1;
    this.#phase = "slideIn";
    this.#phaseT = 0;
  }

  #stepSlideIn(): void {
    const s = this.#phaseT / SLIDE_SECONDS;
    this.#u = 1 - ease(s);
    const start = this.#startOf(this.#plan);
    this.#penX = start.x;
    this.#penY = start.y;
    if (s < 1) return;
    this.#u = 0;
    this.#phase = "lower";
    this.#phaseT = 0;
  }

  #stepLower(st: Settings): void {
    const start = this.#startOf(this.#plan);
    this.#penX = start.x;
    this.#penY = start.y;
    this.#liftTarget = 0;
    if (this.#phaseT < LOWER_SECONDS) return;
    // A "now" or a switch-on that came while the sheets changed signs the blank sheet first, then draws.
    if (this.#markEvent && !this.#signed) {
      this.#startHover("mark", st);
      return;
    }
    this.#figureStarted = true;
    this.#renewEvent = false;
    this.#lastDown = false;
    this.#phase = "draw";
    this.#phaseT = 0;
  }

  // ---- upload ------------------------------------------------------------------------------------

  #writeState(): void {
    const data = this.#stateData;
    splitHalf(data, 0, this.#penX);
    splitHalf(data, 2, this.#penY);
    splitHalf(data, 4, this.#u * this.#slide);
    data[6] = this.#tilt;
    const lift = clamp(this.#lift, 0, 1);
    data[7] = HARMONOGRAPH.down + 0.0022 * (0.5 + 0.5 * Math.sin(this.#bob)) * (1 - lift) + HARMONOGRAPH.rise * lift;
    this.#stateTexture.upload(data);
  }
}

/** The harmonograph, for a scene whose `params` carry the knobs `Knob` names. */
export function harmonographSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<Knob>("harmonograph", params, KNOBS);
  return (gl) => new HarmonographSim(gl, knobs);
}

