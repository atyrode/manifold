// The Autumn park preset's layers' GLSL (ADR 0062 Phase 2a; the composer: src/composer, README
// "Composers"): a park in autumn, late afternoon, seen through the park's rig (constants.ts
// AUTUMN_RIG: horizon 0.36, focal 1, the eye 1.5 m up, laid out at least 1.45 wide). Its parts, each
// a layer, drawn in the order the park always painted them:
//   parkland  (backdrop) the World's sky over the park (the deck greyed by the rain, rain shafts
//             under it) and three rows of far crowns in haze; the park's air (the haze toward each
//             bearing, greyed under the deck; the drops' light); the land runs to the horizon.
//   parkPath  (ground) the lawn and the gravel path (worn pale down its middle, wet and pooled in
//             rain, rings spreading in the pools, splashes close by) with a mottle of finer litter
//             that thickens with the season, the key light's long shadows (the trunk's, the lamp
//             post's, the bench's, the canopy's dapple) and the contact shadows where things stand.
//   lamp      (dressing) the cast-iron lamp post beside the path; its glass lit as the day fades or a
//             storm darkens it, its warm pool on the ground and the leaves (a declared light for
//             every guest layer, autumnLampLight for the park's own), its halo in the air.
//   maple     (dressing, the subject) the bench on the lawn, the great tree (maple, ginkgo or oak:
//             its canopy as a solid mass and three layers of leaf sprites at three depths, back and
//             mid behind the trunk, the front layer before it; its trunk and boughs between them),
//             and the colours of its leaves in the air (mapleLeafSpeck): the leaves are the composer's
//             falling things (sim.ts, composer/falling.ts), each a plate the simulation tumbles drawn
//             cell by cell in the speck map, two-toned (its paler underside shows when it turns
//             over), hidden by depth behind the canopy's layers, the trunk and the bench nearer.
//   litter    (cover) the carpet of fallen leaves (one leaf per lattice cell in two layers, from the
//             simulation) lying on the lawn and the path, the gold leaves of the M among them.
// Everything that moves cuts its edges per cell (hardFill / hardEdge) so it never shimmers: leaves,
// sprites, the dapple. The park keeps its own light (autumnBegin): the World's sun (or, once it has
// set, its moon, dimmed by the rain's deck) lifted a little so that shadows still reach the path, the
// sky's light a little warmer and flatter; the sun stands behind the scene, so leaves are lit from
// behind and glow. Guest layers take the composer's light, graded to match (AUTUMN_GRADE).
//
// What the park keeps of its own, and what is the composer's: the World's weather falls at the
// composed depth (worldFog, worldPrecip in the park's air: the rain's veil in the haze, its drops in
// the sky's light and the sun's); the gusts are the composer's one gust field (gustAt, ADR 0062 D4):
// the canopy sways and its dapple shifts by the field's load at the canopy, the leaves in the air are
// pushed by it where they are (sim.ts). The passage is the park's: the rig's lens shift (rigShift,
// raised into the canopy at the start of the entrance, tilting up into it at the exit), the canopy
// leaning before the passage's gust, the leaves it blows from the simulation; all exactly off at rest.
//
// The shared parts (autumnSharedGlsl, every drawing layer's; autumnFloorGlsl, the ground's and the
// litter's) read the other layers' gates, LAYER_MAPLE and LAYER_LAMP, so a park without its tree
// keeps the maple's palette and casts no tree's shadow, and one without its lamp no lamp's light.
// The tree's species is the maple's (K_species), the season the composer's (K_season), the
// arrangement the composer's seed (K_seed). Data: the litter's two fields (the carpet's layers,
// litterField0/1).
import { autumnLayoutGlsl } from "./layout.ts";

/**
 * The park's shared GLSL, held by every layer that draws: the layout, the light and the season each
 * cell takes (autumnBegin), the leaves' shapes and colours, the key light's shadows, the lamp's pool,
 * and how a thing standing in the park is drawn over the cell (autumnStand).
 */
export const autumnSharedGlsl = `
// ---- the park (autumn/shader.ts), shared by its layers ----
${autumnLayoutGlsl}
const float AUTUMN_FOV = 0.9272952;   // 2 atan(0.5 / focal) for focal 1
// The cloud deck's base over the park (m): its shadows', at a height that sends a shadow's edge across
// the park in a few seconds in a breeze.
const float AUTUMN_CLOUD_BASE = 300.0;

// This cell's light and the season, set once by autumnBegin.
World autumnWorld;    // the world now: the sky, the rain's overcast and the deck's cover
WorldView autumnView; // the park's own view of the sky: its widened frame's ray
vec3 autumnDir;       // that ray
vec2 autumnP;         // the cell in the park's frame: x from the centre line (screen heights), y up
float autumnAspect;   // the frame's aspect, at least AUTUMN_WIDE
vec3 autumnL;         // toward the light (x right, y up, z into the scene), unit
vec2 autumnSh;        // horizontal shift of a shadow per metre of height: L.xz / L.y
vec3 autumnSun;       // direct light
vec3 autumnAmb;       // sky light
float autumnWet;
float autumnTm;       // the motion clock
float autumnGust;     // signed gust strength at the canopy (the composer's field, and the passage's)
float autumnBlow;     // the passage's gust 0..1.3 (0 at rest) and the way it blows (+1 right, -1 left)
float autumnBlowDir;
float autumnPassT;    // seconds into the passage, the phase of the canopy's sway before the gust
float autumnKind;     // the tree's species: the maple's knob while it stands, a maple's leaves else
float autumnThin;     // 0..1: how much of the canopy has gone
float autumnGreen;    // 0..1: how green the leaves still are
float autumnLate;     // 0..1: how brown the season has turned them
float autumnCarpet;   // the carpet's overall density
float autumnLampOn;   // 0..1: the lamp is lit

// ---- leaves ----

// A leaf's size relative to its species: tied to its hue so the sim and the shader agree.
float autumnLeafScale(float h) {
  return 0.9 + 0.2 * fract(h * 7.3);
}

float autumnLeafRadius() {
  return autumnKind < 0.5 ? 0.15 : (autumnKind < 1.5 ? 0.12 : 0.14);
}

// A leaf's upper face for hue h (0..1) at this season: maple crimson to gold, ginkgo butter to lemon,
// oak russet to ochre; early in the season some are still green, late they brown.
vec3 autumnLeafTop(float h) {
  vec3 c;
  if (autumnKind < 0.5) {
    c = mix(vec3(0.62, 0.06, 0.06), vec3(0.86, 0.17, 0.05), smoothstep(0.0, 0.45, h));
    c = mix(c, vec3(0.95, 0.46, 0.08), smoothstep(0.4, 0.75, h));
    c = mix(c, vec3(0.97, 0.74, 0.15), smoothstep(0.8, 1.0, h));
  } else if (autumnKind < 1.5) {
    c = mix(vec3(0.92, 0.60, 0.08), vec3(0.98, 0.82, 0.20), smoothstep(0.0, 0.6, h));
    c = mix(c, vec3(0.95, 0.89, 0.36), smoothstep(0.6, 1.0, h));
  } else {
    c = mix(vec3(0.50, 0.23, 0.09), vec3(0.74, 0.44, 0.12), smoothstep(0.0, 0.5, h));
    c = mix(c, vec3(0.82, 0.62, 0.18), smoothstep(0.5, 0.85, h));
    c = mix(c, vec3(0.50, 0.46, 0.14), smoothstep(0.85, 1.0, h));
  }
  float green = autumnGreen * (0.25 + 0.75 * fract(h * 5.3));
  c = mix(c, vec3(0.38, 0.52, 0.10), green);
  return mix(c, vec3(0.38, 0.20, 0.09), 0.5 * autumnLate);
}

// The blade of the leaf at q (its radius about 1, its tip toward +y, the stalk toward -y): a signed
// distance in leaf units, near its outline. k: this leaf's own random 0..1.
float autumnBlade(vec2 q, float k) {
  if (autumnKind < 0.5) {
    // A maple: five pointed lobes round a notch at the stalk.
    float a = abs(atan(q.x, q.y + 1e-5));
    float r = 0.36;
    r = max(r, pow(max(1.0 - a / 0.46, 0.0), 1.2));
    r = max(r, (0.84 + 0.1 * k) * pow(max(1.0 - abs(a - 1.08) / 0.42, 0.0), 1.2));
    r = max(r, 0.58 * pow(max(1.0 - abs(a - 2.1) / 0.38, 0.0), 1.2));
    r *= 1.0 - 0.8 * smoothstep(2.65, 3.1, a);
    return (length(q) - r) * 0.9;
  }
  if (autumnKind < 1.5) {
    // A ginkgo: a fan from its stalk, notched at the top.
    vec2 f = q + vec2(0.0, 0.7);
    float a = atan(f.x, f.y + 1e-5);
    float rr = length(f);
    float notch = exp(-a * a / 0.012);
    float outer = rr - (1.35 - 0.3 * notch);
    float wedge = (abs(a) - 0.92) * max(rr, 0.25);
    return max(max(outer, wedge), 0.18 - rr) * 0.85;
  }
  // An oak: long, narrowing to its base, three rounded lobes down each side.
  float t = clamp((q.y + 0.95) / 1.9, 0.0, 1.0);
  float w = 0.64 * pow(max(sin(3.14159 * pow(t, 0.85)), 0.0), 0.75) * (0.78 + 0.22 * cos(18.0 * t + 0.4 + 2.0 * k));
  return max(abs(q.x) - w, abs(q.y) - 0.95) * 0.85;
}

float autumnStalk(vec2 q) {
  float y0 = autumnKind < 0.5 ? -0.25 : (autumnKind < 1.5 ? -0.6 : -0.85);
  return segmentDistance(q, vec2(0.0, y0), vec2(0.03, y0 - 0.55)) - 0.045;
}

// Blade and stalk together: a signed distance in leaf units.
float autumnLeafD(vec2 q, float k) {
  return min(autumnBlade(q, k), autumnStalk(q));
}

// Distance to the leaf's veins (leaf units).
float autumnVein(vec2 q) {
  if (autumnKind < 0.5) {
    float d = segmentDistance(q, vec2(0.0, -0.3), vec2(0.0, 0.9));
    d = min(d, segmentDistance(q, vec2(0.0, 0.05), vec2(0.7, 0.5)));
    d = min(d, segmentDistance(q, vec2(0.0, 0.05), vec2(-0.7, 0.5)));
    d = min(d, segmentDistance(q, vec2(0.0, -0.1), vec2(0.5, -0.5)));
    return min(d, segmentDistance(q, vec2(0.0, -0.1), vec2(-0.5, -0.5)));
  }
  if (autumnKind < 1.5) {
    vec2 f = q + vec2(0.0, 0.7);
    float a = atan(f.x, f.y + 1e-5);
    return abs(fract(a * 3.2 + 0.5) - 0.5) / 3.2 * length(f);
  }
  float d = segmentDistance(q, vec2(0.0, -0.9), vec2(0.0, 0.9));
  d = min(d, segmentDistance(q, vec2(0.0, -0.3), vec2(0.5, 0.15)));
  d = min(d, segmentDistance(q, vec2(0.0, -0.3), vec2(-0.5, 0.15)));
  d = min(d, segmentDistance(q, vec2(0.0, 0.2), vec2(0.45, 0.6)));
  return min(d, segmentDistance(q, vec2(0.0, 0.2), vec2(-0.45, 0.6)));
}

// A leaf lit: h its hue, top whether its upper face is toward the viewer, nv its normal toward the
// viewer, lit whether the sun reaches it, vein 0..1, mark 1 for a leaf of the M (always gold).
// Sunlight through the leaf takes its colour: backlit leaves glow.
vec3 autumnLeafColour(float h, bool top, vec3 nv, float lit, float vein, float mark) {
  vec3 base = mark > 0.5 ? vec3(0.98, 0.72, 0.14) * (0.88 + 0.24 * h) : autumnLeafTop(h);
  vec3 face = top ? base : mix(base, vec3(dot(base, LUMA)), 0.4) * 1.1 + vec3(0.06, 0.05, 0.02);
  face *= 1.0 - 0.3 * vein;
  face = wetten(face, autumnWet * 0.8, 0.5);
  float front = max(dot(nv, autumnL), 0.0);
  float back = max(dot(-nv, autumnL), 0.0);
  vec3 sun = autumnSun * lit;
  vec3 col = face * (autumnAmb * 0.9 + sun * (front + 0.5 * back));
  col += face * face * sun * (back + 0.45 * front) * 1.1;
  col += autumnAmb * 0.3 * wetGloss(autumnWet, nv.y);
  return col;
}

// ---- light and shade ----

// The sun's light reaching world point P (x right, y up, z into the scene): 1 in full sun, smaller in
// the shadows of what stands in the park: the trunk, the lamp post, the bench and the canopy (two
// leafy layers, offset along the light, their holes the sun's flecks), each while its layer is on.
// Callers cut the result per cell with hardEdge.
float autumnShadow(vec3 P) {
  vec2 sh = autumnSh;
  float lit = 1.0;
#if LAYER_MAPLE
  float rise = max(AUTUMN_BOUGHS + 1.5 - P.y, 0.1);
  float dt = segmentDistance(P.xz, AUTUMN_TREE.xy, AUTUMN_TREE.xy - sh * rise);
  lit *= smoothstep(0.4, 0.7 + 0.012 * rise, dt);
#endif
#if LAYER_LAMP
  float lr = max(AUTUMN_LAMP.z - P.y, 0.1);
  float dl = segmentDistance(P.xz, AUTUMN_LAMP.xy, AUTUMN_LAMP.xy - sh * lr);
  lit *= smoothstep(0.02, 0.07 + 0.01 * lr, dl);
#endif
#if LAYER_MAPLE
  if (P.y < 0.5) {
    vec2 q = P.xz + sh * (0.45 - P.y) - AUTUMN_BENCH_AT;
    lit *= 0.2 + 0.8 * smoothstep(-0.02, 0.05, sdBox(q, vec2(AUTUMN_BENCH_SIZE.x, 0.24), 0.0));
  }
  if (P.y < 0.85) {
    vec2 q = P.xz + sh * (0.75 - P.y) - AUTUMN_BENCH_AT - vec2(0.0, 0.22);
    lit *= 0.45 + 0.55 * smoothstep(0.0, 0.05, sdBox(q, vec2(AUTUMN_BENCH_SIZE.x, 0.04), 0.0));
  }
  for (int k = 0; k < 2; k++) {
    float hc = k == 0 ? 5.0 : 7.4;
    vec2 shift = sh * (hc - P.y);
    shift *= min(1.0, 7.0 / max(length(shift), 1e-4));
    vec2 Q = P.xz + shift;
    float fp = 1.0 - smoothstep(0.55, 1.0, length((Q - AUTUMN_CANOPY.xy) / (AUTUMN_CANOPY.z * vec2(1.0, 0.85))));
    if (fp <= 0.0) continue;
    vec2 sway = 0.3 * vec2(sin(autumnTm * 0.31 + hc), cos(autumnTm * 0.27 + 2.0 * hc)) + vec2(autumnGust * 0.5, 0.0);
    float n = fbm3((Q + sway) * 0.75 + vec2(K_seed * 2.3 + hc, 1.1));
    float leaf = fp * smoothstep(0.30 + 0.45 * autumnThin, 0.52 + 0.45 * autumnThin, n + 0.25 * (fp - 0.5));
    lit *= 1.0 - 0.9 * leaf;
  }
#endif
  return lit;
}

// The lamp's light on a ground point or leaf at (x, z): a warm pool under it, while the lamp stands.
vec3 autumnLampLight(vec2 w) {
#if LAYER_LAMP
  vec2 dl = w - AUTUMN_LAMP.xy;
  return vec3(1.0, 0.72, 0.38) * autumnLampOn * 1.6 / pow(1.0 + dot(dl, dl) / 6.0, 1.5);
#else
  return vec3(0.0);
#endif
}

// Something standing in the park drawn over the cell at depth z (rgba's cover is 0 or 1): what the
// cell shows, the nearest depth, and what hides a speck behind it.
void autumnStand(inout Cell c, vec4 rgba, float z) {
  c.col = mix(c.col, rgba.rgb, rgba.a);
  c.z = min(c.z, z);
  c.zs = min(c.zs, z);
}

// ---- the cell ----

// Every park layer's state for this cell: the light (the key: the sun, or the moon once the sun is
// down, hidden as the sun is by the rain's deck, its direction kept but lifted so that its shadows
// still fall on the park rather than far beyond it), the season, the lamp, the gust at the canopy,
// the park's view of the sky, and the clouds' shadow on what the cell shows.
void autumnBegin(Ctx x) {
  autumnTm = x.tm;
  autumnAspect = max(x.aspect, AUTUMN_WIDE);
  autumnP = vec2((x.uv.x - 0.5) * autumnAspect, x.uv.y);
  autumnWorld = x.w;
  Sky sky = autumnWorld.sky;
  autumnWet = clamp(uWeather.x, 0.0, 1.0);
  bool moonKey = sky.sun.y < -0.02;
  vec3 key = moonKey ? sky.moon : sky.sun;
  vec3 keyCol = moonKey ? sky.moonColor * 1.6 * (1.0 - WORLD_DECK_SUN * autumnWorld.overcast) : sky.sunColor;
  float elev = 0.25 + 0.55 * max(key.y, 0.0);
  vec2 hz = key.xz;
  hz = dot(hz, hz) > 1e-6 ? normalize(hz) : vec2(-0.8, 0.6);
  // The light comes in from the side and a little toward the viewer, so that the shadows of the tree,
  // the bench and the lamp run across the path and away into the park, and the trunk's near face is lit.
  float hx = abs(hz.x) < 0.5 ? (hz.x < 0.0 ? -0.5 : 0.5) : hz.x;
  hz = normalize(vec2(hx, -0.4));
  autumnL = normalize(vec3(hz.x * cos(elev), sin(elev), hz.y * cos(elev)));
  autumnSh = autumnL.xz / autumnL.y;
  autumnSun = keyCol * 1.2;
  // The sky's light, a little warmer and flatter in the park.
  vec3 amb = sky.ambient;
  autumnAmb = mix(amb, vec3(dot(amb, LUMA)) * vec3(1.04, 1.0, 0.92), 0.3);
  float season = clamp(K_season, 0.0, 1.0);
  autumnThin = smoothstep(0.3, 1.0, season);
  autumnGreen = 1.0 - smoothstep(0.05, 0.4, season);
  autumnLate = smoothstep(0.55, 1.0, season);
  autumnCarpet = 0.2 + 0.9 * pow(season, 0.7);
#if LAYER_MAPLE
  autumnKind = K_species;
#else
  autumnKind = 0.0;
#endif
#if LAYER_LAMP
  autumnLampOn = K_lamp * (1.0 - smoothstep(0.1, 0.34, dot(autumnAmb, LUMA) + 0.2 * dot(autumnSun, LUMA)));
#else
  autumnLampOn = 0.0;
#endif
#if LAYER_MAPLE
  // The gust at the canopy, which it sways in and its dapple shifts with: the composer's field, the
  // way the wind blows; the passage's gust leans it too.
  autumnGust = (K_wind < 0.0 ? -1.0 : 1.0) * AUTUMN_GUST_GAIN * gustAt(x.gust, AUTUMN_CANOPY.xy, x.tm, 0.0);
  autumnBlow = autumnPassageBlow();
  autumnBlowDir = K_wind < -0.05 ? -1.0 : 1.0;
  autumnPassT = passageIn() * AUTUMN_PASSAGE.x + passageOut() * AUTUMN_PASSAGE.y;
  if (autumnBlow > 0.0) autumnGust += autumnBlowDir * 0.8 * autumnBlow;
#endif
  // The park is laid out for a wide frame; a narrower one squeezes it rather than lose the tree.
  autumnDir = viewRay(x.uv, autumnAspect, AUTUMN_HORIZON, AUTUMN_FOV);
  autumnView = worldViewOf(autumnDir, x.uv, AUTUMN_HORIZON, AUTUMN_FOCAL, AUTUMN_EYE, 0.0, 1.0);
#if WORLD_SHADOWS
  // Cloud shadows (K_shadows): the deck's shadow where this cell's sight line reaches the park, on the
  // ground it meets or, above the horizon, at the canopy's depth. A cloud's shadow is far larger than
  // anything here, so that one point shades everything the cell shows.
  if (K_shadows > 0.0 && autumnWorld.sky.sun.y > 0.0) {
    float z = x.uv.y < AUTUMN_HORIZON ? min(AUTUMN_EYE * AUTUMN_FOCAL / (AUTUMN_HORIZON - x.uv.y), 120.0) : AUTUMN_CANOPY.y;
    autumnSun *= 1.0 - K_shadows * skyCloudShadow(autumnWorld.sky, autumnDir * (z / autumnDir.z), AUTUMN_CLOUD_BASE, autumnTm, autumnWorld.cover, autumnWorld.wind);
  }
#endif
}
`;

/**
 * The park's floor, held by the ground and the litter (after the backdrop's begin, which says where
 * the land ends): where this cell's ray meets the ground, its footprint, the key light's shadow and the
 * contact shadows there, and the haze the distance takes; the path's colour under the carpet once the
 * ground has drawn it.
 */
export const autumnFloorGlsl = `
// ---- the park's floor (autumn/shader.ts), shared by the ground and the litter ----
bool autumnOnFloor;   // the ray meets the park's ground in this cell
vec2 autumnW;         // where (m), and the ground a cell spans there (m, across and in depth)
vec2 autumnFoot;
float autumnFloorZ;   // its depth
float autumnFloorAa;  // the metres a cell covers
float autumnFloorLit; // the key light reaches it (0 or 1)
float autumnFloorAo;  // the contact shadows where things stand
float autumnFloorHaze;// the haze the distance takes over it
bool autumnFloorDrawn;// the ground drew it: autumnFloorCol is its colour before the haze
vec3 autumnFloorCol;

void autumnFloorBegin(Ctx x) {
  autumnFloorDrawn = false;
  autumnOnFloor = x.uv.y < min(x.groundTo, AUTUMN_HORIZON - 1e-4) && x.zg < x.landZ;
  if (!autumnOnFloor) return;
  Ground g = planeAt(x.uv, autumnAspect, AUTUMN_HORIZON, AUTUMN_EYE, AUTUMN_FOCAL);
  vec2 w = g.p;
  autumnW = w;
  autumnFoot = g.foot;
  autumnFloorZ = w.y;
  autumnFloorAa = 0.8 * sqrt(g.foot.x * g.foot.y);
  autumnFloorLit = hardEdge(autumnShadow(vec3(w.x, 0.0, w.y)));
  // Contact shadows where things stand: round the bench, the lamp's foot and the trunk's roots.
  float ao = 1.0;
#if LAYER_MAPLE
  ao = 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.45, sdBox(w - AUTUMN_BENCH_AT - vec2(0.0, 0.2), vec2(0.95, 0.4), 0.1)));
#endif
#if LAYER_LAMP
  ao *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 0.5, length(w - AUTUMN_LAMP.xy) - 0.12));
#endif
#if LAYER_MAPLE
  ao *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 1.0, length(w - AUTUMN_TREE.xy) - AUTUMN_TREE.z * 1.3));
#endif
  autumnFloorAo = ao;
  autumnFloorHaze = 1.0 - exp(-w.y * 0.016);
}
`;

/** The parkland's GLSL: the sky over the park, the far crowns, the park's air. */
export const parklandGlsl = `
// ---- the sky and the far trees ----

// One row of far trees, nearest (k = 0) to farthest (k = 2): lumpy crowns that dip between one
// another, a few tall dark conifers, the silhouette broken up by leafy noise, the sun's side lit and
// the whole lost in the haze. Returns rgb and cover.
vec4 autumnFarRow(vec2 p, float k, vec3 haze) {
  float w = 0.17 - 0.03 * k;
  float hMax = 0.105 - 0.025 * k;
  float gx = (p.x + 0.31 * k + K_seed * 0.013) / w;
  float id = floor(gx);
  float fx = gx - id;
  float h = hash12(vec2(id, k * 7.0 + K_seed));
  float h2 = hash12(vec2(id * 1.7, k * 3.0 + 1.0));
  float h3 = hash12(vec2(id * 2.3, k * 5.0 + 2.0));
  float u = 2.0 * fx - 1.0;
  float height = hMax * (0.5 + 0.6 * h2) * (0.45 + 0.55 * pow(sqrt(max(1.0 - u * u, 0.0)), 0.7));
  bool conifer = h3 > 0.8;
  if (conifer) {
    float spire = pow(max(1.0 - abs(u) * 1.7, 0.0), 0.8);
    height = max(height * 0.55, hMax * (0.95 + 0.4 * h2) * spire);
  }
  height += hMax * 0.3 * (vnoise(vec2(p.x * 26.0 / (1.0 + 0.3 * k) + k * 3.0, 1.0)) - 0.5);
  height = max(height, 0.0);
  float edge = AUTUMN_HORIZON - 0.004 + height;
  float broken = vnoise(p * vec2(70.0, 90.0) + k * 5.0) - 0.5;
  float c = clamp((edge - p.y) / 0.014 + 0.5 + broken * 1.3, 0.0, 1.0);
  if (hardEdge(c) <= 0.0) return vec4(0.0);
  float tone = hash12(vec2(id * 1.3, k + 4.1));
  vec3 col;
  if (conifer) {
    col = vec3(0.09, 0.17, 0.11);
  } else {
    col = autumnLeafTop(clamp(tone * 1.1 + 0.25 * (vnoise(p * vec2(18.0, 24.0) + k) - 0.5), 0.0, 1.0)) * (0.75 + 0.35 * h);
  }
  float sideLit = autumnL.x < 0.0 ? smoothfall(0.8, 0.1, fx) : smoothstep(0.2, 0.9, fx);
  float topLit = clamp((p.y - AUTUMN_HORIZON) / max(height, 0.01), 0.0, 1.0);
  col *= (0.45 + 0.5 * sideLit + 0.35 * topLit) * (0.8 + 0.4 * vnoise(p * vec2(120.0, 140.0) + k * 9.0));
  vec3 lit = col * (autumnAmb * 0.8 + autumnSun * 0.55) + col * col * autumnSun * 0.3 * sideLit;
  lit = mix(lit, vec3(dot(lit, LUMA)), 0.2 * k);
  return vec4(mix(lit, haze, 0.36 + 0.2 * k), 1.0);
}

// ---- the parkland's passes ----
// The park's air: the haze toward this bearing, greyed under the rain's deck, which the fog takes
// too; the drops' light, from the sky's light and the sun's. The land runs out to the horizon.
void parklandBegin(inout Ctx x) {
  vec3 haze = horizonHaze(autumnWorld.sky, autumnDir, 0.03);
  haze = greyed(haze, vec3(0.97, 0.98, 1.0), 0.5 * autumnWorld.overcast);
  vec3 drop = max(autumnAmb * 1.2, vec3(0.08)) + autumnSun * 0.2;
  x.air = Air(haze, haze, drop, haze, 0.0, 0.016, 0.0);
  x.groundTo = AUTUMN_HORIZON - 1e-4;
  x.landZ = 1e9;
}

// The colour the far rain fuses into (the backdrop's precip.air): the haze, a little darker.
vec3 parklandRainAir(Ctx x) {
  return x.air.haze * 0.9;
}

// The World's sky over the far crowns (the dome, the aurora behind the clouds, the deck, the stars
// and the giant planet in its gaps, shooting stars), the deck greyed by the rain (the world's grey
// day greys what it leaves open), rain shafts hanging under it, the lightning over it.
void parklandSky(Ctx x, inout Cell c) {
  if (x.uv.y < x.groundTo) return;
  WorldSky heaven = worldSky(autumnWorld, autumnView, WORLD_METEOR_FIELD);
  vec3 sk = mix(heaven.col, greyed(heaven.col, vec3(0.94, 0.96, 1.0), 0.55 * autumnWorld.overcast), heaven.cloud);
  if (K_rain > 0.0) {
    float shaft = rainShafts(autumnDir.xy / (max(autumnDir.z, 0.2) * 0.3), uMotionTime, K_rain, K_wind);
    sk = mix(sk, autumnAmb * 1.3 + vec3(0.1), shaft * 0.6);
  }
  c.col = sk + heaven.strike;
}

// Three rows of far crowns, far to near, each lost a little more in the haze.
void parklandFar(Ctx x, inout Cell c) {
  if (x.uv.y < x.groundTo || autumnP.y >= AUTUMN_HORIZON + 0.16) return;
  for (int k = 2; k >= 0; k--) {
    vec4 row = autumnFarRow(autumnP, float(k), x.air.haze);
    if (row.a > 0.0) cellPut(c, row, 38.0 + 30.0 * float(k) + 10.0 * float(k * k));
  }
}
`;

/** The park path's GLSL: the lawn, the gravel path and the finer litter, wet and pooled in rain. */
export const parkPathGlsl = `
// ---- the ground ----
// The lawn and the path under the cell: gravel worn pale down the path's middle, darker and ragged at
// its edges, two faint ruts; the lawn's sun-bleached and lush drifts, patches, tufts close by; finer
// litter than the carpet's leaves, a mottle of leaf colours that thickens with the season, under the
// tree and off the path (far away it is averaged into the colour); lit by the key light and the
// lamp's pool, darkened where things stand; pools mirroring the haze, rings spreading in them while
// it rains, splashes close by; the haze over the distance.
void parkPathGround(Ctx x, inout Cell c) {
  if (!autumnOnFloor) return;
  vec2 w = autumnW;
  vec2 foot = autumnFoot;
  float aa = autumnFloorAa;

  float across = w.x - autumnPathX(w.y);
  float wob = vnoise(vec2(w.y * 1.9 + 3.0, 7.0)) - 0.5 + 0.35 * (vnoise(vec2(w.y * 6.0, 2.0)) - 0.5);
  float dPath = abs(across) - AUTUMN_PATH_HALF * (1.0 + 0.2 * wob);
  float onPath = 1.0 - smoothstep(-0.1, 0.2, dPath);
  float centre = 1.0 - smoothstep(0.0, AUTUMN_PATH_HALF, abs(across));

  float fineFade = (1.0 - smoothstep(0.02, 0.06, foot.x)) * (1.0 - smoothstep(0.05, 0.15, foot.y));
  float broad = fbm3(w * 0.35 + K_seed * 1.3);
  float lush = fbm3(w * vec2(1.6, 1.0) + vec2(4.0, K_seed));
  vec3 grass = mix(vec3(0.20, 0.30, 0.08), vec3(0.52, 0.47, 0.17), smoothstep(0.3, 0.75, broad));
  grass = mix(grass, vec3(0.32, 0.40, 0.12), 0.4 * smoothstep(0.4, 0.7, lush));
  grass *= 0.85 + 0.3 * mix(0.5, vnoise(w * 7.0), fineFade) + (vnoise(w * 2.3) - 0.5) * 0.2;
  vec3 gravel = mix(vec3(0.50, 0.41, 0.30), vec3(0.72, 0.63, 0.48), smoothstep(0.2, 0.8, 0.6 * vnoise(w * vec2(1.4, 0.5)) + 0.4 * centre));
  gravel *= 1.0 + (hash12(floor(w * 16.0)) - 0.5) * 0.18 * fineFade + (vnoise(w * 3.5) - 0.5) * 0.15;
  gravel *= 1.0 - 0.1 * smoothfall(0.22, 0.0, abs(abs(across) - 0.5));
  vec3 albedo = mix(grass, gravel, onPath);
  albedo *= 1.0 - 0.3 * smoothfall(0.4, 0.0, abs(dPath));

  vec2 tc = w - AUTUMN_CANOPY.xy;
  float edgeBand = exp(-(dPath / 0.8) * (dPath / 0.8));
  float shape = ((0.75 + 0.9 * exp(-dot(tc, tc) / 60.5)) * (1.0 - 0.3 * onPath) + 0.55 * edgeBand) * (0.7 + 0.6 * vnoise(w * 0.28 + K_seed));
  float dens = min(0.95, autumnCarpet * shape);
  vec2 gs = w / 0.17;
  vec2 sid = floor(gs);
  vec2 sj = hash22(sid + 7.0);
  float speckD = length(fract(gs) - 0.5 - (sj - 0.5) * 0.4) - 0.3;
  float speckLod = 1.0 - smoothstep(0.08, 0.2, foot.y);
  float speck = (hash12(sid + 41.0) < dens * 0.8 ? 1.0 : 0.0) * hardFill(speckD, aa / 0.17) * speckLod;
  vec3 speckCol = autumnLeafTop(hash12(sid + 3.0)) * 0.75;
  albedo = mix(albedo, speckCol, speck * 0.9);
  albedo = mix(albedo, autumnLeafTop(0.35) * 0.62, dens * 0.5 * (1.0 - speckLod));
  albedo = wetten(albedo, autumnWet, mix(0.8, 0.45, onPath));

  vec3 light = autumnAmb * 0.95 + autumnSun * (autumnL.y * autumnFloorLit * 1.25) + autumnLampLight(w);
  vec3 col = albedo * light * autumnFloorAo;

  float pool = rainPuddles(w * 0.8, autumnWet) * (0.4 + 0.6 * onPath);
  if (pool > 0.0) {
    vec3 mirror = x.air.haze * 0.9 + autumnLampLight(w) * 0.5;
    col = mix(col, mirror, pool * 0.75);
    if (K_rain > 0.0) {
      vec3 ring = rainRipples(w * 1.8, uFallTime, K_rain);
      col += vec3(ring.z) * 0.3 * pool * (1.0 - smoothstep(0.05, 0.2, foot.y));
    }
  }
  if (K_rain > 0.0 && foot.x < 0.067) {
    float splash = rainSplashes(w * (uRes.y / 200.0), uFallTime, K_rain);
    col = mix(col, max(autumnAmb * 1.2, vec3(0.1)), splash * 0.5 * (1.0 - pool));
  }

  autumnFloorCol = col;
  autumnFloorDrawn = true;
  c.col = mix(col, x.air.haze, autumnFloorHaze);
  c.z = autumnFloorZ;
  c.accent = 0.0;
}
`;

/** The lamp's GLSL: the post, its light on the guests (lampLight), its halo. */
export const lampGlsl = `
// ---- the lamp post ----

// The lamp post at its depth: its iron, or its glass, lit as the lamp is (rgb, cover).
vec4 autumnLampPost(vec2 p, vec3 haze) {
  float s = AUTUMN_FOCAL / AUTUMN_LAMP.y;
  vec2 q = vec2(p.x / s - AUTUMN_LAMP.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (abs(q.x) > 0.5 || q.y < -0.05 || q.y > AUTUMN_LAMP.z + 0.3) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float hb = AUTUMN_LAMP.z - 0.55;
  float r = 0.045 + 0.07 * smoothfall(0.55, 0.0, q.y) + 0.015 * smoothfall(0.25, 0.0, abs(q.y - 1.4));
  float dPost = max(abs(q.x) - r, q.y - hb);
  float dPlate = sdBox(vec2(q.x, q.y - hb - 0.02), vec2(0.11, 0.03), 0.0);
  // The lantern: a tapering cage of glass with a cap and a finial.
  float wl = 0.15 + 0.03 * (q.y - hb) / 0.45;
  float dBody = max(abs(q.x) - wl, max(hb + 0.05 - q.y, q.y - (hb + 0.5)));
  float dGlass = dBody + 0.025;
  float capT = clamp((q.y - (hb + 0.5)) / 0.24, 0.0, 1.0);
  float dCap = max(abs(q.x) - (0.23 * (1.0 - capT) + 0.012), max(hb + 0.5 - q.y, q.y - (hb + 0.76)));
  float dIron = min(min(dPost, dPlate), min(dCap, 1e3));
  float cage = max(dBody, -dGlass);
  dIron = min(dIron, cage);
  float dAll = min(dIron, dBody);
  float cov = hardFill(dAll, aa);
  if (cov <= 0.0) return vec4(0.0);
  float nx = clamp(q.x / max(r, 0.02), -1.0, 1.0);
  vec3 N = vec3(nx, 0.0, -sqrt(max(1.0 - nx * nx, 0.0)));
  vec3 iron = vec3(0.11, 0.12, 0.11) * (autumnAmb * 0.9 + autumnSun * max(dot(N, autumnL), 0.0) * 0.9 + 0.04);
  iron += autumnSun * 0.3 * pow(max(dot(N, autumnL), 0.0), 4.0) * (1.0 - 0.5 * smoothstep(0.5, 1.5, q.y));
  iron *= 1.0 - 0.25 * smoothfall(0.02, 0.0, abs(q.y - 1.4));
  if (dBody < 0.0 && dGlass < 0.0 && dIron > 0.0) {
    vec3 lamp = vec3(1.0, 0.78, 0.42) * 1.2;
    return vec4(mix(haze * 0.55, lamp, autumnLampOn), cov);
  }
  return vec4(iron, cov);
}

// The post stands on the ground: drawn over what lies behind it and its foot over the ground just in
// front, its depth (and what hides a speck: the litter keeps off its foot) the post's.
void lampMiddle(Ctx x, inout Cell c) {
  vec4 lamp = autumnLampPost(autumnP, x.air.haze);
  if (lamp.a <= 0.0 || AUTUMN_LAMP.y >= c.z + 0.5) return;
  autumnStand(c, lamp, AUTUMN_LAMP.y);
  c.accent = 0.0;
}

// The lamp's halo in the air, when it is lit; brighter in the rain.
void lampAir(inout Ctx x, inout Cell c) {
  if (autumnLampOn <= 0.0) return;
  float s = AUTUMN_FOCAL / AUTUMN_LAMP.y;
  vec2 lc = vec2((AUTUMN_LAMP.x) * s, AUTUMN_HORIZON + (AUTUMN_LAMP.z - 0.3 - AUTUMN_EYE) * s);
  vec2 dl = (autumnP - lc) / 0.07;
  c.col += vec3(1.0, 0.72, 0.36) * autumnLampOn * (0.45 + 0.5 * autumnWet) * exp(-dot(dl, dl) * 0.6);
}

// The lamp's pool on another layer's surface at p (the composer's localLight).
vec3 lampLight(vec3 p, vec3 n) {
  return autumnLampLight(p.xz);
}
`;

/** The maple's GLSL: the bench, the canopy, the trunk and the leaves in the air, in the park's order. */
export const mapleGlsl = `
// ---- the bench ----

// A park bench seen from the front: wooden boards on iron ends, a few fallen leaves on the seat.
vec4 autumnBench(vec2 p) {
  float s = AUTUMN_FOCAL / AUTUMN_BENCH_AT.y;
  vec2 q = vec2(p.x / s - AUTUMN_BENCH_AT.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (abs(q.x) > 1.05 || q.y < -0.03 || q.y > 1.0) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float legs = max(abs(abs(q.x) - 0.8) - 0.03, max(-q.y, q.y - 0.9));
  float arm = sdBox(vec2(abs(q.x) - 0.8, q.y - 0.63), vec2(0.06, 0.02), 0.0);
  float seatFront = sdBox(vec2(q.x, q.y - 0.425), vec2(0.86, 0.028), 0.0);
  float seatTop = sdBox(vec2(q.x, q.y - 0.49), vec2(0.86, 0.04), 0.0);
  float bi = floor((q.y - 0.55) / 0.115);
  float fy = q.y - 0.55 - (bi + 0.5) * 0.115;
  float board = (bi < -0.5 || bi > 2.5) ? 1.0 : max(abs(fy) - 0.045, abs(q.x) - 0.8);
  float dWood = min(min(seatFront, seatTop), board);
  float dIron = min(legs, arm);
  float cov = hardFill(min(dWood, dIron), aa);
  if (cov <= 0.0) return vec4(0.0);
  float tone = (bi < -0.5 || bi > 2.5) ? 0.9 : 0.8 + 0.3 * hash12(vec2(bi, K_seed + 3.0));
  float grain = vnoise(vec2(q.x * 1.6 + bi * 3.7, q.y * 75.0));
  vec3 wood = vec3(0.47, 0.30, 0.15) * tone * (0.72 + 0.4 * grain);
  wood = mix(wood, vec3(0.52, 0.46, 0.38), 0.3 * smoothstep(0.55, 0.8, vnoise(vec2(q.x * 3.0 + 2.0, q.y * 20.0))));
  float sunLit = hardEdge(autumnShadow(vec3(AUTUMN_BENCH_AT.x + q.x, 0.5, AUTUMN_BENCH_AT.y)));
  wood = wetten(wood, autumnWet, 0.7);
  vec3 col;
  if (dIron < dWood) {
    float post = q.x < 0.0 ? -0.8 : 0.8;
    col = vec3(0.09, 0.10, 0.09) * (autumnAmb * 0.9 + autumnSun * sunLit * 0.25);
    col += autumnSun * sunLit * 0.35 * smoothfall(0.012, 0.0, abs(q.x - post + 0.018));
  } else if (seatTop <= seatFront && seatTop < board) {
    // The seat's top, lit from above, with a line between its slats and the leaves that have settled.
    col = wood * 1.1 * (autumnAmb + autumnSun * (autumnL.y * 1.2 * sunLit));
    col *= 1.0 - 0.35 * smoothfall(0.006, 0.0, abs(q.y - 0.49));
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float cx = -0.52 + 0.58 * fi + 0.08 * hash12(vec2(fi, K_seed));
      float d = sdEllipse(vec2(q.x - cx, q.y - 0.49 - 0.006 * fi), vec2(0.085, 0.026));
      if (hardFill(d, aa) > 0.0) {
        col = autumnLeafColour(fract(0.31 + 0.27 * fi), true, vec3(0.0, 1.0, 0.0), sunLit, 0.0, 0.0);
      }
    }
  } else {
    // The faces toward the viewer take the low sun from the side, and a bright edge on top.
    col = wood * (autumnAmb * 0.75 + autumnSun * (max(-autumnL.z, 0.0) * 1.3 * sunLit));
    float onBoard = step(board, min(seatFront, seatTop));
    col += autumnSun * sunLit * 0.45 * smoothfall(0.016, 0.0, abs(fy - 0.045)) * onBoard;
    col *= 1.0 - 0.35 * smoothstep(0.034, 0.045, abs(fy)) * onBoard;
  }
  return vec4(col, cov);
}

// ---- the tree ----

// The trunk and its boughs at the tree's depth, as a signed distance in metres: q = (across from the
// trunk's foot, height). The trunk flares into roots that spread over the ground and forks into
// boughs that climb into the canopy.
float autumnTreeD(vec2 q) {
  float lean = 0.16 * sin(0.55 * q.y + 1.0) - 0.03 * q.y;
  float rt = AUTUMN_TREE.z * (1.0 + 1.4 * exp(-q.y * 2.8)) * (1.0 - 0.05 * q.y);
  float d = max(abs(q.x - lean) - rt, q.y - 4.0);
  d = min(d, sdTaperCapsule(q, vec2(-0.3, 0.3), vec2(-1.6, 0.0), 0.28, 0.06));
  d = min(d, sdTaperCapsule(q, vec2(0.35, 0.3), vec2(1.8, 0.0), 0.3, 0.06));
  d = min(d, sdTaperCapsule(q, vec2(0.1, 0.25), vec2(0.7, -0.02), 0.2, 0.05));
  d = max(d, -0.06 - q.y);
  if (q.y > 2.3) {
    d = min(d, sdTaperCapsule(q, vec2(-0.1, 2.9), vec2(-1.9, 4.3), 0.3, 0.17));
    d = min(d, sdTaperCapsule(q, vec2(-1.9, 4.3), vec2(-4.6, 5.4), 0.17, 0.08));
    d = min(d, sdTaperCapsule(q, vec2(-1.9, 4.3), vec2(-2.6, 6.4), 0.14, 0.07));
    d = min(d, sdTaperCapsule(q, vec2(0.1, 3.1), vec2(1.8, 4.5), 0.28, 0.16));
    d = min(d, sdTaperCapsule(q, vec2(1.8, 4.5), vec2(4.4, 5.2), 0.16, 0.07));
    d = min(d, sdTaperCapsule(q, vec2(1.8, 4.5), vec2(2.4, 6.6), 0.12, 0.06));
    d = min(d, sdTaperCapsule(q, vec2(0.0, 3.3), vec2(0.35, 6.2), 0.28, 0.13));
    d = min(d, sdTaperCapsule(q, vec2(-0.3, 3.6), vec2(-0.9, 6.0), 0.18, 0.08));
    d = min(d, sdTaperCapsule(q, vec2(-0.2, 2.5), vec2(-3.0, 3.7), 0.22, 0.09));
    d = min(d, sdTaperCapsule(q, vec2(0.2, 2.6), vec2(3.0, 3.8), 0.22, 0.09));
  }
  return d;
}

// The trunk and boughs (rgb, cover): furrowed, cracked bark with lichen and moss, dark where it meets
// the ground, lit on the side toward the sun with a warm rim.
vec4 autumnTrunk(vec2 p) {
  float s = AUTUMN_FOCAL / AUTUMN_TREE.y;
  vec2 q = vec2(p.x / s - AUTUMN_TREE.x, (p.y - (AUTUMN_HORIZON - AUTUMN_EYE * s)) / s);
  if (q.y < -0.1) return vec4(0.0);
  float aa = 0.8 / (uRes.y * s);
  float d = autumnTreeD(q);
  if (d > 0.1) return vec4(0.0);
  float cov = hardFill(d, aa);
  if (cov <= 0.0) return vec4(0.0);
  // A pseudo-normal: the outline's slope toward the viewer in the middle, round at the edge.
  float e = 0.03;
  vec2 grad = vec2(autumnTreeD(q + vec2(e, 0.0)) - autumnTreeD(q - vec2(e, 0.0)), autumnTreeD(q + vec2(0.0, e)) - autumnTreeD(q - vec2(0.0, e)));
  float gl = length(grad);
  vec2 gdir = gl > 1e-5 ? grad / gl : vec2(0.0, 1.0);
  float rad = mix(AUTUMN_TREE.z * 1.3, 0.16, smoothstep(2.6, 3.4, q.y));
  float m = clamp(1.0 + d / rad, 0.0, 1.0);
  vec3 N = vec3(gdir * m, -sqrt(max(1.0 - m * m, 0.0)));
  vec3 bark = autumnKind < 0.5 ? vec3(0.36, 0.30, 0.25) : (autumnKind < 1.5 ? vec3(0.42, 0.37, 0.31) : vec3(0.26, 0.21, 0.17));
  float fine = 1.0 - smoothstep(0.05, 0.12, 4.0 / (uRes.y * s));
  float warp = 0.1 * vnoise(vec2(q.y * 1.3, 5.0));
  float f1 = vnoise(vec2((q.x + warp) * 13.0, q.y * 0.45 + 2.0));
  float f2 = vnoise(vec2((q.x + warp) * 34.0, q.y * 1.6));
  float ridge = 0.65 * f1 + 0.35 * mix(0.5, f2, fine);
  float crack = smoothfall(0.38, 0.22, f1);
  vec3 albedo = bark * (0.5 + 0.95 * ridge) * (1.0 - 0.5 * crack);
  float lichen = smoothstep(0.6, 0.76, vnoise(vec2(q.x * 3.0, q.y * 2.0) + 9.0));
  albedo = mix(albedo, vec3(0.58, 0.60, 0.46), 0.3 * lichen);
  float moss = smoothfall(1.6, 0.2, q.y) * smoothstep(0.35, 0.7, vnoise(vec2(q.x * 5.0, q.y * 3.0)));
  albedo = mix(albedo, vec3(0.22, 0.30, 0.10), 0.5 * moss);
  albedo *= 0.55 + 0.45 * smoothstep(-0.05, 0.7, q.y);
  albedo = wetten(albedo, autumnWet, 0.6);
  float sunLit = hardEdge(autumnShadow(vec3(AUTUMN_TREE.x + q.x, q.y, AUTUMN_TREE.y)));
  float diff = max(dot(N, autumnL), 0.0);
  vec3 col = albedo * (autumnAmb * (0.6 + 0.25 * N.y) + autumnSun * sunLit * (diff * 1.25 + 0.08));
  col += albedo * vec3(0.30, 0.22, 0.10) * smoothfall(1.2, 0.0, q.y) * 0.25;
  col += autumnSun * sunLit * 0.3 * smoothstep(0.6, 1.0, m) * max(dot(N.xy, normalize(vec2(autumnL.x, 0.5))), 0.0);
  return vec4(col, cov);
}

// ---- the canopy ----

// The underside of the canopy at screen x: ragged, drooping round the trunk.
float autumnCanopyEdge(float x) {
  float seed = K_seed;
  float edge = 0.70 + 0.05 * sin(x * 2.1 + 1.3 + seed * 0.7) + 0.04 * sin(x * 5.3 + seed) + 0.08 * (fbm3(vec2(x * 2.2 + seed * 1.7, 2.0)) - 0.5);
  float tx = (x - AUTUMN_TREE.x / AUTUMN_TREE.y * AUTUMN_FOCAL) / 0.55;
  return edge - 0.07 * exp(-tx * tx);
}

// How far into the canopy screen point p lies (edge: autumnCanopyEdge at p.x): 0 under its ragged
// underside, rising to 1 a little above it. The canopy before its holes open: the mass field never
// exceeds it, so where it is small the holes need not be looked at.
float autumnCanopyDepth(vec2 p, float edge) {
  return smoothstep(edge - 0.02, edge + 0.12, p.y);
}

// The canopy at screen point p (edge and depth: autumnCanopyEdge and autumnCanopyDepth there): x how
// much there is (0 sky .. 1 solid, never more than depth), y how thin it is (1 at the edge and round
// the holes, where the light shines through). Holes open, and the whole thins, as the season runs on.
vec2 autumnMassField(vec2 p, float edge, float depth) {
  float holes = 0.6 * fbm3(p * 2.6 + vec2(K_seed * 3.1, 1.7)) + 0.4 * fbm3(p * 1.25 + vec2(7.3, K_seed * 1.3));
  float cut = mix(0.6, 1.25, autumnThin);
  float v = holes + 0.25 * depth;
  float mass = depth * smoothstep(cut, cut + 0.1, v);
  float thin = 1.0 - smoothstep(cut + 0.05, cut + 0.3, v) * smoothstep(edge, edge + 0.2, p.y);
  return vec2(mass, thin);
}

// The colour cluster of the canopy at p: crimson, orange and gold in patches a boughs-width across.
float autumnCanopyHue(vec2 p) {
  float n = fbm3(p * 5.5 + vec2(K_seed * 2.7, 8.0));
  return clamp(n * 1.5 - 0.25 + 0.3 * (vnoise(p * 48.0) - 0.5), 0.0, 1.0);
}

// A bumpy height for the canopy's clumps.
float autumnCanopyBump(vec2 p) {
  return fbm3(p * 4.2 + vec2(K_seed * 1.9, 4.0)) + 0.35 * vnoise(p * 11.0 + 3.0);
}

// How lit the canopy is at p (edge: autumnCanopyEdge at p.x), about 0.25 in deep shade to 1.1 in
// full sun: clumps that face the sun are bright, their far flanks and the underside of the canopy
// dark, the top of the frame brighter.
float autumnCanopyLight(vec2 p, float edge) {
  vec2 toSun = normalize(vec2(autumnL.x, 0.55));
  float facing = clamp(0.5 + (autumnCanopyBump(p) - autumnCanopyBump(p + toSun * 0.04)) * 3.2, 0.0, 1.0);
  float under = smoothstep(0.0, 0.28, p.y - edge);
  float top = smoothstep(0.7, 1.05, p.y);
  return (0.25 + 0.85 * facing) * (0.5 + 0.5 * under) * (0.9 + 0.3 * top);
}

// The canopy's body: clumps of leaves in patches of red, orange and gold, lit on the sun's side and
// dark under it, a fine leafy grain, and the sun glowing through where it is thin. Below the
// canopy's underside its depth is cut already, and the holes are never looked at.
vec4 autumnCanopyBody(vec2 p) {
  float edge = autumnCanopyEdge(p.x);
  float depth = autumnCanopyDepth(p, edge);
  if (hardEdge(depth) <= 0.0) return vec4(0.0);
  vec2 mf = autumnMassField(p, edge, depth);
  if (hardEdge(mf.x) <= 0.0) return vec4(0.0);
  float lightK = autumnCanopyLight(p, edge);
  vec3 base = autumnLeafTop(autumnCanopyHue(p));
  float speck = 0.5 + 0.5 * smoothstep(0.3, 0.65, vnoise(p * 95.0 + 5.0));
  vec3 col = base * (autumnAmb * 0.5 + autumnSun * lightK * 0.8);
  col += base * base * autumnSun * (0.25 + 0.9 * mf.y) * (0.4 + 0.6 * lightK);
  col *= speck;
  col = wetten(col, autumnWet * 0.7, 0.5);
  return vec4(col, 1.0);
}

// One layer of leaves over the canopy's body: a jittered lattice of cs-wide cells in screen space, a
// leaf in some cells (more at the edge and round the holes), each swaying a little (more in a gust)
// and coloured by the clump it hangs in; shadeK dims the layer (the far ones). density: how many
// cells hold a leaf.
vec4 autumnCanopyLayer(vec2 p, float cs, float salt, float density, float shadeK) {
  vec2 off = vec2(salt * 0.37, salt * 0.61);
  vec2 g = p / cs + off;
  vec2 i0 = floor(g);
  vec2 f = g - i0;
  vec2 nb = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  vec4 best = vec4(0.0);
  float bestK = 2.0;
  float aa = 0.8 / uRes.y;
  for (int k = 0; k < 4; k++) {
    vec2 id = i0 + vec2(float(k - 2 * (k / 2)) * nb.x, float(k / 2) * nb.y);
    float h = hash12(id + salt * 11.3);
    if (h > density * 1.7) continue;
    vec2 jit = hash22(id + salt * 5.7);
    vec2 cp = (id + 0.5 + (jit - 0.5) * 0.6 - off) * cs;
    float h2 = hash12(id * 1.7 + salt);
    if (h2 >= bestK) continue;
    float ph = h * 18.85;
    vec2 sway = vec2(sin(autumnTm * 0.55 + ph), cos(autumnTm * 0.43 + ph * 1.3)) * cs * (0.05 + 0.06 * abs(K_wind) + 0.14 * abs(autumnGust));
    // The passage's gust leans the leaves along it, each a little ahead of or behind its neighbours, with a
    // slow flutter; the whole sprite moves, so that its edge is cut per cell as ever.
    if (autumnBlow > 0.0) {
      float lean = 0.55 + 0.35 * sin(ph * 1.7 + 5.0 * autumnPassT - 3.0 * autumnBlowDir * cp.x);
      sway += vec2(autumnBlowDir * lean, 0.15 * cos(ph + 4.0 * autumnPassT)) * cs * 0.9 * autumnBlow;
    }
    vec2 d = p - cp - sway;
    float r = cs * 0.62 * autumnLeafScale(h2);
    if (dot(d, d) > r * r * 2.4) continue;
    // The canopy's depth bounds its mass, and its thinness is at most 1: where even those would hold
    // no leaf, the holes are never looked at.
    float edge = autumnCanopyEdge(cp.x);
    float depth = autumnCanopyDepth(cp, edge);
    if (h > depth * density * (0.7 + 1.0)) continue;
    vec2 mf = autumnMassField(cp, edge, depth);
    if (h > mf.x * density * (0.7 + mf.y)) continue;
    float ang = (hash12(id + 9.1 + salt) - 0.5) * 6.2831 + 0.12 * sin(autumnTm * 0.31 + ph);
    vec2 q = rotate(d, -ang) / r;
    float cov = hardFill(autumnLeafD(q, h2) * r, aa);
    if (cov <= 0.0) continue;
    float lightK = autumnCanopyLight(cp, edge);
    float hue = clamp(autumnCanopyHue(cp) + (hash12(id * 0.37 + salt * 2.1) - 0.5) * 0.3, 0.0, 1.0);
    bool top = hash12(id + 3.3 + salt) < 0.5;
    vec3 nv = normalize(vec3((jit.x - 0.5) * 1.4, (jit.y - 0.5) * 1.2 + 0.25, -1.0));
    float lit = lightK > 0.55 ? 1.0 : 0.0;
    best = vec4(autumnLeafColour(hue, top, nv, lit, 0.0, 0.0) * shadeK * (0.55 + 0.6 * lightK), 1.0);
    bestK = h2;
  }
  return best;
}

// ---- the leaves in the air ----

// A falling leaf's cell (the composer's falling things, composer/falling.ts; LayerFalling.leaf): its
// hue band's colour in the tree's palette, the face it shows (shade 0 and 1 its top, 2 and 3 its
// paler underside), lying toward the sky (0, 2) or standing on edge (1, 3), lit where the sun reaches
// its point at depth z, warmed by the lamp's pool near the ground.
vec3 mapleLeafSpeck(float hue, int shade, float z, Ctx x) {
  bool top = shade < 2;
  vec3 nv = normalize(shade == 1 || shade == 3 ? vec3(0.0, 0.35, -1.0) : vec3(0.0, 1.0, -0.35));
  vec3 P = vec3(autumnP.x * z, AUTUMN_EYE + (autumnP.y - AUTUMN_HORIZON) * z, z);
  float lit = hardEdge(autumnShadow(P));
  vec3 col = autumnLeafColour(hue, top, nv, lit, 0.0, 0.0);
  return col + autumnLeafTop(hue) * autumnLampLight(P.xz) * 0.5 * step(P.y, 1.0);
}

// ---- the maple's pass ----
// Back to front over what stands behind (the ground, the litter, the lamp): the bench, the canopy's
// layers and the trunk. Each part stands at its depth: drawn unless something already nearer (a
// guest) hides it, a foot over the ground just before it; the leaves in the air are drawn among them
// by depth in the composer's speck pass.
void mapleFront(Ctx x, inout Cell c) {
  vec2 p = autumnP;
  vec4 bench = autumnBench(p);
  if (bench.a > 0.0 && AUTUMN_BENCH_AT.y < c.z + 0.5) {
    autumnStand(c, bench, AUTUMN_BENCH_AT.y);
    c.accent = 0.0;
  }
  bool high = x.uv.y > 0.4;
  if (high) {
    // Back: the canopy's body (clumps lit on the sun's side, the light glowing through where it thins)
    // and the farthest leaves, 9.5 m off.
    vec4 body = autumnCanopyBody(p);
    vec4 back = autumnCanopyLayer(p, 0.020, 1.0, 0.45, 0.6);
    vec4 b = back.a > 0.5 ? back : body;
    if (b.a > 0.0 && 9.5 < c.z + 0.5) autumnStand(c, b, 9.5);
    vec4 mid = autumnCanopyLayer(p, 0.026, 2.0, 0.6, 0.85);
    if (mid.a > 0.0 && 7.0 < c.z + 0.5) autumnStand(c, mid, 7.0);
  }
  vec4 trunk = autumnTrunk(p);
  if (trunk.a > 0.0 && AUTUMN_TREE.y < c.z + 0.5) {
    autumnStand(c, trunk, AUTUMN_TREE.y);
    c.accent = 0.0;
  }
  if (high) {
    vec4 front = autumnCanopyLayer(p, 0.034, 3.0, 0.3, 1.0);
    if (front.a > 0.0 && 4.2 < c.z + 0.5) autumnStand(c, front, 4.2);
  }
}

// The tree's, the bench's and the lamp's shadows on another layer's floor (the composer's casterShadow).
float mapleShade(vec2 xz, Ctx x) {
  return 1.0 - autumnShadow(vec3(xz.x, 0.0, xz.y));
}
`;

/** The litter's GLSL: the carpet of fallen leaves over the floor. */
export const litterGlsl = `
// ---- the carpet ----

// One layer of the carpet at ground point pw (metres): the leaf there (rgb, cover) and whether it is
// one of the M's. layer 0 is the lattice, layer 1 the lattice shifted half a cell. aa: metres a cell
// covers; lit: the sun reaches the ground here (0 or 1).
vec4 autumnCarpetLayer(vec2 pw, float layer, float aa, float lit, float lod, out float isMark) {
  isMark = 0.0;
  vec2 g = (pw - AUTUMN_CARPET.xy) / AUTUMN_CARPET.z - 0.5 * layer;
  vec2 i0 = floor(g);
  vec2 f = g - i0;
  vec2 nb = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  vec4 best = vec4(0.0);
  float dissolve = edgeThreshold(gl_FragCoord.xy, vec2(5.0, 2.0));
  for (int k = 0; k < 4; k++) {
    vec2 id = i0 + vec2(float(k - 2 * (k / 2)) * nb.x, float(k / 2) * nb.y);
    if (id.x < 0.0 || id.y < 0.0 || id.x >= float(AUTUMN_CARPET_SIZE.x) || id.y >= float(AUTUMN_CARPET_SIZE.y)) continue;
    vec4 c = layer < 0.5 ? texelFetch(litterField0, ivec2(id), 0) : texelFetch(litterField1, ivec2(id), 0);
    float aw = abs(c.w);
    if (aw < 1.0) continue;
    float mk = step(16.0, aw);
    aw -= 16.0 * mk;
    float level = floor(aw);
    if (level / 8.0 <= dissolve) continue;
    float hue = clamp(fract(aw) / 0.98, 0.0, 1.0);
    vec2 d = (g - (id + 0.5 + c.xy)) * AUTUMN_CARPET.z;
    float R = autumnLeafRadius() * autumnLeafScale(hue);
    if (dot(d, d) > R * R * 2.3) continue;
    float ca = cos(c.z);
    float sa = sin(c.z);
    vec2 q = vec2(-sa * d.x + ca * d.y, ca * d.x + sa * d.y) / R;
    float k1 = hash12(id + layer * 17.0);
    float cov = hardFill(autumnLeafD(q, k1) * R, aa);
    cov *= mk > 0.5 ? 1.0 : 1.0 - smoothstep(0.22, 0.6, lod);
    if (cov <= 0.0) continue;
    float vein = 0.0;
    if (R / aa > 7.0) vein = hardFill(autumnVein(q) - 0.04, aa / R);
    bool top = c.w > 0.0;
    vec3 col = autumnLeafColour(hue, top, vec3(0.0, 1.0, 0.0), lit, vein, mk);
    col += autumnLeafTop(hue) * autumnLampLight(pw) * 0.7;
    best = vec4(col, 1.0);
    isMark = mk;
  }
  return best;
}

// The carpet over the floor: the half-shifted layer first, the lattice over it, both under the path's
// contact shadows and (over the park's own ground) the haze it takes; the M's leaves its accent. The
// foot of anything standing at the ground point keeps it off (what hides a speck there, c.zs).
void litterMiddle(Ctx x, inout Cell c) {
  if (!autumnOnFloor || !litterField0On() || c.zs < autumnFloorZ + 0.5) return;
  float m1 = 0.0;
  float m2 = 0.0;
  vec4 lb = autumnCarpetLayer(autumnW, 1.0, autumnFloorAa, autumnFloorLit, autumnFoot.y, m2);
  vec4 la = autumnCarpetLayer(autumnW, 0.0, autumnFloorAa, autumnFloorLit, autumnFoot.y, m1);
  if (lb.a <= 0.0 && la.a <= 0.0) return;
  vec3 col = autumnFloorDrawn ? autumnFloorCol : c.col;
  col = mix(col, lb.rgb * autumnFloorAo, lb.a);
  col = mix(col, la.rgb * autumnFloorAo, la.a);
  c.col = autumnFloorDrawn ? mix(col, x.air.haze, autumnFloorHaze) : col;
  c.accent = max(m2 * lb.a, m1 * la.a);
}
`;
