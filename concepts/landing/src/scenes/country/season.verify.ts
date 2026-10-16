// GPU check (verify-browser.ts, `countrySeason`) of the countryside's farming year, its trodden
// snow and its wind ripples, over the real sim's terrain through the scene's own programs:
//
// - The all-features program (featuresAll) draws each of their settings byte for byte as that
//   setting's own program does: summer, the harvest's bales half laid, autumn, spring, midwinter
//   under its own lying snow and with its rain falling as snow, the passing year, wind ripples on
//   the river, and the default, walkers and carts over lying snow once the snowfall is over.
// - Walkers tread the roads' lying snow, and only lying snow: with snow lying and none falling, the
//   frame with walkers out differs from the one without beyond the figures themselves (the pixels
//   the two differ by on bare ground), darker there; snow still falling fills the way back in, so it
//   darkens it less.
// - Autumn turns the broadleaf trees and leaves the pines: over a countryside of woods alone (no
//   crops or settlements), autumn's broadleaf woods draw many orange cells, near crowns and far
//   canopy alike, and its pine woods next to none, nor does the harvest.
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "../../shaders/index.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_SEASONS } from "./season.ts";
import {
  countryBuild,
  type CountryBuilt,
  countryDraw,
  countryProgram,
  differing,
} from "./terrain.verify.ts";

const WIDTH = 240;
const HEIGHT = 135;
/** Snow lying deep, none falling: the snowfall over. */
const LYING = [0, 0.8] as const;
/** Midwinter (the farming year's coldest) and the snow it lays by itself (climateLying: all). */
const MIDWINTER = { date: 0.875 } as const;
const WINTER_LYING = [0, 1] as const;

interface Setting {
  knobs: Record<string, number>;
  weather?: readonly [number, number];
}

/** The parts' gated and runtime settings, each in the weather that shows it. */
const SETTINGS: readonly Setting[] = [
  { knobs: { date: COUNTRY_SEASONS.summer } },
  { knobs: { date: 0.45 } },
  { knobs: { date: COUNTRY_SEASONS.autumn } },
  { knobs: { date: 0.2 } },
  { knobs: MIDWINTER, weather: WINTER_LYING },
  { knobs: { ...MIDWINTER, rain: 1, "rain-amount": 0.6 }, weather: WINTER_LYING },
  { knobs: { year: 1, "year-amount": 2 } },
  { knobs: { ripples: 0.6, wind: 0.7 } },
  { knobs: {}, weather: LYING },
  { knobs: { walkers: 1 }, weather: LYING },
  { knobs: { carts: 1, "carts-amount": 2 }, weather: LYING },
];

/** A countryside of woods alone, at midday so the light is neutral. */
const WOODS = {
  crops: 0,
  "woodland-amount": 100,
  village: 0,
  hamlets: 0,
  farms: 0,
  castle: 0,
  time: 0.5,
};

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

/** 1 for each pixel whose colour differs between two frames. */
function changed(a: Uint8Array, b: Uint8Array): Uint8Array {
  const mask = new Uint8Array(a.length / 4);
  for (let i = 0; i < mask.length; i++)
    if (a[4 * i] !== b[4 * i] || a[4 * i + 1] !== b[4 * i + 1] || a[4 * i + 2] !== b[4 * i + 2])
      mask[i] = 1;
  return mask;
}

function luma(bytes: Uint8Array, i: number): number {
  return (
    0.299 * (bytes[4 * i] ?? 0) + 0.587 * (bytes[4 * i + 1] ?? 0) + 0.114 * (bytes[4 * i + 2] ?? 0)
  );
}

/** Pixels clearly orange or russet: red well over green and blue. */
function orange(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i] ?? 0;
    if (r > 40 && r > 1.45 * (bytes[i + 1] ?? 0) && r > 2 * (bytes[i + 2] ?? 0)) count++;
  }
  return count;
}

export function verifyCountrySeason(gl: WebGL2RenderingContext): Record<string, unknown> {
  const programs = new Map<string, WebGLProgram>();
  const programFor = (features: Readonly<Record<string, number>>): WebGLProgram => {
    const key = featureKey(features);
    let program = programs.get(key);
    if (!program) {
      program = countryProgram(gl, fragmentSourceFor(countryScene, features));
      programs.set(key, program);
    }
    return program;
  };
  const own = (knobs: Record<string, number>) =>
    programFor(sceneFeatures(countryScene, shaderValues(countryScene, knobs)));
  const draw = (
    built: CountryBuilt,
    program: WebGLProgram,
    knobs: Record<string, number>,
    weather?: readonly [number, number],
  ): Uint8Array => {
    built.step(knobs);
    return countryDraw(gl, program, built, knobs, {
      width: WIDTH,
      height: HEIGHT,
      motionTime: 40,
      ...(weather === undefined ? {} : { weather }),
    });
  };
  let built = countryBuild(gl, {});
  try {
    const all = programFor(sceneFeaturesAll(countryScene) ?? {});
    for (const { knobs, weather } of SETTINGS) {
      const count = differing(
        draw(built, own(knobs), knobs, weather),
        draw(built, all, knobs, weather),
      );
      check(
        count === 0,
        `country: featuresAll draws ${JSON.stringify(knobs)} in ${JSON.stringify(weather ?? [0, 0])} other than its own program (${count} pixels)`,
      );
    }

    // Trodden snow: what walkers change beyond themselves, with the snowfall over and while it falls.
    const walkers = { walkers: 1, "walkers-amount": 1 };
    const figures = changed(draw(built, own({}), {}), draw(built, own(walkers), walkers));
    const tread = (snow: Record<string, number>) => {
      const off = draw(built, own(snow), snow, LYING);
      const on = draw(built, own({ ...snow, ...walkers }), { ...snow, ...walkers }, LYING);
      return {
        off,
        on,
        beyond: changed(off, on).map((value, i) => (figures[i] === 1 ? 0 : value)),
      };
    };
    const after = tread({});
    const trodden = after.beyond.reduce((sum: number, value) => sum + value, 0);
    let darker = 0;
    let deeper = 0;
    after.beyond.forEach((value, i) => {
      if (value === 0) return;
      if (luma(after.on, i) < luma(after.off, i)) darker++;
      deeper += luma(after.off, i) - luma(after.on, i);
    });
    check(trodden >= 60, `country: walkers tread only ${trodden} pixels of the roads' lying snow`);
    check(
      darker >= 0.9 * trodden,
      `country: only ${darker} of the ${trodden} trodden pixels are darker than the untrodden snow`,
    );
    const falling = tread({ snow: 1, "snow-amount": 1 });
    let filled = 0;
    after.beyond.forEach((value, i) => {
      if (value === 1) filled += luma(falling.off, i) - luma(falling.on, i);
    });
    check(
      filled < 0.75 * deeper,
      `country: falling snow does not fill the trodden roads back in (darkening ${(filled / trodden).toFixed(1)} while it falls, ${(deeper / trodden).toFixed(1)} after)`,
    );

    // Autumn over woods alone: the broadleaf turn, the pines stay.
    built.dispose();
    built = countryBuild(gl, WOODS);
    const woods = (pines: number, date: number) => {
      const knobs = { ...WOODS, pines, date };
      return orange(draw(built, own(knobs), knobs));
    };
    const turned = woods(0, COUNTRY_SEASONS.autumn);
    const evergreen = woods(1, COUNTRY_SEASONS.autumn);
    const harvest = woods(0, COUNTRY_SEASONS.harvest);
    check(turned >= 400, `country: autumn turns only ${turned} pixels of broadleaf woods orange`);
    check(
      evergreen <= 0.1 * turned && harvest <= 0.02 * turned,
      `country: orange pixels: autumn broadleaf ${turned}, autumn pine ${evergreen}, harvest broadleaf ${harvest}`,
    );
    return {
      settings: SETTINGS.length,
      trodden,
      darkening: {
        after: Number((deeper / trodden).toFixed(1)),
        falling: Number((filled / trodden).toFixed(1)),
      },
      orange: { autumnBroadleaf: turned, autumnPine: evergreen, harvestBroadleaf: harvest },
      programs: programs.size,
    };
  } finally {
    for (const program of programs.values()) gl.deleteProgram(program);
    built.dispose();
  }
}
