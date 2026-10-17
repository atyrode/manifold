// GPU regression for Orbit's depth order (#1082 R01): ring material nearer the eye than a moon or a
// captured meteor covers it, and ring material behind a moon never does. It renders the real scene
// entry with knob combinations and compares them pixel by pixel, all through its all-features program
// (every ORBIT_* gate compiled in, the knobs deciding); the captured meteor is drawn at a moment read
// off its own path (orbitCapturePath) by a probe entry. Registered in verify-browser.ts.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  fragmentSourceFor,
  packParams,
  sceneFeaturesAll,
  vertexSource,
} from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { orbitScene } from "./index.ts";
import { ORBIT_CAPTURE } from "./shader.ts";

const WIDTH = 480;
const HEIGHT = 270;
/** orbitCapturedEvent's trail: its head and the places it passed, TRAIL in all, TRAIL_GAP seconds apart. */
const TRAIL = 16;
const TRAIL_GAP = 0.05;
/**
 * How far (planet radii) every place of the meteor's trail lies behind the ring plane at the moment
 * drawn: well past the ring's change in depth across a drawn dot (about 0.02 here).
 */
const BEHIND = 0.05;
/** Moments of a fall the probe tries, TRAIL_GAP apart: from the first with the whole trail on to the burn-up. */
const MOMENTS = Math.round(ORBIT_CAPTURE.seconds / TRAIL_GAP) - TRAIL + 2;

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

/**
 * Seconds into the fall of capture `id` (orbitCaptured's numbering, orbitCaptureOrbit its orbit) at
 * which every place of its trail is in sight, over the ring's span and BEHIND radii or more behind
 * the ring plane, at the ring settings in `params`: the middle of the longest run of such moments. A
 * probe entry reads them off the scene's own GLSL, one moment per cell of the bottom row (the canvas
 * WIDTH wide).
 */
function captureBehindRing(gl: WebGL2RenderingContext, params: Float32Array, id: number): number {
  const gap = glslFloat(TRAIL_GAP);
  const entry = `
Shade probeCaptureBehindRing(vec2 uv, vec2 cell, float t) {
  float tau = (floor(cell.x) + ${glslFloat(TRAIL - 1)}) * ${gap};
  vec4 orbit = orbitCaptureOrbit(${glslFloat(id)});
  PlanetRing plane = orbitRingPlane();
  PlanetRingBands bands = orbitRingBands();
  float behind = 1.0;
  for (int i = 0; i < ${TRAIL}; i++) {
    vec3 pos = orbitCapturePath((tau - float(i) * ${gap}) / ${glslFloat(ORBIT_CAPTURE.seconds)}, orbit.x, orbit.y, orbit.z, orbit.w);
    vec3 ring = planetRingAt(plane, pos.xy);
    float rho = length(ring.xy);
    if (planetBehind(pos) || ring.z < pos.z + ${glslFloat(BEHIND)} || rho < bands.inner || rho > bands.outer) behind = 0.0;
  }
  return shadeOf(vec3(behind), 0.0, 0.0);
}
`;
  const probe = program(
    gl,
    fragmentSourceFor(
      { ...orbitScene, entry: "probeCaptureBehindRing", glsl: orbitScene.glsl + entry },
      sceneFeaturesAll(orbitScene),
    ),
  );
  gl.useProgram(probe);
  gl.uniform2f(gl.getUniformLocation(probe, "uRes"), WIDTH, HEIGHT);
  gl.uniform1i(gl.getUniformLocation(probe, "uView"), 1);
  gl.uniform4fv(gl.getUniformLocation(probe, "uParams"), packParams(params));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const bytes = new Uint8Array(MOMENTS * 4);
  gl.readPixels(0, 0, MOMENTS, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
  gl.deleteProgram(probe);
  let longest = { from: 0, length: 0 };
  let from = 0;
  for (let moment = 0; moment <= MOMENTS; moment++) {
    if (moment < MOMENTS && bytes[moment * 4] === 255) continue;
    if (moment - from > longest.length) longest = { from, length: moment - from };
    from = moment + 1;
  }
  check(
    longest.length > 0,
    `Fixture: capture ${id}'s trail never lies wholly behind the ring as it falls`,
  );
  return (longest.from + Math.floor(longest.length / 2) + TRAIL - 1) * TRAIL_GAP;
}

export function verifyOrbitRingDepth(gl: WebGL2RenderingContext): Record<string, unknown> {
  const linked = program(gl, fragmentSourceFor(orbitScene, sceneFeaturesAll(orbitScene)));
  gl.canvas.width = WIDTH;
  gl.canvas.height = HEIGHT;
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.useProgram(linked);
  const at = (name: string) => gl.getUniformLocation(linked, name);
  gl.uniform2f(at("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(at("uView"), 1);
  gl.uniform1f(at("uMotion"), 1);
  gl.uniform2f(at("uPassage"), 1, 0);
  gl.uniform4f(at("uMouse"), 0.5, 0.5, 0, -1e4);
  // Ink in red, the accent (the ring's default tone) in blue: each channel reads one layer.
  gl.uniform3f(at("uInk"), 1, 0, 0);
  gl.uniform3f(at("uAccent"), 0, 0, 1);
  // The planet small and centred so the whole ring system and the moons' orbits are in frame; no
  // stars, nebula or eclipse shadows, and a still ring, so knob pairs differ only by the bodies.
  const scene = {
    ...paramDefaults("orbit"),
    stars: 0,
    nebula: 0,
    planetX: 0,
    planetY: 0,
    planet: 0.35,
    eclipses: 0,
    ringSpin: 0,
  };
  const draw = (knobs: Record<string, number>, time: number, captureStamp = -1e4): Uint8Array => {
    const triggers = new Float32Array(8).fill(-1e4);
    triggers[1] = captureStamp;
    gl.uniform1fv(at("uTriggers"), triggers);
    gl.uniform1f(at("uTime"), time);
    gl.uniform1f(at("uMotionTime"), time);
    gl.uniform4fv(
      at("uParams"),
      packParams(renderSettings(defaultsFor("orbit"), { ...scene, ...knobs }).params),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
    return bytes;
  };
  const RED = 0;
  const BLUE = 2;
  const pixelsWhere = (test: (index: number) => boolean): number[] =>
    Array.from({ length: WIDTH * HEIGHT }, (_, pixel) => pixel * 4).filter(test);

  // At motion time 281 the inner moon is crossing the near side of the ring, which lies well in
  // front of it; at 222 the outer (third) moon sits over the far side, well behind it.
  const moons = (count: number) => ({
    moons: count > 0 ? 1 : 0,
    "moons-amount": Math.max(count, 1),
  });
  const NEAR = 281;
  const FAR = 222;
  const bare = draw({ ring: 0, ...moons(0) }, NEAR);
  const inner = draw({ ring: 0, ...moons(1) }, NEAR);
  const ring = draw({ ring: 1, ...moons(0) }, NEAR);
  const near = draw({ ring: 1, ...moons(1) }, NEAR);
  const bareFar = draw({ ring: 0, ...moons(0) }, FAR);
  const two = draw({ ring: 0, ...moons(2) }, FAR);
  const three = draw({ ring: 0, ...moons(3) }, FAR);
  const ringFar = draw({ ring: 1, ...moons(0) }, FAR);
  const both = draw({ ring: 1, ...moons(3) }, FAR);
  const before = pixelsWhere(
    (index) =>
      inner[index + RED] !== bare[index + RED] &&
      (ring[index + BLUE] ?? 0) >= (bare[index + BLUE] ?? 0) + 32,
  );
  const behind = pixelsWhere(
    (index) =>
      three[index + RED] !== two[index + RED] &&
      (ringFar[index + BLUE] ?? 0) >= (bareFar[index + BLUE] ?? 0) + 32,
  );
  check(
    before.length >= 3,
    `Fixture lost the inner moon behind the near ring: ${before.length} pixels`,
  );
  check(
    behind.length >= 8,
    `Fixture lost the outer moon over the far ring: ${behind.length} pixels`,
  );
  for (const index of behind) {
    check(
      [0, 1, 2].every((channel) => both[index + channel] === three[index + channel]),
      `Ring behind a moon showed over it at pixel ${index / 4}`,
    );
  }
  for (const index of before) {
    check(
      (near[index + RED] ?? 0) < (inner[index + RED] ?? 0) && (near[index + BLUE] ?? 0) > 0,
      `Moon showed through the ring in front of it at pixel ${index / 4}`,
    );
  }

  // A captured meteor started by the "now" button at scene time 112 (capture 1112 in orbitCaptured's
  // numbering), drawn at a moment of its fall when its whole trail lies behind ring material nearer
  // the eye. Its orbit crosses the ring plane, so other moments put part of the trail in front.
  const STAMP = 112;
  const sky = { ring: 0, ...moons(0) };
  const fall = captureBehindRing(
    gl,
    Float32Array.from(renderSettings(defaultsFor("orbit"), { ...scene, ...sky, ring: 1 }).params),
    1000 + STAMP,
  );
  gl.useProgram(linked);
  const quiet = draw(sky, STAMP + fall);
  const meteor = draw(sky, STAMP + fall, STAMP);
  const ringQuiet = draw({ ...sky, ring: 1 }, STAMP + fall);
  const ringMeteor = draw({ ...sky, ring: 1 }, STAMP + fall, STAMP);
  const trail = pixelsWhere(
    (index) =>
      (meteor[index + RED] ?? 0) > (quiet[index + RED] ?? 0) &&
      (ringQuiet[index + BLUE] ?? 0) >= (quiet[index + BLUE] ?? 0) + 32,
  );
  check(
    trail.length >= 6,
    `Fixture lost the captured meteor behind the ring: ${trail.length} pixels`,
  );
  for (const index of trail) {
    check(
      (ringMeteor[index + RED] ?? 0) < (meteor[index + RED] ?? 0),
      `Captured meteor showed through the ring in front of it at pixel ${index / 4}`,
    );
  }
  gl.deleteProgram(linked);
  return {
    ringBehindMoonPixels: behind.length,
    ringBeforeMoonPixels: before.length,
    ringBeforeMeteorPixels: trail.length,
    meteorFallSeconds: fall,
  };
}
