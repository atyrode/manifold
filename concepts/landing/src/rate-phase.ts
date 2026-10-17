// Rate phases. A rate knob (ParamDef.rate: the day cycle's pace, the year's minutes per season, a
// drift's speed, a swing's period) read as `K × the motion clock` jumps the picture whenever it moves,
// by all the time the scene has run at the old pace. The renderer integrates each one instead: every
// step of the motion clock adds the knob's rate as it stands then, in double precision, wrapped at
// the knob's period, and the shader reads that phase (PHASE_<key>, a component of the uPhases row),
// a sim SimFrame.phases[key]. Moving the knob changes the pace from that moment on, never the
// picture; the shader sees small, wrapped numbers however long the page stays up. A feature's phase
// stands at 0 while it is off and starts there as it is switched on: a day cycle starts from the hour
// on the knob, as the lab's dial shows it.
import type { ParamDef, Rate } from "./params.ts";

/** The most rate knobs a scene may have: the components of the shader's uPhases row. */
export const MAX_PHASES = 4;
const COMPONENTS = "xyzw";

/** A scene whose rate knobs cannot become phases. */
export class RatePhaseError extends Error {}

/** A rate knob and where it sits: its index in the scene's params (uParams, SimFrame.values). */
export interface RatedKnob {
  readonly def: ParamDef & { rate: Rate };
  readonly index: number;
}

const hasRate = (def: ParamDef): def is ParamDef & { rate: Rate } => def.rate !== undefined;

/** The scene's rate knobs in params order: phase j is the j-th. Throws past MAX_PHASES. */
export function ratedKnobs(params: readonly ParamDef[]): RatedKnob[] {
  const rated = params.flatMap((def, index) => (hasRate(def) ? [{ def, index }] : []));
  if (rated.length > MAX_PHASES)
    throw new RatePhaseError(
      `${rated.length} rate knobs (${rated.map((knob) => knob.def.key).join(", ")}), at most ${MAX_PHASES}`,
    );
  return rated;
}

/** `#define PHASE_<key> uPhases.<x|y|z|w>` for each of the scene's rate knobs. */
export function phaseDefines(scene: { readonly params: readonly ParamDef[] }): string {
  return ratedKnobs(scene.params)
    .map(({ def }, j) => `#define PHASE_${def.key} uPhases.${COMPONENTS[j]}\n`)
    .join("");
}

/**
 * Phase units a second of the motion clock for a knob at `value` as the shader reads it: per × value,
 * or per / value for a period; nothing for a period at or below 0.
 */
export function rateOf(rate: Rate, value: number): number {
  if (!rate.inverse) return rate.per * value;
  return value > 0 ? rate.per / value : 0;
}

/** `phase` wrapped into 0..period (as it is without a period). */
function wrapped(phase: number, period: number | undefined): number {
  if (period === undefined) return phase;
  return phase - period * Math.floor(phase / period);
}

/** A scene's rate phases, integrated on its motion clock; all 0 as it enters. */
export class RatePhases {
  readonly #knobs: readonly RatedKnob[];
  readonly #phases: Float64Array;
  /** The phases as the shader reads them (uPhases), rewritten in place each step. */
  readonly upload = new Float32Array(MAX_PHASES);
  /** The phases by knob key (SimFrame.phases), rewritten in place each step. */
  readonly byKey: Record<string, number> = {};

  constructor(params: readonly ParamDef[]) {
    this.#knobs = ratedKnobs(params);
    this.#phases = new Float64Array(this.#knobs.length);
    for (const { def } of this.#knobs) this.byKey[def.key] = 0;
  }

  /**
   * Advance every phase by `motionStep` seconds of the motion clock with the knobs at `values` (as
   * the shader reads them, in params order: uParams): each by its rate now, a feature that is off
   * back to 0.
   */
  step(values: readonly number[], motionStep: number): void {
    for (const [j, { def, index }] of this.#knobs.entries()) {
      const value = values[index] ?? 0;
      const phase =
        def.kind === "feature" && value <= 0
          ? 0
          : wrapped((this.#phases[j] ?? 0) + rateOf(def.rate, value) * motionStep, def.rate.period);
      this.#phases[j] = phase;
      this.upload[j] = phase;
      this.byKey[def.key] = phase;
    }
  }

  /**
   * Take over the phases of `from` (another scene's, as the lab carries the world's knobs across a
   * change of scene) for every rate knob both have under one key and one rate, so a running day
   * cycle goes on where it was instead of starting over.
   */
  adopt(from: RatePhases): void {
    for (const [j, { def }] of this.#knobs.entries()) {
      const k = from.#knobs.findIndex(
        (other) =>
          other.def.key === def.key &&
          other.def.rate.per === def.rate.per &&
          other.def.rate.inverse === def.rate.inverse &&
          other.def.rate.period === def.rate.period,
      );
      if (k < 0) continue;
      const phase = from.#phases[k] ?? 0;
      this.#phases[j] = phase;
      this.upload[j] = phase;
      this.byKey[def.key] = phase;
    }
  }
}
