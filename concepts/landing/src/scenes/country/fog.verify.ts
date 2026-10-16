// GPU check (verify-browser.ts, `countryFog`): the valley fog reads the land. The countryside's real
// sim, drawn by the scene's own programs with the fog off and on, and a probe of the same march that
// tells each pixel's distance along its ray and the height of the land it meets there:
//   - the fog's program with the knob at 0 draws the fog-off program's picture byte for byte (at
//     dawn, and at night with the windows lit);
//   - at dawn with the fog on, in each band of distance from the eye, the lowest quarter of the land
//     seen there (the valley floor, the river) is changed by the fog clearly more than the highest
//     quarter (the valley's sides, the ridges and hilltops): the bank lies in the valley and the
//     high ground rises out of it, wherever along the view;
//   - the sky just over the skyline takes the fog too;
//   - by midday the same knob changes the land less than at dawn (the bank burns off).
// A pixel's change is how far its colour moves from the fog-off picture's (RGB distance, 0..441).
import { fragmentSourceFor, sceneFeatures, shaderValues } from "../../shaders/index.ts";
import { countryScene } from "./index.ts";
import { countryBuild, countryDraw, countryProgram, differing } from "./terrain.verify.ts";

const WIDTH = 192;
const HEIGHT = 108;
/** The fog's amount drawn, and the hours: dawn and midday. */
const FOG = 0.5;
const DAWN = 0.27;
const MIDDAY = 0.5;
/** Bands of distance from the eye (metres) the low and high ground are compared within. */
const BANDS = [
  [500, 1200],
  [1200, 2000],
  [2000, 3200],
] as const;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`country fog: ${message}`);
}

// The probe: each pixel's ray marched as the scene marches it; r, g its distance to the land in
// 10 m (high, low byte), b the land's height there in 2 m; all 0 where it meets none (the sky).
const probeGlsl = /* glsl */ `
Shade probeFog(vec2 uv, vec2 cell, float t) {
  countryFwd = vec3(COUNTRY_HEADING.x, 0.0, COUNTRY_HEADING.y);
  countryRight = vec3(COUNTRY_HEADING.y, 0.0, -COUNTRY_HEADING.x);
  vec3 rd = countryToWorld(viewRay(uv, uRes.x / uRes.y, COUNTRY_HORIZON, COUNTRY_FOV));
  vec3 eye = terrainEye(uSim3);
  float hit = countryMarch(eye, rd);
  if (hit <= 0.0) return shadeOf(vec3(0.0), 0.0, 0.0);
  float d = clamp(floor(hit / 10.0), 1.0, 65535.0);
  float high = floor(d / 256.0);
  float y = clamp(floor((eye.y + rd.y * hit) / 2.0), 0.0, 255.0);
  return shadeOf(vec3(high, d - 256.0 * high, y) / 255.0, 0.0, 0.0);
}
`;

/** RGB distance between two frames, a pixel each. */
function changes(a: Uint8Array, b: Uint8Array): Float32Array {
  const out = new Float32Array(a.length / 4);
  for (let k = 0; k < out.length; k++) {
    const dr = (a[4 * k] ?? 0) - (b[4 * k] ?? 0);
    const dg = (a[4 * k + 1] ?? 0) - (b[4 * k + 1] ?? 0);
    const db = (a[4 * k + 2] ?? 0) - (b[4 * k + 2] ?? 0);
    out[k] = Math.hypot(dr, dg, db);
  }
  return out;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const round = (value: number): number => Number(value.toFixed(1));

export function verifyCountryFog(gl: WebGL2RenderingContext): Record<string, unknown> {
  const featuresFor = (knobs: Record<string, number>) =>
    sceneFeatures(countryScene, shaderValues(countryScene, knobs));
  const off = countryProgram(gl, fragmentSourceFor(countryScene, featuresFor({ fog: 0 })));
  const on = countryProgram(gl, fragmentSourceFor(countryScene, featuresFor({ fog: FOG })));
  const probe = countryProgram(
    gl,
    fragmentSourceFor(
      { ...countryScene, entry: "probeFog", glsl: countryScene.glsl + probeGlsl },
      featuresFor({ fog: 0 }),
    ),
  );
  const built = countryBuild(gl, {});
  try {
    const result: Record<string, unknown> = {};
    // The fog compiled in, at 0: the fog-off program's picture.
    for (const time of [DAWN, 0.86]) {
      const count = differing(
        countryDraw(gl, off, built, { time }),
        countryDraw(gl, on, built, { time, fog: 0 }),
      );
      check(count === 0, `with the knob at 0 the fog's program changes ${count} pixels at ${time}`);
    }
    const where = countryDraw(gl, probe, built, {});
    const dawn = changes(
      countryDraw(gl, on, built, { time: DAWN, fog: FOG }),
      countryDraw(gl, off, built, { time: DAWN }),
    );
    const midday = changes(
      countryDraw(gl, on, built, { time: MIDDAY, fog: FOG }),
      countryDraw(gl, off, built, { time: MIDDAY }),
    );
    const land: { distance: number; height: number; change: number }[] = [];
    const sky: number[] = [];
    const landNoon: number[] = [];
    const skyline = new Int32Array(WIDTH).fill(-1);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const k = y * WIDTH + x;
        const distance = 10 * (256 * (where[4 * k] ?? 0) + (where[4 * k + 1] ?? 0));
        if (distance > 0) {
          land.push({ distance, height: 2 * (where[4 * k + 2] ?? 0), change: dawn[k] ?? 0 });
          landNoon.push(midday[k] ?? 0);
          skyline[x] = y;
        }
      }
    }
    // The sky's rows just over the skyline (rows run up from the bottom).
    for (let x = 0; x < WIDTH; x++) {
      const top = skyline[x] ?? -1;
      for (let y = top + 1; y <= top + 4 && y < HEIGHT; y++) sky.push(dawn[y * WIDTH + x] ?? 0);
    }
    const bands = BANDS.map(([near, far]) => {
      const inBand = land
        .filter((point) => point.distance >= near && point.distance < far)
        .sort((a, b) => a.height - b.height);
      const quarter = Math.floor(inBand.length / 4);
      check(quarter >= 40, `only ${inBand.length} pixels of land ${near}..${far} m off`);
      const low = inBand.slice(0, quarter);
      const high = inBand.slice(inBand.length - quarter);
      return {
        band: `${near}..${far} m`,
        lowHeight: round(mean(low.map((point) => point.height))),
        highHeight: round(mean(high.map((point) => point.height))),
        low: round(mean(low.map((point) => point.change))),
        high: round(mean(high.map((point) => point.change))),
      };
    });
    result.bands = bands;
    for (const band of bands) {
      check(
        band.low > 1.3 * band.high && band.low - band.high > 25,
        `${band.band}: the low ground (${band.lowHeight} m) changes ${band.low}, the high (${band.highHeight} m) ${band.high}`,
      );
    }
    const horizon = mean(sky);
    result.horizon = round(horizon);
    check(horizon > 6, `the sky over the skyline changes only ${round(horizon)}`);
    const atDawn = mean(land.map((point) => point.change));
    const atNoon = mean(landNoon);
    result.land = { dawn: round(atDawn), midday: round(atNoon) };
    check(
      atNoon < 0.75 * atDawn,
      `the land changes ${round(atNoon)} at midday, ${round(atDawn)} at dawn`,
    );
    return result;
  } finally {
    built.dispose();
    gl.deleteProgram(off);
    gl.deleteProgram(on);
    gl.deleteProgram(probe);
  }
}
