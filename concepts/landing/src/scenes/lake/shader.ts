// The northern night, drawn (sim.ts grows the lake's cracks, drifts its snow and paces the aurora):
// the frozen lake, or the fjord (K_setting 1, below), under one sky.
//
// The camera stands on the ice, EYE metres up, facing north across a lake ringed with spruce
// forest, low hills and snowy mountains behind; a point reaches out from the left with a log
// cabin on it, its window lit and smoke rising until it flattens under the cold air above. The
// aurora hangs over the north (the shared library, recoloured, paced by the sim's substorms and
// spreading overhead in a surge), with stars, the shared Milky Way and our own moon with its phase.
//
// The ice is clear and black where the wind has swept it: a mirror of everything above (tipped a
// little by the frozen undulations of the surface and softened, as rough ice does, by a second tap
// of the aurora a little higher), with methane bubbles frozen beneath it in five layers (flat white
// discs stacked in columns over the seeps, fainter and bluer deeper down, and clouds of small ones
// near the surface), and cracks: a white line where each meets the surface and, hanging from it,
// the fracture plane going down into the ice, seen through the surface along the refracted ray.
// The sim's field gives both: the distance to the nearest crack, and how far up the screen the
// crack above is, which against the depth this pixel's refracted ray reaches says whether it
// passes through that crack's plane. A crack being sung glows behind its front. Packed snow lies in
// wind-shaped patches (crisp, world-anchored edges cut against each cell's threshold), drifting
// snow streams across in long thin streamers, the moon and the window draw paths of light down the
// ice, and hoarfrost catches the light here and there.
//
// Entrance and exit are in the world. The camera tilts: a vertical lens shift of the whole frame
// (the horizon slides down the screen as it looks up), applied to uv before everything is built from
// it, so the ice, its cracks, the sky, the mist and the falling snow stay in one projection. It
// arrives from the aurora, settling a little past level, and leaves toward it. On the way in a crack
// sings across the ice (the sim); on the way out a gust of blown snow streams across, carrying low
// streamers over the ice and the far shore, in rows of the screen and faster the nearer the ice,
// cut per cell. At rest none of it is drawn and uv is the screen's.
//
// The slow drapes (K_drapes; compiled in by LAKE_DRAPES): instead of the shared curtains, up to
// three ribbons hang along arcs at growing distances, laid out in the sky as the fjord's camera at
// rest sees it (lakeDrapePoint), so they hang alike over the lake and the fjord and in either's
// mirror. A ribbon's sheet folds in and out along its length (where it turns edge-on it glows
// more); its light is a sharp bright hem, then fine vertical rays (spaced by angle, brightening and
// fading slowly along their height), a pulse of brightness travelling along the arc, lit stretches
// and dark gaps; green low, the colour's fringe toward the top. A corona (rays streaming from a
// point high in the sky) gathers now and then. They run on the substorm's clock: a surge brightens
// them, livens them (as activity) and quickens them. Coming in they unfurl from faint high arcs,
// ray by ray; going out they roll back up.
//
// The fjord (K_setting 1; compiled in by LAKE_FJORD): a still fjord under snowy mountains going
// straight into the water, a small red cabin on the far shore with its window lit and a thread of
// smoke climbing from the chimney, birches beside it and on the near bank. A side-on pinhole camera
// of its own (horizon LAKE_FJ_HZ, focal LAKE_FJ_F) draws it: the sky (the lake's, lakeSkyAt, with
// the moon low on the left and the M folded into a curtain high up), the mountains, the far shore
// and the cabin are one function, lakeFjFar, of a screen point above the horizon. The water below
// it is that same function looked up at the mirrored point, shifted by slow ripple noise (still
// water), by a breeze's ripples (K_ripples, shaders/windWater.ts) or by frozen undulations (K_ice),
// then dimmed by a Fresnel-like share; the cabin's window and the moon draw their light paths down
// it. Reflected edges move a fraction of a cell at a time; every crisp edge (window, trunk, smoke)
// is cut per cell against the dither threshold, so each cell flips once as it passes. Its passage:
// the camera comes down from the stars already moving and settles on the fjord (a touch of
// overshoot) as the chimney's smoke climbs, and lifts to the stars again, ever faster, going out.
import { glslFloat, glslPick } from "../../shaders/glsl.ts";
import { birdsGlsl } from "../../shaders/lib/birds.ts";
import { milkyWayGlsl } from "../../shaders/lib/milkyway.ts";
import { LAKE_CORONA_TRIGGER, LAKE_METEOR_TRIGGER, LAKE_PASSAGE } from "./constants.ts";
import {
  ABOVE_RANGE,
  DIST_RANGE,
  DRIFT_MAX,
  EYE,
  FIELD_FU,
  FIELD_FV,
  FIELD_H,
  FIELD_W,
  FOCAL,
  HORIZON,
  ICE_DEPTH,
  ICE_INDEX,
  MARK_ID,
  SNOW_MAX,
  SURGE_GAIN,
} from "./sim.ts";

/** The aurora's colours by the `hue` knob (green + violet, teal, storm, crimson, green): its low light and its high fringe. */
const AURORA_LOW = [
  "vec3(0.25, 1.0, 0.55)",
  "vec3(0.2, 0.95, 0.88)",
  "vec3(0.38, 1.0, 0.48)",
  "vec3(1.0, 0.3, 0.38)",
  "vec3(0.25, 1.0, 0.55)",
] as const;
const AURORA_HIGH = [
  "vec3(0.78, 0.2, 0.58)",
  "vec3(0.38, 0.32, 1.0)",
  "vec3(1.0, 0.14, 0.26)",
  "vec3(0.72, 0.06, 0.24)",
  "vec3(0.12, 0.85, 0.72)",
] as const;

/**
 * The slow drapes' colours by the `hue` knob, as AURORA_LOW and AURORA_HIGH: low and high, how far
 * up a curtain (0 its hem, 1 its top) the change begins and ends, and the gain (a red fringe reads
 * dimmer). The sky's M over the fjord takes them too.
 */
const DRAPE_LOW = [
  "vec3(0.28, 1.0, 0.50)",
  "vec3(0.2, 0.95, 0.88)",
  "vec3(0.45, 1.0, 0.32)",
  "vec3(1.0, 0.3, 0.38)",
  "vec3(0.28, 1.0, 0.50)",
] as const;
const DRAPE_HIGH = [
  "vec3(0.66, 0.22, 0.92)",
  "vec3(0.38, 0.32, 1.0)",
  "vec3(1.0, 0.10, 0.22)",
  "vec3(0.72, 0.06, 0.24)",
  "vec3(0.12, 0.85, 0.72)",
] as const;
const DRAPE_FROM = [0.3, 0.3, 0.08, 0.2, 0.35] as const;
const DRAPE_TO = [0.85, 0.85, 0.65, 0.8, 1.0] as const;
const DRAPE_GAIN = [1.0, 1.0, 1.2, 1.2, 1.0] as const;

/** The fjord's camera: its horizon (screen height, at rest) and vertical field of view (rad). */
export const FJORD_HORIZON = 0.32;
const FJORD_FOV = 1.3;

export const lakeGlsl = `
${birdsGlsl}
${milkyWayGlsl}
const float LAKE_HORIZON = ${glslFloat(HORIZON)};
const float LAKE_FOCAL = ${glslFloat(FOCAL)};
const float LAKE_EYE = ${glslFloat(EYE)};
// Shooting stars (the shared component, K_meteors) set out here, in skyAngles of the sky's
// directions (bearing, elevation, radians): high over the mountains, and seen again in the ice.
const int LAKE_METEOR_SLOT = ${LAKE_METEOR_TRIGGER};
const vec4 LAKE_METEOR_FIELD = vec4(-0.6, 0.3, 1.2, 0.15);
const float LAKE_ICE_N = ${glslFloat(ICE_INDEX)};
const float LAKE_ICE_DEPTH = ${glslFloat(ICE_DEPTH)};
const float LAKE_FU = ${glslFloat(FIELD_FU)};
const float LAKE_FV = ${glslFloat(FIELD_FV)};
const vec2 LAKE_FIELD = vec2(${glslFloat(FIELD_W)}, ${glslFloat(FIELD_H)});
const float LAKE_DIST = ${glslFloat(DIST_RANGE)};
const float LAKE_ABOVE = ${glslFloat(ABOVE_RANGE)};
const float LAKE_SNOW_MAX = ${glslFloat(SNOW_MAX)};
const float LAKE_DRIFT_MAX = ${glslFloat(DRIFT_MAX)};
const float LAKE_MARK = ${glslFloat(MARK_ID)};
// The passage: how far the camera tilts (screen heights) and how long the exit's gust takes (s).
const float LAKE_TILT = 0.5;
const float LAKE_EXIT_S = ${glslFloat(LAKE_PASSAGE.exit)};

// The cabin stands this far off (m) on a bank this high, its window 1.3 m up, 1.1 m left of its middle.
const float LAKE_CABIN_Z = 92.0;
const float LAKE_BANK = 1.0;
const vec3 LAKE_WINDOW = vec3(1.0, 0.58, 0.24);
// The glints on the ice (waterGlint): the moon's exposure, set so its path across the row that
// mirrors it is as bright at half its height as it always was, and the cabin window's intensity,
// over the squared distance (m) to the ice it lights.
const float LAKE_MOON_GLINT = 0.0081;
const float LAKE_WINDOW_GLINT = 2.86;
const vec3 LAKE_SNOW = vec3(0.86, 0.9, 1.0);
const vec3 LAKE_FLASH = vec3(0.78, 0.93, 1.0);
const vec3 LAKE_WATER = vec3(0.003, 0.009, 0.012);
// The Milky Way's band: it rises from low on the right to high over the middle.
const MilkyWayBand LAKE_GALAXY = MILKY_WAY_BAND(vec3(-0.2984, -0.7957, 0.5272));
// Depths (m) of the layers of frozen bubbles, and the spacing of the seeps on the lake bed (m).
const float LAKE_LAYER[5] = float[5](0.04, 0.13, 0.26, 0.42, 0.62);
const float LAKE_SEEP = 1.1;

// Set once per pixel by lakeSetup.
float lakeTm;          // the motion clock
Sky lakeSky;           // the sky, with the library's own moon put away: the lake draws its own
vec3 lakeMoon;         // our moon's direction, its bearing and elevation (rad)
float lakeMoonAz;
float lakeMoonEl;
float lakePhase;       // 0 no moon .. 1 full
vec3 lakeMoonLight;    // its light on the land
vec3 lakeAmb;          // light from the whole sky, the aurora's included
vec3 lakeAurLow;       // the aurora's colours
vec3 lakeAurHigh;
vec3 lakeAurLight;     // the aurora's light on the land
float lakeAurGain;     // K_aurora times the substorm's surge
float lakeAurClock;    // the curtains' clock: the sim's, motion time sped up through a surge
float lakeSurge;       // the substorm, 0..1
float lakeAurVis;      // how much of the aurora twilight and cloud let through
float lakeOver;        // overcast 0..1
float lakeCabinAz;     // the cabin's bearing (rad)
float lakePar;         // the backdrop's parallax turn (rad)
float lakeAccent;      // aurora light gathered by lakeSkyAt
float lakeMeteorAt;    // seconds since the latest shooting star, and its id (meteorAge)
float lakeMeteorSeed;

vec3 lakeAuroraLowColour() {
${glslPick("hue", AURORA_LOW, AURORA_LOW[0])}
}

vec3 lakeAuroraHighColour() {
${glslPick("hue", AURORA_HIGH, AURORA_HIGH[0])}
}

// The aurora for a ray: the shared curtains, repainted in the chosen colours (the library mixes
// its oxygen green low into red-violet high; split them back out and mix ours), and in a substorm a
// second set spreading overhead. soft > 0 averages a tap that much higher, smearing the curtains
// up and down as rough ice does in its mirror.
vec3 lakeAurora(vec3 d, float soft) {
  if (lakeAurGain <= 0.0 || d.y <= 0.0) return vec3(0.0);
  vec3 a = auroraCurtains(d, lakeAurClock, lakeAurGain, 1.0);
  if (soft > 0.0) a = 0.5 * (a + auroraCurtains(normalize(d + vec3(0.0, soft, 0.0)), lakeAurClock, lakeAurGain, 1.0));
  if (lakeSurge > 0.03) {
    vec3 high = normalize(vec3(d.x * 1.15, d.y * 0.6, d.z));
    a += auroraCurtains(high, lakeAurClock * 1.3 + 41.0, lakeAurGain * 0.8 * smoothstep(0.03, 0.7, lakeSurge), 1.0);
  }
  float low = max(0.78 * a.g - 0.2 * a.r, 0.0) / 0.73;
  float fringe = max(a.r - 0.25 * a.g, 0.0) / 0.73;
  return (low * lakeAurLow + fringe * lakeAurHigh) * lakeAurVis;
}

#if LAKE_FJORD || LAKE_DRAPES
// The fjord's camera at rest: its horizon on the screen and its focal length (screen heights). The
// fjord is drawn through it; the slow drapes and the sky's M hang in the sky where it sees them.
const float LAKE_FJ_HZ = ${glslFloat(FJORD_HORIZON)};
const float LAKE_FJ_F = ${glslFloat(0.5 / Math.tan(FJORD_FOV / 2))};

// Set once per pixel by lakeSetup.
float lakeFocal;       // the focal length of the camera drawing (screen heights)
vec3 lakeDrLow;        // the drapes' colours (DRAPE_*), the sky M's too
vec3 lakeDrHigh;
float lakeDrFrom;
float lakeDrTo;
float lakeDrGain;

vec3 lakeDrapeLowColour() {
${glslPick("hue", DRAPE_LOW, DRAPE_LOW[0])}
}

vec3 lakeDrapeHighColour() {
${glslPick("hue", DRAPE_HIGH, DRAPE_HIGH[0])}
}

float lakeDrapeFrom() {
${glslPick("hue", DRAPE_FROM.map(glslFloat), glslFloat(DRAPE_FROM[0]))}
}

float lakeDrapeTo() {
${glslPick("hue", DRAPE_TO.map(glslFloat), glslFloat(DRAPE_TO[0]))}
}

float lakeDrapeGain() {
${glslPick("hue", DRAPE_GAIN.map(glslFloat), glslFloat(DRAPE_GAIN[0]))}
}

// Where the sky in direction d (d.z > 0) stands in the fjord's frame at rest: screen heights across
// from its middle and up from its foot.
vec2 lakeDrapePoint(vec3 d) {
  return vec2(d.x, d.y) * (LAKE_FJ_F / d.z) + vec2(0.0, LAKE_FJ_HZ);
}
#endif

#if LAKE_DRAPES
const int LAKE_CORONA_SLOT = ${LAKE_CORONA_TRIGGER};
const float LAKE_SURGE_GAIN = ${glslFloat(SURGE_GAIN)};

// Set once per pixel by lakeSetup.
float lakeDrStrength;  // how bright: K_aurora, brightened by a substorm's surge
float lakeDrAct;       // how lively: K_activity, livelier through a surge
float lakeDrHW;        // half the frame's width where the drapes hang (the fjord's frame, screen heights)
float lakeUnfurl[3];   // passage: how far each curtain has come down (1 at rest)
float lakeCorona;      // the corona's envelope 0..1

// The drapes' passage: coming in, the three unfurl one after another, each sweeping along its arc
// from a faint high arc to its full drape as the rays drop ray by ray; going out they roll back up
// into faint arcs (the far end first) until the exit ends. Returns the land's share of their light
// while they are furled; at rest everything stands at 1.
float lakeDrapesPassage() {
  lakeUnfurl[0] = 1.0;
  lakeUnfurl[1] = 1.0;
  lakeUnfurl[2] = 1.0;
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return 1.0;
  float glow = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float inU = clamp((pin - 0.10 - 0.08 * fi) / 0.62, 0.0, 1.0);
    float outU = 1.0 - clamp((pout - 0.06 * fi) / (1.0 - 0.06 * fi), 0.0, 1.0);
    lakeUnfurl[i] = min(inU, outU);
    glow += lakeUnfurl[i] / 3.0;
  }
  return 0.7 + 0.3 * glow;
}

// The corona's envelope: a burst every minute or two (more often with the knob), a few tens of
// seconds long, or at once from the "now" button. Smooth in time, zero between.
float lakeCoronaEnv() {
  if (K_corona <= 0.0) return 0.0;
  float period = mix(240.0, 80.0, clamp(K_corona, 0.0, 1.0));
  float cyc = fract(uMotionTime / period + 0.55);
  float b = sin(3.14159265 * clamp(cyc / 0.28, 0.0, 1.0));
  float env = b * b;
  float since = sinceTrigger(LAKE_CORONA_SLOT);
  if (since >= 0.0 && since < 40.0) {
    float s = sin(3.14159265 * since / 40.0);
    env = max(env, s * s);
  }
  return env;
}

// One ribbon of the drapes, a curtain seen from the ground, at sky point q (lakeDrapePoint): its
// lower hem follows a curve in the sky that slowly evolves into long S-bends (y0: where it hangs, L:
// how far its light reaches up, both in screen heights of the fjord's frame). Above the hem the light
// fades upward as a fan of fine, dense, vertical rays, each brightening and fading slowly along its
// height. The curtain is folded along its length: where its ray coordinate s bunches up (ds/dx
// small) the sheet turns edge-on and glows brighter. A pulse of brightness travels along it; lit
// stretches alternate with dark gaps. A faint veil lies under the hem. Returns the light (x) and
// how far up the sheet (y, 0..1).
vec2 lakeRibbon(vec2 q, float y0, float L, float salt, float T, float unf) {
  float act = lakeDrAct;
  float x = q.x;
  float amp = 0.03 + 0.05 * act;
  float hem = y0 + amp * (sin(x * 1.9 + T * 0.014 + salt) + 0.55 * sin(x * 3.7 - T * 0.021 + salt * 2.1) + 0.2 * sin(x * 7.3 + T * 0.030 + salt * 3.3));
  // unf < 1: the curtain is unfurling or rolling up. A wave sweeps along the arc (ux: how far this
  // stretch has come down), the hem hanging higher the less unfurled it is.
  float ux = 1.0;
  if (unf < 1.0) {
    float xw = clamp(0.5 + 0.5 * x / lakeDrHW, 0.0, 1.0);
    if (salt > 3.0 && salt < 5.0) xw = 1.0 - xw;
    ux = smoothstep(0.0, 1.0, clamp(unf * 1.5 - 0.5 * xw, 0.0, 1.0));
    hem += 0.10 * (1.0 - ux);
  }
  float fa = 0.10 + 0.08 * act;
  float s = x + fa * sin(x * 3.3 - T * 0.017 + salt * 1.7) + 0.5 * fa * sin(x * 7.1 + T * 0.026 + salt);
  float ds = 1.0 + fa * 3.3 * cos(x * 3.3 - T * 0.017 + salt * 1.7) + 0.5 * fa * 7.1 * cos(x * 7.1 + T * 0.026 + salt);
  float hh0 = q.y - hem;
  if (hh0 < -0.12 || hh0 > 2.4 * L + 0.02) return vec2(0.0);
  float sx = s + 0.10 * hh0;
  // Each ray drops at its own moment (static along the arc), so the drape comes down ragged and
  // settles: Le is how far the light reaches up here.
  float Le = L;
  if (unf < 1.0) {
    float rp = vnoise(vec2(sx * 31.0 + salt * 7.0, salt + 2.0));
    Le = L * mix(0.14, 1.0, clamp(ux * 1.4 - 0.4 * rp, 0.0, 1.0));
  }
  float fine = vnoise(vec2(sx * 75.0 - T * 0.012 + salt * 9.0, salt + hh0 * 2.0 - T * 0.015));
  float mid = vnoise(vec2(sx * 28.0 + T * 0.008, salt * 3.0 + hh0 * 0.8));
  float rays = smoothstep(0.25, 0.85, 0.6 * fine + 0.4 * mid);
  float hh = hh0 + 0.014 * (0.5 - fine);
  float edge = smoothstep(-0.004, 0.006, hh);
  float up = max(hh, 0.0) / Le;
  float body = exp(-up * 3.2) * (0.55 + 0.45 * rays) + 0.5 * rays * exp(-up * 1.1);
  float stretch = smoothstep(0.2, 0.65, vnoise(vec2(x * 1.1 + T * 0.008, salt + 7.0)));
  float w = 0.5 + 0.5 * sin(x * 3.0 - T * 0.13 + salt * 1.7);
  float pulse = mix(1.0, 0.35 + 0.65 * w * w, 0.25 + 0.6 * act);
  float fold = clamp(1.0 / max(ds, 0.35), 0.7, 2.0);
  float lum = edge * body * (1.0 - smoothstep(1.2, 2.4, up)) * pulse * mix(0.2, 1.0, stretch) * fold
            + (1.0 - edge) * 0.10 * exp(min(hh, 0.0) / 0.04) * stretch;
  // The colour follows the full-height curtain, so a furled arc stays the low green.
  return vec2(lum, clamp(max(hh, 0.0) / L / 1.4, 0.0, 1.0));
}

// The ribbons at sky point q: the main one hanging mid-sky with its rays reaching high, a dimmer
// one low behind the mountains, and (in a livelier sky) a third high up; breathing slowly.
vec3 lakeDrapeCurtains(vec2 q, float T) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float gain = i == 0 ? 1.0 : (i == 1 ? 0.7 : 0.5 * smoothstep(0.1, 0.5, lakeDrAct));
    if (gain > 0.0) {
      float y0 = i == 0 ? 0.57 : (i == 1 ? 0.45 : 0.74);
      float len = i == 0 ? 0.17 : (i == 1 ? 0.11 : 0.14);
      float unf = lakeUnfurl[i];
      // A curtain still furled is a faint arc: a little dimmer, mostly just short.
      if (unf < 1.0) gain *= 0.6 + 0.4 * unf;
      vec2 cu = lakeRibbon(q, y0, len, float(i) * 2.7 + 1.3, T, unf);
      c += mix(lakeDrLow, lakeDrHigh, smoothstep(lakeDrFrom, lakeDrTo, cu.y)) * cu.x * gain;
    }
  }
  return c * 0.6 * (0.92 + 0.08 * sin(T * 0.13));
}

// The corona: rays streaming from a point high in the north, brightest near the point, fading to
// the high colour with distance. Integer ray counts around the point keep it seamless.
vec3 lakeCoronaLight(vec3 d, float T) {
  if (lakeCorona <= 0.0 || d.y <= 0.0) return vec3(0.0);
  vec3 c = normalize(vec3(-0.1, 0.82, 0.58));
  float ca = dot(d, c);
  if (ca < 0.55) return vec3(0.0);
  vec3 ex = normalize(cross(vec3(0.0, 1.0, 0.0), c));
  vec3 ey = cross(c, ex);
  float a = acos(min(ca, 1.0));
  float phi = atan(dot(d, ey), dot(d, ex));
  float r = 0.5 + 0.25 * (sin(phi * 14.0 + T * 0.03 + a * 1.5) + sin(phi * 23.0 - T * 0.021 + a * 2.5 + 1.3));
  float rays = smoothstep(0.35, 0.85, r);
  float lum = lakeCorona * exp(-a * a / 0.22) * smoothstep(0.03, 0.22, a) * (0.2 + 0.8 * rays);
  vec3 tint = mix(lakeDrLow * vec3(1.0, 1.0, 1.15), lakeDrHigh, smoothstep(0.12, 0.65, a));
  return tint * lum * 0.85;
}

// The drapes for a ray, to add to the night sky in place of lakeAurora: the ribbons, the corona and
// a faint glow of the curtains over the sky, as bright as their strength and what twilight and cloud
// let through. soft as for lakeAurora.
vec3 lakeDrapes(vec3 d, float soft) {
  if (lakeDrStrength <= 0.0 || d.y <= 0.0) return vec3(0.0);
  vec3 a = lakeCoronaLight(d, lakeAurClock) * lakeDrGain;
  if (d.z > 0.05) {
    vec2 q = lakeDrapePoint(d);
    vec3 c = lakeDrapeCurtains(q, lakeAurClock);
    if (soft > 0.0) c = 0.5 * (c + lakeDrapeCurtains(lakeDrapePoint(normalize(d + vec3(0.0, soft, 0.0))), lakeAurClock));
    a += c * lakeDrGain + lakeDrLow * 0.035 * exp(-abs(q.y - 0.6) / 0.25);
  }
  return a * lakeDrStrength * lakeAurVis;
}
#endif

#if LAKE_FJORD
// Where the fjord's moon stands in its frame at rest: across as a share of the half width, and up.
const vec2 LAKE_FJ_MOON = vec2(-0.42, 0.545);
float lakeFjHW;        // half the fjord's frame's width (screen heights), set by lakeFjord

// The M over the fjord: a curtain of the aurora that has folded itself into the letter high in the
// sky, with the same vertical rays, breathing slowly, its sheet rippling a little. Adds its light to
// lakeAccent.
vec3 lakeSkyMark(vec3 d, float T) {
  if (K_mark < 0.5 || K_setting < 0.5 || d.z <= 0.05) return vec3(0.0);
  vec2 q = lakeDrapePoint(d);
  float size = 0.30;
  vec2 m = (q - vec2(0.10 * lakeFjHW, 0.69)) / size;
  m.x += 0.014 * sin(m.y * 5.0 + T * 0.30);
  if (abs(m.x) > 0.7 || abs(m.y) > 0.75) return vec3(0.0);
  float dm = markDistance(m);
  float core = 1.0 - smoothstep(0.035, 0.085, dm);
  float halo = exp(-dm * dm / 0.006) * 0.35;
  float rays = 0.65 + 0.35 * vnoise(vec2(q.x * 80.0 - T * 0.04, q.y * 2.0 + T * 0.02));
  float breathe = 0.82 + 0.18 * sin(T * 0.45);
  float lum = (core + halo) * rays * breathe * (0.8 + 0.2 * smoothstep(-0.5, 0.5, -m.y));
  lakeAccent += lum * 1.2;
  return mix(lakeDrLow, lakeDrHigh, smoothstep(-0.2, 0.9, m.y) * 0.8) * lum * 1.1 * lakeDrGain * lakeAurVis;
}
#endif

// Our moon: a disc in its phase (the lit limb toward the sun, down to the left), its dark part
// faint with earthshine, and a halo. Returns light for the sky; cover how much of the disc hides
// the stars behind it.
vec3 lakeMoonAt(vec3 d, out float cover) {
  cover = 0.0;
  if (lakePhase <= 0.0) return vec3(0.0);
  vec3 mv = d - lakeMoon;
  float am = 0.5 * dot(mv, mv);
  vec3 halo = vec3(0.32, 0.38, 0.52) * (0.16 * exp(-am * 2600.0) + 0.05 * exp(-am * 160.0)) * lakePhase * (1.0 - lakeOver);
  const float radius = 0.026;
  if (length(mv) > radius * 1.2) return halo;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), lakeMoon));
  vec3 up = cross(lakeMoon, right);
  vec2 q = rotate(vec2(dot(mv, right), dot(mv, up)) / radius, 2.36);
  float l = length(q);
  float disc = 1.0 - smoothstep(0.88, 1.0, l);
  float terminator = (1.0 - 2.0 * lakePhase) * sqrt(max(1.0 - q.y * q.y, 0.0));
  float lit = smoothstep(terminator - 0.08, terminator + 0.08, q.x) * disc;
  float maria = vnoise(q * 2.3 + 4.7) * 0.6 + vnoise(q * 5.1 + 1.3) * 0.4;
  vec3 face = vec3(0.98, 0.95, 0.88) * (1.0 - 0.28 * smoothstep(0.45, 0.68, maria));
  cover = disc * (1.0 - lakeOver);
  return halo + (face * lit * 1.1 + vec3(0.04, 0.05, 0.07) * (disc - lit)) * (1.0 - lakeOver);
}

// The night sky for a ray: the dome, moonlight in the air and the aurora's glow low in the north,
// the Milky Way and stars (fainter in the mirror), the giant planet, our moon, a shooting star, the
// aurora (the shared curtains or the slow drapes) and over the fjord the M, and cloud while it
// snows. Adds the aurora's light that shows to lakeAccent.
vec3 lakeSkyAt(vec3 d, bool mirror, float soft) {
  vec3 col = skyColor(lakeSky, d);
  float hh = max(d.y, 0.0);
  col += vec3(0.02, 0.03, 0.062) * lakePhase * lakeSky.night * (0.5 + 0.5 * exp(-hh * 3.0)) * (1.0 - lakeOver);
  col += lakeAurLight * 0.6 * exp(-hh * 8.0);
  Sky starry = lakeSky;
  starry.moon = lakePhase > 0.0 ? lakeMoon : vec3(0.0, -1.0, 0.0);
  float mw = milkyWay(d, d.y, LAKE_GALAXY) * K_milkyWay * K_stars * lakeSky.night * (1.0 - 0.75 * lakePhase);
  col += vec3(0.045, 0.048, 0.064) * mw;
  float density = milkyWayStars(K_stars, mw) * (1.0 - 0.6 * lakePhase);
  col += skyStarLight(starry, d, mirror ? 0.5 * density : density) * (mirror ? 0.6 : 1.0);
#if LAKE_FJORD
  float foot = max(1.0 / (lakeFocal * uRes.y), soft);
#else
  float foot = max(1.0 / (LAKE_FOCAL * uRes.y), soft);
#endif
  col = skyGiant(starry, col, d, foot, 1.0);
  float disc;
  vec3 moon = lakeMoonAt(d, disc);
  col = col * (1.0 - 0.9 * disc) + moon;
  float meteor = meteorStreak(skyAngles(d), LAKE_METEOR_FIELD, lakeMeteorAt, lakeMeteorSeed, foot);
  col += METEOR_TINT * hardEdge(meteor * lakeSky.night * (1.0 - disc)) * (mirror ? 0.6 : 1.0);
#if LAKE_DRAPES
  vec3 aur = K_drapes > 0.5 ? lakeDrapes(d, soft) : lakeAurora(d, soft);
#else
  vec3 aur = lakeAurora(d, soft);
#endif
#if LAKE_FJORD
  aur += lakeSkyMark(d, lakeTm);
#endif
  col += aur;
  float seen = dot(aur, LUMA);
  if (lakeOver > 0.0) {
    vec4 deck = skyClouds(lakeSky, d, lakeTm, lakeOver, K_wind);
    col = mix(col, deck.rgb, deck.a);
    seen *= 1.0 - deck.a;
  }
  lakeAccent += seen;
  return col;
}

// The far shore's waterline (m) by bearing, and the point the cabin stands on reaching out from the left.
float lakeFarShore(float az) {
  return 230.0 + 70.0 * vnoise(vec2(az * 2.4 + 3.0, 1.7)) + 30.0 * vnoise(vec2(az * 6.5, 4.2));
}

float lakePointShore(float az) {
  float d = (az - lakeCabinAz) / 0.2;
  return LAKE_CABIN_Z - 8.0 + 140.0 * d * d;
}

// Ridgelines by bearing, as elevations (rad): forested hills ~3 km off, snowy mountains ~14 km.
float lakeHills(float az) {
  return (70.0 + 170.0 * (0.62 * vnoise(vec2(az * 4.2, 2.0)) + 0.38 * vnoise(vec2(az * 11.0, 5.0)))) / 3200.0;
}

float lakePeaks(float az) {
  float r = 1.0 - abs(2.0 * vnoise(vec2(az * 2.1 + 7.0, 1.0)) - 1.0);
  float r2 = 1.0 - abs(2.0 * vnoise(vec2(az * 5.3 + 2.0, 3.0)) - 1.0);
  return (250.0 + 800.0 * (0.7 * r * r + 0.3 * r2)) / 14000.0;
}

// One row of spruces 'back' metres behind a shoreline, 'spacing' rad apart and up to 'tallest'
// metres: does the ray (from o, 'r0' metres out on the ice, rising 'slope' per metre) pass
// through one, and its colour. onPoint: the point's grove, whose shoreline each tree finds for
// itself (it curves fast); else the far shore at zs. Dark needles with snow on every tier.
bool lakeSpruces(float az, vec3 o, float r0, float slope, float zs, float back, float spacing, float tallest, bool onPoint, float salt, out vec3 col) {
  col = vec3(0.0);
  float k0 = floor(az / spacing);
  for (int i = -1; i <= 1; i++) {
    float k = k0 + float(i);
    float h = hash12(vec2(k, salt));
    if (h < 0.1) continue;
    float azk = (k + 0.5 + 0.6 * (fract(h * 7.3) - 0.5)) * spacing;
    if (onPoint && K_cabin > 0.5 && abs(azk - lakeCabinAz) < 0.05) continue;
    float zk = (onPoint ? lakePointShore(azk) : zs) + back;
    float tall = tallest * (0.55 + 0.45 * fract(h * 13.7));
    float v = (o.y + slope * (zk - r0) - LAKE_BANK * 0.7) / tall;
    if (v < 0.0 || v > 1.0) continue;
    float tier = fract(v * 6.0 + h * 3.0);
    float hw = 0.23 * tall * (1.0 - v) * (0.7 + 0.3 * tier) + 0.12;
    if (abs((az - azk) * zk) < hw) {
      float snowy = smoothstep(0.62, 0.92, tier) * (0.55 + 0.45 * fract(h * 5.1));
      vec3 needles = vec3(0.012, 0.022, 0.02) + lakeAmb * 0.12;
      vec3 lit = LAKE_SNOW * (lakeAmb * 1.6 + lakeMoonLight * 0.6 + lakeAurLight * 1.4) * 0.8;
      col = mix(needles, lit, clamp(0.75 * snowy + 0.6 * uWeather.y, 0.0, 1.0));
      return true;
    }
  }
  return false;
}

// The log cabin: walls, a snow-laden gable roof with dark eaves, a stone chimney, a door, and one
// window lit by the fire inside. p: metres across from its middle and up from the bank.
bool lakeCabin(vec2 p, out vec3 col) {
  col = vec3(0.0);
  float ax = abs(p.x);
  float ridge = 2.3 + 2.0 * (1.0 - ax / 3.1);
  bool wall = ax < 2.6 && p.y > 0.0 && p.y < 2.35;
  bool roof = ax < 3.1 && p.y >= 2.2 && p.y < ridge;
  bool chimney = abs(p.x - 1.5) < 0.28 && p.y > 3.0 && p.y < 5.0;
  if (!(wall || roof || chimney)) return false;
  vec3 lit = lakeAmb * 1.4 + lakeMoonLight * 0.5 + lakeAurLight * 1.2;
  if (chimney) {
    col = vec3(0.1, 0.095, 0.09) * (lit * 2.0 + 0.01);
  } else if (roof) {
    col = p.y < 2.4 ? vec3(0.025, 0.02, 0.018) : LAKE_SNOW * lit * 1.9 * (0.9 + 0.1 * vnoise(vec2(p.x * 3.0, p.y * 2.0)));
  } else {
    col = vec3(0.07, 0.045, 0.03) * (0.8 + 0.2 * smoothstep(0.3, 0.45, fract(p.y / 0.45))) * (lit * 2.2 + 0.02);
    if (abs(p.x - 0.9) < 0.42 && p.y < 1.9) col = vec3(0.02, 0.015, 0.012);
    if (abs(p.x + 1.1) < 0.5 && abs(p.y - 1.3) < 0.4) {
      float fire = 0.9 + 0.06 * sin(lakeTm * 0.9) + 0.04 * sin(lakeTm * 2.3 + 1.0);
      col = LAKE_WINDOW * 1.5 * fire * (1.0 - 0.15 * smoothstep(0.0, 0.4, p.y - 1.3));
    }
    if (p.y < 0.35 + 0.25 * vnoise(vec2(p.x * 2.0, 3.0))) col = LAKE_SNOW * lit * 1.8;
  }
  return true;
}

// Smoke from the chimney: it rises through the still, cold air, leaning downwind, until it meets
// the inversion some 24 m up and spreads along under it. p: metres across from the chimney and up
// from its top. Its path is x = drift s, y = lid (1 - e^(-s / lid)) after s metres of travel; a
// point finds its s from its height while the plume climbs, from its distance across once it has
// levelled. Returns its thickness 0..1, puffs riding up and along it.
float lakeSmoke(vec2 p) {
  float drift = 0.04 + 0.55 * K_wind;
  if (p.y < -0.3 || p.y > 30.0 || abs(p.x) > 8.0 + 120.0 * abs(drift)) return 0.0;
  const float lid = 24.0;
  float sLevel = lid * log(1.0 / max(abs(drift), 0.02));
  float sUp = -lid * log(1.0 - clamp(p.y, 0.0, lid * 0.98) / lid);
  float sAcross = p.x / (abs(drift) < 1e-4 ? 1e-4 : drift);
  float s = sUp;
  float off = p.x - drift * sUp;
  if (sUp >= sLevel && sAcross >= sLevel) {
    s = sAcross;
    off = p.y - lid * (1.0 - exp(-sAcross / lid));
  }
  float w = 0.35 + 0.16 * pow(s, 0.85);
  float r = off / w;
  float puffs = 0.45 + 0.55 * vnoise(vec2(s * 0.3 - lakeTm * 0.4, r * 0.7 + 3.0));
  return exp(-r * r) * puffs * exp(-s / 70.0) * smoothstep(-0.3, 0.6, p.y);
}

// What a ray sees beyond the ice, from o (the eye, or a point on the ice for its mirror) along d:
// the snowbank at the waterline, the cabin and the point's grove, the far forest (dark all the way
// back below the horizon, where the ray dips into it), the hills and mountains, all a little lost in
// the haze, and the sky; the chimney's smoke over them (not in the mirror, where it would be lost
// in the roughness); and the birds in front of the far land (the shared birds; off by default):
// geese by default, a skein migrating through the night, dark against the aurora and grey against
// the dark sky where the snow below lights their undersides, mirrored by the ice as the eye
// reflected under it sees them, behind the cabin and the point's grove; few fly in snow.
vec3 lakeBeyond(vec3 o, vec3 d, bool mirror, float soft) {
  float hl = length(d.xz);
  float az = atan(d.x, d.z) + lakePar;
  float slope = d.y / hl;
  float r0 = length(o.xz);
  vec3 col = vec3(0.0);
  float hazy = -1.0; // how far the land is lost in the haze; < 0: no land, the sky
  if (slope < 0.25) {
    float zFar = lakeFarShore(az);
    float zPoint = lakePointShore(az);
    float zs = min(zFar, zPoint);
    vec2 cp = vec2((az - lakeCabinAz) * LAKE_CABIN_Z, o.y + slope * (LAKE_CABIN_Z - r0) - LAKE_BANK);
    if (o.y + slope * (zs - r0) < LAKE_BANK * (0.6 + 0.6 * vnoise(vec2(az * 70.0, 1.0)))) {
      // The snowbank, warm under the window.
      float under = cp.x + 1.1;
      col = LAKE_SNOW * (lakeAmb * 2.2 + lakeMoonLight * 0.8 + lakeAurLight * 1.8) * 0.85 + LAKE_WINDOW * 0.3 * exp(-under * under / 6.0) * K_cabin;
      hazy = 0.2;
    } else if (zPoint < zFar && K_cabin > 0.5 && abs(cp.x) < 3.2 && lakeCabin(cp, col)) {
      hazy = 0.1;
    } else if (zPoint < zFar && (lakeSpruces(az, o, r0, slope, zs, 6.0, 0.04, 15.0, true, 3.0, col)
                              || lakeSpruces(az, o, r0, slope, zs, 16.0, 0.045, 18.0, true, 5.0, col))) {
      hazy = 0.12;
    } else if (slope < 0.12 && (lakeSpruces(az, o, r0, slope, zFar, 4.0, 0.016, 19.0, false, 7.0, col)
                             || lakeSpruces(az, o, r0, slope, zFar, 14.0, 0.021, 21.0, false, 9.0, col))) {
      hazy = 0.2;
    } else if (slope < 0.0) {
      col = vec3(0.012, 0.02, 0.019) + lakeAmb * 0.1;
      hazy = 0.25;
    } else if (slope < 0.08 && slope < lakeHills(az)) {
      // Forested hills, dark, with snowy clearings.
      float clearing = smoothstep(0.55, 0.75, vnoise(vec2(az * 90.0, slope * 600.0)));
      vec3 snow = LAKE_SNOW * (lakeAmb * 1.5 + lakeMoonLight * 0.6 + lakeAurLight * 1.2) * 0.7;
      col = mix(vec3(0.014, 0.022, 0.026), snow, clamp(0.5 * clearing + 0.3 * uWeather.y, 0.0, 1.0));
      hazy = 0.35;
    } else if (slope < 0.08 && slope < lakePeaks(az)) {
      // Snowy mountains, the faces turned toward the moon (on the right) brighter, rock showing
      // through on the steeps, gullies streaking down.
      float face = (lakePeaks(az + 0.004) - lakePeaks(az - 0.004)) / 0.008;
      float toMoon = clamp(0.5 - face * 4.0, 0.0, 1.0);
      float gully = vnoise(vec2(az * 140.0, slope * 260.0));
      vec3 snow = LAKE_SNOW * (lakeAmb * 1.4 + lakeMoonLight * (0.3 + toMoon) + lakeAurLight * 1.6) * (0.75 + 0.25 * gully);
      float rock = smoothstep(0.62, 0.8, vnoise(vec2(az * 60.0, slope * 900.0))) * 0.6;
      col = mix(snow, vec3(0.02, 0.025, 0.035), rock);
      hazy = 0.5;
    }
  }
  if (hazy < 0.0) col = lakeSkyAt(vec3(sin(az) * hl, d.y, cos(az) * hl), mirror, soft);
  else col = mix(col, horizonHaze(lakeSky, vec3(sin(az), 0.0, cos(az)), 0.03), hazy);
  if (!mirror && K_cabin > 0.5) {
    vec2 sp = vec2((az - lakeCabinAz) * LAKE_CABIN_Z - 1.5, o.y + slope * (LAKE_CABIN_Z - r0) - LAKE_BANK - 5.0);
    float smoke = lakeSmoke(sp);
    if (smoke > 0.0) {
      vec3 lit = lakeAmb * 2.0 + lakeMoonLight * 0.9 + lakeAurLight * 1.6 + LAKE_WINDOW * 0.15 * exp(-max(sp.y, 0.0) / 3.0);
      col = mix(col, lit, smoke * 0.5);
      lakeAccent *= 1.0 - smoke * 0.5;
    }
  }
  if (K_birds > 0.0 && d.z > 0.05 && (hazy < 0.0 || hazy > 0.15)) {
    vec2 q = vec2(tan(az) * LAKE_FOCAL, LAKE_HORIZON + d.y / d.z * LAKE_FOCAL);
    BirdCamera cam = BirdCamera(LAKE_HORIZON, LAKE_FOCAL, LAKE_EYE, 1.0, 3.0);
    BirdSky flights = birdSky(K_birds * smoothfall(0.7, 0.3, K_snow), K_birdKind, K_birdFormation - 1.0, vec2(60.0, 450.0), vec2(LAKE_HORIZON + 0.05, 0.95), vec2(K_iceSeed * 0.37, 6.1));
    BirdHit bird = birdFlightsSeen(q, flights, cam, lakeTm, 1.0 / uRes.y, mirror);
    if (bird.cover > 0.5) {
      vec3 under = LAKE_SNOW * (lakeAmb * 2.4 + lakeMoonLight * 0.9 + lakeAurLight * 1.8) * 0.3;
      col = mix(bird.albedo * (lakeAmb * 1.5 + lakeMoonLight * 0.6) + under, horizonHaze(lakeSky, vec3(sin(az), 0.0, cos(az)), 0.03), 1.0 - exp(-bird.depth / 1500.0));
      lakeAccent = 0.0;
    }
  }
  return col;
}

// Methane bubbles frozen into the ice, along the refracted ray rd from the surface at P (m): in
// each of five layers, flat white discs stacked over the seeps (one per LAKE_SEEP cell at most,
// seeps gathered in fields, each column leaning a little), and in the top two clouds of small
// ones. Deeper layers are fainter and bluer, and nearer layers hide what lies under them. Discs too
// small for a few cells fade out. footZ: the ice one cell spans along the view (m); light: the
// light that reaches into the ice. Returns the light they send back and how much they cover.
vec4 lakeBubbles(vec2 P, vec3 rd, float footZ, vec3 light) {
  if (K_bubbles <= 0.0 || footZ > 0.3) return vec4(0.0);
  vec2 run = rd.xz / -rd.y;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    vec2 q = P + run * LAKE_LAYER[k];
    vec3 tint = mix(vec3(1.0), vec3(0.5, 0.75, 1.0), fk * 0.25) * (1.0 - 0.14 * fk);
    vec2 g = q / LAKE_SEEP;
    vec2 id = floor(g);
    float h = hash12(id + 7.13);
    float field = smoothstep(0.3, 0.72, vnoise(id * 0.23 + 3.3));
    if (h < K_bubbles * (0.1 + 0.75 * field)) {
      float h2 = hash12(id + vec2(fk * 3.17, 1.7));
      if (h2 < 0.85) {
        vec2 c = 0.32 + 0.36 * vec2(hash12(id + 2.3), hash12(id + 5.9)) + fk * 0.022 * vec2(cos(h * 40.0), sin(h * 40.0));
        float rad = (0.06 + 0.13 * hash12(id + 11.7)) * (0.55 + 0.53 * h2) / LAKE_SEEP;
        vec2 v = g - id - c;
        float ang = atan(v.y, v.x);
        rad *= 1.0 + 0.08 * sin(3.0 * ang + h2 * 31.0) + 0.05 * sin(5.0 * ang + h * 17.0);
        float rho = length(v) / rad;
        float lod = smoothstep(0.8, 2.4, 2.0 * rad * LAKE_SEEP / footZ);
        if (rho < 1.0 && lod > 0.0) {
          // milky white, brightest at the rim, faint rings where it froze in steps
          float shade = 0.6 + 0.4 * smoothstep(0.45, 0.95, rho) + 0.06 * sin(rho * 18.0 + h2 * 9.0);
          float a = (1.0 - smoothstep(0.84, 1.0, rho)) * (0.92 - 0.1 * fk) * lod;
          acc += trans * a * shade * tint * light;
          trans *= 1.0 - a;
        }
      }
    }
    if (k < 2 && footZ < 0.05) {
      vec2 g2 = q / 0.28;
      vec2 id2 = floor(g2);
      float hs = hash12(id2 + vec2(fk * 5.3, 2.9));
      if (hs < K_bubbles * 0.5 * field) {
        vec2 c2 = 0.3 + 0.4 * vec2(hash12(id2 + 4.1), hash12(id2 + 8.3));
        float r2 = (0.012 + 0.024 * fract(hs * 37.0)) / 0.28;
        float rho2 = length(g2 - id2 - c2) / r2;
        float a2 = (1.0 - smoothstep(0.7, 1.0, rho2)) * 0.85 * smoothstep(1.0, 2.5, 2.0 * r2 * 0.28 / footZ);
        acc += trans * a2 * tint * light * 0.9;
        trans *= 1.0 - a2;
      }
    }
  }
  return vec4(acc, 1.0 - trans);
}

// How brightly the part of crack 'id' at 'arc' (0..1 along it) glows: behind a running front,
// fading with distance behind it and with time once the front has stopped.
float lakeGlow(float id, float arc) {
  vec4 st = texelFetch(uSim2, ivec2(int(id), 0), 0);
  float behind = st.x - arc;
  return st.y * step(-0.006, behind) * exp(-max(behind, 0.0) / max(st.z, 1e-4));
}

// Clear black ice at P (m), seen along dir: the mirror, the bubbles and fracture planes under the
// surface, the cracks at it, the moon's and the window's paths, hoarfrost, and a skin of snow
// ('dust') where a patch thins out. g: the ice under this pixel; fu, fv: its place in the field;
// near, ids: the crack field there (uSim0, uSim1).
vec3 lakeClearIce(Ground g, float fu, float fv, float range, vec3 dir, vec3 snowLight, float dust, vec4 near, vec4 ids, out float glow) {
  glow = 0.0;
  vec2 P = g.p;
  vec3 under = lakeAmb * 1.6 + lakeMoonLight * 0.7 + lakeAurLight * 1.6;

  // The mirror, tipped by the surface's long frozen undulations.
  float rough = mix(0.02, 0.003, K_mirror);
  vec2 tilt = vec2(vnoise(P * 0.35 + 3.0), vnoise(P * 0.35 + 9.0)) - 0.5;
  tilt += 0.5 * (vec2(vnoise(P * 1.3 + 5.0), vnoise(P * 1.3 + 1.0)) - 0.5) * (1.0 - smoothstep(0.1, 0.4, g.foot.y));
  vec3 n = normalize(vec3(-tilt.x * rough * 2.0, 1.0, -tilt.y * rough * 2.0));
  vec3 r = reflect(dir, n);
  r.y = max(r.y, 0.003);
  float refl = clamp(fresnelSchlick(dot(-dir, n), 0.018, 0.0) * (0.6 + 0.5 * K_mirror) + 0.12 * K_mirror, 0.0, 0.95);
  lakeAccent = 0.0;
  vec3 mirror = lakeBeyond(vec3(P.x, 0.0, P.y), r, true, rough * 1.5 + 0.004);
  glow += lakeAccent * refl;

  // Under the surface: black water, the bubbles.
  vec3 rd = refract(dir, vec3(0.0, 1.0, 0.0), 1.0 / LAKE_ICE_N);
  vec3 col = LAKE_WATER + under * 0.03;
  vec4 bubbles = lakeBubbles(P, rd, g.foot.y, under * 2.4);
  col = col * (1.0 - bubbles.a) + bubbles.rgb;

  // Cracks: the line at the surface, and the fracture plane of the crack above hanging into the
  // ice. This pixel's refracted ray reaches the plane's foot (its depth varying along the crack)
  // 'span' up the screen from here: it passes through the plane if that crack lies closer above.
  float line = 0.0;
  vec3 lineCol = vec3(0.0);
  float halo = 0.0;
  if (uSimOn.x > 0.5) {
    float far = smoothstep(0.006, 0.04, fv);
    float cells = near.r * LAKE_DIST * uRes.y;
    float idN = floor(ids.r * 255.0 + 0.5);
    float flash = uSimOn.z > 0.5 ? lakeGlow(idN, ids.g) : 0.0;
    float w = mix(0.5, 1.2, near.b) + 0.6 * flash;
    line = hardEdge((1.0 - smoothstep(w - 0.7, w + 0.7, cells)) * far * step(0.02, near.b));
    halo = flash * exp(-cells / 3.0) * far;
    lineCol = LAKE_SNOW * (under * 2.2 + lakeMoonLight * 0.5) * (0.55 + 0.45 * near.b) + LAKE_FLASH * flash * 0.9;
    if (idN > LAKE_MARK - 0.5) {
      // The M holds a little of the aurora's light.
      lineCol = mix(lineCol, lakeAurLow * (0.3 + 0.6 * flash), 0.5);
      glow += line * (0.6 + 0.4 * flash);
    }
    if (near.a > 0.02 && near.g < 0.999) {
      float idA = floor(ids.b * 255.0 + 0.5);
      float run = length(rd.xz) / -rd.y;
      float ahead = LAKE_FOCAL / length(vec2(fu, LAKE_FOCAL));
      float reach = LAKE_ICE_DEPTH * (0.3 + 0.7 * near.a) * (0.5 + 0.5 * vnoise(vec2(fu * 45.0, idA * 1.7)));
      float span = fv - LAKE_EYE * LAKE_FOCAL / (g.p.y + run * reach * ahead);
      float q = near.g * LAKE_ABOVE / max(span, 1e-5);
      if (q < 1.0) {
        float hackle = 0.5 + 0.5 * vnoise(vec2(fu * 150.0, q * 2.5 + idA));
        float plane = hardEdge((1.0 - smoothstep(0.75, 1.0, q)) * (0.6 + 0.4 * hackle) * far);
        float sung = uSimOn.z > 0.5 ? lakeGlow(idA, ids.a) : 0.0;
        vec3 sheet = under * mix(vec3(0.95, 1.0, 1.0), vec3(0.6, 0.8, 1.0), q) * (0.35 + 0.65 * pow(1.0 - q, 1.5)) * (0.5 + 0.5 * hackle) * (0.45 + 0.55 * near.a) * 1.8;
        sheet += LAKE_FLASH * sung * (1.0 - q) * 0.8;
        if (idA > LAKE_MARK - 0.5) {
          sheet = mix(sheet, lakeAurLow * dot(sheet, LUMA) * 1.4, 0.5);
          glow += plane * 0.3;
        }
        col = mix(col, sheet, plane * 0.85);
      }
    }
  }

  col = mix(col, mirror, refl);

  // The moon's path and the window's: the shared glint (waterGlint), the ice's facets tipped to
  // mirror each light toward the eye about the drawn surface, their slopes spread past what the
  // undulations draw by an rms of 5 rough + 0.012 (the rougher the ice, the wider and dimmer each
  // path), with single facets glinting in the moon's. The window's light falls off with the square
  // of its distance, so its path fades from the far shore toward us.
  vec3 view = -dir;
  float facets = (5.0 * rough + 0.012) * (5.0 * rough + 0.012);
  if (lakePhase > 0.0) {
    float path = waterGlint(n, view, lakeMoon, facets, LAKE_MOON_GLINT * (1.0 - lakeOver));
    float facet = hash12(floor(P * vec2(16.0, 5.0)) + 0.37);
    col += lakeMoonLight * (path + 1.6 * hardEdge(path * smoothstep(0.82, 0.97, facet)));
  }
  // The window, 1.3 m up on the cabin across the ice, 1.1 m left of its middle.
  if (K_cabin > 0.5) {
    float bearing = lakeCabinAz - 1.1 / LAKE_CABIN_Z - lakePar;
    vec3 toPane = vec3(sin(bearing) * LAKE_CABIN_Z - P.x, LAKE_BANK + 1.3, cos(bearing) * LAKE_CABIN_Z - P.y);
    col += LAKE_WINDOW * waterGlint(n, view, normalize(toPane), facets, LAKE_WINDOW_GLINT / dot(toPane, toPane));
  }

  // Hoarfrost: here and there a crystal on the bare ice catches the light.
  vec2 fc = floor(P / 0.06);
  float hf = hash12(fc + 5.3);
  if (hf > 0.985 && g.foot.x < 0.02) {
    vec2 c = (fc + 0.3 + 0.4 * vec2(fract(hf * 61.0), fract(hf * 83.0))) * 0.06;
    float dd = length((P - c) / max(g.foot, vec2(0.006)));
    col = mix(col, LAKE_SNOW * (under * 2.0 + lakeMoonLight * 0.8), hardEdge(1.0 - smoothstep(0.6, 1.6, dd)) * 0.8);
  }

  col = mix(col, LAKE_SNOW * snowLight * 0.7, dust);
  col = mix(col, lineCol, line);
  col += LAKE_FLASH * halo * 0.3;
  glow *= 1.0 - dust;
  return col;
}

// The snow lying on the ice under a pixel: the sim's patches (with crisp, world-anchored edges) and
// any snow that has fallen, except along the M's bare channel.
struct LakeSnow {
  Ground g;      // the ice under the pixel
  vec4 sn;       // the sim's snow there (uSim3): lying depth, drifting snow, loose share
  vec4 near;     // the crack field there (uSim0) and its ids (uSim1)
  vec4 ids;
  float fine;    // 1 while the ice's finer detail still resolves, 0 far off
  float th0;     // the depth at which the patches begin (K_cover)
  float amount;  // the sim's depth with its edge
  float lying;   // fallen snow (uWeather.y)
  float powder;  // how much of the surface is fresh powder (K_fresh, freshest where the sim's snow is loose)
  bool bare;     // in the M's channel
  float cover;   // 1 where snow covers this cell
};

LakeSnow lakeSnowAt(vec2 uv, float aspect) {
  LakeSnow s;
  s.g = planeAt(uv, aspect, LAKE_HORIZON, LAKE_EYE, LAKE_FOCAL);
  vec2 P = s.g.p;
  float fu = (uv.x - 0.5) * aspect;
  float fv = LAKE_HORIZON - uv.y;
  vec2 fuv = vec2(fu / (2.0 * LAKE_FU) + 0.5, fv / LAKE_FV);
  s.sn = uSimOn.w > 0.5 ? texture(uSim3, fuv) : vec4(0.0);
  float depth = s.sn.r * LAKE_SNOW_MAX;
  s.fine = 1.0 - smoothstep(0.05, 0.14, max(s.g.foot.x, s.g.foot.y));
  float edge = 0.62 * vnoise(P * vec2(0.9, 2.6)) + 0.38 * mix(0.5, vnoise(P * vec2(3.1, 7.3) + 4.0), s.fine);
  s.th0 = mix(1.0, 0.1, K_cover);
  s.amount = depth + (edge - 0.5) * 0.5 * smoothstep(0.0, 0.25, depth);
  s.lying = uWeather.y > 0.0 ? snowCover(vec3(0.0, 1.0, 0.0), P, uWeather.y) : 0.0;
  s.near = vec4(1.0, 1.0, 0.0, 0.0);
  s.ids = vec4(0.0);
  if (uSimOn.x > 0.5) {
    s.near = texture(uSim0, fuv);
    s.ids = texelFetch(uSim1, ivec2(clamp(fuv, vec2(0.0), vec2(0.9999)) * LAKE_FIELD), 0);
  }
  s.bare = s.ids.r * 255.0 > LAKE_MARK - 0.5 && s.near.r * LAKE_DIST * uRes.y < 4.0 + 2.0 * cellTh;
  s.powder = K_fresh * (0.65 + 0.35 * s.sn.b);
  // Powder feathers the patches' edges into a stipple, evenly either side of where they begin, so
  // about as much of the ice stays covered.
  float feather = 0.05 + 0.12 * s.powder;
  s.cover = s.bare ? 0.0 : max(hardEdge(smoothstep(s.th0 - feather, s.th0 + feather, s.amount)), hardEdge(s.lying));
  return s;
}

// The light of lying snow, as a share of the snow-lit white: packed snow carved by the wind into low
// ridges and darker where it lies thin, loose snow brighter; fresh powder smooths the ridges away,
// lies brighter still and stays white where it is thin.
float lakeSnowShade(LakeSnow s) {
  float ridges = vnoise(s.g.p * vec2(0.7, 3.4) + 1.3);
  float thin = smoothstep(s.th0, s.th0 + 0.35, max(s.amount, 2.0 * s.lying));
  float shade = (0.82 + 0.28 * ridges * (0.5 + 0.5 * s.fine) + 0.12 * s.sn.b) * mix(0.78, 1.0, thin);
  if (s.powder > 0.0) {
    float relief = mix(ridges, 0.5, 0.85 * s.powder);
    shade = (0.82 + 0.28 * relief * (0.5 + 0.5 * s.fine) + 0.12 * s.sn.b + 0.12 * s.powder) * mix(mix(0.78, 0.92, s.powder), 1.0, thin);
  }
  return shade;
}

// The ice under this pixel: the lying snow where it covers it, else clear ice; drifting snow
// streaming over everything, and the far ice greying into the haze at the far shore.
vec3 lakeIce(vec2 uv, float aspect, vec3 dir, float range, out float glow) {
  glow = 0.0;
  LakeSnow s = lakeSnowAt(uv, aspect);
  Ground g = s.g;
  vec2 P = g.p;
  float fu = (uv.x - 0.5) * aspect;
  float fv = LAKE_HORIZON - uv.y;
  vec3 snowLight = lakeAmb * 2.6 + lakeMoonLight * 0.9 + lakeAurLight * 2.2;
  float drift = s.sn.g * LAKE_DRIFT_MAX;

  vec3 col;
  if (s.cover > 0.5) {
    col = LAKE_SNOW * snowLight * lakeSnowShade(s);
    // A few crystals catching the moon, now and then; more in fresh powder.
    vec2 gc = floor(P / 0.05);
    float hg = hash12(gc + 9.1);
    if (hg > 0.975 - 0.035 * s.powder && g.foot.x < 0.016) {
      vec2 c = (gc + 0.3 + 0.4 * vec2(fract(hg * 57.0), fract(hg * 91.0))) * 0.05;
      float dd = length((P - c) / max(g.foot, vec2(0.004)));
      float twinkle = 0.55 + 0.45 * sin(lakeTm * (0.3 + 0.5 * fract(hg * 13.0)) + hg * 70.0);
      col = mix(col, LAKE_SNOW * (snowLight * 1.6 + lakeMoonLight * 2.0), hardEdge((1.0 - smoothstep(0.5, 1.4, dd)) * twinkle));
    }
  } else {
    // A dusting blown off the patches, wider round fresh powder.
    float dust = s.bare ? 0.0 : smoothstep(s.th0 - 0.45, s.th0, s.amount) * 0.45 * (1.0 + 0.6 * s.powder);
    col = lakeClearIce(g, fu, fv, range, dir, snowLight, dust, s.near, s.ids, glow);
  }

  // Drifting snow: long thin streamers riding downwind (the sim's offset), snaking across the
  // wind; where they would be finer than a few cells, their mean; and a low haze of blown snow,
  // thicker where the eye grazes more of it.
  if (drift > 0.004) {
    vec4 wd = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(1, 1), 0) : vec4(0.0);
    float xi = P.x - (wd.x + wd.y);
    float wave = (vnoise(vec2(xi * 0.15, 2.0 + lakeTm * 0.02)) - 0.5) * 1.8;
    float load = min(drift * 4.0, 1.0);
    float streams = smoothstep(0.56, 0.8, vnoise(vec2(xi * 0.21, P.y * 3.2 + wave * 3.0))) * load;
    float snake = mix(0.22 * load, streams, 1.0 - smoothstep(0.035, 0.09, g.foot.y));
    col = mix(col, LAKE_SNOW * snowLight * 1.05, hardEdge(snake) * 0.85);
    col = mix(col, LAKE_SNOW * snowLight * 0.85, clamp(drift * 0.6 * smoothstep(4.0, 60.0, range), 0.0, 0.4));
  }

  if (range > 40.0) {
    float far = smoothstep(40.0, 260.0, range) * 0.5;
    col = mix(col, horizonHaze(lakeSky, dir, 0.01) * 0.9 + lakeAurLight * 0.5, far);
    glow *= 1.0 - far;
  }
  return col;
}

// The camera arriving from the aurora: the share of the tilt still to go at progress p. It comes
// down from the sky already moving fast and settles a little past level and back, landing on
// exactly zero at rest.
float lakeArrive(float p) {
  float a = 1.0 - clamp(p, 0.0, 1.0);
  return a * a * a * (2.5 * a - 1.5);
}

// The camera leaving toward the aurora: the share of the tilt done at progress p, gathering pace
// once the gust has begun and still at full pace as the exit ends.
float lakeLeave(float p) {
  float q = clamp((p - 0.1) / 0.9, 0.0, 1.0);
  return q * q * q;
}

// A gust of blown snow, 0..1 at this uv (the camera's, tilt included): its head crosses the frame
// downwind at a steady pace from beyond its edge, and behind it low streamers ride the ice in rows
// of the screen, the nearer rows faster, thinning to nothing over the horizon; a haze of fine snow
// between them. Each row's streamers slide along it (no noise crawl); the caller cuts the density
// against the cell's threshold.
float lakeGust(vec2 uv, float aspect, float gp) {
  float fv = LAKE_HORIZON - uv.y;
  float uu = (K_wind < -0.05 ? -1.0 : 1.0) * (uv.x - 0.5) * aspect;
  float head = mix(-0.5 * aspect - 0.3, 0.5 * aspect + 1.2, gp);
  float behind = head - uu;
  float cover = smoothstep(0.0, 0.2, behind) * (1.0 - 0.45 * smoothstep(0.3, 1.8, behind));
  float low = fv >= 0.0 ? 1.0 : exp(fv / 0.06);
  float xs = uu - (0.5 + 3.0 * max(fv, 0.0)) * gp * LAKE_EXIT_S;
  float row = fv * 64.0;
  float n = 0.6 * vnoise(vec2(xs * 4.0, row)) + 0.4 * vnoise(vec2(xs * 11.0 + 7.0, row * 2.1 + 3.0));
  float streak = smoothstep(0.5, 0.75, n);
  return clamp(streak + 0.16, 0.0, 1.0) * cover * low;
}

// The night: twilight to deep night by K_hour, our moon, the aurora's colours and the sim's surge,
// the light on the land, overcast while it snows, the cabin's and the moon's bearings for the frame;
// over the fjord its camera and its moon; the drapes' strength, colours, corona and light.
void lakeSetup(float aspect) {
  lakeTm = uMotionTime;
  float hour = clamp(K_hour, 0.0, 1.0);
  Sky sky = skyAt(0.78 + 0.075 * hour * hour);
  float halfAz = atan(0.5 * aspect, LAKE_FOCAL);
  lakeCabinAz = -min(0.36, 0.72 * halfAz);
  lakeMoonAz = min(0.52, 0.75 * halfAz);
  lakeMoonEl = 0.15;
  lakeMoon = vec3(sin(lakeMoonAz) * cos(lakeMoonEl), sin(lakeMoonEl), cos(lakeMoonAz) * cos(lakeMoonEl));
#if LAKE_FJORD || LAKE_DRAPES
  lakeFocal = LAKE_FOCAL;
#endif
#if LAKE_FJORD
  if (K_setting > 0.5) {
    lakeFocal = LAKE_FJ_F;
    lakeMoon = normalize(vec3(LAKE_FJ_MOON.x * 0.5 * aspect, LAKE_FJ_MOON.y - LAKE_FJ_HZ, LAKE_FJ_F));
  }
#endif
  lakePhase = K_moon;
  lakeOver = K_snow > 0.0 ? weatherOvercast(0.0, K_snow) : 0.0;
  lakeMoonLight = vec3(0.40, 0.44, 0.54) * pow(lakePhase, 1.3) * 0.6 * (1.0 - 0.85 * lakeOver);
  // The library's moon rides elsewhere: take its light out and put ours in.
  vec3 amb = sky.ambient - sky.moonColor * 0.3;
  sky.moon = vec3(0.0, -1.0, 0.0);
  sky.moonColor = lakeMoonLight;
  lakeSky = sky;
  lakeMeteorAt = meteorAge(lakeTm, K_meteors, LAKE_METEOR_SLOT, lakeMeteorSeed);

  vec4 au = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(0, 1), 0) : vec4(1.0, uMotionTime, 0.0, 0.0);
  lakeSurge = au.w;
  lakeAurGain = K_aurora * au.x;
  lakeAurClock = au.y + au.z;
  lakeAurVis = mix(0.45, 1.0, sky.night) * (1.0 - 0.9 * lakeOver);
  lakeAurLow = lakeAuroraLowColour();
  lakeAurHigh = lakeAuroraHighColour();
  lakeAurLight = lakeAurLow * lakeAurGain * 0.05 * lakeAurVis;
#if LAKE_FJORD || LAKE_DRAPES
  lakeDrLow = lakeDrapeLowColour();
  lakeDrHigh = lakeDrapeHighColour();
  lakeDrFrom = lakeDrapeFrom();
  lakeDrTo = lakeDrapeTo();
  lakeDrGain = lakeDrapeGain();
#endif
#if LAKE_DRAPES
  lakeDrStrength = 0.0;
  if (K_drapes > 0.5) {
    lakeDrStrength = K_aurora * (1.0 + LAKE_SURGE_GAIN * lakeSurge);
    lakeDrAct = mix(K_activity, 1.0, lakeSurge);
    lakeDrHW = 0.5 * aspect * LAKE_FJ_F / lakeFocal;
    lakeCorona = lakeCoronaEnv();
    // Their light on the land, breathing with them; a share of it while they are furled.
    float furled = lakeDrapesPassage();
    lakeAurLight = lakeDrLow * lakeDrStrength * 0.075 * lakeAurVis * (0.92 + 0.08 * sin(lakeAurClock * 0.11)) * furled;
  }
#endif
  lakeAmb = greyed(amb, vec3(0.92, 0.95, 1.0), 0.6 * lakeOver) + lakeAurLight + lakeMoonLight * 0.25;
  lakePar = uPointer.x * 0.012;
}

#if LAKE_FJORD
// ---- The fjord (K_setting 1) ----

const float LAKE_FJ_EYE = 1.7; // metres above the water
const vec3 LAKE_FJ_WALL = vec3(0.80, 0.12, 0.08);
const float LAKE_FJ_CS = 2.0;     // the cabin's size: its own units times this
const float LAKE_FJ_FOOT = 0.014; // its foot above the waterline, on a small knoll of snow
// The glints on the open water (waterGlint): the slope variance of the calm fjord's ripples finer
// than any drawn, and the exposures of the cabin's window and of the moon (per unit of its phase),
// set so their paths down the rows that mirror them are as bright at half their height as the
// hand-drawn paths they replace.
const float LAKE_FJ_CALM = 0.005;
const float LAKE_FJ_WINDOW_GLINT = 0.0035;
const float LAKE_FJ_MOON_GLINT = 0.0225;

// Set once per pixel by lakeFjord.
float lakeFjPx;          // one dither cell, in screen heights
float lakeFjSx;          // 1 on a wide frame, less on a narrow one: the near bank and trees shrink with it
float lakeFjCabinX;      // the cabin's place along the far shore
vec3 lakeFjHaze;         // the air above the far shore
float lakeFjTilt;        // passage: the camera's tilt up from rest, in screen heights (0 at rest)
float lakeFjSmokeFront;  // passage: how far up the chimney smoke has climbed (1 at rest)

// Far snowy mountains and the nearer wooded hills, as heights above the horizon (screen heights).
float lakeFjPeaks(float x) {
  float xs = x * 1.35 + 3.0;
  float r = 1.0 - abs(2.0 * vnoise(vec2(xs * 1.5, 1.0)) - 1.0);
  float r2 = 1.0 - abs(2.0 * vnoise(vec2(xs * 4.2 + 2.0, 3.0)) - 1.0);
  return 0.03 + 0.17 * (0.7 * r * sqrt(r) + 0.3 * r2 * r);
}

float lakeFjHills(float x) {
  float lower = 1.0 - 0.8 * K_cabin * bell((x - lakeFjCabinX) / 0.3);
  float n = 0.6 * vnoise(vec2(x * 3.2 + 9.0, 4.0)) + 0.4 * vnoise(vec2(x * 8.5 + 1.0, 6.0));
  return (0.012 + 0.05 * n) * lower;
}

// A mountain face y above the horizon: snow lit by the moon on the faces that turn toward it (left),
// by the aurora everywhere, rock showing on the steeps, gullies streaking down, haze at its foot.
vec3 lakeFjPeakColour(vec2 q, float y) {
  float slope = (lakeFjPeaks(q.x + 0.006) - lakeFjPeaks(q.x - 0.006)) / 0.012;
  float toMoon = clamp(0.5 + 1.1 * slope, 0.0, 1.0);
  float gully = vnoise(vec2(q.x * 85.0, y * 28.0));
  vec3 light = lakeAmb * 2.6 + lakeMoonLight * (0.25 + 1.1 * toMoon) + lakeAurLight * 1.8;
  vec3 snow = LAKE_SNOW * light * (0.70 + 0.30 * gully);
  float steep = clamp(abs(slope) * 1.2, 0.0, 1.0);
  float rock = smoothstep(0.64, 0.82, vnoise(vec2(q.x * 46.0, y * 70.0))) * 0.7 * steep;
  vec3 col = mix(snow, vec3(0.025, 0.03, 0.04) + lakeAmb * 0.15, rock);
  return mix(col, lakeFjHaze, 0.1 + 0.45 * (1.0 - smoothstep(0.0, 0.09, y)));
}

vec3 lakeFjHillColour(vec2 q, float y) {
  float clearing = smoothstep(0.55, 0.75, vnoise(vec2(q.x * 50.0, y * 120.0)));
  vec3 light = lakeAmb * 1.5 + lakeMoonLight * 0.6 + lakeAurLight * 1.2;
  vec3 snow = LAKE_SNOW * light * 0.7;
  vec3 wood = vec3(0.010, 0.018, 0.022) + lakeAmb * 0.10;
  return mix(mix(wood, snow, clamp(0.40 * clearing + 0.35 * uWeather.y, 0.0, 1.0)), lakeFjHaze, 0.30);
}

// A row of spruces along the far shore, snow on every tier, left bare around the cabin.
bool lakeFjTreeline(vec2 q, out vec3 col) {
  col = vec3(0.0);
  float y = q.y - LAKE_FJ_HZ;
  if (y > 0.036) return false;
  float cell = 0.013;
  float k0 = floor(q.x / cell);
  for (int i = -1; i <= 1; i++) {
    float k = k0 + float(i);
    float h = hash12(vec2(k, 4.0));
    float h2 = hash12(vec2(k, 9.0));
    float cx = (k + 0.5 + 0.7 * (h2 - 0.5)) * cell;
    float clear = 1.0 - K_cabin * (1.0 - smoothstep(0.08, 0.14, abs(cx - lakeFjCabinX)));
    float ht = (0.009 + 0.026 * h * h) * clear;
    if (ht < 0.004) continue;
    float v = y / ht;
    if (v < 0.0 || v > 1.0) continue;
    float tier = fract(v * 4.0 + h * 3.0);
    float hw = 0.2 * ht * (1.0 - v) * (0.8 + 0.2 * tier) + 0.0012;
    if (abs(q.x - cx) < hw) {
      vec3 needles = vec3(0.010, 0.020, 0.022) + lakeAmb * 0.10;
      vec3 lit = LAKE_SNOW * (lakeAmb * 1.6 + lakeMoonLight * 0.6 + lakeAurLight * 1.4) * 0.8;
      float snowy = smoothstep(0.6, 0.95, tier);
      col = mix(mix(needles, lit, clamp(0.7 * snowy + 0.5 * uWeather.y, 0.0, 1.0)), lakeFjHaze, 0.15);
      return true;
    }
  }
  return false;
}

// The snowbank along the far waterline, swelling into a knoll under the cabin.
float lakeFjShoreTop(float x) {
  return 0.0045 + 0.003 * vnoise(vec2(x * 90.0, 1.0)) + 0.012 * K_cabin * bell((x - lakeFjCabinX) / 0.26);
}

// Four small birches beside the cabin: a pale trunk and a bare crown of twigs.
bool lakeFjFarBirches(vec2 q, out vec3 col) {
  col = vec3(0.0);
  float y = q.y - LAKE_FJ_HZ;
  if (y < 0.0 || y > 0.14) return false;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float bx = lakeFjCabinX + (fi < 1.5 ? (fi < 0.5 ? -0.15 : -0.19) : (fi < 2.5 ? 0.14 : 0.18));
    float ht = 0.070 + 0.025 * hash12(vec2(fi, 8.1));
    float dx = q.x - bx;
    if (abs(dx) < 0.0034 && y < ht) {
      col = mix(LAKE_SNOW * (lakeAmb * 2.8 + lakeMoonLight + lakeAurLight * 2.0) * 0.9, lakeFjHaze, 0.1);
      return true;
    }
    vec2 e = vec2(dx / 0.028, (y - ht * 0.78) / 0.036);
    float rr = length(e);
    if (rr < 1.0) {
      float n = vnoise(vec2(q.x * 320.0 + fi * 9.0, q.y * 220.0));
      if (n * (0.35 + 0.9 * (1.0 - rr)) > 0.58) {
        col = mix(vec3(0.05, 0.03, 0.04) + lakeAmb * 0.2, lakeFjHaze, 0.2);
        return true;
      }
    }
  }
  return false;
}

// The red cabin: plank walls, a snow-laden gable roof with dark eaves, a stone chimney, a door and
// one window lit by the fire. p: screen heights across from its middle and up from its foot.
bool lakeFjCabin(vec2 p, out vec3 col) {
  col = vec3(0.0);
  float ax = abs(p.x);
  float roofTop = 0.029 + 0.027 * (1.0 - ax / 0.039);
  bool wall = ax < 0.031 && p.y > 0.0 && p.y < 0.029;
  bool roof = ax < 0.039 && p.y >= 0.027 && p.y < roofTop;
  bool chimney = abs(p.x - 0.0165) < 0.0042 && p.y > 0.03 && p.y < 0.058;
  if (!(wall || roof || chimney)) return false;
  vec3 lit = lakeAmb * 1.4 + lakeMoonLight * 0.5 + lakeAurLight * 1.2;
  vec3 snowLit = LAKE_SNOW * (lakeAmb * 2.8 + lakeMoonLight * 0.9 + lakeAurLight * 2.0);
  if (chimney) {
    col = vec3(0.10, 0.09, 0.09) * (lit * 2.0 + 0.02);
    if (p.y > 0.0545) col = snowLit * 0.9;
  } else if (roof) {
    col = snowLit * (0.9 + 0.1 * vnoise(vec2(p.x * 300.0, p.y * 200.0)));
    if (p.y < 0.0305 || roofTop - p.y < 0.0018) col = vec3(0.05, 0.04, 0.04) * (lit * 2.0 + 0.02);
  } else {
    float board = fract(p.y / 0.006);
    col = LAKE_FJ_WALL * (lit * 2.6 + vec3(0.09, 0.05, 0.05)) * (board > 0.8 ? 0.65 : 1.0);
    vec2 wq = p - vec2(-0.011, 0.0155);
    float glow = exp(-length(wq) / 0.012);
    if (abs(wq.x) < 0.0068 && abs(wq.y) < 0.0075) {
      float fire = 0.95 + 0.03 * sin(lakeTm * 0.9) + 0.02 * sin(lakeTm * 2.3 + 1.0);
      col = LAKE_WINDOW * 1.5 * fire;
      if (abs(wq.x) < 0.0006 || abs(wq.y) < 0.0006) col = vec3(0.30, 0.10, 0.05);
    } else if (abs(wq.x) < 0.0082 && abs(wq.y) < 0.0092) {
      col = snowLit * 0.55;
    } else {
      col += LAKE_WINDOW * 0.10 * glow;
    }
    if (abs(p.x - 0.017) < 0.0045 && p.y < 0.0115) col = vec3(0.10, 0.04, 0.03) * (lit * 2.0 + 0.04);
    if (p.y < 0.003 + 0.005 * uWeather.y) col = snowLit * 0.9;
  }
  return true;
}

// Smoke from the chimney: a thread climbing slowly, leaning with the wind and swaying, widening and
// thinning as it goes. Thickness 0..1.
float lakeFjSmoke(vec2 q) {
  float s = q.y - (LAKE_FJ_HZ + LAKE_FJ_FOOT + 0.058 * LAKE_FJ_CS);
  if (s < -0.003 || s > 0.36) return 0.0;
  float lean = (0.04 + 0.45 * K_wind) * s;
  float sway = (0.008 * sin(s * 21.0 - lakeTm * 0.30) + 0.004 * sin(s * 47.0 - lakeTm * 0.45 + 1.0)) * smoothstep(0.0, 0.12, s);
  float xc = lakeFjCabinX + 0.0165 * LAKE_FJ_CS + lean + sway;
  float w = 0.005 + 0.09 * max(s, 0.0);
  float r = (q.x - xc) / w;
  if (abs(r) > 2.5) return 0.0;
  float puffs = 0.45 + 0.55 * vnoise(vec2(s * 20.0 - lakeTm * 0.20, r * 0.8 + 3.0));
  float sm = exp(-r * r) * puffs * (1.0 - smoothstep(0.12, 0.36, s)) * smoothstep(-0.003, 0.012, s);
  // On the way in the thread climbs from the chimney: a front rising through it, cut per cell.
  if (lakeFjSmokeFront < 1.0) sm *= 1.0 - smoothstep(0.40 * lakeFjSmokeFront - 0.04, 0.40 * lakeFjSmokeFront, s);
  return sm;
}

// Everything beyond the water, at screen point q at or above the horizon (mirror: reflected): the
// cabin, its birches, the far treeline and snowbank, the hills and the mountains, else the lake's
// sky along the camera's ray; the smoke over them; and the birds in front of it (the shared birds;
// off by default): geese by default, a skein migrating across the night, dark against the aurora and
// grey against the dark sky where the snow below lights their undersides, mirrored in the water as
// the camera reflected under it sees them; few fly in snow.
vec3 lakeFjFar(vec2 q, bool mirror) {
  float y = q.y - LAKE_FJ_HZ;
  vec3 col = vec3(0.0);
  vec3 c2;
  if (K_cabin > 0.5 && abs(q.x - lakeFjCabinX) < 0.04 * LAKE_FJ_CS && y < 0.07 * LAKE_FJ_CS + LAKE_FJ_FOOT && lakeFjCabin((q - vec2(lakeFjCabinX, LAKE_FJ_HZ + LAKE_FJ_FOOT)) / LAKE_FJ_CS, c2)) {
    col = c2;
  } else if (lakeFjFarBirches(q, c2)) {
    col = c2;
  } else if (lakeFjTreeline(q, c2)) {
    col = c2;
  } else if (y < lakeFjShoreTop(q.x)) {
    // The snowbank at the waterline, warm in the light of the window.
    float dxw = q.x - (lakeFjCabinX - 0.011 * LAKE_FJ_CS);
    col = LAKE_SNOW * (lakeAmb * 2.8 + lakeMoonLight * 0.9 + lakeAurLight * 2.0) * 0.85 + LAKE_WINDOW * 0.55 * K_cabin * exp(-dxw * dxw / 0.004);
    col = mix(col, lakeFjHaze, 0.2);
  } else if (y < lakeFjHills(q.x)) {
    col = lakeFjHillColour(q, y);
  } else if (y < lakeFjPeaks(q.x)) {
    col = lakeFjPeakColour(q, y);
  } else {
    col = lakeSkyAt(normalize(vec3(q.x, y, LAKE_FJ_F)), mirror, 0.0);
  }
  if (K_cabin > 0.5) {
    float sm = lakeFjSmoke(q);
    if (sm > 0.0) {
      vec3 sc = LAKE_SNOW * (lakeAmb * 3.2 + lakeMoonLight + lakeAurLight * 2.0)
              + LAKE_WINDOW * 0.18 * exp(-max(q.y - (LAKE_FJ_HZ + LAKE_FJ_FOOT + 0.058 * LAKE_FJ_CS), 0.0) / 0.05);
      col = mix(col, sc, 0.8 * hardEdge(sm));
    }
  }
  if (K_birds > 0.0) {
    BirdCamera cam = BirdCamera(LAKE_FJ_HZ, LAKE_FJ_F, LAKE_FJ_EYE, 1.0, 3.0);
    BirdSky flights = birdSky(K_birds * smoothfall(0.7, 0.3, K_snow), K_birdKind, K_birdFormation - 1.0, vec2(60.0, 420.0), vec2(LAKE_FJ_HZ + 0.06, 0.95), vec2(2.9, 4.3));
    BirdHit bird = birdFlightsSeen(q, flights, cam, lakeTm, lakeFjPx, mirror);
    if (bird.cover > 0.5) {
      vec3 under = LAKE_SNOW * (lakeAmb * 2.4 + lakeMoonLight * 0.9 + lakeAurLight * 1.8) * 0.3;
      col = mix(bird.albedo * (lakeAmb * 1.5 + lakeMoonLight * 0.6) + under, lakeFjHaze, 1.0 - exp(-bird.depth / 1500.0));
      lakeAccent = 0.0;
    }
  }
  return col;
}

// The water at screen point p below the horizon: the far world mirrored (the ray's reach grows as
// 1 / h below the horizon, so ripples are laid out in that depth and fade out where they would be
// finer than a cell), dimmer the nearer it lies; with the ripples knob, cat's-paws of wind ripples
// streaking it; the window's light and the moon's drawn down it; and, as the ice knob rises, plates
// of ice in it: static, dimmer mirrors, hairline cracks and patches of snow. range: metres to the
// water here.
vec3 lakeFjWater(vec2 p, out float range) {
  float h = max(LAKE_FJ_HZ - p.y, 0.002);
  range = LAKE_FJ_EYE * LAKE_FJ_F / h;
  vec2 g = vec2(p.x * 1.6 / (0.25 + 2.0 * h), log(0.04 + h) * 3.0);
  float iceMask = 0.0;
  if (K_ice > 0.0) {
    float nIce = fbm3(g * vec2(0.8, 1.0) + vec2(3.1, 7.7));
    iceMask = hardEdge(smoothstep(0.46, 0.54, nIce + (K_ice - 0.5) * 1.4));
  }
  vec2 P = vec2(p.x, 1.0) * (0.5 / h);
  float tm = lakeTm * (1.0 - iceMask);
  float fade1 = smoothstep(0.03, 0.12, h);
  float fade2 = smoothstep(0.08, 0.20, h);
  float w1 = vnoise(vec2(P.x * 0.7, P.y * 1.3 - tm * 0.05)) - 0.5;
  float w2 = vnoise(vec2(P.x * 2.1 + 4.0, P.y * 3.9 - tm * 0.08 + 6.0)) - 0.5;
  float amp = mix(0.05, 0.10, iceMask);
  float dy = amp * h * (w1 * fade1 + 0.5 * w2 * fade2);
  float dx = 0.02 * h * w2 * fade2;
  vec2 q = vec2(p.x + dx, max(LAKE_FJ_HZ + h + dy, LAKE_FJ_HZ + 0.0006));
  // A breeze on open water (the ripples knob, blowing with the wind): its ripples tip the mirror and
  // stretch what it shows into vertical streaks; the ripples too fine to draw smear it, each cell
  // looking a little up or down for the dither to average.
  vec4 rip = vec4(0.0);
  if (K_ripples > 0.0 && iceMask < 0.5) {
    rip = windRipples(planeAt(vec2(p.x / (2.0 * lakeFjHW) + 0.5, p.y), 2.0 * lakeFjHW, LAKE_FJ_HZ, LAKE_FJ_EYE, LAKE_FJ_F), lakeTm, K_wind, K_ripples);
    vec2 shift = windMirror(rip, h, LAKE_FJ_F) + vec2(0.0, (cellTh - 0.5) * 2.0 * windMirrorSpread(rip, LAKE_FJ_F));
    q = vec2(q.x + shift.x, max(q.y + shift.y, LAKE_FJ_HZ + 0.0006));
  }

  float low = exp(-h * 9.0);
  float fres = mix(0.55 + 0.35 * low, 0.22 + 0.22 * low, iceMask);
  lakeAccent = 0.0;
  vec3 refl = lakeFjFar(q, true);
  float reflAccent = lakeAccent;
  vec3 deep = vec3(0.003, 0.010, 0.017) + lakeAmb * 0.10;
  // Ice is pale blue-grey, lit by the whole sky and never black; the sky shows in it dimly.
  vec3 icePale = LAKE_SNOW * (lakeAmb * 3.4 + lakeMoonLight * 1.2 + lakeAurLight * 2.2) * 0.85 + vec3(0.05, 0.07, 0.10);
  vec3 col = mix(mix(deep, icePale, iceMask), refl * vec3(0.92, 0.96, 1.0) * 1.1, fres);
  col += lakeAurLight * 0.4 * (1.0 - iceMask);
  lakeAccent = reflAccent * fres;

  // The window's light and the moon's on the water (waterGlint), about the cat's-paws' slope, the
  // facets spread by the calm water's own roughness and the ripples too fine to draw, so each path
  // widens where the breeze crosses it; drawn down the water in slowly drifting bands, where the
  // long undulations turn the facets toward the light or away. Both lights stand far beyond the
  // water we see, so the same light reaches all of it. At the waterline the far shore's mirror
  // image takes over.
  vec3 view = -normalize(vec3(p.x, -h, LAKE_FJ_F));
  vec3 normal = normalize(vec3(-rip.x, 1.0, -rip.y));
  float facets = LAKE_FJ_CALM + rip.z;
  float bands = 0.35 + 0.65 * smoothstep(0.3, 0.75, vnoise(vec2(p.x * 24.0, P.y * 2.2 - tm * 0.07)));
  vec3 path = vec3(0.0);
  if (K_cabin > 0.5) {
    vec3 pane = normalize(vec3(lakeFjCabinX - 0.011 * LAKE_FJ_CS, LAKE_FJ_FOOT + 0.0155 * LAKE_FJ_CS, LAKE_FJ_F));
    path += LAKE_WINDOW * waterGlint(normal, view, pane, facets, LAKE_FJ_WINDOW_GLINT);
  }
  if (lakePhase > 0.0)
    path += vec3(0.80, 0.85, 0.95) * waterGlint(normal, view, lakeMoon, facets, LAKE_FJ_MOON_GLINT * lakePhase * (1.0 - 0.7 * lakeOver));
  col += path * bands * smoothstep(0.004, 0.03, h) * mix(1.0, 0.35, iceMask);

  if (iceMask > 0.5) {
    // Soft drifts: a wide, stippled transition between bare ice and snow.
    float sn = fbm3(g * vec2(0.9, 1.5) + vec2(11.0, 2.0));
    float th = 0.62 - 0.25 * uWeather.y - 0.05 * K_ice;
    float snow = hardEdge(smoothstep(th - 0.2, th + 0.2, sn));
    float crackN = vnoise(g * vec2(1.7, 2.3) + 4.0);
    float crack = hardEdge(1.0 - smoothstep(0.0, 0.03, abs(crackN - 0.5))) * smoothstep(0.04, 0.10, h);
    col = mix(col, icePale * 0.5, crack * 0.7);
    vec3 snowCol = mix(icePale * 1.25 * (0.9 + 0.1 * vnoise(g * 9.0)), lakeFjHaze, 0.4 * (1.0 - smoothstep(0.0, 0.1, h)));
    col = mix(col, snowCol, snow * 0.9);
    lakeAccent *= 1.0 - 0.7 * snow;
  }
  return col;
}

// The ground the camera stands on: a snowbank in each lower corner.
float lakeFjBankTop(float x) {
  float ul = (x + lakeFjHW) / (0.62 * lakeFjSx);
  float ur = (x - lakeFjHW) / (0.5 * lakeFjSx);
  float n = 1.0 + 0.3 * (vnoise(vec2(x * 6.0 + 3.0, 2.0)) - 0.5);
  return (0.13 * exp(-ul * ul) + 0.07 * exp(-ur * ur)) * n - 0.012;
}

// A near birch rooted at (bx, by): a pale trunk, tapering, leaning a little and swaying in its line,
// with dark lenticels; five bare branches that end in a drooping crown of fine twigs (vertical
// strands cut from static noise, so nothing about them moves). w0: the trunk's half width at its foot.
bool lakeFjBirch(vec2 p, float bx, float by, float w0, float sd, out vec3 col) {
  col = vec3(0.0);
  float yy = p.y - by;
  if (yy < 0.0 || abs(p.x - bx) > 0.36) return false;
  float lean = (fract(sd * 3.7) - 0.5) * 0.10;
  float ht = 1.05 - by;
  vec3 bark = LAKE_SNOW * (lakeAmb * 3.0 + lakeMoonLight * 1.2 + lakeAurLight * 2.2);
  float xc = bx + lean * yy + 0.010 * sin(yy * 3.4 + sd * 7.0);
  float w = w0 * mix(1.0, 0.45, clamp(yy / ht, 0.0, 1.0));
  float dx = p.x - xc;
  if (abs(dx) < w + lakeFjPx && hardFill(abs(dx) - w, lakeFjPx * 0.8) > 0.5) {
    float row = floor(yy * 45.0);
    float hh = hash12(vec2(row, sd));
    float mx = hash12(vec2(row, sd + 3.0)) * 1.6 - 0.8;
    float mark = step(0.55, hh) * step(abs(fract(yy * 45.0) - 0.5), 0.16) * step(abs(dx / w - mx), 0.5);
    float shade = 0.55 + 0.45 * clamp(0.5 - 0.5 * dx / w, 0.0, 1.0);
    col = mix(bark * shade, vec3(0.03, 0.025, 0.03) + lakeAmb * 0.2, mark);
    return true;
  }
  for (int j = 0; j < 5; j++) {
    float fj = float(j);
    float h1 = hash12(vec2(fj * 3.7 + sd * 11.0, 1.3));
    float h2 = hash12(vec2(fj * 5.1 + sd * 7.0, 2.9));
    float yb = 0.20 + 0.13 * fj + 0.03 * h1;
    float side = mod(fj + floor(sd), 2.0) < 0.5 ? 1.0 : -1.0;
    float ang = 0.45 + 0.4 * h2;
    float len = 0.05 + 0.05 * h1;
    float xb = bx + lean * yb + 0.010 * sin(yb * 3.4 + sd * 7.0);
    vec2 a = vec2(xb, by + yb);
    vec2 b = a + len * vec2(side * sin(ang), cos(ang));
    // A short branch angled up from the trunk...
    float dB = sdTaperCapsule(p, a, b, w0 * 0.28, 0.0012);
    if (hardFill(dB, lakeFjPx * 0.8) > 0.5) {
      col = vec3(0.05, 0.035, 0.04) + lakeAmb * 0.3;
      return true;
    }
    // ...and from its tip a drooping mass of fine twigs, soft dark lace: vertical strands and
    // finer breakup cut from static noise, densest in the middle and thinning to the edge.
    vec2 cc = b + vec2(side * 0.012, -0.045);
    float rr = length((p - cc) / vec2(0.07, 0.115));
    if (rr < 1.0) {
      float strands = vnoise(vec2(p.x * 170.0 + fj * 9.0 + sd * 31.0, p.y * 38.0 + fj));
      float lace = vnoise(vec2(p.x * 80.0 + sd * 5.0, p.y * 90.0 + fj * 3.0));
      float dens = (0.6 * strands + 0.4 * lace) * (0.35 + 1.3 * (1.0 - rr));
      if (dens > 0.58) {
        vec3 twig = vec3(0.06, 0.035, 0.045) + lakeAmb * 0.3;
        col = mix(twig, bark * 0.45, 0.35 * smoothstep(0.7, 0.9, dens) + 0.5 * uWeather.y * step(0.5, fract(lace * 37.0)));
        return true;
      }
    }
  }
  return false;
}

// The near bank and its birches, over everything: rgb and cover; depth: for the snow in the air.
vec4 lakeFjForeground(vec2 p, out float depth) {
  depth = weatherDepth(3.5);
  float top = lakeFjBankTop(p.x);
  if (p.y < top) {
    float below = clamp((top - p.y) / 0.12, 0.0, 1.0);
    float grain = vnoise(vec2(p.x * 24.0, p.y * 80.0));
    vec3 col = LAKE_SNOW * (lakeAmb * 3.2 + lakeMoonLight * 1.2 + lakeAurLight * 2.4) * (0.78 + 0.18 * grain - 0.2 * below);
    return vec4(col, 1.0);
  }
  float ax = -lakeFjHW + 0.09 * lakeFjSx;
  float bx = -lakeFjHW + 0.30 * lakeFjSx;
  float cx = lakeFjHW - 0.05;
  vec3 bc;
  if (lakeFjBirch(p, ax, lakeFjBankTop(ax) - 0.025, 0.022, 1.0, bc)
   || lakeFjBirch(p, bx, lakeFjBankTop(bx) - 0.025, 0.0145, 2.0, bc)
   || lakeFjBirch(p, cx, lakeFjBankTop(cx) - 0.025, 0.016, 3.0, bc)) {
    return vec4(bc, 1.0);
  }
  return vec4(0.0);
}

// The fjord's passage: on the way in the camera comes down from the stars already moving and
// settles on the fjord (a touch of overshoot), and the cabin's smoke then climbs; on the way out it
// lifts to the stars, ever faster. Both rest at their rest values (tilt 0, smoke 1).
void lakeFjPassage() {
  lakeFjTilt = 0.0;
  lakeFjSmokeFront = 1.0;
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return;
  float settle = passageSettle(pin / 0.82, 1.1);
  lakeFjTilt = 0.22 * (1.0 - settle) + 0.26 * pout * pout;
  float sf = clamp((pin - 0.35) / 0.65, 0.0, 1.0);
  lakeFjSmokeFront = 1.0 - (1.0 - sf) * (1.0 - sf);
}

// The fjord for a screen point, under the night lakeSetup has set: the near bank and its birches,
// the water, or what lies beyond it; then the mist lying on the fjord and the falling snow.
Shade lakeFjord(vec2 screenUv, float aspect) {
  lakeSetup(aspect);
  lakeFjPassage();
  lakeFjPx = 1.0 / uRes.y;
  lakeFjHW = 0.5 * aspect;
  lakeFjSx = clamp(aspect / 1.78, 0.45, 1.0);
  lakeFjCabinX = 0.40 * lakeFjHW;
  lakeFjHaze = horizonHaze(lakeSky, vec3(0.0, 0.0, 1.0), 0.03) + lakeAurLight * 1.1 + lakeMoonLight * 0.2;
  // The camera's tilt (zero at rest, where uv == screenUv). The snow is weather in front of the
  // lens and stays in screen space.
  vec2 uv = screenUv + vec2(0.0, lakeFjTilt);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  lakeAccent = 0.0;
  float depth = 1.0;
  float fogDist = 1.0;
  float fogHeight = max(p.y - LAKE_FJ_HZ, 0.0) * 6.0;
  vec3 col;
  float fgDepth;
  vec4 fg = lakeFjForeground(p, fgDepth);
  if (fg.a > 0.5) {
    col = fg.rgb;
    depth = fgDepth;
    fogDist = 0.05;
    fogHeight = 0.0;
  } else if (p.y < LAKE_FJ_HZ) {
    float range;
    col = lakeFjWater(p, range);
    depth = weatherDepth(range);
    fogDist = 1.0 - exp(-range / 160.0);
    fogHeight = 0.0;
  } else {
    col = lakeFjFar(p, false);
  }

  // Mist lying on the fjord: the far shore fades first, and it lies low.
  if (K_fog > 0.0) {
    vec3 mist = LAKE_SNOW * (lakeAmb * 1.6 + lakeAurLight * 1.2 + lakeMoonLight * 0.5) * 0.8 + lakeFjHaze * 0.5;
    float f = fogAmount(K_fog, fogDist, fogHeight);
    col = mix(col, mist, f);
    lakeAccent *= 1.0 - f;
  }
  // Falling snow, in depth to the first thing the eye meets.
  if (K_snow > 0.0) {
    Precip pr = snowFall(screenUv, aspect, lakeTm, K_snow, K_wind, depth);
    vec3 air = LAKE_SNOW * (lakeAmb * 2.4 + lakeMoonLight * 0.6 + lakeAurLight * 1.5);
    col = precipOver(col, air, max(air * 1.3, vec3(0.08)), pr);
    lakeAccent *= 1.0 - pr.veil;
  }
  return shadeOf(col, inkOf(col, 1.4, 0.8), clamp(lakeAccent * 1.6, 0.0, 1.0));
}
#endif

Shade sceneLake(vec2 screenUv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
#if LAKE_FJORD
  if (K_setting > 0.5) return lakeFjord(screenUv, aspect);
#endif
  // The camera's tilt, a lens shift of uv (exactly nothing at rest).
  vec2 uv = screenUv;
  float pin = passageIn();
  float pout = passageOut();
  if (pin < 1.0) uv.y += LAKE_TILT * lakeArrive(pin);
  if (pout > 0.0) uv.y += LAKE_TILT * lakeLeave(pout);
  lakeSetup(aspect);
  vec2 sp = vec2((uv.x - 0.5) * aspect, uv.y - LAKE_HORIZON);
  vec3 dir = normalize(vec3(sp, LAKE_FOCAL));
  float az = atan(sp.x, LAKE_FOCAL) + lakePar;
  // How far the eye ray runs across the ice before it meets the shore (or the sky: far).
  float range = 1e4;
  bool ice = false;
  if (sp.y < 0.0) {
    float shore = min(lakeFarShore(az), lakePointShore(az));
    range = LAKE_EYE * length(vec2(sp.x, LAKE_FOCAL)) / -sp.y;
    ice = range < shore;
    range = min(range, shore);
  }
  lakeAccent = 0.0;
  float glow = 0.0;
  vec3 col;
  if (ice) {
    col = lakeIce(uv, aspect, dir, range, glow);
  } else {
    col = lakeBeyond(vec3(0.0, LAKE_EYE, 0.0), dir, false, 0.0);
    glow = lakeAccent;
  }

  // Mist on the lake: the far shore fades first, and it lies low.
  if (K_fog > 0.0) {
    vec3 mist = horizonHaze(lakeSky, dir, 0.02) * 0.8 + lakeAmb * 1.5 + lakeAurLight * 1.2 + lakeMoonLight * 0.4;
    float f = fogAmount(K_fog, 1.0 - exp(-range / 160.0), max(dir.y, 0.0) * 6.0);
    col = mix(col, mist, f);
    glow *= 1.0 - f;
  }
  // The exit's gust of blown snow, low over the ice and the far shore.
  if (pout > 0.0) {
    float hit = hardEdge(lakeGust(uv, aspect, pout));
    vec3 blown = LAKE_SNOW * (lakeAmb * 2.6 + lakeMoonLight * 0.9 + lakeAurLight * 2.2);
    col = mix(col, blown, 0.85 * hit);
    glow *= 1.0 - 0.85 * hit;
  }
  // Falling snow, in depth to the first thing the eye meets.
  if (K_snow > 0.0) {
    Precip p = snowFall(uv, aspect, lakeTm, K_snow, K_wind, weatherDepth(range));
    vec3 air = LAKE_SNOW * (lakeAmb * 2.4 + lakeMoonLight * 0.6 + lakeAurLight * 1.5);
    col = precipOver(col, air, max(air * 1.3, vec3(0.08)), p);
    glow *= 1.0 - p.veil;
  }

  Shade o = blankShade();
  o.ink = clamp(pow(max(dot(col, LUMA), 0.0), 0.8) * 1.4, 0.0, 1.0);
  o.accent = clamp(glow * 1.6, 0.0, 1.0);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
