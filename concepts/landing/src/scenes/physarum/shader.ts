// The slime mould's picture, from the fields its sim grows (sim.ts): golden plasmodium and oat
// flakes in a petri dish of warm agar, a sumi drawing on paper, or a night transit map.
//   uSim0  rg16f over the trail grid (the frame plus PHYSARUM_MARGIN texels round it): R the trail in
//          units of its trunk level, smoothed; G its slow memory (the slime the mould leaves behind)
//   uSim1  r32f (nearest; r16f in the still fallback) at half resolution: distance along the veins
//          from the heart, screen heights. Filtered here by hand: 32-bit floats may not filter.
//   uSim2  rgba16f PHYSARUM_MAX_FOOD × 3, nearest: row 0 per flake centre uv, radius (heights),
//          presence (negative while it is eaten); row 1 turn, squash, grain, 1 for a crumb; row 2
//          texel 0 the streaming phase, the heart's presence and its centre uv, texel 1 the M (centre
//          uv, height, shown), texel 2 the entrance's growth 0..1 (the sim's own clock, 1 at rest)
//   uSim3  rgba at half resolution: R scent, G salt, B feeding, A light (the sea, and past the dish)
// The trail arrives in tone (sim.ts VIEW): a typical filament at ~0.3, trunks at ~1. It is drawn
// in three registers: a dim ochre lace (0.1–0.28), golden veins (0.4–0.72) and the pale, lit cores
// of trunks (0.9–1.4). Round a flake the plasmodium lies plain and flat over the oat: no pale core,
// no relief, so a flake never reads as a glossy bead. Knobs read here: K_palette (0 agar, 1 ink,
// 2 rail), K_pulse, K_relief, K_slime.
//
// Entrance: oat flakes land on the dish on passageIn(), staggered, the heart's first; then the mould
// grows out of the heart along its veins (the sim's distance field) on the sim's own growth clock,
// which starts once its prewarm is done and ignores slow frames, so a slow first frame cannot use it
// up: strands reach out thin and thicken behind the front, the fine lace filling in after. Cut per
// cell, never faded. Exit
// (passageOut): the lace thins away, then the strands thin and draw back into the nearest flakes,
// leaving the slime they laid; the flakes stay. At rest none of it is drawn.
import { glslFloat } from "../../shaders/glsl.ts";
import { PHYSARUM_DISH, PHYSARUM_FAR, PHYSARUM_MARGIN, PHYSARUM_MAX_FOOD, PHYSARUM_PASSAGE, PHYSARUM_WAVE } from "./sim.ts";

export const physarumGlsl = `
const float PHYSARUM_MARGIN = ${glslFloat(PHYSARUM_MARGIN)};
const int PHYSARUM_FOOD = ${PHYSARUM_MAX_FOOD};
const float PHYSARUM_WAVE = ${glslFloat(PHYSARUM_WAVE)};
const float PHYSARUM_FAR = ${glslFloat(PHYSARUM_FAR)};
const float PHYSARUM_DISH = ${glslFloat(PHYSARUM_DISH)};
// The dish's glass wall, screen heights thick.
const float PHYSARUM_WALL = 0.014;

// The entrance, in seconds of it: each flake lands over LAND_SECONDS, starting at LAND_FROM plus its
// own share of LAND_SPREAD (the heart's LAND_HEART); the veins' front runs from GROW_FROM over
// GROW_SECONDS, the lace's from LACE_FROM over LACE_SECONDS. Fronts are in screen heights.
const float PHYSARUM_ENTER = ${glslFloat(PHYSARUM_PASSAGE.enter)};
const float PHYSARUM_LAND_FROM = 0.4;
const float PHYSARUM_LAND_SPREAD = 0.75;
const float PHYSARUM_LAND_HEART = 0.3;
const float PHYSARUM_LAND_SECONDS = 0.5;
const float PHYSARUM_GROW_FROM = 0.8;
const float PHYSARUM_GROW_SECONDS = 2.1;
const float PHYSARUM_LACE_FROM = 1.2;
const float PHYSARUM_LACE_SECONDS = 1.9;
// The exit's farthest strand from any flake (heights) before it starts to draw back, and the share
// of the veins' thickness the strands keep once thinned.
const float PHYSARUM_DRAW = 1.2;
const float PHYSARUM_THIN = 0.55;

// Agar: warm amber, brighter under a lamp high on the left; the lit sea the mould shuns, cool and
// pale; the glossy track of slime it leaves; the meniscus where the agar climbs the glass; the
// glass wall and the dark bench beyond it.
const vec3 PHYSARUM_AGAR = vec3(0.105, 0.074, 0.040);
const vec3 PHYSARUM_LAMP = vec3(0.060, 0.042, 0.020);
const vec3 PHYSARUM_LIT = vec3(0.150, 0.155, 0.148);
const vec3 PHYSARUM_SLIME = vec3(0.070, 0.052, 0.020);
const vec3 PHYSARUM_MENISCUS = vec3(0.10, 0.075, 0.040);
const vec3 PHYSARUM_GLASS = vec3(0.17, 0.18, 0.18);
const vec3 PHYSARUM_BENCH = vec3(0.020, 0.018, 0.017);
// The plasmodium: a dim ochre lace of fine filaments, a faint film round the veins, golden veins,
// pale trunk cores.
const vec3 PHYSARUM_LACE = vec3(0.42, 0.27, 0.06);
const vec3 PHYSARUM_FILM = vec3(0.16, 0.09, 0.012);
const vec3 PHYSARUM_VEIN = vec3(0.93, 0.66, 0.10);
const vec3 PHYSARUM_CORE = vec3(1.0, 0.89, 0.42);
// Rolled oats, fresh (pale meal, a few bran specks) and eaten; salt.
const vec3 PHYSARUM_OAT = vec3(0.87, 0.80, 0.64);
const vec3 PHYSARUM_BRAN = vec3(0.56, 0.42, 0.24);
const vec3 PHYSARUM_HUSK = vec3(0.40, 0.32, 0.20);
const vec3 PHYSARUM_SALT = vec3(0.86, 0.88, 0.90);
// Ink: warm paper, sumi, its grey bleed, a pale wash for the sea.
const vec3 PHYSARUM_PAPER = vec3(0.925, 0.898, 0.835);
const vec3 PHYSARUM_SUMI = vec3(0.105, 0.100, 0.125);
const vec3 PHYSARUM_BLEED = vec3(0.70, 0.68, 0.66);
const vec3 PHYSARUM_WASH = vec3(0.80, 0.845, 0.86);
// Rail: a night map, lines in sodium amber, minor ones dim, white stations, disused lines in blue,
// salt as closures.
const vec3 PHYSARUM_NIGHT = vec3(0.030, 0.045, 0.090);
const vec3 PHYSARUM_SEA = vec3(0.012, 0.022, 0.055);
const vec3 PHYSARUM_COAST = vec3(0.10, 0.17, 0.30);
const vec3 PHYSARUM_MINOR = vec3(0.30, 0.17, 0.06);
const vec3 PHYSARUM_LINE = vec3(1.0, 0.70, 0.28);
const vec3 PHYSARUM_LINECORE = vec3(1.0, 0.93, 0.74);
const vec3 PHYSARUM_GLOW = vec3(0.14, 0.07, 0.02);
const vec3 PHYSARUM_DISUSED = vec3(0.06, 0.09, 0.16);
const vec3 PHYSARUM_STATION = vec3(0.95, 0.95, 0.92);
const vec3 PHYSARUM_CLOSED = vec3(0.62, 0.20, 0.16);

// Toward the lamp, high on the left: in the plane, and in 3D (both unit).
const vec2 PHYSARUM_TOLAMP = vec2(-0.6402, 0.7682);
const vec3 PHYSARUM_LIGHT = vec3(-0.50, 0.60, 0.6245);

// Where a point of the frame lies in the sim's fields, which run PHYSARUM_MARGIN texels past every edge.
vec2 physarumDomain(vec2 uv) {
  vec2 m = PHYSARUM_MARGIN / vec2(textureSize(uSim0, 0));
  return m + uv * (1.0 - 2.0 * m);
}

// The distance along the veins at a point of the fields, bilinear by hand (see uSim1 above).
float physarumDistance(vec2 d) {
  ivec2 size = textureSize(uSim1, 0);
  vec2 at = d * vec2(size) - 0.5;
  vec2 w = fract(at);
  ivec2 a = clamp(ivec2(floor(at)), ivec2(0), size - 1);
  ivec2 b = clamp(ivec2(floor(at)) + 1, ivec2(0), size - 1);
  float d00 = texelFetch(uSim1, a, 0).r;
  float d10 = texelFetch(uSim1, ivec2(b.x, a.y), 0).r;
  float d01 = texelFetch(uSim1, ivec2(a.x, b.y), 0).r;
  float d11 = texelFetch(uSim1, b, 0).r;
  return mix(mix(d00, d10, w.x), mix(d01, d11, w.x), w.y);
}

struct PhysarumField {
  float dens;   // the trail in tone: ~1 on a trunk, ~0.3 on the lace
  float glow;   // the trail a few texels round: the film of plasmodium about the veins
  vec2 grad;    // its slope, per texel
  float lee;    // the trail a little toward the lamp: veins shading the agar beside them
  float memory; // the trail over the last minute: the slime track
  float dist;   // along the veins from the heart, screen heights
  vec4 env;     // scent, salt, feeding, light
};

PhysarumField physarumField(vec2 uv) {
  PhysarumField f;
  f.dens = 0.0;
  f.glow = 0.0;
  f.grad = vec2(0.0);
  f.lee = 0.0;
  f.memory = 0.0;
  f.dist = 1e3;
  f.env = vec4(0.0);
  if (uSimOn.x < 0.5) return f;
  vec2 d = physarumDomain(uv);
  vec2 tx = 1.0 / vec2(textureSize(uSim0, 0));
  vec2 c = texture(uSim0, d).rg;
  // A cross 1.4 texels out: with the view's own 2 × 2 average, a one-texel filament is drawn as a
  // soft line about two cells wide however fine the grid is under the dither.
  vec2 b = 1.4 * tx;
  float e = texture(uSim0, d + vec2(b.x, 0.0)).r;
  float w = texture(uSim0, d - vec2(b.x, 0.0)).r;
  float n = texture(uSim0, d + vec2(0.0, b.y)).r;
  float s = texture(uSim0, d - vec2(0.0, b.y)).r;
  vec2 r = 3.0 * tx;
  f.glow = 0.25 * (texture(uSim0, d + r).r + texture(uSim0, d - r).r
    + texture(uSim0, d + vec2(r.x, -r.y)).r + texture(uSim0, d + vec2(-r.x, r.y)).r);
  f.dens = 0.5 * c.r + 0.125 * (e + w + n + s);
  f.grad = vec2(e - w, n - s) / 2.8;
  f.lee = texture(uSim0, d + PHYSARUM_TOLAMP * 2.5 * tx).r;
  f.memory = c.g;
  if (uSimOn.y > 0.5) f.dist = physarumDistance(d);
  if (uSimOn.w > 0.5) f.env = texture(uSim3, d);
  return f;
}

// Salt: grains three cells apart, each a crisp 2 × 2 cells set by its own hash, present (at most
// seven in ten, so even thick salt reads as scattered crystals, not a lattice) where the salt at its
// centre is thick enough: a line of salt thins grain by grain as it dissolves. x: grain, y: its lit
// corner.
vec2 physarumGrains(vec2 cell) {
  if (uSimOn.x < 0.5 || uSimOn.w < 0.5) return vec2(0.0);
  vec2 g = floor(cell / 3.0);
  float salt = texture(uSim3, physarumDomain((g * 3.0 + 1.5) / uRes)).g;
  if (salt < 0.02 || hash12(g + 3.1) > 0.7 * salt) return vec2(0.0);
  vec2 local = floor(cell) - g * 3.0 - floor(vec2(hash12(g + 7.7), hash12(g + 9.3)) * 2.0);
  if (local.x < 0.0 || local.y < 0.0 || local.x > 1.0 || local.y > 1.0) return vec2(0.0);
  return vec2(1.0, local.x < 0.5 && local.y > 0.5 ? 1.0 : 0.0);
}

// Oat dust strewn along the M's strokes while it is laid: specks of 2 × 2 cells.
float physarumDust(vec2 p, vec2 cell, vec4 mark, float aspect) {
  if (mark.w < 0.002 || mark.z <= 0.0) return 0.0;
  vec2 c = vec2((mark.x - 0.5) * aspect, mark.y - 0.5);
  float near = 1.0 - smoothstep(0.004, 0.016, markDistance((p - c) / mark.z) * mark.z);
  if (near <= 0.0) return 0.0;
  return near * mark.w * step(0.72, hash12(floor(cell / 2.0) + 17.0));
}

// A rolled oat from above: flat and matt, its edge torn and irregular, pale meal ridged along its
// length and lighter where it thins at the rim, a few brown bran specks, a small soft shadow. A
// fresh one lands, shrinking a little as its shadow closes in under it; an eaten one shrinks and
// browns to a husk. Returns its cover.
float physarumOat(vec2 p, vec2 c, float r, vec4 shape, float presence, bool eaten, float px, inout vec3 col) {
  float fade = smoothstep(0.0, 0.35, presence);
  float fall = eaten ? 0.0 : (1.0 - presence) * (1.0 - presence);
  r *= eaten ? 0.6 + 0.4 * presence : 1.0 + 0.3 * fall;
  vec2 away = vec2(0.3, -0.36) * r * (1.0 + 4.0 * fall);
  vec2 squash = vec2(1.0, 1.0 / shape.y);
  vec2 q = rotate(p - c, -shape.x) * squash;
  vec2 qs = rotate(p - c - away, -shape.x) * squash;
  // A torn edge: three octaves of noise taken round a circle, so it closes without a seam.
  float a = atan(q.y, q.x + 1e-6);
  vec2 rim = vec2(cos(a), sin(a));
  float edge = r * (1.0 + 0.22 * (vnoise(rim * 1.6 + shape.z * 41.0) - 0.5)
    + 0.12 * (vnoise(rim * 3.7 + shape.z * 13.0) - 0.5) + 0.06 * (vnoise(rim * 8.0 + shape.z * 7.0) - 0.5));
  float shadow = (1.0 - smoothstep(-0.3 * r, 0.5 * r * (1.0 + fall), length(qs) - edge)) * fade;
  col *= 1.0 - 0.35 * shadow;
  float len = length(q);
  float cover = softFill(len - edge, px) * fade;
  if (cover <= 0.0) return 0.0;
  float u = clamp(len / edge, 0.0, 1.0);
  vec2 dir = (p - c) / max(length(p - c), 1e-6);
  float tint = 1.0 + 0.08 * dot(dir, PHYSARUM_TOLAMP) * u;
  float ridge = vnoise(vec2(q.x / r * 1.6, q.y / r * 5.5) + shape.z * 57.0);
  float grit = vnoise(q / r * 6.0 + shape.z * 91.0);
  vec3 oat = PHYSARUM_OAT * tint * (0.9 + 0.16 * ridge) * (1.0 + 0.08 * smoothstep(0.75, 1.0, u));
  oat = mix(oat, PHYSARUM_BRAN, 0.6 * smoothstep(0.72, 0.8, grit));
  if (eaten) oat = mix(oat, PHYSARUM_HUSK, 1.0 - presence);
  col = mix(col, oat, cover);
  return cover;
}

// Ink: a dot inside a fine ring, as food is marked on a plate; an eaten one's dot shrinks away.
float physarumDot(vec2 p, vec2 c, float r, float presence, bool eaten, float px, inout vec3 col) {
  float fade = smoothstep(0.0, 0.35, presence);
  float d = length(p - c);
  float inner = r * (eaten ? 0.55 * presence : 0.55);
  float fill = (1.0 - smoothstep(inner - px, inner + px, d)) * fade;
  float ring = (1.0 - smoothstep(0.5 * px, 1.4 * px, abs(d - 1.15 * r))) * fade * (eaten ? presence : 1.0);
  col = mix(col, PHYSARUM_SUMI, max(fill, ring));
  return fill;
}

// Rail: a station, a white ring round a dark hole with a white pip.
float physarumStation(vec2 p, vec2 c, float r, float presence, bool eaten, float px, inout vec3 col) {
  float fade = smoothstep(0.0, 0.35, presence) * (eaten ? presence : 1.0);
  float d = length(p - c);
  float outer = 0.8 * r;
  float disc = (1.0 - smoothstep(outer - px, outer + px, d)) * fade;
  float hole = (1.0 - smoothstep(0.55 * outer - px, 0.55 * outer + px, d)) * fade;
  float pip = (1.0 - smoothstep(0.22 * outer - px, 0.22 * outer + px, d)) * fade;
  col = mix(col, PHYSARUM_STATION, disc);
  col = mix(col, PHYSARUM_NIGHT, hole);
  col = mix(col, PHYSARUM_STATION, pip);
  return disc;
}

// How far a flake has landed, 0..1 over its landing (the entrance only): the heart's first, the rest
// staggered by their own grain. 'shape' is the flake's row 1, 'c' its centre in p, 'heart' the heart's.
float physarumLanding(vec4 shape, vec2 c, vec2 heart, float tin) {
  float delay = length(c - heart) < 0.002 ? PHYSARUM_LAND_HEART : PHYSARUM_LAND_FROM + PHYSARUM_LAND_SPREAD * shape.z;
  return clamp((tin * PHYSARUM_ENTER - delay) / PHYSARUM_LAND_SECONDS, 0.0, 1.0);
}

// Every flake on the dish, in the palette's manner. Returns their cover; near rises to 1 within a
// couple of radii of a flake.
float physarumNodes(vec2 p, float aspect, float px, int palette, float tin, vec2 heart, inout vec3 col, inout float near) {
  if (uSimOn.z < 0.5) return 0.0;
  float cover = 0.0;
  for (int i = 0; i < PHYSARUM_FOOD; i++) {
    vec4 node = texelFetch(uSim2, ivec2(i, 0), 0);
    float presence = abs(node.w);
    if (presence < 0.002) continue;
    vec2 c = vec2((node.x - 0.5) * aspect, node.y - 0.5);
    if (length(p - c) > 5.0 * node.z + 0.01) continue;
    // Entrance: the flake lands (at rest tin is 1 and this is skipped).
    if (tin < 1.0) {
      presence = min(presence, physarumLanding(texelFetch(uSim2, ivec2(i, 1), 0), c, heart, tin));
      if (presence < 0.002) continue;
    }
    bool eaten = node.w < 0.0;
    near = max(near, presence * (1.0 - smoothstep(1.2 * node.z, 2.6 * node.z, length(p - c))));
    if (palette == 1) cover = max(cover, physarumDot(p, c, node.z, presence, eaten, px, col));
    else if (palette == 2) cover = max(cover, physarumStation(p, c, node.z, presence, eaten, px, col));
    else cover = max(cover, physarumOat(p, c, node.z, texelFetch(uSim2, ivec2(i, 1), 0), presence, eaten, px, col));
  }
  return cover;
}

// Clear space from p to the nearest flake on the dish (heights), 0 inside one.
float physarumFoodDistance(vec2 p, float aspect) {
  float best = 1e3;
  for (int i = 0; i < PHYSARUM_FOOD; i++) {
    vec4 node = texelFetch(uSim2, ivec2(i, 0), 0);
    if (abs(node.w) < 0.002) continue;
    vec2 c = vec2((node.x - 0.5) * aspect, node.y - 0.5);
    best = min(best, length(p - c) - node.z);
  }
  return max(best, 0.0);
}

// The mould's entrance and exit, applied to the fields before they are drawn. Cells are cut whole
// (hardEdge at two decorrelated thresholds: one for whether the plasmodium has reached a cell, one
// for whether it has thickened yet), so the front is a dithered edge that flips each cell once.
void physarumPassage(inout PhysarumField f, vec2 p, vec2 cell, float aspect, float dishR, vec2 heart, float grown) {
  float tout = passageOut();
  if (grown >= 1.0 && tout <= 0.0) return;
  if (uSimOn.x < 0.5) return;
  float th = edgeThreshold(cell, vec2(0.0));
  float th2 = edgeThreshold(cell, vec2(23.0, 41.0));
  // Veins (and trunks) follow the veins' front, the lace between the lace's: the vein-ness of a point.
  float vt = smoothstep(0.3, 0.55, f.dens);
  float reached = 1.0;
  float thick = 1.0;
  if (grown < 1.0) {
    float t = grown * PHYSARUM_ENTER;
    float away = length(p - heart);
    float along = f.dist < 0.9 * PHYSARUM_FAR ? f.dist : 1.35 * away + 0.15;
    float sv = clamp((t - PHYSARUM_GROW_FROM) / PHYSARUM_GROW_SECONDS, 0.0, 1.0);
    float sl = clamp((t - PHYSARUM_LACE_FROM) / PHYSARUM_LACE_SECONDS, 0.0, 1.0);
    float fv = (2.0 * dishR + 0.2) * sv * sv * (3.0 - 2.0 * sv);
    float fl = (1.9 * dishR + 0.2) * sl * sl * (3.0 - 2.0 * sl);
    float coverVein = smoothstep(0.0, 0.1, fv - along);
    float coverLace = smoothstep(0.0, 0.3, fl - 1.25 * away);
    reached *= hardEdge(mix(coverLace, coverVein, vt), th);
    // Strands reach out thin, then thicken behind the front.
    float thicken = mix(1.0, smoothstep(0.1, 0.55, fv - along), vt);
    thick *= mix(PHYSARUM_THIN, 1.0, hardEdge(thicken, th2));
  }
  if (tout > 0.0) {
    float e = 1.0 - pow(1.0 - tout, 2.2);
    float gap = uSimOn.z > 0.5 ? physarumFoodDistance(p, aspect) : length(p - heart);
    // The lace goes first (it counts as farther from food), then the strands draw back.
    float lag = gap * mix(1.6, 1.0, vt);
    float coverBack = smoothstep(0.0, 0.08, PHYSARUM_DRAW * (1.0 - e) - lag);
    reached *= hardEdge(coverBack, th);
    thick *= mix(PHYSARUM_THIN, 1.0, hardEdge(1.0 - smoothstep(0.0, 0.55, e), th2));
  }
  float shown = reached * thick;
  f.dens *= shown;
  f.glow *= shown;
  f.lee *= shown;
  f.grad *= shown;
  // Slime is left behind on the way out, but is not there before the mould is.
  if (grown < 1.0) f.memory *= shown;
}

Shade scenePhysarum(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float px = 1.0 / uRes.y;
  int palette = int(K_palette + 0.5);

  PhysarumField f = physarumField(uv);
  vec4 state = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(0, 2), 0) : vec4(0.0);
  vec4 mark = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(1, 2), 0) : vec4(0.0);

  // The petri dish: centred, its glass wall cutting the frame's corners. 'facing' is how squarely
  // the wall (or the meniscus) at this bearing faces the lamp: the far side catches it.
  float dishR = PHYSARUM_DISH * 0.5 * length(vec2(aspect, 1.0));
  // The mould's entrance and exit (nothing at rest): where it began, and what has grown or drawn back.
  float tin = passageIn();
  float grown = uSimOn.z > 0.5 ? texelFetch(uSim2, ivec2(2, 2), 0).x : 1.0;
  vec2 heart = vec2((state.z - 0.5) * aspect, state.w - 0.5);
  physarumPassage(f, p, cell, aspect, dishR, heart, grown);
  float rr = length(p);
  float inside = 1.0 - smoothstep(dishR - px, dishR + px, rr);
  float wall = smoothstep(dishR - px, dishR + px, rr) * (1.0 - smoothstep(dishR + PHYSARUM_WALL - px, dishR + PHYSARUM_WALL + px, rr));
  float lip = 1.0 - smoothstep(0.4 * px, 1.4 * px, abs(rr - dishR - 0.65 * PHYSARUM_WALL));
  float facing = 0.5 - 0.5 * dot(p / max(rr, 1e-5), PHYSARUM_TOLAMP);
  float meniscus = smoothstep(dishR - 0.025, dishR - 0.003, rr) * inside;
  // Darkening toward the wall: the agar is thinner there and the lamp further.
  float vignette = 0.76 + 0.24 * (1.0 - smoothstep(0.4 * dishR, dishR, rr));
  float shore = 1.0 - smoothstep(dishR - 0.03, dishR - 0.015, rr);

  // Shuttle streaming: a slow, low wave of brightness running along the veins out from the heart
  // (and back, once the flow reverses). Brightness only, so no vein's edge moves with it.
  float surge = 0.0;
  if (K_pulse > 0.0) {
    float wave = cos(TAU * (f.dist / PHYSARUM_WAVE - state.x));
    surge = 0.17 * K_pulse * state.y * wave * (1.0 - smoothstep(0.5 * PHYSARUM_FAR, 0.8 * PHYSARUM_FAR, f.dist));
  }
  float lace = smoothstep(0.1, 0.28, f.dens);
  float body = smoothstep(0.4, 0.72, f.dens);
  float core = smoothstep(0.9, 1.4, f.dens);
  float halo = smoothstep(0.35, 0.85, f.glow);
  float lee = smoothstep(0.4, 1.0, f.lee) * (1.0 - body) * K_relief;
  float track = smoothstep(0.1, 0.4, f.memory - 0.8 * f.dens) * K_slime;
  float near = 0.0;
  float sea = smoothstep(0.35, 0.65, f.env.a) * shore;
  float coast = (1.0 - smoothstep(0.04, 0.14, abs(f.env.a - 0.5))) * shore;
  float damp = smoothstep(0.03, 0.4, f.env.g);
  vec2 grain = physarumGrains(cell);
  float dust = physarumDust(p, cell, mark, aspect);
  // The veins lit as tubes from the lamp: 1 on the flat, brighter on the slopes facing it.
  vec3 tilt = normalize(vec3(-2.6 * f.grad, 1.0));
  float relief = mix(1.0, clamp(dot(tilt, PHYSARUM_LIGHT) / PHYSARUM_LIGHT.z, 0.55, 1.45), K_relief);

  vec3 col;
  float nodes;
  if (palette == 1) {
    // Ink: a sumi drawing on warm paper, the dish a drawn circle; the lace hairlines of grey, thin
    // veins grey, trunks black and pooled at their edges; the sea a hatched wash, abandoned veins a
    // ghost of grey, salt a stipple.
    col = PHYSARUM_PAPER * (0.965 + 0.06 * fbm(cell / 70.0 + 2.3));
    float hatch = step(mod(floor(cell.y), 5.0), 0.5);
    col = mix(col, PHYSARUM_WASH * (1.0 - 0.08 * hatch), sea);
    col = mix(col, PHYSARUM_SUMI, 0.7 * coast);
    col *= 1.0 - 0.08 * track - 0.06 * damp;
    col = mix(col, PHYSARUM_SUMI * 3.0, 0.75 * grain.x);
    col = mix(col, PHYSARUM_SUMI, 0.5 * dust);
    col = mix(col, PHYSARUM_BLEED, 0.25 * halo * (1.0 - lace));
    col = mix(col, PHYSARUM_BLEED * 0.8, 0.55 * lace * (1.0 - body));
    float pool = K_relief * smoothstep(0.12, 0.45, length(f.grad));
    vec3 ink = mix(PHYSARUM_BLEED * 0.55, PHYSARUM_SUMI, max(core, pool)) * (1.0 - 0.6 * surge);
    col = mix(col, ink, body);
    nodes = physarumNodes(p, aspect, px, 1, tin, heart, col, near);
    col = mix(col, PHYSARUM_SUMI, 0.8 * (1.0 - smoothstep(0.4 * px, 1.3 * px, abs(rr - dishR))));
  } else if (palette == 2) {
    // Rail: a night transit map, a faint graticule, the lace minor lines in dim amber, trunks the
    // main lines glowing in sodium amber, disused ones a dim blue, salt red closures, flakes as
    // stations; past the dish the map's dark margin.
    col = PHYSARUM_NIGHT;
    vec2 graticule = (0.5 - abs(fract(p / 0.125) - 0.5)) * 0.125;
    col += 0.02 * (1.0 - smoothstep(0.4 * px, 1.1 * px, min(graticule.x, graticule.y)));
    col = mix(col, PHYSARUM_SEA, sea);
    col = mix(col, PHYSARUM_COAST, coast);
    col += PHYSARUM_DISUSED * track;
    col = mix(col, PHYSARUM_CLOSED, grain.x);
    col += PHYSARUM_GLOW * halo * (1.0 - lace);
    col = mix(col, PHYSARUM_MINOR, 0.6 * lace * (1.0 - body));
    vec3 line = mix(PHYSARUM_LINE, PHYSARUM_LINECORE, core) * relief * (1.0 + surge);
    col = mix(col, line, body);
    col = mix(col, PHYSARUM_STATION * 0.6, 0.6 * dust);
    nodes = physarumNodes(p, aspect, px, 2, tin, heart, col, near);
    col = mix(PHYSARUM_SEA * 0.6, col, inside);
    col = mix(col, PHYSARUM_COAST, 1.0 - smoothstep(0.4 * px, 1.3 * px, abs(rr - dishR)));
  } else {
    // Agar: warm and mottled, brighter under the lamp and darkening toward the wall; the sea lit
    // pale, the slime track glossy, the agar wet round the salt and shaded beside the veins. Then
    // the flakes and the salt, and the plasmodium over them: its dim lace, the film round its
    // veins, the veins themselves lit as tubes, lying thinner across the flakes it is eating. Then
    // the meniscus, the glass wall and the bench.
    col = PHYSARUM_AGAR * (0.84 + 0.32 * fbm(p * 2.4 + 3.7));
    vec2 lamp = p - vec2(-0.45 * aspect, 0.42);
    col += PHYSARUM_LAMP * exp(-1.4 * dot(lamp, lamp));
    col *= vignette;
    col = mix(col, PHYSARUM_LIT * (0.94 + 0.12 * fbm(p * 1.8 + 9.1)), sea);
    col += 0.05 * coast;
    col += PHYSARUM_SLIME * track;
    col *= (1.0 - 0.35 * damp) * (1.0 - 0.4 * lee);
    col = mix(col, PHYSARUM_OAT * 0.8, 0.8 * dust);
    nodes = physarumNodes(p, aspect, px, 0, tin, heart, col, near);
    col = mix(col, PHYSARUM_SALT * (grain.y > 0.5 ? 1.08 : 0.9), grain.x);
    float veil = 1.0 - 0.7 * nodes;
    float plain = 1.0 - near;
    col += PHYSARUM_FILM * halo * (1.0 - lace) * veil * plain;
    col = mix(col, PHYSARUM_LACE, 0.6 * lace * (1.0 - body) * veil);
    vec3 vein = mix(PHYSARUM_VEIN, PHYSARUM_CORE, core * plain) * mix(1.0, relief, plain) * (1.0 + surge);
    col = mix(col, vein, body * veil);
    col += PHYSARUM_MENISCUS * meniscus * (0.4 + 0.6 * facing);
    col = mix(PHYSARUM_BENCH, col, inside);
    col = mix(col, PHYSARUM_GLASS * (0.5 + 0.8 * facing), 0.7 * wall);
    col += 0.1 * lip * (0.3 + 0.7 * facing);
  }

  // Paper puts the page in its light theme, where ink means dark; on the dark dishes it means light.
  float accent = (palette == 1 ? body : max(body, 0.5 * lace)) * (1.0 - 0.7 * nodes) * inside;
  return shadeOf(col, inkOf(col, 1.3, 1.0, vec2(0.92, 0.8)), accent);
}
`;
