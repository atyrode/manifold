// The pendulum wave's swing on the GPU (verify-browser.ts): the ideal row still lines up exactly,
// and the real one swings as the shared pendulum maths says (sims/pendulum.ts, its TS twin).
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { pendulumAngle, pendulumFadingSwings, pendulumStretch } from "../../sims/pendulum.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { sceneDefs } from "../index.ts";
import { PENDULA_SWING } from "./shader.ts";

/** Angles are written as 0.5 + angle / SPAN, split over two bytes. */
const SPAN = 2.4;
const COUNT = 18;
const CYCLE = 100;

function linked(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("pendula: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`pendula: ${gl.getShaderInfoLog(shader) ?? "compile failed"}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`pendula: ${gl.getProgramInfoLog(program) ?? "link failed"}`);
  return program;
}

/** Each pendulum's angle, read back from the scene's own swing (pendulaSwing, pendulaBobAt). */
export function verifyPendulaSwing(gl: WebGL2RenderingContext): Record<string, unknown> {
  const program = linked(
    gl,
    fragmentSourceFor({
      ...sceneDefs.pendula,
      entry: "regressionPendulaSwing",
      glsl: `${sceneDefs.pendula.glsl}
      Shade regressionPendulaSwing(vec2 uv, vec2 cell, float t) {
        float n0 = 2.0 * (K_count - 1.0);
        float k = n0 + floor(cell.x);
        float L = PENDULA_LMAX * (n0 / k) * (n0 / k);
        float c = uMotionTime / K_cycle;
        float env = K_release > 0.5 ? pendulaEnvelope(fract(c / PENDULA_RELEASE) * PENDULA_RELEASE) : 1.0;
        vec3 sw = pendulaSwing(k, L, c, fract(c), mix(PENDULA_LEAST, PENDULA_MOST, K_swing), env);
        vec3 bob = pendulaBobAt(vec3(0.0, PENDULA_PIVOT, 0.0), L, sw.x, sw.y);
        float v = clamp(0.5 + atan(bob.z, PENDULA_PIVOT - bob.y) / ${SPAN.toFixed(1)}, 0.0, 1.0) * 255.0;
        return shadeOf(vec3(floor(v) / 255.0, fract(v), 0.0), 0.0, 0.0);
      }`,
    }),
  );
  gl.canvas.width = COUNT;
  gl.canvas.height = 1;
  gl.useProgram(program);
  gl.viewport(0, 0, COUNT, 1);
  gl.uniform2f(gl.getUniformLocation(program, "uRes"), COUNT, 1);
  gl.uniform1i(gl.getUniformLocation(program, "uView"), 1);
  gl.uniform2f(gl.getUniformLocation(program, "uPassage"), 1, 0);
  const angles = (knobs: Record<string, number>, cycles: number): number[] => {
    gl.uniform1f(gl.getUniformLocation(program, "uMotionTime"), cycles * CYCLE);
    gl.uniform1fv(
      gl.getUniformLocation(program, "uParams"),
      Float32Array.from(renderSettings(defaultsFor("pendula"), { ...paramDefaults("pendula"), count: COUNT, cycle: CYCLE, swing: 0.5, ...knobs }).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(COUNT * 4);
    gl.readPixels(0, 0, COUNT, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return Array.from({ length: COUNT }, (_, i) => (((bytes[i * 4] ?? 0) + (bytes[i * 4 + 1] ?? 0) / 255) / 255 - 0.5) * SPAN);
  };
  const close = (got: readonly number[], want: (i: number) => number, tolerance: number, message: string): number => {
    let worst = 0;
    got.forEach((angle, i) => {
      worst = Math.max(worst, Math.abs(angle - want(i)));
    });
    if (worst > tolerance) throw new Error(`${message}: off by ${worst.toFixed(5)} rad (${got.map((a) => a.toFixed(3)).join(", ")})`);
    return worst;
  };
  const { least, most, decay } = PENDULA_SWING;
  const amp = least + (most - least) * 0.5;
  const n0 = 2 * (COUNT - 1);
  const result: Record<string, unknown> = {};

  // Ideal (the default): every bob back at its release angle each time the row lines up, and half a
  // cycle in every other bob swung the other way.
  result.idealRealigned = close(angles({}, 3), () => amp, 2e-4, "The ideal row did not line up after a full release");
  result.idealRunDown = close(angles({}, 1), () => amp * Math.exp(-decay), 2e-4, "The ideal row did not line up a cycle in");
  result.idealHalfway = close(angles({ release: 0 }, 0.5), (i) => (i % 2 === 0 ? amp : -amp), 2e-4, "The ideal row was not alternating half a cycle in");

  // Real: a board draws every bob back as far as the longest swings (thread n0² / k² of the longest),
  // so each swings at its own angle and is slowed by its own stretch. A GPU's sin and cos may be off
  // by 2e-4 (SwiftShader's), some 50 swings in: hence 5e-3 rad, against misses of a tenth and more.
  const board = (i: number): number => Math.asin(Math.min(((n0 + i) / n0) ** 2 * Math.sin(amp), 1));
  result.realReleased = close(angles({ physics: 1, release: 0 }, 0), board, 1e-3, "The real row was not let go from the board");
  const real = angles({ physics: 1, release: 0 }, 1);
  result.realSteady = close(real, (i) => pendulumAngle(board(i), (n0 + i) / pendulumStretch(board(i))), 5e-3, "The real row strayed from the pendulum maths");
  const miss = Math.max(...real.map((angle, i) => Math.abs(angle - board(i))));
  if (miss < 0.1) throw new Error(`The real row lined up as if ideal (largest miss ${miss.toFixed(3)} rad)`);
  result.realMiss = miss;
  result.realRunningDown = close(
    angles({ physics: 1 }, 1.5),
    (i) => pendulumAngle(board(i) * Math.exp(-decay * 1.5), (n0 + i) * pendulumFadingSwings(board(i), decay, 1.5)),
    5e-3,
    "The real row running down strayed from the pendulum maths",
  );
  gl.deleteProgram(program);
  return result;
}
