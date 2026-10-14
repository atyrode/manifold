// A northern night, drawn: a still fjord under slow curtains of aurora, snowy mountains going straight
// into the water, a small red cabin on the far shore with its window lit and a thread of smoke
// climbing from the chimney, birches on the near bank. No simulation: everything moves on smooth
// functions of the motion clock, slowly enough that no cell steps more than a few times a minute.
//
// The camera is a side-on pinhole with the horizon (and the far shore's waterline) at AUR_HZ. The
// sky, the mountains, the far shore and the cabin are one function, aurFar, of a screen point above
// the horizon. The water below it is that same function looked up at the mirrored point, shifted by
// slow ripple noise (still water) or by frozen undulations (ice), then dimmed by a Fresnel-like
// share; the cabin's window and the moon draw their light paths down it. Reflected edges move a
// fraction of a cell at a time; every crisp edge (disc, window, trunk, smoke) is cut per cell
// against the dither threshold, so each cell flips once as it passes.
//
// The aurora: up to three curtains hang along arcs at growing distances (a ray meets each at a
// depth that folds in and out along its length; where the sheet turns edge-on it glows more). Light
// in a curtain: a sharp bright lower edge, then fine vertical rays (spaced by angle, brightening and
// fading slowly along their height), a pulse of brightness travelling along the arc, lit stretches
// and dark gaps; green low, violet or red toward the top. A corona (rays streaming from a point high
// in the sky) gathers now and then. The sky's glow lights the snow and the cabin's walls.
//
// Passage (aurPassage): the camera tilts between the stars and the fjord (a shift of uv, so every
// layer, the mirrored water and the horizon move as one), the curtains unfurl from faint high arcs
// or roll back up into them, and on the way in the chimney's smoke climbs. All gated to nothing at rest.
import { glslFloat, glslPick } from "../../shaders/glsl.ts";

/** The aurora's low (oxygen green) and high (violet, red) colours by the `hue` knob, where the change begins and ends, and its gain. */
const AURORA_LOW = ["vec3(0.28, 1.0, 0.50)", "vec3(0.28, 1.0, 0.50)", "vec3(0.45, 1.0, 0.32)"] as const;
const AURORA_HIGH = ["vec3(0.12, 0.85, 0.72)", "vec3(0.66, 0.22, 0.92)", "vec3(1.0, 0.10, 0.22)"] as const;
const AURORA_FROM = [0.35, 0.3, 0.08] as const;
const AURORA_TO = [1.0, 0.85, 0.65] as const;
const AURORA_GAIN = [1.0, 1.0, 1.2] as const;

/** Horizon (screen height) and vertical field of view (rad) of the pinhole camera. */
const HORIZON = 0.32;
const FOV = 1.3;

export const auroraGlsl = `
const float AUR_HZ = ${glslFloat(HORIZON)};
const float AUR_F = ${glslFloat(0.5 / Math.tan(FOV / 2))};
const vec3 AUR_SNOW = vec3(0.86, 0.9, 1.0);
const vec3 AUR_WINDOW = vec3(1.0, 0.62, 0.26);
const vec3 AUR_WALL = vec3(0.80, 0.12, 0.08);

// Set once per pixel by aurSetup.
float aurT;          // the motion clock
float aurPx;         // one dither cell, in screen heights
float aurHW;         // half the frame's width, in screen heights
float aurSx;         // 1 on a wide frame, less on a narrow one: the near bank and trees shrink with it
float aurCabinX;     // the cabin's place along the far shore
vec2 aurMoonAt;
vec3 aurLow;         // the aurora's colours
vec3 aurHigh;
float aurFrom;
float aurTo;
float aurGain;
vec3 aurLight;       // the aurora's light on the land
float aurTilt;       // passage: the camera's tilt up from rest, in screen heights (0 at rest)
float aurUnfurl[3];  // passage: how far each curtain has come down (1 at rest)
float aurSmokeFront; // passage: how far up the chimney smoke has climbed (1 at rest)
float aurGlowGate;   // passage: the land's share of the sky's glow while the curtains are furled (1 at rest)
vec3 aurMoonLight;   // the moon's
vec3 aurAmb;         // light from the whole sky
vec3 aurHaze;        // the air above the far shore
float aurCorona;     // the corona's envelope 0..1
float aurOver;       // cloud while it snows 0..1
float aurVis;        // how much of the aurora and stars the cloud lets through
Sky aurStars;
float aurAccent;     // aurora light gathered by the sky

vec3 aurLowColour() {
${glslPick("hue", AURORA_LOW, AURORA_LOW[0])}
}

vec3 aurHighColour() {
${glslPick("hue", AURORA_HIGH, AURORA_HIGH[0])}
}

float aurFromAt() {
${glslPick("hue", AURORA_FROM.map(glslFloat), glslFloat(AURORA_FROM[0]))}
}

float aurToAt() {
${glslPick("hue", AURORA_TO.map(glslFloat), glslFloat(AURORA_TO[0]))}
}

float aurGainAt() {
${glslPick("hue", AURORA_GAIN.map(glslFloat), glslFloat(AURORA_GAIN[0]))}
}

// The corona's envelope: a burst every minute or two (more often with the knob), a few tens of
// seconds long, or at once from the "now" button. Smooth in time, zero between.
float aurCoronaEnv() {
  if (K_corona <= 0.0) return 0.0;
  float period = mix(240.0, 80.0, clamp(K_corona, 0.0, 1.0));
  float cyc = fract(uMotionTime / period + 0.55);
  float b = sin(3.14159265 * clamp(cyc / 0.28, 0.0, 1.0));
  float env = b * b;
  float since = sinceTrigger(0);
  if (since >= 0.0 && since < 40.0) {
    float s = sin(3.14159265 * since / 40.0);
    env = max(env, s * s);
  }
  return env;
}

// The aurora's colour at height hn up a curtain (0 lower edge .. 1 top).
vec3 aurTint(float hn) {
  return mix(aurLow, aurHigh, smoothstep(aurFrom, aurTo, hn));
}

// One ribbon of the aurora, a curtain seen from the ground: its lower hem follows a curve in the sky
// that slowly evolves into long S-bends (y0: where it hangs, L: how far its light reaches up, both
// in screen heights). Above the hem the light fades upward as a fan of fine, dense, vertical rays,
// each brightening and fading slowly along its height. The curtain is folded along its length:
// where its ray coordinate s bunches up (ds/dx small) the sheet turns edge-on and glows brighter.
// A pulse of brightness travels along it; lit stretches alternate with dark gaps. A faint veil
// lies under the hem. Returns the light (x) and how far up the sheet (y, 0..1).
vec2 aurRibbon(vec2 q, float y0, float L, float salt, float T, float unf) {
  float act = K_activity;
  float x = q.x;
  float amp = 0.03 + 0.05 * act;
  float hem = y0 + amp * (sin(x * 1.9 + T * 0.014 + salt) + 0.55 * sin(x * 3.7 - T * 0.021 + salt * 2.1) + 0.2 * sin(x * 7.3 + T * 0.030 + salt * 3.3));
  // unf < 1: the curtain is unfurling or rolling up. A wave sweeps along the arc (ux: how far this
  // stretch has come down), the hem hanging higher the less unfurled it is.
  float ux = 1.0;
  if (unf < 1.0) {
    float xw = clamp(0.5 + 0.5 * x / aurHW, 0.0, 1.0);
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

// The aurora for a screen point, to add to the sky: three ribbons, the main one hanging mid-sky
// with its rays reaching high over the frame, a dimmer one low behind the mountains, and (in a
// livelier sky) a third high up.
vec3 aurAurora(vec2 q, float T) {
  if (K_glow <= 0.0) return vec3(0.0);
  vec3 c = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float gain = i == 0 ? 1.0 : (i == 1 ? 0.7 : 0.5 * smoothstep(0.1, 0.5, K_activity));
    if (gain > 0.0) {
      float y0 = i == 0 ? 0.57 : (i == 1 ? 0.45 : 0.74);
      float len = i == 0 ? 0.17 : (i == 1 ? 0.11 : 0.14);
      float unf = aurUnfurl[i];
      // A curtain still furled is a faint arc: a little dimmer, mostly just short.
      if (unf < 1.0) gain *= 0.6 + 0.4 * unf;
      vec2 cu = aurRibbon(q, y0, len, float(i) * 2.7 + 1.3, T, unf);
      c += aurTint(cu.y) * cu.x * gain;
    }
  }
  return c * K_glow * 0.6 * aurGain * (0.92 + 0.08 * sin(T * 0.13));
}

// The corona: rays streaming from a point high in the north, brightest near the point, fading to
// the high colour with distance. Integer ray counts around the point keep it seamless.
vec3 aurCoronaLight(vec3 d, float T) {
  if (aurCorona <= 0.0 || d.y <= 0.0) return vec3(0.0);
  vec3 c = normalize(vec3(-0.1, 0.82, 0.58));
  float ca = dot(d, c);
  if (ca < 0.55) return vec3(0.0);
  vec3 ex = normalize(cross(vec3(0.0, 1.0, 0.0), c));
  vec3 ey = cross(c, ex);
  float a = acos(min(ca, 1.0));
  float phi = atan(dot(d, ey), dot(d, ex));
  float r = 0.5 + 0.25 * (sin(phi * 14.0 + T * 0.03 + a * 1.5) + sin(phi * 23.0 - T * 0.021 + a * 2.5 + 1.3));
  float rays = smoothstep(0.35, 0.85, r);
  float lum = aurCorona * exp(-a * a / 0.22) * smoothstep(0.03, 0.22, a) * (0.2 + 0.8 * rays);
  vec3 tint = mix(aurLow * vec3(1.0, 1.0, 1.15), aurHigh, smoothstep(0.12, 0.65, a));
  return tint * lum * 0.85 * K_glow * aurGain;
}

// The crescent moon: a disc with a second disc cut from it (full when the cut slides clear), a
// faint earthshine on the dark part and a halo. cover: how much of the sky the disc hides.
vec3 aurMoonLightAt(vec2 q, out float cover) {
  cover = 0.0;
  if (K_moon <= 0.0) return vec3(0.0);
  vec2 v = q - aurMoonAt;
  float r = 0.021;
  float d1 = length(v) - r;
  vec2 cut = normalize(vec2(-0.8, 0.45)) * (2.1 * r * K_moon);
  float d2 = length(v - cut) - r * 1.02;
  float body = hardFill(d1, aurPx * 0.8);
  float lit = hardFill(max(d1, -d2), aurPx * 0.8);
  cover = body;
  vec3 col = vec3(0.95, 0.93, 0.84) * lit * 1.05 + vec3(0.014, 0.02, 0.03) * (body - lit);
  float halo = exp(-length(v) / 0.045) * 0.05 * (0.3 + K_moon);
  return col + vec3(0.30, 0.36, 0.50) * halo * (1.0 - 0.7 * aurOver);
}

// The Manifold M: a curtain that has folded itself into the letter, high in the sky, with the same
// vertical rays, breathing slowly, its sheet rippling a little.
vec3 aurMarkLight(vec2 q, float T) {
  if (K_mark < 0.5) return vec3(0.0);
  float size = 0.30;
  vec2 m = (q - vec2(0.10 * aurHW, 0.69)) / size;
  m.x += 0.014 * sin(m.y * 5.0 + T * 0.30);
  if (abs(m.x) > 0.7 || abs(m.y) > 0.75) return vec3(0.0);
  float dm = markDistance(m);
  float core = 1.0 - smoothstep(0.035, 0.085, dm);
  float halo = exp(-dm * dm / 0.006) * 0.35;
  float rays = 0.65 + 0.35 * vnoise(vec2(q.x * 80.0 - T * 0.04, q.y * 2.0 + T * 0.02));
  float breathe = 0.82 + 0.18 * sin(T * 0.45);
  float lum = (core + halo) * rays * breathe * (0.8 + 0.2 * smoothstep(-0.5, 0.5, -m.y));
  aurAccent += lum * 1.2;
  return mix(aurLow, aurHigh, smoothstep(-0.2, 0.9, m.y) * 0.8) * lum * 1.1 * aurGain;
}

// The night sky above the horizon at screen point q (mirror: seen in the water).
vec3 aurSky(vec2 q, bool mirror) {
  vec3 d = normalize(vec3(q.x, q.y - AUR_HZ, AUR_F));
  float e = max(d.y, 0.0);
  vec3 col = mix(vec3(0.020, 0.046, 0.078), vec3(0.003, 0.008, 0.026), smoothstep(0.0, 0.8, e));
  col += aurLight * 1.1 * exp(-e * 5.0) + aurLow * (K_glow * aurVis * 0.035) * exp(-abs(q.y - 0.6) / 0.25);
  float cover;
  vec3 moon = aurMoonLightAt(q, cover);
  float dens = K_stars * (1.0 - 0.45 * K_moon);
  vec3 stars = skyStarLight(aurStars, d, mirror ? 0.55 * dens : dens) * (mirror ? 0.6 : 1.0) * aurVis;
  vec3 au = (aurAurora(q, aurT) + aurCoronaLight(d, aurT) + aurMarkLight(q, aurT)) * aurVis;
  float seen = dot(au, LUMA);
  col += stars * (1.0 - min(seen * 3.0, 1.0)) * (1.0 - cover) + au;
  col = mix(col, vec3(0.012, 0.016, 0.026), cover) + moon;
  aurAccent += seen;
  if (aurOver > 0.0) {
    // Cloud while it snows, lit green from underneath by what is left of the aurora.
    float dens2 = fbm3(vec2(q.x * 1.7 + aurT * 0.004, q.y * 4.0 + 3.0));
    float cov = smoothstep(0.62 - 0.4 * aurOver, 0.78 - 0.3 * aurOver, dens2) * min(aurOver * 1.6, 1.0);
    col = mix(col, vec3(0.018, 0.026, 0.036) + aurLight * 0.9, cov * 0.9);
    aurAccent *= 1.0 - cov * 0.9;
  }
  return col;
}

// Far snowy mountains and the nearer wooded hills, as heights above the horizon (screen heights).
float aurPeaks(float x) {
  float xs = x * 1.35 + 3.0;
  float r = 1.0 - abs(2.0 * vnoise(vec2(xs * 1.5, 1.0)) - 1.0);
  float r2 = 1.0 - abs(2.0 * vnoise(vec2(xs * 4.2 + 2.0, 3.0)) - 1.0);
  return 0.03 + 0.17 * (0.7 * r * sqrt(r) + 0.3 * r2 * r);
}

float aurHills(float x) {
  float lower = 1.0 - 0.8 * K_cabin * bell((x - aurCabinX) / 0.3);
  float n = 0.6 * vnoise(vec2(x * 3.2 + 9.0, 4.0)) + 0.4 * vnoise(vec2(x * 8.5 + 1.0, 6.0));
  return (0.012 + 0.05 * n) * lower;
}

// A mountain face y above the horizon: snow lit by the moon on the faces that turn toward it (left),
// by the aurora everywhere, rock showing on the steeps, gullies streaking down, haze at its foot.
vec3 aurPeakColour(vec2 q, float y) {
  float h = aurPeaks(q.x);
  float slope = (aurPeaks(q.x + 0.006) - aurPeaks(q.x - 0.006)) / 0.012;
  float toMoon = clamp(0.5 + 1.1 * slope, 0.0, 1.0);
  float gully = vnoise(vec2(q.x * 85.0, y * 28.0));
  vec3 light = aurAmb * 2.6 + aurMoonLight * (0.25 + 1.1 * toMoon) + aurLight * 1.8;
  vec3 snow = AUR_SNOW * light * (0.70 + 0.30 * gully);
  float steep = clamp(abs(slope) * 1.2, 0.0, 1.0);
  float rock = smoothstep(0.64, 0.82, vnoise(vec2(q.x * 46.0, y * 70.0))) * 0.7 * steep;
  vec3 col = mix(snow, vec3(0.025, 0.03, 0.04) + aurAmb * 0.15, rock);
  return mix(col, aurHaze, 0.1 + 0.45 * (1.0 - smoothstep(0.0, 0.09, y)));
}

vec3 aurHillColour(vec2 q, float y) {
  float clearing = smoothstep(0.55, 0.75, vnoise(vec2(q.x * 50.0, y * 120.0)));
  vec3 light = aurAmb * 1.5 + aurMoonLight * 0.6 + aurLight * 1.2;
  vec3 snow = AUR_SNOW * light * 0.7;
  vec3 wood = vec3(0.010, 0.018, 0.022) + aurAmb * 0.10;
  return mix(mix(wood, snow, clamp(0.40 * clearing + 0.35 * uWeather.y, 0.0, 1.0)), aurHaze, 0.30);
}

// A row of spruces along the far shore, snow on every tier, left bare around the cabin.
bool aurTreeline(vec2 q, out vec3 col) {
  col = vec3(0.0);
  float y = q.y - AUR_HZ;
  if (y > 0.036) return false;
  float cell = 0.013;
  float k0 = floor(q.x / cell);
  for (int i = -1; i <= 1; i++) {
    float k = k0 + float(i);
    float h = hash12(vec2(k, 4.0));
    float h2 = hash12(vec2(k, 9.0));
    float cx = (k + 0.5 + 0.7 * (h2 - 0.5)) * cell;
    float clear = 1.0 - K_cabin * (1.0 - smoothstep(0.08, 0.14, abs(cx - aurCabinX)));
    float ht = (0.009 + 0.026 * h * h) * clear;
    if (ht < 0.004) continue;
    float v = y / ht;
    if (v < 0.0 || v > 1.0) continue;
    float tier = fract(v * 4.0 + h * 3.0);
    float hw = 0.2 * ht * (1.0 - v) * (0.8 + 0.2 * tier) + 0.0012;
    if (abs(q.x - cx) < hw) {
      vec3 needles = vec3(0.010, 0.020, 0.022) + aurAmb * 0.10;
      vec3 lit = AUR_SNOW * (aurAmb * 1.6 + aurMoonLight * 0.6 + aurLight * 1.4) * 0.8;
      float snowy = smoothstep(0.6, 0.95, tier);
      col = mix(mix(needles, lit, clamp(0.7 * snowy + 0.5 * uWeather.y, 0.0, 1.0)), aurHaze, 0.15);
      return true;
    }
  }
  return false;
}

const float AUR_CS = 2.0;     // the cabin's size: its own units times this
const float AUR_FOOT = 0.014; // its foot above the waterline, on a small knoll of snow

// The snowbank along the far waterline, swelling into a knoll under the cabin.
float aurShoreTop(float x) {
  return 0.0045 + 0.003 * vnoise(vec2(x * 90.0, 1.0)) + 0.012 * K_cabin * bell((x - aurCabinX) / 0.26);
}

// Four small birches beside the cabin: a pale trunk and a bare crown of twigs.
bool aurFarBirches(vec2 q, out vec3 col) {
  col = vec3(0.0);
  float y = q.y - AUR_HZ;
  if (y < 0.0 || y > 0.14) return false;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float bx = aurCabinX + (fi < 1.5 ? (fi < 0.5 ? -0.15 : -0.19) : (fi < 2.5 ? 0.14 : 0.18));
    float ht = 0.070 + 0.025 * hash12(vec2(fi, 8.1));
    float dx = q.x - bx;
    if (abs(dx) < 0.0034 && y < ht) {
      col = mix(AUR_SNOW * (aurAmb * 2.8 + aurMoonLight + aurLight * 2.0) * 0.9, aurHaze, 0.1);
      return true;
    }
    vec2 e = vec2(dx / 0.028, (y - ht * 0.78) / 0.036);
    float rr = length(e);
    if (rr < 1.0) {
      float n = vnoise(vec2(q.x * 320.0 + fi * 9.0, q.y * 220.0));
      if (n * (0.35 + 0.9 * (1.0 - rr)) > 0.58) {
        col = mix(vec3(0.05, 0.03, 0.04) + aurAmb * 0.2, aurHaze, 0.2);
        return true;
      }
    }
  }
  return false;
}

// The cabin: red plank walls, a snow-laden gable roof with dark eaves, a stone chimney, a door and
// one window lit by the fire. p: screen heights across from its middle and up from its foot.
bool aurCabin(vec2 p, out vec3 col) {
  col = vec3(0.0);
  float ax = abs(p.x);
  float roofTop = 0.029 + 0.027 * (1.0 - ax / 0.039);
  bool wall = ax < 0.031 && p.y > 0.0 && p.y < 0.029;
  bool roof = ax < 0.039 && p.y >= 0.027 && p.y < roofTop;
  bool chimney = abs(p.x - 0.0165) < 0.0042 && p.y > 0.03 && p.y < 0.058;
  if (!(wall || roof || chimney)) return false;
  vec3 lit = aurAmb * 1.4 + aurMoonLight * 0.5 + aurLight * 1.2;
  vec3 snowLit = AUR_SNOW * (aurAmb * 2.8 + aurMoonLight * 0.9 + aurLight * 2.0);
  if (chimney) {
    col = vec3(0.10, 0.09, 0.09) * (lit * 2.0 + 0.02);
    if (p.y > 0.0545) col = snowLit * 0.9;
  } else if (roof) {
    col = snowLit * (0.9 + 0.1 * vnoise(vec2(p.x * 300.0, p.y * 200.0)));
    if (p.y < 0.0305 || roofTop - p.y < 0.0018) col = vec3(0.05, 0.04, 0.04) * (lit * 2.0 + 0.02);
  } else {
    float board = fract(p.y / 0.006);
    col = AUR_WALL * (lit * 2.6 + vec3(0.09, 0.05, 0.05)) * (board > 0.8 ? 0.65 : 1.0);
    vec2 wq = p - vec2(-0.011, 0.0155);
    float glow = exp(-length(wq) / 0.012);
    if (abs(wq.x) < 0.0068 && abs(wq.y) < 0.0075) {
      float fire = 0.95 + 0.03 * sin(aurT * 0.9) + 0.02 * sin(aurT * 2.3 + 1.0);
      col = AUR_WINDOW * 1.5 * fire;
      if (abs(wq.x) < 0.0006 || abs(wq.y) < 0.0006) col = vec3(0.30, 0.10, 0.05);
    } else if (abs(wq.x) < 0.0082 && abs(wq.y) < 0.0092) {
      col = snowLit * 0.55;
    } else {
      col += AUR_WINDOW * 0.10 * glow;
    }
    if (abs(p.x - 0.017) < 0.0045 && p.y < 0.0115) col = vec3(0.10, 0.04, 0.03) * (lit * 2.0 + 0.04);
    if (p.y < 0.003 + 0.005 * uWeather.y) col = snowLit * 0.9;
  }
  return true;
}

// Smoke from the chimney: a thread climbing slowly, leaning with the wind and swaying, widening and
// thinning as it goes. Thickness 0..1.
float aurSmoke(vec2 q) {
  float s = q.y - (AUR_HZ + AUR_FOOT + 0.058 * AUR_CS);
  if (s < -0.003 || s > 0.36) return 0.0;
  float lean = (0.04 + 0.45 * K_wind) * s;
  float sway = (0.008 * sin(s * 21.0 - aurT * 0.30) + 0.004 * sin(s * 47.0 - aurT * 0.45 + 1.0)) * smoothstep(0.0, 0.12, s);
  float xc = aurCabinX + 0.0165 * AUR_CS + lean + sway;
  float w = 0.005 + 0.09 * max(s, 0.0);
  float r = (q.x - xc) / w;
  if (abs(r) > 2.5) return 0.0;
  float puffs = 0.45 + 0.55 * vnoise(vec2(s * 20.0 - aurT * 0.20, r * 0.8 + 3.0));
  float sm = exp(-r * r) * puffs * (1.0 - smoothstep(0.12, 0.36, s)) * smoothstep(-0.003, 0.012, s);
  // On the way in the thread climbs from the chimney: a front rising through it, cut per cell.
  if (aurSmokeFront < 1.0) sm *= 1.0 - smoothstep(0.40 * aurSmokeFront - 0.04, 0.40 * aurSmokeFront, s);
  return sm;
}

// Everything beyond the water, at screen point q at or above the horizon (mirror: reflected).
vec3 aurFar(vec2 q, bool mirror) {
  float y = q.y - AUR_HZ;
  vec3 col = vec3(0.0);
  vec3 c2;
  if (K_cabin > 0.5 && abs(q.x - aurCabinX) < 0.04 * AUR_CS && y < 0.07 * AUR_CS + AUR_FOOT && aurCabin((q - vec2(aurCabinX, AUR_HZ + AUR_FOOT)) / AUR_CS, c2)) {
    col = c2;
  } else if (aurFarBirches(q, c2)) {
    col = c2;
  } else if (aurTreeline(q, c2)) {
    col = c2;
  } else if (y < aurShoreTop(q.x)) {
    // The snowbank at the waterline, warm in the light of the window.
    float dxw = q.x - (aurCabinX - 0.011 * AUR_CS);
    col = AUR_SNOW * (aurAmb * 2.8 + aurMoonLight * 0.9 + aurLight * 2.0) * 0.85 + AUR_WINDOW * 0.55 * K_cabin * exp(-dxw * dxw / 0.004);
    col = mix(col, aurHaze, 0.2);
  } else if (y < aurHills(q.x)) {
    col = aurHillColour(q, y);
  } else if (y < aurPeaks(q.x)) {
    col = aurPeakColour(q, y);
  } else {
    col = aurSky(q, mirror);
  }
  if (K_cabin > 0.5) {
    float sm = aurSmoke(q);
    if (sm > 0.0) {
      vec3 sc = AUR_SNOW * (aurAmb * 3.2 + aurMoonLight + aurLight * 2.0)
              + AUR_WINDOW * 0.18 * exp(-max(q.y - (AUR_HZ + AUR_FOOT + 0.058 * AUR_CS), 0.0) / 0.05);
      col = mix(col, sc, 0.8 * hardEdge(sm));
    }
  }
  return col;
}

// The water at screen point p below the horizon: the far world mirrored (the ray's reach grows as
// 1 / h below the horizon, so ripples are laid out in that depth and fade out where they would be
// finer than a cell), dimmer the nearer it lies; the window's light and the moon's drawn down it;
// and, as the ice knob rises, plates of ice in it: static, dimmer mirrors, hairline cracks and
// patches of snow. range: metres to the water here.
vec3 aurWater(vec2 p, out float range) {
  float h = max(AUR_HZ - p.y, 0.002);
  range = 1.7 * AUR_F / h;
  vec2 g = vec2(p.x * 1.6 / (0.25 + 2.0 * h), log(0.04 + h) * 3.0);
  float iceMask = 0.0;
  if (K_ice > 0.0) {
    float nIce = fbm3(g * vec2(0.8, 1.0) + vec2(3.1, 7.7));
    iceMask = hardEdge(smoothstep(0.46, 0.54, nIce + (K_ice - 0.5) * 1.4));
  }
  vec2 P = vec2(p.x, 1.0) * (0.5 / h);
  float tm = aurT * (1.0 - iceMask);
  float fade1 = smoothstep(0.03, 0.12, h);
  float fade2 = smoothstep(0.08, 0.20, h);
  float w1 = vnoise(vec2(P.x * 0.7, P.y * 1.3 - tm * 0.05)) - 0.5;
  float w2 = vnoise(vec2(P.x * 2.1 + 4.0, P.y * 3.9 - tm * 0.08 + 6.0)) - 0.5;
  float amp = mix(0.05, 0.10, iceMask);
  float dy = amp * h * (w1 * fade1 + 0.5 * w2 * fade2);
  float dx = 0.02 * h * w2 * fade2;
  vec2 q = vec2(p.x + dx, max(AUR_HZ + h + dy, AUR_HZ + 0.0006));

  float low = exp(-h * 9.0);
  float fres = mix(0.55 + 0.35 * low, 0.22 + 0.22 * low, iceMask);
  aurAccent = 0.0;
  vec3 refl = aurFar(q, true);
  float reflAccent = aurAccent;
  vec3 deep = vec3(0.003, 0.010, 0.017) + aurAmb * 0.10;
  // Ice is pale blue-grey, lit by the whole sky and never black; the sky shows in it dimly.
  vec3 icePale = AUR_SNOW * (aurAmb * 3.4 + aurMoonLight * 1.2 + aurLight * 2.2) * 0.85 + vec3(0.05, 0.07, 0.10);
  vec3 col = mix(mix(deep, icePale, iceMask), refl * vec3(0.92, 0.96, 1.0) * 1.1, fres);
  col += aurLow * (K_glow * aurVis * 0.03) * (1.0 - iceMask);
  aurAccent = reflAccent * fres;

  // The window's light and the moon's, drawn down the water toward us in slowly drifting bands.
  float bands = 0.35 + 0.65 * smoothstep(0.3, 0.75, vnoise(vec2(p.x * 24.0, P.y * 2.2 - tm * 0.07)));
  vec3 path = vec3(0.0);
  if (K_cabin > 0.5) {
    float wx = (p.x - (aurCabinX - 0.011 * AUR_CS)) / (0.008 + 0.05 * h);
    path += AUR_WINDOW * exp(-wx * wx) * exp(-h * 6.0) * smoothstep(0.004, 0.03, h) * bands * 0.7;
  }
  if (K_moon > 0.0) {
    float mx = (p.x - aurMoonAt.x) / (0.012 + 0.07 * h);
    float mh = (h - (aurMoonAt.y - AUR_HZ)) / 0.14;
    path += vec3(0.80, 0.85, 0.95) * exp(-mx * mx) * (0.2 + 0.8 * exp(-mh * mh)) * smoothstep(0.004, 0.03, h) * bands * 0.25 * K_moon * (1.0 - 0.7 * aurOver);
  }
  col += path * mix(1.0, 0.35, iceMask);

  if (iceMask > 0.5) {
    // Soft drifts: a wide, stippled transition between bare ice and snow.
    float sn = fbm3(g * vec2(0.9, 1.5) + vec2(11.0, 2.0));
    float th = 0.62 - 0.25 * uWeather.y - 0.05 * K_ice;
    float snow = hardEdge(smoothstep(th - 0.2, th + 0.2, sn));
    float crackN = vnoise(g * vec2(1.7, 2.3) + 4.0);
    float crack = hardEdge(1.0 - smoothstep(0.0, 0.03, abs(crackN - 0.5))) * smoothstep(0.04, 0.10, h);
    col = mix(col, icePale * 0.5, crack * 0.7);
    vec3 snowCol = mix(icePale * 1.25 * (0.9 + 0.1 * vnoise(g * 9.0)), aurHaze, 0.4 * (1.0 - smoothstep(0.0, 0.1, h)));
    col = mix(col, snowCol, snow * 0.9);
    aurAccent *= 1.0 - 0.7 * snow;
  }
  return col;
}

// The ground the camera stands on: a snowbank in each lower corner.
float aurBankTop(float x) {
  float ul = (x + aurHW) / (0.62 * aurSx);
  float ur = (x - aurHW) / (0.5 * aurSx);
  float n = 1.0 + 0.3 * (vnoise(vec2(x * 6.0 + 3.0, 2.0)) - 0.5);
  return (0.13 * exp(-ul * ul) + 0.07 * exp(-ur * ur)) * n - 0.012;
}

vec3 aurBarkLight() {
  return AUR_SNOW * (aurAmb * 3.0 + aurMoonLight * 1.2 + aurLight * 2.2);
}

// A near birch rooted at (bx, by): a pale trunk, tapering, leaning a little and swaying in its line,
// with dark lenticels; five bare branches that end in a drooping crown of fine twigs (vertical
// strands cut from static noise, so nothing about them moves). w0: the trunk's half width at its foot.
bool aurBirch(vec2 p, float bx, float by, float w0, float sd, out vec3 col) {
  col = vec3(0.0);
  float yy = p.y - by;
  if (yy < 0.0 || abs(p.x - bx) > 0.36) return false;
  float lean = (fract(sd * 3.7) - 0.5) * 0.10;
  float ht = 1.05 - by;
  vec3 bark = aurBarkLight();
  float xc = bx + lean * yy + 0.010 * sin(yy * 3.4 + sd * 7.0);
  float w = w0 * mix(1.0, 0.45, clamp(yy / ht, 0.0, 1.0));
  float dx = p.x - xc;
  if (abs(dx) < w + aurPx && hardFill(abs(dx) - w, aurPx * 0.8) > 0.5) {
    float row = floor(yy * 45.0);
    float hh = hash12(vec2(row, sd));
    float mx = hash12(vec2(row, sd + 3.0)) * 1.6 - 0.8;
    float mark = step(0.55, hh) * step(abs(fract(yy * 45.0) - 0.5), 0.16) * step(abs(dx / w - mx), 0.5);
    float shade = 0.55 + 0.45 * clamp(0.5 - 0.5 * dx / w, 0.0, 1.0);
    col = mix(bark * shade, vec3(0.03, 0.025, 0.03) + aurAmb * 0.2, mark);
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
    if (hardFill(dB, aurPx * 0.8) > 0.5) {
      col = vec3(0.05, 0.035, 0.04) + aurAmb * 0.3;
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
        vec3 twig = vec3(0.06, 0.035, 0.045) + aurAmb * 0.3;
        col = mix(twig, bark * 0.45, 0.35 * smoothstep(0.7, 0.9, dens) + 0.5 * uWeather.y * step(0.5, fract(lace * 37.0)));
        return true;
      }
    }
  }
  return false;
}

// The near bank and its birches, over everything: rgb and cover; depth: for the snow in the air.
vec4 aurForeground(vec2 p, out float depth) {
  depth = weatherDepth(3.5);
  float top = aurBankTop(p.x);
  if (p.y < top) {
    float below = clamp((top - p.y) / 0.12, 0.0, 1.0);
    float grain = vnoise(vec2(p.x * 24.0, p.y * 80.0));
    vec3 col = AUR_SNOW * (aurAmb * 3.2 + aurMoonLight * 1.2 + aurLight * 2.4) * (0.78 + 0.18 * grain - 0.2 * below);
    return vec4(col, 1.0);
  }
  float ax = -aurHW + 0.09 * aurSx;
  float bx = -aurHW + 0.30 * aurSx;
  float cx = aurHW - 0.05;
  vec3 bc;
  if (aurBirch(p, ax, aurBankTop(ax) - 0.025, 0.022, 1.0, bc)
   || aurBirch(p, bx, aurBankTop(bx) - 0.025, 0.0145, 2.0, bc)
   || aurBirch(p, cx, aurBankTop(cx) - 0.025, 0.016, 3.0, bc)) {
    return vec4(bc, 1.0);
  }
  return vec4(0.0);
}

// The passage, in the world: on the way in the camera comes down from the stars and settles on the
// fjord (a touch of overshoot) while the three curtains unfurl one after another, each sweeping
// along its arc from a faint high arc to its full drape as the rays drop ray by ray; the cabin's
// smoke then climbs. On the way out the curtains roll back up into faint arcs (the far end first)
// and the camera lifts to the stars. Everything keeps its rest value (tilt 0, unfurl 1, smoke 1,
// glow gate 1) when nothing is passing.
void aurPassage() {
  aurTilt = 0.0;
  aurUnfurl[0] = 1.0;
  aurUnfurl[1] = 1.0;
  aurUnfurl[2] = 1.0;
  aurSmokeFront = 1.0;
  aurGlowGate = 1.0;
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return;
  float x = clamp(pin / 0.82, 0.0, 1.0);
  float x2 = x * x * (3.0 - 2.0 * x);
  float back = x2 - 1.0;
  float settle = 1.0 + 2.1 * back * back * back + 1.1 * back * back;
  float leave = pout * pout * (3.0 - 2.0 * pout);
  aurTilt = 0.22 * (1.0 - settle) + 0.26 * leave;
  float glow = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float inU = clamp((pin - 0.10 - 0.08 * fi) / 0.62, 0.0, 1.0);
    float outU = 1.0 - clamp((pout - 0.06 * fi) / 0.70, 0.0, 1.0);
    aurUnfurl[i] = min(inU, outU);
    glow += aurUnfurl[i] / 3.0;
  }
  aurGlowGate = 0.7 + 0.3 * glow;
  float sf = clamp((pin - 0.35) / 0.65, 0.0, 1.0);
  aurSmokeFront = 1.0 - (1.0 - sf) * (1.0 - sf);
}

// The night's frame: placements, aurora colours, the light on the land and the corona's envelope.
void aurSetup(float aspect) {
  aurT = uMotionTime;
  aurPassage();
  aurPx = 1.0 / uRes.y;
  aurHW = 0.5 * aspect;
  aurSx = clamp(aspect / 1.78, 0.45, 1.0);
  aurCabinX = 0.40 * aurHW;
  aurMoonAt = vec2(-0.42 * aurHW, 0.545);
  aurOver = K_snow > 0.0 ? weatherOvercast(0.0, K_snow) : 0.0;
  aurVis = 1.0 - 0.85 * aurOver;
  aurLow = aurLowColour();
  aurHigh = aurHighColour();
  aurFrom = aurFromAt();
  aurTo = aurToAt();
  aurGain = aurGainAt();
  aurLight = aurLow * K_glow * 0.075 * aurVis * (0.92 + 0.08 * sin(aurT * 0.11)) * aurGlowGate;
  aurMoonLight = vec3(0.30, 0.36, 0.52) * K_moon * 0.55 * (1.0 - 0.8 * aurOver);
  aurAmb = vec3(0.035, 0.050, 0.095) * (1.0 - 0.3 * aurOver) + aurLight + aurMoonLight * 0.25;
  aurHaze = vec3(0.030, 0.060, 0.090) + aurLight * 1.1 + aurMoonLight * 0.2;
  aurStars = skyAt(0.0);
  aurStars.moon = vec3(0.0, -1.0, 0.0);
  aurCorona = aurCoronaEnv() * aurVis;
}

Shade sceneAurora(vec2 screenUv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  aurSetup(aspect);
  // The camera's tilt (zero at rest, where uv == screenUv). The snow is weather in front of the
  // lens and stays in screen space.
  vec2 uv = screenUv + vec2(0.0, aurTilt);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  aurAccent = 0.0;
  float depth = 1.0;
  float fogDist = 1.0;
  float fogHeight = max(p.y - AUR_HZ, 0.0) * 6.0;
  vec3 col;
  float fgDepth;
  vec4 fg = aurForeground(p, fgDepth);
  if (fg.a > 0.5) {
    col = fg.rgb;
    depth = fgDepth;
    fogDist = 0.05;
    fogHeight = 0.0;
  } else if (p.y < AUR_HZ) {
    float range;
    col = aurWater(p, range);
    depth = weatherDepth(range);
    fogDist = 1.0 - exp(-range / 160.0);
    fogHeight = 0.0;
  } else {
    col = aurFar(p, false);
  }

  // Mist lying on the fjord: the far shore fades first, and it lies low.
  if (K_fog > 0.0) {
    vec3 mist = AUR_SNOW * (aurAmb * 1.6 + aurLight * 1.2 + aurMoonLight * 0.5) * 0.8 + aurHaze * 0.5;
    float f = fogAmount(K_fog, fogDist, fogHeight);
    col = mix(col, mist, f);
    aurAccent *= 1.0 - f;
  }
  // Falling snow, in depth to the first thing the eye meets.
  if (K_snow > 0.0) {
    Precip pr = snowFall(screenUv, aspect, t, K_snow, K_wind, depth);
    vec3 air = AUR_SNOW * (aurAmb * 2.4 + aurMoonLight * 0.6 + aurLight * 1.5);
    col = precipOver(col, air, max(air * 1.3, vec3(0.08)), pr);
    aurAccent *= 1.0 - pr.veil;
  }

  return shadeOf(col, inkOf(col, 1.4, 0.8), clamp(aurAccent * 1.6, 0.0, 1.0));
}
`;
