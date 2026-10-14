// The pond's koi when they are drawn to the pointer (the `follow` knob), swum as steered fish
// (sims/fish.ts) instead of on the shader's own loops.
//
// Off (the default), the shader swims each koi round its loop (pondKoiPath) and this stands idle.
// On, every koi still follows its loop until the pointer is over the pond and has moved within the
// last few seconds: then the koi that are near enough notice it one after another (`eager`: how far
// they notice, how soon they come, how long they wait once it rests), come to it and mill about it,
// noses in, each keeping its personal space (`spacing`) instead of piling onto the others. When the
// pointer rests or leaves they lose interest and swim back to their loops. Turned off, they swim home
// and the shader takes them over again, blending over HANDOFF seconds.
//
// The loops are the shader's, mirrored here (koiLoop, with common.ts's hash12 in float32 steps), so
// a koi taken over from its loop or handed back to it does not jump.
//
// Texture: a FishTexture of KOI_MAX koi, swum on the motion clock (the shader's tm), in the shader's
// pond units (p: x across ±aspect/2, y ±0.5); tag.x is how much of the steered koi the shader shows
// rather than its own loop, the same for all (0 while idle: the texture is then not bound at all).
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { FishGroup, FishTexture, KOI } from "../../sims/fish.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import type { SimFrame } from "../types.ts";

/** The most koi the shader draws (its loop runs to 8). */
export const KOI_MAX = 8;
/** Seconds the shader takes to hand a koi over to steering, and back to its loop. */
const TAKEOVER = 0.6;
const HANDOFF = 1.2;
/** Turned off, the koi are handed back once all are this near their loops (or after HOMING s). */
const HOME_NEAR = 0.01;
const HOMING = 5;
/** Fixed step of the swim (motion seconds) and most steps per frame. */
const STEP = 1 / 60;
const MAX_STEPS = 8;
/**
 * Eagerness 0..1 maps to: how far off a koi notices the pointer (pond heights), how quickly its
 * interest rises (per second, each koi 0.5-1.5 times it), and how many seconds of a resting pointer
 * it waits for before losing interest.
 */
const REACH = [0.35, 1.3] as const;
const KEEN = [0.25, 1.4] as const;
const PATIENCE = [3, 16] as const;
/** Interest lost per second once the pointer rests or leaves. */
const BORED = 0.45;
/** The pointer counts as moved past this many pond heights. */
const STIR = 0.004;
/** A koi slows inside this many body lengths of the pointer, and aims a little off it (its own spot). */
const SLOW = 2.5;
const SPOT = 0.35;
/** Personal space at spacing 1, in body lengths between centres (the default 0.5 is KOI's 1.1). */
const SPACE = 2.2;
/** Soft walls while gathering: the pond's edges, pulled in by this much. */
const WALL = 0.08;

type Knob = "koi" | "swim" | "follow" | "spacing" | "eager";
const KNOBS: readonly Knob[] = ["koi", "swim", "follow", "spacing", "eager"];

const f32 = Math.fround;
const fract32 = (x: number): number => f32(x - Math.floor(x));

/** common.ts `hash12(vec2(x, y))`, step by step in float32 as the shader runs it. */
export function glslHash12(x: number, y: number): number {
  const k = f32(0.1031);
  const s = f32(33.33);
  let a = fract32(f32(f32(x) * k));
  let b = fract32(f32(f32(y) * k));
  let c = a;
  const d = f32(f32(f32(a * f32(b + s)) + f32(b * f32(c + s))) + f32(c * f32(a + s)));
  a = f32(a + d);
  b = f32(b + d);
  c = f32(c + d);
  return fract32(f32(f32(a + b) * c));
}

/**
 * One koi as the shader derives it from its index: its loop (a, b, ph), body length; and, for
 * steering only, its eagerness (0.5..1.5 of the knob's), its spot off the pointer (-1..1 of SPOT
 * lengths each way) and its weave's salt.
 */
export interface KoiLoop {
  a: number;
  b: number;
  ph: number;
  len: number;
  keen: number;
  spotX: number;
  spotY: number;
  salt: number;
}

/** The shader's pondKoiPath for koi i: position and velocity (per unit of s) at path time s, into out. */
export function koiLoop(loop: KoiLoop, s: number, aspect: number, out: Float64Array): void {
  const { a, b, ph } = loop;
  const u1 = s * a + ph;
  const u2 = s * a * 2.3 + ph * 1.7;
  const v1 = s * b + ph * 0.7;
  const v2 = s * b * 1.9 + ph;
  out[0] = Math.sin(u1) * 0.42 * aspect + Math.sin(u2) * 0.12;
  out[1] = Math.sin(v1) * 0.34 + Math.cos(v2) * 0.1;
  out[2] = a * Math.cos(u1) * 0.42 * aspect + a * 2.3 * Math.cos(u2) * 0.12;
  out[3] = b * Math.cos(v1) * 0.34 - b * 1.9 * Math.sin(v2) * 0.1;
}

export function koiLoops(): readonly KoiLoop[] {
  return Array.from({ length: KOI_MAX }, (_, i) => ({
    a: 0.13 + 0.07 * glslHash12(i, 1),
    b: 0.11 + 0.08 * glslHash12(i, 2),
    ph: glslHash12(i, 3) * Math.PI * 2,
    len: 0.11 + 0.06 * glslHash12(i, 6),
    keen: 0.5 + glslHash12(i, 10),
    spotX: 2 * glslHash12(i, 4) - 1,
    spotY: 2 * glslHash12(i, 5) - 1,
    salt: glslHash12(i, 9),
  }));
}

export class PondKoi {
  readonly group = new FishGroup(KOI, KOI_MAX);
  readonly #knobs: KnobReader<Knob>;
  readonly #loops = koiLoops();
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  readonly #at = new Float64Array(4);
  readonly #interest = new Float64Array(KOI_MAX);
  readonly #texture: FishTexture | undefined;
  /** How much of the steered koi the shader shows, 0..1. */
  #shown = 0;
  /** Seconds since follow was turned off while steering (−1 while on or idle). */
  #homing = -1;
  #started = false;
  /** The pointer: where it was last seen to move, how long ago (scene seconds). */
  #lureX = 0;
  #lureY = 0;
  #still = Infinity;
  #aspect = 16 / 9;
  /** The species as swum, rebuilt only when the spacing knob moves. */
  #spacing = Number.NaN;

  constructor(params: readonly ParamDef[], gl?: WebGL2RenderingContext) {
    this.#knobs = new KnobReader("pond koi", params, KNOBS);
    this.#texture = gl ? new FishTexture(gl, KOI_MAX) : undefined;
  }

  /** How much of the steered koi the shader shows (0: the koi are on the shader's own loops). */
  get shown(): number {
    return this.#shown;
  }

  /** How keen koi i is on the pointer, 0..1. */
  interest(i: number): number {
    return this.#interest[i] ?? 0;
  }

  /** Advance for this frame; returns the texture to bind, or undefined while the shader's loops rule. */
  frame(frame: SimFrame): WebGLTexture | undefined {
    const knobs = this.#knobs;
    const follow = knobs.value(frame, "follow") > 0.5 && knobs.value(frame, "koi") > 0;
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    // The shader's swimTime per motion second.
    const pace = 0.6 + 2.4 * knobs.value(frame, "swim");
    const real = Math.max(0, frame.dt);
    this.#watchPointer(frame, real);

    // Taken over this frame: the koi stand where the loops have them now, and swim from the next.
    const fresh = follow && this.#shown <= 0;
    if (fresh) this.#takeOver(frame.motionTime, pace, !this.#started);
    this.#started = true;
    if (this.#shown <= 0) return undefined;

    // Hand-over to and from the loops runs on the scene clock, so it ends even while motion is 0.
    if (follow) {
      this.#homing = -1;
      this.#shown = Math.min(1, this.#shown + real / TAKEOVER);
    } else {
      if (this.#homing < 0) this.#homing = 0;
      this.#homing += real;
      if (this.#homing > HOMING || this.#farthestFromHome(frame.motionTime, pace) < HOME_NEAR) this.#shown = Math.max(0, this.#shown - real / HANDOFF);
    }

    const count = Math.round(knobs.value(frame, "koi"));
    const steps = fresh ? 0 : this.#clock.advance(real * frame.motion);
    for (let k = 0; k < steps; k++) {
      this.#step(frame.motionTime - this.#clock.lag(k), pace, count, follow, frame);
    }
    const group = this.group;
    for (let i = 0; i < KOI_MAX; i++) group.tag[4 * i] = this.#shown;
    this.#texture?.upload(group, count, this.#clock.pending);
    return this.#shown > 0 ? this.#texture?.texture : undefined;
  }

  dispose(): void {
    this.#texture?.dispose();
  }

  /** Put every koi on its loop at motion time tm, facing along it, and start showing them. */
  #takeOver(tm: number, pace: number, atOnce: boolean): void {
    const group = this.group;
    const at = this.#at;
    for (let i = 0; i < KOI_MAX; i++) {
      const loop = this.#loops[i];
      if (!loop) continue;
      koiLoop(loop, tm * pace + i * 11, this.#aspect, at);
      const vx = (at[2] ?? 0) * pace;
      const vy = (at[3] ?? 0) * pace;
      group.place(i, at[0] ?? 0, at[1] ?? 0, Math.atan2(vy, vx), Math.hypot(vx, vy), loop.len, loop.salt);
      this.#interest[i] = 0;
    }
    this.#clock.reset();
    this.#homing = -1;
    // A sim built with follow already on (an entrance, a fresh load) starts steered; turned on
    // later, the koi are taken over from their loops over TAKEOVER.
    this.#shown = atOnce ? 1 : 1e-6;
  }

  /** The farthest any koi is from its place on its loop at motion time tm. */
  #farthestFromHome(tm: number, pace: number): number {
    const at = this.#at;
    let far = 0;
    for (let i = 0; i < KOI_MAX; i++) {
      const loop = this.#loops[i];
      if (!loop) continue;
      koiLoop(loop, tm * pace + i * 11, this.#aspect, at);
      far = Math.max(far, Math.hypot((this.group.x[i] ?? 0) - (at[0] ?? 0), (this.group.y[i] ?? 0) - (at[1] ?? 0)));
    }
    return far;
  }

  /** Where the pointer is over the pond (pond units) and how long it has rested. */
  #watchPointer(frame: SimFrame, dt: number): void {
    const pointer = frame.pointer;
    if (!pointer.inside) {
      this.#still = Infinity;
      return;
    }
    const x = (pointer.x - 0.5) * this.#aspect;
    const y = pointer.y - 0.5;
    if (!Number.isFinite(this.#still) || Math.hypot(x - this.#lureX, y - this.#lureY) > STIR) {
      this.#lureX = x;
      this.#lureY = y;
      this.#still = 0;
    } else {
      this.#still += dt;
    }
  }

  #step(tm: number, pace: number, count: number, follow: boolean, frame: SimFrame): void {
    const knobs = this.#knobs;
    const eager = clamp(knobs.value(frame, "eager"), 0, 1);
    const reach = REACH[0] + (REACH[1] - REACH[0]) * eager;
    const keen = KEEN[0] + (KEEN[1] - KEEN[0]) * eager;
    const patience = PATIENCE[0] + (PATIENCE[1] - PATIENCE[0]) * eager;
    const lured = follow && this.#still <= patience;
    const group = this.group;
    group.pace = pace;
    const spacing = SPACE * clamp(knobs.value(frame, "spacing"), 0, 1);
    if (spacing !== this.#spacing) {
      this.#spacing = spacing;
      group.species = { ...KOI, spacing };
    }
    group.clear(KOI_MAX);
    const at = this.#at;
    const halfX = 0.5 * this.#aspect - WALL;
    for (let i = 0; i < KOI_MAX; i++) {
      const loop = this.#loops[i];
      if (!loop) continue;
      // Interest: each koi near enough warms to a moving pointer at its own rate, and cools once it rests.
      const dx = this.#lureX - (group.x[i] ?? 0);
      const dy = this.#lureY - (group.y[i] ?? 0);
      const near = lured && Math.hypot(dx, dy) < reach + (this.#interest[i] ?? 0) * 0.3;
      const rate = near ? keen * loop.keen : -BORED;
      const interest = clamp((this.#interest[i] ?? 0) + rate * STEP, 0, 1);
      this.#interest[i] = interest;
      const pull = smoothstep(0, 1, interest);
      koiLoop(loop, tm * pace + i * 11, this.#aspect, at);
      if (pull < 1) group.follow(i, at[0] ?? 0, at[1] ?? 0, (at[2] ?? 0) * pace, (at[3] ?? 0) * pace, 1 - pull);
      if (pull > 0) {
        // Each aims at its own spot just off the pointer, slowing as it comes: they arrive spread out.
        const spot = SPOT * loop.len;
        group.gather(i, this.#lureX + loop.spotX * spot, this.#lureY + loop.spotY * spot, SLOW * loop.len, pull * (1 + eager));
        group.wander(i, tm, 0.6 * pull);
        group.within(i, -halfX, -0.5 + WALL, halfX, 0.5 - WALL, WALL);
      }
    }
    group.space(count);
    group.swim(KOI_MAX, STEP);
  }
}
