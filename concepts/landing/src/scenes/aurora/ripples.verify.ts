// GPU regression for the fjord's wind ripples (#1082 R45), on the real scene entry: they ruffle the
// open water and nothing else (the sky, mountains and shore above the horizon stay as they were, and
// ice stays still), and even at the strongest wind they stay calm under the dither. Registered in
// verify-browser.ts.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { auroraScene } from "./index.ts";
import { AURORA_HORIZON } from "./shader.ts";

const WIDTH = 240;
const HEIGHT = 135;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
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

export function verifyAuroraRipples(gl: WebGL2RenderingContext): Record<string, unknown> {
  const linked = program(gl, fragmentSourceFor(auroraScene));
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uColor"), 2);
  gl.uniform1f(at("uLevels"), 4);
  gl.uniform1f(at("uMotion"), 1);
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform4f(at("uMouse"), 0.5, 0.5, 0, -1e4);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform3f(at("uBg"), 0.02, 0.03, 0.05);
  gl.uniform3f(at("uInk"), 0.9, 0.9, 0.9);
  gl.uniform3f(at("uAccent"), 0.3, 0.94, 0.55);
  const draw = (knobs: Record<string, number>, time: number, view: number): Uint8Array => {
    gl.uniform1i(at("uView"), view);
    gl.uniform1f(at("uTime"), time);
    gl.uniform1f(at("uMotionTime"), time);
    gl.uniform1fv(
      at("uParams"),
      Float32Array.from(
        renderSettings(defaultsFor("aurora"), { ...paramDefaults("aurora"), ...knobs }).params,
      ),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const differs = (a: Uint8Array, b: Uint8Array, pixel: number) =>
    a[pixel * 4] !== b[pixel * 4] ||
    a[pixel * 4 + 1] !== b[pixel * 4 + 1] ||
    a[pixel * 4 + 2] !== b[pixel * 4 + 2];
  // Rows of cells wholly above the waterline (at rest) and wholly below it; rows run bottom to top.
  const waterRows = Math.floor(AURORA_HORIZON * HEIGHT);
  const skyFrom = Math.ceil(AURORA_HORIZON * HEIGHT);

  const still = draw({}, 30, 1);
  const ruffled = draw({ ripples: 1 }, 30, 1);
  let sky = 0;
  let water = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const row = Math.floor(pixel / WIDTH);
    if (row >= skyFrom && differs(still, ruffled, pixel)) sky++;
    if (row < waterRows && differs(still, ruffled, pixel)) water++;
  }
  check(sky === 0, `Wind ripples changed ${sky} cells above the water`);
  check(water >= (WIDTH * waterRows) / 10, `Wind ripples barely touched the water: ${water} cells`);

  const frozen = draw({ ice: 1 }, 30, 1);
  const frozenRuffled = draw({ ice: 1, ripples: 1 }, 30, 1);
  let iceChanged = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++)
    if (differs(frozen, frozenRuffled, pixel)) iceChanged++;
  check(iceChanged === 0, `Wind ripples moved ${iceChanged} cells of a frozen fjord`);

  // The strongest breeze, as the dither shows it, over one 30 fps frame at two moments.
  let flips = 0;
  for (const time of [30, 75.5]) {
    const before = draw({ ripples: 1, wind: 1 }, time, 0);
    const after = draw({ ripples: 1, wind: 1 }, time + 1 / 30, 0);
    for (let pixel = 0; pixel < WIDTH * waterRows; pixel++)
      if (differs(before, after, pixel)) flips++;
  }
  const share = flips / (2 * WIDTH * waterRows);
  check(
    share <= 0.05,
    `Wind ripples flicker: ${(share * 100).toFixed(1)}% of water cells change per frame`,
  );
  gl.deleteProgram(linked);
  return { rippledWaterCells: water, waterFlipsPerFrame: Number(share.toFixed(4)) };
}
