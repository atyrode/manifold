// GPU regressions for the shared canopy weather (shaders/lib/canopy.ts: bamboo and forest), run by
// concepts/landing/verify-browser.ts on real WebGL output. A probe entry compiled with Forest's knobs
// evaluates the library functions into a small float target, one case per pixel.
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`canopy: ${message}`);
}

function program(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)), gl.getShaderInfoLog(shader) ?? "compile failed");
    return shader;
  });
  const linked = gl.createProgram();
  for (const shader of shaders) gl.attachShader(linked, shader);
  gl.linkProgram(linked);
  check(Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)), gl.getProgramInfoLog(linked) ?? "link failed");
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

// uProbeA: (time of day, rain, slant for the ray sources, 0). Probe 0, one value per pixel: the weather
// (overcast, cloud, slant), its sun, moon and ambient light, (keySide, 0); then the clear sky's sun,
// ambient light and moon colour, the sun's and the moon's directions. Probe 1: canopyGap along a row,
// p = (uProbeB.z + x * uProbeB.w, uProbeB.y), wind uProbeB.x, ray sources uProbeC.xyz. Probe 2:
// canopyRaySources(uProbeC.xyz, spread uProbeB.x, seed uProbeB.y, aspect uProbeB.z, tm uProbeB.w,
// slant uProbeA.z). Probe 3: canopyGapSky over a patch of sky centred on (bearing, elevation)
// uProbeC.xy, 0.004 rad a pixel, washed grey uProbeB.z, stars uProbeB.x, deck uProbeB.y.
const PROBE = `
uniform int uProbe;
uniform vec4 uProbeA;
uniform vec4 uProbeB;
uniform vec4 uProbeC;

Shade canopyProbe(vec2 uv, vec2 cell, float t) {
  int x = int(floor(cell.x));
  Sky clear = skyAt(uProbeA.x);
  CanopyWeather w = canopyWeather(clear, uProbeA.y);
  vec3 v = vec3(0.0);
  if (uProbe == 0) {
    vec3 cases[10] = vec3[10](
      vec3(w.overcast, w.cloud, w.slant), w.sky.sunColor, w.sky.moonColor, w.sky.ambient, vec3(w.keySide, 0.0),
      clear.sunColor, clear.ambient, clear.moonColor, clear.sun, clear.moon
    );
    v = cases[min(x, 9)];
  } else if (uProbe == 1) {
    v = vec3(canopyGap(vec2(uProbeB.z + float(x) * uProbeB.w, uProbeB.y), uProbeB.x, 3.0, uProbeC.xyz), 0.0, 0.0);
  } else if (uProbe == 2) {
    v = canopyRaySources(uProbeC.xyz, uProbeB.x, uProbeB.y, uProbeB.z, uProbeB.w, uProbeA.z);
  } else {
    vec2 a = (cell - 0.5 * uRes) * 0.004 + uProbeC.xy;
    vec3 dir = vec3(sin(a.x) * cos(a.y), sin(a.y), cos(a.x) * cos(a.y));
    v = canopyGapSky(w, vec3(uProbeB.z), dir, uProbeB.x, vec2(cell.x * 0.01 - 0.3, 0.9), 0.0, 3.0, uProbeB.y);
  }
  Shade o = blankShade();
  o.source = v;
  return o;
}
`;

type Uniforms = Readonly<Record<string, readonly number[]>>;

/** Draws `linked` at width x height into a float target and returns RGBA floats, rows bottom up. */
function draw(gl: WebGL2RenderingContext, linked: WebGLProgram, width: number, height: number, uniforms: Uniforms): Float32Array {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  // Unbound, so no uSim sampler (all on unit 0) reads the target it renders into.
  gl.bindTexture(gl.TEXTURE_2D, null);
  check(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, "float target incomplete");
  gl.useProgram(linked);
  gl.viewport(0, 0, width, height);
  const all: Uniforms = { uRes: [width, height], uView: [1], uTime: [40], uMotion: [0.6], uMotionTime: [24], uPassage: [1, 0], uBg: [0.03, 0.03, 0.05], ...uniforms };
  for (const [name, value] of Object.entries(all)) {
    const at = gl.getUniformLocation(linked, name);
    if (at === null) continue;
    if (name === "uProbe" || name === "uView") gl.uniform1i(at, value[0] ?? 0);
    else if (value.length === 1) gl.uniform1f(at, value[0] ?? 0);
    else if (value.length === 2) gl.uniform2fv(at, value);
    else if (value.length === 3) gl.uniform3fv(at, value);
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

type Vec3 = readonly [number, number, number];
const LUMA: Vec3 = [0.299, 0.587, 0.114];
const lum = (c: Vec3): number => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));

interface Weather { overcast: number; cloud: number; slant: number; sun: Vec3; moon: Vec3; ambient: Vec3; keySide: [number, number]; clearSun: Vec3; clearAmbient: Vec3; clearMoon: Vec3; sunDir: Vec3; moonDir: Vec3 }

export function verifyCanopy(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const probe = program(gl, fragmentSourceFor({ ...sceneDefs.forest, entry: "canopyProbe", glsl: PROBE }));
  const weather = (tod: number, rain: number): Weather => {
    const out = draw(gl, probe, 10, 1, { uProbe: [0], uProbeA: [tod, rain, 0, 0] });
    const at = (i: number): Vec3 => [out[i * 4] ?? Number.NaN, out[i * 4 + 1] ?? Number.NaN, out[i * 4 + 2] ?? Number.NaN];
    const head = at(0);
    const side = at(4);
    return { overcast: head[0], cloud: head[1], slant: head[2], sun: at(1), moon: at(2), ambient: at(3), keySide: [side[0], side[1]], clearSun: at(5), clearAmbient: at(6), clearMoon: at(7), sunDir: at(8), moonDir: at(9) };
  };
  const result: Record<string, unknown> = {};

  // Dry: the clock's sky as it is. A morning sun stands to the right: the key comes from its side and
  // the shafts fall toward -x (slant > 0).
  const morning = weather(0.32, 0);
  check(morning.overcast === 0, `dry sky overcast ${morning.overcast}`);
  check(morning.sun.every((c, i) => c === morning.clearSun[i]) && morning.ambient.every((c, i) => c === morning.clearAmbient[i]), "a dry sky's light changed");
  const sunSide = Math.hypot(morning.sunDir[0], morning.sunDir[2]);
  check(near(Math.hypot(...morning.keySide), 1, 1e-5), `key side not a unit vector: ${morning.keySide.join(", ")}`);
  check((morning.keySide[0] * morning.sunDir[0] + morning.keySide[1] * morning.sunDir[2]) / sunSide > 0.999, "the key does not come from the sun's side by day");
  check(morning.sunDir[0] > 0 && morning.slant > 0 && morning.slant <= Math.fround(0.85), `a morning sun's shafts slant ${morning.slant}`);
  const midnight = weather(0.0, 0);
  const moonSide = Math.hypot(midnight.moonDir[0], midnight.moonDir[2]);
  check((midnight.keySide[0] * midnight.moonDir[0] + midnight.keySide[1] * midnight.moonDir[2]) / moonSide > 0.999, "the key does not come from the moon's side at night");

  // Rain, by day and by night: the cloud closes from a quarter of the knob up, sun and moon gone, the
  // light the deck's grey; the deck takes its brightness from the clear sky (ambient + 0.3 sun),
  // dimming in the heaviest rain.
  check(midnight.clearMoon.some((c) => c > 0), "no moonlight at midnight to test the rain against");
  for (const tod of [0.5, 0.0]) {
    for (const rain of [0.25, 0.5, 1]) {
      const w = weather(tod, rain);
      check(w.overcast === 1, `rain ${rain}: overcast ${w.overcast}`);
      check([...w.sun, ...w.moon].every((c) => c === 0), `rain ${rain} at ${tod}: the sun or moon still shines`);
      const cloud = (lum(w.clearAmbient) + 0.3 * lum(w.clearSun)) * (1 - 0.3 * rain * rain);
      check(near(w.cloud, cloud, 1e-4), `rain ${rain} at ${tod}: deck brightness ${w.cloud}, expected ${cloud} (from the clear sky)`);
      check(near(w.ambient[0], 0.95 * w.cloud, 1e-5) && near(w.ambient[2], w.cloud, 1e-5), `rain ${rain} at ${tod}: ambient not the deck's grey`);
      check(w.slant === 0 && w.keySide[0] === Math.fround(0.6) && w.keySide[1] === Math.fround(0.8), `rain ${rain} at ${tod}: no key light, yet key (${w.keySide.join(", ")}) slant ${w.slant}`);
    }
  }
  const drizzle = weather(0.5, 0.1);
  check(drizzle.overcast > 0.2 && drizzle.overcast < 0.6, `drizzle overcast ${drizzle.overcast}`);
  check(near(drizzle.sun[1], drizzle.clearSun[1] * (1 - drizzle.overcast), 1e-5), "drizzle does not dim the sun by the overcast");
  result.weather = { morningSlant: morning.slant, drizzleOvercast: drizzle.overcast, deckAtNoon: weather(0.5, 0.5).cloud };

  // Gaps: open in full under every shaft's source, leaning downwind toward the floor.
  const sources: Vec3 = [-0.6, 0.1, 0.7];
  const row = (wind: number, y: number, from: number, step: number, width: number): number[] => {
    const out = draw(gl, probe, width, 1, { uProbe: [1], uProbeB: [wind, y, from, step], uProbeC: [...sources, 0] });
    return Array.from({ length: width }, (_, i) => out[i * 4] ?? Number.NaN);
  };
  for (const [wind, y] of [[0, 0.8], [0.8, 0], [-0.5, 0.4]] as const) {
    for (const src of sources) {
      const lean = wind * 0.35 * (1 - y);
      check((row(wind, y, src + lean, 0, 1)[0] ?? 0) >= 0.9999, `wind ${wind}, height ${y}: closed under the shaft from ${src}`);
    }
  }
  const across = row(0, 0.8, -1.2, 0.04, 64);
  check(across.every((g) => g >= 0 && g <= 1) && Math.min(...across) < 0.5, `gaps not a 0..1 mask with leaves in it: min ${Math.min(...across)}`);
  result.gaps = { closed: across.filter((g) => g < 0.05).length, of: across.length };

  // Ray sources: seeded and steady per seed, base + spread in frame widths, moved along the slant.
  const rays = (spread: number, seed: number, slant: number): Vec3 => {
    const out = draw(gl, probe, 1, 1, { uProbe: [2], uProbeA: [0.5, 0, slant, 0], uProbeB: [spread, seed, 1.5, 10], uProbeC: [-0.3, 0.04, 0.32, 0] });
    return [out[0] ?? Number.NaN, out[1] ?? Number.NaN, out[2] ?? Number.NaN];
  };
  const still = rays(0, 3, 0.4);
  [-0.3, 0.04, 0.32].forEach((base, i) => check(Math.abs((still[i] ?? 0) - base * 1.5 - Math.tan(0.4) * 0.42) <= 0.0201, `ray ${i} at ${still[i]} away from its base`));
  check(rays(0.1, 3, 0).every((x, i) => x === rays(0.1, 3, 0)[i]) && rays(0.1, 4, 0).some((x, i) => x !== rays(0.1, 3, 0)[i]), "ray sources not seeded");

  // The gap sky: stars on a clear night, none through the rain's deck, whose grey scales with its gain.
  const S = 48;
  // A patch 0.8 rad up on the bearing opposite the moon's, clear of its disc and glare.
  const away = [Math.atan2(-midnight.moonDir[0], -midnight.moonDir[2]), 0.8];
  const patch = (rain: number, stars: number, deck: number): Float32Array => draw(gl, probe, S, S, { uProbe: [3], uProbeA: [0, rain, 0, 0], uProbeB: [stars, deck, 0, 0], uProbeC: [...away, 0, 0] });
  const lit = (pixels: Float32Array): number => Array.from({ length: S * S }, (_, i) => pixels[i * 4 + 2] ?? 0).filter((b) => b > 0.05).length;
  const clearNight = lit(patch(0, 1, 1.25));
  check(clearNight > 0 && lit(patch(0, 0, 1.25)) === 0, `stars ${clearNight} at density 1 (none expected at 0)`);
  const deckNight = weather(0.0, 1);
  const deck1 = patch(1, 1, 1);
  const deck2 = patch(1, 1, 2);
  for (let i = 0; i < S * S; i++) {
    const b = deck1[i * 4 + 2] ?? Number.NaN;
    check(b >= 0.9 * 0.8 * deckNight.cloud * (1 - 1e-5) && b <= 0.9 * deckNight.cloud * (1 + 1e-5), `downpour gap ${b}: not the deck's grey (cloud ${deckNight.cloud}), or stars through it`);
    check(near(deck2[i * 4 + 2] ?? Number.NaN, 2 * b, 1e-5), "the deck's gain does not scale its grey");
  }
  result.gapSky = { clearNightStars: clearNight, downpourDeck: deck1[2] };
  gl.deleteProgram(probe);
  return result;
}
