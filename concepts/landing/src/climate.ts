// The climate: how cold a scene's time of year is, and what that does to its weather. A scene's year
// position comes from its season knob's `SeasonYear` tag (params.ts): 0..1, wrapping, 0 the start of
// spring, 0.25 of summer, 0.5 of autumn, 0.75 of winter; -1 for a season that is no time of year.
// One model of the year's cold serves every scene, the world clock's (src/world-clock.ts), read two
// ways off the year's distance from midwinter (0.875). The chill (climateChill) is how far the year
// has turned toward winter, a cosine from 0 at midsummer (0.375) to 1 at midwinter: for what follows
// the season smoothly, a scene's light lower and cooler toward winter (bonsai). The cold
// (climateCold) is how near midwinter's freeze it is: full within COLD_CORE of midwinter, about half
// at the turns of winter (0.75 and 1) and nil beyond COLD_EDGE (0.075..0.675, mid-spring to
// mid-autumn), rising wherever the chill does; what falls and lies follows it, and so does a scene's
// own snow (bonsai's melts slowly while the cold would lay snow of its own). Where a scene both keeps
// a season and can snow (it has a season knob and a `snow` knob), the season sets the climate: as it
// grows cold, rain falls as snow, and in deep winter snow lies without any falling. The snow switch
// stays an explicit override that falls whatever the season. The renderer (src/renderer.ts) applies
// it to how much snow lies; the shared weather library mirrors it in GLSL (climateChill, climateCold,
// climatePrecip, climateLying in src/shaders/lib/weather.ts) for what falls, the world (worldAt in
// src/shaders/lib/world.ts) for its rain and snow, and every scene's program gets its year position
// as SKY_YEAR (src/shaders/index.ts). The year's cycle is a rate knob (YEAR_CYCLE_RATE): the renderer
// integrates it into the years it has carried the date on, so moving it never jumps the date.
// `worldClock` (src/world-clock.verify.ts) checks the GLSL against the functions here.
import type { ParamDef, Rate, SeasonYear } from "./params.ts";

/** Midwinter's year position. */
export const MIDWINTER = 0.875;
/** Year distance from midwinter within which it is fully cold, and beyond which not at all. */
export const COLD_CORE = 0.04;
export const COLD_EDGE = 0.2;
/** The cold over which rain turns to snow: none falls as snow below the first, all above the second. */
export const SNOW_SHARE = [0.35, 0.65] as const;
/** The cold over which deep winter's own snow comes to lie, none to all of WINTER_COVER. */
export const WINTER_LYING = [0.55, 0.95] as const;
/**
 * How much snow deep winter lays by itself at its coldest (uWeather.y): a cover through which the
 * hedges, field edges and furrows still read; a snowfall lies deeper.
 */
export const WINTER_COVER = 0.7;

export type SeasonKnob = ParamDef & { widget: { kind: "sky"; part: "season"; year: SeasonYear } };

/** The scene's season knob, if one of its knobs carries a season's year. */
export function seasonKnob(params: readonly ParamDef[]): SeasonKnob | undefined {
  return params.find(
    (def): def is SeasonKnob => def.widget?.kind === "sky" && def.widget.part === "season",
  );
}

export type YearCycleKnob = ParamDef & { kind: "feature"; widget: { kind: "sky"; part: "year" } };

/** The scene's year cycle ("the year passes": a feature, its amount minutes per season), if any. */
export function yearCycleKnob(params: readonly ParamDef[]): YearCycleKnob | undefined {
  return params.find(
    (def): def is YearCycleKnob =>
      def.kind === "feature" && def.widget?.kind === "sky" && def.widget.part === "year",
  );
}

/** Seconds of motion clock per season at one minute per season. */
const SEASON_SECONDS = 60;

/**
 * The year's cycle as a rate knob (its ParamDef.rate): its phase is the years it has carried the
 * date on, a year every 4 seasons of its minutes per season, wrapped at a whole year.
 */
export const YEAR_CYCLE_RATE: Rate = { per: 1 / (4 * SEASON_SECONDS), inverse: true, period: 1 };

/**
 * The year position now: `year` carried on by the `years` the year's cycle has run (its phase:
 * SimFrame.phases[key], 0 without a cycle or while it is off); -1 stays -1.
 */
export function yearNow(year: number, years: number): number {
  if (year < 0 || years === 0) return year;
  return wrap(year + years);
}

/** Whether the season sets the climate: the scene keeps a season and can snow. */
export function hasClimate(params: readonly ParamDef[]): boolean {
  return seasonKnob(params) !== undefined && params.some((def) => def.key === "snow");
}

const wrap = (year: number) => year - Math.floor(year);

/** How much of the year a span covers: 1 for one that comes round to its start. */
function spanLength([from, to]: readonly [number, number]): number {
  return wrap(to - from) || (to === from ? 0 : 1);
}

/**
 * The year position a season knob gives for `k`, the value it hands the shader (`effective`: a
 * feature's amount while on, 0 while off); -1 for no time of year.
 */
export function yearAt(def: SeasonKnob, k: number): number {
  const year = def.widget.year;
  if ("at" in year) {
    if (def.kind !== "choice") return -1;
    const index = def.options.findIndex((option) => Math.abs(option.value - k) < 0.5);
    return year.at[index] ?? -1;
  }
  if (def.kind !== "range" && def.kind !== "feature") return -1;
  if (def.kind === "feature" && k <= 0) return year.off ?? -1;
  const t = def.max === def.min ? 0 : (k - def.min) / (def.max - def.min);
  return wrap(year.span[0] + t * spanLength(year.span));
}

const glslFloat = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value));

/** `yearAt` as a GLSL expression of the knob's define `k` (`K_<key>`). */
export function yearGlsl(def: SeasonKnob, k: string): string {
  const year = def.widget.year;
  if ("at" in year) {
    if (def.kind !== "choice") return "-1.0";
    return def.options.reduceRight(
      (rest, option, index) =>
        `(abs(${k} - ${glslFloat(option.value)}) < 0.5 ? ${glslFloat(year.at[index] ?? -1)} : ${rest})`,
      "-1.0",
    );
  }
  if (def.kind !== "range" && def.kind !== "feature") return "-1.0";
  const scale = def.max === def.min ? 0 : spanLength(year.span) / (def.max - def.min);
  const on = `fract(${glslFloat(year.span[0])} + (${k} - ${glslFloat(def.min)}) * ${glslFloat(scale)})`;
  return def.kind === "feature" ? `(${k} <= 0.0 ? ${glslFloat(year.off ?? -1)} : ${on})` : on;
}

/** `yearNow` of `yearGlsl`, as GLSL: the year position SKY_YEAR holds (the cycle's phase PHASE_<key>). */
export function yearNowGlsl(season: SeasonKnob, cycle: YearCycleKnob | undefined): string {
  const at = yearGlsl(season, `K_${season.key}`);
  if (!cycle) return at;
  return `(K_${cycle.key} > 0.0 && ${at} >= 0.0 ? fract(${at} + PHASE_${cycle.key}) : ${at})`;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How far the year has turned toward winter: 0 at midsummer .. 1 at midwinter, a cosine round the
 * year; 0 for no time of year.
 */
export function climateChill(year: number): number {
  if (year < 0) return 0;
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (year - MIDWINTER));
}

/**
 * How cold the time of year is: 0 from mid-spring to mid-autumn and for no time of year, 1 round
 * midwinter; it rises wherever climateChill does.
 */
export function climateCold(year: number): number {
  if (year < 0) return 0;
  const d = Math.abs(wrap(year - MIDWINTER + 0.5) - 0.5);
  return 1 - smoothstep(COLD_CORE, COLD_EDGE, d);
}

/** The cold's share of the rain that falls as snow, 0..1. */
export function snowShare(cold: number): number {
  return smoothstep(SNOW_SHARE[0], SNOW_SHARE[1], cold);
}

/** The rain that falls as rain in this cold (GLSL `climatePrecip(...).x`). */
export function fallingRain(rain: number, cold: number): number {
  return rain * (1 - snowShare(cold));
}

/** The snow that falls in this cold: the snow switch's, or the rain turned to snow (`.y`). */
export function fallingSnow(rain: number, snow: number, cold: number): number {
  return Math.max(snow, rain * snowShare(cold));
}

/** How much snow deep winter lays by itself, 0..WINTER_COVER, beside what falls. */
export function climateLying(cold: number): number {
  return WINTER_COVER * smoothstep(WINTER_LYING[0], WINTER_LYING[1], cold);
}

/** The GLSL mirror of the functions above, for the shared weather library. */
export const climateGlsl = /* glsl */ `
// ---- climate (src/climate.ts) ----
// How far a year position (SKY_YEAR; -1 none) has turned toward winter: 0 at midsummer .. 1 at
// midwinter, a cosine round the year; 0 for no time of year.
float climateChill(float year) {
  if (year < 0.0) return 0.0;
  return 0.5 + 0.5 * cos(TAU * (year - ${MIDWINTER}));
}
// How cold a year position is: 0 from mid-spring to mid-autumn, 1 round midwinter.
float climateCold(float year) {
  if (year < 0.0) return 0.0;
  float d = abs(fract(year - ${MIDWINTER} + 0.5) - 0.5);
  return 1.0 - smoothstep(${COLD_CORE}, ${COLD_EDGE}, d);
}
// Rain and snow as they fall in this cold (x rain, y snow): the cold's share of the rain as snow.
vec2 climatePrecip(float rain, float snow, float cold) {
  float share = smoothstep(${SNOW_SHARE[0]}, ${SNOW_SHARE[1]}, cold);
  return vec2(rain * (1.0 - share), max(snow, rain * share));
}
// How much snow deep winter lays by itself, 0..${WINTER_COVER}, beside what falls (uWeather.y holds it).
float climateLying(float cold) {
  return ${WINTER_COVER} * smoothstep(${WINTER_LYING[0]}, ${WINTER_LYING[1]}, cold);
}
`;
