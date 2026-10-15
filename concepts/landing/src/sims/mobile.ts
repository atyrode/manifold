// A hanging mobile, after Calder: balanced wire arms hung one from another, each end carrying a flat
// plate, a ball (a painted globe, a brass weight) or the link to the next arm down. A shared part: a
// scene designs one from a seed (`designMobile`) or lays one out itself (a `MobileDesign`), steps it
// in the air it supplies (`Mobile.step`), uploads it each frame (`MobileTexture`) and draws it with
// `mobileGlsl`: plates, balls, wires and links traced along a view ray, and the shadows they cast
// from a round lamp onto anything (a wall, a floor, each other).
//
// Physics, on VerletSystem (verlet.ts):
// - Every arm is a rigid triangle of three points: its ends A (end 0) and B (end 1) and the hang loop
//   H a little above the line between them, so a balanced arm hangs level and stable. A link (one
//   distance constraint, a ball joint at each end) ties H to the parent's end, to the parent's own
//   loop (arms stacked on one axis, `end: 2`), or to the pinned ceiling anchor. The arms are coupled
//   pendulums: each swings on its link from the one above, rocks on its loop and turns freely about
//   its link.
// - A plate is lumped at its arm's end: the wire runs onto the plate's centroid (where Calder riveted
//   it). `designMobile` balances every arm on its loop by the lever rule for what hangs below each
//   end, with a small seeded imbalance that tilts it a few degrees.
// - A ball is lumped at its arm's end too, centred on it, with the mass its design gives (a hollow
//   globe is light for its size, a brass weight heavy).
// - The air pushes on every plate along its normal, quadratic in the relative speed
//   (½ ρ C_d A |v_n| v_n), with a little skin drag in its plane, so a steady draft turns the arms
//   toward edge-on and a gust spins and swings them; on a ball, along the relative air whatever its
//   way (a sphere's C_d). Everything feels `damping` (VerletStepOptions: a light linear drag on every
//   point).
// - A motor (`drive`) may turn an arm about its link at a set rate, so that over time it keeps that
//   rate exactly: a couple at the arm's two ends that makes up for the damping, brings the turn back
//   to the rate within about MOTOR_LAG and winds up the turn it has lost (up to MOTOR_SLIP, as a
//   slipping clutch) over about MOTOR_HOLD, never more than MOTOR_GRIP of angular acceleration, so a
//   gust or a knock still sets the arm back and it catches up again.
// - Contact: after each substep's solve, a plate overlapping another arm's plate, wire or link is
//   pushed apart from it along a plate normal by the overlap, mass-weighted (PBD inequality
//   constraints, Müller, Heidelberger, Hennix, Ratcliff, "Position Based Dynamics", 2007). A plate is
//   tested as its equivalent ellipse (the same area and second moments) and a slab MOBILE_SLAB thick
//   on each side; against another plate, 8 points of its rim. A ball keeps its radius plus the slab
//   clear of other arms' balls, wires and links and of their plates' slabs, and is pushed out along
//   the line between them. `contacts` counts the touches begun.
// - Time: fixed substeps of MOBILE_SUBSTEP, one VerletSystem step each, so the air and the contacts
//   are evaluated every substep; `alpha` blends the drawn state between the last two.
//
// Units: metres, seconds, kilograms; y up, z toward the viewer (the Verlet convention).
//
// Texture (`MobileTexture`: rgba16f, MOBILE_MAX_ARMS × MOBILE_TEXELS texels in one row, nearest).
// Arm k starts at texel k · MOBILE_TEXELS; positions less the texture's origin, blended by alpha and
// moved by the pose:
//   +0 end A (xyz), w 1 while the arm exists (0: no arm k, nor any after it)
//   +1 end B, +2 the loop H, +3 the link's top (the parent's end or loop, or the anchor)
//   +4, +5 what hangs at end 0 / 1: (code, size m, spin rad, twist rad); code 0 none or an arm, a plate
//          1 + shape + 8 for the plate the Manifold M may replace, a ball MOBILE_BALL_CODE + its look
//          with size its radius
//   +6 (tone of plate 0, tone of plate 1, depth, 0): a tone 0..1 picks a colour in the scene's palette
//   +7 (radius round H that holds the arm's wires, plates and balls, 0, 0, 0)
//
// Usage:
//   const mobile = new Mobile(designMobile({ seed, arms: 5, anchor: [0, 3.3, 0], span: 1, clearance: 1, shapes: [0, 1, 2, 3], top: 0.9 }));
//   mobile.settle(MOBILE_SETTLE, air);                 // prewarm: a fixed count of substeps
//   const texture = new MobileTexture(gl, [0, 1.8, 0]);
//   // each frame:
//   mobile.step(frame.dt * frame.motion, air);         // air(x, y, z, out): the air's velocity there now
//   texture.upload(mobile);
//   // GLSL: ${mobileGlsl("uSim0", [0, 1.8, 0])}, then mobileTrace(ro, rd, cellW, maxT, wireR, linkR)
//   // and mobileShadow(P, lamp, lampRadius, skipArm, skipEnd); mobile.drive(k, rate) runs a motor.
import { glslFloat } from "../shaders/glsl.ts";
import { FixedStep } from "./clock.ts";
import { clamp } from "./math.ts";
import { Random } from "./random.ts";
import { DataTexture } from "./texture.ts";
import { VerletSystem, type Vec3, type VerletStepOptions } from "./verlet.ts";

/** Most arms a mobile has (the texture's capacity). */
export const MOBILE_MAX_ARMS = 12;
/** Texels per arm in the texture. */
export const MOBILE_TEXELS = 8;
/** Seconds per substep: the contacts and the air are evaluated this often. */
export const MOBILE_SUBSTEP = 1 / 240;
/** Most substeps one `step` runs (a longer dt is dropped, as FixedStep does): 0.2 s. */
const MAX_SUBSTEPS = 48;
/** Half the thickness a plate keeps clear around it in contact (m): 2 mm sheet and a hair of air. */
export const MOBILE_SLAB = 0.004;
/** Substeps a pair must stay apart before touching again counts as a new touch (0.1 s). */
const TOUCH_GAP = 24;

/** Plate outlines, in `shape` order. The M (MOBILE_MARK_SHAPE) only ever replaces a plate in the drawing. */
export const MOBILE_SHAPES = ["disc", "petal", "drop", "crescent"] as const;
export const MOBILE_MARK_SHAPE = 4;
/** A ball's code in the texture: this plus its look (0..MOBILE_BALL_LOOKS - 1), above every plate's. */
export const MOBILE_BALL_CODE = 32;
export const MOBILE_BALL_LOOKS = 32;

/** Gravity (m/s²), the air's ½ ρ C_d for a flat plate face-on (kg/m³), and the skin drag's share of it. */
const GRAVITY = 9.81;
const FACE_DRAG = 0.5 * 1.2 * 1.17;
const SKIN = 0.04;
/** The air's ½ ρ C_d for a ball (a sphere's C_d, 0.47), on its cross-section. */
const BALL_DRAG = 0.5 * 1.2 * 0.47;
/**
 * A motor's response (s): it brings its arm's turn to the set rate in about this long, and winds up
 * the turn the arm has lost over about MOTOR_HOLD, up to MOTOR_SLIP (rad; more slips like a clutch
 * and is let go); its grip, the most angular acceleration it gives (rad/s²), so a gust or a knock
 * still sets the arm back.
 */
const MOTOR_LAG = 1.2;
const MOTOR_HOLD = 4;
const MOTOR_SLIP = 2 * Math.PI;
const MOTOR_GRIP = 1.5;
/**
 * Sheet (kg/m²: 1 mm aluminium), wire (kg/m: 2.5 mm steel), a crimped loop or hook (kg). The loop's
 * 20 g also keeps the solver honest: under a half-kilogram cascade a 4 g loop let the most loaded
 * side of a triangle stretch 1.6%, which on a loop a few centimetres above the wire tilts the arm by
 * degrees.
 */
const SHEET = 2.7;
export const MOBILE_WIRE = 0.035;
export const MOBILE_LOOP = 0.02;
/** Linear drag on every point (1/s): a swing rings down over ~20 s, and a turning arm keeps turning a while. */
const DAMPING = 0.06;
/**
 * Constraint passes per substep. At 30, 24 designs of 5-7 arms settled in still air kept every
 * constraint within 1% and every arm within 2° of its designed balance (16 µs a substep in Bun).
 */
const ITERATIONS = 30;

/** Signed distance to plate shape `shape` (units of its size, about the shape's own origin). */
function shapeDistance(shape: number, x: number, y: number): number {
  if (shape === 0) return Math.hypot(x, y) - 1;
  if (shape === 1) {
    // A vesica pointed along x: half length 1, half width 0.5 (two arcs of radius 1.25).
    const px = Math.abs(y);
    const py = Math.abs(x);
    return (py - 1) * 0.75 > px ? Math.hypot(px, py - 1) : Math.hypot(px + 0.75, py) - 1.25;
  }
  if (shape === 2) {
    // A drop: a round end on the left tapering to a point on the right (sdTaperCapsule).
    const t = Math.min(1, Math.max(0, (x + 0.35) / 1.27));
    return Math.hypot(x + 0.35 - 1.27 * t, y) - (0.65 - 0.59 * t);
  }
  // A crescent: the disc less a disc shifted up and to the right.
  return Math.max(Math.hypot(x, y) - 1, 0.8 - Math.hypot(x - 0.55, y - 0.3));
}

interface ShapeStats {
  /** Area in size² units. */
  area: number;
  /** Centroid, about the shape's origin: the plate's mass point. */
  cx: number;
  cy: number;
  /** Semi-axes of the equivalent ellipse (same area and second moments), along x and y. */
  ex: number;
  ey: number;
  /** Farthest the outline reaches from the centroid. */
  reach: number;
}

/** Each outline's area, centroid and equivalent ellipse, measured once on a 96² grid. */
const SHAPE_STATS: readonly ShapeStats[] = MOBILE_SHAPES.map((_, shape) => {
  const n = 96;
  const h = 2.4 / n;
  let area = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -1.2 + (i + 0.5) * h;
      const y = -1.2 + (j + 0.5) * h;
      if (shapeDistance(shape, x, y) >= 0) continue;
      area += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
    }
  }
  const cx = sx / area;
  const cy = sy / area;
  let reach = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -1.2 + (i + 0.5) * h;
      const y = -1.2 + (j + 0.5) * h;
      if (shapeDistance(shape, x, y) < 0) reach = Math.max(reach, Math.hypot(x - cx, y - cy));
    }
  }
  return {
    area: area * h * h,
    cx,
    cy,
    ex: 2 * Math.sqrt(Math.max(1e-6, sxx / area - cx * cx)),
    ey: 2 * Math.sqrt(Math.max(1e-6, syy / area - cy * cy)),
    reach: reach + h,
  };
});

/**
 * Signed distance to plate outline `shape` (an index into MOBILE_SHAPES; not the M) at (x, y) in
 * units of its size about its centroid, the plate's mass point: the CPU twin of GLSL `mobileShape`.
 */
export function mobilePlateDistance(shape: number, x: number, y: number): number {
  const stats = SHAPE_STATS[shape] ?? SHAPE_STATS[0];
  return shapeDistance(shape, x + (stats?.cx ?? 0), y + (stats?.cy ?? 0));
}

// ---- design ------------------------------------------------------------------------------------

export interface MobilePlateDesign {
  /** Index into MOBILE_SHAPES. */
  readonly shape: number;
  /** Scale of the outline (m): it reaches about this far from its middle. */
  readonly size: number;
  /** In-plane turn of the outline from the arm's outward direction, toward up (rad). */
  readonly spin: number;
  /** Turn of the plate's plane about the arm's line (rad). */
  readonly twist: number;
  /** 0..1: picks a colour from the scene's palette. */
  readonly tone: number;
  /** The plate the Manifold M may replace in the drawing (one per mobile). */
  readonly markable: boolean;
}

/** A ball hung at an arm's end in place of a plate, centred on it: a painted globe, a brass weight. */
export interface MobileBallDesign {
  /** Radius (m). */
  readonly radius: number;
  /** Mass (kg). */
  readonly mass: number;
  /** What the scene draws it as, its own number 0..MOBILE_BALL_LOOKS - 1 (packed for the shader). */
  readonly look: number;
}

export interface MobileArmDesign {
  /** The arm it hangs from, or -1 for the anchor. */
  readonly parent: number;
  /** Which end of the parent it hangs from, or 2 for the parent's own loop (arms stacked on one axis). */
  readonly end: 0 | 1 | 2;
  /** Arms above it. */
  readonly depth: number;
  /** Length of the link from the parent's end or loop (or the anchor) down to its loop (m). */
  readonly link: number;
  /** Horizontal distance from the loop to end 0 and to end 1 (m). */
  readonly reach: readonly [number, number];
  /** Height of the loop above the line between the ends (m). */
  readonly loop: number;
  /** Which way end 1 points at rest, about +y from +x (rad). */
  readonly heading: number;
  /** The plate at each end; undefined where a ball or an arm hangs from it instead. */
  readonly plates: readonly [MobilePlateDesign | undefined, MobilePlateDesign | undefined];
  /** A ball at an end that has no plate; undefined where an arm (or nothing) hangs from it. */
  readonly balls?: readonly [MobileBallDesign | undefined, MobileBallDesign | undefined];
}

export interface MobileDesign {
  /** Where the top link is tied (pinned). */
  readonly anchor: Vec3;
  /** Parents before children: arm 0 hangs from the anchor. */
  readonly arms: readonly MobileArmDesign[];
}

export interface MobileDesignOptions {
  seed: number;
  /** 1..MOBILE_MAX_ARMS. */
  arms: number;
  anchor: Vec3;
  /** Length of the top arm (m); each arm down is about three quarters of the one above. */
  span: number;
  /** Scales every link: below 1 the arms crowd and knock against each other. */
  clearance: number;
  /** The outlines the plates are drawn from (indices into MOBILE_SHAPES). */
  shapes: readonly number[];
  /** Length of the top link, from the anchor down to the top arm's loop (m); not scaled by `clearance`. */
  top: number;
}

export class MobileError extends Error {}

/** Chance an arm hangs from an older arm's free end rather than from the newest arm (a branch). */
const BRANCH = 0.3;
/** The top plate's size (m) and its fall-off per level down. */
const PLATE = 0.19;
const PLATE_FALL = 0.86;
/** Each arm's span against its parent's. */
const SPAN_FALL = 0.76;
/** The loop's height against the arm's span; the imbalance that tilts an arm (share of its reach: up to ~5°). */
const LOOP_SHARE = 0.06;
const TILT = 0.005;
/** Link length (m) below the top link: a base plus room for the plates either side. */
const LINK_BASE = 0.06;
const LINK_ROOM = 0.7;

/**
 * A balanced cascade of `arms` arms for a seed. Each new arm hangs from the newest arm's end, or now
 * and then (a branch) from an older arm's free end; every end left free carries a plate. Sizes fall
 * off down the cascade; every arm's two reaches balance what hangs below them about its loop.
 */
export function designMobile(options: MobileDesignOptions): MobileDesign {
  const count = Math.min(MOBILE_MAX_ARMS, Math.max(1, Math.round(options.arms)));
  if (options.shapes.length === 0)
    throw new MobileError("designMobile: no plate shapes to draw from");
  const rand = new Random(Math.imul(options.seed + 1, 0x9e3779b1) ^ 0x6d6f6231);

  // The tree: which end of which arm each arm hangs from.
  const parent = [-1];
  const end: (0 | 1)[] = [0];
  const depth = [0];
  const child: [number, number][] = [[-1, -1]];
  for (let k = 1; k < count; k++) {
    let p = k - 1;
    if (k >= 2 && rand.next() < BRANCH) {
      const older: number[] = [];
      for (let j = 0; j < k - 1; j++) {
        const c = child[j];
        if (c !== undefined && (c[0] < 0 || c[1] < 0) && (depth[j] ?? 0) < 2) older.push(j);
      }
      if (older.length > 0) p = rand.pick(older);
    }
    const c = child[p] ?? [-1, -1];
    const e: 0 | 1 = c[0] < 0 && c[1] < 0 ? (rand.int(2) as 0 | 1) : c[0] < 0 ? 0 : 1;
    c[e] = k;
    parent.push(p);
    end.push(e);
    depth.push((depth[p] ?? 0) + 1);
    child.push([-1, -1]);
  }

  // Each arm's own measures, drawn in arm order.
  const spans: number[] = [];
  const headings: number[] = [];
  const tilts: number[] = [];
  const plates: [MobilePlateDesign | undefined, MobilePlateDesign | undefined][] = [];
  for (let k = 0; k < count; k++) {
    const level = depth[k] ?? 0;
    spans.push(options.span * Math.pow(SPAN_FALL, level) * (0.85 + 0.3 * rand.next()));
    headings.push(rand.next() * Math.PI * 2);
    tilts.push((rand.next() - 0.5) * 2 * TILT);
    const pair: [MobilePlateDesign | undefined, MobilePlateDesign | undefined] = [
      undefined,
      undefined,
    ];
    for (const e of [0, 1] as const) {
      if ((child[k]?.[e] ?? -1) >= 0) continue;
      pair[e] = {
        shape: rand.pick(options.shapes),
        size: PLATE * Math.pow(PLATE_FALL, level) * (0.75 + 0.5 * rand.next()),
        spin: rand.next() * 1.4 - 0.9,
        twist: (rand.next() - 0.5) * 0.7,
        tone: rand.next(),
        markable: false,
      };
    }
    plates.push(pair);
  }
  // The Manifold M may replace the last plate of the deepest arm: the cascade's tip.
  let tip = 0;
  for (let k = 0; k < count; k++) if ((depth[k] ?? 0) >= (depth[tip] ?? 0)) tip = k;
  const tipPlates = plates[tip];
  if (tipPlates !== undefined) {
    const e = tipPlates[1] !== undefined ? 1 : 0;
    const plate = tipPlates[e];
    if (plate !== undefined) tipPlates[e] = { ...plate, markable: true };
  }

  // Balance, from the bottom up: each end's reach by the lever rule for what hangs below it.
  const below = new Array<number>(count).fill(0);
  const reaches: [number, number][] = new Array(count);
  for (let k = count - 1; k >= 0; k--) {
    const span = spans[k] ?? 0;
    const wire = MOBILE_WIRE * span;
    const mass = [0, 1].map((e) => {
      const plate = plates[k]?.[e];
      const hung = child[k]?.[e] ?? -1;
      return (
        (plate === undefined
          ? (hung >= 0 ? (below[hung] ?? 0) : 0) + MOBILE_LOOP
          : plateMass(plate)) +
        wire / 2
      );
    });
    const m0 = mass[0] ?? 0;
    const m1 = mass[1] ?? 0;
    const r0 = Math.min(0.92, Math.max(0.08, (m1 / (m0 + m1)) * (1 + (tilts[k] ?? 0))));
    reaches[k] = [span * r0, span * (1 - r0)];
    below[k] = m0 + m1 + MOBILE_LOOP;
  }

  // Links: room for the biggest plate on the parent and on the arm itself to pass each other.
  const biggest = (k: number): number =>
    Math.max(plates[k]?.[0]?.size ?? 0, plates[k]?.[1]?.size ?? 0);
  const arms: MobileArmDesign[] = [];
  for (let k = 0; k < count; k++) {
    const p = parent[k] ?? -1;
    const room = LINK_BASE + LINK_ROOM * ((p >= 0 ? biggest(p) : 0) + biggest(k));
    const span = spans[k] ?? 0;
    arms.push({
      parent: p,
      end: end[k] ?? 0,
      depth: depth[k] ?? 0,
      link: p < 0 ? options.top : options.clearance * (room + 0.06 * rand.next()),
      reach: reaches[k] ?? [span / 2, span / 2],
      loop: LOOP_SHARE * span,
      heading: headings[k] ?? 0,
      plates: plates[k] ?? [undefined, undefined],
    });
  }
  return { anchor: options.anchor, arms };
}

function plateMass(plate: MobilePlateDesign): number {
  return SHEET * (SHAPE_STATS[plate.shape]?.area ?? Math.PI) * plate.size * plate.size;
}

// ---- simulation --------------------------------------------------------------------------------

/** The air's velocity (m/s) at (x, y, z) now: write it into `out`. Called once per plate per substep. */
export type MobileAir = (x: number, y: number, z: number, out: Float32Array) => void;

/** A rigid move of the whole mobile for drawing (a passage): `swing` radians about the anchor in the picture plane, then `lift` metres up. */
export interface MobilePose {
  lift: number;
  swing: number;
}

/** Substeps a scene might settle a fresh mobile for: 6 s. */
export const MOBILE_SETTLE = 1440;

/** Plate frame record: centre, outline x axis, outline y axis, normal (12 numbers). */
const FRAME = 12;

/** A mobile in the air (see the header). */
export class Mobile {
  readonly design: MobileDesign;
  readonly system: VerletSystem;
  /**
   * Touches begun since it was built (plate or ball on plate, ball, wire or link): a pair counts
   * again only after TOUCH_GAP apart, so a plate resting against another, pushed out and falling back
   * substep by substep, is one touch.
   */
  contacts = 0;
  readonly #clock = new FixedStep(MOBILE_SUBSTEP, MAX_SUBSTEPS);
  readonly #step: VerletStepOptions;
  readonly #anchor: number;
  /** Per arm: point indices of A, B, H and the link's top. */
  readonly #ends: Int32Array;
  readonly #loopPoint: Int32Array;
  readonly #topPoint: Int32Array;
  /** Per plate. */
  readonly #plateArm: Int32Array;
  readonly #plateEnd: Int32Array;
  readonly #platePoint: Int32Array;
  readonly #plateArea: Float64Array;
  readonly #plateSize: Float64Array;
  readonly #plateEx: Float64Array;
  readonly #plateEy: Float64Array;
  readonly #plateReach: Float64Array;
  readonly #plateSpin: Float64Array;
  readonly #plateTwist: Float64Array;
  readonly #frames: Float64Array;
  /** Per ball. */
  readonly #ballArm: Int32Array;
  readonly #ballEnd: Int32Array;
  readonly #ballPoint: Int32Array;
  readonly #ballRadius: Float64Array;
  /** Segments for contact (each arm's two wires and its link): endpoints and owner. */
  readonly #segA: Int32Array;
  readonly #segB: Int32Array;
  readonly #segArm: Int32Array;
  /** The substep (counted from 1; 0: never) each plate last touched each plate / segment, for counting touches begun. */
  readonly #touched: Float64Array;
  /** The same for each ball against each ball / plate / segment. */
  readonly #ballTouched: Float64Array;
  /**
   * Per arm: its motor's rate (rad/s about +y; NaN: none), the turn it has lost to make up (rad) and
   * its turning inertia about its link (kg m²).
   */
  readonly #driveRate: Float64Array;
  readonly #driveLost: Float64Array;
  readonly #driveInertia: Float64Array;
  #substeps = 0;
  readonly #force: Float32Array;
  readonly #air = new Float32Array(3);
  readonly #rim = new Float64Array(3);
  #airAt: MobileAir | undefined;

  constructor(design: MobileDesign) {
    if (design.arms.length === 0 || design.arms.length > MOBILE_MAX_ARMS)
      throw new MobileError(`a mobile has 1..${MOBILE_MAX_ARMS} arms, got ${design.arms.length}`);
    this.design = design;
    const arms = design.arms.length;
    const sys = new VerletSystem({
      substep: MOBILE_SUBSTEP,
      maxSubsteps: 1,
      points: 1 + 3 * arms,
      constraints: 4 * arms,
    });
    this.system = sys;
    const [ax, ay, az] = design.anchor;
    this.#anchor = sys.addPoint(ax, ay, az, 0);
    this.#ends = new Int32Array(2 * arms);
    this.#loopPoint = new Int32Array(arms);
    this.#topPoint = new Int32Array(arms);
    const plates = design.arms.reduce(
      (n, arm) => n + (arm.plates[0] ? 1 : 0) + (arm.plates[1] ? 1 : 0),
      0,
    );
    const balls = design.arms.reduce(
      (n, arm) => n + (arm.balls?.[0] ? 1 : 0) + (arm.balls?.[1] ? 1 : 0),
      0,
    );
    this.#plateArm = new Int32Array(plates);
    this.#plateEnd = new Int32Array(plates);
    this.#platePoint = new Int32Array(plates);
    this.#plateArea = new Float64Array(plates);
    this.#plateSize = new Float64Array(plates);
    this.#plateEx = new Float64Array(plates);
    this.#plateEy = new Float64Array(plates);
    this.#plateReach = new Float64Array(plates);
    this.#plateSpin = new Float64Array(plates);
    this.#plateTwist = new Float64Array(plates);
    this.#frames = new Float64Array(plates * FRAME);
    this.#ballArm = new Int32Array(balls);
    this.#ballEnd = new Int32Array(balls);
    this.#ballPoint = new Int32Array(balls);
    this.#ballRadius = new Float64Array(balls);
    this.#segA = new Int32Array(3 * arms);
    this.#segB = new Int32Array(3 * arms);
    this.#segArm = new Int32Array(3 * arms);
    this.#touched = new Float64Array(plates * (plates + 3 * arms));
    this.#ballTouched = new Float64Array(balls * (balls + plates + 3 * arms));
    this.#driveRate = new Float64Array(arms).fill(Number.NaN);
    this.#driveLost = new Float64Array(arms);
    this.#driveInertia = new Float64Array(arms);
    this.#force = new Float32Array((1 + 3 * arms) * 3);

    // What each end carries (its plate, ball or the loop an arm hangs from), and each arm with
    // everything below it, from the bottom up: the motors' turning inertia.
    const endMass = (k: number, e: 0 | 1): number => {
      const arm = design.arms[k];
      if (arm === undefined) return 0;
      const plate = arm.plates[e];
      const ball = arm.balls?.[e];
      const own =
        plate !== undefined ? plateMass(plate) : ball !== undefined ? ball.mass : MOBILE_LOOP;
      return own + (MOBILE_WIRE * (arm.reach[0] + arm.reach[1])) / 2;
    };
    const hung = new Float64Array(arms);
    const carried = new Float64Array(2 * arms);
    for (let k = arms - 1; k >= 0; k--) {
      const arm = design.arms[k];
      if (arm === undefined) continue;
      hung[k] = (hung[k] ?? 0) + endMass(k, 0) + endMass(k, 1) + MOBILE_LOOP;
      carried[2 * k] = (carried[2 * k] ?? 0) + endMass(k, 0);
      carried[2 * k + 1] = (carried[2 * k + 1] ?? 0) + endMass(k, 1);
      if (arm.parent < 0) continue;
      hung[arm.parent] = (hung[arm.parent] ?? 0) + (hung[k] ?? 0);
      if (arm.end !== 2)
        carried[2 * arm.parent + arm.end] =
          (carried[2 * arm.parent + arm.end] ?? 0) + (hung[k] ?? 0);
    }

    // Build top-down at rest: every arm level, its loop straight below the point it hangs from.
    let plate = 0;
    let ball = 0;
    for (let k = 0; k < arms; k++) {
      const arm = design.arms[k];
      if (arm === undefined) continue;
      if (arm.parent >= k)
        throw new MobileError(`arm ${k} hangs from arm ${arm.parent}: parents come first`);
      const above = design.arms[arm.parent];
      if (
        above !== undefined &&
        arm.end !== 2 &&
        (above.plates[arm.end] !== undefined || above.balls?.[arm.end] !== undefined)
      )
        throw new MobileError(`arm ${k} hangs from an end of arm ${arm.parent} that holds a body`);
      const top =
        arm.parent < 0
          ? this.#anchor
          : arm.end === 2
            ? (this.#loopPoint[arm.parent] ?? 0)
            : (this.#ends[2 * arm.parent + arm.end] ?? 0);
      const pos = sys.positions;
      const tx = pos[top * 3] ?? 0;
      const ty = pos[top * 3 + 1] ?? 0;
      const tz = pos[top * 3 + 2] ?? 0;
      const hy = ty - arm.link;
      const dx = Math.cos(arm.heading);
      const dz = Math.sin(arm.heading);
      this.#driveInertia[k] =
        (carried[2 * k] ?? 0) * arm.reach[0] ** 2 + (carried[2 * k + 1] ?? 0) * arm.reach[1] ** 2;
      const a = sys.addPoint(
        tx - dx * arm.reach[0],
        hy - arm.loop,
        tz - dz * arm.reach[0],
        1 / endMass(k, 0),
      );
      const b = sys.addPoint(
        tx + dx * arm.reach[1],
        hy - arm.loop,
        tz + dz * arm.reach[1],
        1 / endMass(k, 1),
      );
      const h = sys.addPoint(tx, hy, tz, 1 / MOBILE_LOOP);
      sys.addConstraint(a, h);
      sys.addConstraint(b, h);
      sys.addConstraint(a, b);
      sys.addConstraint(top, h);
      this.#ends[2 * k] = a;
      this.#ends[2 * k + 1] = b;
      this.#loopPoint[k] = h;
      this.#topPoint[k] = top;
      this.#segA[3 * k] = a;
      this.#segB[3 * k] = h;
      this.#segA[3 * k + 1] = h;
      this.#segB[3 * k + 1] = b;
      this.#segA[3 * k + 2] = top;
      this.#segB[3 * k + 2] = h;
      this.#segArm.fill(k, 3 * k, 3 * k + 3);
      for (const e of [0, 1] as const) {
        const globe = arm.balls?.[e];
        const p = arm.plates[e];
        if (globe !== undefined) {
          if (p !== undefined)
            throw new MobileError(`arm ${k}'s end ${e} holds both a plate and a ball`);
          if (!(globe.look >= 0 && globe.look < MOBILE_BALL_LOOKS))
            throw new MobileError(
              `a ball's look is 0..${MOBILE_BALL_LOOKS - 1}, got ${globe.look}`,
            );
          this.#ballArm[ball] = k;
          this.#ballEnd[ball] = e;
          this.#ballPoint[ball] = e === 0 ? a : b;
          this.#ballRadius[ball] = globe.radius;
          ball++;
        }
        if (p === undefined) continue;
        const stats = SHAPE_STATS[p.shape] ?? SHAPE_STATS[0];
        this.#plateArm[plate] = k;
        this.#plateEnd[plate] = e;
        this.#platePoint[plate] = e === 0 ? a : b;
        this.#plateArea[plate] = (stats?.area ?? Math.PI) * p.size * p.size;
        this.#plateSize[plate] = p.size;
        this.#plateEx[plate] = (stats?.ex ?? 1) * p.size;
        this.#plateEy[plate] = (stats?.ey ?? 1) * p.size;
        this.#plateReach[plate] = (stats?.reach ?? 1) * p.size;
        this.#plateSpin[plate] = p.spin;
        this.#plateTwist[plate] = p.twist;
        plate++;
      }
    }
    const force = this.#force;
    this.#step = {
      gravity: [0, -GRAVITY, 0],
      damping: DAMPING,
      iterations: ITERATIONS,
      force: (i, _x, _y, _z, out) => {
        out[0] = force[i * 3] ?? 0;
        out[1] = force[i * 3 + 1] ?? 0;
        out[2] = force[i * 3 + 2] ?? 0;
      },
    };
  }

  get arms(): number {
    return this.design.arms.length;
  }

  get plates(): number {
    return this.#platePoint.length;
  }

  get balls(): number {
    return this.#ballPoint.length;
  }

  /** Share of a substep run past the last one, 0..1: the drawn state's blend. */
  get alpha(): number {
    return this.#clock.alpha;
  }

  /** Point indices of arm k: [end A, end B, loop H, the link's top]. */
  armPoints(k: number): readonly [number, number, number, number] {
    return [
      this.#ends[2 * k] ?? 0,
      this.#ends[2 * k + 1] ?? 0,
      this.#loopPoint[k] ?? 0,
      this.#topPoint[k] ?? 0,
    ];
  }

  /** Arm, end and Verlet point of plate i. */
  plate(i: number): { arm: number; end: number; point: number } {
    return {
      arm: this.#plateArm[i] ?? 0,
      end: this.#plateEnd[i] ?? 0,
      point: this.#platePoint[i] ?? 0,
    };
  }

  /** Arm, end, Verlet point (its centre) and radius of ball i. */
  ball(i: number): { arm: number; end: number; point: number; radius: number } {
    return {
      arm: this.#ballArm[i] ?? 0,
      end: this.#ballEnd[i] ?? 0,
      point: this.#ballPoint[i] ?? 0,
      radius: this.#ballRadius[i] ?? 0,
    };
  }

  /**
   * Run arm k's motor at `rate` rad/s about its link, right-handed about +y (+x turns toward -z:
   * anticlockwise seen from above); NaN switches it off and leaves the arm to turn freely.
   */
  drive(k: number, rate: number): void {
    if (!(k >= 0 && k < this.arms)) return;
    this.#driveRate[k] = rate;
    if (Number.isNaN(rate)) this.#driveLost[k] = 0;
  }

  /**
   * Plate i's frame now, as the shader builds it: centre (its mass point), the outline's x and y
   * axes and the normal, 12 numbers into `out`.
   */
  plateFrame(i: number, out: Float64Array | number[]): void {
    this.#frame(i);
    for (let j = 0; j < FRAME; j++) out[j] = this.#frames[i * FRAME + j] ?? 0;
  }

  /** Advance `dt` seconds of the motion clock (fixed substeps; the remainder carried). Returns the substeps run. */
  step(dt: number, air?: MobileAir): number {
    const n = this.#clock.advance(dt);
    this.#airAt = air;
    for (let s = 0; s < n; s++) this.#substep();
    return n;
  }

  /** Run `substeps` substeps outright (a prewarm), leaving the frame clock alone. */
  settle(substeps: number, air?: MobileAir): void {
    this.#airAt = air;
    for (let s = 0; s < substeps; s++) this.#substep();
  }

  /**
   * The plate or ball whose outline passes nearest the ray ro + t rd (rd unit), within `slack` of its
   * reach: a plate's index, or a ball's plus `plates`; -1 if none.
   */
  pick(ro: Vec3, rd: Vec3, slack: number): number {
    const pos = this.system.positions;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.plates + this.balls; i++) {
      const ball = i >= this.plates;
      const o = ((ball ? this.#ballPoint[i - this.plates] : this.#platePoint[i]) ?? 0) * 3;
      const wx = (pos[o] ?? 0) - ro[0];
      const wy = (pos[o + 1] ?? 0) - ro[1];
      const wz = (pos[o + 2] ?? 0) - ro[2];
      const t = wx * rd[0] + wy * rd[1] + wz * rd[2];
      const reach = (ball ? this.#ballRadius[i - this.plates] : this.#plateReach[i]) ?? 0;
      const d = Math.hypot(wx - rd[0] * t, wy - rd[1] * t, wz - rd[2] * t) - reach;
      if (t > 0 && d < slack && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Give plate i (or ball i - plates, as `pick` numbers them) a push: a velocity change (m/s) of its point. */
  kick(i: number, vx: number, vy: number, vz: number): void {
    const p = i >= this.plates ? this.#ballPoint[i - this.plates] : this.#platePoint[i];
    if (p === undefined) return;
    const pos = this.system.positions;
    this.system.impulse(
      pos[p * 3] ?? 0,
      pos[p * 3 + 1] ?? 0,
      pos[p * 3 + 2] ?? 0,
      1e-3,
      vx,
      vy,
      vz,
    );
  }

  #substep(): void {
    for (let i = 0; i < this.plates; i++) this.#frame(i);
    this.#airForces();
    this.#driveForces();
    this.system.step(MOBILE_SUBSTEP, this.#step);
    for (let i = 0; i < this.plates; i++) this.#frame(i);
    this.#contact();
  }

  /** Plate i's frame from its arm's three points (the shader's mobilePlate, line for line). */
  #frame(i: number): void {
    const pos = this.system.positions;
    const k = this.#plateArm[i] ?? 0;
    const e = this.#plateEnd[i] ?? 0;
    const pa = (this.#ends[2 * k] ?? 0) * 3;
    const pb = (this.#ends[2 * k + 1] ?? 0) * 3;
    const ph = (this.#loopPoint[k] ?? 0) * 3;
    const [pc, po] = e === 0 ? [pa, pb] : [pb, pa];
    const cx = pos[pc] ?? 0;
    const cy = pos[pc + 1] ?? 0;
    const cz = pos[pc + 2] ?? 0;
    let ux = cx - (pos[po] ?? 0);
    let uy = cy - (pos[po + 1] ?? 0);
    let uz = cz - (pos[po + 2] ?? 0);
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    let wx = (pos[ph] ?? 0) - 0.5 * ((pos[pa] ?? 0) + (pos[pb] ?? 0));
    let wy = (pos[ph + 1] ?? 0) - 0.5 * ((pos[pa + 1] ?? 0) + (pos[pb + 1] ?? 0));
    let wz = (pos[ph + 2] ?? 0) - 0.5 * ((pos[pa + 2] ?? 0) + (pos[pb + 2] ?? 0));
    const wu = wx * ux + wy * uy + wz * uz;
    wx -= wu * ux;
    wy -= wu * uy;
    wz -= wu * uz;
    const wl = Math.hypot(wx, wy, wz) || 1;
    const vx = wx / wl;
    const vy = wy / wl;
    const vz = wz / wl;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const tw = this.#plateTwist[i] ?? 0;
    const ct = Math.cos(tw);
    const st = Math.sin(tw);
    const v2x = vx * ct + nx * st;
    const v2y = vy * ct + ny * st;
    const v2z = vz * ct + nz * st;
    const sp = this.#plateSpin[i] ?? 0;
    const cs = Math.cos(sp);
    const ss = Math.sin(sp);
    const f = this.#frames;
    const o = i * FRAME;
    f[o] = cx;
    f[o + 1] = cy;
    f[o + 2] = cz;
    f[o + 3] = ux * cs + v2x * ss;
    f[o + 4] = uy * cs + v2y * ss;
    f[o + 5] = uz * cs + v2z * ss;
    f[o + 6] = v2x * cs - ux * ss;
    f[o + 7] = v2y * cs - uy * ss;
    f[o + 8] = v2z * cs - uz * ss;
    f[o + 9] = nx * ct - vx * st;
    f[o + 10] = ny * ct - vy * st;
    f[o + 11] = nz * ct - vz * st;
  }

  /** The air's push on every plate and ball, into the per-point force array the Verlet step reads. */
  #airForces(): void {
    const force = this.#force;
    force.fill(0);
    const pos = this.system.positions;
    const prev = this.system.previous;
    const air = this.#air;
    const rate = 1 / MOBILE_SUBSTEP;
    const f = this.#frames;
    for (let i = 0; i < this.plates; i++) {
      const p = (this.#platePoint[i] ?? 0) * 3;
      const x = pos[p] ?? 0;
      const y = pos[p + 1] ?? 0;
      const z = pos[p + 2] ?? 0;
      air[0] = 0;
      air[1] = 0;
      air[2] = 0;
      this.#airAt?.(x, y, z, air);
      const rx = (x - (prev[p] ?? x)) * rate - (air[0] ?? 0);
      const ry = (y - (prev[p + 1] ?? y)) * rate - (air[1] ?? 0);
      const rz = (z - (prev[p + 2] ?? z)) * rate - (air[2] ?? 0);
      const o = i * FRAME;
      const nx = f[o + 9] ?? 0;
      const ny = f[o + 10] ?? 0;
      const nz = f[o + 11] ?? 0;
      const vn = rx * nx + ry * ny + rz * nz;
      const tx = rx - vn * nx;
      const ty = ry - vn * ny;
      const tz = rz - vn * nz;
      const area = FACE_DRAG * (this.#plateArea[i] ?? 0);
      const face = -area * Math.abs(vn) * vn;
      const skin = -area * SKIN * Math.hypot(tx, ty, tz);
      force[p] = (force[p] ?? 0) + face * nx + skin * tx;
      force[p + 1] = (force[p + 1] ?? 0) + face * ny + skin * ty;
      force[p + 2] = (force[p + 2] ?? 0) + face * nz + skin * tz;
    }
    for (let i = 0; i < this.balls; i++) {
      const p = (this.#ballPoint[i] ?? 0) * 3;
      const x = pos[p] ?? 0;
      const y = pos[p + 1] ?? 0;
      const z = pos[p + 2] ?? 0;
      air[0] = 0;
      air[1] = 0;
      air[2] = 0;
      this.#airAt?.(x, y, z, air);
      const rx = (x - (prev[p] ?? x)) * rate - (air[0] ?? 0);
      const ry = (y - (prev[p + 1] ?? y)) * rate - (air[1] ?? 0);
      const rz = (z - (prev[p + 2] ?? z)) * rate - (air[2] ?? 0);
      const r = this.#ballRadius[i] ?? 0;
      const drag = -BALL_DRAG * Math.PI * r * r * Math.hypot(rx, ry, rz);
      force[p] = (force[p] ?? 0) + drag * rx;
      force[p + 1] = (force[p + 1] ?? 0) + drag * ry;
      force[p + 2] = (force[p + 2] ?? 0) + drag * rz;
    }
  }

  /**
   * Each running motor's couple, into the force array: equal and opposite pushes across its arm's two
   * ends, its arm's turning inertia times the acceleration the header gives (at most MOTOR_GRIP). The
   * turn is the arm's line seen from above, now against a substep ago, so a swing or a rock of the arm
   * does not count; the turn lost sums the rate's turn less the arm's, substep by substep.
   */
  #driveForces(): void {
    const pos = this.system.positions;
    const prev = this.system.previous;
    const force = this.#force;
    for (let k = 0; k < this.arms; k++) {
      const rate = this.#driveRate[k] ?? Number.NaN;
      if (Number.isNaN(rate)) continue;
      const a = (this.#ends[2 * k] ?? 0) * 3;
      const b = (this.#ends[2 * k + 1] ?? 0) * 3;
      const ux = (pos[a] ?? 0) - (pos[b] ?? 0);
      const uz = (pos[a + 2] ?? 0) - (pos[b + 2] ?? 0);
      const px = (prev[a] ?? 0) - (prev[b] ?? 0);
      const pz = (prev[a + 2] ?? 0) - (prev[b + 2] ?? 0);
      const span = Math.hypot(ux, uz);
      const was = Math.hypot(px, pz);
      if (span < 1e-6 || was < 1e-6) continue;
      const turn = Math.asin(clamp((pz * ux - px * uz) / (span * was), -1, 1)) / MOBILE_SUBSTEP;
      const lost = clamp(
        (this.#driveLost[k] ?? 0) + (rate - turn) * MOBILE_SUBSTEP,
        -MOTOR_SLIP,
        MOTOR_SLIP,
      );
      this.#driveLost[k] = lost;
      const accel = clamp(
        DAMPING * rate + (rate - turn) / MOTOR_LAG + lost / (MOTOR_LAG * MOTOR_HOLD),
        -MOTOR_GRIP,
        MOTOR_GRIP,
      );
      // Each end's push (N), along y × (A - B) at A, the way a right-handed turn about +y moves it.
      const push = ((this.#driveInertia[k] ?? 0) * accel) / (span * span);
      force[a] = (force[a] ?? 0) + push * uz;
      force[a + 2] = (force[a + 2] ?? 0) - push * ux;
      force[b] = (force[b] ?? 0) - push * uz;
      force[b + 2] = (force[b + 2] ?? 0) + push * ux;
    }
  }

  /** Push overlapping plates, balls, wires and links apart (see the header). */
  #contact(): void {
    const plates = this.plates;
    const segments = this.#segArm.length;
    const stride = plates + segments;
    const now = ++this.#substeps;
    for (let i = 0; i < plates; i++) {
      for (let j = i + 1; j < plates; j++) {
        if ((this.#plateArm[i] ?? 0) !== (this.#plateArm[j] ?? -1) && this.#platePair(i, j))
          this.#touch(this.#touched, i * stride + j, now);
      }
      for (let s = 0; s < segments; s++) {
        if ((this.#segArm[s] ?? -1) !== (this.#plateArm[i] ?? 0) && this.#plateSegment(i, s))
          this.#touch(this.#touched, i * stride + plates + s, now);
      }
    }
    const balls = this.balls;
    const ballStride = balls + stride;
    for (let i = 0; i < balls; i++) {
      const arm = this.#ballArm[i] ?? 0;
      for (let j = i + 1; j < balls; j++) {
        if (arm !== (this.#ballArm[j] ?? -1) && this.#ballPair(i, j))
          this.#touch(this.#ballTouched, i * ballStride + j, now);
      }
      for (let j = 0; j < plates; j++) {
        if (arm !== (this.#plateArm[j] ?? -1) && this.#ballPlate(i, j))
          this.#touch(this.#ballTouched, i * ballStride + balls + j, now);
      }
      for (let s = 0; s < segments; s++) {
        if (arm !== (this.#segArm[s] ?? -1) && this.#ballSegment(i, s))
          this.#touch(this.#ballTouched, i * ballStride + balls + plates + s, now);
      }
    }
  }

  #touch(record: Float64Array, pair: number, now: number): void {
    const last = record[pair] ?? 0;
    if (last === 0 || now - last > TOUCH_GAP) this.contacts++;
    record[pair] = now;
  }

  /** Balls i and j: kept their radii and a slab apart along the line between their centres. True if they touched. */
  #ballPair(i: number, j: number): boolean {
    const pos = this.system.positions;
    const inv = this.system.inverseMass;
    const pi = this.#ballPoint[i] ?? 0;
    const pj = this.#ballPoint[j] ?? 0;
    const dx = (pos[pj * 3] ?? 0) - (pos[pi * 3] ?? 0);
    const dy = (pos[pj * 3 + 1] ?? 0) - (pos[pi * 3 + 1] ?? 0);
    const dz = (pos[pj * 3 + 2] ?? 0) - (pos[pi * 3 + 2] ?? 0);
    const d = Math.hypot(dx, dy, dz);
    const depth = (this.#ballRadius[i] ?? 0) + (this.#ballRadius[j] ?? 0) + MOBILE_SLAB - d;
    if (depth <= 0) return false;
    const wi = inv[pi] ?? 0;
    const wj = inv[pj] ?? 0;
    const w = wi + wj;
    if (w <= 0) return true;
    const n = d > 1e-9 ? [dx / d, dy / d, dz / d] : [1, 0, 0];
    for (let c = 0; c < 3; c++) {
      pos[pi * 3 + c] = (pos[pi * 3 + c] ?? 0) - ((n[c] ?? 0) * depth * wi) / w;
      pos[pj * 3 + c] = (pos[pj * 3 + c] ?? 0) + ((n[c] ?? 0) * depth * wj) / w;
    }
    return true;
  }

  /**
   * Ball i against plate j: where the ball's centre lies over the plate's equivalent ellipse, kept its
   * radius and the slab off the plate's face, pushed apart along the plate's normal. True if they touched.
   */
  #ballPlate(i: number, j: number): boolean {
    const pos = this.system.positions;
    const inv = this.system.inverseMass;
    const f = this.#frames;
    const o = j * FRAME;
    const pb = this.#ballPoint[i] ?? 0;
    const pp = this.#platePoint[j] ?? 0;
    const x = (pos[pb * 3] ?? 0) - (f[o] ?? 0);
    const y = (pos[pb * 3 + 1] ?? 0) - (f[o + 1] ?? 0);
    const z = (pos[pb * 3 + 2] ?? 0) - (f[o + 2] ?? 0);
    const s = x * (f[o + 9] ?? 0) + y * (f[o + 10] ?? 0) + z * (f[o + 11] ?? 0);
    const depth = (this.#ballRadius[i] ?? 0) + MOBILE_SLAB - Math.abs(s);
    if (depth <= 0) return false;
    const lx =
      (x * (f[o + 3] ?? 0) + y * (f[o + 4] ?? 0) + z * (f[o + 5] ?? 0)) / (this.#plateEx[j] ?? 1);
    const ly =
      (x * (f[o + 6] ?? 0) + y * (f[o + 7] ?? 0) + z * (f[o + 8] ?? 0)) / (this.#plateEy[j] ?? 1);
    if (lx * lx + ly * ly >= 1) return false;
    const wb = inv[pb] ?? 0;
    const wp = inv[pp] ?? 0;
    const w = wb + wp;
    if (w <= 0) return true;
    const side = s < 0 ? -1 : 1;
    for (let c = 0; c < 3; c++) {
      const n = (f[o + 9 + c] ?? 0) * side * depth;
      pos[pb * 3 + c] = (pos[pb * 3 + c] ?? 0) + (n * wb) / w;
      pos[pp * 3 + c] = (pos[pp * 3 + c] ?? 0) - (n * wp) / w;
    }
    return true;
  }

  /** Ball i against segment s (a wire or link of another arm): kept its radius and the slab off it. True if they touched. */
  #ballSegment(i: number, s: number): boolean {
    const pos = this.system.positions;
    const inv = this.system.inverseMass;
    const p = this.#ballPoint[i] ?? 0;
    const a = this.#segA[s] ?? 0;
    const b = this.#segB[s] ?? 0;
    const ax = pos[a * 3] ?? 0;
    const ay = pos[a * 3 + 1] ?? 0;
    const az = pos[a * 3 + 2] ?? 0;
    const bx = (pos[b * 3] ?? 0) - ax;
    const by = (pos[b * 3 + 1] ?? 0) - ay;
    const bz = (pos[b * 3 + 2] ?? 0) - az;
    const cx = (pos[p * 3] ?? 0) - ax;
    const cy = (pos[p * 3 + 1] ?? 0) - ay;
    const cz = (pos[p * 3 + 2] ?? 0) - az;
    const bb = bx * bx + by * by + bz * bz;
    const t = bb > 0 ? Math.min(1, Math.max(0, (cx * bx + cy * by + cz * bz) / bb)) : 0;
    // From the segment's point nearest the centre out to the centre.
    const qx = cx - bx * t;
    const qy = cy - by * t;
    const qz = cz - bz * t;
    const d = Math.hypot(qx, qy, qz);
    const depth = (this.#ballRadius[i] ?? 0) + MOBILE_SLAB - d;
    if (depth <= 0) return false;
    const wp = inv[p] ?? 0;
    const w = wp + (inv[a] ?? 0) * (1 - t) * (1 - t) + (inv[b] ?? 0) * t * t;
    if (w <= 0 || d < 1e-9) return true;
    const k = depth / (w * d);
    for (const [c, n] of [
      [0, qx],
      [1, qy],
      [2, qz],
    ] as const) {
      const move = n * k;
      pos[p * 3 + c] = (pos[p * 3 + c] ?? 0) + move * wp;
      pos[a * 3 + c] = (pos[a * 3 + c] ?? 0) - move * (inv[a] ?? 0) * (1 - t);
      pos[b * 3 + c] = (pos[b * 3 + c] ?? 0) - move * (inv[b] ?? 0) * t;
    }
    return true;
  }

  /** Plates i and j: the deepest of either's rim points inside the other's slab, pushed out. True if they touched. */
  #platePair(i: number, j: number): boolean {
    const pos = this.system.positions;
    const f = this.#frames;
    const oi = i * FRAME;
    const oj = j * FRAME;
    const dx = (f[oj] ?? 0) - (f[oi] ?? 0);
    const dy = (f[oj + 1] ?? 0) - (f[oi + 1] ?? 0);
    const dz = (f[oj + 2] ?? 0) - (f[oi + 2] ?? 0);
    if (
      Math.hypot(dx, dy, dz) >
      (this.#plateReach[i] ?? 0) + (this.#plateReach[j] ?? 0) + 2 * MOBILE_SLAB
    )
      return false;
    let depth = 0;
    let dir = 0;
    let along = j;
    for (const [from, onto, sign] of [
      [i, j, 1],
      [j, i, -1],
    ] as const) {
      const of = from * FRAME;
      const oo = onto * FRAME;
      const ex = this.#plateEx[from] ?? 0;
      const ey = this.#plateEy[from] ?? 0;
      const ox = this.#plateEx[onto] ?? 0;
      const oy = this.#plateEy[onto] ?? 0;
      for (let r = 0; r < 8; r++) {
        const a = (r * Math.PI) / 4;
        const ca = Math.cos(a) * ex;
        const sa = Math.sin(a) * ey;
        const rim = this.#rim;
        for (let c = 0; c < 3; c++)
          rim[c] =
            (f[of + c] ?? 0) +
            ca * (f[of + 3 + c] ?? 0) +
            sa * (f[of + 6 + c] ?? 0) -
            (f[oo + c] ?? 0);
        const s =
          (rim[0] ?? 0) * (f[oo + 9] ?? 0) +
          (rim[1] ?? 0) * (f[oo + 10] ?? 0) +
          (rim[2] ?? 0) * (f[oo + 11] ?? 0);
        if (Math.abs(s) >= MOBILE_SLAB) continue;
        const lx =
          ((rim[0] ?? 0) * (f[oo + 3] ?? 0) +
            (rim[1] ?? 0) * (f[oo + 4] ?? 0) +
            (rim[2] ?? 0) * (f[oo + 5] ?? 0)) /
          ox;
        const ly =
          ((rim[0] ?? 0) * (f[oo + 6] ?? 0) +
            (rim[1] ?? 0) * (f[oo + 7] ?? 0) +
            (rim[2] ?? 0) * (f[oo + 8] ?? 0)) /
          oy;
        if (lx * lx + ly * ly >= 1) continue;
        const d = MOBILE_SLAB - Math.abs(s);
        if (d > depth) {
          depth = d;
          // Push `from` out of `onto`'s slab on the side it is on; as plate i's move, signed.
          dir = (s < 0 ? -1 : 1) * sign;
          along = onto;
        }
      }
    }
    if (depth <= 0) return false;
    const pi = (this.#platePoint[i] ?? 0) * 3;
    const pj = (this.#platePoint[j] ?? 0) * 3;
    const wi = this.system.inverseMass[this.#platePoint[i] ?? 0] ?? 0;
    const wj = this.system.inverseMass[this.#platePoint[j] ?? 0] ?? 0;
    const w = wi + wj;
    if (w <= 0) return true;
    const on = along * FRAME + 9;
    for (let c = 0; c < 3; c++) {
      const n = (f[on + c] ?? 0) * dir * depth;
      pos[pi + c] = (pos[pi + c] ?? 0) + (n * wi) / w;
      pos[pj + c] = (pos[pj + c] ?? 0) - (n * wj) / w;
    }
    return true;
  }

  /** Plate i against segment s (a wire or link of another arm): pushed apart along the plate's normal. True if they touched. */
  #plateSegment(i: number, s: number): boolean {
    const pos = this.system.positions;
    const inv = this.system.inverseMass;
    const f = this.#frames;
    const o = i * FRAME;
    const a = this.#segA[s] ?? 0;
    const b = this.#segB[s] ?? 0;
    const ax = pos[a * 3] ?? 0;
    const ay = pos[a * 3 + 1] ?? 0;
    const az = pos[a * 3 + 2] ?? 0;
    const bx = (pos[b * 3] ?? 0) - ax;
    const by = (pos[b * 3 + 1] ?? 0) - ay;
    const bz = (pos[b * 3 + 2] ?? 0) - az;
    const cx = (f[o] ?? 0) - ax;
    const cy = (f[o + 1] ?? 0) - ay;
    const cz = (f[o + 2] ?? 0) - az;
    const bb = bx * bx + by * by + bz * bz;
    const t = bb > 0 ? Math.min(1, Math.max(0, (cx * bx + cy * by + cz * bz) / bb)) : 0;
    // The segment's point nearest the plate's centre, relative to it.
    const qx = bx * t - cx;
    const qy = by * t - cy;
    const qz = bz * t - cz;
    const reach = (this.#plateReach[i] ?? 0) + MOBILE_SLAB;
    if (qx * qx + qy * qy + qz * qz > reach * reach) return false;
    const nx = f[o + 9] ?? 0;
    const ny = f[o + 10] ?? 0;
    const nz = f[o + 11] ?? 0;
    const sn = qx * nx + qy * ny + qz * nz;
    if (Math.abs(sn) >= MOBILE_SLAB) return false;
    const lx =
      (qx * (f[o + 3] ?? 0) + qy * (f[o + 4] ?? 0) + qz * (f[o + 5] ?? 0)) /
      (this.#plateEx[i] ?? 1);
    const ly =
      (qx * (f[o + 6] ?? 0) + qy * (f[o + 7] ?? 0) + qz * (f[o + 8] ?? 0)) /
      (this.#plateEy[i] ?? 1);
    if (lx * lx + ly * ly >= 1) return false;
    const depth = MOBILE_SLAB - Math.abs(sn);
    const side = sn < 0 ? -1 : 1;
    const p = this.#platePoint[i] ?? 0;
    const wp = inv[p] ?? 0;
    const wa = (inv[a] ?? 0) * (1 - t) * (1 - t);
    const wb = (inv[b] ?? 0) * t * t;
    const w = wp + wa + wb;
    if (w <= 0) return true;
    const k = depth / w;
    // The segment moves out along the side it is on; the plate the other way.
    for (const [c, n] of [
      [0, nx],
      [1, ny],
      [2, nz],
    ] as const) {
      const move = side * n * k;
      pos[p * 3 + c] = (pos[p * 3 + c] ?? 0) - move * wp;
      pos[a * 3 + c] = (pos[a * 3 + c] ?? 0) + move * (inv[a] ?? 0) * (1 - t);
      pos[b * 3 + c] = (pos[b * 3 + c] ?? 0) + move * (inv[b] ?? 0) * t;
    }
    return true;
  }
}

// ---- texture -----------------------------------------------------------------------------------

/** A mobile packed for `mobileGlsl` (layout in the header). */
export class MobileTexture {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(MOBILE_MAX_ARMS * MOBILE_TEXELS * 4);
  readonly #origin: Vec3;

  constructor(gl: WebGL2RenderingContext, origin: Vec3) {
    this.#texture = new DataTexture(gl, {
      width: MOBILE_MAX_ARMS * MOBILE_TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#origin = origin;
  }

  get texture(): WebGLTexture {
    return this.#texture.texture;
  }

  /** Pack and upload the mobile as drawn now (blended by its alpha), moved by `pose`. */
  upload(mobile: Mobile, pose?: MobilePose): void {
    packMobile(mobile, this.#origin, this.#data, pose);
    this.#texture.upload(this.#data);
  }

  dispose(): void {
    this.#texture.dispose();
  }
}

/** The texture's numbers for `mobile` (MOBILE_MAX_ARMS × MOBILE_TEXELS × 4 into `out`; see the header). */
export function packMobile(
  mobile: Mobile,
  origin: Vec3,
  out: Float32Array,
  pose?: MobilePose,
): void {
  out.fill(0);
  const sys = mobile.system;
  const pos = sys.positions;
  const prev = sys.previous;
  const alpha = mobile.alpha;
  const [ax, ay] = mobile.design.anchor;
  const swing = pose?.swing ?? 0;
  const lift = pose?.lift ?? 0;
  const moved = swing !== 0 || lift !== 0;
  const cs = Math.cos(swing);
  const ss = Math.sin(swing);
  const put = (texel: number, point: number, w: number): void => {
    const o = point * 3;
    let x = (prev[o] ?? 0) + ((pos[o] ?? 0) - (prev[o] ?? 0)) * alpha;
    let y = (prev[o + 1] ?? 0) + ((pos[o + 1] ?? 0) - (prev[o + 1] ?? 0)) * alpha;
    const z = (prev[o + 2] ?? 0) + ((pos[o + 2] ?? 0) - (prev[o + 2] ?? 0)) * alpha;
    if (moved) {
      const rx = x - ax;
      const ry = y - ay;
      x = ax + rx * cs - ry * ss;
      y = ay + rx * ss + ry * cs + lift;
    }
    out[texel * 4] = x - origin[0];
    out[texel * 4 + 1] = y - origin[1];
    out[texel * 4 + 2] = z - origin[2];
    out[texel * 4 + 3] = w;
  };
  for (let k = 0; k < mobile.arms; k++) {
    const arm = mobile.design.arms[k];
    if (arm === undefined) continue;
    const base = k * MOBILE_TEXELS;
    const [a, b, h, top] = mobile.armPoints(k);
    put(base, a, 1);
    put(base + 1, b, 0);
    put(base + 2, h, 0);
    put(base + 3, top, 0);
    let bound = 0;
    for (const e of [0, 1] as const) {
      const plate = arm.plates[e];
      const ball = arm.balls?.[e];
      const o = (base + 4 + e) * 4;
      bound = Math.max(
        bound,
        arm.reach[e] +
          arm.loop +
          (plate !== undefined
            ? (SHAPE_STATS[plate.shape]?.reach ?? 1) * plate.size
            : (ball?.radius ?? 0)),
      );
      if (ball !== undefined) {
        out[o] = MOBILE_BALL_CODE + ball.look;
        out[o + 1] = ball.radius;
      }
      if (plate === undefined) continue;
      out[o] = 1 + plate.shape + (plate.markable ? 8 : 0);
      out[o + 1] = plate.size;
      out[o + 2] = plate.spin;
      out[o + 3] = plate.twist;
      out[(base + 6) * 4 + e] = plate.tone;
    }
    out[(base + 6) * 4 + 2] = arm.depth;
    // Room for the M, which may be drawn larger than the plate it replaces.
    out[(base + 7) * 4] = bound * 1.4;
  }
}

// ---- GLSL --------------------------------------------------------------------------------------

/**
 * GLSL reading a MobileTexture bound to `sampler` (with the same `origin`), after common:
 *
 *   float mobileMark;                     set > 0 to draw the markable plate as the Manifold M, at that scale
 *   struct MobilePlate { vec3 c; vec3 ax; vec3 ay; vec3 n; float size; int shape; float tone; };
 *   bool mobilePlate(int k, int e, vec3 a, vec3 b, vec3 h, out MobilePlate p);  end e's plate, if any
 *   bool mobileBall(int k, int e, vec3 a, vec3 b, out vec4 ball, out int look);  end e's ball, if any:
 *       xyz its centre, w its radius; look the scene's number for it
 *   float mobileShape(vec2 q, int shape); signed distance to an outline, q in size units about its centroid
 *   struct MobileHit { float t; int kind; int arm; int end; vec3 n; vec2 q; float tone; int shape; };
 *   MobileHit mobileTrace(vec3 ro, vec3 rd, float cellW, float maxT, float wireR, float linkR);
 *       the nearest plate (MOBILE_PLATE), ball (MOBILE_BALL), wire (MOBILE_WIRE) or link (MOBILE_LINK)
 *       along a unit ray before maxT, cut per cell (cellW: a cell's size per unit of ray length;
 *       wires and links at least about a cell wide, plates still a cell thick edge-on, balls at least
 *       a cell across); n faces the eye (a ball's: its surface normal); q the plate point in size
 *       units; shape a ball's look; kind MOBILE_NONE and t = maxT if nothing
 *   float mobileShadow(vec3 P, vec3 L, float lr, int skipArm, int skipEnd);
 *       the share of a round lamp (centre L, radius lr) the mobile hides from P, penumbrae and all;
 *       skipArm/skipEnd leave out one plate or ball (the one P lies on), -1 for none
 */
export function mobileGlsl(sampler: string, origin: Vec3): string {
  const centroids = SHAPE_STATS.map((s) => `vec2(${glslFloat(s.cx)}, ${glslFloat(s.cy)})`).join(
    ", ",
  );
  return `
const int MOBILE_ARMS = ${MOBILE_MAX_ARMS};
const int MOBILE_NONE = 0;
const int MOBILE_PLATE = 1;
const int MOBILE_WIRE = 2;
const int MOBILE_LINK = 3;
const int MOBILE_BALL = 4;
const vec3 MOBILE_ORIGIN = vec3(${glslFloat(origin[0])}, ${glslFloat(origin[1])}, ${glslFloat(origin[2])});
const vec2 MOBILE_CENTROID[${SHAPE_STATS.length}] = vec2[${SHAPE_STATS.length}](${centroids});
// Half the sheet's thickness (m).
const float MOBILE_SHEET = 0.001;

float mobileMark = 0.0;

vec4 mobileTexel(int k, int i) {
  return texelFetch(${sampler}, ivec2(k * ${MOBILE_TEXELS} + i, 0), 0);
}

vec3 mobileAt(int k, int i) {
  return mobileTexel(k, i).xyz + MOBILE_ORIGIN;
}

struct MobilePlate {
  vec3 c;
  vec3 ax;
  vec3 ay;
  vec3 n;
  float size;
  int shape;
  float tone;
};

// Plate e (0: end a, 1: end b) of arm k, whose loop is h: its frame as Mobile's #frame builds it.
bool mobilePlate(int k, int e, vec3 a, vec3 b, vec3 h, out MobilePlate p) {
  vec4 g = mobileTexel(k, 4 + e);
  p = MobilePlate(vec3(0.0), vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), 0.0, 0, 0.0);
  if (g.x < 0.5 || g.x > ${glslFloat(MOBILE_BALL_CODE - 0.5)}) return false;
  vec3 c = e == 0 ? a : b;
  vec3 u = normalize(c - (e == 0 ? b : a));
  vec3 w = h - 0.5 * (a + b);
  vec3 v = normalize(w - dot(w, u) * u);
  vec3 n = cross(u, v);
  vec3 v2 = v * cos(g.w) + n * sin(g.w);
  float code = g.x - 1.0;
  bool markable = code > 7.5;
  p.c = c;
  p.ax = u * cos(g.z) + v2 * sin(g.z);
  p.ay = v2 * cos(g.z) - u * sin(g.z);
  p.n = n * cos(g.w) - v * sin(g.w);
  p.size = g.y;
  p.shape = int(code - (markable ? 8.0 : 0.0) + 0.5);
  if (markable && mobileMark > 0.0) {
    p.shape = ${MOBILE_MARK_SHAPE};
    p.size *= mobileMark;
  }
  vec4 tones = mobileTexel(k, 6);
  p.tone = e == 0 ? tones.x : tones.y;
  return true;
}

// The ball at end e (0: end a, 1: end b) of arm k: xyz its centre, w its radius; look the scene's.
bool mobileBall(int k, int e, vec3 a, vec3 b, out vec4 ball, out int look) {
  vec4 g = mobileTexel(k, 4 + e);
  ball = vec4(e == 0 ? a : b, g.y);
  look = int(g.x - ${glslFloat(MOBILE_BALL_CODE)} + 0.5);
  return g.x > ${glslFloat(MOBILE_BALL_CODE - 0.5)};
}

// Signed distance to an outline in size units, q about its centroid (the plate's mass point).
float mobileShape(vec2 q, int shape) {
  if (shape == ${MOBILE_MARK_SHAPE}) return (markDistance(q / 1.2) - 0.11) * 1.2;
  q += MOBILE_CENTROID[shape];
  if (shape == 0) return length(q) - 1.0;
  if (shape == 1) {
    vec2 p = abs(q.yx);
    return (p.y - 1.0) * 0.75 > p.x ? length(p - vec2(0.0, 1.0)) : length(p + vec2(0.75, 0.0)) - 1.25;
  }
  if (shape == 2) return sdTaperCapsule(q, vec2(-0.35, 0.0), vec2(0.92, 0.0), 0.65, 0.06);
  return max(length(q) - 1.0, 0.8 - length(q - vec2(0.55, 0.3)));
}

// The ray ro + t rd against segment a..b: the distance between them, the ray's t at the nearest point
// and where along the segment that is (0..1).
float mobileRaySeg(vec3 ro, vec3 rd, vec3 a, vec3 b, out float rayT, out float along) {
  vec3 d = b - a;
  vec3 w = a - ro;
  float dr = dot(d, rd);
  float den = max(dot(d, d) - dr * dr, 1.0e-9);
  along = clamp(-(dot(d, w) - dot(rd, w) * dr) / den, 0.0, 1.0);
  vec3 q = w + d * along;
  rayT = dot(q, rd);
  return length(q - rd * rayT);
}

// The plate along the ray: its t, or -1 where this cell misses it. The sheet is taken at least half a
// cell thick, so an edge-on plate still shows as a line: of the ray's stretch through that slab, the
// point nearest the centre is tried as well as the point on the mid-plane.
float mobilePlateRay(vec3 ro, vec3 rd, MobilePlate p, float cellW, out vec2 q) {
  vec3 oc = p.c - ro;
  float tc = dot(oc, rd);
  q = vec2(0.0);
  if (tc <= 0.0) return -1.0;
  float dn = dot(rd, p.n);
  float th = max(MOBILE_SHEET, 0.45 * cellW * tc);
  float tMid = abs(dn) > 1.0e-4 ? dot(oc, p.n) / dn : tc;
  float span = th / max(abs(dn), 1.0e-4);
  float tNear = clamp(tc, tMid - span, tMid + span);
  vec3 x0 = ro + rd * tMid - p.c;
  vec3 x1 = ro + rd * tNear - p.c;
  vec2 q0 = vec2(dot(x0, p.ax), dot(x0, p.ay)) / p.size;
  vec2 q1 = vec2(dot(x1, p.ax), dot(x1, p.ay)) / p.size;
  float d0 = abs(dn) > 1.0e-4 ? mobileShape(q0, p.shape) : 1.0e4;
  float d1 = abs(dot(x1, p.n)) <= th * 1.001 ? mobileShape(q1, p.shape) : 1.0e4;
  float d = min(d0, d1) * p.size;
  float t = d0 <= d1 ? tMid : tNear;
  q = d0 <= d1 ? q0 : q1;
  if (t <= 0.0 || hardFill(d / (cellW * t), 0.7) < 0.5) return -1.0;
  return t;
}

// The ball along the ray: its t, or -1 where this cell misses it, cut per cell at its silhouette and
// drawn at least about a cell across; n its surface normal there (on the rim's outer cells, the way
// from the centre to the ray).
float mobileBallRay(vec3 ro, vec3 rd, vec4 ball, float cellW, out vec3 n) {
  vec3 oc = ball.xyz - ro;
  float tc = dot(oc, rd);
  n = vec3(0.0, 0.0, 1.0);
  if (tc <= 0.0) return -1.0;
  vec3 off = rd * tc - oc;
  float d = length(off);
  float r = max(ball.w, 0.5 * cellW * tc);
  if (hardFill((d - r) / (cellW * tc), 0.7) < 0.5) return -1.0;
  float h = sqrt(max(r * r - d * d, 0.0));
  n = normalize(off - rd * h);
  return tc - h;
}

struct MobileHit {
  float t;
  int kind;
  int arm;
  int end;
  vec3 n;
  vec2 q;
  float tone;
  int shape;
};

// A round wire's normal where the ray passes at distance d of its axis (r: the drawn half width),
// the side toward the eye; off is the direction from the axis to the ray's nearest point.
vec3 mobileWireNormal(vec3 rd, vec3 off, float d, float r) {
  float s = clamp(d / max(r, 1.0e-6), 0.0, 1.0);
  vec3 side = length(off) > 1.0e-7 ? normalize(off) : vec3(0.0);
  return normalize(side * s - rd * sqrt(1.0 - s * s));
}

MobileHit mobileTrace(vec3 ro, vec3 rd, float cellW, float maxT, float wireR, float linkR) {
  MobileHit hit = MobileHit(maxT, MOBILE_NONE, -1, -1, vec3(0.0, 0.0, 1.0), vec2(0.0), 0.0, 0);
  for (int k = 0; k < MOBILE_ARMS; k++) {
    vec4 t0 = mobileTexel(k, 0);
    if (t0.w < 0.5) break;
    vec3 a = t0.xyz + MOBILE_ORIGIN;
    vec3 b = mobileAt(k, 1);
    vec3 h = mobileAt(k, 2);
    vec3 top = mobileAt(k, 3);
    float rt;
    float al;
    // The link.
    float d = mobileRaySeg(ro, rd, top, h, rt, al);
    float r = max(linkR, 0.4 * cellW * rt);
    if (rt > 0.0 && rt < hit.t && hardFill((d - r) / (cellW * rt), 0.6) > 0.5) {
      hit = MobileHit(rt, MOBILE_LINK, k, -1, mobileWireNormal(rd, ro + rd * rt - mix(top, h, al), d, r), vec2(al, 0.0), 0.0, 0);
    }
    // The arm: skipped where the ray passes clear of the ball round its loop.
    vec3 oh = h - ro;
    float th = dot(oh, rd);
    float bound = mobileTexel(k, 7).x + cellW * max(th, 0.0);
    if (th <= 0.0 || dot(oh, oh) - th * th > bound * bound || th - bound > hit.t) continue;
    for (int s = 0; s < 2; s++) {
      vec3 p0 = s == 0 ? a : h;
      vec3 p1 = s == 0 ? h : b;
      d = mobileRaySeg(ro, rd, p0, p1, rt, al);
      r = max(wireR, 0.5 * cellW * rt);
      if (rt > 0.0 && rt < hit.t && hardFill((d - r) / (cellW * rt), 0.6) > 0.5) {
        hit = MobileHit(rt, MOBILE_WIRE, k, s, mobileWireNormal(rd, ro + rd * rt - mix(p0, p1, al), d, r), vec2(al, 0.0), 0.0, 0);
      }
    }
    for (int e = 0; e < 2; e++) {
      vec4 ball;
      int look;
      if (mobileBall(k, e, a, b, ball, look)) {
        vec3 n;
        float tb = mobileBallRay(ro, rd, ball, cellW, n);
        if (tb > 0.0 && tb < hit.t) hit = MobileHit(tb, MOBILE_BALL, k, e, n, vec2(0.0), 0.0, look);
        continue;
      }
      MobilePlate p;
      if (!mobilePlate(k, e, a, b, h, p)) continue;
      vec2 q;
      float tp = mobilePlateRay(ro, rd, p, cellW, q);
      if (tp > 0.0 && tp < hit.t) hit = MobileHit(tp, MOBILE_PLATE, k, e, dot(rd, p.n) < 0.0 ? p.n : -p.n, q, p.tone, p.shape);
    }
  }
  return hit;
}

// Closest approach of segments p0..p1 and q0..q1 (Ericson, Real-Time Collision Detection 5.1.9): the
// distance, s along the first and u along the second (0..1).
float mobileSegSeg(vec3 p0, vec3 p1, vec3 q0, vec3 q1, out float s, out float u) {
  vec3 d1 = p1 - p0;
  vec3 d2 = q1 - q0;
  vec3 r = p0 - q0;
  float a = dot(d1, d1);
  float e = max(dot(d2, d2), 1.0e-12);
  float f = dot(d2, r);
  float c = dot(d1, r);
  float b = dot(d1, d2);
  float den = a * e - b * b;
  s = den > 1.0e-12 ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
  u = (b * s + f) / e;
  if (u < 0.0) {
    u = 0.0;
    s = clamp(-c / a, 0.0, 1.0);
  } else if (u > 1.0) {
    u = 1.0;
    s = clamp((b - c) / a, 0.0, 1.0);
  }
  return length(p0 + d1 * s - q0 - d2 * u);
}

// The share of the lamp a wire of radius r hides from P: the lamp seen from P has radius lr * s where
// the line to it passes the wire, so a thin wire under a big lamp only dims the light.
float mobileWireShade(vec3 P, vec3 L, vec3 a, vec3 b, float r, float lr) {
  float s;
  float u;
  float d = mobileSegSeg(P, L, a, b, s, u);
  float pen = max(lr * s, 1.0e-5);
  float w = max(pen, r);
  return (r / w) * (1.0 - smoothstep(0.0, w + r, d));
}

float mobileShadow(vec3 P, vec3 L, float lr, int skipArm, int skipEnd) {
  float lit = 1.0;
  vec3 pl = L - P;
  float pll = dot(pl, pl);
  for (int k = 0; k < MOBILE_ARMS; k++) {
    vec4 t0 = mobileTexel(k, 0);
    if (t0.w < 0.5) break;
    vec3 a = t0.xyz + MOBILE_ORIGIN;
    vec3 b = mobileAt(k, 1);
    vec3 h = mobileAt(k, 2);
    vec3 top = mobileAt(k, 3);
    lit *= 1.0 - mobileWireShade(P, L, top, h, 0.0006, lr);
    // The arm, where the line to the lamp passes near the ball round its loop.
    float s = clamp(dot(h - P, pl) / pll, 0.0, 1.0);
    float bound = mobileTexel(k, 7).x + lr * s;
    vec3 off = P + pl * s - h;
    if (dot(off, off) > bound * bound) continue;
    lit *= 1.0 - mobileWireShade(P, L, a, h, 0.0012, lr);
    lit *= 1.0 - mobileWireShade(P, L, h, b, 0.0012, lr);
    for (int e = 0; e < 2; e++) {
      if (k == skipArm && e == skipEnd) continue;
      vec4 ball;
      int look;
      if (mobileBall(k, e, a, b, ball, look)) {
        float t = dot(ball.xyz - P, pl) / pll;
        if (t <= 1.0e-4 || t >= 1.0) continue;
        // The lamp's footprint where the line to it passes the ball has radius lr * t: a ball smaller
        // than that only dims the light, by the share of the footprint it covers.
        float w = lr * t + 2.0e-4;
        float big = max(ball.w, w);
        float share = ball.w / big;
        lit *= 1.0 - share * share * softFill(length(P + pl * t - ball.xyz) - big, min(ball.w, w));
        continue;
      }
      MobilePlate p;
      if (!mobilePlate(k, e, a, b, h, p)) continue;
      float dn = dot(pl, p.n);
      if (abs(dn) < 1.0e-7) continue;
      float t = dot(p.c - P, p.n) / dn;
      if (t <= 1.0e-4 || t >= 1.0) continue;
      vec3 x = P + pl * t - p.c;
      float d = mobileShape(vec2(dot(x, p.ax), dot(x, p.ay)) / p.size, p.shape) * p.size;
      lit *= 1.0 - softFill(d, lr * t + 2.0e-4);
    }
  }
  return 1.0 - lit;
}
`;
}
