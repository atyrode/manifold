// GPU regressions for the shared water (#1082 M13: shaders/lib/water.ts and the ripple spectrum in
// surface.ts), run by concepts/landing/verify-browser.ts on real WebGL output. A probe entry compiled
// on Island's program (so it reads Island's own spectrum table) evaluates the library over grids into
// a float target: the spectra the three open-water scenes draw are bit for bit the sums they drew
// before they shared rippleSpectrum, the pond's caustics are bit for bit the layer it drew before it
// shared the cellular net, the trains, caustic waves and net seams too fine to draw are skipped
// without changing a value (or leave only the net's mean), and the mirror, the flow and the caustic
// light behave. Then the tiers: each tier's functions exist from its tier up and not below, and each
// adopting scene compiles at the tier it selects and not one lower.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { sceneDefs } from "../index.ts";
import type { SceneDef } from "../types.ts";

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
// stretch of the footprint, the knob-like gain, the current (m/s). A row's footprint grows from 2^-9
// m at the bottom to 2^4 m at the top, so every train goes from drawn to too fine to draw.
const PROBE = `
uniform int uProbe;
uniform vec4 uProbeA;
uniform vec4 uProbeB;

// The sums as Island, Lanterns and Shore wrote them before rippleSpectrum.
vec3 probeIsland(vec2 p, float tm, vec2 foot) {
  return rippleTrain(p, tm, foot, 4.0, normalize(vec2(0.25, 1.0)), 0.03, 0.35, 1.0, vec2(7.0, 14.0))
       + rippleTrain(p, tm, foot, 1.5, normalize(vec2(1.0, 0.35)), 0.035, 0.35, 0.0, vec2(7.0, 14.0))
       + rippleTrain(p, tm, foot, 0.9, normalize(vec2(-0.5, 1.0)), 0.03, 0.35, 2.0, vec2(7.0, 14.0))
       + rippleTrain(p, tm, foot, 0.55, normalize(vec2(0.7, -0.7)), 0.025, 0.35, 4.0, vec2(7.0, 14.0));
}

vec3 probeLanterns(vec2 p, float tm, vec2 foot, float amp, float drift) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float turn = 0.5 * sin(fi * 2.4 + 0.7);
    sum += rippleTrain(p + vec2(drift, 0.0), tm, foot, 6.0 * pow(0.53, fi), vec2(sin(turn), cos(turn)), amp * (0.06 - 0.007 * fi), 0.14 * (1.0 - 0.1 * fi), fi * 1.9, vec2(7.0, 14.0));
  }
  return sum;
}

vec3 probeShore(vec2 p, float tm, vec2 foot, float wind) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float a = 1.7 + fi * 2.4;
    sum += rippleTrain(p, tm, foot, 3.2 * pow(0.55, fi), vec2(sin(a), cos(a)), (0.025 - 0.003 * fi) * wind, 1.0, fi * 1.7, vec2(8.0, 16.0));
  }
  return sum;
}

// rippleTrain and causticRipples as written before they skipped what is too fine to draw.
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

// The pond's caustic layer as it wrote it before the shared cellular net.
float probeCells(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.1));
      o = 0.5 + 0.45 * sin(t + TAU * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return 1.0 - smoothstep(0.0, 0.06, f2 - f1);
}

float probePattern(vec2 q) {
  return sin(3.0 * q.x + 2.0 * q.y);
}

Shade waterProbe(vec2 uv, vec2 cell, float t) {
  vec3 v = vec3(0.0);
  vec2 p = uProbeA.xy + floor(cell) * uProbeA.z;
  float tm = uProbeA.w;
  vec2 foot = exp2(mix(-9.0, 4.0, floor(cell.y) / uRes.y)) * vec2(1.0, uProbeB.x);
  if (uProbe == 0) {
    // As the scenes call it now: Island's table, Lanterns' fan riding its current, Shore's fan.
    float current = uProbeB.z;
    vec3 island = rippleSpectrum(p, tm, foot, 1.0, ISL_RIPPLES);
    vec3 lanterns = rippleSpectrum(waterDrift(p, vec2(-0.6 * current, 0.0), tm), tm, foot, uProbeB.y,
                                   RippleFan(5, vec2(6.0, 0.53), vec2(0.06, 0.007), vec2(0.14, 0.1), vec2(0.0), vec3(0.5, 2.4, 0.7), 1.9, vec2(7.0, 14.0)));
    vec3 shore = rippleSpectrum(p, tm, foot, uProbeB.y,
                                RippleFan(4, vec2(3.2, 0.55), vec2(0.025, 0.003), vec2(1.0, 0.0), vec2(1.7, 2.4), vec3(0.0), 1.7, vec2(8.0, 16.0)));
    v = vec3(any(notEqual(island, probeIsland(p, tm, foot))) ? 1.0 : 0.0,
             any(notEqual(lanterns, probeLanterns(p, tm, foot, uProbeB.y, 0.6 * current * tm))) ? 1.0 : 0.0,
             any(notEqual(shore, probeShore(p, tm, foot, uProbeB.y))) ? 1.0 : 0.0);
  } else if (uProbe == 1) {
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
  } else if (uProbe == 4) {
    // A pattern carried by waterFlow: x is time (uProbeA.x + x * uProbeA.y), y the start along x.
    float time = uProbeA.x + floor(cell.x) * uProbeA.y;
    vec2 at = vec2(floor(cell.y) * 0.1, 0.3);
    float weight;
    vec4 q = waterFlow(at, uProbeB.xy, time, uProbeB.z, weight);
    v = vec3(mix(probePattern(q.xy), probePattern(q.zw), weight), weight, max(length(q.xy - at), length(q.zw - at)));
  } else if (uProbe == 6) {
    // The cellular net against the pond's former layer, p in net cells, tm its wander: a row's
    // footprint (2^-9 .. 2^4 net cells up the rows), or uProbeB.y throughout.
    float cellFoot = uProbeB.y > 0.0 ? uProbeB.y : foot.x;
    float net = causticCells(p, tm, cellFoot);
    v = vec3(net != probeCells(p, tm) ? 1.0 : 0.0, net, cellFoot);
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

/** A scene whose entry only calls `call`, compiled with `features`. */
function gate(base: SceneDef, call: string, features: Readonly<Record<string, number>>): string {
  return fragmentSourceFor({
    ...base,
    features,
    entry: "waterGate",
    glsl: `Shade waterGate(vec2 uv, vec2 cell, float t) {\n  ${call};\n  return blankShade();\n}\n`,
  });
}

export function verifyWaterTiers(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const island = sceneDefs.island;
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

  // The three spectra, bit for bit, over footprints from fine to far too coarse, on the default and
  // the strongest knobs, along and across the depth, early and late on the clock.
  let spectra = 0;
  for (const [stretch, gain, current, tm] of [
    [1, 0.45, 0.17, 0],
    [12, 1.6, 0.45, 61.7],
    [40, 0.6, 0.05, 333.3],
    [3, 1.5, 0.3, 4096.5],
  ] as const) {
    const pixels = draw(gl, probe, W, H, {
      uProbe: [0],
      uProbeA: [-7.3, 3.1, 0.37, tm],
      uProbeB: [stretch, gain, current, 0],
    });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        check(
          at(pixels, W, x, y, 0) === 0,
          `Island's spectrum differs from its four trains at (${x}, ${y}), stretch ${stretch}`,
        );
        check(
          at(pixels, W, x, y, 1) === 0,
          `Lanterns' spectrum differs from its former sum at (${x}, ${y}), stretch ${stretch}`,
        );
        check(
          at(pixels, W, x, y, 2) === 0,
          `Shore's spectrum differs from its former sum at (${x}, ${y}), stretch ${stretch}`,
        );
        spectra++;
      }
    }
  }

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

  // The flow: no current carries nothing; on a current the mix is continuous through every reset
  // (a single copy jumps by the current times the period), and the copy being put back is hidden.
  const T = 256;
  const step = 4 / T;
  const still = draw(gl, probe, T, 8, {
    uProbe: [4],
    uProbeA: [0.5, step, 0, 0],
    uProbeB: [0, 0, 2, 0],
  });
  for (let i = 0; i < T * 8; i++)
    check(still[i * 4 + 2] === 0, "waterFlow moved a pattern on still water");
  const flow = draw(gl, probe, T, 8, {
    uProbe: [4],
    uProbeA: [0, step, 0, 0],
    uProbeB: [0.6, 0.2, 2, 0],
  });
  let largest = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 1; x < T; x++)
      largest = Math.max(largest, Math.abs(at(flow, T, x, y, 0) - at(flow, T, x - 1, y, 0)));
    for (let x = 0; x < T; x++) {
      const time = x * step;
      if (Number.isInteger(time / 2))
        check(
          at(flow, T, x, y, 1) === 1,
          `the copy being put back at ${time} s still shows (weight ${at(flow, T, x, y, 1)})`,
        );
    }
  }
  check(largest < 0.1, `the carried pattern jumps by ${largest} between samples ${step} s apart`);

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

  // The cellular net: where its seams span a cell or more, the pond's former layer bit for bit;
  // under half a cell only the net's mean (CAUSTIC_CELLS_MEAN, as float32), and between a mix.
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
        const cellFoot = at(net, W, x, y, 2);
        const value = at(net, W, x, y, 1);
        if (cellFoot <= 0.06) {
          check(
            at(net, W, x, y, 0) === 0,
            `causticCells differs from the pond's former layer at (${x}, ${y}), ${tm} s`,
          );
          if (value > 0) seams++;
        } else if (cellFoot >= 0.12) {
          check(
            value === netMean,
            `a far cell (${x}, ${y}) is ${value}, not the net's mean ${netMean}`,
          );
        } else {
          check(
            value >= 0 && value <= 1,
            `a fading cell (${x}, ${y}) leaves the net's range: ${value}`,
          );
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
    for (let i = 0; i < 64 * 64; i++) sum += wide[i * 4 + 1] ?? Number.NaN;
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
    ["flow", "float w; vec4 f = waterFlow(uv, vec2(1.0, 0.0), t, 2.0, w)"],
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
  const adopters: readonly [keyof typeof sceneDefs, keyof typeof WATER_TIERS][] = [
    ["aurora", "ripples"],
    ["island", "mirror"],
    ["shore", "mirror"],
    ["lanterns", "flow"],
    ["tidepool", "caustics"],
    ["pond", "caustics"],
  ];
  for (const [id, tier] of adopters) {
    const def = sceneDefs[id];
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
    spectraCells: spectra,
    nearRippleCells: drawn,
    nearCausticCells: curved,
    netSeamCells: seams,
    netAverage: Number(netAverage.toFixed(4)),
    flowLargestStep: Number(largest.toFixed(4)),
  };
}
