// The night strip's model (nightsky.ts), apart from its DOM: the parts a group holds (knobs tagged
// `night`), where the strip's stars stand and how many are out at a density, how many streaks the
// shooting stars draw, and what a click, a drag or a key does to a part. A part is the stars'
// density (a range, always out) or a sky component that switches (a feature): on or off, with an
// amount it keeps while off.
import { formatValue, type ParamDef } from "../params.ts";
import { snap } from "./dom.ts";
import type { FeatureDef, RangeDef } from "./knobs.ts";

export type NightPartName = "stars" | "milkyWay" | "meteors" | "aurora";

/** A part of the strip: the stars' density, or a sky component that switches. */
export type NightPart =
  { name: "stars"; def: RangeDef } | { name: Exclude<NightPartName, "stars">; def: FeatureDef };

/** A part as the URL holds it: on (the stars always are) and its amount (the stars' density). */
export interface PartState {
  on: boolean;
  amount: number;
}

export type Patch = Record<string, number>;

/**
 * The strip's order: the sky the stars fill, then left to right the aurora low over the horizon,
 * the Milky Way rising through the middle and the shooting stars on the right.
 */
const ORDER: readonly NightPartName[] = ["stars", "aurora", "milkyWay", "meteors"];

/**
 * The night parts among `defs`, in the strip's order: the first knob tagged with each part's name,
 * the stars only as a range and the others only as features.
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

/** A part at `amount`, clamped and snapped; a feature switched on with it. */
function amountPatch(part: NightPart, amount: number): Patch {
  const { def } = part;
  const value = snap(amount, def.min, def.max, def.step);
  return part.name === "stars" ? { [def.key]: value } : { [def.key]: 1, [amountKey(part)]: value };
}

/** A click on a part: a feature switches on or off and keeps its amount; the stars take none. */
export function clickPatch(part: NightPart, state: PartState): Patch | undefined {
  return part.name === "stars" ? undefined : { [part.def.key]: state.on ? 0 : 1 };
}

/** Pixels of drag, right or up, across a part's whole span (left or down takes it back). */
export const DRAG_SPAN = 160;
/** A press that moves less than this many pixels is a click. */
export const CLICK_SLOP = 4;

/** Whether a press that moved (dx, dy) pixels is a drag rather than a click. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= CLICK_SLOP;
}

/**
 * A drag of (dx, dy) pixels (y down) on a part whose amount was `from`: the amount rises with right
 * and up and falls with left and down, the same either way, and a feature comes on with it.
 */
export function dragPatch(part: NightPart, from: number, dx: number, dy: number): Patch {
  const { def } = part;
  return amountPatch(part, from + ((dx - dy) / DRAG_SPAN) * (def.max - def.min));
}

/**
 * What a key does to a part; `step` is keyStep's change for it (undefined for keys that do not
 * step). Space and Enter switch a feature on or off; a step moves the amount, a feature that is off
 * coming on at the amount it had; Home and End take the amount to its ends, switching a feature on;
 * Delete and Backspace switch a feature off and put the stars out. Undefined for other keys.
 */
export function keyPatch(
  part: NightPart,
  state: PartState,
  key: string,
  step: number | undefined,
): Patch | undefined {
  const { def } = part;
  if (step !== undefined) return amountPatch(part, state.on ? state.amount + step : state.amount);
  switch (key) {
    case "Home":
      return amountPatch(part, def.min);
    case "End":
      return amountPatch(part, def.max);
    case " ":
    case "Enter":
      return clickPatch(part, state);
    case "Delete":
    case "Backspace":
      return part.name === "stars" ? { [def.key]: def.min } : { [def.key]: 0 };
    default:
      return undefined;
  }
}

/** A star on the strip: across (0..1), down the sky above the ground (0..1) and size (0..1). */
export interface StripStar {
  x: number;
  y: number;
  size: number;
}

const fract = (value: number) => value - Math.floor(value);

/**
 * The strip's stars in the order they come out as the density rises: an R2 sequence, so the first
 * few already spread over the whole sky and each next one fills a gap.
 */
export const NIGHT_STARS: readonly StripStar[] = Array.from({ length: 44 }, (_, n) => ({
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

/** A part's state in words: its amount ("60%", "1.00") while on, "off" while off. */
export function partValue(part: NightPart, state: PartState): string {
  return state.on ? formatValue(part.def, state.amount) : "off";
}

/** A part in words: "stars 60%", "Milky Way 1.00", "shooting stars off". */
export function partText(part: NightPart, state: PartState): string {
  return `${part.def.label} ${partValue(part, state)}`;
}

/**
 * The strip at rest in words: a strip of one part (named by its row) as its value alone; otherwise
 * the stars' density, then a lone switching part as itself or several as how many are on
 * ("stars 60% · 2 of 3 on").
 */
export function nightSummary(
  parts: readonly NightPart[],
  stateOf: (part: NightPart) => PartState,
): string {
  const [only] = parts;
  if (parts.length === 1 && only) return partValue(only, stateOf(only));
  const stars = parts.filter((part) => part.name === "stars");
  const switching = parts.filter((part) => part.name !== "stars");
  const lone = switching.length === 1 ? switching : [];
  const texts = [...stars, ...lone].map((part) => partText(part, stateOf(part)));
  if (switching.length > 1) {
    const on = switching.filter((part) => stateOf(part).on).length;
    texts.push(`${on} of ${switching.length} on`);
  }
  return texts.join(" · ");
}
