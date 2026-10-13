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
