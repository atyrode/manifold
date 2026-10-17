// Shared lab knobs for outdoor scenes: time of day, and the weather layer (rain, snow, fog, wind,
// lightning, aurora), plus the opt-in sky components (star density, the Milky Way, the moon's phase,
// shooting stars, constellations and the agents' star-joining) and fair-weather cloud with its
// shadows. Every scene that uses them gets the same keys, labels and help, so a setting means the
// same thing everywhere; the GLSL side lives in src/shaders/lib/ and reads them through the
// generated K_<key> defines (K_time, K_cycle, K_stars, K_milkyWay, K_moon, K_meteors,
// K_constellations, K_join, K_clouds, K_shadows, K_rain, K_snow, K_fog, K_wind, K_lightning,
// K_aurora). The night sky's planets are no knobs but a list of their own (SceneDef.planets,
// src/scenes/planets.ts). How a scene composes them: src/scenes/README.md.
//
// The page theme is decided here too (skyTheme, paletteTheme), once, from the knobs: the shader reads
// the outcome with pagePaper() instead of repeating the test.
import {
  counts,
  effective,
  feature,
  knobDef,
  KnobError,
  range,
  type Blurb,
  type ParamDef,
  type Recipe,
} from "../params.ts";
import { DAY_CYCLE_RATE } from "../world-clock.ts";
import type { SceneTheme } from "./types.ts";

export interface SkyComponentOptions {
  /**
   * Adds K_stars, the density for `skyStars` (0 none .. 1 a dark-site sky), starting at this value:
   * give it the density the scene draws with. Omit to leave the knob out.
   */
  stars?: number;
  /**
   * Adds K_milkyWay, the band's brightness for `milkyWay` (shaders/lib/milkyway.ts: a gain while on,
   * 0 off), off unless `on`, at `value` (default 1, the band as the component draws it).
   */
  milkyWay?: { on?: boolean; value?: number };
  /**
   * Adds K_moon, the shared moon's phase for `skyMoonPhase` through a lunation while on (0.05 a thin
   * waxing crescent, its lit share up to 1 full, then waning to 1.95 a thin waning crescent: its lit
   * share 2 - K_moon; 0 off: no moon), starting on at this phase: 1 is the full moon every scene
   * draws. Needs the SKY_MOON_PHASE feature. Omit to leave the knob out.
   */
  moon?: number;
  /**
   * Adds K_meteors, shooting stars for `meteorAge` (frequency while on, 0 off) with a "now" button on
   * this trigger slot; off unless `on`, at `value` (default 0.3). Omit to leave the knob out.
   */
  meteors?: { trigger: number; on?: boolean; value?: number };
  /**
   * Adds K_constellations, the stick figures' lines for `skyStars` (0.05 a trace .. 1 clear while on,
   * 0 off: no figures), off at 0.4, and after it K_join, the agents' star-joining (how many
   * figures they join a night while on, 0 off; src/constellations.ts), on at all six. Only for a
   * scene whose stars come from `skyStars`.
   */
  constellations?: boolean;
  /** Lab group; default "sky". */
  group?: string;
}

export interface SkyOptions extends SkyComponentOptions {
  /** Starting time of day, 0..1: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  time?: number;
}

/**
 * The opt-in sky components alone, without the clock: for a scene that keeps a night of its own (an
 * hour knob, a fixed night, a painted sky) and composes components into it, most often shooting stars.
 * K_stars, K_milkyWay, K_moon, K_meteors, K_constellations and K_join as for `skyKnobs`, in that
 * order.
 */
export function skyComponentKnobs(options: SkyComponentOptions = {}): ParamDef[] {
  const group = options.group ?? "sky";
  const knobs: ParamDef[] = [];
  if (options.stars !== undefined)
    knobs.push(
      range(
        group,
        "stars",
        "stars",
        options.stars,
        "How many stars come out once the sky is dark: none to the left, a dark country sky to the right.",
        { widget: { kind: "night", part: "stars" } },
      ),
    );
  if (options.milkyWay !== undefined) {
    const { on = false, value = 1 } = options.milkyWay;
    knobs.push(
      feature(
        group,
        "milkyWay",
        "Milky Way",
        on,
        "brightness",
        value,
        "The band of our galaxy across the dark sky: soft clouds of stars split by a dark lane of dust, more stars crowding into it than the sky around it. Faint to the left, twice as bright to the right. Off: no band, the stars as thin everywhere as they are away from it.",
        { min: 0.1, max: 2, widget: { kind: "night", part: "milkyWay" } },
      ),
    );
  }
  if (options.moon !== undefined) {
    knobs.push(
      feature(
        group,
        "moon",
        "moon",
        true,
        "phase",
        options.moon,
        "The moon through its month, waxing from a thin crescent to full at the middle, then waning: it stands where its phase puts it, its lit side toward the sun. A waxing crescent trails the sun and hangs over the sunset, a first quarter stands a quarter of the sky east of it and a gibbous moon rises toward dusk; past full it rises later each night, the last quarter at midnight, and a waning crescent comes up just before the sun. A slimmer moon lights the land, the clouds and the sky round it far less and lets stars come out closer to it. Off: a moonless night.",
        { min: 0.05, max: 1.95, widget: { kind: "night", part: "moon" } },
      ),
    );
  }
  if (options.meteors !== undefined) {
    const { trigger, on = false, value = 0.3 } = options.meteors;
    knobs.push(
      feature(
        group,
        "meteors",
        "shooting stars",
        on,
        "frequency",
        value,
        "Now and then a shooting star streaks across the open night sky: one every minute or two at the left end, every ten seconds or so at the right. Now: one at once.",
        { trigger, widget: { kind: "night", part: "meteors" } },
      ),
    );
  }
  if (options.constellations === true)
    knobs.push(
      feature(
        group,
        "constellations",
        "constellations",
        false,
        "lines",
        0.4,
        "Six familiar figures among the stars: Orion, the Big Dipper, Cassiopeia, Cygnus, Leo and the Southern Cross, their stars brighter than the rest, in the same place every night and turning with the stars while the days pass. Lines: the stars standing out with the faintest trace of the figures to the left, clear stick figures to the right. They come out with the stars.",
        { min: 0.05, max: 1, widget: { kind: "night", part: "constellations" } },
      ),
      feature(
        group,
        "join",
        "star-joining",
        true,
        "figures",
        6,
        "The agents' chore while the lab has agents in the scene and the constellations are out: once night has fallen they leave the page in turn to join a figure's stars, its lines growing star by star behind a cursor among the stars, and come back between figures. The lines stand until dawn fades them with the stars; the next night the figures are joined afresh, starting one further on. Figures: how many of the six they join a night.",
        { options: counts(1, 2, 3, 4, 5, 6), when: "constellations", icon: "constellation" },
      ),
    );
  return knobs;
}

/**
 * K_time: time of day 0..1 (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
 * K_cycle: day-cycle speed (0 = the clock stands at K_time), a rate knob: `timeOfDayM(K_time, skyDays())`.
 * K_stars (only with `stars`): star density for `skyStars`.
 * K_milkyWay (only with `milkyWay`): the Milky Way's brightness for `milkyWay`.
 * K_moon (only with `moon`): the moon's phase for `skyMoonPhase` (below 1 waxing, 1 full, above waning).
 * K_meteors (only with `meteors`): shooting-star frequency for `meteorAge`, trigger slot `meteors.trigger`.
 * K_constellations (only with `constellations`): drawn by `skyStars` itself, as is K_join, the
 * agents' star-joining that comes with it.
 */
export function skyKnobs(options: SkyOptions = {}): ParamDef[] {
  const group = options.group ?? "sky";
  return [
    range(
      group,
      "time",
      "time of day",
      options.time ?? 0.78,
      "Midnight at the left end, noon in the middle: sunrise, day, golden hour, dusk, night.",
      { steady: true, widget: { kind: "sky", part: "time" } },
    ),
    feature(
      group,
      "cycle",
      "day cycle",
      false,
      "speed",
      0.3,
      "The sun and moon keep moving and the stars turn: days pass at this pace.",
      { widget: { kind: "sky", part: "cycle" }, rate: DAY_CYCLE_RATE },
    ),
    ...skyComponentKnobs({ ...options, group }),
  ];
}

export interface WeatherOptions {
  group?: string;
  /** Lab group of the aurora, which hangs in the sky; default "sky". */
  auroraGroup?: string;
  /**
   * Adds K_clouds, fair-weather cloud cover 0..1 (0 clear .. 1 a full deck) starting at this value:
   * give it the cover the scene draws with in dry weather. Rain and snow thicken the deck beyond it.
   * Omit to leave the knob out.
   */
  clouds?: number;
  /**
   * Adds K_shadows, how dark the cloud deck's shadows fall on the ground (`skyCloudShadow`, the
   * CLOUD_SHADOWS tier: darkness 0.6 while on, 0 off), off unless `on.shadows`.
   */
  shadows?: boolean;
  rain?: boolean;
  snow?: boolean;
  fog?: boolean;
  wind?: boolean;
  /** Trigger slot for a "now" button on lightning; omit to leave lightning out. */
  lightning?: number;
  aurora?: boolean;
  /** Which of them start on. */
  on?: Partial<Record<"shadows" | "rain" | "snow" | "lightning" | "aurora", boolean>>;
}

/**
 * The weather layer, as far as a scene wants it:
 * K_clouds fair-weather cover 0..1, K_shadows the cloud shadows' darkness (0 off), K_rain / K_snow
 * amount (0 off; ~0.1 drizzle or a flurry .. 1 a downpour or a blizzard), K_fog 0..1, K_wind -1..1
 * (left to right), K_lightning strike rate (0 off; its trigger slot fires one strike now), K_aurora
 * strength (0 off). The renderer follows the `rain` and `snow` knobs with `uWeather` (how wet the
 * world is, how much snow lies).
 */
export function weatherKnobs(options: WeatherOptions): ParamDef[] {
  const group = options.group ?? "weather";
  const on = options.on ?? {};
  const knobs: ParamDef[] = [];
  if (options.clouds !== undefined)
    knobs.push(
      range(
        group,
        "clouds",
        "cloud cover",
        options.clouds,
        "Cloud in fair weather, from a clear sky to a full deck; rain and snow close it further.",
      ),
    );
  if (options.shadows)
    knobs.push(
      feature(
        group,
        "shadows",
        "cloud shadows",
        on.shadows ?? false,
        "darkness",
        0.6,
        "Shadows of the clouds drifting over the ground wherever the deck crosses the sun, and how dark they fall.",
      ),
    );
  if (options.rain)
    knobs.push(
      feature(
        group,
        "rain",
        "rain",
        on.rain ?? false,
        "amount",
        0.5,
        "Rain falling through the scene in depth, from drizzle to a downpour; surfaces get wet and drip.",
      ),
    );
  if (options.snow)
    knobs.push(
      feature(
        group,
        "snow",
        "snow",
        on.snow ?? false,
        "amount",
        0.5,
        "Snow falling through the scene in depth, from a flurry to a blizzard; it settles on the scene.",
      ),
    );
  if (options.fog)
    knobs.push(range(group, "fog", "fog", 0, "Mist settling in: distance fades first."));
  if (options.wind)
    knobs.push(
      range(
        group,
        "wind",
        "wind",
        0.2,
        "Which way and how hard the wind blows: slants rain, drifts snow and cloud.",
        { min: -1, max: 1, widget: { kind: "direction" } },
      ),
    );
  if (options.lightning !== undefined) {
    knobs.push(
      feature(
        group,
        "lightning",
        "lightning",
        on.lightning ?? false,
        "frequency",
        0.35,
        "Forked bolts now and then, lighting up the sky.",
        { trigger: options.lightning },
      ),
    );
  }
  if (options.aurora)
    knobs.push(
      feature(
        options.auroraGroup ?? "sky",
        "aurora",
        "aurora",
        on.aurora ?? false,
        "strength",
        0.6,
        "Curtains of green and violet light rippling across the night sky.",
        { widget: { kind: "night", part: "aurora" } },
      ),
    );
  return knobs;
}

/**
 * The sky's recipes, for the shared sky headings: moments of the day with the clock stopped, and
 * nights for the sky components, clearing the weather that would hide them.
 */
export const skyRecipes: readonly Recipe[] = [
  {
    label: "Dawn",
    icon: "sunrise",
    help: "The sun on the horizon, the first warm light; the clock stands still.",
    set: { time: 0.25, cycle: 0 },
    needs: ["time"],
  },
  {
    label: "Noon",
    icon: "noon",
    help: "The sun at its highest, short shadows; the clock stands still.",
    set: { time: 0.5, cycle: 0 },
    needs: ["time"],
  },
  {
    label: "Golden hour",
    icon: "goldenHour",
    help: "The sun low before it sets, long warm light; the clock stands still.",
    set: { time: 0.7, cycle: 0 },
    needs: ["time"],
  },
  {
    label: "Starry night",
    icon: "stars",
    help: "Midnight with no moon and nothing overhead: every star out, and the Milky Way where there is one.",
    set: {
      time: 0,
      cycle: 0,
      stars: 1,
      moon: 0,
      milkyWay: 1,
      "milkyWay-amount": 1.5,
      clouds: 0,
      rain: 0,
      snow: 0,
      fog: 0,
    },
    needs: ["stars"],
  },
  {
    label: "Full-moon night",
    icon: "fullMoon",
    help: "Midnight under a full moon: moonlight on the land, a few clouds silvered by it.",
    set: {
      time: 0,
      cycle: 0,
      moon: 1,
      "moon-amount": 1,
      clouds: 0.2,
      "clouds-amount": 0.2,
      rain: 0,
      snow: 0,
      fog: 0,
    },
    needs: ["moon"],
  },
  {
    label: "Meteor shower",
    icon: "meteor",
    help: "A clear, moonless midnight with a shooting star every few seconds.",
    set: {
      time: 0,
      cycle: 0,
      meteors: 1,
      "meteors-amount": 1,
      stars: 0.9,
      moon: 0,
      clouds: 0,
      rain: 0,
      snow: 0,
      fog: 0,
    },
    needs: ["meteors"],
  },
  {
    label: "Aurora night",
    icon: "aurora",
    help: "A clear, moonless midnight with the aurora's curtains bright overhead.",
    set: {
      time: 0,
      cycle: 0,
      aurora: 1,
      "aurora-amount": 0.9,
      moon: 0,
      clouds: 0,
      rain: 0,
      snow: 0,
      fog: 0,
    },
    needs: ["aurora"],
  },
];

/**
 * The weather's recipes, for the shared weather headings: each sets the cloud, rain, snow, fog and
 * lightning outright (and the wind where it shapes the weather), so none inherits another's leftovers.
 */
export const weatherRecipes: readonly Recipe[] = [
  {
    label: "Clear",
    icon: "sun",
    help: "A clear sky: no cloud, rain, snow, fog or lightning.",
    set: { clouds: 0, shadows: 0, rain: 0, snow: 0, fog: 0, lightning: 0 },
  },
  {
    label: "Fair",
    icon: "fair",
    help: "Fair-weather cumulus drifting over, their shadows sweeping the ground; dry and bright.",
    set: {
      clouds: 0.3,
      "clouds-amount": 0.3,
      shadows: 1,
      "shadows-amount": 0.5,
      rain: 0,
      snow: 0,
      fog: 0,
      lightning: 0,
    },
    needs: ["clouds"],
  },
  {
    label: "Overcast",
    icon: "overcast",
    help: "A full grey deck, no sun to cast shadows; dry, the distance a little hazy.",
    set: {
      clouds: 0.9,
      "clouds-amount": 0.9,
      shadows: 0,
      rain: 0,
      snow: 0,
      fog: 0.1,
      lightning: 0,
    },
    needs: ["clouds"],
  },
  {
    label: "Drizzle",
    icon: "drizzle",
    help: "A low grey sky and a fine rain falling almost straight, a soft mist over the distance.",
    set: {
      clouds: 0.8,
      "clouds-amount": 0.8,
      shadows: 0,
      rain: 1,
      "rain-amount": 0.15,
      snow: 0,
      fog: 0.15,
      lightning: 0,
      wind: 0.1,
    },
    needs: ["rain"],
  },
  {
    label: "Downpour",
    icon: "rain",
    help: "Heavy rain out of a closed sky, slanting in the wind, the far side lost in it.",
    set: {
      clouds: 1,
      "clouds-amount": 1,
      shadows: 0,
      rain: 1,
      "rain-amount": 0.9,
      snow: 0,
      fog: 0.3,
      lightning: 0,
      wind: 0.35,
    },
    needs: ["rain"],
  },
  {
    label: "Thunderstorm",
    icon: "lightning",
    help: "A storm: a dark deck, driving rain, a strong wind and lightning forking down.",
    set: {
      clouds: 1,
      "clouds-amount": 1,
      shadows: 0,
      rain: 1,
      "rain-amount": 0.75,
      snow: 0,
      fog: 0.15,
      lightning: 1,
      "lightning-amount": 0.7,
      wind: 0.6,
    },
    needs: ["lightning"],
  },
  {
    label: "Snowfall",
    icon: "snow",
    help: "Snow drifting down out of a soft grey sky on a light breeze, settling as it falls.",
    set: {
      clouds: 0.85,
      "clouds-amount": 0.85,
      shadows: 0,
      rain: 0,
      snow: 1,
      "snow-amount": 0.4,
      fog: 0.1,
      lightning: 0,
      wind: 0.1,
    },
    needs: ["snow"],
  },
  {
    label: "Blizzard",
    icon: "blizzard",
    help: "Thick snow driven sideways by a gale, the distance whited out.",
    set: {
      clouds: 1,
      "clouds-amount": 1,
      shadows: 0,
      rain: 0,
      snow: 1,
      "snow-amount": 1,
      fog: 0.5,
      lightning: 0,
      wind: 0.9,
    },
    needs: ["snow"],
  },
  {
    label: "Fog",
    icon: "fog",
    help: "Still air and thick fog: the distance fades to nothing under a grey sky.",
    set: {
      clouds: 0.6,
      "clouds-amount": 0.6,
      shadows: 0,
      rain: 0,
      snow: 0,
      fog: 0.8,
      lightning: 0,
      wind: 0.05,
    },
    needs: ["fog"],
  },
];

/**
 * Lab headings for the shared groups, on the lab's World shelf: `skyNight` for a sky group that also
 * holds sky components.
 */
export const atmosphereGroups: Readonly<Record<"sky" | "skyNight" | "weather", Blurb>> = {
  sky: {
    title: "Sky",
    shelf: "world",
    blurb: "Time of day, and whether the days pass.",
    recipes: skyRecipes,
  },
  skyNight: {
    title: "Sky",
    shelf: "world",
    blurb:
      "Time of day, whether the days pass, and the night sky: its stars, the moon's phase, the odd shooting star.",
    recipes: skyRecipes,
  },
  weather: {
    title: "Weather",
    shelf: "world",
    blurb: "Cloud, rain, snow, fog, wind and lightning, shared by every outdoor scene.",
    recipes: weatherRecipes,
  },
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
  const rain =
    options.rainBelow === undefined
      ? undefined
      : { def: knobDef("skyTheme", params, "rain"), below: options.rainBelow };
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
  if (def.kind !== "choice" && def.kind !== "toggle")
    throw new KnobError(`paletteTheme: '${key}' is a ${def.kind}, not a choice or toggle`);
  return (values) => (isPaper(Math.round(effective(def, values)), values) ? "paper" : "night");
}
