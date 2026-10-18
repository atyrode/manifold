// GPU check (verify-browser.ts, `worldClock`) that the world clock's GLSL mirror (worldClockGlsl in
// world-clock.ts, the climate's in climate.ts) works out what the TypeScript model does, and that a
// dated sky stands as staged at its default date:
// - mirror: a probe compiled with the garden's knobs evaluates skyAtWorld and skyMoonPhase over
//   hours, dates (sun shifts), star turns and phases into a float target, with skyStarFrame, the
//   date shift, the star turn and the climate's chill and cold; each value matches skyState and its
//   kin within MIRROR (float32 against float64).
// - staged: the garden's and the countryside's programs at their defaults draw byte for byte what
//   the same programs draw undated (SKY_DATE_ANCHOR left out), and at another date they do not.
import { climateChill, climateCold, climateLying, fallingSnow } from "./climate.ts";
import { loadScene } from "./scenes/index.ts";
import { assembleFragment, fragmentSourceFor, packParams, sceneFeatures } from "./shaders/index.ts";
import { shakeGlsl } from "./shaders/shake.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./state.ts";
import { check, drawFloats, link, readBytes } from "./verify/kit.ts";
import { dateShift, skyState, starFrame, starTurn, timeOfDay } from "./world-clock.ts";

const gardenScene = await loadScene("garden");
const countryScene = await loadScene("country");

/** How far a GPU value may stand from the model's. */
const MIRROR = 5e-4;
const HOURS = 24;
const SHIFTS = [0, dateShift(0.375, 0.625), dateShift(0.75, 0.47)] as const;
/** The stars' turn at each of SHIFTS' dates: as staged, with the day cycle on, by the date alone. */
const TURNS = [0, starTurn((0.3 * 37) / 240, 0.375, 0.625), starTurn(0, 0.75, 0.47)] as const;
/**
 * Full (the staged moon untouched), moving onto it (moonStaging), by its elongation waxing and waning
 * (K_moon past full), and none.
 */
const PHASES = [1, 0.95, 0.3, 1.6, 0] as const;
/** RGB texels a case writes, along x. */
const FIELDS = 10;
const PROBE_NORM = Math.hypot(0.3, 0.5, 0.8);
const PROBE_DIR = [0.3 / PROBE_NORM, 0.5 / PROBE_NORM, 0.8 / PROBE_NORM] as const;
/** The [texel, channel] the probe writes angles to: the stars' turn, the worldStarTurn. */
const ANGLES: Readonly<Record<string, true>> = { "6.1": true, "9.2": true };

// Case y (hour, shift, turn and phase from its index) writes texel x: 0 sun, 1 moon, 2 sunColor,
// 3 ambient, 4 moonColor, 5 (day, twilight, night), 6 (moonPhase, starTurn, timeOfDayM with the days
// a cycle of 0.3 runs in 123.4 s and the hour), 7 the probe direction in the stars' frame, 8 the
// climate at the hour taken as a year (chill, cold, lying), 9 (the rain of 0.6 that falls as snow
// there, worldDateShift(year, 0.625), worldStarTurn of the days a cycle of 0.3 runs in 37 + 500 year
// s, year, 0.47)). The raw view (uView 1) writes the source unclamped.
const PROBE = `
uniform vec3 uShifts;
uniform vec3 uTurns;
uniform float uMoonPhases[${PHASES.length}];
uniform vec3 uProbeDir;

Shade worldClockProbe(vec2 uv, vec2 cell, float t) {
  int i = int(cell.y);
  int field = int(cell.x);
  float tod = float(i % ${HOURS}) / ${HOURS}.0;
  int k = (i / ${HOURS}) % 3;
  int p = i / (${HOURS} * 3);
  Sky sky = skyMoonPhase(skyAtWorld(tod, uShifts[k], uTurns[k]), uMoonPhases[p]);
  float cold = climateCold(tod);
  vec3 v;
  if (field == 0) v = sky.sun;
  else if (field == 1) v = sky.moon;
  else if (field == 2) v = sky.sunColor;
  else if (field == 3) v = sky.ambient;
  else if (field == 4) v = sky.moonColor;
  else if (field == 5) v = vec3(sky.day, sky.twilight, sky.night);
  else if (field == 6) v = vec3(sky.moonPhase, sky.starTurn, timeOfDayM(0.7, 0.3 * (123.4 + tod) / 240.0));
  else if (field == 7) v = skyStarFrame(sky, uProbeDir);
  else if (field == 8) v = vec3(climateChill(tod), cold, climateLying(cold));
  else v = vec3(climatePrecip(0.6, 0.0, cold).y, worldDateShift(tod, 0.625), worldStarTurn(0.3 * (37.0 + 500.0 * tod) / 240.0, tod, 0.47));
  Shade o = blankShade();
  o.source = v;
  return o;
}
`;

/** The model's values for case `i`, texel by texel, as the probe writes them. */
function expected(i: number): readonly (readonly number[])[] {
  const tod = (i % HOURS) / HOURS;
  const k = Math.floor(i / HOURS) % 3;
  const shift = SHIFTS[k] ?? 0;
  const turn = TURNS[k] ?? 0;
  const phase = PHASES[Math.floor(i / (HOURS * 3))] ?? 1;
  const s = skyState(tod, { shift, turn, phase });
  const cold = climateCold(tod);
  return [
    s.sun,
    s.moon,
    s.sunColor,
    s.ambient,
    s.moonColor,
    [s.day, s.twilight, s.night],
    [s.moonPhase, s.starTurn, timeOfDay(0.7, (0.3 * (123.4 + tod)) / 240)],
    starFrame(PROBE_DIR, turn),
    [climateChill(tod), cold, climateLying(cold)],
    [
      fallingSnow(0.6, 0, cold),
      dateShift(tod, 0.625),
      starTurn((0.3 * (37 + 500 * tod)) / 240, tod, 0.47),
    ],
  ];
}

/** The scene drawn at 8-bit, its knobs as given, its program with or without its staged date. */
function drawScene(
  gl: WebGL2RenderingContext,
  id: "garden" | "country",
  dated: boolean,
  over: Record<string, number>,
): Uint8Array {
  const scene = id === "garden" ? gardenScene : countryScene;
  // Assembled whole, so the date anchor can be left out before the program is shaken.
  const source = assembleFragment(scene, sceneFeatures(scene));
  const fragment = dated ? source : source.replace(/#define SKY_DATE_ANCHOR [^\n]*\n/, "");
  check(dated || fragment !== source, `${id} has no staged date to leave out`);
  const linked = link(gl, shakeGlsl(fragment));
  const width = 160;
  const height = 90;
  gl.viewport(0, 0, width, height);
  gl.useProgram(linked);
  const location = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(location("uRes"), width, height);
  gl.uniform1i(location("uView"), 1);
  gl.uniform1f(location("uTime"), 40);
  gl.uniform1f(location("uMotionTime"), 40);
  gl.uniform1f(location("uMotion"), 1);
  gl.uniform2f(location("uPassage"), 1, 0);
  gl.uniform4fv(
    location("uParams"),
    packParams(renderSettings(defaultsFor(id), { ...paramDefaults(id), ...over }).params),
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = readBytes(gl, width, height);
  gl.deleteProgram(linked);
  return bytes;
}

const differing = (a: Uint8Array, b: Uint8Array): number =>
  a.reduce((n, value, i) => n + (value === b[i] ? 0 : 1), 0);

export function verifyWorldClock(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  // The probe in place of the garden's composed program (its glslFor), with the garden's knobs.
  const { glslFor: composed, ...garden } = gardenScene;
  check(composed !== undefined, "the garden is not composed");
  const probe = link(
    gl,
    fragmentSourceFor(
      { ...garden, entry: "worldClockProbe", glsl: PROBE },
      { ...sceneFeatures(garden), SKY_MOON_PHASE: 1 },
    ),
  );
  const cases = HOURS * 3 * PHASES.length;
  const out = drawFloats(gl, FIELDS, cases, () => {
    gl.useProgram(probe);
    const location = (name: string) => gl.getUniformLocation(probe, name);
    gl.uniform2f(location("uRes"), FIELDS, cases);
    gl.uniform1i(location("uView"), 1);
    gl.uniform3fv(location("uShifts"), Float32Array.from(SHIFTS));
    gl.uniform3fv(location("uTurns"), Float32Array.from(TURNS));
    gl.uniform1fv(location("uMoonPhases"), Float32Array.from(PHASES));
    gl.uniform3fv(location("uProbeDir"), Float32Array.from(PROBE_DIR));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  gl.deleteProgram(probe);
  let worst = 0;
  let where = "";
  for (let i = 0; i < cases; i++) {
    expected(i).forEach((texel, field) =>
      texel.forEach((value, c) => {
        const gpu = out[(i * FIELDS + field) * 4 + c] ?? Number.NaN;
        // Turns are angles: a turn just short of a whole one is one just past none.
        const off = ANGLES[`${field}.${c}`]
          ? Math.abs(Math.atan2(Math.sin(gpu - value), Math.cos(gpu - value)))
          : Math.abs(gpu - value);
        if (!(off <= worst)) {
          worst = Number.isNaN(off) ? Number.POSITIVE_INFINITY : off;
          where = `case ${i} texel ${field}.${c}: GPU ${gpu}, model ${value}`;
        }
      }),
    );
  }
  check(worst <= MIRROR, `the GLSL parts from the model by ${worst} (${where})`);

  // Staged at the default date: dated and undated draw alike; another date moves the sky.
  const staged: Record<string, number> = {};
  for (const [id, other] of [
    ["garden", { season: 1 }],
    ["country", { date: 0.2 }],
  ] as const) {
    const off = differing(drawScene(gl, id, true, {}), drawScene(gl, id, false, {}));
    check(off === 0, `${id} at its defaults draws ${off} bytes off its undated sky`);
    const moved = differing(drawScene(gl, id, true, other), drawScene(gl, id, false, other));
    check(moved > 0, `${id}'s sky stands still at another date`);
    staged[id] = moved;
  }
  return { worst, cases, movedAtAnotherDate: staged };
}
