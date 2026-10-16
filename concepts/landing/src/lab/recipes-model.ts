// A group's recipes (`Blurb.recipes`, `Recipe` in params.ts), apart from their DOM: which ones a
// scene shows, the one URL patch each makes there, and whether the setup on screen already is it.
// A recipe names URL keys of any group; a scene takes the ones it has, each as its knob holds it.
import { MAX_SEED, type ParamDef, type Recipe } from "../params.ts";
import type { Params } from "../state.ts";
import { snap } from "./dom.ts";

/** A knob value by URL key, its default while unset (Knobs.value). */
export type Read = (key: string) => number;

/** A recipe a scene shows, with the patch it makes there. */
export interface ShownRecipe {
  recipe: Recipe;
  patch: Params;
}

type FeatureDef = Extract<ParamDef, { kind: "feature" }>;

const AMOUNT = "-amount";

/** `value` as knob `def` holds it under its own key; undefined for a value it cannot take. */
function knobValue(def: ParamDef, value: number): number | undefined {
  switch (def.kind) {
    case "range":
      return snap(value, def.min, def.max, def.step);
    case "toggle":
    case "feature":
      return value > 0 ? 1 : 0;
    case "choice":
      return def.options.some((option) => option.value === value) ? value : undefined;
    case "seed":
      return Math.round(Math.min(MAX_SEED, Math.max(0, value)));
    default: {
      const unreachable: never = def;
      throw new Error(`landing: unknown knob ${String(unreachable)}`);
    }
  }
}

/** `value` as feature `def`'s amount; undefined for one its segments do not offer. */
function amountValue(def: FeatureDef, value: number): number | undefined {
  if (def.options) return def.options.some((option) => option.value === value) ? value : undefined;
  return snap(value, def.min, def.max, def.step);
}

/**
 * The patch `recipe` makes in a scene with knobs `defs`, or undefined where the scene does not show
 * it: a key in `needs` it lacks, or no key the recipe sets that it has.
 */
export function recipePatch(recipe: Recipe, defs: readonly ParamDef[]): Params | undefined {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const has = (key: string) => {
    if (byKey.has(key)) return true;
    return key.endsWith(AMOUNT) && byKey.get(key.slice(0, -AMOUNT.length))?.kind === "feature";
  };
  if (!(recipe.needs ?? []).every(has)) return undefined;
  const patch: Params = {};
  for (const [key, value] of Object.entries(recipe.set)) {
    const def = byKey.get(key);
    if (def) {
      const held = knobValue(def, value);
      if (held !== undefined) patch[key] = held;
      continue;
    }
    if (!key.endsWith(AMOUNT)) continue;
    const owner = byKey.get(key.slice(0, -AMOUNT.length));
    // An amount comes only with its feature, switched on by the same recipe.
    if (owner?.kind !== "feature" || !((recipe.set[owner.key] ?? 0) > 0)) continue;
    const amount = amountValue(owner, value);
    if (amount !== undefined) patch[key] = amount;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The recipes a scene with knobs `defs` shows, in order, with their patches. */
export function shownRecipes(recipes: readonly Recipe[], defs: readonly ParamDef[]): ShownRecipe[] {
  return recipes.flatMap((recipe) => {
    const patch = recipePatch(recipe, defs);
    return patch ? [{ recipe, patch }] : [];
  });
}

/**
 * Whether the setup already is the recipe: every key of its patch holds its value. A feature's
 * amount is in the patch only beside its switch turned on, so it counts only while that is on.
 */
export function recipeLit(patch: Readonly<Params>, read: Read): boolean {
  return Object.entries(patch).every(([key, value]) => Math.abs(read(key) - value) < 1e-6);
}
