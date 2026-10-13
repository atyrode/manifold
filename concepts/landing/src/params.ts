// Knob builders for scene modules (see scenes/README.md). A scene's `params` order is the index into
// the shader's `uParams` array: new scenes read knobs through the generated `K_<key>` defines, the
// first five index `uParams` by hand, so their lists only ever grow at the end.
//
// Kinds:
//   range    a slider
//   toggle   a switch; the shader reads 0/1
//   feature  a switch plus its amount (slider, or segments when `options` is set); the shader reads
//            the amount while on and 0 while off. URL keys: `key` (0/1) and `key-amount`.
//   choice   segmented buttons; the shader reads the chosen value
//   seed     an arrangement number with a "re-seed" button; the shader reads it
//
// Reading knobs back in TS: a sim uses a KnobReader (slots resolved once, by key), a page theme or
// other one-off reader uses knobValue; both read what the shader reads (see `effective`).
import type { SimFrame } from "./scenes/types.ts";

interface Base {
  key: string;
  label: string;
  /** Shown on hover/focus of the control's "?". */
  help: string;
  /** Lab section heading. */
  group: string;
  /** Only shown while this toggle or feature (same scene) is on. */
  when?: string;
  /** Slot in the shader's `uTriggers`: adds a "now" button that fires one occurrence at once. */
  trigger?: number;
  /** Shuffle leaves this knob alone (framing that would otherwise lose the subject). */
  steady?: boolean;
}

export interface Option {
  label: string;
  value: number;
}

export type ParamDef =
  | (Base & { kind: "range"; min: number; max: number; step: number; value: number })
  | (Base & { kind: "toggle"; value: number })
  | (Base & { kind: "feature"; on: boolean; amountLabel: string; min: number; max: number; step: number; value: number; options?: readonly Option[] })
  | (Base & { kind: "choice"; options: readonly Option[]; value: number })
  | (Base & { kind: "seed"; value: number });

/** Largest arrangement number a seed knob can hold. */
export const MAX_SEED = 999;

/** Must match `MAX_PARAMS` / `MAX_TRIGGERS` in the fragment shader. */
export const MAX_PARAMS = 64;
export const MAX_TRIGGERS = 8;

interface Extra { when?: string; trigger?: number; steady?: boolean }
const extra = (options: Extra) => ({
  ...(options.when === undefined ? {} : { when: options.when }),
  ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
  ...(options.steady === undefined ? {} : { steady: options.steady }),
});

export const range = (group: string, key: string, label: string, value: number, help: string, options: Extra & { min?: number; max?: number; step?: number } = {}): ParamDef => ({
  kind: "range", group, key, label, value, help,
  min: options.min ?? 0, max: options.max ?? 1, step: options.step ?? 0.05, ...extra(options),
});

export const toggle = (group: string, key: string, label: string, on: boolean, help: string, options: Extra = {}): ParamDef => ({
  kind: "toggle", group, key, label, value: on ? 1 : 0, help, ...extra(options),
});

export const feature = (
  group: string, key: string, label: string, on: boolean, amountLabel: string, value: number, help: string,
  options: Extra & { min?: number; max?: number; step?: number; options?: readonly Option[] } = {},
): ParamDef => ({
  kind: "feature", group, key, label, on, amountLabel, value, help,
  // Segmented amounts take their bounds from the choices, so counts like 8 survive URL parsing.
  min: options.options ? Math.min(...options.options.map((option) => option.value)) : options.min ?? 0.05,
  max: options.options ? Math.max(...options.options.map((option) => option.value)) : options.max ?? 1,
  step: options.step ?? 0.05,
  ...(options.options === undefined ? {} : { options: options.options }),
  ...extra(options),
});

export const choice = (group: string, key: string, label: string, options: readonly Option[], value: number, help: string, more: Extra = {}): ParamDef => ({
  kind: "choice", group, key, label, options, value, help, ...extra(more),
});

export const seed = (group: string, key: string, label: string, help: string, more: Extra = {}): ParamDef => ({
  kind: "seed", group, key, label, value: 0, help, ...extra(more),
});

export const counts = (...values: number[]): Option[] => values.map((value) => ({ label: String(value), value }));

/** The value a knob hands to the shader. */
export function effective(def: ParamDef, params: Record<string, number>): number {
  const value = params[def.key] ?? (def.kind === "feature" ? (def.on ? 1 : 0) : def.value);
  if (def.kind !== "feature") return value;
  return value > 0.5 ? (params[`${def.key}-amount`] ?? def.value) : 0;
}

/** A title and one-line description: lab section headings (SceneDef.groups). */
export interface Blurb {
  title: string;
  blurb: string;
}

/** How a knob's value reads in the lab. */
export function formatValue(def: ParamDef, value: number): string {
  if (def.kind === "toggle") return value > 0.5 ? "on" : "off";
  if (def.kind === "seed") return `#${Math.round(value)}`;
  const step = def.kind === "range" || def.kind === "feature" ? def.step : 1;
  if (step >= 1) return String(Math.round(value));
  const min = def.kind === "range" || def.kind === "feature" ? def.min : 0;
  const max = def.kind === "range" || def.kind === "feature" ? def.max : 1;
  if (min >= 0 && max <= 1) return `${Math.round(value * 100)}%`;
  return value.toFixed(2);
}

/** A knob the scene lacks, a trigger slot a knob lacks, or a key a KnobReader was not built with. */
export class KnobError extends Error {}

/** The scene's knob `key`; throws KnobError "<owner>: the scene has no '<key>' knob". */
export function knobDef(owner: string, params: readonly ParamDef[], key: string): ParamDef {
  const def = params.find((candidate) => candidate.key === key);
  if (def === undefined) throw new KnobError(`${owner}: the scene has no '${key}' knob`);
  return def;
}

/**
 * Knob `key` as the shader reads it, from raw knobs keyed as in the URL (what `SceneDef.theme`
 * receives): `effective` looked up by key. Throws KnobError for a key the scene lacks.
 */
export function knobValue(params: readonly ParamDef[], values: Readonly<Record<string, number>>, key: string): number {
  return effective(knobDef("knobValue", params, key), values);
}

/** One knob's place in the scene, resolved once by KnobReader. */
interface KnobSlot {
  /** Position in the scene's `params`, so in `SimFrame.values` and `uParams`. */
  readonly index: number;
  readonly def: ParamDef;
  /** A feature's `<key>-amount` URL key; undefined for every other kind. */
  readonly amountKey: string | undefined;
  /** What the shader reads at the scene's defaults: effective(def, {}). */
  readonly initial: number;
}

/**
 * A sim's knobs by key, through their slots in the scene's `params`, resolved once in the
 * constructor (which throws KnobError "<owner>: the scene has no '<key>' knob").
 *
 * Fallbacks, one rule: the renderer hands every knob over each frame (state.ts `readParams` fills
 * them all), so a fallback only makes a read total. A read falls back to what the shader sees at the
 * scene's defaults, `effective(def, {})`: a feature that starts off reads 0, one that starts on its
 * default amount, any other knob its default value. `amount` falls back to the feature's default
 * amount, on or off. `knobValue` follows the same rule through `effective`.
 *
 * Usage:
 *   type Knob = "speed" | "palette" | "mark";
 *   readonly #knobs = new KnobReader<Knob>("pond", params, ["speed", "palette", "mark"]);
 *   const speed = this.#knobs.value(frame, "speed");
 *   const palette = this.#knobs.pick(frame, "palette", POND_PALETTES, POND_DEFAULT_PALETTE);
 *   const markSlot = this.#knobs.trigger("mark"); // index into frame.triggers
 *   this.#startMark(this.#knobs.amount(frame, "mark")); // the M's size even while the feature is off
 */
export class KnobReader<K extends string> {
  readonly #owner: string;
  readonly #slots: ReadonlyMap<K, KnobSlot>;

  constructor(owner: string, params: readonly ParamDef[], keys: readonly K[]) {
    const slots = new Map<K, KnobSlot>();
    for (const key of keys) {
      const index = params.findIndex((def) => def.key === key);
      const def = params[index];
      if (def === undefined) throw new KnobError(`${owner}: the scene has no '${key}' knob`);
      slots.set(key, { index, def, amountKey: def.kind === "feature" ? `${key}-amount` : undefined, initial: effective(def, {}) });
    }
    this.#owner = owner;
    this.#slots = slots;
  }

  /** The knob as the shader sees it (`frame.values`): a feature reads its amount while on, 0 while off. */
  value(frame: SimFrame, key: K): number {
    const slot = this.#slot(key);
    return frame.values[slot.index] ?? slot.initial;
  }

  /** A feature's amount even while it is off (its "now" button still plays one); any other knob's value. */
  amount(frame: SimFrame, key: K): number {
    const slot = this.#slot(key);
    if (slot.amountKey === undefined) return frame.values[slot.index] ?? slot.initial;
    return frame.params[slot.amountKey] ?? slot.def.value;
  }

  /** What `value` reads at the scene's defaults, for a constructor that runs before the first frame. */
  initial(key: K): number {
    return this.#slot(key).initial;
  }

  /** The knob's slot in `frame.triggers` (its "now" button); throws KnobError if it has none. */
  trigger(key: K): number {
    const trigger = this.#slot(key).def.trigger;
    if (trigger === undefined) throw new KnobError(`${this.#owner}: the '${key}' knob has no trigger slot`);
    return trigger;
  }

  /** A choice knob's entry: list[round(value)], or `fallback` when the list has no such entry. */
  pick<T>(frame: SimFrame, key: K, list: readonly T[], fallback: T): T {
    return list[Math.round(this.value(frame, key))] ?? fallback;
  }

  #slot(key: K): KnobSlot {
    const slot = this.#slots.get(key);
    if (slot === undefined) throw new KnobError(`${this.#owner}: '${key}' is not one of the knobs this reader was built with`);
    return slot;
  }
}
