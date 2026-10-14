// GPU checks for the pond's steered koi (koi.ts), run by verify-browser.ts against real WebGL:
//   - the sim's mirror of the koi loops (koiLoop, glslHash12) agrees with the shader's pondKoiPath
//     within a cell, also far into the clock, so a koi taken over from its loop or handed back to it
//     does not jump;
//   - a koi texture at tag 0 leaves the picture exactly as without it (the default render), and at
//     tag 1 the koi is drawn where the sim has it, not on its loop.
import { paramDefaults, defaultsFor, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { FishGroup, FishTexture, KOI } from "../../sims/fish.ts";
import { sceneDefs } from "../index.ts";
import { koiLoop, koiLoops, KOI_MAX } from "./koi.ts";

const W = 160;
const H = 90;

function fail(message: string): never {
  throw new Error(`pond koi: ${message}`);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type);
    if (!shader) fail("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) fail(gl.getShaderInfoLog(shader) ?? "compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) fail(gl.getProgramInfoLog(linked) ?? "link failed");
  return linked;
}

/** One frame of `linked` in the source view (raw colour), W × H, with `knobs` over the pond's defaults. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, knobs: Record<string, number>, motionTime: number, koi?: WebGLTexture): Uint8Array {
  gl.canvas.width = W;
  gl.canvas.height = H;
  gl.viewport(0, 0, W, H);
  gl.useProgram(linked);
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), W, H);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1f(at("uTime"), motionTime / 0.6);
  gl.uniform1f(at("uMotionTime"), motionTime);
  gl.uniform1f(at("uMotion"), 0.6);
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform1fv(at("uParams"), Float32Array.from(renderSettings(defaultsFor("pond"), { ...paramDefaults("pond"), ...knobs }).params));
  gl.uniform1i(at("uSim2"), 2);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, koi ?? null);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform4f(at("uSimOn"), 0, 0, koi ? 1 : 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return bytes;
}

export function verifyPondKoi(gl: WebGL2RenderingContext): Record<string, unknown> {
  gl.bindVertexArray(gl.createVertexArray());
  const aspect = W / H;
  const loops = koiLoops();

  // 1. The loops: the shader's pondKoiPath minus the sim's koiLoop, 50× about mid-grey, one pixel per
  //    koi and path time. A cell at 540 rows is 1/540 pond heights: within it, a byte stays within ±0.1.
  const times = [0.5, 37.25, 412.5, 2981.75];
  const mirror = program(gl, fragmentSourceFor({
    ...sceneDefs.pond,
    entry: "regressionKoiLoop",
    glsl: `${sceneDefs.pond.glsl}
uniform vec2 regressionLoop[${KOI_MAX * times.length}];
uniform float regressionTime[${times.length}];
Shade regressionKoiLoop(vec2 uv, vec2 cell, float t) {
  int i = int(cell.x);
  int k = int(cell.y);
  vec2 d = pondKoiPath(float(i), regressionTime[k] + float(i) * 11.0, ${(W / H).toFixed(6)}) - regressionLoop[k * ${KOI_MAX} + i];
  return shadeOf(vec3(0.5 + 50.0 * d, 0.0), 0.0, 0.0);
}`,
  }));
  const expected = new Float32Array(2 * KOI_MAX * times.length);
  const out = new Float64Array(4);
  times.forEach((s, k) => {
    loops.forEach((loop, i) => {
      koiLoop(loop, s + i * 11, aspect, out);
      expected[2 * (k * KOI_MAX + i)] = out[0] ?? 0;
      expected[2 * (k * KOI_MAX + i) + 1] = out[1] ?? 0;
    });
  });
  gl.useProgram(mirror);
  gl.uniform2fv(gl.getUniformLocation(mirror, "regressionLoop"), expected);
  gl.uniform1fv(gl.getUniformLocation(mirror, "regressionTime"), Float32Array.from(times));
  const loopBytes = draw(gl, mirror, {}, 0);
  let worst = 0;
  for (let k = 0; k < times.length; k++) {
    for (let i = 0; i < KOI_MAX; i++) {
      const p = 4 * (k * W + i);
      for (const c of [0, 1]) worst = Math.max(worst, Math.abs((loopBytes[p + c] ?? 0) / 255 - 0.5) / 50);
    }
  }
  if (worst > 1 / 540) fail(`the sim's koi loops stray ${worst.toFixed(5)} pond heights from the shader's`);
  gl.deleteProgram(mirror);

  // 2. The blend: koi 0 steered to the middle of the pond, the others on their loops.
  const pond = program(gl, fragmentSourceFor(sceneDefs.pond));
  const knobs = { "koi-amount": 3, follow: 1, plants: 0, lilies: 0, caustics: 0, rays: 0, ripples: 0 };
  const motionTime = 41.5;
  const pace = 0.6 + 2.4 * 0.4;
  const group = new FishGroup(KOI, KOI_MAX);
  const loopAt: [number, number][] = [];
  loops.forEach((loop, i) => {
    koiLoop(loop, motionTime * pace + i * 11, aspect, out);
    loopAt.push([out[0] ?? 0, out[1] ?? 0]);
    group.place(i, out[0] ?? 0, out[1] ?? 0, Math.atan2(out[3] ?? 0, out[2] ?? 0), 0, loop.len, 0);
  });
  const [ox, oy] = loopAt[0] ?? [0, 0];
  const [k1x, k1y] = loopAt[1] ?? [0, 0];
  // Somewhere clear of every koi's loop position.
  const target: [number, number] = ox > 0 ? [-0.55, -oy * 0.5] : [0.55, -oy * 0.5];
  for (const [x, y] of [[k1x, k1y], loopAt[2] ?? [0, 0], target]) {
    if (Math.hypot(x - ox, y - oy) < 0.25) fail("fixture: koi 0's loop position is crowded at this clock; pick another");
  }
  if (Math.hypot(target[0] - k1x, target[1] - k1y) < 0.25) fail("fixture: the steered spot is crowded; pick another");
  group.place(0, target[0], target[1], 0, 0, loops[0]?.len ?? 0.14, 0);
  const texture = new FishTexture(gl, KOI_MAX);
  const pixel = (bytes: Uint8Array, x: number, y: number): number[] => {
    const px = Math.round((x / aspect + 0.5) * W);
    const py = Math.round((y + 0.5) * H);
    const p = 4 * (py * W + px);
    return [bytes[p] ?? 0, bytes[p + 1] ?? 0, bytes[p + 2] ?? 0];
  };
  const bare = draw(gl, pond, knobs, motionTime);
  for (let i = 0; i < KOI_MAX; i++) group.tag[4 * i] = 0;
  texture.upload(group, 3);
  const idle = draw(gl, pond, knobs, motionTime, texture.texture);
  if (idle.some((byte, index) => byte !== bare[index])) fail("a koi texture shown at 0 changed the picture");
  for (let i = 0; i < KOI_MAX; i++) group.tag[4 * i] = 1;
  texture.upload(group, 3);
  const steered = draw(gl, pond, knobs, motionTime, texture.texture);
  const same = (a: number[], b: number[]) => a.every((v, c) => v === b[c]);
  if (same(pixel(bare, ...target), pixel(steered, ...target))) fail("the steered koi is not drawn where the sim has it");
  if (same(pixel(bare, ox, oy), pixel(steered, ox, oy))) fail("the steered koi is still drawn on its loop");
  texture.dispose();
  gl.deleteProgram(pond);
  return { loopStray: worst, steeredDrawn: true, idleUntouched: true };
}
