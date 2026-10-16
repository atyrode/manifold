// The world's knobs and compile-time gates, for a scene that composes the shared world
// (shaders/lib/world.ts, worldGlsl): one atmosphere with the same keys, labels and help in every
// scene (the shared builders' own: skyKnobs, weatherKnobs, birdKnobs), its defaults a sensible
// ambient world, and its parts compiled in only while their knobs can show them. The contract and
// how a scene adopts it: src/scenes/README.md ("World layers").
import type { Blurb, ParamDef } from "../params.ts";
import { birdKnobs, birdsGroup, type BirdOptions } from "../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../shaders/lib/clouds.ts";
import { WORLD_BIRD_HOURS } from "../shaders/lib/world.ts";
import { skyKnobs, weatherKnobs, type WeatherOptions } from "./atmosphere.ts";

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
} as const;

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
 * K_milkyWay, K_moon, K_meteors (skyKnobs); K_clouds, K_shadows, K_rain, K_snow, K_fog,
 * K_lightning, K_aurora, then K_wind (weatherKnobs); K_birds, K_birdKind, K_birdFormation
 * (birdKnobs). Defaults: an ambient world, with fair-weather cloud, the stars, the moon and the
 * Milky Way at night and birds by day on; shooting stars, cloud shadows, rain, snow, fog, lightning
 * and the aurora off; wind 0.2. The scene gives its hour, its trigger slots and its birds.
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
    }),
    ...weatherKnobs({
      group: weather,
      auroraGroup: sky,
      clouds: options.clouds ?? WORLD_DEFAULTS.clouds,
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
      "Time of day, whether the days pass, and the night sky: its stars and the Milky Way, the moon's phase, the odd shooting star and the aurora.",
  },
  weather: {
    title: "Weather",
    shelf: "world",
    blurb:
      "Cloud and its shadows, rain, snow, fog, wind and lightning: one weather, shared by every outdoor scene.",
  },
  birds: birdsGroup,
};

/** The K_time contract: the sun crosses the horizon at these times of day, and is up between. */
const SUNRISE = 0.25;
const SUNSET = 0.75;

/**
 * The world's compile-time gates for knob values as the shader reads them (SceneDef.featuresFor:
 * merge them into the scene's own), each 0 or 1, on wherever its knobs can show its part:
 * WORLD_STARS, WORLD_MILKYWAY, WORLD_AURORA and WORLD_METEORS only where night can fall (the day
 * cycle on, or the hour outside sunrise..sunset, where the sky's night is exactly 0), WORLD_BIRDS
 * only within WORLD_BIRD_HOURS; WORLD_CLOUDS while there is fair-weather cloud, rain or snow,
 * WORLD_SHADOWS (with CLOUD_TIER at the shadows tier) while they are on too; WORLD_RAIN, WORLD_SNOW,
 * WORLD_FOG while on. Shooting stars and lightning have a "now" button that shows one while their
 * knob is off, so their gates hold whenever one could show: the meteors' whenever night can fall,
 * lightning's always. SKY_MOON_PHASE while the moon is off or short of full (a full moon is the
 * sky library's own).
 */
export function worldFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (key: string) => ((values[key] ?? 0) > 0 ? 1 : 0);
  const time = values["time"] ?? 0;
  const cycle = on("cycle") === 1;
  const night = cycle || time < SUNRISE || time > SUNSET ? 1 : 0;
  const day = cycle || (time > WORLD_BIRD_HOURS[0] && time < WORLD_BIRD_HOURS[3]) ? 1 : 0;
  const clouds = Math.max(on("clouds"), on("rain"), on("snow"));
  const shadows = clouds * on("shadows");
  return {
    WORLD_STARS: night * on("stars"),
    WORLD_MILKYWAY: night * on("stars") * on("milkyWay"),
    WORLD_METEORS: night,
    WORLD_AURORA: night * on("aurora"),
    WORLD_CLOUDS: clouds,
    WORLD_SHADOWS: shadows,
    CLOUD_TIER: shadows ? CLOUD_TIERS.shadows : CLOUD_TIERS.lit,
    WORLD_BIRDS: day * on("birds"),
    WORLD_RAIN: on("rain"),
    WORLD_SNOW: on("snow"),
    WORLD_FOG: on("fog"),
    WORLD_LIGHTNING: 1,
    ...((values["moon"] ?? 1) < 1 ? { SKY_MOON_PHASE: 1 } : {}),
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
  rain: 1,
  snow: 1,
  fog: 1,
  moon: 0.5,
});
