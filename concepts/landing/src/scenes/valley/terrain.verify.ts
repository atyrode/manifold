// GPU check (verify-browser.ts, `valleyTerrain`): the valley's real sim builds the terrain toolbox's
// textures, and the scene's all-features program (featuresAll: every optional part compiled in)
// draws them: the land, the river and the sky all show, the same frame draws bit for bit the same
// twice, and another landscape draws another picture. Sizes are small: software WebGL runs every
// line of the march. The helpers (a program, the real sim's textures, a frame drawn with them) serve
// the valley's other checks too (life.verify.ts).
import { paramDefaults, renderSettings, defaultsFor } from "../../state.ts";
import { fragmentSourceFor, sceneFeaturesAll, vertexSource } from "../../shaders/index.ts";
import type { SimFrame } from "../types.ts";
import { valleyScene } from "./index.ts";

const WIDTH = 192;
const HEIGHT = 108;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("valley: shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) ?? "valley: compile failed");
  return shader;
}

/** A linked program for a fragment source (the dither pass's own vertex shader). */
export function valleyProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [
    compile(gl, gl.VERTEX_SHADER, vertexSource),
    compile(gl, gl.FRAGMENT_SHADER, fragment),
  ];
  const program = gl.createProgram();
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program) ?? "valley: link failed");
  for (const shader of shaders) gl.deleteShader(shader);
  return program;
}

/** FNV-1a over the bytes. */
export function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The knobs as the shader reads them (`uParams`) for raw knobs over the valley's defaults. */
export function valleyValues(knobs: Record<string, number>): readonly number[] {
  return renderSettings(defaultsFor("valley"), { ...paramDefaults("valley"), ...knobs }).params;
}

export interface ValleyBuilt {
  textures: readonly (WebGLTexture | undefined)[];
  /** Sim frames the build took. */
  frames: number;
  dispose(): void;
}

/** The valley's real sim, run until its terrain is built, for these knobs over the defaults. */
export function valleyBuild(
  gl: WebGL2RenderingContext,
  knobs: Record<string, number>,
): ValleyBuilt {
  const params = { ...paramDefaults("valley"), ...knobs };
  const frame: SimFrame = {
    dt: 0,
    time: 30,
    motionTime: 30,
    motion: 1,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    values: valleyValues(knobs),
    params,
    triggers: new Array(8).fill(-1e4),
    fired: new Array(8).fill(false),
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
    passage: { enter: 1, exit: 0 },
  };
  const sim = valleyScene.sim?.(gl);
  if (!sim) throw new Error("valley: no sim");
  // The build runs a budget of units a call; nothing is bound until it is done.
  let textures = sim.frame(frame);
  let frames = 1;
  while (textures.length === 0 && frames < 2000) {
    textures = sim.frame(frame);
    frames++;
  }
  if (textures.length !== 4) {
    sim.dispose();
    throw new Error(`valley: the sim bound ${textures.length} textures`);
  }
  return { textures, frames, dispose: () => sim.dispose() };
}

export interface ValleyDraw {
  width?: number;
  height?: number;
  time?: number;
  motionTime?: number;
  motion?: number;
  /** uView: 1 the source picture (the default), 0 dithered. */
  view?: number;
}

/** One frame of `program` over the built textures with these knobs, read back (RGBA bytes). */
export function valleyDraw(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  built: ValleyBuilt,
  knobs: Record<string, number>,
  options: ValleyDraw = {},
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
  gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform1fv(u("uParams"), Float32Array.from(valleyValues(knobs)));
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
    if (gl.getError() !== gl.NO_ERROR) throw new Error("valley: GL error");
    return bytes;
  } finally {
    gl.activeTexture(gl.TEXTURE0);
  }
}

export function verifyValleyTerrain(gl: WebGL2RenderingContext): Record<string, unknown> {
  const program = valleyProgram(gl, fragmentSourceFor(valleyScene, sceneFeaturesAll(valleyScene)));
  const draw = (landscape: number): { bytes: Uint8Array; frames: number } => {
    const built = valleyBuild(gl, { landscape });
    try {
      return { bytes: valleyDraw(gl, program, built, { landscape }), frames: built.frames };
    } finally {
      built.dispose();
    }
  };

  try {
    const first = draw(0);
    const again = draw(0);
    const other = draw(5);
    if (fnv(first.bytes) !== fnv(again.bytes))
      throw new Error("valley: the same landscape drew two different pictures");
    if (fnv(first.bytes) === fnv(other.bytes))
      throw new Error("valley: another landscape drew the same picture");
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
    if (sky < 0.8 * top) throw new Error(`valley: the sky shows in ${sky} of ${top} top pixels`);
    if (land < 0.8 * bottom)
      throw new Error(`valley: the land shows in ${land} of ${bottom} pixels`);
    if (water < 4) throw new Error(`valley: no river in sight (${water} pixels)`);
    return { buildFrames: first.frames, sky, land, water, hash: fnv(first.bytes) };
  } finally {
    gl.deleteProgram(program);
  }
}
