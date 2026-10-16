// The Night sky section's model (nightsky.ts), apart from its DOM: the parts a group holds (knobs
// tagged `night`), how each reads and is drawn at its setting (the moon's phase among the drawn
// moons, how many stars, streaks and planets are out), what a click on a drawn part does, and what
// "See it at night" sets. A part is the stars' density (a range, always out) or a sky component that
// switches (a feature): on or off, with an amount it keeps while off.
import { formatValue, type ParamDef } from "../params.ts";
import { snap } from "./dom.ts";
import type { FeatureDef, RangeDef } from "./knobs.ts";

export type NightPartName =
  "moon" | "stars" | "milkyWay" | "constellations" | "planets" | "aurora" | "meteors";

/** A part of the night sky: the stars' density, or a sky component that switches. */
export type NightPart =
  { name: "stars"; def: RangeDef } | { name: Exclude<NightPartName, "stars">; def: FeatureDef };

/** A part as the URL holds it: on (the stars always are) and its amount (the stars' density). */
export interface PartState {
  on: boolean;
  amount: number;
}

export type Patch = Record<string, number>;

/**
 * The section's order: the moon (its own row of phases), then the chips two by two: the stars and
 * the Milky Way, the figures and planets among them, then what comes and goes, the aurora and
 * shooting stars.
 */
const ORDER: readonly NightPartName[] = [
  "moon",
  "stars",
  "milkyWay",
  "constellations",
  "planets",
  "aurora",
  "meteors",
];

/**
 * The night parts among `defs`, in the section's order: the first knob tagged with each part's
 * name, the stars only as a range and the others only as features.
 */
export function nightParts(defs: readonly ParamDef[]): NightPart[] {
  return ORDER.flatMap((name): NightPart[] => {
    const def = defs.find((each) => each.widget?.kind === "night" && each.widget.part === name);
    if (name === "stars") return def?.kind === "range" ? [{ name, def }] : [];
    return def?.kind === "feature" ? [{ name, def }] : [];
  });
}

/** The URL key holding a part's amount: the stars' own, a feature's `<key>-amount`. */
export function amountKey(part: NightPart): string {
  return part.name === "stars" ? part.def.key : `${part.def.key}-amount`;
}

/** Where `amount` stands between a knob's least and most, 0..1. */
export function shareOf(def: { min: number; max: number }, amount: number): number {
  return Math.min(1, Math.max(0, (amount - def.min) / (def.max - def.min)));
}

/** Whether a part shows in the night sky: a feature while on, the stars above none. */
export function partShows(part: NightPart, state: PartState): boolean {
  return part.name === "stars" ? state.amount > part.def.min : state.on;
}

/** A click on a drawn part: a feature switches on or off and keeps its amount; the stars take none. */
export function clickPatch(part: NightPart, state: PartState): Patch | undefined {
  return part.name === "stars" ? undefined : { [part.def.key]: state.on ? 0 : 1 };
}

// ---- the moon -------------------------------------------------------------------------------

/**
 * The moon's phases as the section draws them, left to right: each sets its lit share, and stands
 * for the shares below `below` (and from the one before's): a slimmer moon than a quarter is a
 * crescent, a fuller one gibbous, and from 0.92 the moon reads as full.
 */
export const MOON_PHASES = [
  { name: "crescent", lit: 0.25, below: 0.4 },
  { name: "quarter", lit: 0.5, below: 0.6 },
  { name: "gibbous", lit: 0.75, below: 0.92 },
  { name: "full", lit: 1, below: Infinity },
] as const;

/** The phase (an index into MOON_PHASES) a lit share reads as. */
export function phaseIndex(lit: number): number {
  const index = MOON_PHASES.findIndex((phase) => lit < phase.below);
  return index < 0 ? MOON_PHASES.length - 1 : index;
}

/** The moon's look at a lit share: "thin crescent", "crescent", "quarter moon", "gibbous", "full moon". */
export function phaseOf(lit: number): string {
  if (lit < 0.15) return "thin crescent";
  const { name } = MOON_PHASES[phaseIndex(lit)] ?? MOON_PHASES[0];
  return name === "quarter" || name === "full" ? `${name} moon` : name;
}

/**
 * The moon set to a phase (an index into MOON_PHASES), switched on with its lit share snapped into
 * the knob's range; undefined puts the moon out and keeps its phase.
 */
export function moonPatch(def: FeatureDef, phase: number | undefined): Patch {
  const chosen = phase === undefined ? undefined : MOON_PHASES[phase];
  if (!chosen) return { [def.key]: 0 };
  return { [def.key]: 1, [`${def.key}-amount`]: snap(chosen.lit, def.min, def.max, def.step) };
}

/** A disc of radius r centred on 0, lit over `lit` of it from the right, the terminator an ellipse. */
export function moonPath(r: number, lit: number): string {
  if (lit >= 0.995) return `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}Z`;
  const rx = Math.abs(1 - 2 * Math.max(0, lit)) * r;
  return `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${lit > 0.5 ? 1 : 0} 0 ${-r}Z`;
}

// ---- what the drawing shows -------------------------------------------------------------------

/** A star in the drawn sky: across (0..1), down the sky above the ground (0..1) and size (0..1). */
export interface SkyStar {
  x: number;
  y: number;
  size: number;
}

const fract = (value: number) => value - Math.floor(value);

/**
 * The drawn sky's stars in the order they come out as the density rises: an R2 sequence, so the
 * first few already spread over the whole sky and each next one fills a gap.
 */
export const NIGHT_STARS: readonly SkyStar[] = Array.from({ length: 52 }, (_, n) => ({
  x: fract(0.5 + n * 0.7548776662466927),
  y: fract(0.5 + n * 0.5698402909980532),
  size: fract(Math.sin(n * 91.7 + 13.1) * 43758.5453),
}));

/** How many of `count` stars are out at a density share 0..1 (clamped): none at 0, all at 1. */
export function starsOut(share: number, count: number = NIGHT_STARS.length): number {
  return Math.round(Math.min(1, Math.max(0, share)) * count);
}

/**
 * How many streaks the shooting stars draw at a frequency share 0..1: none while off, one at the
 * least, a second from a third of the way up and a third from two thirds.
 */
export function streaksOf(on: boolean, share: number): number {
  if (!on) return 0;
  return 1 + (share >= 1 / 3 ? 1 : 0) + (share >= 2 / 3 ? 1 : 0);
}

/** The naked-eye planets, brightest first: the planets knob's amount is how many of them show. */
export const PLANETS = ["Venus", "Jupiter", "Saturn", "Mars", "Mercury"] as const;

/** How many planets an amount names (rounded, within the five), whether or not they are on. */
export function planetCount(amount: number): number {
  return Math.min(PLANETS.length, Math.max(0, Math.round(amount)));
}

// ---- words ----------------------------------------------------------------------------------

/**
 * A part's state in words: the moon's phase, how many planets, the others' amount ("60%", "1.00");
 * "off" while off.
 */
export function partValue(part: NightPart, state: PartState): string {
  if (!state.on) return "off";
  if (part.name === "moon") return phaseOf(state.amount);
  if (part.name === "planets") {
    const count = planetCount(state.amount);
    return count === 1 ? "1 planet" : `${count} planets`;
  }
  return formatValue(part.def, state.amount);
}

/**
 * The section at rest in words: a section of one part as that part's value; otherwise how many of
 * its parts show ("4 of 7 out"), the stars counting while any are out.
 */
export function nightSummary(
  parts: readonly NightPart[],
  stateOf: (part: NightPart) => PartState,
): string {
  const [only] = parts;
  if (parts.length === 1 && only) return partValue(only, stateOf(only));
  const out = parts.filter((part) => partShows(part, stateOf(part))).length;
  return `${out} of ${parts.length} out`;
}

// ---- "See it at night" ------------------------------------------------------------------------

/** The time of day "See it at night" sets: late evening, the sky dark and the moon well up. */
export const NIGHT_TIME = 0.95;

/** Whether a time of day (0 midnight, 0.5 noon) falls in the night: past dusk, before dawn. */
export function isNight(time: number): boolean {
  const t = fract(time);
  return t < 0.2 || t >= 0.81;
}

/** The scene's clock: its time of day, and the day cycle that carries it round, if any. */
export interface NightClock {
  time: RangeDef;
  cycle: FeatureDef | undefined;
}

/**
 * What "See it at night" sets, as one change: the time of day at NIGHT_TIME, with the day cycle
 * stopped so the night holds. Undefined while the clock already stands still at night.
 */
export function nightPatch(clock: NightClock, time: number, cycling: boolean): Patch | undefined {
  if (isNight(time) && !cycling) return undefined;
  const { time: def, cycle } = clock;
  return {
    [def.key]: snap(NIGHT_TIME, def.min, def.max, def.step),
    ...(cycle && cycling ? { [cycle.key]: 0 } : {}),
  };
}
