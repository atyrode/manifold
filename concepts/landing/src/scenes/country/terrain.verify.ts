// GPU check (verify-browser.ts, `countryTerrain`): the countryside's real sim builds the terrain
// toolbox's textures and the land model's uses, and the scene's all-features program (featuresAll:
// every optional part compiled in) draws them: the land, the river and the sky all show, the same
// frame draws bit for bit the same twice, and another landscape draws another picture. The land is
// drawn from the records: at sample points over the map, the parcel the shader finds carries the
// use the land model (built again here on the CPU) gave it, and the woods stand only on woodland
// parcels; a change of the land's uses rebuilds nothing (one sim frame, timed) and redraws the
// land, and the river switched off leaves its bed dry. Sizes are small: software WebGL runs every
// line of the march. The helpers (a program, the real sim's textures, a frame drawn with them) serve
// the countryside's other checks too (life.verify.ts).
import { fragmentSourceFor, sceneFeaturesAll, vertexSource } from "../../shaders/index.ts";
import { LandModel, LAND_USES } from "../../sims/landuse.ts";
import { generateTerrain } from "../../sims/terrain.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_MAP } from "./sim.ts";

const WIDTH = 192;
const HEIGHT = 108;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("country: shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) ?? "country: compile failed");
  return shader;
}

/** A linked program for a fragment source (the dither pass's own vertex shader). */
export function countryProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [
    compile(gl, gl.VERTEX_SHADER, vertexSource),
    compile(gl, gl.FRAGMENT_SHADER, fragment),
  ];
  const program = gl.createProgram();
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "country: link failed");
  for (const shader of shaders) gl.deleteShader(shader);
  return program;
}

/** FNV-1a over the bytes. */
export function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The knobs as the shader reads them (`uParams`) for raw knobs over the countryside's defaults. */
export function countryValues(knobs: Record<string, number>): readonly number[] {
  return renderSettings(defaultsFor("country"), { ...paramDefaults("country"), ...knobs }).params;
}

export interface CountryBuilt {
  textures: readonly (WebGLTexture | undefined)[];
  /** Sim frames the build took. */
  frames: number;
  /** One more sim frame with these knobs over the defaults; the milliseconds it took. */
  step(knobs: Record<string, number>): number;
  dispose(): void;
}

function simFrame(knobs: Record<string, number>): SimFrame {
  return {
    dt: 0,
    time: 30,
    motionTime: 30,
    motion: 1,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    values: countryValues(knobs),
    params: { ...paramDefaults("country"), ...knobs },
    triggers: new Array(8).fill(-1e4),
    fired: new Array(8).fill(false),
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
    passage: { enter: 1, exit: 0 },
  };
}

/** The countryside's real sim, run until its terrain is built, for these knobs over the defaults. */
export function countryBuild(
  gl: WebGL2RenderingContext,
  knobs: Record<string, number>,
): CountryBuilt {
  const sim: SceneSim | undefined = countryScene.sim?.(gl);
  if (!sim) throw new Error("country: no sim");
  // The build runs a budget of units a call; nothing is bound until it is done.
  const frame = simFrame(knobs);
  let textures = sim.frame(frame);
  let frames = 1;
  while (textures.length === 0 && frames < 2000) {
    textures = sim.frame(frame);
    frames++;
  }
  if (textures.length !== 4) {
    sim.dispose();
    throw new Error(`country: the sim bound ${textures.length} textures`);
  }
  return {
    textures,
    frames,
    step(more) {
      const started = performance.now();
      const bound = sim.frame(simFrame(more));
      const ms = performance.now() - started;
      if (bound.length !== 4 || bound.some((texture, slot) => texture !== textures[slot]))
        throw new Error("country: a sim frame bound other textures");
      return ms;
    },
    dispose: () => sim.dispose(),
  };
}

export interface CountryDraw {
  width?: number;
  height?: number;
  time?: number;
  motionTime?: number;
  motion?: number;
  /** uView: 1 the source picture (the default), 0 dithered. */
  view?: number;
  /** uWeather: how wet the land is and how much snow lies on it (default none). */
  weather?: readonly [number, number];
}

/** One frame of `program` over the built textures with these knobs, read back (RGBA bytes). */
export function countryDraw(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  built: CountryBuilt,
  knobs: Record<string, number>,
  options: CountryDraw = {},
): Uint8Array {
  const width = options.width ?? WIDTH;
  const height = options.height ?? HEIGHT;
  gl.canvas.width = width;
  gl.canvas.height = height;
  gl.viewport(0, 0, width, height);
  gl.useProgram(program);
  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform2f(u("uRes"), width, height);
  gl.uniform1i(u("uView"), options.view ?? 1);
  gl.uniform1f(u("uTime"), options.time ?? 30);
  gl.uniform1f(u("uMotion"), options.motion ?? 1);
  gl.uniform1f(u("uMotionTime"), options.motionTime ?? 30);
  gl.uniform2f(u("uPassage"), 1, 0);
  gl.uniform2f(u("uWeather"), options.weather?.[0] ?? 0, options.weather?.[1] ?? 0);
  gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform1fv(u("uParams"), Float32Array.from(countryValues(knobs)));
  gl.uniform4f(u("uSimOn"), 1, 1, 1, 1);
  try {
    built.textures.forEach((texture, slot) => {
      gl.uniform1i(u(`uSim${slot}`), slot);
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("country: GL error");
    return bytes;
  } finally {
    gl.activeTexture(gl.TEXTURE0);
  }
}

/** Pixels whose colour differs between two frames. */
export function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
  return count;
}

// The land probe: a grid of PROBE × PROBE map points at fine texel centres, a pixel each: r the
// parcel id's high byte, g its low byte, b its use × 16, plus 8 where the woods stand.
const PROBE = 96;
const probeGlsl = /* glsl */ `
Shade probeLand(vec2 uv, vec2 cell, float t) {
  float texel = COUNTRY_EXTENT / float(textureSize(uSim2, 0).x);
  float stride = floor(float(textureSize(uSim2, 0).x) / ${PROBE}.0);
  vec2 p = (floor(cell) * stride + floor(0.5 * stride) + 0.5) * texel;
  TerrainParcel parcel = terrainParcel(uSim2, uSim3, p, COUNTRY_EXTENT);
  vec4 cover = terrainCover(uSim1, p, COUNTRY_EXTENT);
  float woods = countryWoods(cover, terrainWater(terrainGround(uSim0, p, COUNTRY_EXTENT)), false) > 0.5 ? 8.0 : 0.0;
  float high = floor(parcel.id / 256.0);
  return shadeOf(vec3(high, parcel.id - 256.0 * high, floor(parcel.use + 0.5) * 16.0 + woods) / 255.0, 0.0, 0.0);
}
`;

/** Settings of the land's uses the check draws (a feature's amount is `<key>-amount`). */
const WOODED = { crops: 0, woodland: 1, "woodland-amount": 100 };
const MIXED = {
  pasture: 1,
  "pasture-amount": 30,
  wildflowers: 1,
  lavender: 1,
  sunflowers: 1,
  pines: 0.5,
};

export function verifyCountryTerrain(gl: WebGL2RenderingContext): Record<string, unknown> {
  const all = sceneFeaturesAll(countryScene);
  const program = countryProgram(gl, fragmentSourceFor(countryScene, all));
  const probe = countryProgram(
    gl,
    fragmentSourceFor(
      { ...countryScene, entry: "probeLand", glsl: countryScene.glsl + probeGlsl },
      all,
    ),
  );
  const draw = (landscape: number): { bytes: Uint8Array; frames: number } => {
    const built = countryBuild(gl, { landscape });
    try {
      return { bytes: countryDraw(gl, program, built, { landscape }), frames: built.frames };
    } finally {
      built.dispose();
    }
  };
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(`country: ${message}`);
  };

  try {
    const first = draw(0);
    const again = draw(0);
    const other = draw(5);
    check(fnv(first.bytes) === fnv(again.bytes), "the same landscape drew two different pictures");
    check(fnv(first.bytes) !== fnv(other.bytes), "another landscape drew the same picture");
    // The source view's colours: sky (blue over red) in the top rows, land (green over blue) below
    // the horizon, and the river mirroring the sky somewhere on the land.
    let sky = 0;
    let land = 0;
    let water = 0;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const o = 4 * (y * WIDTH + x);
        const r = first.bytes[o] ?? 0;
        const g = first.bytes[o + 1] ?? 0;
        const b = first.bytes[o + 2] ?? 0;
        if (y > 0.8 * HEIGHT && b > r + 20) sky++;
        if (y < 0.4 * HEIGHT && g > b + 10) land++;
        if (y < 0.55 * HEIGHT && b > g + 6 && b > r + 15) water++;
      }
    }
    const top = WIDTH * Math.round(0.2 * HEIGHT);
    const bottom = WIDTH * Math.round(0.4 * HEIGHT);
    check(sky >= 0.8 * top, `the sky shows in ${sky} of ${top} top pixels`);
    check(land >= 0.8 * bottom, `the land shows in ${land} of ${bottom} pixels`);
    check(water >= 4, `no river in sight (${water} pixels)`);

    // The land from the records: the uses the land model gives, for each setting, on the GPU.
    const terrain = generateTerrain({
      seed: 0,
      size: COUNTRY_MAP.size,
      extent: COUNTRY_MAP.extent,
    });
    const model = new LandModel(terrain, 0);
    const m = terrain.size;
    const stride = Math.floor(m / PROBE);
    const built = countryBuild(gl, {});
    try {
      const settings: Record<string, Record<string, number>> = {
        default: {},
        wooded: WOODED,
        felled: { woodland: 0 },
        mixed: MIXED,
      };
      const result: Record<string, unknown> = { buildFrames: first.frames, sky, land, water };
      const pictures = new Map<string, string>();
      for (const [name, knobs] of Object.entries(settings)) {
        const ms = built.step(knobs);
        const picture = countryDraw(gl, program, built, knobs);
        pictures.set(name, fnv(picture));
        const values = { ...paramDefaults("country"), ...knobs };
        const share = (key: string) =>
          (values[key] ?? 0) > 0.5 ? (values[`${key}-amount`] ?? 0) : 0;
        const allocation = model.allocate({
          shares: {
            crops: share("crops"),
            wildflowers: share("wildflowers"),
            lavender: share("lavender"),
            sunflowers: share("sunflowers"),
            pasture: share("pasture"),
            woodland: share("woodland"),
          },
          pines: share("woodland") > 0 ? (values.pines ?? 0) : 0,
          cows: values.cows ?? 0,
        });
        const bytes = countryDraw(gl, probe, built, knobs, { width: PROBE, height: PROBE });
        let points = 0;
        let agreed = 0;
        let wooded = 0;
        for (let k = 0; k < PROBE * PROBE; k++) {
          const i = (k % PROBE) * stride + Math.floor(stride / 2);
          const j = Math.floor(k / PROBE) * stride + Math.floor(stride / 2);
          const id = terrain.parcels.ids[2 * (j * m + i)] ?? 0;
          const shown = 256 * (bytes[4 * k] ?? 0) + (bytes[4 * k + 1] ?? 0);
          const coded = bytes[4 * k + 2] ?? 0;
          if (id === 0) continue;
          points++;
          if (shown !== id) continue;
          agreed++;
          const use = allocation.use[id - 1] ?? 0;
          check(
            coded >> 4 === use,
            `${name}: the shader drew parcel ${id} as ${LAND_USES[coded >> 4] ?? coded >> 4}, the land model made it ${LAND_USES[use] ?? use}`,
          );
          if ((coded & 8) !== 0) {
            wooded++;
            check(
              LAND_USES[use] === "woodland",
              `${name}: woods stand on parcel ${id}, which is ${LAND_USES[use] ?? use}`,
            );
          }
        }
        check(agreed >= 0.97 * points, `${name}: the shader found ${agreed} of ${points} parcels`);
        if (name === "felled")
          check(wooded === 0, `${name}: ${wooded} wooded points with woodland off`);
        else check(wooded > 0.02 * points, `${name}: only ${wooded} of ${points} points wooded`);
        result[name] = { ms: Number(ms.toFixed(2)), points, agreed, wooded };
      }
      check(
        new Set(pictures.values()).size === pictures.size,
        "two land settings drew the same picture",
      );
      // The river switched off: its bed dry, the rest as it was (nothing laid out again).
      built.step({});
      const flowing = countryDraw(gl, program, built, {});
      built.step({ river: 0 });
      const dry = countryDraw(gl, program, built, { river: 0 });
      let wet = 0;
      for (let k = 0; k < WIDTH * HEIGHT; k++) {
        const o = 4 * k;
        if (
          (dry[o + 2] ?? 0) > (dry[o + 1] ?? 0) + 6 &&
          (dry[o + 2] ?? 0) > (dry[o] ?? 0) + 15 &&
          k < WIDTH * Math.round(0.55 * HEIGHT)
        )
          wet++;
      }
      result.riverOff = { changed: differing(flowing, dry), water: wet };
      check(wet < water / 4, `the river still shows in ${wet} pixels with it off`);
      built.step({});
      check(
        differing(flowing, countryDraw(gl, program, built, {})) === 0,
        "the river on again drew another picture",
      );
      return result;
    } finally {
      built.dispose();
    }
  } finally {
    gl.deleteProgram(program);
    gl.deleteProgram(probe);
  }
}
