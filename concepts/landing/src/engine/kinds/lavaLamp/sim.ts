// The lava lamp's wax: the lava scene's parcel sim (src/scenes/lava/sim.ts) in three dimensions,
// one per lamp (KindCode.sim, run by src/engine/state.ts). Each lamp holds PARCELS parcels of wax:
// soft balls with a temperature, in glass units (shape.ts: gy 0 at the bottom of the liquid .. 1
// under the cap, x and z across from the glass's axis on the same scale). The GLSL (code.ts) draws
// their metaball surface, so parcels that touch read as one blob, a pair pulling apart draws a neck,
// and a neck that stretches too far snaps.
//
// The physics, per parcel, as the scene's:
//   heat     the coil on the bottom of the glass heats the wax resting on it; everywhere else the
//            liquid (warmer low down than under the cap, but below floating everywhere) slowly cools
//            it, small parcels faster; parcels in touch share heat; the cap cools what presses up
//            under it, so each blob turns round on its own
//   buoyancy warm wax (T above NEUTRAL) is lighter than the liquid and rises, cool wax sinks; wax
//            clings to the coil until it is well past floating, so it leaves with heat to spare
//   drag     a viscous liquid: velocities relax toward the liquid's own slow convection (in over
//            the coil, up the middle, out under the cap, down the sides); solid wax hardly moves
//   bonds    neighbours repel inside their rest distance and attract beyond it, up to a break
//            distance where the pull fades to nothing: a warm parcel tearing away from the heap
//            draws out a neck, then lets go; cold wax binds harder; bonded parcels damp their
//            relative motion (a blob moves as one) and share heat; warm and cool parcels slip past
//            one another and barely hold on
// So the heap on the coil warms, swells and sends up blobs one at a time; each cools against the
// cap and sinks, merges with the heap and warms again. What the scene's flat glass needed is gone:
// the parcels have a depth, the glass is round (its wall pushes along the radius), and the coil is a
// disc under the middle. A lamp is a warm pour, prewarmed WARM_STEPS coarse steps (75 s of lamp
// time) before it shows, seeded by its object's id.
//
// Its state block (KindDef.state: STATE_TEXELS × 1 texels): texel 0 (parcels, the risen share of
// the wax 0..1, 0, 0); parcel k at texel 1 + 2k (x, y, z, radius) and 2 + 2k (vx, vy, vz,
// temperature), glass units and seconds.
import { clamp, smoothstep } from "../../../sims/math.ts";
import type { InstanceSim, KindSim } from "../../types.ts";
import { innerRadius, PARCELS } from "./shape.ts";

/** A parcel's metaball reaches this many radii; a lone parcel's surface sits at its radius. */
export const REACH = 1.9;
/** The teardrop: how far a parcel's tail stretches per unit of speed (glass units/s). */
export const STRETCH = 7;

/** The live step (s of motion time); the warm-up's coarser steps and their count (75 s). */
const STEP = 1 / 60;
const WARM_STEP = 1 / 30;
const WARM_STEPS = 2251;
/** Settling a fresh heap before the warm-up (s). */
const SETTLE = 4;
/** A parcel's mean radius (glass units) and the spread of sizes either side (share). */
const R0 = 0.056;
const SIZE_SPREAD = 0.28;

/** Temperatures: 0 is the cold room; wax at NEUTRAL floats, warmer rises, cooler sinks. */
const NEUTRAL = 0.5;
/** Below SOLID_LO the wax is solid, above SOLID_HI it flows. */
const SOLID_LO = 0.1;
const SOLID_HI = 0.2;
/** The liquid's temperature: LIQ_TOP under the cap plus LIQ_BOTTOM · e^(−LIQ_FALL · gy), well
 * below NEUTRAL everywhere: only the coil lifts wax, and nothing hovers for ever. */
const LIQ_TOP = 0.22;
const LIQ_BOTTOM = 0.12;
const LIQ_FALL = 3;
/** Heat exchange with the liquid (1/s for a parcel of radius R0; small ones faster). */
const EXCHANGE = 1 / 30;
/** The coil: how close to it a parcel's underside must rest to touch it (glass units), the radius
 * of the disc it heats (its warmth falls off as a Gaussian of that width), its pull toward its
 * temperature (1/s) and that temperature at heat 0 and 1. Wax clings to it until RELEASE warm. */
const COIL_REACH = 0.035;
const COIL_HALF = 0.075;
const COIL_RATE = 0.18;
const COIL_T0 = 1.25;
const COIL_T1 = 0.15;
const RELEASE = 0.85;
/** The cap: wax pressed up under it (its top within CAP_REACH) cools toward CAP_T (1/s). */
const CAP_REACH = 0.06;
const CAP_RATE = 0.25;
const CAP_T = 0.12;

/** Buoyancy: acceleration per unit of temperature above NEUTRAL (glass units/s²). */
const BUOYANCY = 0.45;
/** Viscous drag toward the liquid's flow (1/s for a parcel of radius R0) and its multiple when solid. */
const DRAG = 1.8;
const SOLID_DRAG = 12;
/** The liquid's convection (glass units/s). */
const FLOW = 0.005;
/** Bonds, in shares of the two radii: rest and break distance; repulsion and cohesion peaks
 * (glass units/s²), cold wax's extra bond, relative-velocity damping (1/s) and heat sharing (1/s). */
const REST = 0.7;
const BREAK = 1.05;
const REPEL = 1;
const COHESION = 0.035;
const COLD_BOND = 2;
const VISCOSITY = 0.3;
const CONDUCT = 0.006;
/** Parcels this far apart in temperature (PASS_LO to PASS_HI) lose PASS of their repulsion and
 * viscosity (warm and cool wax slip past each other) and TEAR of their cohesion. */
const PASS = 0.85;
const TEAR = 0.6;
const PASS_LO = 0.08;
const PASS_HI = 0.3;
/** The glass pushing wax back (1/s²); how far a parcel may press into it (share of its radius). */
const WALL_PUSH = 40;
const WALL_GIVE = 0.15;
/** Wax this high (glass units) has left the heap: the risen share the lamp's light takes. */
const RISEN = [0.18, 0.34] as const;

/** Xorshift32 stream in [0, 1). */
function random32(seed: number): () => number {
  let s = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** The liquid's temperature at height gy. */
function liquidTemperature(gy: number): number {
  return LIQ_TOP + LIQ_BOTTOM * Math.exp(-LIQ_FALL * clamp(gy, 0, 1));
}

interface Parcel {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  /** Temperature: 0 the cold room, NEUTRAL floating, about 1 fresh off the coil. */
  T: number;
  // This step's accumulators.
  ax: number;
  ay: number;
  az: number;
  dT: number;
}

/** One lamp's wax. */
export class LavaWax implements InstanceSim {
  readonly wax: readonly Parcel[];

  constructor(seed: number) {
    const random = random32(seed);
    this.wax = Array.from({ length: PARCELS }, () => ({
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      r: R0 * (1 - SIZE_SPREAD + 2 * SIZE_SPREAD * random()),
      T: 0,
      ax: 0,
      ay: 0,
      az: 0,
      dT: 0,
    }));
    this.#heap(random);
    // A warm pour: the heap at the liquid's temperature, then the warm-up runs the coil until it
    // has sent up a stream of blobs one by one.
    for (const w of this.wax) w.T = liquidTemperature(w.y) + 0.04 * random();
  }

  warm(_i: number, options: Readonly<Record<string, number>>): void {
    this.#step(WARM_STEP, clamp(options["heat"] ?? 0.5, 0, 1), false);
  }

  step(options: Readonly<Record<string, number>>): void {
    this.#step(STEP, clamp(options["heat"] ?? 0.5, 0, 1), false);
  }

  write(block: Float32Array): void {
    let risen = 0;
    let all = 0;
    for (const [k, w] of this.wax.entries()) {
      const at = (1 + 2 * k) * 4;
      block[at] = w.x;
      block[at + 1] = w.y;
      block[at + 2] = w.z;
      block[at + 3] = w.r;
      block[at + 4] = w.vx;
      block[at + 5] = w.vy;
      block[at + 6] = w.vz;
      block[at + 7] = w.T;
      const mass = w.r * w.r * w.r;
      all += mass;
      risen += mass * smoothstep(RISEN[0], RISEN[1], w.y);
    }
    block[0] = PARCELS;
    block[1] = all > 0 ? risen / all : 0;
  }

  /** Cold wax packed on the bottom of the glass in layers, settled under its own weight. */
  #heap(random: () => number): void {
    const spacing = 1.55 * R0;
    let y = 0;
    let k = 0;
    let layer = 0;
    while (k < PARCELS) {
      const room = innerRadius(y + R0) - 0.02;
      const fits = Math.max(1, Math.floor(0.9 * ((2 * room) / spacing) ** 2));
      const n = Math.min(fits, PARCELS - k);
      for (let j = 0; j < n; j++, k++) {
        const w = this.wax[k];
        if (w === undefined) continue;
        const along = (room - spacing / 2) * Math.sqrt((j + 0.5) / n);
        const turn = j * 2.39996 + layer;
        w.x = along * Math.cos(turn) + 0.01 * (random() - 0.5);
        w.z = along * Math.sin(turn) + 0.01 * (random() - 0.5);
        w.y = y + w.r * 0.9;
      }
      y += 1.3 * R0;
      layer += 1;
    }
    // Let it slump as if it had cooled where it settled: solid drag off, no heat.
    for (let t = 0; t < SETTLE; t += STEP) this.#step(STEP, 0, true);
    for (const w of this.wax) {
      w.vx = 0;
      w.vy = 0;
      w.vz = 0;
    }
  }

  /** One step of `h` seconds at bulb `heat` 0..1; `settling` a fresh heap (no heat, no buoyancy). */
  #step(h: number, heat: number, settling: boolean): void {
    const wax = this.wax;
    const quick = 0.75 + 0.5 * heat;
    const coilT = COIL_T0 + COIL_T1 * heat;
    const lift = BUOYANCY * (0.85 + 0.3 * heat);
    const flow = FLOW * (0.6 + 0.8 * heat);

    for (const w of wax) {
      w.ax = 0;
      w.ay = 0;
      w.az = 0;
      w.dT = 0;
      const scale = R0 / Math.max(w.r, 0.25 * R0);
      const rho = Math.hypot(w.x, w.z);
      const ux = rho > 1e-9 ? w.x / rho : 0;
      const uz = rho > 1e-9 ? w.z / rho : 0;
      const onCoil = smoothstep(COIL_REACH, 0, w.y - w.r);
      // Heat: the liquid, the coil, the cap.
      if (!settling) {
        let dT = EXCHANGE * scale * (liquidTemperature(w.y) - w.T);
        dT += COIL_RATE * quick * onCoil * Math.exp(-((rho / COIL_HALF) ** 2)) * (coilT - w.T);
        dT += CAP_RATE * smoothstep(CAP_REACH, 0, 1 - w.y - w.r) * (CAP_T - w.T);
        w.dT = dT;
      }
      // Forces: buoyancy (on the coil, only past RELEASE), drag toward the liquid's convection.
      const solid = settling ? 0 : 1 - smoothstep(SOLID_LO, SOLID_HI, w.T);
      const drag = DRAG * Math.sqrt(scale) * (1 + SOLID_DRAG * solid);
      const R = innerRadius(w.y);
      const xi = Math.min(rho / R, 1);
      const yc = clamp(w.y, 0, 1);
      const rise = Math.sin(Math.PI * yc);
      const out = -0.5 * flow * Math.sin(Math.PI * xi) * Math.cos(Math.PI * yc);
      const up = flow * Math.cos(Math.PI * xi) * rise * rise;
      const T = settling ? 0 : w.T;
      const neutral = NEUTRAL + (RELEASE - NEUTRAL) * onCoil;
      w.ax += drag * (out * ux - w.vx);
      w.az += drag * (out * uz - w.vz);
      w.ay += drag * (up - w.vy) + lift * (T - neutral);
      // The glass: its round wall, the bottom and the cap's underside push back (the wall along
      // the radius and without friction: warm wax slides down the funnel of its foot to the coil).
      const over = rho - (R - (1 - WALL_GIVE) * w.r);
      if (over > 0) {
        w.ax -= WALL_PUSH * over * ux;
        w.az -= WALL_PUSH * over * uz;
      }
      const floor = (1 - WALL_GIVE) * w.r;
      if (w.y < floor) w.ay += WALL_PUSH * (floor - w.y);
      const ceiling = 1 - (1 - WALL_GIVE) * w.r;
      if (w.y > ceiling) w.ay -= WALL_PUSH * (w.y - ceiling);
    }

    for (const [i, a] of wax.entries()) {
      const ma = (a.r / R0) ** 2;
      for (let j = i + 1; j < wax.length; j++) {
        const b = wax[j];
        if (b === undefined) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const reach = BREAK * (a.r + b.r);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2) + 1e-6;
        const nx = dx / d;
        const ny = dy / d;
        const nz = dz / d;
        const rest = REST * (a.r + b.r);
        const mb = (b.r / R0) ** 2;
        const m = Math.min(ma, mb);
        const solid = settling ? 1 : 1 - smoothstep(SOLID_LO, SOLID_HI, Math.min(a.T, b.T));
        const bond = 1 + COLD_BOND * solid;
        const apart = smoothstep(PASS_LO, PASS_HI, Math.abs(a.T - b.T));
        const pass = 1 - PASS * apart;
        let f: number;
        if (d < rest) f = (-REPEL * pass * (rest - d)) / rest;
        else {
          const u = (d - rest) / (reach - rest);
          f = COHESION * bond * (1 - TEAR * apart) * 4 * u * (1 - u);
        }
        const near = 1 - d / reach;
        const vis = VISCOSITY * bond * pass * near * m;
        const fx = f * m * nx + vis * (b.vx - a.vx);
        const fy = f * m * ny + vis * (b.vy - a.vy);
        const fz = f * m * nz + vis * (b.vz - a.vz);
        a.ax += fx / ma;
        a.ay += fy / ma;
        a.az += fz / ma;
        b.ax -= fx / mb;
        b.ay -= fy / mb;
        b.az -= fz / mb;
        if (!settling) {
          const q = CONDUCT * near * m * (b.T - a.T);
          a.dT += q / ma;
          b.dT -= q / mb;
        }
      }
    }

    for (const w of wax) {
      w.vx += w.ax * h;
      w.vy += w.ay * h;
      w.vz += w.az * h;
      w.x += w.vx * h;
      w.y += w.vy * h;
      w.z += w.vz * h;
      w.T += w.dT * h;
      // Never through the glass, whatever the step.
      w.y = clamp(w.y, 0.4 * w.r, 1 - 0.4 * w.r);
      const lim = Math.max(0, innerRadius(w.y) - 0.6 * w.r);
      const rho = Math.hypot(w.x, w.z);
      if (rho > lim) {
        w.x *= lim / rho;
        w.z *= lim / rho;
      }
    }
  }
}

/** The kind's sim (KindCode.sim). */
export const lavaSim: KindSim = {
  step: STEP,
  warmSteps: WARM_STEPS,
  create: (seed) => new LavaWax(seed),
};
