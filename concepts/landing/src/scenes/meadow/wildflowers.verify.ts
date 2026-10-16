// Real-WebGL regression for the meadow's wildflowers (wildflowers.ts; run by verify-browser.ts) on
// the actual scene shader and simulation: switched off they add nothing, compiled in or not and
// whatever texture is bound; switched on, they stand out of the grass; the gusts bow them, and once
// the air is still they stand exactly as clumps grown in it.
import {
  fragmentSourceFor,
  sceneFeatures,
  shaderValues,
  vertexSource,
} from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "../../state.ts";
import { sceneDefs } from "../index.ts";
import type { SceneSim, SimFrame } from "../types.ts";

const W = 256;
const H = 160;
const AT = 20;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`meadow wildflowers: ${message}`);
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

/** How many pixels differ between two frames. */
function changed(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < W * H; i++) if ([0, 1, 2].some((c) => a[i * 4 + c] !== b[i * 4 + c])) n++;
  return n;
}

export function verifyMeadowWildflowers(gl: WebGL2RenderingContext): Record<string, unknown> {
  const meadow = sceneDefs.meadow;
  const calm: Params = { ...paramDefaults("meadow"), gusts: 0, wind: 0 };
  const grown: Params = { ...calm, wildflowers: 1, "wildflowers-amount": 1 };
  const off = sceneFeatures(meadow, shaderValues(meadow, calm));
  const on = sceneFeatures(meadow, shaderValues(meadow, grown));
  check(off.MEADOW_HAS_WILDFLOWERS === 0, "the wildflowers are compiled in while they are off");
  const plain = program(gl, fragmentSourceFor(meadow, off));
  const gated = program(gl, fragmentSourceFor(meadow, on));
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  const draw = (linked: WebGLProgram, knobs: Params, flowers?: WebGLTexture): Uint8Array => {
    gl.useProgram(linked);
    const u = (name: string) => gl.getUniformLocation(linked, name);
    gl.uniform2f(u("uRes"), W, H);
    gl.uniform1f(u("uTime"), AT);
    gl.uniform1f(u("uMotionTime"), AT);
    gl.uniform1f(u("uMotion"), 1);
    gl.uniform1f(u("uLevels"), 2);
    gl.uniform1i(u("uView"), 1);
    gl.uniform2f(u("uPassage"), 1, 0);
    gl.uniform2f(u("uWeather"), 0, 0);
    gl.uniform2f(u("uPointer"), 0, 0);
    gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
    gl.uniform1i(u("uSim3"), 3);
    gl.uniform1fv(
      u("uParams"),
      Float32Array.from(renderSettings(defaultsFor("meadow"), knobs).params),
    );
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, flowers ?? null);
    gl.uniform4f(u("uSimOn"), 0, 0, 0, flowers ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const frame = (knobs: Params, time: number): SimFrame => ({
    dt: 1 / 60,
    time,
    motionTime: time,
    motion: 1,
    now: time * 1000,
    budget: Infinity,
    width: W,
    height: H,
    aspect: W / H,
    params: knobs,
    values: renderSettings(defaultsFor("meadow"), knobs).params,
    triggers: Array.from({ length: 8 }, () => -1e4),
    fired: Array.from({ length: 8 }, () => false),
    passage: { enter: 1, exit: 0 },
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
  });
  const run = (sim: SceneSim, knobs: Params, from: number, seconds: number) => {
    let flowers: WebGLTexture | undefined;
    for (let n = 0; n <= Math.round(seconds * 60); n++)
      flowers = sim.frame(frame(knobs, from + n / 60))[3];
    return flowers;
  };
  const still = meadow.sim?.(gl);
  const windy = meadow.sim?.(gl);
  if (!still || !windy) throw new Error("Meadow simulation unavailable");
  const result: Record<string, unknown> = {};
  try {
    check(
      run(still, calm, 0, 0) === undefined,
      "switched off, the sim still handed over a texture",
    );
    const rest = run(still, grown, 0, 0);
    check(rest !== undefined, "switched on, the sim handed over no texture");
    const bare = draw(plain, calm);
    check(changed(draw(gated, calm, rest), bare) === 0, "switched off, they changed the frame");
    const shown = changed(draw(gated, grown, rest), bare);
    check(shown >= 60, `they barely showed: ${shown} pixels`);
    result.wildflowersShown = shown;
    const gusty = { ...grown, gusts: 1, "gusts-amount": 1, gustRate: 1, wind: 0.6 };
    const first = draw(gated, gusty, run(windy, gusty, 0, 8));
    const later = draw(gated, gusty, run(windy, gusty, 8, 1));
    const swayed = changed(first, later);
    check(swayed >= 10, `the gusts barely moved them: ${swayed} pixels`);
    result.wildflowersSwayed = swayed;
    const settled = run(windy, grown, 9, 8);
    check(
      changed(draw(gated, grown, settled), draw(gated, grown, rest)) === 0,
      "they did not come back to rest once the air was still",
    );
  } finally {
    still.dispose();
    windy.dispose();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.deleteProgram(plain);
    gl.deleteProgram(gated);
  }
  return result;
}
