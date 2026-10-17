// GPU regressions for the night sky's opt-in parts, the constellations (skyStars, src/shaders/lib/
// sky.ts), compiled in only while their knob is on (the library gate SKY_FIGURES), and the planets
// (skyGiant), compiled in only while the scene's list holds any (SKY_PLANETS); run by
// concepts/landing/verify-browser.ts on real WebGL output.
// - `nightSky`: a probe compiled with Frost's knobs and every gate on samples skyStars, both
//   overloads, at every figure's stars and the middle of every figure line. At a clear midnight the
//   figures add light there while on (the lines as strong as their amount), and the knobs off draw
//   exactly what a program without them draws; by day, and with no stars, nothing; at a coarse
//   footprint the points still show.
// - `nightPlanets`: in two skies (the lake's fjord under its slow drapes, and the island at
//   midnight), two planets of different kinds each change the night sky where their placements put
//   them (the one placed further left, further left on screen), together as each alone does round
//   itself; an orbiting planet drifts left with the motion clock and, half a circuit on, has set: the
//   sky is then the empty list's again, byte for byte. A run scoped to some scenes draws only the
//   skies among them.
import { constellationUniforms } from "./constellations.ts";
import { effective, type ParamDef } from "./params.ts";
import {
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
  packParams,
} from "./shaders/index.ts";
import { skyFigurePoint, skyFigures } from "./shaders/lib/sky.ts";
import { loadScene, type SceneId } from "./scenes/index.ts";
import { planetUniforms, readPlanet, type SkyPlanet } from "./scenes/planets.ts";
import type { LoadedScene } from "./scenes/types.ts";
import { paramDefaults } from "./state.ts";
import { check, drawFloats, LAKE_FJORD, link, VerifyError, walk } from "./verify/kit.ts";

const frostScene = await loadScene("frost");

/** The shared night knobs with library gates (skyComponentKnobs' constellations). */
const nightPart = (def: ParamDef): boolean =>
  def.widget?.kind === "night" && def.widget.part === "constellations";

interface Draw {
  readonly width: number;
  readonly height: number;
  readonly params: readonly number[];
  readonly uniforms?: Readonly<Record<string, readonly number[]>>;
  /** Integer uniforms (uPlanetCount). */
  readonly ints?: Readonly<Record<string, number>>;
  /** A float RGBA row on texture unit 0 (uSim0), one texel per pixel across. */
  readonly row?: Float32Array;
}

/** Draws `linked` into a float target, the clock frozen, and returns RGBA floats, rows bottom up. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, frame: Draw): Float32Array {
  const { width, height } = frame;
  const row = frame.row ? gl.createTexture() : null;
  try {
    return drawFloats(gl, width, height, () => {
      // Unit 0 holds the row, or nothing, so no uSim sampler reads the target it renders into.
      gl.bindTexture(gl.TEXTURE_2D, row);
      if (frame.row) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, frame.row);
      }
      gl.useProgram(linked);
      const figures = constellationUniforms;
      const at = (name: string) => gl.getUniformLocation(linked, name);
      gl.uniform4fv(at("uConStars"), figures.stars);
      gl.uniform4fv(at("uConBright"), figures.brightness);
      gl.uniform4fv(at("uConLines"), figures.lines);
      gl.uniform1i(at("uConStarCount"), figures.starCount);
      gl.uniform1i(at("uConLineCount"), figures.lineCount);
      gl.uniform1i(at("uConMarkStar"), figures.markStar);
      gl.uniform1i(at("uConMarkLine"), figures.markLine);
      gl.uniform1i(at("uView"), 1);
      gl.uniform4fv(at("uParams"), packParams(frame.params));
      gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
      const uniforms: Record<string, readonly number[]> = {
        uRes: [width, height],
        uTime: [40],
        uMotion: [0.6],
        uMotionTime: [24],
        uPassage: [1, 0],
        uPrincipals: [-1, -1, 0, -1e4],
        uBg: [0.03, 0.03, 0.05],
        ...frame.uniforms,
      };
      for (const [name, value] of Object.entries(uniforms)) {
        const location = at(name);
        if (value.length === 1) gl.uniform1f(location, value[0] ?? 0);
        else if (value.length === 2) gl.uniform2fv(location, value);
        else if (value.length === 3) gl.uniform3fv(location, value);
        else gl.uniform4fv(location, value);
      }
      for (const [name, value] of Object.entries(frame.ints ?? {})) gl.uniform1i(at(name), value);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(row);
  }
}

const same = (a: Float32Array, b: Float32Array): boolean => a.every((value, i) => value === b[i]);

// Pixel x samples the direction in texel x of uSim0: x skyStars with a footprint, y without (its
// cell 1 / uRes.y radians, which uNight sets to the same footprint). uNight: x the time of day, y
// the star density, z the footprint (radians a dither cell spans).
const PROBE = `
uniform vec3 uNight;

Shade nightProbe(vec2 uv, vec2 cell, float t) {
  vec3 dir = texelFetch(uSim0, ivec2(cell), 0).xyz;
  Sky sky = skyAt(uNight.x);
  Shade o = blankShade();
  o.source = vec3(skyStars(sky, dir, uNight.y, uNight.z), skyStars(sky, dir, uNight.y), 0.0);
  return o;
}
`;

export function verifyNightSky(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const frost = frostScene;
  check(frost.params.filter(nightPart).length === 1, "frost lacks the constellations");
  const probeDef: LoadedScene = { ...frost, entry: "nightProbe", glsl: PROBE };
  const plainDef: LoadedScene = {
    ...probeDef,
    params: probeDef.params.filter((def) => !nightPart(def)),
  };
  const probe = link(gl, fragmentSourceFor(probeDef, sceneFeaturesAll(probeDef)));
  const plain = link(gl, fragmentSourceFor(plainDef));

  // The samples: each figure's stars, then the middle of each of its lines.
  const offset = (star: number): [number, number] => [
    constellationUniforms.stars[star * 4 + 2] ?? 0,
    constellationUniforms.stars[star * 4 + 3] ?? 0,
  ];
  const stars: (readonly number[])[] = [];
  const lines: (readonly number[])[] = [];
  for (const figure of skyFigures) {
    for (let star = figure.stars[0]; star < figure.stars[1]; star++)
      stars.push(skyFigurePoint(figure, offset(star)));
    for (let line = figure.lines[0]; line < figure.lines[1]; line++) {
      const a = offset(constellationUniforms.lines[line * 2] ?? 0);
      const b = offset(constellationUniforms.lines[line * 2 + 1] ?? 0);
      lines.push(skyFigurePoint(figure, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
    }
  }
  const samples = [...stars, ...lines];
  const width = samples.length;
  const row = new Float32Array(width * 4);
  samples.forEach((dir, i) => row.set(dir, i * 4));
  const figureSamples = stars.length + lines.length;

  const frostKnobs = paramDefaults("frost");
  const sky = (
    linked: WebGLProgram,
    def: LoadedScene,
    over: Record<string, number>,
    night: readonly [time: number, density: number, foot: number],
  ): Float32Array =>
    draw(gl, linked, {
      width,
      height: 1,
      params: def.params.map((knob) => effective(knob, { ...frostKnobs, ...over })),
      // uRes.y: a cell of 1 / uRes.y radians for the overload without a footprint.
      uniforms: { uRes: [width, 1 / night[2]], uNight: [...night] },
      row,
    });
  /** Sample i's value, the lesser of the two overloads. */
  const value = (pixels: Float32Array, i: number): number =>
    Math.min(pixels[i * 4] ?? 0, pixels[i * 4 + 1] ?? 0);
  const indices = (from: number, to: number): number[] =>
    Array.from({ length: to - from }, (_, k) => from + k);
  const starIndices = indices(0, stars.length);
  const lineIndices = indices(stars.length, figureSamples);

  const midnight = [0, 0.5, 0.002] as const;
  const constellations = { constellations: 1, "constellations-amount": 1 };

  // Off: what a program without the knobs draws, and nothing of the parts.
  const off = sky(probe, probeDef, {}, midnight);
  check(same(off, sky(plain, plainDef, {}, midnight)), "the knobs off change skyStars");

  // The figures: every star and line lit, adding light over the field's stars.
  const figures = sky(probe, probeDef, constellations, midnight);
  const dim = [...starIndices, ...lineIndices].filter((i) => value(figures, i) < 0.85);
  check(dim.length === 0, `figure stars or lines dim at midnight: samples ${dim.join(", ")}`);
  const added = [...starIndices, ...lineIndices].reduce(
    (sum, i) => sum + value(figures, i) - value(off, i),
    0,
  );
  check(added > 0.5 * figureSamples, `the figures add little light: ${added.toFixed(2)}`);

  // The lines' amount: at a trace the stars stand out as before, the lines barely there.
  const trace = sky(
    probe,
    probeDef,
    { ...constellations, "constellations-amount": 0.05 },
    midnight,
  );
  check(
    starIndices.every((i) => value(trace, i) >= 0.85),
    "the figures' stars fade with the lines",
  );
  const traced = lineIndices.filter((i) => value(trace, i) > value(off, i) + 0.1);
  check(traced.length === 0, `lines at 0.05 more than a trace: samples ${traced.join(", ")}`);

  // Coarse cells (a 1-radian view at 100 rows): the points are sized in cells and still show.
  const coarse = sky(probe, probeDef, constellations, [0, 0.5, 0.01]);
  check(
    starIndices.every((i) => value(coarse, i) >= 0.85),
    "figure stars lost at a coarse footprint",
  );

  // Nothing by day, nor without stars.
  const day = sky(probe, probeDef, constellations, [0.5, 0.5, 0.002]);
  const starless = sky(probe, probeDef, constellations, [0, 0, 0.002]);
  check(
    day.every((v, i) => i % 4 > 1 || v === 0),
    "night parts by day",
  );
  check(
    starless.every((v, i) => i % 4 > 1 || v === 0),
    "night parts without stars",
  );

  gl.deleteProgram(probe);
  gl.deleteProgram(plain);
  return {
    samples: { stars: stars.length, lines: lines.length },
    added: Number(added.toFixed(2)),
  };
}

/** Where a frame differs from another: how many pixels, and their mean across (0..1 of the width). */
function difference(a: Float32Array, b: Float32Array, width: number): { count: number; x: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const moved =
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
        Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
        Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) >
      0.02;
    if (!moved) continue;
    count++;
    sum += ((i / 4) % width) / width;
  }
  return { count, x: count > 0 ? sum / count : Number.NaN };
}

/**
 * The nights nightPlanets draws, each with its knobs: the lake's fjord under its slow drapes, and
 * the island at midnight.
 */
const NIGHTS: readonly (readonly [SceneId, () => Record<string, number>])[] = [
  ["lake", () => LAKE_FJORD],
  ["island", () => ({ ...paramDefaults("island"), time: 0 })],
];

/** nightPlanets (see the header), in the nights of the run's scope. */
export const verifyNightPlanets = walk(
  NIGHTS.map(([id]) => id),
  nightPlanets,
);

async function nightPlanets(
  gl: WebGL2RenderingContext,
  scenes: readonly SceneId[],
): Promise<Record<string, unknown>> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const width = 160;
  const height = 100;
  const result: Record<string, unknown> = {};
  for (const [id, knobsOf] of NIGHTS) {
    if (!scenes.includes(id)) continue;
    const knobs = knobsOf();
    const scene = await loadScene(id);
    const spec = scene.planets;
    if (spec === undefined) throw new VerifyError(`${id} takes no planets`);
    const params = scene.params.map((knob) => effective(knob, knobs));
    const programs = new Map<number, WebGLProgram>();
    const frame = (planets: readonly SkyPlanet[], motionTime = 24): Float32Array => {
      const gate = planets.length > 0 ? 1 : 0;
      const linked =
        programs.get(gate) ??
        link(gl, fragmentSourceFor(scene, sceneFeatures(scene, shaderValues(scene, knobs), gate)));
      programs.set(gate, linked);
      const { count, data } = planetUniforms(planets);
      return draw(gl, linked, {
        width,
        height,
        params,
        uniforms: { uPlanets: Array.from(data), uMotionTime: [motionTime] },
        ints: { uPlanetCount: count },
      });
    };
    const [low, , high] = spec.across;
    const up = spec.up[1];
    const left = readPlanet(spec, {
      kind: 3,
      ring: 0,
      size: 0.6,
      across: low + (high - low) * 0.25,
      up,
    });
    const right = readPlanet(spec, {
      kind: 5,
      ring: 0,
      size: 0.6,
      across: low + (high - low) * 0.75,
      up,
    });
    const empty = frame([]);
    const one = difference(frame([left]), empty, width);
    const other = difference(frame([right]), empty, width);
    const both = difference(frame([left, right]), empty, width);
    check(
      one.count > 20 && other.count > 20,
      `${id}: a planet barely shows (${one.count}, ${other.count})`,
    );
    check(
      one.x < other.x,
      `${id}: the planet placed further left stands at ${one.x.toFixed(2)}, the other at ${other.x.toFixed(2)}`,
    );
    check(
      Math.abs(both.count - one.count - other.count) < 0.1 * both.count,
      `${id}: two planets draw ${both.count} pixels, alone ${one.count} and ${other.count}`,
    );
    // An orbiting planet, a circuit every half minute: on its way left, then set.
    const orbit = readPlanet(spec, {
      orbit: 1,
      "orbit-amount": 0.5,
      ring: 0,
      size: 0.6,
      across: (low + high) / 2,
      up,
    });
    // Each against the empty list's frame at the same motion clock (the stars twinkle on it).
    const top = difference(frame([orbit], 0), frame([], 0), width);
    const later = difference(frame([orbit], 2), frame([], 2), width);
    const set = frame([orbit], 15);
    check(top.count > 20, `${id}: the orbiting planet does not show at its height`);
    check(
      later.count > 0 && later.x < top.x,
      `${id}: the orbiting planet stays at ${top.x.toFixed(2)} (then ${later.x.toFixed(2)})`,
    );
    check(same(set, frame([], 15)), `${id}: half a circuit on, the orbiting planet still shows`);
    for (const linked of programs.values()) gl.deleteProgram(linked);
    result[id] = { left: one, right: other, orbit: { top: top.x, later: later.x } };
  }
  return result;
}
