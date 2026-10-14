// GPU regressions for the shared sky components (stars, the moon's phase, aurora, meteors) and their
// composition in Frost, run by concepts/landing/verify-browser.ts on real WebGL output. A probe entry
// compiled with Frost's knobs evaluates the library functions over grids of directions into a float
// target; the full Frost program checks the coupling at the rendered picture.
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { fragmentSourceFor, vertexSource } from "../../shaders/index.ts";
import { sceneDefs } from "../index.ts";

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`frost sky: ${message}`);
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

// Library outputs over grids. probeDir: pixel x -> bearing (uProbeA.x whole pixels of shift, uProbeA.y
// radians a pixel, uProbeA.w the first bearing), y -> elevation from uProbeA.z. probeSky: skyAt(uProbeB.x),
// in phase uProbeB.y where the feature is compiled in.
const PROBE = `
uniform int uProbe;
uniform vec4 uProbeA;
uniform vec4 uProbeB;
uniform vec4 uProbeC;

vec3 probeDir(vec2 cell) {
  float az = uProbeA.w + (cell.x - 0.5 + uProbeA.x) * uProbeA.y;
  float el = uProbeA.z + (cell.y - 0.5) * uProbeA.y;
  return vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
}

Sky probeSky() {
  Sky s = skyAt(uProbeB.x);
#ifdef SKY_MOON_PHASE
  s = skyMoonPhase(s, uProbeB.y);
#endif
  return s;
}

// Around the moon: uProbeA.x radians a pixel, centred on it at pixel uProbeA.yz; also the sun's side
// of the disc. uRes.y is set to 1 / uProbeA.x, so the library's own footprint (1 / uRes.y radians a
// cell) matches the grid.
vec3 probeMoonDir(Sky sky, vec2 cell, out float sunSide) {
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), sky.moon));
  vec3 up = cross(sky.moon, right);
  vec2 o = (cell - uProbeA.yz) * uProbeA.x;
  sunSide = dot(o, vec2(dot(sky.sun, right), dot(sky.sun, up)));
  return normalize(sky.moon + right * o.x + up * o.y);
}

Shade toolboxProbe(vec2 uv, vec2 cell, float t) {
  vec3 v = vec3(0.0);
  Sky sky = probeSky();
  if (uProbe == 0) {
    vec3 dir = probeDir(cell);
    v = vec3(skyStars(sky, dir, uProbeB.z), skyStars(sky, dir, uProbeB.z, uProbeB.w), 0.0);
  } else if (uProbe == 1) {
    float side;
    vec3 dir = probeMoonDir(sky, cell, side);
    v = skyColor(sky, dir);
  } else if (uProbe == 2) {
    float side;
    vec3 dir = probeMoonDir(sky, cell, side);
    v = vec3(skyMoonCover(sky, dir), side, skyStarFade(sky, dir));
  } else if (uProbe == 3) {
    v = cell.x < 1.0 ? sky.moonColor : cell.x < 2.0 ? sky.ambient : sky.moon;
  } else if (uProbe == 4) {
    v = auroraM(probeDir(cell), uProbeC.x, uProbeC.y, uProbeC.z);
  } else if (uProbe == 5) {
    v = aurora(probeDir(cell), uProbeC.x, uProbeC.y);
  } else if (uProbe == 6) {
    v = cell.x < 1.0
      ? vec3(auroraSeen(skyAt(0.5), 0.0), auroraSeen(skyAt(0.0), 1.0), auroraSeen(skyAt(0.0), 0.0))
      : auroraGlow(uProbeC.x, uProbeC.y);
  } else if (uProbe == 7) {
    float seed;
    float age = meteorAge((floor(cell.x) + floor(cell.y) * uRes.x) * uProbeC.x, uProbeC.y, int(uProbeC.z), seed);
    v = vec3(age, seed, 0.0);
  } else {
    vec2 q = (cell - 0.5 * uRes) / uRes.y;
    v = vec3(meteorStreak(q, uProbeA, uProbeC.x, uProbeC.y, uProbeC.z), 0.0, 0.0);
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
  const set = (name: string, value: readonly number[]): void => {
    const at = gl.getUniformLocation(linked, name);
    if (at === null) return;
    if (name === "uProbe" || name === "uView") gl.uniform1i(at, value[0] ?? 0);
    else if (name === "uParams" || name === "uTriggers") gl.uniform1fv(at, Float32Array.from(value));
    else if (value.length === 1) gl.uniform1f(at, value[0] ?? 0);
    else if (value.length === 2) gl.uniform2fv(at, value);
    else if (value.length === 3) gl.uniform3fv(at, value);
    else gl.uniform4fv(at, value);
  };
  const base: Uniforms = {
    uRes: [width, height], uView: [1], uTime: [40], uMotion: [0.6], uMotionTime: [24], uPassage: [1, 0],
    uTriggers: Array.from({ length: 8 }, () => -1e4), uMouse: [-1, -1, 0, -1e4], uBg: [0.03, 0.03, 0.05],
  };
  for (const [name, value] of Object.entries({ ...base, ...uniforms })) set(name, value);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const out = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return out;
}

const channel = (pixels: Float32Array, c: number): number[] => Array.from({ length: pixels.length / 4 }, (_, i) => pixels[i * 4 + c] ?? 0);
const luma = (pixels: Float32Array, i: number): number => 0.2126 * (pixels[i * 4] ?? 0) + 0.7152 * (pixels[i * 4 + 1] ?? 0) + 0.0722 * (pixels[i * 4 + 2] ?? 0);
const same = (a: Float32Array, b: Float32Array): boolean => a.every((value, i) => value === b[i]);

/** Frost's knobs as the shader reads them, with overrides keyed as in the URL. */
function frostParams(over: Record<string, number>): readonly number[] {
  return renderSettings(defaultsFor("frost"), { ...paramDefaults("frost"), ...over }).params;
}

export function verifyFrostSky(gl: WebGL2RenderingContext): Record<string, unknown> {
  check(gl.getExtension("EXT_color_buffer_float") !== null, "float render targets unavailable");
  const result: Record<string, unknown> = {};
  const frost = sceneDefs.frost;
  const probeDef = { ...frost, entry: "toolboxProbe", glsl: PROBE };
  const probe = program(gl, fragmentSourceFor(probeDef));
  const plain = program(gl, fragmentSourceFor({ ...probeDef, features: {} }));
  const params = frostParams({});

  // Stars: a band of sky at midnight, 43-50 degrees up and 69-90 degrees right, far from the moon
  // (30 degrees up straight ahead); 0.002 rad a pixel, as in a 1-radian view at 500 rows.
  const W = 192;
  const H = 64;
  const step = 0.002;
  const band = (density: number, foot: number, shift = 0, tod = 0.0): Float32Array =>
    draw(gl, probe, W, H, { uProbe: [0], uParams: params, uProbeA: [shift, step, 0.75, 1.2], uProbeB: [tod, 1, density, foot] });
  const count = (pixels: Float32Array, c: number): number => channel(pixels, c).filter((value) => value > 0.05).length;
  const half = band(0.5, 0.002);
  const full = band(1, 0.002);
  check(count(band(0, 0.002), 0) === 0, "stars at density 0");
  check(count(full, 0) > count(half, 0) && count(half, 0) > 20, `star count not rising with density: ${count(half, 0)}, ${count(full, 0)}`);
  check(count(band(1, 0.002, 0, 0.5), 0) === 0, "stars by day");
  // A star belongs to its direction: the band turned by one pixel's bearing shows the same stars one
  // pixel over (screen-space hashing would reshuffle them).
  const turned = band(1, 0.002, 1);
  let matched = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x + 1 < W; x++) {
      check(turned[(y * W + x) * 4] === full[(y * W + x + 1) * 4], `star at (${x + 1}, ${y}) moved with the view`);
      matched++;
    }
  }
  // Level of detail: at a fine footprint it is exactly the plain call; at a coarse one no layer
  // draws single stars, only a faint mean glow.
  check(channel(full, 0).every((value, i) => value === full[i * 4 + 1]), "fine-footprint stars differ from skyStars(sky, dir, density)");
  const coarse = band(1, 0.06);
  check(count(coarse, 1) === 0 && channel(coarse, 1).some((value) => value > 0), "coarse footprint still draws single stars or loses the glow");
  result.stars = { half: count(half, 0), full: count(full, 0), matched };

  // Moon: selecting the feature leaves a full moon's sky exactly as it was; a phase lights its sun side.
  const D = 64;
  const moonGrid = (linked: WebGLProgram, mode: number, phase: number, tod = 0.95): Float32Array =>
    draw(gl, linked, D, D, { uProbe: [mode], uParams: params, uRes: [D, 1 / 0.0012], uProbeA: [0.0012, D / 2, D / 2, 0], uProbeB: [tod, phase, 0, 0] });
  check(same(moonGrid(probe, 1, 1), moonGrid(plain, 1, 1)), "SKY_MOON_PHASE at phase 1 changed the sky");
  check(same(moonGrid(probe, 2, 1), moonGrid(plain, 2, 1)), "SKY_MOON_PHASE at phase 1 changed the moon's cover or the stars' glare");
  check(same(band(1, 0.002), draw(gl, plain, W, H, { uProbe: [0], uParams: params, uProbeA: [0, step, 0.75, 1.2], uProbeB: [0, 1, 1, 0.002] })), "SKY_MOON_PHASE at phase 1 changed the stars");
  const geometry = moonGrid(probe, 2, 0.5);
  const lit = (phase: number): { sun: number; away: number } => {
    const sky = moonGrid(probe, 1, phase);
    const behind = moonGrid(probe, 1, 0.05);
    let sun = 0;
    let away = 0;
    for (let i = 0; i < D * D; i++) {
      if ((geometry[i * 4] ?? 0) < 0.99) continue;
      if (luma(sky, i) > luma(behind, i) + 0.15) {
        if ((geometry[i * 4 + 1] ?? 0) > 0) sun++;
        else away++;
      }
    }
    return { sun, away };
  };
  const disc = channel(geometry, 0).filter((value) => value >= 0.99).length;
  const quarter = lit(0.5);
  const gibbous = lit(0.85);
  check(disc > 300, `moon disc too small to judge: ${disc}`);
  check(quarter.sun > 4 * Math.max(quarter.away, 1), `half moon not lit toward the sun: ${quarter.sun} vs ${quarter.away}`);
  check(quarter.sun + quarter.away > 0.3 * disc && quarter.sun + quarter.away < 0.7 * disc, `half moon lit share ${(quarter.sun + quarter.away) / disc}`);
  check(gibbous.sun + gibbous.away > quarter.sun + quarter.away, "fuller moon not more lit");
  // Coverage: whole disc 1 (its unlit part too), none two radii off or with no moon.
  check((geometry[(D / 2 * D + D / 2) * 4] ?? 0) === 1 && (geometry[0] ?? 1) === 0, "moon cover at centre / corner");
  check(channel(moonGrid(probe, 2, 0), 0).every((value) => value === 0), "a moonless sky still covers stars");
  // Its light: Lambert-sphere fall-off (0.318 at half), none without a moon; ambient follows.
  const light = (phase: number): Float32Array => draw(gl, probe, 3, 1, { uProbe: [3], uParams: params, uProbeB: [0.95, phase, 0, 0] });
  const moonLum = (phase: number): number => luma(light(phase), 0);
  const ratio = moonLum(0.5) / moonLum(1);
  check(Math.abs(ratio - 0.3183) < 0.01, `half moon light ratio ${ratio}`);
  check(moonLum(0) === 0 && luma(light(0), 1) < luma(light(1), 1), "no moon still lights the land");
  // A slim moon lets stars come closer: the fade 0.035 rad from it (just outside the disc).
  const fade = (phase: number): number => {
    const grid = moonGrid(probe, 2, phase);
    const i = (D / 2) * D + D / 2 + 29; // 29.5 pixels right of centre: 0.035 rad
    return grid[i * 4 + 2] ?? -1;
  };
  check(fade(0.15) > fade(1) + 0.2, `slim moon glare ${fade(0.15)} vs full ${fade(1)}`);
  result.moon = { disc, halfLit: quarter, lightRatio: ratio };

  // Aurora: on the motion clock (the same picture at any motion for the same uMotionTime), the
  // legacy entry exactly auroraM at t * uMotion, a level of detail that keeps the glow, visibility.
  // A band 3-21 degrees up and 70 degrees wide across the middle of the view, 0.0064 rad a pixel.
  const AH = 48;
  const sky = (mode: number, motion: number, clock: number, strength: number, foot: number): Float32Array =>
    draw(gl, probe, W, AH, { uProbe: [mode], uParams: params, uMotion: [motion], uProbeA: [0, 0.0064, 0.06, -0.61], uProbeC: [clock, strength, foot, 0] });
  const curtains = sky(4, 0.6, 50, 0.8, 0.002);
  check(same(curtains, sky(4, 0.25, 50, 0.8, 0.002)) && same(curtains, sky(4, 1, 50, 0.8, 0.002)), "aurora depends on motion beyond its clock");
  check(same(sky(5, 0.5, 100, 0.8, 0), sky(4, 0.5, 50, 0.8, 0.002)), "aurora(dir, t, s) differs from auroraM(dir, t * uMotion, s)");
  check(channel(curtains, 1).some((value) => value > 0.05), "no aurora at strength 0.8");
  check(channel(sky(4, 0.6, 50, 0, 0.002), 1).every((value) => value === 0), "aurora at strength 0");
  const roughness = (pixels: Float32Array): number => {
    let sum = 0;
    for (let y = 0; y < AH; y++) for (let x = 0; x + 1 < W; x++) sum += Math.abs((pixels[(y * W + x + 1) * 4 + 1] ?? 0) - (pixels[(y * W + x) * 4 + 1] ?? 0));
    return sum;
  };
  const meanGreen = (pixels: Float32Array): number => channel(pixels, 1).reduce((a, b) => a + b, 0) / (W * AH);
  const blurred = sky(4, 0.6, 50, 0.8, 0.03);
  check(roughness(blurred) < 0.8 * roughness(curtains), "coarse footprint kept the finest rays");
  check(Math.abs(meanGreen(blurred) / meanGreen(curtains) - 1) < 0.1, `coarse footprint changed the aurora's mean glow: ${meanGreen(blurred)} vs ${meanGreen(curtains)}`);
  const seen = draw(gl, probe, 2, 1, { uProbe: [6], uParams: params, uProbeC: [50, 1, 0, 0] });
  check(seen[0] === 0 && seen[1] === 0 && seen[2] === 1, `aurora visibility day/cloud/open: ${seen.slice(0, 3).join(",")}`);
  check((seen[5] ?? 0) > (seen[4] ?? 0) && (seen[5] ?? 0) > 0, "aurora glow not green");
  result.aurora = { roughness: [roughness(curtains), roughness(blurred)], meanGreen: [meanGreen(curtains), meanGreen(blurred)] };

  // Meteors: none without a rate or trigger; the trigger's meteor at its age with a stable seed; none
  // at motion 0; at rate 1 about 0.8 x 0.9 s per 5 s window in flight.
  const schedule = (rate: number, motion: number, slot: number, triggers?: number[]): Float32Array =>
    draw(gl, probe, 200, 30, { uProbe: [7], uParams: params, uMotion: [motion], uProbeC: [0.5, rate, slot, 0], ...(triggers ? { uTriggers: triggers } : {}) });
  const flying = (pixels: Float32Array): number => channel(pixels, 0).filter((age) => age <= 0.9).length / (pixels.length / 4);
  check(channel(schedule(0, 1, 1), 0).every((age) => age === 1e4), "meteors without a rate");
  check(flying(schedule(1, 0, -1)) === 0, "random meteors at motion 0");
  const often = flying(schedule(1, 1, -1));
  const seldom = flying(schedule(0.3, 1, -1));
  check(often > 0.1 && often < 0.19 && seldom < often * 0.4, `meteor shares ${often}, ${seldom}`);
  const fireSlot1 = Array.from({ length: 8 }, (_, slot) => (slot === 1 ? 39.7 : -1e4));
  const fired = schedule(0, 0, 1, fireSlot1);
  check(channel(fired, 0).every((age) => Math.abs(age - 0.3) < 1e-4), "triggered meteor's age");
  check(new Set(channel(fired, 1)).size === 1 && same(fired, schedule(0, 0, 1, fireSlot1)), "triggered meteor's seed not stable");
  const streak = (age: number): Float32Array => draw(gl, probe, 160, 100, { uProbe: [8], uParams: params, uProbeA: [-0.3, 0.1, 0.6, 0.2], uProbeC: [age, 0.37, 0.01, 0] });
  const covered = (pixels: Float32Array): number => channel(pixels, 0).filter((value) => value > 0.3).length;
  check(covered(streak(0.45)) > 5 && covered(streak(1.2)) === 0 && covered(streak(-0.1)) === 0, "meteor streak in and out of flight");
  result.meteors = { inFlight: [often, seldom], streakCells: covered(streak(0.45)) };
  gl.deleteProgram(probe);
  gl.deleteProgram(plain);

  // Frost: the components at the rendered picture, night over the street, clear glass (no sim).
  const scene = program(gl, fragmentSourceFor(frost));
  const FW = 192;
  const FH = 120;
  const render = (over: Record<string, number>, triggers?: number[]): Float32Array =>
    draw(gl, scene, FW, FH, { uParams: frostParams({ time: 0.95, ...over }), uWeather: [0, 0.5], uSimOn: [0, 0, 0, 0], ...(triggers ? { uTriggers: triggers } : {}) });
  // The street and the snow along it: the bottom quarter of the frame.
  const ground = Array.from({ length: Math.floor(FH * 0.25) * FW }, (_, i) => i);
  const meanLuma = (pixels: Float32Array, at: number[]): number => at.reduce((sum, i) => sum + luma(pixels, i), 0) / at.length;
  const meanG = (pixels: Float32Array, at: number[]): number => at.reduce((sum, i) => sum + (pixels[i * 4 + 1] ?? 0), 0) / at.length;
  // Aurora light on the snow while the sky is open; the snow cloud shuts it out.
  const openOff = render({ snow: 0, aurora: 0 });
  const openOn = render({ snow: 0, aurora: 1, "aurora-amount": 0.8 });
  check(meanG(openOn, ground) > meanG(openOff, ground) * 1.02, "aurora does not light the snow under an open sky");
  const cloudOff = render({ aurora: 0 });
  const cloudOn = render({ aurora: 1, "aurora-amount": 0.8 });
  check(ground.every((i) => [0, 1, 2].every((c) => cloudOn[i * 4 + c] === cloudOff[i * 4 + c])), "aurora light leaks through the snow cloud");
  // The moon's phase lights the land.
  check(meanLuma(render({ snow: 0, "moon-amount": 0.25 }), ground) < meanLuma(openOff, ground), "a crescent lights the street as much as a full moon");
  // A triggered meteor shows only in the sky above the roofs, and behind the snow cloud at most
  // through its thin gaps.
  const meteorTrigger = Array.from({ length: 8 }, (_, slot) => (slot === 1 ? 40 - 0.4 : -1e4));
  const changed = (a: Float32Array, b: Float32Array): number[] => {
    const out: number[] = [];
    for (let i = 0; i < FW * FH; i++) if ([0, 1, 2].some((c) => a[i * 4 + c] !== b[i * 4 + c])) out.push(i);
    return out;
  };
  const meteorCells = changed(render({ snow: 0 }, meteorTrigger), openOff);
  check(meteorCells.length > 3 && meteorCells.every((i) => Math.floor(i / FW) > FH * 0.45), `meteor cells ${meteorCells.length}, lowest row ${Math.min(...meteorCells.map((i) => Math.floor(i / FW)))}`);
  const clouded = changed(render({}, meteorTrigger), cloudOff).length;
  check(clouded < 0.25 * meteorCells.length, `a meteor shows through the snow cloud: ${clouded} of ${meteorCells.length} cells`);
  result.frost = { auroraGroundGreen: [meanG(openOff, ground), meanG(openOn, ground)], meteorCells: [meteorCells.length, clouded] };
  gl.deleteProgram(scene);
  return result;
}
