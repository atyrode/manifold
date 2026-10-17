// GPU regression for the shared star density knob (K_stars, skyKnobs({ stars })) where it replaced a
// fixed density: above the cloud sea, over the murmuration and over the shore (and in its wet sand),
// run by concepts/landing/verify-browser.ts on real WebGL output. Each scene starts at the density
// it drew before, and on a clear night no stars, its own and a dark-site sky light it more and more:
// each step by more than 0.02% of the whole frame's light, far more than the wet sand's glints alone.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, packParams, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`stars knob: ${message}`);
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

const WIDTH = 160;
const HEIGHT = 90;

/** The source view's summed luminance, drawn into a float target. */
function light(
  gl: WebGL2RenderingContext,
  linked: WebGLProgram,
  params: readonly number[],
): number {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, WIDTH, HEIGHT, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  // Unbound, so no uSim sampler (all on unit 0) reads the target it renders into.
  gl.bindTexture(gl.TEXTURE_2D, null);
  check(
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
    "float target incomplete",
  );
  gl.useProgram(linked);
  gl.viewport(0, 0, WIDTH, HEIGHT);
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1f(at("uTime"), 40);
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform4f(at("uMouse"), -1, -1, 0, -1e4);
  gl.uniform3f(at("uBg"), 0.03, 0.03, 0.05);
  gl.uniform4fv(at("uParams"), packParams(params));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  let sum = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++)
    sum +=
      0.2126 * (out[i * 4] ?? 0) + 0.7152 * (out[i * 4 + 1] ?? 0) + 0.0722 * (out[i * 4 + 2] ?? 0);
  return sum;
}

export function verifyStarsKnob(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const result: Record<string, number[]> = {};
  // The density each drew before the knob, and a clear night with the most sky in view.
  for (const [id, before, night] of [
    ["clouds", 0.75, { time: 0, window: 0 }],
    ["flock", 0.45, { time: 0 }],
    ["shore", 0.6, { time: 0 }],
  ] as const) {
    check(
      paramDefaults(id)["stars"] === before,
      `${id} does not start at its former density ${before}`,
    );
    const linked = program(gl, fragmentSourceFor(sceneDefs[id]));
    const sums = [0, before, 1].map((stars) =>
      light(
        gl,
        linked,
        renderSettings(defaultsFor(id), { ...paramDefaults(id), ...night, stars }).params,
      ),
    );
    const [none = 0, own = 0, dark = 0] = sums;
    check(
      own - none > 2e-4 * none && dark - own > 2e-4 * own,
      `${id}'s night does not brighten with its stars: ${sums.map((x) => x.toFixed(3)).join(", ")}`,
    );
    result[id] = sums.map((x) => Number(x.toFixed(3)));
    gl.deleteProgram(linked);
  }
  return result;
}
