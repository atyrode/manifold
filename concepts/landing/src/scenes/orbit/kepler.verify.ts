// GPU regression for Orbit's orbital motion (verify-browser.ts, `orbitKepler`), read back from the
// scene's own GLSL: the moons (the shared planetMoon family, as orbit composes it) keep Kepler's third
// law, period² ∝ distance³, and a captured meteor's decaying orbit (orbitCapturePath) speeds up as
// it falls, its rate rising as distance^-1.5 the way a real decaying orbit's does. A probe entry
// writes one number per cell, each over three bytes.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { orbitScene } from "./index.ts";
import { ORBIT_CAPTURE } from "./shader.ts";

/** Numbers are written as value / SPAN, 0..1. */
const SPAN = 4;
/** Seconds of the motion clock a moon's turn is measured over (well under half a turn). */
const MOON_SPAN = 10;
/** Samples along the captured meteor's fall, and the share of it each one's turn is measured over. */
const FALL_SAMPLES = 16;
const FALL_STEP = 1 / 512;
/** Cells: per moon its distance and its turn over MOON_SPAN; per fall sample its distance and turn. */
const CELLS = 6 + 2 * FALL_SAMPLES;

const PROBE = `
// The angle between two points of an orbit about the planet's centre, radians (precise when small).
float probeTurn(vec3 a, vec3 b) {
  return atan(length(cross(a, b)), dot(a, b));
}

Shade probeOrbitKepler(vec2 uv, vec2 cell, float t) {
  int k = int(cell.x);
  float value = 0.0;
  if (k < 6) {
    PlanetMoon mo = planetMoon(k % 3, PlanetRing(0.9, -0.15));
    vec3 a = planetMoonAt(mo, uMotionTime, 0.0, 1.0);
    vec3 b = planetMoonAt(mo, uMotionTime + ${MOON_SPAN.toFixed(1)}, 0.0, 1.0);
    value = k < 3 ? length(a) : probeTurn(a, b);
  } else {
    int j = k - 6;
    float tt = float(j % ${FALL_SAMPLES}) / ${(FALL_SAMPLES - 1).toFixed(1)} * ${(1 - FALL_STEP).toFixed(6)};
    vec3 a = orbitCapturePath(tt, 0.7, 1.0, 0.6, 0.3);
    vec3 b = orbitCapturePath(tt + ${FALL_STEP.toFixed(8)}, 0.7, 1.0, 0.6, 0.3);
    value = j < ${FALL_SAMPLES} ? length(a) : probeTurn(a, b);
  }
  float v = clamp(value / ${SPAN.toFixed(1)}, 0.0, 1.0) * 255.0;
  float rest = fract(v) * 255.0;
  return shadeOf(vec3(floor(v) / 255.0, floor(rest) / 255.0, fract(rest)), 0.0, 0.0);
}
`;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function linked(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("orbit: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(`orbit: ${gl.getShaderInfoLog(shader) ?? "compile failed"}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`orbit: ${gl.getProgramInfoLog(program) ?? "link failed"}`);
  return program;
}

/** The largest relative spread of `values` about their mean. */
function spread(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(...values.map((value) => Math.abs(value / mean - 1)));
}

export function verifyOrbitKepler(gl: WebGL2RenderingContext): Record<string, unknown> {
  const program = linked(
    gl,
    fragmentSourceFor({ ...orbitScene, entry: "probeOrbitKepler", glsl: orbitScene.glsl + PROBE }),
  );
  gl.canvas.width = CELLS;
  gl.canvas.height = 1;
  gl.viewport(0, 0, CELLS, 1);
  gl.useProgram(program);
  const at = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform2f(at("uRes"), CELLS, 1);
  gl.uniform1i(at("uView"), 1);
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform1f(at("uMotion"), 1);
  gl.uniform1fv(
    at("uParams"),
    Float32Array.from(renderSettings(defaultsFor("orbit"), paramDefaults("orbit")).params),
  );
  const read = (time: number): number[] => {
    gl.uniform1f(at("uTime"), time);
    gl.uniform1f(at("uMotionTime"), time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(CELLS * 4);
    gl.readPixels(0, 0, CELLS, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "orbit: readPixels failed");
    return Array.from(
      { length: CELLS },
      (_, i) =>
        (((bytes[i * 4] ?? 0) + ((bytes[i * 4 + 1] ?? 0) + (bytes[i * 4 + 2] ?? 0) / 255) / 255) /
          255) *
        SPAN,
    );
  };
  const result: Record<string, unknown> = {};

  // The moons: each one's rate over MOON_SPAN seconds, at two clocks; rate² × distance³ is one
  // constant across them (Kepler's third law). A 1% spread is float noise; the moons as they were
  // (rates 0.060, 0.046, 0.032) spread 36%.
  const moonLaw: number[] = [];
  for (const time of [17, 263]) {
    const cells = read(time);
    for (let i = 0; i < 3; i++) {
      const distance = cells[i] ?? 0;
      const rate = (cells[3 + i] ?? 0) / MOON_SPAN;
      check(distance > 1 && distance < 2, `orbit: moon ${i} at ${distance} radii`);
      moonLaw.push(rate * rate * distance ** 3);
    }
  }
  result.moonLawSpread = spread(moonLaw);
  check(
    spread(moonLaw) < 0.01,
    `orbit: the moons break Kepler's third law (rate² × distance³: ${moonLaw.map((x) => x.toPrecision(4)).join(", ")})`,
  );

  // The captured meteor: its distance falls from ORBIT_CAPTURE.from to .to; its rate rises all the
  // way down, as distance^-1.5 (rate × distance^1.5 stays put), so its speed rises too.
  const cells = read(0);
  const fall = Array.from({ length: FALL_SAMPLES }, (_, j) => ({
    distance: cells[6 + j] ?? 0,
    turn: cells[6 + FALL_SAMPLES + j] ?? 0,
  }));
  const first = fall[0];
  const last = fall.at(-1);
  check(first !== undefined && last !== undefined, "orbit: no fall samples");
  if (first === undefined || last === undefined) return result;
  check(
    Math.abs(first.distance - ORBIT_CAPTURE.from) < 0.02 &&
      Math.abs(last.distance - ORBIT_CAPTURE.to) < 0.02,
    `orbit: the capture falls from ${first.distance} to ${last.distance} radii`,
  );
  for (let j = 1; j < FALL_SAMPLES; j++) {
    const before = fall[j - 1];
    const now = fall[j];
    if (before === undefined || now === undefined) continue;
    check(now.distance < before.distance, `orbit: the capture climbs at sample ${j}`);
    check(now.turn > before.turn, `orbit: the capture slows at sample ${j}`);
    check(
      now.turn * now.distance > before.turn * before.distance,
      `orbit: the capture's speed drops at sample ${j}`,
    );
  }
  const keplerian = fall.map((sample) => sample.turn * sample.distance ** 1.5);
  result.captureRateGain = last.turn / first.turn;
  result.captureSpeedGain = (last.turn * last.distance) / (first.turn * first.distance);
  result.captureLawSpread = spread(keplerian);
  check(
    spread(keplerian) < 0.03,
    `orbit: the capture's rate is not distance^-1.5 (rate × distance^1.5: ${keplerian.map((x) => x.toPrecision(4)).join(", ")})`,
  );
  gl.deleteProgram(program);
  return result;
}
