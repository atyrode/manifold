// The Campfire preset's layers' GLSL (ADR 0062 Phase 2b; the composer: src/composer, README
// "Composers"): a small campfire at night seen from a low seat just across the flames, through the
// seat's rig (constants.ts CAMPFIRE_RIG: horizon 0.37, a field of one radian, the eye 0.9 m up). Its
// parts, each a layer, drawn in the order the campfire always painted them:
//   pines     (backdrop) the World's sky over the clearing with a faint skyglow along the horizon,
//             two rows of far pines fading into the haze, and the two big pines framing the view;
//             the clearing's air.
//   clearing  (ground) the soil and the flat rocky outcrop under the fire, lit by it, the stones'
//             contact shadows; dark and glossy in rain, snowed on away from the fire.
//   camp      (dressing) the tent with its lantern glowing inside and the backpack at the edge of the
//             light.
//   campfire  (dressing, the subject) the far half of the ring of stones, the breathing coals, the back
//             log, the flames (four nested layers of licking tongues), the two front logs, the near
//             stones, the mug, the marshmallow toasting on its stick and the log bench (with the M
//             carved in it when it is on); its light falls on every other layer (campfireLightAt).
//   smoke     (life) the thin column rising from the flames, leaning with the wind.
//   sparks    (life) sparks climbing from the flames in lazy arcs.
//
// Space: p = (x in view heights from the centre, y up from the bottom), one cell = 1 / uRes.y, as the
// campfire was drawn: the fire stands at campfireF; ground distances are foreshortened (a circle on
// the ground is an ellipse 0.32 as tall). Every part stands at a depth in metres (CAMPFIRE_Z_*: its
// foot on the rig's floor, nearer in the order the campfire painted them), over the floor and behind
// whatever already stands nearer (c.zs), so the parts compose as they were painted and the World's
// fog and rain fall between them at those depths. Light is one warm source at the fire, falling off as
// 1 / (1 + (d / r0)^2)^2, breathing a few percent; every surface is albedo * (sky light + warm *
// firelight), the sky's light the World's (its moon put away by the preset) times 1.35 over a cool
// floor (CAMPFIRE_GRADE matches it for guests).
//
// The picture itself is no simulation. Moving edges (flame layers, smoke, sparks) are cut per cell
// with hardEdge / hardFill so a passing edge flips a cell once; the flames' noise advects upward at
// well under a flame height per second, the sparks drift at ~25 px/s, so nothing flickers cell by
// cell. With K_fuel on, the logs burn down (sim.ts, a FuelBed in the campfire's row of the records
// atlas): the flames, the firelight, the coals, the smoke and the sparks follow the bed, and each log
// chars, thins, slumps and crumbles away; off, the fire is exactly the steady one it always was.
//
// What the campfire keeps of its own, and what is the World's (ADR 0062 D10): the sky, its stars,
// the Milky Way, the shooting stars and the giant planet (the World's planets, the giant the first
// the preset opens with) are the World's, and so are the fog and the rain and snow, at the composed
// depth. The passage is the campfire's: embers in the dark, a flame catching and growing, the
// firelight spreading, the sparks and the smoke starting up; all exactly off at rest.
// Knobs read: the campfire's K_flame, K_lively, K_marshmallow, K_fuel (K_tend: sim.ts), K_reach,
// K_campfireMark; the life layers' switches K_smoke and K_sparks (their amounts); the World's K_wind.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  CAMPFIRE_FIRE_Z,
  CAMPFIRE_FOV,
  CAMPFIRE_HORIZON,
  CAMPFIRE_LOGS,
  campfireDepth,
} from "./constants.ts";

/**
 * What every campfire layer shares: the layout, the light and the fire's state each cell takes
 * (campfireBegin), the firelight, the ring's stones and where the clearing ends.
 */
export const campfireSharedGlsl = `
// ---- the campfire (campfire/shader.ts), shared by its layers ----
const int CAMPFIRE_LOGS = ${CAMPFIRE_LOGS};      // the fuel's log texels (sim.ts), the bed's after them
const float CAMPFIRE_HORIZON = ${glslFloat(CAMPFIRE_HORIZON)};   // screen height of the far horizon (the pines hide it)
const float CAMPFIRE_FOV = ${glslFloat(CAMPFIRE_FOV)};
const float CAMPFIRE_FLAME = 0.30;     // the full flame's height, in the fire's own units
const vec3 CAMPFIRE_WARM = vec3(1.0, 0.52, 0.18);
// Where each part stands (m ahead): the fire's foot, then the parts nearer in the order the campfire
// painted them, back to front, each over what it was painted over.
const float CAMPFIRE_Z_FIRE = ${glslFloat(CAMPFIRE_FIRE_Z)};
const float CAMPFIRE_Z_FAR = 60.0;           // the far row of pines
const float CAMPFIRE_Z_MID = 30.0;           // the middle row
const float CAMPFIRE_Z_PINES = 5.5;          // the two big pines framing the view
const float CAMPFIRE_Z_TENT = ${glslFloat(campfireDepth(0.2))};
const float CAMPFIRE_Z_PACK = ${glslFloat(campfireDepth(0.06))};
const float CAMPFIRE_Z_RING_BACK = CAMPFIRE_Z_FIRE + 0.3;
const float CAMPFIRE_Z_COALS = CAMPFIRE_Z_FIRE + 0.2;
const float CAMPFIRE_Z_BACK_LOG = CAMPFIRE_Z_FIRE + 0.15;
const float CAMPFIRE_Z_FLAMES = CAMPFIRE_Z_FIRE + 0.1;
const float CAMPFIRE_Z_SMOKE = CAMPFIRE_Z_FIRE + 0.05;
const float CAMPFIRE_Z_FRONT_LOG = CAMPFIRE_Z_FIRE - 0.15;
const float CAMPFIRE_Z_CROSS_LOG = CAMPFIRE_Z_FIRE - 0.2;   // laid over the other front log
const float CAMPFIRE_Z_RING_FRONT = CAMPFIRE_Z_FIRE - 0.3;
const float CAMPFIRE_Z_MUG = ${glslFloat(campfireDepth(0.0835))};
const float CAMPFIRE_Z_STICK = CAMPFIRE_Z_FIRE - 0.35;  // its end over the fire; it rests on the bench
const float CAMPFIRE_Z_BENCH = ${glslFloat(campfireDepth(0.027))};
const float CAMPFIRE_Z_SPARKS = CAMPFIRE_Z_FIRE - 0.4;

Sky campfireSkyState;   // the World's sky now
vec3 campfireAmb;       // light from the sky on upturned surfaces
vec2 campfireF;         // the fire's centre on the ground
float campfireS;        // flame scale, 0.62 .. 1.38
float campfireTm;       // the motion clock
float campfireBreath;   // firelight gain, breathing a few percent
float campfireHalf;     // half the frame width, kept in 0.5 .. 0.9 for the layout
float campfireGlow;     // what should glow in the accent colour
float campfireFlameG;   // flame growth 0..1 (1 at rest): the flame catches on entry and dies on exit
float campfireLit;      // how far the firelight has spread 0..1 (1 at rest)
float campfireSparkG;   // sparks gate 0..1
float campfireSmokeG;   // smoke column strength 0..1
float campfireCoalK;    // coal glow gain, 0.6 (low embers) .. 1
float campfireSparkK;   // share of the spark slots flying (K_sparks, or the bed's)
float campfireSmokeK;   // smoke density gain (1, or the bed's)
vec2 campfireP;         // the cell, in the campfire's space (above)
float campfirePx;       // one cell
vec3 campfireDir;       // the cell's ray, as the campfire laid its haze out
vec3 campfireHaze;      // the haze toward its bearing
// The fuel (K_fuel, sim.ts): per log x wood left (0 burnt away), y char, z slump, w laid on; the bed
// x heat, y embers, z smoke, w spark burst. Off: whole fresh logs over a steady bed, vec4(1, 0, 0, 1)
// and vec4(1, 1, 0, 0), which change nothing.
bool campfireFuelOn;
vec4 campfireFuelLog[CAMPFIRE_LOGS];
vec4 campfireFuelBed;

// The passage's eases between progress lo and hi: in, from rest and fastest at hi (u²); out, fastest
// at lo and coming to rest at hi (1 - (1 - u)²). Both exactly 0 before lo and 1 after hi.
float campfireEaseIn(float lo, float hi, float x) {
  float u = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return u * u;
}

float campfireEaseOut(float lo, float hi, float x) {
  float u = 1.0 - clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return 1.0 - u * u;
}

// Firelight reaching p: 1 at the fire, falling off. lift 0 is flat ground (distances foreshortened),
// 1 an upright surface. None while the fire is out of the stack.
float campfireLight(vec2 p, float lift) {
#if LAYER_CAMPFIRE
  vec2 d = p - (campfireF + vec2(0.0, 0.085 * campfireS));
  d.y /= mix(0.34, 1.0, lift);
  float r0 = (0.28 + 0.42 * K_reach) * (0.8 + 0.2 * campfireS) * mix(0.5, 1.0, campfireLit);
  float l = 1.0 / (1.0 + dot(d, d) / (r0 * r0));
  return l * (0.3 + 0.7 * l) * campfireBreath;
#else
  return 0.0;
#endif
}

// An albedo wet by the World's rain (wetten), porous 0 stone .. 1 soil, wood, cloth; dry, as it is.
vec3 campfireWet(vec3 alb, float porous) {
  return uWeather.x > 0.0 ? wetten(alb, uWeather.x, porous) : alb;
}

// A part of the camp now stands in the cell at depth z, over the floor: what it shows, and what hides
// a speck or a part drawn after it from behind.
void campfireStand(inout Cell c, float z) {
  c.z = z;
  c.zs = z;
}

// The ring of stones: centre of stone i and its half size. Stones further from the viewer sit higher
// and smaller.
vec2 campfireStone(int i, out vec2 sz) {
  float fi = float(i);
  float ang = (fi + 0.35 * hash12(vec2(fi, 5.1))) * (TAU / 12.0) + 0.2;
  float rr = 1.0 + 0.10 * (hash12(vec2(fi, 6.2)) - 0.5);
  float depth = sin(ang);
  vec2 c = campfireF + vec2(cos(ang) * 0.175 * rr, depth * 0.052 * rr);
  float sizeV = 0.020 + 0.012 * hash12(vec2(fi, 7.3));
  float scale = 1.0 - 0.22 * depth;
  sz = vec2(sizeV * 1.25, sizeV * 0.85) * scale;
  return c;
}

// The clearing's far edge, where the pines' rows take over: higher toward the sides.
float campfireGroundTop(float x) {
  float side = smoothstep(0.55 * campfireHalf, campfireHalf * 1.05, abs(x));
  return 0.285 + 0.014 * vnoise(vec2(x * 3.0, 1.7)) + 0.045 * side;
}

// Every campfire layer's state for this cell: the layout, the sky's light (the World's, its moon put
// away by the preset), the fire's size and breath, its passage, and the fuel's bed.
void campfireBegin(Ctx x) {
  campfireTm = x.tm;
  campfireSkyState = x.w.sky;
  campfireAmb = campfireSkyState.ambient * 1.35 + vec3(0.012, 0.017, 0.034);
  campfireHalf = clamp(0.5 * x.aspect, 0.5, 0.9);
  campfireP = vec2((x.uv.x - 0.5) * x.aspect, x.uv.y);
  campfirePx = x.aa;
  campfireDir = viewRay(x.uv, x.aspect, CAMPFIRE_HORIZON, CAMPFIRE_FOV);
  campfireHaze = horizonHaze(campfireSkyState, campfireDir, 0.01);
  campfireS = 0.62 + 0.76 * K_flame;
  campfireF = vec2(0.0, 0.16);
  float slow = 0.5 + 0.5 * sin(campfireTm * 0.9 + 1.3 * sin(campfireTm * 0.37));
  float lick = vnoise1(campfireTm * 0.8, 11.0).x;
  campfireBreath = (0.55 + 0.45 * campfireS) * (0.90 + 0.06 * slow + 0.06 * (lick - 0.5));
  // Passage (all exactly 1 at rest). Entrance: embers in a dark night, a flame catches and grows, the
  // firelight spreads, then smoke and sparks start up at once and settle to the fire's own. Exit:
  // sparks go, the flame dies down, the light withdraws, a last curl of smoke, each going faster
  // and faster, the light and the smoke until the very end. The sky is never touched.
  float pin = passageIn();
  float pout = passageOut();
  campfireFlameG = smoothstep(0.20, 0.72, pin) * (1.0 - campfireEaseIn(0.10, 0.70, pout));
  campfireLit = smoothstep(0.24, 0.98, pin) * (1.0 - campfireEaseIn(0.30, 1.00, pout));
  campfireSparkG = campfireEaseOut(0.58, 1.00, pin) * (1.0 - campfireEaseIn(0.00, 0.35, pout));
  campfireSmokeG = campfireEaseOut(0.40, 0.90, pin) * (1.0 - campfireEaseIn(0.62, 1.00, pout));
  campfireCoalK = mix(0.6, 1.0, campfireLit);
  campfireBreath *= mix(0.12, 1.0, campfireLit);
  campfireAmb *= mix(0.6, 1.0, campfireLit);
  campfireSparkK = K_sparks;
  campfireSmokeK = 1.0;
  campfireFuelBed = vec4(1.0, 1.0, 0.0, 0.0);
  for (int i = 0; i < CAMPFIRE_LOGS; i++) campfireFuelLog[i] = vec4(1.0, 0.0, 0.0, 1.0);
  campfireFuelOn = false;
#if LAYER_CAMPFIRE
  campfireFuelOn = K_fuel > 0.0 && campfireSimOn();
  if (campfireFuelOn) {
    for (int i = 0; i < CAMPFIRE_LOGS; i++) campfireFuelLog[i] = campfireRecord(i, 0);
    campfireFuelBed = campfireRecord(CAMPFIRE_LOGS, 0);
    float heat = campfireFuelBed.x;
    float embers = campfireFuelBed.y;
    // The flames follow the flaming wood (a fresh armful flares past the usual fire, coals alone have
    // none); the firelight follows the flames, or the coals where they glow brighter; the coals glow
    // with the bed. Sparks fly with the flames and shower when a log slumps or lands; a fresh log
    // smokes until it catches.
    campfireFlameG *= min(heat, 1.3);
    campfireBreath *= 0.06 + 0.94 * max(min(heat, 1.25), 0.6 * min(embers, 1.0));
    campfireCoalK *= mix(0.15, 1.1, smoothstep(0.0, 0.6, embers));
    campfireSparkK = min(1.0, K_sparks * clamp(heat, 0.0, 1.2) + 0.6 * campfireFuelBed.w);
    campfireSmokeK = clamp(0.85 * min(heat, 1.2) + 1.6 * campfireFuelBed.z, 0.0, 2.2);
  }
#endif
  campfireGlow = 0.0;
}
`;

/** The pines' GLSL: the sky over the clearing, the rows of far pines, the two big ones, the air. */
export const pinesGlsl = `
// ---- the pines ----

// A pine of tiered boughs as a signed distance (< 0 inside): bare trunk below s = 0.14, then tiers that
// widen downward and taper to the top; lean sways the top.
float pinesTree(vec2 p, float cx, float base, float h, float w, float tiers, float lean) {
  float s = (p.y - base) / h;
  float sc = clamp(s, 0.0, 1.2);
  float cr = clamp((s - 0.14) / 0.86, 0.0, 1.0);
  float hw = s < 0.14 ? w * 0.07 : w * (1.0 - cr) * mix(1.0, 0.45, fract(cr * tiers));
  float x = cx + lean * sc * sc;
  return max(abs(p.x - x) - hw, p.y - (base + h));
}

// A row of pines along x, one per cell of width spacing (jittered), the nearest three tested.
float pinesRow(vec2 p, float spacing, float base, float hMin, float hMax, float w, float salt, float lean) {
  float d = 1e3;
  float i0 = floor(p.x / spacing);
  for (int k = -1; k <= 1; k++) {
    float id = i0 + float(k);
    float h1 = hash12(vec2(id, salt));
    float h2 = hash12(vec2(id, salt + 9.1));
    float cx = (id + 0.15 + 0.7 * h1) * spacing;
    float h = mix(hMin, hMax, h2 * h2);
    float tiers = 5.0 + floor(h1 * 3.0);
    float sway = lean * sin(campfireTm * 0.3 + id * 1.7);
    d = min(d, pinesTree(p, cx, base, h, w * mix(0.8, 1.2, h1), tiers, sway));
  }
  return d;
}

// Pine colour: nearly black, more haze the farther it stands (the World's fog falls on them at their
// depth).
vec3 pinesTone(float haziness) {
  vec3 dark = vec3(0.05, 0.075, 0.06) * (campfireAmb * 3.0 + 0.04) + vec3(0.006, 0.009, 0.016);
  return mix(dark, campfireHaze * 0.8, clamp(haziness, 0.0, 1.0));
}

// The rim of a pine's silhouette, lit by the haze behind it.
vec3 pinesRim() {
  return campfireHaze * 0.7 + vec3(0.012, 0.018, 0.034) * campfireSkyState.night;
}

// A pine drawn over the cell at depth z, by its cover (0 or 1): over the floor, behind what stands nearer.
void pinesPut(inout Cell c, vec3 col, float cover, float z) {
  if (z > c.zs) return;
  c.col = mix(c.col, col, cover);
  if (cover > 0.5) {
    c.z = z;
    c.zs = z;
  }
}

// ---- the pines' passes ----
// The clearing's air (the backdrop's): the haze toward this bearing, which the fog takes on, as mist
// did between the pines; the drops' light, the sky's and near the fire the fire's; the clearing ends
// at the foot of the pines.
void pinesBegin(inout Ctx x) {
  vec3 drop = max(campfireAmb * 1.2, vec3(0.08)) + CAMPFIRE_WARM * 1.2 * campfireLight(campfireP, 0.6);
  x.air = Air(campfireHaze, campfireHaze * 0.9 + campfireAmb * 0.6, drop, campfireHaze, 0.0, 0.01, 0.0);
  x.groundTo = campfireGroundTop(campfireP.x);
  x.landZ = 1e9;
}

// The World's sky over the pines (the dome, the aurora and the cloud, the stars and the Milky Way,
// the planets in their gaps, shooting stars, the lightning), and a faint skyglow along the horizon,
// so the pines keep a backdrop even in the deepest night.
void pinesSky(Ctx x, inout Cell c) {
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  vec3 glow = vec3(0.09, 0.10, 0.15) * exp(-max(campfireDir.y, 0.0) * 5.0) * campfireSkyState.night;
  c.col = heaven.col + glow + heaven.strike;
}

// The far and middle rows of pines in the haze, a little parallax with the pointer; the far row's
// band fills the land below it.
void pinesFar(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float px = campfirePx;
  vec2 pf = p + vec2(uPointer.x * 0.006, 0.0);
  vec2 pm = p + vec2(uPointer.x * 0.012, 0.0);
  float dFar = min(pinesRow(pf, 0.105, 0.27, 0.15, 0.27, 0.045, 3.0, 0.0), p.y - 0.30);
  pinesPut(c, pinesTone(0.55), hardFill(dFar, px * 1.2), CAMPFIRE_Z_FAR);
  float dMid = pinesRow(pm, 0.165, 0.25, 0.17, 0.36, 0.07, 17.0, 0.0);
  vec3 midTone = pinesTone(0.2);
  float cMid = hardFill(dMid, px * 1.2);
  pinesPut(c, midTone, cMid, CAMPFIRE_Z_MID);
  pinesPut(c, midTone + pinesRim() * 0.5, cMid * (1.0 - hardFill(dMid + 0.005, px * 1.2)), CAMPFIRE_Z_MID);
}

// The two big pines framing the view, swaying a little in the wind.
void pinesMiddle(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float px = campfirePx;
  float tm = campfireTm;
  float lean = 0.004 + 0.006 * abs(K_wind);
  float dNear = min(
    pinesTree(p, -0.90 * campfireHalf, 0.12, 1.05, 0.17, 7.0, lean * sin(tm * 0.31)),
    pinesTree(p, 0.84 * campfireHalf, 0.10, 0.95, 0.15, 6.0, -lean * sin(tm * 0.27 + 1.0)));
  vec3 nearTone = pinesTone(0.0);
  float cNear = hardFill(dNear, px * 1.2);
  pinesPut(c, nearTone, cNear, CAMPFIRE_Z_PINES);
  pinesPut(c, nearTone + pinesRim() * 0.4, cNear * (1.0 - hardFill(dNear + 0.006, px * 1.2)), CAMPFIRE_Z_PINES);
}
`;

/** The clearing's GLSL: the ground round the fire. */
export const clearingGlsl = `
// ---- the clearing ----

// The ground: soil, and the flat rocky slab the fire stands on, cracked, lit by the fire; the ring's
// contact shadows; wet, it darkens and glints with the sky and the fire; lying snow, melted round
// the fire.
vec3 clearingColour(Ctx x, vec2 p) {
  vec2 q = p - campfireF;
  vec2 g = vec2(q.x, q.y / 0.32);
  float rho = length(g);
  vec2 u = g / max(rho, 1e-4);
  float slabR = 0.34 + 0.07 * vnoise(u * 1.7 + 3.0) + 0.03 * vnoise(u * 4.3 + 1.0);
  float n = fbm3(p * vec2(8.0, 16.0));
  vec3 soil = mix(vec3(0.16, 0.12, 0.085), vec3(0.10, 0.125, 0.085), smoothstep(0.35, 0.7, n));
  float pebble = step(0.97, hash12(floor(p * vec2(80.0, 140.0))));
  soil = mix(soil, vec3(0.24, 0.23, 0.22), pebble * 0.7);
  vec3 rock = mix(vec3(0.21, 0.205, 0.22), vec3(0.14, 0.14, 0.17), smoothstep(0.3, 0.8, fbm3(p * vec2(5.0, 12.0) + 4.0)));
  float crack = smoothfall(0.05, 0.022, abs(vnoise(p * vec2(6.0, 15.0) + 8.0) - 0.5));
  rock *= 1.0 - 0.55 * crack;
  float slab = hardEdge(smoothfall(slabR + 0.02, slabR - 0.02, rho));
  vec3 alb = campfireWet(mix(soil, rock, slab), mix(0.8, 0.2, slab));
  // Contact shadows under the stones.
  float occ = 1.0;
#if LAYER_CAMPFIRE
  if (abs(q.x) < 0.27 && abs(q.y) < 0.11) {
    for (int i = 0; i < 12; i++) {
      vec2 sz;
      vec2 c = campfireStone(i, sz);
      vec2 e = (p - c + vec2(0.0, sz.y * 0.55)) / (sz * vec2(1.3, 0.9));
      occ *= 1.0 - 0.55 * (1.0 - smoothstep(0.7, 1.3, length(e)));
    }
  }
#endif
  float fire = campfireLight(p, 0.0);
  vec3 lightc = campfireAmb * 0.9 + vec3(1.0, 0.46, 0.12) * (3.8 * fire);
  vec3 col = alb * lightc * occ;
  if (uWeather.x > 0.0) col += wetGloss(uWeather.x, 1.0) * (x.air.deck * 0.3 + CAMPFIRE_WARM * 0.6 * fire) * occ;
  if (uWeather.y > 0.0) {
    vec2 xz = vec2(p.x * x.zg / RIG_FOCAL, x.zg);
    float snow = snowCover(vec3(0.0, 1.0, 0.0), xz, uWeather.y) * (1.0 - smoothstep(0.08, 0.35, fire));
    col = mix(col, vec3(0.92, 0.94, 0.98) * lightc * occ, snow);
  }
  return col;
}

// ---- the clearing's pass ----
// Below the clearing's far edge, where the ray meets the ground.
void clearingGround(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float top = campfireGroundTop(p.x);
  if (p.y >= top + 0.01 || hardFill(p.y - top, campfirePx * 1.5) <= 0.5) return;
  c.col = clearingColour(x, p);
  c.z = x.zg;
}
`;

/** The camp's GLSL: the tent with its lantern and the backpack. */
export const campGlsl = `
// ---- the camp ----

// The tent at the edge of the light, its lantern glowing in the doorway and spilling onto the ground;
// true where it covers the cell (its contact shadow and the spill fall on what lies behind).
bool campfireTent(vec2 p, float px, inout vec3 col) {
  float cx = -mix(0.44, 0.58, smoothstep(0.5, 0.89, campfireHalf));
  vec2 q = p - vec2(cx, 0.2);
  const float tentH = 0.2;
  const float tentW = 0.16;
  if (abs(q.x) > 0.3 || q.y < -0.08 || q.y > 0.25) return false;
  // Contact shadow, and the lantern's light spilling out of the door onto the ground.
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / (tentW * 1.35), (q.y + 0.005) / 0.034))));
  float lantern = 0.88 + 0.12 * sin(campfireTm * 0.9 + 1.0);
  if (q.y < 0.0) col += vec3(1.0, 0.55, 0.2) * 0.16 * lantern * bell(length(vec2(q.x / 0.26, (q.y + 0.01) / 0.07)));
  float ty = clamp(q.y / tentH, 0.0, 1.0);
  float d = max((abs(q.x) - tentW * (1.0 - ty)) * 0.78, max(-q.y, q.y - tentH));
  if (hardFill(d, px) < 0.5) return false;
  float side = smoothstep(-tentW, tentW, q.x);
  vec3 alb = mix(vec3(0.34, 0.22, 0.17), vec3(0.44, 0.31, 0.20), side);
  alb *= 0.88 + 0.12 * vnoise(vec2(q.x * 60.0, q.y * 8.0));
  alb = campfireWet(alb, 0.7);
  float lightv = campfireLight(p, 0.9);
  vec3 c = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.0 * lightv * (0.5 + 0.5 * side));
  c += vec3(1.0, 0.55, 0.2) * 0.30 * lantern * bell(length(vec2(q.x, q.y - 0.07)) / 0.17);
  c = mix(c, c + vec3(0.9, 0.5, 0.2) * 0.12, smoothstep(0.0, 0.01, 0.007 + d));
  // Snow lying on the flysheet's slopes.
  if (uWeather.y > 0.0) {
    float snow = snowCover(normalize(vec3(sign(q.x) * 0.78, 0.62, 0.0)), q * vec2(9.0, 6.0), uWeather.y);
    c = mix(c, vec3(0.92, 0.94, 0.98) * (campfireAmb * 1.1 + CAMPFIRE_WARM * 2.0 * lightv), snow);
  }
  // The doorway, with the lantern inside.
  float dd = max((abs(q.x) - tentW * 0.36 * (1.0 - clamp(q.y / (tentH * 0.86), 0.0, 1.0))) * 0.8, q.y - tentH * 0.86);
  float door = hardFill(dd, px);
  vec3 inside = vec3(0.10, 0.05, 0.03) + vec3(1.0, 0.58, 0.22) * 0.8 * lantern * bell(length(vec2(q.x, q.y - 0.07)) / 0.10);
  col = mix(c, inside, door);
  return true;
}

// The backpack leaning by the stones; true where it covers the cell.
bool campfirePack(vec2 p, float px, inout vec3 col) {
  vec2 q = p - vec2(-0.285, 0.15);
  if (abs(q.x) > 0.07 || q.y < -0.09 || q.y > 0.075) return false;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / 0.052, (q.y + 0.056) / 0.014))));
  float body = sdBox(q, vec2(0.030, 0.045), 0.013);
  float lid = sdBox(q - vec2(0.0, 0.041), vec2(0.032, 0.013), 0.009);
  float pocket = sdBox(q - vec2(0.027, -0.018), vec2(0.012, 0.020), 0.007);
  float roll = sdBox(q - vec2(0.0, -0.047), vec2(0.036, 0.010), 0.009);
  if (hardFill(min(min(body, lid), min(pocket, roll)), px) < 0.5) return false;
  vec3 alb = vec3(0.46, 0.31, 0.10);
  if (hardFill(roll, px) > 0.5) alb = vec3(0.20, 0.27, 0.25);
  if (hardFill(pocket, px) > 0.5) alb = vec3(0.38, 0.25, 0.08);
  if (hardFill(lid, px) > 0.5) alb = vec3(0.34, 0.22, 0.08);
  if (abs(q.x + 0.005) < 0.004 && q.y > -0.03 && q.y < 0.054) alb *= 0.55;
  alb = campfireWet(alb, 0.7);
  float lightv = campfireLight(p, 0.9);
  float side = 0.45 + 0.55 * smoothstep(-0.035, 0.035, q.x);
  col = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.2 * lightv * side);
  return true;
}

// ---- the camp's pass ----
// The tent, then the pack: each over the floor and the pines, behind what stands nearer.
void campFront(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float px = campfirePx;
  if (CAMPFIRE_Z_TENT < c.zs && campfireTent(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_TENT);
  if (CAMPFIRE_Z_PACK < c.zs && campfirePack(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_PACK);
}
`;

/** The campfire's GLSL: the ring, the coals, the logs, the flames, the mug, the stick, the bench, its light. */
export const campfireGlsl = `
// ---- the campfire ----

// The ring's stones on the far (front false) or near side of the fire; true where one covers the cell.
bool campfireStones(vec2 p, float px, bool front, inout vec3 col) {
  if (abs(p.x - campfireF.x) > 0.27 || abs(p.y - campfireF.y) > 0.10) return false;
  bool hit = false;
  for (int i = 0; i < 12; i++) {
    vec2 sz;
    vec2 c = campfireStone(i, sz);
    if ((c.y < campfireF.y) != front) continue;
    vec2 lp = p - c;
    if (abs(lp.x) > sz.x * 1.2 || abs(lp.y) > sz.y * 1.2) continue;
    float fi = float(i);
    lp += (vec2(vnoise(lp * 90.0 + fi * 7.0), vnoise(lp * 90.0 + fi * 3.0 + 40.0)) - 0.5) * 0.004;
    float d = sdBox(lp, sz * 0.92, min(sz.x, sz.y) * 0.8);
    if (hardFill(d, px) < 0.5) continue;
    vec2 nn = normalize(vec2(lp.x / sz.x, lp.y / sz.y) + vec2(0.0001));
    vec2 toFire = normalize(campfireF + vec2(0.0, 0.07) - c);
    float lit = clamp(0.5 + 0.5 * dot(nn, toFire), 0.0, 1.0);
    float upward = clamp(0.5 + 0.5 * nn.y, 0.0, 1.0);
    vec3 alb = mix(vec3(0.17, 0.16, 0.17), vec3(0.25, 0.22, 0.19), hash12(vec2(fi, 9.4)));
    alb *= 0.82 + 0.3 * vnoise(lp * vec2(55.0, 70.0) + fi * 5.0);
    alb = campfireWet(alb, 0.2);
    float lightv = campfireLight(c, 0.6);
    col = alb * (campfireAmb * (0.6 + 0.5 * upward) + CAMPFIRE_WARM * (4.2 * lightv * (0.12 + 1.15 * lit * lit)));
    col += vec3(1.0, 0.42, 0.10) * (0.22 * lightv * lit * lit * lit);
    hit = true;
  }
  return hit;
}

// The enamel mug by the near stones; true where it covers the cell.
bool campfireMug(vec2 p, float px, inout vec3 col) {
  vec2 q = p - vec2(0.232, 0.096);
  if (abs(q.x) > 0.03 || abs(q.y) > 0.03) return false;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2(q.x / 0.02, (q.y + 0.0125) / 0.006))));
  float body = sdBox(q, vec2(0.0108, 0.0125), 0.003);
  float handle = max(abs(length(q - vec2(0.0122, 0.0)) - 0.0068) - 0.0021, 0.008 - q.x);
  if (hardFill(min(body, handle), px) < 0.5) return false;
  float lightv = campfireLight(p, 0.8);
  vec3 c = vec3(0.60, 0.58, 0.50) * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.4 * lightv * (0.5 + 0.5 * smoothstep(-0.011, 0.011, -q.x)));
  float rim = hardFill(sdEllipse(q - vec2(0.0, 0.0122), vec2(0.0100, 0.0030)), px);
  col = mix(c, vec3(0.06, 0.03, 0.02) + CAMPFIRE_WARM * 0.05 * lightv, rim);
  return true;
}

// The bed of coals under the logs, breathing; true where it covers the cell.
bool campfireCoals(vec2 p, float px, inout vec3 col) {
  vec2 q = p - (campfireF + vec2(0.0, 0.02));
  float k = 0.75 + 0.25 * campfireS;
  // A burning-down fire's bed grows with its embers (fuel only).
  if (campfireFuelOn) k *= mix(0.8, 1.08, clamp(campfireFuelBed.y / 1.2, 0.0, 1.0));
  if (hardFill(sdEllipse(q, vec2(0.125, 0.036) * k), px) < 0.5) return false;
  vec2 cp = p * vec2(55.0, 95.0);
  float lump = 0.6 * vnoise(cp) + 0.4 * vnoise(cp * 2.1 + 3.3);
  float phase = vnoise(p * vec2(9.0, 15.0) + 1.0) * 12.0;
  float breath = 0.5 + 0.5 * sin(campfireTm * 0.65 + phase);
  float glow = smoothstep(0.42, 0.72, lump) * (0.35 + 0.65 * breath) * campfireCoalK;
  vec2 e = q / vec2(0.1, 0.03);
  float centre = exp(-dot(e, e));
  vec3 ember = mix(vec3(0.55, 0.10, 0.03), vec3(1.0, 0.45, 0.08), glow);
  vec3 ash = vec3(0.05, 0.04, 0.04) + CAMPFIRE_WARM * 0.06 * centre * min(campfireFuelBed.y, 1.0);
  col = mix(ash, ember, clamp(glow * (0.5 + 0.8 * centre), 0.0, 1.0));
  campfireGlow = max(campfireGlow, glow * 0.7);
  return true;
}

// A log from a to b (radius ra to rb): bark furrows, lit from the fire's side, glowing cracks where it
// burns near the flames. fuel (campfireFuelLog, used while the fuel is on): laid on from above, it
// slumps into the coals as it burns through, thins where the flames are hottest until it breaks there,
// and chars black and crazed, its cracks glowing, greying with ash once the flames die down. True
// where it covers the cell.
bool campfireLog(vec2 p, vec2 a, vec2 b, float ra, float rb, float seed, vec4 fuel, float px, inout vec3 col) {
  float wood = 1.0;
  if (campfireFuelOn) {
    if (fuel.x <= 0.0) return false;
    float lower = 0.016 * fuel.z - 0.07 * (1.0 - fuel.w) * (1.0 - fuel.w);
    a.y -= lower;
    b.y -= lower;
    // The radius shrinks steadily in time while the mass, burning at its surface, falls as its cube.
    wood = pow(fuel.x, 1.0 / 3.0);
  }
  float t;
  float d = sdTaperCapsule(p, a, b, ra, rb, t);
  float radius = mix(ra, rb, t);
  vec2 fireTop = campfireF + vec2(0.0, 0.045);
  if (campfireFuelOn) {
    vec2 ha = (mix(a, b, t) - fireTop) / vec2(0.11, 0.05);
    float thin = (1.0 - wood) * mix(0.35, 1.15, exp(-dot(ha, ha)));
    d += radius * thin;
    radius *= max(1.0 - thin, 0.05);
  }
  if (hardFill(d, px) < 0.5) return false;
  vec2 ba = b - a;
  float len = length(ba);
  vec2 axis = ba / len;
  vec2 nrm = vec2(-axis.y, axis.x);
  float across = clamp(dot(p - a, nrm) / radius, -1.0, 1.0);
  float along = t * len;
  float bark = vnoise(vec2(across * 3.2 + seed * 5.0, along * 38.0));
  vec3 alb = mix(vec3(0.085, 0.05, 0.03), vec3(0.15, 0.10, 0.065), bark);
  vec2 toFire = normalize(campfireF + vec2(0.0, 0.07) - p);
  float facing = clamp(0.55 + 0.6 * dot(nrm * across, toFire), 0.0, 1.0);
  vec2 hc = (p - fireTop) / vec2(0.11, 0.05);
  float heat = exp(-dot(hc, hc));
  float crack = smoothstep(0.52, 0.72, vnoise(vec2(across * 4.0 + seed * 3.0, along * 60.0 + campfireTm * 0.02)));
  if (campfireFuelOn) {
    // Char: black, crazed into blocks along the grain; the cracks between them glow farther from the
    // flames the deeper the char, and a grey skin of ash forms on the blocks as the flames die down.
    float charK = fuel.y;
    float crazed = smoothfall(0.075, 0.035, abs(vnoise(vec2(across * 2.6 + seed * 7.0, along * 32.0)) - 0.5));
    alb = mix(alb, vec3(0.024, 0.02, 0.018), smoothstep(0.1, 0.6, charK));
    float ashy = charK * charK * (1.0 - clamp(campfireFuelBed.x, 0.0, 1.0));
    alb = mix(alb, vec3(0.2, 0.19, 0.18), 0.55 * ashy * (1.0 - crazed));
    heat = exp(-dot(hc, hc) / (1.0 + 2.0 * charK));
    crack = max(crack, crazed * smoothstep(0.3, 0.8, charK));
  }
  vec3 c = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 2.8 * campfireLight(p, 0.85) * facing);
  float breath = 0.55 + 0.45 * sin(campfireTm * 0.7 + seed * 4.0 + along * 25.0);
  c = c * (1.0 - 0.5 * heat) + vec3(1.0, 0.36, 0.07) * (crack * heat * breath * 1.3 * campfireCoalK);
  col = c;
  return true;
}

// One layer of the flame as a signed distance in the fire's own units (x across, y up): five tongues,
// each a narrow column whose half width falls to a point at its own height, whose axis splays outward
// and leans on slow noise, joined at the base into one teardrop; the whole body warped by noise
// advected upward. wk and hk scale the layer's width and height. The outer layer (wk ~ 1) also sheds
// three small wisps that detach above the tips, swell, rise and shrink away.
float campfireTongues(vec2 q, float wk, float hk) {
  float tm = campfireTm;
  float lv = 0.55 + 0.9 * K_lively;
  float ht = clamp(q.y / CAMPFIRE_FLAME, 0.0, 1.4);
  float n1 = vnoise(vec2(q.x * 9.0 + 1.7, q.y * 6.0 - tm * 0.8)) - 0.5;
  float n2 = vnoise(vec2(q.x * 17.0 - 4.1, q.y * 10.0 - tm * 1.25)) - 0.5;
  q.x += (n1 * 0.05 + n2 * 0.018) * ht * lv;
  float d = 1e3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float c = (fi - 2.0) * 0.5;
    float hs = hash12(vec2(fi, 4.7));
    float grow = vnoise1(tm * 0.30 + fi * 5.3, 2.0 + fi).x;
    float height = CAMPFIRE_FLAME * hk * (0.55 + 0.45 * grow * lv) * (1.0 - 0.45 * abs(c)) * (0.85 + 0.15 * hs);
    float lean = (c * 0.05 + 0.04 * lv * sin(tm * 0.55 + fi * 2.1 + hs * 6.0) + K_wind * 0.08) * wk;
    float ax = c * 0.05 * wk;
    float hh = q.y / height;
    float xc = ax + lean * pow(clamp(hh, 0.0, 1.2), 1.5);
    float hw = 0.042 * wk * (1.0 - 0.25 * abs(c)) * pow(clamp(1.0 - hh, 0.0, 1.0), 0.8);
    float dt = max(abs(q.x - xc) - hw, max(q.y - height, -q.y - 0.03));
    d = smin(d, dt, 0.02 * wk);
  }
  if (wk > 0.95) {
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float ph = fract(tm * 0.09 + fj / 3.0 + hash12(vec2(fj, 1.1)));
      vec2 wp = vec2((hash12(vec2(fj, 2.2)) - 0.5) * 0.10 + 0.03 * sin(tm * 0.6 + fj * 2.0) + K_wind * 0.08 * ph,
                     CAMPFIRE_FLAME * hk * (0.8 + 0.28 * ph));
      float wr = 0.009 * sin(3.14159 * ph) * (1.0 - ph);
      d = min(d, length((q - wp) / vec2(1.0, 1.6)) - wr);
    }
  }
  return d;
}

// The flames: four nested layers of tongues, red-orange outside to a pale yellow heart; true where
// the outer layer covers the cell.
bool campfireFlames(vec2 p, float px, inout vec3 col) {
  float g = campfireFlameG;
  if (g < 0.03) return false;
  float s = campfireS * g;
  vec2 q = (p - (campfireF + vec2(0.0, 0.032))) / s;
  if (abs(q.x) > 0.42 || q.y < -0.06 || q.y > 0.66) return false;
  float aa = px * 5.0 / s;
  float ht = clamp(q.y / CAMPFIRE_FLAME, 0.0, 1.0);
  float c0 = hardEdge(softFill(campfireTongues(q, 1.0, 1.0), aa));
  if (c0 < 0.5) return false;
  float c1 = hardEdge(softFill(campfireTongues(q, 0.66, 0.72), aa)) * c0;
  float c2 = hardEdge(softFill(campfireTongues(q, 0.40, 0.48), aa)) * c1;
  float c3 = hardEdge(softFill(campfireTongues(q, 0.22, 0.26), aa)) * c2;
  vec3 outer = mix(vec3(0.95, 0.26, 0.05), vec3(0.62, 0.08, 0.03), smoothstep(0.35, 1.0, ht));
  vec3 mid = mix(vec3(1.0, 0.56, 0.10), vec3(0.95, 0.34, 0.06), smoothstep(0.3, 0.9, ht));
  vec3 inner = mix(vec3(1.0, 0.84, 0.32), vec3(1.0, 0.62, 0.14), smoothstep(0.2, 0.8, ht));
  col = mix(col, outer, c0 * (0.92 - 0.45 * ht));
  col = mix(col, mid, c1 * 0.96);
  col = mix(col, inner, c2 * 0.98);
  col = mix(col, vec3(1.0, 0.96, 0.74), c3);
  campfireGlow = max(campfireGlow, max(c0 * 0.5, c1));
  return true;
}

// The stick rests on the bench and reaches over the fire; the marshmallow on its end slowly toasts.
// True where either covers the cell, and how far along the stick (0 at the bench, 1 over the fire).
bool campfireStick(vec2 p, float px, inout vec3 col, out float along) {
  vec2 a = vec2(0.56, 0.112);
  vec2 b = campfireF + vec2(0.052, 0.05);
  vec2 dir = normalize(b - a);
  vec2 nrm = vec2(-dir.y, dir.x);
  float t;
  float ds = sdTaperCapsule(p, a, b + dir * 0.012, 0.0078, 0.0050, t);
  along = t;
  vec2 mc = b - dir * 0.014;
  vec2 lp = vec2(dot(p - mc, dir), dot(p - mc, nrm));
  float dm = sdBox(lp, vec2(0.027, 0.0165), 0.012);
  if (hardFill(dm, px) > 0.5) {
    float toast = (0.5 - 0.5 * cos(campfireTm * 0.04 + 1.2)) * 0.95;
    float hot = smoothstep(-0.8, 1.0, lp.y / 0.0165);
    float tl = toast * (0.5 + 0.8 * hot);
    vec3 alb = mix(vec3(0.95, 0.90, 0.78), vec3(0.82, 0.52, 0.18), smoothstep(0.1, 0.55, tl));
    alb = mix(alb, vec3(0.28, 0.14, 0.06), smoothstep(0.7, 1.0, tl));
    float lightv = campfireLight(p, 0.9);
    vec3 lit = alb * (campfireAmb * 0.8 + 0.12 + CAMPFIRE_WARM * 2.2 * lightv * (0.5 + 0.5 * hot));
    // A darker, toasted skin round the edge, so the marshmallow reads against the flames.
    float skin = 1.0 - hardFill(dm + 0.0032, px);
    col = mix(lit, lit * vec3(0.55, 0.38, 0.28), skin);
    along = 1.0;
    return true;
  }
  if (hardFill(ds, px) > 0.5) {
    float lightv = campfireLight(p, 0.9);
    col = vec3(0.30, 0.20, 0.11) * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.4 * lightv) + vec3(0.11, 0.07, 0.035);
    return true;
  }
  return false;
}

// The log bench across the near right: a squared log with its cut end toward the fire, bark furrows,
// and (with the knob) the Manifold M carved into its side, the grooves glowing like coals; snow on its
// top. True where it covers the cell.
bool campfireBench(vec2 p, float px, inout vec3 col) {
  float x0 = 0.30;
  float x1 = campfireHalf + 0.2;
  vec2 c = vec2(0.5 * (x0 + x1), 0.072);
  vec2 hs = vec2(0.5 * (x1 - x0), 0.045);
  if (p.y > 0.13 || p.x < x0 - 0.04) return false;
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.6, 1.2, length(vec2((p.x - c.x) / (hs.x * 1.04), (p.y - 0.028) / 0.022))));
  float d = sdBox(p - c, hs, 0.028);
  if (hardFill(d, px) < 0.5) return false;
  float yy = (p.y - c.y) / hs.y;
  float bark = vnoise(vec2(p.x * 7.0, p.y * 42.0));
  vec3 alb = mix(vec3(0.085, 0.05, 0.03), vec3(0.16, 0.105, 0.065), bark);
  alb *= 1.0 + 0.5 * smoothstep(0.75, 0.95, yy);
  alb = campfireWet(alb, 0.8);
  float lightv = campfireLight(p, 0.75);
  float facing = 0.35 + 0.65 * smoothstep(-0.8, 0.9, yy);
  vec3 c0 = alb * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.0 * lightv * facing);
  // The cut end, rings and all, catching the firelight.
  vec2 e = (p - vec2(x0 + 0.002, c.y)) / vec2(0.016, 0.043);
  float cap = hardFill((length(e) - 1.0) * 0.016, px);
  float ring = 0.5 + 0.5 * sin(length(e) * 16.0 + 1.3);
  vec3 wood = campfireWet(mix(vec3(0.32, 0.20, 0.11), vec3(0.45, 0.30, 0.17), ring), 0.8);
  c0 = mix(c0, wood * (campfireAmb * 0.8 + CAMPFIRE_WARM * 3.6 * lightv), cap);
  if (uWeather.y > 0.0) {
    float snow = snowCover(vec3(0.0, smoothstep(0.55, 0.95, yy), 0.0), p * vec2(9.0, 30.0), uWeather.y);
    c0 = mix(c0, vec3(0.92, 0.94, 0.98) * (campfireAmb * 1.1 + CAMPFIRE_WARM * 2.0 * lightv), snow);
  }
  if (K_campfireMark > 0.0) {
    float size = 0.066;
    float xm = 0.5 * (x0 + campfireHalf) + 0.03;
    float dm = markDistance((p - vec2(xm, 0.073)) / size) * size;
    float g = min(K_campfireMark, 1.4);
    float pulse = 0.78 + 0.22 * sin(campfireTm * 0.8 + p.x * 6.0);
    float groove = hardFill(dm - 0.0042, px);
    float halo = hardEdge(0.45 * bell(dm / 0.011) * min(g, 1.0));
    c0 += vec3(1.0, 0.4, 0.1) * 0.35 * g * halo;
    c0 = mix(c0, vec3(1.0, 0.44, 0.10) * (0.55 + 0.6 * g * pulse), groove);
    campfireGlow = max(campfireGlow, groove * min(g, 1.0));
  }
  col = c0;
  return true;
}

// ---- the campfire's pass ----
// The far half of the ring, the coals and the back log, the flames, the two front logs crossed over
// the flames' foot, the near stones, the mug, the stick and the bench, in the order the campfire
// painted them, each drawn only where nothing stands nearer; their glow the accent.
void campfireFront(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float px = campfirePx;
  vec2 f = campfireF;
  if (CAMPFIRE_Z_RING_BACK < c.zs && campfireStones(p, px, false, c.col)) campfireStand(c, CAMPFIRE_Z_RING_BACK);
  if (CAMPFIRE_Z_COALS < c.zs && campfireCoals(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_COALS);
  if (CAMPFIRE_Z_BACK_LOG < c.zs && campfireLog(p, f + vec2(-0.125, 0.036), f + vec2(0.115, 0.056), 0.0155, 0.0145, 1.0, campfireFuelLog[0], px, c.col))
    campfireStand(c, CAMPFIRE_Z_BACK_LOG);
  if (CAMPFIRE_Z_FLAMES < c.zs && campfireFlames(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_FLAMES);
  if (CAMPFIRE_Z_FRONT_LOG < c.zs && campfireLog(p, f + vec2(-0.135, -0.014), f + vec2(0.03, 0.052), 0.0175, 0.0145, 2.0, campfireFuelLog[1], px, c.col))
    campfireStand(c, CAMPFIRE_Z_FRONT_LOG);
  if (CAMPFIRE_Z_CROSS_LOG < c.zs && campfireLog(p, f + vec2(0.145, -0.010), f + vec2(-0.02, 0.05), 0.0165, 0.0140, 3.0, campfireFuelLog[2], px, c.col))
    campfireStand(c, CAMPFIRE_Z_CROSS_LOG);
  if (CAMPFIRE_Z_RING_FRONT < c.zs && campfireStones(p, px, true, c.col)) campfireStand(c, CAMPFIRE_Z_RING_FRONT);
  if (CAMPFIRE_Z_MUG < c.zs && campfireMug(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_MUG);
  // The stick stands the farther the further it reaches from the bench toward the fire.
  if (K_marshmallow > 0.5) {
    vec3 col = c.col;
    float along;
    if (campfireStick(p, px, col, along)) {
      float z = mix(CAMPFIRE_Z_BENCH + 0.05, CAMPFIRE_Z_STICK, along);
      if (z < c.zs) {
        c.col = col;
        campfireStand(c, z);
      }
    }
  }
  if (CAMPFIRE_Z_BENCH < c.zs && campfireBench(p, px, c.col)) campfireStand(c, CAMPFIRE_Z_BENCH);
  c.accent = max(c.accent, campfireGlow);
}

// The fire's light on another layer's surface at p (rig frame, m) facing n (0: lit all round), for
// the composer's localLight: the campfire's own falloff (campfireLight) laid out in metres round the
// flames' heart, at the fire's depth.
vec3 campfireLightAt(vec3 p, vec3 n) {
  float m = CAMPFIRE_Z_FIRE / RIG_FOCAL;
  vec3 d = p - vec3(0.0, 0.085 * campfireS * m, CAMPFIRE_Z_FIRE);
  float r0 = (0.28 + 0.42 * K_reach) * (0.8 + 0.2 * campfireS) * mix(0.5, 1.0, campfireLit) * m;
  float l = 1.0 / (1.0 + dot(d, d) / (r0 * r0));
  float facing = dot(n, n) > 0.0 ? clamp(0.35 + 0.65 * dot(n, -d) * inversesqrt(max(dot(d, d), 1e-6)), 0.0, 1.0) : 1.0;
  return CAMPFIRE_WARM * 3.0 * l * (0.3 + 0.7 * l) * campfireBreath * facing;
}
`;

/** The smoke's GLSL: the column over the flames. */
export const smokeGlsl = `
// ---- the smoke ----
// A thin column from the flame tips: it meanders, widens and thins as it climbs, leans with the wind,
// lit warm near the fire and by the sky higher up. Cut per cell, so its edge flips each cell once.
// Translucent, over what lies behind it and behind the logs, the stones, the stick and the bench.
void smokeFrontVeil(Ctx x, inout Cell c) {
  if (K_smoke <= 0.0 || campfireSmokeG <= 0.0) return;
  vec2 p = campfireP;
  float tm = campfireTm;
  float u = p.y - campfireF.y - 0.26 * campfireS * mix(0.3, 1.0, campfireFlameG);
  if (u < 0.0) return;
  float meander = 0.020 * sin(u * 6.5 - tm * 0.42) + 0.012 * sin(u * 13.0 - tm * 0.7 + 1.3);
  float xc = campfireF.x + meander * (0.3 + 2.0 * u) + K_wind * (0.07 * u + 0.75 * u * u);
  float w = 0.012 + 0.09 * u;
  float wob = (vnoise(vec2(u * 6.0 - tm * 0.38, 7.0)) - 0.5) * w * 1.4;
  float z = (p.x - xc - wob) / w;
  if (abs(z) > 3.0) return;
  float nz = fbm3(vec2(z * 1.1 + 3.0, u * 8.0 - tm * 0.5));
  float fade = smoothstep(0.0, 0.07, u) * exp(-u * 2.4);
  float dens = exp(-1.3 * z * z) * (0.25 + 1.1 * nz) * fade * (0.55 + 0.9 * K_smoke) * 0.6 * campfireSmokeG * campfireSmokeK;
  float cover = hardEdge(dens);
  if (cover < 0.5) return;
  float nearFire = bell(u / 0.30);
  vec3 smokeC = vec3(0.07, 0.08, 0.115) + campfireAmb * 1.4 + CAMPFIRE_WARM * (0.75 * nearFire * campfireBreath);
  cellVeil(c, vec4(smokeC, 0.62), CAMPFIRE_Z_SMOKE);
}
`;

/** The sparks' GLSL: the sparks climbing from the flames. */
export const sparksGlsl = `
// ---- the sparks ----
// Sparks: each slot flies one slow arc (rising, swaying, leaning with the wind), winks out, and is
// re-rolled for its next flight. Few cells wide, moving about a quarter of a cell a frame; in front
// of the flames and the smoke, their glow the accent.
void sparksFront(Ctx x, inout Cell c) {
  vec2 p = campfireP;
  float px = campfirePx;
  if (K_sparks <= 0.0 || campfireSparkG <= 0.0 || p.y < campfireF.y + 0.1 * campfireS || abs(p.x - campfireF.x) > 0.75) return;
  if (CAMPFIRE_Z_SPARKS >= c.zs) return;
  float tm = campfireTm;
  float s = campfireS;
  vec3 hit = vec3(0.0);
  float on = 0.0;
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    if (hash12(vec2(fi, 31.7)) > campfireSparkK) continue;
    float sg = clamp((campfireSparkG - 0.85 * hash12(vec2(fi, 55.1))) / 0.15, 0.0, 1.0);
    if (sg <= 0.0) continue;
    float life = 5.5 + 4.0 * hash12(vec2(fi, 8.3));
    float ph = tm / life + hash12(vec2(fi, 2.9));
    float cyc = floor(ph);
    float u = ph - cyc;
    float age = u * life;
    vec2 h = hash22(vec2(fi + 0.5, cyc * 1.37 + 4.0));
    vec2 start = campfireF + vec2((h.x - 0.5) * 0.12 * s, (0.17 + 0.15 * h.y) * s);
    float vy = (0.045 + 0.04 * h.y) * (0.75 + 0.35 * s);
    float vx = (h.x - 0.5) * 0.02;
    float sway = 0.016 * sin(age * (0.7 + 0.5 * h.y) + h.x * TAU) * smoothstep(0.0, 2.0, age);
    vec2 pos = start + vec2(vx * age + sway + K_wind * 0.035 * age, vy * age);
    vec2 dd = p - pos;
    if (dot(dd, dd) > 144.0 * px * px) continue;
    float b = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.45, 0.95, u));
    b *= (0.8 + 0.2 * sin(age * 1.9 + fi * 2.3)) * sg;
    float rad = px * (1.1 + 0.9 * h.y) * (0.45 + 0.55 * b);
    if (hardFill(length(dd) - rad, px * 0.7) > 0.5) {
      hit = mix(vec3(0.85, 0.18, 0.05), vec3(1.0, 0.78, 0.30), b);
      on = 1.0;
    }
  }
  c.col = mix(c.col, hit, on);
  if (on > 0.5) campfireStand(c, CAMPFIRE_Z_SPARKS);
  campfireGlow = max(campfireGlow, on * 0.8);
  c.accent = max(c.accent, campfireGlow);
}
`;
