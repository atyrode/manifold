// The shared world in the lab: which of a scene's knob groups stand on the Controls view's World
// shelf (`Blurb.shelf`), in the shelf's order, and the world a scene picked with "keep the world" on
// takes over from the one left (lab.ts #setScene): the World knobs both scenes have, by key, the
// season through the year it stands at (almanac-model.ts), and the planets of its night sky.
import { MAX_SEED, type Blurb, type ParamDef } from "../params.ts";
import { readPlanet, type SkyPlanet, type SkyPlanets } from "../scenes/planets.ts";
import type { Params } from "../state.ts";
import { seasonDef, seasonPatch, yearDistance, yearOf } from "./almanac-model.ts";

/** What the world needs of a scene (a SceneDef is one): its knobs, their groups' headings, its planets. */
export interface WorldScene {
  params: readonly ParamDef[];
  groups: Readonly<Record<string, Blurb>>;
  planets?: SkyPlanets;
}

/** The World shelf leads with these groups, whatever order the scene's knobs come in. */
const WORLD_ORDER: readonly string[] = ["sky", "weather", "wind", "birds"];

/**
 * The scene's knob groups, each where its first knob stands, split into the World shelf (groups
 * whose heading has `shelf: "world"`: sky, weather, wind and birds first) and the scene's own.
 */
export function shelves(scene: WorldScene): { world: string[]; own: string[] } {
  const groups = [...new Set(scene.params.map((def) => def.group))];
  const rank = (group: string) => {
    const at = WORLD_ORDER.indexOf(group);
    return at < 0 ? WORLD_ORDER.length : at;
  };
  const world = groups
    .filter((group) => scene.groups[group]?.shelf === "world")
    .sort((a, b) => rank(a) - rank(b));
  return { world, own: groups.filter((group) => !world.includes(group)) };
}

/**
 * The next scene's knobs (`toParams`, keyed as readParams keys them) under the world of the scene
 * left: each knob of a World group of `to` takes the value of the knob of a World group of `from`
 * with its key and kind, kept within its own range (a feature's amount too; a choice, or a feature's
 * segmented amount, only where it offers that value). The season goes over through the year, from
 * whichever knob holds it on each side, unless the next scene already shows that time of year.
 */
export function carryWorld(
  from: WorldScene,
  fromParams: Readonly<Params>,
  to: WorldScene,
  toParams: Readonly<Params>,
): Params {
  const out: Params = { ...toParams };
  const sources = new Map(
    from.params
      .filter((def) => from.groups[def.group]?.shelf === "world")
      .map((def) => [def.key, def]),
  );
  for (const def of to.params) {
    const source = sources.get(def.key);
    if (source?.kind !== def.kind || to.groups[def.group]?.shelf !== "world") continue;
    Object.assign(out, carried(source, fromParams, def));
  }
  const fromSeason = seasonDef(from.params);
  const toSeason = seasonDef(to.params);
  const year = fromSeason === undefined ? undefined : yearOf(fromSeason, fromParams);
  if (toSeason !== undefined && year !== undefined) {
    const shown = yearOf(toSeason, out);
    if (shown === undefined || yearDistance(shown, year) > 1e-6)
      Object.assign(out, seasonPatch(toSeason, year));
  }
  return out;
}

/**
 * The planets the next scene takes over from the one left: every one of `planets`, each kept within
 * the next scene's pad (readPlanet), where both scenes hold their planets in a World group; none
 * otherwise, the next scene's own sky as it starts.
 */
export function carryPlanets(
  from: WorldScene,
  planets: readonly SkyPlanet[],
  to: WorldScene,
): SkyPlanet[] {
  const spec = to.planets;
  const world = (scene: WorldScene) =>
    scene.planets !== undefined && scene.groups[scene.planets.group]?.shelf === "world";
  return spec !== undefined && world(from) && world(to)
    ? planets.map((planet) => readPlanet(spec, planet))
    : [];
}

/** Knob `source`'s setting in `params` as a patch for `def`, a knob of the same kind. */
function carried(source: ParamDef, params: Readonly<Params>, def: ParamDef): Params {
  const raw = params[source.key] ?? (source.kind === "feature" ? Number(source.on) : source.value);
  const within = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  switch (def.kind) {
    case "range":
      return { [def.key]: within(raw, def.min, def.max) };
    case "toggle":
      return { [def.key]: raw > 0.5 ? 1 : 0 };
    case "feature": {
      const on = { [def.key]: raw > 0.5 ? 1 : 0 };
      const amount = within(params[`${source.key}-amount`] ?? source.value, def.min, def.max);
      if (def.options?.some((option) => option.value === amount) === false) return on;
      return { ...on, [`${def.key}-amount`]: amount };
    }
    case "choice":
      return def.options.some((option) => option.value === raw) ? { [def.key]: raw } : {};
    case "seed":
      return { [def.key]: within(Math.round(raw), 0, MAX_SEED) };
    default: {
      const unreachable: never = def;
      throw new Error(`carryWorld: unknown knob ${String(unreachable)}`);
    }
  }
}
