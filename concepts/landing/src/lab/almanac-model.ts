// The year as season knobs hold it (`SeasonYear` in params.ts): one position 0..1 that wraps, 0 the
// start of spring, 0.25 of summer, 0.5 of autumn, 0.75 of winter. A scene's season knob reads out as
// such a position and is set from one, so the almanac's ring and a world carried between scenes speak
// the same year whatever the knob's kind or options.
import type { ParamDef, SeasonYear } from "../params.ts";
import type { Params } from "../state.ts";

export type SeasonDef = ParamDef & { widget: { kind: "sky"; part: "season"; year: SeasonYear } };

export const SEASON_NAMES = ["spring", "summer", "autumn", "winter"] as const;

/** The scene's season knob, if one of its knobs is the almanac's `season` part. */
export function seasonDef(defs: readonly ParamDef[]): SeasonDef | undefined {
  return defs.find(
    (def): def is SeasonDef => def.widget?.kind === "sky" && def.widget.part === "season",
  );
}

const wrap = (year: number) => ((year % 1) + 1) % 1;

/** How far apart two year positions are, round the shorter way: 0..0.5. */
export function yearDistance(a: number, b: number): number {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 1 - d);
}

/** The amount (or range value) a `span` knob takes for `year`: the nearest point of its span. */
function spanValue(
  span: readonly [number, number],
  min: number,
  max: number,
  year: number,
): number {
  const [from, to] = span;
  const length = wrap(to - from) || (to === from ? 0 : 1);
  const along = wrap(year - from);
  // Past the span's end: snap to whichever end lies nearer round the year.
  const t =
    along <= length ? along : yearDistance(year, to) < yearDistance(year, from) ? length : 0;
  return min + (length === 0 ? 0 : t / length) * (max - min);
}

/** Where the knob puts the year at these values; undefined for a choice that is not a season. */
export function yearOf(def: SeasonDef, params: Readonly<Params>): number | undefined {
  const year = def.widget.year;
  if ("at" in year) {
    if (def.kind !== "choice") return undefined;
    const value = params[def.key] ?? def.value;
    const index = def.options.findIndex((option) => option.value === value);
    return year.at[index] ?? undefined;
  }
  let value: number;
  let min: number;
  let max: number;
  if (def.kind === "feature") {
    if ((params[def.key] ?? (def.on ? 1 : 0)) <= 0.5) return year.off;
    value = params[`${def.key}-amount`] ?? def.value;
    ({ min, max } = def);
  } else if (def.kind === "range") {
    value = params[def.key] ?? def.value;
    ({ min, max } = def);
  } else return undefined;
  const [from, to] = year.span;
  const length = wrap(to - from) || (to === from ? 0 : 1);
  const t = max === min ? 0 : (value - min) / (max - min);
  return wrap(from + t * length);
}

/** The URL patch that sets the knob as near `year` as it goes (a feature switches on). */
export function seasonPatch(def: SeasonDef, year: number): Params {
  const spec = def.widget.year;
  if ("at" in spec) {
    if (def.kind !== "choice") return {};
    let best: { value: number; d: number } | undefined;
    def.options.forEach((option, index) => {
      const at = spec.at[index];
      if (at === null || at === undefined) return;
      const d = yearDistance(at, year);
      if (best === undefined || d < best.d) best = { value: option.value, d };
    });
    return best === undefined ? {} : { [def.key]: best.value };
  }
  if (def.kind === "feature") {
    const value = spanValue(spec.span, def.min, def.max, year);
    return { [def.key]: 1, [`${def.key}-amount`]: snapTo(value, def.min, def.step) };
  }
  if (def.kind === "range")
    return { [def.key]: snapTo(spanValue(spec.span, def.min, def.max, year), def.min, def.step) };
  return {};
}

function snapTo(value: number, min: number, step: number): number {
  if (step <= 0) return value;
  return Number((min + Math.round((value - min) / step) * step).toFixed(6));
}

/** "early spring", "high summer", "late autumn"… for a year position. */
export function seasonName(year: number): string {
  const y = wrap(year) * 4;
  const name = SEASON_NAMES[Math.min(3, Math.floor(y))] ?? "spring";
  const within = y - Math.floor(y);
  const part =
    within < 1 / 3 ? "early " : within < 2 / 3 ? (name === "summer" ? "high " : "mid ") : "late ";
  return part + name;
}
