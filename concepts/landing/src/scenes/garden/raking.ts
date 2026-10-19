// The raking chore's sim (`raking`, on the gravel): the plan and the tools; the gravel (its host,
// gravel.ts) owns the field and nature's undo, and lends the board and the tines.
//
// The unseen rake is the chore's default agent. It follows a choreographed plan the layout comes
// with (build.ts): long passes across the garden, straight or in waves, the rake lifted over the ring
// zones, then a lap of five rings around every island; or, for "circles", rings spreading out from
// every stone until they meet the rings of the next. Every frame the rake moves a little along the
// plan at the chore's pace: a board just ahead of it levels the old pattern, then five tines cut
// fresh grooves, in short pieces so the banks stay even round a bend, and it sweeps the lying leaves
// in its way (the boughs' affordances). Each new layout sets it down afresh left of centre, where both
// views see it at work. Every hand dragged on the gravel (by its place in SimFrame.principals: the
// visitor, the cast's agents) rakes its own lines with a three-tined hand rake; an agent pressing
// without moving sets it down and lifts it.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import type { RakeOptions } from "../../sims/heightfield.ts";
import { clamp, lerp } from "../../sims/math.ts";
import type { PrincipalState } from "../types.ts";
import { RAKE, type Stroke } from "./build.ts";
import { Boughs } from "./boughs.ts";
import { Gravel } from "./gravel.ts";

/** The leveling board: half its width (reaching half-way into the bank beyond the outer tines), and how far it runs ahead of the tines. */
const LEVEL_HALF = 0.066;
const LEAD = 0.03;
/** The hand rake every hand draws with: three tines. */
const HAND: RakeOptions = { width: 0.011, depth: 0.0028, ridge: 0.011, tines: 3, spacing: 0.022 };
const HAND_LEVEL_HALF = 0.04;
/** Shortest hand move that rakes, garden depths. */
const HAND_STEP = 0.003;
/** Between strokes the rake is lifted and carried: this much plan distance of rest. */
const STROKE_PAUSE = 0.05;
/** Garden depths per second at the pace's full travel. */
const RAKE_SPEED = 0.08;
/** Longest piece the rake cuts in one go (garden depths): a slow frame is cut in several. */
const MAX_PIECE = 0.0015;
/** Where the rake starts after a layout (the plan point nearest it): left of centre, in both views. */
const LIVE_START = { x: 0.66, y: 0.56 } as const;

const KNOBS = ["raking"] as const;

/** The unseen rake on the plan and every hand's rake (see the header). */
class RakingSim implements LayerSim {
  readonly #knobs: KnobReader<(typeof KNOBS)[number]>;
  #gravel: Gravel | undefined = undefined;
  #boughs: Boughs | undefined = undefined;
  /** The gravel's layout the rake was last set down on. */
  #generation = 0;
  #stroke = 0;
  #along = 0;
  /** Index of the plan vertex at or before #along on the current stroke. */
  #vertex = 0;
  #pause = 0;
  /** The rake has just been set down: level the stretch ahead of its tines before the first cut. */
  #landing = true;
  /** Where the rake's tines are and which way they travel (for sweeping up leaves); on while raking. */
  #rakeX = 0;
  #rakeY = 0;
  #rakeDX = 1;
  #rakeDY = 0;
  #rakeOn = false;
  readonly #segA = new Float64Array(2);
  readonly #segB = new Float64Array(2);
  /** The garden point under a hand (x, y), written by the gravel's view. */
  readonly #ground = new Float64Array(2);
  // The hand rakes, one per hand: whether it is on the gravel, and where it last raked to.
  readonly #handOn = new Uint8Array(MAX_PRINCIPALS);
  readonly #handX = new Float64Array(MAX_PRINCIPALS);
  readonly #handY = new Float64Array(MAX_PRINCIPALS);

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden raking", params, KNOBS);
  }

  frame(frame: LayerFrame): void {
    const gravel = frame.host("gravel");
    const boughs = frame.host("boughs");
    this.#gravel = gravel instanceof Gravel ? gravel : undefined;
    this.#boughs = boughs instanceof Boughs ? boughs : undefined;
    if (this.#gravel === undefined || !this.#gravel.laid) return;
    if (this.#gravel.generation !== this.#generation) {
      this.#generation = this.#gravel.generation;
      this.#setDown(this.#gravel.plan);
    }
    const speed = RAKE_SPEED * clamp(this.#knobs.value(frame, "raking"), 0, 1);
    const step = Math.min(Math.max(frame.dt, 0), 0.1) * frame.motion;
    if (step > 0) {
      if (speed > 0) {
        this.#advance(this.#gravel, speed * step);
        if (this.#rakeOn)
          this.#boughs?.sweep(
            this.#rakeX,
            this.#rakeY,
            this.#rakeDX,
            this.#rakeDY,
            LEVEL_HALF,
            speed,
          );
      } else {
        this.#rakeOn = false;
      }
    }
    for (let i = 0; i < MAX_PRINCIPALS; i++)
      this.#handRake(this.#gravel, i, frame.principals[i], speed);
  }

  // The rake and its plan are the gravel's: nothing of its own to release.
  dispose(): void {}

  /** A fresh layout: the rake set down at the plan point nearest LIVE_START. */
  #setDown(plan: readonly Stroke[]): void {
    this.#rakeOn = false;
    let best = Infinity;
    let start = 0;
    let offset = 0;
    for (const stroke of plan) {
      const n = stroke.xy.length >> 1;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(
          (stroke.xy[2 * i] ?? 0) - LIVE_START.x,
          (stroke.xy[2 * i + 1] ?? 0) - LIVE_START.y,
        );
        if (d < best) {
          best = d;
          start = offset + (stroke.at[i] ?? 0);
        }
      }
      offset += stroke.length + STROKE_PAUSE;
    }
    this.#seek(plan, start);
  }

  /** Set the rake down at plan distance `at` (pauses count STROKE_PAUSE each). */
  #seek(plan: readonly Stroke[], at: number): void {
    this.#landing = true;
    let rest = at;
    for (let k = 0; k < plan.length; k++) {
      const stroke = plan[k];
      if (stroke === undefined) continue;
      if (rest < stroke.length) {
        this.#stroke = k;
        this.#along = rest;
        this.#pause = 0;
        this.#vertex = 0;
        while ((stroke.at[this.#vertex + 1] ?? Infinity) <= rest) this.#vertex++;
        return;
      }
      rest -= stroke.length;
      if (rest < STROKE_PAUSE) {
        this.#stroke = (k + 1) % plan.length;
        this.#along = 0;
        this.#vertex = 0;
        this.#pause = STROKE_PAUSE - rest;
        return;
      }
      rest -= STROKE_PAUSE;
    }
    this.#stroke = 0;
    this.#along = 0;
    this.#vertex = 0;
    this.#pause = 0;
  }

  /**
   * Move the rake `distance` along the plan: level ahead, cut, note the freshly raked gravel. It
   * goes in steps of at most MAX_PIECE, so on a bend each piece's banks meet the next's evenly.
   */
  #advance(gravel: Gravel, distance: number): void {
    const plan = gravel.plan;
    let budget = distance;
    let guard = 0;
    this.#rakeOn = false;
    while (budget > 1e-9 && plan.length > 0 && guard++ < 10_000) {
      if (this.#pause > 0) {
        const rest = Math.min(this.#pause, budget);
        this.#pause -= rest;
        budget -= rest;
        continue;
      }
      const stroke = plan[this.#stroke];
      if (stroke === undefined) {
        this.#stroke = 0;
        continue;
      }
      const s0 = this.#along;
      const s1 = Math.min(stroke.length, s0 + Math.min(budget, MAX_PIECE));
      if (this.#landing) {
        this.#pieces(gravel, stroke, s0, Math.min(s0 + LEAD, stroke.length), this.#vertex, false);
        this.#landing = false;
      }
      this.#pieces(
        gravel,
        stroke,
        Math.min(s0 + LEAD, stroke.length),
        Math.min(s1 + LEAD, stroke.length),
        this.#vertex,
        false,
      );
      this.#vertex = this.#pieces(gravel, stroke, s0, s1, this.#vertex, true);
      budget -= s1 - s0;
      this.#along = s1;
      if (s1 >= stroke.length) {
        this.#stroke = (this.#stroke + 1) % plan.length;
        this.#along = 0;
        this.#vertex = 0;
        this.#pause = STROKE_PAUSE;
        this.#landing = true;
      }
    }
  }

  /** Point at distance s along a stroke into `out`, searching from vertex index `from`. */
  #pointAt(stroke: Stroke, s: number, from: number, out: Float64Array): number {
    let i = Math.max(0, from);
    const last = (stroke.xy.length >> 1) - 1;
    while (i < last - 1 && (stroke.at[i + 1] ?? Infinity) <= s) i++;
    const a = stroke.at[i] ?? 0;
    const b = stroke.at[i + 1] ?? a;
    const t = b > a ? clamp((s - a) / (b - a), 0, 1) : 0;
    out[0] = lerp(stroke.xy[2 * i] ?? 0, stroke.xy[2 * i + 2] ?? 0, t);
    out[1] = lerp(stroke.xy[2 * i + 1] ?? 0, stroke.xy[2 * i + 3] ?? 0, t);
    return i;
  }

  /** Visit the polyline pieces of a stroke between distances s0 and s1: cut each with the tines (`rake`), or level it. */
  #pieces(
    gravel: Gravel,
    stroke: Stroke,
    s0: number,
    s1: number,
    from: number,
    rake: boolean,
  ): number {
    if (!(s1 > s0)) return from;
    const a = this.#segA;
    const b = this.#segB;
    let i = this.#pointAt(stroke, s0, from, a);
    let s = s0;
    while (s < s1) {
      const next = Math.min(s1, stroke.at[i + 1] ?? s1);
      i = this.#pointAt(stroke, next, i, b);
      const ax = a[0] ?? 0;
      const ay = a[1] ?? 0;
      const bx = b[0] ?? 0;
      const by = b[1] ?? 0;
      if (rake) {
        // The tines cut one piece of the plan, and the gravel it turned over is stamped fresh.
        gravel.groove(ax, ay, bx, by, RAKE, LEVEL_HALF);
        const length = Math.hypot(bx - ax, by - ay);
        if (length > 1e-9) {
          this.#rakeDX = (bx - ax) / length;
          this.#rakeDY = (by - ay) / length;
        }
        this.#rakeX = bx;
        this.#rakeY = by;
        this.#rakeOn = true;
      } else {
        gravel.level(ax, ay, bx, by, LEVEL_HALF);
      }
      a[0] = bx;
      a[1] = by;
      if (next <= s) break;
      s = next;
      if ((stroke.at[i + 1] ?? Infinity) <= s) i++;
    }
    return i;
  }

  /**
   * Hand `i` (undefined: not present) dragged on the gravel rakes its own lines with a hand rake.
   * Every hand rakes alike; the cast's agents, who press without moving, set it down and lift it.
   */
  #handRake(gravel: Gravel, i: number, hand: PrincipalState | undefined, speed: number): void {
    const at = this.#ground;
    if (
      hand === undefined ||
      !(hand.inside && hand.down && gravel.view.groundUnder(hand.x, hand.y, at)) ||
      gravel.onStone(at[0] ?? 0, at[1] ?? 0)
    ) {
      this.#handOn[i] = 0;
      return;
    }
    const x = at[0] ?? 0;
    const y = at[1] ?? 0;
    if (this.#handOn[i] !== 1 || hand.pressed) {
      this.#handOn[i] = 1;
      this.#handX[i] = x;
      this.#handY[i] = y;
      return;
    }
    const fromX = this.#handX[i] ?? x;
    const fromY = this.#handY[i] ?? y;
    const length = Math.hypot(x - fromX, y - fromY);
    if (length < HAND_STEP) return;
    gravel.level(fromX, fromY, x, y, HAND_LEVEL_HALF);
    gravel.groove(fromX, fromY, x, y, HAND, HAND_LEVEL_HALF);
    this.#boughs?.sweep(
      x,
      y,
      (x - fromX) / length,
      (y - fromY) / length,
      HAND_LEVEL_HALF,
      Math.max(speed, 0.05),
    );
    this.#handX[i] = x;
    this.#handY[i] = y;
  }
}

/** The raking chore's sim (LayerCode.sim). */
export function rakingSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new RakingSim(params);
}
