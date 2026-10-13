// Position-based Verlet dynamics for threads, chains and nets: kelp swaying in the surge (chains
// pinned to the sea floor, buoyant), a dewy orb web plucked by the pointer (radii and a capture
// spiral under tension, ringing out of plane), bamboo culms bending in the wind.
//
// Points live in flat Float32Arrays (x, y, z interleaved): position, previous position and inverse
// mass (0 = pinned). Each substep integrates position Verlet (the velocity is the last move,
// x - x_prev), then projects the distance constraints Gauss–Seidel style (Müller, Heidelberger,
// Hennix, Ratcliff, "Position Based Dynamics", 2007), alternating direction every iteration so no
// end of a chain is favoured. A constraint's stiffness is the share of its error removed per
// substep, whatever the iteration count. Bending is a skip-one distance constraint (i to i + 2): the
// cheap way to give a chain a spine. Stiffness and pre-tension (restScale < 1) together set how fast
// a thread rings: tune them against the flicker metric, since fast ringing reads as shimmer.
//
// Time: `step(dt)` runs whole fixed substeps (default 1/120 s) and carries the remainder, so the
// motion is the same at 10 fps and at 144 fps, and dt = 0.1 s is just twelve small, stable steps.
// `PointTexture` blends the last two substeps by that remainder, so motion stays smooth when a frame
// falls between substeps.
//
// Units are the scene's. The convention: view heights with y up (x in 0..aspect, y in 0..1) and z
// toward the viewer, so a pointer at uv (u, v) is at (u · aspect, v).
//
// Drag toward a current (kelp in the surge): damping c plus a force c · u(x, t) on a unit mass gives
// dv/dt = c (u - v). The force callback reads `system.time` for the substep's clock.
//
// Cost: per substep O(points + iterations × constraints), no allocation. A 24-spoke, 14-turn web
// (361 points, 695 constraints) at 4 iterations and dt = 0.1 s is 12 substeps ≈ 33k projections,
// well under a millisecond in V8 (estimate).
//
// Usage:
//   const sys = new VerletSystem();
//   const web = sys.addWeb({ center: [0.9, 0.55, 0], radius: 0.42, spokes: 24, turns: 14,
//                            restScale: 0.97, spiralStiffness: 0.3, irregularity: 0.5, seed });
//   const pack = new PointTexture(gl, { points: sys.count, velocity: true, origin: [0.9, 0.5, 0] });
//   const opts: VerletStepOptions = { gravity: [0, -0.05, 0], damping: 0.8, iterations: 4 };
//   for (let i = 0; i < 20; i++) sys.step(0.1, opts); // prewarm: let the tension settle
//   // each frame (keep `opts`; do not rebuild it):
//   sys.step(frame.dt * frame.motion, opts);
//   if (frame.pointer.pressed) sys.impulseXY(frame.pointer.x * frame.aspect, frame.pointer.y, 0.06, 0, 0, 0.4);
//   pack.upload(sys);
//   return [pack.texture];
//   // GLSL, two texels per point with velocity (W = pack.width, origin added back):
//   //   vec4 webTexel(int k) { return texelFetch(uSim0, ivec2(k % W, k / W), 0); }
//   //   vec3 p = webTexel(2 * i).xyz + vec3(0.9, 0.5, 0.0);  vec3 v = webTexel(2 * i + 1).xyz;
import { DataTexture } from "./texture.ts";

const TAU = Math.PI * 2;

export type Vec3 = readonly [number, number, number];

/**
 * An extra force on point `index` at (x, y, z): write it into `out` (zeroed before each call). It is
 * divided by the point's mass (at the default inverse mass 1, force = acceleration). Called once
 * per free point per substep.
 */
export type VerletForce = (index: number, x: number, y: number, z: number, out: Float32Array) => void;

export interface VerletStepOptions {
  /** Acceleration on every free point, units per second². */
  gravity: Vec3;
  /** Share of velocity lost per second, as a rate: c makes speed fall to 1/e in 1/c seconds. */
  damping: number;
  /** Constraint passes per substep; more converge better on long chains (2–8). */
  iterations: number;
  force?: VerletForce;
}

export interface VerletOptions {
  /** Fixed internal time step, seconds. Default 1/120. */
  substep?: number;
  /**
   * Most substeps one `step` runs; a longer dt is cut short (the sim slows rather than exploding or
   * stalling). Default 16, which covers the renderer's 0.1 s clamp at the default substep.
   */
  maxSubsteps?: number;
  /** Points and constraints to reserve up front (the arrays otherwise grow while building). */
  points?: number;
  constraints?: number;
}

/** What a builder added: points first..first + points - 1, constraints likewise. */
export interface VerletRange {
  first: number;
  points: number;
  firstConstraint: number;
  constraints: number;
}

export interface ChainOptions {
  /** Default 1. */
  invMass?: number;
  /** Segment stiffness 0..1. Default 1. */
  stiffness?: number;
  /** Bending stiffness 0..1 (skip-one constraints); 0 adds none. Default 0. */
  bend?: number;
  /** Rest length over built length: < 1 pre-tensions, > 1 leaves slack. Default 1. */
  restScale?: number;
  pinFirst?: boolean;
  pinLast?: boolean;
}

export interface NetOptions {
  /** Default 1. */
  invMass?: number;
  /** Default 1. */
  stiffness?: number;
  /** Rest length over built length. Default 1. */
  restScale?: number;
  /** Indices into `points` to pin. */
  pinned?: readonly number[];
}

export interface WebOptions {
  /** The hub; the web lies in the plane z = center[2] and vibrates out of it. */
  center: Vec3;
  /** Hub to the anchors the radii are tied to (pinned). */
  radius: number;
  /** Radii, at least 3. */
  spokes: number;
  /** Turns of the capture spiral, at least 1. */
  turns: number;
  /** Where the spiral starts, as a share of the radius (the open zone around the hub). Default 0.12. */
  hub?: number;
  /** Where the spiral ends, as a share of the radius. Default 0.85. */
  rim?: number;
  /** Default 1. */
  invMass?: number;
  /** Rest length over built length for every thread: < 1 pulls the web taut. Default 1. */
  restScale?: number;
  /** Radii stiffness 0..1. Default 1. */
  spokeStiffness?: number;
  /** Capture-spiral stiffness 0..1 (the stretchy silk). Default 0.6. */
  spiralStiffness?: number;
  /** 0..1: uneven radii angles, spiral spacing and anchor distances, as a spider spins. Default 0. */
  irregularity?: number;
  /** Seeds the irregularity. Default 1. */
  seed?: number;
}

/**
 * An orb web: the hub, then the spiral crossing on spoke s at turn k at `spiral + s * turns + k`
 * (radius growing with k + s / spokes), then the pinned anchor of spoke s at `anchors + s`. The
 * constraints are the radii (hub to anchor through the crossings, spoke by spoke), then the capture
 * spiral from `spiralConstraint`, in order from the hub outward.
 */
export interface WebLayout extends VerletRange {
  hub: number;
  spiral: number;
  anchors: number;
  spokes: number;
  turns: number;
  spiralConstraint: number;
}

export interface PointTextureOptions {
  /** Points the texture holds; a system's points beyond this are left out, missing ones read as 0. */
  points: number;
  /** Two texels per point, position then velocity. Default false: position only. */
  velocity?: boolean;
  /**
   * Texels per row, a multiple of the texels per point. Default: one row (N×1) up to 2048 texels
   * (the smallest MAX_TEXTURE_SIZE WebGL2 allows), else rows of 2048.
   */
  width?: number;
  /**
   * Subtracted from every position before packing; add it back in the shader. Half floats are
   * finest near zero (about 1/2048 of the value), so put it at the middle of the scene. Default 0.
   */
  origin?: Vec3;
}

export class VerletError extends Error {}

/** Widest default row of a PointTexture: WebGL2's guaranteed MAX_TEXTURE_SIZE, a multiple of 2. */
const MAX_ROW = 2048;
const GROWTH_FLOOR = 16;

function growF32(array: Float32Array, length: number): Float32Array {
  const next = new Float32Array(length);
  next.set(array);
  return next;
}

function growU32(array: Uint32Array, length: number): Uint32Array {
  const next = new Uint32Array(length);
  next.set(array);
  return next;
}

function growU8(array: Uint8Array, length: number): Uint8Array {
  const next = new Uint8Array(length);
  next.set(array);
  return next;
}

/** A deterministic value in [-1, 1) for (seed, n): two integer mixing rounds (multiply, xorshift). */
function jitter(seed: number, n: number): number {
  let x = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(n + 0x632be5ab, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

export class VerletSystem {
  readonly #substep: number;
  readonly #maxSubsteps: number;
  #count = 0;
  #constraintCount = 0;
  #pos: Float32Array;
  #prev: Float32Array;
  /** Where a pinned point glides to over the next substeps (see `move`). */
  #target: Float32Array;
  #invMass: Float32Array;
  /** The inverse mass `unpin` restores. */
  #freeMass: Float32Array;
  #moving: Uint8Array;
  #a: Uint32Array;
  #b: Uint32Array;
  #rest: Float32Array;
  #stiffness: Float32Array;
  /** Per-iteration stiffness for `#kIterations` passes; 0 marks it stale. */
  #k: Float32Array;
  #kIterations = 0;
  /** Time not yet simulated, below one substep. */
  #carry = 0;
  #time = 0;
  readonly #force = new Float32Array(3);
  /** Bumped on every change, so uploads can be skipped while nothing moves. */
  version = 0;

  constructor(options: VerletOptions = {}) {
    const substep = options.substep ?? 1 / 120;
    if (!(substep > 0)) throw new VerletError(`substep must be positive, got ${substep}`);
    this.#substep = substep;
    this.#maxSubsteps = Math.max(1, Math.floor(options.maxSubsteps ?? 16));
    const points = Math.max(GROWTH_FLOOR, Math.ceil(options.points ?? 0));
    const constraints = Math.max(GROWTH_FLOOR, Math.ceil(options.constraints ?? 0));
    this.#pos = new Float32Array(points * 3);
    this.#prev = new Float32Array(points * 3);
    this.#target = new Float32Array(points * 3);
    this.#invMass = new Float32Array(points);
    this.#freeMass = new Float32Array(points);
    this.#moving = new Uint8Array(points);
    this.#a = new Uint32Array(constraints);
    this.#b = new Uint32Array(constraints);
    this.#rest = new Float32Array(constraints);
    this.#stiffness = new Float32Array(constraints);
    this.#k = new Float32Array(constraints);
  }

  get count(): number {
    return this.#count;
  }

  get constraintCount(): number {
    return this.#constraintCount;
  }

  /**
   * The live arrays: x, y, z of point i at 3i (positions, previous positions), one value per point
   * (inverse mass) or per constraint (endpoints, rest length). Only the first `count` (or
   * `constraintCount`) records are meaningful, and building may replace the arrays: read them again
   * after adding points.
   */
  get positions(): Float32Array {
    return this.#pos;
  }

  get previous(): Float32Array {
    return this.#prev;
  }

  get inverseMass(): Float32Array {
    return this.#invMass;
  }

  get constraintA(): Uint32Array {
    return this.#a;
  }

  get constraintB(): Uint32Array {
    return this.#b;
  }

  get restLength(): Float32Array {
    return this.#rest;
  }

  /** Simulated seconds, advanced substep by substep (the clock a force callback should read). */
  get time(): number {
    return this.#time;
  }

  get substep(): number {
    return this.#substep;
  }

  /** How far time has run past the last substep, 0..1 of a substep: the render blend. */
  get blend(): number {
    return this.#carry / this.#substep;
  }

  // ---- building -------------------------------------------------------------------------------

  /** Add a point at rest; returns its index. */
  addPoint(x: number, y: number, z: number, invMass = 1): number {
    const i = this.#count;
    this.#reservePoints(i + 1);
    this.#putAtRest(i, x, y, z);
    const mass = invMass > 0 ? invMass : 0;
    this.#invMass[i] = mass;
    this.#freeMass[i] = mass > 0 ? mass : 1;
    this.#moving[i] = 0;
    this.#count = i + 1;
    this.version++;
    return i;
  }

  /** Tie points a and b; the rest length defaults to their distance now. Returns its index. */
  addConstraint(a: number, b: number, stiffness = 1, rest = this.distance(a, b)): number {
    this.#check(a);
    this.#check(b);
    const c = this.#constraintCount;
    this.#reserveConstraints(c + 1);
    this.#a[c] = a;
    this.#b[c] = b;
    this.#rest[c] = Math.max(0, rest);
    this.#stiffness[c] = Math.min(1, Math.max(0, stiffness));
    this.#constraintCount = c + 1;
    this.#kIterations = 0;
    this.version++;
    return c;
  }

  /** Retune a constraint (a tension or stiffness knob) without rebuilding. */
  setConstraint(c: number, rest: number, stiffness: number): void {
    if (!(Number.isInteger(c) && c >= 0 && c < this.#constraintCount)) throw new VerletError(`no constraint ${c}`);
    this.#rest[c] = Math.max(0, rest);
    this.#stiffness[c] = Math.min(1, Math.max(0, stiffness));
    this.#kIterations = 0;
  }

  /**
   * A chain of `segments` equal links from `from` to `to` (segments + 1 points, in order), with
   * optional skip-one bending constraints.
   */
  addChain(from: Vec3, to: Vec3, segments: number, options: ChainOptions = {}): VerletRange {
    const n = Math.max(1, Math.round(segments));
    const bend = Math.min(1, Math.max(0, options.bend ?? 0));
    const first = this.#count;
    const firstConstraint = this.#constraintCount;
    this.#reservePoints(first + n + 1);
    this.#reserveConstraints(firstConstraint + n + (bend > 0 ? n - 1 : 0));
    const invMass = options.invMass ?? 1;
    for (let s = 0; s <= n; s++) {
      const f = s / n;
      this.addPoint(from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f, invMass);
    }
    const link = (Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / n) * (options.restScale ?? 1);
    const stiffness = options.stiffness ?? 1;
    for (let s = 0; s < n; s++) {
      this.addConstraint(first + s, first + s + 1, stiffness, link);
      if (bend > 0 && s > 0) this.addConstraint(first + s - 1, first + s + 1, bend, 2 * link);
    }
    if (options.pinFirst === true) this.pin(first);
    if (options.pinLast === true) this.pin(first + n);
    return { first, points: n + 1, firstConstraint, constraints: this.#constraintCount - firstConstraint };
  }

  /** Any net: `points` added in order, `edges` as index pairs into `points`. */
  addNet(points: readonly Vec3[], edges: readonly (readonly [number, number])[], options: NetOptions = {}): VerletRange {
    const first = this.#count;
    const firstConstraint = this.#constraintCount;
    for (const [a, b] of edges) {
      if (!(a >= 0 && a < points.length && b >= 0 && b < points.length)) throw new VerletError(`net edge ${a}–${b} is outside its ${points.length} points`);
    }
    this.#reservePoints(first + points.length);
    this.#reserveConstraints(firstConstraint + edges.length);
    const invMass = options.invMass ?? 1;
    for (const [x, y, z] of points) this.addPoint(x, y, z, invMass);
    const stiffness = options.stiffness ?? 1;
    const restScale = options.restScale ?? 1;
    for (const [a, b] of edges) this.addConstraint(first + a, first + b, stiffness, this.distance(first + a, first + b) * restScale);
    for (const p of options.pinned ?? []) {
      if (!(p >= 0 && p < points.length)) throw new VerletError(`net pin ${p} is outside its ${points.length} points`);
      this.pin(first + p);
    }
    return { first, points: points.length, firstConstraint, constraints: edges.length };
  }

  /**
   * An orb web in the plane z = center[2]: radii from the hub through every spiral crossing to a
   * pinned anchor, and a capture spiral winding outward across them (see `WebLayout`). Spoke 0
   * points up; the spoke angles run counter-clockwise.
   */
  addWeb(options: WebOptions): WebLayout {
    const spokes = Math.max(3, Math.round(options.spokes));
    const turns = Math.max(1, Math.round(options.turns));
    const [cx, cy, cz] = options.center;
    const radius = options.radius;
    const inner = radius * (options.hub ?? 0.12);
    const pitch = (radius * (options.rim ?? 0.85) - inner) / turns;
    const jag = Math.min(1, Math.max(0, options.irregularity ?? 0));
    const seed = options.seed ?? 1;
    const invMass = options.invMass ?? 1;
    const restScale = options.restScale ?? 1;
    const spokeStiffness = options.spokeStiffness ?? 1;
    const spiralStiffness = options.spiralStiffness ?? 0.6;
    const first = this.#count;
    const firstConstraint = this.#constraintCount;
    const spiralLinks = spokes * turns - 1;
    this.#reservePoints(first + 1 + spokes * (turns + 1));
    this.#reserveConstraints(firstConstraint + spokes * (turns + 1) + spiralLinks);

    // A spider spaces its radii by eye: each angle wanders up to 0.3 of the even spacing.
    const angles = Array.from({ length: spokes }, (_, s) => Math.PI / 2 + ((s + 0.3 * jag * jitter(seed, s)) * TAU) / spokes);
    const hub = this.addPoint(cx, cy, cz, invMass);
    const spiral = this.#count;
    for (let s = 0; s < spokes; s++) {
      const a = angles[s] ?? 0;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      for (let k = 0; k < turns; k++) {
        // Spiral spacing wanders up to 0.3 of the pitch, so crossings stay in order along a radius.
        const r = inner + pitch * (k + s / spokes + 0.3 * jag * jitter(seed, spokes + s * turns + k));
        this.addPoint(cx + ux * r, cy + uy * r, cz, invMass);
      }
    }
    const anchors = this.#count;
    for (let s = 0; s < spokes; s++) {
      const a = angles[s] ?? 0;
      const r = radius * (1 + 0.12 * jag * jitter(seed, spokes * (turns + 1) + s));
      this.pin(this.addPoint(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz, invMass));
    }

    for (let s = 0; s < spokes; s++) {
      let from = hub;
      for (let k = 0; k <= turns; k++) {
        const to = k < turns ? spiral + s * turns + k : anchors + s;
        this.addConstraint(from, to, spokeStiffness, this.distance(from, to) * restScale);
        from = to;
      }
    }
    const spiralConstraint = this.#constraintCount;
    for (let k = 0; k < turns; k++) {
      for (let s = 0; s < spokes; s++) {
        const here = spiral + s * turns + k;
        const next = s + 1 < spokes ? here + turns : k + 1 < turns ? spiral + k + 1 : -1;
        if (next >= 0) this.addConstraint(here, next, spiralStiffness, this.distance(here, next) * restScale);
      }
    }
    return {
      first,
      points: this.#count - first,
      firstConstraint,
      constraints: this.#constraintCount - firstConstraint,
      hub,
      spiral,
      anchors,
      spokes,
      turns,
      spiralConstraint,
    };
  }

  /** Remove every point and constraint (arrays are kept for reuse). */
  clear(): void {
    this.#count = 0;
    this.#constraintCount = 0;
    this.#kIterations = 0;
    this.#carry = 0;
    this.#time = 0;
    this.version++;
  }

  // ---- handling -------------------------------------------------------------------------------

  /** Hold a point still (inverse mass 0); `unpin` restores its mass. */
  pin(i: number): void {
    this.#check(i);
    this.#invMass[i] = 0;
    this.version++;
  }

  /** Let a pinned point go, keeping the velocity it was last moved with. */
  unpin(i: number, invMass?: number): void {
    this.#check(i);
    const mass = invMass ?? this.#freeMass[i] ?? 1;
    if (!(mass > 0)) throw new VerletError(`unpin needs a positive inverse mass, got ${mass}`);
    this.#invMass[i] = mass;
    this.#freeMass[i] = mass;
    this.#moving[i] = 0;
    this.version++;
  }

  isPinned(i: number): boolean {
    return (this.#invMass[i] ?? 0) === 0;
  }

  /**
   * Move a point. A pinned point glides there in even steps over the next `step`'s substeps (so a
   * dragged anchor or a swaying twig pulls its threads smoothly, and carries velocity if unpinned);
   * a free point is shifted there, keeping its velocity.
   */
  move(i: number, x: number, y: number, z: number): void {
    this.#check(i);
    const o = i * 3;
    if (this.isPinned(i)) {
      this.#target[o] = x;
      this.#target[o + 1] = y;
      this.#target[o + 2] = z;
      this.#moving[i] = 1;
    } else {
      const pos = this.#pos;
      const prev = this.#prev;
      const dx = x - (pos[o] ?? 0);
      const dy = y - (pos[o + 1] ?? 0);
      const dz = z - (pos[o + 2] ?? 0);
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      prev[o] = (prev[o] ?? 0) + dx;
      prev[o + 1] = (prev[o + 1] ?? 0) + dy;
      prev[o + 2] = (prev[o + 2] ?? 0) + dz;
    }
    this.version++;
  }

  /** Put a point there at once, at rest (no glide, no velocity). */
  place(i: number, x: number, y: number, z: number): void {
    this.#check(i);
    this.#putAtRest(i, x, y, z);
    this.#moving[i] = 0;
    this.version++;
  }

  distance(a: number, b: number): number {
    const pos = this.#pos;
    const oa = a * 3;
    const ob = b * 3;
    return Math.hypot((pos[ob] ?? 0) - (pos[oa] ?? 0), (pos[ob + 1] ?? 0) - (pos[oa + 1] ?? 0), (pos[ob + 2] ?? 0) - (pos[oa + 2] ?? 0));
  }

  /** Velocity of point i (units per second) into out[0..2]. */
  velocity(i: number, out: Float32Array | number[]): void {
    const o = i * 3;
    const rate = 1 / this.#substep;
    out[0] = ((this.#pos[o] ?? 0) - (this.#prev[o] ?? 0)) * rate;
    out[1] = ((this.#pos[o + 1] ?? 0) - (this.#prev[o + 1] ?? 0)) * rate;
    out[2] = ((this.#pos[o + 2] ?? 0) - (this.#prev[o + 2] ?? 0)) * rate;
  }

  /** The point nearest (x, y, z) within `maxDistance`, or -1; `freeOnly` skips pinned points. */
  nearest(x: number, y: number, z: number, maxDistance = Infinity, freeOnly = false): number {
    return this.#nearest(x, y, z, 1, maxDistance, freeOnly);
  }

  /** As `nearest`, measured in the xy plane only: for picking with the pointer. */
  nearestXY(x: number, y: number, maxDistance = Infinity, freeOnly = false): number {
    return this.#nearest(x, y, 0, 0, maxDistance, freeOnly);
  }

  /**
   * Kick every free point within `radius` of (x, y, z) by the velocity (vx, vy, vz), fading as
   * (1 - d²/r²)² to nothing at the edge. A velocity change, not a momentum: heavy and light points
   * jump alike. Returns the summed falloff (0 = nothing in reach).
   */
  impulse(x: number, y: number, z: number, radius: number, vx: number, vy: number, vz: number): number {
    return this.#kick(x, y, z, 1, radius, vx, vy, vz);
  }

  /** As `impulse`, reaching through the screen: distance in the xy plane only (pluck, brush). */
  impulseXY(x: number, y: number, radius: number, vx: number, vy: number, vz: number): number {
    return this.#kick(x, y, 0, 0, radius, vx, vy, vz);
  }

  // ---- simulation -----------------------------------------------------------------------------

  /**
   * Advance by dt seconds (pass dt × motion): whole substeps, the remainder carried to the next
   * call. dt ≤ 0 (paused) does nothing. Returns the substeps run. Allocation-free; keep `options`
   * around rather than building it each frame.
   */
  step(dt: number, options: VerletStepOptions): number {
    if (!(dt > 0)) return 0;
    const h = this.#substep;
    let steps = Math.floor((this.#carry + dt) / h);
    if (steps > this.#maxSubsteps) {
      steps = this.#maxSubsteps;
      this.#carry = 0;
    } else {
      this.#carry = Math.max(0, this.#carry + dt - steps * h);
    }
    this.version++;
    if (steps === 0) return 0;
    const iterations = Math.max(1, Math.round(options.iterations));
    if (iterations !== this.#kIterations) this.#refreshStiffness(iterations);
    const keep = Math.exp(-Math.max(0, options.damping) * h);
    for (let s = 0; s < steps; s++) {
      this.#integrate(h, keep, options, steps - s);
      this.#solve(iterations);
      this.#time += h;
    }
    return steps;
  }

  #integrate(h: number, keep: number, options: VerletStepOptions, remaining: number): void {
    const pos = this.#pos;
    const prev = this.#prev;
    const target = this.#target;
    const inv = this.#invMass;
    const moving = this.#moving;
    const out = this.#force;
    const force = options.force;
    const h2 = h * h;
    const [gx, gy, gz] = options.gravity;
    const glide = 1 / remaining;
    const n = this.#count;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const x = pos[o] ?? 0;
      const y = pos[o + 1] ?? 0;
      const z = pos[o + 2] ?? 0;
      const w = inv[i] ?? 0;
      if (w === 0) {
        prev[o] = x;
        prev[o + 1] = y;
        prev[o + 2] = z;
        if (moving[i] === 1) {
          pos[o] = x + ((target[o] ?? x) - x) * glide;
          pos[o + 1] = y + ((target[o + 1] ?? y) - y) * glide;
          pos[o + 2] = z + ((target[o + 2] ?? z) - z) * glide;
          if (remaining === 1) moving[i] = 0;
        }
        continue;
      }
      let ax = gx;
      let ay = gy;
      let az = gz;
      if (force !== undefined) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        force(i, x, y, z, out);
        ax += (out[0] ?? 0) * w;
        ay += (out[1] ?? 0) * w;
        az += (out[2] ?? 0) * w;
      }
      const vx = (x - (prev[o] ?? x)) * keep;
      const vy = (y - (prev[o + 1] ?? y)) * keep;
      const vz = (z - (prev[o + 2] ?? z)) * keep;
      prev[o] = x;
      prev[o + 1] = y;
      prev[o + 2] = z;
      pos[o] = x + vx + ax * h2;
      pos[o + 1] = y + vy + ay * h2;
      pos[o + 2] = z + vz + az * h2;
    }
  }

  #solve(iterations: number): void {
    const pos = this.#pos;
    const inv = this.#invMass;
    const ca = this.#a;
    const cb = this.#b;
    const rest = this.#rest;
    const stiffness = this.#k;
    const count = this.#constraintCount;
    for (let it = 0; it < iterations; it++) {
      const forward = (it & 1) === 0;
      for (let s = 0; s < count; s++) {
        const c = forward ? s : count - 1 - s;
        const a = ca[c] ?? 0;
        const b = cb[c] ?? 0;
        const wa = inv[a] ?? 0;
        const wb = inv[b] ?? 0;
        const w = wa + wb;
        if (w === 0) continue;
        const oa = a * 3;
        const ob = b * 3;
        const dx = (pos[ob] ?? 0) - (pos[oa] ?? 0);
        const dy = (pos[ob + 1] ?? 0) - (pos[oa + 1] ?? 0);
        const dz = (pos[ob + 2] ?? 0) - (pos[oa + 2] ?? 0);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-18) continue;
        const d = Math.sqrt(d2);
        const f = ((stiffness[c] ?? 0) * (d - (rest[c] ?? 0))) / (d * w);
        pos[oa] = (pos[oa] ?? 0) + wa * f * dx;
        pos[oa + 1] = (pos[oa + 1] ?? 0) + wa * f * dy;
        pos[oa + 2] = (pos[oa + 2] ?? 0) + wa * f * dz;
        pos[ob] = (pos[ob] ?? 0) - wb * f * dx;
        pos[ob + 1] = (pos[ob + 1] ?? 0) - wb * f * dy;
        pos[ob + 2] = (pos[ob + 2] ?? 0) - wb * f * dz;
      }
    }
  }

  /** Per-pass stiffness k' = 1 - (1 - k)^(1/n): n passes remove the share k of a lone error. */
  #refreshStiffness(iterations: number): void {
    const k = this.#k;
    const stiffness = this.#stiffness;
    for (let c = 0; c < this.#constraintCount; c++) {
      const s = stiffness[c] ?? 0;
      k[c] = s >= 1 ? 1 : 1 - Math.pow(1 - s, 1 / iterations);
    }
    this.#kIterations = iterations;
  }

  #nearest(x: number, y: number, z: number, zWeight: number, maxDistance: number, freeOnly: boolean): number {
    const pos = this.#pos;
    const inv = this.#invMass;
    let best = -1;
    let bestD2 = maxDistance * maxDistance;
    for (let i = 0; i < this.#count; i++) {
      if (freeOnly && (inv[i] ?? 0) === 0) continue;
      const o = i * 3;
      const dx = (pos[o] ?? 0) - x;
      const dy = (pos[o + 1] ?? 0) - y;
      const dz = ((pos[o + 2] ?? 0) - z) * zWeight;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  #kick(x: number, y: number, z: number, zWeight: number, radius: number, vx: number, vy: number, vz: number): number {
    if (!(radius > 0)) return 0;
    const pos = this.#pos;
    const prev = this.#prev;
    const inv = this.#invMass;
    const r2 = radius * radius;
    // The velocity is the last move (pos - prev) / h. Split the extra move around the render blend
    // so the drawn point (prev + (pos - prev) · blend) does not twitch on the frame of the kick.
    const blend = this.blend;
    const back = this.#substep * blend;
    const ahead = this.#substep * (1 - blend);
    let total = 0;
    for (let i = 0; i < this.#count; i++) {
      if ((inv[i] ?? 0) === 0) continue;
      const o = i * 3;
      const dx = (pos[o] ?? 0) - x;
      const dy = (pos[o + 1] ?? 0) - y;
      const dz = ((pos[o + 2] ?? 0) - z) * zWeight;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const q = 1 - d2 / r2;
      const w = q * q;
      prev[o] = (prev[o] ?? 0) - vx * w * back;
      prev[o + 1] = (prev[o + 1] ?? 0) - vy * w * back;
      prev[o + 2] = (prev[o + 2] ?? 0) - vz * w * back;
      pos[o] = (pos[o] ?? 0) + vx * w * ahead;
      pos[o + 1] = (pos[o + 1] ?? 0) + vy * w * ahead;
      pos[o + 2] = (pos[o + 2] ?? 0) + vz * w * ahead;
      total += w;
    }
    if (total > 0) this.version++;
    return total;
  }

  #check(i: number): void {
    if (!(Number.isInteger(i) && i >= 0 && i < this.#count)) throw new VerletError(`no point ${i} (count ${this.#count})`);
  }

  /** Position, previous position and glide target all at (x, y, z): there, and still. */
  #putAtRest(i: number, x: number, y: number, z: number): void {
    const o = i * 3;
    const pos = this.#pos;
    const prev = this.#prev;
    const target = this.#target;
    pos[o] = x;
    pos[o + 1] = y;
    pos[o + 2] = z;
    prev[o] = x;
    prev[o + 1] = y;
    prev[o + 2] = z;
    target[o] = x;
    target[o + 1] = y;
    target[o + 2] = z;
  }

  #reservePoints(n: number): void {
    const capacity = this.#invMass.length;
    if (n <= capacity) return;
    const size = Math.max(n, capacity * 2);
    this.#pos = growF32(this.#pos, size * 3);
    this.#prev = growF32(this.#prev, size * 3);
    this.#target = growF32(this.#target, size * 3);
    this.#invMass = growF32(this.#invMass, size);
    this.#freeMass = growF32(this.#freeMass, size);
    this.#moving = growU8(this.#moving, size);
  }

  #reserveConstraints(n: number): void {
    const capacity = this.#a.length;
    if (n <= capacity) return;
    const size = Math.max(n, capacity * 2);
    this.#a = growU32(this.#a, size);
    this.#b = growU32(this.#b, size);
    this.#rest = growF32(this.#rest, size);
    this.#stiffness = growF32(this.#stiffness, size);
    this.#k = growF32(this.#k, size);
  }
}

/**
 * A system's points packed into an rgba16f texture for `texelFetch`: point i's record starts at
 * texel k = i × stride, at (k % width, k / width). Position texel: xyz = position − origin, blended
 * between the last two substeps; w = the caller's per-point value or else the inverse mass (0 =
 * pinned). Velocity texel (when packed): xyz = velocity in units per second, w = speed.
 */
export class PointTexture {
  readonly points: number;
  /** Texels per point: 1 (position) or 2 (position, velocity). */
  readonly stride: 1 | 2;
  readonly width: number;
  readonly height: number;
  readonly #texture: DataTexture;
  readonly #data: Float32Array;
  readonly #origin: Vec3;
  #version = -1;

  constructor(gl: WebGL2RenderingContext, options: PointTextureOptions) {
    this.points = Math.max(1, Math.floor(options.points));
    this.stride = options.velocity === true ? 2 : 1;
    const texels = this.points * this.stride;
    const width = options.width ?? Math.min(texels, MAX_ROW);
    if (!(Number.isInteger(width) && width >= this.stride && width % this.stride === 0)) {
      throw new VerletError(`point texture width ${width} must be a positive multiple of ${this.stride}`);
    }
    this.width = width;
    this.height = Math.ceil(texels / width);
    this.#data = new Float32Array(this.width * this.height * 4);
    this.#texture = new DataTexture(gl, { width: this.width, height: this.height, format: "rgba16f", filter: "nearest" });
    this.#origin = options.origin ?? [0, 0, 0];
  }

  get texture(): WebGLTexture {
    return this.#texture.texture;
  }

  /**
   * Pack and upload the system's points. Skipped (returning false) when the system has not changed
   * since the last upload, unless `w` is given: per-point values for the position texel's w.
   */
  upload(system: VerletSystem, w?: ArrayLike<number>): boolean {
    if (w === undefined && system.version === this.#version) return false;
    this.#version = system.version;
    const data = this.#data;
    const pos = system.positions;
    const prev = system.previous;
    const inv = system.inverseMass;
    const blend = system.blend;
    const rate = 1 / system.substep;
    const [ox, oy, oz] = this.#origin;
    const velocity = this.stride === 2;
    const record = this.stride * 4;
    const n = Math.min(this.points, system.count);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const k = i * record;
      const x = pos[o] ?? 0;
      const y = pos[o + 1] ?? 0;
      const z = pos[o + 2] ?? 0;
      const px = prev[o] ?? x;
      const py = prev[o + 1] ?? y;
      const pz = prev[o + 2] ?? z;
      data[k] = px + (x - px) * blend - ox;
      data[k + 1] = py + (y - py) * blend - oy;
      data[k + 2] = pz + (z - pz) * blend - oz;
      data[k + 3] = w === undefined ? (inv[i] ?? 0) : (w[i] ?? 0);
      if (velocity) {
        const vx = (x - px) * rate;
        const vy = (y - py) * rate;
        const vz = (z - pz) * rate;
        data[k + 4] = vx;
        data[k + 5] = vy;
        data[k + 6] = vz;
        data[k + 7] = Math.sqrt(vx * vx + vy * vy + vz * vz);
      }
    }
    data.fill(0, n * record);
    this.#texture.upload(data);
    return true;
  }

  dispose(): void {
    this.#texture.dispose();
  }
}
