// Falling leaves and petals as rigid plates (Andersen, Pesavento & Wang, "Unsteady aerodynamics of
// fluttering and tumbling plates", J. Fluid Mech. 541, 2005: the quasi-steady model with added mass,
// circulation lift, quadratic drag and a rotational damping torque). Light plates flutter, swinging
// from side to side and gliding up at the end of each swing; heavier ones tumble end over end. Each
// falls in its own vertical plane, which turns slowly, rocks about its chord and spins in its own
// plane as it goes, and the air carries it. Down, it eases flat, face up or face down, whichever is
// nearer. Autumn's and the garden's leaves fall on it.
//
// The scene owns everything round the flight: where a plate lets go and the random draws that seed
// it, the air at it (wind, gusts, swirls), the ground it lands on, what becomes of it there, and how it
// is packed for the shader. Positions, air and frames are in the plates' own axes, two horizontal and
// the height, (a, b, up), with a plane's azimuth turning a toward b; a scene maps its world onto them
// (autumn: x, z, y; garden: x, y, z).
//
//   new FlutterPlates(slots, rockAngle)  one plate a slot, rocking up to rockAngle (radians, ~0.3)
//                    about its chord in flight; per-slot state in Float64Arrays the scene seeds:
//     mass             mass per span in plate units (the dimensionless inertia): flutter below ~0.6, tumble above
//     chord            the aerodynamic chord, in the scene's length unit: the swing's size and the descent
//     pace             real seconds per model time unit: the swing's pace
//     psi, dpsi        the fall plane's azimuth (radians, a toward b) and its turn per second
//     th               the pitch in that plane (0 flat, face up)
//     u, v, w          the velocity along the chord and across it, and the pitch rate (model units)
//     sigma, dsigma    the plate's turn in its own plane, and its rate per second
//     roll, rollRate   the phase of its rock about the chord (rockAngle at most), and its rate per second
//     debt             model time owed (at most two steps)
//     touch, rest      the pitch it touched down at, wrapped into (-π, π], and the pitch it comes to rest at
//     start(i)         a plate let go: still, nothing owed (seed the rest in the scene's own order)
//     fly(i, dt, at, airA, airB, airUp, floor)
//                      fly dt real seconds through air moving (airA, airB, airUp) per second; `at` is its
//                      position (a, b, up), read and written. True once it reaches floor(a, b), checked
//                      after each step: it stops there, at[2] that height
//     touchDown(i)     note the pitch it came down at (touch)
//     settle(i, k)     ease the pitch flat: k 0 as it touched down .. 1 at rest, face up or down
//     orient(i, rock, out)  its frame into out (9): chord axis, span axis, the plate's normal (upward
//                      face up), each (a, b, up); rock 1 in flight, toward 0 as it settles
//
// Usage:
//   readonly #plates = new FlutterPlates(SLOTS, 0.3);
//   readonly #pos = new Float64Array(3);
//   const p = this.#plates;
//   p.mass[i] = lerp(0.2, 0.42, rand()); p.chord[i] = 0.4; p.pace[i] = 0.21; p.psi[i] = rand() * TAU; ...; p.start(i);
//   const pos = this.#pos;
//   pos[0] = x; pos[1] = z; pos[2] = y;                    // a world with y up
//   if (p.fly(i, dt, pos, windX, windZ, 0, this.#floor)) p.touchDown(i);
//   x = pos[0]; z = pos[1]; y = pos[2];
import { lerp } from "./math.ts";

// In units of the plate's chord, the air's density and gravity: C_T = 1.2, C_R = π, drag A = 1.4,
// B = 1.0, the added masses of a thin ellipse, and a weak damping torque (which lets light plates
// flutter widely and heavy ones tumble).
const PLATE_CT = 1.2;
const PLATE_CR = Math.PI;
const PLATE_A = 1.4;
const PLATE_B = 1.0;
const PLATE_MU = 0.02;
const PLATE_M11 = 0.02;
const PLATE_M22 = Math.PI / 4;
const PLATE_IA = Math.PI / 128;
/** Model time per substep (stable to ~0.06 with the midpoint rule). */
const PLATE_STEP = 0.03;
/** Most substeps one call takes, and the model time it may still owe afterwards. */
const MOST_STEPS = 64;
const MOST_OWED = 2 * PLATE_STEP;

/** Where a plate at (a, b) touches down: the height of what it lands on there. */
export type FlutterFloor = (a: number, b: number) => number;

/** A set of fluttering plates, one per slot, in typed arrays the scene seeds and reads. */
export class FlutterPlates {
  /** How far a plate rocks about its chord in flight (radians). */
  readonly rockAngle: number;
  readonly mass: Float64Array;
  readonly chord: Float64Array;
  readonly pace: Float64Array;
  readonly psi: Float64Array;
  readonly dpsi: Float64Array;
  readonly th: Float64Array;
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly w: Float64Array;
  readonly sigma: Float64Array;
  readonly dsigma: Float64Array;
  readonly roll: Float64Array;
  readonly rollRate: Float64Array;
  readonly debt: Float64Array;
  readonly touch: Float64Array;
  readonly rest: Float64Array;
  /** The rates #plate writes: du, dv, dw. */
  readonly #rates = new Float64Array(3);

  constructor(slots: number, rockAngle: number) {
    this.rockAngle = rockAngle;
    this.mass = new Float64Array(slots);
    this.chord = new Float64Array(slots);
    this.pace = new Float64Array(slots);
    this.psi = new Float64Array(slots);
    this.dpsi = new Float64Array(slots);
    this.th = new Float64Array(slots);
    this.u = new Float64Array(slots);
    this.v = new Float64Array(slots);
    this.w = new Float64Array(slots);
    this.sigma = new Float64Array(slots);
    this.dsigma = new Float64Array(slots);
    this.roll = new Float64Array(slots);
    this.rollRate = new Float64Array(slots);
    this.debt = new Float64Array(slots);
    this.touch = new Float64Array(slots);
    this.rest = new Float64Array(slots);
  }

  /** Plate i lets go: no velocity, no model time owed. Its shape, plane, pitch and spin are the scene's to seed. */
  start(i: number): void {
    this.u[i] = 0;
    this.v[i] = 0;
    this.w[i] = 0;
    this.debt[i] = 0;
  }

  /**
   * Fly plate i for dt real seconds: whole model steps by the midpoint rule, in its turning plane, the
   * air (airA, airB, airUp per second, held over the call) carrying it. `at` is its position (a, b, up),
   * read and written. Returns true when it came down on floor(a, b), checked after each step: it stops
   * there (at[2] = the floor). At most 64 steps a call; what is still owed is kept, up to two steps.
   */
  fly(
    i: number,
    dt: number,
    at: Float64Array,
    airA: number,
    airB: number,
    airUp: number,
    floor: FlutterFloor,
  ): boolean {
    const m = this.mass[i] ?? 0;
    const chord = this.chord[i] ?? 0;
    const pace = this.pace[i] ?? 0;
    const inertia = m / 12 + PLATE_IA;
    let u = this.u[i] ?? 0;
    let v = this.v[i] ?? 0;
    let w = this.w[i] ?? 0;
    let th = this.th[i] ?? 0;
    let a = at[0] ?? 0;
    let b = at[1] ?? 0;
    let up = at[2] ?? 0;
    let psi = this.psi[i] ?? 0;
    let debt = (this.debt[i] ?? 0) + dt / pace;
    const real = PLATE_STEP * pace;
    const dpsi = this.dpsi[i] ?? 0;
    const rates = this.#rates;
    const h = 0.5 * PLATE_STEP;
    let landed = false;
    let guard = 0;
    while (debt >= PLATE_STEP && guard++ < MOST_STEPS) {
      debt -= PLATE_STEP;
      // The midpoint rule.
      this.#plate(m, inertia, u, v, w, th);
      const uMid = u + h * (rates[0] ?? 0);
      const vMid = v + h * (rates[1] ?? 0);
      const wMid = w + h * (rates[2] ?? 0);
      const thMid = th + h * w;
      this.#plate(m, inertia, uMid, vMid, wMid, thMid);
      u += PLATE_STEP * (rates[0] ?? 0);
      v += PLATE_STEP * (rates[1] ?? 0);
      w += PLATE_STEP * (rates[2] ?? 0);
      th += PLATE_STEP * wMid;
      // Motion in the plane, in chords, from the midpoint state; then into the world.
      const ct = Math.cos(thMid);
      const st = Math.sin(thMid);
      const along = (uMid * ct - vMid * st) * PLATE_STEP * chord;
      const rise = (uMid * st + vMid * ct) * PLATE_STEP * chord;
      a += along * Math.cos(psi) + airA * real;
      b += along * Math.sin(psi) + airB * real;
      up += rise + airUp * real;
      psi += dpsi * real;
      const ground = floor(a, b);
      if (up <= ground) {
        landed = true;
        up = ground;
        break;
      }
    }
    this.debt[i] = Math.min(debt, MOST_OWED);
    this.sigma[i] = (this.sigma[i] ?? 0) + (this.dsigma[i] ?? 0) * dt;
    this.roll[i] = (this.roll[i] ?? 0) + (this.rollRate[i] ?? 0) * dt;
    this.u[i] = u;
    this.v[i] = v;
    this.w[i] = w;
    this.th[i] = th;
    this.psi[i] = psi;
    at[0] = a;
    at[1] = b;
    at[2] = up;
    return landed;
  }

  /** Plate i came down: its pitch wrapped into (-π, π], which side it settles from. */
  touchDown(i: number): void {
    const th = this.th[i] ?? 0;
    this.touch[i] = Math.atan2(Math.sin(th), Math.cos(th));
  }

  /** Ease plate i's pitch from where it touched down toward lying flat (face up or face down, whichever is nearer): k 0..1. */
  settle(i: number, k: number): void {
    const touch = this.touch[i] ?? 0;
    const rest = this.rest[i] ?? 0;
    const target = Math.abs(touch) > Math.PI / 2 ? Math.sign(touch) * Math.PI + rest : rest;
    this.th[i] = lerp(touch, target, k);
  }

  /**
   * Plate i's frame into `out` (9 numbers): its chord axis (0..2), its span axis (3..5) and its normal
   * (6..8, upward when face up), each (a, b, up). The plate pitches in its plane, rocks about its chord
   * (by `rock` of its swing: 1 in flight, falling to 0 as it settles), then spins about its normal.
   */
  orient(i: number, rock: number, out: Float64Array): void {
    const psi = this.psi[i] ?? 0;
    const th = this.th[i] ?? 0;
    const ce = Math.cos(psi);
    const se = Math.sin(psi);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const rho = this.rockAngle * Math.sin(this.roll[i] ?? 0) * rock;
    const cr = Math.cos(rho);
    const sr = Math.sin(rho);
    const sigma = this.sigma[i] ?? 0;
    const cs = Math.cos(sigma);
    const ss = Math.sin(sigma);
    // The chord axis, the level axis across the plane, the plate's normal in its own plane.
    const ta = ct * ce;
    const tb = ct * se;
    const tu = st;
    const ba = -se;
    const bb = ce;
    const na = -st * ce;
    const nb = -st * se;
    const nu = ct;
    // The span axis rocked toward the normal, the normal with it.
    const sa = ba * cr + na * sr;
    const sb = bb * cr + nb * sr;
    const su = nu * sr;
    out[0] = cs * ta + ss * sa;
    out[1] = cs * tb + ss * sb;
    out[2] = cs * tu + ss * su;
    out[3] = -ss * ta + cs * sa;
    out[4] = -ss * tb + cs * sb;
    out[5] = -ss * tu + cs * su;
    out[6] = na * cr - ba * sr;
    out[7] = nb * cr - bb * sr;
    out[8] = nu * cr;
  }

  /**
   * The quasi-steady plate, per unit span, in units of chord, air density and gravity: the rates of
   * the velocity along the chord (u) and across it (v) and of the pitch rate (w), at pitch th, into
   * #rates. Circulation Γ = -½ C_T uv/|V| + ½ C_R w lifts across the flow; drag ½ (A - B cos 2α) |V|
   * opposes it; the added masses couple u, v and w; a weak damping torque lets light plates swing wide.
   */
  #plate(m: number, inertia: number, u: number, v: number, w: number, th: number): void {
    const speed = Math.hypot(u, v) + 1e-9;
    const gamma = -0.5 * PLATE_CT * ((u * v) / speed) + 0.5 * PLATE_CR * w;
    const drag = 0.5 * (PLATE_A - (PLATE_B * (u * u - v * v)) / (speed * speed)) * speed;
    const torque = PLATE_MU * (1 + Math.abs(w)) * w;
    const out = this.#rates;
    out[0] = ((m + PLATE_M22) * v * w - gamma * v - m * Math.sin(th) - drag * u) / (m + PLATE_M11);
    out[1] = (-(m + PLATE_M11) * u * w + gamma * u - m * Math.cos(th) - drag * v) / (m + PLATE_M22);
    out[2] = ((PLATE_M11 - PLATE_M22) * u * v - torque) / inertia;
  }
}
