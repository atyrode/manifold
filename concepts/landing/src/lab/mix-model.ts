// The mix bar's model (mix.ts), apart from its DOM: which parts are in, their weights and spans along
// the bar, and the knob patches its gestures make. A part is a range, out while its weight is zero,
// or a feature, out while it is off: its amount is its weight while it is on and keeps its value
// while it is off, so switching it back on brings its share back. The widget never leaves a feature
// on at zero weight (a drag or key that takes it there switches it off instead); a URL may, and such
// a part takes no share until it is given some.
import { snap } from "./dom.ts";
import type { FeatureDef, RangeDef } from "./knobs.ts";

export interface MixPart {
  def: RangeDef | FeatureDef;
  /** Its name on the bar, in the legend and on its chip. */
  part: string;
  /** Its colour on the bar (a CSS colour). */
  swatch: string;
}

/** A knob value by URL key, its default while unset (Knobs.value, Knobs.default). */
export type Read = (key: string) => number;

/** Knob values by URL key, as Knobs.set takes them. */
export type KnobPatch = Record<string, number>;

/** The URL key holding a part's weight: a range's own, a feature's amount. */
export function weightKey(def: MixPart["def"]): string {
  return def.kind === "feature" ? `${def.key}-amount` : def.key;
}

/** Whether a part may take share: a feature while on, a range always (zero weight leaves it out). */
export function switchedOn(part: MixPart, read: Read): boolean {
  return part.def.kind !== "feature" || read(part.def.key) > 0.5;
}

/** A part's weight as the scene reads it (`effective`): a feature's amount while on, 0 while off. */
export function weightOf(part: MixPart, read: Read): number {
  return switchedOn(part, read) ? read(weightKey(part.def)) : 0;
}

export function totalWeight(parts: readonly MixPart[], read: Read): number {
  return parts.reduce((sum, part) => sum + weightOf(part, read), 0);
}

/** A part's share of the mix, 0..1; 0 for every part while all weights are zero. */
export function shareOf(part: MixPart, parts: readonly MixPart[], read: Read): number {
  const sum = totalWeight(parts, read);
  return sum > 0 ? weightOf(part, read) / sum : 0;
}

/** A part's segment along the bar, as fractions of its width. */
export interface Span {
  part: MixPart;
  start: number;
  end: number;
}

/** The parts with weight, in order, as spans of the bar; `held` parts stay in even at zero width. */
export function spans(
  parts: readonly MixPart[],
  read: Read,
  held: readonly MixPart[] = [],
): Span[] {
  const sum = totalWeight(parts, read);
  let start = 0;
  return parts
    .map((part) => {
      const width = sum > 0 ? weightOf(part, read) / sum : 0;
      const span = { part, start, end: start + width };
      start += width;
      return span;
    })
    .filter((span) => span.end > span.start || held.includes(span.part));
}

/** A drag of one divider, from the weights when it began. */
export interface DividerDrag {
  /** The two parts beside the divider: drawn even at zero weight until it is let go. */
  readonly held: readonly MixPart[];
  /** The patch with the divider at `at`, a fraction of the bar's width. */
  at(at: number): KnobPatch;
  /**
   * What to commit when it is let go at the patch `at` last made: that patch, except that a feature
   * the drag took to zero switches off and keeps the amount it had, so its chip brings it back.
   */
  release(last: KnobPatch): KnobPatch;
}

/**
 * Drag divider `index` (between the spans `index` and `index + 1`): the two parts beside it trade
 * share at the pointer and every other part keeps its share. Their weights keep their sum while both
 * fit under their maximum; past it every weight scales down together, so the shares still come out
 * as dragged. Each patch writes the weight of every part that is switched on, and leaves the parts
 * that are off (and their stored amounts) alone. Undefined when the divider has no part on a side.
 */
export function dividerDrag(
  parts: readonly MixPart[],
  read: Read,
  index: number,
): DividerDrag | undefined {
  const shown = spans(parts, read);
  const left = shown[index];
  const right = shown[index + 1];
  if (!left || !right) return undefined;
  const start = new Map(parts.map((part) => [part, weightOf(part, read)]));
  const sum = totalWeight(parts, read);
  const on = parts.filter((part) => switchedOn(part, read));
  return {
    held: [left.part, right.part],
    at: (at) => {
      const into = Math.min(right.end, Math.max(left.start, at));
      const next = new Map(start);
      next.set(left.part, (into - left.start) * sum);
      next.set(right.part, (right.end - into) * sum);
      const over = Math.max(...parts.map((part) => (next.get(part) ?? 0) / part.def.max));
      const scale = over > 1 ? 1 / over : 1;
      return Object.fromEntries(
        on.map((part) => {
          const { min, max, step } = part.def;
          return [weightKey(part.def), snap((next.get(part) ?? 0) * scale, min, max, step)];
        }),
      );
    },
    release: (last) => {
      const patch = { ...last };
      for (const part of on) {
        const was = start.get(part) ?? 0;
        const key = weightKey(part.def);
        if (part.def.kind !== "feature" || was <= 0 || (patch[key] ?? was) > 0) continue;
        patch[part.def.key] = 0;
        patch[key] = was;
      }
      return patch;
    },
  };
}

/** The weight a part comes in with: the mean of the parts in, or half its range while none is. */
function evenWeight(part: MixPart, parts: readonly MixPart[], read: Read): number {
  const { min, max, step } = part.def;
  const others = parts.map((other) => weightOf(other, read)).filter((weight) => weight > 0);
  const mean = others.length > 0 ? others.reduce((a, b) => a + b, 0) / others.length : max / 2;
  return snap(mean, min, max, step);
}

/**
 * Take a part out of the mix or bring it in. A range leaves at its minimum and comes back with an
 * even weight (`evenWeight`). A feature (its chip) switches off with its amount kept and comes back
 * on with that amount; an amount of zero (only a URL leaves one) comes back as its default, or an
 * even weight when that is zero too, so the part never comes on without share.
 */
export function toggleIn(
  part: MixPart,
  parts: readonly MixPart[],
  read: Read,
  defaults: Read,
): KnobPatch {
  const { def } = part;
  if (def.kind === "range")
    return { [def.key]: weightOf(part, read) > 0 ? def.min : evenWeight(part, parts, read) };
  if (switchedOn(part, read)) return { [def.key]: 0 };
  const key = weightKey(def);
  if (read(key) > 0) return { [def.key]: 1 };
  const fallback = defaults(key);
  return { [def.key]: 1, [key]: fallback > 0 ? fallback : evenWeight(part, parts, read) };
}

/** A part's weight set outright (the legend's keys), snapped; a feature set to zero switches off. */
export function setWeight(part: MixPart, value: number): KnobPatch {
  const { def } = part;
  const next = snap(value, def.min, def.max, def.step);
  return def.kind === "feature" && next <= 0 ? { [def.key]: 0 } : { [weightKey(def)]: next };
}
