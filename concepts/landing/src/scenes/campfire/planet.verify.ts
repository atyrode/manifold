// GPU regression for the shared giant planet (shaders/lib/planet.ts, #1082 M9) and its composition in
// Campfire's sky. It runs the library's own GLSL and the real scene entry; registered in
// verify-browser.ts.
//   1. Ring geometry: the line-of-sight sample (planetRingAt), the plane coordinates of a 3D point
//      (planetRingPlane), the plane normal and the ring's shadow on the planet (planetRingShadowAt)
//      agree, for campfire's nearly edge-on ring, orbit's default and a steep one; a sign or roll
//      slip between them puts shadows and depth in the wrong place in one consumer but not the other.
//   2. Level of detail: belts that resolve are fbm bit for bit (what keeps orbit's picture
//      unchanged), a tiny planet's belts are their even mean, and a far planet's city lights merge
//      into blocks rather than single shimmering cells.
//   3. Campfire composes moons, aurora, city lights and the circling sun: each one shows, and only
//      where the planet itself shows (inside its glow, behind the pines and the ground). A moon
//      behind the planet is hidden; the same moon in front of it is drawn over the disc.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { campfireScene } from "./index.ts";

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

// Draws the full frame, or only the cells inside 'box' (x, y, width, height) with the rest cleared.
function draw(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  box?: readonly [number, number, number, number],
): Uint8Array {
  gl.canvas.width = width;
  gl.canvas.height = height;
  gl.viewport(0, 0, width, height);
  if (box) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(...box);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
  return bytes;
}

// Case 0..2: ring geometry for three rings over q in [-2.5, 2.5] x [-1.4, 1.4]; red, green, blue
// 255 where the plane coordinates, the plane and the shadow ray agree. Case 3: a planet
// regressionRadius cells in radius (foot 1 / radius) centred on a 64 x 64 frame: red its city lights,
// green its belts, blue plain fbm there. Case 4: the same planet, red 255 where its belts are fbm
// bit for bit.
const COMPONENT = `
uniform int regressionCase;
uniform float regressionRadius;
Shade regressionPlanet(vec2 uv, vec2 cell, float t) {
  if (regressionCase < 3) {
    PlanetRing ring = PlanetRing(0.20, 0.32);
    if (regressionCase == 1) ring = PlanetRing(0.606, -0.14);
    if (regressionCase == 2) ring = PlanetRing(0.97, 0.7);
    vec2 q = (uv - 0.5) * vec2(5.0, 2.8);
    vec3 at = planetRingAt(ring, q);
    vec3 point = vec3(q, at.z);
    float plane = length(planetRingPlane(ring, point) - at.xy) < 1e-3 ? 1.0 : 0.0;
    float onPlane = abs(dot(planetRingNormal(ring), point)) < 1e-3 ? 1.0 : 0.0;
    // With the sun behind the eye, the ring's shadow on the surface is the ring seen on the same
    // line of sight, and only where that ring lies in front of the surface.
    float shadow = 1.0;
    float d = length(q);
    if (d < 0.98) {
      vec3 normal = vec3(q, sqrt(1.0 - d * d));
      vec2 sh;
      bool hits = planetRingShadowAt(ring, normal, vec3(0.0, 0.0, 1.0), sh);
      bool front = at.z > normal.z;
      if (abs(at.z - normal.z) > 1e-3) shadow = hits == front && (!hits || length(sh - at.xy) < 1e-3) ? 1.0 : 0.0;
    }
    return shadeOf(vec3(plane, onPlane, shadow), 0.0, 0.0);
  }
  vec2 q = (cell - 32.0) / regressionRadius;
  float d = length(q);
  if (d >= 1.0) return shadeOf(vec3(0.0), 0.0, 0.0);
  vec3 normal = vec3(q, sqrt(1.0 - d * d));
  float lon = planetLongitude(normal, 0.3, 0.0);
  float belts = planetBelts(normal, lon, 1.0 / regressionRadius);
  float plain = fbm(vec2(lon * 3.0, normal.y * 11.0));
  if (regressionCase == 4) return shadeOf(vec3(belts == plain ? 1.0 : 0.0), 0.0, 0.0);
  return shadeOf(vec3(planetCityLights(normal, lon, t, 0.0, 1.0 / regressionRadius), belts, plain), 0.0, 0.0);
}`;

export function verifyPlanet(gl: WebGL2RenderingContext): Record<string, unknown> {
  const component = program(
    gl,
    fragmentSourceFor({
      ...campfireScene,
      entry: "regressionPlanet",
      glsl: campfireScene.glsl + COMPONENT,
    }),
  );
  gl.useProgram(component);
  const caseAt = gl.getUniformLocation(component, "regressionCase");
  gl.uniform1i(gl.getUniformLocation(component, "uView"), 1);
  gl.uniform1f(gl.getUniformLocation(component, "uMotion"), 1);
  const ringNames = ["campfire", "orbit", "steep"];
  for (const [index, name] of ringNames.entries()) {
    gl.uniform1i(caseAt, index);
    gl.uniform2f(gl.getUniformLocation(component, "uRes"), 240, 135);
    const bytes = draw(gl, 240, 135);
    const channels = ["plane coordinates", "plane", "shadow on the planet"];
    for (let pixel = 0; pixel < 240 * 135; pixel++) {
      for (const [channel, what] of channels.entries()) {
        check(
          (bytes[pixel * 4 + channel] ?? 0) === 255,
          `Planet ring geometry (${name} ring): ${what} disagree at pixel ${pixel}`,
        );
      }
    }
  }

  // Level of detail: a planet 300 cells in radius (orbit's default on a 270-row frame, its finest
  // belts 1.6 cells across) is fbm bit for bit; one 10 cells across, where even the broadest belts
  // are finer than a cell, is their even mean; one 30 cells in radius lights its night side in blocks
  // of cells, not single ones.
  gl.uniform2f(gl.getUniformLocation(component, "uRes"), 64, 64);
  gl.uniform1f(gl.getUniformLocation(component, "uTime"), 0);
  const radiusAt = gl.getUniformLocation(component, "regressionRadius");
  gl.uniform1i(caseAt, 4);
  gl.uniform1f(radiusAt, 300);
  const near = draw(gl, 64, 64);
  for (let pixel = 0; pixel < 64 * 64; pixel++) {
    check(
      (near[pixel * 4] ?? 0) === 255,
      `Resolved planet belts differ from fbm at pixel ${pixel}: level of detail touched a resolved surface`,
    );
  }
  gl.uniform1i(caseAt, 3);
  const planetOf = (radius: number) => {
    gl.uniform1f(radiusAt, radius);
    const bytes = draw(gl, 64, 64);
    const inDisc = (x: number, y: number) =>
      (x + 0.5 - 32) ** 2 + (y + 0.5 - 32) ** 2 < (radius - 1) ** 2;
    return {
      inDisc,
      at: (x: number, y: number, channel: number) => bytes[(y * 64 + x) * 4 + channel] ?? 0,
    };
  };
  const tiny = planetOf(5);
  const beltValues = new Set<number>();
  const fbmValues = new Set<number>();
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (!tiny.inDisc(x, y)) continue;
      beltValues.add(tiny.at(x, y, 1));
      fbmValues.add(tiny.at(x, y, 2));
    }
  }
  check(
    beltValues.size === 1 && fbmValues.size > 4,
    `A planet 10 cells across shows ${beltValues.size} belt levels (fbm ${fbmValues.size}): sub-cell belts should be their mean`,
  );
  const lights = planetOf(30);
  let lit = 0;
  let isolated = 0;
  for (let y = 1; y < 63; y++) {
    for (let x = 1; x < 63; x++) {
      if (!lights.inDisc(x, y) || lights.at(x, y, 0) < 128) continue;
      lit++;
      if (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].every(([dx = 0, dy = 0]) => lights.at(x + dx, y + dy, 0) < 128)
      )
        isolated++;
    }
  }
  check(lit >= 40, `A far planet lost its city lights: ${lit} lit cells`);
  check(
    isolated < 0.3 * lit,
    `A far planet's city lights shimmer as single cells: ${isolated} of ${lit} isolated`,
  );
  gl.deleteProgram(component);

  // Campfire's sky: the default planet, then each composed feature. Only the cells round the planet
  // are shaded (2.6 radii, past the 2.3 its features may reach): the rest of the scene is costly.
  const scene = program(gl, fragmentSourceFor(campfireScene));
  gl.useProgram(scene);
  const where = (name: string) => gl.getUniformLocation(scene, name);
  const WIDTH = 320;
  const HEIGHT = 180;
  const centre = {
    x: WIDTH / 2 + 0.58 * Math.min(Math.max(WIDTH / HEIGHT / 2, 0.5), 0.9) * HEIGHT,
    y: 0.57 * HEIGHT,
  };
  const radius = (0.07 + 0.13 * 0.55) * HEIGHT;
  const reach = Math.ceil(2.6 * radius);
  const box = [
    Math.floor(centre.x) - reach,
    Math.floor(centre.y) - reach,
    2 * reach,
    2 * reach,
  ] as const;
  gl.uniform2f(where("uRes"), WIDTH, HEIGHT);
  gl.uniform1i(where("uView"), 1);
  gl.uniform1f(where("uMotion"), 1);
  gl.uniform2f(where("uPassage"), 1, 0);
  gl.uniform4f(where("uMouse"), 0.5, 0.5, 0, -1e4);
  gl.uniform1fv(where("uTriggers"), new Float32Array(8).fill(-1e4));
  const render = (knobs: Record<string, number>, time: number): Uint8Array => {
    gl.uniform1f(where("uTime"), time);
    gl.uniform1f(where("uMotionTime"), time);
    gl.uniform1fv(
      where("uParams"),
      Float32Array.from(
        renderSettings(defaultsFor("campfire"), { ...paramDefaults("campfire"), ...knobs }).params,
      ),
    );
    return draw(gl, WIDTH, HEIGHT, box);
  };
  const differs = (a: Uint8Array, b: Uint8Array, pixel: number) =>
    a[pixel * 4] !== b[pixel * 4] ||
    a[pixel * 4 + 1] !== b[pixel * 4 + 1] ||
    a[pixel * 4 + 2] !== b[pixel * 4 + 2];
  const TIME = 40;
  const bare = render({ planet: 0 }, TIME);
  const plain = render({}, TIME);
  const features: Record<string, Record<string, number>> = {
    moons: { planetMoons: 1, "planetMoons-amount": 3 },
    aurora: { planetAurora: 1 },
    lights: { planetLights: 1 },
    daycycle: { planetDaycycle: 1, "planetDaycycle-amount": 1 },
  };
  const shown: Record<string, number> = {};
  for (const [name, knobs] of Object.entries(features)) {
    const picture = render(knobs, TIME);
    let changed = 0;
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      if (!differs(picture, plain, pixel)) continue;
      check(
        differs(plain, bare, pixel),
        `Campfire's planet ${name} drew outside the planet or over its foreground at pixel ${pixel}`,
      );
      changed++;
    }
    check(changed >= 10, `Campfire's planet ${name} does not show: ${changed} pixels`);
    shown[name] = changed;
  }

  // The third moon orbits edge-on through the planet's centre (campfire's ring plane, 0.032 rad/s
  // from phase 3, 1.56 radii out): at 53.5 s it crosses in front of the disc's centre, at 151.7 s
  // behind it. Eclipses off, so only the moon itself can differ between two and three moons.
  const moons = (count: number) => ({
    planetMoons: 1,
    "planetMoons-amount": count,
    planetEclipses: 0,
  });
  const changedPixels = (a: Uint8Array, b: Uint8Array, discOnly: boolean) => {
    let changed = 0;
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      const onDisc =
        Math.hypot((pixel % WIDTH) + 0.5 - centre.x, Math.floor(pixel / WIDTH) + 0.5 - centre.y) <
        radius - 1;
      if ((onDisc || !discOnly) && differs(a, b, pixel)) changed++;
    }
    return changed;
  };
  const transit = changedPixels(render(moons(3), 53.5), render(moons(2), 53.5), true);
  const hidden = changedPixels(render(moons(3), 151.7), render(moons(2), 151.7), false);
  check(
    transit >= 6,
    `A moon crossing in front of Campfire's planet was not drawn over it: ${transit} pixels`,
  );
  check(hidden === 0, `A moon behind Campfire's planet showed through it: ${hidden} pixels`);
  gl.deleteProgram(scene);
  return {
    featurePixels: shown,
    transitPixels: transit,
    farLights: { lit, isolated },
    tinyFbmLevels: fbmValues.size,
  };
}
