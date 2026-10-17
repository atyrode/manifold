// A hanging mobile: balanced wire arms hung one from another, each end carrying a ball (a painted
// globe, a brass weight) or the link to the next arm down. A shared part: a scene lays one out (a
// `MobileDesign`), steps it in the air it supplies (`Mobile.step`), uploads it each frame
// (`MobileTexture`) and draws it with `mobileGlsl`: balls, wires and links traced along a view ray,
// and the shadows they cast from a round lamp onto anything (a wall, a floor, each other).
//
// Physics, on VerletSystem (verlet.ts):
// - Every arm is a rigid triangle of three points: its ends A (end 0) and B (end 1) and the hang loop
//   H a little above the line between them, so a balanced arm hangs level and stable. A link (one
//   distance constraint, a ball joint at each end) ties H to the parent's end, to the parent's own
//   loop (arms stacked on one axis, `end: 2`), or to the pinned ceiling anchor. The arms are coupled
//   pendulums: each swings on its link from the one above, rocks on its loop and turns freely about
//   its link.
// - A ball is lumped at its arm's end, centred on it, with the mass its design gives (a hollow globe
//   is light for its size, a brass weight heavy). The design balances each arm on its loop by the
//   lever rule for what hangs below each end.
// - The air pushes on every ball along the relative air whatever its way, quadratic in the relative
//   speed (½ ρ C_d A |v| v, a sphere's C_d). Everything feels `damping` (VerletStepOptions: a light
//   linear drag on every point).
// - A motor (`drive`) may turn an arm about its link at a set rate, so that over time it keeps that
//   rate exactly: a couple at the arm's two ends that makes up for the damping, brings the turn back
//   to the rate within about MOTOR_LAG and winds up the turn it has lost (up to MOTOR_SLIP, as a
//   slipping clutch) over about MOTOR_HOLD, never more than MOTOR_GRIP of angular acceleration, so a
//   gust or a knock still sets the arm back and it catches up again.
// - Contact: after each substep's solve, a ball keeps its radius plus MOBILE_SLAB clear of other
//   arms' balls, wires and links, pushed out along the line between them by the overlap,
//   mass-weighted (PBD inequality constraints, Müller, Heidelberger, Hennix, Ratcliff, "Position
//   Based Dynamics", 2007). `contacts` counts the touches begun.
// - Time: one FixedStep of MOBILE_SUBSTEP (the only clock), one VerletSystem substep each, so the air
//   and the contacts are evaluated every substep; `alpha` blends the drawn state between the last two.
//
// Units: metres, seconds, kilograms; y up, z toward the viewer (the Verlet convention).
//
// Texture (`MobileTexture`: rgba16f, MOBILE_MAX_ARMS × MOBILE_TEXELS texels in one row, nearest).
// Arm k starts at texel k · MOBILE_TEXELS; positions less the texture's origin, blended by alpha and
// moved by the pose:
//   +0 end A (xyz), w 1 while the arm exists (0: no arm k, nor any after it)
//   +1 end B, +2 the loop H, +3 the link's top (the parent's end or loop, or the anchor)
//   +4, +5 what hangs at end 0 / 1: (code, radius m, 0, 0); code 0 none or an arm, a ball
//          MOBILE_BALL_CODE + its look
//   +6 (radius round H that holds the arm's wires and balls, 0, 0, 0)
//
// Usage:
//   const mobile = new Mobile(design);                  // a MobileDesign the scene lays out
//   mobile.settle(480, air);                            // prewarm: a fixed count of substeps
//   const texture = new MobileTexture(gl, [0, 1.8, 0]);
//   // each frame:
//   mobile.step(frame.dt * frame.motion, air);         // air(x, y, z, out): the air's velocity there now
//   texture.upload(mobile);
//   // GLSL: ${mobileGlsl("uSim0", [0, 1.8, 0])}, then mobileTrace(ro, rd, cellW, maxT, wireR, linkR)
//   // and mobileShadow(P, lamp, lampRadius, skipArm, skipEnd); mobile.drive(k, rate) runs a motor.
import { glslFloat } from "../shaders/glsl.ts";
import { FixedStep } from "./clock.ts";
import { clamp } from "./math.ts";
import { DataTexture } from "./texture.ts";
import { VerletSystem, type Vec3, type VerletStepOptions } from "./verlet.ts";

/** Most arms a mobile has (the texture's capacity). */
export const MOBILE_MAX_ARMS = 12;
/** Texels per arm in the texture. */
export const MOBILE_TEXELS = 7;
/** Seconds per substep: the contacts and the air are evaluated this often. */
export const MOBILE_SUBSTEP = 1 / 240;
/** Most substeps one `step` runs (a longer dt is dropped, as FixedStep does): 0.2 s. */
const MAX_SUBSTEPS = 48;
/** What a ball keeps clear of another arm's ball, wire or link beyond its radius (m). */
export const MOBILE_SLAB = 0.004;
/** Substeps a pair must stay apart before touching again counts as a new touch (0.1 s). */
const TOUCH_GAP = 24;

/** A ball's code in the texture: this plus its look (0..MOBILE_BALL_LOOKS - 1); 0 is no ball. */
export const MOBILE_BALL_CODE = 1;
export const MOBILE_BALL_LOOKS = 32;

/** Gravity (m/s²) and the air's ½ ρ C_d for a ball (a sphere's C_d, 0.47), on its cross-section. */
const GRAVITY = 9.81;
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
 * Wire (kg/m: 2.5 mm steel), a crimped loop or hook (kg). The loop's 20 g also keeps the solver
 * honest: under a half-kilogram cascade a 4 g loop let the most loaded side of a triangle stretch
 * 1.6%, which on a loop a few centimetres above the wire tilts the arm by degrees.
 */
export const MOBILE_WIRE = 0.035;
export const MOBILE_LOOP = 0.02;
/**
 * Linear drag on every point (1/s): a knocked mobile's swing loses about nine tenths of its energy
 * in ten seconds, and a turning arm keeps turning a while. The solver adds next to none of its own
 * (verlet.ts), so this is all the damping there is.
 */
const DAMPING = 0.1;
/**
 * Constraint passes per substep: ITERATIONS, and ITERATIONS_PER_ARM more for every arm. What the
 * solve leaves of a link's stretch falls only as 1 / passes, and the top links carry every arm below
 * them, so a longer cascade needs more. 60 s of the solar mobile in a breeze at clearance 1 keeps
 * its most loaded link within 0.45% with 5 arms, 0.77% with 9 and 0.83% with 11 (at a flat 24
 * passes: 0.75%, 1.45% and 1.85%), for 20, 51 and 74 µs a substep in Bun (15, 33 and 44 at 24).
 */
const ITERATIONS = 24;
const ITERATIONS_PER_ARM = 3;

// ---- design ------------------------------------------------------------------------------------

/** A ball hung at an arm's end, centred on it: a painted globe, a brass weight. */
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
  /** The ball at each end; undefined where an arm (or nothing) hangs from it. */
  readonly balls?: readonly [MobileBallDesign | undefined, MobileBallDesign | undefined];
}

export interface MobileDesign {
  /** Where the top link is tied (pinned). */
  readonly anchor: Vec3;
  /** Parents before children: arm 0 hangs from the anchor. */
  readonly arms: readonly MobileArmDesign[];
}

export class MobileError extends Error {}

// ---- simulation --------------------------------------------------------------------------------

/** The air's velocity (m/s) at (x, y, z) now: write it into `out`. Called once per ball per substep. */
export type MobileAir = (x: number, y: number, z: number, out: Float32Array) => void;

/** A rigid move of the whole mobile for drawing (a passage): `swing` radians about the anchor in the picture plane, then `lift` metres up. */
export interface MobilePose {
  lift: number;
  swing: number;
}

/** A mobile in the air (see the header). */
export class Mobile {
  readonly design: MobileDesign;
  readonly system: VerletSystem;
  /**
   * Touches begun since it was built (a ball on another arm's ball, wire or link): a pair counts
   * again only after TOUCH_GAP apart, so a ball resting against a wire, pushed out and falling back
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
  /** Per ball. */
  readonly #ballArm: Int32Array;
  readonly #ballEnd: Int32Array;
  readonly #ballPoint: Int32Array;
  readonly #ballRadius: Float64Array;
  /** Segments for contact (each arm's two wires and its link): endpoints and owner. */
  readonly #segA: Int32Array;
  readonly #segB: Int32Array;
  readonly #segArm: Int32Array;
  /** The substep (counted from 1; 0: never) each ball last touched each ball / segment, for counting touches begun. */
  readonly #touched: Float64Array;
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
  #airAt: MobileAir | undefined;

  constructor(design: MobileDesign) {
    if (design.arms.length === 0 || design.arms.length > MOBILE_MAX_ARMS)
      throw new MobileError(`a mobile has 1..${MOBILE_MAX_ARMS} arms, got ${design.arms.length}`);
    this.design = design;
    const arms = design.arms.length;
    const sys = new VerletSystem({
      substep: MOBILE_SUBSTEP,
      points: 1 + 3 * arms,
      constraints: 4 * arms,
    });
    this.system = sys;
    const [ax, ay, az] = design.anchor;
    this.#anchor = sys.addPoint(ax, ay, az, 0);
    this.#ends = new Int32Array(2 * arms);
    this.#loopPoint = new Int32Array(arms);
    this.#topPoint = new Int32Array(arms);
    const balls = design.arms.reduce(
      (n, arm) => n + (arm.balls?.[0] ? 1 : 0) + (arm.balls?.[1] ? 1 : 0),
      0,
    );
    this.#ballArm = new Int32Array(balls);
    this.#ballEnd = new Int32Array(balls);
    this.#ballPoint = new Int32Array(balls);
    this.#ballRadius = new Float64Array(balls);
    this.#segA = new Int32Array(3 * arms);
    this.#segB = new Int32Array(3 * arms);
    this.#segArm = new Int32Array(3 * arms);
    this.#touched = new Float64Array(balls * (balls + 3 * arms));
    this.#driveRate = new Float64Array(arms).fill(Number.NaN);
    this.#driveLost = new Float64Array(arms);
    this.#driveInertia = new Float64Array(arms);
    this.#force = new Float32Array((1 + 3 * arms) * 3);

    // What each end carries (its ball or the loop an arm hangs from), and each arm with everything
    // below it, from the bottom up: the motors' turning inertia.
    const endMass = (k: number, e: 0 | 1): number => {
      const arm = design.arms[k];
      if (arm === undefined) return 0;
      const own = arm.balls?.[e]?.mass ?? MOBILE_LOOP;
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
    let ball = 0;
    for (let k = 0; k < arms; k++) {
      const arm = design.arms[k];
      if (arm === undefined) continue;
      if (arm.parent >= k)
        throw new MobileError(`arm ${k} hangs from arm ${arm.parent}: parents come first`);
      const above = design.arms[arm.parent];
      if (above !== undefined && arm.end !== 2 && above.balls?.[arm.end] !== undefined)
        throw new MobileError(`arm ${k} hangs from an end of arm ${arm.parent} that holds a ball`);
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
        if (globe === undefined) continue;
        if (!(globe.look >= 0 && globe.look < MOBILE_BALL_LOOKS))
          throw new MobileError(`a ball's look is 0..${MOBILE_BALL_LOOKS - 1}, got ${globe.look}`);
        this.#ballArm[ball] = k;
        this.#ballEnd[ball] = e;
        this.#ballPoint[ball] = e === 0 ? a : b;
        this.#ballRadius[ball] = globe.radius;
        ball++;
      }
    }
    const force = this.#force;
    this.#step = {
      gravity: [0, -GRAVITY, 0],
      damping: DAMPING,
      iterations: ITERATIONS + ITERATIONS_PER_ARM * arms,
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

  /** The ball whose outline passes nearest the ray ro + t rd (rd unit), within `slack` of it: its index, or -1 if none. */
  pick(ro: Vec3, rd: Vec3, slack: number): number {
    const pos = this.system.positions;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.balls; i++) {
      const o = (this.#ballPoint[i] ?? 0) * 3;
      const wx = (pos[o] ?? 0) - ro[0];
      const wy = (pos[o + 1] ?? 0) - ro[1];
      const wz = (pos[o + 2] ?? 0) - ro[2];
      const t = wx * rd[0] + wy * rd[1] + wz * rd[2];
      const d =
        Math.hypot(wx - rd[0] * t, wy - rd[1] * t, wz - rd[2] * t) - (this.#ballRadius[i] ?? 0);
      if (t > 0 && d < slack && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Give ball i a push: a velocity change (m/s) of its point. */
  kick(i: number, vx: number, vy: number, vz: number): void {
    const p = this.#ballPoint[i];
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
      this.#clock.alpha,
    );
  }

  #substep(): void {
    this.#airForces();
    this.#driveForces();
    this.system.step(this.#step);
    this.#contact();
  }

  /** The air's push on every ball, into the per-point force array the Verlet step reads. */
  #airForces(): void {
    const force = this.#force;
    force.fill(0);
    const pos = this.system.positions;
    const prev = this.system.previous;
    const air = this.#air;
    const rate = 1 / MOBILE_SUBSTEP;
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

  /** Push overlapping balls, wires and links apart (see the header). */
  #contact(): void {
    const balls = this.balls;
    const segments = this.#segArm.length;
    const stride = balls + segments;
    const now = ++this.#substeps;
    for (let i = 0; i < balls; i++) {
      const arm = this.#ballArm[i] ?? 0;
      for (let j = i + 1; j < balls; j++) {
        if (arm !== (this.#ballArm[j] ?? -1) && this.#ballPair(i, j))
          this.#touch(i * stride + j, now);
      }
      for (let s = 0; s < segments; s++) {
        if (arm !== (this.#segArm[s] ?? -1) && this.#ballSegment(i, s))
          this.#touch(i * stride + balls + s, now);
      }
    }
  }

  #touch(pair: number, now: number): void {
    const last = this.#touched[pair] ?? 0;
    if (last === 0 || now - last > TOUCH_GAP) this.contacts++;
    this.#touched[pair] = now;
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
      const ball = arm.balls?.[e];
      bound = Math.max(bound, arm.reach[e] + arm.loop + (ball?.radius ?? 0));
      if (ball === undefined) continue;
      const o = (base + 4 + e) * 4;
      out[o] = MOBILE_BALL_CODE + ball.look;
      out[o + 1] = ball.radius;
    }
    // Room to spare: the loaded wires stretch a little, and a far ball is drawn a cell across.
    out[(base + 6) * 4] = bound * 1.4;
  }
}

// ---- GLSL --------------------------------------------------------------------------------------

/**
 * GLSL reading a MobileTexture bound to `sampler` (with the same `origin`), after common:
 *
 *   bool mobileBall(int k, int e, vec3 a, vec3 b, out vec4 ball, out int look);  end e's ball, if any:
 *       xyz its centre, w its radius; look the scene's number for it
 *   struct MobileHit { float t; int kind; int arm; int end; vec3 n; };
 *   MobileHit mobileTrace(vec3 ro, vec3 rd, float cellW, float maxT, float wireR, float linkR);
 *       the nearest ball (MOBILE_BALL), wire (MOBILE_WIRE) or link (MOBILE_LINK) along a unit ray
 *       before maxT, cut per cell (cellW: a cell's size per unit of ray length; wires and links at
 *       least about a cell wide, balls at least a cell across); n faces the eye (a ball's: its surface
 *       normal); kind MOBILE_NONE and t = maxT if nothing
 *   float mobileShadow(vec3 P, vec3 L, float lr, int skipArm, int skipEnd);
 *       the share of a round lamp (centre L, radius lr) the mobile hides from P, penumbrae and all;
 *       skipArm/skipEnd leave out one ball (the one P lies on), -1 for none
 */
export function mobileGlsl(sampler: string, origin: Vec3): string {
  return `
const int MOBILE_ARMS = ${MOBILE_MAX_ARMS};
const int MOBILE_NONE = 0;
const int MOBILE_BALL = 1;
const int MOBILE_WIRE = 2;
const int MOBILE_LINK = 3;
const vec3 MOBILE_ORIGIN = vec3(${glslFloat(origin[0])}, ${glslFloat(origin[1])}, ${glslFloat(origin[2])});

vec4 mobileTexel(int k, int i) {
  return texelFetch(${sampler}, ivec2(k * ${MOBILE_TEXELS} + i, 0), 0);
}

vec3 mobileAt(int k, int i) {
  return mobileTexel(k, i).xyz + MOBILE_ORIGIN;
}

// The ball at end e (0: end a, 1: end b) of arm k: xyz its centre, w its radius; look the scene's.
bool mobileBall(int k, int e, vec3 a, vec3 b, out vec4 ball, out int look) {
  vec4 g = mobileTexel(k, 4 + e);
  ball = vec4(e == 0 ? a : b, g.y);
  look = int(g.x - ${glslFloat(MOBILE_BALL_CODE)} + 0.5);
  return g.x > ${glslFloat(MOBILE_BALL_CODE - 0.5)};
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
};

// A round wire's normal where the ray passes at distance d of its axis (r: the drawn half width),
// the side toward the eye; off is the direction from the axis to the ray's nearest point.
vec3 mobileWireNormal(vec3 rd, vec3 off, float d, float r) {
  float s = clamp(d / max(r, 1.0e-6), 0.0, 1.0);
  vec3 side = length(off) > 1.0e-7 ? normalize(off) : vec3(0.0);
  return normalize(side * s - rd * sqrt(1.0 - s * s));
}

MobileHit mobileTrace(vec3 ro, vec3 rd, float cellW, float maxT, float wireR, float linkR) {
  MobileHit hit = MobileHit(maxT, MOBILE_NONE, -1, -1, vec3(0.0, 0.0, 1.0));
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
      hit = MobileHit(rt, MOBILE_LINK, k, -1, mobileWireNormal(rd, ro + rd * rt - mix(top, h, al), d, r));
    }
    // The arm: skipped where the ray passes clear of the ball round its loop.
    vec3 oh = h - ro;
    float th = dot(oh, rd);
    float bound = mobileTexel(k, 6).x + cellW * max(th, 0.0);
    if (th <= 0.0 || dot(oh, oh) - th * th > bound * bound || th - bound > hit.t) continue;
    for (int s = 0; s < 2; s++) {
      vec3 p0 = s == 0 ? a : h;
      vec3 p1 = s == 0 ? h : b;
      d = mobileRaySeg(ro, rd, p0, p1, rt, al);
      r = max(wireR, 0.5 * cellW * rt);
      if (rt > 0.0 && rt < hit.t && hardFill((d - r) / (cellW * rt), 0.6) > 0.5) {
        hit = MobileHit(rt, MOBILE_WIRE, k, s, mobileWireNormal(rd, ro + rd * rt - mix(p0, p1, al), d, r));
      }
    }
    for (int e = 0; e < 2; e++) {
      vec4 ball;
      int look;
      if (!mobileBall(k, e, a, b, ball, look)) continue;
      vec3 n;
      float tb = mobileBallRay(ro, rd, ball, cellW, n);
      if (tb > 0.0 && tb < hit.t) hit = MobileHit(tb, MOBILE_BALL, k, e, n);
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
    float bound = mobileTexel(k, 6).x + lr * s;
    vec3 off = P + pl * s - h;
    if (dot(off, off) > bound * bound) continue;
    lit *= 1.0 - mobileWireShade(P, L, a, h, 0.0012, lr);
    lit *= 1.0 - mobileWireShade(P, L, h, b, 0.0012, lr);
    for (int e = 0; e < 2; e++) {
      if (k == skipArm && e == skipEnd) continue;
      vec4 ball;
      int look;
      if (!mobileBall(k, e, a, b, ball, look)) continue;
      float t = dot(ball.xyz - P, pl) / pll;
      if (t <= 1.0e-4 || t >= 1.0) continue;
      // The lamp's footprint where the line to it passes the ball has radius lr * t: a ball smaller
      // than that only dims the light, by the share of the footprint it covers.
      float w = lr * t + 2.0e-4;
      float big = max(ball.w, w);
      float share = ball.w / big;
      lit *= 1.0 - share * share * softFill(length(P + pl * t - ball.xyz) - big, min(ball.w, w));
    }
  }
  return 1.0 - lit;
}
`;
}
