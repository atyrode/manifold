// GPU regressions for the night sky's opt-in parts, the constellations (skyStars, src/shaders/lib/
// sky.ts) and the giant planet (skyGiant), each compiled in only while its knob is on (the library
// gates SKY_FIGURES and SKY_GIANT), run by concepts/landing/verify-browser.ts on real WebGL output.
// - `nightSky`: a probe compiled with Frost's knobs and every gate on samples skyStars, both
//   overloads, at every figure's stars and the middle of every figure line. At a clear midnight the
//   figures add light there while on (the lines as strong as their amount), and the knobs off draw
//   exactly what a program without them draws; by day, and with no stars, nothing; at a coarse
//   footprint the points still show.
// - `nightSkyDefaults1`..`3` (a third of the scenes each, to stay well under the deadline): every
//   scene with the knobs starts with them off and, at its defaults and at midnight, draws byte for
//   byte what the same scene without them draws.
import { constellationUniforms } from "./constellations.ts";
import { effective, type ParamDef } from "./params.ts";
import {
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
  vertexSource,
} from "./shaders/index.ts";
import { skyFigurePoint, skyFigures } from "./shaders/lib/sky.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import type { SceneDef } from "./scenes/types.ts";
import { paramDefaults } from "./state.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`night sky: ${message}`);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
      gl.getShaderInfoLog(shader) ?? "compile failed",
    );
    return shader;
  });
  const linked = gl.createProgram();
  for (const shader of shaders) gl.attachShader(linked, shader);
  gl.linkProgram(linked);
  check(
    Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)),
    gl.getProgramInfoLog(linked) ?? "link failed",
  );
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

/** The shared night knobs with library gates (skyComponentKnobs' constellations and giant). */
const nightPart = (def: ParamDef): boolean =>
  def.widget?.kind === "night" &&
  (def.widget.part === "constellations" || def.widget.part === "giant");

interface Draw {
  readonly width: number;
  readonly height: number;
  readonly params: readonly number[];
  readonly uniforms?: Readonly<Record<string, readonly number[]>>;
  /** A float RGBA row on texture unit 0 (uSim0), one texel per pixel across. */
  readonly row?: Float32Array;
}

/** Draws `linked` into a float target, the clock frozen, and returns RGBA floats, rows bottom up. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, frame: Draw): Float32Array {
  const { width, height } = frame;
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  check(
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
    "float target incomplete",
  );
  // Unit 0 holds the row, or nothing, so no uSim sampler reads the target it renders into.
  const row = frame.row ? gl.createTexture() : null;
  gl.bindTexture(gl.TEXTURE_2D, row);
  if (frame.row) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, frame.row);
  }
  gl.useProgram(linked);
  gl.viewport(0, 0, width, height);
  const figures = constellationUniforms;
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform4fv(at("uConStars"), figures.stars);
  gl.uniform1fv(at("uConBright"), figures.brightness);
  gl.uniform2fv(at("uConLines"), figures.lines);
  gl.uniform1i(at("uConStarCount"), figures.starCount);
  gl.uniform1i(at("uConLineCount"), figures.lineCount);
  gl.uniform1i(at("uConMarkStar"), figures.markStar);
  gl.uniform1i(at("uConMarkLine"), figures.markLine);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1fv(at("uParams"), Float32Array.from(frame.params));
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  const uniforms: Record<string, readonly number[]> = {
    uRes: [width, height],
    uTime: [40],
    uMotion: [0.6],
    uMotionTime: [24],
    uPassage: [1, 0],
    uMouse: [-1, -1, 0, -1e4],
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
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(target);
  gl.deleteTexture(row);
  return out;
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
  const frost = sceneDefs.frost;
  check(frost.params.filter(nightPart).length === 2, "frost lacks the constellations or the giant");
  const probeDef: SceneDef = { ...frost, entry: "nightProbe", glsl: PROBE };
  const plainDef: SceneDef = {
    ...probeDef,
    params: probeDef.params.filter((def) => !nightPart(def)),
  };
  const probe = program(gl, fragmentSourceFor(probeDef, sceneFeaturesAll(probeDef)));
  const plain = program(gl, fragmentSourceFor(plainDef));

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
    def: SceneDef,
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

/**
 * `nightSkyDefaults`, split `parts` ways to keep each entry well under the deadline: this entry
 * checks every `parts`-th scene with the knobs, from the `part`-th (0-based) on. Returns each scene's
 * milliseconds.
 */
export function nightSkyDefaults(
  part: number,
  parts: number,
): (gl: WebGL2RenderingContext) => Record<string, number> {
  return (gl) => {
    check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
    const adopters = (Object.entries(sceneDefs) as [SceneId, SceneDef][]).filter(([, scene]) =>
      scene.params.some(nightPart),
    );
    check(adopters.length > 0, "no scene has the night knobs");
    const result: Record<string, number> = {};
    for (const [id, scene] of adopters.filter((_, i) => i % parts === part)) {
      const start = performance.now();
      const defaults = paramDefaults(id);
      check(
        scene.params.filter(nightPart).every((def) => effective(def, defaults) === 0),
        `${id} starts with a night part on`,
      );
      const before: SceneDef = { ...scene, params: scene.params.filter((def) => !nightPart(def)) };
      // One program per scene and feature set: most draw their midnight with their defaults' program.
      const programs = new Map<string, WebGLProgram>();
      const frame = (def: SceneDef, knobs: Record<string, number>): Float32Array => {
        const source = fragmentSourceFor(def, sceneFeatures(def, shaderValues(def, knobs)));
        const linked = programs.get(source) ?? program(gl, source);
        programs.set(source, linked);
        const params = def.params.map((knob) => effective(knob, knobs));
        return draw(gl, linked, { width: 64, height: 36, params });
      };
      const time = scene.params.some((def) => def.key === "time");
      for (const over of time ? [{}, { time: 0 }] : [{}]) {
        const knobs = { ...defaults, ...over };
        check(
          same(frame(scene, knobs), frame(before, knobs)),
          `${id}${"time" in over ? " at midnight" : ""} changed with the night knobs off`,
        );
      }
      for (const linked of programs.values()) gl.deleteProgram(linked);
      result[id] = Math.round(performance.now() - start);
    }
    return result;
  };
}
