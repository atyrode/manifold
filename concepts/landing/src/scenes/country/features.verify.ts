// GPU check (verify-browser.ts, `countryFeaturesAll`) of the countryside's compile-time features,
// over the real sim's land through the scene's own programs: the all-features program of a
// setting's layers (featuresAllFor: a layer switch builds another layer set's program) draws every
// setting, as source and dithered in the scene's look, byte for byte as that setting's own program
// (featuresFor) does. The settings are each knob turn within the default layers that changes the
// program and all of them at once (gatedTurns, src/knob-turns.ts: a knob added later is covered
// without a list to edit), then NAMED, the conditions no single turn from the defaults reaches and
// the layers the default leaves off. Each distinct program compiles once and is freed after the last
// setting it draws. The renderer's side of the features (background builds, no waits on a build,
// the programs it keeps) is checked by sceneFeatures and featureToggles (src/features.verify.ts).
import { gatedTurns } from "../../knob-turns.ts";
import { colorIds, ditherIds } from "../../renderer.ts";
import { featureKey, sceneFeatures, sceneFeaturesAll, shaderValues } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { loadScene } from "../index.ts";
import { COUNTRY_SEASONS } from "./constants.ts";
import {
  countryBuild,
  countryDraw,
  countryProgram,
  countrySource,
  differing,
} from "./terrain.verify.ts";

const countryScene = await loadScene("country");

interface Setting {
  knobs: Record<string, number>;
  /** uWeather: how wet the land is and how much snow lies on it (default none). */
  weather?: readonly [number, number];
}

/** Snow lying deep, none falling: the snowfall over. */
const LYING = [0, 0.8] as const;
/** Midwinter (the farming year's coldest) and the snow it lays by itself (climateLying: all). */
const MIDWINTER = { season: 0.875 } as const;
const WINTER_LYING = [0, 1] as const;

/**
 * The settings a single knob turn from the defaults does not reach, each in the weather that shows
 * it: the default; broadleaf woods without pines; lit windows and smoke at dusk, and dusk with them
 * off; the verges, and the murmuration at its hour (each its layer joining the default ones); the
 * farming year (summer, the harvest's bales half laid, autumn, spring, midwinter under its own
 * lying snow and with its rain falling as snow, the year passing); wind ripples on the river; the
 * default, walkers and carts over lying snow once the snowfall is over; and last, since they
 * rebuild the terrain, the roads and tracks off, then the village too.
 */
const NAMED: readonly Setting[] = [
  { knobs: {} },
  { knobs: { farmlandPines: 0 } },
  { knobs: { time: 0.8 } },
  { knobs: { time: 0.8, lights: 0, settlementsSmoke: 0 } },
  { knobs: { verges: 1 } },
  { knobs: { starlings: 1, time: 0.72 } },
  { knobs: { season: COUNTRY_SEASONS.summer } },
  { knobs: { season: 0.45 } },
  { knobs: { season: COUNTRY_SEASONS.autumn } },
  { knobs: { season: 0.2 } },
  { knobs: MIDWINTER, weather: WINTER_LYING },
  { knobs: { ...MIDWINTER, rain: 1, "rain-amount": 0.6 }, weather: WINTER_LYING },
  { knobs: { year: 1, "year-amount": 2 } },
  { knobs: { waterwayRipples: 0.6, wind: 0.7 } },
  { knobs: {}, weather: LYING },
  { knobs: { walkers: 1 }, weather: LYING },
  { knobs: { carts: 1, "carts-amount": 2 }, weather: LYING },
  { knobs: { roads: 0, tracks: 0 } },
  { knobs: { roads: 0, tracks: 0, village: 0 } },
];

/** uView: 1 the source picture, 0 dithered. */
const VIEWS = [1, 0] as const;

export function verifyCountryFeaturesAll(gl: WebGL2RenderingContext): Record<string, unknown> {
  const settings: Setting[] = [
    ...gatedTurns(countryScene, true).map((knobs) => ({ knobs })),
    ...NAMED,
  ];
  const values = settings.map(({ knobs }) => shaderValues(countryScene, knobs));
  // Each setting's own program, and its layer set's all-features program.
  const owns = values.map((v) => sceneFeatures(countryScene, v));
  const alls = values.map((v) => sceneFeaturesAll(countryScene, v) ?? {});
  const ownKeys = owns.map(featureKey);
  const allKeys = alls.map(featureKey);
  // How many draws of settings each program has still to make, so it is freed after its last.
  const pending = new Map<string, number>();
  for (const key of [...ownKeys, ...allKeys]) pending.set(key, (pending.get(key) ?? 0) + 1);
  // The scene's look, so the dithered view quantizes the colours its page would.
  const look = renderSettings(defaultsFor("country"), paramDefaults("country"));
  // Seconds spent linking programs and drawing with each kind (a program's first draw may finish
  // its compile).
  const spent = { link: 0, own: 0, all: 0 };
  const timed = <T>(part: keyof typeof spent, run: () => T): T => {
    const started = performance.now();
    try {
      return run();
    } finally {
      spent[part] += (performance.now() - started) / 1000;
    }
  };
  const compile = (set: Readonly<Record<string, number>>): WebGLProgram =>
    timed("link", () => {
      const program = countryProgram(gl, countrySource(set));
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "uColor"), colorIds.indexOf(look.color));
      gl.uniform1i(gl.getUniformLocation(program, "uDither"), ditherIds.indexOf(look.dither));
      gl.uniform1f(gl.getUniformLocation(program, "uLevels"), look.levels);
      return program;
    });
  const built = countryBuild(gl, {});
  // By feature key, each until the last setting it draws.
  const programs = new Map<string, WebGLProgram>();
  let compiled = 0;
  const linkedFor = (key: string, set: Readonly<Record<string, number>>): WebGLProgram => {
    let linked = programs.get(key);
    if (linked === undefined) {
      linked = compile(set);
      programs.set(key, linked);
      compiled++;
    }
    return linked;
  };
  const drawn = (key: string): void => {
    const left = (pending.get(key) ?? 1) - 1;
    pending.set(key, left);
    const linked = programs.get(key);
    if (left === 0 && linked !== undefined) {
      gl.deleteProgram(linked);
      programs.delete(key);
    }
  };
  try {
    const mismatches: string[] = [];
    for (const [index, { knobs, weather }] of settings.entries()) {
      const allKey = allKeys[index] ?? "";
      const ownKey = ownKeys[index] ?? "";
      const all = linkedFor(allKey, alls[index] ?? {});
      const own = linkedFor(ownKey, owns[index] ?? {});
      built.step(knobs);
      for (const view of VIEWS) {
        const options = {
          width: 160,
          height: 90,
          motionTime: 40,
          view,
          ...(weather === undefined ? {} : { weather }),
        };
        const count = differing(
          timed("own", () => countryDraw(gl, own, built, knobs, options)),
          timed("all", () => countryDraw(gl, all, built, knobs, options)),
        );
        if (count > 0)
          mismatches.push(
            `${view === 1 ? "source" : "dithered"} ${JSON.stringify(knobs)} in ${JSON.stringify(weather ?? [0, 0])}: ${count} pixels`,
          );
      }
      drawn(ownKey);
      drawn(allKey);
    }
    if (mismatches.length > 0)
      throw new Error(
        `country: featuresAll draws other than each setting's own program: ${mismatches.join("; ")}`,
      );
    const seconds = Object.fromEntries(
      Object.entries(spent).map(([part, value]) => [part, Math.round(value * 10) / 10]),
    );
    return { settings: settings.length, programs: compiled, seconds };
  } finally {
    for (const program of programs.values()) gl.deleteProgram(program);
    built.dispose();
  }
}
