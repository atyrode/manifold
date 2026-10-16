// The climate's marks (see "Lab widgets" in scenes/README.md), apart from their elements: where a
// scene's season sets its climate (src/climate.ts `hasClimate`), small readouts on the weather's rain
// and snow switches, and on the weather recipes that switch them on, say what the time of year makes
// of them. Snow switched on while it is warm falls anyway, out of season; rain in the cold comes down
// as sleet, then as snow; in deep winter snow lies with none falling. The cold is the season knob's
// own (`yearAt`), not the passing year's, so a mark holds still while the year cycle runs. Marks only
// describe the setup: they change no value.
import {
  climateCold,
  climateLying,
  hasClimate,
  seasonKnob,
  SNOW_SHARE,
  yearAt,
} from "../climate.ts";
import { effective, type ParamDef } from "../params.ts";
import type { Params } from "../state.ts";

/** A knob value by URL key, its default while unset (Knobs.value). */
export type Read = (key: string) => number;

/** What a mark says. */
export type ClimateMarkKind = "outOfSeason" | "sleet" | "asSnow" | "lies";

export interface ClimateMark {
  kind: ClimateMarkKind;
  /** The readout on the control. */
  text: string;
  /** A sentence for its description. */
  help: string;
}

export const CLIMATE_MARKS: Readonly<Record<ClimateMarkKind, ClimateMark>> = {
  outOfSeason: {
    kind: "outOfSeason",
    text: "out of season",
    help: "Snow is switched on in the warm months: it falls anyway.",
  },
  sleet: {
    kind: "sleet",
    text: "sleet",
    help: "It is cold enough that some of the rain comes down as snow.",
  },
  asSnow: {
    kind: "asSnow",
    text: "falls as snow",
    help: "It is cold enough that the rain comes down as snow.",
  },
  lies: {
    kind: "lies",
    text: "snow lies",
    help: "Deep winter: snow lies on the ground with none falling.",
  },
};

/** The marks for the rain's and the snow's switch, keyed by knob. */
export interface PrecipMarks {
  rain?: ClimateMark;
  snow?: ClimateMark;
}

/**
 * The marks in this cold (`climateCold`, 0..1) for rain and snow as the shader has them (0 while
 * off): rain marks the share of it that comes down as snow (`SNOW_SHARE`: some of it, sleet, past the
 * first; all of it from the second); snow switched on below the first is out of season; while deep
 * winter lays snow of its own (`climateLying` above 0), the snow's switch says it lies.
 */
export function precipMarks(cold: number, rain: number, snow: number): PrecipMarks {
  const marks: PrecipMarks = {};
  if (rain > 0 && cold >= SNOW_SHARE[1]) marks.rain = CLIMATE_MARKS.asSnow;
  else if (rain > 0 && cold > SNOW_SHARE[0]) marks.rain = CLIMATE_MARKS.sleet;
  if (snow > 0 && cold < SNOW_SHARE[0]) marks.snow = CLIMATE_MARKS.outOfSeason;
  else if (climateLying(cold) > 0) marks.snow = CLIMATE_MARKS.lies;
  return marks;
}

/** A scene's marks for the knobs as `read` gives them, keyed by knob key (`rain`, `snow`). */
export type ClimateMarks = (read: Read) => Readonly<Record<string, ClimateMark>>;

/** `def`'s value as the shader has it (`effective`), from the lab's reads. */
function held(def: ParamDef | undefined, read: Read): number {
  if (!def) return 0;
  const amount = `${def.key}-amount`;
  return effective(def, { [def.key]: read(def.key), [amount]: read(amount) });
}

/** The marks of a scene with knobs `params`; undefined unless its season sets its climate. */
export function climateMarks(params: readonly ParamDef[]): ClimateMarks | undefined {
  const season = seasonKnob(params);
  if (!season || !hasClimate(params)) return undefined;
  const rain = params.find((def) => def.key === "rain");
  const snow = params.find((def) => def.key === "snow");
  return (read) => {
    const cold = climateCold(yearAt(season, held(season, read)));
    // As a plain record of the marks there are, keyed by knob.
    return { ...precipMarks(cold, held(rain, read), held(snow, read)) };
  };
}

/**
 * A recipe's mark: what the time of year makes of the rain or snow its `patch` switches on, set over
 * the knobs as `read` gives them; deep winter's lying snow is no doing of the recipe's.
 */
export function recipeMark(
  marks: ClimateMarks,
  patch: Readonly<Params>,
  read: Read,
): ClimateMark | undefined {
  const after = marks((key) => patch[key] ?? read(key));
  return ["rain", "snow"]
    .filter((key) => (patch[key] ?? 0) > 0)
    .map((key) => after[key])
    .find((mark) => mark !== undefined && mark.kind !== "lies");
}
