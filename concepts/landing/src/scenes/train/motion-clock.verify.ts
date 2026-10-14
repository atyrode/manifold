// Real-WebGL regression for the motion clock in Street and Train (F1, R38, R39): with the day cycle
// running, what each scene draws from its clock is the same at the same motion clock (uMotionTime)
// whatever the motion amount and the scene clock, so moving the Motion slider changes the pace
// without jumping the sky, the street's lit windows, Train's clouds, its station clock or a
// crossing's flashers; an hour more on the motion clock does change them. Each scene sets its clock
// globals as it draws (streetHour, trainSetup); small entries then draw those parts on their own,
// since software WebGL takes many seconds to compile either whole scene.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneDef } from "../types.ts";
import { sceneDefs } from "../index.ts";
import { TRAIN_CROSSING, TRAIN_STATION } from "./sim.ts";

interface Clocks {
  /** uTime, the scene clock. */
  time: number;
  /** uMotionTime, the motion clock. */
  motionTime: number;
  /** uMotion, the slider. */
  motion: number;
}

const WIDTH = 64;
const HEIGHT = 36;
/** A motion clock that the scene clock times no tested motion amount reproduces (600 × 1, 0.25, 0). */
const BASE: Clocks = { time: 600, motionTime: 240, motion: 1 };

function fail(message: string): never {
  throw new Error(`motion clock: ${message}`);
}

function compile(gl: WebGL2RenderingContext, scene: SceneDef, entry: string, glsl: string): WebGLProgram {
  const linked = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSourceFor({ ...scene, entry, glsl: scene.glsl + glsl })]] as const) {
    const shader = gl.createShader(type);
    if (!shader) fail("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) fail(`${scene.id}: ${gl.getShaderInfoLog(shader) ?? "compile failed"}`);
    gl.attachShader(linked, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(linked);
  if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) fail(`${scene.id}: ${gl.getProgramInfoLog(linked) ?? "link failed"}`);
  return linked;
}

/** One source-view frame of `linked` at `clocks` with the knobs `values`, uSim0 = `sim` if given. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, values: readonly number[], sim: WebGLTexture | undefined, clocks: Clocks): Uint8Array {
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1f(at("uTime"), clocks.time);
  gl.uniform1f(at("uMotionTime"), clocks.motionTime);
  gl.uniform1f(at("uMotion"), clocks.motion);
  gl.uniform1i(at("uView"), 1);
  gl.uniform4f(at("uMouse"), 0.5, 0.5, 0, -1e4);
  gl.uniform1fv(at("uParams"), Float32Array.from(values));
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform2f(at("uWeather"), 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sim ?? null);
  gl.uniform1i(at("uSim0"), 0);
  gl.uniform4f(at("uSimOn"), sim ? 1 : 0, 0, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  if (gl.getError() !== gl.NO_ERROR) fail("readPixels GL error");
  return bytes;
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
  return count;
}

/** Frames at BASE's motion clock under other motion amounts and another scene clock must equal
 *  BASE's; an hour more on the motion clock must not. Returns the pixels that hour changed. */
function invariance(gl: WebGL2RenderingContext, label: string, linked: WebGLProgram, values: readonly number[], sim?: WebGLTexture): number {
  const base = draw(gl, linked, values, sim, BASE);
  for (const clocks of [{ ...BASE, motion: 0.25 }, { ...BASE, motion: 0 }, { ...BASE, time: 900, motion: 0.25 }]) {
    const changed = differing(base, draw(gl, linked, values, sim, clocks));
    if (changed > 0) fail(`${label}: ${changed} of ${WIDTH * HEIGHT} pixels jumped at the same motion clock (uTime ${clocks.time}, uMotion ${clocks.motion})`);
  }
  // At cycle 1 a day takes 240 s of motion clock: 10 s more is an hour later.
  const later = differing(base, draw(gl, linked, values, sim, { ...BASE, motionTime: BASE.motionTime + 10 }));
  if (later === 0) fail(`${label}: an hour on the motion clock changed nothing (the check would be vacuous)`);
  return later;
}

/** The knobs at `time` of day with the day cycle running a day per four minutes. */
function dayCycle(id: "street" | "train", time: number): readonly number[] {
  return renderSettings(defaultsFor(id), { ...paramDefaults(id), time, cycle: 1, "cycle-amount": 1 }).params;
}

/** Street at midnight: the upper floors of the far right block, their windows switching on and off
 *  with the motion clock, lit by the hour's sky. */
function streetCheck(gl: WebGL2RenderingContext): number {
  const linked = compile(
    gl,
    sceneDefs.street,
    "regressionStreetHour",
    `
    Shade regressionStreetHour(vec2 uv, vec2 cell, float t) {
      streetHour();
      vec3 albedo;
      vec3 emit;
      float glass;
      streetFacade(1, uv.x * 40.0, 4.0 + uv.y * 14.0, vec2(0.02), false, albedo, emit, glass);
      return shadeOf(emit + albedo * streetAmbient, 0.0, 0.0);
    }`,
  );
  try {
    return invariance(gl, "street windows", linked, dayCycle("street", 0));
  } finally {
    gl.deleteProgram(linked);
  }
}

/** Train: the far country and its clouds at noon (stars, whose twinkle is the shared sky library's
 *  own, are out of it); then at midnight, a station's canopy middle and a level crossing level with
 *  the window (the odometer and two events in uSim0, as sim.ts lays them out), its clock face filling
 *  the frame, then the ground round the crossing under its flashers. */
function trainCheck(gl: WebGL2RenderingContext): Record<string, number> {
  const linked = compile(
    gl,
    sceneDefs.train,
    "regressionTrain",
    `
    uniform int regressionPart;
    Shade regressionTrain(vec2 uv, vec2 cell, float t) {
      trainSetup(cell, t);
      vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
      float hitZ = 1e6;
      float accent = 0.0;
      vec3 glow = vec3(0.0);
      if (regressionPart == 0) return shadeOf(trainFar(p + vec2(0.0, 0.3), t, true, hitZ, accent), 0.0, 0.0);
      if (regressionPart == 1) {
        // The clock hangs 6 m out from the eye, its face 0.38 m above it: look straight at it.
        vec2 o = vec2(0.0, TRAIN_HORIZON + 0.38 * TRAIN_F / 6.0) + p * 0.14;
        vec3 c = trainStationScene(o, t, vec3(0.0), hitZ, accent, glow);
        return shadeOf(vec3(dot(c, LUMA), abs(hitZ - 6.0) < 0.01 ? 1.0 : 0.0, 0.0), 0.0, 0.0);
      }
      // The crossing's road beyond the fence, 12..40 m out.
      vec2 o = vec2(p.x * 0.6, TRAIN_HORIZON - TRAIN_EYE * TRAIN_F / mix(12.0, 40.0, uv.y));
      float zg = TRAIN_EYE * TRAIN_F / (TRAIN_HORIZON - o.y);
      return shadeOf(trainGround(o, zg, o.x * zg / TRAIN_F, t), 0.0, 0.0);
    }`,
  );
  const events = new Float32Array(12 * 4);
  // 20 blocks and 100 m along at 4 m/s; a 170 m platform starting 85 m back, so its middle is level
  // with us; a level crossing right here.
  events.set([20, 100, 0, 4], 0);
  events.set([20, 15, 170, TRAIN_STATION, 0.3, 220, 0, 0], 8);
  events.set([20, 100, 0, TRAIN_CROSSING, 0.3, 130, 0, 0], 16);
  const sim = new DataTexture(gl, { width: 12, height: 1, format: "rgba16f", filter: "nearest" });
  sim.upload(events);
  const part = gl.getUniformLocation(linked, "regressionPart");
  try {
    gl.useProgram(linked);
    gl.uniform1i(part, 0);
    const clouds = invariance(gl, "train clouds", linked, dayCycle("train", 0.5));
    gl.uniform1i(part, 1);
    const midnight = dayCycle("train", 0);
    const face = draw(gl, linked, midnight, sim.texture, BASE);
    let atClock = 0;
    for (let i = 1; i < face.length; i += 4) if ((face[i] ?? 0) > 127) atClock++;
    if (atClock < 0.2 * WIDTH * HEIGHT) fail(`the station clock is not in view (${atClock} pixels at its depth)`);
    const stationClock = invariance(gl, "train station clock", linked, midnight, sim.texture);
    gl.uniform1i(part, 2);
    const flashers = invariance(gl, "train crossing flashers", linked, midnight, sim.texture);
    return { clouds, stationClock, flashers, clockPixels: atClock };
  } finally {
    gl.deleteProgram(linked);
    sim.dispose();
  }
}

/** The check: throws on a jump; returns the pixels an hour of motion clock changes in each part. */
export function verifyMotionClocks(gl: WebGL2RenderingContext): Record<string, unknown> {
  return { motionClock: { street: streetCheck(gl), train: trainCheck(gl) } };
}
