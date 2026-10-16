// Shared lab knobs for the plant component (sims/plants.ts, shaders/lib/plants.ts): the year, growth
// and gusts, with the same keys, labels and help in every scene that grows plants. Each starts off,
// so adopting one never changes a scene's picture: off, a scene shows its plants in high summer
// (PLANT_SUMMER), in their prime, stirred only by its own wind. The sim reads them by key into its
// PlantClimate; the shaders never read them (the organs carry what they did).
//
// Keys: `season` (feature; the amount is the time of year, spring at the left end, as bonsai's),
// `growth` (feature; the amount is its pace) and `gusts` (feature; strength, with a "now" button).
import { feature, type ParamDef } from "../params.ts";

export interface PlantKnobOptions {
  /** Lab group for `season` and `growth`. */
  group: string;
  /** Only shown while this scene toggle or feature is on (the plants' own switch). */
  when?: string;
  /** Add `season`, starting at this time of year when switched on. */
  season?: number;
  /** Add `growth`, starting at this pace when switched on. */
  growth?: number;
  /** Add `gusts`, its "now" on `trigger`, in `group` (default the plants' group), starting at `value`. */
  gusts?: { trigger: number; group?: string; value?: number };
}

/** The plant component's knobs a scene composes, in lab order: season, growth, gusts. All start off. */
export function plantKnobs(options: PlantKnobOptions): ParamDef[] {
  const when: { when?: string } = options.when === undefined ? {} : { when: options.when };
  const knobs: ParamDef[] = [];
  if (options.season !== undefined) {
    knobs.push(
      feature(
        options.group,
        "season",
        "seasons",
        false,
        "time of year",
        options.season,
        "The year turns the plants: a flush of pale young leaves in spring, everything out and green in summer, leaves turning gold and brown and the deciduous ones falling in autumn, bare stems among the evergreens in winter; flowers open only in their season. Spring at the left end, then summer, autumn and winter. Off: high summer.",
        {
          ...when,
          steady: true,
          widget: { kind: "sky", part: "season", year: { span: [0.05, 1], off: 0.35 } },
        },
      ),
    );
  }
  if (options.growth !== undefined) {
    knobs.push(
      feature(
        options.group,
        "growth",
        "growth",
        false,
        "pace",
        options.growth,
        "The plants keep growing: new leaves unfold pale and small, old ones yellow and drop, and each node grows the next in its place. Higher: faster. Off: every leaf holds in its prime.",
        when,
      ),
    );
  }
  if (options.gusts !== undefined) {
    knobs.push(
      feature(
        options.gusts.group ?? options.group,
        "gusts",
        "gusts",
        false,
        "strength",
        options.gusts.value ?? 0.5,
        "Now and then a gust crosses as a front: the plants bow one after another as it reaches them, then swing back. Higher: stronger and more often. Now: a gust.",
        { trigger: options.gusts.trigger, widget: { kind: "gusts" } },
      ),
    );
  }
  return knobs;
}
