// The Controls view's "changed" lens, apart from its DOM: which URL keys differ from their defaults
// (a scene's knobs against its knob defaults, as Knobs.modified compares them; the global groups'
// settings against the scene's `defaultsFor`, as their resets do), how many knobs of each group
// changed, and which controls and groups show under the lens and the search together.
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

/** What narrows the controls: the search's words (trimmed, lower case; empty for none) and the lens. */
export interface LensQuery {
  text: string;
  lens: boolean;
  /** The URL keys that differ from their defaults. */
  changed: ReadonlySet<string>;
}

/** A control as the search and the lens see it. */
export interface LensItem {
  /** Its words (`data-search`). */
  search: string;
  /** The URL keys of the knobs it holds (`data-keys`): a widget of several knobs, all of theirs. */
  keys: readonly string[];
  /** In hand (it holds the focus): it stays under the lens while it is used, back at its default or not. */
  held: boolean;
}

/** Whether a group's title holds the search's words. */
export function titleHolds(title: string, query: LensQuery): boolean {
  return query.text !== "" && title.includes(query.text);
}

/**
 * Whether a control shows: its words, or its group's title (`titleHit`), hold the search's; and
 * under the lens, one of its knobs changed or it is in hand.
 */
export function itemShows(item: LensItem, titleHit: boolean, query: LensQuery): boolean {
  const found = query.text === "" || titleHit || item.search.includes(query.text);
  return found && (!query.lens || item.held || item.keys.some((key) => query.changed.has(key)));
}

/**
 * Whether a group shows with `shown` of its controls showing: every group while nothing narrows
 * them, under the search alone also one whose title holds the words, under the lens only one with a
 * control to show.
 */
export function groupShows(shown: number, titleHit: boolean, query: LensQuery): boolean {
  if (query.lens) return shown > 0;
  return query.text === "" || shown > 0 || titleHit;
}
