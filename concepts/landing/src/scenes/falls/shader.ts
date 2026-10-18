// The Waterfall preset's GLSL (ADR 0062 Phase 2a): a cliff across the frame, a fall pouring from a
// notch in its lip into a plunge pool, seen level from the pool's edge through FALLS_RIG. Its parts,
// each a layer (layers.ts), drawn in the order the scene always painted them:
//   cliff     (backdrop) the rock of the gorge (basalt flows, sandstone ledges or a limestone slot
//             whose walls close in), the trees on the rim and the woods upstream through the notch,
//             the fallen blocks at the cliff's foot, the carved M; over the rim the World's sky seen
//             half turned from the sun (fallsWorld), its aurora lifted over the rim, its deck closing
//             with the rain and hanging shafts of rain over the skyline; the gorge's air.
//   pool      (ground) the plunge pool mirroring the cliff and the fall, ringed by the plunge and by
//             the rain; the fireflies over it from dusk on; the near bank's boulders.
//   falls     (dressing) the falling sheet and the plunge's white water; after dark their soft glow in
//             the air and in the pool, which lights the rain around them.
//   spray     (dressing) the plume and fans of spray from the plunge, the spray off the sheet, and the
//             rainbow in it.
//   greenery  (cover) moss on the ledges, the wet rock, the blocks and the bank; ferns and creepers
//             hanging from the ledges; the near bank's ferns (sim.ts, the composer's records atlas).
// The World's rain and fog fall at the composed depth (the bank's stones 3.5 m off, its ferns 2.2 m,
// the cliff 29 m), its birds fly in front of whatever the gorge draws farther than them. The gorge
// keeps its own light model (fallsBegin): the World's sky seen half turned, with the eye adapting to
// the dark.
//
// Frame: q = ((uv.x - 0.5) * aspect, uv.y): x in screen heights from the centre, y the screen
// height, uv through the passage's lens shift (rigShift). The cliff stands at the back of the pool;
// the camera stands level at the pool's edge, its eye at FALLS_EYE, looking straight at the rock.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  FALLS_CAM,
  FALLS_CLUMPS,
  FALLS_EYE,
  FALLS_FERN_M,
  FALLS_FERN_Z,
  FALLS_FOV,
  FALLS_FRONDS,
} from "./constants.ts";

/**
 * The gorge's shared GLSL (every falls layer holds it, after the plants component): its constants,
 * its light, the rock, the water and the spray's shapes, and the per-cell state the layers' begins
 * set and their passes read and leave for each other.
 */
export const fallsSharedGlsl = `
// ---- the gorge (falls/shader.ts), shared by its layers ----
// The aurora's arc stands higher than the world hangs it (each ray's slope looked up this much
// lower: WorldView.auroraLift), so its bright lower edge shows just over the rim rather than behind
// the cliff.
const float FALLS_AURORA_LIFT = 0.3;

const float FALLS_LIP = 0.79;   // where the water pours over: the floor of the notch in the lip
const float FALLS_POOL = 0.27;  // the waterline at the foot of the cliff
const float FALLS_EYE = ${glslFloat(FALLS_EYE)};   // eye level: the camera's horizon line (RIG_HORIZON)
const float FALLS_FOV = ${glslFloat(FALLS_FOV)};    // vertical field of view, radians
const float FALLS_FOCAL = ${glslFloat(0.5 / Math.tan(0.45))};
const float FALLS_G = 0.34;     // gravity in screen heights / s^2: a big fall seen from afar is unhurried
const float FALLS_DEG = 57.29578;
const float FALLS_BEDS = 9.0;   // couplets of beds (a hard lava flow and the soft bed on it) per screen height
const vec3 FALLS_MIST = vec3(0.86, 0.96, 1.0);
const vec3 FALLS_CYAN = vec3(0.5, 0.86, 0.92);
// Distances (m) for the World's rain, fog and birds: the eye stands ~2 m over the pool (gravity at
// the cliff, FALLS_G, makes a screen height there ~29 m), the cliff ~29 m off, the near bank's
// stones and ferns 2-4 m.
const float FALLS_CAM = ${glslFloat(FALLS_CAM)};      // metres per pool-plane unit (the eye's height over the water, RIG_EYE)
const float FALLS_CLIFF_Z = 29.0; // metres to the cliff...
const float FALLS_CLIFF_M = 28.0; // ...and per screen height there
const float FALLS_BANK_Z = 3.5;   // metres to the near bank's stones...
const float FALLS_BANK_M = 3.4;   // ...and per screen height there
const float FALLS_FERN_Z = ${glslFloat(FALLS_FERN_Z)};   // metres to the bank's ferns...
const float FALLS_FERN_M = ${glslFloat(FALLS_FERN_M)};   // ...and per screen height there
const float FALLS_RAIN_Z = 30.0;  // rainFall's layers sit for depth = 1 - exp(-z / FALLS_RAIN_Z)
// The gorge's own haze per metre, for what the World's birds and a guest layer haze (Air.dust).
const float FALLS_HAZE = 0.004;
// Whether the water pours (the falls layer on): without it the rock beside the notch stays dry, the
// blocks lie across the plunge and the pool lies still.
#if LAYER_FALLS
const float FALLS_POUR = 1.0;
#else
const float FALLS_POUR = 0.0;
#endif

struct FallsLight {
  vec3 sun;     // toward the sun, camera frame
  vec3 moon;    // toward the moon, camera frame
  vec3 sunCol;  // direct sunlight (0 once set), dimmed by overcast
  vec3 moonCol; // direct moonlight
  vec3 amb;     // light from the whole sky
};

// ---- the gorge's state at this cell ----
// Set by fallsBegin, before any layer's: the clocks and the passage, the frame point (fallsQ) and its
// parallax-shifted copies (the cliff, fall, pool and spray; the woods upstream through the notch; the
// near bank), the camera's ray and the sky's, the light, the air, the rain and the wind, where the
// river comes over the lip.
float fallsTm = 0.0;
float fallsAspect = 1.78;
float fallsArrive = 1.0;
float fallsLeave = 0.0;
vec2 fallsUv = vec2(0.0);
vec2 fallsQ = vec2(0.0);
vec2 fallsQc = vec2(0.0);
vec2 fallsQt = vec2(0.0);
vec2 fallsQb = vec2(0.0);
vec3 fallsRayCam = vec3(0.0, 0.0, 1.0);
vec3 fallsRay = vec3(0.0, 0.0, -1.0);
FallsLight fallsL;
float fallsDark = 0.0;
vec3 fallsSkyLight = vec3(0.0);
vec3 fallsGlow = vec3(0.0);
vec3 fallsHaze = vec3(0.0);
vec3 fallsRainAir = vec3(0.0);
vec3 fallsCloudBase = vec3(0.0);
vec3 fallsRainLight = vec3(0.08);
float fallsDripAmt = 0.0;
float fallsRain = 0.0;
float fallsRainWet = 0.0;
float fallsWind = 0.0;
float fallsFx = 0.0;
// Set by the layers' begins from their knobs, each its own: the carved M's parting (cliff), the
// flow and the foot of the sheet where it meets the pool (falls; with no falls, a width of -1: no
// plunge clears the blocks), the spray (spray), the moss and ferns (greenery), the fireflies (pool).
float fallsParting = 0.0;
float fallsFlow = 0.0;
float fallsFootX = 0.0;
float fallsFootW = -1.0;
float fallsMistAmount = 0.0;
float fallsGreen = 0.0;
float fallsFlies = 0.0;
// The cliff's layout at this cell (cliffBegin): its skyline, the slot wall seen here (fallsSlot) with
// its top and the woods over it, the trees on the rim and the woods upstream, and which part the cell
// shows (FALLS_AT_*).
const int FALLS_AT_WALL = 0;
const int FALLS_AT_TREES = 1;
const int FALLS_AT_WOODS = 2;
const int FALLS_AT_SKY = 3;
const int FALLS_AT_CLIFF = 4;
const int FALLS_AT_POOL = 5;
int fallsPart = FALLS_AT_SKY;
float fallsRimY = 1.0;
vec4 fallsSlotHit = vec4(0.0);
float fallsSlotTopY = 0.0;
float fallsSlotWoods = 0.0;
float fallsTreesY = 1.0;
float fallsWoodsY = 1.0;
// What the passes leave for the later ones: the depth of what the gorge drew last (anything the cell
// then shows nearer covers it: a bird, a guest's grass), the wet sparkle, the white water and the
// spray there (for the dither's shimmer, cliffShade), the plunge's churn, the spray's veil, how much
// of the near bank stands in front (its stones and ferns), and the white water's glow left in the
// air after it (for the rain around it).
float fallsZm = 1e4;
float fallsGlint = 0.0;
float fallsWhite = 0.0;
float fallsSpray = 0.0;
float fallsChurnX = 0.0;
float fallsMistA = 0.0;
float fallsFront = 0.0;
float fallsHaloM = 0.0;

// The shared sky's sun crosses the sky ahead of its camera. This camera is turned half a turn
// about the vertical, so the sun is behind the viewer whenever it is up: it lights the cliff and
// the spray from the front, and its antisolar point (the rainbow's centre) lies ahead, below the
// horizon. The same map takes camera directions to sky directions and back.
vec3 fallsWorld(vec3 d) {
  return vec3(-d.x, d.y, -d.z);
}

// Light reaching a surface with normal n (camera frame): the sky, favouring upward faces, plus
// sun and moon.
vec3 fallsLit(FallsLight L, vec3 n) {
  return L.amb * (0.75 + 0.25 * n.y) + L.sunCol * max(dot(n, L.sun), 0.0) + L.moonCol * max(dot(n, L.moon), 0.0);
}

// ---- the falling water ----
// Free fall from the lip: water comes over at v0 and, having dropped d, moves at
// v = sqrt(v0^2 + 2 g d); it left the lip tau = (v - v0) / g seconds ago.
float fallsV0(float flow) {
  return 0.05 + 0.07 * flow;
}

float fallsTau(float d, float v0) {
  float v = sqrt(v0 * v0 + 2.0 * FALLS_G * max(d, 0.0));
  return (v - v0) / FALLS_G;
}

// Half-width of the sheet after dropping d: set by the flow, spreading as it falls and faster
// toward the foot, where the water breaks up and fans out.
float fallsHalfWidth(float d, float flow) {
  float fall = max(d, 0.0);
  return mix(0.02, 0.15, flow) * (1.0 + 0.3 * fall + 0.7 * fall * fall) + 0.02 * fall;
}

// Where the river comes over the lip, x on the frame: a little right of centre on wide screens.
float fallsAt(float aspect) {
  return 0.09 * min(aspect, 2.0);
}

// Middle of the sheet after dropping d: a steady wind pushes the water aside by ~ a tau^2 / 2.
float fallsCentre(float d, float fx, float flow, float wind) {
  float tau = fallsTau(d, fallsV0(flow));
  return fx + wind * 0.03 * tau * tau;
}

// The falling sheet at q. Every pattern is painted in (u, e): u across the sheet, e = t - tau the
// moment that water came over the lip. A streak therefore rides with its water and stretches as it
// accelerates (parcels that left dt apart are v dt apart): short and slow at the lip, long fast
// ropes near the foot. Everything moves with the clock; nothing is re-randomised per frame.
// split (0..1) parts the flow around a horn of rock at the lip. Returns x coverage, y aeration
// (white water), z glassiness (the smooth tongue at the lip), w = u; sheen is a slow streak
// pattern for the sky reflected in the clear water.
vec4 fallsCurtain(vec2 q, float fx, float flow, float split, float wind, float tm, out float sheen) {
  sheen = 0.0;
  float d = FALLS_LIP - q.y;
  if (d < -0.012) return vec4(0.0);
  float v0 = fallsV0(flow);
  float tau = fallsTau(d, v0);
  float u = (q.x - fx - wind * 0.03 * tau * tau) / fallsHalfWidth(d, flow);
  if (abs(u) > 1.7) return vec4(0.0, 0.0, 0.0, u);
  float e = tm - tau;
  float ropes = mix(2.5, 11.0, flow);
  float streak = 0.62 * vnoise(vec2(u * ropes, e * 1.7)) + 0.38 * vnoise(vec2(u * ropes * 2.3 + 7.0, e * 3.4 + 2.0));
  sheen = vnoise(vec2(u * ropes * 0.8 + 3.0, e * 0.45));
  // Ragged edges, more so the further the water has fallen: they fray into spray.
  float fray = smoothstep(0.03, 0.45, d);
  float ragged = vnoise(vec2(u * 2.2 + 5.0, e * 2.2)) - 0.5;
  float alpha = smoothstep(0.0, 0.05 + 0.3 * fray, 1.0 - abs(u) + ragged * (0.1 + 0.8 * fray));
  // The water rounds over the lip.
  float bulge = 0.006 * sqrt(max(1.0 - u * u, 0.0));
  alpha *= smoothstep(-bulge - 0.002, -bulge + 0.002, d);
  // Parted by the horn: two streams that spread and close up lower down, a thin veil between.
  if (split > 0.0) {
    float gap = split * 0.8 * (1.0 - smoothstep(0.08, 0.42, d));
    alpha *= mix(0.2, 1.0, smoothstep(0.0, 0.06 + 0.2 * fray, abs(u) - gap + ragged * 0.3 * fray));
  }
  // A thin flow breaks into separate ropes; partings open and drift down with the water.
  float gaps = (1.0 - flow) * 0.85 * smoothstep(0.08, 0.45, d);
  alpha *= mix(1.0, smoothstep(0.2, 0.5, streak), gaps);
  float parting = smoothstep(0.62, 0.8, vnoise(vec2(u * 1.4 + 21.0, e * 0.3))) * smoothstep(0.04, 0.2, d);
  alpha *= 1.0 - clamp(parting * (0.55 - 0.45 * flow + 0.5 * split), 0.0, 0.9);
  // Air beaten in as it falls: clear at the lip, then white ropes, then whole sheets.
  float aeration = clamp(smoothstep(0.012, 0.26, d) * (0.75 + 0.45 * flow), 0.0, 1.0);
  float level = mix(0.95, 0.3 - 0.12 * flow, aeration);
  // A soft threshold: the ropes ride down fast, and a hard one would flash cells on and off.
  float white = smoothstep(level - 0.15, level + 0.13, streak);
  white = max(white, 0.8 * smoothstep(0.4, 0.66, vnoise(vec2(u * 2.0 + 3.0, e * 0.8 + 9.0))) * smoothstep(0.08, 0.35, d));
  return vec4(alpha, white, 1.0 - smoothstep(0.0, 0.07, d), u);
}

// The falling water's colour: clear dark water carrying streaks of reflected sky at the lip,
// white aerated water lower down, bluish in its own shade. The sheet bows toward the viewer, so
// its middle catches more light than its edges. glow is the white water's own soft light after
// dark (0 by day).
vec3 fallsWater(vec4 c, float sheen, FallsLight L, vec3 skyLight, vec3 glow) {
  float bow = sqrt(max(1.0 - c.w * c.w, 0.0));
  vec3 lit = fallsLit(L, normalize(vec3(c.w * 0.45, 0.15, -1.0)));
  vec3 foam = mix(vec3(0.56, 0.72, 0.8), vec3(1.0), 0.4 + 0.6 * bow) * lit * 1.1 + glow * (0.6 + 0.4 * bow);
  vec3 clear = mix(vec3(0.03, 0.075, 0.065), vec3(0.09, 0.17, 0.15), sheen) * lit + skyLight * smoothstep(0.55, 0.85, sheen) * (0.12 + 0.38 * c.z);
  return mix(clear, foam, c.y);
}

// White water lying on the pool or boiling up at the plunge; shade 0..1 from hollows to tops.
vec3 fallsFoam(FallsLight L, vec3 glow, float shade) {
  return mix(vec3(0.55, 0.7, 0.76), vec3(0.98, 1.0, 1.0), shade) * (L.amb * 1.2 + L.sunCol * 0.8 + L.moonCol * 0.7) + glow * shade;
}

// The plunge: a low dome of churning white water where the sheet hits the pool, wider than the
// sheet, boiling up (two noise layers scrolled upward at different speeds), flatter in front.
// Returns coverage and shade.
vec2 fallsChurn(vec2 q, float cx, float wb, float flow, float tm) {
  vec2 c = vec2((q.x - cx) / (wb * 1.3 + 0.03), (q.y - FALLS_POOL) / (0.03 + 0.05 * flow));
  if (abs(c.x) > 1.7 || c.y > 1.7 || c.y < -0.8) return vec2(0.0);
  float dome = 1.0 - length(vec2(c.x, c.y > 0.0 ? c.y : c.y * 2.6));
  float boil = 0.6 * vnoise(vec2(c.x * 2.6, c.y * 2.2 - tm * 1.6)) + 0.4 * vnoise(vec2(c.x * 5.4 + 3.0, c.y * 4.6 - tm * 2.6));
  return vec2(smoothstep(-0.05, 0.3, dome + (boil - 0.5) * 0.8), clamp(0.35 + 0.5 * dome + 0.5 * (boil - 0.5), 0.0, 1.0));
}

// Spray in the air at q: a plume billowing up from the plunge, widening as it rises and leaning
// downwind, its puffs (two fbm layers advected up and along the wind) rising and drifting; spray
// flung out sideways at the impact in two low fans; a thinner haze spreads toward the viewer over
// the pool and hangs low across the valley floor.
float fallsMist(vec2 q, float cx, float wb, float flow, float amount, float wind, float tm) {
  float h = q.y - FALLS_POOL;
  float rise = max(h, 0.0);
  float dx = q.x - cx - wind * (0.25 * rise + 0.9 * rise * rise);
  float spread = wb + 0.05 + 0.5 * rise + 0.9 * max(-h, 0.0);
  float reach = (0.06 + 0.34 * amount) * (0.5 + 0.7 * flow);
  float plume = (0.3 + 1.1 * amount) * (0.4 + 0.8 * flow) * exp(-dx * dx / (spread * spread)) * exp(-rise / reach) * exp(min(h, 0.0) / 0.1);
  float valley = amount * 0.3 * exp(-abs(h) / (0.05 + 0.08 * amount));
  // The fans: droplets leave the plunge sideways on ballistic arcs, so the spray stands highest
  // a third of the way out and falls back to the water at its reach; its puffs ride outward.
  float side = abs(q.x - cx) - 0.7 * wb;
  float far = side / ((0.1 + 0.18 * flow) * (0.6 + 0.6 * amount));
  float fan = 0.0;
  if (far > -0.3 && far < 1.0 && h > -0.04) {
    float top = (0.035 + 0.06 * flow) * (0.6 + 0.5 * amount) * 2.6 * sqrt(max(far, 0.0)) * (1.0 - far) + 0.012;
    float drift = vnoise(vec2(side * 9.0 - tm * (0.5 + 0.5 * flow), h * 16.0 + sign(q.x - cx) * 5.0));
    fan = (0.2 + 0.5 * flow) * (0.4 + 0.8 * amount) * (1.0 - smoothstep(0.35, 1.0, h / top)) * exp(min(h, 0.0) / 0.015)
        * (1.0 - far) * smoothstep(-0.3, 0.0, far) * (0.35 + drift);
  }
  if (plume + valley + fan < 0.004) return 0.0;
  vec2 p = vec2(q.x * 3.4 - tm * 0.05 * wind, q.y * 3.4 - tm * 0.075);
  float puffs = smoothstep(0.25, 0.85, 0.5 * fbm3(p) + 0.6 * fbm3(p * 0.5 + vec2(5.2, 1.3 - tm * 0.02)));
  return plume * (0.3 + 1.2 * puffs) + valley * (0.4 + 0.9 * puffs) + fan;
}

// After dark the white water seems to glow: a soft bloom, 0..1, strongest at the sheet's edges
// and fading over a few dozen cells of air; below the waterline, its reflection's.
float fallsHalo(vec2 q, float fx, float flow, float wind) {
  if (abs(q.x - fx) > 0.75) return 0.0;
  bool inPool = q.y < FALLS_POOL;
  float y = inPool ? 2.0 * FALLS_POOL - q.y : q.y;
  float d = clamp(FALLS_LIP - y, 0.0, FALLS_LIP - FALLS_POOL);
  float off = max(abs(q.x - fallsCentre(d, fx, flow, wind)) - fallsHalfWidth(d, flow), 0.0);
  float along = (1.0 - smoothstep(FALLS_LIP - 0.06, FALLS_LIP + 0.06, y)) * (inPool ? 0.7 : 1.0);
  return exp(-off / (0.035 + 0.04 * flow)) * along * (0.5 + 0.5 * smoothstep(0.0, 0.3, d));
}

// ---- the cliff ----

// The cliff's skyline: a ragged lip, notched where the river pours over; horn (0..1) raises a
// knob of rock in the middle of the notch that splits the flow.
float fallsRim(float x, float fx, float horn) {
  float rim = 0.848 + 0.06 * (fbm3(vec2(x * 1.7, 3.0)) - 0.5) + 0.008 * (vnoise(vec2(x * 16.0, 5.0)) - 0.5);
  float across = abs(x - fx);
  float notch = 1.0 - smoothstep(0.17, 0.25, across);
  return mix(rim, FALLS_LIP + horn * 0.035 * exp(-across * across / 0.0008), notch);
}

// Tree crowns along a skyline, height above its base at x: one tree per cell of width size, a
// rounded broadleaf crown or now and then a conifer's spire. Crowns stay within reach of the
// three cells looked at, so none is ever cut off.
float fallsCrowns(float x, float size, float seed) {
  float c = floor(x / size);
  float h = 0.0;
  for (int k = -1; k <= 1; k++) {
    float id = c + float(k);
    float r = size * (0.5 + 0.5 * hash12(vec2(id, seed)));
    float dx = abs(x - (id + 0.5 + (hash12(vec2(id, seed + 1.0)) - 0.5) * 0.6) * size);
    float crown = hash12(vec2(id, seed + 2.0)) < 0.3 ? max(2.2 * r - dx * 4.5, 0.0) : sqrt(max(r * r - dx * dx, 0.0));
    h = max(h, crown);
  }
  return h;
}

// ---- the rock: three gorges (K_gorge) ----
// Two layered rocks and one massive one. Basalt flows (0, the original cliff): couplets of a hard
// lava flow and the soft ash or scoria on it, dipping and folded, the flows standing out as ledges.
// Sandstone ledges (1): many thinner, nearly level beds of buff and red sandstone parted by thin
// shale, cross-bedded, the sandstone standing far out as stepped ledges. A limestone slot (2): a few
// thick, pale, level beds parted by thin bedding planes, barely standing out, fluted by runnels and
// striped with dark streaks under the lips, crusted with tufa where the water runs; the walls close
// in on both sides (fallsSlot), leaving a slit of sky. Set once per pixel by fallsSetGorge.
struct FallsGeology {
  float kind;      // 0 basalt flows, 1 sandstone ledges, 2 limestone slot
  float beds;      // couplets per screen height
  float dip;       // rise of the bedding per unit x
  float fold;      // share of the broad, shared folds
  float warp;      // share of the pinch and swell
  vec3 split;      // the hard bed's share of a couplet: base, spread between beds, wobble along a bed...
  vec2 splitRange; // ...kept within this
  vec3 proud;      // how far a hard bed stands out: base, spread between beds, wobble along a bed
  vec3 block0;     // fallen blocks: the darkest stone...
  vec3 block1;     // ...and the palest
};
FallsGeology fallsGeo;

void fallsSetGorge(float gorge) {
  fallsGeo = FallsGeology(0.0, FALLS_BEDS, 0.6, 1.0, 1.0, vec3(0.4, 0.42, 0.32), vec2(0.3, 0.95), vec3(0.15, 0.85, 0.7), vec3(0.16, 0.16, 0.17), vec3(0.32, 0.3, 0.27));
  if (gorge > 1.5) fallsGeo = FallsGeology(2.0, 4.2, 0.04, 0.12, 0.3, vec3(0.86, 0.08, 0.06), vec2(0.8, 0.96), vec3(0.06, 0.22, 0.3), vec3(0.5, 0.48, 0.43), vec3(0.78, 0.75, 0.66));
  else if (gorge > 0.5) fallsGeo = FallsGeology(1.0, 10.0, 0.2, 0.4, 0.7, vec3(0.5, 0.4, 0.3), vec2(0.35, 0.92), vec3(0.25, 0.75, 0.8), vec3(0.3, 0.2, 0.15), vec3(0.55, 0.42, 0.3));
}

// The bedding: s counts couplets up the cliff, each a hard bed (a lava flow, a sandstone, a
// limestone) with a soft bed (ash, scoria, shale, a bedding plane) lying on it. The beds dip gently
// to the right and sag in broad, shared folds; a slow warp along the column, different for each bed
// and changing along x, makes them thicken and thin (pinch and swell). dsdy = ds/dy, to turn
// fractions of a bed into screen heights.
float fallsLayer(vec2 q, out float dsdy) {
  float s0 = q.y * fallsGeo.beds + fallsGeo.dip * q.x + fallsGeo.fold * 1.3 * vnoise1(q.x * 0.9, 1.3).x + fallsGeo.fold * 0.45 * vnoise1(q.x * 2.7, 2.9).x;
  vec2 w = vnoiseD(vec2(s0 * 1.1, q.x * 1.6)).xy;
  dsdy = fallsGeo.beds * (1.0 + fallsGeo.warp * 0.55 * w.y);
  return s0 + fallsGeo.warp * 0.5 * (w.x - 0.5);
}

// The share of couplet c the hard bed takes up at x (the soft bed on it has the rest), varying
// along the bed so the soft partings now and then all but pinch out.
float fallsSplit(float c, float x) {
  return clamp(fallsGeo.split.x + fallsGeo.split.y * hash12(vec2(c, 2.7)) + fallsGeo.split.z * (vnoise1(x * 1.9 + c * 3.7, c + 0.5).x - 0.5), fallsGeo.splitRange.x, fallsGeo.splitRange.y);
}

// How far couplet c's hard bed stands out from the soft beds about it at x, 0..1: some beds stand
// out as ledges and overhangs, some barely, and erosion bites in and out along each.
float fallsProud(float c, float x) {
  return clamp(fallsGeo.proud.x + fallsGeo.proud.y * hash12(vec2(c, 3.1)) + fallsGeo.proud.z * (vnoise1(x * 2.3 + c * 5.1, c + 7.5).x - 0.5), 0.0, 1.0);
}

// A bed's stone. Basalt: the hard beds dark basalt, some greyer or browner; the soft beds rusty
// scoria, pale ash or dark rubble. Sandstone: buff, red or pale sandstone on grey-violet shale.
// Limestone: cream, grey or warm limestone, the bedding planes a shade darker.
vec3 fallsStone(float c, bool hard) {
  float kind = hash12(vec2(c, hard ? 5.3 : 6.1));
  if (fallsGeo.kind > 1.5) {
    if (hard) return kind < 0.45 ? vec3(0.8, 0.77, 0.68) : kind < 0.8 ? vec3(0.74, 0.73, 0.68) : vec3(0.82, 0.72, 0.56);
    return vec3(0.56, 0.53, 0.47);
  }
  if (fallsGeo.kind > 0.5) {
    if (hard) return kind < 0.4 ? vec3(0.55, 0.42, 0.28) : kind < 0.75 ? vec3(0.5, 0.3, 0.21) : vec3(0.6, 0.53, 0.42);
    return kind < 0.6 ? vec3(0.27, 0.25, 0.27) : vec3(0.33, 0.28, 0.27);
  }
  if (hard) return kind < 0.5 ? vec3(0.22, 0.22, 0.23) : kind < 0.8 ? vec3(0.3, 0.29, 0.28) : vec3(0.29, 0.25, 0.21);
  return kind < 0.45 ? vec3(0.38, 0.26, 0.19) : kind < 0.8 ? vec3(0.37, 0.33, 0.27) : vec3(0.21, 0.19, 0.19);
}

// The cliff face at q (s, dsdy from fallsLayer). Erosion bites the bed edges into scallops. A
// hard bed's top rolls back into a rounded lip facing the sky (moss, ferns, a rim of sky light
// after dark) and its base tucks under as a dark overhang; a few joints split it, each leaning
// its own way, reaching down from the top some way and opening into a notch at the lip, the
// blocks either side rounded into it; a thick bed shows a faint parting between two flows. The
// soft bed on it is recessed, finely layered and shaded by the overhang of the bed above. Seeps
// along the base of each hard bed stain dark wet streaks down the rock below; lichen crusts the
// dry stone. wet (the spray, the pool) darkens the stone and makes it glisten; rainWet (how wet
// the rain has left the place) soaks the rest and glosses it, and sends rivulets over each ledge
// and down the bed below; drip (0..1) drops water from the overhangs, lit dropLight. glint reports
// the spray's sparkle for the dither's shimmer.
vec3 fallsRock(vec2 q, float s, float dsdy, vec3 ray, FallsLight L, float wet, float rainWet, float drip, vec3 dropLight, float green, float dark, float tm, float tf, out float glint) {
  float rough = vnoise(vec2(q.x * 32.0, s * 3.0));
  float sr = s + 0.14 * (rough - 0.5);
  float c = floor(sr);
  float g = sr - c;
  float split = fallsSplit(c, q.x);
  bool hard = g < split;
  float f = hard ? g / split : (g - split) / (1.0 - split); // 0 at the bed's base .. 1 at its top
  float thick = (hard ? split : 1.0 - split) / dsdy;         // the bed's thickness, screen heights
  float proud = fallsProud(c, q.x);
  float proudUp = fallsProud(c + 1.0, q.x);
  float g1 = vnoise(q * vec2(28.0, 46.0));
  float g2 = vnoise(q * vec2(90.0, 70.0) + 7.0);

  float lip = 0.0;
  float tuck = 0.0;
  float overhang = 0.0;
  float layering = 0.0;
  float joint = 0.0;
  float groove = 0.0;
  vec3 n = vec3((g2 - 0.5) * 0.5 + (g1 - 0.5) * 0.5, (g1 - 0.5) * 0.4, -1.0);
  if (hard) {
    lip = smoothstep(1.0 - min(0.45, (0.008 + 0.016 * proud) / thick), 1.0, f) * (0.3 + 0.7 * proud);
    tuck = (1.0 - smoothstep(0.0, min(0.35, (0.005 + 0.012 * proud) / thick), f)) * proud;
    n.y += (f - 0.5) * 0.35;
    float at = 0.3 + 0.4 * hash12(vec2(c, 4.4));
    layering = (1.0 - smoothstep(0.002, 0.005, abs(f - at) * thick)) * smoothstep(0.05, 0.08, thick) * smoothstep(0.4, 0.6, vnoise1(q.x * 7.0, c + 12.0).x);
    // Joints: at most one per irregular stretch of the bed, and only in some stretches.
    float jx = q.x * 3.4 + 9.0 * hash12(vec2(c, 8.8));
    float stretch = floor(jx);
    float hj = hash12(vec2(stretch, c + 0.31));
    if (hj < 0.6) {
      float run = smoothstep(0.0, 0.12, f - 0.75 * fract(hj * 31.1));
      float dx = (fract(jx) - 0.2 - 0.6 * fract(hj * 7.1)) / 3.4 - (fract(hj * 17.3) - 0.5) * 0.5 * (f - 0.5) * thick - 0.005 * (g1 - 0.5);
      float w = 0.003 + 0.005 * smoothstep(0.6, 1.0, f);
      joint = (1.0 - smoothstep(0.5 * w, w, abs(dx))) * run;
      groove = (1.0 - smoothstep(w, 3.5 * w, abs(dx))) * run;
      n.x += sign(dx) * 0.7 * groove;
    }
  } else {
    float reach = (0.004 + 0.022 * proudUp) / thick;
    overhang = proudUp * smoothstep(1.0 - reach - 0.15, 1.0 - reach + 0.1, f + 0.2 * (g1 - 0.5));
    layering = smoothstep(0.5, 0.9, abs(fract(sr * 7.0 + 0.4 * g1) - 0.5) * 2.0) * 0.6;
  }
  if (fallsGeo.kind > 1.5) {
    // Limestone: runnels flute the face from each lip down, fading down the bed, and joints split
    // the massive beds from top to bottom, a few to a screen height, each wandering a little.
    float flute = sin(q.x * 150.0 + 4.0 * vnoise(vec2(q.x * 14.0, sr * 0.7)));
    n.x += 0.22 * flute * (hard ? 1.0 - 0.6 * f : 0.3);
    float dx = (fract(q.x * 2.3 + 0.15 * vnoise(vec2(q.y * 4.0, 2.0)) + 0.3) - 0.5) / 2.3;
    joint = max(joint, 1.0 - smoothstep(0.0015, 0.004, abs(dx)));
    groove = max(groove, 1.0 - smoothstep(0.004, 0.014, abs(dx)));
    n.x += sign(dx) * 0.5 * groove;
  } else if (fallsGeo.kind > 0.5 && hard) {
    // Sandstone: cross-bedding, thin laminae slanting through each bed, one way or the other in
    // each stretch of it.
    float set = floor(q.x * 2.6 + hash12(vec2(c, 9.1)) * 5.0);
    float slope = (hash12(vec2(set, c + 0.7)) - 0.5) * 0.9;
    float lamina = abs(fract((f * thick - slope * q.x) * 110.0) - 0.5);
    layering = max(layering, 0.6 * smoothstep(0.36, 0.5, lamina) * smoothstep(0.02, 0.05, thick));
  }
  n = normalize(n);
  n = normalize(mix(n, vec3(0.0, 0.85, -0.53), lip));
  n = normalize(mix(n, vec3(0.0, -0.8, -0.6), tuck));

  // Seeps: water oozing out along the base of the hard bed above stains streaks down from it.
  float below = (c + 1.0 - sr) / dsdy;
  float seep = smoothstep(0.55, 0.85, vnoise1(q.x * 5.5, c + 41.0).x);
  float stain = seep * smoothstep(0.35, 0.65, vnoise(vec2(q.x * 30.0, sr * 0.6 + 3.0))) * (1.0 - smoothstep(0.0, 0.04 + 0.12 * seep, below));
  float damp = max(wet, 0.8 * stain);

  // Rain: the water gathering on each ledge spills over its lip in rivulets down the face of the
  // bed, reaching further the wetter the rock, and soaks the stone the spray leaves dry.
  float runoff = 0.0;
  if (hard && rainWet > 0.0) {
    float lane = smoothstep(0.6, 0.8, vnoise(vec2(q.x * 46.0, c * 2.3 + 0.7)) + 0.12 * (g1 - 0.5));
    float reach = thick * (0.2 + 0.9 * rainWet);
    runoff = lane * rainWet * (1.0 - smoothstep(0.5 * reach, reach, (1.0 - f) * thick));
  }
  float soak = max(0.85 * rainWet, runoff) * (1.0 - damp);

  // Moss: cushions along the lips of the ledges and on the soft rock just above them, spilling
  // raggedly over; patches on the face where spray and seeps keep it wet. Lichen on dry stone.
  float patchy = fbm3(q * vec2(9.0, 13.0) + 2.0);
  float band = (0.012 + 0.02 * green * proud) / thick;
  float onLip = hard
    ? smoothstep(1.0 - band * (1.0 + 0.8 * rough), 1.0 - 0.4 * band, f) * smoothstep(0.15, 0.45, proud)
    : (1.0 - smoothstep(0.0, 0.18 + 0.2 * rough, f)) * smoothstep(0.3, 0.6, proud) * 0.8;
  float onShelf = onLip * smoothstep(0.62 - 0.45 * green, 0.78 - 0.45 * green, patchy);
  float onFace = smoothstep(0.78, 0.92, patchy + 0.25 * wet + 0.1 * stain + 0.15 * green) * (1.0 - joint);
  float moss = clamp(max(onShelf, onFace), 0.0, 1.0) * smoothstep(0.0, 0.15, green);
  // Soaked, moss turns a deeper, richer green.
  vec3 mossCol = wetten(mix(vec3(0.1, 0.24, 0.06), vec3(0.34, 0.52, 0.13), patchy), rainWet, 1.0) * mix(vec3(1.0), vec3(0.85, 1.05, 0.7), rainWet);
  float lichen = smoothstep(0.64, 0.78, 1.0 - patchy + 0.4 * (g2 - 0.5)) * (1.0 - smoothstep(0.15, 0.45, damp)) * (hard ? 0.8 : 0.4) * (1.0 - moss);
  vec3 lichenCol = wetten(mix(vec3(0.48, 0.52, 0.42), vec3(0.6, 0.43, 0.2), smoothstep(0.55, 0.7, g1)), rainWet, 0.6);

  vec3 albedo = wetten(fallsStone(c, hard) * (0.72 + 0.45 * g1) * (0.6 + 0.8 * patchy) * mix(1.0, 0.5, damp), soak, hard ? 0.25 : 0.7);
  albedo = mix(albedo, vec3(0.05, 0.06, 0.045), 0.45 * stain);
  albedo = mix(albedo, lichenCol, 0.75 * lichen);
  albedo = mix(albedo, mossCol * mix(1.0, 0.8, damp), moss);
  if (fallsGeo.kind > 1.5) {
    // Dark streaks (algae) hang down the face below the lips, and tufa crusts the rock the water
    // keeps wet, cream to orange.
    float tint = smoothstep(0.55, 0.8, vnoise(vec2(q.x * 26.0, c * 3.1))) * smoothstep(0.25, 0.6, vnoise(vec2(q.x * 26.0, sr * 1.3 + 4.0)));
    albedo = mix(albedo, vec3(0.13, 0.13, 0.12), 0.55 * tint * (1.0 - moss));
    albedo = mix(albedo, vec3(0.74, 0.62, 0.45), 0.5 * smoothstep(0.3, 0.8, wet) * smoothstep(0.4, 0.7, g1) * (1.0 - moss));
  }
  float occlusion = (1.0 - 0.7 * overhang) * (1.0 - 0.8 * joint) * (1.0 - 0.25 * groove) * (1.0 - 0.5 * tuck) * (1.0 - 0.3 * layering) * (hard ? 1.0 : 0.85);
  vec3 col = albedo * fallsLit(L, n) * occlusion;

  // Sky light along the lips: the rounded tops face the open sky and, wet, mirror it. After dark,
  // with the sky the only light, these rims draw the ledges.
  vec3 skyLight = L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.35;
  col += skyLight * lip * (0.04 + 0.1 * damp + 0.22 * dark) * (1.0 - 0.5 * moss);

  // Wet stone glistens: facets flash where they mirror the sun or moon, the sky lies in a faint
  // sheen over it, and films of water slide down it in the spray, catching the light. Rain glosses
  // it too, most on the rounded lips where water stands and along the rivulets, down which films
  // slide slowly.
  vec3 r = reflect(ray, n);
  float flashSun = pow(max(dot(r, L.sun), 0.0), 36.0);
  float flashMoon = pow(max(dot(r, L.moon), 0.0), 36.0);
  float film = smoothstep(0.66, 0.92, vnoise(vec2(q.x * 80.0, q.y * 7.0 + tm * 1.1))) * wet;
  float bare = 1.0 - moss;
  float gloss = rainWet > 0.0 ? wetGloss(max(rainWet, runoff), n.y) * bare : 0.0;
  float slide = smoothstep(0.45, 0.85, vnoise(vec2(q.x * 46.0 + 5.0, q.y * 5.0 + tm * 0.3)));
  col += (L.sunCol * flashSun + L.moonCol * flashMoon) * 1.5 * max(damp, gloss) * bare * occlusion;
  col += skyLight * (0.06 * damp + 0.35 * film) * (1.0 - 0.7 * moss);
  col += skyLight * (0.12 * gloss + 0.3 * runoff * bare * (0.4 + 0.6 * slide)) * occlusion;
  glint = wet * bare * (flashSun + 0.5 * flashMoon + 0.6 * film) * occlusion;
  // Drops gather under the overhang of the bed above and fall past the recess onto the ledge below.
  if (drip > 0.0 && !hard && proudUp > 0.3) {
    col = mix(col, dropLight, rainDrips(vec2(q.x, (c + 1.0 - s) / dsdy) * FALLS_CLIFF_M, tf, drip * proudUp, 1.0));
  }
  return col;
}

// Ferns and creepers hanging from the ledges (the lips of the hard beds): a clump of fronds here
// and there along a ledge that stands out far enough, arching out and drooping over the face
// below (plantFrond: the plant component's frond, posed here from hashes rather than grown), and
// curtains of creeper strands hanging straight down. Both sway with the wind and the fall's draught
// (sway: how far the frond tips swing, in frond lengths). Looks at the two ledges above q, three
// clumps along each. Returns coverage; tip is how far along the frond (tips are younger and paler).
float fallsFerns(vec2 q, float s, float dsdy, float green, float sway, float tm, out float tip) {
  tip = 0.0;
  float cover = 0.0;
  float c0 = floor(s);
  float first = s - c0 < fallsSplit(c0, q.x) ? c0 : c0 + 1.0;
  for (int lv = 0; lv < 2; lv++) {
    float cc = first + float(lv);
    // A little under the smooth bedding line, so the roots sit in the moss on the eroded lip.
    float shelfY = q.y + (cc + fallsSplit(cc, q.x) - s) / dsdy - 0.004;
    if (shelfY - q.y > 0.09) break;
    float c = floor(q.x / 0.1);
    for (int k = -1; k <= 1; k++) {
      float id = c + float(k);
      vec2 key = vec2(id, cc * 1.37);
      if (hash12(key) > green * 0.9) continue;
      vec2 root = vec2((id + 0.5 + (hash12(key + 1.7) - 0.5) * 0.7) * 0.1, shelfY);
      if (fallsProud(cc, root.x) < 0.4) continue;
      float reach = 0.035 + 0.035 * hash12(key + 2.9);
      float swing = sway * sin(tm * 0.7 + id * 1.9 + cc);
      for (int j = 0; j < 3; j++) {
        float fj = float(j);
        float side = j == 1 ? 1.0 : -1.0;
        if (j == 2) side = hash12(key + 4.1) < 0.5 ? -1.0 : 1.0;
        float u = 0.0;
        float under = 0.0;
        float frond = plantFrond(q - root, side, reach * (1.0 - 0.25 * fj), 0.35 - 0.15 * fj, 1.2 + 0.5 * fj, swing * side, 0.0, u, under);
        if (frond > cover) {
          cover = frond;
          tip = u;
        }
      }
    }
    // Creepers: strands hanging from the ledge directly above, swinging together.
    if (lv == 0) {
      float hang = shelfY - q.y;
      float vx = q.x * 60.0 + sin(tm * 0.6 + cc * 2.0) * hang * 25.0 * sway;
      float strand = floor(vx);
      float len = (0.015 + 0.06 * hash12(vec2(strand, cc + 0.71))) * green;
      if (hang > 0.0 && hang < len && hash12(vec2(strand, cc + 0.37)) < green * 0.5 * smoothstep(0.45, 0.7, vnoise(vec2(strand * 0.12, cc))) && fallsProud(cc, (strand + 0.5) / 60.0) > 0.3) {
        float width = 0.08 + 0.18 * (1.0 - hang / len);
        cover = max(cover, smoothfall(width, width * 0.5, abs(fract(vx) - 0.5)));
      }
    }
  }
  return cover;
}

// One row of blocks fallen from the cliff (see fallsBoulders): a block or a gap per stretch of
// width size, each a rounded, squarish lump (a superellipse) of its own size and lean, sunk into
// the scree at height base; none within clearW + ~0.05 of clearX, where the plunge has scoured
// them away. Lays itself over what the rows behind left in cover, n, k and h.
void fallsBlockRow(vec2 q, float size, float base, float salt, float clearX, float clearW, inout float cover, inout vec3 n, inout float k, inout float h) {
  float cell = floor(q.x / size);
  for (int j = -1; j <= 1; j++) {
    float id = cell + float(j);
    vec2 key = vec2(id, salt);
    float hb = hash12(key);
    if (hb < 0.22) continue;
    float x0 = (id + 0.5 + (hash12(key + 1.3) - 0.5) * 0.5) * size;
    float r = size * (0.3 + 0.32 * hb) * smoothstep(clearW + 0.02, clearW + 0.1, abs(x0 - clearX));
    if (r < 0.004) continue;
    vec2 p = (q - vec2(x0, base)) / vec2(r, r * (0.55 + 0.35 * hash12(key + 3.7)));
    p.x += (hash12(key + 5.1) - 0.5) * 0.6 * p.y;
    float e = pow(abs(p.x), 2.4) + pow(max(p.y, 0.0), 2.4);
    float a = 1.0 - smoothstep(0.8, 1.0, e);
    if (a > 0.0 && (a > 0.5 || a > cover)) {
      vec2 grad = vec2(sign(p.x) * pow(abs(p.x), 1.4), pow(max(p.y, 0.0), 1.4));
      n = normalize(vec3(grad.x * 0.9, grad.y * 0.9 + 0.15, -1.0));
      k = fract(hb * 7.3);
      h = clamp(p.y, 0.0, 1.0);
    }
    cover = max(cover, a);
  }
}

// Blocks fallen from the cliff, heaped along its foot: a row of big blocks, scree banked against
// them, smaller stones in front. Returns coverage; n the surface normal, k a 0..1 key for the
// stone's tone, h how high up the block (0 at its foot, wet, .. 1 at its top).
float fallsBoulders(vec2 q, float clearX, float clearW, out vec3 n, out float k, out float h) {
  n = vec3(0.0, 0.0, -1.0);
  k = 0.0;
  h = 0.0;
  float cover = 0.0;
  fallsBlockRow(q, 0.085, FALLS_POOL + 0.008, 17.0, clearX, clearW, cover, n, k, h);
  float apron = FALLS_POOL + (0.008 + 0.016 * vnoise(vec2(q.x * 20.0, 3.0))) * smoothstep(clearW, clearW + 0.08, abs(q.x - clearX));
  if (q.y < apron) {
    float gv = vnoise(q * vec2(110.0, 140.0));
    float a = 1.0 - smoothstep(apron - 0.003, apron, q.y);
    if (a > 0.5 || a > cover) {
      n = normalize(vec3((gv - 0.5) * 0.9, 0.35 + 0.4 * (gv - 0.5), -1.0));
      k = 0.1 + 0.3 * gv;
      h = 0.4 * (q.y - FALLS_POOL) / max(apron - FALLS_POOL, 0.001);
    }
    cover = max(cover, a);
  }
  fallsBlockRow(q, 0.042, FALLS_POOL - 0.004, 29.0, clearX, clearW, cover, n, k, h);
  return cover;
}

// A fallen block's (or the scree's) colour: stone with a little grain, dark and wet toward the
// water, moss on the tops, and like the ledges a rim of sky light along the tops after dark.
// rainWet soaks the stone the water leaves dry and glosses the tops.
vec3 fallsBlock(vec2 q, vec3 n, float k, float h, FallsLight L, vec3 skyLight, float wet, float rainWet, float green, float dark) {
  float grain = vnoise(q * 64.0 + k * 40.0);
  vec3 stone = mix(fallsGeo.block0, fallsGeo.block1, k) * (0.8 + 0.4 * grain);
  float damp = max(wet, 1.0 - smoothstep(0.0, 0.5, h));
  float moss = smoothstep(0.4, 0.8, n.y + 0.6 * (grain - 0.5)) * smoothstep(0.05, 0.6, green);
  stone = wetten(stone * mix(1.0, 0.5, damp), rainWet * (1.0 - damp), 0.2);
  vec3 mossCol = wetten(mix(vec3(0.1, 0.24, 0.06), vec3(0.3, 0.48, 0.12), grain), rainWet, 1.0);
  float gloss = rainWet > 0.0 ? wetGloss(rainWet, n.y) * (1.0 - moss) : 0.0;
  return mix(stone, mossCol, moss) * fallsLit(L, n) + skyLight * (smoothstep(0.4, 0.9, n.y) * (0.03 + 0.1 * damp + 0.2 * dark) * (1.0 - 0.5 * moss) + 0.25 * gloss);
}

// Down in the limestone slot the back wall at height y sees only a strip of sky, and the sun reaches
// only its top; the other gorges stand open.
FallsLight fallsSlotShade(FallsLight L, float y) {
  if (fallsGeo.kind > 1.5) {
    L.amb *= 0.75 + 0.25 * smoothstep(FALLS_POOL, 0.9, y);
    L.sunCol *= smoothstep(0.4, 0.75, y);
  }
  return L;
}

// What the pool mirrors at q (a point on the cliff above the waterline): the stone, the fallen
// blocks, the falling water and the plunge, done cheaply (no ferns, joints or carving): the
// ripples smear it anyway. rainWet soaks its stone as it does the cliff's. Without the falls the
// rock beside the notch is dry, and no water falls or boils in the image.
vec3 fallsMirror(vec2 q, FallsLight L, vec3 skyLight, vec3 glow, float fx, float flow, float green, float split, float wind, float rainWet, float dark, float tm) {
  float dsdy = 0.0;
  float s = fallsLayer(q, dsdy);
  float c = floor(s);
  float g = s - c;
  float sp = fallsSplit(c, q.x);
  bool hard = g < sp;
  float f = hard ? g / sp : (g - sp) / (1.0 - sp);
  float wet = smoothfall(FALLS_POOL + 0.035, FALLS_POOL, q.y);
#if LAYER_FALLS
  float d = FALLS_LIP - q.y;
  float beside = abs(q.x - fallsCentre(d, fx, flow, wind)) - fallsHalfWidth(d, flow);
  wet = max(exp(-max(beside, 0.0) / (0.04 + 0.08 * flow)), wet);
#endif
  float lip = hard ? smoothstep(0.7, 1.0, f) * fallsProud(c, q.x) : 0.0;
  vec3 n = normalize(vec3(0.0, hard ? (f - 0.5) * 0.5 : 0.0, -1.0));
  FallsLight Ls = fallsSlotShade(L, q.y);
  vec3 col = wetten(fallsStone(c, hard) * (0.72 + 0.45 * vnoise(q * vec2(28.0, 46.0))) * mix(1.0, 0.5, wet), 0.85 * rainWet * (1.0 - wet), hard ? 0.25 : 0.7) * fallsLit(Ls, n) * (hard ? 1.0 : 0.8);
  col = mix(col, wetten(vec3(0.2, 0.36, 0.1), rainWet, 1.0) * fallsLit(Ls, vec3(0.0, 0.85, -0.53)), lip * smoothstep(0.0, 0.15, green) * 0.8);
  col += skyLight * lip * 0.22 * dark;
  if (q.y < FALLS_POOL + 0.075) {
    vec3 bn = vec3(0.0, 0.0, -1.0);
    float bk = 0.0;
    float bh = 0.0;
    float block = fallsBoulders(q, fallsFootX, fallsFootW, bn, bk, bh);
    if (block > 0.0) col = mix(col, fallsBlock(q, bn, bk, bh, L, skyLight, wet, rainWet, green, dark), block);
  }
#if LAYER_FALLS
  float sheen = 0.0;
  vec4 sheet = fallsCurtain(q, fx, flow, split, wind, tm, sheen);
  if (sheet.x > 0.0) col = mix(col, fallsWater(sheet, sheen, L, skyLight, glow), sheet.x);
  vec2 churn = fallsChurn(q, fallsFootX, fallsFootW, flow, tm);
  col = mix(col, fallsFoam(L, glow, churn.y), churn.x);
#endif
  return col;
}

// ---- the slot (the limestone gorge) ----
// Its walls are two vertical planes running from the back wall toward the eye on either side of the
// slot's axis, undulating where the water has carved them and leaning in toward the top. A point on
// screen at q lies on a wall at depth t (1 at the back wall, less nearer: the plane x = X / t) and
// height h = FALLS_EYE + (q.y - FALLS_EYE) * t, both measured on the back wall's scale, where the
// waterline is FALLS_POOL. Walking along a wall toward the eye, a unit of t is FALLS_SLOT_RUN screen
// heights of the back wall's scale, so the wall's face unrolls from the corner, its beds continuing
// the back wall's and running away to the vanishing point.
const float FALLS_SLOT_X = 0.06;   // the slot's axis, a little toward the fall...
const float FALLS_SLOT_W = 0.44;   // ...and its half-width at the waterline, on a 16:9 frame
const float FALLS_SLOT_RUN = 1.04; // FALLS_CLIFF_Z / FALLS_CLIFF_M

// How much of its 16:9 width the slot keeps on a narrower frame, so its walls stay in view.
float fallsSlotFit(float aspect) {
  return clamp(aspect / 1.78, 0.62, 1.0);
}

// The slot's half-width at height h and depth t on the side of the axis given: narrowing upward,
// bulging in and out along and up the wall.
float fallsSlotHalf(float h, float t, float side) {
  return FALLS_SLOT_W * (1.0 - 0.32 * smoothstep(FALLS_POOL, 0.95, h)) + 0.06 * (fbm3(vec2(h * 3.5 + side * 4.0, t * 2.2)) - 0.5);
}

// The top of a wall at depth t, on the back wall's scale: level with the back wall's rim.
float fallsSlotTop(float t, float side) {
  return 0.86 + 0.05 * (fbm3(vec2(t * 3.0 + side * 2.0, 9.0)) - 0.5);
}

// The wall seen at q on a frame fitted by fit (fallsSlotFit), if any: x the side (-1 left, 1 right,
// 0 none: the back wall shows), y its depth t, z the height h (below FALLS_POOL: the water in front of
// the wall; above fallsSlotTop: over it), w the wall's unrolled coordinate (the back wall's x at the
// corner).
vec4 fallsSlot(vec2 q, float fit) {
  float side = q.x < FALLS_SLOT_X * fit ? -1.0 : 1.0;
  float x = (FALLS_SLOT_X + side * FALLS_SLOT_W * 0.85) * fit;
  if (q.x * x <= 0.0) return vec4(0.0);
  float t = x / q.x;
  x = (FALLS_SLOT_X + side * fallsSlotHalf(FALLS_EYE + (q.y - FALLS_EYE) * t, t, side)) * fit;
  t = x / q.x;
  if (q.x * x <= 0.0 || t >= 1.0) return vec4(0.0);
  return vec4(side, t, FALLS_EYE + (q.y - FALLS_EYE) * t, x + side * (1.0 - t) * FALLS_SLOT_RUN);
}

// A slot wall's light: the camera-frame light turned into the wall's own frame (fallsRock's, the face
// toward -z), dimmed toward the water where the slot sees only a strip of sky and the sun reaches
// only the upper walls.
FallsLight fallsSlotLight(FallsLight L, vec4 slot) {
  vec3 along = vec3(0.0, 0.0, -slot.x);
  vec3 into = vec3(slot.x, 0.0, 0.0);
  FallsLight w = L;
  w.sun = vec3(dot(L.sun, along), L.sun.y, dot(L.sun, into));
  w.moon = vec3(dot(L.moon, along), L.moon.y, dot(L.moon, into));
  w.amb *= 0.6 + 0.4 * smoothstep(FALLS_POOL, 0.9, slot.z);
  w.sunCol *= smoothstep(0.45, 0.8, slot.z);
  return w;
}

// What the pool mirrors of a slot wall (slot at the mirrored height): its stone and beds, flat-lit.
vec3 fallsSlotMirror(vec4 slot, FallsLight L, vec3 haze, float rainWet) {
  if (slot.z > fallsSlotTop(slot.y, slot.x)) return haze;
  vec2 wq = vec2(slot.w, slot.z);
  float dsdy = 0.0;
  float s = fallsLayer(wq, dsdy);
  float c = floor(s);
  bool hard = s - c < fallsSplit(c, wq.x);
  float wet = smoothfall(FALLS_POOL + 0.035, FALLS_POOL, slot.z);
  vec3 stone = wetten(fallsStone(c, hard) * (0.72 + 0.45 * vnoise(wq * vec2(28.0, 46.0))) * mix(1.0, 0.5, wet), 0.85 * rainWet * (1.0 - wet), 0.25);
  return stone * fallsLit(fallsSlotLight(L, slot), vec3(0.0, 0.0, -1.0)) * (hard ? 1.0 : 0.8);
}

// ---- the gorge's state, per cell ----
// What every gorge layer reads, before any layer's own begin: the clocks, the passage, the frame
// point through the passage's lens shift (x.uv: everything below, projection and rain included, looks
// through the shifted frame), the light, the air and the rain.
void fallsBegin(Ctx x) {
  fallsTm = x.tm;
  fallsAspect = x.aspect;
  fallsArrive = passageIn();
  fallsLeave = passageOut();
  fallsUv = x.uv;
  fallsQ = vec2((fallsUv.x - 0.5) * fallsAspect, fallsUv.y);
  fallsRain = x.w.rain;
  fallsRainWet = uWeather.x;
  fallsWind = x.w.wind;
  fallsFx = fallsAt(fallsAspect);

  // Light, from the world's sky seen facing away from the sun (fallsWorld). Rain falls from the
  // world's overcast, which hides the sun and the moon alike and spreads their light into a flat grey
  // one from the whole sky: pale and bright for a drizzle, darker the heavier the rain.
  Sky sky = x.w.sky;
  fallsRayCam = viewRay(fallsUv, fallsAspect, FALLS_EYE, FALLS_FOV);
  fallsRay = fallsWorld(fallsRayCam);
  float overcast = x.w.overcast;
  FallsLight L;
  L.sun = fallsWorld(sky.sun);
  L.moon = fallsWorld(sky.moon);
  L.sunCol = sky.sunColor;
  L.moonCol = sky.moonColor * (1.0 - WORLD_DECK_SUN * overcast);
  L.amb = sky.ambient + (0.25 * sky.sunColor + 0.3 * L.moonCol) * overcast;
  // Night vision: as the light fails the eye adapts, so the scene below the sky is shaded with
  // the light scaled back up toward a readable level (the sky itself is left as the library paints
  // it) and its blue cast softened. fallsDark (0 by day .. 1 at night) brings in what shows only
  // after dusk: sky light along the ledges, the white water's soft glow, rain lit around the fall.
  // The gloom of heavy rain is the one darkness the eye does not adapt away.
  float lightLum = dot(L.amb, LUMA) + 0.6 * dot(L.sunCol, LUMA) + 0.5 * dot(L.moonCol, LUMA);
  float adapt = clamp(0.42 / max(lightLum, 0.01), 1.0, 6.0) * (1.0 - 0.45 * fallsRain);
  fallsDark = 1.0 - smoothstep(0.15, 0.5, lightLum);
  L.amb = greyed(L.amb, vec3(1.0), 0.3 * fallsDark) * adapt;
  L.sunCol *= adapt;
  L.moonCol *= adapt;
  fallsL = L;
  // What a glassy surface shows of the sky, the white water's own light after dark, and the haze
  // on the horizon (the fog's colour, the distance), greyed and dimmed under rain.
  fallsSkyLight = L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.35;
  fallsGlow = vec3(0.75, 0.88, 1.0) * dot(L.amb + 0.8 * L.moonCol, LUMA) * 0.5 * fallsDark;
  vec3 haze = skyColor(sky, fallsWorld(normalize(vec3(fallsRayCam.x, 0.04, 1.0))));
  fallsHaze = greyed(haze, vec3(1.0), 0.75 * overcast) * (1.0 - 0.55 * fallsRain);
  // The rain's air (the veil of drops too far off to make out; after dark it is lit like the
  // scene); the overcast's underside, the sky light under the deck greyed (drops, splashes and
  // puddles all show it); the light the drops catch: each refracts the bright overcast, so a drop
  // shows ~1.2x its cloud base, plus what sun gets through, never quite dark at night. Then how
  // hard the ledges and fronds drip: while it rains, and for a while after, as long as they are wet.
  fallsRainAir = mix(fallsHaze, 0.35 * fallsSkyLight, fallsDark);
  fallsCloudBase = mix(vec3(dot(L.amb, LUMA)), L.amb, 0.3) * 0.6 + 0.15 * L.moonCol;
  fallsRainLight = max(1.2 * fallsCloudBase + 0.3 * L.sunCol, vec3(0.08));
  fallsDripAmt = max(fallsRain, 0.4 * fallsRainWet);

  // Parallax: nearer layers slide further as the pointer moves.
  fallsQc = fallsQ - uPointer * vec2(0.006, 0.003);  // cliff, fall, pool and spray
  fallsQt = fallsQ - uPointer * vec2(0.003, 0.0015); // the woods upstream, through the notch
  fallsQb = fallsQ - uPointer * vec2(0.02, 0.008);   // the near bank
}

// Something the cell shows nearer than what the gorge drew last (a bird, a guest's grass) covers it:
// the sparkle of what lies behind goes with it, and the gorge draws on from there.
void fallsCovered(Cell c) {
  if (c.z < fallsZm) {
    fallsGlint = 0.0;
    fallsWhite = 0.0;
    fallsSpray = 0.0;
    fallsZm = c.z;
  }
}

// The veil of rain too fine and far to make out between the eye and a surface at this weatherDepth:
// rainFall's own for a level camera (shaders/lib/weather.ts), without its drops. The World veils
// what the cell shows; the pool's mirror image has crossed more rain than its surface (poolGround).
float fallsRainVeil(float depth) {
  float a = clamp(fallsRain, 0.0, 1.0);
  float gusty = smoothstep(0.25, 0.95, a) * (0.35 + 0.65 * abs(fallsWind));
  vec3 dir = rainFallDir(fallsRain, fallsWind);
  vec2 p = vec2((fallsUv.x - 0.5) * fallsAspect, fallsUv.y - 0.5);
  float across = p.x - p.y * dir.x / dir.y;
  float k = 0.22 * smoothstep(0.0, 0.12, a) + 0.3 * a + 0.87 * a * a * a;
  k *= 1.0 + gusty * (1.3 * weatherGust(across, mix(2.0, 22.0, depth), fallsTm, fallsWind) - 0.45);
  return 1.0 - exp(-k * depth * (0.4 + 0.6 * depth));
}
`;

/**
 * The cliff's GLSL (a backdrop): the rock of the gorge, the rim's trees and the woods upstream, the
 * fallen blocks, the carved M, the World's sky over the rim, the gorge's air and its rain's, and the
 * shimmer the gorge leaves in the dither.
 */
export const cliffGlsl = `
// ---- the cliff (falls/shader.ts) ----
// The Manifold M cut into the rock, centred at 'at', size its height. x: groove coverage (a
// chiselled, slightly wavering edge); y: light on the groove's floor (the upper wall shades the
// floor below it, the light coming from above); z: the lower wall, facing up into the light.
vec3 fallsMark(vec2 q, vec2 at, float size) {
  vec2 m = (q - at) / size;
  if (abs(m.x) > 0.7 || abs(m.y) > 0.7) return vec3(0.0);
  float d = markDistance(m) - 0.085 + (vnoise(m * 24.0) - 0.5) * 0.02;
  float groove = smoothfall(0.012, -0.004, d);
  float lit = smoothfall(0.01, -0.02, markDistance(m + vec2(0.01, 0.07)) - 0.085);
  float wall = smoothstep(-0.01, 0.01, markDistance(m - vec2(0.0, 0.035)) - 0.085);
  return vec3(groove, lit, wall * groove);
}

// Per cell: the rock the river has cut through and the M's parting, the cliff's skyline and which of
// its parts the cell shows; the gorge's air (its haze toward this bearing, the fog's colour, the
// drops' light, the bright sky wet things mirror). The site's floor ends at the waterline, at the
// pool's far edge.
void cliffBegin(inout Ctx x) {
  fallsSetGorge(K_gorge);
  fallsParting = K_cliffMark;
  vec2 qc = fallsQc;
  fallsRimY = fallsRim(qc.x, fallsFx, fallsParting);
  // The limestone slot's walls stand in front of the back wall at the sides, the woods over their tops.
  vec4 slot = fallsGeo.kind > 1.5 ? fallsSlot(qc, fallsSlotFit(fallsAspect)) : vec4(0.0);
  fallsSlotHit = slot;
  fallsSlotTopY = slot.x != 0.0 ? fallsSlotTop(slot.y, slot.x) : 0.0;
  fallsSlotWoods = slot.x != 0.0 ? 0.006 + 0.7 * fallsCrowns(slot.w, 0.05, 23.0) : 0.0;
  if (slot.x != 0.0 && slot.z >= FALLS_POOL && slot.z < fallsSlotTopY + fallsSlotWoods) {
    fallsPart = FALLS_AT_WALL;
  } else if (qc.y > fallsRimY) {
    // Above the cliff: trees along its top, the woods upstream through the notch, then the sky.
    float notch = 1.0 - smoothstep(0.17, 0.25, abs(qc.x - fallsFx));
    float lean = (0.002 + 0.004 * abs(fallsWind)) * sin(fallsTm * 0.5 + qc.x * 3.0);
    fallsTreesY = fallsRimY + (0.003 + fallsCrowns(qc.x - lean, 0.045, 1.0)) * (1.0 - notch);
    fallsWoodsY = FALLS_LIP + 0.028 + 0.02 * fbm3(vec2(fallsQt.x * 2.5, 8.0)) + 0.8 * fallsCrowns(fallsQt.x, 0.02, 7.0);
    fallsPart = qc.y < fallsTreesY ? FALLS_AT_TREES : qc.y < fallsWoodsY ? FALLS_AT_WOODS : FALLS_AT_SKY;
  } else {
    fallsPart = qc.y > FALLS_POOL ? FALLS_AT_CLIFF : FALLS_AT_POOL;
  }
  x.air = Air(fallsHaze, fallsHaze, fallsRainLight, fallsSkyLight, 0.0, FALLS_HAZE, 0.0);
  x.groundTo = FALLS_POOL + 0.003 * uPointer.y;
  x.landZ = FALLS_CAM * FALLS_FOCAL / (FALLS_EYE - FALLS_POOL);
}

// Over the rim the World's sky, seen half turned away from the sun (its frame exactly fallsWorld's):
// the dome; the aurora ahead of the camera, its arc lifted over the rim; the deck, broken cloud as the
// clouds knob has it and closing from there with the rain's overcast, sinking as it grows heavier
// (seen larger, being nearer), greyed and darker the heavier the rain, what it leaves open greyed by
// the world; the stars and shooting stars in its gaps; the lightning. The world turns its wind by the
// view's half turn (worldDeckDrift), so the deck drifts the way the rain slants.
void cliffSky(Ctx x, inout Cell c) {
  if (fallsPart != FALLS_AT_SKY) return;
  vec2 qc = fallsQc;
  WorldView view = worldViewOf(fallsRayCam, fallsUv, FALLS_EYE, FALLS_FOCAL, FALLS_CAM, 0.5 * TAU, 1.0);
  view.dir = fallsRay;
  view.auroraLift = FALLS_AURORA_LIFT;
  World world = x.w;
  world.cover = mix(K_clouds, 1.0, world.overcast);
  world.low = 1.0 + WORLD_DECK_LOW * world.storm;
  WorldSky heaven = worldSky(world, view, WORLD_METEOR_FIELD);
  vec3 col = mix(heaven.col, greyed(heaven.col, vec3(1.0), 0.6 * world.overcast) * (1.0 - 0.55 * world.storm), heaven.cloud) + heaven.strike;
  if (fallsRain > 0.0) {
    // Rain hangs from the deck in grey shafts behind the cliff, slanting downwind and sweeping
    // slowly across, thickest over the skyline and fading up into the cloud.
    float xs = qc.x + fallsWind * 0.4 * (qc.y - fallsRimY);
    float shaft = smoothstep(0.35, 0.75, fbm3(vec2(xs * 2.4 - fallsTm * (0.01 + 0.05 * fallsWind), 3.7)));
    float hang = 1.0 - smoothstep(0.0, 0.1 + 0.12 * fallsRain, qc.y - fallsRimY);
    float streaks = 0.75 + 0.25 * vnoise(vec2(xs * 26.0, qc.y * 3.0 + fallsTm * 0.4));
    col = mix(col, fallsRainAir, shaft * hang * streaks * (0.15 + 0.6 * fallsRain));
  }
  c.col = col;
}

// Below the sky: a slot wall or the woods over it, the trees on the rim, the woods upstream through
// the notch, or the cliff face with the ledge ferns (greenery), the carved M and the blocks heaped at
// its foot, each at its depth (the World's rain and fog stop there, its birds hide behind it).
void cliffFar(Ctx x, inout Cell c) {
  int part = fallsPart;
  if (part == FALLS_AT_SKY || part == FALLS_AT_POOL) return;
  vec2 qc = fallsQc;
  FallsLight L = fallsL;
  float tm = fallsTm;
  float green = fallsGreen;
  float rainWet = fallsRainWet;
  float dark = fallsDark;
  vec3 col = vec3(0.0);
  float zm = FALLS_CLIFF_Z;
  float glint = 0.0;
  float markAccent = 0.0;
  if (part == FALLS_AT_WALL) {
    vec4 slot = fallsSlotHit;
    if (slot.z < fallsSlotTopY) {
      // The wall, shaded as the back wall is in its own frame (fallsSlotLight), wet at its foot.
      vec2 wq = vec2(slot.w, slot.z);
      float dsdy = 0.0;
      float s = fallsLayer(wq, dsdy);
      float wet = smoothfall(FALLS_POOL + 0.035, FALLS_POOL, slot.z);
      vec3 rayWall = vec3(-slot.x * fallsRayCam.z, fallsRayCam.y, slot.x * fallsRayCam.x);
      col = fallsRock(wq, s, dsdy, rayWall, fallsSlotLight(L, slot), wet, rainWet, fallsDripAmt, fallsRainLight, green, dark, tm, uFallTime, glint);
    } else {
      // The woods leaning over the top of the wall, seen from below.
      float clump = 0.6 * vnoise(vec2(slot.w, slot.z) * vec2(60.0, 70.0)) + 0.4 * vnoise(qc * vec2(150.0, 160.0));
      vec3 leaf = wetten(mix(vec3(0.03, 0.08, 0.04), vec3(0.12, 0.24, 0.09), clump), rainWet, 0.5);
      col = leaf * fallsLit(L, normalize(vec3(clump - 0.5, -0.4, -1.0)));
    }
    zm = slot.y * FALLS_CLIFF_Z;
  } else if (part == FALLS_AT_TREES) {
    float clump = 0.6 * vnoise(qc * vec2(60.0, 70.0)) + 0.4 * vnoise(qc * vec2(150.0, 160.0));
    float up = clamp((qc.y - fallsRimY) / 0.07, 0.0, 1.0);
    vec3 leaf = wetten(mix(vec3(0.04, 0.1, 0.05), vec3(0.15, 0.29, 0.11), clump), rainWet, 0.5);
    col = leaf * fallsLit(L, normalize(vec3(clump - 0.5, 0.2 + 0.6 * up, -1.0))) * (0.55 + 0.6 * up);
    zm = 31.0;
  } else if (part == FALLS_AT_WOODS) {
    float clump = vnoise(fallsQt * vec2(90.0, 100.0));
    vec3 leaf = wetten(mix(vec3(0.05, 0.11, 0.07), vec3(0.13, 0.22, 0.12), clump), rainWet, 0.5);
    col = mix(leaf * fallsLit(L, vec3(0.0, 0.5, -0.866)), fallsHaze, 0.45);
    zm = 90.0;
  } else {
    // The cliff face.
    float dsdy = 0.0;
    float s = fallsLayer(qc, dsdy);
    float flow = fallsFlow;
    float wind = fallsWind;
    FallsLight Lr = L;
#if LAYER_FALLS
    float d = FALLS_LIP - qc.y;
    float beside = abs(qc.x - fallsCentre(d, fallsFx, flow, wind)) - fallsHalfWidth(d, flow);
    // Spray soaks the rock beside the fall, widest near the foot, and the pool wets the base (the
    // rain's wetness is fallsRock's own).
    float foot = smoothfall(FALLS_POOL + 0.3, FALLS_POOL, qc.y);
    float wet = exp(-max(beside, 0.0) / (0.02 + 0.05 * flow + 0.14 * foot * fallsMistAmount)) * smoothstep(-0.04, 0.0, d);
    wet = max(wet, smoothfall(FALLS_POOL + 0.035, FALLS_POOL, qc.y));
    // The sheet is thrown clear of the rock (it leaves the lip at v0) and shades it from the sun
    // behind the viewer: step toward the sun as far as the sheet's plane and look there.
    float v0 = fallsV0(flow);
    vec2 toward = qc + L.sun.xy * ((v0 * fallsTau(d, v0) + 0.008) / max(-L.sun.z, 0.25));
    float td = FALLS_LIP - toward.y;
    float shade = smoothfall(1.05, 0.7, abs(toward.x - fallsCentre(td, fallsFx, flow, wind)) / fallsHalfWidth(td, flow)) * step(0.0, td);
    Lr.sunCol *= 1.0 - shade * (0.5 + 0.4 * flow);
    Lr.amb *= 1.0 - 0.35 * smoothfall(0.0, -0.02, beside) * step(0.0, d);
#else
    // No water comes over: only the pool wets the base.
    float wet = smoothfall(FALLS_POOL + 0.035, FALLS_POOL, qc.y);
#endif
    Lr = fallsSlotShade(Lr, qc.y);
    col = fallsRock(qc, s, dsdy, fallsRayCam, Lr, wet, rainWet, fallsDripAmt, fallsRainLight, green, dark, tm, uFallTime, glint);
#if LAYER_GREENERY
    if (green > 0.0) {
      // The fall's draught stirs the ferns beside it.
#if LAYER_FALLS
      float draught = exp(-max(beside, 0.0) / 0.08) * (0.3 + 0.7 * flow);
#else
      float draught = 0.0;
#endif
      float ledgeTip = 0.0;
      float ledgeFern = fallsFerns(qc, s, dsdy, green, 0.06 + 0.2 * abs(wind) + 0.12 * draught, tm, ledgeTip);
      if (ledgeFern > 0.0) {
        vec3 frond = wetten(mix(vec3(0.06, 0.17, 0.05), vec3(0.3, 0.5, 0.15), 0.3 + 0.55 * ledgeTip), rainWet, 0.4);
        col = mix(col, frond * fallsLit(Lr, normalize(vec3(0.0, 0.4, -1.0))), ledgeFern);
        glint *= 1.0 - ledgeFern;
      }
    }
#endif
    if (fallsParting > 0.0) {
      // The carved M: its smooth wet floor holds the mist's light, its lower walls catch the sky.
      vec3 mk = fallsMark(qc, vec2(fallsFx, FALLS_LIP - 0.215), 0.15);
      if (mk.x > 0.0) {
        vec3 held = FALLS_CYAN * (L.amb * 1.5 + L.sunCol * 0.3 + L.moonCol * 0.5);
        col = mix(col, col * mix(0.35, 0.75, mk.y) + held * (0.12 + 0.3 * mk.y + 0.35 * mk.z), mk.x);
        markAccent = mk.x * (0.5 + 0.35 * mk.y + 0.15 * mk.z);
      }
    }
    // Blocks fallen from the cliff, heaped along its foot with scree.
    if (qc.y < FALLS_POOL + 0.075) {
      vec3 bn = vec3(0.0, 0.0, -1.0);
      float bk = 0.0;
      float bh = 0.0;
      float block = fallsBoulders(qc, fallsFootX, fallsFootW, bn, bk, bh);
      if (block > 0.0) {
        col = mix(col, fallsBlock(qc, bn, bk, bh, Lr, fallsSkyLight, wet, rainWet, green, dark), block);
        // Drops burst on their tops (at ~19 cells to the metre the crowns are 3-6 cells across),
        // left out on screens too small for them to read.
        if (fallsRain > 0.0) col = mix(col, fallsRainLight, rainSplashes(qc * FALLS_CLIFF_M, uFallTime, fallsRain) * smoothstep(0.25, 0.6, bn.y) * step(0.5, block) * smoothstep(12.0, 16.0, uRes.y / FALLS_CLIFF_M));
        glint *= 1.0 - block;
      }
    }
  }
  c.col = col;
  c.z = zm;
  c.zs = zm;
  c.accent = markAccent;
  fallsGlint = glint;
  fallsZm = zm;
}

// The air the far rain fuses into (the backdrop's precip air): the rain's grey, lit after dark like
// the gorge, and round the fall by the white water's glow (fallsAir).
vec3 cliffRainAir(Ctx x) {
  return fallsRainAir + fallsGlow * 1.5 * fallsHaloM;
}

// The dither's shimmer, re-rolled several times a second, wherever the gorge left something to
// sparkle: wet rock and rippled water catching the light, white water, spray. None behind the near
// bank or anything nearer than the gorge's own; most of it held back while the camera moves.
void cliffShade(Ctx x, Cell c, inout Shade o) {
  fallsCovered(c);
  float keep = 1.0 - fallsFront;
  float glint = fallsGlint * keep;
  float white = fallsWhite * keep;
  float spray = fallsSpray * keep;
  float moving = max(1.0 - smoothstep(0.0, 0.85, fallsArrive), smoothstep(0.0, 0.3, fallsLeave));
  o.shimmer = clamp(0.6 * glint + 0.15 * white + 0.35 * spray, 0.0, 1.0) * (1.0 - 0.6 * moving);
}
`;

/** The pool's GLSL (a ground): the plunge pool and its mirror, the fireflies over it, the near bank. */
export const poolGlsl = `
// ---- the plunge pool and the near bank (falls/shader.ts) ----
// Fireflies over the pool: each drifts on its own slow loop at its own height over the water and
// glows up and dies away every few seconds (a smooth pulse, never a per-frame flicker), a warm
// point with a soft halo; its reflection lies straight below it, as far under the surface as it
// is above, drawn out by the ripples. Perspective sizes them: nearer flies, lower on the screen,
// are larger. Returns the light they add.
vec3 fallsFireflies(vec2 q, float aspect, float tm, float count) {
  vec3 light = vec3(0.0);
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float hx = hash12(vec2(fi, 71.0));
    float hy = hash12(vec2(fi, 72.0));
    float hz = hash12(vec2(fi, 73.0));
    float ground = 0.05 + 0.19 * hy;
    float scale = (FALLS_EYE - ground) / (FALLS_EYE - 0.1);
    float x = (hx - 0.5) * aspect * 0.9 + 0.06 * scale * sin(tm * (0.11 + 0.08 * hz) + fi * 2.3);
    float alt = scale * (0.025 + 0.06 * hz) * (1.0 + 0.25 * sin(tm * 0.23 + fi * 4.1));
    float r = 0.0042 * scale + 0.0022;
    vec2 up = q - vec2(x, ground + alt);
    vec2 down = (q - vec2(x, ground - alt)) * vec2(1.0, 0.4);
    if (min(dot(up, up), dot(down, down)) > 196.0 * r * r) continue;
    float wave = 0.5 + 0.5 * sin(tm * (1.2 + 1.1 * hx) + fi * 1.7);
    float pulse = 0.1 + 0.9 * wave * wave * wave;
    float du = length(up) / r;
    float dd = length(down) / r;
    light += pulse * (vec3(1.0, 0.95, 0.62) * 1.3 * exp(-du * du) + vec3(0.95, 0.75, 0.24) * 0.32 * exp(-du * 0.33)
                    + vec3(1.0, 0.9, 0.5) * 0.6 * exp(-dd * dd) + vec3(0.9, 0.7, 0.22) * 0.12 * exp(-dd * 0.4));
  }
  return light;
}

// How many fireflies (0: none).
void poolBegin(inout Ctx x) {
  fallsFlies = K_poolFireflies;
}

// The plunge pool: a level plane with the camera one unit (its own height) above it. Depth along the
// view and distance across put the ripples and foam in perspective. Without the falls it lies still
// but for the wind and the rain.
void poolGround(Ctx x, inout Cell c) {
  if (fallsPart != FALLS_AT_POOL) return;
  vec2 qc = fallsQc;
  FallsLight L = fallsL;
  float tm = fallsTm;
  float flow = fallsFlow;
  float wind = fallsWind;
  float rain = fallsRain;
  float dark = fallsDark;
  vec3 skyLight = fallsSkyLight;
  vec4 slot = fallsSlotHit;
  float focal = 0.5 / tan(0.5 * FALLS_FOV);
  float depth = focal / max(FALLS_EYE - qc.y, 0.01);
  float back = focal / (FALLS_EYE - FALLS_POOL);
  vec2 P = vec2(qc.x * depth / focal, depth);
  vec2 rel = P - vec2(fallsFootX * back / focal, back - 0.6);
  float r = length(rel);
  // Toward the far edge the plane is squeezed into a few cells: there the surface detail fades
  // to a still mirror (as distant water looks at a grazing angle) instead of crawling. detail
  // follows the on-screen size of one ring wavelength.
  float detail = smoothstep(0.004, 0.012, focal * 1.14 / (depth * depth));
  // Rings running out from the plunge.
  float phase = r * 5.5 - tm * 2.4;
  float rings = exp(-r * 0.2) * (0.3 + 0.7 * flow) * detail * FALLS_POUR;
  vec2 slope = rel / max(r, 0.001) * cos(phase) * rings;
  // Wind ruffles.
  vec2 wp = P * vec2(1.4, 0.8) + vec2(tm * 0.3 * wind, tm * 0.12);
  slope += (vec2(vnoise(wp), vnoise(wp + 17.0)) - 0.5) * (0.2 + 0.7 * abs(wind)) * detail;
  // Raindrop rings: few and wide in a drizzle, crowding in smaller as the rain thickens. Being
  // smaller than the plunge's rings, they give way to the still mirror sooner.
  float ringScale = mix(2.5, 4.5, rain);
  vec3 drops = rainRipples(P * ringScale, uFallTime, rain) * smoothstep(0.004, 0.012, focal * 0.9 / (ringScale * depth * depth));
  slope += drops.xy;
  // The mirror image: a vertical cliff at the pool's far edge reflects about the waterline
  // exactly; the tilted surface smears it, mostly up and down.
  vec2 mq = vec2(qc.x + slope.x * 0.012, 2.0 * FALLS_POOL - qc.y + slope.y * 0.03);
  // In front of a slot wall the water mirrors the wall, about the waterline at the wall's depth.
  vec3 mirror = slot.x != 0.0
    ? fallsSlotMirror(vec4(slot.xy, 2.0 * FALLS_POOL - slot.z + slope.y * 0.03 * slot.y, slot.w + slope.x * 0.012 * slot.y), L, fallsHaze, fallsRainWet)
    : fallsMirror(mq, L, skyLight, fallsGlow, fallsFx, flow, fallsGreen, fallsParting, wind, fallsRainWet, dark, tm);
  // Schlick's Fresnel: a mirror at grazing angles far off, dark water underfoot.
  float fresnel = fresnelSchlick(-fallsRayCam.y + slope.y * 0.03, 0.02, 0.02);
  float aerated = exp(-r * 0.35) * (0.35 + 0.65 * flow) * FALLS_POUR;
  vec3 body = mix(vec3(0.012, 0.035, 0.035), vec3(0.08, 0.27, 0.26), aerated) * (L.amb * 1.3 + L.sunCol * 0.45 + L.moonCol * 0.4);
  vec3 col = mix(body, mirror * 0.92, fresnel);
  float crest = smoothstep(0.75, 1.0, sin(phase)) * rings;
  col += skyLight * (crest * (0.12 + 0.2 * dark) + drops.z * (0.25 + 0.2 * rain));
  // Facets of the ruffled water tipped toward the viewer catch the open sky.
  col += skyLight * smoothstep(0.1, 0.35, slope.y) * (0.03 + 0.1 * dark) * detail;
  // The rings sparkle, less as they crowd in heavy rain (the shimmer is re-rolled several times
  // a second and would boil across the whole pool).
  float glint = crest * 0.3 + drops.z * 0.5 * (1.0 - 0.5 * rain);
  // Foam rafts carried out from the plunge, stretching sideways as they spread.
  float ang = atan(rel.x, -rel.y);
  vec2 fp = vec2(ang * 2.8, r * 0.7 - tm * 0.2);
  float raft = smoothstep(0.52, 0.74, 0.65 * vnoise(fp) + 0.35 * mix(0.5, vnoise(fp * 2.1 + 5.0), detail) + 0.3 * exp(-r * 0.5)) * exp(-r * 0.12) * (0.3 + 0.7 * flow) * FALLS_POUR;
  col = mix(col, fallsFoam(L, fallsGlow, 0.7), raft * 0.85);
  float mirrorW = 0.92 * fresnel * (1.0 - 0.85 * raft);
  float zm = FALLS_CAM * depth;
  // The pool's reflection crossed the rain all the way from the cliff: veil it as the cliff is
  // (the veil's optical depth goes as depth * (0.4 + 0.6 * depth)). The eye's own stretch to the
  // water is veiled with everything else by the World.
  if (rain > 0.0 && mirrorW > 0.0) {
    float rainDepth = 1.0 - exp(-zm / FALLS_RAIN_Z);
    float cliff = 1.0 - exp(-FALLS_CLIFF_Z / FALLS_RAIN_Z);
    float beyond = cliff * (0.4 + 0.6 * cliff) / (rainDepth * (0.4 + 0.6 * rainDepth)) - 1.0;
    col += mirrorW * (1.0 - pow(max(1.0 - fallsRainVeil(rainDepth), 1e-4), max(beyond, 0.0))) * (fallsRainAir - mirror);
  }
  c.col = col;
  c.z = zm;
  fallsGlint = glint;
  fallsWhite = raft * 0.6;
  fallsZm = zm;
}

// The fireflies over the pool from dusk on, glowing over whatever the cell shows; then the near
// bank: dark boulders along the bottom of the frame, soaked in the rain; puddles in the hollows of
// their tops mirror the sky, and drops burst on them. Nothing of it over what stands nearer.
void poolFront(Ctx x, inout Cell c) {
  fallsCovered(c);
  Sky sky = x.w.sky;
  float dusk = clamp(sky.night + 0.8 * sky.twilight, 0.0, 1.0) * (1.0 - sky.day) * (1.0 - 0.7 * fallsRain);
  if (fallsFlies > 0.0 && dusk > 0.0 && fallsQ.y < 0.42) {
    c.col += fallsFireflies(fallsQ - uPointer * vec2(0.01, 0.005), fallsAspect, fallsTm, 4.0 + 10.0 * fallsFlies) * dusk;
  }
  vec2 qb = fallsQb;
  if (qb.y >= 0.3 || c.z <= FALLS_BANK_Z) return;
  float edgeness = smoothstep(0.15, 1.0, abs(qb.x) / max(0.5 * fallsAspect, 0.3));
  float bankTop = 0.018 + 0.025 * fbm3(vec2(qb.x * 4.0, 2.0)) + 0.1 * edgeness * edgeness + fallsCrowns(qb.x + 0.37, 0.11, 13.0) * (0.12 + 0.5 * edgeness);
  if (qb.y >= bankTop) return;
  float green = fallsGreen;
  float rainWet = fallsRainWet;
  float grain = 0.6 * vnoise(qb * 40.0) + 0.4 * vnoise(qb * 110.0);
  float top = smoothstep(bankTop - 0.025, bankTop, qb.y);
  vec3 n = normalize(vec3((grain - 0.5) * 0.6, 0.15 + 0.8 * top, -1.0));
  float moss = top * smoothstep(0.55 - 0.4 * green, 0.7 - 0.4 * green, grain) * smoothstep(0.0, 0.15, green);
  vec3 stone = wetten(vec3(0.15, 0.14, 0.13) * (0.6 + 0.6 * grain), rainWet, 0.2);
  vec3 col = mix(stone, wetten(vec3(0.1, 0.22, 0.07), rainWet, 1.0), moss) * fallsLit(fallsL, n) * 0.85;
  if (rainWet > 0.0) {
    // Pools a few times smaller than the library's, to fit the stones' tops; the top is seen
    // foreshortened, so stretched in y. They mirror the overcast, brighter than the stone.
    float bare = 1.0 - moss;
    float puddle = rainPuddles(vec2(qb.x, (qb.y - bankTop) * 3.0) * (6.0 * FALLS_BANK_M), rainWet) * top * bare;
    col = mix(col + fallsSkyLight * 0.3 * wetGloss(rainWet, n.y) * bare, fallsCloudBase, puddle);
  }
  // Splash crowns, a third of the library's size: this near (~160 cells to the metre) true-size
  // crowns would be 25-50 cells across; these are 8-16.
  if (fallsRain > 0.0) col = mix(col, fallsRainLight, rainSplashes(qb * (3.0 * FALLS_BANK_M), uFallTime, fallsRain) * top);
  c.col = col;
  c.z = FALLS_BANK_Z;
  c.zs = FALLS_BANK_Z;
  c.accent = 0.0;
  fallsFront = 1.0;
  fallsZm = FALLS_BANK_Z;
}
`;

/** The falls' GLSL (a dressing): the falling sheet, the plunge, their glow after dark. */
export const fallsWaterGlsl = `
// ---- the falling water (falls/shader.ts) ----
// The flow, and where the sheet's foot meets the pool.
void fallsWaterBegin(inout Ctx x) {
  fallsFlow = K_flow;
  float drop = FALLS_LIP - FALLS_POOL;
  fallsFootX = fallsCentre(drop, fallsFx, fallsFlow, fallsWind);
  fallsFootW = fallsHalfWidth(drop, fallsFlow);
}

// The falling water over the rock (a slot wall in front hides it), then the plunge where it lands.
void fallsMiddle(Ctx x, inout Cell c) {
  vec2 qc = fallsQc;
  FallsLight L = fallsL;
  vec4 slot = fallsSlotHit;
  if (qc.y > FALLS_POOL && qc.y < FALLS_LIP + 0.012) {
    float sheen = 0.0;
    vec4 sheet = fallsCurtain(qc, fallsFx, fallsFlow, fallsParting, fallsWind, fallsTm, sheen);
    if (slot.x != 0.0) sheet.x = 0.0;
    if (sheet.x > 0.0) {
      vec3 water = fallsWater(sheet, sheen, L, fallsSkyLight, fallsGlow);
      // Where it curves over the lip the water mirrors the sky in one bright line.
      water += fallsSkyLight * 0.6 * exp(-abs(FALLS_LIP - qc.y + 0.002) / 0.004) * max(1.0 - sheet.w * sheet.w, 0.0);
      c.col = mix(c.col, water, sheet.x);
      fallsWhite = sheet.x * sheet.y;
      fallsGlint *= 1.0 - sheet.x;
      c.accent *= 1.0 - 0.85 * sheet.x;
    }
  }
  vec2 churn = slot.x != 0.0 ? vec2(0.0) : fallsChurn(qc, fallsFootX, fallsFootW, fallsFlow, fallsTm);
  fallsChurnX = churn.x;
  if (churn.x > 0.0) {
    c.col = mix(c.col, fallsFoam(L, fallsGlow, churn.y), churn.x);
    fallsWhite = max(fallsWhite, churn.x);
    fallsGlint *= 1.0 - churn.x;
  }
}

// After dark the white water's soft bloom in the air about it and in the pool, under whatever of the
// near bank stands in front; and its light in the rain around the fall, in the spray most.
void fallsAir(inout Ctx x, inout Cell c) {
  float halo = fallsDark > 0.0 ? fallsHalo(fallsQc, fallsFx, fallsFlow, fallsWind) : 0.0;
  float keep = 1.0 - fallsFront;
  fallsHaloM = halo * keep;
  c.col += fallsGlow * fallsHaloM;
  x.air.drop += fallsGlow * (3.0 * fallsHaloM + 2.0 * fallsMistA * keep);
}
`;

/** The spray's GLSL (a dressing): the spray from the plunge and off the sheet, and the rainbow in it. */
export const sprayGlsl = `
// ---- the spray and the rainbow (falls/shader.ts) ----
float fallsLobe(float k, float c, float w) {
  float z = (k - c) / w;
  return max(1.0 - z * z, 0.0);
}

// The rainbow's colours across one band, k = 0 violet to 1 red: overlapping lobes shaped roughly
// like the CIE 1931 colour-matching functions (red's small second lobe in the violet included).
vec3 fallsSpectrum(float k) {
  vec3 c = vec3(fallsLobe(k, 0.8, 0.3) + 0.3 * fallsLobe(k, 0.06, 0.12), fallsLobe(k, 0.52, 0.26), fallsLobe(k, 0.18, 0.24));
  return c * smoothstep(-0.12, 0.04, k) * smoothfall(1.12, 0.96, k);
}

// How much spray: held low until the camera has come down, then rising; at the exit it surges up.
void sprayBegin(inout Ctx x) {
  fallsMistAmount = K_spray * (1.0 - 0.75 * (1.0 - smoothstep(0.3, 0.9, fallsArrive))) * (1.0 + 0.9 * fallsLeave * fallsLeave);
}

// Spray: the plume and fans from the plunge, and spray hugging the lower sheet and its frayed edges,
// lit from the front by the sun or moon behind the viewer and by the whole sky; it carries the
// accent over the dark rock. Then the rainbow, wherever spray hangs in sunlight. Light refracted into
// a drop, reflected once inside and refracted out leaves it at most ~42 degrees from the antisolar
// point (Descartes' minimum deviation: red outermost at 42.3, violet at 40.6); reflected twice it
// makes the fainter secondary bow at 50.4-53.6 with the colours reversed. Between the two the sky is
// darker (Alexander's band), inside the primary brighter.
void sprayMiddleVeil(Ctx x, inout Cell c) {
  fallsCovered(c);
  vec2 qc = fallsQc;
  FallsLight L = fallsL;
  float flow = fallsFlow;
  float wind = fallsWind;
  float density = fallsMist(qc, fallsFootX, fallsFootW, flow, fallsMistAmount, wind, fallsTm);
  float fallen = FALLS_LIP - qc.y;
  float spray = 0.0;
  if (fallen > 0.1 && qc.y > FALLS_POOL - 0.03) {
    float off = abs(qc.x - fallsCentre(fallen, fallsFx, flow, wind)) - fallsHalfWidth(fallen, flow);
    spray = exp(-max(off, 0.0) / (0.015 + 0.03 * flow)) * smoothstep(0.12, 0.5, fallen) * (0.12 + 0.3 * flow);
    density += spray;
  }
  fallsSpray = clamp(spray + 0.5 * fallsChurnX, 0.0, 1.0);
  float mistA = (1.0 - exp(-density * 2.2)) * 0.92;
  fallsMistA = mistA;
  if (mistA > 0.002) {
    vec3 mistCol = FALLS_MIST * (L.amb * 1.25 + L.sunCol * 0.55 + L.moonCol * 0.6);
    float under = clamp(dot(c.col, LUMA), 0.0, 1.0);
    c.col = mix(c.col, mistCol, mistA);
    c.accent = max(c.accent, mistA * 0.6 * (1.0 - 0.7 * under));
  }
  if (K_rainbow > 0.0 && density > 0.0) {
    float ang = acos(clamp(dot(fallsRayCam, -L.sun), -1.0, 1.0)) * FALLS_DEG;
    vec3 bow = fallsSpectrum((ang - 40.6) / 1.8) + 0.4 * fallsSpectrum((53.6 - ang) / 3.2);
    float bowLit = K_rainbow * (1.0 - exp(-density * 1.6)) * smoothstep(0.0, 0.15, -L.sun.z);
    float alexander = smoothstep(42.2, 43.2, ang) * smoothfall(50.6, 49.6, ang);
    c.col = c.col * (1.0 - bowLit * (0.3 * max(bow.r, max(bow.g, bow.b)) + 0.12 * alexander)) + (bow * 0.6 + 0.08 * smoothfall(41.0, 30.0, ang)) * L.sunCol * bowLit;
  }
}
`;

/** The greenery's GLSL (a cover): the near bank's ferns (the moss and the ledge ferns are the cliff's to draw, at fallsGreen). */
export const greeneryGlsl = `
// ---- the moss and ferns (falls/shader.ts) ----
// Ferns on the near bank: up to four clumps toward the corners (more with more greenery), fronds
// rising and arching over: the plant component's fronds, rooted, grown and bent by the wind in the
// sim (sim.ts: the layer's rows of the records atlas hold FALLS_CLUMPS × FALLS_FRONDS records, clump
// by clump; a missing or shed frond's tier is 0). Returns coverage; tip as for fallsFerns, pheno the
// year's turn of the frond in front.
// wet (how wet the rain has left them) hangs beads of water under the leaflets' tips: bead 0..1.
// drip finds the nearest frond overhead, for the water dripping off it: x along that frond, y how
// far below it (screen heights), z 1 if there is one. foot: a cell in screen heights.
// grow (1 at rest) scales the fronds and slides the clumps in from the frame's edge: the entrance
// springs them up past 1 and back, standing upright at first and arching over as they grow.
const int FALLS_CLUMPS = ${FALLS_CLUMPS};
const int FALLS_FRONDS = ${FALLS_FRONDS};
float fallsBankFerns(vec2 q, float wet, float grow, float foot, out float tip, out float pheno, out float bead, out vec3 drip) {
  tip = 0.0;
  pheno = 0.0;
  bead = 0.0;
  drip = vec3(0.0, 1.0, 0.0);
  float cover = 0.0;
  float len = 1.0;   // the frond in front: its length, how far below its spine q lies, its key
  float under = 0.0;
  float key = 0.0;
  if (!greenerySimOn()) return 0.0;
  float g = clamp(grow, 0.0, 1.0);
  for (int r = 0; r < FALLS_CLUMPS * FALLS_FRONDS; r++) {
    PlantOrgan o = plantOrgan(greeneryAtlas, greeneryRow, r);
    if (o.tier < 0.5) continue;
    vec2 root = o.at + vec2(sign(o.at.x) * 0.08 * (1.0 - g), 0.0);
    float lj = o.len * grow;
    vec2 rel = q - root;
    if (dot(rel, rel) > lj * lj * 4.0) continue;
    float u = 0.0;
    float uj = 0.0;
    // The spring's turn of the frond lifts (or lowers) its tip: its bend in frond lengths.
    float bend = o.side * o.bend * length(vec2(1.0, o.a - o.b));
    float frond = plantFrond(rel, o.side, lj, o.a, o.b * (1.0 - 0.6 * (1.0 - g)), bend, foot, u, uj);
    if (frond > cover) {
      cover = frond;
      tip = u;
      len = lj;
      under = uj;
      key = o.variant;
      pheno = o.pheno;
    }
    // The water runs out along the frond and drips off its outer, drooping part, down to the
    // ground the clump grows from.
    if (u > 0.35 && uj > 0.0 && uj < drip.y && q.y > root.y - 0.03) drip = vec3(u * lj + 0.61 * o.variant, uj, 1.0);
  }
  if (wet > 0.0 && cover > 0.0) {
    // One leaflet in a few holds a bead under its tip (the leaflets peak at u = (k + 0.5) pi / 23).
    float k = floor(tip * 7.32);
    float uk = (k + 0.5) / 7.32;
    vec2 v = vec2((tip - uk) * len, under - 0.75 * (len * 0.17 * (1.0 - uk) + 0.0011));
    bead = smoothfall(0.0035, 0.0015, length(v)) * step(hash12(vec2(k, key + 0.5)), 0.2 + 0.6 * wet) * wet;
  }
  return cover;
}

// How green the gorge grows: moss on the ledges, the wet rock, the blocks and the bank, ferns and
// creepers hanging from the ledges (the cliff and the pool draw them), ferns on the near bank.
void greeneryBegin(inout Ctx x) {
  fallsGreen = K_greenery;
}

// The near bank's ferns toward the corners (skipped in the open middle), springing up as the scene
// arrives, and the water dripping off their fronds in front of the stones and behind the nearer
// fronds, beads of it on the leaflets catching the sky. Nothing of them over what stands nearer.
void greeneryFront(Ctx x, inout Cell c) {
  fallsCovered(c);
  vec2 qb = fallsQb;
  float fernGrow = fallsSpring((fallsArrive - 0.5) / 0.4);
  if (!(fallsGreen > 0.0 && fernGrow > 0.01 && qb.y < 0.45 && abs(qb.x) > 0.47 * fallsAspect - 0.45) || c.z <= FALLS_FERN_Z) return;
  float tip = 0.0;
  float fernPheno = 0.0;
  float bead = 0.0;
  vec3 fernDrip = vec3(0.0);
  float fern = fallsBankFerns(qb, fallsRainWet, fernGrow, 1.0 / uRes.y, tip, fernPheno, bead, fernDrip);
  if (fernDrip.z > 0.0 && fallsDripAmt > 0.0) c.col = mix(c.col, fallsRainLight, rainDrips(fernDrip.xy * FALLS_FERN_M, uFallTime, fallsDripAmt, 0.07));
  if (fern > 0.0) {
    vec3 frond = wetten(plantPhenology(mix(vec3(0.04, 0.12, 0.04), vec3(0.22, 0.4, 0.12), 0.25 + 0.6 * tip), fernPheno), fallsRainWet, 0.4);
    c.col = mix(c.col, mix(frond * fallsLit(fallsL, normalize(vec3(0.0, 0.6, -1.0))), fallsRainLight, bead), fern);
    c.accent *= 1.0 - fern;
    fallsFront = max(fallsFront, fern);
    if (fern > 0.5) {
      c.z = FALLS_FERN_Z;
      c.zs = FALLS_FERN_Z;
      fallsZm = FALLS_FERN_Z;
    }
  }
}
`;
