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
// Textures (all nearest, read with texelFetch):
//   uSim0  rgba16f segments, DEW_SEG_TEXELS texels each, DEW_SEG_ROW per row; segment s starts at
//          (3 (s % DEW_SEG_ROW), s / DEW_SEG_ROW). Positions are split hi + lo (hi a multiple of
//          1/64, exact in half floats, lo the remainder) so threads stay put to a hundredth of a cell:
//          t0 = (a.x, a.y, b.x, b.y) hi; t1 = the same, lo; t2 = (a.z, b.z, wet, code). Threads:
//          wet = round(wetness × DEW_WET_LEVELS) + 0.5 + 0.45 × dry, where dry > 0 means beads at
//          t < dry are gone and dry < 0 beads at t > -dry (a drop is sweeping the thread); code =
//          kind × DEW_CODE + beads along it. Stems: wet = 0, code = kind × DEW_CODE + radius in
//          DEW_STEM_UNIT.
//   uSim1  r16f bins: a grid of square bins one 1/rows of the frame height across, from the frame's
//          bottom-left corner; bin (i, j) lists what reaches into it at texels
//          (j × DEW_BIN_SLOTS + k, i), k < DEW_BIN_SLOTS: s + 1 for segment s, -(d + 1) for drop d,
//          0 ends the list. rows = width / DEW_BIN_SLOTS, columns = height.
//   uSim2  rgba16f drops, two texels each: (x, y) hi, (x, y) lo of the centre; (radius, z,
//          stretch, squash). Radius 0 = no drop.
//   uSim3  rgba16f header: t0 = hub (x, y) hi, lo; t1 = (hub z, focus z, the hub's turn (radians),
//          web radius); t2 = (gust 0..1, breeze 0..1, 0, 0).
//
// Units: frame heights, x from the frame's left edge, y up from its bottom, z toward the viewer.
import type { ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import { VerletSystem, type VerletForce, type VerletStepOptions, type WebLayout } from "../../sims/verlet.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- shared with the shader -----------------------------------------------------------------------

export const DEW_SEG_TEXELS = 3;
export const DEW_SEG_ROW = 512;
export const DEW_BIN_SLOTS = 32;
export const DEW_DROPS = 48;
/** A segment's code: kind × DEW_CODE + beads (threads) or radius (stems). */
export const DEW_CODE = 64;
export const DEW_KIND_SPOKE = 0;
export const DEW_KIND_SPIRAL = 1;
export const DEW_KIND_FRAME = 2;
export const DEW_KIND_STEM = 3;
/** A stem's radius unit in its code, frame heights. */
export const DEW_STEM_UNIT = 1 / 4000;
export const DEW_WET_LEVELS = 31;
/** Depth of field: blur radius (frame heights) per unit of depth off the focus at full knob; its cap. */
export const DEW_DOF = 1.2;
export const DEW_BLUR_MAX = 0.01;
/** Typical bead radius (frame heights) on a fully wet capture thread in the heaviest dew. */
export const DEW_BEAD_R = 0.0031;
/** Bead radius by kind (spoke, spiral, frame): the dry radii and frame carry finer dew. */
export const DEW_BEAD_SCALE = [0.72, 1, 0.85] as const;
/** Share of their radius beads and big drops hang below their thread. */
export const DEW_BEAD_HANG = 0.3;
export const DEW_DROP_HANG = 0.55;
/** Thread half-widths in cells (radii and spiral, frame and moorings) and how much a glint swells them. */
export const DEW_SILK_HALF = 0.62;
export const DEW_FRAME_HALF = 0.85;
export const DEW_GLINT_SWELL = 0.7;

/** Largest bead radius the shader can draw for a kind at this dew (its hash term peaks at 1.3). */
export function dewBeadMax(kind: number, dew: number): number {
  return DEW_BEAD_R * (DEW_BEAD_SCALE[kind] ?? 1) * (0.6 + 0.4 * dew) * 1.3;
}

// ---- the web ----------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
/** Radii, turns of capture spiral, the open hub and the spiral's outer edge (shares of the radius). */
const SPOKES = 24;
const TURNS = 18;
const HUB_SHARE = 0.13;
const RIM_SHARE = 0.86;
/**
 * Rest over built length of every thread. The pull against the moorings is what tensions the web:
 * at 0.92 the hub swings out of plane with a period of about 2.6 s and settles in a few (measured).
 */
const TENSION = 0.92;
const SPIRAL_STIFFNESS = 0.5;
const IRREGULARITY = 0.55;
/** Frame corners in degrees counter-clockwise from the hub's right, and their reach (× radius). */
const CORNERS = [18, 90, 162, 234, 306] as const;
const CORNER_JITTER = 6;
const CORNER_REACH = 1.28;
const CORNER_REACH_JITTER = 0.04;
/** Where a frame thread's bead count comes from: bead spacing (frame heights) by kind. */
const BEAD_SPACING = [0.015, 0.0105, 0.017] as const;
/** Gravity (frame heights/s²), damping (1/s) and constraint passes per substep. */
const GRAVITY = -0.05;
const DAMPING = 0.8;
const ITERATIONS = 4;
/** Prewarm: whole 0.1 s steps run at construction so the tension has settled (it does in ~2 s). */
const PREWARM_STEPS = 20;
/** Seconds of drop life fast-forwarded at construction, and the step. */
const PREWARM_DROPS = 50;
const PREWARM_DROP_STEP = 0.25;
/** Camera distance in frame heights: a point swinging toward the viewer grows by z / distance. */
const CAMERA_DISTANCE = 2;

// ---- breeze -----------------------------------------------------------------------------------------

/** Out-of-plane pressure on every point at breeze 1 (frame heights/s²), its share in the plane. */
const PRESSURE = 0.06;
const SIDEWAYS = 0.2;
/** A pressure ripple running across the web: amplitude share, wavenumber (rad/height), rate (rad/s). */
const RIPPLE = 0.45;
const RIPPLE_K = 11;
const RIPPLE_W = 1.6;
/** Gusts: length (s), extra pressure at the peak (× breeze 1), seconds between natural ones at breeze 0 and 1. */
const GUST_SECONDS = 6;
const GUST_GAIN = 2.2;
const GUST_RARE = 80;
const GUST_OFTEN = 24;
/** Sway of a stem's tip at breeze 1 (frame heights), and the extra a full gust adds. */
const STEM_SWAY = 0.03;
const STEM_GUST = 0.035;

// ---- drops ------------------------------------------------------------------------------------------

/** A drop of this radius on a vertical thread pulls with 1 against the pinning PIN (contact-angle hysteresis). */
const R_SLIDE = 0.0075;
const PIN = 0.4;
/** Creeping speed (frame heights/s per unit of excess pull), and the time it takes to get going. */
const SLIDE_SPEED = 0.025;
const SLIDE_EASE = 0.6;
/** At a crossing a drop only goes on down a thread at least this steep; turning keeps this much speed. */
const SLOPE_MIN = 0.15;
const CORNER_KEEP = 0.6;
/** Radius at which a drop falls at once; above R_HANG one parked at a low point lets go after ~HANG s. */
const R_FALL = 0.0105;
const R_HANG = 0.0085;
const HANG_SECONDS = 15;
/** Condensation onto a drop: r³ per second at dew 1. */
const GROW = 7e-9;
/** With more drops than the dew feeds (it was turned down) they dry: r³ per second; gone below R_GONE. */
const EVAPORATE = 4e-8;
const R_GONE = 0.002;
/** A new drop's radius, how long it takes to gather, the share of its thread's beads it takes up. */
const SPAWN_R = 0.0036;
const BIRTH_SECONDS = 3;
const SPAWN_TAKE = 0.6;
/** Seconds between new drops while the web holds fewer than its share. */
const SPAWN_GAP = 2.2;
/** Beads regrow: wetness per second at dew 0 and the extra at dew 1. */
const WET_REGROW = 0.01;
const WET_REGROW_DEW = 0.03;
/** Fall: gravity (frame heights/s²) and the upward kick its thread gets from a drop of R_FALL. */
const FALL_GRAVITY = 1.4;
const RECOIL = 0.35;
const RECOIL_RADIUS = 0.04;
/** A drop of R_FALL weighs this much on its thread (frame heights/s² on the two points). */
const WEIGHT = 0.25;
/** Thread speed (frame heights/s) that shakes a drop of R_FALL loose (smaller drops need (R_FALL / r)² more). */
const SHAKE_FALL = 0.35;
/** Wobble: amplitude per unit thread speed, its cap, decay (s) and frequency (Hz). */
const SHIVER_GAIN = 0.4;
const SHIVER_MAX = 0.3;
const SHIVER_DECAY = 1.2;
const SHIVER_HZ = 2.1;
/** During a gust, drops bigger than this may be blown off, at up to GUST_SHED per second for a drop of R_FALL. */
const GUST_SHED_R = 0.006;
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

/** About this many cells per bin, between these many rows. */
const BIN_CELLS = 14;
const BIN_ROWS_MIN = 12;
const BIN_ROWS_MAX = 64;

// ---- helpers ----------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a seed always spins the same web. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The part of x a half float holds exactly (a multiple of 1/64); the shader adds the remainder back. */
function hi(x: number): number {
  return Math.floor(x * 64) / 64;
}

/** Distance from (px, py) to the segment a–b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0;
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}

export class DewError extends Error {}

/** A grass stem at the frame's edge: a gently bowed line from below the frame to above it. */
interface Stem {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Sideways bulge at mid-height (to the right of its upward direction). */
  bow: number;
  r0: number;
  r1: number;
  /** Phases of its own nodding. */
  phase: number;
  /** This frame's sway of the tip: x in the frame, z toward the viewer. */
  sx: number;
  sz: number;
}

/** A frame corner's mooring: the pinned point, the stem it is tied to (-1: a twig above the frame) at u. */
interface Mooring {
  point: number;
  stem: number;
  u: number;
  x: number;
  y: number;
}

const STEM_SEGMENTS = 10;

function stemAt(stem: Stem, u: number, out: Float64Array): void {
  const dx = stem.x1 - stem.x0;
  const dy = stem.y1 - stem.y0;
  const len = Math.hypot(dx, dy);
  const bow = (stem.bow * 4 * u * (1 - u)) / len;
  const s = u * u;
  out[0] = stem.x0 + dx * u + dy * bow + stem.sx * s;
  out[1] = stem.y0 + dy * u - dx * bow;
  out[2] = stem.sz * s;
}

/** The nearest crossing of the ray from (hx, hy) along (ux, uy) with the closed polygon. */
function rayHit(hx: number, hy: number, ux: number, uy: number, corners: readonly (readonly [number, number])[]): { t: number; side: number; along: number } {
  let best = { t: Infinity, side: -1, along: 0 };
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = corners[i] ?? [0, 0];
    const [bx, by] = corners[(i + 1) % n] ?? [0, 0];
    const ex = bx - ax;
    const ey = by - ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = ax - hx;
    const wy = ay - hy;
    const t = (wx * ey - wy * ex) / den;
    const along = (wx * uy - wy * ux) / den;
    if (t > 0 && along >= 0 && along <= 1 && t < best.t) best = { t, side: i, along };
  }
  if (best.side < 0) throw new DewError("dew: a radius misses the frame");
  return best;
}

/** One web, spun for a frame aspect and a seed: the net, its stems and the dew it carries. */
class DewWeb {
  readonly aspect: number;
  readonly seed: number;
  readonly sys = new VerletSystem({ points: 1 + SPOKES * (TURNS + 1) + CORNERS.length * 2, constraints: SPOKES * (TURNS + 1) + SPOKES * TURNS + SPOKES + CORNERS.length * 2 });
  readonly layout: WebLayout;
  readonly radius: number;
  /** Constraints: the threads drawn and ridden (stems come after them in the segment records). */
  readonly threads: number;
  readonly kind: Uint8Array;
  readonly beads: Uint8Array;
  readonly wet: Float32Array;
  readonly dry: Float32Array;
  /** Threads at each point: adjList[adjStart[i] .. adjStart[i + 1]). */
  readonly adjStart: Uint32Array;
  readonly adjList: Uint32Array;
  readonly stems: Stem[];
  readonly moorings: Mooring[];
  /** Drawn positions this frame (blended between substeps, with perspective): x, y, z per point. */
  readonly drawn: Float32Array;

  constructor(aspect: number, seed: number) {
    this.aspect = aspect;
    this.seed = seed;
    const rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x64657721) >>> 0);
    const sys = this.sys;

    // The hub right of centre (the page's copy sits lower left), the stems at the frame's edges. A
    // narrow frame gets a web larger than fits between them, seen closer: the stems stand just
    // beyond the edges and only their moorings show.
    const edgeLeft = 0.07 * aspect + 0.05;
    const edgeRight = aspect - (0.04 * aspect + 0.03);
    const hx = aspect * (aspect >= 1.2 ? 0.58 : 0.5);
    const hy = 0.56;
    const span = CORNER_REACH + CORNER_REACH_JITTER + 0.1;
    const radius = Math.min(0.46, Math.max(Math.min(hx - edgeLeft, edgeRight - hx) / span, 0.24 * aspect + 0.09));
    const leftX = Math.min(edgeLeft, hx - span * radius);
    const rightX = Math.max(edgeRight, hx + span * radius);
    this.radius = radius;
    this.stems = [
      { x0: leftX - 0.02, y0: -0.06, x1: leftX + 0.03, y1: 1.12, bow: -0.025, r0: 0.0135, r1: 0.008, phase: rand() * TAU, sx: 0, sz: 0 },
      { x0: rightX + 0.015, y0: -0.06, x1: rightX - 0.035, y1: 1.12, bow: 0.03, r0: 0.0125, r1: 0.0075, phase: rand() * TAU, sx: 0, sz: 0 },
    ];

    const layout = sys.addWeb({
      center: [hx, hy, 0],
      radius,
      spokes: SPOKES,
      turns: TURNS,
      hub: HUB_SHARE,
      rim: RIM_SHARE,
      restScale: TENSION,
      spiralStiffness: SPIRAL_STIFFNESS,
      irregularity: IRREGULARITY,
      seed: seed + 1,
    });
    this.layout = layout;

    // The frame: a polygon round the web; each radius is tied to it where it meets it.
    const corners = CORNERS.map((deg): readonly [number, number] => {
      const a = ((deg + CORNER_JITTER * (rand() * 2 - 1)) * Math.PI) / 180;
      const reach = (CORNER_REACH + CORNER_REACH_JITTER * (rand() * 2 - 1)) * radius;
      return [hx + Math.cos(a) * reach, hy + Math.sin(a) * reach];
    });
    const sides: [number, number][][] = corners.map(() => []);
    const pos = sys.positions;
    for (let s = 0; s < SPOKES; s++) {
      const anchor = layout.anchors + s;
      const dx = (pos[anchor * 3] ?? 0) - hx;
      const dy = (pos[anchor * 3 + 1] ?? 0) - hy;
      const len = Math.hypot(dx, dy);
      const hit = rayHit(hx, hy, dx / len, dy / len, corners);
      sys.place(anchor, hx + (dx / len) * hit.t, hy + (dy / len) * hit.t, 0);
      const last = layout.spiral + s * TURNS + TURNS - 1;
      sys.setConstraint(layout.firstConstraint + s * (TURNS + 1) + TURNS, sys.distance(last, anchor) * TENSION, 1);
      sys.unpin(anchor);
      sides[hit.side]?.push([hit.along, anchor]);
    }
    const cornerPoints = corners.map(([x, y]) => sys.addPoint(x, y, 0));
    const frameFirst = sys.constraintCount;
    for (let i = 0; i < corners.length; i++) {
      const along = (sides[i] ?? []).sort((p, q) => p[0] - q[0]);
      let from = cornerPoints[i] ?? 0;
      const to = [...along.map((entry) => entry[1]), cornerPoints[(i + 1) % corners.length] ?? 0];
      for (const next of to) {
        sys.addConstraint(from, next, 1, sys.distance(from, next) * TENSION);
        from = next;
      }
    }

    // Moorings: the right corner and the lower right to the right stem, the left ones to the left
    // stem, the top one up out of the frame to an unseen twig.
    const at = new Float64Array(3);
    const moorTo = (corner: number, stem: number, height: number): Mooring => {
      const s = this.stems[stem];
      const u = s === undefined ? 0 : Math.min(1, Math.max(0, (height - s.y0) / (s.y1 - s.y0)));
      if (s === undefined) {
        at[0] = hx - 0.1 * radius;
        at[1] = height;
      } else {
        stemAt(s, u, at);
      }
      const x = at[0] ?? 0;
      const y = at[1] ?? 0;
      const point = sys.addPoint(x, y, 0);
      sys.pin(point);
      const c = cornerPoints[corner] ?? 0;
      sys.addConstraint(c, point, 1, sys.distance(c, point) * TENSION);
      return { point, stem: s === undefined ? -1 : stem, u, x, y };
    };
    this.moorings = [
      moorTo(0, 1, (corners[0]?.[1] ?? hy) + 0.05),
      moorTo(1, -1, Math.max(1.3, (corners[1]?.[1] ?? hy) + 0.15)),
      moorTo(2, 0, (corners[2]?.[1] ?? hy) + 0.07),
      moorTo(3, 0, 0.02),
      moorTo(4, 1, 0.0),
    ];

    const threads = sys.constraintCount;
    this.threads = threads;
    this.kind = new Uint8Array(threads);
    this.beads = new Uint8Array(threads);
    this.wet = new Float32Array(threads).fill(1);
    this.dry = new Float32Array(threads);
    for (let c = 0; c < threads; c++) {
      const kind = c < layout.spiralConstraint ? DEW_KIND_SPOKE : c < frameFirst ? DEW_KIND_SPIRAL : DEW_KIND_FRAME;
      this.kind[c] = kind;
      this.beads[c] = Math.min(DEW_CODE - 1, Math.floor((sys.restLength[c] ?? 0) / TENSION / (BEAD_SPACING[kind] ?? 0.0105)));
    }

    const count = sys.count;
    const degree = new Uint32Array(count + 1);
    const ca = sys.constraintA;
    const cb = sys.constraintB;
    for (let c = 0; c < threads; c++) {
      const a = (ca[c] ?? 0) + 1;
      const b = (cb[c] ?? 0) + 1;
      degree[a] = (degree[a] ?? 0) + 1;
      degree[b] = (degree[b] ?? 0) + 1;
    }
    for (let i = 0; i < count; i++) degree[i + 1] = (degree[i + 1] ?? 0) + (degree[i] ?? 0);
    this.adjStart = degree;
    this.adjList = new Uint32Array(threads * 2);
    const fill = degree.slice(0, count);
    for (let c = 0; c < threads; c++) {
      const a = ca[c] ?? 0;
      const b = cb[c] ?? 0;
      this.adjList[fill[a] ?? 0] = c;
      fill[a] = (fill[a] ?? 0) + 1;
      this.adjList[fill[b] ?? 0] = c;
      fill[b] = (fill[b] ?? 0) + 1;
    }
    this.drawn = new Float32Array(count * 3);
  }
}

// ---- the simulation ---------------------------------------------------------------------------------

type DewKnob = "breeze" | "dew" | "dof" | "webSeed";

interface KnobSlot {
  index: number;
  fallback: number;
}

/** Reads the scene's knobs by key, through their position in the scene's `params`. */
class DewKnobs {
  readonly #slots: Record<DewKnob, KnobSlot>;
  /** The trigger slot of the breeze's "now" (a gust). */
  readonly gust: number;

  constructor(params: readonly ParamDef[]) {
    const slot = (key: DewKnob): KnobSlot => {
      const index = params.findIndex((def) => def.key === key);
      const def = params[index];
      if (def === undefined) throw new DewError(`dew: the scene has no ${key} knob`);
      return { index, fallback: def.value };
    };
    this.#slots = { breeze: slot("breeze"), dew: slot("dew"), dof: slot("dof"), webSeed: slot("webSeed") };
    const gust = params.find((def) => def.key === "breeze")?.trigger;
    if (gust === undefined) throw new DewError("dew: the breeze knob needs a trigger slot for gusts");
    this.gust = gust;
  }

  value(frame: SimFrame, key: DewKnob): number {
    const slot = this.#slots[key];
    return frame.values[slot.index] ?? slot.fallback;
  }

  fallback(key: DewKnob): number {
    return this.#slots[key].fallback;
  }
}

const RIDING = 1;
const FALLING = 2;

class DewSim implements SceneSim {
  readonly #knobs: DewKnobs;
  readonly #segTex: DataTexture;
  readonly #binTex: DataTexture;
  readonly #dropTex: DataTexture;
  readonly #headTex: DataTexture;
  #segData = new Float32Array(4);
  #binData = new Float32Array(1);
  #binCount = new Uint8Array(1);
  readonly #dropData = new Float32Array(DEW_DROPS * 2 * 4);
  readonly #headData = new Float32Array(3 * 4);
  #rows = 0;
  #cols = 0;

  #web: DewWeb;
  /** The drops' chance, reseeded with every web so a seed always plays out the same. */
  #rand = mulberry32(0);
  /** Extra force per point this frame: the weight of the drops (y). */
  #load = new Float32Array(1);
  readonly #opts: VerletStepOptions;
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
  #triggers: number[] | undefined;
  #strum = { x: 0, y: 0 };
  #prewarming = false;

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

  constructor(gl: WebGL2RenderingContext, knobs: DewKnobs) {
    this.#knobs = knobs;
    this.#segTex = new DataTexture(gl, { width: DEW_SEG_ROW * DEW_SEG_TEXELS, height: 1, format: "rgba16f", filter: "nearest" });
    this.#binTex = new DataTexture(gl, { width: DEW_BIN_SLOTS, height: 1, format: "r16f", filter: "nearest" });
    this.#dropTex = new DataTexture(gl, { width: DEW_DROPS * 2, height: 1, format: "rgba16f", filter: "nearest" });
    this.#headTex = new DataTexture(gl, { width: 3, height: 1, format: "rgba16f", filter: "nearest" });
    const seed = Math.round(knobs.fallback("webSeed"));
    this.#breeze = knobs.fallback("breeze");
    this.#dew = knobs.fallback("dew");
    this.#dof = knobs.fallback("dof");
    this.#opts = { gravity: [0, GRAVITY, 0], damping: DAMPING, iterations: ITERATIONS, force: this.#force };
    // Spun for the usual landscape frame; a different aspect respins it on the first frame.
    this.#web = this.#spin(16 / 9, seed);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#breeze = Math.max(0, knobs.value(frame, "breeze"));
    this.#dew = Math.min(1, Math.max(0, knobs.value(frame, "dew")));
    this.#dof = Math.max(0, knobs.value(frame, "dof"));
    const aspect = Number.isFinite(frame.aspect) && frame.aspect > 0 ? frame.aspect : 16 / 9;
    const seed = Math.round(knobs.value(frame, "webSeed"));
    if (Math.abs(aspect - this.#web.aspect) > 1e-3 || seed !== this.#web.seed) this.#web = this.#spin(aspect, seed);
    this.#fitBins(frame.height, aspect);

    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const sdt = dt * Math.min(1, Math.max(0, frame.motion));
    if (this.#fired(frame.triggers)) {
      this.#gustAt = this.#clock;
      this.#gustAmp = 1;
    }
    this.#advance(sdt);
    this.#play(frame.pointer, aspect);

    this.#pack(frame.height);
    return [this.#segTex.texture, this.#binTex.texture, this.#dropTex.texture, this.#headTex.texture];
  }

  dispose(): void {
    this.#segTex.dispose();
    this.#binTex.dispose();
    this.#dropTex.dispose();
    this.#headTex.dispose();
  }

  // ---- building -----------------------------------------------------------------------------------

  /** Spin a web, let it settle, and fast-forward its dew so the first frame already glistens. */
  #spin(aspect: number, seed: number): DewWeb {
    const web = new DewWeb(aspect, seed);
    this.#web = web;
    this.#rand = mulberry32((Math.imul(seed + 7, 0x85ebca6b) ^ 0x6472) >>> 0);
    this.#load = new Float32Array(web.sys.count);
    this.#state.fill(0);
    this.#spawnIn = 0;
    this.#prewarming = true;
    this.#weather(0);
    for (let i = 0; i < PREWARM_STEPS; i++) web.sys.step(0.1, this.#opts);
    this.#focus = (web.sys.positions[web.layout.hub * 3 + 2] ?? 0) * 0.8;
    // Seed some dew already gathered into drops, then let them run for a while.
    for (let i = 0; i < 6; i++) this.#spawn(0.4 + 0.6 * this.#rand());
    for (let time = 0; time < PREWARM_DROPS; time += PREWARM_DROP_STEP) this.#drops(PREWARM_DROP_STEP);
    for (let d = 0; d < DEW_DROPS; d++) if (this.#state[d] === FALLING) this.#state[d] = 0;
    this.#prewarming = false;
    return web;
  }

  #fitBins(heightCells: number, aspect: number): void {
    const rows = Math.min(BIN_ROWS_MAX, Math.max(BIN_ROWS_MIN, Math.round(heightCells / BIN_CELLS)));
    const cols = Math.ceil(aspect * rows);
    if (rows === this.#rows && cols === this.#cols) return;
    this.#rows = rows;
    this.#cols = cols;
    this.#binTex.resize(rows * DEW_BIN_SLOTS, cols);
    this.#binData = new Float32Array(rows * DEW_BIN_SLOTS * cols);
    this.#binCount = new Uint8Array(rows * cols);
  }

  /** Trigger slot stamped since the previous frame: a gust now. */
  #fired(triggers: readonly number[]): boolean {
    const previous = this.#triggers;
    this.#triggers = [...triggers];
    const slot = this.#knobs.gust;
    const at = triggers[slot] ?? -1e4;
    return previous !== undefined && at !== previous[slot] && at > -1e3;
  }

  // ---- the breeze ---------------------------------------------------------------------------------

  /** Breeze, gusts and the stems' nodding for the clock as it stands; moves the moorings. */
  #weather(dt: number): void {
    const clock = this.#clock;
    const breeze = this.#breeze;
    // Natural gusts come now and then, the more often the stronger the breeze.
    if (dt > 0 && breeze > 0.02 && clock >= this.#nextGust) {
      this.#gustAt = clock;
      this.#gustAmp = 0.35 + 0.35 * this.#rand();
      this.#nextGust = clock + (GUST_RARE + (GUST_OFTEN - GUST_RARE) * breeze) * (0.6 + 0.8 * this.#rand());
    }
    const since = clock - this.#gustAt;
    const g = since >= 0 && since < GUST_SECONDS ? Math.sin((Math.PI * since) / GUST_SECONDS) : 0;
    this.#gust = g * g * this.#gustAmp;
    const swell = 0.6 + 0.25 * Math.sin((clock / 7.3) * TAU) + 0.15 * Math.sin((clock / 12.9) * TAU + 1.3);
    const level = breeze * swell + GUST_GAIN * this.#gust * (0.35 + breeze);
    this.#fz = PRESSURE * level;
    this.#fx = PRESSURE * SIDEWAYS * level;

    const web = this.#web;
    for (const stem of web.stems) {
      const p = stem.phase;
      const nod = breeze * (0.6 * Math.sin((clock / 6.3) * TAU + p) + 0.4 * Math.sin((clock / 9.7) * TAU + 2 * p));
      stem.sx = STEM_SWAY * nod + STEM_GUST * this.#gust;
      stem.sz = STEM_SWAY * breeze * (0.7 * Math.sin((clock / 8.1) * TAU + 3 * p) + 0.3 * Math.sin((clock / 4.9) * TAU + p)) + 0.5 * STEM_GUST * this.#gust;
    }
    const at = this.#at;
    for (const m of web.moorings) {
      const stem = web.stems[m.stem];
      if (stem === undefined) {
        // The twig above: a small, slow nod of its own.
        const nod = 0.006 * breeze * Math.sin((clock / 10.3) * TAU + 0.7);
        web.sys.move(m.point, m.x + nod, m.y, nod * 0.6);
      } else {
        stemAt(stem, m.u, at);
        web.sys.move(m.point, at[0] ?? 0, at[1] ?? 0, at[2] ?? 0);
      }
    }
  }

  /** Breeze pressure (out of plane, a ripple running across) and the drops' weight. */
  readonly #force: VerletForce = (i, x, y, _z, out) => {
    const ripple = 1 + RIPPLE * Math.sin(RIPPLE_K * (0.8 * x + 0.6 * y) - RIPPLE_W * this.#web.sys.time);
    out[0] = this.#fx;
    out[1] = this.#load[i] ?? 0;
    out[2] = this.#fz * ripple;
  };

  #advance(dt: number): void {
    this.#clock += dt;
    this.#weather(dt);
    const web = this.#web;
    // The drops hang their weight on their threads' two points.
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
    web.sys.step(dt, this.#opts);
    if (dt > 0) {
      this.#drops(dt);
      const regrow = (WET_REGROW + WET_REGROW_DEW * this.#dew) * dt;
      const wet = web.wet;
      for (let c = 0; c < web.threads; c++) wet[c] = Math.min(1, (wet[c] ?? 0) + regrow);
      // Focus follows the hub (an autofocus on the spider), lagging a little.
      const hubZ = web.sys.positions[web.layout.hub * 3 + 2] ?? 0;
      this.#focus += (hubZ * 0.8 - this.#focus) * (1 - Math.exp(-dt / 1.5));
    }
    for (let d = 0; d < DEW_DROPS; d++) this.#shiver[d] = (this.#shiver[d] ?? 0) * Math.exp(-dt / SHIVER_DECAY);
  }

  // ---- the pointer --------------------------------------------------------------------------------

  /** Press: pluck the threads under the pointer. Drag: strum them. */
  #play(pointer: PointerState, aspect: number): void {
    if (!pointer.inside) return;
    const x = pointer.x * aspect;
    const y = pointer.y;
    if (pointer.pressed) {
      this.#pluck(x, y, PLUCK_V);
      this.#strum = { x, y };
    } else if (pointer.down && Math.hypot(x - this.#strum.x, y - this.#strum.y) > STRUM_STEP) {
      this.#pluck(x, y, STRUM_V);
      this.#strum = { x, y };
    }
  }

  #pluck(x: number, y: number, v: number): void {
    const sys = this.#web.sys;
    if (sys.nearestXY(x, y, PLUCK_RADIUS * 1.5, true) < 0) return;
    sys.impulseXY(x, y, PLUCK_RADIUS, 0, -PLUCK_PULL * v, v);
    for (let d = 0; d < DEW_DROPS; d++) {
      if (this.#state[d] !== RIDING) continue;
      const dist = Math.hypot((this.#x[d] ?? 0) - x, (this.#y[d] ?? 0) - y);
      if (dist > PLUCK_SHAKE) continue;
      const near = 1 - dist / PLUCK_SHAKE;
      this.#shiver[d] = Math.min(SHIVER_MAX, (this.#shiver[d] ?? 0) + SHIVER_MAX * near * (v / PLUCK_V));
      const k = (this.#r[d] ?? 0) / R_FALL;
      if (this.#rand() < near * k * k * 1.2 * (v / PLUCK_V)) this.#fall(d);
    }
  }

  // ---- the drops ----------------------------------------------------------------------------------

  #drops(dt: number): void {
    const web = this.#web;
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
      let v = (this.#v[d] ?? 0) + (target - (this.#v[d] ?? 0)) * (1 - Math.exp(-dt / SLIDE_EASE));
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
        (r > GUST_SHED_R && this.#rand() < dt * GUST_SHED * this.#gust * heavy * heavy * heavy)
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
    const presence = (0.4 + 0.6 * dew) * (kind === DEW_KIND_SPOKE ? 0.6 : 1);
    const mean = DEW_BEAD_R * (DEW_BEAD_SCALE[kind] ?? 1) * (0.6 + 0.4 * dew) * 0.9;
    return (presence * mean * mean * mean * wet) / (BEAD_SPACING[kind] ?? 0.0105);
  }

  /**
   * A new drop on a heavily beaded thread, gathering at its upper crossing (where dew collects), so
   * when it runs it runs down the thread and bares it; `grown` 0..1 starts it partway gathered.
   */
  #spawn(grown: number): void {
    const d = this.#state.indexOf(0);
    if (d < 0) return;
    const web = this.#web;
    let c = -1;
    for (let tries = 0; tries < 10 && c < 0; tries++) {
      const pick = Math.floor(this.#rand() * web.threads);
      const kind = web.kind[pick];
      if (kind === DEW_KIND_FRAME || (web.wet[pick] ?? 0) < 0.7 || (web.beads[pick] ?? 0) < 2) continue;
      if (kind === DEW_KIND_SPOKE && this.#rand() < 0.6) continue;
      c = pick;
    }
    if (c < 0) return;
    this.#state[d] = RIDING;
    this.#seg[d] = c;
    const pos = web.sys.positions;
    const upper = (pos[(web.sys.constraintA[c] ?? 0) * 3 + 1] ?? 0) >= (pos[(web.sys.constraintB[c] ?? 0) * 3 + 1] ?? 0) ? 0 : 1;
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
    const sys = this.#web.sys;
    const pos = sys.positions;
    const c = this.#seg[d] ?? 0;
    const a = (sys.constraintA[c] ?? 0) * 3;
    const b = (sys.constraintB[c] ?? 0) * 3;
    const t = this.#t[d] ?? 0;
    const r = this.#r[d] ?? 0;
    this.#x[d] = (pos[a] ?? 0) + ((pos[b] ?? 0) - (pos[a] ?? 0)) * t;
    this.#y[d] = (pos[a + 1] ?? 0) + ((pos[b + 1] ?? 0) - (pos[a + 1] ?? 0)) * t - r * DEW_DROP_HANG;
    this.#z[d] = (pos[a + 2] ?? 0) + ((pos[b + 2] ?? 0) - (pos[a + 2] ?? 0)) * t;
  }

  /** Let a drop go: it falls, and its thread springs up. */
  #fall(d: number): void {
    if (this.#state[d] !== RIDING) return;
    const sys = this.#web.sys;
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
    sys.impulse(x, y, this.#z[d] ?? 0, RECOIL_RADIUS, 0, RECOIL * k * k * k, 0.3 * RECOIL * k * k * k);
  }

  /** Drops that touch run together into the bigger one. */
  #merge(): void {
    for (let d = 0; d < DEW_DROPS; d++) {
      if (this.#state[d] !== RIDING) continue;
      for (let e = d + 1; e < DEW_DROPS; e++) {
        if (this.#state[e] !== RIDING) continue;
        const rd = this.#r[d] ?? 0;
        const re = this.#r[e] ?? 0;
        if (Math.hypot((this.#x[d] ?? 0) - (this.#x[e] ?? 0), (this.#y[d] ?? 0) - (this.#y[e] ?? 0)) > (rd + re) * 0.85) continue;
        const keep = rd >= re ? d : e;
        const gone = keep === d ? e : d;
        this.#r[keep] = Math.cbrt(rd * rd * rd + re * re * re);
        this.#birth[keep] = Math.max(this.#birth[d] ?? 0, this.#birth[e] ?? 0);
        this.#shiver[keep] = SHIVER_MAX;
        this.#state[gone] = 0;
        this.#place(keep);
        if (gone === d) break;
      }
    }
  }

  // ---- packing ------------------------------------------------------------------------------------

  #pack(heightCells: number): void {
    const web = this.#web;
    const sys = web.sys;
    const aspect = web.aspect;
    const cell = 1 / Math.max(1, heightCells);
    const dew = this.#dew;
    const dof = DEW_DOF * this.#dof;
    const focus = this.#focus;
    const blurAt = (z: number): number => Math.min(DEW_BLUR_MAX, Math.abs(z - focus) * dof);

    // Drawn positions: blended between the last two substeps (as PointTexture does), seen with a
    // little perspective about the frame's centre.
    const pos = sys.positions;
    const prev = sys.previous;
    const blend = sys.blend;
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

    const segRows = Math.ceil((web.threads + web.stems.length * STEM_SEGMENTS) / DEW_SEG_ROW);
    const segWidth = DEW_SEG_ROW * DEW_SEG_TEXELS;
    if (this.#segTex.height !== segRows) this.#segTex.resize(segWidth, segRows);
    if (this.#segData.length !== segWidth * segRows * 4) this.#segData = new Float32Array(segWidth * segRows * 4);
    const seg = this.#segData;
    const bins = this.#binData;
    const counts = this.#binCount;
    bins.fill(0);
    counts.fill(0);
    const rows = this.#rows;
    const cols = this.#cols;
    const size = 1 / rows;
    const half = size * Math.SQRT1_2;
    const put = (id: number, ax: number, ay: number, bx: number, by: number, margin: number): void => {
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - margin) / size));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + margin) / size));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - margin) / size));
      const j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + margin) / size));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          if (segmentDistance((i + 0.5) * size, (j + 0.5) * size, ax, ay, bx, by) > half + margin) continue;
          const bin = i * rows + j;
          const k = counts[bin] ?? 0;
          if (k >= DEW_BIN_SLOTS) continue;
          bins[(i * rows + j) * DEW_BIN_SLOTS + k] = id;
          counts[bin] = k + 1;
        }
      }
    };

    // Drops first, so a crowded bin never loses one.
    const drop = this.#dropData;
    drop.fill(0);
    const clock = this.#clock;
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
        x = cx + (x - cx) * grow;
        y = 0.5 + (y - 0.5) * grow;
        stretch = 1 + Math.min(2.5, (Math.abs(this.#vy[d] ?? 0) * 0.012) / Math.max(r, 1e-4));
      } else {
        // Riding drops follow their thread as drawn.
        const c = this.#seg[d] ?? 0;
        const a = (sys.constraintA[c] ?? 0) * 3;
        const b = (sys.constraintB[c] ?? 0) * 3;
        const t = this.#t[d] ?? 0;
        x = (drawn[a] ?? 0) + ((drawn[b] ?? 0) - (drawn[a] ?? 0)) * t;
        y = (drawn[a + 1] ?? 0) + ((drawn[b + 1] ?? 0) - (drawn[a + 1] ?? 0)) * t - r * DEW_DROP_HANG;
      }
      const squash = (this.#shiver[d] ?? 0) * Math.sin(clock * SHIVER_HZ * TAU + (this.#phase[d] ?? 0));
      const o = d * 8;
      drop[o] = hi(x);
      drop[o + 1] = hi(y);
      drop[o + 2] = x - hi(x);
      drop[o + 3] = y - hi(y);
      drop[o + 4] = r;
      drop[o + 5] = z;
      drop[o + 6] = stretch;
      drop[o + 7] = squash;
      const reach = r * stretch * (1 + Math.abs(squash)) * 1.25 + blurAt(z) + 1.5 * cell;
      put(-(d + 1), x, y, x, y, reach);
    }

    // Stems.
    const at = this.#at;
    for (let s = 0; s < web.stems.length; s++) {
      const stem = web.stems[s];
      if (stem === undefined) continue;
      stemAt(stem, 0, at);
      let ax = cx + ((at[0] ?? 0) - cx) * (1 + (at[2] ?? 0) / CAMERA_DISTANCE);
      let ay = 0.5 + ((at[1] ?? 0) - 0.5) * (1 + (at[2] ?? 0) / CAMERA_DISTANCE);
      let az = at[2] ?? 0;
      for (let k = 0; k < STEM_SEGMENTS; k++) {
        const u1 = (k + 1) / STEM_SEGMENTS;
        stemAt(stem, u1, at);
        const bz = at[2] ?? 0;
        const grow = 1 + bz / CAMERA_DISTANCE;
        const bx = cx + ((at[0] ?? 0) - cx) * grow;
        const by = 0.5 + ((at[1] ?? 0) - 0.5) * grow;
        const radius = stem.r0 + (stem.r1 - stem.r0) * ((k + 0.5) / STEM_SEGMENTS);
        const code = Math.min(DEW_CODE - 1, Math.round(radius / DEW_STEM_UNIT));
        const id = web.threads + s * STEM_SEGMENTS + k;
        this.#writeSegment(seg, id, ax, ay, az, bx, by, bz, 0, DEW_KIND_STEM * DEW_CODE + code);
        put(id + 1, ax, ay, bx, by, code * DEW_STEM_UNIT + dewBeadMax(DEW_KIND_SPIRAL, dew) * 2 + Math.max(blurAt(az), blurAt(bz)) + 2 * cell);
        ax = bx;
        ay = by;
        az = bz;
      }
    }

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
      this.#writeSegment(seg, c, ax, ay, az, bx, by, bz, wet, kind * DEW_CODE + (web.beads[c] ?? 0));
      const silk = ((kind === DEW_KIND_FRAME ? DEW_FRAME_HALF : DEW_SILK_HALF) * (1 + DEW_GLINT_SWELL) + 1) * cell;
      const bead = dewBeadMax(kind, dew) * (1 + DEW_BEAD_HANG) + cell;
      put(c + 1, ax, ay, bx, by, Math.max(silk, bead) + Math.max(blurAt(az), blurAt(bz)));
    }
    this.#segTex.upload(seg);
    this.#binTex.upload(bins);
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
    head[10] = 0;
    head[11] = 0;
    this.#headTex.upload(head);
  }

  #writeSegment(data: Float32Array, id: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, wet: number, code: number): void {
    const o = ((id % DEW_SEG_ROW) * DEW_SEG_TEXELS + Math.floor(id / DEW_SEG_ROW) * DEW_SEG_ROW * DEW_SEG_TEXELS) * 4;
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
  const knobs = new DewKnobs(params);
  return (gl) => new DewSim(gl, knobs);
}
