// GPU check (verify-browser.ts, `countryYear`) of the countryside's continuous year, over the real
// sim's terrain through each setting's own program (featuresFor), on a frozen clock:
//
// - The passing year shows the land as the date it has reached: from the harvest at two minutes a
//   season, 62.4 s of the motion clock reach autumn's key and 194.4 s midwinter, each drawn byte for
//   byte as that date is.
// - The climate: at midwinter the rain falls as snow, the frame with rain byte for byte the one with
//   as much snow, while in summer rain is rain. The snow lying there is uWeather.y's alone: over
//   the land with its woods off, without it midwinter's land shows next to no snow white, under it
//   most of the land is white (a wood's crowns catch their own snow, white only in part, and the
//   woods may fill the near ground).
// - Winter bares the broadleaf trees and keeps the pines: over woods alone at midwinter (no snow
//   lying), the broadleaf woods keep a small share of summer's green cells, the pine woods most.
// - Spring over the fields: late in spring the rapeseed is in yellow flower (many more yellow cells
//   than early in spring, when the spring-sown fields lie as bare earth: more earth-brown cells),
//   and the hawthorn's may whitens the hedges (near-white land cells that summer has not).
// - No pops: from summer through the harvest into autumn, and from midwinter through spring, in steps
//   of a few days, no step changes more than a small share of the land's cells, while each stretch
//   changes many.
import { featureKey, sceneFeatures, shaderValues } from "../../shaders/index.ts";
import { loadScene } from "../index.ts";
import { COUNTRY_SEASONS } from "./constants.ts";
import {
  countryBuild,
  type CountryBuilt,
  countryDraw,
  countryProgram,
  countrySource,
  differing,
} from "./terrain.verify.ts";

const countryScene = await loadScene("country");

const WIDTH = 240;
const HEIGHT = 135;
/** The sweeps' smaller frames: the land below the horizon is all they count. */
const SWEEP = { width: 160, height: 90 } as const;
/** Rows (from the bottom) below the horizon, where the land lies, as a share of the frame. */
const LAND_ROWS = 0.55;
const MIDWINTER = 0.875;
/** The passing year at two minutes a season: motion-clock seconds to a whole year. */
const YEAR_SECONDS = 4 * 60 * 2;
const PASSING = { year: 1, "year-amount": 2 } as const;
/** A countryside of woods alone, and one of fields alone, at midday so the light is neutral. */
const BARE = { village: 0, hamlets: 0, farms: 0, castle: 0, time: 0.5 } as const;
const WOODS = { ...BARE, crops: 0, "woodland-amount": 100 };
const FIELDS = { ...BARE, "crops-amount": 100, woodland: 0 };

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country year: ${message}`);
}

/** Cells of the land (below the horizon) that `pick` takes by their colour. */
function count(
  bytes: Uint8Array,
  width: number,
  pick: (r: number, g: number, b: number) => boolean,
): number {
  const rows = Math.floor(LAND_ROWS * (bytes.length / 4 / width));
  let n = 0;
  for (let i = 0; i < rows * width; i++)
    if (pick(bytes[4 * i] ?? 0, bytes[4 * i + 1] ?? 0, bytes[4 * i + 2] ?? 0)) n++;
  return n;
}

const green = (r: number, g: number, b: number) => g > 25 && g > 1.15 * r && g > 1.2 * b;
const yellow = (r: number, g: number, b: number) => r > 120 && g > 0.8 * r && b < 0.4 * g;
const earth = (r: number, g: number, b: number) =>
  r > 40 && g < 0.82 * r && b < 0.65 * r && b > 0.3 * r;
const white = (r: number, g: number, b: number) =>
  Math.min(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 60;

/** Share of the land's cells that clearly change (some channel by more than a tenth) between frames. */
function changedShare(a: Uint8Array, b: Uint8Array, width: number): number {
  const rows = Math.floor(LAND_ROWS * (a.length / 4 / width));
  let n = 0;
  for (let i = 0; i < rows * width; i++) {
    const k = 4 * i;
    const most = Math.max(
      Math.abs((a[k] ?? 0) - (b[k] ?? 0)),
      Math.abs((a[k + 1] ?? 0) - (b[k + 1] ?? 0)),
      Math.abs((a[k + 2] ?? 0) - (b[k + 2] ?? 0)),
    );
    if (most > 25) n++;
  }
  return n / (rows * width);
}

export function verifyCountryYear(gl: WebGL2RenderingContext): Record<string, unknown> {
  const programs = new Map<string, WebGLProgram>();
  const own = (knobs: Record<string, number>): WebGLProgram => {
    const features = sceneFeatures(countryScene, shaderValues(countryScene, knobs));
    const key = featureKey(features);
    let program = programs.get(key);
    if (!program) {
      program = countryProgram(gl, countrySource(features));
      programs.set(key, program);
    }
    return program;
  };
  let built: CountryBuilt | undefined;
  const land = (knobs: Record<string, number>): CountryBuilt => {
    built?.dispose();
    built = countryBuild(gl, knobs);
    return built;
  };
  const draw = (
    at: CountryBuilt,
    knobs: Record<string, number>,
    options: {
      motionTime?: number;
      weather?: readonly [number, number];
      width?: number;
      height?: number;
    } = {},
  ): Uint8Array => {
    at.step(knobs);
    return countryDraw(gl, own(knobs), at, knobs, {
      width: options.width ?? WIDTH,
      height: options.height ?? HEIGHT,
      motionTime: options.motionTime ?? 40,
      ...(options.weather === undefined ? {} : { weather: options.weather }),
    });
  };
  const result: Record<string, unknown> = {};
  try {
    // The passing year reaches autumn's key and midwinter, drawn as those dates are.
    const valley = land({});
    const lying = [0, 1] as const;
    for (const [date, weather] of [
      [COUNTRY_SEASONS.autumn, [0, 0]],
      [MIDWINTER, lying],
    ] as const) {
      const motionTime = (date - COUNTRY_SEASONS.harvest) * YEAR_SECONDS;
      const passed = draw(valley, { ...PASSING }, { motionTime, weather });
      const dated = draw(valley, { season: date }, { motionTime, weather });
      const off = differing(passed, dated);
      check(
        off === 0,
        `the year passing from the harvest to ${date} draws ${off} pixels other than the date`,
      );
    }

    // At midwinter the rain falls as snow; in summer it is rain. Midwinter's lying snow is
    // uWeather.y's alone, over the land with its woods off (the near ground may be wooded).
    const rain = { rain: 1, "rain-amount": 0.8 };
    const snow = { snow: 1, "snow-amount": 0.8 };
    const winterRain = draw(valley, { ...rain, season: MIDWINTER }, { weather: lying });
    const winterSnow = draw(valley, { ...snow, season: MIDWINTER }, { weather: lying });
    const asSnow = differing(winterRain, winterSnow);
    check(asSnow === 0, `midwinter's rain draws ${asSnow} pixels other than its snow`);
    const summerRain = draw(valley, { ...rain, season: COUNTRY_SEASONS.summer });
    const summerSnow = draw(valley, { ...snow, season: COUNTRY_SEASONS.summer });
    result.summerRainVsSnow = differing(summerRain, summerSnow);
    check((result.summerRainVsSnow as number) > 500, "summer's rain draws as its snow");
    const landCells = Math.floor(LAND_ROWS * HEIGHT) * WIDTH;
    const noon = { season: MIDWINTER, time: 0.5, woodland: 0 };
    const bareWhite = count(draw(valley, noon, { weather: [0, 0] }), WIDTH, white);
    const snowWhite = count(draw(valley, noon, { weather: lying }), WIDTH, white);
    result.midwinterWhite = { bare: bareWhite, lying: snowWhite, land: landCells };
    check(
      bareWhite < 0.1 * landCells && snowWhite > 0.6 * landCells,
      `midwinter's white land cells: ${bareWhite} with no snow lying, ${snowWhite} under it, of ${landCells}`,
    );

    // Winter bares the broadleaves and keeps the pines, over the woods' own cells (those the
    // species changes in summer): the broadleaf woods' green goes, the pine woods stay as they were.
    const woods = land(WOODS);
    const at = (pines: number, season: number) =>
      draw(woods, { ...WOODS, farmlandPines: pines, season }, { weather: [0, 0] });
    const frames = {
      broad: { summer: at(0, COUNTRY_SEASONS.summer), winter: at(0, MIDWINTER) },
      pine: { summer: at(1, COUNTRY_SEASONS.summer), winter: at(1, MIDWINTER) },
    };
    const rgb = (bytes: Uint8Array, i: number) =>
      [bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0] as const;
    const moved = (a: Uint8Array, b: Uint8Array, i: number) =>
      [0, 1, 2].some((c) => Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)) > 25);
    let cells = 0;
    const tally = { summerGreen: 0, winterGreen: 0, broadMoved: 0, pineMoved: 0 };
    for (let i = 0; i < frames.broad.summer.length; i += 4) {
      if (!moved(frames.broad.summer, frames.pine.summer, i)) continue;
      cells++;
      if (green(...rgb(frames.broad.summer, i))) tally.summerGreen++;
      if (green(...rgb(frames.broad.winter, i))) tally.winterGreen++;
      if (moved(frames.broad.summer, frames.broad.winter, i)) tally.broadMoved++;
      if (moved(frames.pine.summer, frames.pine.winter, i)) tally.pineMoved++;
    }
    const share = (n: number) => Number((n / Math.max(cells, 1)).toFixed(3));
    const woodsYear = {
      cells,
      broadleafGreen: { summer: share(tally.summerGreen), winter: share(tally.winterGreen) },
      changed: { broadleaf: share(tally.broadMoved), pine: share(tally.pineMoved) },
    };
    result.woods = woodsYear;
    check(cells > 2000, `the woods' species changes only ${cells} cells`);
    check(
      woodsYear.broadleafGreen.summer > 0.6 && woodsYear.broadleafGreen.winter < 0.15,
      `green share of the broadleaf woods: ${woodsYear.broadleafGreen.summer} in summer, ${woodsYear.broadleafGreen.winter} at midwinter`,
    );
    check(
      woodsYear.changed.broadleaf > 0.6 && woodsYear.changed.pine < 0.25,
      `share of the woods changed from summer to midwinter: broadleaf ${woodsYear.changed.broadleaf}, pine ${woodsYear.changed.pine}`,
    );

    // Spring over the fields: bare earth early, the rapeseed in flower late, the may in the hedges.
    const fields = land(FIELDS);
    const early = draw(fields, { ...FIELDS, season: 0.06 });
    const late = draw(fields, { ...FIELDS, season: 0.23 });
    const summer = draw(fields, { ...FIELDS, season: COUNTRY_SEASONS.summer });
    const spring = {
      yellow: { early: count(early, WIDTH, yellow), late: count(late, WIDTH, yellow) },
      earth: { early: count(early, WIDTH, earth), late: count(late, WIDTH, earth) },
      white: { late: count(late, WIDTH, white), summer: count(summer, WIDTH, white) },
    };
    result.spring = spring;
    // The floor only guards against rapeseed out of frame (early spring draws 0): no layout's luck.
    check(
      spring.yellow.late > 40 && spring.yellow.late > 4 * spring.yellow.early,
      `rapeseed's yellow cells: ${spring.yellow.early} early in spring, ${spring.yellow.late} late`,
    );
    check(
      spring.earth.early > 1.5 * spring.earth.late,
      `earth-brown cells: ${spring.earth.early} early in spring, ${spring.earth.late} late`,
    );
    check(
      spring.white.late > spring.white.summer + 20,
      `near-white land cells: ${spring.white.late} with the may out, ${spring.white.summer} in summer`,
    );

    // No pops: the season knob's steps (0.005 of the year, under two days) through the busiest
    // stretches; the most any step changes against the whole stretch's change (a season that
    // switched at once would change all of it in one step).
    const sweep = (from: number, to: number): { step: number; whole: number } => {
      let last: Uint8Array | undefined;
      let first: Uint8Array | undefined;
      let step = 0;
      for (let k = 0; from + 0.005 * k <= to + 1e-9; k++) {
        const date = Math.round((from + 0.005 * k) * 1000) / 1000;
        const frame = draw(fields, { ...FIELDS, season: date % 1 }, SWEEP);
        if (last) step = Math.max(step, changedShare(last, frame, SWEEP.width));
        first ??= frame;
        last = frame;
      }
      return {
        step: Number(step.toFixed(4)),
        whole: first && last ? Number(changedShare(first, last, SWEEP.width).toFixed(4)) : 0,
      };
    };
    const sweeps = {
      harvest: sweep(COUNTRY_SEASONS.summer, COUNTRY_SEASONS.autumn),
      greening: sweep(0.95, 1.3),
    };
    result.sweeps = sweeps;
    for (const [name, { step, whole }] of Object.entries(sweeps))
      check(
        step < 0.08 && whole > 5 * step && whole > 0.2,
        `the ${name} sweep changes ${(100 * step).toFixed(1)}% of the land in one step, ${(100 * whole).toFixed(1)}% over it`,
      );
    result.programs = programs.size;
    return result;
  } finally {
    for (const program of programs.values()) gl.deleteProgram(program);
    built?.dispose();
  }
}
