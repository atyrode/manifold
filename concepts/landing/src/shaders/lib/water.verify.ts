// GPU regressions for the shared water (#1082 M13: shaders/lib/water.ts and the ripple spectrum in
// surface.ts), run by concepts/landing/verify-browser.ts on real WebGL output. A probe entry compiled
// on Island's program (so it reads Island's own spectrum table) evaluates the library over grids into
// a float target: the trains and caustic waves too fine to draw are skipped without changing a value
// (each against its unskipped form), the cellular net's seams draw where they span a cell and leave
// only its mean where they do not, and the mirror, the glint and the caustic light behave. Then the
// tiers: each tier's functions exist from its tier up and not below, and each
// adopting scene compiles at the tier it selects and not one lower.
import { loadScene, type SceneId } from "../../scenes/index.ts";
import type { LoadedScene } from "../../scenes/types.ts";
import { fragmentSourceFor, vertexSource } from "../index.ts";
import { WATER_TIERS } from "./water.ts";

const islandScene = await loadScene("island");

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`water: ${message}`);
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

function compiles(gl: WebGL2RenderingContext, fragment: string): boolean {
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) throw new Error("Shader allocation failed");
  gl.shaderSource(shader, fragment);
  gl.compileShader(shader);
  const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS));
  gl.deleteShader(shader);
  return ok;
}

// uProbeA: mode 0-2 the grid's origin (m, xy), metres a cell, tm; uProbeB: mode 0-2 the depthwise
// stretch of the footprint, the knob-like gain. A row's footprint grows from 2^-9 m at the bottom to
// 2^4 m at the top, so every train goes from drawn to too fine to draw.
const PROBE = `
uniform int uProbe;
uniform vec4 uProbeA;
uniform vec4 uProbeB;

// rippleTrain and causticRipples without their skip of what is too fine to draw: what the skip must
// leave every value as.
vec3 probeTrain(vec2 p, float tm, vec2 foot, float wavelength, vec2 along, float slope, float pace, float phase, vec2 lod) {
  float k = TAU / wavelength;
  float seen = smoothstep(lod.x, lod.y, wavelength / max(length(along * foot), 1e-6));
  float ph = k * dot(along, p) - pace * sqrt(9.81 * k) * tm + phase;
  return vec3(along * cos(ph) * slope * seen, 0.5 * slope * slope * (1.0 - seen));
}

vec2 probeCaustic(vec2 p, float tm, vec2 wind, float scale, float steep, float pace, float foot, out vec3 hessian) {
  vec2 slope = vec2(0.0);
  hessian = vec3(0.0);
  float wavelength = scale;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float turn = (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) * (0.25 + 0.3 * fi);
    vec2 along = vec2(wind.x * cos(turn) - wind.y * sin(turn), wind.x * sin(turn) + wind.y * cos(turn));
    float k = TAU / wavelength;
    float seen = smoothstep(6.0, 12.0, wavelength / max(foot, 1e-6));
    float a = steep / k * seen;
    float ph = k * dot(along, p) - pace * sqrt(k) * tm + 1.7 * fi * fi + 0.4;
    slope += along * (a * k * cos(ph));
    hessian -= vec3(along.x * along.x, along.y * along.y, along.x * along.y) * (a * k * k * sin(ph));
    wavelength *= 0.77;
  }
  return slope;
}

Shade waterProbe(vec2 uv, vec2 cell, float t) {
  vec3 v = vec3(0.0);
  vec2 p = uProbeA.xy + floor(cell) * uProbeA.z;
  float tm = uProbeA.w;
  vec2 foot = exp2(mix(-9.0, 4.0, floor(cell.y) / uRes.y)) * vec2(1.0, uProbeB.x);
  if (uProbe == 1) {
    // Island's trains against the unskipped form; Lanterns' whole spectrum's slope and variance.
    float differs = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 w = ISL_RIPPLES.train[i];
      vec3 now = rippleTrain(p, tm, foot, w.x, ISL_RIPPLES.along[i], uProbeB.y * w.y, w.z, w.w, ISL_RIPPLES.lod);
      vec3 before = probeTrain(p, tm, foot, w.x, ISL_RIPPLES.along[i], uProbeB.y * w.y, w.z, w.w, ISL_RIPPLES.lod);
      if (any(notEqual(now, before))) differs = 1.0;
    }
    vec3 sum = rippleSpectrum(p, tm, foot, uProbeB.y, RippleFan(5, vec2(6.0, 0.53), vec2(0.06, 0.007), vec2(0.14, 0.1), vec2(0.0), vec3(0.5, 2.4, 0.7), 1.9, vec2(7.0, 14.0)));
    v = vec3(differs, length(sum.xy), sum.z);
  } else if (uProbe == 2) {
    // The caustic net against the unskipped form, with a square footprint of the row's size.
    vec3 h;
    vec3 h0;
    vec2 slope = causticRipples(p, tm, normalize(vec2(0.8, 0.6)), 0.075 * 64.0, 0.06, 0.32, foot.x, h);
    vec2 slope0 = probeCaustic(p, tm, normalize(vec2(0.8, 0.6)), 0.075 * 64.0, 0.06, 0.32, foot.x, h0);
    v = vec3(any(notEqual(slope, slope0)) || any(notEqual(h, h0)) ? 1.0 : 0.0, length(h), length(slope));
  } else if (uProbe == 3) {
    // The mirror on a grid of slopes (uProbeA.z a cell, zero at the middle cell) along one view ray.
    vec3 dir = normalize(uProbeB.xyz);
    WaterMirror m = waterMirror(dir, (floor(cell) - floor(0.5 * uRes)) * uProbeA.z, 0.0);
    v = vec3(m.ray.y, m.fresnel, m.normal.z);
  } else if (uProbe == 6) {
    // The cellular net, p in net cells, tm its wander: a row's footprint (2^-9 .. 2^4 net cells up
    // the rows), or uProbeB.y throughout.
    float cellFoot = uProbeB.y > 0.0 ? uProbeB.y : foot.x;
    v = vec3(causticCells(p, tm, cellFoot), cellFoot, 0.0);
  } else if (uProbe == 7) {
    // The glint over a grid of half vectors (uProbeA.z of tangent a cell, level at the middle cell),
    // the eye along uProbeB.xyz, the light mirrored about each, on water sloped uProbeA.xy with
    // variance uProbeA.w, at exposure uProbeB.w; y: the same light sunk below the horizon.
    vec2 tilt = (floor(cell) - floor(0.5 * uRes)) * uProbeA.z;
    vec3 view = normalize(uProbeB.xyz);
    vec3 light = reflect(-view, normalize(vec3(tilt.x, 1.0, tilt.y)));
    vec3 n = normalize(vec3(-uProbeA.x, 1.0, -uProbeA.y));
    v = vec3(waterGlint(n, view, light, uProbeA.w, uProbeB.w), waterGlint(n, view, vec3(light.x, -abs(light.y), light.z), uProbeA.w, uProbeB.w), light.y);
  } else if (uProbe == 8) {
    // The glint at the heart of the path on level water, the light (cell + 0.5) * uProbeA.z radians
    // up and the eye on its mirror image, variance uProbeA.w, exposure uProbeB.w; y: Smith's share
    // for that height; z: the same with the water tipped away from the eye past the view.
    float e = (floor(cell.x) + 0.5) * uProbeA.z;
    vec3 light = vec3(0.0, sin(e), cos(e));
    vec3 view = vec3(0.0, sin(e), -cos(e));
    vec3 away = vec3(0.0, cos(e + 0.1), sin(e + 0.1));
    v = vec3(waterGlint(vec3(0.0, 1.0, 0.0), view, light, uProbeA.w, uProbeB.w), waterMasking(sin(e), uProbeA.w), waterGlint(away, view, light, uProbeA.w, uProbeB.w));
  } else {
    // The caustic light: still water; no focus at all (capped); half focus; a curved surface.
    float x = floor(cell.x);
    vec3 curved = vec3(3.0, -1.0, 0.5);
    v = x < 1.0 ? vec3(waterCaustic(vec3(0.0), 0.5, 1.0, 0.2))
      : x < 2.0 ? vec3(waterCaustic(curved, 0.5, 0.0, 0.25))
      : x < 3.0 ? vec3(waterCaustic(vec3(0.0), 0.5, 0.5, 0.1))
      : vec3(waterCaustic(curved, 0.5, 0.8, 0.1), 0.8 * causticJacobian(curved, 0.125), 0.0);
  }
  return shadeOf(v, 0.0, 0.0);
}
`;

type Uniforms = Readonly<Record<string, readonly number[]>>;

/** Draws `linked` at width x height into a float target and returns RGBA floats, rows bottom up. */
function draw(
  gl: WebGL2RenderingContext,
  linked: WebGLProgram,
  width: number,
  height: number,
  uniforms: Uniforms,
): Float32Array {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  check(
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
    "float target incomplete",
  );
  gl.useProgram(linked);
  gl.viewport(0, 0, width, height);
  const all: Uniforms = {
    uRes: [width, height],
    uView: [1],
    uPassage: [1, 0],
    uTriggers: Array.from({ length: 8 }, () => -1e4),
    ...uniforms,
  };
  for (const [name, value] of Object.entries(all)) {
    const at = gl.getUniformLocation(linked, name);
    if (at === null) continue;
    if (name === "uProbe" || name === "uView") gl.uniform1i(at, value[0] ?? 0);
    else if (name === "uTriggers") gl.uniform1fv(at, Float32Array.from(value));
    else if (value.length === 2) gl.uniform2fv(at, value);
    else gl.uniform4fv(at, value);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return out;
}

const at = (pixels: Float32Array, width: number, x: number, y: number, c: number): number =>
  pixels[(y * width + x) * 4 + c] ?? Number.NaN;

type Vec3 = readonly [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** A scene whose entry only calls `call`, compiled with `features`. */
function gate(base: LoadedScene, call: string, features: Readonly<Record<string, number>>): string {
  return fragmentSourceFor({
    ...base,
    features,
    entry: "waterGate",
    glsl: `Shade waterGate(vec2 uv, vec2 cell, float t) {\n  ${call};\n  return blankShade();\n}\n`,
  });
}

export async function verifyWaterTiers(
  gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const island = islandScene;
  const probe = program(
    gl,
    fragmentSourceFor({
      ...island,
      features: { WATER_TIER: WATER_TIERS.caustics },
      entry: "waterProbe",
      glsl: island.glsl + PROBE,
    }),
  );
  const W = 48;
  const H = 64;

  // Projected size: a skipped train is exactly the unskipped one; the finest footprints draw
  // slopes, the coarsest only the variance of all five trains.
  const gain = 1.2;
  const lod = draw(gl, probe, W, H, {
    uProbe: [1],
    uProbeA: [2.1, -4.4, 0.29, 47.25],
    uProbeB: [5, gain, 0, 0],
  });
  const variance = [0, 1, 2, 3, 4].reduce(
    (sum, i) => sum + 0.5 * (gain * (0.06 - 0.007 * i)) ** 2,
    0,
  );
  let drawn = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      check(at(lod, W, x, y, 0) === 0, `rippleTrain's skip changed a train at (${x}, ${y})`);
      if (y < 4 && at(lod, W, x, y, 1) > 0) drawn++;
      if (y >= H - 4) {
        check(at(lod, W, x, y, 1) === 0, `a far cell (${x}, ${y}) still draws ripple slopes`);
        check(
          Math.abs(at(lod, W, x, y, 2) - variance) <= 1e-6 * variance,
          `a far cell's variance ${at(lod, W, x, y, 2)} is not the five trains' ${variance}`,
        );
      }
    }
  }
  check(drawn >= 3 * W, `near cells barely draw ripples: ${drawn}`);
  const caustic = draw(gl, probe, W, H, {
    uProbe: [2],
    uProbeA: [0.5, 1.5, 0.21, 12.5],
    uProbeB: [1, 0, 0, 0],
  });
  let curved = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      check(at(caustic, W, x, y, 0) === 0, `causticRipples' skip changed the net at (${x}, ${y})`);
      if (y < 4 && at(caustic, W, x, y, 1) > 0) curved++;
      if (y >= H - 4)
        check(
          at(caustic, W, x, y, 1) === 0 && at(caustic, W, x, y, 2) === 0,
          `a far cell (${x}, ${y}) still draws the caustic net`,
        );
    }
  }
  check(curved >= 3 * W, `near cells barely draw the caustic net: ${curved}`);

  // The mirror: level water mirrors the view ray; a facet tipped toward the eye (dh/dz > 0) throws
  // it higher and is seen more head-on, so it reflects less.
  const M = 33;
  const dir = [0.1, -0.2, 1];
  const len = Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0);
  const mirror = draw(gl, probe, M, M, {
    uProbe: [3],
    uProbeA: [0, 0, 0.01, 0],
    uProbeB: [...dir, 0],
  });
  const mid = (M - 1) / 2;
  check(
    Math.abs(at(mirror, M, mid, mid, 0) - 0.2 / len) < 1e-6,
    `level water's reflected ray rises ${at(mirror, M, mid, mid, 0)}, not ${0.2 / len}`,
  );
  check(
    Math.abs(at(mirror, M, mid, mid, 1) - (0.02 + 0.98 * (1 - 0.2 / len) ** 5)) < 1e-5,
    `level water's Fresnel ${at(mirror, M, mid, mid, 1)}`,
  );
  for (let y = 1; y < M; y++) {
    check(
      at(mirror, M, mid, y, 0) > at(mirror, M, mid, y - 1, 0),
      `a facet tipped toward the eye does not throw the ray higher (row ${y})`,
    );
    check(
      at(mirror, M, mid, y, 1) < at(mirror, M, mid, y - 1, 1),
      `a facet tipped toward the eye reflects as much or more (row ${y})`,
    );
  }
  check(
    at(mirror, M, mid, M - 1, 2) < 0,
    "a facet rising away from the eye does not lean toward it",
  );

  // The glint (waterGlint), over the half vector's tangent plane, read back as radiance (the
  // exposure's saturation undone) and divided by its geometry (Fresnel on the facet, Smith's share
  // seen and lit, 1 / (4 (n.v) (n.h)^4)): what is left is the facets' slope density, which on level
  // water peaks at 1 / (pi s2) where the half vector is the normal, holds 1 and spreads over exactly
  // the variance it is given, so a sea four times as rough lays a path twice as wide and a quarter
  // as bright at its heart. Tilting the water moves the heart onto its normal (the tangent plane,
  // laid about the vertical, warps the lobe a little there); a light below the horizon lays none.
  const masking = (c: number, s2: number): number => {
    if (c <= 0) return 0;
    const a = c / Math.sqrt(s2 * Math.max(1 - c * c, 1e-6));
    return a < 1.6 ? (3.535 * a + 2.181 * a * a) / (1 + 2.276 * a + 2.577 * a * a) : 1;
  };
  /** F(v.h) G(v) G(l) / (4 (n.v) (n.h)^4) for unit view, light and normal. */
  const geometry = (view: Vec3, light: Vec3, n: Vec3, s2: number): number => {
    const half = unit([view[0] + light[0], view[1] + light[1], view[2] + light[2]]);
    const nv = dot(n, view);
    const c = dot(n, half);
    const fresnel = 0.02 + 0.98 * (1 - dot(view, half)) ** 5;
    return (fresnel * masking(nv, s2) * masking(dot(n, light), s2)) / (4 * nv * c ** 4);
  };
  const G = 65;
  const gmid = (G - 1) / 2;
  const eye = unit([0, 1, -0.25]);
  const glint: { s2: number; area: number; spread: number }[] = [];
  for (const [s2, slopeX, slopeZ] of [
    [0.002, 0, 0],
    [0.008, 0, 0],
    [0.032, 0, 0],
    [0.008, 0.1, -0.05],
  ] as const) {
    const cell = (3.2 * Math.sqrt(s2)) / gmid;
    const n = unit([-slopeX, 1, -slopeZ]);
    const lightAt = (x: number, y: number): Vec3 => {
      const h = unit([(x - gmid) * cell, 1, (y - gmid) * cell]);
      const k = 2 * dot(h, eye);
      return [k * h[0] - eye[0], k * h[1] - eye[1], k * h[2] - eye[2]];
    };
    // An exposure that lays 1 - 1/e at the heart: far from saturating the tails' rounding away.
    const exposure = (Math.PI * s2) / geometry(eye, lightAt(gmid, gmid), n, s2);
    const lobe = draw(gl, probe, G, G, {
      uProbe: [7],
      uProbeA: [slopeX, slopeZ, cell, s2],
      uProbeB: [...eye, exposure],
    });
    let sum = 0;
    let mx = 0;
    let mz = 0;
    let second = 0;
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const value = at(lobe, G, x, y, 0);
        check(at(lobe, G, x, y, 2) > 0, "the glint probe's light dipped below the horizon");
        check(value >= 0 && value < 1, `the glint leaves 0..1: ${value}`);
        check(
          at(lobe, G, x, y, 1) === 0,
          `a light below the horizon glints ${at(lobe, G, x, y, 1)}`,
        );
        const density = -Math.log1p(-value) / exposure / geometry(eye, lightAt(x, y), n, s2);
        const tx = (x - gmid) * cell;
        const tz = (y - gmid) * cell;
        sum += density;
        mx += density * tx;
        mz += density * tz;
        second += density * (tx * tx + tz * tz);
      }
    }
    const centre = [mx / sum, mz / sum] as const;
    const sigma = Math.sqrt(s2);
    check(
      Math.abs(centre[0] + slopeX) < 0.05 * sigma && Math.abs(centre[1] + slopeZ) < 0.05 * sigma,
      `the glint's heart lies at ${centre.join(", ")}, not on the normal of slope ${slopeX}, ${slopeZ}`,
    );
    if (slopeX !== 0 || slopeZ !== 0) continue;
    const area = sum * cell * cell;
    const spread = second / sum - centre[0] ** 2 - centre[1] ** 2;
    const heart = at(lobe, G, gmid, gmid, 0);
    check(
      Math.abs(heart - (1 - Math.exp(-1))) < 1e-4,
      `the glint's heart is ${heart}, not 1 - 1/e: its density there is not 1 / (pi s2)`,
    );
    check(Math.abs(area - 1) < 0.01, `the facets' slope density holds ${area}, not 1 (s2 ${s2})`);
    check(
      Math.abs(spread / s2 - 1) < 0.01,
      `the glint spreads over ${spread}, not its variance ${s2}`,
    );
    glint.push({ s2, area: Number(area.toFixed(6)), spread: Number(spread.toFixed(6)) });
  }

  // Down the heart of the path against the light's height (level water, variance 0.01): the
  // radiance is Fresnel times Smith's share seen and lit over (4 pi s2 sin e), so a light low over
  // the water lays a brighter heart than a high one, finite even skimming the horizon; water
  // tipped away from the eye shows none, and the brightest exposure never passes 1.
  const HEIGHTS = 32;
  const step = Math.fround(1.4 / HEIGHTS);
  const heights = draw(gl, probe, HEIGHTS, 1, {
    uProbe: [8],
    uProbeA: [0, 0, step, 0.01],
    uProbeB: [0, 0, 0, 0.01],
  });
  let previous = Infinity;
  for (let x = 0; x < HEIGHTS; x++) {
    const e = Math.fround(Math.fround(x + 0.5) * step);
    const s = Math.sin(e);
    const shown = masking(s, 0.01);
    // Relative, as the radiance below: near grazing the share is steep in e, and float32 shows it.
    check(
      Math.abs(at(heights, HEIGHTS, x, 0, 1) / shown - 1) < 1e-3,
      `Smith's share at ${e} rad is ${at(heights, HEIGHTS, x, 0, 1)}, not ${shown}`,
    );
    const radiance = -Math.log1p(-at(heights, HEIGHTS, x, 0, 0)) / 0.01;
    const expected = ((0.02 + 0.98 * (1 - s) ** 5) * shown * shown) / (4 * Math.PI * 0.01 * s);
    check(
      Math.abs(radiance / expected - 1) < 1e-3,
      `the path's heart with the light ${e} rad up is ${radiance}, not ${expected}`,
    );
    check(radiance < previous, `a light ${e} rad up lays a heart as bright as a lower one's`);
    previous = radiance;
    check(at(heights, HEIGHTS, x, 0, 2) === 0, `water tipped away from the eye glints ${e} rad up`);
  }
  const blinding = draw(gl, probe, HEIGHTS, 1, {
    uProbe: [8],
    uProbeA: [0, 0, step, 0.01],
    uProbeB: [0, 0, 0, 1e6],
  });
  for (let x = 0; x < HEIGHTS; x++)
    check(at(blinding, HEIGHTS, x, 0, 0) <= 1, `a blinding light's glint passes 1 at ${x}`);

  // The caustic light: still water is 1, a sim focusing nothing is capped at 1 / soft, and the two
  // Jacobians multiply.
  const light = draw(gl, probe, 4, 1, { uProbe: [5] });
  check(at(light, 4, 0, 0, 0) === 1, `still water's caustic light is ${at(light, 4, 0, 0, 0)}`);
  check(
    at(light, 4, 1, 0, 0) === 4,
    `an unfocused sim's caustic light is ${at(light, 4, 1, 0, 0)}, not capped at 4`,
  );
  check(at(light, 4, 2, 0, 0) === 2, `half the sim's focus gives ${at(light, 4, 2, 0, 0)}, not 2`);
  check(
    Math.abs(at(light, 4, 3, 0, 0) - 1 / Math.max(Math.abs(at(light, 4, 3, 0, 1)), 0.1)) < 1e-6,
    "the caustic light is not the two Jacobians' product",
  );

  // The cellular net: where its seams span a cell or more they draw, within the net's range; under
  // half a cell only the net's mean (CAUSTIC_CELLS_MEAN, as float32), and between a mix.
  const netMean = Math.fround(0.078);
  let seams = 0;
  for (const tm of [3.7, 211.9]) {
    const net = draw(gl, probe, W, H, {
      uProbe: [6],
      uProbeA: [-11.3, 4.9, 0.137, tm],
      uProbeB: [1, 0, 0, 0],
    });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const value = at(net, W, x, y, 0);
        const cellFoot = at(net, W, x, y, 1);
        if (cellFoot >= 0.12) {
          check(
            value === netMean,
            `a far cell (${x}, ${y}) is ${value}, not the net's mean ${netMean}`,
          );
        } else {
          check(
            value >= 0 && value <= 1,
            `a near or fading cell (${x}, ${y}) leaves the net's range: ${value}`,
          );
          if (cellFoot <= 0.06 && value > 0) seams++;
        }
      }
    }
  }
  check(seams >= W, `near cells barely draw the net's seams: ${seams}`);
  // Its mean is the resolved net's: averaged over a wide grid at two moments.
  let sum = 0;
  for (const tm of [57.3, 1203.1]) {
    const wide = draw(gl, probe, 64, 64, {
      uProbe: [6],
      uProbeA: [3.1, -7.7, 0.613, tm],
      uProbeB: [1, 0.001, 0, 0],
    });
    for (let i = 0; i < 64 * 64; i++) sum += wide[i * 4] ?? Number.NaN;
  }
  const netAverage = sum / (2 * 64 * 64);
  check(
    Math.abs(netAverage - netMean) < 0.25 * netMean,
    `the net averages ${netAverage}, far from its mean ${netMean}`,
  );
  gl.deleteProgram(probe);

  // The tiers: each tier's functions exist from that tier up and not below it; rippleSpectrum and
  // rippleTrain belong to every program.
  const calls: readonly [keyof typeof WATER_TIERS, string][] = [
    ["ripples", "vec4 r = windRipples(planeAt(uv, 1.0, 0.6, 1.7, 1.2), t, 0.5, 1.0)"],
    ["mirror", "WaterMirror m = waterMirror(vec3(0.0, -0.3, 1.0), vec2(0.0), 0.0)"],
    [
      "mirror",
      "float g = waterGlint(vec3(0.0, 1.0, 0.0), vec3(0.0, 0.3, -1.0), vec3(0.0, 0.3, 1.0), 0.01, 1.0)",
    ],
    ["flow", "vec2 f = waterDrift(uv, vec2(1.0, 0.0), t)"],
    [
      "caustics",
      "vec3 h; vec2 s = causticRipples(uv, t, vec2(1.0, 0.0), 0.1, 0.05, 0.3, 0.001, h)",
    ],
    ["caustics", "float c = causticCells(uv * 4.0, t, 0.001)"],
  ];
  for (const [tier, call] of calls) {
    const level = WATER_TIERS[tier];
    check(
      compiles(gl, gate(island, call, { WATER_TIER: level })),
      `${tier} functions missing at their own tier`,
    );
    check(
      compiles(gl, gate(island, call, { WATER_TIER: WATER_TIERS.caustics })),
      `${tier} functions missing at the top tier`,
    );
    check(
      !compiles(gl, gate(island, call, { WATER_TIER: level - 1 })),
      `${tier} functions present a tier below`,
    );
    check(!compiles(gl, gate(island, call, {})), `${tier} functions present without WATER_TIER`);
  }
  const spectrum =
    "vec3 r = rippleSpectrum(uv, t, vec2(0.01), 1.0, RippleFan(3, vec2(2.0, 0.5), vec2(0.03, 0.0), vec2(1.0, 0.0), vec2(0.0, 2.4), vec3(0.0), 1.0, vec2(7.0, 14.0)))";
  check(compiles(gl, gate(island, spectrum, {})), "rippleSpectrum missing without WATER_TIER");

  // The adopters: each compiles at the tier it selects, and needs it (one tier lower fails).
  const adopters: readonly [SceneId, keyof typeof WATER_TIERS][] = [
    ["island", "mirror"],
    ["shore", "mirror"],
    ["swell", "mirror"],
    ["lake", "mirror"],
    ["lanterns", "flow"],
    ["tidepool", "caustics"],
    ["pond", "caustics"],
  ];
  for (const [id, tier] of adopters) {
    const def = await loadScene(id);
    check(
      def.features?.["WATER_TIER"] === WATER_TIERS[tier],
      `${id} does not select the ${tier} tier`,
    );
    check(compiles(gl, fragmentSourceFor(def)), `${id} does not compile at its tier`);
    check(
      !compiles(
        gl,
        fragmentSourceFor({
          ...def,
          features: { ...def.features, WATER_TIER: WATER_TIERS[tier] - 1 },
        }),
      ),
      `${id} compiles a tier lower: it does not use the ${tier} tier`,
    );
  }
  return {
    nearRippleCells: drawn,
    nearCausticCells: curved,
    netSeamCells: seams,
    netAverage: Number(netAverage.toFixed(4)),
    glint,
  };
}
