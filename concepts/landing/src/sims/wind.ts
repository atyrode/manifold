// Wind for sims: the lab's shared conventions for wind and gusts, so every scene that blows things
// about means the same by them.
//
// Conventions (scenes/atmosphere.ts `weatherKnobs`): K_wind runs -1..1, positive blowing toward +x
// (screen right). A scene's gusts are a feature knob whose amount is their strength (and how often
// they come), with a "now" trigger. A gust blows the way the wind does: `windSign`.
//
//   gustPulse(age, rise)    a gust's strength `age` seconds after it began: a = age / rise,
//                           a² e^(2 (1 - a)); 0 before it begins and from 12 rise on, peaking at 1 at
//                           age = rise. The gusts of garden (garden/sim.ts, rise 1) and autumn
//                           (autumn/sim.ts, rise 1.6).
//   gustPulseGlsl           its GLSL twin, `float windGustPulse(float age, float rise)`: the garden
//                           maple's sway (garden/shader.ts) follows the leaves' gust with it.
//   windSign(wind)          -1 when the wind is set left beyond -0.05, else +1 (autumn's and garden's
//                           gusts and autumn's passage).
//   gustWait(mean, r)       seconds to the next gust for a uniform draw r: mean · (0.6 + 0.8 r), the
//                           spread of autumn's and bonsai's gust scheduling (autumn's through it).
//   GustTrain               a seeded train of gusts on that spread, with "now" (`start`), each blowing
//                           with the wind at its own power; `strength(delay)` reads the pulse a
//                           travelling front brings to a point `delay` seconds after it began.
//   windNoise(t, salt)      smooth 1D value noise in -1..1, for eddies and the breeze's wander.
//
// Usage (a gust feature `gusts` with a "now" trigger, and the wind knob):
//   readonly #gusts = new GustTrain(mulberry32(seed), 1.6, 25);
//   if (frame.fired[gustSlot]) this.#gusts.start(wind, power, mean);
//   this.#gusts.step(dt, gustsOn ? mean : Infinity, wind, power);
//   const push = this.#gusts.strength(x / FRONT_SPEED);   // a front crossing from x = 0
import { hash31 } from "./math.ts";

/** A gust's strength `age` seconds after it began: (age / rise)² e^(2 (1 - age / rise)), 0 outside (0, 12 rise). */
export function gustPulse(age: number, rise: number): number {
  if (!(age > 0 && age < 12 * rise)) return 0;
  const a = age / rise;
  return a * a * Math.exp(2 * (1 - a));
}

/** GLSL: `float windGustPulse(float age, float rise)`, gustPulse on the GPU. */
export const gustPulseGlsl = `
float windGustPulse(float age, float rise) {
  if (age <= 0.0 || age >= 12.0 * rise) return 0.0;
  float a = age / rise;
  return a * a * exp(2.0 * (1.0 - a));
}
`;

/** The way a gust blows for the wind knob -1..1: -1 (left) below -0.05, else +1 (right). */
export function windSign(wind: number): number {
  return wind < -0.05 ? -1 : 1;
}

/** Seconds to the next gust, mean · (0.6 + 0.8 r) for a uniform r in [0, 1). */
export function gustWait(mean: number, r: number): number {
  return mean * (0.6 + 0.8 * r);
}

/**
 * A train of gusts at random intervals around a mean, each a `gustPulse` of the train's rise time
 * blowing with the wind. Allocation-free; draws one number from `random` per gust.
 */
export class GustTrain {
  /** Seconds a gust takes to peak. */
  readonly rise: number;
  readonly #random: () => number;
  /** Seconds since the latest gust began (Infinity before the first). */
  age = Infinity;
  /** The way the latest gust blows, ±1. */
  sign = 1;
  /** Its peak strength. */
  power = 0;
  #wait: number;

  constructor(random: () => number, rise: number, firstWait: number) {
    this.#random = random;
    this.rise = rise;
    this.#wait = firstWait;
  }

  /** Seconds until the next gust starts on its own. */
  get wait(): number {
    return this.#wait;
  }

  /** A gust begins now, blowing with `wind`, peaking at `power`; the next comes about `mean` seconds later. */
  start(wind: number, power: number, mean: number): void {
    this.age = 0;
    this.sign = windSign(wind);
    this.power = power;
    this.#wait = gustWait(mean, this.#random());
  }

  /**
   * Advance `dt` seconds. While `mean` is finite the wait runs down and a gust starts when it runs
   * out (Infinity: gusts are off, the wait holds). Returns whether a gust began.
   */
  step(dt: number, mean: number, wind: number, power: number): boolean {
    if (!(dt > 0)) return false;
    this.age += dt;
    if (!Number.isFinite(mean)) return false;
    this.#wait -= dt;
    if (this.#wait > 0) return false;
    this.start(wind, power, mean);
    return true;
  }

  /** The latest gust's signed strength, `delay` seconds behind its start (a front reaching a point later). */
  strength(delay = 0): number {
    return gustPulse(this.age - delay, this.rise) * this.power * this.sign;
  }
}

/** Smooth value noise in -1..1 along t (one lattice value per whole t, eased between), per `salt`. */
export function windNoise(t: number, salt: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash31(i, salt, 0x57494e44);
  const b = hash31(i + 1, salt, 0x57494e44);
  return 2 * (a + (b - a) * u) - 1;
}
