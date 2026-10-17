// The dew web's build (sims/build.ts), on the build worker: a web spun the way an orb weaver builds
// hers (sim.ts's header), for a frame aspect and a seed, between its grass stems, then run in the
// breeze as it stood until its tension has settled (dewSpin). The page's sim (sim.ts) carries the
// web on from there, with its dew.
//
// Units: frame heights, x from the frame's left edge, y up from its bottom, z toward the viewer.
import type { BuildKind } from "../../sims/build.ts";
import { mulberry32 } from "../../sims/random.ts";
import {
  VerletSystem,
  type VerletState,
  type VerletStepOptions,
  type WebLayout,
} from "../../sims/verlet.ts";

// ---- shared with the shader -----------------------------------------------------------------------

/** A segment's code: kind × DEW_CODE + beads (threads) or radius (stems). */
export const DEW_CODE = 64;
export const DEW_KIND_SPOKE = 0;
export const DEW_KIND_SPIRAL = 1;
export const DEW_KIND_FRAME = 2;
export const DEW_KIND_STEM = 3;

// ---- the web ----------------------------------------------------------------------------------------

export const TAU = Math.PI * 2;
/** Radii, turns of capture spiral, the open hub and the spiral's outer edge (shares of the radius). */
const SPOKES = 24;
const TURNS = 18;
const HUB_SHARE = 0.13;
const RIM_SHARE = 0.86;
/**
 * Rest over built length of every thread: the pull against the moorings is what tensions the web.
 * Silk stretches (compliance, verlet.ts): the radii, frame and moorings a little, which sets how
 * taut the pull holds the web; the capture spiral, the stretchy silk, about ten times as much.
 */
const TENSION = 0.92;
const THREAD_COMPLIANCE = 1.5e-5;
const SPIRAL_COMPLIANCE = 1.4e-4;
const IRREGULARITY = 0.55;
/** Frame corners in degrees counter-clockwise from the hub's right, and their reach (× radius). */
const CORNERS = [18, 90, 162, 234, 306] as const;
const CORNER_JITTER = 6;
export const CORNER_REACH = 1.28;
export const CORNER_REACH_JITTER = 0.04;
/** Bead spacing along a thread (frame heights) by kind: well apart, so they read as beads on a string. */
export const BEAD_SPACING = [0.024, 0.016, 0.026] as const;
/**
 * Gravity (frame heights/s²), damping (1/s), the web's substep and constraint passes per substep
 * (small steps: a taut net needs the short one). The damping keeps ringing short (a pluck dies away
 * in about three seconds) so fine threads never shimmer for long.
 */
export const GRAVITY = -0.05;
export const DAMPING = 2.4;
export const SUBSTEP = 1 / 480;
export const ITERATIONS = 1;
/** Prewarm: whole 0.1 s steps a spun web runs (dewSpin) so the tension has settled (it does in ~2 s). */
const PREWARM_STEPS = 20;
const PREWARM_SUBSTEPS = Math.round(0.1 / SUBSTEP);

// ---- breeze -----------------------------------------------------------------------------------------

/**
 * Out-of-plane pressure on every point at breeze 1 (frame heights/s²) and its share in the plane.
 * At rest the web only breathes: the threads move well under a cell; gusts and plucks move it more.
 */
const PRESSURE = 0.06;
const SIDEWAYS = 0.04;
/** A slow pressure ripple across the web: amplitude share, wavenumber (rad/height), rate (rad/s). */
const RIPPLE = 0.3;
const RIPPLE_K = 7;
const RIPPLE_W = 0.5;
/** The breeze's slow swell: periods (s) of its two parts. */
const SWELL_SLOW = 23.7;
const SWELL_FAST = 13.1;
/** Gusts: length (s) and extra pressure at the peak (× breeze 1). */
export const GUST_SECONDS = 6;
const GUST_GAIN = 2.2;
/** Sway of a stem's tip at breeze 1 (frame heights), the extra a full gust adds, and the twig's nod. */
const STEM_SWAY = 0.006;
const STEM_GUST = 0.02;
const TWIG_NOD = 0.0015;

// ---- the web's parts --------------------------------------------------------------------------------

export class DewError extends Error {}

/** A leaf blade on a stem: where it leaves the stalk (u), which side, its length and half-width (frame heights), its launch angle off the vertical and how far it bends over (radians). */
interface Leaf {
  u: number;
  side: number;
  length: number;
  width: number;
  lift: number;
  droop: number;
}

/** A grass stem at the frame's edge: a gently bowed line from below the frame to above it, with leaves and a seed head. */
interface Stem {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Sideways bulge at mid-height (to the right of its upward direction). */
  bow: number;
  /** Stalk radius at the bottom and at the tip (frame heights). */
  r0: number;
  r1: number;
  /** Phases of its own nodding. */
  phase: number;
  /** This frame's sway of the tip: x in the frame, z toward the viewer. */
  sx: number;
  sz: number;
  /** The seed head's length (frame heights) and how far it nods over along it (radians, positive toward +x). */
  head: number;
  nod: number;
  leaves: readonly Leaf[];
}

/** A frame corner's mooring: the pinned point, the stem it is tied to (-1: a twig above the frame) at u. */
interface Mooring {
  point: number;
  stem: number;
  u: number;
  x: number;
  y: number;
}

export function stemAt(stem: Stem, u: number, out: Float64Array): void {
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
function rayHit(
  hx: number,
  hy: number,
  ux: number,
  uy: number,
  corners: readonly (readonly [number, number])[],
): { t: number; side: number; along: number } {
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

/** A spun web's whole state (DewWeb.state): what the build worker hands the page. */
export interface DewWebState {
  readonly aspect: number;
  readonly seed: number;
  readonly sys: VerletState;
  readonly layout: WebLayout;
  readonly radius: number;
  readonly hubX: number;
  readonly hubY: number;
  readonly threads: number;
  readonly kind: Uint8Array;
  readonly beads: Uint8Array;
  readonly wet: Float32Array;
  readonly dry: Float32Array;
  readonly adjStart: Uint32Array;
  readonly adjList: Uint32Array;
  readonly stems: Stem[];
  readonly moorings: Mooring[];
  readonly drawn: Float32Array;
}

/** One web, spun for a frame aspect and a seed: the net, its stems and the dew it carries. */
export class DewWeb {
  readonly aspect: number;
  readonly seed: number;
  readonly sys: VerletSystem;
  readonly layout: WebLayout;
  readonly radius: number;
  /** Where the hub was spun (frame heights). */
  readonly hubX: number;
  readonly hubY: number;
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

  /** Spin a web, or take one spun already (`state`, on its own arrays). */
  constructor(aspect: number, seed: number);
  constructor(state: DewWebState);
  constructor(from: number | DewWebState, seed = 0) {
    if (typeof from !== "number") {
      this.aspect = from.aspect;
      this.seed = from.seed;
      this.sys = VerletSystem.from(from.sys);
      this.layout = from.layout;
      this.radius = from.radius;
      this.hubX = from.hubX;
      this.hubY = from.hubY;
      this.threads = from.threads;
      this.kind = from.kind;
      this.beads = from.beads;
      this.wet = from.wet;
      this.dry = from.dry;
      this.adjStart = from.adjStart;
      this.adjList = from.adjList;
      this.stems = from.stems;
      this.moorings = from.moorings;
      this.drawn = from.drawn;
      return;
    }
    const aspect = from;
    this.aspect = aspect;
    this.seed = seed;
    this.sys = new VerletSystem({
      substep: SUBSTEP,
      points: 1 + SPOKES * (TURNS + 1) + CORNERS.length * 2,
      constraints: SPOKES * (TURNS + 1) + SPOKES * TURNS + SPOKES + CORNERS.length * 2,
    });
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
    const radius = Math.min(
      0.46,
      Math.max(Math.min(hx - edgeLeft, edgeRight - hx) / span, 0.24 * aspect + 0.09),
    );
    const leftX = Math.min(edgeLeft, hx - span * radius);
    const rightX = Math.max(edgeRight, hx + span * radius);
    this.radius = radius;
    this.hubX = hx;
    this.hubY = hy;
    this.stems = [
      {
        x0: leftX - 0.035,
        y0: -0.06,
        x1: leftX + 0.04,
        y1: 0.92,
        bow: -0.03,
        r0: 0.0075,
        r1: 0.003,
        phase: rand() * TAU,
        sx: 0,
        sz: 0,
        head: 0.085,
        nod: 0.3,
        leaves: [
          { u: 0.28, side: -1, length: 0.24, width: 0.0055, lift: 0.5, droop: 1.9 },
          { u: 0.5, side: 1, length: 0.19, width: 0.005, lift: 0.65, droop: 1.8 },
        ],
      },
      {
        x0: rightX + 0.02,
        y0: -0.06,
        x1: rightX - 0.045,
        y1: 0.87,
        bow: 0.035,
        r0: 0.007,
        r1: 0.003,
        phase: rand() * TAU,
        sx: 0,
        sz: 0,
        head: 0.07,
        nod: -0.32,
        leaves: [
          { u: 0.33, side: -1, length: 0.21, width: 0.0052, lift: 0.55, droop: 1.9 },
          { u: 0.57, side: 1, length: 0.15, width: 0.0048, lift: 0.7, droop: 1.7 },
        ],
      },
    ];

    const layout = sys.addWeb({
      center: [hx, hy, 0],
      radius,
      spokes: SPOKES,
      turns: TURNS,
      hub: HUB_SHARE,
      rim: RIM_SHARE,
      restScale: TENSION,
      spokeCompliance: THREAD_COMPLIANCE,
      spiralCompliance: SPIRAL_COMPLIANCE,
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
      sys.setConstraint(
        layout.firstConstraint + s * (TURNS + 1) + TURNS,
        sys.distance(last, anchor) * TENSION,
        THREAD_COMPLIANCE,
      );
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
        sys.addConstraint(from, next, THREAD_COMPLIANCE, sys.distance(from, next) * TENSION);
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
      sys.addConstraint(c, point, THREAD_COMPLIANCE, sys.distance(c, point) * TENSION);
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
      const kind =
        c < layout.spiralConstraint
          ? DEW_KIND_SPOKE
          : c < frameFirst
            ? DEW_KIND_SPIRAL
            : DEW_KIND_FRAME;
      this.kind[c] = kind;
      this.beads[c] = Math.min(
        DEW_CODE - 1,
        Math.floor((sys.restLength[c] ?? 0) / TENSION / (BEAD_SPACING[kind] ?? 0.0105)),
      );
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

  /** The web as its own arrays (not copies), as `new DewWeb(state)` takes it. */
  get state(): DewWebState {
    return {
      aspect: this.aspect,
      seed: this.seed,
      sys: this.sys.state,
      layout: this.layout,
      radius: this.radius,
      hubX: this.hubX,
      hubY: this.hubY,
      threads: this.threads,
      kind: this.kind,
      beads: this.beads,
      wet: this.wet,
      dry: this.dry,
      adjStart: this.adjStart,
      adjList: this.adjList,
      stems: this.stems,
      moorings: this.moorings,
      drawn: this.drawn,
    };
  }
}

/** The breeze as it stood when a web was asked for: the breeze's clock, strength and gust. */
export interface DewAir {
  readonly clock: number;
  readonly breeze: number;
  readonly gustAt: number;
  readonly gustAmp: number;
}

/** A web to spin: for a frame aspect and a seed, settled in the breeze as it stood. */
export interface DewSpinRequest {
  readonly aspect: number;
  readonly seed: number;
  readonly air: DewAir;
}

/** A gust's strength 0..1 at `clock`: it set off at `gustAt`, swells and dies over GUST_SECONDS. */
export function gustLevel(clock: number, gustAt: number, gustAmp: number): number {
  const since = clock - gustAt;
  const g = since >= 0 && since < GUST_SECONDS ? Math.sin((Math.PI * since) / GUST_SECONDS) : 0;
  return g * g * gustAmp;
}

/** The breeze on the web at its clock: the gust 0..1, and its push sideways and out of plane. */
export function breezeAt({ clock, breeze, gustAt, gustAmp }: DewAir): {
  gust: number;
  fx: number;
  fz: number;
} {
  const gust = gustLevel(clock, gustAt, gustAmp);
  const swell =
    0.6 +
    0.25 * Math.sin((clock / SWELL_FAST) * TAU) +
    0.15 * Math.sin((clock / SWELL_SLOW) * TAU + 1.3);
  const level = breeze * swell + GUST_GAIN * gust * (0.35 + breeze);
  return { gust, fx: PRESSURE * SIDEWAYS * level, fz: PRESSURE * level };
}

/** The stems nodding in the breeze at `clock`, and the web's moorings gliding with them. */
export function swayStems(
  web: DewWeb,
  clock: number,
  breeze: number,
  gust: number,
  at: Float64Array,
): void {
  for (const stem of web.stems) {
    const p = stem.phase;
    const nod =
      breeze *
      (0.6 * Math.sin((clock / 11.3) * TAU + p) + 0.4 * Math.sin((clock / 17.9) * TAU + 2 * p));
    stem.sx = STEM_SWAY * nod + STEM_GUST * gust;
    stem.sz =
      STEM_SWAY *
        breeze *
        (0.7 * Math.sin((clock / 14.7) * TAU + 3 * p) + 0.3 * Math.sin((clock / 9.1) * TAU + p)) +
      0.5 * STEM_GUST * gust;
  }
  for (const m of web.moorings) {
    const stem = web.stems[m.stem];
    if (stem === undefined) {
      // The twig above: a small, slow nod of its own.
      const nod = TWIG_NOD * breeze * Math.sin((clock / 15.1) * TAU + 0.7);
      web.sys.move(m.point, m.x + nod, m.y, nod * 0.6);
    } else {
      stemAt(stem, m.u, at);
      web.sys.move(m.point, at[0] ?? 0, at[1] ?? 0, at[2] ?? 0);
    }
  }
}

/**
 * The breeze's push on a web point at (x, y) at the web's `time` (a VerletForce's out): sideways,
 * the drops' weight on it (`load`), and out of plane with a slow ripple running across.
 */
export function breezePush(
  out: Float32Array,
  x: number,
  y: number,
  time: number,
  fx: number,
  load: number,
  fz: number,
): void {
  const ripple = 1 + RIPPLE * Math.sin(RIPPLE_K * (0.8 * x + 0.6 * y) - RIPPLE_W * time);
  out[0] = fx;
  out[1] = load;
  out[2] = fz * ripple;
}

/**
 * Spinning a web as a build (sims/build.ts): spun, then PREWARM_STEPS whole 0.1 s steps in the
 * breeze as it stood, so its tension has settled. Its dew is the page's to carry over (DewSim #adopt).
 */
export const dewSpin: BuildKind<DewSpinRequest, DewWebState> = {
  name: "dew",
  builder: () => ({
    *build({ aspect, seed, air }) {
      const web = new DewWeb(aspect, seed);
      const { gust, fx, fz } = breezeAt(air);
      swayStems(web, air.clock, air.breeze, gust, new Float64Array(3));
      const opts: VerletStepOptions = {
        gravity: [0, GRAVITY, 0],
        damping: DAMPING,
        iterations: ITERATIONS,
        force: (_i, x, y, _z, out) => breezePush(out, x, y, web.sys.time, fx, 0, fz),
      };
      for (let i = 0; i < PREWARM_STEPS; i++) {
        web.sys.step(opts, PREWARM_SUBSTEPS);
        yield undefined;
      }
      return web.state;
    },
  }),
};
