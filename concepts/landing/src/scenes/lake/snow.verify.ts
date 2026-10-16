// GPU check (verify-browser.ts): fresh snow changes the look of the lake's lying snow, never how much
// of the ice it covers. The real sim lays the night's snow; the scene's own lakeSnowAt / lakeSnowShade
// say, per pixel of the near and middle ice, whether snow covers it and how it is lit.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SimFrame } from "../types.ts";
import { lakeScene } from "./index.ts";

const WIDTH = 320;
const HEIGHT = 200;

function fail(message: string): never {
  throw new Error(`lake fresh snow: ${message}`);
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type) ?? fail("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      fail(gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    fail(gl.getProgramInfoLog(linked) ?? "link failed");
  return linked;
}

interface SnowStats {
  /** Share of the ice pixels under snow. */
  covered: number;
  /** Mean and spread of the snow's light over the covered pixels (bytes of shade / 1.5). */
  mean: number;
  spread: number;
}

export function verifyLakeFreshSnow(gl: WebGL2RenderingContext): Record<string, unknown> {
  const knobs = { ...paramDefaults("lake"), cover: 0.45 };
  const sim = lakeScene.sim?.(gl) ?? fail("no sim");
  const frame: SimFrame = {
    dt: 0,
    time: 0,
    motionTime: 0,
    motion: 1,
    now: 0,
    budget: Infinity,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    values: renderSettings(defaultsFor("lake"), knobs).params,
    params: knobs,
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
  };
  const textures = sim.frame(frame);
  const linked = compile(
    gl,
    fragmentSourceFor({
      ...lakeScene,
      entry: "regressionLakeSnow",
      glsl: `${lakeScene.glsl}
    Shade regressionLakeSnow(vec2 uv, vec2 cell, float t) {
      float aspect = uRes.x / uRes.y;
      lakeTh = threshold(cell);
      lakeSetup(t, aspect);
      if (uv.y > LAKE_HORIZON - 0.02) return shadeOf(vec3(0.0, 0.0, 1.0), 0.0, 0.0);
      LakeSnow s = lakeSnowAt(uv, aspect);
      return shadeOf(vec3(s.cover, s.cover > 0.5 ? lakeSnowShade(s) / 1.5 : 0.0, 0.0), 0.0, 0.0);
    }`,
    }),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const uniform = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(linked, name);
  gl.uniform2f(uniform("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(uniform("uView"), 1);
  gl.uniform1f(uniform("uTime"), 30);
  gl.uniform1f(uniform("uMotionTime"), 30);
  gl.uniform1f(uniform("uMotion"), 1);
  gl.uniform2f(uniform("uPassage"), 1, 0);
  gl.uniform1fv(uniform("uTriggers"), new Float32Array(8).fill(-1e4));
  textures.forEach((texture, slot) => {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.uniform1i(uniform(`uSim${slot}`), slot);
  });
  gl.uniform4f(uniform("uSimOn"), 1, 1, 1, 1);

  const draw = (fresh: number): SnowStats => {
    gl.uniform1fv(
      uniform("uParams"),
      Float32Array.from(renderSettings(defaultsFor("lake"), { ...knobs, fresh }).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    let ice = 0;
    let covered = 0;
    let sum = 0;
    let squares = 0;
    for (let at = 0; at < bytes.length; at += 4) {
      if ((bytes[at + 2] ?? 0) > 127) continue;
      ice++;
      if ((bytes[at] ?? 0) < 128) continue;
      covered++;
      const shade = bytes[at + 1] ?? 0;
      sum += shade;
      squares += shade * shade;
    }
    if (ice < (WIDTH * HEIGHT) / 4) fail(`only ${ice} ice pixels`);
    const mean = covered > 0 ? sum / covered : 0;
    return {
      covered: covered / ice,
      mean,
      spread: covered > 0 ? Math.sqrt(Math.max(0, squares / covered - mean * mean)) : 0,
    };
  };
  const old = draw(0);
  const fresh = draw(1);
  sim.dispose();
  gl.deleteProgram(linked);
  for (let slot = 0; slot < 4; slot++) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);

  if (old.covered < 0.05 || old.covered > 0.95)
    fail(`the fixture's snow covers ${old.covered} of the ice`);
  if (Math.abs(fresh.covered - old.covered) > 0.1 * old.covered)
    fail(`fresh snow moved the cover from ${old.covered} to ${fresh.covered}`);
  if (fresh.mean < old.mean + 8) fail(`fresh powder is not brighter: ${old.mean} -> ${fresh.mean}`);
  if (fresh.spread > 0.8 * old.spread)
    fail(`fresh powder kept the wind ridges: spread ${old.spread} -> ${fresh.spread}`);
  return { old, fresh };
}
