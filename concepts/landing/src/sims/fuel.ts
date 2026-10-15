// A wood fire's fuel burning down: logs that catch from the bed, char, slump into it in steps as they
// burn through and crumble to embers; a coal bed fed by what burns and fading to ash; and someone who
// tends the fire, laying a fresh log on when one has burnt away (or not, and the fire goes out). For
// any scene with a wood fire (a campfire, a hearth, a stove, a brazier): the bed says how big the
// flames are, how brightly the coals glow, how much it smokes and when sparks burst, and how far each
// log has burnt, charred and slumped; the scene draws all of that its own way.
//
// One `burnTime` (seconds) is how long a flaming log of full size takes to burn away. Step the bed on
// the motion clock (frame.dt * frame.motion, through a FixedStep), so a still frame holds the fire.
//
// Per log (FuelLog), mass m from 1 (fresh) to 0 (gone):
//   lit     0 just laid on .. 1 flaming. It catches from the bed: dlit/dt = draw (1 - lit) / (CATCH burnTime),
//           draw = the embers plus the other logs' flames (at most 1.5); on a cold, dead bed it never does.
//   mass    burns at its surface: dm/dt = -3 lit m^(2/3) / burnTime, so a flaming log of mass m0 is gone
//           after m0^(1/3) burnTimes.
//   char    blackens while it burns: dchar/dt = lit (1 - char) / (CHAR burnTime).
//   settle  0..1: slumps into the bed in SLUMPS.length steps as it burns through (at about 30, 55, 75
//           and 90% gone, each log's own thresholds jittered by the seed), each over SLUMP_SECONDS and
//           each a burst of sparks.
//   placed  0..1 over PLACE_SECONDS while a new log is being laid on (ease it in the drawing); landing
//           gives a smaller burst.
// The bed:
//   heat    the flames, relative to the fire FuelBed.open(STEADY_FIRE) lays (1). Wood burns in two
//           phases: while its volatiles last (until CHARCOAL of it is left) it flames from its whole
//           surface, lit m^(2/3); then its charcoal glows with little flame, CHAR_FLAME of that. So a
//           fresh log flares the fire to ~1.6 as it catches, and an old fire's flames sink while its
//           coals hold. Scale the flames and the firelight by it.
//   embers  the coal bed, fed by what burns and fading to ash over ASH burnTimes: 1 under a steady fire,
//           up to 1.5; it outlasts the flames by a burnTime or so.
//   smoke   0..1: a fresh log smokes until it catches; a dying fire smoulders.
//   burst   1 as a log slumps (0.6 as one lands), fading over BURST_SECONDS: a shower of sparks.
// Tending (`tend` on): a few seconds after a log has burnt away or the flames have sunk below
// TEND_LOW, a fresh one is laid on, never while the last one laid is still catching. addLog() lays
// one at once. Either way it goes on the slot whose log has least wood left, the stub pushed into the
// coals.
//
// Usage (a scene's sim, three logs, burn time from a knob in minutes):
//   readonly #bed = new FuelBed(3, 0xf1e);
//   readonly #clock = new FixedStep(FUEL_STEP, 4);
//   frame(frame) {
//     if (switchedOn) { this.#bed.open(STEADY_FIRE); this.#clock.reset(); }
//     if (frame.fired[tendSlot]) this.#bed.addLog();
//     const steps = this.#clock.advance(Math.max(0, frame.dt) * frame.motion);
//     for (let i = 0; i < steps; i++) this.#bed.step(FUEL_STEP, minutes * 60, tend);
//     // upload bed.logs[i].{mass, char, settle, placed} and bed.{heat, embers, smoke, burst}
//   }
import { clamp } from "./math.ts";
import { Random } from "./random.ts";

/** A step that keeps the bed's integration accurate (s); larger steps still stay stable. */
export const FUEL_STEP = 1 / 20;

/** Shares of a burnTime: a log catching on a full bed (63%), its bark charring (63%), the embers fading (1/e). */
const CATCH = 0.06;
const CHAR = 0.12;
const ASH = 0.3;
/** Shares of a log gone at which it slumps, the jitter on each, and how long a slump or a laying takes (s). */
const SLUMPS: readonly number[] = [0.3, 0.55, 0.75, 0.9];
const SLUMP_JITTER = 0.05;
const SLUMP_SECONDS = 0.25;
const PLACE_SECONDS = 1.4;
const BURST_SECONDS = 1.5;
const LANDING_BURST = 0.6;
/** Below this mass a log has crumbled into the bed. */
const GONE = 0.03;
/** Wood left once the volatiles are gone and the charcoal glows; flames of that charcoal relative to a fresh surface. */
const CHARCOAL = 0.25;
const CHAR_FLAME = 0.35;
/** A fire under way: three logs with this much wood left (heat 1, embers 1). */
export const STEADY_FIRE: readonly number[] = [0.7, 0.45, 0.25];
/** Burning surface Σ m^(2/3) and flames of STEADY_FIRE. */
const STEADY = STEADY_FIRE.reduce((sum, m) => sum + Math.pow(m, 2 / 3), 0);
const STEADY_FLAME = STEADY_FIRE.reduce((sum, m) => sum + flames(m, 1), 0);
/** Embers made per unit of mass burnt, so that a steady fire keeps them at 1. */
const EMBER_GAIN = 1 / (ASH * 3 * STEADY);
const MAX_EMBERS = 1.5;
const MAX_DRAW = 1.5;
/** Seconds a tender takes to lay a fresh log once one is due, and the flames below which one is. */
const TEND_DELAY: readonly [number, number] = [3, 10];
const TEND_LOW = 0.3;

/** The flames of a log with `mass` of its wood left, caught `lit`: its surface, less once only charcoal is left. */
function flames(mass: number, lit: number): number {
  const volatiles = clamp((mass - CHARCOAL) / (1 - CHARCOAL), 0, 1);
  return lit * Math.pow(mass, 2 / 3) * (CHAR_FLAME + (1 - CHAR_FLAME) * volatiles);
}

export class FuelError extends Error {}

/** One log as the scene draws it. */
export interface FuelLog {
  /** Wood left: 1 fresh .. 0 gone (nothing to draw). */
  readonly mass: number;
  /** How far it has caught: 0 just laid on .. 1 flaming. */
  readonly lit: number;
  /** Char on its surface: 0 bark .. 1 black and crazed. */
  readonly char: number;
  /** How far it has slumped into the bed, 0..1. */
  readonly settle: number;
  /** Being laid on: 0 still in the hand .. 1 resting. */
  readonly placed: number;
}

interface Log {
  mass: number;
  lit: number;
  char: number;
  settle: number;
  placed: number;
  slumps: number;
  thresholds: number[];
}

export class FuelBed {
  readonly #logs: Log[];
  readonly #random: Random;
  #embers = 0;
  #burst = 0;
  readonly #seed: number;
  #clock = 0;
  #tendAt = Number.POSITIVE_INFINITY;

  constructor(slots: number, seed: number) {
    if (!(Number.isInteger(slots) && slots >= 1))
      throw new FuelError(`a fuel bed needs a whole number of log slots ≥ 1, got ${slots}`);
    this.#seed = seed;
    this.#random = new Random(seed);
    this.#logs = Array.from({ length: slots }, () => ({
      mass: 0,
      lit: 0,
      char: 0,
      settle: 0,
      placed: 1,
      slumps: 0,
      thresholds: SLUMPS.slice(),
    }));
  }

  /** The log slots, in the order the bed was built with; read them, don't keep them. */
  get logs(): readonly FuelLog[] {
    return this.#logs;
  }

  /** The flames, relative to a fire opened on STEADY_FIRE (1); 0 once nothing flames. */
  get heat(): number {
    return this.#flames() / STEADY_FLAME;
  }

  get embers(): number {
    return this.#embers;
  }

  get smoke(): number {
    let fresh = 0;
    for (const log of this.#logs) fresh += log.mass * (1 - log.lit) * log.placed;
    return clamp(fresh + 0.35 * this.#embers * (1 - Math.min(this.heat, 1)), 0, 1);
  }

  get burst(): number {
    return this.#burst;
  }

  /**
   * A fire under way: log i has `masses[i]` of its wood left (0 for an empty slot), has been
   * flaming all along and is charred and slumped to match, over a coal bed in step with them. The
   * same masses open the same fire every time (the seed restarts).
   */
  open(masses: readonly number[]): void {
    this.#random.seed(this.#seed);
    let surface = 0;
    for (const [i, log] of this.#logs.entries()) {
      const mass = clamp(masses[i] ?? 0, 0, 1);
      this.#lay(log);
      log.placed = 1;
      if (mass < GONE) {
        log.mass = 0;
        log.lit = 0;
        continue;
      }
      log.mass = mass;
      log.lit = 1;
      // Burnt for 1 - m^(1/3) burnTimes, flaming all the while.
      log.char = 1 - Math.exp(-(1 - Math.cbrt(mass)) / CHAR);
      this.#slump(log, true);
      surface += Math.pow(mass, 2 / 3);
    }
    this.#embers = Math.min(MAX_EMBERS, EMBER_GAIN * ASH * 3 * surface);
    this.#burst = 0;
    this.#tendAt = Number.POSITIVE_INFINITY;
  }

  /** Lay a fresh log at once on the slot with least wood left, its stub pushed into the coals. */
  addLog(): void {
    let slot: Log | undefined;
    for (const log of this.#logs) if (!slot || log.mass < slot.mass) slot = log;
    if (!slot) return;
    this.#embers = Math.min(MAX_EMBERS, this.#embers + EMBER_GAIN * slot.mass);
    this.#lay(slot);
    this.#tendAt = Number.POSITIVE_INFINITY;
  }

  /** Advance `dt` seconds (motion time) with logs that burn away in `burnTime` seconds. */
  step(dt: number, burnTime: number, tend: boolean): void {
    if (!(dt > 0)) return;
    const time = Math.max(burnTime, 1);
    this.#clock += dt;
    this.#burst *= Math.exp(-dt / BURST_SECONDS);
    const embers = this.#embers;
    const fire = this.#flames();
    let burnt = 0;
    let empty = false;
    let catching = false;
    for (const log of this.#logs) {
      if (log.mass <= 0) {
        empty = true;
        continue;
      }
      if (log.placed < 1) {
        log.placed = Math.min(1, log.placed + dt / PLACE_SECONDS);
        if (log.placed >= 1) this.#burst = Math.max(this.#burst, LANDING_BURST);
        catching = true;
        continue;
      }
      if (log.lit < 0.5) catching = true;
      // Caught from the coals and the other logs' flames.
      const draw = Math.min(MAX_DRAW, embers + (fire - flames(log.mass, log.lit)) / STEADY_FLAME);
      log.lit += (1 - log.lit) * (1 - Math.exp(-(draw * dt) / (CATCH * time)));
      const loss = Math.min(log.mass, (3 * log.lit * Math.pow(log.mass, 2 / 3) * dt) / time);
      log.mass -= loss;
      burnt += loss;
      log.char += (1 - log.char) * (1 - Math.exp(-(log.lit * dt) / (CHAR * time)));
      this.#slump(log, false);
      log.settle += (log.slumps / SLUMPS.length - log.settle) * (1 - Math.exp(-dt / SLUMP_SECONDS));
      if (log.mass < GONE) {
        burnt += log.mass;
        log.mass = 0;
        log.lit = 0;
        empty = true;
      }
    }
    this.#embers = Math.min(MAX_EMBERS, embers * Math.exp(-dt / (ASH * time)) + EMBER_GAIN * burnt);
    // A tender lays a log when one has burnt away or the flames run low, but not while the last one
    // is still catching.
    const due = tend && !catching && (empty || this.heat < TEND_LOW);
    if (!due) {
      this.#tendAt = Number.POSITIVE_INFINITY;
    } else if (this.#tendAt === Number.POSITIVE_INFINITY) {
      this.#tendAt = this.#clock + this.#random.range(TEND_DELAY[0], TEND_DELAY[1]);
    } else if (this.#clock >= this.#tendAt) {
      this.addLog();
    }
  }

  /** The flames of the logs resting in the bed. */
  #flames(): number {
    let sum = 0;
    for (const log of this.#logs)
      if (log.mass > 0 && log.placed >= 1) sum += flames(log.mass, log.lit);
    return sum;
  }

  /** A fresh log in `log`'s slot, its slump thresholds drawn. */
  #lay(log: Log): void {
    log.mass = 1;
    log.lit = 0;
    log.char = 0;
    log.settle = 0;
    log.placed = 0;
    log.slumps = 0;
    for (const [k, at] of SLUMPS.entries())
      log.thresholds[k] = at + this.#random.range(-SLUMP_JITTER, SLUMP_JITTER);
  }

  /** Count the slumps the log has burnt past: each new one bursts sparks (`settled`: all at once, quietly). */
  #slump(log: Log, settled: boolean): void {
    const gone = 1 - log.mass;
    while (log.slumps < log.thresholds.length && gone >= (log.thresholds[log.slumps] ?? 1)) {
      log.slumps++;
      if (!settled) this.#burst = 1;
    }
    if (settled) log.settle = log.slumps / SLUMPS.length;
  }
}
