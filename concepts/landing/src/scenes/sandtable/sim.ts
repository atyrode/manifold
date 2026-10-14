// The sand table's two machines (see index.ts), and the sand they work.
//
// Ball: a steel ball pulled through fine sand by a magnet under the table, as in Bruce Shapiro's
// Sisyphus tables. The magnet runs theta–rho tracks at an even pace; the ball chases it on a damped
// spring (so corners come out rounded) and ploughs a groove whose spoil banks up either side
// (HeightField.groove). Between drawings an erase spiral, its turns closer than a groove and ridden
// shallower, goes straight over the last: wherever it crosses, it scrapes the old banks away and
// fills the old grooves, until the table lies groomed for the next drawing. The Manifold M is one
// continuous stroke from foot to foot, drawn at once when asked for (or every few drawings, on a
// freshly groomed table), and lit in the accent as far as the ball has drawn it.
//
// Pendulum: a funnel of sand on a string, a damped two-axis pendulum
//   u'' = -wu² u - 2γ u' + 2Ω v'        v'' = -wv² v - 2γ v' - 2Ω u'
// (two frequencies a hair off a rational ratio, slow damping, a slight Coriolis-like turn Ω), in
// axes turned to suit each figure. It trickles sand onto dark slate at an even rate
// (HeightField.stamp), so the line runs thin where the funnel is fast and heaps where it turns. The
// rosette grows inward as the swing dies away; then a straight edge scrapes the slate clean,
// shoving what it gathers ahead in a berm and off the far side, and the funnel is refilled and
// swung again with new frequencies.
//
// Throughout, the sand slumps to its angle of repose (HeightField.relax).
//
// Passages (SANDTABLE_PASSAGE), in the world and on the sim's own clock: the ball rolls in from the
// side of the frame and ploughs along its track as far as the opening table has it (or, with the M
// track on, draws the M as far as it is drawn at first); the funnel is carried in on its string and
// starts to pour. On the way out a straight edge sweeps the table from the far side of the frame,
// leaving the sand smooth (the pendulum's shoves its berm off the table), the ball pushed ahead of it
// out of the frame and the funnel carried off before it. At rest none of it exists.
//
// Field space, shared with the shader: the height field spans a square one field unit across,
// centred on the table, heights in field units too (a HeightField at aspect 1). The shader draws it
// SANDTABLE.span view heights across, so the grid never changes with the window. Tracks are laid in
// the unit disc, radius 1 = SANDTABLE.track.
//
// Uploads: uSim0 r16f heights, SANDTABLE.grid square; uSim1 rgba16f, 3 texels:
//   0  the ball or the funnel: centre (field units from the table's centre), shown 0..1, stream 0..1
//   1  the straight edge: normal (unit), offset of its middle along the normal, shown 0..1
//   2  the M: lit 0..1, its height in field units; ball: how much of it is drawn, in mark units along
//      its stroke (positive from the left foot, negative from the right); pendulum: the funnel's
//      fill 0..1; 0
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { domeProfile, HeightField, type GrooveOptions } from "../../sims/heightfield.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

export class SandtableError extends Error {}

const TAU = Math.PI * 2;

/** The table, in field units; the shader draws with the same numbers. */
export const SANDTABLE = {
  /** View heights per field unit on a landscape screen (on a portrait one, times its aspect). */
  span: 0.9,
  /** Radius of the sand, out to the rim's inner edge. */
  sand: 0.47,
  /** Width of the rim, and how far it stands above the sand. */
  rim: 0.055,
  rimHeight: 0.018,
  /** Farthest the ball's centre goes from the middle: radius 1 of the theta–rho tracks. */
  track: 0.452,
  /**
   * The steel ball's radius (some 2.9% of the table across; the shader keeps it at least ten cells
   * across on coarse pixels), and the groove it ploughs, about where a ball that size sinking a
   * groove's depth meets the sand.
   */
  ball: 0.015,
  groove: 0.021,
  /** Height-field texels across the field (about a cell and a half each on screen). */
  grid: 320,
  /** The pendulum's funnel: radius of its mouth, and how high it hangs over the table. */
  funnel: 0.026,
  funnelHeight: 0.2,
  /** The straight edge that wipes the slate: its width and height. */
  edge: 0.018,
  edgeHeight: 0.012,
  /** Groove depth at the bottom of the depth knob, and what the whole knob adds. */
  depthMin: 0.0015,
  depthRange: 0.005,
} as const;

export const sandtableMachines = ["ball", "pendulum"] as const;
export const sandtablePatterns = ["cycle", "spiral", "clover", "rose", "star", "waves", "loops"] as const;
export const sandtableFigures = ["cycle", "1:1", "1:2", "2:3", "3:4"] as const;
type Machine = (typeof sandtableMachines)[number];
type Pattern = (typeof sandtablePatterns)[number];
type Drawing = Exclude<Pattern, "cycle">;
type Figure = (typeof sandtableFigures)[number];
type Ratio = Exclude<Figure, "cycle">;

// ---- small helpers -------------------------------------------------------------------------------

type Rand = () => number;

function seedOf(seed: number, index: number, salt: number): number {
  return (Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ salt) >>> 0;
}

function pick<T>(items: readonly T[], rand: Rand): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new SandtableError("sandtable: nothing to pick from");
  return item;
}

const sign = (rand: Rand): number => (rand() < 0.5 ? -1 : 1);

/** Move `value` toward `target` by at most `step`. */
function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

const depthOf = (knob: number): number => SANDTABLE.depthMin + SANDTABLE.depthRange * knob;
/** Dry sand's angle of repose: rise over run, about 32°. */
const TALUS = 0.62;

// ---- knobs ---------------------------------------------------------------------------------------

const SANDTABLE_KNOBS = ["machine", "pattern", "figure", "speed", "renew", "drawings", "depth", "mark"] as const;
type Knob = (typeof SANDTABLE_KNOBS)[number];

interface Settings {
  machine: Machine;
  pattern: Pattern;
  figure: Figure;
  /** Drawing-speed multiplier. */
  speed: number;
  /** Seconds a finished drawing rests before the next; undefined while "next drawing" is off. */
  pause: number | undefined;
  seed: number;
  /** The groove-depth knob, 0..1. */
  depth: number;
  /** Height of the M drawn every few drawings, unit-disc units; 0 while the M track is off. */
  mark: number;
  /** Height of the M its "now" button draws. */
  markNow: number;
}

const markSize = (amount: number): number => 0.8 + 0.5 * amount;

/** The knobs as settings, written into `out` so a frame allocates nothing. */
function readSettings(knobs: KnobReader<Knob>, frame: SimFrame, out: Settings): void {
  const renew = knobs.value(frame, "renew");
  const mark = knobs.value(frame, "mark");
  out.machine = sandtableMachines[Math.round(knobs.value(frame, "machine"))] ?? "ball";
  out.pattern = sandtablePatterns[Math.round(knobs.value(frame, "pattern"))] ?? "cycle";
  out.figure = sandtableFigures[Math.round(knobs.value(frame, "figure"))] ?? "cycle";
  out.speed = Math.max(0.05, knobs.value(frame, "speed"));
  out.pause = renew > 0 ? 60 * renew : undefined;
  out.seed = Math.round(knobs.value(frame, "drawings"));
  out.depth = clamp(knobs.value(frame, "depth"), 0, 1);
  out.mark = mark > 0 ? markSize(mark) : 0;
  out.markNow = markSize(knobs.amount(frame, "mark"));
}

/** The pointer on the table, in field units from its centre. */
interface Touch {
  x: number;
  y: number;
  /** Pressed this frame, over the page and on the sand. */
  pressed: boolean;
  down: boolean;
}

// ---- theta–rho tracks ----------------------------------------------------------------------------

/** Longest straight piece of a track, unit-disc units (about a fifth of the groove). */
const TRACK_STEP = 0.01;
/** Length a drawing aims at, unit-disc units: some 16 field units, about four minutes at speed 1. */
const BUDGET = 16 / SANDTABLE.track;

interface Stop {
  /** Distance along the track, field units. */
  at: number;
  seconds: number;
}

/** What a track does to the sand: draws, grooms the table flat for the next drawing, or draws the M. */
type TrackKind = "draw" | "erase" | "mark";

/** The magnet's path: a polyline in the unit disc, walked at an even pace. */
interface Track {
  readonly xy: Float64Array;
  /** Distance along the path to each point, field units. */
  readonly at: Float64Array;
  readonly count: number;
  readonly length: number;
  /** Where the magnet waits a moment, so the ball catches up and turns a crisp corner. */
  readonly stops: readonly Stop[];
  /** Pace relative to the drawing speed. */
  readonly pace: number;
  readonly kind: TrackKind;
  /** The first stretch (field units) is a quick move into place, at TRANSIT_PACE. */
  readonly lead: number;
  /** For the M: how much of it (field units) was drawn before this track began. */
  readonly drawn: number;
}

/**
 * Lays a track from where the magnet stands. `to` and `sweep` work in a frame that can be turned
 * and mirrored, so every pattern is written once, starting from its own local point (rho, 0).
 */
class TrackBuilder {
  readonly #xy: number[];
  readonly #at: number[] = [0];
  readonly #stops: Stop[] = [];
  #x: number;
  #y: number;
  #length = 0;
  #cos = 1;
  #sin = 0;
  #mirror = 1;

  constructor(x: number, y: number) {
    this.#x = x;
    this.#y = y;
    this.#xy = [x, y];
  }

  /** Field units laid so far. */
  get length(): number {
    return this.#length;
  }

  /** Lay what follows turned by `angle`, mirrored across the local x axis when `mirror` < 0. */
  orient(angle: number, mirror: number): void {
    this.#cos = Math.cos(angle);
    this.#sin = Math.sin(angle);
    this.#mirror = mirror < 0 ? -1 : 1;
  }

  /** Straight on to (x, y) in the oriented frame. */
  to(x: number, y: number): void {
    const my = y * this.#mirror;
    this.#line(this.#cos * x - this.#sin * my, this.#sin * x + this.#cos * my);
  }

  /** The way a sand table's arm moves: angle and radius both change evenly, a spiral arc. */
  sweep(theta0: number, theta1: number, rho0: number, rho1: number): void {
    const reach = Math.abs(theta1 - theta0) * Math.max(rho0, rho1) + Math.abs(rho1 - rho0);
    const n = Math.ceil(reach / (0.5 * TRACK_STEP));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const theta = theta0 + (theta1 - theta0) * f;
      const rho = rho0 + (rho1 - rho0) * f;
      this.to(rho * Math.cos(theta), rho * Math.sin(theta));
    }
  }

  stop(seconds: number): void {
    this.#stops.push({ at: this.#length, seconds });
  }

  /**
   * Carry on with what is left of `track` beyond distance `from` (field units, on `segment`), stops
   * and all. The builder must stand at that point.
   */
  follow(track: Track, from: number, segment: number): void {
    const shift = this.#length - from;
    for (let i = segment + 1; i < track.count; i++) this.#line(track.xy[2 * i] ?? 0, track.xy[2 * i + 1] ?? 0);
    for (const stop of track.stops) if (stop.at >= from) this.#stops.push({ at: stop.at + shift, seconds: stop.seconds });
  }

  build(pace: number, kind: TrackKind, lead = 0, drawn = 0): Track {
    return {
      xy: Float64Array.from(this.#xy),
      at: Float64Array.from(this.#at),
      count: this.#at.length,
      length: this.#length,
      stops: this.#stops,
      pace,
      kind,
      lead,
      drawn,
    };
  }

  #line(x: number, y: number): void {
    const x0 = this.#x;
    const y0 = this.#y;
    const dx = x - x0;
    const dy = y - y0;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return;
    const n = Math.ceil(d / TRACK_STEP);
    const piece = (d / n) * SANDTABLE.track;
    for (let k = 1; k <= n; k++) {
      this.#xy.push(x0 + (dx * k) / n, y0 + (dy * k) / n);
      this.#length += piece;
      this.#at.push(this.#length);
    }
    this.#x = x;
    this.#y = y;
  }
}

/** The segment of `track` holding distance `s`, searching on from `hint`. */
function locate(track: Track, s: number, hint: number): number {
  const last = Math.max(0, track.count - 2);
  let i = Math.min(Math.max(0, hint), last);
  while (i < last && (track.at[i + 1] ?? Infinity) < s) i++;
  return i;
}

/** The point at distance `s` on `segment` of `track`, unit-disc units. */
function trackPoint(track: Track, segment: number, s: number, out: { x: number; y: number }): void {
  const i = segment;
  const j = Math.min(i + 1, track.count - 1);
  const a = track.at[i] ?? 0;
  const b = track.at[j] ?? a;
  const f = b > a ? clamp((s - a) / (b - a), 0, 1) : 0;
  const x0 = track.xy[2 * i] ?? 0;
  const y0 = track.xy[2 * i + 1] ?? 0;
  out.x = x0 + ((track.xy[2 * j] ?? x0) - x0) * f;
  out.y = y0 + ((track.xy[2 * j + 1] ?? y0) - y0) * f;
}

/**
 * A builder at (fromX, fromY), turned so the pattern, laid from its local point (startRho, 0),
 * begins where a short theta–rho move from there arrives: the arm turns half a turn per unit of
 * radius it crosses, in the pattern's own sense, so a drawing opens with a spiral arm, not a spoke.
 */
function begin(fromX: number, fromY: number, startRho: number, rand: Rand): TrackBuilder {
  const rho = Math.min(1, Math.hypot(fromX, fromY));
  const theta = Math.atan2(fromY, fromX);
  const mirror = sign(rand);
  const lead = Math.PI * Math.abs(startRho - rho);
  const builder = new TrackBuilder(fromX, fromY);
  builder.orient(theta + mirror * lead, mirror);
  builder.sweep(-lead, 0, rho, startRho);
  return builder;
}

/**
 * Erase spiral: one groove wound from `from` (0 centre, 1 rim) to the other end, its turns some
 * three quarters of a groove apart and ridden shallower than a drawing (ERASE_DEPTH), so each turn
 * shaves its neighbour's bank and buries whatever was there, leaving only the faint ripple of a
 * record's grooves for the next drawing to stand out on.
 */
function spiral(b: TrackBuilder, from: number, rand: Rand): void {
  const spacing = SANDTABLE.groove * (0.75 + 0.1 * rand());
  const turns = Math.max(4, Math.round(SANDTABLE.track / spacing));
  const steps = turns * 360;
  for (let k = 1; k <= steps; k++) {
    const u = k / steps;
    const theta = TAU * turns * u;
    const rho = from + (1 - 2 * from) * u;
    b.to(rho * Math.cos(theta), rho * Math.sin(theta));
  }
}

/**
 * Clover sweep: lobes swept round and round between an inner radius and the rim, each turn slipping
 * on by a share of a lobe, so after `turns` turns the lobes have woven a closed rosette.
 */
function clover(b: TrackBuilder, rand: Rand): void {
  const lobes = pick([3, 4, 5, 6, 7], rand);
  const inner = 0.05 + 0.3 * rand();
  const shape = 0.6 + 1.1 * rand();
  const perTurn = Math.hypot((TAU * (1 + inner)) / 2, 2 * lobes * (1 - inner));
  const turns = clamp(Math.round(BUDGET / perTurn), 3, 9);
  const k = lobes * (1 + sign(rand) / (lobes * turns));
  const steps = turns * lobes * 96;
  for (let i = 1; i <= steps; i++) {
    const theta = (TAU * turns * i) / steps;
    const rho = inner + (1 - inner) * Math.pow(0.5 + 0.5 * Math.cos(k * theta), shape);
    b.to(rho * Math.cos(theta), rho * Math.sin(theta));
  }
}

/** Rhodonea r = cos(n/d θ): overlapping petals through the centre. */
const ROSES: readonly (readonly [number, number])[] = [[3, 2], [5, 2], [5, 3], [7, 3], [4, 3], [5, 4], [7, 4], [8, 5], [7, 2]];

/**
 * A rose, closed after π·d (n·d odd) or 2π·d, so it ends on the rim where it began. A short one is
 * drawn again, turned to fall between its own petals, until it fills the drawing's length.
 */
function rose(b: TrackBuilder, rand: Rand): void {
  const [n, d] = pick(ROSES, rand);
  const k = n / d;
  const span = (n * d) % 2 === 1 ? Math.PI * d : TAU * d;
  const steps = Math.ceil(span * Math.max(1, k) * 120);
  let passes = 1;
  let offset = 0;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) {
      const next = (pass * Math.PI) / (k * passes);
      b.sweep(offset, next, 1, 1);
      offset = next;
    }
    const start = b.length;
    for (let i = 1; i <= steps; i++) {
      const theta = (span * i) / steps;
      const r = Math.cos(k * theta);
      b.to(r * Math.cos(theta + offset), r * Math.sin(theta + offset));
    }
    if (pass === 0) passes = clamp(Math.round((BUDGET * SANDTABLE.track) / (b.length - start)), 1, 3);
  }
}

/** Star polygons {n/k}. */
const STARS: readonly (readonly [number, number])[] = [[5, 2], [7, 2], [7, 3], [8, 3], [9, 2], [9, 4], [11, 3], [11, 4], [12, 5]];

/**
 * Star vortex: a star polygon's chords, each vertex a little nearer the centre and turned a little
 * on, so the stars nest into a turning funnel. Inward from the rim, or outward from the centre.
 */
function star(b: TrackBuilder, from: number, rand: Rand): void {
  const [n, k] = pick(STARS, rand);
  const chord = 2 * Math.sin((Math.PI * k) / n);
  const shrink = clamp(-Math.log(1 - chord / BUDGET), 0.012, 0.16);
  const step = (TAU * k) / n + (0.004 + 0.03 * rand()) * sign(rand);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; ; j++) {
    const rho = Math.exp(-shrink * j);
    if (rho < 0.06) break;
    xs.push(rho * Math.cos(j * step));
    ys.push(rho * Math.sin(j * step));
  }
  xs.push(0);
  ys.push(0);
  const count = xs.length;
  for (let j = 0; j < count; j++) {
    const i = from > 0.5 ? j : count - 1 - j;
    b.to(xs[i] ?? 0, ys[i] ?? 0);
  }
}

/**
 * Twisted waves: a wide spiral from `from` to the other end, rippled across its turns; the ripples'
 * phase turns with the radius, so their crests line up into curving spokes.
 */
function waves(b: TrackBuilder, from: number, rand: Rand): void {
  const pitch = (SANDTABLE.groove * (2.6 + 0.9 * rand())) / SANDTABLE.track;
  const turns = Math.max(3, Math.round(1 / pitch));
  const ripples = 5 + Math.floor(rand() * 8);
  const amplitude = 0.32 / turns;
  const twist = (0.5 + 1.5 * rand()) * sign(rand);
  const steps = turns * Math.max(360, ripples * 48);
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const theta = TAU * turns * u;
    const base = from + (1 - 2 * from) * u;
    // Calm at the centre and the rim, so it starts and ends exactly there.
    const taper = smoothstep(0, 1, Math.min(1, base / 0.12, (1 - base) / 0.12));
    const rho = base + amplitude * taper * Math.sin(ripples * theta + twist * TAU * base);
    b.to(rho * Math.cos(theta), rho * Math.sin(theta));
  }
}

/**
 * Spirograph loops: z(t) = (1 - β) e^{it} + β e^{±ict}, c a hair over a whole number so the curls
 * creep round and close after `turns` turns, back on the rim where they began.
 */
function loops(b: TrackBuilder, rand: Rand): void {
  const m = 3 + Math.floor(rand() * 5);
  const beta = 0.18 + 0.14 * rand();
  const sense = rand() < 0.6 ? -1 : 1;
  const perTurn = TAU * Math.hypot(1 - beta, m * beta);
  const turns = clamp(Math.round(BUDGET / perTurn), 2, 7);
  const c = sense * (m + 1 / turns);
  const steps = turns * (m + 1) * 120;
  for (let i = 1; i <= steps; i++) {
    const t = (TAU * turns * i) / steps;
    b.to((1 - beta) * Math.cos(t) + beta * Math.cos(c * t), (1 - beta) * Math.sin(t) + beta * Math.sin(c * t));
  }
}

/** Seconds the magnet waits at each corner of the M, so the ball turns it crisply. */
const MARK_STOP = 0.5;

/**
 * Erase spirals run at twice the drawings' pace, moves into place at two and a half times. The M is
 * an event: it runs on the scene clock whatever the lab's motion, at about the pace a drawing has at
 * the default motion.
 */
const ERASE_PACE = 2;
const MARK_PACE = 0.6;
const TRANSIT_PACE = 2.5;

/**
 * The M, `size` unit-disc units tall, as one continuous stroke from foot to foot: a brisk theta–rho
 * move from the magnet to the nearer foot (the track's lead), then up, down into the V, up and
 * down, pausing at each corner.
 */
function markTrack(size: number, fromX: number, fromY: number): Track {
  const order = fromX < 0 ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
  const foot = markVertex(order[0] ?? 0);
  const footX = foot[0] * size;
  const footY = foot[1] * size;
  const rho0 = Math.min(1, Math.hypot(fromX, fromY));
  const theta1 = Math.atan2(footY, footX);
  const theta0 = rho0 > 0.02 ? Math.atan2(fromY, fromX) : theta1;
  let turn = theta1 - theta0;
  turn -= TAU * Math.round(turn / TAU);
  const b = new TrackBuilder(fromX, fromY);
  b.sweep(theta0, theta0 + turn, rho0, Math.hypot(footX, footY));
  const lead = b.length;
  b.stop(MARK_STOP);
  for (const index of order.slice(1)) {
    const vertex = markVertex(index);
    b.to(vertex[0] * size, vertex[1] * size);
    b.stop(MARK_STOP);
  }
  return b.build(MARK_PACE, "mark", lead);
}

type Job =
  | { kind: "drawing"; drawing: Drawing; seed: number }
  /** An erase spiral from the centre out to the rim, for the M to come in from. */
  | { kind: "erase"; seed: number }
  | { kind: "mark"; size: number };

/** The drawings the cycle brings round, an erase spiral between each. */
const ROTATION: readonly Exclude<Drawing, "spiral">[] = ["clover", "rose", "star", "waves", "loops"];

/** Even drawings are erase spirals; the odd ones the chosen pattern, or the cycle's next. */
function drawingAt(pattern: Pattern, index: number): Drawing {
  if (pattern === "spiral" || index % 2 === 0) return "spiral";
  if (pattern !== "cycle") return pattern;
  return ROTATION[((index - 1) / 2) % ROTATION.length] ?? "clover";
}

function buildTrack(job: Job, fromX: number, fromY: number): Track {
  switch (job.kind) {
    case "drawing":
      return drawingTrack(job.drawing, mulberry32(job.seed), fromX, fromY);
    case "erase": {
      const rand = mulberry32(job.seed);
      const b = begin(fromX, fromY, 0, rand);
      spiral(b, 0, rand);
      return b.build(ERASE_PACE, "erase");
    }
    case "mark":
      return markTrack(job.size, fromX, fromY);
    default: {
      const unreachable: never = job;
      throw new SandtableError(`sandtable: unknown job ${String(unreachable)}`);
    }
  }
}

function drawingTrack(drawing: Drawing, rand: Rand, fromX: number, fromY: number): Track {
  // Spirals, stars and waves set off from wherever the ball is, the centre or the rim; the rest
  // start and end on the rim.
  const side = Math.hypot(fromX, fromY) < 0.5 ? 0 : 1;
  switch (drawing) {
    case "spiral": {
      const b = begin(fromX, fromY, side, rand);
      spiral(b, side, rand);
      return b.build(ERASE_PACE, "erase");
    }
    case "clover": {
      const b = begin(fromX, fromY, 1, rand);
      clover(b, rand);
      return b.build(1, "draw");
    }
    case "rose": {
      const b = begin(fromX, fromY, 1, rand);
      rose(b, rand);
      return b.build(1, "draw");
    }
    case "star": {
      const b = begin(fromX, fromY, side, rand);
      star(b, side, rand);
      return b.build(1, "draw");
    }
    case "waves": {
      const b = begin(fromX, fromY, side, rand);
      waves(b, side, rand);
      return b.build(1, "draw");
    }
    case "loops": {
      const b = begin(fromX, fromY, 1, rand);
      loops(b, rand);
      return b.build(1, "draw");
    }
    default: {
      const unreachable: never = drawing;
      throw new SandtableError(`sandtable: unknown drawing ${String(unreachable)}`);
    }
  }
}

// ---- entrances and exits -------------------------------------------------------------------------

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). The sim runs the entrance on its
 * own clock, which starts once the opening table is laid, so a slow first frame cannot use it up.
 */
export const SANDTABLE_PASSAGE: { enter: number; exit: number } = { enter: 2.6, exit: 1.6 };

/** What the sim tells a machine of the scene's passage each frame. */
interface Passage {
  /** Seconds since the table was laid, while the scene is arriving; Infinity when it is not. */
  arrive: number;
  /** The exit's progress: 0 until the scene leaves, then 0→1. */
  leave: number;
  /** The frame's width over its height. */
  aspect: number;
}

/** The machine sets off this long after the table is laid and takes this long to arrive (well inside the entrance). */
const ARRIVE_DELAY = 0.15;
const ARRIVE_SECONDS = 1.7;
/** How far past the frame's edge (field units) a machine starts from, and the straight edge starts and ends. */
const OFF_FRAME = 0.08;
/** The ball ploughs its roll-in in strokes this long (field units). */
const ROLL_STEP = 0.01;
/** The ball's wipe sets off this far into the exit (0..1). */
const BALL_SWEEP_FROM = 0.05;
/**
 * The pendulum's exit: the stream shuts over SHUT_SECONDS, the funnel is carried off between
 * CARRY_FROM (once the stream is shut) and CARRY_TO of the exit, and the edge sweeps from SWEEP_FROM on.
 */
const SHUT_SECONDS = 0.25;
const CARRY_FROM = SHUT_SECONDS / SANDTABLE_PASSAGE.exit;
const CARRY_TO = 0.7;
const SWEEP_FROM = 0.3;
/** The last stretch behind the ball's wipe is levelled again each step (field units): slumping may creep in behind it. */
const SWEEP_BACK = 0.012;

const aspectOf = (frame: SimFrame): number => (Number.isFinite(frame.aspect) && frame.aspect > 0 ? frame.aspect : 16 / 9);

/** Half the frame's width and height in field units (the shader's mapping, inverted). */
function frameHalf(aspect: number): { w: number; h: number } {
  const scale = SANDTABLE.span * Math.min(1, aspect);
  return { w: (0.5 * aspect) / scale, h: 0.5 / scale };
}

/** Rolls in fast and settles: the mean of an ease-out and a smoothstep. */
const settleEase = (u: number): number => 0.5 * (smoothstep(0, 1, u) + 1 - (1 - u) * (1 - u));
/** Sets off gently and goes on at pace: the mean of an ease-in and a smoothstep. */
const departEase = (u: number): number => 0.5 * (smoothstep(0, 1, u) + u * u);

/**
 * The ball's roll-in: from off the frame's side to where its track starts, then along the track as
 * far as the opening table has it (`run`, field units along the track), ploughing as it goes.
 */
interface Entry {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  approach: number;
  run: number;
  total: number;
  /** Distance rolled so far along the whole path. */
  at: number;
}

/** The ball's wipe: the straight edge's direction, the ball where it was found, and the edge's face. */
interface Wipe {
  nx: number;
  ny: number;
  bx: number;
  by: number;
  /** The ball's coordinate along the edge's direction. */
  bn: number;
  lead0: number;
  end: number;
  lead: number;
}

// ---- the ball ------------------------------------------------------------------------------------

/**
 * The magnet's pace at drawing speed 1 and full motion, field units per second; at the lab's default
 * motion of 0.6 that is some 0.066, about 20 cells a second at 300 rows.
 */
const BALL_SPEED = 0.11;
/** The ball chases the magnet on a damped spring: natural frequency (rad/s) and damping ratio. */
const SPRING = 9;
const SPRING_DAMPING = 0.85;
const BALL_SUBSTEP = 1 / 120;
/** The groove is extended once the ball has moved this far (field units). */
const GROOVE_STEP = 0.0025;
/**
 * Laying out the opening table: slices of drawing time, and longer strokes per groove (7 texels;
 * even on the innermost turns of a spiral the chord strays under half a texel from the curve).
 */
const PREWARM_SLICE = 0.05;
const PREWARM_GROOVE_STEP = 0.022;
/**
 * The opening table: a bed groomed, one drawing finished on it, and the ball this many seconds of
 * drawing time into the next track, so a short fresh groove trails behind it. With the M track on,
 * the ball has instead come in to the M and drawn this share of it.
 */
const PREWARM_LEAD = 3;
const PREWARM_MARK = 0.3;
/** Erase spirals ride this share of a drawing's groove depth, so the groomed bed stays quiet. */
const ERASE_DEPTH = 0.55;
/** While the M track is on, it comes round after this many drawings, and then rests this long. */
const MARK_EVERY = 4;
const MARK_REST = 40;
/** The M stays lit until the drawing after it is this far along, fading over this share. */
const MARK_FADE_FROM = 0.15;
const MARK_FADE_SPAN = 0.3;
/** The magnet chasing the pointer (field units per second), and how long after letting go the ball goes back. */
const FOLLOW_SPEED = 0.6;
const RESUME_AFTER = 2.5;
const SALT_DRAWING = 0x5a17;
const SALT_ERASE = 0xe2a5;

class Ball {
  readonly #field: HeightField;
  /** The ball's tools, drawing and erasing; kept and only retuned, as HeightField asks. */
  readonly #groove: GrooveOptions = { width: SANDTABLE.groove, depth: depthOf(0.5), ridge: 0.75 * SANDTABLE.groove };
  readonly #erase: GrooveOptions = { width: SANDTABLE.groove, depth: ERASE_DEPTH * depthOf(0.5), ridge: 0.75 * SANDTABLE.groove };
  #track: Track | undefined;
  #phase: "draw" | "rest" = "draw";
  /** Distance along the track (field units), its segment, the next stop, time left waiting there. */
  #s = 0;
  #segment = 0;
  #stop = 0;
  #wait = 0;
  #rested = 0;
  readonly #magnet = { x: 0, y: 0 };
  readonly #ball = { x: 0, y: 0, vx: 0, vy: 0 };
  /** Where the groove has been drawn to. */
  readonly #cut = { x: 0, y: 0 };
  readonly #point = { x: 0, y: 0 };
  /** The next drawing in the cycle, and drawings since the last M. */
  #drawing = 0;
  #sinceMark = 0;
  #queue: Job[] = [];
  /** The pointer has the ball (held), or had it and the ball has not gone back yet (away). */
  #held = false;
  #away = false;
  #idle = 0;
  /** The M: its height (field units), lit while it lies in the sand, how much is drawn, from which foot. */
  #markHeight = 0;
  #markLive = false;
  #markFading = false;
  #markDrawn = 0;
  #markSign = 1;
  /** The M track knob was on last frame (switching it on draws the M at once). */
  #markOn = false;
  #signature = "";
  /** The roll-in while the scene arrives, and the wipe while it leaves. */
  #entry: Entry | undefined;
  #wipe: Wipe | undefined;
  readonly #span = { from: 0, to: -1 };

  constructor(field: HeightField) {
    this.#field = field;
  }

  /**
   * A fresh table: a bed groomed, one drawing finished on it, and the ball just setting off on the
   * next; or, with the M track on, already part way up the M. With an `aspect` (the scene is
   * arriving) the ball is left off the frame's side instead, to roll in and take those last
   * moments up.
   */
  reset(settings: Settings, aspect: number | undefined): void {
    this.#field.fill(0);
    this.#magnet.x = 0;
    this.#magnet.y = 0;
    Object.assign(this.#ball, { x: 0, y: 0, vx: 0, vy: 0 });
    this.#cut.x = 0;
    this.#cut.y = 0;
    this.#drawing = 0;
    this.#sinceMark = 0;
    this.#queue = [];
    this.#held = false;
    this.#away = false;
    this.#entry = undefined;
    this.#wipe = undefined;
    this.#markLive = false;
    this.#markFading = false;
    this.#markOn = settings.mark > 0;
    this.#signature = `${settings.pattern}|${settings.seed}`;
    this.#retune(settings);
    for (let k = 0; k < 2; k++) {
      this.#next(settings);
      this.#runOut(Infinity);
    }
    if (this.#markOn) {
      this.#drawMark(settings.markNow);
      this.#next(settings);
      const track = this.#track;
      if (track !== undefined) {
        const reach = track.lead + PREWARM_MARK * (track.length - track.lead);
        if (aspect === undefined) this.#runOut(reach);
        else this.#beginEntry(aspect, reach);
      }
    } else {
      this.#next(settings);
      const track = this.#track;
      if (aspect === undefined) this.#drive(PREWARM_LEAD, GROOVE_STEP);
      else if (track !== undefined) this.#beginEntry(aspect, Math.min(track.length, PREWARM_LEAD * BALL_SPEED * track.pace));
    }
    for (let pass = 0; pass < 2; pass++) this.#field.relax(TALUS, 30, 1);
  }

  frame(dt: number, motion: number, touch: Touch, settings: Settings, next: boolean, markNow: boolean, passage: Passage): void {
    this.#retune(settings);
    if (passage.leave > 0) {
      this.#leave(passage);
      return;
    }
    const signature = `${settings.pattern}|${settings.seed}`;
    const markOn = settings.mark > 0;
    // Rolling in, the ball is left to it until something changes the table's course.
    if (this.#entry !== undefined) {
      if (signature === this.#signature && !next && !markNow && !(markOn && !this.#markOn)) {
        this.#roll(passage.arrive);
        return;
      }
      this.#entry = undefined;
    }
    // A new pattern or run of drawings starts at once, with the chosen pattern rather than an erase.
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#drawing = 1;
      this.#queue = [];
      this.#next(settings);
    }
    if (next) {
      this.#queue = [];
      this.#next(settings);
    }
    // The M at once when asked for, or when its knob is switched on.
    if (markNow || (markOn && !this.#markOn)) {
      this.#drawMark(settings.markNow);
      this.#next(settings);
    }
    this.#markOn = markOn;

    // The pointer takes the ball: the magnet chases it while held; a moment after letting go, the
    // ball goes back to where it left its drawing and carries on.
    if (touch.pressed) {
      this.#held = true;
      this.#away = true;
      this.#idle = 0;
    }
    if (this.#held && !touch.down) this.#held = false;
    if (this.#away && !this.#held) {
      this.#idle += dt;
      if (this.#idle >= RESUME_AFTER) this.#rejoin();
    }
    if (this.#away) {
      this.#chase(dt, touch);
      return;
    }

    // A track planned to follow (the M after its erase spiral) goes on at once; otherwise the
    // finished drawing rests, or stays while "next drawing" is off.
    if (this.#phase === "rest" && this.#queue.length > 0) {
      this.#next(settings);
    } else if (this.#phase === "rest" && settings.pause !== undefined) {
      this.#rested += dt * motion;
      const rest = this.#track?.kind === "mark" ? Math.max(MARK_REST, settings.pause) : settings.pause;
      if (this.#rested >= rest) this.#next(settings);
    }
    // The M is an event and plays on the scene clock; the drawings follow the lab's motion.
    const clock = this.#track?.kind === "mark" ? dt : dt * motion;
    this.#drive(clock * settings.speed, GROOVE_STEP);
  }

  write(data: Float32Array): void {
    const track = this.#track;
    if (track?.kind === "mark" && this.#markLive && !this.#markFading) {
      // Lit up to the ball, which trails the magnet by a little on its spring.
      const lag = Math.hypot(this.#ball.x - this.#magnet.x, this.#ball.y - this.#magnet.y);
      this.#markDrawn = Math.max(this.#markDrawn, track.drawn + this.#s - track.lead - lag);
    }
    const wipe = this.#wipe;
    data[0] = this.#ball.x;
    data[1] = this.#ball.y;
    data[2] = 1;
    data[3] = 0;
    data[4] = wipe === undefined ? 1 : wipe.nx;
    data[5] = wipe === undefined ? 0 : wipe.ny;
    data[6] = wipe === undefined ? 0 : wipe.lead - 0.5 * SANDTABLE.edge;
    data[7] = wipe === undefined ? 0 : 1;
    data[8] = this.#markShown();
    data[9] = this.#markHeight;
    data[10] = this.#markHeight > 0 ? (this.#markSign * this.#markDrawn) / this.#markHeight : 0;
    data[11] = 0;
  }

  #retune(settings: Settings): void {
    this.#groove.depth = depthOf(settings.depth);
    this.#erase.depth = ERASE_DEPTH * this.#groove.depth;
  }

  /** The M glows as it is drawn, until a whole track has gone over it. */
  #markShown(): number {
    if (!this.#markLive) return 0;
    if (!this.#markFading) return 1;
    const track = this.#track;
    const progress = track !== undefined && track.length > 0 ? this.#s / track.length : 1;
    return 1 - smoothstep(0, 1, (progress - MARK_FADE_FROM) / MARK_FADE_SPAN);
  }

  #plan(settings: Settings): void {
    // The M comes round in place of an erase spiral (it brings its own).
    if (settings.mark > 0 && this.#sinceMark >= MARK_EVERY && this.#drawing % 2 === 0) {
      this.#planMark(settings.mark, settings.seed);
      return;
    }
    const index = this.#drawing++;
    this.#sinceMark++;
    this.#queue.push({ kind: "drawing", drawing: drawingAt(settings.pattern, index), seed: seedOf(settings.seed, index, SALT_DRAWING) });
  }

  /**
   * In place of the next erase spiral (the index is even here): groom the table out to the rim, then
   * draw the M in from there. A drawing, not another erase, comes after it and slowly crosses it.
   */
  #planMark(size: number, seed: number): void {
    this.#sinceMark = 0;
    const index = this.#drawing++;
    this.#queue = [{ kind: "erase", seed: seedOf(seed, index, SALT_ERASE) }, { kind: "mark", size }];
  }

  /** The M at once, over whatever the table holds; an erase spiral comes after it. */
  #drawMark(size: number): void {
    this.#sinceMark = 0;
    if (this.#drawing % 2 === 1) this.#drawing--;
    this.#queue = [{ kind: "mark", size }];
  }

  #next(settings: Settings): void {
    if (this.#queue.length === 0) this.#plan(settings);
    const job = this.#queue.shift();
    if (job === undefined) throw new SandtableError("sandtable: nothing planned for the ball");
    const track = buildTrack(job, this.#magnet.x / SANDTABLE.track, this.#magnet.y / SANDTABLE.track);
    if (job.kind === "mark") {
      this.#markLive = true;
      this.#markFading = false;
      this.#markHeight = job.size * SANDTABLE.track;
      this.#markDrawn = 0;
      // It ends on the far foot: on the right, it set off from the left.
      this.#markSign = (track.xy[2 * track.count - 2] ?? 1) > 0 ? 1 : -1;
    } else if (this.#markLive) {
      if (this.#markFading) this.#markLive = false;
      else this.#markFading = true;
    }
    this.#track = track;
    this.#s = 0;
    this.#segment = 0;
    this.#stop = 0;
    this.#wait = 0;
    this.#rested = 0;
    this.#phase = "draw";
  }

  /** Draw on to distance `until` along the track (Infinity: its end), in slices, out of sight. */
  #runOut(until: number): void {
    while (this.#phase === "draw" && this.#s < until) this.#drive(PREWARM_SLICE, PREWARM_GROOVE_STEP);
    this.#carve(0);
  }

  /** `time` seconds of drawing time: the magnet walks its track, the ball chases and ploughs. */
  #drive(time: number, grooveStep: number): void {
    if (!(time > 0)) return;
    const n = Math.ceil(time / BALL_SUBSTEP);
    const h = time / n;
    for (let i = 0; i < n; i++) {
      if (this.#phase === "draw") this.#advance(h);
      this.#spring(h);
      this.#carve(grooveStep);
    }
  }

  /** Walk the magnet `time` seconds along its track, waiting at its stops; rest at its end. */
  #advance(time: number): void {
    const track = this.#track;
    if (track === undefined) return;
    let left = time;
    while (left > 0 && this.#phase === "draw") {
      if (this.#wait > 0) {
        const w = Math.min(this.#wait, left);
        this.#wait -= w;
        left -= w;
        continue;
      }
      const stop = track.stops[this.#stop];
      const stopAt = stop === undefined ? Infinity : stop.at;
      const transit = this.#s < track.lead;
      const goal = Math.min(stopAt, track.length, transit ? track.lead : Infinity);
      const v = BALL_SPEED * (transit ? TRANSIT_PACE : track.pace);
      const need = (goal - this.#s) / v;
      if (need > left) {
        this.#s += v * left;
        break;
      }
      this.#s = Math.max(this.#s, goal);
      left -= Math.max(0, need);
      if (stop !== undefined && this.#s >= stopAt) {
        this.#wait = stop.seconds;
        this.#stop++;
      } else if (this.#s >= track.length) {
        this.#phase = "rest";
        this.#rested = 0;
      }
    }
    this.#segment = locate(track, this.#s, this.#segment);
    trackPoint(track, this.#segment, this.#s, this.#point);
    this.#magnet.x = this.#point.x * SANDTABLE.track;
    this.#magnet.y = this.#point.y * SANDTABLE.track;
  }

  #spring(h: number): void {
    const b = this.#ball;
    const m = this.#magnet;
    const k = SPRING * SPRING;
    const c = 2 * SPRING_DAMPING * SPRING;
    b.vx += (k * (m.x - b.x) - c * b.vx) * h;
    b.vy += (k * (m.y - b.y) - c * b.vy) * h;
    b.x += b.vx * h;
    b.y += b.vy * h;
  }

  #carve(step: number): void {
    const b = this.#ball;
    const cut = this.#cut;
    if (Math.hypot(b.x - cut.x, b.y - cut.y) < Math.max(step, 1e-6)) return;
    const tool = !this.#away && this.#track?.kind === "erase" ? this.#erase : this.#groove;
    this.#field.groove(0.5 + cut.x, 0.5 + cut.y, 0.5 + b.x, 0.5 + b.y, tool);
    cut.x = b.x;
    cut.y = b.y;
  }

  /** The magnet chases the pointer (on the real clock), up to FOLLOW_SPEED, inside the track's reach. */
  #chase(dt: number, touch: Touch): void {
    if (!(dt > 0)) return;
    const r = Math.hypot(touch.x, touch.y);
    const k = r > SANDTABLE.track ? SANDTABLE.track / r : 1;
    const tx = touch.x * k;
    const ty = touch.y * k;
    const m = this.#magnet;
    const n = Math.ceil(dt / BALL_SUBSTEP);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.#held) {
        const dx = tx - m.x;
        const dy = ty - m.y;
        const d = Math.hypot(dx, dy);
        const reach = FOLLOW_SPEED * h;
        if (d > reach) {
          m.x += (dx / d) * reach;
          m.y += (dy / d) * reach;
        } else {
          m.x = tx;
          m.y = ty;
        }
      }
      this.#spring(h);
      this.#carve(GROOVE_STEP);
    }
  }

  /**
   * Back to the drawing: a brisk theta–rho move, the short way round, from where the pointer left
   * the magnet to where it left the track, then the rest of the track. Resting between drawings,
   * the next one simply starts from wherever the ball now is.
   */
  #rejoin(): void {
    this.#away = false;
    const track = this.#track;
    if (track === undefined || this.#phase !== "draw") return;
    const m = this.#magnet;
    const fromX = m.x / SANDTABLE.track;
    const fromY = m.y / SANDTABLE.track;
    trackPoint(track, this.#segment, this.#s, this.#point);
    const theta0 = Math.atan2(fromY, fromX);
    let turn = Math.atan2(this.#point.y, this.#point.x) - theta0;
    turn -= TAU * Math.round(turn / TAU);
    const b = new TrackBuilder(fromX, fromY);
    b.sweep(theta0, theta0 + turn, Math.min(1, Math.hypot(fromX, fromY)), Math.hypot(this.#point.x, this.#point.y));
    const lead = b.length + Math.max(0, track.lead - this.#s);
    const drawn = track.drawn + Math.max(0, this.#s - track.lead);
    b.follow(track, this.#s, this.#segment);
    this.#track = b.build(track.pace, track.kind, lead, drawn);
    this.#s = 0;
    this.#segment = 0;
    this.#stop = 0;
  }

  /**
   * The table as laid stops `run` field units along its track (the drawn part of the M, or the
   * erase spiral's first stretch). The ball is put off the frame's longer side, level with where
   * the track starts, to roll in to it and on along the track.
   */
  #beginEntry(aspect: number, run: number): void {
    const track = this.#track;
    if (track === undefined) return;
    const m = this.#magnet;
    const half = frameHalf(aspect);
    const sideways = aspect >= 1;
    const sx = sideways ? (m.x < 0 ? -1 : 1) * (half.w + OFF_FRAME) : m.x;
    const sy = sideways ? m.y : (m.y < 0 ? -1 : 1) * (half.h + OFF_FRAME);
    const inbound = Math.hypot(m.x - sx, m.y - sy);
    this.#entry = { sx, sy, tx: m.x, ty: m.y, approach: inbound, run, total: inbound + run, at: 0 };
    Object.assign(this.#ball, { x: sx, y: sy, vx: 0, vy: 0 });
    m.x = sx;
    m.y = sy;
    this.#cut.x = sx;
    this.#cut.y = sy;
    this.#s = 0;
    this.#segment = 0;
    this.#stop = 0;
    this.#wait = 0;
  }

  /** The roll-in at `arrive` seconds: the ball carried on along its path, ploughing as it goes. */
  #roll(arrive: number): void {
    const entry = this.#entry;
    const track = this.#track;
    if (entry === undefined || track === undefined) return;
    const u = clamp((arrive - ARRIVE_DELAY) / ARRIVE_SECONDS, 0, 1);
    const from = entry.at;
    const goal = Math.max(from, settleEase(u) * entry.total);
    const n = Math.max(1, Math.ceil((goal - from) / ROLL_STEP));
    for (let k = 1; k <= n; k++) {
      this.#rollTo(entry, track, from + ((goal - from) * k) / n);
      this.#carve(0);
    }
    entry.at = goal;
    if (u >= 1) this.#land(entry, track);
  }

  /** The ball, and the magnet with it, at `distance` along the roll-in's path. */
  #rollTo(entry: Entry, track: Track, distance: number): void {
    const b = this.#ball;
    if (distance <= entry.approach) {
      const f = entry.approach > 0 ? distance / entry.approach : 1;
      b.x = entry.sx + (entry.tx - entry.sx) * f;
      b.y = entry.sy + (entry.ty - entry.sy) * f;
      this.#s = 0;
    } else {
      const s = Math.min(distance - entry.approach, entry.run);
      this.#segment = locate(track, s, this.#segment);
      trackPoint(track, this.#segment, s, this.#point);
      b.x = this.#point.x * SANDTABLE.track;
      b.y = this.#point.y * SANDTABLE.track;
      this.#s = s;
    }
    b.vx = 0;
    b.vy = 0;
    this.#magnet.x = b.x;
    this.#magnet.y = b.y;
  }

  /** Arrived: the ball stands where the opening table has it, at rest, to be led on along the track. */
  #land(entry: Entry, track: Track): void {
    this.#entry = undefined;
    this.#rollTo(entry, track, entry.total);
    let passed = 0;
    while (passed < track.stops.length && (track.stops[passed]?.at ?? Infinity) <= entry.run) passed++;
    this.#stop = passed;
    this.#wait = 0;
    this.#cut.x = this.#ball.x;
    this.#cut.y = this.#ball.y;
  }

  /**
   * The exit at `passage.leave`: a straight edge sweeps the table from the far side of the frame,
   * levelling the sand behind its face and pushing the ball, which has stopped where it was, ahead
   * of it out of the frame.
   */
  #leave(passage: Passage): void {
    this.#entry = undefined;
    this.#held = false;
    this.#away = false;
    const wipe = this.#wipe ?? this.#beginWipe(passage.aspect);
    const sweep = departEase(clamp((passage.leave - BALL_SWEEP_FROM) / (1 - BALL_SWEEP_FROM), 0, 1));
    const lead = wipe.lead0 + (wipe.end - wipe.lead0) * sweep;
    if (lead > wipe.lead) {
      flatten(this.#field, wipe.nx, wipe.ny, wipe.lead - SWEEP_BACK, lead, this.#span);
      wipe.lead = lead;
    }
    const pushed = Math.max(wipe.bn, wipe.lead + SANDTABLE.ball);
    const b = this.#ball;
    b.x = wipe.bx + wipe.nx * (pushed - wipe.bn);
    b.y = wipe.by + wipe.ny * (pushed - wipe.bn);
    b.vx = 0;
    b.vy = 0;
    this.#magnet.x = b.x;
    this.#magnet.y = b.y;
  }

  /** The edge sweeps across the frame's shorter side, from the far side toward the one the ball is on. */
  #beginWipe(aspect: number): Wipe {
    const half = frameHalf(aspect);
    const b = this.#ball;
    const across = aspect < 1;
    const nx = across ? (b.x < 0 ? -1 : 1) : 0;
    const ny = across ? 0 : (b.y < 0 ? -1 : 1);
    const support = across ? half.w : half.h;
    const lead0 = -(support + SANDTABLE.edge + OFF_FRAME);
    const wipe: Wipe = { nx, ny, bx: b.x, by: b.y, bn: nx * b.x + ny * b.y, lead0, end: support + OFF_FRAME, lead: lead0 };
    this.#wipe = wipe;
    return wipe;
  }
}

// ---- the pendulum --------------------------------------------------------------------------------

/** The slower axis's period, seconds. */
const PERIOD = 5.6;
/**
 * Seconds from release until the swing is down to END_AMPLITUDE (field units, both axes together)
 * and the stream closes.
 */
const LIFE = 105;
const END_AMPLITUDE = 0.06;
/** The stream lands as a dome this wide (field units), at this rate per second at depth 0.5. */
const STREAM_RADIUS = 0.0065;
const FLOW = 0.045;
/** A hand on the funnel: spring toward the pointer (1/s²) and its damping (1/s). */
const PULL = 30;
const PULL_DAMPING = 8;
const SWING_SUBSTEP = 1 / 240;
/** Seconds for the stream to open or close, and for the straight edge to appear or go. */
const STREAM_FADE = 0.4;
const EDGE_FADE = 0.6;
/** The wipe: the edge's pace (field units per second) and the berm it shoves, how deep. */
const WIPE_SPEED = 0.09;
const BERM = 0.024;
/** The berm is kept in lanes across the edge, so sand only moves straight ahead of it. */
const LANES = 256;
const LANE_SPAN = 0.72;
/** Seconds to draw the funnel back and let go. */
const LAUNCH_SECONDS = 3;
/** The opening table: this share of a figure already drawn. */
const PREWARM_SWING = 0.45;
const SALT_FIGURE = 0xf16e;
const SALT_EDGE = 0xed9e;

const FIGURE_ROTATION: readonly Ratio[] = ["1:1", "2:3", "3:4", "1:2"];
const RATIOS: Readonly<Record<Ratio, readonly [number, number]>> = { "1:1": [1, 1], "1:2": [1, 2], "2:3": [2, 3], "3:4": [3, 4] };

const flowOf = (depth: number): number => FLOW * (0.4 + 1.2 * depth);
/** The berm's cross-section, heaped against the edge: u = 0 at its face, 1 at the berm's front. */
const bermProfile = (u: number): number => (u < 1 ? (1 - u) * (1 - u) : 0);
const laneOf = (t: number): number => clamp(Math.floor(((t + LANE_SPAN) / (2 * LANE_SPAN)) * LANES), 0, LANES - 1);

/** The columns of a texel row whose centres may lie in a band a ≤ n·p < b (empty: from > to). */
function bandColumns(nx: number, ny: number, y: number, a: number, b: number, out: { from: number; to: number }): void {
  const grid = SANDTABLE.grid;
  if (Math.abs(nx) < 1e-6) {
    const d = ny * y;
    out.from = 0;
    out.to = d >= a && d < b ? grid - 1 : -1;
    return;
  }
  const xa = (a - ny * y) / nx;
  const xb = (b - ny * y) / nx;
  out.from = Math.max(0, Math.floor((Math.min(xa, xb) + 0.5) * grid - 0.5));
  out.to = Math.min(grid - 1, Math.ceil((Math.max(xa, xb) + 0.5) * grid - 0.5));
}

/**
 * Level the sand behind a straight edge's face: every texel whose coordinate along (nx, ny) lies
 * from `from` up to `to` is set to the bed's height.
 */
function flatten(field: HeightField, nx: number, ny: number, from: number, to: number, span: { from: number; to: number }): void {
  const grid = SANDTABLE.grid;
  const data = field.data;
  let any = false;
  for (let j = 0; j < grid; j++) {
    const y = (j + 0.5) / grid - 0.5;
    bandColumns(nx, ny, y, from, to, span);
    for (let i = span.from; i <= span.to; i++) {
      const d = nx * ((i + 0.5) / grid - 0.5) + ny * y;
      if (d < from || d >= to) continue;
      const k = j * grid + i;
      if ((data[k] ?? 0) !== 0) {
        data[k] = 0;
        any = true;
      }
    }
  }
  if (any) field.touch();
}

/** The pointer when a hand is not to take the funnel. */
const NO_TOUCH: Touch = { x: 0, y: 0, pressed: false, down: false };

/** The funnel carried in from off the frame's side: the side it comes from and how far off it starts. */
interface Arrival {
  dx: number;
  dy: number;
  reach: number;
}

/** The funnel carried off, and the edge's start. */
interface Leaving {
  nx: number;
  ny: number;
  reach: number;
  lead0: number;
}

class Pendulum {
  readonly #field: HeightField;
  /** The swing in its own axes (turned by #cos, #sin from the table's), and their parameters. */
  #u = 0;
  #v = 0;
  #du = 0;
  #dv = 0;
  #wu = TAU / PERIOD;
  #wv = TAU / PERIOD;
  #damping = 0;
  #spin = 0;
  #cos = 1;
  #sin = 0;
  /** The funnel over the table, field units from its centre. */
  #x = 0;
  #y = 0;
  #phase: "swing" | "rest" | "wipe" | "launch" = "swing";
  #stream = 0;
  #fill = 1;
  #drain = 1 / LIFE;
  #rested = 0;
  #figure = 0;
  #held = false;
  readonly #edge = { nx: 1, ny: 0, lead: 0, end: 0, shown: 0 };
  /** Drawing the funnel back: from where it hung to the release point, and the swing it is let go into. */
  readonly #launch = { x: 0, y: 0, u: 0, v: 0, du: 0, dv: 0, t: 0 };
  readonly #lanes = new Float64Array(LANES);
  readonly #weights = new Float64Array(LANES);
  readonly #span = { from: 0, to: -1 };
  #signature = "";
  /**
   * The funnel is shown this far from where it hangs (field units), carried in or off by hand; the
   * stream pours at the true place, so it is shut while the two differ.
   */
  #offX = 0;
  #offY = 0;
  #arrival: Arrival | undefined;
  #leaving: Leaving | undefined;

  constructor(field: HeightField) {
    this.#field = field;
  }

  /**
   * A fresh slate with a figure part drawn, the funnel still swinging wide; or, with an `aspect`
   * (the scene is arriving), the funnel off the frame's side with its stream shut, to be carried in.
   */
  reset(settings: Settings, aspect: number | undefined): void {
    this.#field.fill(0);
    this.#figure = 0;
    this.#held = false;
    this.#edge.shown = 0;
    this.#arrival = undefined;
    this.#leaving = undefined;
    this.#offX = 0;
    this.#offY = 0;
    this.#signature = `${settings.figure}|${settings.seed}`;
    this.#setup(settings);
    this.#release();
    this.#stream = 1;
    const flow = flowOf(settings.depth);
    const seconds = Math.round(PREWARM_SWING * LIFE);
    for (let t = 0; t < seconds; t++) {
      this.#swing(1, flow, undefined);
      if (t % 8 === 7) this.#field.relax(TALUS, 30, 1);
    }
    this.#field.relax(TALUS, 30, 1);
    if (aspect !== undefined) this.#beginArrival(aspect);
  }

  frame(dt: number, motion: number, pointer: Touch, settings: Settings, next: boolean, passage: Passage): void {
    if (passage.leave > 0) {
      this.#leave(dt, motion, settings, passage);
      return;
    }
    // A new figure or run starts over: wipe, and swing the first of the new choice.
    const signature = `${settings.figure}|${settings.seed}`;
    // That, or a press of "next", ends the entrance where it is; and no hand takes the funnel on its way in.
    if (this.#arrival !== undefined && (signature !== this.#signature || next)) this.#carryIn(Infinity);
    const touch = this.#arrival === undefined ? pointer : NO_TOUCH;
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#figure = 0;
      this.#startWipe(settings);
    }
    if (next) this.#startWipe(settings);

    // A hand on the funnel: it follows the pointer, still pouring, and swings on from there.
    if (touch.pressed && (this.#phase === "swing" || this.#phase === "rest")) {
      this.#held = true;
      this.#phase = "swing";
      this.#rested = 0;
    }
    if (this.#held && !touch.down) this.#held = false;
    const time = this.#held ? dt : dt * motion * settings.speed;
    const flow = flowOf(settings.depth);
    const phase = this.#phase;
    switch (phase) {
      case "swing": {
        this.#stream = approach(this.#stream, this.#fill > 0 && this.#arrival === undefined ? 1 : 0, time / STREAM_FADE);
        this.#swing(time, flow, this.#held ? touch : undefined);
        // Both axes' amplitudes together: the turn trades swing between them but does no work, so
        // this dies away evenly, on time.
        const amplitude = Math.hypot(this.#u, this.#du / this.#wu, this.#v, this.#dv / this.#wv);
        if (!this.#held && amplitude < END_AMPLITUDE) {
          this.#phase = "rest";
          this.#rested = 0;
        }
        break;
      }
      case "rest":
        this.#stream = approach(this.#stream, 0, time / STREAM_FADE);
        this.#swing(time, flow, undefined);
        if (settings.pause !== undefined) {
          this.#rested += dt * motion;
          if (this.#rested >= settings.pause) this.#startWipe(settings);
        }
        break;
      case "wipe": {
        this.#stream = 0;
        this.#swing(time, 0, undefined);
        const edge = this.#edge;
        const from = edge.lead;
        edge.lead = Math.min(edge.end, edge.lead + WIPE_SPEED * time);
        if (edge.lead > from) this.#scrape(from, edge.lead);
        if (edge.lead >= edge.end) this.#beginLaunch(settings);
        break;
      }
      case "launch": {
        const l = this.#launch;
        l.t = Math.min(LAUNCH_SECONDS, l.t + time);
        const f = smoothstep(0, 1, l.t / LAUNCH_SECONDS);
        this.#x = l.x + (this.#cos * l.u - this.#sin * l.v - l.x) * f;
        this.#y = l.y + (this.#sin * l.u + this.#cos * l.v - l.y) * f;
        this.#fill = Math.max(this.#fill, f);
        if (l.t >= LAUNCH_SECONDS) this.#release();
        break;
      }
      default: {
        const unreachable: never = phase;
        throw new SandtableError(`sandtable: unknown pendulum phase ${String(unreachable)}`);
      }
    }
    this.#edge.shown = approach(this.#edge.shown, this.#phase === "wipe" ? 1 : 0, dt / EDGE_FADE);
    this.#carryIn(passage.arrive);
  }

  write(data: Float32Array): void {
    data[0] = this.#x + this.#offX;
    data[1] = this.#y + this.#offY;
    data[2] = 1;
    data[3] = this.#stream * Math.min(1, 6 * this.#fill);
    const edge = this.#edge;
    data[4] = edge.nx;
    data[5] = edge.ny;
    data[6] = edge.lead - 0.5 * SANDTABLE.edge;
    data[7] = edge.shown;
    data[8] = 0;
    data[9] = 0;
    data[10] = this.#fill;
    data[11] = 0;
  }

  /** The next figure: its ratio, detuning, damping, turn and release, into #launch. */
  #setup(settings: Settings): void {
    const index = this.#figure++;
    const rand = mulberry32(seedOf(settings.seed, index, SALT_FIGURE));
    const ratio = settings.figure === "cycle" ? FIGURE_ROTATION[index % FIGURE_ROTATION.length] ?? "1:1" : settings.figure;
    const [p, q] = RATIOS[ratio];
    const slow = TAU / PERIOD;
    this.#wu = slow;
    this.#wv = slow * (q / p) * (1 + (0.003 + 0.009 * rand()) * sign(rand));
    const au = 0.24 + 0.07 * rand();
    const av = 0.24 + 0.07 * rand();
    const lag = TAU * rand();
    this.#damping = Math.log(Math.hypot(au, av) / END_AMPLITUDE) / LIFE;
    this.#spin = (0.004 + 0.012 * rand()) * sign(rand);
    const turn = TAU * rand();
    this.#cos = Math.cos(turn);
    this.#sin = Math.sin(turn);
    // A little more sand than a whole figure takes, so the funnel only runs dry when pushed on.
    this.#drain = 1 / (1.2 * LIFE);
    const l = this.#launch;
    l.u = au;
    l.v = av * Math.cos(lag);
    l.du = 0;
    l.dv = -av * this.#wv * Math.sin(lag);
  }

  #release(): void {
    const l = this.#launch;
    this.#u = l.u;
    this.#v = l.v;
    this.#du = l.du;
    this.#dv = l.dv;
    this.#fill = 1;
    this.#phase = "swing";
    this.#place();
  }

  #place(): void {
    this.#x = this.#cos * this.#u - this.#sin * this.#v;
    this.#y = this.#sin * this.#u + this.#cos * this.#v;
  }

  /** `time` seconds of swing (semi-implicit Euler), pouring at `flow` while the stream is open. */
  #swing(time: number, flow: number, pull: Touch | undefined): void {
    if (!(time > 0)) return;
    const n = Math.ceil(time / SWING_SUBSTEP);
    const h = time / n;
    const wu2 = this.#wu * this.#wu;
    const wv2 = this.#wv * this.#wv;
    const g = 2 * this.#damping;
    const c = 2 * this.#spin;
    const reach = SANDTABLE.track;
    let pu = 0;
    let pv = 0;
    if (pull !== undefined) {
      const r = Math.hypot(pull.x, pull.y);
      const k = r > reach ? reach / r : 1;
      pu = (this.#cos * pull.x + this.#sin * pull.y) * k;
      pv = (-this.#sin * pull.x + this.#cos * pull.y) * k;
    }
    let u = this.#u;
    let v = this.#v;
    let du = this.#du;
    let dv = this.#dv;
    for (let i = 0; i < n; i++) {
      let au = -wu2 * u - g * du + c * dv;
      let av = -wv2 * v - g * dv - c * du;
      if (pull !== undefined) {
        au += PULL * (pu - u) - PULL_DAMPING * du;
        av += PULL * (pv - v) - PULL_DAMPING * dv;
      }
      du += au * h;
      dv += av * h;
      u += du * h;
      v += dv * h;
      // The string is only so long: the funnel never swings out past the sand.
      const r = Math.hypot(u, v);
      if (r > reach) {
        u *= reach / r;
        v *= reach / r;
        const out = (du * u + dv * v) / reach;
        if (out > 0) {
          du -= (out * u) / reach;
          dv -= (out * v) / reach;
        }
      }
      if (flow > 0 && this.#stream > 0 && this.#fill > 0) {
        const x = this.#cos * u - this.#sin * v;
        const y = this.#sin * u + this.#cos * v;
        this.#field.stamp(0.5 + x, 0.5 + y, STREAM_RADIUS, domeProfile, flow * this.#stream * h * Math.min(1, 6 * this.#fill));
        this.#fill = Math.max(0, this.#fill - this.#stream * h * this.#drain);
      }
    }
    this.#u = u;
    this.#v = v;
    this.#du = du;
    this.#dv = dv;
    this.#place();
  }

  #startWipe(settings: Settings): void {
    const phase = this.#phase;
    switch (phase) {
      case "swing":
      case "rest": {
        const angle = TAU * mulberry32(seedOf(settings.seed, this.#figure, SALT_EDGE))();
        const edge = this.#edge;
        edge.nx = Math.cos(angle);
        edge.ny = Math.sin(angle);
        // From just beyond the rim on one side until the berm has gone over the far side.
        edge.lead = -(SANDTABLE.sand + SANDTABLE.rim + 0.04);
        edge.end = SANDTABLE.sand + BERM + 0.03;
        this.#phase = "wipe";
        this.#held = false;
        return;
      }
      case "wipe":
        return;
      case "launch":
        this.#beginLaunch(settings);
        return;
      default: {
        const unreachable: never = phase;
        throw new SandtableError(`sandtable: unknown pendulum phase ${String(unreachable)}`);
      }
    }
  }

  #beginLaunch(settings: Settings): void {
    this.#setup(settings);
    const l = this.#launch;
    l.x = this.#x;
    l.y = this.#y;
    l.t = 0;
    this.#stream = 0;
    this.#phase = "launch";
  }

  /** The funnel starts off the frame's longer side, on the side it hangs, its stream shut. */
  #beginArrival(aspect: number): void {
    const half = frameHalf(aspect);
    const sideways = aspect >= 1;
    const dx = sideways ? (this.#x < 0 ? -1 : 1) : 0;
    const dy = sideways ? 0 : (this.#y < 0 ? -1 : 1);
    this.#stream = 0;
    this.#arrival = { dx, dy, reach: (sideways ? half.w : half.h) + OFF_FRAME + SANDTABLE.track };
    this.#carryIn(0);
  }

  /**
   * The funnel carried in at `arrive` seconds, settling onto its swing; once it is there the arrival
   * is over and the stream opens.
   */
  #carryIn(arrive: number): void {
    const arrival = this.#arrival;
    if (arrival === undefined) return;
    const u = clamp((arrive - ARRIVE_DELAY) / ARRIVE_SECONDS, 0, 1);
    if (u >= 1) {
      this.#arrival = undefined;
      this.#offX = 0;
      this.#offY = 0;
      return;
    }
    const left = arrival.reach * (1 - settleEase(u));
    this.#offX = arrival.dx * left;
    this.#offY = arrival.dy * left;
  }

  /**
   * The exit at `passage.leave`: the stream shuts, the funnel is carried off the frame's side it hangs
   * on, and the edge sweeps the slate clean after it, shoving the berm off the far side. A wipe
   * already under way carries on, faster, in its own direction.
   */
  #leave(dt: number, motion: number, settings: Settings, passage: Passage): void {
    this.#carryIn(Infinity);
    this.#held = false;
    const leaving = this.#leaving ?? this.#beginLeave(passage.aspect);
    if (this.#phase !== "launch") this.#swing(dt * motion * settings.speed, flowOf(settings.depth), undefined);
    this.#stream = approach(this.#stream, 0, dt / SHUT_SECONDS);
    const carried = clamp((passage.leave - CARRY_FROM) / (CARRY_TO - CARRY_FROM), 0, 1);
    const away = leaving.reach * carried * carried;
    this.#offX = leaving.nx * away;
    this.#offY = leaving.ny * away;
    const edge = this.#edge;
    const lead = leaving.lead0 + (edge.end - leaving.lead0) * departEase(clamp((passage.leave - SWEEP_FROM) / (1 - SWEEP_FROM), 0, 1));
    if (lead > edge.lead) {
      this.#scrape(edge.lead, lead);
      edge.lead = lead;
    }
  }

  /** The edge waits off the frame on the far side from the funnel, across the shorter side. */
  #beginLeave(aspect: number): Leaving {
    const half = frameHalf(aspect);
    const edge = this.#edge;
    if (this.#phase !== "wipe") {
      const across = aspect < 1;
      edge.nx = across ? (this.#x < 0 ? -1 : 1) : 0;
      edge.ny = across ? 0 : (this.#y < 0 ? -1 : 1);
      edge.lead = -((across ? half.w : half.h) + SANDTABLE.edge + OFF_FRAME);
    }
    const support = half.w * Math.abs(edge.nx) + half.h * Math.abs(edge.ny);
    edge.end = support + OFF_FRAME;
    edge.shown = 1;
    const leaving: Leaving = { nx: edge.nx, ny: edge.ny, reach: support + OFF_FRAME + SANDTABLE.track, lead0: edge.lead };
    this.#leaving = leaving;
    return leaving;
  }

  /**
   * The straight edge's face moves from `from` to `to` along its normal: everything from under it to
   * the front of its berm is gathered, lane by lane, and laid back as the berm just ahead of it.
   * What would land beyond the sand falls off the table.
   */
  #scrape(from: number, to: number): void {
    const { nx, ny } = this.#edge;
    const grid = SANDTABLE.grid;
    const data = this.#field.data;
    const lanes = this.#lanes.fill(0);
    const weights = this.#weights.fill(0);
    const span = this.#span;
    const gather = from - SANDTABLE.edge;
    const front = to + BERM;
    const sand2 = SANDTABLE.sand * SANDTABLE.sand;
    let any = false;
    for (let j = 0; j < grid; j++) {
      const y = (j + 0.5) / grid - 0.5;
      bandColumns(nx, ny, y, gather, front, span);
      for (let i = span.from; i <= span.to; i++) {
        const x = (i + 0.5) / grid - 0.5;
        const d = nx * x + ny * y;
        if (d < gather || d >= front) continue;
        const lane = laneOf(nx * y - ny * x);
        const k = j * grid + i;
        const h = data[k] ?? 0;
        if (h !== 0) {
          lanes[lane] = (lanes[lane] ?? 0) + h;
          data[k] = 0;
          any = true;
        }
        if (d >= to) weights[lane] = (weights[lane] ?? 0) + bermProfile((d - to) / BERM);
      }
    }
    if (!any) return;
    for (let j = 0; j < grid; j++) {
      const y = (j + 0.5) / grid - 0.5;
      bandColumns(nx, ny, y, to, front, span);
      for (let i = span.from; i <= span.to; i++) {
        const x = (i + 0.5) / grid - 0.5;
        const d = nx * x + ny * y;
        if (d < to || d >= front || x * x + y * y > sand2) continue;
        const lane = laneOf(nx * y - ny * x);
        const weight = weights[lane] ?? 0;
        if (weight > 0) data[j * grid + i] = ((lanes[lane] ?? 0) * bermProfile((d - to) / BERM)) / weight;
      }
    }
    this.#field.touch();
  }
}

// ---- the simulation ------------------------------------------------------------------------------

/** Longest step simulated; a stalled tab must not fling the ball across the table. */
const MAX_STEP = 0.1;
/** How briskly slopes steeper than the talus slump (per second). */
const RELAX_RATE = 3;
/** Rows relaxed per frame: a full pass every eight frames. */
const RELAX_ROWS = 40;
/** The heights are re-uploaded at most this often while the sand changes... */
const UPLOAD_MS = 1000 / 30;
/**
 * ...unless a machine has got further than this (field units, a quarter of the ball's radius) from
 * where it stood when they last went up: the ball, the stream while it pours, or the straight edge.
 * Its tool state goes to the shader every frame, so the head of the groove, the line or the scrape
 * then always lies under the ball, stream or bar. The ball at the default drawing speed moves less
 * than this between throttled uploads; a fast ball or edge has the heights sent every frame.
 */
const SYNC_LAG = 0.25 * SANDTABLE.ball;

class SandtableSim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #field = new HeightField(SANDTABLE.grid, SANDTABLE.grid, 1);
  readonly #heights: DataTexture;
  readonly #state: DataTexture;
  readonly #stateData = new Float32Array(12);
  readonly #textures: readonly WebGLTexture[];
  readonly #ball: Ball;
  readonly #pendulum: Pendulum;
  readonly #touch: Touch = { x: 0, y: 0, pressed: false, down: false };
  /** The knobs as settings, rewritten each frame. */
  readonly #settings: Settings = { machine: "ball", pattern: "cycle", figure: "cycle", speed: 1, pause: undefined, seed: 0, depth: 0, mark: 0, markNow: 0 };
  /** Trigger slots of the "next drawing" and "M track" knobs. */
  readonly #nextSlot: number;
  readonly #markSlot: number;
  /** The machine the table is laid out for; none until the first frame. */
  #machine: Machine | undefined;
  #uploadedAt = -Infinity;
  #force = true;
  /** The tools as they stood at the last heights upload: ball or funnel centre, and the edge's offset. */
  readonly #shown = { x: 0, y: 0, edge: 0 };
  /** What the machines are told of the scene's passage, rewritten each frame. */
  readonly #passage: Passage = { arrive: Infinity, leave: 0, aspect: 16 / 9 };
  /** Whether the scene is arriving (decided on the first frame), and seconds since its table was laid. */
  #arriving: boolean | undefined;
  #arrived = 0;

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<Knob>) {
    this.#knobs = knobs;
    this.#nextSlot = knobs.trigger("renew");
    this.#markSlot = knobs.trigger("mark");
    this.#heights = new DataTexture(gl, { width: SANDTABLE.grid, height: SANDTABLE.grid, format: "r16f" });
    this.#state = new DataTexture(gl, { width: 3, height: 1, format: "rgba16f", filter: "nearest" });
    this.#textures = [this.#heights.texture, this.#state.texture];
    this.#ball = new Ball(this.#field);
    this.#pendulum = new Pendulum(this.#field);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const dt = Math.min(Math.max(Number.isFinite(frame.dt) ? frame.dt : 0, 0), MAX_STEP);
    const settings = this.#settings;
    readSettings(this.#knobs, frame, settings);
    const touch = this.#readTouch(frame);
    const passage = this.#passage;
    passage.aspect = aspectOf(frame);
    passage.leave = clamp(frame.passage.exit, 0, 1);
    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1;
    // The opening table is laid out on the first frame, the first time the page's knobs are known,
    // and afresh whenever the machine changes. Only the first has an entrance.
    let laid = false;
    if (settings.machine !== this.#machine) {
      const first = this.#machine === undefined;
      this.#lay(settings, first && this.#arriving ? passage.aspect : undefined);
      if (!first) this.#arriving = false;
      laid = true;
    }
    if (this.#arriving) {
      if (!laid) this.#arrived += dt;
      if (this.#arrived >= SANDTABLE_PASSAGE.enter) this.#arriving = false;
    }
    passage.arrive = this.#arriving ? this.#arrived : Infinity;

    const machine = settings.machine;
    switch (machine) {
      case "ball":
        this.#ball.frame(dt, frame.motion, touch, settings, frame.fired[this.#nextSlot] === true, frame.fired[this.#markSlot] === true, passage);
        this.#ball.write(this.#stateData);
        break;
      case "pendulum":
        this.#pendulum.frame(dt, frame.motion, touch, settings, frame.fired[this.#nextSlot] === true, passage);
        this.#pendulum.write(this.#stateData);
        break;
      default: {
        const unreachable: never = machine;
        throw new SandtableError(`sandtable: unknown machine ${String(unreachable)}`);
      }
    }
    this.#field.relax(TALUS, RELAX_RATE, dt, RELAX_ROWS);

    const now = performance.now();
    // While the machines move in or out the sand is shown as it is, every frame; so it is while a
    // tool has run on past SYNC_LAG since the last upload.
    const moving = passage.arrive !== Infinity || passage.leave > 0;
    const state = this.#stateData;
    const shown = this.#shown;
    const pouring = machine === "ball" || (state[3] ?? 0) > 0;
    const lead = Math.max(
      pouring ? Math.hypot((state[0] ?? 0) - shown.x, (state[1] ?? 0) - shown.y) : 0,
      (state[7] ?? 0) > 0 ? Math.abs((state[6] ?? 0) - shown.edge) : 0,
    );
    if (this.#force || moving || lead > SYNC_LAG || now - this.#uploadedAt >= UPLOAD_MS) {
      if (this.#field.upload(this.#heights)) this.#uploadedAt = now;
      // Uploaded or unchanged, the sand on screen is the sand as it is, with the tools where they are.
      shown.x = state[0] ?? 0;
      shown.y = state[1] ?? 0;
      shown.edge = state[6] ?? 0;
      this.#force = false;
    }
    this.#state.upload(this.#stateData);
    return this.#textures;
  }

  dispose(): void {
    this.#heights.dispose();
    this.#state.dispose();
  }

  /** A fresh table for the settings' machine, already part way through its work (or, arriving, short of its last moments). */
  #lay(settings: Settings, aspect: number | undefined): void {
    this.#machine = settings.machine;
    if (settings.machine === "ball") this.#ball.reset(settings, aspect);
    else this.#pendulum.reset(settings, aspect);
    this.#force = true;
  }

  /** The pointer in field units from the table's centre (the shader's mapping, inverted). */
  #readTouch(frame: SimFrame): Touch {
    const pointer = frame.pointer;
    const aspect = aspectOf(frame);
    const scale = SANDTABLE.span * Math.min(1, aspect);
    const touch = this.#touch;
    touch.x = ((pointer.x - 0.5) * aspect) / scale;
    touch.y = (pointer.y - 0.5) / scale;
    touch.pressed = pointer.pressed && pointer.inside && Math.hypot(touch.x, touch.y) <= SANDTABLE.sand;
    touch.down = pointer.down;
    return touch;
  }
}

/** The sand table, for a scene whose `params` carry the knobs `Knob` names. */
export function sandtableSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<Knob>("sandtable", params, SANDTABLE_KNOBS);
  return (gl) => new SandtableSim(gl, knobs);
}
