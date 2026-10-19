// The swell's picture as the composer's layers draw it (layers.ts): a moonlit open sea on the shared
// water library (shaders/lib/water.ts, its mirror tier) under the World (its sky, weather and
// gulls).
//
// The sea is a spectrum: two long Gerstner swells from far off (the `height` knob), three shorter
// Gerstner trains of wind sea and the chop (rippleSpectrum) on them, both raised by the World's wind
// and running with it; the Gerstner crests sharpened to the trochoid's (a Newton step on the
// surface's point) and breaking white where the trains' summed steepness passes a wave's limit.
// Every train tilts the surface where the cells resolve it and only roughens it where they do not,
// so the far sea never crawls. The surface mirrors the World's sky (worldMirrorView, worldMirrorSky:
// the stars, the clouds, the aurora, shooting stars and lightning) and the moonlit air low over it,
// and lays the moon's and the sun's glitter paths on it (waterGlint): broad columns of flecks that
// blaze toward the horizon; the crests glow the scene's blue where the moon or the sun shines
// through their thin water. On the night page the ink starts over a black point by night, so the
// World's night sky stays black and only what is lit over it reads; by day it eases into a gentle
// curve and the water's light turns the scene's blue. The paper page (a still daylight clock) takes
// inkOf's dark ink. Lengths are in camera heights (SWELL_METRES metres, the eye over the still sea),
// the composer's depths in metres.
//
// The layers, and what each draws:
//   shared      (swellSharedGlsl) the sea's trains, the lamps' glow, the headland's and the boats'
//               shapes (each while its layer is on: the sea mirrors them and lays their lamps' paths),
//               and the per-cell state the layers' begins set and the others read.
//   openSea     (openSeaGlsl) its begin: the camera (the pointer's lens shift over the rig's
//               passage), the sky turned to the sea and its light, the air (the haze over the sea, the
//               rain's grey, the moonlit fog, the drops' light). Its sky: the World's, the M in the
//               moon's seas, the rain's grey over the deck and its shafts out at sea, the moonlit air
//               low over the horizon. Its shade: the ink, over a black point by night, the crests'
//               blue the accent and by day the water's, the glitter's shimmer.
//   swell       (swellGlsl) the sea where the ray meets it (with `relief`, a bounded march over waves
//               of real height): the sky, the headland and the boats mirrored in it, the moon's and
//               the sun's glitter, the crests' glow, the whitecaps, and the lighthouse's and the
//               lanterns' paths trembling down the water.
//   lighthouse  (lighthouseGlsl) the headland and its tower over the far sea; its beams sweeping the
//               air and its lamp's flash, over the fog (its glow pass).
//   boats       (boatsGlsl) the boats riding at anchor on the sea's trains; their lanterns' glow
//               once it is dark, over the fog (its glow pass).
import { glslFloat } from "../../shaders/glsl.ts";
import { SWELL_BOATS, SWELL_CAPE, SWELL_FACING, SWELL_METRES } from "./constants.ts";

/** One column of the boats' table (constants.ts) as a GLSL initialiser of `type`. */
const boatTable = (type: string, row: (boat: (typeof SWELL_BOATS)[number]) => string): string =>
  `${type}[${SWELL_BOATS.length}](${SWELL_BOATS.map(row).join(", ")})`;

/**
 * What every swell layer holds: the units, the sea's trains (the swell layer lays them, the boats ride
 * them), the lamps' glow, the headland and the boats (each while its layer is on), and the state the
 * layers' begins set.
 */
export const swellSharedGlsl = `
// ---- the open sea (swell/shader.ts): what its layers share ----
// Metres in a camera height, and the World's units in the swell's: camera heights per metre.
const float SWELL_METRES = ${glslFloat(SWELL_METRES)};
const float SWELL_UNIT = 1.0 / ${glslFloat(SWELL_METRES)};
// The World's view turns by -SWELL_FACING from the rig's frame into the sky's (RIG_TURN).
const float SWELL_FACING = ${glslFloat(SWELL_FACING)};

// Gravity in camera heights a second squared, for the waves' true deep-water dispersion.
const float SWELL_G = 0.654;
// The Gerstner trains: wavelength (camera heights), amplitude (per unit of its gain: the swell's for
// the first SWELL_SWELLS, the wind's for the rest) and phase. The swells come in toward the camera
// from off to either side (SWELL_ALONG); the wind sea runs with the wind, its trains turned
// SWELL_SPREAD (radians) off the wind's heading.
const int SWELL_TRAINS = 5;
const int SWELL_SWELLS = 2;
const vec3 SWELL_WAVE[SWELL_TRAINS] = vec3[SWELL_TRAINS](vec3(4.9, 0.114, 0.0), vec3(3.0, 0.057, 1.3), vec3(1.8, 0.03, 2.9), vec3(1.14, 0.02, 4.4), vec3(0.7, 0.0125, 0.7));
// The moonlit air low over the sea: its light per unit of the moon's (x), which the far water
// mirrors as its slant grazes; the sky shows y of it over the horizon, fading over z radians up, and
// the fog takes on w of it.
const vec4 SWELL_AIR = vec4(0.45, 0.6, 0.03, 0.8);

// The sea's trains for this setting: each one's heading and amplitude, and the Gerstner steepness
// that keeps their crests from folding.
struct SwellSea {
  vec2 along[SWELL_TRAINS];
  float amp[SWELL_TRAINS];
  float q;
  float reach; // the trains' amplitudes summed: the highest a crest stands
};

// The Gerstner trains at x (camera heights: across, ahead) at tm. x is where the surface lies, not
// where its water came from (X(x0) = x0 + sum q a d cos(phase)), so that is found first: a
// fixed-point step back, then one Newton step on X, whose Jacobian is I - sum q k a sin(phase) d d^T.
// The fixed-point step alone leaves the crests half as sharp as the trochoid's; with the Newton step
// the curvature at a crest is within 1% of it. seen: how much of each train counts (the cells' share
// of it, 1 for the relief's shape). Returns the height (x), the slope dh/dx, dh/dz (yz) and the
// trains' summed steepness k a sin(phase) (w: how near the crest here is to breaking).
vec4 swellLong(vec2 x, float tm, SwellSea s, float seen[SWELL_TRAINS]) {
  vec2 x0 = x;
  for (int i = 0; i < SWELL_TRAINS; i++) {
    float k = TAU / SWELL_WAVE[i].x;
    x0 -= s.q * s.amp[i] * s.along[i] * cos(k * dot(s.along[i], x) - sqrt(SWELL_G * k) * tm + SWELL_WAVE[i].z);
  }
  vec2 miss = x0 - x;
  mat2 jacobian = mat2(1.0);
  for (int i = 0; i < SWELL_TRAINS; i++) {
    float k = TAU / SWELL_WAVE[i].x;
    float ph = k * dot(s.along[i], x0) - sqrt(SWELL_G * k) * tm + SWELL_WAVE[i].z;
    miss += s.q * s.amp[i] * s.along[i] * cos(ph);
    jacobian -= s.q * k * s.amp[i] * sin(ph) * outerProduct(s.along[i], s.along[i]);
  }
  x0 -= inverse(jacobian) * miss;
  float h = 0.0;
  vec2 rise = vec2(0.0);
  float squeeze = 1.0;
  float steep = 0.0;
  for (int i = 0; i < SWELL_TRAINS; i++) {
    float k = TAU / SWELL_WAVE[i].x;
    float ph = k * dot(s.along[i], x0) - sqrt(SWELL_G * k) * tm + SWELL_WAVE[i].z;
    float a = s.amp[i] * seen[i];
    h += a * sin(ph);
    rise += s.along[i] * (k * a * cos(ph));
    steep += k * a * sin(ph);
  }
  squeeze -= s.q * steep;
  return vec4(h, rise / squeeze, steep);
}

// ---- lamps on the water, and in the air ----
// A lamp's glitter (waterGlint), its exposure per unit of its brightness over its squared distance
// (camera heights) to the water. The share of a lamp's or a beam's light rain or snow scatters out of
// the straight path per camera height, at full storm. A lamp's glow in the air: its core's radius and
// its glare's width, in cells, and its aura's widening in cells per unit of optical depth; how many
// times the brightest a cell shows its core is; how many widths out the glare and the aura reach
// (exactly 0 from there); and how deep a lamp's own hull or tower stands, which does not hide it.
const float SWELL_LAMP_GLINT = 0.6;
const float SWELL_THICK = 0.012;
const vec3 SWELL_LAMP_GLOW = vec3(1.2, 2.5, 2.0);
const float SWELL_LAMP_POWER = 48.0;
const float SWELL_LAMP_SPAN = 5.0;
const float SWELL_LAMP_DEEP = 0.25;

// A lamp of brightness b, ahead camera heights out through air of optical depth tau
// (swellLampDepth), seen at p (screen heights, the view's frame) from its projection at lamp, over
// what the cell shows zHit ahead. What comes straight through (exp(-tau)): its core, cut per cell,
// SWELL_LAMP_POWER times the brightest a cell shows, exposed so it dims only in thick air; and its
// glare. All the rest of the light of both the air scatters into an aura that widens with the
// depth, its light spread over it, so in thick air the point fades into a broad soft glow that
// holds the light it lost. Anything nearer hides the core; of the glare and the aura, scattered all
// along the way, it hides the share beyond it. Glare and aura reach exactly 0 SWELL_LAMP_SPAN widths
// out.
float swellLampGlow(vec2 p, vec2 lamp, float ahead, float tau, float zHit, float b) {
  float d = length(p - lamp) * uRes.y;
  float through = exp(-tau);
  float wide = SWELL_LAMP_GLOW.y + SWELL_LAMP_GLOW.z * tau;
  float tail = exp(-SWELL_LAMP_SPAN);
  float core = hardEdge(softFill(d - SWELL_LAMP_GLOW.x, 0.6)) * (1.0 - exp(-through * SWELL_LAMP_POWER));
  float glare = through * b * max(exp(-d / SWELL_LAMP_GLOW.y) - tail, 0.0);
  // The light the core and the glare hold, in the glare's peak over its width squared.
  float held = b + 0.5 * SWELL_LAMP_POWER * SWELL_LAMP_GLOW.x * SWELL_LAMP_GLOW.x / (SWELL_LAMP_GLOW.y * SWELL_LAMP_GLOW.y);
  float aura = (1.0 - through) * held * SWELL_LAMP_GLOW.y * SWELL_LAMP_GLOW.y / (wide * wide) * max(exp(-d / wide) - tail, 0.0);
  return core * step(ahead - SWELL_LAMP_DEEP, zHit) + (glare + aura) * min(zHit / ahead, 1.0);
}

// How far out a lamp's glow reaches through air of optical depth tau (screen heights): its aura's
// SWELL_LAMP_SPAN widths, the glare's at least.
float swellLampReach(float tau) {
  return SWELL_LAMP_SPAN * (SWELL_LAMP_GLOW.y + SWELL_LAMP_GLOW.z * tau) / uRes.y;
}

// What each cell's begins set (openSeaBegin, swellBegin) and the layers read: the camera (its height
// over the still sea, the eye, the ray in the rig's frame, the cell in screen heights from the
// horizon's middle); the sky in the rig's frame, the moon's light dimmed under the deck as the sun's
// is, the light on a level surface and the sun's share of it; how dark it is getting (lamps are lit
// then); the air over the sea (the haze toward this bearing, the rain's grey lit up by the lightning,
// how thick the rain or snow is for the lamps and the beams, per camera height); the sea's trains
// now. And what the sea drew here, for the shade: its depth (m; -1 none), the crests' blue, the
// moon's glitter and how much of the sea shows white (the glitter, the lamps' paths, the foam).
float swellCamH = 1.0;
vec3 swellEye = vec3(0.0, 1.0, 0.0);
vec3 swellRd = vec3(0.0, 0.0, 1.0);
vec2 swellP = vec2(0.0);
Sky swellSky;
vec3 swellLight = vec3(0.0);
vec3 swellSunLight = vec3(0.0);
float swellDusk = 0.0;
vec3 swellHaze = vec3(0.0);
vec3 swellAir = vec3(0.0);
float swellThick = 0.0;
SwellSea swellNow;
float swellZ = -1.0;
vec3 swellGlow = vec3(0.0);
float swellPath = 0.0;
float swellWhite = 0.0;

// The depth of what a cell shows (m, the composer's) in camera heights; open sky (c.z exactly
// WORLD_FAR: the sea far out lies beyond it in metres) as far as it gets.
float swellDepth(float z) {
  return z == WORLD_FAR ? WORLD_FAR : z / SWELL_METRES;
}

// The optical depth of the air between the eye and a lamp at (across, up, ahead): the World's fog's,
// as deep as worldFogAt veils a point there (thin up over its layer), and the rain's or snow's over
// the distance. The World's fog is never deeper than SWELL_FOG_DEEPEST per unit of fog (fogAmount's
// exponent), whatever the distance: a bound the lamps cull their glow by before working it out.
const float SWELL_FOG_DEEPEST = 5.0;
float swellLampDepth(World w, vec3 at) {
  float far = length(at - swellEye);
  return -log(1.0 - worldFogAt(w, far * SWELL_METRES, at.y * SWELL_METRES)) + swellThick * far;
}

#if LAYER_LIGHTHOUSE
// ---- the headland and its lighthouse (the lighthouse layer) ----
// The headland stands in the plane SWELL_CAPE_AHEAD camera heights ahead, its cliff meeting the sea
// at across SWELL_CAPE_TOE and running on to the right; the lighthouse's lamp at SWELL_CAPE_LAMP
// (across, height), on a white tower SWELL_CAPE_TOWER wide (foot, top) from the cliff top up.
const float SWELL_CAPE_AHEAD = ${glslFloat(SWELL_CAPE.ahead)};
const float SWELL_CAPE_TOE = ${glslFloat(SWELL_CAPE.toe)};
const vec2 SWELL_CAPE_LAMP = vec2(${glslFloat(SWELL_CAPE.lamp[0])}, ${glslFloat(SWELL_CAPE.lamp[1])});
const vec2 SWELL_CAPE_TOWER = vec2(0.34, 0.24);
// The land's colour, and the haze that greys it at that distance.
const vec3 SWELL_CAPE_LAND = vec3(0.2, 0.22, 0.14);
const float SWELL_CAPE_HAZE = 0.25;
// The beams: seconds a turn (two beams, so a flash every half turn), the first one's heading at the
// start of the motion clock (radians from ahead toward the right: out over the sea to the left and
// toward the eye, so a still frame shows it sweeping across the night), their spread (radians from
// the axis to the cone's 1/e), their warm light, and the lamp's light at a flash.
const float SWELL_BEAM_TURN = 16.0;
const float SWELL_BEAM_START = -2.2;
const float SWELL_BEAM_SPREAD = 0.05;
const vec3 SWELL_BEAM = vec3(1.0, 0.9, 0.72);
const float SWELL_BEAM_FLASH = 200.0;

// The lamp now (lighthouseBegin): where it is, its first beam's heading, how lit it is (from dusk),
// how brightly it shows toward the eye, and where it shows (screen heights from the horizon's middle).
vec3 swellLamp = vec3(0.0);
vec3 swellBeamDir = vec3(0.0, 0.0, 1.0);
float swellLampLit = 0.0;
float swellLampFlash = 0.0;
vec2 swellLampSeen = vec2(0.0);

// The headland's top (camera heights over the sea) at across x in its plane, -1 off its end: a
// sheer cliff at the toe, a sea stack off it, then the land rolling up and on.
float swellCapeTop(float x) {
  float u = x - SWELL_CAPE_TOE;
  float stack = 0.55 * smoothstep(-1.1, -0.95, u) * smoothfall(-0.55, -0.7, u);
  if (u < 0.0) return stack > 0.0 ? stack : -1.0;
  float land = 1.6 * smoothstep(1.0, 12.0, u) + 0.6 * (vnoise(vec2(u * 0.3, 3.1)) - 0.5) * smoothstep(1.0, 4.0, u);
  return 2.2 * smoothstep(0.0, 0.45, u) + land;
}

// The lighthouse's tower at (x, y) in the headland's plane: its signed distance (camera heights),
// the lantern room's glass and gallery included.
float swellTower(vec2 at) {
  float base = 2.15;
  float y = (at.y - base) / (SWELL_CAPE_LAMP.y - base);
  float side = 0.5 * mix(SWELL_CAPE_TOWER.x, SWELL_CAPE_TOWER.y, clamp(y, 0.0, 1.0));
  float wall = max(abs(at.x - SWELL_CAPE_LAMP.x) - side, max(base - at.y, at.y - SWELL_CAPE_LAMP.y - 0.14));
  float gallery = max(abs(at.x - SWELL_CAPE_LAMP.x) - 0.2, abs(at.y - SWELL_CAPE_LAMP.y + 0.16) - 0.035);
  return min(wall, gallery);
}

// The headland seen along a ray from 'from' (camera heights: across, up from the sea, ahead) along
// dir, foot: one cell's size there (camera heights): rgb and coverage, 0 or 1 per cell. Its land is
// lit by the sky and the sun and greys with distance, the grass along its top catching the moon so
// its outline reads by night; the tower stands white with a red band, moonlit by night, its lantern
// room lit (lit 0..1).
vec4 swellCape(vec3 from, vec3 dir, float foot, Sky sky, vec3 haze, float lit) {
  if (dir.z <= 1e-3 || from.z >= SWELL_CAPE_AHEAD) return vec4(0.0);
  vec3 at = from + dir * ((SWELL_CAPE_AHEAD - from.z) / dir.z);
  if (at.x < SWELL_CAPE_TOE - 1.2 || at.y > SWELL_CAPE_LAMP.y + 0.3 || at.y < -0.05) return vec4(0.0);
  float top = swellCapeTop(at.x);
  float tower = swellTower(at.xy);
  float land = at.y - top;
  if (hardFill(min(land, tower), foot) < 0.5) return vec4(0.0);
  vec3 light = sky.ambient + sky.sunColor * (0.3 + 0.5 * max(-sky.sun.z, 0.0)) * smoothstep(-0.02, 0.06, sky.sun.y) + sky.moonColor * 0.3;
  float crown = smoothstep(-0.25, -0.02, land);
  vec3 col = SWELL_CAPE_LAND * ((0.7 + 0.3 * crown) * light + 7.0 * crown * max(sky.moon.y, 0.0) * sky.moonColor);
  if (tower < land) {
    float band = step(abs(at.y - 2.75), 0.12);
    col = mix(vec3(0.82, 0.82, 0.8), vec3(0.62, 0.12, 0.1), band) * (light + sky.moonColor * 0.5);
    float glass = step(abs(at.y - SWELL_CAPE_LAMP.y), 0.1) * step(abs(at.x - SWELL_CAPE_LAMP.x), 0.09);
    col = mix(col, SWELL_BEAM * 1.4, glass * lit);
  }
  return vec4(mix(col, haze, SWELL_CAPE_HAZE), 1.0);
}

// How brightly the lamp shows toward the eye: each beam's flash as it sweeps past, over a steady
// glow. b: the first beam's heading.
float swellFlash(vec3 eye, vec3 b) {
  vec3 toEye = normalize(eye - vec3(SWELL_CAPE_LAMP.x, SWELL_CAPE_LAMP.y, SWELL_CAPE_AHEAD));
  float c = dot(b, toEye);
  return 0.4 + exp(-2.0 * (1.0 - abs(c)) / (SWELL_BEAM_SPREAD * SWELL_BEAM_SPREAD));
}
#endif

#if LAYER_BOATS
// ---- the boats (the boats layer: K_boats, K_boatsLanterns) ----
// The boats' table (constants.ts): where each rides (across, ahead), its length and kind (0 a sloop,
// 1 a fishing boat), and its own phase for the rocking; the first K_boats ride.
const int SWELL_BOAT_COUNT = ${SWELL_BOATS.length};
const vec4 SWELL_BOAT[SWELL_BOAT_COUNT] = ${boatTable("vec4", ([across, ahead, length, kind]) => `vec4(${[across, ahead, length, kind].map(glslFloat).join(", ")})`)};
const float SWELL_BOAT_PHASE[SWELL_BOAT_COUNT] = ${boatTable("float", (boat) => glslFloat(boat[4]))};
// How much of the surface's tilt a hull follows, and its own rocking on top (radians, rad/s).
const float SWELL_BOAT_FOLLOW = 0.85;
const vec2 SWELL_BOAT_ROCK = vec2(0.035, 1.4);
// The lanterns: their warm light, their brightness on the water (SWELL_LAMP_GLINT's), and where each
// kind hangs one (lengths: toward the bow, up).
const vec3 SWELL_LANTERN = vec3(1.0, 0.72, 0.38);
const float SWELL_LANTERN_POWER = 1.5;
const vec2 SWELL_LANTERN_AT[2] = vec2[2](vec2(-0.38, 0.42), vec2(0.26, 0.74));

// How many boats ride, and whether their lanterns are lit once it is dark (boatsBegin).
float swellBoats = 0.0;
float swellLanterns = 0.0;

// A boat as it rides now: the middle of its waterline (across, up from the still sea, ahead), its
// tilt in the picture (radians, counter-clockwise), which way its bow points in the picture (+1 the
// right), its length and kind.
struct SwellHull {
  vec3 at;
  float tilt;
  float bow;
  float size;
  float kind;
};

// Boat i on the sea now: heaved and tilted by the waves under it, sampled from the same trains as the
// surface drawn round it, each as far as the hull follows a wave its length (a wave much shorter than
// the hull only rocks it a little), and rocking a little on its own. Bows to the wind.
SwellHull swellHull(int i, float tm, SwellSea sea, float wind) {
  vec4 b = SWELL_BOAT[i];
  float ride[SWELL_TRAINS];
  for (int j = 0; j < SWELL_TRAINS; j++) ride[j] = smoothstep(0.6, 2.5, SWELL_WAVE[j].x / b.z);
  vec4 w = swellLong(b.xy, tm, sea, ride);
  SwellHull hull;
  hull.at = vec3(b.x, w.x, b.y);
  hull.tilt = SWELL_BOAT_FOLLOW * atan(w.y) + SWELL_BOAT_ROCK.x * sin(tm * SWELL_BOAT_ROCK.y + TAU * SWELL_BOAT_PHASE[i]);
  hull.bow = wind >= 0.0 ? -1.0 : 1.0;
  hull.size = b.z;
  hull.kind = b.w;
  return hull;
}

// A point (across, up, in the plane of the boat) in the boat's own lengths: toward its bow from the
// middle, up from its waterline.
vec2 swellHullLocal(SwellHull hull, vec2 at) {
  vec2 q = rotate(at - hull.at.xy, -hull.tilt) / hull.size;
  return vec2(q.x * hull.bow, q.y);
}

// The boat's outline at q (its own lengths): x the signed distance (lengths, near enough), y the part
// (0 hull, 1 house, 2 rig) for its colour; rig: the mast's and boom's half width, never under most
// of a cell. A sloop: low white hull with a raked stem, a cabin aft of the mast, the sail furled on
// the boom. A fishing boat: high blue hull, a wheelhouse forward, a short mast with a crossbar.
vec2 swellBoatShape(vec2 q, float kind, float rig) {
  bool fisher = kind > 0.5;
  float sheer = fisher ? 0.15 + 0.07 * smoothstep(0.0, 0.5, q.x) : 0.11 + 0.05 * smoothstep(0.1, 0.5, q.x);
  float stem = 0.5 + (fisher ? 0.22 : 0.32) * q.y;
  float stern = -0.5 + (fisher ? 0.0 : 0.08) * q.y;
  float hull = max(max(-q.y, q.y - sheer), max(q.x - stem, stern - q.x));
  vec2 box = fisher ? abs(q - vec2(0.05, 0.27)) - vec2(0.12, 0.11) : abs(q - vec2(-0.06, 0.16)) - vec2(0.16, 0.05);
  float house = length(max(box, 0.0)) + min(max(box.x, box.y), 0.0) - 0.01;
  float spars = fisher
    ? min(segmentDistance(q, vec2(0.26, 0.2), vec2(0.26, 0.8)), segmentDistance(q, vec2(0.16, 0.66), vec2(0.36, 0.66))) - rig
    : min(segmentDistance(q, vec2(0.08, 0.1), vec2(0.08, 1.18)) - rig, segmentDistance(q, vec2(0.06, 0.25), vec2(-0.42, 0.22)) - max(rig, 0.022));
  float d = min(hull, min(house, spars));
  return vec2(d, d == hull ? 0.0 : d == house ? 1.0 : 2.0);
}

// The boat's colour at q for its part (swellBoatShape), lit (the sky's light and the sun's and the
// moon's on the side toward the eye), its fishing boat's windows warm while its lantern is lit.
vec3 swellBoatColour(vec2 q, vec2 shape, float kind, vec3 light, float lantern) {
  bool fisher = kind > 0.5;
  vec3 albedo;
  if (shape.y < 0.5) {
    albedo = fisher ? mix(vec3(0.1, 0.18, 0.32), vec3(0.55, 0.12, 0.08), step(q.y, 0.035)) : mix(vec3(0.82, 0.82, 0.8), vec3(0.1, 0.15, 0.25), step(q.y, 0.03));
  } else if (shape.y < 1.5) {
    albedo = fisher ? vec3(0.85, 0.86, 0.86) : vec3(0.8, 0.78, 0.72);
  } else {
    albedo = fisher ? vec3(0.6, 0.6, 0.58) : vec3(0.7, 0.68, 0.62);
  }
  vec3 col = albedo * light;
  if (fisher && shape.y > 0.5 && shape.y < 1.5) {
    float window = step(abs(q.y - 0.31), 0.035) * step(abs(fract((q.x + 0.05) * 14.0) - 0.5), 0.3);
    col = mix(col, SWELL_LANTERN * 0.8, window * lantern);
  }
  return col;
}

// The light on a boat toward the eye from a light toward dir (the rig's frame) of colour c: on its
// side facing the eye, full from behind the eye and none from ahead (then the boat stands dark
// against it), and on its decks and coachroof from above; none once the light is down.
vec3 swellSideLight(vec3 dir, vec3 c) {
  return c * (0.6 * clamp(0.15 - 0.85 * dir.z, 0.0, 1.0) + 0.4 * max(dir.y, 0.0)) * smoothstep(-0.02, 0.05, dir.y);
}

// A boat's lantern: where it hangs now (across, up from the still sea, ahead).
vec3 swellLanternAt(SwellHull hull) {
  vec2 at = SWELL_LANTERN_AT[hull.kind > 0.5 ? 1 : 0] * vec2(hull.bow, 1.0) * hull.size;
  return vec3(hull.at.xy + rotate(at, hull.tilt), hull.at.z);
}
#endif
`;

/** The open sea's GLSL: the camera and the air, the sky over the sea, the picture's ink. */
export const openSeaGlsl = `
// ---- the open sea (swell/shader.ts) ----
// The night palettes' ink: none up to luminance x, so the World's night sky stays black and only
// what is lit over it reads (the moon, the stars, the moonlit air and sea); above, 1 - exp(-y l),
// l the luminance over x, so a bright sky still dithers. By day it gives way to inkOf's at gamma z, a
// gentle curve (shore's grade's), which leaves the sky's bright range room to show (openSeaShade).
const vec3 OPEN_SEA_INK = vec3(0.115, 3.5, 0.8);

// The Manifold M in the moon's seas (K_mmoon): col darkened where dir (the sky's frame) crosses the
// mark on the moon's disc, unless cloud hides it.
vec3 openSeaMaria(Sky sky, vec3 dir, vec3 col, float cloud) {
  vec3 mv = dir - sky.moon;
  if (length(mv) >= SKY_MOON_RADIUS) return col;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), sky.moon));
  vec3 up = cross(sky.moon, right);
  vec2 q = vec2(dot(mv, right), dot(mv, up)) / SKY_MOON_RADIUS;
  float maria = smoothfall(0.11, 0.07, markDistance(q / 1.3));
  return mix(col, col * 0.4, maria * skyMoonCover(sky, dir) * (1.0 - cloud));
}

// The camera, the sky's light and the air (see the header). The rig's passage has moved the eye and
// tilted the lens already (constants.ts); the pointer shifts the lens a little more, the World's sky,
// birds and rain with it. The World's view is handed over in metres.
void openSeaBegin(inout Ctx x) {
  vec2 uv = x.uv + vec2(uPointer.x * 0.012 / x.aspect, uPointer.y * 0.006) * uMotion;
  swellCamH = 1.0 - 0.65 * swellArrive() - 0.6 * swellLeave();
  x.uv = uv;
  x.eye = swellCamH * SWELL_METRES;
  x.v = worldView(uv, RIG_HORIZON, RIG_FOCAL, x.eye, RIG_TURN, 1.0);
  x.zg = uv.y < RIG_HORIZON ? x.eye * RIG_FOCAL / (RIG_HORIZON - uv.y) : WORLD_FAR;
  swellRd = x.v.ray;
  swellEye = vec3(0.0, swellCamH, 0.0);
  swellP = (uv - vec2(0.5, RIG_HORIZON)) * vec2(x.aspect, 1.0);
  // The sky in the rig's frame lights the sea; the moon's light dims under the deck as the sun's does.
  Sky sky = skyFacing(x.w.sky, SWELL_FACING);
  sky.moonColor *= 1.0 - 0.85 * x.w.overcast;
  swellSky = sky;
  swellSunLight = sky.sunColor * max(sky.sun.y, 0.0);
  swellLight = sky.ambient + swellSunLight + sky.moonColor * 0.5;
  swellDusk = 1.0 - smoothstep(0.05, 0.4, sky.day);
  // The air over the sea: the sky just over the horizon in this bearing, greyed as the day is; the
  // rain's grey, lit up by the lightning, and the light its drops catch; the fog's mist, moonlit; how
  // thick the rain or snow is for the lamps and the beams.
  vec3 haze = worldGrey(x.w, horizonHaze(x.w.sky, x.v.dir, 0.02), 1.0);
  swellHaze = haze;
  swellAir = mix(haze, vec3(dot(haze, LUMA)), 0.5) * 1.1 + WORLD_FLASH_SKY * x.w.flash;
  vec3 dropLight = max(swellAir * 1.4 + swellLight * 0.25, vec3(0.08));
  swellThick = SWELL_THICK * x.w.storm;
  x.air = Air(haze, haze + sky.moonColor * SWELL_AIR.x * SWELL_AIR.w, dropLight, haze, 0.0, 0.0, 0.0);
}

// The rain veil's colour (the open sea's precip air): the rain's grey, lit up by the lightning.
vec3 openSeaRainAir(Ctx x) {
  return swellAir;
}

// The sky over the sea: the World's (the dome, the aurora behind the clouds, the deck, the Milky Way
// and the stars in its gaps, shooting stars high over the sea); the M in the moon's seas; under rain
// or snow the deck dulled toward the rain's grey, its moonlit linings with it (a narrow strip of sky
// shows it at a grazing slant, its edges drawn out into bright bands), rain hanging in shafts out at
// sea; the lightning over it; the moonlit air glowing low over the horizon.
void openSeaSky(Ctx x, inout Cell c) {
  vec3 rd = swellRd;
  if (rd.y <= 0.0) return;
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  vec3 col = heaven.col;
  if (K_mmoon > 0.0) col = openSeaMaria(x.w.sky, x.v.dir, col, heaven.cloud);
#if WORLD_RAIN || WORLD_SNOW
  if (x.w.storm > 0.0) col = mix(col, swellAir, 0.6 * x.w.overcast * heaven.cloud);
#endif
#if WORLD_RAIN
  if (x.w.rain > 0.0) col = mix(col, swellAir * 0.9, 0.85 * rainShafts(rd.xy / (rd.z * 0.12), x.tm, x.w.rain, x.w.wind));
#endif
  col += heaven.strike + swellSky.moonColor * SWELL_AIR.x * SWELL_AIR.y * exp(-rd.y / SWELL_AIR.z);
  c.col = col;
}

// The palettes: the crests' blue is the accent (where the sea is what the cell shows, as much as the
// World's air leaves of it: c.accent, 1 where the sea was drawn), everything else ink: on the paper
// page inkOf's dark ink; on the night page light ink, by night over OPEN_SEA_INK's black point, so
// the World's night sky stays black. As the day comes up (the sky's day) that gives way to a gentle
// curve, so the day's sky keeps its gradient, its cloud and the sun, and the water's own light turns
// the scene's blue as the crests' is, what of it shows white (swellWhite: the glitter, the lamps'
// paths, the foam) left so: blue water under a light sky. The moon's glitter shimmers.
void openSeaShade(Ctx x, Cell c, inout Shade o) {
  float clear = c.z == swellZ ? c.accent : 0.0;
  vec3 glow = swellGlow * clear;
  float path = c.z == swellZ ? swellPath : 0.0;
  vec3 rgb = clamp(c.col, 0.0, 1.0);
  float accent = clamp(dot(glow, LUMA) * 3.5, 0.0, 1.0) * (1.0 - min(path * 2.0, 1.0));
  vec3 inked = max(rgb - glow, 0.0);
  float ink = inkOf(inked, 1.0, OPEN_SEA_INK.z);
  if (!pagePaper()) {
    float day = swellSky.day;
    ink = mix(1.0 - exp(-OPEN_SEA_INK.y * max(dot(inked, LUMA) - OPEN_SEA_INK.x, 0.0)), ink, day);
    float blue = day * clear * (1.0 - swellWhite);
    accent = max(accent, blue * ink);
    ink *= 1.0 - blue;
  }
  o = shadeOf(rgb, ink, accent);
  o.shimmer = min(path, 1.0) * 0.3 * clear;
}
`;

/** The sea's GLSL: its trains now, and the water where the ray meets it. */
export const swellGlsl = `
// ---- the swell (swell/shader.ts) ----
// The pace that gives rippleTrain (which reckons in metres) the waves' dispersion: sqrt(SWELL_G / 9.81).
const float SWELL_PACE = 0.258;
const vec2 SWELL_ALONG[SWELL_SWELLS] = vec2[SWELL_SWELLS](normalize(vec2(-0.8, -0.6)), normalize(vec2(0.55, -0.83)));
const vec3 SWELL_SPREAD = vec3(-0.3, 0.35, -0.05);
// How far each train's water is drawn in under its crests (Gerstner's steepness Q), and the most the
// trains together may squeeze the surface, so a crest sharpens but never folds over.
const float SWELL_SHARP = 1.6;
const float SWELL_FOLD = 0.7;
// The wind's heading: toward the camera in a calm, swung toward the side the wind blows to by up to
// SWELL_VEER radians (full by a wind of 1 / SWELL_VEER_GAIN).
const float SWELL_VEER = 0.75;
const float SWELL_VEER_GAIN = 3.0;
// The wind sea's and the chop's gain: this much in a calm, and this much more per unit of wind. The
// default breeze (0.2) gives 1.
const vec2 SWELL_BREEZE = vec2(0.5, 2.5);
// Crests break white as the trains' summed steepness (k a sin) climbs through these: a wave breaks
// near k a 0.44 (Stokes), and the trains seldom stack that high in the default breeze.
const vec2 SWELL_BREAK = vec2(0.46, 0.62);
// The slope variance of ripples finer than the chop: a floor, and more per unit of wind; rain dimples
// the surface by this much more at full strength.
const vec3 SWELL_ROUGH = vec3(0.03, 0.1, 0.012);
// The water's own colour per unit of light, and the scene's blue (its accent): the crests where the
// moon or the sun shines through their thin water, their light per unit of it (the troughs between
// keep SWELL_CREST_FLOOR of a crest's), fading out this far (camera heights) as the trains merge
// into the far sea.
const vec3 SWELL_DEEP = vec3(0.012, 0.045, 0.07);
const vec3 SWELL_CREST = vec3(0.3, 0.43, 0.96);
const float SWELL_THROUGH = 1.3;
const float SWELL_CREST_FLOOR = 0.13;
const float SWELL_CREST_FAR = 40.0;
// The Gerstner trains are drawn once a wavelength spans SWELL_LOD.y cells along their run (fading in
// from x), sooner than rippleTrain's 7 to 14: they are long and slow, and read as rows of swell out
// to the middle distance without crawling over the dither.
const vec2 SWELL_LOD = vec2(4.0, 8.0);
// The glitter of the moon and the sun (waterGlint): each one's exposure per unit of its strength
// (the brightest channel of its light). The moon's path spreads across the view as over a sea whose
// crossing trains tilt its facets sideways: across, the facets' slope variance is the sea's plus
// SWELL_GLITTER, along the view the sea's own, so a low moon lays a broad column from the
// foreground to the horizon while a high one's pool reaches no nearer than the sea alone would lay
// it. Its narrow core, the sea's own variance both ways, blazes along the horizon (SWELL_MOON_CORE:
// its exposure). The paths are made of flecks (swellFlecks): a cell is exposed SWELL_FLICKER.x
// times over, and SWELL_FLICKER.y times more while a fleck there catches the light.
const float SWELL_MOON_GLINT = 0.9;
const float SWELL_MOON_CORE = 0.15;
const float SWELL_SUN_GLINT = 0.012;
const float SWELL_GLITTER = 0.2;
const vec2 SWELL_FLICKER = vec2(0.1, 16.0);
// The flecks: single facets catching the light for a moment, on a grid fixed to the water whose
// cells are SWELL_FLECK dither cells (wide, as perspective lays a facet down), this share of them
// lit at a time.
const vec2 SWELL_FLECK = vec2(3.0, 1.0);
const float SWELL_FLECK_SHARE = 0.4;

// The flecks at gp (the water point's (x / z, eye / z) scaled to cells, as waterFacets takes it),
// each row of the grid shifted along by its own share so the rows' flecks never line up; each fleck
// lit at random for one of its turns of 0.5 to 1.2 s, swelling and fading over it. tm: the motion
// clock. Returns 0..1.
float swellFlecks(vec2 gp, float tm) {
  vec2 g = gp / SWELL_FLECK;
  g.x += 3.0 * hash12(vec2(floor(g.y), 4.1));
  vec2 id = floor(g);
  float h = hash12(id + 0.53);
  float age = tm / (0.5 + 0.7 * h) + fract(h * 7.31);
  float turn = floor(age);
  float lit = step(hash12(id + turn * vec2(0.73, 1.37) + 2.3), SWELL_FLECK_SHARE);
  float swell = sin(0.5 * TAU * (age - turn));
  return lit * swell * swell;
}

// The sea for the swell's height (0..2) and the wind's gain (SWELL_BREEZE), its sea running heading
// radians from ahead toward the right.
SwellSea swellSea(float height, float gain, float heading) {
  SwellSea s;
  for (int i = 0; i < SWELL_SWELLS; i++) {
    s.along[i] = SWELL_ALONG[i];
    s.amp[i] = SWELL_WAVE[i].y * height;
  }
  for (int i = SWELL_SWELLS; i < SWELL_TRAINS; i++) {
    float a = heading + SWELL_SPREAD[i - SWELL_SWELLS];
    s.along[i] = vec2(sin(a), cos(a));
    s.amp[i] = SWELL_WAVE[i].y * gain;
  }
  float ka = 0.0;
  s.reach = 0.0;
  for (int i = 0; i < SWELL_TRAINS; i++) {
    ka += TAU / SWELL_WAVE[i].x * s.amp[i];
    s.reach += s.amp[i];
  }
  s.q = min(SWELL_SHARP, SWELL_FOLD / max(ka, 1e-4));
  return s;
}

// The chop on the wind sea: four trains rocking about the wind's heading, from 4 m down to under a
// metre, their slopes times the wind's gain (rippleSpectrum), at their true pace.
RippleFan swellChop(float heading) {
  return RippleFan(4, vec2(0.25, 0.6), vec2(0.12, 0.02), vec2(SWELL_PACE, 0.0), vec2(heading, 0.0), vec3(0.6, 2.4, 0.0), 1.7, vec2(8.0, 16.0));
}

// A single long swell rolling in toward the camera as the scene arrives: a crest with a trough behind
// it, riding a gaussian envelope that widens with distance so it reads as one wave at any depth.
// front: where the crest is (camera heights ahead); amp: its height, 0 once the entrance is over.
// Returns its height and its slope along z.
vec2 swellRoll(float z, float front, float amp) {
  if (amp <= 0.0) return vec2(0.0);
  float s = 1.14 + 0.15 * max(front, 0.0);
  float d = (z - front) / s;
  float bell = exp(-d * d * 0.5);
  return amp * bell * vec2(sin(d * 1.7), (1.7 * cos(d * 1.7) - d * sin(d * 1.7)) / s);
}

#if SWELL_RELIEF
// ---- the relief (K_relief) ----
// The relief fades out between these distances (camera heights), where the waves shrink toward a
// cell: beyond, the sea is the flat one, so the far field and the horizon never alias.
const float SWELL_RELIEF_NEAR = 8.0;
const float SWELL_RELIEF_FAR = 30.0;

// How far the point s along the eye's ray rd lies above the sea when the waves stand 'lift' times
// their height above and below still water: negative under it. The shape is the Gerstner trains and
// the entrance's roll; the chop only shades.
float swellGap(float s, float camH, vec3 rd, float lift, float t, SwellSea sea, float front, float amp) {
  vec2 x = rd.xz * s;
  float fade = smoothfall(SWELL_RELIEF_FAR, SWELL_RELIEF_NEAR, s);
  float whole[SWELL_TRAINS] = float[SWELL_TRAINS](1.0, 1.0, 1.0, 1.0, 1.0);
  return camH + rd.y * s - lift * fade * (swellLong(x, t, sea, whole).x + swellRoll(x.y, front, amp).x);
}

// The waves' real height for relief 0..1: at 1 they are lifted until their steepest slope is 0.9,
// never above 0.8 of the camera, camH over still water. Returns the lift (times their height, for
// swellGap), the largest lifted height and the largest lifted slope: the trains' amplitudes summed,
// and their slopes summed and steepened by the most the Gerstner squeeze can (1 + Q sum k a).
vec3 swellRelief(float relief, float camH, SwellSea sea, float amp) {
  float ka = 0.0;
  for (int i = 0; i < SWELL_TRAINS; i++) ka += TAU / SWELL_WAVE[i].x * sea.amp[i];
  float reach = sea.reach + amp;
  float steepest = ka * (1.0 + sea.q * ka) + 1.6 * amp;
  float lift = relief * min(0.9 / max(steepest, 1e-3), 0.8 * camH / max(reach, 1e-3));
  return vec3(lift, lift * reach, lift * steepest);
}

// Where the eye's ray first meets that sea: steps through the slab the waves can fill, as long as the
// gap and the slope allow and never shorter than a share of the distance (at most 28), then three
// secant steps. A ray still above the waves after its last step is skimming the crests and stops
// there. Returns the distance along rd.
float swellMarch(float camH, vec3 rd, vec3 relief, float t, SwellSea sea, float front, float amp) {
  float lift = relief.x;
  float bound = relief.y;
  float slope = relief.z;
  float level = camH / -rd.y;
  float ta = max((camH - bound) / -rd.y, 0.0);
  if (ta >= SWELL_RELIEF_FAR) return level;
  float tEnd = min((camH + bound) / -rd.y, max(level, SWELL_RELIEF_FAR));
  float ga = swellGap(ta, camH, rd, lift, t, sea, front, amp);
  float tb = ta;
  float gb = ga;
  for (int i = 0; i < 28; i++) {
    if (gb <= 0.0 || tb >= tEnd) break;
    ta = tb;
    ga = gb;
    float steep = slope * smoothfall(SWELL_RELIEF_FAR, SWELL_RELIEF_NEAR, tb) + 0.1 * bound;
    tb = min(tb + max(gb / (-rd.y + steep), 0.01 + 0.015 * tb), tEnd);
    gb = swellGap(tb, camH, rd, lift, t, sea, front, amp);
  }
  if (gb > 0.0) return tb;
  for (int k = 0; k < 3; k++) {
    float ts = ta + (tb - ta) * ga / max(ga - gb, 1e-5);
    float gs = swellGap(ts, camH, rd, lift, t, sea, front, amp);
    if (gs > 0.0) {
      ta = ts;
      ga = gs;
    } else {
      tb = ts;
      gb = gs;
    }
  }
  return ta + (tb - ta) * ga / max(ga - gb, 1e-5);
}
#endif

// The wind's gain on the wind sea and its heading, and the entrance's swell: one long crest rolls in
// from the far sea (front, camera heights ahead) and spends itself before it reaches the camera;
// rollAmp is exactly 0 once the scene has arrived.
float swellGain = 1.0;
float swellHeading = 0.0;
float swellFront = 0.0;
float swellRollAmp = 0.0;

// The sea's trains now (swellNow, which the boats ride): the wind raises the wind sea and its chop and
// turns them its way; the swell is the knob's.
void swellBegin(inout Ctx x) {
  swellGain = SWELL_BREEZE.x + SWELL_BREEZE.y * abs(x.w.wind);
  swellHeading = 0.5 * TAU - SWELL_VEER * clamp(SWELL_VEER_GAIN * x.w.wind, -1.0, 1.0);
  swellNow = swellSea(K_height * 2.0, swellGain, swellHeading);
  float arrived = passageIn();
  swellFront = mix(15.5, -1.8, arrived);
  swellRollAmp = 0.18 * smoothstep(0.0, 0.1, arrived) * (1.0 - smoothstep(0.7, 1.0, arrived));
}

// The sea where the ray meets it (see the header), behind whatever stands nearer (the headland).
void swellGround(Ctx x, inout Cell c) {
  vec3 rd = swellRd;
  if (rd.y > 0.0) return;
  float tm = x.tm;
  float camH = swellCamH;
  vec3 eye = swellEye;
  vec2 p = swellP;
  Sky sky = swellSky;
  SwellSea sea = swellNow;
  float rollAmp = swellRollAmp;
  // With relief the waves have real height and crests hide the troughs behind them; 0 is the flat
  // sea with the waves painted on it.
  float dist = camH / max(-rd.y, 1e-4);
#if SWELL_RELIEF
  if (K_relief > 0.0) dist = swellMarch(camH, rd, swellRelief(K_relief, camH, sea, rollAmp), tm, sea, swellFront, rollAmp);
#endif
  vec3 hit = eye + rd * dist; // the sea under this cell (across, up from the still sea, ahead)
  float z = hit.z * SWELL_METRES;
  if (c.z < WORLD_FAR && z >= c.z) return;
  vec2 x2 = hit.xz;
  // What one cell covers there (the flat sea's footprint), and how much of each train it resolves
  // (rippleTrain's 7 to 14 cells a wavelength): a train it does not is only roughness.
  Ground g = groundHit(rd, camH, RIG_FOCAL);
  float seen[SWELL_TRAINS];
  float fine = 0.0;
  for (int i = 0; i < SWELL_TRAINS; i++) {
    float wavelength = SWELL_WAVE[i].x;
    seen[i] = smoothstep(SWELL_LOD.x, SWELL_LOD.y, wavelength / max(length(sea.along[i] * g.foot), 1e-6));
    float ka = TAU / wavelength * sea.amp[i];
    fine += 0.5 * ka * ka * (1.0 - seen[i]);
  }
  vec4 wave = swellLong(x2, tm, sea, seen);
  vec2 roll = swellRoll(x2.y, swellFront, rollAmp);
  vec3 rip = rippleSpectrum(x2, tm, g.foot, swellGain, swellChop(swellHeading));
  // The slope variance the cells do not draw: ripples finer than the chop, more as the wind blows
  // harder and where rain dimples the surface; the chop's and the trains' too fine to draw.
  float rough = SWELL_ROUGH.x + SWELL_ROUGH.y * abs(x.w.wind) + SWELL_ROUGH.z * x.w.rain + rip.z + fine;
  WaterMirror water = waterMirror(rd, wave.yz + vec2(0.0, roll.y) + rip.xy, 0.8 * sqrt(rough));
  vec3 refl = water.ray;
  refl.y = max(refl.y, 0.01);
  refl = normalize(refl);
  // The World's sky in the water, as rough as the sea spreads it, the lightning's image in it.
  WorldView mirror = worldMirrorView(x.v, refl, 2.0 * sqrt(rough));
  WorldSky image = worldMirrorSky(x.w, mirror, WORLD_METEOR_FIELD);
  vec3 reflected = image.col + image.strike;
  // What stands on the sea in the mirror: the headland, and the boats, whose dark hulls take the
  // moon's glitter where they hide it. A facet tilted so far that its mirrored ray dips into the
  // sea mirrors the next wave, never a boat.
  float hidden = 0.0;
#if LAYER_LIGHTHOUSE
  if (abs(p.x / RIG_FOCAL - SWELL_CAPE_TOE / SWELL_CAPE_AHEAD - 0.25) < 0.35) {
    vec4 cape = swellCape(vec3(hit.x, 0.0, hit.z), refl, 0.02, sky, swellHaze, swellLampLit);
    reflected = mix(reflected, cape.rgb * 0.8, cape.a);
  }
#endif
#if LAYER_BOATS
  for (int i = 0; i < SWELL_BOAT_COUNT; i++) {
    if (float(i) >= swellBoats || water.ray.y <= 0.0) break;
    vec4 b = SWELL_BOAT[i];
    if (hit.z >= b.y) continue;
    vec2 seenAt = vec2(b.x, -camH) / b.y * RIG_FOCAL;
    float scale = RIG_FOCAL / b.y * b.z;
    if (abs(p.x - seenAt.x) > 0.75 * scale + 0.02 || p.y > seenAt.y + 0.2 * scale || p.y < seenAt.y - 2.5 * scale - 0.03) continue;
    SwellHull hull = swellHull(i, tm, sea, x.w.wind);
    vec3 to = vec3(hit.x, 0.0, hit.z) + water.ray * ((hull.at.z - hit.z) / max(water.ray.z, 1e-3));
    vec2 shape = swellBoatShape(swellHullLocal(hull, to.xy), hull.kind, 0.02);
    float covered = hardFill(shape.x * hull.size, 0.01 + 0.02 * sqrt(rough) * (hull.at.z - hit.z));
    if (covered > 0.5) {
      reflected = swellBoatColour(swellHullLocal(hull, to.xy), shape, hull.kind, sky.ambient + swellSideLight(sky.sun, sky.sunColor) + swellSideLight(sky.moon, sky.moonColor), 0.0) * 0.85;
      hidden = 1.0;
    }
  }
#endif
  // The moon's path (waterGlint): spread wide across, a column of flecks from the foreground to
  // the horizon (swellFlecks, on the swells' and the wind sea's rows near by) over the narrow
  // core that blazes along the horizon, where the trains fade into the roughness and the water
  // mirrors more. Cloud across the moon, seen along the mirrored ray, and a hull in the way hide
  // it. The sun's path likewise, by day, without the spread. Each fills in to its light's own hue
  // at full strength.
  vec3 toEye = -rd;
  float moonShine = max(sky.moonColor.r, max(sky.moonColor.g, sky.moonColor.b));
  vec3 moonHue = sky.moonColor / max(moonShine, 1e-4);
  float sunShine = max(sky.sunColor.r, max(sky.sunColor.g, sky.sunColor.b));
  vec3 sunHue = sky.sunColor / max(sunShine, 1e-4);
  float flicker = SWELL_FLICKER.x + SWELL_FLICKER.y * swellFlecks(vec2(hit.x, camH) / hit.z * RIG_FOCAL * uRes.y, tm);
  float open = (1.0 - image.cloud) * (1.0 - hidden);
  // The spread across: every vector's x shrunk by wide makes the facets' variance across
  // wide^2 times the variance along, at the cost of exposing the lobe wide times over.
  float wide = sqrt((rough + SWELL_GLITTER) / rough);
  vec3 across = vec3(1.0 / wide, 1.0, 1.0);
  float path = waterGlint(normalize(water.normal * across), normalize(toEye * across), normalize(sky.moon * across), rough, SWELL_MOON_GLINT * moonShine * flicker / wide) * open;
  path += waterGlint(water.normal, toEye, sky.moon, rough, SWELL_MOON_CORE * moonShine) * open;
  float sunPath = waterGlint(water.normal, toEye, sky.sun, rough, SWELL_SUN_GLINT * sunShine * flicker) * open;
  // Deep water lit a little from above; the crests glowing blue where the moon or the sun, ahead,
  // shines through their thin water, fading as the trains merge into the far sea; the moonlit air
  // mirrored where the far water grazes.
  float crest = smoothstep(0.0, 1.0, (wave.x + roll.x) / max(0.7 * sea.reach + rollAmp, 1e-3));
  float through = dot(sky.moonColor, LUMA) * (0.4 + 0.6 * max(sky.moon.z, 0.0)) + dot(swellSunLight, LUMA) * (0.3 + 0.4 * max(sky.sun.z, 0.0)) + 0.3 * dot(sky.ambient, LUMA);
  vec3 glow = SWELL_CREST * SWELL_THROUGH * through * (SWELL_CREST_FLOOR + crest) * exp(-dist / SWELL_CREST_FAR) * (1.0 - hidden);
  vec3 body = SWELL_DEEP * swellLight;
  vec3 moonlitAir = sky.moonColor * SWELL_AIR.x * fresnelSchlick(-rd.y, 0.02, 0.0) * (1.0 - hidden);
  vec3 col = mix(body + glow, reflected, water.fresnel) + moonlitAir + moonHue * path + sunHue * sunPath;
  glow *= 1.0 - water.fresnel;
  // How much of it shows white rather than as the water's own light (the shade's day blue): the
  // moon's, the sun's and the lamps' glitter, and the whitecaps.
  float white = min(2.0 * (path + sunPath), 1.0);
  // Whitecaps where the trains stack steep enough to break (and the entrance's roll at its height),
  // ragged along the crest; lit by the sky, the sun and the moon.
  float breaking = smoothstep(SWELL_BREAK.x, SWELL_BREAK.y, wave.w + 6.0 * roll.x);
  float foam = breaking * smoothstep(0.25, 0.65, vnoise(x2 * vec2(2.2, 5.0) + vec2(0.0, 0.3 * tm)));
  if (hardEdge(foam * 0.9) > 0.5) {
    col = sky.ambient * 2.0 + swellSunLight + sky.moonColor * 1.2;
    glow = vec3(0.0);
    white = 1.0;
  }
#if LAYER_LIGHTHOUSE
  // The lighthouse's lamp trembling down the water toward the eye, brighter as a beam sweeps by:
  // worked out within the reach of the sea's slopes below the lamp, fading out at its edges.
  float lampReach = 0.05 + 1.2 * sqrt(rough) * max(swellLampSeen.y - p.y, 0.0);
  float lampWindow = smoothfall(lampReach, 0.6 * lampReach, abs(p.x - swellLampSeen.x));
  if (swellLampLit > 0.0 && lampWindow > 0.0) {
    vec3 toLamp = swellLamp - vec3(hit.x, 0.0, hit.z);
    float lampPath = waterGlint(water.normal, toEye, normalize(toLamp), rough, SWELL_LAMP_GLINT * swellLampFlash * SWELL_BEAM_FLASH * flicker / dot(toLamp, toLamp));
    col += SWELL_BEAM * lampWindow * lampPath;
    white = max(white, min(2.0 * lampWindow * lampPath, 1.0));
  }
#endif
#if BOATS_LANTERNS
  // Each lantern's warm path down the water toward the eye, likewise.
  if (swellLanterns > 0.0 && swellDusk > 0.0) {
    for (int i = 0; i < SWELL_BOAT_COUNT; i++) {
      if (float(i) >= swellBoats) break;
      vec4 b = SWELL_BOAT[i];
      vec2 seenAt = vec2(b.x, -camH) / b.y * RIG_FOCAL;
      float reach = 0.05 + 1.2 * sqrt(rough) * max(seenAt.y - p.y + 0.1, 0.0);
      float window = smoothfall(reach, 0.6 * reach, abs(p.x - seenAt.x));
      if (hit.z >= b.y || window <= 0.0) continue;
      vec3 toLantern = swellLanternAt(swellHull(i, tm, sea, x.w.wind)) - vec3(hit.x, 0.0, hit.z);
      float lanternPath = waterGlint(water.normal, toEye, normalize(toLantern), rough, SWELL_LAMP_GLINT * swellDusk * SWELL_LANTERN_POWER * flicker / dot(toLantern, toLantern));
      col += SWELL_LANTERN * window * lanternPath;
      white = max(white, min(2.0 * window * lanternPath, 1.0));
    }
  }
#endif
  c.col = col;
  c.z = z;
  c.accent = 1.0;
  swellZ = z;
  swellGlow = glow;
  swellPath = path;
  swellWhite = white;
}
`;

/** The lighthouse's GLSL: the lamp now, the headland over the far sea, the beams in the air. */
export const lighthouseGlsl = `
// ---- the lighthouse (swell/shader.ts) ----
// The beams: the lens they leave (camera heights), how much the air scatters of them (clear, and per
// unit of fog, rain and snow), how far they carry (the share they lose per camera height per unit of
// fog, and the rain's or snow's, swellThick), and the glow's exposure.
const float LIGHTHOUSE_LENS = 0.06;
const vec4 LIGHTHOUSE_AIR = vec4(0.12, 0.5, 0.4, 0.4);
const float LIGHTHOUSE_CARRY = 0.04;
const float LIGHTHOUSE_EXPOSURE = 0.5;

// The two beams' heading now, how lit the lamp is (once it is getting dark), how brightly it shows
// toward the eye, and where it shows.
void lighthouseBegin(inout Ctx x) {
  swellLamp = vec3(SWELL_CAPE_LAMP, SWELL_CAPE_AHEAD);
  float sweep = SWELL_BEAM_START + TAU * fract(x.tm / SWELL_BEAM_TURN);
  swellBeamDir = vec3(sin(sweep), 0.0, cos(sweep));
  swellLampLit = swellDusk;
  swellLampFlash = swellFlash(swellEye, swellBeamDir) * swellLampLit;
  swellLampSeen = (swellLamp.xy - swellEye.xy) / (swellLamp.z) * RIG_FOCAL;
}

// The headland on the horizon to the right, its lighthouse on the cliff, over the sky and the far
// sea (the swell stays in front of it where it is nearer).
void lighthouseFar(Ctx x, inout Cell c) {
  vec4 cape = swellCape(swellEye, swellRd, SWELL_CAPE_AHEAD / (swellRd.z * RIG_FOCAL * uRes.y), swellSky, swellHaze, swellLampLit);
  if (cape.a > 0.5) cellPut(c, vec4(cape.rgb, 1.0), SWELL_CAPE_AHEAD * SWELL_METRES);
}

// The error function (Winitzki's, within 2e-4), odd and smooth.
float lighthouseErf(float x) {
  float x2 = x * x;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}

// The light a beam from the lamp along b scatters toward the eye along rd, from the eye out to the
// ray's reach (distance along it), where the ray runs in front of the lens: the cone's light (its
// gaussian profile r wide, r growing along it, so thinning as 1 / r^2) gathered along the ray in
// closed form, so smooth at every heading, toward the eye too. From a point t1 on that stretch, where
// the cone is r1 wide, y = (t - t1) / r(t) turns dt / r^2 into dy / r1 and the ray's offset from the
// axis over r into m + y n, so the light is a gaussian's integral over y: an erf at each end (over
// sqrt(pi), so a ray across the beam gathers exp(-gap^2) / (r sin) of the angle between them). Spent
// by the thick air it has crossed at carry a camera height, reckoned where the light it gathers lies
// on the mean (the truncated gaussian's), and the air's forward scattering (Henyey-Greenstein, g
// 0.5, 1 at right angles).
float lighthouseBeam(vec3 eye, vec3 rd, vec3 lamp, vec3 b, float reach, float carry) {
  vec3 w0 = eye - lamp;
  float c = dot(rd, b);
  float u0 = dot(w0, b);
  float ta = 0.0;
  float tb = reach;
  if (c > 0.0) ta = -u0 / c;
  else if (c < 0.0) tb = min(tb, -u0 / c);
  else if (u0 < 0.0) return 0.0;
  ta = max(ta, 0.0);
  if (tb <= ta) return 0.0;
  // t1: where the ray passes nearest the axis, kept to the stretch.
  float t1 = clamp((c * u0 - dot(rd, w0)) / max(1.0 - c * c, 1e-4), ta, tb);
  float grow = SWELL_BEAM_SPREAD * c;
  float r1 = LIGHTHOUSE_LENS + SWELL_BEAM_SPREAD * (u0 + c * t1);
  vec3 m = cross(w0 + t1 * rd, b) / r1;
  vec3 n = cross(rd, b) - grow * m;
  float nn = max(dot(n, n), 1e-6);
  float nl = sqrt(nn);
  float mn = dot(m, n);
  float ys = -mn / nn;
  float ya = (ta - t1) / (LIGHTHOUSE_LENS + SWELL_BEAM_SPREAD * (u0 + c * ta)) - ys;
  float yb = (tb - t1) / (LIGHTHOUSE_LENS + SWELL_BEAM_SPREAD * (u0 + c * tb)) - ys;
  float along = max(0.5 * (lighthouseErf(nl * yb) - lighthouseErf(nl * ya)) / nl, 1e-6);
  float mean = ys + clamp((exp(-nn * ya * ya) - exp(-nn * yb * yb)) / (3.5449077 * nn * along), ya, yb);
  float u = (r1 / (1.0 - grow * mean) - LIGHTHOUSE_LENS) / SWELL_BEAM_SPREAD;
  float miss = max(dot(m, m) - mn * mn / nn, 0.0);
  float phase = pow(1.25 / (1.25 + c), 1.5);
  return exp(-miss - u * carry) * along * phase / r1;
}

// The beams' light in the air, as far as the cell sees, more the thicker the air; the lamp's glow
// through the air over all, as far as it reaches. After the World's fog, which does not veil it.
void lighthouseGlow(Ctx x, inout Cell c) {
  if (swellLampLit <= 0.0) return;
  float zHit = swellDepth(c.z);
  float scatter = LIGHTHOUSE_AIR.x + LIGHTHOUSE_AIR.y * x.w.fog + LIGHTHOUSE_AIR.z * x.w.rain + LIGHTHOUSE_AIR.w * x.w.snow;
  float carry = LIGHTHOUSE_CARRY * x.w.fog + swellThick;
  float reach = zHit / max(swellRd.z, 1e-3);
  float shaft = lighthouseBeam(swellEye, swellRd, swellLamp, swellBeamDir, reach, carry) + lighthouseBeam(swellEye, swellRd, swellLamp, -swellBeamDir, reach, carry);
  c.col += SWELL_BEAM * swellLampLit * (1.0 - exp(-LIGHTHOUSE_EXPOSURE * scatter * shaft));
  float off = length(swellP - swellLampSeen);
  if (off >= swellLampReach(SWELL_FOG_DEEPEST * x.w.fog + swellThick * length(swellLamp - swellEye))) return;
  float tau = swellLampDepth(x.w, swellLamp);
  if (off < swellLampReach(tau)) c.col += SWELL_BEAM * swellLampFlash * swellLampGlow(swellP, swellLampSeen, swellLamp.z, tau, zHit, 1.0);
}
`;

/** The boats' GLSL: how many ride, the hulls on the sea, their lanterns' glow. */
export const boatsGlsl = `
// ---- the boats (swell/shader.ts) ----

// How many ride (K_boats), and whether their lanterns are lit (K_boatsLanterns), for the sea too.
void boatsBegin(inout Ctx x) {
  swellBoats = K_boats;
#if BOATS_LANTERNS
  swellLanterns = K_boatsLanterns;
#endif
}

// The boats riding at anchor, in front of the sea behind them and of the sky their masts rise into,
// each worked out only where the cell may see it; the fishing boats' windows lit with the lanterns.
void boatsMiddle(Ctx x, inout Cell c) {
  vec2 p = swellP;
  vec3 eye = swellEye;
  Sky sky = swellSky;
  float zHit = swellDepth(c.z);
  for (int i = 0; i < SWELL_BOAT_COUNT; i++) {
    if (float(i) >= swellBoats) break;
    vec4 b = SWELL_BOAT[i];
    if (b.y >= zHit) continue;
    vec2 seenAt = vec2(b.x, -eye.y) / b.y * RIG_FOCAL;
    float scale = RIG_FOCAL / b.y * b.z;
    if (abs(p.x - seenAt.x) > 0.75 * scale + 0.02 || p.y < seenAt.y - 0.3 * scale - 0.02 || p.y > seenAt.y + 1.4 * scale + 0.03) continue;
    SwellHull hull = swellHull(i, x.tm, swellNow, x.w.wind);
    vec2 at = eye.xy + vec2(p.x, p.y) / RIG_FOCAL * hull.at.z;
    float foot = hull.at.z / (RIG_FOCAL * uRes.y);
    vec2 q = swellHullLocal(hull, at);
    vec2 shape = swellBoatShape(q, hull.kind, 0.6 * foot / hull.size);
    float lit = 0.0;
#if BOATS_LANTERNS
    lit = swellLanterns * swellDusk;
#endif
    if (hardFill(shape.x * hull.size, foot) > 0.5) {
      cellPut(c, vec4(swellBoatColour(q, shape, hull.kind, sky.ambient + swellSideLight(sky.sun, sky.sunColor) + swellSideLight(sky.moon, sky.moonColor), lit), 1.0), hull.at.z * SWELL_METRES);
      zHit = hull.at.z;
    }
  }
}

// The lanterns' glow once it is dark, over the fog (and the beams' light), over what the cell shows
// in the end: each worked out only as far as it reaches round where it would hang on the still sea,
// give or take the most the boat heaves and rocks, and there where it hangs now.
void boatsGlow(Ctx x, inout Cell c) {
#if BOATS_LANTERNS
  float lit = swellLanterns * swellDusk;
  if (lit <= 0.0) return;
  vec2 p = swellP;
  vec3 eye = swellEye;
  float zHit = swellDepth(c.z);
  float bow = x.w.wind >= 0.0 ? -1.0 : 1.0;
  for (int i = 0; i < SWELL_BOAT_COUNT; i++) {
    if (float(i) >= swellBoats) break;
    vec4 b = SWELL_BOAT[i];
    vec3 still = vec3(vec2(b.x, 0.0) + SWELL_LANTERN_AT[b.w > 0.5 ? 1 : 0] * vec2(bow, 1.0) * b.z, b.y);
    float off = length(p - (still.xy - eye.xy) / b.y * RIG_FOCAL) - (swellNow.reach + 0.5 * b.z) / b.y * RIG_FOCAL;
    if (off > swellLampReach(SWELL_FOG_DEEPEST * x.w.fog + swellThick * length(still - eye))) continue;
    float tau = swellLampDepth(x.w, still);
    if (off > swellLampReach(tau)) continue;
    vec3 hang = swellLanternAt(swellHull(i, x.tm, swellNow, x.w.wind));
    c.col += SWELL_LANTERN * lit * swellLampGlow(p, (hang.xy - eye.xy) / hang.z * RIG_FOCAL, hang.z, tau, zHit, 0.6);
  }
#endif
}
`;
