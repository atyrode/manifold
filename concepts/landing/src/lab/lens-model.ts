// The Controls view's "changed" lens, apart from its DOM: which URL keys differ from their defaults
// (a scene's knobs against its knob defaults, as Knobs.modified compares them; the global groups'
// settings against the scene's `defaultsFor`, as their resets do) and how many knobs of each group
// changed. A knob counts whether or not it takes effect: one whose switch is off still rides the
// link, and shows dormant under the lens (availability-model.ts, which decides what shows).
import type { ParamDef } from "../params.ts";
import type { Params } from "../state.ts";
import { knobKeys } from "./knobs.ts";

/**
 * The URL keys of `defs` (a feature's amount too) whose values differ from their defaults; an unset
 * key reads its default.
 */
export function changedKnobs(
  defs: readonly ParamDef[],
  params: Readonly<Params>,
  defaults: Readonly<Params>,
): Set<string> {
  const changed = new Set<string>();
  for (const key of defs.flatMap(knobKeys))
    if ((params[key] ?? defaults[key] ?? 0) !== defaults[key]) changed.add(key);
  return changed;
}

/** The settings among `keys` whose values differ from `base`'s. */
export function changedSettings<K extends string>(
  keys: readonly K[],
  state: Readonly<Record<K, unknown>>,
  base: Readonly<Record<K, unknown>>,
): Set<string> {
  return new Set(keys.filter((key) => state[key] !== base[key]));
}

/** A group as the lens counts it: its knobs, each the URL keys it is stored under. */
export interface LensGroup {
  id: string;
  knobs: readonly (readonly string[])[];
}

/**
 * How many knobs of each group changed, a knob once however many of its keys did; a group with
 * none is left out.
 */
export function changedCounts(
  groups: readonly LensGroup[],
  changed: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const count = group.knobs.filter((keys) => keys.some((key) => changed.has(key))).length;
    if (count > 0) counts.set(group.id, count);
  }
  return counts;
}
