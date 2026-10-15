// Regressions for the countryside's wildlife (wildlife.ts) on the actual scene shader and the actual
// murmuration simulation: birds are never drawn over land that lies in front of them, the sky's birds
// follow the motion clock alone, and a switched-off murmuration costs the frame nothing.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "../../state.ts";
import { sceneDefs } from "../index.ts";
import type { SimFrame } from "../types.ts";
import { COUNTRY_FULL } from "./index.ts";

const WIDTH = 192;
const HEIGHT = 108;
/** Motion times (s) of the rooks fixture: parties in open sky, and swoops behind nearer ridges (170-173, 416, 936). */
const OCCLUDED_TIMES = [100, 150, 170, 171, 173, 416, 936];

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

/** Pixels that differ between two frames (rgb). */
function changed(a: Uint8Array, b: Uint8Array): boolean[] {
  return Array.from({ length: a.length / 4 }, (_, i) =>
    [0, 1, 2].some((c) => a[i * 4 + c] !== b[i * 4 + c]),
  );
}

/**
 * Mode 0 draws the actual scene. Modes 1 (birds) and 2 (murmuration) draw, at rest, r: where that
 * wildlife would cover the pixel before any occlusion, g: where a whole ridge nearer than it covers
 * the pixel with its visible outline (treetops included), so nothing of it may show there.
 */
const wrapper = `
uniform int regressionMode;
Shade regressionWildlife(vec2 uv, vec2 cell, float t) {
  Shade actual = sceneCountry(uv, cell, t);
  if (regressionMode == 0) return actual;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  vec2 spots = vec2(-0.2, 0.24) * aspect + countrySeed * 0.004 * aspect;
  float depth = COUNTRY_MURMURATION_DEPTH;
  float raw = 0.0;
  if (regressionMode == 1) {
    BirdHit bird = countryBirds(p, uMotionTime, vec2(0.0), spots);
    raw = bird.cover;
    depth = bird.depth;
  } else if (uSimOn.x > 0.5) {
    raw = step(0.05, flockSheet(uv).x);
  }
  float front = 0.0;
  for (int k = 0; k < 6; k++) {
    float terrain = 0.0;
    if (countryLayer(float(k)).x < depth && p.y < countryCrest(float(k), p.x, spots, terrain)) front = 1.0;
  }
  return shadeOf(vec3(raw, front, 0.0), 0.0, 0.0);
}`;

export function verifyCountryWildlife(gl: WebGL2RenderingContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const scene = program(
    gl,
    fragmentSourceFor(
      {
        ...sceneDefs.country,
        entry: "regressionWildlife",
        glsl: sceneDefs.country.glsl + wrapper,
      },
      COUNTRY_FULL,
    ),
  );
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(scene);
  const at = (name: string) => gl.getUniformLocation(scene, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1fv(at("uTriggers"), new Float32Array(8).fill(-1e4));
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform2f(at("uWeather"), 0, 0);
  gl.uniform2f(at("uPointer"), 0, 0);
  for (const [slot, name] of ["uSim0", "uSim1", "uSim2", "uSim3"].entries())
    gl.uniform1i(at(name), slot);
  const calm = {
    ...paramDefaults("country"),
    time: 0.5,
    clouds: 0,
    shadows: 0,
    wind: 0,
    fog: 0,
  };
  const draw = (
    knobs: Params,
    mode: number,
    motionTime: number,
    clock = motionTime,
    motion = 1,
    textures: readonly (WebGLTexture | undefined)[] = [],
  ): Uint8Array => {
    gl.uniform1i(at("regressionMode"), mode);
    gl.uniform1f(at("uTime"), clock);
    gl.uniform1f(at("uMotionTime"), motionTime);
    gl.uniform1f(at("uMotion"), motion);
    gl.uniform1fv(
      at("uParams"),
      Float32Array.from(renderSettings(defaultsFor("country"), knobs).params),
    );
    for (let slot = 0; slot < 4; slot++) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, textures[slot] ?? null);
    }
    gl.uniform4f(at("uSimOn"), textures[0] ? 1 : 0, textures[1] ? 1 : 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };

  // (a) Birds that dip behind a nearer ridge are hidden by it: no drawn bird pixel (the actual
  // frame with birds against the one without) lies where a ridge nearer than that bird covers it,
  // while the fixture does put birds there before occlusion.
  const rooks = { ...calm, songbirds: 1, "songbirds-amount": 1, flights: 1 };
  let drawn = 0;
  let hidden = 0;
  for (const time of OCCLUDED_TIMES) {
    const birds = changed(draw(rooks, 0, time), draw(calm, 0, time));
    const mask = draw(rooks, 1, time);
    birds.forEach((bird, i) => {
      const raw = (mask[i * 4] ?? 0) > 127;
      const front = (mask[i * 4 + 1] ?? 0) > 127;
      check(!(bird && front), `A bird was drawn over a nearer ridge at ${time}s, pixel ${i}`);
      if (bird) drawn++;
      if (raw && front) hidden++;
    });
  }
  check(drawn >= 40, `Birds fixture drew too few birds: ${drawn}`);
  check(hidden >= 3, `Birds fixture never put a bird behind a nearer ridge: ${hidden}`);
  result.wildlifeBirds = { drawn, hidden };

  // (b) The birds are fixed by the motion clock: the same motion time draws the same birds at
  // another scene clock and motion amount, and they move on as the motion clock advances.
  const birdsAt = (motionTime: number, clock: number, motion: number): boolean[] =>
    changed(draw(rooks, 0, motionTime, clock, motion), draw(calm, 0, motionTime, clock, motion));
  const still = birdsAt(150, 150, 1);
  check(still.some(Boolean), "No birds in the determinism fixture");
  check(
    birdsAt(150, 431, 0.35).every((bird, i) => bird === still[i]),
    "Birds moved with the scene clock or the motion amount at a fixed motion time",
  );
  check(
    birdsAt(151.5, 150, 1).some((bird, i) => bird !== still[i]),
    "Birds did not move as the motion clock advanced",
  );
  result.wildlifeDeterminism = true;

  // (c) The murmuration: switched off, the simulation hands over no textures and the scene draws
  // the same frame even with a flock's textures bound; switched on, the flock shows, and never
  // over a ridge nearer than it (the fixture pours it down to roost behind the hills).
  const sim = sceneDefs.country.sim?.(gl);
  if (!sim) throw new Error("Countryside simulation unavailable");
  const dusk = { ...calm, time: 0.72 };
  const flock = { ...dusk, murmuration: 1, "murmuration-amount": 3000 };
  const frame = (knobs: Params, exit: number): SimFrame => ({
    dt: 1 / 60,
    time: 10,
    motionTime: 10,
    motion: 1,
    width: WIDTH,
    height: HEIGHT,
    aspect: WIDTH / HEIGHT,
    params: knobs,
    values: renderSettings(defaultsFor("country"), knobs).params,
    triggers: Array.from({ length: 8 }, () => -1e4),
    fired: Array.from({ length: 8 }, () => false),
    passage: { enter: 1, exit },
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
  });
  check(
    sim.frame(frame(dusk, 0)).every((texture) => texture === undefined),
    "The murmuration switched off still handed the scene textures",
  );
  let textures = sim.frame(frame(flock, 0));
  for (let i = 0; i < 30; i++) textures = sim.frame(frame(flock, 0));
  check(textures[0] !== undefined, "The murmuration switched on handed the scene no density");
  const bare = draw(dusk, 0, 10);
  check(
    draw(dusk, 0, 10, 10, 1, textures).every((value, i) => value === bare[i]),
    "The murmuration switched off changed the frame",
  );
  const showing = changed(draw(flock, 0, 10, 10, 1, textures), draw(flock, 0, 10));
  const shown = showing.filter(Boolean).length;
  check(shown >= 30, `The murmuration switched on barely showed: ${shown}`);
  let roosting = textures;
  for (let i = 0; i < 50; i++) roosting = sim.frame(frame(flock, Math.min(1, i / 40)));
  const starlings = changed(draw(flock, 0, 10, 10, 1, roosting), draw(flock, 0, 10));
  const mask = draw(flock, 2, 10, 10, 1, roosting);
  let behind = 0;
  starlings.forEach((bird, i) => {
    const front = (mask[i * 4 + 1] ?? 0) > 127;
    check(!(bird && front), `The murmuration was drawn over a nearer ridge, pixel ${i}`);
    if ((mask[i * 4] ?? 0) > 127 && front) behind++;
  });
  check(behind >= 3, `The murmuration fixture never went behind a nearer ridge: ${behind}`);
  result.wildlifeMurmuration = { shown, behind };
  sim.dispose();
  for (let slot = 3; slot >= 0; slot--) {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.deleteProgram(scene);
  return result;
}
