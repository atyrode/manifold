// The mystic forest's picture, back to front: the mist (luminous grey-green, near white up toward the
// canopy, lit by the sky and by shafts of sun or moon falling through the canopy's gaps), the sky in
// those gaps, the floor (moss, cedar litter and roots, the stream a ribbon of light with the bed
// showing through near and the mist and the torii mirrored far, foam round the stepping stones), three
// layers of far trunks fading into the mist, the stag crossing between them, the torii over the stream
// half swallowed by moss with mushrooms at its foot, the fallen log, the old beech with its branch and
// beards of lichen, the stepping stones, the near boulder, the great cedar with its rope and paper
// streamers, the boulder its roots grip (or the M they grew into), the ferns in the corners; then the
// spirits on their perches, the glow of mushrooms, spirits and M in the air, the mist's drifting banks,
// the spores (round the mushrooms and in the shafts), the drips off the canopy and the rain, in depth.
// Rain closes the sky, greys and thickens the mist, and (through uWeather.x, how wet the forest is)
// darkens and glosses every surface, pools on the floor, rings the stream and keeps the beards, the
// torii and the canopy dripping as it dries.
// The passage is the camera's: coming in it starts FOREST_DOLLY.back m behind its resting place and
// dollies forward between the trunks (slow start, a small overshoot, a settle) while the spirits (the
// sim's) pop up one by one; going out it drifts back into the mist. Every layer is placed at its own
// depth by forestAt (nearer things slide further, the pointer's parallax too), the floor and the mist
// by the camera's true distance. All of it is exactly off at rest (forestCamD == 0).
// The sim (sim.ts) moves the spirits, the stag, the motes and the mist field; its textures are
// described there. Knobs read here: K_spirits (via the sim), K_mushrooms, K_spores, K_stream, K_mist,
// K_shafts, K_forestSeed, K_time, K_cycle, K_rain, K_wind, K_mark; triggers 2 (the M) and 3 (spores).
import { glslFloat } from "../../shaders/glsl.ts";
import {
  FOREST_BEARD_SPACING,
  FOREST_BRANCH,
  FOREST_DOLLY,
  FOREST_ELDER,
  FOREST_EYE,
  FOREST_GATE_SHROOMS,
  FOREST_HERO,
  FOREST_HORIZON,
  FOREST_LOG,
  FOREST_MARK,
  FOREST_MIN_ASPECT,
  FOREST_MOTE_ROWS,
  FOREST_PASSAGE,
  FOREST_ROCK_LEFT,
  FOREST_ROCK_RIGHT,
  FOREST_SPIRITS,
  FOREST_STAG,
  FOREST_STONES,
  FOREST_STREAM,
  FOREST_TORII,
} from "./sim.ts";

/** A number as a GLSL float literal. */
const f = (value: number): string => value.toFixed(4);
const stones = FOREST_STONES.map((s) => `vec4(${f(s.z)}, ${f(s.offset)}, ${f(s.radius)}, ${f(s.height)})`).join(", ");

export const forestGlsl = `
// ---- forest ----
const float FOREST_HORIZON = ${f(FOREST_HORIZON)};
const float FOREST_EYE = ${f(FOREST_EYE)};
const float FOREST_MIN_ASPECT = ${f(FOREST_MIN_ASPECT)};
// The passage (sim.ts FOREST_PASSAGE, FOREST_DOLLY): seconds the entrance takes (the exit needs only its
// progress); metres the camera starts back, seconds its dolly takes, metres it drifts back on the way out.
const float FOREST_ENTER = ${glslFloat(FOREST_PASSAGE.enter)};
const vec3 FOREST_DOLLY = vec3(${glslFloat(FOREST_DOLLY.back)}, ${glslFloat(FOREST_DOLLY.settle)}, ${glslFloat(FOREST_DOLLY.drift)});
// The stream: centre - swing sin((z - from) rate), half-width half + widen z (see sim.ts).
const vec4 FOREST_STREAM = vec4(${f(FOREST_STREAM.centre)}, ${f(FOREST_STREAM.swing)}, ${f(FOREST_STREAM.rate)}, ${f(FOREST_STREAM.from)});
const vec2 FOREST_STREAM_W = vec2(${f(FOREST_STREAM.half)}, ${f(FOREST_STREAM.widen)});
// The named trees: (radius, flare, flare height, lean).
const vec4 FOREST_HERO_SHAPE = vec4(${f(FOREST_HERO.radius)}, ${f(FOREST_HERO.flare)}, ${f(FOREST_HERO.flareHeight)}, ${f(FOREST_HERO.lean)});
const float FOREST_HERO_EDGE = ${f(FOREST_HERO.edge)};
const float FOREST_HERO_Z = ${f(FOREST_HERO.z)};
const float FOREST_HERO_SALT = 3.1;   // its bark's pattern, and its wander (forestBigAxis)
const vec4 FOREST_ELDER_SHAPE = vec4(${f(FOREST_ELDER.radius)}, ${f(FOREST_ELDER.flare)}, ${f(FOREST_ELDER.flareHeight)}, ${f(FOREST_ELDER.lean)});
const float FOREST_ELDER_EDGE = ${f(FOREST_ELDER.edge)};
const float FOREST_ELDER_Z = ${f(FOREST_ELDER.z)};
// The mushrooms on the moss mound at the torii's left foot, in the torii's own frame (m).
const vec2 FOREST_GATE_SHROOMS = vec2(${f(FOREST_GATE_SHROOMS.x)}, ${f(FOREST_GATE_SHROOMS.y)});
// The beech's branch: (height, length, rise, sag), (radius, tip radius, root in trunk radii).
const vec4 FOREST_BRANCH_A = vec4(${f(FOREST_BRANCH.height)}, ${f(FOREST_BRANCH.length)}, ${f(FOREST_BRANCH.rise)}, ${f(FOREST_BRANCH.sag)});
const vec3 FOREST_BRANCH_B = vec3(${f(FOREST_BRANCH.radius)}, ${f(FOREST_BRANCH.tip)}, ${f(FOREST_BRANCH.root)});
const float FOREST_BEARD = ${f(FOREST_BEARD_SPACING)};
// Boulders: (edge, depth, radius across, radius up), centre height.
const vec4 FOREST_ROCKL = vec4(${f(FOREST_ROCK_LEFT.edge)}, ${f(FOREST_ROCK_LEFT.z)}, ${f(FOREST_ROCK_LEFT.rx)}, ${f(FOREST_ROCK_LEFT.ry)});
const float FOREST_ROCKL_C = ${f(FOREST_ROCK_LEFT.centre)};
const vec4 FOREST_ROCKR = vec4(${f(FOREST_ROCK_RIGHT.edge)}, ${f(FOREST_ROCK_RIGHT.z)}, ${f(FOREST_ROCK_RIGHT.rx)}, ${f(FOREST_ROCK_RIGHT.ry)});
const float FOREST_ROCKR_C = ${f(FOREST_ROCK_RIGHT.centre)};
// The log: (from, to, depth, radius).
const vec4 FOREST_LOG = vec4(${f(FOREST_LOG.from)}, ${f(FOREST_LOG.to)}, ${f(FOREST_LOG.z)}, ${f(FOREST_LOG.radius)});
const float FOREST_TORII_Z = ${f(FOREST_TORII.z)};
const float FOREST_TORII_SPAN = ${f(FOREST_TORII.span)};
const float FOREST_TORII_H = ${f(FOREST_TORII.height)};
const float FOREST_TORII_BEAM = ${f(FOREST_TORII.beam)};
const float FOREST_TORII_OVER = ${f(FOREST_TORII.overhang)};
const float FOREST_TORII_LEAN = ${f(FOREST_TORII.lean)};
// Stepping stones: (depth, offset from the stream's centre, radius, height above the water).
const vec4 FOREST_STONE[${FOREST_STONES.length}] = vec4[${FOREST_STONES.length}](${stones});
const vec2 FOREST_MARK = vec2(${f(FOREST_MARK.lift)}, ${f(FOREST_MARK.size)});
const float FOREST_STAG_Z = ${f(FOREST_STAG.z)};
const float FOREST_STAG_STRIDE = ${f(FOREST_STAG.stride)};
const int FOREST_SPIRITS = ${FOREST_SPIRITS};
const float FOREST_MOTE_ROWS = ${f(FOREST_MOTE_ROWS)};
// The rope round the great cedar, its height (m).
const float FOREST_ROPE_H = 1.95;
// Far trunks, three layers near to far: depth, grid spacing, radius (m), share of cells holding one.
const float FOREST_TREE_Z[3] = float[3](10.0, 15.5, 28.0);
const float FOREST_TREE_SP[3] = float[3](4.4, 4.2, 3.8);
const float FOREST_TREE_R[3] = float[3](0.7, 0.62, 0.55);
const float FOREST_TREE_FILL[3] = float[3](0.62, 0.72, 0.85);
// The near boulder's roots in its own units (x in its radius across, y in its radius up): one across
// its upper face from the cedar's foot (the M's top corners hang from it), one lower across its face
// (the M takes its place), one low on its left.
const vec2 FOREST_ROOT_A[5] = vec2[5](vec2(-1.45, 0.5), vec2(-0.85, 0.63), vec2(-0.3, 0.67), vec2(0.3, 0.62), vec2(0.9, 0.3));
const vec2 FOREST_ROOT_B[5] = vec2[5](vec2(-1.3, 0.15), vec2(-0.75, 0.36), vec2(-0.2, 0.33), vec2(0.25, 0.08), vec2(0.42, -0.35));
const vec2 FOREST_ROOT_C[5] = vec2[5](vec2(-1.25, -0.12), vec2(-0.95, 0.06), vec2(-0.7, -0.05), vec2(-0.55, -0.3), vec2(-0.5, -0.6));

const vec3 FOREST_CEDAR = vec3(0.42, 0.25, 0.16);       // cedar bark: red-brown strips
const vec3 FOREST_CEDAR_OLD = vec3(0.38, 0.33, 0.28);   // weathered to grey
const vec3 FOREST_BEECH = vec3(0.46, 0.47, 0.43);       // smooth grey beech
const vec3 FOREST_LICHEN = vec3(0.66, 0.70, 0.60);
const vec3 FOREST_MOSS = vec3(0.34, 0.60, 0.10);
const vec3 FOREST_MOSS_DEEP = vec3(0.09, 0.26, 0.06);
const vec3 FOREST_MOSS_LIT = vec3(0.72, 0.92, 0.22);    // moss with the light grazing it
const vec3 FOREST_ROCK = vec3(0.40, 0.41, 0.39);
const vec3 FOREST_LITTER = vec3(0.27, 0.18, 0.11);      // cedar needles and soil
const vec3 FOREST_FERN = vec3(0.22, 0.50, 0.13);
const vec3 FOREST_FERN_LIT = vec3(0.55, 0.85, 0.25);    // light through a frond
const vec3 FOREST_USNEA = vec3(0.58, 0.64, 0.52);       // beard lichen
const vec3 FOREST_VERMILION = vec3(0.66, 0.24, 0.13);   // the torii's faded lacquer
const vec3 FOREST_STRAW = vec3(0.72, 0.62, 0.40);       // the rope
const vec3 FOREST_PAPER = vec3(0.92, 0.92, 0.88);       // its streamers
const vec3 FOREST_SPIRIT = vec3(0.88, 0.93, 0.86);      // a spirit's chalky white
const vec3 FOREST_GLOW = vec3(0.66, 1.0, 0.80);         // spirit light
const vec3 FOREST_CAP = vec3(0.80, 0.74, 0.60);
const vec3 FOREST_SHROOM_GLOW = vec3(0.50, 1.0, 0.72);
const vec3 FOREST_MIST_LOW = vec3(0.46, 0.56, 0.56);
const vec3 FOREST_MIST_HIGH = vec3(0.86, 0.91, 0.86);
const vec3 FOREST_SUNLIT = vec3(1.0, 0.95, 0.80);       // sunlight through the cedars: gold-white
const vec3 FOREST_NEEDLE = vec3(0.10, 0.20, 0.10);      // the canopy
const vec3 FOREST_WATER = vec3(0.05, 0.09, 0.08);
const vec3 FOREST_STAG_COAT = vec3(0.16, 0.13, 0.11);

// This pixel's light, set once at the top of sceneForest.
Sky forestSky;
float forestAspect;
float forestLA;        // the aspect the layout is made for (never narrower than FOREST_MIN_ASPECT)
float forestTh;        // this cell's dither threshold
float forestLevel;     // how bright the sky is (luminance of its ambient light)
vec3 forestFill;       // the soft light under the canopy, on every side of things
vec3 forestTop;        // the light from the canopy's gaps on whatever faces up (moss tops, the floor)
vec3 forestKey;        // direct sun and moon, where a shaft gets through
vec2 forestKeySide;    // their horizontal direction (x across, z into the scene), unit
vec3 forestKeyDir;     // toward the key light (x across, y up, z into the scene), unit
float forestBeam;      // 0..1: how much this point lies in a shaft (lights what it falls on)
vec3 forestRayLight;   // the shafts' colour
vec3 forestMist;       // the mist's colour here, shafts included
vec3 forestSheen;      // the bright mist above: what wet surfaces mirror
float forestWisp;      // the mist's thickness here (the sim's field), about 1
float forestRain;      // K_rain
float forestRainHere;  // the rain reaching this point through the canopy
float forestOvercast;  // how far the rain's cloud has closed the sky
float forestCloud;     // that cloud deck's brightness (luminance)
float forestWet;       // how wet the forest is (uWeather.x)
float forestGloss;     // the sheen of wet upright surfaces
float forestNight;     // 0 by day .. 1 at dusk and night: how much the glows show
float forestRaySlant;  // the shafts' angle from straight down, + falling toward -x
vec3 forestRaySrc;     // screen x where each shaft leaves the canopy
vec4 forestShroom[6];  // mushroom clusters: screen xy (parallax 0), depth, strength
float forestShroomGlow;
vec3 forestDropLit;    // the light a drop of water shows
vec2 forestPar;        // parallax: nearer things slide further (divided by depth)
float forestHeroX;     // screen x of the great cedar's axis
float forestElderX;    // screen x of the beech's axis
float forestToriiX;    // world x (m) of the torii's centre
float forestCamD;      // the camera's advance (m) from where it rests: 0 at rest, - while it is behind
float forestCamMove;   // 0..1: how fast it is moving (the floor's fine pattern would crawl past, so it calms)

// The dolly's progress 0..1 over x = 0..1: a slow start, an arrival a little early with a small
// overshoot (to about 1.05) and a settle back, exactly 1 from x = 1.
float forestSettle(float x) {
  x = clamp(x, 0.0, 1.0);
  float bob = smoothstep(0.5, 1.0, x);
  return smoothstep(0.0, 0.8, x) + 0.05 * sin(0.5 * TAU * bob);
}

// The camera's advance (m) from where it rests, set once at the top of sceneForest (with forestCamMove):
// exactly 0 at rest.
float forestCamera() {
  float pin = passageIn();
  float pout = passageOut();
  forestCamMove = 0.0;
  if (pin >= 1.0 && pout <= 0.0) return 0.0;
  float d = 0.0;
  if (pin < 1.0) {
    float x = pin * FOREST_ENTER / FOREST_DOLLY.y;
    float u = clamp(x / 0.8, 0.0, 1.0);
    d -= FOREST_DOLLY.x * (1.0 - forestSettle(x));
    forestCamMove = 4.0 * u * (1.0 - u);
  }
  if (pout > 0.0) {
    d -= FOREST_DOLLY.z * pout * pout * (3.0 - 2.0 * pout);
    forestCamMove = max(forestCamMove, 4.0 * pout * (1.0 - pout));
  }
  return d;
}

// Screen point p as the resting camera would see the same world point of a layer at depth z (m): the
// camera's advance scales the view about the vanishing point (the horizon, the middle), more for what
// is near. forestAt adds the pointer's parallax.
vec2 forestScale(vec2 p, float z) {
  if (forestCamD == 0.0) return p;
  vec2 c = vec2(0.0, FOREST_HORIZON);
  return c + (p - c) * (1.0 - forestCamD / z);
}

vec2 forestAt(vec2 p, float z) {
  return forestScale(p, z) + forestPar / z;
}

// The coverage of something that moves, made all-or-nothing against this cell's dither threshold, so
// a passing edge flips each cell once instead of stepping its three colour channels apart.
float forestHard(float cover) {
  return cover > forestTh ? 1.0 : 0.0;
}

float forestBell(float x) {
  return exp(-x * x);
}

float forestCapsule(vec2 p, vec2 a, vec2 b, float r) {
  return segmentDistance(p, a, b) - r;
}

// The nearest point to q on segment a-b: xy the point, z the distance, w the parameter along it.
vec4 forestNearest(vec2 q, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 c = a + ab * h;
  return vec4(c, length(q - c), h);
}

float forestStreamX(float z) {
  return FOREST_STREAM.x - FOREST_STREAM.y * sin((z - FOREST_STREAM.w) * FOREST_STREAM.z);
}

float forestStreamHalf(float z) {
  return FOREST_STREAM_W.x + FOREST_STREAM_W.y * z;
}

// A trunk's half-width (m) at height h: radius r, widened by 'flare' at the foot, fading over fh m.
float forestFlare(float h, float r, float flare, float fh) {
  return r * (1.0 + flare * exp(-max(h, 0.0) / fh));
}

// A point on top of a boulder (centre c, radii rs, screen units), u across it (-1..1).
vec2 forestOnRock(vec2 c, vec2 rs, float u) {
  return c + vec2(u * rs.x, rs.y * sqrt(1.0 - u * u));
}

// The mist as the sky lights it: pale and luminous, a cool grey-green low in the forest's depths and
// near white up toward the canopy where the light comes in (by day it outshines every trunk standing in
// it), warmer on the sun's side, blue-green toward the moon, with a faint glow of its own at night.
// Under rain cloud it goes a flatter pale green-grey.
vec3 forestMistColor(vec2 p) {
  Sky s = forestSky;
  float up = smoothstep(0.05, 1.0, p.y);
  float ov = forestOvercast;
  float rise = mix(0.6, 0.9, s.day) + mix(0.75, 0.6, s.day) * up;
  vec3 c = mix(FOREST_MIST_LOW, FOREST_MIST_HIGH, up) * forestLevel * mix(rise, 0.8 + 0.4 * up, ov);
  float toward = clamp(0.5 + p.x * s.sun.x / forestAspect, 0.0, 1.0);
  c += s.sunColor * FOREST_SUNLIT * (0.03 + 0.15 * toward * toward) * (0.3 + 0.7 * p.y);
  float moonward = clamp(0.5 + p.x * s.moon.x / forestAspect, 0.0, 1.0);
  c += s.moonColor * vec3(0.42, 0.6, 0.72) * (0.2 + 0.35 * p.y * p.y) * (0.6 + 0.8 * moonward);
  c += vec3(0.008, 0.014, 0.016) * forestNight;
  return mix(c, vec3(dot(c, LUMA)) * vec3(0.92, 1.0, 0.98), 0.5 * ov);
}

// How much of something at depth z (m) and height (m above the floor) shows through the mist: thicker
// low down, thicker where the sim's field holds a bank, thicker in the rain.
float forestTransmit(float z, float height) {
  float rain = 0.04 * smoothstep(0.0, 0.15, forestRain) + 0.07 * forestRain * forestRain;
  float dens = (0.01 + 0.075 * K_mist + rain) * forestWisp;
  return exp(-dens * (z - forestCamD) * (1.0 + 0.6 * exp(-max(height, 0.0) / 1.1)));
}

// The shafts: three beams falling from gaps in the canopy (forestRaySrc) at forestRaySlant, narrow at
// the gap and widening as they fall, combed by the shadows of what they passed, each breathing in and
// out over a couple of minutes. x: how much this point lies in a beam, y: the beam's glow in the air.
vec2 forestRays(vec2 p, float tm) {
  float sl = forestRaySlant;
  float b = max(1.02 - p.y, 0.0) / cos(sl);
  float at = p.x + sin(sl) * b;
  float lit = 0.0;
  float glow = 0.0;
  for (int r = 0; r < 3; r++) {
    float h = hash12(vec2(float(r) * 3.7 + 1.0, K_forestSeed * 0.913 + 5.0));
    float across = (at - forestRaySrc[r]) * cos(sl);
    float width = 0.01 + (0.06 + 0.04 * h) * b;
    float beam = 1.0 - smoothstep(0.25 * width, width, abs(across));
    if (beam <= 0.0) continue;
    float comb = smoothstep(0.6, 0.8, vnoise(vec2(across / width * 3.0 + h * 17.0, 0.5)));
    float breathe = 0.75 + 0.25 * sin(tm * (0.045 + 0.03 * h) + h * TAU);
    beam *= (1.0 - 0.6 * comb) * breathe * (0.65 + 0.35 * h);
    lit = max(lit, beam);
    glow += beam * exp(-0.55 * b);
  }
  return vec2(lit, glow);
}

// The mushrooms' light falling on something at screen point p, depth z: each cluster lights about
// half a metre round it.
vec3 forestShroomLight(vec2 p, float z) {
  if (forestShroomGlow <= 0.0) return vec3(0.0);
  float s = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 c = forestShroom[i];
    vec2 v = (p - c.xy) * c.z - vec2(0.0, 0.06);
    float dz = z - c.z;
    s += c.w * exp(-(dot(v, v) + dz * dz) / 0.3);
  }
  return FOREST_SHROOM_GLOW * s * forestShroomGlow * 0.5;
}

// Bark seen side-on, u across the trunk (-1..1), h metres up, hw its half-width there, aa a cell in
// metres at its depth z: a cedar's (kind 0) fibrous red-brown strips parted by deep furrows that wander
// and twist slowly up the bole, or a beech's (kind 1) smooth grey skin with pale lichen; ribbed into
// buttresses at the foot; moss thick at the foot and climbing the shaded side in cushions. Strongly
// round: its edges fall into shadow, the side toward the sun or moon takes their light (gilded where a
// shaft crosses), and only the very edge catches the bright mist behind. Wet, it darkens and its
// strips glisten.
vec3 forestBark(float kind, float u, float h, float hw, float salt, float aa, float z, vec2 at, float mossAmt) {
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float a = asin(clamp(u, -1.0, 1.0));
  float arc = a * hw;
  float face = forestKeySide.x < 0.0 ? -1.0 : 1.0;
  float bold = 1.0 - smoothstep(0.022, 0.045, aa);   // furrows 15 cm apart need a few cells
  float fine = 1.0 - smoothstep(0.008, 0.02, aa);    // the fibres between them
  float wander = vnoise(vec2(arc * 1.3 + salt, h * 0.35 + salt * 2.0)) - 0.5;
  float tw = arc + 0.12 * h * (1.0 - kind) + 0.18 * wander;
  float ridge = abs(fract(tw / 0.15 + salt) - 0.5) * 2.0;
  // Furrows fade where the trunk turns away and they would crowd into less than a cell.
  float furrow = (1.0 - smoothstep(0.05, 0.5, ridge)) * bold * smoothstep(0.15, 0.55, nz) * (1.0 - kind);
  float fib = vnoise(vec2(tw * 26.0 + salt * 13.0, h * 0.9 + salt));
  vec3 cedar = mix(FOREST_CEDAR, FOREST_CEDAR_OLD, smoothstep(0.35, 0.8, vnoise(vec2(tw * 2.2 + salt, h * 0.3 + salt * 2.0))));
  cedar *= (0.78 + 0.44 * mix(0.5, fib, fine)) * (1.0 - 0.85 * furrow);
  float lichen = smoothstep(0.55, 0.75, vnoise(vec2(arc * 3.0 + salt * 9.0, h * 2.2)));
  vec3 beech = mix(FOREST_BEECH * (0.8 + 0.4 * vnoise(vec2(arc * 4.0 + salt, h * 0.6))), FOREST_LICHEN, lichen * 0.75 * max(bold, 0.4));
  vec3 albedo = mix(cedar, beech, kind);
  float mn = vnoise(vec2(a * 2.4 + salt * 5.0, h * 1.1 + salt));
  float shaded = 1.0 - smoothstep(-0.9, 0.4, u * face);
  float mossy = smoothstep(0.5, 0.72, 0.5 * mn + mossAmt * (0.75 * exp(-h / 1.5) + 0.4 * shaded * exp(-h / 6.0)) + 0.12 * forestWet);
  float cushion = mix(0.5, vnoise(vec2(arc * 12.0 + salt, h * 12.0)), fine);
  albedo = mix(albedo, mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.3 + 0.7 * cushion), mossy);
  albedo = wetten(albedo, forestWet, mix(0.4 + 0.2 * (1.0 - kind), 0.9, mossy));
  // Buttresses: broad ribs round the foot, dark in the valleys between them.
  float valley = exp(-h / 0.9) * (0.5 - 0.5 * sin(a * 4.0 + salt * 3.0));
  float lit = clamp(0.5 + 0.5 * (u * face * 0.9 + nz * 0.3), 0.0, 1.0);
  float rounded = (0.1 + 0.9 * pow(nz, 1.3)) * (1.0 - 0.5 * valley);
  vec3 light = forestFill * rounded * (0.5 + 0.8 * lit)
             + forestKey * smoothstep(0.45, 1.0, lit) * (0.45 + 1.2 * forestBeam) * (1.0 - 0.5 * valley)
             + forestShroomLight(at, z) * (0.4 + 0.6 * nz);
  vec3 col = albedo * light;
  col += FOREST_MOSS_LIT * forestKey * (0.15 + forestBeam) * mossy * lit * cushion * 0.3;
  col += forestSheen * forestGloss * (1.0 - 0.7 * mossy) * (1.0 - furrow) * 0.4 * forestBell((u - 0.4 * face) / 0.28) * (0.6 + 0.4 * fib);
  col += forestMist * 0.15 * pow(1.0 - nz, 6.0);
  return col;
}

// The far trunks of layer i (0..2) at q (screen, shifted for parallax): cells of a grid, each of which
// may hold one cedar or beech, leaning a little, flaring into buttresses at the foot; none stands in
// the stream, and the nearer two layers leave the view through the torii open. Returns lit colour and
// coverage; depth (how far the mist takes it to be) and height (m above the floor) out.
vec4 forestTrees(vec2 q, int i, out float depth, out float height) {
  float z = FOREST_TREE_Z[i];
  height = (q.y - (FOREST_HORIZON - FOREST_EYE / z)) * z;
  depth = z;
  if (height < -0.1) return vec4(0.0);
  float hh = max(height, 0.0);
  float xw = q.x * z;
  float sp = FOREST_TREE_SP[i];
  float aa = z / uRes.y;
  float k0 = floor(xw / sp);
  float sx = forestStreamX(z);
  float sh = forestStreamHalf(z);
  float gate = forestToriiX / FOREST_TORII_Z;
  float best = 1e9;
  float axis = 0.0;
  float hwBest = 1.0;
  float hc = 0.0;
  for (int j = -1; j <= 1; j++) {
    float k = k0 + float(j);
    float hk = hash12(vec2(k + 0.5, float(i) * 7.1 + K_forestSeed * 3.17 + 40.0));
    if (fract(hk * 5.31) > FOREST_TREE_FILL[i]) continue;
    float x0 = (k + 0.5 + 0.55 * (fract(hk * 41.7) - 0.5)) * sp;
    float r = FOREST_TREE_R[i] * (0.5 + 1.0 * fract(hk * 7.3));
    if (abs(x0 - sx) < sh + 1.6 * r + 0.3) continue;
    if (i == 0 && abs(x0 / z - gate) < 0.2) continue;
    if (i == 1 && abs(x0 / z - gate) < 0.09) continue;
    // Leaning a little and wandering slowly from straight, tapering, buttressed, its roots splaying.
    float ax = x0 + (fract(hk * 113.9) - 0.5) * 0.05 * hh + 0.1 * r * (sin(hh * 0.5 + hk * 30.0) - sin(hk * 30.0));
    float side = xw > ax ? 1.0 : -1.0;
    float hw = forestFlare(hh, r * (1.0 - 0.012 * hh), 0.85, 0.6) * (1.0 + 0.08 * sin(hh * 2.1 + side * 1.7 + hk * 20.0) * exp(-hh / 1.4))
             + r * 0.5 * exp(-hh / 0.22) * (0.5 + 0.5 * sin(side * 2.3 + hk * 40.0));
    float e = abs(xw - ax) - hw;
    if (e < best) {
      best = e;
      axis = ax;
      hwBest = hw;
      hc = hk;
    }
  }
  if (best > 2.0 * aa) return vec4(0.0);
  float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, best)) * smoothstep(-0.1, 0.02, height);
  if (cover <= 0.0) return vec4(0.0);
  float u = clamp((xw - axis) / hwBest, -1.0, 1.0);
  float kind = step(0.62, fract(hc * 17.9));
  vec3 col = forestBark(kind, u, hh, hwBest, hc * 10.0, aa, z, vec2(axis / z, q.y), 0.6 + 0.5 * fract(hc * 3.3));
  depth = z * (0.9 + 0.2 * fract(hc * 3.7));
  return vec4(col, cover);
}

// How far a named tree's axis has strayed (m) at height h: its lean, and a slow sinuous wander.
float forestBigAxis(float h, vec4 shape, float salt) {
  return shape.w * h + 0.1 * shape.x * (sin(h * 0.55 + salt) - sin(salt));
}

// One of the named trees, its axis at screen x axisS (at its foot), depth z; shape: (radius, flare,
// flare height, lean). It tapers a little, bulges unevenly side to side, flares into buttresses and
// splays its roots at the ground. Returns lit colour and coverage; height (m) and u (-1..1) out.
vec4 forestBigTree(vec2 q, float axisS, float z, vec4 shape, float kind, float salt, float moss, out float height, out float u) {
  u = 0.0;
  height = (q.y - (FOREST_HORIZON - FOREST_EYE / z)) * z;
  if (height < -0.1) return vec4(0.0);
  float hh = max(height, 0.0);
  float xw = (q.x - axisS) * z - forestBigAxis(hh, shape, salt);
  float side = xw > 0.0 ? 1.0 : -1.0;
  float hw = forestFlare(hh, shape.x * (1.0 - 0.01 * hh), shape.y, shape.z)
           * (1.0 + 0.08 * sin(hh * 1.8 + side * 1.3 + salt) * exp(-hh / 1.5) + 0.04 * (vnoise(vec2(hh * 1.6, side * 3.0 + salt)) - 0.5))
           + shape.x * 0.55 * exp(-hh / 0.25) * (0.55 + 0.45 * sin(side * 2.3 + salt));
  float aa = z / uRes.y;
  float e = abs(xw) - hw;
  if (e > 2.0 * aa) return vec4(0.0);
  float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, e)) * smoothstep(-0.1, 0.02, height);
  if (cover <= 0.0) return vec4(0.0);
  u = clamp(xw / hw, -1.0, 1.0);
  return vec4(forestBark(kind, u, hh, hw, salt, aa, z, q, moss), cover);
}

// The rope round the great cedar (a shimenawa: it is a sacred tree), thick twisted straw, and its four
// zigzag paper streamers (shide) swaying a little. hh, u: the point on the trunk. Returns colour and
// coverage over the bark.
vec4 forestRope(vec2 q, float hh, float u, float tm) {
  float z = FOREST_HERO_Z;
  float aa = z / uRes.y;
  float nz = sqrt(max(1.0 - u * u, 0.0));
  float hw = forestFlare(FOREST_ROPE_H, FOREST_HERO_SHAPE.x * (1.0 - 0.01 * FOREST_ROPE_H), FOREST_HERO_SHAPE.y, FOREST_HERO_SHAPE.z);
  float xw = (q.x - forestHeroX) * z - forestBigAxis(hh, FOREST_HERO_SHAPE, FOREST_HERO_SALT);
  float rise = (FOREST_ROPE_H - FOREST_EYE) * hw / z;
  // A ring above the eye: its near side shows a little higher than its edges.
  float dy = hh - (FOREST_ROPE_H + rise * nz);
  float face = forestKeySide.x < 0.0 ? -1.0 : 1.0;
  float lit = clamp(0.5 + 0.5 * (u * face * 0.9 + nz * 0.3), 0.0, 1.0);
  vec3 light = forestFill * (0.6 + 0.8 * lit) + forestTop * 0.4 + forestKey * smoothstep(0.4, 1.0, lit) * (0.45 + 1.2 * forestBeam) + forestShroomLight(q, z) * 0.4;
  vec4 o = vec4(0.0);
  float th = 0.085;
  if (abs(dy) < th + 2.0 * aa) {
    float cover = 1.0 - smoothstep(th - 0.7 * aa, th + 0.7 * aa, abs(dy));
    float twist = fract(asin(u) * hw * 4.5 + dy * 7.0);
    float strand = smoothstep(0.0, 0.3, twist) * (1.0 - smoothstep(0.6, 1.0, twist));
    float bulge = sqrt(max(1.0 - (dy / th) * (dy / th), 0.0));
    vec3 straw = wetten(FOREST_STRAW * (0.5 + 0.5 * strand), forestWet, 0.8);
    o = vec4(straw * light * (0.25 + 0.85 * nz) * (0.45 + 0.55 * bulge), cover);
  }
  for (int k = 0; k < 4; k++) {
    float a = (float(k) - 1.5) * 0.62;
    float sy = FOREST_ROPE_H + rise * cos(a) - th * 0.5 - hh;   // down from the streamer's top (m)
    if (sy < 0.0 || sy > 0.38) continue;
    float sway = (0.03 + 0.03 * abs(K_wind)) * sin(tm * (0.7 + 0.13 * float(k)) + float(k) * 1.9) * sy / 0.38;
    float seg = floor(sy / 0.095);
    float fold = mod(seg, 2.0);
    float edge = abs(xw - hw * sin(a) - (fold < 0.5 ? -0.02 : 0.02) - sway) - 0.035;
    float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, edge)) * (1.0 - smoothstep(0.35, 0.38, sy));
    // The paper takes the light as the bark does not: it shows pale even at night.
    if (cover > o.a) o = vec4(wetten(FOREST_PAPER, forestWet, 0.6) * (light * 1.1 + forestMist * 0.3) * (0.85 + 0.15 * fold), cover);
  }
  return o;
}

// The beech's branch reaching left at q (the beech's parallax): moss thick along its top, beards of
// lichen hanging from it and swaying slowly, and, while it is wet, drops gathering at the beards' tips
// (or the bare underside) and falling. Returns colour and coverage; drip out: the drops, 0/1.
vec4 forestBranch(vec2 q, float t, float tm, out float drip) {
  drip = 0.0;
  float z = FOREST_ELDER_Z;
  vec2 w = vec2(q.x * z, (q.y - FOREST_HORIZON) * z + FOREST_EYE);
  float along = forestElderX * z - FOREST_BRANCH_B.z * FOREST_ELDER_SHAPE.x - w.x;
  float s = along / FOREST_BRANCH_A.y;
  if (s < -0.1 || s > 1.1 || w.y < FOREST_BRANCH_A.x - 2.2 || w.y > FOREST_BRANCH_A.x + 1.1) return vec4(0.0);
  float aa = z / uRes.y;
  float sc = clamp(s, 0.0, 1.0);
  float yc = FOREST_BRANCH_A.x + FOREST_BRANCH_A.z * sc - FOREST_BRANCH_A.w * sc * sc;
  float slope = (FOREST_BRANCH_A.z - 2.0 * FOREST_BRANCH_A.w * sc) / FOREST_BRANCH_A.y;
  float r = mix(FOREST_BRANCH_B.x, FOREST_BRANCH_B.y, sc) * (1.0 + 0.6 * (1.0 - smoothstep(-0.1, 0.12, s)));
  float dy = (w.y - yc) / sqrt(1.0 + slope * slope);
  float e = abs(dy) - r;
  if (s > 1.0) e = length(vec2((s - 1.0) * FOREST_BRANCH_A.y, w.y - yc)) - r;
  float cover = 1.0 - smoothstep(-0.7 * aa, 0.7 * aa, e);
  vec3 col = vec3(0.0);
  if (cover > 0.0) {
    float v = clamp(dy / r, -1.0, 1.0);
    float nz = sqrt(max(1.0 - v * v, 0.0));
    float mn = vnoise(vec2(along * 3.0, v * 2.0 + 7.0));
    float mossy = smoothstep(-0.25, 0.15, v + 0.45 * (mn - 0.5));
    float cushion = vnoise(vec2(along * 14.0, v * 3.0));
    vec3 albedo = mix(FOREST_BEECH * (0.8 + 0.3 * mn), mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.35 + 0.65 * cushion), mossy);
    albedo = wetten(albedo, forestWet, mix(0.35, 0.9, mossy));
    float up = 0.5 + 0.5 * v;
    vec3 light = forestFill * (0.3 + 0.5 * up) * (0.7 + 0.3 * nz) + forestTop * 1.2 * max(v, 0.0) + forestKey * (0.25 + 1.2 * forestBeam) * up * 0.7 + forestShroomLight(q, z) * 0.5;
    col = albedo * light + FOREST_MOSS_LIT * (forestKey * (0.15 + forestBeam) + forestTop * 0.3) * mossy * up * 0.3;
    col += forestSheen * forestGloss * (1.0 - mossy) * 0.3 * forestBell((v - 0.5) / 0.3);
  }
  // Beards: one strand per lane of FOREST_BEARD, hung where rainDrips puts that lane's drip point,
  // so the drops fall from the tips.
  float lane = floor(along / FOREST_BEARD);
  float hl = hash12(vec2(lane, 3.7));
  float sx = (lane + 0.3 + 0.4 * hl) * FOREST_BEARD;
  float ss = sx / FOREST_BRANCH_A.y;
  if (ss > 0.04 && ss < 0.96) {
    float top = FOREST_BRANCH_A.x + FOREST_BRANCH_A.z * ss - FOREST_BRANCH_A.w * ss * ss - mix(FOREST_BRANCH_B.x, FOREST_BRANCH_B.y, ss) + 0.03;
    float hb = hash12(vec2(lane, 9.1));
    float len = hb < 0.72 ? 0.22 + 0.65 * fract(hb * 17.3) : 0.0;
    float below = top - w.y;
    float sway = (0.025 + 0.03 * abs(K_wind)) * sin(tm * (0.45 + 0.2 * hl) + lane * 1.7);
    if (len > 0.0 && below > 0.0 && below < len) {
      float k = below / len;
      float off = sway * k * k + 0.012 * sin(below * 23.0 + lane);
      float width = max(0.03 * pow(1.0 - k, 0.6) * (0.75 + 0.5 * vnoise(vec2(lane * 3.1, below * 9.0))), 0.6 * aa);
      float strand = 1.0 - smoothstep(width - 0.6 * aa, width + 0.6 * aa, abs(along - sx + off));
      if (strand > cover) {
        vec3 lichen = wetten(FOREST_USNEA * (0.8 + 0.3 * vnoise(vec2(lane, below * 5.0))), forestWet, 0.6);
        col = lichen * (forestFill * 0.95 + forestKey * (0.05 + 0.9 * forestBeam) * 0.6 + forestShroomLight(q, z) * 0.5);
        cover = strand;
      }
    }
    float amount = max(K_rain, 0.4 * forestWet);
    // The tip hangs at the lane's drip point shifted by the sway: shift the lane back onto it.
    if (amount > 0.0) drip = rainDrips(vec2(along + sway, top - len - w.y), t, amount, FOREST_BEARD);
  }
  return vec4(col, cover);
}

// A mossy boulder at depth z: centre c and radii rs (screen), hidden below cutY where the floor or
// the water in front of it covers it. Its lower flanks are lumpy, its top (where spirits stand) the
// plain dome. Moss carpets the top and spills down in cushions; the bare stone is grey with lichen,
// glossy when wet, and drops burst on it in the rain. Returns lit colour and coverage; up: normal y.
vec4 forestRock(vec2 q, vec2 c, vec2 rs, float z, float cutY, float salt, float mossAmt, float t, out float up) {
  up = 0.0;
  vec2 d = (q - c) / rs;
  if (abs(d.x) > 1.15 || abs(d.y) > 1.15 || q.y < cutY) return vec4(0.0);
  float low = 1.0 - smoothstep(0.1, 0.6, d.y);
  float lump = 0.08 * (vnoise(vec2(atan(d.y, d.x) * 1.7 + salt, salt * 3.1)) - 0.5) * low;
  float rr = length(d);
  float aa = 1.0 / (uRes.y * rs.y);
  float cover = 1.0 - smoothstep(-aa, aa, rr - 1.0 - lump);
  if (cover <= 0.0) return vec4(0.0);
  vec2 dn = d / max(rr, 1e-3) * min(rr, 1.0);
  vec3 n = vec3(dn, -sqrt(max(1.0 - dot(dn, dn), 0.0)));
  up = n.y;
  float detail = 1.0 - smoothstep(0.01, 0.04, z / uRes.y);
  vec3 stone = FOREST_ROCK * (0.72 + 0.4 * vnoise(d * 5.0 + salt));
  stone = mix(stone, FOREST_LICHEN * 0.9, smoothstep(0.7, 0.85, vnoise(d * 11.0 + salt * 2.0)) * 0.5 * detail);
  float mossy = smoothstep(0.0, 0.25, n.y * 0.9 + mossAmt - 0.62 + 0.35 * (vnoise(d * 3.5 + salt * 2.0) - 0.5));
  float cushion = mix(0.5, vnoise(d * vec2(14.0, 18.0) + salt), detail);
  vec3 albedo = mix(stone, mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.3 + 0.7 * cushion), mossy);
  albedo = wetten(albedo, forestWet, mix(0.12, 0.9, mossy));
  float key = max(dot(n, forestKeyDir), 0.0);
  vec3 light = forestFill * (0.3 + 0.4 * (0.5 + 0.5 * n.y)) * (0.75 + 0.25 * cushion * mossy) + forestTop * 1.2 * max(n.y, 0.0)
             + forestKey * key * (0.3 + 1.3 * forestBeam) + forestShroomLight(q, z) * (0.6 + 0.4 * n.y);
  vec3 col = albedo * light + FOREST_MOSS_LIT * (forestKey * (0.15 + forestBeam) * key + forestTop * 0.3 * max(n.y, 0.0)) * mossy * cushion * 0.3;
  col += forestSheen * wetGloss(forestWet, n.y) * (1.0 - mossy) * 0.5;
  if (forestRainHere > 0.0 && n.y > 0.4) {
    // Crowns ~5 cells across: the library's units scaled so one spans ~22 cells here.
    float splash = rainSplashes(vec2(q.x * z, (q.y - c.y) * z * 3.0) * (uRes.y / (22.0 * z)), t, forestRainHere);
    col = mix(col, forestDropLit, splash * (1.0 - mossy) * smoothstep(0.4, 0.8, n.y) * 0.8);
  }
  return vec4(col, cover);
}

// The great cedar's roots gripping the near boulder (centre c, radii rs, screen; depth z): one across
// its upper face from the trunk's foot (below the top, where the spirits stand), one lower across its
// face, one low on its left, each a tapering round root, moss on its upper side, glossy when wet.
// With the mark ('mark' 0..1 dissolves between them) the lower root is an M instead, hanging from the
// upper one by its two top corners, and pale fungus glows along it ('markGlow'). Returns lit colour
// and coverage; glow out: the M's light here (the accent).
vec4 forestRoots(vec2 q, vec2 c, vec2 rs, float z, float mark, float markGlow, out float glow) {
  glow = 0.0;
  vec2 d = (q - c) / rs;
  if (d.x < -1.7 || d.x > 1.25 || d.y < -1.0 || d.y > 1.35) return vec4(0.0);
  float aa = 1.0 / uRes.y;
  // The nearest root of each kind: x edge distance (screen), y radius, zw its axis point.
  vec4 always = vec4(1e9, 1.0, 0.0, 0.0);
  vec4 natural = vec4(1e9, 1.0, 0.0, 0.0);
  vec4 grown = vec4(1e9, 1.0, 0.0, 0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec4 n = forestNearest(q, c + FOREST_ROOT_A[i] * rs, c + FOREST_ROOT_A[i + 1] * rs);
    float r = (0.075 / z) * (1.0 - 0.35 * (fi + n.w) / 4.0);
    if (n.z - r < always.x) always = vec4(n.z - r, r, n.xy);
    n = forestNearest(q, c + FOREST_ROOT_C[i] * rs, c + FOREST_ROOT_C[i + 1] * rs);
    r = (0.05 / z) * (1.0 - 0.4 * (fi + n.w) / 4.0);
    if (n.z - r < always.x) always = vec4(n.z - r, r, n.xy);
    if (mark < 1.0) {
      n = forestNearest(q, c + FOREST_ROOT_B[i] * rs, c + FOREST_ROOT_B[i + 1] * rs);
      r = (0.058 / z) * (1.0 - 0.4 * (fi + n.w) / 4.0);
      if (n.z - r < natural.x) natural = vec4(n.z - r, r, n.xy);
    }
    if (mark > 0.0) {
      vec2 mc = c + vec2(0.0, FOREST_MARK.x * rs.y);
      float ms = FOREST_MARK.y * rs.y;
      n = forestNearest(q, mc + markVertex(i) * ms, mc + markVertex(i + 1) * ms);
      r = 0.03 / z;
      if (n.z - r < grown.x) grown = vec4(n.z - r, r, n.xy);
    }
  }
  float coverA = 1.0 - smoothstep(-0.7 * aa, 0.7 * aa, always.x);
  float coverB = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, natural.x)) * (1.0 - mark);
  float coverM = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, grown.x)) * mark;
  vec4 root = vec4(1e9, 1.0, 0.0, 0.0);
  float cover = 0.0;
  float isM = 0.0;
  if (forestHard(coverA) > 0.0 && always.x < root.x) {
    root = always;
    cover = 1.0;
  }
  if (forestHard(coverB) > 0.0 && natural.x < root.x) {
    root = natural;
    cover = 1.0;
  }
  if (forestHard(coverM) > 0.0 && grown.x < root.x) {
    root = grown;
    cover = 1.0;
    isM = 1.0;
  }
  if (cover <= 0.0) return vec4(0.0);
  float dist = root.x + root.y;
  float v = clamp(dist / root.y, 0.0, 1.0);
  vec2 n2 = dist > 1e-6 ? (q - root.zw) / dist : vec2(0.0, 1.0);
  vec3 n = vec3(n2 * v, -sqrt(max(1.0 - v * v, 0.0)));
  float detail = 1.0 - smoothstep(0.01, 0.04, z / uRes.y);
  float mossy = smoothstep(0.1, 0.5, n.y + 0.35 * (vnoise(q * 90.0) - 0.5)) * 0.9;
  vec3 bark = FOREST_CEDAR * 0.75 * (0.8 + 0.35 * mix(0.5, vnoise(q * vec2(160.0, 60.0)), detail));
  vec3 albedo = wetten(mix(bark, mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.4 + 0.5 * vnoise(q * 140.0)), mossy), forestWet, mix(0.45, 0.9, mossy));
  float key = max(dot(n, forestKeyDir), 0.0);
  vec3 light = forestFill * (0.3 + 0.4 * (0.5 + 0.5 * n.y)) + forestTop * 1.1 * max(n.y, 0.0) + forestKey * key * (0.3 + 1.3 * forestBeam) + forestShroomLight(q, z);
  vec3 col = albedo * light;
  col += forestSheen * wetGloss(forestWet, n.y) * (1.0 - mossy) * 0.5 * forestBell((v - 0.45) / 0.35);
  if (isM > 0.0) {
    glow = markGlow * (0.4 + 0.6 * smoothstep(-0.2, 0.6, n.y));
    col += FOREST_GLOW * glow * 0.75;
  }
  return vec4(col, cover);
}

// The fallen log, lying across the floor beyond the beech, its left end broken off and its top deep in
// moss. Returns lit colour and coverage; up: how far the point faces up (-1..1).
vec4 forestLog(vec2 q, out float up) {
  up = 0.0;
  float z = FOREST_LOG.z;
  float R = FOREST_LOG.w;
  vec2 w = vec2(q.x * z, (q.y - FOREST_HORIZON) * z + FOREST_EYE);
  if (w.x < FOREST_LOG.x - 0.4 || w.x > FOREST_LOG.y + 0.2 || abs(w.y - R) > 1.3 * R) return vec4(0.0);
  float aa = z / uRes.y;
  float v = (w.y - R) / R;
  float endL = FOREST_LOG.x + 0.14 * (vnoise(vec2(v * 3.0, 4.0)) - 0.5) + 0.08 * abs(v);
  float cover = (1.0 - smoothstep(1.0 - aa / R, 1.0 + aa / R, abs(v)))
              * smoothstep(endL - aa, endL + aa, w.x) * (1.0 - smoothstep(FOREST_LOG.y - aa, FOREST_LOG.y + aa, w.x));
  if (cover <= 0.0) return vec4(0.0);
  float vc = clamp(v, -1.0, 1.0);
  float nz = sqrt(max(1.0 - vc * vc, 0.0));
  up = vc;
  float fromEnd = w.x - endL;
  float mn = vnoise(vec2(w.x * 2.5, vc * 2.0 + 3.0));
  float mossy = smoothstep(-0.15, 0.3, vc + 0.4 * (mn - 0.5)) * smoothstep(0.05, 0.3, fromEnd);
  float cushion = vnoise(vec2(w.x * 14.0, vc * 4.0 + 1.0));
  vec3 bark = vec3(0.24, 0.19, 0.15) * (0.75 + 0.4 * vnoise(vec2(w.x * 6.0, vc * 8.0)));
  vec3 heart = vec3(0.56, 0.36, 0.2) * (0.8 + 0.3 * vnoise(vec2(vc * 10.0, 1.0)));
  vec3 albedo = mix(bark, heart, 1.0 - smoothstep(0.0, 0.05, fromEnd));
  albedo = mix(albedo, mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.3 + 0.7 * cushion), mossy);
  albedo = wetten(albedo, forestWet, mix(0.6, 0.9, mossy));
  float lit = 0.5 + 0.5 * vc;
  vec3 light = forestFill * (0.3 + 0.45 * lit) * (0.7 + 0.3 * nz) + forestTop * 1.2 * max(vc, 0.0) + forestKey * (0.25 + 1.2 * forestBeam) * lit * 0.6 + forestShroomLight(q, z) * (0.5 + 0.5 * lit);
  vec3 col = albedo * light + FOREST_MOSS_LIT * (forestKey * (0.15 + forestBeam) + forestTop * 0.3) * mossy * cushion * lit * 0.3;
  col += forestSheen * wetGloss(forestWet, vc) * (1.0 - mossy) * 0.35;
  return vec4(col, cover);
}

// A screen point q (at the torii's parallax) in the torii's own frame: x across from its centre, y up
// from its feet (m), undoing its lean about the right foot.
vec2 forestToriiFrame(vec2 q) {
  vec2 w = vec2(q.x * FOREST_TORII_Z - forestToriiX, (q.y - FOREST_HORIZON) * FOREST_TORII_Z + FOREST_EYE);
  vec2 pivot = vec2(FOREST_TORII_SPAN, 0.0);
  return pivot + rotate(w - pivot, -FOREST_TORII_LEAN);
}

// The bottom of the top beam (kasagi) at x, sweeping up toward its ends (as forestKasagiTop in sim.ts).
float forestKasagiBottom(float x) {
  float k = abs(x) / (FOREST_TORII_SPAN + FOREST_TORII_OVER);
  return FOREST_TORII_H + 0.12 * k * k * k * k;
}

// The torii in its own frame P (m): two round pillars, the tie beam and its strut, the beam under the
// top, and the top beam with its black cap sweeping up at the ends; faded vermilion lacquer flaking to
// grey wood; moss cushions on every top and a mound swallowing the sunken left foot. aa: a cell in
// metres. Returns lit colour and coverage.
vec4 forestTorii(vec2 P, float aa) {
  float S = FOREST_TORII_SPAN;
  float ext = S + FOREST_TORII_OVER;
  float H = FOREST_TORII_H;
  if (abs(P.x) > ext + 0.3 || P.y < -0.5 || P.y > H + FOREST_TORII_BEAM + 0.45) return vec4(0.0);
  float k = abs(P.x) / ext;
  float k4 = k * k * k * k;
  float bottom = H + 0.12 * k4;
  float top = bottom + FOREST_TORII_BEAM + 0.06 * k4;
  float px = abs(P.x) - S;
  float pr = mix(0.15, 0.12, clamp(P.y / H, 0.0, 1.0));
  float pillar = max(abs(px) - pr, max(-0.5 - P.y, P.y - H));
  float nuki = max(abs(P.x) - S - 0.32, abs(P.y - 2.35) - 0.1);
  float strut = max(abs(P.x) - 0.08, abs(P.y - 2.66) - 0.21);
  float shimaki = max(abs(P.x) - S - 0.5, abs(P.y - (H - 0.1)) - 0.1);
  float kasagi = max(abs(P.x) - ext - 0.06 * clamp((P.y - bottom) / FOREST_TORII_BEAM, 0.0, 1.0), max(bottom - P.y, P.y - top));
  float wood = min(min(pillar, nuki), min(min(strut, shimaki), kasagi));
  float mn = vnoise(vec2(P.x * 4.0, 3.0));
  float onTop = max(abs(P.x) - ext + 0.08, max(top - 0.03 - P.y, P.y - top - 0.075 * (0.4 + 0.8 * mn) * (1.0 - k4)));
  float onNuki = max(abs(P.x) - S - 0.24, max(2.42 - P.y, P.y - 2.45 - 0.05 * mn));
  vec2 mL = (P - vec2(-S, -0.1)) / vec2(0.8, 0.62);
  vec2 mR = (P - vec2(S, -0.1)) / vec2(0.46, 0.3);
  float mound = min((length(mL) - 1.0 - 0.15 * (vnoise(P * 3.0 + 1.7) - 0.5)) * 0.55, (length(mR) - 1.0) * 0.3);
  float moss = min(min(onTop, onNuki), mound);
  float cover = 1.0 - smoothstep(-0.7 * aa, 0.7 * aa, min(wood, moss));
  if (cover <= 0.0) return vec4(0.0);
  vec3 col;
  if (moss < 0.0 || moss < wood) {
    float cushion = vnoise(P * vec2(16.0, 20.0));
    vec3 m = wetten(mix(FOREST_MOSS_DEEP, FOREST_MOSS, 0.3 + 0.7 * cushion), forestWet, 0.9);
    col = m * (forestFill * (0.6 + 0.3 * cushion) + forestTop * 1.1 + forestKey * (0.25 + 1.1 * forestBeam) * 0.6) + FOREST_MOSS_LIT * (forestKey * forestBeam + forestTop * 0.3) * cushion * 0.25;
  } else {
    float flake = smoothstep(0.6, 0.72, vnoise(P * vec2(6.0, 2.5) + 2.0));
    vec3 albedo = mix(FOREST_VERMILION * (0.78 + 0.3 * vnoise(P * vec2(2.0, 9.0))), vec3(0.36, 0.33, 0.29), flake);
    albedo = mix(albedo, vec3(0.06, 0.055, 0.05), step(bottom + 0.45 * FOREST_TORII_BEAM, P.y) * step(kasagi, 0.0));
    albedo = wetten(albedo, forestWet, 0.35);
    float bulge = pillar <= min(min(nuki, strut), min(shimaki, kasagi)) ? sqrt(max(1.0 - (px / pr) * (px / pr), 0.0)) : 0.8;
    float under = kasagi <= 0.0 ? smoothstep(bottom, bottom + 0.1, P.y) : 1.0;
    col = albedo * (forestFill * (0.7 + 0.8 * bulge) * (0.6 + 0.4 * under) + forestTop * 0.3 + forestKey * (0.25 + 1.1 * forestBeam) * 0.5);
    col += forestSheen * forestGloss * 0.3 * bulge;
  }
  return vec4(col, cover);
}

// A cluster of mushrooms at site i, q at the host's parallax: four short pale stems leaning out from
// the moss under broad, slightly flattened domed caps, pale by day; at dusk their caps and gills glow
// green. Returns colour and coverage; glow out: their light here (the accent).
vec4 forestShrooms(vec2 q, int i, out float glow) {
  glow = 0.0;
  vec4 site = forestShroom[i];
  float z = site.z;
  vec2 l = (q - site.xy) * z;
  if (abs(l.x) > 0.22 || l.y < -0.03 || l.y > 0.2) return vec4(0.0);
  float aa = z / uRes.y;
  float best = 1e9;
  float isCap = 0.0;
  float under = 0.0;
  float tone = 0.0;
  for (int j = 0; j < 4; j++) {
    float hj = hash12(vec2(float(i) * 7.3 + 1.0, float(j) * 3.1 + 2.0));
    float x0 = (float(j) - 1.5) * 0.05 + (hj - 0.5) * 0.03;
    float h = 0.03 + 0.045 * fract(hj * 13.7);
    float lean = (fract(hj * 5.9) - 0.5) * 0.25 + x0 * 2.0;
    float rc = 0.03 + 0.025 * fract(hj * 29.3);
    vec2 top = vec2(x0 + lean * h, h);
    float stem = segmentDistance(l, vec2(x0, -0.02), top) - max(0.009, 0.6 * aa);
    float cap = max((length((l - top) / vec2(rc, rc * 0.7)) - 1.0) * rc * 0.7, top.y - 0.12 * rc - l.y);
    float dj = min(stem, cap);
    if (dj < best) {
      best = dj;
      isCap = cap < stem ? 1.0 : 0.0;
      under = 1.0 - smoothstep(0.0, 0.45 * rc, l.y - top.y + 0.12 * rc);
      tone = hj;
    }
  }
  float cover = 1.0 - smoothstep(-0.7 * aa, 0.7 * aa, best);
  if (cover <= 0.0) return vec4(0.0);
  float emit = forestShroomGlow * site.w * (0.75 + 0.25 * fract(tone * 41.0)) * mix(0.45, 1.0, isCap) * (1.0 + 0.6 * under * isCap);
  vec3 albedo = wetten(mix(vec3(0.86, 0.85, 0.78), FOREST_CAP, isCap), forestWet, 0.5);
  vec3 col = albedo * (forestFill + forestTop * 0.7 * (1.0 - under) + forestKey * forestBeam * 0.5) + FOREST_SHROOM_GLOW * emit * 1.3;
  col += forestSheen * forestGloss * 0.3 * isCap;
  glow = clamp(emit, 0.0, 1.0);
  return vec4(col, cover);
}

// A fern growing from a crown just below the frame (crown, screen), 'scale' screen heights per frond
// unit: seven fronds springing up and out and arching over under their own weight, each a bare stalk
// becoming a spine with leaflets along both sides, longest a third of the way out and shrinking to the
// tip, swept toward it and rounded at their ends; they sway slowly, one after another. Lit from the
// canopy above and glowing green where the light comes through them, darker down in the crown.
// Returns lit colour and coverage.
vec4 forestFern(vec2 q, vec2 crown, float scale, float salt, float tm) {
  vec2 v = (q - crown) / scale;
  if (v.y < -0.05 || v.y > 1.2 || abs(v.x) > 1.6) return vec4(0.0);
  float aa = 1.0 / (uRes.y * scale);
  float cover = 0.0;
  float tone = 0.0;
  float along = 0.0;
  float across = 0.0;
  for (int f = 0; f < 7; f++) {
    float hf = hash12(vec2(float(f) + salt * 7.0, 4.7));
    float ang = (float(f) - 3.0) * 0.32 + (hf - 0.5) * 0.16 + 0.03 * sin(tm * 0.5 + float(f) * 1.9 + salt) + 0.05 * K_wind;
    float len = 0.75 + 0.3 * fract(hf * 7.1);
    vec2 dir = vec2(sin(ang), cos(ang));
    // The spine arches over toward its own side (the upright ones gently, the outer ones hard):
    // P(t) = t dir + bend t^2 g for t = 0..len. Three Newton steps from a guess along the chord find
    // the point of it nearest v.
    float arch = ang + (hf - 0.5) * 0.3;
    vec2 g = normalize(vec2((arch < 0.0 ? -0.35 : 0.35) + ang * 1.4, -1.0));
    float bend = (0.3 + 0.45 * abs(dir.x)) * (0.85 + 0.3 * fract(hf * 3.7));
    vec2 chord = len * dir + bend * len * len * g;
    float t = clamp(dot(v, chord) / dot(chord, chord), 0.0, 1.0) * len;
    for (int n = 0; n < 3; n++) {
      vec2 off = t * dir + bend * t * t * g - v;
      vec2 d1 = dir + 2.0 * bend * t * g;
      t = clamp(t - dot(off, d1) / max(dot(d1, d1) + dot(off, 2.0 * bend * g), 0.2), 0.0, len);
    }
    vec2 rel = v - (t * dir + bend * t * t * g);
    float dist = length(rel);
    if (dist > 0.3) continue;
    vec2 tangent = normalize(dir + 2.0 * bend * t * g);
    float b = abs(dot(rel, vec2(-tangent.y, tangent.x)));
    float s = t / len;
    float pl = 0.21 * len * smoothstep(0.1, 0.28, s) * pow(1.0 - s, 0.6);
    float pitch = 0.058;
    float lobe = abs(fract((t - b * 0.5) / pitch + hf * 5.0) - 0.5);
    float r = b / max(pl, 1e-3);
    float width = 0.42 * sqrt(max(1.0 - r * r, 0.0));
    float leaflet = (1.0 - smoothstep(pl - aa, pl + aa, b)) * (1.0 - smoothstep(width - aa / pitch, width + aa / pitch, lobe));
    float stalk = 0.007 + 0.006 * (1.0 - s);
    float rachis = 1.0 - smoothstep(stalk - aa, stalk + aa, dist);
    float cv = max(leaflet, rachis);
    if (cv > cover) {
      cover = cv;
      tone = hf;
      along = s;
      across = min(r, 1.0);
    }
  }
  if (cover <= 0.0) return vec4(0.0);
  vec3 albedo = wetten(FOREST_FERN * (0.75 + 0.35 * across + 0.2 * along + 0.15 * (fract(tone * 7.0) - 0.5)), forestWet, 0.4);
  float behind = 0.4 + 0.6 * clamp(forestKeySide.y * 1.5, 0.0, 1.0);
  vec3 col = albedo * (forestFill * 0.7 + forestTop * 0.9 + forestShroomLight(q, 2.3) * 0.5)
           + FOREST_FERN_LIT * (forestKey * (0.15 + forestBeam) * behind + dot(forestSheen, LUMA) * 0.25) * (0.4 + 0.6 * across) * 0.6;
  col *= 0.6 + 0.4 * smoothstep(0.0, 0.4, along);
  col += forestSheen * forestGloss * 0.15;
  return vec4(col, cover);
}

// A forest spirit (a kodama) at l, in its own units (its height 1, x across, y up from its feet): a
// small soft pillar of a body on two stubby legs, arms hanging, and the big round head, a little wider
// at the crown, lumpy in its own way (variant), tilted about its neck by 'tilt' (+: its top to the
// left) with its three dark holes, two eyes and a mouth, shifted by 'yaw' (-1..1, +: looking right).
// cells: its height in cells (the face goes once it is too small to hold). Returns x: coverage, y:
// face hole 0/1, z: shading 0..1, w: rim 0..1.
vec4 forestSpiritShape(vec2 l, float tilt, float yaw, float variant, float cells) {
  float aa = 0.8 / cells;
  float d = forestCapsule(l, vec2(0.0, 0.2), vec2(0.0, 0.42), 0.12);
  d = min(d, forestCapsule(l, vec2(-0.065, 0.0), vec2(-0.06, 0.18), 0.05));
  d = min(d, forestCapsule(l, vec2(0.065, 0.0), vec2(0.06, 0.18), 0.05));
  float arm = 0.06 * sin(variant * 31.0);
  d = min(d, forestCapsule(l, vec2(-0.1, 0.4), vec2(-0.19, 0.28 + arm), 0.04));
  d = min(d, forestCapsule(l, vec2(0.1, 0.4), vec2(0.19, 0.28 - arm), 0.04));
  vec2 hl = rotate(l - vec2(0.0, 0.5), -tilt) - vec2(0.0, 0.2);
  vec2 hr = vec2(0.25 + 0.04 * variant, 0.19 + 0.03 * fract(variant * 7.0));
  hr.x *= 1.0 + 0.08 * clamp(hl.y / hr.y, -1.0, 1.0);
  float dh = (length(hl / hr) - 1.0) * min(hr.x, hr.y) + 0.01 * sin(atan(hl.y, hl.x) * 3.0 + variant * 9.0);
  d = min(d, dh);
  float cover = 1.0 - smoothstep(-aa, aa, d);
  float hole = 0.0;
  if (cells > 14.0 && dh < 0.0) {
    float sh = yaw * 0.085;
    float er = max(0.05, 1.1 / cells);
    vec2 eye = vec2(er * 0.9, er * 1.15);
    // The eye on the side it turns toward foreshortens.
    float eL = length((hl - vec2(-0.09 + sh, 0.03)) / (eye * vec2(1.0 - 0.35 * max(-yaw, 0.0), 1.0)));
    float eR = length((hl - vec2(0.09 + sh, 0.03)) / (eye * vec2(1.0 - 0.35 * max(yaw, 0.0), 1.0)));
    vec2 mouth = vec2(max(0.04, 1.0 / cells) * (0.8 + 0.4 * variant), max(0.034, 1.0 / cells));
    float m = length((hl - vec2(0.01 + sh * 1.1, -0.085)) / mouth);
    hole = step(min(min(eL, eR), m), 1.0);
  }
  float shade = 0.72 + 0.28 * smoothstep(-0.25, 0.25, l.y > 0.5 ? hl.y / hr.y : (l.y - 0.45) * 2.0);
  float rim = 1.0 - smoothstep(0.0, 4.0 * aa, -d);
  return vec4(cover, hole, shade, rim);
}

// Where a hoof is (m, from below the body's centre) at phase phi of its stride: planted and sliding
// back under the body for 65% of the cycle, as fast as the stag walks (sim.ts STAG_CYCLE = 1.4 m:
// 2 x 0.455 / 0.65), so it stays put on the ground; then lifted and swung forward.
vec2 forestHoof(float phi, float hipX) {
  float duty = 0.65;
  float reach = 0.455;
  if (phi < duty) return vec2(hipX + reach - 2.0 * reach * phi / duty, 0.0);
  float s = (phi - duty) / (1.0 - duty);
  return vec2(hipX - reach + 2.0 * reach * s * s * (3.0 - 2.0 * s), 0.14 * sin(3.14159 * s));
}

// The joint of a leg of two 0.5 m bones from hip to hoof, bent forward (bend 1) or back (-1).
vec2 forestKnee(vec2 hip, vec2 hoof, float bend) {
  vec2 d = hoof - hip;
  float len = max(length(d), 1e-3);
  float h = sqrt(max(0.25 - 0.25 * len * len, 0.0));
  return hip + 0.5 * d + vec2(-d.y, d.x) / len * h * bend;
}

// A point of the far antler (m = 1) or the near one (m = 0), offset o from the antlers' base: in
// profile the far one shows a little forward; facing you (look 1) the two spread as mirror images.
vec2 forestAntler(vec2 o, float m, float look) {
  return vec2(mix(o.x, mix(o.x + 0.07, -o.x, look), m), o.y + 0.02 * m * (1.0 - look));
}

// The stag's silhouette, signed distance (m, negative inside) at l (m: x along its heading from below
// the body's centre, y up from the ground): barrel, chest and haunch, neck and head (turned to you by
// 'look', raised by 'headUp'), ears, tail, the four legs walking at gait phase 'gait' (lateral
// sequence: left hind, left fore, right hind, right fore) or standing ('stand' 1), and the great
// branching antlers. r0: the thinnest anything may be (two cells).
float forestStagDist(vec2 l, float gait, float look, float headUp, float stand, float r0) {
  float d = (length((l - vec2(0.0, 1.02)) / vec2(0.62, 0.26)) - 1.0) * 0.26;
  d = min(d, length(l - vec2(0.4, 1.06)) - 0.25);
  d = min(d, length(l - vec2(-0.46, 1.06)) - 0.24);
  vec2 nt = mix(vec2(0.74, 1.52), vec2(0.64, 1.78), headUp);
  d = min(d, forestCapsule(l, vec2(0.42, 1.14), nt, 0.1));
  d = min(d, forestCapsule(l, nt, nt + vec2(0.3 * (1.0 - 0.8 * look), -0.13 - 0.05 * look), 0.075));
  d = min(d, forestCapsule(l, nt + vec2(0.0, 0.04), nt + vec2(-0.14 - 0.03 * look, 0.12), max(0.03, r0)));
  d = min(d, forestCapsule(l, nt + vec2(0.0, 0.04), nt + vec2(mix(-0.14, 0.17, look), 0.12), max(0.03, r0)));
  d = min(d, forestCapsule(l, vec2(-0.66, 1.14), vec2(-0.74, 1.02), max(0.045, r0)));
  vec2 base = nt + vec2(-0.02, 0.07);
  for (int a = 0; a < 2; a++) {
    float m = float(a);
    vec2 a1 = base + forestAntler(vec2(-0.10, 0.32), m, look);
    vec2 a2 = base + forestAntler(vec2(-0.26, 0.60), m, look);
    vec2 a3 = base + forestAntler(vec2(-0.30, 0.88), m, look);
    float rb = max(0.035, r0);
    float rt = max(0.026, r0);
    d = min(d, forestCapsule(l, base, a1, rb));
    d = min(d, forestCapsule(l, a1, a2, rb));
    d = min(d, forestCapsule(l, a2, a3, rt));
    d = min(d, forestCapsule(l, base + forestAntler(vec2(-0.05, 0.16), m, look), base + forestAntler(vec2(0.14, 0.30), m, look), rt));
    d = min(d, forestCapsule(l, a1, base + forestAntler(vec2(0.10, 0.55), m, look), rt));
    d = min(d, forestCapsule(l, a2, base + forestAntler(vec2(0.02, 0.86), m, look), rt));
    d = min(d, forestCapsule(l, a2, base + forestAntler(vec2(-0.48, 0.74), m, look), rt));
    d = min(d, forestCapsule(l, a3, base + forestAntler(vec2(-0.16, 1.06), m, look), rt));
  }
  for (int g = 0; g < 4; g++) {
    float front = mod(float(g), 2.0);
    float hipX = front > 0.5 ? 0.38 : -0.44;
    vec2 hip = vec2(hipX, 0.98);
    vec2 hoof = mix(forestHoof(fract(gait + 0.25 * float(g)), hipX), vec2(hipX + (front > 0.5 ? 0.03 : -0.03), 0.0), stand);
    vec2 knee = forestKnee(hip, hoof, front > 0.5 ? 1.0 : -1.0);
    d = min(d, forestCapsule(l, hip, knee, 0.07));
    d = min(d, forestCapsule(l, knee, hoof + vec2(0.0, 0.02), max(0.04, r0)));
  }
  return d;
}

// The spores and motes (sim.ts): discs a cell or two across (bigger near), binned on the sim's grid
// (two slots per bin; the four bins round this point hold every mote that can reach it), each hidden
// behind whatever stands nearer (hitZ) and shrinking away as it fades. At night they glow pale green;
// by day they are dust, seen only where a shaft lights them. Returns the colour and how much of it
// shows (0 where none).
vec4 forestMotes(vec2 p, float hitZ) {
  if (uSimOn.y < 0.5) return vec4(0.0);
  ivec2 size = textureSize(uSim1, 0);
  int cols = size.x / 2;
  vec2 pm = forestScale(p, 6.0);
  vec2 g = vec2((pm.x + 0.5 * forestAspect) * FOREST_MOTE_ROWS, pm.y * FOREST_MOTE_ROWS);
  ivec2 b0 = ivec2(floor(g - 0.5));
  float cellsPerBin = uRes.y / FOREST_MOTE_ROWS;
  float best = 0.0;
  float bestZ = 1.0;
  for (int k = 0; k < 8; k++) {
    int bin = k / 2;
    ivec2 bi = b0 + ivec2(bin % 2, bin / 2);
    if (bi.x < 0 || bi.y < 0 || bi.x >= cols || bi.y >= size.y) continue;
    vec4 m = texelFetch(uSim1, ivec2(bi.x * 2 + k % 2, bi.y), 0);
    if (m.w <= 0.0 || m.z >= hitZ) continue;
    float rc = mix(2.6, 1.15, smoothstep(2.0, 14.0, m.z));
    float dc = length(g - (vec2(bi) + m.xy)) * cellsPerBin;
    float cov = (1.0 - smoothstep(rc - 0.7, rc + 0.7, dc)) * min(m.w * 1.3, 1.0);
    if (cov > best) {
      best = cov;
      bestZ = m.z;
    }
  }
  // At night the spores show round the mushrooms that breathe them out (and in the shafts), shrinking
  // away as they drift off; by day only the dust lit in the shafts shows.
  float nearShroom = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 site = forestShroom[i];
    vec2 v = forestAt(p, site.z) - site.xy - vec2(0.0, 0.05);
    nearShroom = max(nearShroom, exp(-dot(v, v) / 0.025));
  }
  float show = clamp(1.5 * forestBeam * step(0.001, K_shafts) + forestNight * (0.1 + 0.9 * nearShroom), 0.0, 1.0);
  if (forestHard(best * show) <= 0.0) return vec4(0.0);
  vec3 spore = FOREST_GLOW * 0.75 * forestNight;
  vec3 dust = forestRayLight * forestBeam * 1.1 + forestFill * 0.3;
  vec3 col = mix(forestMist, spore + dust, mix(forestTransmit(bestZ, 1.5), 1.0, 0.5 * forestNight));
  return vec4(col, 0.85);
}

// The canopy overhead: a ragged ceiling of dark cedar foliage, swaying a little, thinning into gaps
// toward the top of the frame and open where the shafts come through.
vec4 forestCanopy(vec2 p, float tm) {
  vec2 q = p + forestPar / 20.0;
  q.x += 0.006 * (0.4 + abs(K_wind)) * sin(tm * 0.3 + q.x * 2.0) * smoothstep(0.75, 1.0, q.y);
  float edge = 0.84 + 0.08 * vnoise(vec2(q.x * 2.1 + K_forestSeed * 0.37, 0.5));
  float n = 0.6 * vnoise(q * vec2(6.0, 9.0)) + 0.4 * vnoise(q * vec2(17.0, 21.0) + 3.1);
  float dens = smoothstep(edge - 0.08, edge + 0.1, q.y + 0.2 * (n - 0.5));
  float gap = smoothstep(0.62, 0.8, n) * smoothstep(0.9, 1.02, q.y);
  float open = 0.0;
  if (K_shafts > 0.0) {
    for (int r = 0; r < 3; r++) open = max(open, forestBell((p.x - forestRaySrc[r]) / 0.06));
  }
  dens *= 1.0 - 0.9 * open * smoothstep(0.82, 0.97, p.y);
  float behind = 0.3 + 0.7 * clamp(forestKeySide.y * 1.5, 0.0, 1.0);
  vec3 col = FOREST_NEEDLE * (0.7 + 0.5 * n) * forestFill + FOREST_MOSS_LIT * forestKey * forestBeam * behind * 0.15;
  return vec4(col, clamp(dens * (1.0 - gap), 0.0, 1.0));
}

// The stream's water at floor point w (m: x across, depth): flowing toward you, its surface tilted by
// long slow ripples; near, the pebbled bed shows through; farther it mirrors the mist above and, in
// front of the torii, the torii upside down; long streaks of light along the current, foam round the
// stepping stones, rings in the rain. bed: the pebbled bed's colour here.
vec3 forestWater(vec2 q, vec2 w, float zg, float t, float tm, float keep, vec3 bed) {
  float flow = 0.12 + 0.38 * K_stream;
  vec2 fw = vec2(w.x * 2.6, (w.y + tm * flow) * 0.75);
  vec2 tilt = (vec2(vnoise(fw), vnoise(fw * vec2(1.9, 1.6) + 4.0)) - 0.5) * 0.5 * keep;
  float ring = 0.0;
  if (forestRainHere > 0.0) {
    // Rings only where the water is not so foreshortened that they would sparkle.
    float ringKeep = 1.0 - smoothstep(0.03, 0.08, zg * zg / (FOREST_EYE * uRes.y) * 2.4);
    vec3 rr = rainRipples(w * 2.4, t, forestRainHere);
    tilt += rr.xy * ringKeep;
    ring = rr.z * ringKeep;
  }
  // A ribbon of light: the water mirrors the bright mist and the sky high above far more than the
  // floor round it gives back; the bed shows through only close by.
  float fres = mix(0.6, 0.95, smoothstep(3.0, 14.0, zg));
  vec3 refl = mix(forestMistColor(vec2(q.x + tilt.x * 0.02, min(2.0 * FOREST_HORIZON - q.y + tilt.y * 0.03, 0.98))), forestSheen, 0.45) * 1.15;
  float zt = FOREST_TORII_Z - forestCamD;
  if (zg < zt) {
    // The reflected ray reaches this height at the torii's depth (from the camera).
    float h = FOREST_EYE * (zt / zg - 1.0);
    vec2 qr = vec2((q.x + tilt.x * 0.02) * (zt / FOREST_TORII_Z), FOREST_HORIZON + (h - FOREST_EYE) / FOREST_TORII_Z);
    vec4 tr = forestTorii(forestToriiFrame(qr), FOREST_TORII_Z / uRes.y);
    refl = mix(refl, mix(forestMist, tr.rgb, forestTransmit(FOREST_TORII_Z, 2.0)), tr.a * 0.85);
  }
  vec3 col = mix(mix(FOREST_WATER * (forestFill + 0.02), bed, 0.6), refl, fres);
  float streak = smoothstep(0.66, 0.84, vnoise(vec2(w.x * 7.0, (w.y + tm * flow) * 0.5) + 2.0)) * keep;
  col += forestSheen * streak * (0.06 + 0.12 * K_stream);
  col += forestRayLight * forestBeam * 0.2;
  // Foam where the current parts round the stepping stones, trailing downstream (toward you).
  float foam = 0.0;
  for (int k = 0; k < ${FOREST_STONES.length}; k++) {
    vec4 st = FOREST_STONE[k];
    vec2 v = w - vec2(forestStreamX(st.x) + st.y, st.x);
    float ringD = length(v / vec2(st.z, st.z * 1.3)) - 1.12;
    foam = max(foam, exp(-ringD * ringD / 0.02));
    if (v.y < 0.0) {
      float wake = abs(v.x) - st.z * 0.8 + v.y * 0.35;
      foam = max(foam, exp(-wake * wake / 0.004) * exp(v.y / 0.9) * (0.6 + 0.4 * vnoise(vec2(v.x * 8.0, (w.y + tm * flow) * 2.0))));
    }
  }
  col = mix(col, forestSheen * 0.9 + forestKey * forestBeam * 0.3, foam * (0.25 + 0.5 * K_stream) * keep);
  col += forestSheen * ring * 0.5;
  return col;
}

// The floor at screen point p (below the horizon): moss and cedar litter with roots snaking through,
// detail giving way to its mean once finer than a few cells; gold in a shaft, green round the
// mushrooms; the stream (or, with it off, its dry stony bed) winding through with a wet mossy lip;
// pools gathering in the rain, mirroring the mist. zg out: its depth.
vec3 forestGround(vec2 p, float t, float tm, out float zg) {
  float zc = FOREST_EYE / max(FOREST_HORIZON - p.y, 1e-3);
  vec2 q = p + forestPar / zc;
  zc = FOREST_EYE / max(FOREST_HORIZON - q.y, 1e-3);
  // The floor point in the world: its distance from the camera is zc, its depth zg (the same at rest).
  vec2 w = vec2(q.x * zc, zc + forestCamD);
  zg = w.y;
  float foot = zc * zc / (FOREST_EYE * uRes.y);
  float keep = 1.0 - smoothstep(0.03, 0.18, foot);
  float s = (w.x - forestStreamX(zg)) / forestStreamHalf(zg);
  float n1 = vnoise(w * vec2(1.1, 1.6) + K_forestSeed);
  float n2 = vnoise(w * vec2(3.4, 5.2) + 7.0);
  float mossy = smoothstep(0.32, 0.62, n1 + 0.25 * (1.0 - smoothstep(1.0, 2.2, abs(s))));
  float calm = keep * (1.0 - 0.7 * forestCamMove);
  vec3 albedo = mix(FOREST_LITTER, FOREST_MOSS * 0.85, mossy) * (0.78 + 0.44 * mix(0.5, n2, calm));
  float rl = abs(vnoise(w * vec2(0.7, 1.1) + 3.3) - 0.5);
  float root = (1.0 - smoothstep(0.018, 0.034, rl)) * calm * smoothstep(0.35, 0.6, vnoise(w * 0.35 + 9.0));
  albedo = mix(albedo, FOREST_CEDAR * 0.55, root * 0.7);
  albedo = wetten(albedo, forestWet, 0.85);
  // Where the resting camera would see this floor point, for the mushrooms' light (none behind it).
  vec2 qs = q;
  if (forestCamD != 0.0) qs = zg > 0.2 ? vec2(w.x / zg, FOREST_HORIZON - FOREST_EYE / zg) : vec2(1e3);
  vec3 light = forestFill * 0.45 + forestTop * 0.9 + forestKey * (0.1 + 1.4 * forestBeam) * 0.8 + forestShroomLight(qs, zg) * 1.3;
  vec3 col = albedo * light;
  if (forestWet > 0.35 && abs(s) > 1.25) {
    // Pools a metre or two across, only where the floor is not too foreshortened to hold them.
    float pool = rainPuddles(w * 1.8, forestWet) * (1.0 - smoothstep(0.05, 0.22, foot));
    if (pool > 0.0) {
      vec3 refl = forestMistColor(vec2(q.x, 2.0 * FOREST_HORIZON - q.y)) * 0.85 + forestKey * forestBeam * 0.2;
      col = mix(col, refl, pool * clamp(0.55 + 0.35 * wetGloss(forestWet, 1.0), 0.0, 0.9));
    }
  }
  if (abs(s) < 1.25) {
    vec2 bp = w * 2.2;
    vec2 id = floor(bp);
    float hb = hash12(id + 3.1);
    vec2 cen = (vec2(hash12(id + 7.7), hb) - 0.5) * 0.25;
    float pebble = (1.0 - smoothstep(0.25, 0.42, length(fract(bp) - 0.5 - cen))) * keep;
    vec3 bedLight = forestFill * 1.1 + forestTop * 0.5 + forestKey * forestBeam * 0.6;
    vec3 bed = mix(FOREST_LITTER * 0.6, FOREST_ROCK * (0.5 + 0.45 * hb), pebble) * bedLight;
    vec3 inner = K_stream > 0.0 ? forestWater(q, w, zc, t, tm, keep, wetten(bed, 1.0, 0.3) * 0.7) : wetten(bed, forestWet, 0.3);
    float lip = forestBell((abs(s) - 1.0) / 0.09);
    col = mix(inner, col, smoothstep(0.92, 1.18, abs(s)));
    col = mix(col, wetten(FOREST_MOSS_DEEP, 1.0, 0.9) * light, lip * 0.75 * keep);
  }
  return col;
}

// Water gathered in the canopy running off and falling through the forest at depth z: columns 14 cm
// wide, a fifth of them (at amount 1) holding a tip that drips over and over: a bead swells for half
// the beat, lets go and falls as a streak lengthening with its speed. Returns coverage.
float forestDrip(vec2 q, float tm, float amount, float z, float salt) {
  vec2 w = vec2(q.x * z, (q.y - FOREST_HORIZON) * z + FOREST_EYE);
  float cw = 0.14;
  float cx = floor(w.x / cw);
  float h = hash12(vec2(cx + 0.5, salt * 17.0 + 3.0));
  if (h > 0.2 * amount) return 0.0;
  float period = mix(4.5, 2.0, amount) * (0.75 + 0.5 * fract(h * 37.3));
  float ph = tm / period + fract(h * 91.0);
  float n = floor(ph);
  float age = (ph - n) * period;
  float hn = hash12(vec2(cx + 0.5, n + salt * 11.0));
  float tipY = (0.8 + 0.22 * hn - FOREST_HORIZON) * z + FOREST_EYE;
  float x = (cx + 0.2 + 0.6 * fract(hn * 17.3)) * cw;
  float aa = z / uRes.y;
  float hw = max(0.003, 1.2 * aa);
  float hang = 0.5 * period;
  vec2 a = vec2(x, tipY);
  vec2 b = a;
  float r = hw;
  if (age < hang) {
    r = hw * (0.7 + 0.6 * age / hang);
    a = vec2(x, tipY - r);
    b = a;
  } else {
    float fall = age - hang;
    float y = tipY - 4.9 * fall * fall;
    if (y < 0.0) return 0.0;
    a = vec2(x, y);
    b = vec2(x, y + clamp(0.3 * fall, 2.0 * hw, 0.25));
  }
  return 1.0 - smoothstep(r - 0.6 * aa, r + 0.6 * aa, segmentDistance(w, a, b));
}

Shade sceneForest(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  forestAspect = aspect;
  forestLA = max(aspect, FOREST_MIN_ASPECT);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y);
  float tm = t * uMotion;
  forestCamD = forestCamera();
  forestTh = threshold(cell);
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, uMotionTime));
  // The rain's cloud closes over the sky as the rain sets in: a drizzle still lets some sun through,
  // from about a quarter of the knob up the sun and moon are gone, shafts and all. The deck is lit
  // from above, so the light turns soft and grey but stays, dimming only in the heaviest rain; and on
  // such a dark day the mushrooms and spirits show a little.
  forestRain = K_rain;
  forestOvercast = smoothstep(0.0, 0.25, K_rain);
  forestCloud = (dot(sky.ambient, LUMA) + 0.3 * dot(sky.sunColor, LUMA)) * (1.0 - 0.3 * K_rain * K_rain);
  forestNight = max(1.0 - smoothstep(0.0, 0.55, sky.day), 0.4 * forestOvercast * sky.day);
  sky.sunColor *= 1.0 - forestOvercast;
  sky.moonColor *= 1.0 - forestOvercast;
  sky.ambient = mix(sky.ambient, vec3(0.95, 0.98, 1.0) * forestCloud, forestOvercast);
  forestSky = sky;
  forestWet = clamp(uWeather.x, 0.0, 1.0);
  forestGloss = wetGloss(forestWet, 0.0);
  forestPar = uPointer * vec2(0.05, 0.02);

  // Light: the sky's brightness (its hue stays outside: the canopy makes the forest's light). Little of
  // it reaches the sides of things under the canopy, so the trunks stand dark against the luminous
  // mist; what faces up takes the light from the gaps above (forestTop); the key (sun or moon) lights
  // one side, strongest in a shaft.
  forestLevel = max(dot(sky.ambient, LUMA), 0.02);
  forestFill = forestLevel * vec3(0.82, 0.92, 0.84) * mix(0.6, 1.0, forestOvercast) + sky.moonColor * 0.2;
  forestTop = forestLevel * vec3(0.9, 1.0, 0.85) * mix(1.0, 0.85, forestOvercast) + sky.moonColor * 0.25;
  forestKey = sky.sunColor * FOREST_SUNLIT + sky.moonColor * vec3(0.7, 0.85, 0.95) * 1.2;
  float sunLevel = dot(sky.sunColor, LUMA);
  float moonLevel = dot(sky.moonColor, LUMA) * 1.3;
  vec2 keySide = sky.sun.xz * sunLevel + sky.moon.xz * moonLevel;
  forestKeySide = dot(keySide, keySide) > 1e-8 ? normalize(keySide) : vec2(0.6, 0.8);
  forestKeyDir = normalize(vec3(forestKeySide.x, 0.8, forestKeySide.y));

  // The shafts: three, at seed-chosen places, drifting very slowly.
  vec3 toLight = normalize(sky.sun * sunLevel + sky.moon * moonLevel + vec3(0.0, 1e-4, 0.0));
  forestRaySlant = clamp(atan(toLight.x, max(toLight.y, 0.0) + 0.35), -0.85, 0.85);
  vec3 jitter = vec3(
    hash12(vec2(1.0, K_forestSeed * 0.913 + 5.0)),
    hash12(vec2(4.7, K_forestSeed * 0.913 + 5.0)),
    hash12(vec2(8.4, K_forestSeed * 0.913 + 5.0))
  );
  forestRaySrc = (vec3(-0.3, 0.04, 0.32) + (jitter - 0.5) * 0.1) * aspect + 0.02 * sin(tm * 0.011 + jitter * 6.0) + tan(forestRaySlant) * 0.42;
  vec2 rays = K_shafts > 0.0 ? forestRays(p, tm) : vec2(0.0);
  forestBeam = K_shafts > 0.0 ? rays.x : 0.3;
  forestRayLight = sky.sunColor * FOREST_SUNLIT + sky.moonColor * vec3(0.6, 0.8, 0.95) * 1.6;
  vec3 beamGlow = forestRayLight * rays.y * K_shafts * (0.45 + 0.9 * K_mist) * 2.2;

  // The canopy shelters the forest: under it less than half the rain gets through (the rest gathers
  // and drips); through its gaps, where the shafts come, it pours, slanting with the wind.
  float gapX = p.x - K_wind * 0.35 * (1.0 - p.y);
  float gap = smoothstep(0.5, 0.75, vnoise(vec2(gapX * 2.2 + K_forestSeed * 0.37, 7.3)));
  for (int r = 0; r < 3; r++) gap = max(gap, forestBell((gapX - forestRaySrc[r]) / 0.09));
  forestRainHere = K_rain * mix(0.45, 1.0, gap);
  forestDropLit = max(vec3(0.94, 0.97, 1.0) * forestCloud * 1.2, vec3(0.08)) + forestKey * forestBeam * 0.5;

  // The mist, thick and thin as the sim's field carries its banks.
  forestWisp = uSimOn.z > 0.5 ? clamp(texture(uSim2, uv).r, 0.3, 2.0) : 1.0;
  vec3 mist = forestMistColor(p) * (0.88 + 0.12 * forestWisp) + beamGlow;
  forestMist = mist;
  forestSheen = forestMistColor(vec2(p.x, 0.9)) + forestRayLight * 0.15 * forestBeam;

  // The layout: the framing features keep to the edges of a frame at least FOREST_MIN_ASPECT wide.
  forestHeroX = -0.5 * forestLA + FOREST_HERO_EDGE;
  forestElderX = 0.5 * forestLA - FOREST_ELDER_EDGE;
  forestToriiX = forestStreamX(FOREST_TORII_Z);
  vec2 rockLC = vec2(-0.5 * forestLA + FOREST_ROCKL.x, FOREST_HORIZON + (FOREST_ROCKL_C - FOREST_EYE) / FOREST_ROCKL.y);
  vec2 rockLR = FOREST_ROCKL.zw / FOREST_ROCKL.y;
  vec2 rockRC = vec2(0.5 * forestLA - FOREST_ROCKR.x, FOREST_HORIZON + (FOREST_ROCKR_C - FOREST_EYE) / FOREST_ROCKR.y);
  vec2 rockRR = FOREST_ROCKR.zw / FOREST_ROCKR.y;

  // The mushrooms (as forestShroomSites in sim.ts), breathing slowly; a "now" on the spores makes them
  // flare as they puff.
  float logTop = FOREST_HORIZON + (2.0 * FOREST_LOG.w - 0.03 - FOREST_EYE) / FOREST_LOG.z;
  vec2 gate = vec2(FOREST_TORII_SPAN, 0.0) + rotate(FOREST_GATE_SHROOMS - vec2(FOREST_TORII_SPAN, 0.0), FOREST_TORII_LEAN);
  forestShroom[0] = vec4(forestOnRock(rockLC, rockLR, 0.8), FOREST_ROCKL.y, 1.0);
  forestShroom[1] = vec4(forestOnRock(rockLC, rockLR, -0.66), FOREST_ROCKL.y, 0.85);
  forestShroom[2] = vec4(1.25 / FOREST_LOG.z, logTop, FOREST_LOG.z, 0.9);
  forestShroom[3] = vec4(3.9 / FOREST_LOG.z, logTop, FOREST_LOG.z, 0.8);
  forestShroom[4] = vec4((forestToriiX + gate.x) / FOREST_TORII_Z, FOREST_HORIZON + (gate.y - FOREST_EYE) / FOREST_TORII_Z, FOREST_TORII_Z, 1.2);
  forestShroom[5] = vec4(forestOnRock(rockRC, rockRR, -0.72), FOREST_ROCKR.y, 0.75);
  float sinceSpores = sinceTrigger(3);
  float flare = sinceSpores >= 0.0 ? exp(-sinceSpores / 2.5) : 0.0;
  forestShroomGlow = K_mushrooms * (0.2 + 0.8 * forestNight) * (0.85 + 0.15 * sin(tm * 0.35)) * (1.0 + 1.5 * flare);

  // The M: there while its knob is on; a "now" summons it (the roots grow into it) and makes it glow
  // for a while, even by day.
  float sinceMark = sinceTrigger(2);
  float summon = sinceMark >= 0.0 ? smoothstep(0.0, 1.5, sinceMark) * (1.0 - smoothstep(14.0, 18.0, sinceMark)) : 0.0;
  float markShow = max(step(0.001, K_mark), summon);
  float markGlow = max(K_mark * (0.25 + 0.75 * forestNight), 0.9 * summon) * (0.85 + 0.15 * sin(tm * 0.6));

  float accent = 0.0;
  vec3 col = mist;
  float hitZ = 1e4;

  // Up top: the sky through the canopy's gaps (stars at night, the grey deck in rain) and the canopy.
  if (p.y > 0.7) {
    vec3 dir = viewRay(uv, aspect, FOREST_HORIZON, 1.0);
    vec3 sk = skyColor(sky, dir);
    vec3 gapCol = mix(vec3(dot(sk, LUMA)), sk, 0.45) * 1.05 + sky.sunColor * FOREST_SUNLIT * 0.1;
    gapCol += vec3(0.85, 0.88, 1.0) * skyStars(sky, dir, 0.5) * (1.0 - forestOvercast);
    // Under rain cloud the gaps show the deck, grey-white and lit from above, with shafts of heavier
    // rain hanging from it, slanting with the wind.
    float rainShafts = smoothstep(0.45, 0.8, vnoise(vec2((p.x - K_wind * 0.3 * p.y) * 5.0 + K_forestSeed, 3.7)));
    gapCol = mix(gapCol, vec3(0.94, 0.97, 1.0) * forestCloud * 1.25 * (1.0 - 0.2 * rainShafts * K_rain), 0.9 * forestOvercast);
    col = mix(col, max(gapCol, mist), smoothstep(0.78, 1.0, p.y));
    vec4 canopy = forestCanopy(p, tm);
    if (forestHard(canopy.a) > 0.0) {
      // Crowns at about 20 m: the nearer trunks rise in front of them, the farthest vanish into them.
      col = mix(mist, canopy.rgb, forestTransmit(6.0, 9.0));
      hitZ = 20.0;
    }
  }
  if (p.y < FOREST_HORIZON) {
    float zg;
    vec3 ground = forestGround(p, t, tm, zg);
    col = mix(mist, ground, forestTransmit(zg, 0.0));
    hitZ = zg;
  }

  // The far trunks, farthest first, with the stag between the second and third layers and the torii
  // in front of the second.
  for (int i = 2; i >= 0; i--) {
    float z = FOREST_TREE_Z[i];
    vec2 q = forestAt(p, z);
    float height;
    float depth;
    vec4 tree = forestTrees(q, i, depth, height);
    if (forestHard(tree.a) > 0.0 && z < hitZ) {
      col = mix(mist, tree.rgb, forestTransmit(depth, height));
      hitZ = depth;
    }

    if (i == 2 && uSimOn.x > 0.5) {
      // The stag: a dark shape in the mist by day; at night a glowing presence, its outline lit.
      vec4 sa = texelFetch(uSim0, ivec2(0, FOREST_SPIRITS), 0);
      if (sa.w > 0.0) {
        vec4 sb = texelFetch(uSim0, ivec2(1, FOREST_SPIRITS), 0);
        float sz = FOREST_STAG_Z;
        vec2 sq = forestAt(p, sz);
        float xw = sq.x * sz;
        float hgt = (sq.y - FOREST_HORIZON) * sz + FOREST_EYE;
        float aa = sz / uRes.y;
        // Small lights bloom where it has stepped and fade as it walks on.
        float kk = floor((xw - sb.z) * sa.z / FOREST_STAG_STRIDE + 0.5);
        float age = sb.w - kk * FOREST_STAG_STRIDE;
        if (kk >= 1.0 && age >= 0.0 && hitZ > sz - 1.0) {
          vec2 sv = (vec2(xw - (sb.z + sa.z * kk * FOREST_STAG_STRIDE), hgt - 0.05)) / vec2(0.07, 0.1);
          float bloom = (1.0 - smoothstep(0.7, 1.0, length(sv))) * exp(-age / 3.5) * smoothstep(0.0, 0.25, age) * sa.w * (0.25 + 0.75 * forestNight);
          if (forestHard(bloom) > 0.0) {
            col = mix(col, FOREST_GLOW * mix(0.5, 1.1, forestNight), 0.85);
            accent = max(accent, 0.8 * forestNight);
          }
        }
        vec2 l = vec2((xw - sa.x) * sa.z, hgt);
        if (abs(l.x) < 1.7 && hgt > -0.05 && hgt < 3.0) {
          float stand = texelFetch(uSim0, ivec2(2, FOREST_SPIRITS), 0).x;
          float d = forestStagDist(l, sa.y, sb.x, sb.y, stand, aa);
          float cover = (1.0 - smoothstep(-0.7 * aa, 0.7 * aa, d)) * sa.w * step(0.0, hgt);
          if (forestHard(cover) > 0.0) {
            float rim = 1.0 - smoothstep(0.0, 0.06, -d);
            vec3 coat = FOREST_STAG_COAT * (forestFill * 0.8 + forestKey * 0.1) + mist * 0.25 * rim;
            vec3 c = mix(mist, coat, forestTransmit(sz, hgt));
            float inner = 0.5 + 0.5 * vnoise(l * 3.0 + vec2(tm * 0.05, -tm * 0.03));
            c = mix(c, c * 0.6 + FOREST_GLOW * (0.12 + 0.18 * inner + 0.7 * rim) * 0.75, forestNight);
            col = c;
            hitZ = sz;
            accent = max(accent, forestNight * rim * 0.9);
          }
        }
      }
    }

    if (i == 1) {
      // The torii, the mushrooms glowing on the moss mound at its foot, and the drips off its top beam.
      float tz = FOREST_TORII_Z;
      vec2 tq = forestAt(p, tz);
      if ((tq.y - FOREST_HORIZON) * tz + FOREST_EYE >= -0.02) {
        vec2 P = forestToriiFrame(tq);
        vec4 torii = forestTorii(P, tz / uRes.y);
        if (forestHard(torii.a) > 0.0) {
          col = mix(mist, torii.rgb, forestTransmit(tz, max(P.y, 0.0)));
          hitZ = tz;
        }
        float glow;
        vec4 sh = forestShrooms(tq, 4, glow);
        if (forestHard(sh.a) > 0.0) {
          col = mix(mist, sh.rgb, forestTransmit(tz, 0.3)) + FOREST_SHROOM_GLOW * glow * 0.3;
          hitZ = tz;
          accent = max(accent, glow);
        }
        float eaves = max(K_rain, 0.4 * forestWet);
        float ext = FOREST_TORII_SPAN + FOREST_TORII_OVER;
        float bottom = forestKasagiBottom(P.x);
        if (eaves > 0.0 && abs(P.x) < ext && P.y < bottom && P.y > bottom - 2.2) {
          float drip = rainDrips(vec2(P.x + ext, bottom - P.y), t, eaves, 0.4);
          col = mix(col, forestDropLit, drip * 0.85 * forestTransmit(tz, 2.5));
        }
      }
    }
  }

  // The fallen log and its mushrooms.
  {
    float z = FOREST_LOG.z;
    vec2 q = forestAt(p, z);
    float up;
    vec4 fallen = forestLog(q, up);
    if (forestHard(fallen.a) > 0.0) {
      col = mix(mist, fallen.rgb, forestTransmit(z, 0.5));
      hitZ = z;
    }
    for (int k = 2; k <= 3; k++) {
      float glow;
      vec4 sh = forestShrooms(q, k, glow);
      if (forestHard(sh.a) > 0.0) {
        col = mix(mist, sh.rgb, forestTransmit(z, 0.7)) + FOREST_SHROOM_GLOW * glow * 0.3;
        hitZ = z;
        accent = max(accent, glow);
      }
    }
  }

  // The old beech and its branch.
  {
    float z = FOREST_ELDER_Z;
    vec2 q = forestAt(p, z);
    if (abs(q.x - forestElderX) < 0.4) {
      float height;
      float u;
      vec4 tree = forestBigTree(q, forestElderX, z, FOREST_ELDER_SHAPE, 1.0, 7.7, 0.9, height, u);
      if (forestHard(tree.a) > 0.0) {
        col = mix(mist, tree.rgb, forestTransmit(z, height));
        hitZ = z;
      }
    }
    float drip;
    vec4 branch = forestBranch(q, t, tm, drip);
    if (forestHard(branch.a) > 0.0) {
      col = mix(mist, branch.rgb, forestTransmit(z, 3.0));
      hitZ = z;
    } else if (drip > 0.0) {
      col = mix(col, forestDropLit, 0.85 * forestTransmit(z, 2.0));
    }
  }

  // The stepping stones, farthest first.
  for (int k = ${FOREST_STONES.length - 1}; k >= 0; k--) {
    vec4 st = FOREST_STONE[k];
    float z = st.x;
    vec2 q = forestAt(p, z);
    vec2 c = vec2((forestStreamX(z) + st.y) / z, FOREST_HORIZON - FOREST_EYE / z);
    vec2 rs = st.zw / z;
    float up;
    vec4 stone = forestRock(q, c, rs, z, c.y - 0.08 * rs.y, 11.0 + float(k) * 3.7, 0.35, t, up);
    if (forestHard(stone.a) > 0.0) {
      col = mix(mist, stone.rgb, forestTransmit(z, 0.1));
      hitZ = z;
    }
  }

  // The boulder on the right bank, and its mushrooms.
  {
    float z = FOREST_ROCKR.y;
    vec2 q = forestAt(p, z);
    float up;
    vec4 rock = forestRock(q, rockRC, rockRR, z, FOREST_HORIZON - FOREST_EYE / (z - 0.6), 4.1, 0.85, t, up);
    if (forestHard(rock.a) > 0.0) {
      col = mix(mist, rock.rgb, forestTransmit(z, 0.4));
      hitZ = z;
    }
    float glow;
    vec4 sh = forestShrooms(q, 5, glow);
    if (forestHard(sh.a) > 0.0) {
      col = mix(mist, sh.rgb, forestTransmit(z, 0.5)) + FOREST_SHROOM_GLOW * glow * 0.3;
      hitZ = z;
      accent = max(accent, glow);
    }
  }

  // The great cedar with its rope: the whole massive bole in view, buttresses splaying at its foot.
  {
    float z = FOREST_HERO_Z;
    vec2 q = forestAt(p, z);
    if (abs(q.x - forestHeroX) < 0.66) {
      float height;
      float u;
      vec4 tree = forestBigTree(q, forestHeroX, z, FOREST_HERO_SHAPE, 0.0, FOREST_HERO_SALT, 1.25, height, u);
      if (forestHard(tree.a) > 0.0) {
        vec4 rope = forestRope(q, max(height, 0.0), u, tm);
        vec3 c = mix(tree.rgb, rope.rgb, forestHard(rope.a));
        col = mix(mist, c, forestTransmit(z, height));
        hitZ = z;
      }
    }
  }

  // The near boulder, the roots gripping it (or the M), and its mushrooms.
  {
    float z = FOREST_ROCKL.y;
    vec2 q = forestAt(p, z);
    float up;
    vec4 rock = forestRock(q, rockLC, rockLR, z, -1.0, 2.3, 1.0, t, up);
    if (forestHard(rock.a) > 0.0) {
      col = mix(mist, rock.rgb, forestTransmit(z, 0.4));
      hitZ = z;
    }
    float glow;
    vec4 roots = forestRoots(q, rockLC, rockLR, z, markShow, markGlow, glow);
    if (roots.a > 0.0) {
      col = mix(mist, roots.rgb, forestTransmit(z, 0.5)) + FOREST_GLOW * glow * 0.25;
      hitZ = z;
      accent = max(accent, glow);
    }
    for (int k = 0; k <= 1; k++) {
      vec4 sh = forestShrooms(q, k, glow);
      if (forestHard(sh.a) > 0.0) {
        col = mix(mist, sh.rgb, forestTransmit(z, 0.5)) + FOREST_SHROOM_GLOW * glow * 0.3;
        hitZ = z;
        accent = max(accent, glow);
      }
    }
  }

  // Ferns in the near corners.
  {
    float z = 2.3;
    vec2 q = forestAt(p, z);
    vec4 fern = forestFern(q, vec2(0.5 * forestLA - 0.07, -0.05), 0.42, 1.0, tm);
    vec4 fern2 = forestFern(q, vec2(-0.5 * forestLA + 0.07, -0.06), 0.34, 5.0, tm);
    if (fern2.a > fern.a) fern = fern2;
    if (forestHard(fern.a) > 0.0) {
      col = mix(mist, fern.rgb, forestTransmit(z, 0.5));
      hitZ = z;
    }
  }

  // The spirits on their perches: each dissolves in and out cell by cell, rises out of the moss as it
  // comes, and stands with its feet in the moss; chalky white by day, glowing from within at dusk, its
  // face three dark holes; hidden by whatever stands nearer. At night each wears a faint halo.
  float spiritHalo = 0.0;
  if (uSimOn.x > 0.5) {
    for (int s = 0; s < FOREST_SPIRITS; s++) {
      vec4 sa = texelFetch(uSim0, ivec2(0, s), 0);
      if (sa.w <= 0.003) continue;
      float z = sa.z;
      vec2 q = forestAt(p, z);
      vec4 sc = texelFetch(uSim0, ivec2(2, s), 0);
      float hs = sc.y / z;
      vec2 l = (q - sa.xy) / hs;
      vec2 hv = l - vec2(0.0, 0.6);
      float r2 = dot(hv, hv);
      if (r2 > 4.0) continue;
      vec4 sb = texelFetch(uSim0, ivec2(1, s), 0);
      float T = forestTransmit(z, 0.3);
      if (hitZ > z - 0.6) spiritHalo += sa.w * sb.z * exp(-r2 / 0.45) * mix(T, 1.0, 0.4);
      if (abs(l.x) > 0.55 || l.y > 1.05 || hitZ < z - 0.35) continue;
      if (l.y < 0.03 + 0.03 * sin(l.x * 23.0 + float(s))) continue;
      vec4 shape = forestSpiritShape(l + vec2(0.0, sc.x * 0.45), sb.x, sb.y, sb.w, hs * uRes.y);
      if (forestHard(shape.x * sa.w) <= 0.0) continue;
      vec3 body = FOREST_SPIRIT * (forestFill * 1.6 + forestTop * 0.6 + forestKey * (0.2 + 0.4 * forestBeam) + forestShroomLight(q, z) * 0.6) * (0.75 + 0.25 * shape.z);
      vec3 inner = FOREST_GLOW * sb.z * forestNight * (0.5 + 0.5 * shape.w) * 0.6;
      vec3 c = mix(mist, body, T) + inner * mix(T, 1.0, 0.5);
      if (shape.y > 0.5) c = mix(mist, vec3(0.01, 0.015, 0.012), mix(T, 1.0, 0.3));
      col = c;
      hitZ = z;
      accent = max(accent, shape.y > 0.5 ? 0.0 : 0.85);
    }
  }

  // Light in the air: the spirits' halos, the mushrooms' glow, the M's.
  col += FOREST_GLOW * spiritHalo * 0.1 * forestNight * (0.5 + K_mist);
  for (int i = 0; i < 6; i++) {
    vec4 site = forestShroom[i];
    vec2 v = (forestAt(p, site.z) - site.xy) * site.z - vec2(0.0, 0.06);
    float halo = exp(-dot(v, v) / (0.05 + 0.08 * K_mist)) * (hitZ > site.z - 0.5 ? 1.0 : 0.3);
    col += FOREST_SHROOM_GLOW * forestShroomGlow * site.w * halo * (0.06 + 0.22 * K_mist) * forestTransmit(site.z, 0.3);
  }
  if (markGlow * markShow > 0.0) {
    vec2 mv = (forestAt(p, FOREST_ROCKL.y) - rockLC - vec2(0.0, FOREST_MARK.x * rockLR.y)) / (FOREST_MARK.y * rockLR.y);
    col += FOREST_GLOW * markGlow * markShow * exp(-dot(mv, mv) / 0.5) * (0.04 + 0.12 * K_mist) * (hitZ > FOREST_ROCKL.y - 0.5 ? 1.0 : 0.3);
  }

  // The mist's banks drifting across, in front of everything but the nearest things.
  float bank = K_mist * 0.3 * smoothstep(1.0, 1.5, forestWisp) * (1.0 - exp(-min(max(hitZ - forestCamD, 0.0), 40.0) / 9.0));
  col = mix(col, mist * 1.05, bank);

  // Spores and motes.
  vec4 motes = forestMotes(p, hitZ);
  if (motes.a > 0.0) {
    col = mix(col, motes.rgb, motes.a);
    accent = max(accent, motes.a * forestNight * 0.9);
  }

  // Drops off the canopy, falling through the beech's and the far trunks' depths behind whatever
  // stands nearer. Like the rain they are water against the sky and take its light.
  float dripAmount = forestWet * (0.3 + 0.5 * clamp(1.6 * K_rain, 0.0, 1.0));
  if (dripAmount > 0.0) {
    float drip = 0.0;
    if (hitZ > FOREST_ELDER_Z) drip = forestDrip(forestAt(p, FOREST_ELDER_Z), tm, dripAmount, FOREST_ELDER_Z, 1.0);
    if (hitZ > FOREST_TREE_Z[0]) drip = max(drip, 0.75 * forestDrip(forestAt(p, FOREST_TREE_Z[0]), tm, 0.75 * dripAmount, FOREST_TREE_Z[0], 2.0));
    col = mix(col, forestDropLit * 1.1, forestHard(drip) * 0.85);
  }
  // The rain, in depth: each layer of drops hidden behind the first surface along this pixel, its
  // unresolved haze laid over the distance like the mist, the nearest, out of focus, fainter.
  if (forestRain > 0.0) {
    Precip rain = rainFall(uv, aspect, t, forestRainHere, K_wind, 1.0 - exp(-max(hitZ - forestCamD, 0.0) / 30.0));
    col = mix(col, mist, rain.veil);
    col = mix(col, forestDropLit, rain.cover * mix(0.9, 0.55, rain.near));
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(pow(max(dot(col, LUMA), 0.0) * 1.6, 0.8), 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
