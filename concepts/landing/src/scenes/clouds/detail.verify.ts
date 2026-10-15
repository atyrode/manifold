// GPU check (verify-browser.ts): the cloud tops' fine relief fades out with the cell footprint and is
// skipped once fully faded (cloudSeaSurface, the shared clouds' volume tier the scene draws).
// Skipping is only safe while "fully faded" means "adds nothing" and any detail above zero still
// shapes the tops; this draws the real GLSL over a grid of deck points and fails if an early-out ever
// drops relief that is still meant to show, or if the faded surface stops being the bare macro field.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { cloudsScene } from "./index.ts";

const SIZE = 64;

const checkGlsl = `
Shade cloudsDetailCheck(vec2 uv, vec2 cell, float t) {
  vec2 w = (cell - 0.5) * 0.173 + vec2(3.1, -7.4);
  float cover = 0.75;
  float boil = 1.3;
  float macro = cloudSeaMacro(w, cover, boil);
  float off = cloudSeaSurface(w, cover, boil, 0.0);
  float faint = cloudSeaSurface(w, cover, boil, 1.0 / 64.0);
  float full = cloudSeaSurface(w, cover, boil, 1.0);
  // r: fully faded, the surface is the macro field. g: on tops tall enough to carry relief (0 where
  // none is due), 1 if a 1/64 share of it still shows, 0.5 if it was dropped. b: the relief grows
  // from nothing in proportion to the detail, never more than its amplitude 0.16 * 0.6.
  float r = abs(off - macro) <= 1e-6 ? 1.0 : 0.0;
  float tall = smoothstep(0.1, 0.5, macro);
  float g = tall > 0.05 ? (abs(faint - macro) > 1e-6 ? 1.0 : 0.5) : 0.0;
  float b = abs(faint - off) <= 0.096 / 64.0 + 1e-6 && abs(full - off) <= 0.096 + 1e-6 ? 1.0 : 0.0;
  return shadeOf(vec3(r, g, b), 0.0, 0.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("clouds detail: shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "clouds detail: compile failed");
  return shader;
}

export function verifyCloudsDetail(gl: WebGL2RenderingContext): Record<string, unknown> {
  const fragment = fragmentSourceFor({ ...cloudsScene, entry: "cloudsDetailCheck", glsl: cloudsScene.glsl + checkGlsl });
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertexSource), compile(gl, gl.FRAGMENT_SHADER, fragment)];
  const program = gl.createProgram();
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "clouds detail: link failed");
  for (const shader of shaders) gl.deleteShader(shader);

  gl.canvas.width = SIZE;
  gl.canvas.height = SIZE;
  gl.useProgram(program);
  gl.viewport(0, 0, SIZE, SIZE);
  gl.uniform2f(gl.getUniformLocation(program, "uRes"), SIZE, SIZE);
  gl.uniform1i(gl.getUniformLocation(program, "uView"), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  if (gl.getError() !== gl.NO_ERROR) throw new Error("clouds detail: GL error");
  gl.deleteProgram(program);

  let tall = 0;
  let shown = 0;
  for (let at = 0; at < bytes.length; at += 4) {
    if (bytes[at] !== 255) throw new Error(`clouds detail: fully faded relief changed the tops at point ${at / 4}`);
    if (bytes[at + 2] !== 255) throw new Error(`clouds detail: relief out of proportion to its detail at point ${at / 4}`);
    const g = bytes[at + 1] ?? 0;
    if (g > 64) tall++;
    if (g === 255) shown++;
  }
  if (tall < SIZE * SIZE * 0.2) throw new Error(`clouds detail: fixture lacked tall tops (${tall})`);
  if (shown < tall * 0.9) throw new Error(`clouds detail: faint relief was dropped on ${tall - shown} of ${tall} tall tops`);
  return { tallTops: tall, faintReliefShown: shown };
}
