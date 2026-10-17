// The Controls view's one availability model, apart from its DOM: whether a control takes effect,
// and which controls show under the search and the "changed" lens (lens-model.ts finds what
// changed). A control that hangs on a switch (`when`) takes effect while that switch is on, and the
// switch's own `when` is on, and so on to any depth (switchChain). The view closes a control whose
// switches are off, unless the search or the lens finds it: then it shows dormant (dimmed, still in
// reach) together with the switches it waits on, so whatever the lens counts and the search finds is
// on screen, with why it does nothing yet (narrow). inspector.ts applies it; the widgets only mark
// what hangs on what (dom.ts `gate`).
import type { ParamDef } from "../params.ts";

/**
 * The switches a control hanging on `when` waits on, nearest first: `when`, that switch's own
 * `when`, and so on. A key of no knob (a planet's "!<key>", a global setting) ends the chain, and so
 * does a cycle. Empty for a control that hangs on nothing.
 */
export function switchChain(defs: readonly ParamDef[], when: string | undefined): string[] {
  const chain: string[] = [];
  for (let key = when; key !== undefined && !chain.includes(key);) {
    chain.push(key);
    const at = key;
    key = defs.find((def) => def.key === at)?.when;
  }
  return chain;
}

/** Whether a control waiting on `chain` takes effect: every switch of it on. */
export function available(chain: readonly string[], on: (key: string) => boolean): boolean {
  return chain.every(on);
}

/**
 * What is wrong with the `when`s of a scene's knobs, in words; none for a sound scene. Each must name
 * a toggle or a feature of the same scene, and no chain may loop: a `when` naming nothing would hide
 * its control for good.
 */
export function whenProblems(defs: readonly ParamDef[]): string[] {
  const problems: string[] = [];
  for (const def of defs) {
    if (def.when === undefined) continue;
    const target = defs.find((other) => other.key === def.when);
    if (!target) problems.push(`${def.key}: its when "${def.when}" names no knob`);
    else if (target.kind !== "toggle" && target.kind !== "feature")
      problems.push(`${def.key}: its when "${def.when}" is a ${target.kind}, not a switch`);
    const chain = switchChain(defs, def.when);
    const last = chain.at(-1);
    const next = defs.find((other) => other.key === last)?.when;
    if (chain.includes(def.key) || (next !== undefined && chain.includes(next)))
      problems.push(`${def.key}: its when loops (${[def.key, ...chain].join(" → ")})`);
  }
  return problems;
}

// ---- what shows under the search and the lens ---------------------------------------------------

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

/** Whether the search or the lens narrows the controls at all. */
export function narrowing(query: LensQuery): boolean {
  return query.text !== "" || query.lens;
}

/** Whether a group's title holds the search's words. */
export function titleHolds(title: string, query: LensQuery): boolean {
  return query.text !== "" && title.includes(query.text);
}

/**
 * Whether the search and the lens find a control: its words, or its group's title (`titleHit`),
 * hold the search's; and under the lens, one of its knobs changed or it is in hand.
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

/** Where a control hangs on switches (dom.ts `gate`), as the narrowing sees it. */
export interface LensGate {
  /** The URL keys of the switches it waits on, nearest first (switchChain). */
  chain: readonly string[];
  /** Whether they are all on: what it holds takes effect. */
  live: boolean;
}

/**
 * How a gate shows: open while live; dormant while not, but holding a control the search or the
 * lens finds (shown dimmed, still in reach); closed otherwise.
 */
export type GateState = "open" | "dormant" | "closed";

/** A control of a group with the gates it stands in, by index into the group's gates. */
export interface NarrowItem extends LensItem {
  gates: readonly number[];
}

/** A group narrowed: each control found or not, each gate's state, how many controls show. */
export interface Narrowed {
  /** Whether the search and the lens find each control, or it is a switch a dormant one waits on. */
  found: boolean[];
  gates: GateState[];
  /** The controls found that stand in no closed gate. */
  shown: number;
}

/**
 * Narrow a group's controls (`items`) and gates. A control is found by the search and the lens
 * (itemShows), or as a switch that a dormant control waits on: the control holding one of the keys
 * of a dormant gate's chain, so the reason it does nothing shows beside it. A gate is open while
 * live; while not, dormant if the search or the lens narrows and it holds a control found, closed
 * otherwise. Nothing narrowing, a gate that is not live is closed whatever it holds.
 */
export function narrow(
  items: readonly NarrowItem[],
  gates: readonly LensGate[],
  titleHit: boolean,
  query: LensQuery,
): Narrowed {
  const filtering = narrowing(query);
  const found = items.map((item) => itemShows(item, titleHit, query));
  if (filtering) {
    const waits = new Set<string>();
    items.forEach((item, at) => {
      if (!found[at]) return;
      for (const index of item.gates) {
        const gate = gates[index];
        if (gate && !gate.live) for (const key of gate.chain) waits.add(key);
      }
    });
    items.forEach((item, at) => {
      if (!found[at] && item.keys.some((key) => waits.has(key))) found[at] = true;
    });
  }
  const states = gates.map((gate, at): GateState => {
    if (gate.live) return "open";
    const holds = items.some((item, index) => found[index] && item.gates.includes(at));
    return filtering && holds ? "dormant" : "closed";
  });
  const shown = items.filter(
    (item, at) => found[at] && item.gates.every((gate) => states[gate] !== "closed"),
  ).length;
  return { found, gates: states, shown };
}

/**
 * The keys among `changed` held by the controls a narrowed group shows (found, and standing in no
 * closed gate): under a search, "Reset what changed" restores these and nothing it hides.
 */
export function shownChanges(
  items: readonly NarrowItem[],
  narrowed: Narrowed,
  changed: ReadonlySet<string>,
): string[] {
  return items.flatMap((item, at) =>
    narrowed.found[at] === true && item.gates.every((gate) => narrowed.gates[gate] !== "closed")
      ? item.keys.filter((key) => changed.has(key))
      : [],
  );
}
