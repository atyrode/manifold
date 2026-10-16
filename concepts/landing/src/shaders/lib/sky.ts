// Shared sky: the clock, sun and moon, a side-on camera ray, an analytic sky dome with sun and moon
// discs, and stars; helpers to turn the sky to a scene's facing, mirror it for reflections, sample the
// horizon haze and tint the stars, and the moon's coverage. With the SKY_MOON_PHASE feature
// (SceneDef.features) the moon also takes a phase (skyMoonPhase). Two parts of the night compile in
// only while they are out, behind library gates (src/shaders/index.ts): the constellations, which
// skyStars draws from the tables built below (SKY_FIGURES, while their knob is on), and the planets
// skyGiant hangs among the stars (SKY_PLANETS, while the scene's list holds any: the shared planet's
// planetGlsl and planetBodyGlsl with them). The cloud deck is clouds.ts, compiled right after it.
// Compiled into every scene program right after the common preamble; the contract and conventions
// are in src/scenes/README.md.
import { constellationUniforms, type ConstellationUniforms } from "../../constellations.ts";
import { glslFloat } from "../glsl.ts";
import { planetBodyGlsl, planetGlsl } from "./planet.ts";

type Vec3 = readonly [number, number, number];

/** The sky's latitude, 15 degrees (skyBody's daily circles): its cosine and sine. */
export const COS_LAT = 0.965926;
export const SIN_LAT = 0.258819;

/** The most planets a sky draws (the lab adds none past it), and the vec4 rows of uPlanets each takes. */
export const SKY_PLANET_CAP = 8;
export const SKY_PLANET_ROWS = 5;

/**
 * A planet's switches packed into one integer (uPlanets' third row's w, planetUniforms in
 * src/scenes/planets.ts): each field's first bit and how many bits it takes.
 */
export const SKY_PLANET_FLAGS = {
  kind: [0, 4],
  palette: [4, 2],
  phases: [6, 1],
  eclipses: [7, 1],
  lights: [8, 1],
  ring: [9, 2],
  moons: [11, 2],
  seed: [13, 3],
} as const satisfies Record<string, readonly [shift: number, bits: number]>;

/** GLSL reading field `name` of a planet's packed switches `flags` (an int). */
const flag = (name: keyof typeof SKY_PLANET_FLAGS, flags = "flags"): string => {
  const [shift, bits] = SKY_PLANET_FLAGS[name];
  return `((${flags} >> ${shift}) & ${(1 << bits) - 1})`;
};

/**
 * The constellations on the dome. constellations.ts lays its figures out for a flat frame (orbit's
 * sky): here an anchor's x, a fraction of the half-width, is a bearing of FIGURE_TURN plus
 * FIGURE_BEARING radians a unit right of straight ahead, its y (sky units up from mid-frame) an
 * elevation of FIGURE_BASE plus FIGURE_RISE radians a unit, and a star's offset (sky units) is radians
 * on the plane touching the dome at its anchor. That spreads them 13-42 degrees up, from 37 degrees
 * left to 50 right of straight ahead: the sky side-on views frame (most show 30-37 degrees up the
 * middle), turned a little right so that no star of theirs comes within the full moon's glare at
 * midnight (30 degrees up, straight ahead).
 */
const FIGURE_TURN = 0.1;
const FIGURE_BEARING = 0.8;
const FIGURE_BASE = 0.32;
const FIGURE_RISE = 1;

function at(values: Float32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`sky figures: no value at ${index}`);
  return value;
}

/** A constellation figure on the dome, as skyStars draws it. */
export interface SkyFigure {
  /** Its stars [first, end) and lines [first, end) in the uCon* uniforms (constellationUniforms). */
  readonly stars: readonly [number, number];
  readonly lines: readonly [number, number];
  /** Its anchor's direction, and the plane touching the dome there (unit right and up). */
  readonly centre: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Radians from the centre that hold every star's offset. */
  readonly reach: number;
}

/**
 * The figures of `figures` but the Manifold mark, placed on the dome: each is the run of stars that
 * share an anchor and the run of lines joining them.
 */
function placeFigures(figures: ConstellationUniforms): SkyFigure[] {
  const placed: SkyFigure[] = [];
  let line = 0;
  for (let first = 0; first < figures.markStar;) {
    const x = at(figures.stars, first * 4);
    const y = at(figures.stars, first * 4 + 1);
    let end = first;
    let reach = 0;
    for (; end < figures.markStar; end++) {
      if (at(figures.stars, end * 4) !== x || at(figures.stars, end * 4 + 1) !== y) break;
      reach = Math.max(
        reach,
        Math.hypot(at(figures.stars, end * 4 + 2), at(figures.stars, end * 4 + 3)),
      );
    }
    const lines = line;
    for (; line < figures.markLine; line++) {
      const a = at(figures.lines, line * 2);
      const b = at(figures.lines, line * 2 + 1);
      if (a < first || a >= end) break;
      if (b < first || b >= end) throw new Error(`sky figures: line ${line} leaves its figure`);
    }
    const bearing = FIGURE_TURN + x * FIGURE_BEARING;
    const rise = FIGURE_BASE + y * FIGURE_RISE;
    placed.push({
      stars: [first, end],
      lines: [lines, line],
      centre: [
        Math.cos(rise) * Math.sin(bearing),
        Math.sin(rise),
        Math.cos(rise) * Math.cos(bearing),
      ],
      right: [Math.cos(bearing), 0, -Math.sin(bearing)],
      up: [
        -Math.sin(rise) * Math.sin(bearing),
        Math.cos(rise),
        -Math.sin(rise) * Math.cos(bearing),
      ],
      reach,
    });
    first = end;
  }
  if (line !== figures.markLine) throw new Error(`sky figures: line ${line} joins no figure`);
  return placed;
}

/** The constellations' figures as skyStars draws them (constellations.ts, all but the Manifold mark). */
export const skyFigures: readonly SkyFigure[] = placeFigures(constellationUniforms);

/** The direction of the point [x, y] radians (right, up) from a figure's anchor on its plane. */
export function skyFigurePoint(figure: SkyFigure, [x, y]: readonly [number, number]): Vec3 {
  const { centre: c, right: r, up: u } = figure;
  const point: Vec3 = [
    c[0] + r[0] * x + u[0] * y,
    c[1] + r[1] * x + u[1] * y,
    c[2] + r[2] * x + u[2] * y,
  ];
  const size = Math.hypot(...point);
  return [point[0] / size, point[1] / size, point[2] / size];
}

/** GLSL float literals for `values`, comma-separated: a vector constructor's arguments. */
const floats = (values: readonly number[]): string => values.map(glslFloat).join(", ");

/** A GLSL table of the figures, one row each. */
const figureTable = (type: string, name: string, row: (figure: SkyFigure) => string): string =>
  `const ${type} ${name}[SKY_FIGURE_COUNT] = ${type}[SKY_FIGURE_COUNT](\n  ${skyFigures.map(row).join(",\n  ")}\n);`;

// The figures as GLSL: per figure SKY_FIGURE_SPAN (stars [x, y), lines [z, w) in the uCon* uniforms),
// SKY_FIGURE_CONE (the anchor's direction, and the reach) and the plane touching the dome there
// (SKY_FIGURE_RIGHT, _UP).
const figureTables = [
  `const int SKY_FIGURE_COUNT = ${skyFigures.length};`,
  figureTable("ivec4", "SKY_FIGURE_SPAN", (f) => `ivec4(${[...f.stars, ...f.lines].join(", ")})`),
  figureTable("vec4", "SKY_FIGURE_CONE", (f) => `vec4(${floats([...f.centre, f.reach])})`),
  figureTable("vec3", "SKY_FIGURE_RIGHT", (f) => `vec3(${floats(f.right)})`),
  figureTable("vec3", "SKY_FIGURE_UP", (f) => `vec3(${floats(f.up)})`),
].join("\n");

export const skyGlsl = `
// ---- sky ----

// The library gates (src/shaders/index.ts): 1 compiles in the constellations (SKY_FIGURES, defined 0
// or 1 in a scene with their knob as it is off or on) or the planets (SKY_PLANETS, defined in a scene
// that takes them as its list is empty or not); 0 in any other.
#ifndef SKY_FIGURES
#define SKY_FIGURES 0
#endif
#ifndef SKY_PLANETS
#define SKY_PLANETS 0
#endif

// The clock: K_time and K_cycle -> 0..1 (0 midnight, .25 sunrise, .5 noon, .75 sunset). At cycle 1 a
// whole day passes in four minutes. motionTime = uMotionTime is the scene clock integrated with
// uMotion, so the motion slider changes how fast the day passes without jumping the time of day.
float timeOfDayM(float time, float cycle, float motionTime) {
  return fract(time + cycle * motionTime / 240.0);
}

struct Sky {
  vec3 sun;       // unit direction (x right, y up, z into the scene)
  vec3 moon;      // unit direction
  float day;      // 0..1, full once the sun is ~12 degrees up
  float twilight; // 0..1, peaks with the sun on the horizon, lingers through civil and nautical twilight
  float night;    // 0..1, first stars at ~5 degrees down, full once the sun is ~15 degrees down
  vec3 sunColor;  // direct sunlight, reddened by the air mass; 0 once the sun has set
  vec3 ambient;   // light from the whole sky, for shading; never 0
  vec3 moonColor; // direct moonlight, cool and soft; 0 below the horizon and by day
#ifdef SKY_MOON_PHASE
  float moonPhase; // lit share of the moon's disc: 1 full (skyAt) .. 0 no moon (skyMoonPhase)
#endif
};

// Sun and moon ride the daily circles of a low-latitude sky (15 degrees) seen facing the equator,
// the celestial pole low behind the viewer. Negative declinations put both circles in front: the sun
// (-28 degrees, a winter sun) rises ~61 degrees right of straight ahead, culminates 47 degrees up dead
// ahead and sets ~61 degrees left, so sunrise, golden hour and sunset happen in or near the frame;
// the moon (-45 degrees) runs a lower arc, rising ~43 degrees right, 30 degrees up ahead at midnight.
const float SKY_COS_LAT = ${glslFloat(COS_LAT)};
const float SKY_SIN_LAT = ${glslFloat(SIN_LAT)};
const float SKY_SUN_COS_DEC = 0.882948;
const float SKY_SUN_SIN_DEC = -0.469472;
const float SKY_MOON_COS_DEC = 0.707107;
const float SKY_MOON_SIN_DEC = -0.707107;
// The sun's hour angle at sunrise, acos(-tan(dec) tan(lat)). The clock is warped onto it so the sun
// crosses the horizon exactly at .25 and .75 as the K_time contract says, and eased so it lingers
// around sunrise and sunset (half speed there, 1.5x at noon and midnight): golden hour and twilight
// get a wider stretch of the time slider, as they would at higher latitudes.
const float SKY_SUN_H0 = 1.427839;
// Angular radii in radians, ~4x true size so the discs survive a 2-4 px dither.
const float SKY_SUN_RADIUS = 0.02;
const float SKY_MOON_RADIUS = 0.024;

// A body on its daily circle at hour angle h (0 = culmination, negative = rising on the right).
vec3 skyBody(float h, float cosDec, float sinDec) {
  float c = cosDec * cos(h);
  return vec3(-cosDec * sin(h), c * SKY_COS_LAT + sinDec * SKY_SIN_LAT, c * SKY_SIN_LAT - sinDec * SKY_COS_LAT);
}

// Transmittance of a beam arriving at elevation sine e. Air mass ~ 1 / (e + 0.036), about 28 at the
// horizon (a simplification of Kasten and Young 1989), times a Rayleigh-like extinction that grows
// toward blue, so low light turns gold, then orange, then red.
vec3 skyTransmit(float e) {
  float m = 1.0 / (max(e, 0.0) + 0.036);
  return exp(-vec3(0.020, 0.056, 0.125) * m);
}

Sky skyAt(float tod) {
  Sky s;
  float d = fract(tod - 0.25); // 0 sunrise, 0.5 sunset
  float u = fract(d * 2.0);    // progress through the day half or the night half
  u -= 0.5 * sin(TAU * u) / TAU;
  float h = d < 0.5 ? mix(-SKY_SUN_H0, SKY_SUN_H0, u) : mix(SKY_SUN_H0, TAU - SKY_SUN_H0, u);
  s.sun = skyBody(h, SKY_SUN_COS_DEC, SKY_SUN_SIN_DEC);
  s.moon = skyBody(tod * TAU, SKY_MOON_COS_DEC, SKY_MOON_SIN_DEC);
  float e = s.sun.y;
  s.day = smoothstep(-0.02, 0.22, e);
  // Asymmetric bell: golden hour above the horizon, civil and nautical twilight below it.
  float w = (e + 0.02) / (e > -0.02 ? 0.17 : 0.15);
  s.twilight = exp(-w * w);
  s.night = 1.0 - smoothstep(-0.26, -0.03, e);
  s.sunColor = skyTransmit(e) * smoothstep(-0.035, 0.02, e);
  float moonUp = smoothstep(-0.02, 0.06, s.moon.y);
  s.moonColor = vec3(0.30, 0.36, 0.50) * sqrt(skyTransmit(s.moon.y)) * moonUp * (1.0 - s.day);
  // Dusk light is warm while the sun is up and turns blue once it has set (the blue hour).
  vec3 dusk = mix(vec3(0.12, 0.15, 0.30), vec3(0.36, 0.25, 0.30), smoothstep(-0.1, 0.03, e));
  s.ambient = vec3(0.030, 0.038, 0.075) + vec3(0.40, 0.48, 0.62) * s.day + dusk * s.twilight * (1.0 - s.day) + s.moonColor * 0.3;
#ifdef SKY_MOON_PHASE
  s.moonPhase = 1.0;
#endif
  return s;
}

// A sky-library direction turned about the vertical by yaw radians (positive turns +x toward +z),
// for a scene facing away from the sky's own view (sun rising on the right, culminating ahead,
// setting on the left): turns the sky's directions into the scene's frame, or with -yaw a scene ray
// back into the sky's.
vec3 skyFacing(vec3 dir, float yaw) {
  vec2 r = rotate(dir.xz, yaw);
  return vec3(r.x, dir.y, r.y);
}

// The sky with its sun and moon turned by skyFacing(dir, yaw); the light and colours stay as they are.
Sky skyFacing(Sky sky, float yaw) {
  sky.sun = skyFacing(sky.sun, yaw);
  sky.moon = skyFacing(sky.moon, yaw);
  return sky;
}

// The sky for mirrors (water, wet ground): the moon swung round behind the viewer, so no reflection
// shows a sliver of its disc broken up by ripples. Draw the moon's path on the water as glitter.
Sky skyMirror(Sky sky) {
  sky.moon = vec3(-sky.moon.x, sky.moon.y, -sky.moon.z);
  return sky;
}

// How much of the moon's disc lies over dir, 0..1, its unlit part included: hide what the scene draws
// behind the moon with it (its own star layers, a Milky Way, an asterism); skyStars already does.
// 0 below the horizon, so also 0 for a sky whose moon is put away (skyMoonPhase 0).
float skyMoonCover(Sky sky, vec3 dir) {
  return (1.0 - smoothstep(0.82 * SKY_MOON_RADIUS, SKY_MOON_RADIUS, length(dir - sky.moon))) * smoothstep(-0.004, 0.004, dir.y);
}

// A direction as angles on the sky: x its bearing from straight ahead (radians, positive right), y its
// elevation. A flat frame for things drawn across the dome, such as meteorStreak.
vec2 skyAngles(vec3 dir) {
  return vec2(atan(dir.x, dir.z), asin(clamp(dir.y, -1.0, 1.0)));
}

#ifdef SKY_MOON_PHASE
// The moon's light at a phase (its lit share, 0..1) relative to full: a Lambert sphere seen at phase
// angle a, where the lit share is (1 + cos a) / 2. Half lit gives 0.32, a quarter 0.11, a tenth 0.03.
float skyMoonPhaseLight(float phase) {
  float a = acos(clamp(2.0 * phase - 1.0, -1.0, 1.0));
  return (sin(a) + (3.14159265 - a) * cos(a)) / 3.14159265;
}

// The sky with its moon in a phase: 1 full (the sky unchanged), down to a thin crescent, 0 no moon
// (put away well below the horizon on its own bearing, so a scene keying its light off sky.moon still
// gets a direction with a heading). Its light on the land (moonColor, its share of ambient), the
// moonlit blue round it and its halo scale with skyMoonPhaseLight; skyColor draws the lit share of
// the disc on the side toward the sun, skyStars lets stars nearer a dim moon.
Sky skyMoonPhase(Sky sky, float phase) {
  if (phase >= 1.0) return sky;
  float p = max(phase, 0.0);
  vec3 light = p > 0.0 ? sky.moonColor * skyMoonPhaseLight(p) : vec3(0.0);
  sky.ambient += (light - sky.moonColor) * 0.3;
  sky.moonColor = light;
  sky.moonPhase = p;
  if (p <= 0.0) sky.moon = normalize(vec3(sky.moon.x, -2.0, sky.moon.z));
  return sky;
}

// A partial moon's disc at q (disc radii along right and up, skyColor's frame): its lit share on the
// side toward the sun, over an unlit part that shows the sky in front of it (behind) lifted faintly by
// earthshine, strongest for a thin crescent. The terminator softens to stay a cell wide; under ~3
// cells of radius it gives way to the lit share as an even tint (radius against 1 / uRes.y radians a
// cell, a screen height taken as ~1 radian of view, as skyClouds does).
vec3 skyMoonPhaseFace(Sky sky, vec2 q, vec3 right, vec3 up, vec3 face, vec3 behind) {
  vec2 toSun = vec2(dot(sky.sun, right), dot(sky.sun, up));
  toSun = dot(toSun, toSun) > 1e-8 ? normalize(toSun) : vec2(1.0, 0.0);
  vec2 r = vec2(dot(q, toSun), dot(q, vec2(-toSun.y, toSun.x)));
  float cells = SKY_MOON_RADIUS * uRes.y;
  float soft = max(0.06, 1.0 / cells);
  float terminator = (1.0 - 2.0 * sky.moonPhase) * sqrt(max(1.0 - r.y * r.y, 0.0));
  float lit = mix(sky.moonPhase, smoothstep(terminator - soft, terminator + soft, r.x), smoothstep(1.5, 3.0, cells));
  return mix(behind + face * 0.04 * (1.0 - sky.moonPhase), face, lit);
}
#endif

// Side-on pinhole camera with a shifted lens (no pitch): verticals stay vertical and the horizon is
// the straight line uv.y = horizon. fov is the full vertical field of view in radians.
vec3 viewRay(vec2 uv, float aspect, float horizon, float fov) {
  return normalize(vec3((uv.x - 0.5) * aspect, uv.y - horizon, 0.5 / tan(0.5 * fov)));
}

// Overhead colour through the day, keyed by the sun's elevation sine.
vec3 skyZenith(float e) {
  vec3 c = vec3(0.008, 0.011, 0.034);                                 // night: deep indigo
  c = mix(c, vec3(0.022, 0.032, 0.090), smoothstep(-0.32, -0.22, e)); // astronomical twilight
  c = mix(c, vec3(0.060, 0.100, 0.250), smoothstep(-0.22, -0.10, e)); // nautical: the blue hour
  c = mix(c, vec3(0.150, 0.240, 0.480), smoothstep(-0.10, 0.00, e));  // civil twilight to sunset
  c = mix(c, vec3(0.180, 0.340, 0.700), smoothstep(0.00, 0.15, e));   // low sun
  c = mix(c, vec3(0.120, 0.300, 0.720), smoothstep(0.15, 0.60, e));   // high sun: deeper blue
  return c;
}

// Horizon colour away from the sun: pale haze by day, lilac at sunset, faint airglow at night.
vec3 skyHorizon(float e) {
  vec3 c = vec3(0.030, 0.038, 0.066);
  c = mix(c, vec3(0.045, 0.052, 0.110), smoothstep(-0.32, -0.22, e));
  c = mix(c, vec3(0.150, 0.150, 0.290), smoothstep(-0.22, -0.10, e));
  c = mix(c, vec3(0.460, 0.380, 0.490), smoothstep(-0.10, 0.00, e));
  c = mix(c, vec3(0.720, 0.700, 0.700), smoothstep(0.00, 0.15, e));
  c = mix(c, vec3(0.640, 0.760, 0.900), smoothstep(0.15, 0.45, e));
  return c;
}

// The sky dome for a view ray: a Rayleigh-like zenith-to-horizon gradient, sunset bands toward the
// sun's azimuth (gold/orange low, pink above, violet higher), the Earth's shadow and the Belt of Venus
// opposite, moonlit blue and airglow at night, the sun with a Mie aureole and the moon with a halo.
// Below the horizon: the horizon colour dimming into haze, without discs. No stars (skyStars).
vec3 skyColor(Sky sky, vec3 dir) {
  float e = sky.sun.y;
  float hh = max(dir.y, 0.0);
  vec3 col = mix(skyZenith(e), skyHorizon(e), exp(-hh * 5.0));

  // 1 looking toward the sun's azimuth, 0 away from it.
  vec2 dxz = dir.xz;
  vec2 sxz = sky.sun.xz;
  float toward = 0.5 + 0.5 * dot(dxz, sxz) * inversesqrt(max(dot(dxz, dxz) * dot(sxz, sxz), 1e-8));
  float toward2 = toward * toward;

  // Golden hour, sunset and afterglow: bands stacked by height, strongest toward the sun, dimming as
  // it sinks. 'after' moves the palette from gold to red-orange and pink once the sun is down.
  float tw = sky.twilight;
  float after = 1.0 - smoothstep(-0.07, 0.05, e);
  float lit = smoothstep(-0.28, -0.02, e);
  vec3 high = vec3(0.34, 0.24, 0.52) * lit;
  vec3 mid = mix(vec3(0.98, 0.64, 0.50), vec3(0.88, 0.36, 0.46), after) * lit;
  vec3 low = mix(vec3(1.0, 0.64, 0.28), vec3(0.98, 0.34, 0.10), after) * lit;
  col = mix(col, high, tw * toward * exp(-hh * 2.0) * (1.0 - exp(-hh * 8.0)) * (0.2 + 0.4 * after));
  col = mix(col, mid, tw * toward2 * exp(-hh * 5.0) * (0.25 + 0.35 * after));
  col = mix(col, low, tw * toward2 * toward * exp(-hh * 14.0) * 0.85);
  // By day the haze is brighter on the sun's side.
  col += sky.sunColor * toward2 * exp(-hh * 3.0) * 0.1 * sky.day;

  // Opposite the sun just after sunset: the dark blue Earth's shadow on the horizon and the pink
  // Belt of Venus above it.
  float anti = 1.0 - toward;
  float belt = anti * anti * smoothstep(-0.16, -0.04, e) * (1.0 - smoothstep(-0.01, 0.05, e));
  col = mix(col, vec3(0.14, 0.16, 0.30), belt * exp(-hh * 35.0) * 0.55);
  float bh = (hh - 0.1) / 0.07;
  col += vec3(0.22, 0.09, 0.15) * belt * exp(-bh * bh);

  // Night: moonlight turns the sky blue; airglow lifts a faint green band a few degrees up.
  float moonVis = smoothstep(-0.02, 0.04, sky.moon.y) * (1.0 - sky.day);
#ifdef SKY_MOON_PHASE
  if (sky.moonPhase < 1.0) moonVis *= skyMoonPhaseLight(sky.moonPhase); // a partial moon lights less sky
#endif
  col += vec3(0.018, 0.028, 0.060) * moonVis * sky.night * (0.6 + 0.4 * exp(-hh * 3.0));
  col += vec3(0.012, 0.026, 0.020) * sky.night * hh * exp(-hh * 12.0) * 30.0;

  // Sun: three exponential lobes standing in for the Mie (Henyey-Greenstein) forward peak, then a
  // disc cut by the horizon. a = 1 - cos(angle), computed from the chord so it stays precise.
  float horizonCut = smoothstep(-0.004, 0.004, dir.y);
  vec3 dv = dir - sky.sun;
  float a = 0.5 * dot(dv, dv);
  col += sky.sunColor * (0.30 * exp(-a * 1400.0) + 0.16 * exp(-a * 90.0) + 0.07 * exp(-a * 10.0));
  col += sky.sunColor * (1.0 - smoothstep(SKY_SUN_RADIUS * 0.8, SKY_SUN_RADIUS, length(dv))) * horizonCut * 2.5;

  // Moon: a cool halo, then a disc with soft maria and limb darkening, gold when low; full unless the
  // scene gave it a phase (skyMoonPhase).
  vec3 mv = dir - sky.moon;
  float am = 0.5 * dot(mv, mv);
  col += vec3(0.30, 0.36, 0.52) * (0.20 * exp(-am * 2500.0) + 0.06 * exp(-am * 120.0)) * moonVis;
  float md = length(mv);
  if (md < SKY_MOON_RADIUS) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), sky.moon)); // the moon never reaches the zenith
    vec3 up = cross(sky.moon, right);
    vec2 q = vec2(dot(mv, right), dot(mv, up)) / SKY_MOON_RADIUS;
    float l = length(q);
    float maria = vnoise(q * 2.3 + 4.7) * 0.65 + vnoise(q * 5.1 + 1.3) * 0.35;
    float shade = (1.0 - 0.3 * smoothstep(0.45, 0.68, maria)) * (0.8 + 0.2 * sqrt(max(1.0 - l * l, 0.0)));
    vec3 face = vec3(0.95, 0.94, 0.90) * shade * sqrt(skyTransmit(sky.moon.y));
#ifdef SKY_MOON_PHASE
    if (sky.moonPhase < 1.0) face = skyMoonPhaseFace(sky, q, right, up, face, col);
#endif
    col = mix(col, face, (1.0 - smoothstep(0.82, 1.0, l)) * horizonCut * mix(1.0, 0.35, sky.day));
  }

  // Below the horizon: the horizon colour fading into a dim haze.
  return col * mix(1.0, 0.35, smoothstep(0.0, 0.25, -dir.y));
}

// The sky just above the horizon in a ray's bearing: the haze that distant land, mist and fog fade
// into. lift is the sample's rise over the level bearing (dir.xz kept, y = lift, then normalised):
// about the elevation in radians for a ray near the middle of the view. Scenes use 0..0.04.
vec3 horizonHaze(Sky sky, vec3 dir, float lift) {
  return skyColor(sky, normalize(vec3(dir.x, lift, dir.z)));
}

// One layer of stars on an equi-angular cube map of the sky: each face is a grid of cells that may
// hold one star, so a star belongs to a direction and never moves. atan() evens out the cells (plain
// gnomonic cells shrink ~5x in solid angle toward the cube corners and would bunch stars on the
// edges). size is the largest radius in cells; salt decorrelates layers.
float skyStarLayer(vec3 dir, float cells, float fill, float size, float salt) {
  vec3 a = abs(dir);
  vec2 f = vec2(0.0);
  float face = 0.0;
  if (a.x >= a.y && a.x >= a.z) {
    f = dir.zy / a.x;
    face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    f = dir.xz / a.y;
    face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    f = dir.xy / a.z;
    face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  vec2 g = (atan(f) * (2.0 / 3.14159265) + 0.5) * cells;
  vec2 id = floor(g);
  float h = hash12(id + vec2(face * 157.0 + salt, salt * 3.7));
  if (h >= fill) return 0.0;
  float u = h / fill; // uniform 0..1 among the cells that hold a star
  float h2 = hash12(id.yx + vec2(salt * 1.9 + 11.0, face * 61.0));
  vec2 c = 0.25 + 0.5 * vec2(h2, fract(h2 * 67.3));
  float m = u * u * u; // magnitudes: many faint stars, a few bright ones
  float r = size * (0.4 + 0.6 * m);
  float star = (1.0 - smoothstep(0.0, r, length(g - id - c))) * (0.3 + 0.7 * m);
  // Gentle twinkle, each star at its own slow rate; deeper near the horizon (scintillation).
  float wave = 0.5 + 0.5 * sin(uTime * uMotion * (0.8 + 2.2 * fract(h2 * 13.7)) + TAU * fract(h2 * 29.1));
  float depth = mix(0.12, 0.45, 1.0 - smoothstep(0.05, 0.45, dir.y));
  return star * (1.0 - depth * wave);
}

// Where stars show at all, 0..1: by night, rising from the horizon, and away from the moon's disc and
// glare. A partial moon (SKY_MOON_PHASE) keeps hiding its disc but glares over less of the sky.
float skyStarFade(Sky sky, vec3 dir) {
  float d = length(dir - sky.moon);
#ifdef SKY_MOON_PHASE
  float moon = sky.moonPhase < 1.0
    ? smoothstep(0.03, mix(0.035, 0.1, skyMoonPhaseLight(sky.moonPhase)), d)
    : smoothstep(0.03, 0.1, d);
#else
  float moon = smoothstep(0.03, 0.1, d);
#endif
  return sky.night * smoothstep(0.0, 0.22, dir.y) * moon;
}

#if SKY_FIGURES
// The constellations (constellations.ts, every figure but the Manifold mark), placed on the dome by
// placeFigures in sky.ts: the stars' offsets, brightness and lines come from the uCon* uniforms.
${figureTables}

// The figures over dir, 0..1 before the stars' fade: their stars, discs of 0.8..1.4 dither cells'
// radius (brightness 0.4..1) with a one-cell cross of glint reaching 2.7..4.5 cells out, that outshine
// the field's and twinkle as gently as its brightest, and their stick lines at coverage 'lines', a
// dotted trace at 0.05 .. solid at 1. perCell: dither cells a radian; everything is sized in cells, so
// nothing is finer than one and nothing crawls, and a line too short to clear its stars by three cells
// is left out. A figure's stars and lines are visited only within its cone.
float skyFigures(vec3 dir, float perCell, float lines) {
  float lit = 0.0;
  for (int f = 0; f < SKY_FIGURE_COUNT; f++) {
    vec4 cone = SKY_FIGURE_CONE[f];
    vec3 off = dir - cone.xyz;
    float reach = cone.w + 5.0 / perCell;
    if (dot(off, off) > reach * reach) continue;
    // dir on the plane touching the dome at the figure, in radians: a gnomonic view, so the lines
    // between stars are great circles.
    vec2 q = vec2(dot(dir, SKY_FIGURE_RIGHT[f]), dot(dir, SKY_FIGURE_UP[f])) / dot(dir, cone.xyz);
    ivec4 span = SKY_FIGURE_SPAN[f];
    for (int i = span.x; i < span.y; i++) {
      float b = uConBright[i];
      vec2 d = abs(q - uConStars[i].zw) * perCell;
      float r = 0.4 + b;
      float glint = step(min(d.x, d.y), 0.5) * smoothfall(1.5 + 3.0 * b, 0.0, max(d.x, d.y)) * b;
      float wave = 0.5 + 0.5 * sin(uMotionTime * (0.9 + 0.17 * float(i)) + 2.3 * float(i));
      lit = max(lit, max(smoothfall(r + 0.5, r - 0.5, length(d)), 0.7 * glint) * (1.0 - 0.1 * wave));
    }
    for (int i = span.z; i < span.w; i++) {
      vec2 a = uConStars[int(uConLines[i].x)].zw;
      vec2 ab = uConStars[int(uConLines[i].y)].zw - a;
      float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
      float across = length(q - a - ab * h) * perCell;
      float fromEnds = min(h, 1.0 - h) * length(ab) * perCell;
      lit = max(lit, lines * smoothfall(0.9, 0.35, across) * smoothstep(2.5, 3.5, fromEnds));
    }
  }
  return lit;
}
#endif

// skyStars' field of stars (coverage 'field', faded by 'fade', skyStarFade) with the constellations
// over it while they are on (K_constellations, faded as the stars), in a program that compiles them
// in (SKY_FIGURES). foot: radians a dither cell spans. Without them it is the field.
float skyStarFigures(vec3 dir, float field, float fade, float foot) {
#if SKY_FIGURES
  if (K_constellations > 0.0 && fade > 0.0)
    return max(field, skyFigures(dir, 1.0 / max(foot, 1e-6), K_constellations) * fade);
#endif
  return field;
}

// Stars for a view ray, 0..1: a dense layer of faint stars and a sparse one of bright stars. density
// 0..1 (1 is a dark-site sky). Already faded by daylight, toward the horizon and around the moon. The
// constellations of a scene with their knob come with them (none at density 0), sized for a 1-radian
// view: a dither cell 1 / uRes.y radians.
float skyStars(Sky sky, vec3 dir, float density) {
  if (dir.y <= 0.0 || sky.night <= 0.0 || density <= 0.0) return 0.0;
  float s = skyStarLayer(dir, 120.0, 0.22 * density, 0.2, 0.0)
          + skyStarLayer(dir, 44.0, 0.1 * density, 0.09, 7.0) * 1.3;
  float fade = skyStarFade(sky, dir);
  return skyStarFigures(dir, clamp(s * fade, 0.0, 1.0), fade, 1.0 / uRes.y);
}

// One star layer at a footprint (foot: radians one dither cell spans): once its grid cells, (pi / 2) /
// cells radians, shrink toward a single dither cell the stars can no longer stand apart and the layer
// fades to its mean glow, mean per unit of fill (what fbmLod does with noise octaves).
float skyStarLayerLod(vec3 dir, float cells, float fill, float size, float salt, float foot, float mean) {
  float keep = smoothstep(0.75, 1.25, 1.5707963 / (cells * max(foot, 1e-6)));
  if (keep <= 0.0) return mean * fill;
  float s = skyStarLayer(dir, cells, fill, size, salt);
  return keep < 1.0 ? mix(mean * fill, s, keep) : s;
}

// skyStars with a level of detail for the view's footprint, foot: the radians one dither cell spans
// along dir (about the vertical field of view over uRes.y). The faint layer keeps its stars while its
// grid cells span 1.25 dither cells or more (a 1-radian view at 96 rows or finer), the bright layer
// down to 35 rows; there its field is exactly skyStars(sky, dir, density)'s. Coarser, a layer fades to
// its faint mean glow instead of crawling as single cells. The constellations are sized in these
// cells.
float skyStars(Sky sky, vec3 dir, float density, float foot) {
  if (dir.y <= 0.0 || sky.night <= 0.0 || density <= 0.0) return 0.0;
  float s = skyStarLayerLod(dir, 120.0, 0.22 * density, 0.2, 0.0, foot, 0.0064)
          + skyStarLayerLod(dir, 44.0, 0.1 * density, 0.09, 7.0, foot, 0.0013) * 1.3;
  float fade = skyStarFade(sky, dir);
  return skyStarFigures(dir, clamp(s * fade, 0.0, 1.0), fade, foot);
}

// The cool white most scenes give their stars.
const vec3 SKY_STAR_TINT = vec3(0.85, 0.9, 1.0);

// Starlight to add to the sky for a view ray: skyStars in SKY_STAR_TINT.
vec3 skyStarLight(Sky sky, vec3 dir, float density) {
  return SKY_STAR_TINT * skyStars(sky, dir, density);
}

// ---- the sky's planets ----

#if SKY_PLANETS
${planetGlsl}

// The climate (src/climate.ts), compiled with the weather library after the sky: the home-like
// world's year (planetHome).
float climateCold(float year);
float climateLying(float cold);

${planetBodyGlsl}

// The planets (planetUniforms in src/scenes/planets.ts), uPlanetCount of them in drawing order, the
// smaller first (a smaller planet is a farther one, behind the bigger), SKY_PLANET_ROWS rows each:
//   0: A, and w the path's rate (radians a second of the motion clock)
//   1: B, and its radius (gnomonic, the tangent of its angular radius)
//   2: D, and its switches packed (SKY_PLANET_FLAGS: kind, palette, real phases, moons' shadows, city
//      lights, ring, moons, seed)
//   3: day cycle (0 none), spin, the city lights' twinkle, the ring's facing
//   4: the ring's roll, moon size, aurora (0 none), aurora oval
// Its centre at the motion clock tm is D + A cos(w tm) + B sin(w tm): a circle round the sky for a
// planet that orbits, A its direction (w 0, B and D nothing) for one fixed among the stars.
#define SKY_PLANET_CAP ${SKY_PLANET_CAP}
#define SKY_PLANET_ROWS ${SKY_PLANET_ROWS}
uniform vec4 uPlanets[SKY_PLANET_CAP * SKY_PLANET_ROWS];
uniform int uPlanetCount;

// Planet i's centre at the motion clock: a unit direction in the stars' frame.
vec3 skyPlanetCentre(int i, float tm) {
  vec4 a = uPlanets[i * SKY_PLANET_ROWS];
  vec4 b = uPlanets[i * SKY_PLANET_ROWS + 1];
  float h = a.w * tm;
  return uPlanets[i * SKY_PLANET_ROWS + 2].xyz + a.xyz * cos(h) + b.xyz * sin(h);
}

// Planet i over col along dir (vis: how much of a planet shows there, skyGiant's), seen square-on
// from wherever the view looks, the sky round it a gnomonic view, upright: the body tier draws it
// (planetBodyOver) as its kind in its palette, lit from the upper left as campfire's giant is (its day
// cycle sweeping that light round it) or, with real phases, from the scene's sun, so it waxes and
// wanes as the sun moves round the sky; its surface turns, and its moons go round, on its own clock.
vec3 skyPlanetOver(Sky sky, vec3 col, vec3 dir, float foot, float vis, int i, float tm) {
  int at = i * SKY_PLANET_ROWS;
  vec4 shape = uPlanets[at + 1];
  vec4 pack = uPlanets[at + 2];
  vec4 dress = uPlanets[at + 3];
  vec4 more = uPlanets[at + 4];
  vec3 centre = skyPlanetCentre(i, tm);
  vec3 right = dot(centre.xz, centre.xz) > 1e-8 ? normalize(vec3(centre.z, 0.0, -centre.x)) : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(centre, right);
  vec2 p = vec2(dot(dir, right), dot(dir, up)) / dot(dir, centre);
  int flags = int(pack.w + 0.5);
  vec3 light = normalize(vec3(-0.62, 0.42, 0.66));
  if (${flag("phases")} == 1) light = normalize(vec3(dot(sky.sun, right), dot(sky.sun, up), -dot(sky.sun, centre)));
  else if (dress.x > 0.0) light = planetSun(light, uMotionTime * dress.x * 0.25);
  PlanetLook look = planetGiant(vec2(0.0), shape.w, light);
  int kind = ${flag("kind")};
  int palette = ${flag("palette")};
  int ring = ${flag("ring")};
  planetBodyColours(look, kind, palette);
  look.ring = PlanetRing(dress.w, more.x);
  look.ringed = ring == 1 ? 1.0 : 0.0;
  look.visible = vis;
  look.night = sky.night;
  look.moons = float(${flag("moons")});
  look.moonScale = more.y;
  look.eclipses = float(${flag("eclipses")});
  look.aurora = more.z;
  look.auroraSize = more.w;
  look.lights = float(${flag("lights")});
  look.twinkle = dress.z;
  return planetBodyOver(col, p, foot, PlanetBody(look, kind, palette, ring, float(${flag("seed")}), tm * dress.y), uTime);
}

// The sky's planets (src/scenes/planets.ts: the scene's list) over 'col', the sky along dir so far:
// the dome, the Milky Way and the stars, which they stand in front of. dir is the direction the
// scene's stars are fixed to (what it gives skyStars), foot the radians a dither cell spans there,
// clear how much of the sky the scene's cloud leaves open there (1 none, 0 behind a solid deck). Each
// planet stands where its placement puts it among the stars or rides its orbit round our world,
// rising, crossing the sky and setting on its own period; a bigger one stands in front of a smaller.
// They fade to pale ghosts by day as campfire's giant does, and hide behind the moon's disc and under
// the horizon. A cheap bound finds the planets that reach this pixel and only those are drawn, in a
// loop whose turns are those planets: a software rasteriser runs no turn that none of its pixels
// enters, so more planets cost little more than one. Draw the cloud, the aurora,
// shooting stars and the ground over them.
vec3 skyGiant(Sky sky, vec3 col, vec3 dir, float foot, float clear) {
  float vis = (1.0 - 0.85 * sky.day) * clear * (1.0 - skyMoonCover(sky, dir)) * smoothstep(-0.004, 0.004, dir.y);
  if (vis <= 0.0) return col;
  float tm = uMotionTime;
  int reach = 0;
  int hits = 0;
  for (int i = 0; i < SKY_PLANET_CAP; i++) {
    if (i >= uPlanetCount) break;
    // Within the drawn square's corners, 2.3 radii out along each axis, as a tangent.
    float ahead = dot(dir, skyPlanetCentre(i, tm));
    float k = 3.26 * uPlanets[i * SKY_PLANET_ROWS + 1].w;
    if (ahead > 0.0 && ahead * ahead * (1.0 + k * k) >= 1.0) {
      reach |= 1 << i;
      hits++;
    }
  }
  for (int n = 0; n < hits; n++) {
    int i = 0;
    while ((reach >> i & 1) == 0) i++;
    reach &= ~(1 << i);
    col = skyPlanetOver(sky, col, dir, foot, vis, i, tm);
  }
  return col;
}
#else
vec3 skyGiant(Sky sky, vec3 col, vec3 dir, float foot, float clear) {
  return col;
}
#endif
`;
