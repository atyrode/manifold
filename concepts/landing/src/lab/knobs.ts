// A scene's knobs as the lab's widgets reach them: each read falls back to the knob's default, each
// edit is a URL patch through the lab (so undo, links and presets see it like any other change).
// A planet's knobs reach their planet the same way, through a context of its own (planets.ts).
import type { ParamDef } from "../params.ts";
import type { Params } from "../state.ts";
import { available, switchChain } from "./availability-model.ts";
import type { LabContext, Patch } from "./dom.ts";
import { iconFromWords, type IconName } from "./icons.ts";

export type RangeDef = Extract<ParamDef, { kind: "range" }>;
export type FeatureDef = Extract<ParamDef, { kind: "feature" }>;
export type SwitchDef = Extract<ParamDef, { kind: "toggle" | "feature" }>;

export class Knobs {
  readonly #ctx: LabContext;
  readonly #defaults: Params;
  readonly #defs: readonly ParamDef[];
  /** switchChain by `when`, worked out once. */
  readonly #chains = new Map<string | undefined, readonly string[]>();

  constructor(ctx: LabContext, defs: readonly ParamDef[], defaults: Params) {
    this.#ctx = ctx;
    this.#defs = defs;
    this.#defaults = defaults;
  }

  value(key: string): number {
    return this.#ctx.current().params[key] ?? this.#defaults[key] ?? 0;
  }

  default(key: string): number {
    return this.#defaults[key] ?? 0;
  }

  set(patch: Patch, commit: boolean): void {
    this.#ctx.change(patch, commit);
  }

  def(key: string): ParamDef | undefined {
    return this.#defs.find((def) => def.key === key);
  }

  /** Whether switch `key` itself is on (its own value, whatever the switches above it say). */
  on(key: string | undefined): boolean {
    return this.#ctx.on(key);
  }

  /**
   * The switches a control hanging on `when` waits on, nearest first: `when`, its own `when`, and
   * so on to any depth (availability-model.ts switchChain).
   */
  chain(when: string | undefined): readonly string[] {
    let chain = this.#chains.get(when);
    if (!chain) this.#chains.set(when, (chain = switchChain(this.#defs, when)));
    return chain;
  }

  /** Whether a control hanging on `when` takes effect: every switch of its chain on. */
  live(when: string | undefined): boolean {
    return available(this.chain(when), (key) => this.on(key));
  }

  modified(keys: readonly string[]): boolean {
    return keys.some((key) => this.value(key) !== this.#defaults[key]);
  }

  /** Every one of `keys` back to its default, with `also` (other URL keys) in the same change. */
  reset(keys: readonly string[], also: Patch = {}): void {
    this.#ctx.change(
      { ...Object.fromEntries(keys.map((key) => [key, this.#defaults[key] ?? 0])), ...also },
      true,
    );
  }

  fire(slot: number): void {
    this.#ctx.renderer()?.trigger(slot);
  }

  get reducedMotion(): boolean {
    return this.#ctx.reducedMotion;
  }
}

/** A knob's URL keys: a feature's amount too. */
export function knobKeys(def: ParamDef): string[] {
  return def.kind === "feature" ? [def.key, `${def.key}-amount`] : [def.key];
}

/** A knob's icon: its own, else the first word of its key or label naming one, else a plain mark. */
export function knobIcon(def: ParamDef): IconName {
  return def.icon ?? iconFromWords(def.key, def.label) ?? "dot";
}
