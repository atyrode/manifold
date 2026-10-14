// Shared lab knobs for outdoor scenes: time of day, and the weather layer (rain, snow, fog, wind,
// lightning, aurora), plus the opt-in sky components (star density, the moon's phase, shooting stars)
// and fair-weather cloud. Every scene that uses them gets the same keys, labels and help, so a setting
// means the same thing everywhere; the GLSL side lives in src/shaders/lib/ and reads them through the
// generated K_<key> defines (K_time, K_cycle, K_stars, K_moon, K_meteors, K_clouds, K_rain, K_snow,
// K_fog, K_wind, K_lightning, K_aurora). How a scene composes them: src/scenes/README.md.
//
// The page theme is decided here too (skyTheme, paletteTheme), once, from the knobs: the shader reads
// the outcome with pagePaper() instead of repeating the test.
import { effective, feature, knobDef, KnobError, range, type Blurb, type ParamDef } from "../params.ts";
import type { SceneTheme } from "./types.ts";

export interface SkyOptions {
  /** Starting time of day, 0..1: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  time?: number;
  /**
   * Adds K_stars, the density for `skyStars` (0 none .. 1 a dark-site sky), starting at this value:
   * give it the density the scene draws with. Omit to leave the knob out.
   */
  stars?: number;
  /**
   * Adds K_moon, the shared moon's phase for `skyMoonPhase` (lit share 0.05..1 while on, 0 off: no
   * moon), starting on at this phase: 1 is the full moon every scene draws. Needs the SKY_MOON_PHASE
   * feature. Omit to leave the knob out.
   */
  moon?: number;
  /**
   * Adds K_meteors, shooting stars for `meteorAge` (frequency while on, 0 off) with a "now" button on
   * this trigger slot; off unless `on`, at `value` (default 0.3). Omit to leave the knob out.
   */
  meteors?: { trigger: number; on?: boolean; value?: number };
  /** Lab group; default "sky". */
  group?: string;
}

/**
 * K_time: time of day 0..1 (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
 * K_cycle: day-cycle speed (0 = the clock stands at K_time); pass both with uMotionTime to `timeOfDayM`.
 * K_stars (only with `stars`): star density for `skyStars`.
 * K_moon (only with `moon`): the moon's phase for `skyMoonPhase`.
 * K_meteors (only with `meteors`): shooting-star frequency for `meteorAge`, trigger slot `meteors.trigger`.
 */
export function skyKnobs(options: SkyOptions = {}): ParamDef[] {
  const group = options.group ?? "sky";
  const knobs = [
    range(group, "time", "time of day", options.time ?? 0.78, "Midnight at the left end, noon in the middle: sunrise, day, golden hour, dusk, night.", { steady: true }),
    feature(group, "cycle", "day cycle", false, "speed", 0.3, "The sun and moon keep moving: days pass at this pace."),
  ];
  if (options.stars !== undefined) knobs.push(range(group, "stars", "stars", options.stars, "How many stars come out once the sky is dark: none to the left, a dark country sky to the right."));
  if (options.moon !== undefined) {
    knobs.push(feature(group, "moon", "moon", true, "phase", options.moon, "The moon on its nightly path, from a thin crescent to full, its lit side toward the sun: a slimmer moon lights the land, the clouds and the sky round it less and lets stars come out closer to it. Off: a moonless night.", { min: 0.05, max: 1 }));
  }
  if (options.meteors !== undefined) {
    const { trigger, on = false, value = 0.3 } = options.meteors;
    knobs.push(feature(group, "meteors", "shooting stars", on, "frequency", value, "Now and then a shooting star streaks across the open night sky: one every minute or two at the left end, every ten seconds or so at the right. Now: one at once.", { trigger }));
  }
  return knobs;
}

export interface WeatherOptions {
  group?: string;
  /**
   * Adds K_clouds, fair-weather cloud cover 0..1 (0 clear .. 1 a full deck) starting at this value:
   * give it the cover the scene draws with in dry weather. Rain and snow thicken the deck beyond it.
   * Omit to leave the knob out.
   */
  clouds?: number;
  rain?: boolean;
  snow?: boolean;
  fog?: boolean;
  wind?: boolean;
  /** Trigger slot for a "now" button on lightning; omit to leave lightning out. */
  lightning?: number;
  aurora?: boolean;
  /** Which of them start on. */
  on?: Partial<Record<"rain" | "snow" | "lightning" | "aurora", boolean>>;
}

/**
 * The weather layer, as far as a scene wants it:
 * K_clouds fair-weather cover 0..1, K_rain / K_snow amount (0 off; ~0.1 drizzle or a flurry .. 1 a
 * downpour or a blizzard), K_fog 0..1, K_wind -1..1 (left to right), K_lightning strike rate (0 off;
 * its trigger slot fires one strike now), K_aurora strength (0 off). The renderer follows the `rain`
 * and `snow` knobs with `uWeather` (how wet the world is, how much snow lies).
 */
export function weatherKnobs(options: WeatherOptions): ParamDef[] {
  const group = options.group ?? "weather";
  const on = options.on ?? {};
  const knobs: ParamDef[] = [];
  if (options.clouds !== undefined) knobs.push(range(group, "clouds", "cloud cover", options.clouds, "Cloud in fair weather, from a clear sky to a full deck; rain and snow close it further."));
  if (options.rain) knobs.push(feature(group, "rain", "rain", on.rain ?? false, "amount", 0.5, "Rain falling through the scene in depth, from drizzle to a downpour; surfaces get wet and drip."));
  if (options.snow) knobs.push(feature(group, "snow", "snow", on.snow ?? false, "amount", 0.5, "Snow falling through the scene in depth, from a flurry to a blizzard; it settles on the scene."));
  if (options.fog) knobs.push(range(group, "fog", "fog", 0, "Mist settling in: distance fades first."));
  if (options.wind) knobs.push(range(group, "wind", "wind", 0.2, "Which way and how hard the wind blows: slants rain, drifts snow and cloud.", { min: -1, max: 1 }));
  if (options.lightning !== undefined) {
    knobs.push(feature(group, "lightning", "lightning", on.lightning ?? false, "frequency", 0.35, "Forked bolts now and then, lighting up the sky.", { trigger: options.lightning }));
  }
  if (options.aurora) knobs.push(feature(group, "aurora", "aurora", on.aurora ?? false, "strength", 0.6, "Curtains of green and violet light rippling across the night sky."));
  return knobs;
}

/** Lab headings for the shared groups. */
export const atmosphereGroups: Readonly<Record<"sky" | "weather", Blurb>> = {
  sky: { title: "Sky", blurb: "Time of day, and whether the days pass." },
  weather: { title: "Weather", blurb: "Rain, snow, fog, wind, lightning and aurora, shared by every outdoor scene." },
};

export interface SkyThemeOptions {
  /** Paper once the time of day is past this; default 0.33, the sun about 12 degrees up. */
  from?: number;
  /** ... and until it reaches this; default 0.67, the sun back down to about 12 degrees. */
  to?: number;
  /** Only while rain (as the shader reads it, 0 while off) stays below this; needs a `rain` knob. */
  rainBelow?: number;
  /** A further condition on the raw knobs, such as no dark frame around the view. */
  when?: (values: Readonly<Record<string, number>>) => boolean;
}

/**
 * A daylight page: paper while the day cycle is off and the time of day lies strictly between `from`
 * and `to` (and rain below `rainBelow`, and `when` holds), night otherwise. A running cycle keeps
 * changing the light, so the page stays night. Needs `skyKnobs`' `time` and `cycle`; throws
 * KnobError at definition when a knob it reads is missing.
 */
export function skyTheme(params: readonly ParamDef[], options: SkyThemeOptions = {}): SceneTheme {
  const time = knobDef("skyTheme", params, "time");
  const cycle = knobDef("skyTheme", params, "cycle");
  const { from = 0.33, to = 0.67, when } = options;
  const rain = options.rainBelow === undefined ? undefined : { def: knobDef("skyTheme", params, "rain"), below: options.rainBelow };
  return (values) => {
    const hour = effective(time, values);
    const daylight = effective(cycle, values) <= 0 && hour > from && hour < to;
    const dry = rain === undefined || effective(rain.def, values) < rain.below;
    return daylight && dry && (when === undefined || when(values)) ? "paper" : "night";
  };
}

/**
 * A page theme from a choice or toggle knob (a palette, a backdrop, an "ink on paper" switch): paper
 * when `isPaper(index, values)` holds, night otherwise. `index` is the knob's value rounded: the
 * chosen option's value (a palette table's index) or 0/1 for a toggle; `values` are the raw knobs,
 * for any further condition. Throws KnobError at definition for a missing key or another kind of knob.
 */
export function paletteTheme(
  params: readonly ParamDef[],
  key: string,
  isPaper: (index: number, values: Readonly<Record<string, number>>) => boolean,
): SceneTheme {
  const def = knobDef("paletteTheme", params, key);
  if (def.kind !== "choice" && def.kind !== "toggle") throw new KnobError(`paletteTheme: '${key}' is a ${def.kind}, not a choice or toggle`);
  return (values) => (isPaper(Math.round(effective(def, values)), values) ? "paper" : "night");
}
