// GPU check (verify-browser.ts, `valleyTerrain`): the valley's real sim builds the terrain toolbox's
// textures, and the scene's program (every optional part compiled in) draws them: the land, the
// river and the sky all show, the same frame draws bit for bit the same twice, and another
// landscape draws another picture. Sizes are small: software WebGL runs every line of the march.
import { paramDefaults, renderSettings, defaultsFor } from "../../state.ts";
import { fragmentSourceFor, sceneFeatures, shaderValues, vertexSource } from "../../shaders/index.ts";
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

/** FNV-1a over the bytes. */
function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function verifyValleyTerrain(gl: WebGL2RenderingContext): Record<string, unknown> {
  const everything = { rain: 1, snow: 1, fog: 1, shadows: 1, roads: 1, moon: 0.5 };
  const fragment = fragmentSourceFor(
    valleyScene,
    sceneFeatures(valleyScene, shaderValues(valleyScene, everything)),
  );
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

  const draw = (landscape: number): { bytes: Uint8Array; frames: number } => {
    const knobs = { ...paramDefaults("valley"), landscape };
    const settings = renderSettings(defaultsFor("valley"), knobs);
    const frame: SimFrame = {
      dt: 0,
      time: 30,
      motionTime: 30,
      motion: 1,
      width: WIDTH,
      height: HEIGHT,
      aspect: WIDTH / HEIGHT,
      values: settings.params,
      params: knobs,
      triggers: new Array(8).fill(-1e4),
      fired: new Array(8).fill(false),
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      passage: { enter: 1, exit: 0 },
    };
    const sim = valleyScene.sim?.(gl);
    if (!sim) throw new Error("valley: no sim");
    try {
      // The build runs a budget of units a call; nothing is bound until it is done.
      let textures = sim.frame(frame);
      let frames = 1;
      while (textures.length === 0 && frames < 2000) {
        textures = sim.frame(frame);
        frames++;
      }
      if (textures.length !== 4) throw new Error(`valley: the sim bound ${textures.length} textures`);
      gl.canvas.width = WIDTH;
      gl.canvas.height = HEIGHT;
      gl.viewport(0, 0, WIDTH, HEIGHT);
      gl.useProgram(program);
      const u = (name: string) => gl.getUniformLocation(program, name);
      gl.uniform2f(u("uRes"), WIDTH, HEIGHT);
      gl.uniform1i(u("uView"), 1);
      gl.uniform1f(u("uTime"), 30);
      gl.uniform1f(u("uMotion"), 1);
      gl.uniform1f(u("uMotionTime"), 30);
      gl.uniform2f(u("uPassage"), 1, 0);
      gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
      gl.uniform1fv(u("uParams"), Float32Array.from(settings.params));
      gl.uniform4f(u("uSimOn"), 1, 1, 1, 1);
      textures.forEach((texture, slot) => {
        gl.uniform1i(u(`uSim${slot}`), slot);
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("valley: GL error");
      return { bytes, frames };
    } finally {
      sim.dispose();
      gl.activeTexture(gl.TEXTURE0);
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
    if (land < 0.8 * bottom) throw new Error(`valley: the land shows in ${land} of ${bottom} pixels`);
    if (water < 4) throw new Error(`valley: no river in sight (${water} pixels)`);
    return { buildFrames: first.frames, sky, land, water, hash: fnv(first.bytes) };
  } finally {
    gl.deleteProgram(program);
  }
}
