// The composer's falling things (README "Falling things", ADR 0062 "Falling things (W1)"): one pool
// of particles for every layer on screen, stepped on a fixed step and drawn as points into the
// composed sim's shared speck map (sims/specks.ts) under codes of the composer's own
// (Allocation.falling), which the program's speck pass colours (`fallingGlsl`): no layer loops over
// them per pixel. It runs on the CPU: the layers name their drip points and surfaces from their own
// sims each frame, and a landing reaches another layer's sim (a water layer's strike), both of
// which a pool on the GPU would read back every frame, while a few hundred particles step here in a
// fraction of a millisecond.
//
// Drips (FallingWriter.drip). Water gathers at each drip point a layer names, its lane holding a
// beat of its own fixed in time (BEAT_FALL + BEAT_GATHER × a jitter 0.7..1.3, on the pool's step
// count): a bead swells there through the beat's gathering and lets go at its end, falling under
// gravity and drag in the air. The World's rain and the wetness it leaves decide which beats let go
// (amount = max(rain, 0.4 × wet), the edges' rule, README "Weather in the world"), at the rate the
// shared edge drips had (rainDrips: a beat kept with chance (0.35 + 0.65 a) · P / (0.8 + mix(3.2,
// 0.6, a) · jitter)). A beat's moment never moves with the amount, so no drop runs backward as the
// world dries (the bug 4bf629be fixed in the shaders' drips): the pool only ever steps forward.
//
// The air. Every particle is drawn toward the air's velocity with its own time constant (a drop
// DROP_TAU: it falls at about 6 m/s at most and the wind barely bends it; a droplet thrown up by a
// splash the same): the wind along the gust field's heading at WIND_DRIFT m/s for wind 1, and the
// gust field's load where the particle is (composer/gust.ts gustAt, its 'now' and the passage's
// front included, ADR 0062 D4) at GUST_DRIFT m/s a unit, on the motion clock as the shader's.
//
// Landings (FallingWriter.surface: the surfaces every layer on names this frame). A falling drop
// meets the highest surface it crosses within the surface's footprint: on a plane or a ledge it
// splashes, a crown for CROWN_LIFE and SPLASH_DROPLETS droplets thrown up and out that fall back
// and vanish where they meet the surface again, and leaves a wet mark that dries over MARK_LIFE; on
// water it strikes the sim of the layer the surface names (FallingWater, through its affordances),
// with a crown. A drop that meets nothing falls on until it is FALL_FLOOR below the floor or
// MAX_AGE old.
//
// Drawing (`paint`), every frame, between the last two steps by the clock's alpha: each particle in
// the cell its rig-frame position projects to through the rig at rest (LevelCamera), lifted with the
// passage's eye and moved by its lens shift (Composition.falling.shift), slid with the pointer's
// parallax as its layer slides (LayerFalling.slide), at its depth in SPECK_DEPTH_STEP-ths of a metre
// (the speck pass hides it behind whatever stands nearer). A drop is a head DROP_CELLS wide where it
// is at least half a cell across, else one, with a streak behind it as long as it moves in
// STREAK_SECONDS; a bead a cell under its point (two cells wide at its fullest where it is big
// enough); a crown a cup of five cells; a droplet a cell; a wet mark a smear MARK_METRES wide, a
// cell nearer than its surface so its own surface does not hide it, fading through three codes.
//
// Determinism: everything is drawn from the pool's step count, the lanes and the seed (hash31),
// never from the frame: a seed plays the same at any frame rate. The fixed step runs on the fall
// clock's pace (README "Time and motion": dt × min(1, 2.5 × motion)), as the World's rain falls.
import { SPECK_DEPTH_STEP } from "./caps.ts";
import { gustAt, gustWind, newGustWind, type GustField, type GustWind } from "./gust.ts";
import { glslFloat } from "../shaders/glsl.ts";
import { FixedStep } from "../sims/clock.ts";
import { hash31 } from "../sims/math.ts";
import type { LevelCamera } from "../sims/camera.ts";
import type { FallKind, FallSurface, FallingWater } from "./types.ts";

/** Seconds a step of the pool; most steps one frame runs. */
export const FALL_STEP = 1 / 60;
const MAX_STEPS = 8;
/** Particles the pool holds at once: past it a new one is not born. */
export const FALL_CAPACITY = 512;
/** Surfaces and drip points a frame holds (a bank's top in short ledges): past them the rest are dropped. */
const MAX_SURFACES = 128;
const MAX_DRIPS = 256;

const GRAVITY = 9.81;
/** A drop's radius (m): a heavy drip, a bead as the edges' drips drew theirs. */
export const DROP_RADIUS = 0.004;
/** Seconds a drop and a droplet take to reach the air's velocity (a drop's terminal speed ≈ g · tau). */
const DROP_TAU = 0.6;
/** The air: m/s of drift at wind 1, and a gust's at a load of 1 (autumn's leaves' values). */
const WIND_DRIFT = 1.2;
const GUST_DRIFT = 2.2;
/** A drip point's beat: seconds a drop takes to fall away, and to gather (times a jitter 0.7..1.3). */
const BEAT_FALL = 0.8;
const BEAT_GATHER = 1.2;
/** Share of the gathering after which the bead shows. */
const BEAD_SHOWS = 0.35;
/** A splash: the crown's life (s), its droplets, their speed up and out (m/s), their size (of a drop's). */
const CROWN_LIFE = 0.07;
const SPLASH_DROPLETS = 3;
const SPLASH_UP: readonly [number, number] = [0.7, 1.3];
const SPLASH_OUT: readonly [number, number] = [0.25, 0.7];
const DROPLET_SIZE = 0.5;
/** A wet mark: seconds it takes to dry, and how wide it is (m). */
const MARK_LIFE = 3;
const MARK_METRES = 0.03;
/** Where a drop that met nothing ends: metres below the floor, or its age (s). */
const FALL_FLOOR = 2;
const MAX_AGE = 6;
/** The drawn streak: seconds of motion behind the head, at most this many cells. */
const STREAK_SECONDS = 0.012;
const STREAK_CELLS = 8;
/** A drop's head: cells across where it is at least half a cell across. */
const DROP_CELLS = 2;
/** A drop of water's mass (kg) per cubic metre of it. */
const WATER_DENSITY = 1000;

/** The pool's particles. */
const enum Kind {
  free = 0,
  drop = 1,
  droplet = 2,
  crown = 3,
  mark = 4,
}

/**
 * The falling things' codes in the speck map (1-based, from Allocation.falling's base), by kind:
 * the drop's head, its streak, a bead at a drip point, a splash's crown and droplets, and the wet
 * mark fresh, drying and nearly dry.
 */
export const FALL_CODE = {
  drop: 1,
  streak: 2,
  bead: 3,
  splash: 4,
  wet: 5,
  drying: 6,
  dry: 7,
} as const;

/** Codes each kind takes, in the order they are allocated (every kind's codes from 1). */
export const FALL_CODES: Readonly<Record<FallKind, number>> = { drop: 7 };

/** What the composed sim hands the pool for a frame's steps. */
export interface FallFrame {
  /** Scene-clock seconds since the previous frame, and the lab's motion amount. */
  readonly dt: number;
  readonly motion: number;
  readonly motionTime: number;
  /** The seed knob's value (0 where the preset lists none). */
  readonly seed: number;
  /** The World's rain falling now and how wet it has left the world (SimFrame.weather). */
  readonly rain: number;
  readonly wet: number;
  readonly gusts: GustField;
}

/** What the pool is drawn through, a frame. */
export interface FallView {
  readonly rig: LevelCamera;
  /** How far the passage lifts the eye (m), and its lens shift (screen heights, uv read lower). */
  readonly lift: number;
  readonly shift: number;
  readonly width: number;
  readonly height: number;
  /** The pointer's parallax (SimFrame.parallax), -1..1 each way. */
  readonly parallaxX: number;
  readonly parallaxY: number;
}

/** Where the pool plots: the speck map, a code from its allocated base (1-based codes). */
export interface FallPlot {
  plot(cx: number, cy: number, code: number, depth: number): void;
}

/** A drip point named this frame. */
interface Drip {
  key: number;
  x: number;
  y: number;
  z: number;
  slideX: number;
  slideY: number;
}

/** A surface named this frame, as the pool tests it. */
interface Surface {
  surface: FallSurface;
  /** The ledge's segment, unit along it and its length (for the strip test). */
  ux: number;
  uz: number;
  length: number;
}

/** Whether `host` (a layer's affordances) lends the falling things its water. */
function isFallingWater(host: object | undefined): host is FallingWater {
  return host !== undefined && typeof (host as Partial<FallingWater>).strike === "function";
}

/** The pool (see the header). */
export class FallingPool {
  readonly #clock = new FixedStep(FALL_STEP, MAX_STEPS);
  readonly #wind = newGustWind();
  readonly #kind = new Uint8Array(FALL_CAPACITY);
  readonly #x = new Float64Array(FALL_CAPACITY);
  readonly #y = new Float64Array(FALL_CAPACITY);
  readonly #z = new Float64Array(FALL_CAPACITY);
  readonly #px = new Float64Array(FALL_CAPACITY);
  readonly #py = new Float64Array(FALL_CAPACITY);
  readonly #pz = new Float64Array(FALL_CAPACITY);
  readonly #vx = new Float64Array(FALL_CAPACITY);
  readonly #vy = new Float64Array(FALL_CAPACITY);
  readonly #vz = new Float64Array(FALL_CAPACITY);
  readonly #age = new Float64Array(FALL_CAPACITY);
  readonly #radius = new Float64Array(FALL_CAPACITY);
  /** A droplet's surface height (it vanishes back there), a mark's surface height. */
  readonly #floor = new Float64Array(FALL_CAPACITY);
  readonly #slideX = new Float64Array(FALL_CAPACITY);
  readonly #slideY = new Float64Array(FALL_CAPACITY);
  /** Free slots, a stack; the slots above `#top` have never been used. */
  readonly #free = new Int32Array(FALL_CAPACITY);
  #freeCount = 0;
  #top = 0;
  #live = 0;
  /** Steps run since the pool began: its clock (FALL_STEP seconds each). */
  #steps = 0;
  /** Particles born since the pool began: each one's own stream of chance. */
  #born = 0;
  #seed = 0;
  #amount = 0;
  readonly #drips: Drip[] = [];
  #dripCount = 0;
  readonly #surfaces: Surface[] = [];
  #surfaceCount = 0;
  /** A water surface's layer's affordances (LayerFrame.host). */
  readonly #host: (layer: string) => object | undefined;

  constructor(host: (layer: string) => object | undefined) {
    this.#host = host;
  }

  /** Particles alive now. */
  get live(): number {
    return this.#live;
  }

  /** Steps run since the pool began. */
  get steps(): number {
    return this.#steps;
  }

  /** Forget this frame's drip points and surfaces: the layers name them afresh. */
  begin(): void {
    this.#dripCount = 0;
    this.#surfaceCount = 0;
  }

  /** A drip point this frame: `key` its lane among every layer's, (x, y, z) rig frame, metres. */
  drip(key: number, x: number, y: number, z: number, slideX: number, slideY: number): void {
    if (this.#dripCount >= MAX_DRIPS) return;
    const d = (this.#drips[this.#dripCount] ??= {
      key: 0,
      x: 0,
      y: 0,
      z: 0,
      slideX: 0,
      slideY: 0,
    });
    d.key = key;
    d.x = x;
    d.y = y;
    d.z = z;
    d.slideX = slideX;
    d.slideY = slideY;
    this.#dripCount++;
  }

  /** A surface this frame. */
  surface(surface: FallSurface): void {
    if (this.#surfaceCount >= MAX_SURFACES) return;
    const s = (this.#surfaces[this.#surfaceCount] ??= { surface, ux: 1, uz: 0, length: 0 });
    s.surface = surface;
    if (surface.kind === "ledge") {
      const dx = surface.to[0] - surface.from[0];
      const dz = surface.to[1] - surface.from[1];
      const length = Math.hypot(dx, dz);
      s.length = length;
      s.ux = length > 0 ? dx / length : 1;
      s.uz = length > 0 ? dz / length : 0;
    }
    this.#surfaceCount++;
  }

  /** Run the steps this frame owes (see the header). */
  step(frame: FallFrame): void {
    this.#seed = Math.round(frame.seed * 1000);
    this.#amount = Math.max(frame.rain, 0.4 * frame.wet);
    const pace = Math.min(1, 2.5 * frame.motion);
    const clock = this.#clock;
    const n = clock.advance(Math.max(0, frame.dt) * pace);
    if (n === 0) return;
    const g = frame.gusts;
    const wind = gustWind(this.#wind, g.wind, g.gusts, g.rate, g.nowAge, g.pass, g.shape);
    // The air's drift along the gusts' heading: the wind's own, then each particle's gust load.
    const drift = WIND_DRIFT * Math.abs(g.wind);
    // Motion seconds a fall second, to sample the gusts at each step's moment on the motion clock.
    const motionPerFall = pace > 0 ? frame.motion / pace : 0;
    for (let i = 0; i < n; i++) {
      const tm = frame.motionTime - clock.lag(i) * motionPerFall;
      this.#stepOnce(wind, drift, g.gusts > 0, tm);
    }
  }

  #stepOnce(wind: GustWind, drift: number, gusty: boolean, tm: number): void {
    const h = FALL_STEP;
    const t0 = this.#steps * h;
    this.#steps++;
    this.#release(t0, t0 + h);
    const kind = this.#kind;
    const x = this.#x;
    const y = this.#y;
    const z = this.#z;
    const vx = this.#vx;
    const vy = this.#vy;
    const vz = this.#vz;
    const top = this.#top;
    for (let i = 0; i < top; i++) {
      const k = kind[i] ?? Kind.free;
      if (k === Kind.free) continue;
      const age = (this.#age[i] ?? 0) + h;
      this.#age[i] = age;
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      const pz = z[i] ?? 0;
      this.#px[i] = px;
      this.#py[i] = py;
      this.#pz[i] = pz;
      if (k === Kind.crown) {
        if (age >= CROWN_LIFE) this.#kill(i);
        continue;
      }
      if (k === Kind.mark) {
        if (age >= MARK_LIFE) this.#kill(i);
        continue;
      }
      // Drawn toward the air (the wind and the gust where it is), and down.
      const load = gusty ? gustAt(wind, px, pz, tm, 0) : 0;
      const air = drift + GUST_DRIFT * load;
      const pull = h / DROP_TAU;
      const nvx = (vx[i] ?? 0) + (air * wind.dirX - (vx[i] ?? 0)) * pull;
      const nvz = (vz[i] ?? 0) + (air * wind.dirZ - (vz[i] ?? 0)) * pull;
      const nvy = (vy[i] ?? 0) - GRAVITY * h - (vy[i] ?? 0) * pull;
      vx[i] = nvx;
      vy[i] = nvy;
      vz[i] = nvz;
      const nx = px + nvx * h;
      const ny = py + nvy * h;
      const nz = pz + nvz * h;
      x[i] = nx;
      y[i] = ny;
      z[i] = nz;
      if (k === Kind.droplet) {
        if ((nvy < 0 && ny < (this.#floor[i] ?? 0)) || age >= MAX_AGE) this.#kill(i);
        continue;
      }
      if (nvy < 0 && this.#land(i, px, py, pz, nx, ny, nz)) continue;
      if (ny < -FALL_FLOOR || age >= MAX_AGE || nz < 0.05) this.#kill(i);
    }
  }

  /**
   * The drip points whose beat lets a drop go within [t0, t1) of the pool's clock: beat n of a lane
   * of period P and phase f lets go at (n + f) · P + gather, kept as the amount says.
   */
  #release(t0: number, t1: number): void {
    const a = this.#amount;
    if (a <= 0) return;
    for (let k = 0; k < this.#dripCount; k++) {
      const d = this.#drips[k];
      if (d === undefined) continue;
      const beat = this.#beat(d.key);
      const n = Math.floor((t1 - beat.gather) / beat.period - beat.phase);
      const at = (n + beat.phase) * beat.period + beat.gather;
      if (at < t0 || at >= t1) continue;
      if (hash31(d.key, n, this.#seed + 5) > this.#keep(beat.jitter, beat.period)) continue;
      this.#spawn(Kind.drop, d.x, d.y, d.z, 0, 0, 0, DROP_RADIUS, d.slideX, d.slideY);
    }
  }

  readonly #beatOut = { period: 1, phase: 0, gather: 1, jitter: 1 };

  /** A lane's beat: its period, its phase, the share of it spent gathering, and its jitter. */
  #beat(key: number): { period: number; phase: number; gather: number; jitter: number } {
    const b = this.#beatOut;
    const jitter = 0.7 + 0.6 * hash31(key, 13, this.#seed);
    b.jitter = jitter;
    b.gather = BEAT_GATHER * jitter;
    b.period = BEAT_FALL + b.gather;
    b.phase = hash31(key, 7, this.#seed);
    return b;
  }

  /** The chance a beat of this lane lets go at the amount now: the edges' rate (see the header). */
  #keep(jitter: number, period: number): number {
    const a = Math.min(1, this.#amount);
    return ((0.35 + 0.65 * a) * period) / (BEAT_FALL + (3.2 + (0.6 - 3.2) * a) * jitter);
  }

  /** Whether particle i, moving from p to n this step, met a surface: it lands there. */
  #land(
    i: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): boolean {
    let best: Surface | undefined;
    let bestY = -Infinity;
    for (let k = 0; k < this.#surfaceCount; k++) {
      const s = this.#surfaces[k];
      if (s === undefined) continue;
      const sy = s.surface.y;
      if (!(py >= sy && ny < sy) || sy <= bestY) continue;
      const u = (py - sy) / (py - ny);
      const cx = px + (nx - px) * u;
      const cz = pz + (nz - pz) * u;
      if (!this.#within(s, cx, cz)) continue;
      best = s;
      bestY = sy;
    }
    if (best === undefined) return false;
    const u = (py - bestY) / (py - ny);
    const cx = px + (nx - px) * u;
    const cz = pz + (nz - pz) * u;
    const speed = -(this.#vy[i] ?? 0);
    const radius = this.#radius[i] ?? DROP_RADIUS;
    const slideX = this.#slideX[i] ?? 0;
    const slideY = this.#slideY[i] ?? 0;
    const serial = this.#born;
    this.#kill(i);
    const surface = best.surface;
    if (surface.kind === "water") {
      const host = this.#host(surface.strikes);
      if (isFallingWater(host))
        host.strike(cx, cz, (4 / 3) * Math.PI * radius ** 3 * WATER_DENSITY, speed);
    } else {
      this.#spawn(Kind.mark, cx, bestY, cz, 0, 0, 0, radius, slideX, slideY);
      for (let k = 0; k < SPLASH_DROPLETS; k++) {
        const up = SPLASH_UP[0] + (SPLASH_UP[1] - SPLASH_UP[0]) * hash31(serial, k, this.#seed + 1);
        const out =
          SPLASH_OUT[0] + (SPLASH_OUT[1] - SPLASH_OUT[0]) * hash31(serial, k, this.#seed + 2);
        const side = (k % 2 === 0 ? -1 : 1) * out;
        const across = 0.3 * out * (hash31(serial, k, this.#seed + 3) - 0.5);
        const j = this.#spawn(
          Kind.droplet,
          cx,
          bestY,
          cz,
          side,
          up * Math.min(1.4, Math.sqrt(speed / 3)),
          across,
          radius * DROPLET_SIZE,
          slideX,
          slideY,
        );
        if (j >= 0) this.#floor[j] = bestY;
      }
    }
    this.#spawn(Kind.crown, cx, bestY, cz, 0, 0, 0, radius, slideX, slideY);
    return true;
  }

  /** Whether the floor point (x, z) lies on surface s's footprint. */
  #within(s: Surface, x: number, z: number): boolean {
    const surface = s.surface;
    if (surface.kind !== "ledge") {
      const { x: xs, z: zs } = surface;
      return (
        (xs === undefined || (x >= xs[0] && x <= xs[1])) &&
        (zs === undefined || (z >= zs[0] && z <= zs[1]))
      );
    }
    const rx = x - surface.from[0];
    const rz = z - surface.from[1];
    const along = rx * s.ux + rz * s.uz;
    const across = rx * s.uz - rz * s.ux;
    return along >= 0 && along <= s.length && Math.abs(across) <= 0.5 * surface.depth;
  }

  #spawn(
    k: Kind,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    radius: number,
    slideX: number,
    slideY: number,
  ): number {
    let i: number;
    if (this.#freeCount > 0) i = this.#free[--this.#freeCount] ?? 0;
    else if (this.#top < FALL_CAPACITY) i = this.#top++;
    else return -1;
    this.#kind[i] = k;
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = z;
    this.#px[i] = x;
    this.#py[i] = y;
    this.#pz[i] = z;
    this.#vx[i] = vx;
    this.#vy[i] = vy;
    this.#vz[i] = vz;
    this.#age[i] = 0;
    this.#radius[i] = radius;
    this.#floor[i] = y;
    this.#slideX[i] = slideX;
    this.#slideY[i] = slideY;
    this.#born++;
    this.#live++;
    return i;
  }

  #kill(i: number): void {
    if (this.#kind[i] === Kind.free) return;
    this.#kind[i] = Kind.free;
    this.#free[this.#freeCount++] = i;
    this.#live--;
  }

  /** Every particle and bead into the speck map, between the last two steps (see the header). */
  paint(plot: FallPlot, view: FallView): void {
    const alpha = this.#clock.alpha;
    const rig = view.rig;
    const H = view.height;
    const eye = rig.eye + view.lift;
    const half = 0.5 * view.width;
    const cellX = (x: number, z: number, slide: number): number =>
      ((rig.focal * x) / z + slide * view.parallaxX) * H + half;
    const cellY = (y: number, z: number, slide: number): number =>
      (rig.horizon + (rig.focal * (y - eye)) / z - view.shift + slide * view.parallaxY) * H;
    const depthOf = (z: number): number => Math.min(255, Math.floor(z * SPECK_DEPTH_STEP));
    const top = this.#top;
    for (let i = 0; i < top; i++) {
      const k = this.#kind[i] ?? Kind.free;
      if (k === Kind.free) continue;
      const x0 = this.#px[i] ?? 0;
      const y0 = this.#py[i] ?? 0;
      const z0 = this.#pz[i] ?? 0;
      const x = x0 + ((this.#x[i] ?? 0) - x0) * alpha;
      const y = y0 + ((this.#y[i] ?? 0) - y0) * alpha;
      const z = z0 + ((this.#z[i] ?? 0) - z0) * alpha;
      if (z < 0.05) continue;
      const sx = this.#slideX[i] ?? 0;
      const sy = this.#slideY[i] ?? 0;
      const cx = cellX(x, z, sx);
      const cy = cellY(y, z, sy);
      const ix = Math.floor(cx);
      const iy = Math.floor(cy);
      const depth = depthOf(z);
      const scale = (rig.focal / z) * H;
      const across = (this.#radius[i] ?? 0) * 2 * scale;
      if (k === Kind.drop) {
        // The streak first, back along the way it moves on the screen; then the head over it.
        const vxs = (this.#vx[i] ?? 0) * scale;
        const vys = (this.#vy[i] ?? 0) * scale;
        const len = Math.min(STREAK_CELLS, Math.hypot(vxs, vys) * STREAK_SECONDS);
        const steps = Math.floor(len);
        const norm = Math.hypot(vxs, vys) || 1;
        for (let s = 1; s <= steps; s++)
          plot.plot(
            Math.floor(cx - (vxs / norm) * s),
            Math.floor(cy - (vys / norm) * s),
            FALL_CODE.streak,
            depth,
          );
        plot.plot(ix, iy, FALL_CODE.drop, depth);
        if (across >= 0.5 && DROP_CELLS > 1) plot.plot(ix + 1, iy, FALL_CODE.drop, depth);
      } else if (k === Kind.droplet) {
        plot.plot(ix, iy, FALL_CODE.splash, depth);
      } else if (k === Kind.crown) {
        plot.plot(ix - 1, iy, FALL_CODE.splash, depth);
        plot.plot(ix, iy, FALL_CODE.splash, depth);
        plot.plot(ix + 1, iy, FALL_CODE.splash, depth);
        plot.plot(ix - 1, iy + 1, FALL_CODE.splash, depth);
        plot.plot(ix + 1, iy + 1, FALL_CODE.splash, depth);
      } else {
        const share = (this.#age[i] ?? 0) / MARK_LIFE;
        const code = share < 0.34 ? FALL_CODE.wet : share < 0.67 ? FALL_CODE.drying : FALL_CODE.dry;
        const w = Math.max(2, Math.round(MARK_METRES * scale));
        const nearer = Math.max(0, depth - 1);
        for (let s = 0; s < w; s++) plot.plot(ix - (w >> 1) + s, iy, code, nearer);
      }
    }
    this.#paintBeads(plot, cellX, cellY, depthOf, rig, H);
  }

  /** The beads swelling at the drip points whose beat will let go (see the header). */
  #paintBeads(
    plot: FallPlot,
    cellX: (x: number, z: number, slide: number) => number,
    cellY: (y: number, z: number, slide: number) => number,
    depthOf: (z: number) => number,
    rig: LevelCamera,
    H: number,
  ): void {
    if (this.#amount <= 0) return;
    const t = (this.#steps + this.#clock.alpha) * FALL_STEP;
    for (let k = 0; k < this.#dripCount; k++) {
      const d = this.#drips[k];
      if (d === undefined || d.z < 0.05) continue;
      const beat = this.#beat(d.key);
      const ph = t / beat.period - beat.phase;
      const n = Math.floor(ph);
      const into = (ph - n) * beat.period;
      if (into >= beat.gather) continue;
      const grown = into / beat.gather;
      if (grown < BEAD_SHOWS) continue;
      if (hash31(d.key, n, this.#seed + 5) > this.#keep(beat.jitter, beat.period)) continue;
      const ix = Math.floor(cellX(d.x, d.z, d.slideX));
      const iy = Math.floor(cellY(d.y, d.z, d.slideY)) - 1;
      const depth = depthOf(d.z);
      plot.plot(ix, iy, FALL_CODE.bead, depth);
      const across = DROP_RADIUS * 2 * grown * (rig.focal / d.z) * H;
      if (across >= 0.5 && grown > 0.8) plot.plot(ix + 1, iy, FALL_CODE.bead, depth);
    }
  }
}

/**
 * The falling things' colours in the program (README "Falling things"): `vec3 fallingSpeck(int code,
 * vec3 under, Ctx x)` for the kinds on (FALL_CODES' order, each kind's codes from its base), which the
 * composer's speck pass calls for a code of the composer's range (glsl.ts). A drop and its splash
 * shine with the light the backdrop gives the drops (x.air.drop: each refracts the bright sky), the
 * streak and the bead over what lies behind them; a wet mark darkens what it lies on and mirrors the
 * bright sky over it (x.air.deck) at the grazing angle a surface below the eye is seen at, a sheen
 * that reads on dark ground, less as it dries.
 */
export function fallingGlsl(kinds: readonly FallKind[]): string {
  const drops = kinds.includes("drop");
  return `
// ---- the falling things (composer/falling.ts) ----
vec3 fallingSpeck(int code, vec3 under, Ctx x) {
${
  drops
    ? `  vec3 drop = max(x.air.drop, vec3(0.08));
  if (code == ${FALL_CODE.drop}) return drop * 1.1;
  if (code == ${FALL_CODE.streak}) return mix(under, drop, 0.7);
  if (code == ${FALL_CODE.bead}) return mix(under, drop * 1.05, 0.85);
  if (code == ${FALL_CODE.splash}) return drop * 1.2;
  float wet = code == ${FALL_CODE.wet} ? 1.0 : (code == ${FALL_CODE.drying} ? 0.66 : 0.33);
  return mix(under, under * ${glslFloat(0.6)} + x.air.deck * ${glslFloat(0.3)}, wet);`
    : "  return under;"
}
}
`;
}
