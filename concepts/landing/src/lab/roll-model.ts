// The shuffle's rule, apart from its buttons: the tools' shuffle rolls every knob of the scene,
// a group's dice the knobs of that group. Each knob takes a random value of its kind's own (a seed a
// new arrangement); a steady knob (framing that would otherwise lose the subject) keeps its value.
import { MAX_SEED, type ParamDef } from "../params.ts";
import type { Params } from "../state.ts";

/** A source of uniform numbers in [0, 1) (Math.random). */
export type Random = () => number;

/** Random values for `defs` but their steady knobs, as one URL patch. */
export function rollPatch(defs: readonly ParamDef[], random: Random = Math.random): Params {
  const patch: Params = {};
  const pickOne = <T>(list: readonly T[]): T | undefined =>
    list[Math.floor(random() * list.length)];
  const within = (min: number, max: number, step: number) =>
    Math.round((min + random() * (max - min)) / step) * step;
  for (const def of defs) {
    if (def.steady) continue;
    switch (def.kind) {
      case "range":
        patch[def.key] = Number(within(def.min, def.max, def.step).toFixed(4));
        break;
      case "toggle":
        patch[def.key] = random() < 0.45 ? 1 : 0;
        break;
      case "choice":
        patch[def.key] = pickOne(def.options)?.value ?? def.value;
        break;
      case "seed":
        patch[def.key] = Math.floor(random() * (MAX_SEED + 1));
        break;
      case "feature":
        patch[def.key] = random() < 0.55 ? 1 : 0;
        patch[`${def.key}-amount`] = def.options
          ? (pickOne(def.options)?.value ?? def.value)
          : Number(within(def.min, def.max, def.step).toFixed(4));
        break;
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
  }
  return patch;
}
