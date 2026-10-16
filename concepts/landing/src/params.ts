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
// Any knob may also name a purpose-built lab widget (`widget`, see `Widget`) and an icon (`icon`);
// both only change how the lab draws it, never its URL keys, values or defaults.
//
// Reading knobs back in TS: a sim uses a KnobReader (slots resolved once, by key), a page theme or
// other one-off reader uses knobValue; both read what the shader reads (see `effective`).
import type { IconName } from "./lab/icons.ts";
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
  /** A purpose-built lab widget for this knob (and the knobs it names). */
  widget?: Widget;
  /** The lab icon for its chip or heading; default: the first word of its key or label naming one. */
  icon?: IconName;
}

/**
 * How the lab draws a knob beyond its kind's own control (see "Lab widgets" in scenes/README.md):
 *   mix        one part of relative weights: a range, or a feature whose amount is the weight while
 *              it is on (a land use that may be left out: `min` 0, `max` 100, `step` 1); the group's
 *              knobs sharing `mix` (the bar's name) make one stacked bar, this knob its segment named
 *              `part`, coloured `swatch`, drawn while it is in (a range above zero, a feature while
 *              on); a feature part also gets an on/off chip, and keeps its amount while off
 *   sky        a part of the almanac (the sky dial): `time` the time of day (a range over 0..1, 0
 *              midnight), `cycle` the day cycle and `moon` the moon's phase (features), `season`
 *              where the year stands (see `SeasonYear`) and `year` the year's cycle (a feature); the
 *              dial stands where a group has a `time` part, gathering the scene's `season` and
 *              `year` parts from any group; without a `time` part the season parts make a season
 *              wheel in their own group and the others are plain controls
 *   direction  a signed strength (a range from below 0 to above 0), min to the left and max to
 *              the right, on a vector pad
 *   compass    a heading (a range over 0..1: a turn counter-clockwise from the right) on a vector
 *              pad whose length is knob `strength` (a range, or a feature's amount)
 *   position   the across coordinate of a point (a range) whose height is range knob `y`: both on
 *              one XY pad, the whole pad the frame unless `screen` gives the values (on both
 *              axes) where the frame's edges lie, for a point that may leave it
 *   flyway     a part of the birds card (`birdKnobs`): `birds` the switch and how often a flight
 *              passes (a feature), `kind` the species and `formation` the formation (choices); the
 *              card stands where a group has a `birds` part and takes that group's other parts
 *   night      a part of the Night sky section (the sky components of `skyComponentKnobs` and
 *              `weatherKnobs`): `stars` the density (a range), `moon` the moon's phase, `milkyWay`,
 *              `meteors`, `aurora` and `constellations` (features); the section stands where a
 *              group holds any of them, at the first, with the scene's planets where its
 *              SceneDef.planets names that group
 *   gusts      gusts that ride a `direction` knob (a feature, its "now" one gust): the group's
 *              direction pad takes them as its gust lane; without one, a plain chip
 */
export type Widget =
  | { kind: "mix"; mix: string; part: string; swatch: string }
  | { kind: "sky"; part: "time" | "cycle" | "moon" | "year" }
  | { kind: "sky"; part: "season"; year: SeasonYear }
  | { kind: "direction" }
  | { kind: "compass"; strength: string }
  | { kind: "position"; y: string; screen?: readonly [number, number] }
  | { kind: "flyway"; part: "birds" | "kind" | "formation" }
  | { kind: "night"; part: "stars" | "moon" | "milkyWay" | "meteors" | "aurora" | "constellations" }
  | { kind: "gusts" };

/**
 * Where a season knob puts the year, as a year position 0..1 (wrapping): 0 the start of spring,
 * 0.25 of summer, 0.5 of autumn, 0.75 of winter. `span` for a range, or a feature's amount: the
 * positions at its min and max, linear between (a feature that is off stands at `off`). `at` for a
 * choice: each option's position in option order, null for one that is not a time of year.
 */
export type SeasonYear =
  { span: readonly [number, number]; off?: number } | { at: readonly (number | null)[] };

export interface Option {
  label: string;
  value: number;
}

export type ParamDef =
  | (Base & { kind: "range"; min: number; max: number; step: number; value: number })
  | (Base & { kind: "toggle"; value: number })
  | (Base & {
      kind: "feature";
      on: boolean;
      amountLabel: string;
      min: number;
      max: number;
      step: number;
      value: number;
      options?: readonly Option[];
    })
  | (Base & { kind: "choice"; options: readonly Option[]; value: number })
  | (Base & { kind: "seed"; value: number });

/** Largest arrangement number a seed knob can hold. */
export const MAX_SEED = 999;

/** Must match `MAX_PARAMS` / `MAX_TRIGGERS` in the fragment shader. */
export const MAX_PARAMS = 64;
export const MAX_TRIGGERS = 8;

interface Extra {
  when?: string;
  trigger?: number;
  steady?: boolean;
  widget?: Widget;
  icon?: IconName;
}
const extra = (options: Extra) => ({
  ...(options.when === undefined ? {} : { when: options.when }),
  ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
  ...(options.steady === undefined ? {} : { steady: options.steady }),
  ...(options.widget === undefined ? {} : { widget: options.widget }),
  ...(options.icon === undefined ? {} : { icon: options.icon }),
});

export const range = (
  group: string,
  key: string,
  label: string,
  value: number,
  help: string,
  options: Extra & { min?: number; max?: number; step?: number } = {},
): ParamDef => ({
  kind: "range",
  group,
  key,
  label,
  value,
  help,
  min: options.min ?? 0,
  max: options.max ?? 1,
  step: options.step ?? 0.05,
  ...extra(options),
});

export const toggle = (
  group: string,
  key: string,
  label: string,
  on: boolean,
  help: string,
  options: Extra = {},
): ParamDef => ({
  kind: "toggle",
  group,
  key,
  label,
  value: on ? 1 : 0,
  help,
  ...extra(options),
});

export const feature = (
  group: string,
  key: string,
  label: string,
  on: boolean,
  amountLabel: string,
  value: number,
  help: string,
  options: Extra & { min?: number; max?: number; step?: number; options?: readonly Option[] } = {},
): ParamDef => ({
  kind: "feature",
  group,
  key,
  label,
  on,
  amountLabel,
  value,
  help,
  // Segmented amounts take their bounds from the choices, so counts like 8 survive URL parsing.
  min: options.options
    ? Math.min(...options.options.map((option) => option.value))
    : (options.min ?? 0.05),
  max: options.options
    ? Math.max(...options.options.map((option) => option.value))
    : (options.max ?? 1),
  step: options.step ?? 0.05,
  ...(options.options === undefined ? {} : { options: options.options }),
  ...extra(options),
});

export const choice = (
  group: string,
  key: string,
  label: string,
  options: readonly Option[],
  value: number,
  help: string,
  more: Extra = {},
): ParamDef => ({
  kind: "choice",
  group,
  key,
  label,
  options,
  value,
  help,
  ...extra(more),
});

export const seed = (
  group: string,
  key: string,
  label: string,
  help: string,
  more: Extra = {},
): ParamDef => ({
  kind: "seed",
  group,
  key,
  label,
  value: 0,
  help,
  ...extra(more),
});

export const counts = (...values: number[]): Option[] =>
  values.map((value) => ({ label: String(value), value }));

/** The value a knob hands to the shader. */
export function effective(def: ParamDef, params: Record<string, number>): number {
  const value = params[def.key] ?? (def.kind === "feature" ? (def.on ? 1 : 0) : def.value);
  if (def.kind !== "feature") return value;
  return value > 0.5 ? (params[`${def.key}-amount`] ?? def.value) : 0;
}

/** A URL value as a number within min..max; absent, empty or not a number: `fallback`. */
export function readNumber(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = value === null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Each of `defs` as a setup holds it, keyed as in the URL (a feature's amount as `<key>-amount`),
 * from `get` (a URL value by key, null when absent): a range clamped into its bounds, a switch
 * rounded to 0 or 1, a feature's amount clamped and, when segmented, one of its options, a choice one
 * of its options, a seed rounded into 0..MAX_SEED; anything else its default.
 */
export function readKnobs(
  defs: readonly ParamDef[],
  get: (key: string) => string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of defs) {
    switch (def.kind) {
      case "range":
        out[def.key] = readNumber(get(def.key), def.min, def.max, def.value);
        break;
      case "toggle":
        out[def.key] = Math.round(readNumber(get(def.key), 0, 1, def.value));
        break;
      case "feature": {
        out[def.key] = Math.round(readNumber(get(def.key), 0, 1, def.on ? 1 : 0));
        const amount = readNumber(get(`${def.key}-amount`), def.min, def.max, def.value);
        out[`${def.key}-amount`] =
          def.options?.some((option) => option.value === amount) === false ? def.value : amount;
        break;
      }
      case "choice": {
        const raw = get(def.key);
        const value = raw === null || raw === "" ? Number.NaN : Number(raw);
        out[def.key] = def.options.some((option) => option.value === value) ? value : def.value;
        break;
      }
      case "seed":
        out[def.key] = Math.round(readNumber(get(def.key), 0, MAX_SEED, def.value));
        break;
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
  }
  return out;
}

/** A title and one-line description: lab section headings (SceneDef.groups). */
export interface Blurb {
  title: string;
  /**
   * The lab's World shelf, ahead of the scene's own groups: a group of the shared world (its sky,
   * weather and birds) that a scene picked with "keep the world" on carries over by knob key.
   */
  shelf?: "world";
  blurb: string;
  /** The heading's lab icon; default: the first word of the group's key or title naming one. */
  icon?: IconName;
  /** One-tap setups drawn at the top of the group (see "Lab widgets" in scenes/README.md). */
  recipes?: readonly Recipe[];
}

/**
 * A one-tap setup in a group's heading: URL values by key (a feature's amount as `<key>-amount`), of
 * any of the scene's groups. A scene shows it where it has every key in `needs` and one key it sets,
 * and takes only the keys it has, each as its knob holds it: a range clamped and snapped, a switch
 * on for any value above 0 (so a cover written for a range turns a feature of that key on), a
 * feature's amount only where the recipe switches the feature on, a choice only to one of its
 * options, a seed rounded into 0..MAX_SEED. It is lit while every key it takes holds its value.
 */
export interface Recipe {
  label: string;
  /** The chip's glyph; default: the first word of its label naming one. */
  icon?: IconName;
  help: string;
  set: Readonly<Record<string, number>>;
  needs?: readonly string[];
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
export function knobValue(
  params: readonly ParamDef[],
  values: Readonly<Record<string, number>>,
  key: string,
): number {
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
      slots.set(key, {
        index,
        def,
        amountKey: def.kind === "feature" ? `${key}-amount` : undefined,
        initial: effective(def, {}),
      });
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

  /** Whether a feature or toggle is switched on (a feature whose amount may be 0 while on); any other knob: non-zero. */
  on(frame: SimFrame, key: K): boolean {
    const slot = this.#slot(key);
    if (slot.def.kind === "feature") return (frame.params[key] ?? (slot.def.on ? 1 : 0)) > 0.5;
    return this.value(frame, key) !== 0;
  }

  /** What `value` reads at the scene's defaults, for a constructor that runs before the first frame. */
  initial(key: K): number {
    return this.#slot(key).initial;
  }

  /** The knob's slot in `frame.triggers` (its "now" button); throws KnobError if it has none. */
  trigger(key: K): number {
    const trigger = this.#slot(key).def.trigger;
    if (trigger === undefined)
      throw new KnobError(`${this.#owner}: the '${key}' knob has no trigger slot`);
    return trigger;
  }

  /** A choice knob's entry: list[round(value)], or `fallback` when the list has no such entry. */
  pick<T>(frame: SimFrame, key: K, list: readonly T[], fallback: T): T {
    return list[Math.round(this.value(frame, key))] ?? fallback;
  }

  #slot(key: K): KnobSlot {
    const slot = this.#slots.get(key);
    if (slot === undefined)
      throw new KnobError(
        `${this.#owner}: '${key}' is not one of the knobs this reader was built with`,
      );
    return slot;
  }
}
