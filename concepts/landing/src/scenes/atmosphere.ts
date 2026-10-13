// Shared lab knobs for outdoor scenes: time of day, and the weather layer (rain, snow, fog, wind,
// lightning, aurora). Every scene that uses them gets the same keys, labels and help, so a setting
// means the same thing everywhere; the GLSL side lives in src/shaders/lib/ and reads them through
// the generated K_<key> defines (K_time, K_cycle, K_rain, K_snow, K_fog, K_wind, K_lightning, K_aurora).
import { feature, range, type Blurb, type ParamDef } from "../params.ts";

export interface SkyOptions {
  /** Starting time of day, 0..1: 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
  time?: number;
  /** Lab group; default "sky". */
  group?: string;
}

/**
 * K_time: time of day 0..1 (0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
 * K_cycle: day-cycle speed (0 = the clock stands at K_time); pass both to `timeOfDay`.
 */
export function skyKnobs(options: SkyOptions = {}): ParamDef[] {
  const group = options.group ?? "sky";
  return [
    range(group, "time", "time of day", options.time ?? 0.78, "Midnight at the left end, noon in the middle: sunrise, day, golden hour, dusk, night.", { steady: true }),
    feature(group, "cycle", "day cycle", false, "speed", 0.3, "The sun and moon keep moving: days pass at this pace."),
  ];
}

export interface WeatherOptions {
  group?: string;
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
 * K_rain / K_snow amount (0 off), K_fog 0..1, K_wind -1..1 (left to right), K_lightning strike
 * rate (0 off; its trigger slot fires one strike now), K_aurora strength (0 off).
 */
export function weatherKnobs(options: WeatherOptions): ParamDef[] {
  const group = options.group ?? "weather";
  const on = options.on ?? {};
  const knobs: ParamDef[] = [];
  if (options.rain) knobs.push(feature(group, "rain", "rain", on.rain ?? false, "amount", 0.5, "Rain falling through the scene, nearer drops faster and longer."));
  if (options.snow) knobs.push(feature(group, "snow", "snow", on.snow ?? false, "amount", 0.5, "Snowflakes drifting down in layers, the nearest large and soft."));
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
