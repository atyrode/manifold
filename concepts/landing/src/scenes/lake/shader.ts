// The frozen lake, drawn (sim.ts grows its cracks, drifts its snow and paces its aurora).
//
// The camera stands on the ice, EYE metres up, facing north across a lake ringed with spruce
// forest, low hills and snowy mountains behind; a point reaches out from the left with a log
// cabin on it, its window lit and smoke rising until it flattens under the cold air above. The
// aurora hangs over the north (the shared library, recoloured, paced by the sim's substorms and
// spreading overhead in a surge), with stars, the Milky Way and our own moon with its phase.
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
import { glslFloat, glslPick } from "../../shaders/glsl.ts";
import { ABOVE_RANGE, DIST_RANGE, DRIFT_MAX, EYE, FIELD_FU, FIELD_FV, FIELD_H, FIELD_W, FOCAL, HORIZON, ICE_DEPTH, ICE_INDEX, LAKE_PASSAGE, MARK_ID, SNOW_MAX } from "./sim.ts";

/** The aurora's colours by the `hue` knob (green, teal, storm, crimson): its low light and its high fringe. */
const AURORA_LOW = ["vec3(0.25, 1.0, 0.55)", "vec3(0.2, 0.95, 0.88)", "vec3(0.38, 1.0, 0.48)", "vec3(1.0, 0.3, 0.38)"] as const;
const AURORA_HIGH = ["vec3(0.78, 0.2, 0.58)", "vec3(0.38, 0.32, 1.0)", "vec3(1.0, 0.14, 0.26)", "vec3(0.72, 0.06, 0.24)"] as const;

/** Trigger slot of the shooting stars' "now" button (0 substorms, 1 singing ice, 2 the M). */
export const LAKE_METEOR_TRIGGER = 3;

export const lakeGlsl = `
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
const vec3 LAKE_SNOW = vec3(0.86, 0.9, 1.0);
const vec3 LAKE_FLASH = vec3(0.78, 0.93, 1.0);
const vec3 LAKE_WATER = vec3(0.003, 0.009, 0.012);
// The Milky Way's pole: the band rises from low on the right to high over the middle.
const vec3 LAKE_GALAXY = vec3(-0.2984, -0.7957, 0.5272);
// Depths (m) of the layers of frozen bubbles, and the spacing of the seeps on the lake bed (m).
const float LAKE_LAYER[5] = float[5](0.04, 0.13, 0.26, 0.42, 0.62);
const float LAKE_SEEP = 1.1;

// Set once per pixel by lakeSetup.
float lakeTh;          // this cell's dither threshold
float lakeT;           // the scene clock
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
float lakeAurClock;    // the clock to hand aurora()
float lakeSurge;       // the substorm, 0..1
float lakeAurVis;      // how much of the aurora twilight and cloud let through
float lakeOver;        // overcast 0..1
float lakeCabinAz;     // the cabin's bearing (rad)
float lakePar;         // the backdrop's parallax turn (rad)
float lakeAccent;      // aurora light gathered by lakeSkyAt
float lakeMeteorAt;    // seconds since the latest shooting star, and its id (meteorAge)
float lakeMeteorSeed;

// The coverage of something with a crisp edge, made all-or-nothing against this cell's threshold:
// a soft edge would step its three channels through the levels at different moments.
float lakeHard(float cover) {
  return cover > lakeTh ? 1.0 : 0.0;
}

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
  vec3 a = aurora(d, lakeAurClock, lakeAurGain);
  if (soft > 0.0) a = 0.5 * (a + aurora(normalize(d + vec3(0.0, soft, 0.0)), lakeAurClock, lakeAurGain));
  if (lakeSurge > 0.03) {
    vec3 high = normalize(vec3(d.x * 1.15, d.y * 0.6, d.z));
    a += aurora(high, lakeAurClock * 1.3 + 41.0, lakeAurGain * 0.8 * smoothstep(0.03, 0.7, lakeSurge));
  }
  float low = max(0.78 * a.g - 0.2 * a.r, 0.0) / 0.73;
  float fringe = max(a.r - 0.25 * a.g, 0.0) / 0.73;
  return (low * lakeAurLow + fringe * lakeAurHigh) * lakeAurVis;
}

// The Milky Way: a band of soft star clouds across the sky with a dark dust lane down it, 0..~1.3.
float lakeMilkyWay(vec3 d) {
  float b = dot(d, LAKE_GALAXY);
  if (d.y <= 0.0 || abs(b) > 0.35) return 0.0;
  vec3 e1 = normalize(cross(LAKE_GALAXY, vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(LAKE_GALAXY, e1);
  float l = atan(dot(d, e2), dot(d, e1));
  float band = exp(-b * b / 0.014);
  float clouds = 0.55 * vnoise(vec2(l * 8.0, b * 26.0)) + 0.45 * vnoise(vec2(l * 21.0 + 3.0, b * 60.0));
  float lane = (b - 0.02 - 0.015 * sin(l * 5.0)) / 0.016;
  float dust = 1.0 - 0.75 * exp(-lane * lane) * smoothstep(0.25, 0.6, vnoise(vec2(l * 4.0, 7.0)));
  return band * (0.35 + 0.9 * clouds) * dust * smoothstep(0.0, 0.15, d.y);
}

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
// the Milky Way and stars (fainter in the mirror), our moon, a shooting star, the aurora, and cloud
// while it snows. Adds the aurora's light that shows to lakeAccent.
vec3 lakeSkyAt(vec3 d, bool mirror, float soft) {
  vec3 col = skyColor(lakeSky, d);
  float hh = max(d.y, 0.0);
  col += vec3(0.02, 0.03, 0.062) * lakePhase * lakeSky.night * (0.5 + 0.5 * exp(-hh * 3.0)) * (1.0 - lakeOver);
  col += lakeAurLight * 0.6 * exp(-hh * 8.0);
  Sky starry = lakeSky;
  starry.moon = lakePhase > 0.0 ? lakeMoon : vec3(0.0, -1.0, 0.0);
  float mw = lakeMilkyWay(d) * K_stars * lakeSky.night * (1.0 - 0.75 * lakePhase);
  col += vec3(0.045, 0.048, 0.064) * mw;
  float density = K_stars * (0.7 + 0.8 * mw) * (1.0 - 0.6 * lakePhase);
  col += skyStarLight(starry, d, mirror ? 0.5 * density : density) * (mirror ? 0.6 : 1.0);
  float disc;
  vec3 moon = lakeMoonAt(d, disc);
  col = col * (1.0 - 0.9 * disc) + moon;
  float meteor = meteorStreak(skyAngles(d), LAKE_METEOR_FIELD, lakeMeteorAt, lakeMeteorSeed, max(1.0 / (LAKE_FOCAL * uRes.y), soft));
  col += METEOR_TINT * hardEdge(meteor * lakeSky.night * (1.0 - disc)) * (mirror ? 0.6 : 1.0);
  vec3 aur = lakeAurora(d, soft);
  col += aur;
  float seen = dot(aur, LUMA);
  if (lakeOver > 0.0) {
    vec4 deck = skyClouds(lakeSky, d, lakeT, lakeOver, K_wind);
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
// in the roughness).
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
    line = lakeHard((1.0 - smoothstep(w - 0.7, w + 0.7, cells)) * far * step(0.02, near.b));
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
        float plane = lakeHard((1.0 - smoothstep(0.75, 1.0, q)) * (0.6 + 0.4 * hackle) * far);
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

  // The moon's path: facets of the ice tipped toward it, glinting below its image.
  float azr = atan(r.x, r.z) + lakePar;
  float elr = r.y / length(r.xz);
  if (lakePhase > 0.0) {
    float spread = rough * 2.5 + 0.006;
    float da = (azr - lakeMoonAz) / (0.012 + spread * 0.6);
    float de = (elr - lakeMoonEl) / (spread * 4.0);
    float path = exp(-da * da - de * de);
    float facet = hash12(floor(P * vec2(16.0, 5.0)) + 0.37);
    col += lakeMoonLight * (0.6 * path + 1.6 * lakeHard(path * smoothstep(0.82, 0.97, facet))) * (1.0 - lakeOver);
  }
  // The window's light, drawn down the ice toward us.
  if (K_cabin > 0.5) {
    float elw = (LAKE_BANK + 1.3) / max(LAKE_CABIN_Z - range, 5.0);
    float da = (azr - lakeCabinAz + 1.1 / LAKE_CABIN_Z) / (0.004 + rough * 0.25);
    float de = (elr - elw) / (0.004 + rough * 3.5);
    col += LAKE_WINDOW * exp(-da * da - de * de) * 0.5 * refl;
  }

  // Hoarfrost: here and there a crystal on the bare ice catches the light.
  vec2 fc = floor(P / 0.06);
  float hf = hash12(fc + 5.3);
  if (hf > 0.985 && g.foot.x < 0.02) {
    vec2 c = (fc + 0.3 + 0.4 * vec2(fract(hf * 61.0), fract(hf * 83.0))) * 0.06;
    float dd = length((P - c) / max(g.foot, vec2(0.006)));
    col = mix(col, LAKE_SNOW * (under * 2.0 + lakeMoonLight * 0.8), lakeHard(1.0 - smoothstep(0.6, 1.6, dd)) * 0.8);
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
  s.bare = s.ids.r * 255.0 > LAKE_MARK - 0.5 && s.near.r * LAKE_DIST * uRes.y < 4.0 + 2.0 * lakeTh;
  s.powder = K_fresh * (0.65 + 0.35 * s.sn.b);
  // Powder feathers the patches' edges into a stipple, evenly either side of where they begin, so
  // about as much of the ice stays covered.
  float feather = 0.05 + 0.12 * s.powder;
  s.cover = s.bare ? 0.0 : max(lakeHard(smoothstep(s.th0 - feather, s.th0 + feather, s.amount)), lakeHard(s.lying));
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
      col = mix(col, LAKE_SNOW * (snowLight * 1.6 + lakeMoonLight * 2.0), lakeHard((1.0 - smoothstep(0.5, 1.4, dd)) * twinkle));
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
    col = mix(col, LAKE_SNOW * snowLight * 1.05, lakeHard(snake) * 0.85);
    col = mix(col, LAKE_SNOW * snowLight * 0.85, clamp(drift * 0.6 * smoothstep(4.0, 60.0, range), 0.0, 0.4));
  }

  if (range > 40.0) {
    float far = smoothstep(40.0, 260.0, range) * 0.5;
    col = mix(col, horizonHaze(lakeSky, dir, 0.01) * 0.9 + lakeAurLight * 0.5, far);
    glow *= 1.0 - far;
  }
  return col;
}

// The camera arriving from the aurora: the share of the tilt still to go at progress p. A damped
// spring from the sky down onto the ice, settling a little past level (the overshoot eased out by
// the end, so it lands on exactly zero).
float lakeArrive(float p) {
  float q = clamp(p, 0.0, 1.0);
  float e = 1.0 - exp(-4.0 * q) * (cos(3.6 * q) + (4.0 / 3.6) * sin(3.6 * q));
  return (1.0 - e) * (1.0 - smoothstep(0.88, 1.0, q));
}

// The camera leaving toward the aurora: the share of the tilt done at progress p, easing in once
// the gust has begun.
float lakeLeave(float p) {
  float q = clamp((p - 0.1) / 0.9, 0.0, 1.0);
  return q * q * (3.0 - 2.0 * q);
}

// A gust of blown snow, 0..1 at this uv (the camera's, tilt included): its head crosses the frame
// downwind, and behind it low streamers ride the ice in rows of the screen, the nearer rows faster,
// thinning to nothing over the horizon; a haze of fine snow between them. Each row's streamers slide
// along it (no noise crawl); the caller cuts the density against the cell's threshold.
float lakeGust(vec2 uv, float aspect, float gp) {
  float fv = LAKE_HORIZON - uv.y;
  float uu = (K_wind < -0.05 ? -1.0 : 1.0) * (uv.x - 0.5) * aspect;
  float head = mix(-0.5 * aspect - 0.3, 0.5 * aspect + 1.2, smoothstep(0.0, 0.9, gp));
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
// the light on the land, overcast while it snows, the cabin's and the moon's bearings for the frame.
void lakeSetup(float t, float aspect) {
  lakeT = t;
  lakeTm = uMotionTime;
  float hour = clamp(K_hour, 0.0, 1.0);
  Sky sky = skyAt(0.78 + 0.075 * hour * hour);
  float halfAz = atan(0.5 * aspect, LAKE_FOCAL);
  lakeCabinAz = -min(0.36, 0.72 * halfAz);
  lakeMoonAz = min(0.52, 0.75 * halfAz);
  lakeMoonEl = 0.15;
  lakeMoon = vec3(sin(lakeMoonAz) * cos(lakeMoonEl), sin(lakeMoonEl), cos(lakeMoonAz) * cos(lakeMoonEl));
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
  // aurora() runs its curtains on t * uMotion: hand it the sim's clock (already motion time,
  // sped up through a surge) with the motion divided back out.
  lakeAurClock = (au.y + au.z) / max(uMotion, 1e-4);
  lakeAurVis = mix(0.45, 1.0, sky.night) * (1.0 - 0.9 * lakeOver);
  lakeAurLow = lakeAuroraLowColour();
  lakeAurHigh = lakeAuroraHighColour();
  lakeAurLight = lakeAurLow * lakeAurGain * 0.05 * lakeAurVis;
  lakeAmb = greyed(amb, vec3(0.92, 0.95, 1.0), 0.6 * lakeOver) + lakeAurLight + lakeMoonLight * 0.25;
  lakePar = uPointer.x * 0.012;
}

Shade sceneLake(vec2 screenUv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  // The camera's tilt, a lens shift of uv (exactly nothing at rest).
  vec2 uv = screenUv;
  float pin = passageIn();
  float pout = passageOut();
  if (pin < 1.0) uv.y += LAKE_TILT * lakeArrive(pin);
  if (pout > 0.0) uv.y += LAKE_TILT * lakeLeave(pout);
  lakeTh = threshold(cell);
  lakeSetup(t, aspect);
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
    float hit = lakeHard(lakeGust(uv, aspect, pout));
    vec3 blown = LAKE_SNOW * (lakeAmb * 2.6 + lakeMoonLight * 0.9 + lakeAurLight * 2.2);
    col = mix(col, blown, 0.85 * hit);
    glow *= 1.0 - 0.85 * hit;
  }
  // Falling snow, in depth to the first thing the eye meets.
  if (K_snow > 0.0) {
    Precip p = snowFall(uv, aspect, t, K_snow, K_wind, weatherDepth(range));
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
