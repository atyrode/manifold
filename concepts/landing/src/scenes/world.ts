// The world's knobs and compile-time gates, for a scene that composes the shared world
// (shaders/lib/world.ts, worldGlsl): one atmosphere with the same keys, labels and help in every
// scene (the shared builders' own: skyKnobs, weatherKnobs, birdKnobs), its defaults a sensible
// ambient world, and its parts compiled in only while their knobs can show them. The contract and
// how a scene adopts it: src/scenes/README.md ("World layers").
import { hasClimate } from "../climate.ts";
import { feature, type Blurb, type ParamDef } from "../params.ts";
import { birdKnobs, birdsGroup, type BirdOptions } from "../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../shaders/lib/clouds.ts";
import { WORLD_BIRD_HOURS } from "../shaders/lib/world.ts";
import { skyState, SUNRISE, SUNSET, timeOfDay } from "../world-clock.ts";
import {
  skyKnobs,
  skyRecipes,
  weatherKnobs,
  weatherRecipes,
  type WeatherOptions,
} from "./atmosphere.ts";

/** The world's defaults where a scene gives none of its own. */
export const WORLD_DEFAULTS = {
  /** K_stars: the night sky's star density. */
  stars: 0.6,
  /** K_moon: its starting phase, full. */
  moon: 1,
  /** K_clouds: fair-weather cumulus. */
  clouds: 0.25,
  /** K_birds: how often a flight passes, by day. */
  birds: 0.35,
  /** K_cumulus: the painted cumulus towers, off; their size once switched on. */
  cumulus: { on: false, value: 0.55 },
} as const;

/**
 * The sun's elevation (the sine, skyState's sun.y) at or below which WORLD_DAYLIGHT goes off: skyAt's
 * night is whole from -0.26 down (its day and sunColor 0 from -0.02 and -0.035), less a margin for
 * the shader's single precision.
 */
const WORLD_DEEP_NIGHT = -0.27;

export interface WorldOptions {
  /** Starting time of day, 0..1: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  time: number;
  /** K_stars' starting density; default WORLD_DEFAULTS.stars. */
  stars?: number;
  /** K_moon's starting phase (on); default full. */
  moon?: number;
  /** K_milkyWay: on unless `on: false`, at `value` (default 1). */
  milkyWay?: { on?: boolean; value?: number };
  /** K_meteors: the "now" button's trigger slot; off unless `on`, at `value` (default 0.3). */
  meteors: { trigger: number; on?: boolean; value?: number };
  /** K_clouds' fair-weather cover; default WORLD_DEFAULTS.clouds. */
  clouds?: number;
  /** K_cumulus: the painted cumulus towers, on if `on`, at `value`; default WORLD_DEFAULTS.cumulus. */
  cumulus?: { on?: boolean; value?: number };
  /** K_lightning's "now" trigger slot. */
  lightning: number;
  /** Which of the cloud shadows, rain, snow, lightning and aurora start on; all off by default. */
  on?: WeatherOptions["on"];
  /** The birds: the scene's species and help; on unless `on: false`, at WORLD_DEFAULTS.birds. */
  birds: BirdOptions;
  /**
   * Lab groups: "sky" (the aurora too), "weather" (wind too unless `wind` names its own) and
   * "birds" by default.
   */
  groups?: { sky?: string; weather?: string; wind?: string; birds?: string };
}

/**
 * The whole atmosphere as knobs, in the shared builders' keys: K_time, K_cycle, K_stars,
 * K_milkyWay, K_moon, K_meteors and K_constellations (skyKnobs); K_clouds, K_cumulus (the world's
 * own), K_shadows, K_rain, K_snow, K_fog, K_lightning, K_aurora, then K_wind (weatherKnobs); K_birds,
 * K_birdKind, K_birdFormation (birdKnobs). Defaults: an ambient world, with fair-weather cloud, the
 * stars, the moon and the Milky Way at night and birds by day on; the painted cumulus, shooting
 * stars, the constellations, cloud shadows, rain, snow, fog, lightning and the aurora off; wind 0.2.
 * The scene gives its hour, its trigger slots and its birds (and its planets' stretch of sky,
 * SceneDef.planets).
 */
export function worldKnobs(options: WorldOptions): ParamDef[] {
  const groups = options.groups ?? {};
  const sky = groups.sky ?? "sky";
  const weather = groups.weather ?? "weather";
  return [
    ...skyKnobs({
      group: sky,
      time: options.time,
      stars: options.stars ?? WORLD_DEFAULTS.stars,
      milkyWay: { on: true, ...options.milkyWay },
      moon: options.moon ?? WORLD_DEFAULTS.moon,
      meteors: options.meteors,
      constellations: true,
    }),
    ...weatherKnobs({ group: weather, clouds: options.clouds ?? WORLD_DEFAULTS.clouds }),
    feature(
      weather,
      "cumulus",
      "cumulus towers",
      options.cumulus?.on ?? WORLD_DEFAULTS.cumulus.on,
      "size",
      options.cumulus?.value ?? WORLD_DEFAULTS.cumulus.value,
      "Tall summer cumulus standing on the horizon in front of the cloud deck, painted: their sunlit crowns cream with a glowing rim, their shaded sides and flat bases blue-grey. They drift slowly with the wind and their shadows sweep over the land; as rain or snow closes the sky they grey, flatten and sink into the deck. Size: small and fewer to the left, big towers to the right.",
    ),
    ...weatherKnobs({
      group: weather,
      auroraGroup: sky,
      shadows: true,
      rain: true,
      snow: true,
      fog: true,
      lightning: options.lightning,
      aurora: true,
      ...(options.on === undefined ? {} : { on: options.on }),
    }),
    ...weatherKnobs({ group: groups.wind ?? weather, wind: true }),
    ...birdKnobs({
      on: true,
      often: WORLD_DEFAULTS.birds,
      ...options.birds,
      group: groups.birds ?? options.birds.group ?? "birds",
    }),
  ];
}

/** Lab headings for worldKnobs' groups, on the lab's World shelf. */
export const worldGroups: Readonly<Record<"sky" | "weather" | "birds", Blurb>> = {
  sky: {
    title: "Sky",
    shelf: "world",
    blurb:
      "Time of day, whether the days pass, and the night sky: its stars and constellations, the Milky Way, the moon's phase, its planets, the odd shooting star and the aurora.",
    recipes: skyRecipes,
  },
  weather: {
    title: "Weather",
    shelf: "world",
    blurb:
      "Cloud and its shadows, the cumulus towers on the horizon, rain, snow, fog, wind and lightning: one weather, shared by every outdoor scene.",
    recipes: weatherRecipes,
  },
  birds: birdsGroup,
};

/**
 * The World over a patch seen from above (the overhead composer, ADR 0062 "The World seen from
 * every camera"), the very knobs worldKnobs lists, under their keys and meaning: K_rain and K_wind
 * over a patch open to the sky; and where the sky lights it (`sky`: LayerDef.sunlit), first the hour
 * (K_time, K_cycle) and the cloud (K_clouds, K_shadows: its shadows off, as the World's), so
 * time, cycle, clouds, shadows, rain, wind. The hour's default is skyKnobs'; a preset pins its own.
 * Drops fall on the fall clock (uFallTime), the wind and the cloud drift on the motion clock.
 */
export function worldPatchKnobs(sky = false): ParamDef[] {
  return [
    ...(sky ? skyKnobs({}) : []),
    ...weatherKnobs({
      ...(sky ? { clouds: WORLD_DEFAULTS.clouds, shadows: true } : {}),
      rain: true,
      wind: true,
    }),
  ];
}

/**
 * The lab headings of worldPatchKnobs' groups, on the lab's World shelf: "weather" over a patch open
 * to the sky (`weather`, rain and wind alone), "sky" and "weather" over one the sky lights (`lit`).
 */
export const worldPatchGroups: Readonly<{
  weather: Blurb;
  lit: Readonly<Record<"sky" | "weather", Blurb>>;
}> = {
  weather: {
    title: "Weather",
    shelf: "world",
    blurb:
      "The World's rain and wind over the patch: every drop rings the water, the rings run and cross, and the wind roughens the surface.",
  },
  lit: {
    sky: {
      title: "Sky",
      shelf: "world",
      blurb:
        "The World's hour over the patch, and whether the days pass: where the sun stands and how it lights the water, and the moon's light by night.",
    },
    weather: {
      title: "Weather",
      shelf: "world",
      blurb:
        "The World's cloud, rain and wind over the patch: cloud shadows drifting over it with the wind, the rain's grey light, every drop ringing the water, the wind roughening it.",
    },
  },
};

/**
 * worldFeatures' gates for worldPatchKnobs: WORLD_RAIN while it rains, so a dry patch compiles none
 * of it; where the sky lights the patch (`sky`), WORLD_CLOUDS and WORLD_SHADOWS (with CLOUD_TIER)
 * too, so a clear sky or one without shadows compiles none of the deck's.
 */
export function worldPatchFeatures(
  values: Readonly<Record<string, number>>,
  sky = false,
): Record<string, number> {
  const world = worldFeatures(values);
  const rain = { WORLD_RAIN: world["WORLD_RAIN"] ?? 0 };
  if (!sky) return rain;
  return {
    ...rain,
    WORLD_CLOUDS: world["WORLD_CLOUDS"] ?? 0,
    WORLD_SHADOWS: world["WORLD_SHADOWS"] ?? 0,
    CLOUD_TIER: world["CLOUD_TIER"] ?? CLOUD_TIERS.lit,
  };
}

/**
 * The world's compile-time gates for knob values as the shader reads them (SceneDef.featuresFor:
 * merge them into the scene's own), each 0 or 1, on wherever its knobs can show its part:
 * WORLD_STARS, WORLD_MILKYWAY, WORLD_AURORA and WORLD_METEORS only where night can fall (the day
 * cycle on, or the hour outside the world clock's SUNRISE..SUNSET, between which the sky's night is
 * exactly 0 on any date), WORLD_BIRDS only within WORLD_BIRD_HOURS; WORLD_CLOUDS while there is
 * fair-weather cloud, rain or snow, WORLD_SHADOWS (with CLOUD_TIER at the shadows tier) while they
 * are on too; WORLD_CUMULUS, WORLD_RAIN, WORLD_SNOW, WORLD_FOG while on. Shooting stars and
 * lightning have a "now" button that shows one while their knob is off, so their gates hold
 * whenever one could show: the meteors' whenever night can fall, lightning's always. Where the season
 * sets the scene's climate (`climate`: climate.ts hasClimate, a season and a snow knob), its rain may
 * fall as snow (worldAt), so WORLD_SNOW holds with the rain too. SKY_MOON_PHASE while the moon is off
 * or short of full or past it (a full moon is the sky library's own).
 *
 * What a setting settles before its program runs, each gate on where it does not: the shower's and
 * the storm's own events while their knobs are on (WORLD_METEOR_RATE, WORLD_LIGHTNING_RATE; off, the
 * "now" buttons' alone), the moon's phase while there is a moon (WORLD_MOON: off at K_moon 0 or 2),
 * and the sun's light (WORLD_DAYLIGHT: off with the day cycle off at an hour whose sun stands below
 * WORLD_DEEP_NIGHT on the undated sky, so that its night is exactly 1, its day and sunColor exactly
 * 0; on wherever the season dates the sky). Each draws what the runtime path draws there, exactly.
 */
export function worldFeatures(
  values: Readonly<Record<string, number>>,
  climate = false,
): Record<string, number> {
  const on = (key: string) => ((values[key] ?? 0) > 0 ? 1 : 0);
  const time = values["time"] ?? 0;
  const cycle = on("cycle") === 1;
  const night = cycle || time < SUNRISE || time > SUNSET ? 1 : 0;
  const day = cycle || (time > WORLD_BIRD_HOURS[0] && time < WORLD_BIRD_HOURS[3]) ? 1 : 0;
  const daylight = cycle || climate || skyState(timeOfDay(time, 0)).sun[1] > WORLD_DEEP_NIGHT;
  const moon = values["moon"] ?? 1;
  const clouds = Math.max(on("clouds"), on("rain"), on("snow"));
  const shadows = clouds * on("shadows");
  return {
    WORLD_STARS: night * on("stars"),
    WORLD_MILKYWAY: night * on("stars") * on("milkyWay"),
    WORLD_METEORS: night,
    WORLD_METEOR_RATE: on("meteors"),
    WORLD_AURORA: night * on("aurora"),
    WORLD_CLOUDS: clouds,
    WORLD_SHADOWS: shadows,
    CLOUD_TIER: shadows ? CLOUD_TIERS.shadows : CLOUD_TIERS.lit,
    WORLD_BIRDS: day * on("birds"),
    WORLD_CUMULUS: on("cumulus"),
    WORLD_RAIN: on("rain"),
    WORLD_SNOW: climate ? Math.max(on("snow"), on("rain")) : on("snow"),
    WORLD_FOG: on("fog"),
    WORLD_LIGHTNING: 1,
    WORLD_LIGHTNING_RATE: on("lightning"),
    WORLD_MOON: moon > 0 && moon < 2 ? 1 : 0,
    WORLD_DAYLIGHT: daylight ? 1 : 0,
    ...(moon !== 1 ? { SKY_MOON_PHASE: 1 } : {}),
  };
}

/**
 * Every world gate on and the cloud tier at shadows (SceneDef.featuresAll: merge it into the
 * scene's own): the parts' runtime tests of their knobs decide, so this program draws every setting
 * as that setting's own program does.
 */
export const WORLD_ALL = worldFeatures({
  time: 0,
  cycle: 1,
  stars: 1,
  milkyWay: 1,
  aurora: 1,
  clouds: 1,
  shadows: 1,
  birds: 1,
  cumulus: 1,
  rain: 1,
  snow: 1,
  fog: 1,
  meteors: 1,
  lightning: 1,
  moon: 0.5,
});

/** The world's knobs whose parts compile in behind a gate of their own (worldFeatures). */
const WORLD_GATED = [
  "stars",
  "milkyWay",
  "meteors",
  "aurora",
  "clouds",
  "shadows",
  "birds",
  "cumulus",
  "rain",
  "snow",
  "fog",
  "lightning",
] as const;

/**
 * The world's gates for a scene that draws through the world with sky and weather knobs of its own
 * (skyKnobs, weatherKnobs rather than worldKnobs) and compiles in, at every setting, each part its
 * knobs can show (SceneDef.features, no featuresFor): worldFeatures with every gated knob it has on
 * and the day cycle on, so the night's parts and the sun's light are in; lightning only with a
 * lightning knob, the moon's phase (a moon in it: K_moon 0.5) only with a moon knob. A part whose knob
 * is off draws its neutral value by its runtime test; one whose knob the scene lacks stays out. Set a
 * part the scene draws its own way to 0 over it (its own birds: WORLD_BIRDS).
 */
export function worldGates(params: readonly ParamDef[]): Record<string, number> {
  const keys = new Set(params.map((def) => def.key));
  const on = Object.fromEntries(WORLD_GATED.filter((key) => keys.has(key)).map((key) => [key, 1]));
  return {
    ...worldFeatures({ ...on, cycle: 1, moon: keys.has("moon") ? 0.5 : 1 }, hasClimate(params)),
    WORLD_LIGHTNING: keys.has("lightning") ? 1 : 0,
  };
}
