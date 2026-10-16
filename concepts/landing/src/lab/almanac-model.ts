// The year as season knobs hold it (`SeasonYear` in params.ts): one position 0..1 that wraps, 0 the
// start of spring, 0.25 of summer, 0.5 of autumn, 0.75 of winter. A scene's season knob reads out as
// such a position and is set from one, so the almanac's ring and a world carried between scenes speak
// the same year whatever the knob's kind or options. Also where the almanac's parts are laid out: the
// sky dial gathers them from any group (gatherAlmanac), the dial or a season wheel draws them.
import type { ParamDef, SeasonYear } from "../params.ts";
import type { Params } from "../state.ts";
import { snap } from "./dom.ts";
import type { FeatureDef } from "./knobs.ts";

export type SeasonDef = ParamDef & { widget: { kind: "sky"; part: "season"; year: SeasonYear } };

export const SEASON_NAMES = ["spring", "summer", "autumn", "winter"] as const;

/** The scene's season knob, if one of its knobs is the almanac's `season` part. */
export function seasonDef(defs: readonly ParamDef[]): SeasonDef | undefined {
  return defs.find(
    (def): def is SeasonDef => def.widget?.kind === "sky" && def.widget.part === "season",
  );
}

/** The almanac's parts besides the clock: the season knob and the year's cycle (a feature). */
export interface AlmanacParts {
  season: SeasonDef | undefined;
  year: FeatureDef | undefined;
}

/** The `season` and `year` parts among these knobs. */
export function almanacParts(defs: readonly ParamDef[]): AlmanacParts {
  return {
    season: seasonDef(defs),
    year: defs.find(
      (def): def is FeatureDef =>
        def.kind === "feature" && def.widget?.kind === "sky" && def.widget.part === "year",
    ),
  };
}

/**
 * Lab groups by heading, in order: where the scene has a `time` part (a range), its `season` and
 * `year` parts leave their own groups for the time's, to stand on the sky dial, and a group they
 * leave empty goes. Without one they stay, and make a season wheel in their own group. In place.
 */
export function gatherAlmanac(groups: Map<string, ParamDef[]>): void {
  const home = [...groups].find(([, defs]) =>
    defs.some(
      (def) => def.kind === "range" && def.widget?.kind === "sky" && def.widget.part === "time",
    ),
  )?.[0];
  if (home === undefined) return;
  for (const [group, defs] of [...groups]) {
    if (group === home) continue;
    const { season, year } = almanacParts(defs);
    const moving = defs.filter((def) => def === season || def === year);
    if (moving.length === 0) continue;
    groups.set(home, [...(groups.get(home) ?? []), ...moving]);
    const rest = defs.filter((def) => !moving.includes(def));
    if (rest.length > 0) groups.set(group, rest);
    else groups.delete(group);
  }
}

const wrap = (year: number) => ((year % 1) + 1) % 1;

/** How far apart two year positions are, round the shorter way: 0..0.5. */
export function yearDistance(a: number, b: number): number {
  const d = Math.abs(wrap(a) - wrap(b));
  return Math.min(d, 1 - d);
}

/** How much of the year a span covers: 1 for one that comes round to its start. */
function spanLength([from, to]: readonly [number, number]): number {
  return wrap(to - from) || (to === from ? 0 : 1);
}

/** A span knob's stretch of the year: where it starts and how far round it goes (1: all of it). */
export function seasonSpan(def: SeasonDef): { from: number; length: number } | undefined {
  const spec = def.widget.year;
  return "span" in spec ? { from: wrap(spec.span[0]), length: spanLength(spec.span) } : undefined;
}

/** The amount (or range value) a `span` knob takes for `year`: the nearest point of its span. */
function spanValue(
  span: readonly [number, number],
  min: number,
  max: number,
  year: number,
): number {
  const [from, to] = span;
  const length = spanLength(span);
  const along = wrap(year - from);
  // Past the span's end: snap to whichever end lies nearer round the year.
  const t =
    along <= length ? along : yearDistance(year, to) < yearDistance(year, from) ? length : 0;
  return min + (length === 0 ? 0 : t / length) * (max - min);
}

/** Whether the knob is on: a feature's switch, every other kind always. */
function switchedOn(def: SeasonDef, params: Readonly<Params>): boolean {
  return def.kind !== "feature" || (params[def.key] ?? (def.on ? 1 : 0)) > 0.5;
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
    if (!switchedOn(def, params)) return year.off;
    value = params[`${def.key}-amount`] ?? def.value;
    ({ min, max } = def);
  } else if (def.kind === "range") {
    value = params[def.key] ?? def.value;
    ({ min, max } = def);
  } else return undefined;
  const t = max === min ? 0 : (value - min) / (max - min);
  return wrap(year.span[0] + t * spanLength(year.span));
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
  if (def.kind !== "feature" && def.kind !== "range") return {};
  const value = snap(spanValue(spec.span, def.min, def.max, year), def.min, def.max, def.step);
  return def.kind === "feature"
    ? { [def.key]: 1, [`${def.key}-amount`]: value }
    : { [def.key]: value };
}

/** A choice's season on the ring: its option, its position and the arc it holds (from < at < to). */
export interface SeasonStop {
  value: number;
  label: string;
  at: number;
  from: number;
  to: number;
}

const EIGHTH = 1 / 8;

/**
 * A choice's seasons in year order (its options that are a time of year), each holding the ring
 * half-way to its neighbours and at most an eighth of the year either side.
 */
export function seasonStops(def: SeasonDef): SeasonStop[] {
  const spec = def.widget.year;
  if (!("at" in spec) || def.kind !== "choice") return [];
  const stops = def.options
    .flatMap((option, index) => {
      const at = spec.at[index];
      return at === null || at === undefined
        ? []
        : [{ value: option.value, label: option.label, at: wrap(at) }];
    })
    .sort((a, b) => a.at - b.at);
  return stops.map((stop, index) => {
    const before = stops[(index + stops.length - 1) % stops.length];
    const after = stops[(index + 1) % stops.length];
    const back = stops.length > 1 && before ? wrap(stop.at - before.at) / 2 : EIGHTH;
    const ahead = stops.length > 1 && after ? wrap(after.at - stop.at) / 2 : EIGHTH;
    return {
      ...stop,
      from: stop.at - Math.min(EIGHTH, back),
      to: stop.at + Math.min(EIGHTH, ahead),
    };
  });
}

/**
 * The URL patch `steps` steps on through the year (back for steps < 0). A choice moves along its
 * seasons in year order, round the year, onto the first (or last) from an option that is not one. A
 * range or feature amount moves by its own step, through the year as seasonPatch sets it: past an end
 * it stops there, unless it lands nearer the other end round the year (a span that leaves a gap of
 * about a step). A feature switches on, starting from `off` while it is off.
 */
export function stepSeason(def: SeasonDef, params: Readonly<Params>, steps: number): Params {
  if (steps === 0) return {};
  const spec = def.widget.year;
  if ("at" in spec) {
    const stops = seasonStops(def);
    if (stops.length === 0) return {};
    const value = params[def.key] ?? def.value;
    const index = stops.findIndex((stop) => stop.value === value);
    const start = index >= 0 ? index : steps > 0 ? -1 : stops.length;
    const count = stops.length;
    const next = stops[(((start + Math.trunc(steps)) % count) + count) % count];
    return next === undefined ? {} : { [def.key]: next.value };
  }
  if (def.kind !== "feature" && def.kind !== "range") return {};
  const year = yearOf(def, params) ?? yearOf(def, { ...params, [def.key]: 1 }) ?? spec.span[0];
  const step = (def.step / (def.max - def.min)) * spanLength(spec.span);
  return seasonPatch(def, year + steps * step);
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

/**
 * The year the knob reads out as: where it puts the year, but a span's far end a hair back, so it
 * names the end of its own stretch (autumn's last day, not winter's first).
 */
export function namedYear(def: SeasonDef, params: Readonly<Params>): number | undefined {
  const year = yearOf(def, params);
  if (year === undefined || (def.kind !== "range" && def.kind !== "feature")) return year;
  const value = params[def.kind === "feature" ? `${def.key}-amount` : def.key] ?? def.value;
  return switchedOn(def, params) && value >= def.max ? year - 1e-6 : year;
}

/** How the knob's season reads: a choice's option, else the season's name ("off: …" while off). */
export function seasonText(def: SeasonDef, params: Readonly<Params>): string {
  if (def.kind === "choice") {
    const value = params[def.key] ?? def.value;
    return def.options.find((option) => option.value === value)?.label ?? "";
  }
  const year = namedYear(def, params);
  const name = year === undefined ? "" : seasonName(year);
  if (switchedOn(def, params)) return name;
  return name === "" ? "off" : `off: ${name}`;
}
