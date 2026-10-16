// GPU check of last call through the bar's real sim (sim.ts) and shader: early in the evening the
// OPEN sign in the window is lit, and once last call has been called it is closing time, the sign
// dark, whatever the time-of-night knob says.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SimFrame } from "../types.ts";
import { barScene } from "./index.ts";

const W = 320;
const H = 180;

function program(gl: WebGL2RenderingContext): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSourceFor(barScene)],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("bar last call: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) ?? "bar last call: compile failed");
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(linked) ?? "bar last call: link failed");
  return linked;
}

export function verifyBarLastCall(gl: WebGL2RenderingContext): Record<string, unknown> {
  const slot = barScene.params.find((def) => def.key === "night")?.trigger;
  if (slot === undefined) throw new Error("bar last call: the night knob has no 'now'");
  const knobs = paramDefaults("bar");
  const params = renderSettings(defaultsFor("bar"), knobs).params;
  const linked = program(gl);
  const u = (name: string) => gl.getUniformLocation(linked, name);
  // Neon red in the window around the sign (it hangs at x -1.97, y 1.75 m, 2.55 m ahead: about
  // uv (0.13, 0.61) in a 16:9 frame).
  const neon = (texture: WebGLTexture | undefined, time: number): number => {
    gl.useProgram(linked);
    gl.viewport(0, 0, W, H);
    gl.uniform2f(u("uRes"), W, H);
    gl.uniform1i(u("uView"), 1);
    gl.uniform1f(u("uTime"), time);
    gl.uniform1f(u("uMotionTime"), time);
    gl.uniform1f(u("uMotion"), 1);
    gl.uniform1fv(u("uParams"), Float32Array.from(params));
    gl.uniform1fv(u("uTriggers"), new Float32Array(8).fill(-1e4));
    gl.uniform2f(u("uPassage"), 1, 0);
    gl.uniform4f(u("uSimOn"), 1, 0, 0, 0);
    gl.uniform1i(u("uSim0"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    let n = 0;
    for (let y = Math.floor(0.52 * H); y < Math.ceil(0.72 * H); y++) {
      for (let x = Math.floor(0.06 * W); x < Math.ceil(0.2 * W); x++) {
        const at = (y * W + x) * 4;
        if ((out[at] ?? 0) > 170 && (out[at + 1] ?? 255) < 90 && (out[at + 2] ?? 255) < 120) n++;
      }
    }
    return n;
  };
  // Two evenings from the same opening, thirty seconds on; in the second last call is called at five.
  const evening = (callAt: number): { texture: WebGLTexture | undefined; dispose: () => void } => {
    const sim = barScene.sim?.(gl);
    if (!sim) throw new Error("bar last call: the scene has no sim");
    const triggers = Array.from({ length: 8 }, () => -1e4);
    const frame: SimFrame = {
      dt: 0,
      time: 0,
      motionTime: 0,
      motion: 1,
      now: 0,
      budget: Infinity,
      width: W,
      height: H,
      aspect: W / H,
      params: knobs,
      values: params,
      triggers,
      fired: Array.from({ length: 8 }, () => false),
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      passage: { enter: 1, exit: 0 },
    };
    let texture = sim.frame(frame)[0];
    frame.dt = 0.1;
    for (let i = 1; i <= 300; i++) {
      frame.time = i * 0.1;
      frame.motionTime = frame.time;
      if (i === callAt * 10) triggers[slot] = frame.time;
      texture = sim.frame(frame)[0];
    }
    return { texture, dispose: () => sim.dispose() };
  };
  const open = evening(-1);
  const closing = evening(5);
  try {
    const lit = neon(open.texture, 30);
    const dark = neon(closing.texture, 30);
    if (lit < 10)
      throw new Error(
        `bar last call: the OPEN sign showed only ${lit} neon pixels early in the evening`,
      );
    if (dark !== 0)
      throw new Error(
        `bar last call: ${dark} neon pixels of the OPEN sign still lit twenty-five seconds after last call`,
      );
    return { neonPixels: { open: lit, afterLastCall: dark } };
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, null);
    open.dispose();
    closing.dispose();
    gl.deleteProgram(linked);
  }
}
