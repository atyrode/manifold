// The Stone garden preset's layers' GLSL (ADR 0062 Phase 2b; the composer: src/composer, README
// "Composers"): a dry stone garden seen from the temple veranda across to its earthen wall, through
// the garden's rig (constants.ts GARDEN_RIG: the horizon the frame's top edge, focal 1.25, the eye
// 2.53 m up). Its parts, each a layer (layers.ts), drawn in the order the garden always painted them:
//   templeWall   (backdrop) the haze of the sky just below the horizon over the wall, under cloud a
//                grey deck drifting with the wind; the earthen wall and its tiled cap, drops running
//                off the eave; the veranda's boards along the bottom, the eaves' shade on the gravel
//                just beyond them; the garden's air.
//   templeWoods  (dressing) two rows of crowns over the wall (the plant records of their stems: each
//                crown stands where its stem carries it), the farther paler in the haze, snow on them,
//                rain shafts between.
//   gravel       (ground) the raked gravel (its height field for the normals, when each spot was last
//                raked for its damp), the islands' stones and moss marched as height fields inside
//                their bounding cylinders, the pebble drip line and gutter, the slate M; lit by the
//                key (shadowed by the stones, the slate, the maple's dapple and the leaves), the sky,
//                the low sky's glow and the soft key under cloud; wet, pooled, splashed and snowed on.
//   border       (cover) ferns and mondo grass in the gutter, side-on in the plane they stand in.
//   boughs       (dressing) the maple's limbs and twigs, its foliage as leaves (petals in spring) over
//                them, the leaves in the air and on the gravel (its records), the drops falling from it.
// Everything is worked in garden space (constants.ts GARDEN): X right, Y away from the veranda, Z up,
// in garden depths of GARDEN_METRES. That is the sky library's frame with y and z swapped, so its sun
// and moon light the garden directly. What the composer takes is in metres: each cell's depth (c.z,
// along the view's axis), the cloud shadows' points.
//
// The shared part (stoneGardenSharedGlsl, every garden layer's) works out the cell once (gardenCell,
// the garden's begin): its light, the ray, what it meets (the wall, an island, the slate, a border
// plant, the nearest leaf) and how far, reading the other layers' data behind their gates
// (LAYER_GRAVEL, LAYER_BORDER, LAYER_BOUGHS), so a garden without its gravel casts no stone's shadow
// and one without its maple no dapple. The garden keeps its own light (gardenLight): the World's sky
// (its sun, or the moon once the sun is down), exposed up as a low sun sinks; under the deck rain or
// snow closes over, its own grey day, flat light and a soft key from where the sun hides, on the
// World's sky before the World's deck dims it. The composer's grade only inks it and lights the
// plain floor (GARDEN_GRADE). The World's rain and snow fall at the composed depth (D10: they replace
// the garden's own), its fog too, and its cloud shadows (where switched on) cross the garden; the
// gusts are the composer's one field (gustAt at the canopy, D4), the exit's gust the garden's own.
//
// The view from straight above (gardenAboveGlsl) is a program of the garden's own until the
// overhead composer (ADR 0062 Phase 4): the same parts (GARDEN_ABOVE 1) through its pinhole, its
// tiled wall caps, its rain and snow falling away from the eye.
import { WORLD_TRIGGERS } from "../../composer/compose.ts";
import { COMPOSER_ENTRY, simOn } from "../../composer/glsl.ts";
import { gustGlsl } from "../../composer/gust.ts";
import { ATLAS_SLOT, type Allocation } from "../../composer/sim.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { plantsGlsl } from "../../shaders/lib/plants.ts";
import { worldGlsl } from "../../shaders/lib/world.ts";
import { gustPulseGlsl } from "../../sims/wind.ts";
import { GARDEN_GROOVE, GARDEN_MARK } from "./build.ts";
import { GARDEN, GARDEN_METRES } from "./constants.ts";
import {
  GARDEN_BORDER,
  GARDEN_BORDER_FORM,
  GARDEN_CANOPY,
  GARDEN_GUST_GAIN,
  GARDEN_GUST_RISE,
  GARDEN_ISLANDS,
  GARDEN_LEAF_KIND,
  GARDEN_LEAF_SLOTS,
  GARDEN_MAPLE_AT,
  GARDEN_MOSS,
  GARDEN_STONE_TEXEL,
  GARDEN_STONES,
  GARDEN_WOODS,
} from "./sim.ts";

/**
 * The maple's limbs, garden space, as polylines of (x, y, z, radius): the trunk stands beyond the
 * wall off the left of the frame; one limb sweeps over the wall toward the middle, one rises over
 * the garden, two short ones carry the low foliage over the wall's cap.
 */
const LIMBS: readonly (readonly (readonly [number, number, number, number])[])[] = [
  [
    [-0.2, 1.18, 0.12, 0.016],
    [0.05, 1.1, 0.25, 0.012],
    [0.3, 1.03, 0.205, 0.009],
    [0.62, 0.94, 0.215, 0.007],
    [0.88, 0.86, 0.24, 0.005],
    [1.1, 0.79, 0.255, 0.003],
  ],
  [
    [0.3, 1.03, 0.205, 0.007],
    [0.5, 1.0, 0.16, 0.004],
  ],
  [
    [0.05, 1.1, 0.25, 0.01],
    [0.22, 0.92, 0.29, 0.008],
    [0.46, 0.82, 0.285, 0.006],
    [0.74, 0.73, 0.3, 0.004],
  ],
  [
    [0.3, 1.03, 0.205, 0.006],
    [0.4, 1.13, 0.14, 0.004],
  ],
];
const SEGMENTS = LIMBS.flatMap((limb) =>
  limb.slice(1).map((end, k) => [limb[k] ?? end, end] as const),
);
const vec4s = (rows: readonly (readonly number[])[]): string =>
  rows.map((row) => `vec4(${row.map(glslFloat).join(", ")})`).join(",\n  ");

/**
 * The lowest screen height the maple reaches in a view, foliage and limbs (as gardenProject places
 * them), less a margin for its sway: below it the shader skips the tree.
 */
function mapleLow(above: boolean): number {
  const place = (y: number, z: number): { v: number; s: number } => {
    if (above) {
      const s = GARDEN.overheadHeight / (GARDEN.overheadHeight - z) / GARDEN.span;
      return { v: 0.5 + (y - GARDEN.overheadY) * s, s };
    }
    const s = GARDEN.focal / (y - GARDEN.eyeY);
    return { v: GARDEN.horizon + (z - GARDEN.eyeHeight) * s, s };
  };
  let low = Infinity;
  for (const [, y, z, r] of [...GARDEN_CANOPY, ...LIMBS.flat()]) {
    const { v, s } = place(y, z);
    low = Math.min(low, v - 1.55 * r * s);
  }
  return low - 0.04;
}

/**
 * Everything both views of the garden share: its constants, its parts' shapes, the cell worked out
 * once (gardenCell) and the colours of the gravel, the border and the maple. GARDEN_ABOVE (defined
 * before it, 0 or 1) picks the view; each layer's data is read behind its gate.
 */
const GARDEN_COMMON = `
${gustPulseGlsl}
const float GARDEN_ASPECT = ${glslFloat(GARDEN.aspect)};
const vec2 GARDEN_CENTRE = vec2(${glslFloat(GARDEN.aspect / 2)}, 0.5);
const vec2 GARDEN_TEXEL = vec2(${(1 / GARDEN.cols).toFixed(6)}, ${(1 / GARDEN.rows).toFixed(6)});
const float GARDEN_DRIP = ${glslFloat(GARDEN.drip)};
const float GARDEN_WALL_Y = ${glslFloat(GARDEN.wallY)};
const float GARDEN_WALL_H = ${glslFloat(GARDEN.wallHeight)};
const float GARDEN_CAP_H = ${glslFloat(GARDEN.capHeight)};
const float GARDEN_FOCAL = ${glslFloat(GARDEN.focal)};
const float GARDEN_HORIZON = ${glslFloat(GARDEN.horizon)};
const float GARDEN_EYE_H = ${glslFloat(GARDEN.eyeHeight)};
const float GARDEN_EYE_Y = ${glslFloat(GARDEN.eyeY)};
const float GARDEN_SPAN = ${glslFloat(GARDEN.span)};
const float GARDEN_HIGH = ${glslFloat(GARDEN.overheadHeight)};
const float GARDEN_ABOVE_Y = ${glslFloat(GARDEN.overheadY)};
const float GARDEN_GUST_RISE = ${glslFloat(GARDEN_GUST_RISE)};
// Metres in a garden depth (constants.ts GARDEN_METRES): what the composer is told is in metres.
const float GARDEN_DEPTH_M = ${glslFloat(GARDEN_METRES)};
// The composer's gust field at the maple's canopy (metres, rig frame), at this share of its load.
const vec2 GARDEN_MAPLE_AT = vec2(${glslFloat(GARDEN_MAPLE_AT[0])}, ${glslFloat(GARDEN_MAPLE_AT[1])});
const float GARDEN_GUST_GAIN = ${glslFloat(GARDEN_GUST_GAIN)};
// Weather scales. The library's ground functions work in metres: a garden depth is ten. A splash
// unit (garden depths: its crowns some 5-10 cm, larger than life so they hold a few cells); the
// largest ripple ring in standing water (garden depths); drips' spacing along an edge, in cells
// (a drop is about two cells); screen heights per metre on the veranda's nosing; the grooves'
// spacing (the rake's tines), below which they melt into the dither.
const float GARDEN_METRE = 0.1;
const float GARDEN_SPLASH_UNIT = 0.12;
const float GARDEN_RIPPLE_CELL = 0.03;
const float GARDEN_DRIP_CELLS = 18.0;
const float GARDEN_NOSE_METRE = 0.3;
const float GARDEN_GROOVE = ${glslFloat(GARDEN_GROOVE)};
const vec2 GARDEN_MARK_AT = vec2(${glslFloat(GARDEN_MARK.x)}, ${glslFloat(GARDEN_MARK.y)});
const vec2 GARDEN_MARK_SIZE = vec2(${glslFloat(GARDEN_MARK.small)}, ${glslFloat(GARDEN_MARK.grow)});
const float GARDEN_MARK_STROKE = ${glslFloat(GARDEN_MARK.stroke)};
const float GARDEN_SLATE = ${glslFloat(GARDEN_MARK.slate)};
const vec3 GARDEN_MOSS = vec3(${glslFloat(GARDEN_MOSS.height)}, ${glslFloat(GARDEN_MOSS.base)}, ${glslFloat(GARDEN_MOSS.grow)});
const int GARDEN_LEAVES = ${GARDEN_LEAF_SLOTS};
const int GARDEN_ISLAND_COUNT = ${GARDEN_ISLANDS};
// GardenIsland below holds exactly this many stones; the gravel's row keeps stone j of island i at
// texels GARDEN_STONE_TEXEL + 2 (GARDEN_STONE_COUNT i + j) and the next.
const int GARDEN_STONE_COUNT = ${GARDEN_STONES};
const int GARDEN_STONE_TEXEL = ${GARDEN_STONE_TEXEL};
const int GARDEN_MAPLE = ${GARDEN_LEAF_KIND.maple};
const int GARDEN_PETAL = ${GARDEN_LEAF_KIND.petal};
const int GARDEN_GREEN = ${GARDEN_LEAF_KIND.green};
const int GARDEN_WITHERED = ${GARDEN_LEAF_KIND.withered};
// The largest leaf radius the sim draws, with room for its edge: rays farther off skip a leaf.
const float GARDEN_LEAF_REACH = 0.018;
const int GARDEN_CLUMP_COUNT = ${GARDEN_CANOPY.length};
const vec4 GARDEN_CLUMPS[${GARDEN_CANOPY.length}] = vec4[${GARDEN_CANOPY.length}](
  ${vec4s(GARDEN_CANOPY)}
);
// The lowest screen height the maple reaches: from the veranda (x), from above (y).
const vec2 GARDEN_MAPLE_LOW = vec2(${glslFloat(mapleLow(false))}, ${glslFloat(mapleLow(true))});
const int GARDEN_LIMB_COUNT = ${SEGMENTS.length};
const vec4 GARDEN_LIMB_A[${SEGMENTS.length}] = vec4[${SEGMENTS.length}](
  ${vec4s(SEGMENTS.map(([a]) => a))}
);
const vec4 GARDEN_LIMB_B[${SEGMENTS.length}] = vec4[${SEGMENTS.length}](
  ${vec4s(SEGMENTS.map(([, b]) => b))}
);
// The border's clumps along the wall's foot (its records, sim.ts GARDEN_BORDER), binned along X,
// standing in the plane Y = GARDEN_BORDER_Y and at most GARDEN_BORDER_REACH tall; from above they lie
// GARDEN_BORDER_LIE over the ground, laid out toward the gravel.
const float GARDEN_BORDER_PITCH = ${glslFloat(GARDEN_BORDER.pitch)};
const int GARDEN_BORDER_BINS = ${GARDEN_BORDER.bins};
const int GARDEN_BORDER_ORGANS = ${GARDEN_BORDER.organs};
const float GARDEN_BORDER_Y = ${glslFloat(GARDEN_BORDER.y)};
const float GARDEN_BORDER_REACH = ${glslFloat(GARDEN_BORDER.reach)};
const float GARDEN_BORDER_LIE = 0.01;
const float GARDEN_FERN = ${glslFloat(GARDEN_BORDER_FORM.fern)};
// Snow lying, and the silver-blue the eye sees by moonlight.
const vec3 GARDEN_SNOW = vec3(0.9, 0.93, 0.98);
const vec3 GARDEN_MOONLIT = vec3(0.75, 0.88, 1.2);

// ---- the gravel, the islands (the gravel's data) ----

// A stone's height at p (sim.ts stoneHeight): a steep-sided dome on a wobbly footprint, cut by a
// tilted top plane and three steep side planes, so it stands as a weathered block with flat faces.
// a = (centre relative to the garden's centre, half-axes), b = (height, turn, shape seed, 0).
float gardenStone(vec2 p, vec4 a, vec4 b) {
  if (b.x <= 0.0) return 0.0;
  vec2 d = p - a.xy - GARDEN_CENTRE;
  float reach = max(a.z, a.w);
  if (dot(d, d) > 1.44 * reach * reach) return 0.0;
  float c = cos(b.y);
  float s = sin(b.y);
  vec2 q = vec2(c * d.x + s * d.y, c * d.y - s * d.x) / a.zw;
  float ang = atan(q.y, q.x);
  float r = length(q) / (1.0 + 0.1 * sin(3.0 * ang + TAU * b.z) + 0.06 * sin(5.0 * ang + 2.0 * TAU * b.z));
  if (r >= 1.0) return 0.0;
  float tilt = TAU * b.z * 3.1;
  float h = min(1.25 * pow(1.0 - pow(r, 2.6), 0.45), 0.88 + 0.14 * dot(q, vec2(cos(tilt), sin(tilt))));
  for (int k = 0; k < 3; k++) {
    float fa = TAU * (b.z + float(k) / 3.0) + 0.4 * sin(17.0 * b.z + float(k));
    h = min(h, 2.2 * (1.08 - dot(q, vec2(cos(fa), sin(fa)))));
  }
  return b.x * max(h, 0.0);
}

struct GardenIsland {
  vec2 c;      // centre
  float clear; // the smooth gravel (and moss) within this radius; 0: no island
  float top;   // the tallest stone
  vec4 a0; vec4 b0; vec4 a1; vec4 b1; vec4 a2; vec4 b2;
};

#if LAYER_GRAVEL
float gardenGravel(vec2 p) {
  return texture(gravelField0, vec2(p.x / GARDEN_ASPECT, p.y)).r;
}

// Island i (x, y relative to the garden's centre, clear radius, tallest stone), and stone j of it
// (a: x, y, half-axes; b: height, turn, seed): the gravel's row (sim.ts packIslands).
vec4 gardenIslandAt(int i) {
  return gravelRecord(i, 0);
}

vec4 gardenStoneAt(int i, int j, int k) {
  return gravelRecord(GARDEN_STONE_TEXEL + 2 * (GARDEN_STONE_COUNT * i + j) + k, 0);
}

GardenIsland gardenIsland(int i) {
  GardenIsland g;
  vec4 d = gardenIslandAt(i);
  g.c = d.xy + GARDEN_CENTRE;
  g.clear = d.z;
  g.top = max(d.w, GARDEN_MOSS.x + 0.002);
  g.a0 = gardenStoneAt(i, 0, 0);
  g.b0 = gardenStoneAt(i, 0, 1);
  g.a1 = gardenStoneAt(i, 1, 0);
  g.b1 = gardenStoneAt(i, 1, 1);
  g.a2 = gardenStoneAt(i, 2, 0);
  g.b2 = gardenStoneAt(i, 2, 1);
  return g;
}

// The moss cushion around an island's stones: as wide as the moss knob says, its rim wavering.
float gardenMoss(vec2 p, GardenIsland g) {
  vec2 d = p - g.c;
  float reach = g.clear * (GARDEN_MOSS.y + GARDEN_MOSS.z * K_moss);
  float ang = atan(d.y, d.x);
  float r = length(d) / (reach * (1.0 + 0.07 * sin(4.0 * ang + 9.0 * g.c.x) + 0.05 * sin(7.0 * ang + 13.0 * g.c.y)));
  if (r >= 1.0) return 0.0;
  float s = 1.0 - r * r;
  return GARDEN_MOSS.x * smoothstep(0.0, 0.15, K_moss) * s * s;
}

float gardenIslandHeight(vec2 p, GardenIsland g) {
  float stones = max(gardenStone(p, g.a0, g.b0), max(gardenStone(p, g.a1, g.b1), gardenStone(p, g.a2, g.b2)));
  return max(gardenMoss(p, g), stones);
}

vec3 gardenIslandNormal(vec2 p, GardenIsland g, float e) {
  float hx = gardenIslandHeight(p + vec2(e, 0.0), g) - gardenIslandHeight(p - vec2(e, 0.0), g);
  float hy = gardenIslandHeight(p + vec2(0.0, e), g) - gardenIslandHeight(p - vec2(0.0, e), g);
  return normalize(vec3(-hx, -hy, 2.0 * e));
}

// Where a ray from the veranda first meets an island's moss or stones before tEnd (-1 if it
// misses): fixed steps through the island's cylinder below its tallest stone, then bisection.
float gardenMarch(vec3 ro, vec3 rd, GardenIsland g, float tEnd) {
  vec2 oc = ro.xy - g.c;
  float a = dot(rd.xy, rd.xy);
  float b = dot(oc, rd.xy);
  float disc = b * b - a * (dot(oc, oc) - g.clear * g.clear);
  if (disc <= 0.0) return -1.0;
  float root = sqrt(disc);
  float t0 = max((-b - root) / a, (ro.z - g.top) / -rd.z);
  float t1 = min((-b + root) / a, tEnd);
  if (t0 >= t1) return -1.0;
  float dt = (t1 - t0) / 24.0;
  float prev = t0;
  for (int k = 1; k <= 24; k++) {
    float tt = t0 + dt * float(k);
    vec3 q = ro + rd * tt;
    if (q.z < gardenIslandHeight(q.xy, g)) {
      float lo = prev;
      float hi = tt;
      for (int s = 0; s < 5; s++) {
        float mid = 0.5 * (lo + hi);
        vec3 m = ro + rd * mid;
        if (m.z < gardenIslandHeight(m.xy, g)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = tt;
  }
  return -1.0;
}

// Light reaching p past the stones (1 lit .. 0 shadowed). Each stone is a dome: where the light
// ray passes nearest it, it is as wide as the dome is at the ray's height there. The penumbra
// widens with distance, so the long shadows of a low sun go soft at their ends. skip: an island
// whose own shading already covers it.
float gardenStoneShade(vec3 p, vec3 L, int skip) {
  if (L.z <= 0.0) return 1.0;
  float level = max(length(L.xy), 1e-3);
  vec2 l2 = L.xy / level;
  vec2 side = vec2(-l2.y, l2.x);
  float rise = L.z / level;
  float lit = 1.0;
  for (int i = 0; i < GARDEN_ISLAND_COUNT; i++) {
    if (i == skip) continue;
    vec4 d = gardenIslandAt(i);
    if (d.z <= 0.0) continue;
    vec2 v = d.xy + GARDEN_CENTRE - p.xy;
    float along = dot(v, l2);
    if (along < -d.z || p.z + (along - d.z) * rise > d.w || abs(dot(v, side)) > d.z) continue;
    for (int j = 0; j < GARDEN_STONE_COUNT; j++) {
      vec4 a = gardenStoneAt(i, j, 0);
      vec4 b = gardenStoneAt(i, j, 1);
      if (b.x <= 0.0) continue;
      vec2 w = a.xy + GARDEN_CENTRE - p.xy;
      float al = dot(w, l2);
      float z = (p.z + al * rise) / b.x;
      if (al <= 0.0 || z >= 1.0) continue;
      float c = cos(b.y);
      float s = sin(b.y);
      vec2 u = vec2(c * side.x + s * side.y, c * side.y - s * side.x);
      float halfWidth = length(u * a.zw) * pow(max(1.0 - pow(max(z, 0.0), 2.2222), 0.0), 0.3846);
      float pen = 0.003 + 0.025 * al;
      lit *= smoothstep(-pen, pen, abs(dot(w, side)) - halfWidth);
    }
  }
  return lit;
}
#endif

// ---- the maple ----

// How far clump k of the foliage leans now: a slow sway on the breeze, livelier with the wind,
// tossed by a gust (its toss on the scene clock t).
vec3 gardenSway(int k, float tm, float t, float gust) {
  float fk = float(k);
  float breeze = (0.0022 + 0.006 * abs(K_wind)) * (sin(tm * 0.55 + fk * 1.7) + 0.5 * sin(tm * 0.93 + fk * 2.9));
  float lean = 0.006 * K_wind + 0.02 * gust;
  float toss = 0.008 * abs(gust) * sin(t * 2.4 + fk * 1.3);
  return vec3(breeze + lean + toss, 0.0, 0.4 * breeze + 0.5 * toss);
}

// How far from where they hang the maple's boughs stand at point p while the scene comes in or goes
// out (nothing at rest: the early return keeps every term exact). They swing in from just over the
// top of the frame, already on their way down (the spring is picked up a share of the way in, where
// the lowest leaves reach the edge), all at once, those reaching furthest from the trunk settling a
// little later, overshoot a touch and settle with a last sway; on leaving, the gust takes the far
// ones first and carries them up and downwind, faster and faster, the lowest leaves reaching the
// top of the frame as the exit ends. The same offset for any point of a bough, so limbs and foliage
// stay joined. Veranda: up and aside; from above: away from the veranda, up the frame.
vec3 gardenBough(vec3 p) {
  float pin = passageIn();
  float pout = passageOut();
  if (pin >= 1.0 && pout <= 0.0) return vec3(0.0);
  float reach = smoothstep(-0.2, 1.1, p.x);
  float weight = 0.55 + 0.45 * reach;
  float dir = K_wind < -0.05 ? -1.0 : 1.0;
  // In: how far still out (1 .. 0, past 0 a little), and the settling sway.
  float xin = 0.2 + 0.8 * clamp(pin / (0.8 + 0.2 * reach), 0.0, 1.0);
  float u = xin - 1.0;
  float away = -(2.7 * u * u * u + 1.7 * u * u);
  float rock = sin(xin * 11.0 + 2.0 * reach) * (1.0 - xin) * (1.0 - xin);
  // Out: how far gone (0 .. 1), and the toss as the gust takes them.
  float xout = clamp((pout - 0.18 * (1.0 - reach)) / 0.82, 0.0, 1.0);
  float gone = xout * xout * xout;
  float toss = sin(xout * 9.0 + 3.0 * reach) * 4.0 * xout * (1.0 - xout);
  float aside = -0.12 * away + 0.03 * rock + dir * (0.1 * gone + 0.03 * toss);
#if GARDEN_ABOVE
  return weight * vec3(aside, 0.4 * away + 0.225 * gone, 0.0);
#else
  return weight * vec3(aside, 0.0, 0.3 * away + 0.012 * rock + 0.17 * gone);
#endif
}

// Screen uv of garden point p in this view, and screen heights per garden depth there (z).
vec3 gardenProject(vec3 p, float aspect) {
#if GARDEN_ABOVE
  float s = GARDEN_HIGH / max(GARDEN_HIGH - p.z, 0.05) / GARDEN_SPAN;
  return vec3(0.5 + (p.x - GARDEN_CENTRE.x) * s / aspect, 0.5 + (p.y - GARDEN_ABOVE_Y) * s, s);
#else
  float s = GARDEN_FOCAL / max(p.y - GARDEN_EYE_Y, 0.02);
  return vec3(0.5 + (p.x - GARDEN_CENTRE.x) * s / aspect, GARDEN_HORIZON + (p.z - GARDEN_EYE_H) * s, s);
#endif
}

// The maple's shade on the ground at p: each clump's shadow, cast along the light, a leafy blot
// pierced by sun flecks (round pinhole images of the sun, drawn out as it sinks). 1: full sun.
float gardenDapple(vec3 p, vec3 L, float tm, float t, float gust) {
  if (L.z < 0.1 || K_dapple <= 0.0) return 1.0;
  vec2 l2 = normalize(L.xy + vec2(1e-5, 0.0));
  float shade = 1.0;
  for (int k = 0; k < GARDEN_CLUMP_COUNT; k++) {
    vec4 c = GARDEN_CLUMPS[k];
    vec3 C = c.xyz + gardenSway(k, tm, t, gust);
    vec2 v = p.xy - (C.xy - L.xy * ((C.z - p.z) / L.z));
    vec2 e = vec2(dot(v, l2) * L.z, dot(v, vec2(-l2.y, l2.x))) / c.w;
    float d2 = dot(e, e);
    if (d2 > 1.2) continue;
    vec2 f = e * 5.5 + float(k) * 3.7;
    vec2 id = floor(f);
    float h = hash12(id);
    float fleck = step(0.45, h) * (1.0 - smoothstep(0.12, 0.3, length(fract(f) - 0.5 - 0.35 * (vec2(h, fract(h * 31.7)) - 0.5))));
    float blot = 1.0 - smoothstep(0.45, 1.0, d2 + 0.35 * (vnoise(e * 3.5 + float(k) * 5.1) - 0.5));
    shade = min(shade, 1.0 - 0.8 * blot * (1.0 - fleck));
  }
  return mix(1.0, shade, K_dapple * smoothstep(0.1, 0.3, L.z));
}

// ---- the border along the wall's foot (its records) ----

#if LAYER_BORDER
// The border's clumps at q = (garden X, height above the gutter) in the plane they stand in; foot: a
// cell there. A fern's fronds are plantFronds, the spring's turn lifting or lowering their tips (as
// falls' bank ferns); mondo grass's blades are arcs turning their curl (a) plus the bend, tapering
// toward the tip and at least a cell wide. A clump in bin b reaches no further than the next bins.
// Returns coverage; tip: how far along the organ on top (0 root .. 1 tip), pheno its phenology, form
// its species (GARDEN_FERN or mondo grass).
float gardenBorder(vec2 q, float foot, out float tip, out float pheno, out float form) {
  tip = 0.0;
  pheno = 0.0;
  form = 0.0;
  float cover = 0.0;
  int b0 = int(floor(q.x / GARDEN_BORDER_PITCH));
  for (int i = -1; i <= 1; i++) {
    int b = b0 + i;
    if (b < 0 || b >= GARDEN_BORDER_BINS) continue;
    for (int j = 0; j < GARDEN_BORDER_ORGANS; j++) {
      PlantOrgan o = plantOrgan(borderAtlas, borderRow, GARDEN_BORDER_ORGANS * b + j);
      if (o.tier < 0.5) continue;
      vec2 rel = q - o.at;
      if (dot(rel, rel) > 4.0 * o.len * o.len) continue;
      float c = 0.0;
      float u = 0.0;
      if (abs(o.form - GARDEN_FERN) < 0.5) {
        float under = 0.0;
        c = plantFrond(rel, o.side, o.len, o.a, o.b, o.side * o.bend * length(vec2(1.0, o.a - o.b)), foot, u, under);
      } else {
        float s = 0.0;
        float d = plantArc(plantLocal(q, o), o.len, o.a + o.bend, s);
        if (s < 0.0 || s > 1.0) continue;
        float w = max(0.5 * o.width * (1.0 - 0.7 * s), 0.6 * foot);
        c = smoothfall(w + 0.5 * foot, w - 0.5 * foot, abs(d));
        u = s;
      }
      if (c > cover) {
        cover = c;
        tip = u;
        pheno = o.pheno;
        form = o.form;
      }
    }
  }
  return cover;
}
#endif

// ---- leaves ----

// Coverage of a leaf of kind k at q (its radius 1, its tip toward +y), antialiased over aa.
float gardenLeafShape(vec2 q, int k, float aa) {
  if (k == GARDEN_PETAL) {
    // A cherry petal: obovate, notched at the tip, narrowing to its base.
    vec2 p = vec2(q.x * (1.25 + 0.45 * smoothfall(0.3, -0.9, q.y)), q.y + 0.05);
    float a = atan(p.x, p.y);
    return softFill(length(p) - (0.92 - 0.3 * exp(-a * a * 30.0)), aa);
  }
  // A palmate maple leaf: seven pointed lobes, the lowest small, a notch at the stalk. A withered
  // one has curled up narrow.
  if (k == GARDEN_WITHERED) q.x *= 1.55;
  float a = atan(q.x, q.y);
  float lobe = pow(0.5 + 0.5 * cos(4.0 * a), 2.2);
  float r = mix(0.36, 1.0, lobe) * (1.0 - 0.3 * smoothstep(1.3, 2.7, abs(a))) * (1.0 - 0.75 * smoothstep(2.6, 3.1, abs(a)));
  float blade = softFill(length(q) - r, aa);
  float stalk = smoothfall(0.05 + aa, 0.05 - aa, segmentDistance(q, vec2(0.0, -0.25), vec2(0.04, -0.8)));
  return max(blade, stalk);
}

// A leaf's colour by its kind, its own hue, and how long it has lain (0..1 of its time).
vec3 gardenLeafColour(int k, float hue, float age) {
  if (k == GARDEN_MAPLE) {
    // Momiji: crimson to scarlet, some orange, the odd golden one; browning as it lies.
    vec3 c = mix(vec3(0.62, 0.05, 0.05), vec3(0.86, 0.18, 0.05), smoothstep(0.0, 0.5, hue));
    c = mix(c, vec3(0.93, 0.45, 0.07), smoothstep(0.62, 0.9, hue));
    c = mix(c, vec3(0.95, 0.7, 0.15), smoothstep(0.94, 1.0, hue));
    return mix(c, vec3(0.42, 0.17, 0.08), 0.55 * age);
  }
  if (k == GARDEN_PETAL) return mix(mix(vec3(0.98, 0.84, 0.88), vec3(0.95, 0.68, 0.77), hue), vec3(0.82, 0.7, 0.62), 0.5 * age);
  if (k == GARDEN_GREEN) return mix(mix(vec3(0.16, 0.38, 0.07), vec3(0.5, 0.62, 0.12), hue), vec3(0.5, 0.42, 0.14), 0.5 * age);
  return mix(vec3(0.36, 0.22, 0.1), vec3(0.55, 0.38, 0.18), hue);
}

// ---- small things ----

// The drip line's river pebbles at p (one in each cell of a jittered grid, as a dome): xyz its
// normal, w how much pebble is there (0 in the gaps between them); tone: its own shade.
vec4 gardenPebbles(vec2 p, out float tone) {
  vec2 g = p / 0.011;
  vec2 id = floor(g);
  vec2 f = g - id;
  float best = 9.0;
  vec2 bv = vec2(0.0);
  tone = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      float h = hash12(id + o + 31.0);
      vec2 v = f - o - 0.5 - 0.3 * (vec2(h, fract(h * 47.3)) - 0.5);
      float d = dot(v, v);
      if (d < best) {
        best = d;
        bv = v;
        tone = h;
      }
    }
  }
  float r = 0.5 + 0.12 * tone;
  float z = sqrt(max(r * r - best, 0.0));
  return vec4(normalize(vec3(bv, z + 0.03)), smoothstep(0.0, 0.08, r - sqrt(best)));
}

// Distance from p to the M lying in the gravel, in garden depths.
float gardenMarkDistance(vec2 p, float size) {
  return markDistance((p - GARDEN_MARK_AT) / size) * size;
}

// Light reaching gravel point p past the low slate M: a few steps toward the light, as far as a ray
// can run before it rises over the slab's top; long and soft under a low sun.
float gardenSlateShade(vec2 p, vec3 L, float size) {
  if (L.z <= 0.0) return 1.0;
  float level = max(length(L.xy), 1e-3);
  vec2 l2 = L.xy / level;
  float reach = min(GARDEN_SLATE * level / L.z, 0.06);
  float stroke = GARDEN_MARK_STROKE * size;
  float lit = 1.0;
  for (int k = 1; k <= 6; k++) {
    float s = reach * float(k) / 6.0;
    lit = min(lit, smoothstep(-0.002, 0.003 + 0.08 * s, gardenMarkDistance(p + l2 * s, size) - stroke));
  }
  return mix(1.0, lit, 0.8);
}

// Moss, velvet green, mottled.
vec3 gardenMossColour(vec2 p) {
  return mix(vec3(0.2, 0.36, 0.07), vec3(0.36, 0.54, 0.12), vnoise(p * 230.0 + 7.0));
}

// What a wet surface gives back: the sky mirrored (brighter high up than toward the horizon, as an
// overcast sky is), strongest at a grazing view.
vec3 gardenSheen(vec3 n, vec3 rdn, vec3 sky, float gloss) {
  float fresnel = pow(1.0 - clamp(dot(-rdn, n), 0.0, 1.0), 4.0);
  float up = smoothstep(-0.05, 0.6, reflect(rdn, n).z);
  return sky * (0.55 + 0.75 * up) * gloss * (0.15 + 0.85 * fresnel);
}

// ---- the cell ----
// Every garden layer's state for this cell, worked out once (gardenCell).
// The time, the season and the gust at the maple (signed the way it blows).
float gardenAspect;
float gardenTm;
float gardenT;
float gardenSeason;
float gardenWinter;
float gardenGust;
// The slate M's height (0: none) and the gravel's drying clock.
float gardenMarkSize;
float gardenClock;
// The light: the sky, toward the key, the key's light, the sky's (fill), the bright low sky on the
// sun's side (glow), the soft key under cloud, the air, the bright sky wet things mirror, the drops'
// light, the light thrown back off the gravel.
Sky gardenSky;
vec3 gardenL;
vec3 gardenSun;
vec3 gardenFill;
vec3 gardenGlow;
vec3 gardenGlowDir;
vec3 gardenSoftL;
vec3 gardenSoftKey;
vec3 gardenCloudLight;
vec3 gardenAir;
vec3 gardenSkyBright;
vec3 gardenDropLight;
vec3 gardenBounce;
// The weather: what falls, how wet and snowed on the garden is, how closed the sky; drips.
float gardenRain;
float gardenSnow;
float gardenWet;
float gardenLying;
float gardenOvercast;
float gardenHeavy;
float gardenDripping;
float gardenDripGap;
// The ray in garden space, a cell across it per unit along it, and the cell's footprint on the
// gravel's plane; metres of depth along the view's axis per garden depth along the ray.
vec3 gardenRo;
vec3 gardenRd;
float gardenRdLength;
vec3 gardenRdn;
float gardenPixel;
vec2 gardenFoot;
float gardenZ;
// What the ray meets: the wall, or over it (veranda); an island (gardenHit, -1 none) at gardenS; the
// distance to it (gardenHitDepth) and to the nearest of it and a border plant (gardenDepth).
bool gardenWall;
bool gardenBeyond;
int gardenHit;
GardenIsland gardenIsl;
vec3 gardenS;
float gardenHitDepth;
float gardenDepth;
// The slate M under the ray: its coverage, 0 on its flat .. 1 at its worn edge, how far the gravel
// lies from its edge, its normal.
float gardenSlate;
float gardenSlateRim;
float gardenMarkEdge;
vec3 gardenSlateN;
// The border plant on top along the ray: its coverage, how far along its organ, its phenology and
// form; where in its plane (garden X, height over the gutter), and in the garden.
float gardenBorderCov;
float gardenBorderTip;
float gardenBorderPheno;
float gardenBorderForm;
vec2 gardenBorderQ;
vec3 gardenBorderAt;
float gardenBorderAlong;
// The nearest leaf in front along the ray: its coverage, distance and colour; the leaves' shadow on
// what the ray meets.
float gardenLeafCov;
float gardenLeafT;
vec3 gardenLeafCol;
float gardenLeafShade;

// The garden's light (see the header): the key is the sun, or the moon once the sun is down. A low
// sun is weak on the flat but strong on the flanks turned to it: expose it up as it sinks, as dunes
// does. The moon takes a phase (K_moon, SKY_MOON_PHASE): a slimmer one lights the gravel less. The
// garden greys its own light under the deck rain or snow closes over (below), so under one it takes
// the World's sky before the World's deck dims it (the same clock, date and moon), the aurora's and
// the lightning's light on the land kept.
void gardenLight(World w) {
  Sky sky = w.sky;
  if (w.overcast > 0.0) {
    sky = skyAt(w.time);
#ifdef SKY_MOON_PHASE
    sky = skyMoonPhase(sky, K_moon);
#endif
    sky.ambient += w.glow + WORLD_FLASH_LIGHT * w.flash;
  }
  gardenSky = sky;
  bool moonlit = sky.sun.y < -0.03;
  vec3 key = moonlit ? sky.moon : sky.sun;
  vec3 L = normalize(vec3(key.x, key.z, max(key.y, 0.004)));
  gardenL = L;
  vec3 sun = (moonlit ? sky.moonColor * 1.6 : sky.sunColor) * 0.95 / (0.3 + 0.7 * L.z);
  // The sky's light: its colour greyed a little (the dusk sky's lilac would stain the white
  // gravel), and fuller while the sun is low, when it is most of the light the garden gets.
  vec3 fill = mix(vec3(dot(sky.ambient, LUMA)), sky.ambient, 0.6) * mix(1.25, 0.6, smoothstep(0.05, 0.5, sky.sun.y));
  // The bright sky low on the sun's side: a soft light that keeps the grooves legible at dusk.
  vec2 sunward = normalize(vec2(sky.sun.x, sky.sun.z) + vec2(1e-4, 0.0));
  gardenGlowDir = normalize(vec3(sunward * 0.93, 0.36));
  vec3 glow = skyColor(sky, normalize(vec3(sunward.x, 0.18, sunward.y))) * 0.26 * (1.0 - 0.6 * sky.night);

  // Weather. Rain and snow bring cloud: the sun goes in and the sky's light turns flat and grey,
  // dimmer the harder it rains. What falls is the World's (worldAt: in winter the rain comes down as
  // snow). How wet the garden is (uWeather.x) and how much snow lies on it (uWeather.y, deep
  // winter's own included) are the renderer's: they rise while it falls and go after.
  float rain = w.rain;
  float snow = w.snow;
  gardenRain = rain;
  gardenSnow = snow;
  float wet = uWeather.x;
  gardenWet = wet;
  gardenLying = uWeather.y;
  // Even drizzle comes from a grey sky; snow can fall from a broken one.
  float overcast = max(smoothstep(0.0, 0.12, rain), 0.85 * smoothstep(0.0, 0.4, snow));
  gardenOvercast = overcast;
  float heavy = smoothstep(0.35, 1.0, rain);
  gardenHeavy = heavy;
  vec3 cloudLight = vec3(dot(fill, LUMA) + 0.45 * dot(sun, LUMA) * max(L.z, 0.15)) * vec3(0.93, 0.97, 1.03) * (1.0 - 0.35 * heavy);
  gardenCloudLight = cloudLight;
  // Under cloud the sky is still brightest high up toward the hidden sun: a broad soft key from
  // there carries half its light and models the ridges (crests and the flanks turned to it lit,
  // the others in shade); the rest is an even fill.
  gardenSoftL = normalize(vec3(sunward * 0.8, 0.6));
  gardenSoftKey = cloudLight * 0.9 * overcast;
  fill = mix(fill, cloudLight * 0.6, overcast);
  sun *= 1.0 - 0.92 * overcast;
  glow *= 1.0 - 0.75 * overcast;
  gardenFill = fill;
  gardenSun = sun;
  gardenGlow = glow;
  // The air: what mist and the rain's veil show of the sky.
  gardenAir = mix(fill * 1.3 + glow * 0.8, cloudLight * 0.95, overcast);
  // The sky's own brightness, the grey deck under cloud: mirrored in wet surfaces and water, and
  // (a little brighter, with what is left of a low sun) the colour of the drops, so streaks read
  // lighter than the wet gravel; a small floor keeps some rain in sight at night.
  vec3 skyBright = mix(skyColor(sky, normalize(vec3(sunward.x * 0.3, 0.2, 1.0))), cloudLight, overcast);
  gardenSkyBright = skyBright;
  gardenDropLight = max(skyBright * 1.2 + sun * 0.2, vec3(0.08));
  // The eaves and the maple keep dripping a while after the rain has stopped; a drip point every
  // GARDEN_DRIP_CELLS cells along an edge, each drop falling some five spacings.
  gardenDripping = clamp(max(rain, 0.4 * wet), 0.0, 1.0);
  gardenDripGap = GARDEN_DRIP_CELLS / uRes.y;
  // Light thrown back off the pale gravel onto what stands on it: walls, stone faces, the boards.
  gardenBounce = vec3(0.86, 0.84, 0.8) * (sun * L.z + fill) * 0.45 * (1.0 - 0.4 * wet);
}

// The cell (see "the cell" above): the light, the gust at the maple (the composer's field, or the
// exit's own gust while it is stronger), the ray, and what it meets in the garden.
void gardenCell(World w, WorldView v, GustWind gw, vec2 uv, float t) {
  float aspect = uRes.x / uRes.y;
  gardenAspect = aspect;
  float tm = uMotionTime;
  gardenTm = tm;
  gardenT = t;
  gardenSeason = floor(K_season + 0.5);
  gardenWinter = step(2.5, gardenSeason);
  // The exit's gust rises over the whole exit, at its strongest as the scene goes (sim.ts).
  float leaving = windGustPulse(passageOut() * GARDEN_GUST_RISE, GARDEN_GUST_RISE) * (K_wind < -0.05 ? -1.0 : 1.0);
  float field = GARDEN_GUST_GAIN * gustAt(gw, GARDEN_MAPLE_AT, tm, 0.0) * (gw.dir.x < 0.0 ? -1.0 : 1.0);
  gardenGust = abs(leaving) > abs(field) ? leaving : field;
#if LAYER_GRAVEL
  gardenMarkSize = K_gravelMark > 0.0 ? GARDEN_MARK_SIZE.x + GARDEN_MARK_SIZE.y * K_gravelMark : 0.0;
  gardenClock = gravelRecord(GARDEN_ISLAND_COUNT, 0).x;
#else
  gardenMarkSize = 0.0;
  gardenClock = 0.0;
#endif
  gardenLight(w);
  vec3 L = gardenL;

  // The ray, in garden space.
#if GARDEN_ABOVE
  vec3 ro = vec3(GARDEN_CENTRE.x, GARDEN_ABOVE_Y, GARDEN_HIGH);
  vec3 rd = vec3((uv - 0.5) * vec2(aspect, 1.0) * GARDEN_SPAN, -GARDEN_HIGH);
#else
  vec3 ro = vec3(GARDEN_CENTRE.x, GARDEN_EYE_Y, GARDEN_EYE_H);
  vec3 rd = vec3((uv.x - 0.5) * aspect, GARDEN_FOCAL, uv.y - GARDEN_HORIZON);
#endif
  float rdLength = length(rd);
  vec3 rdn = rd / rdLength;
  gardenRo = ro;
  gardenRd = rd;
  gardenRdLength = rdLength;
  gardenRdn = rdn;
  gardenZ = GARDEN_DEPTH_M * rdn.y;
  // Garden depths per cell across the ray, per unit of distance along it.
#if GARDEN_ABOVE
  float pixel = GARDEN_SPAN / (uRes.y * rdLength);
#else
  float pixel = 1.0 / (uRes.y * rdLength);
#endif
  gardenPixel = pixel;
  // Where the ray meets the gravel's plane, and the cell's footprint there: taken in uniform
  // control flow, because fwidth needs every neighbour to run it.
  float tG = min(ro.z / max(-rd.z, 1e-3), 60.0);
  vec3 P = ro + rd * tG;
  vec2 foot = fwidth(P.xy);
  gardenFoot = foot;

  // The wall: the ground's plane past it is hidden; above it, the woods and sky.
#if GARDEN_ABOVE
  bool wall = false;
  bool beyond = false;
  float tHit = tG;
#else
  float tW = (GARDEN_WALL_Y - ro.y) / rd.y;
  float zW = ro.z + rd.z * tW;
  bool wall = P.y > GARDEN_WALL_Y && zW < GARDEN_WALL_H + GARDEN_CAP_H;
  bool beyond = P.y > GARDEN_WALL_Y && !wall;
  float tHit = wall ? tW : (beyond ? 1e9 : tG);
#endif
  gardenWall = wall;
  gardenBeyond = beyond;

  // Islands: the nearest moss or stone along the ray (veranda), or under it (above).
  int hit = -1;
#if LAYER_GRAVEL
  if (!beyond && !wall) {
    for (int i = 0; i < GARDEN_ISLAND_COUNT; i++) {
      vec4 d = gardenIslandAt(i);
      if (d.z <= 0.0) continue;
      vec2 c = d.xy + GARDEN_CENTRE;
#if GARDEN_ABOVE
      if (distance(P.xy, c) < d.z) hit = i;
#else
      // A cheap look before the march: does the ray's ground track pass within reach?
      vec2 toC = c - ro.xy;
      vec2 dir2 = normalize(rd.xy);
      if (abs(toC.x * dir2.y - toC.y * dir2.x) > d.z) continue;
      float th = gardenMarch(ro, rd, gardenIsland(i), tHit);
      if (th > 0.0 && th <= tHit) {
        tHit = th;
        hit = i;
      }
#endif
    }
  }
#endif
  vec3 S = ro + rd * tHit;
#if LAYER_GRAVEL
  if (hit >= 0) gardenIsl = gardenIsland(hit);
#if GARDEN_ABOVE
  if (hit >= 0) {
    float islandTop = gardenIslandHeight(S.xy, gardenIsl);
    if (islandTop > max(gardenGravel(S.xy), 0.0) + 0.0003) S.z = islandTop;
    else hit = -1;
  }
#endif
#endif
  float depth = beyond ? 1e9 : tHit * rdLength;
  gardenHitDepth = depth;

  // The M: a low slab of slate set in the gravel, a few centimetres proud, its outline wavering as
  // a split slab's does and its edges worn round; from the veranda the front of that rounded edge
  // shows below its top.
  gardenSlate = 0.0;
  gardenSlateRim = 0.0;
  gardenMarkEdge = 1e9;
  gardenSlateN = vec3(0.0, 0.0, 1.0);
#if LAYER_GRAVEL
  float markSize = gardenMarkSize;
  if (markSize > 0.0 && !beyond && !wall && hit < 0) {
    float stroke = GARDEN_MARK_STROKE * markSize + 0.0025 * (vnoise(S.xy * 55.0 + 3.0) - 0.5) + 0.0012 * (vnoise(S.xy * 150.0) - 0.5);
#if GARDEN_ABOVE
    vec2 topAt = S.xy;
#else
    vec2 topAt = (ro + rd * ((ro.z - GARDEN_SLATE) / -rd.z)).xy;
#endif
    float dTop = gardenMarkDistance(topAt, markSize) - stroke;
    gardenMarkEdge = gardenMarkDistance(S.xy, markSize) - stroke;
    float aa = 0.7 * max(max(foot.x, foot.y), 0.0008);
    float onTop = softFill(dTop, aa);
#if GARDEN_ABOVE
    float onSide = 0.0;
#else
    float onSide = softFill(gardenMarkEdge, aa) * (1.0 - onTop);
#endif
    gardenSlate = max(onTop, onSide);
    if (gardenSlate > 0.0) {
      bool side = onSide > onTop;
      vec2 at = side ? S.xy : topAt;
      vec2 e = vec2(0.0015, 0.0);
      vec2 grad = vec2(gardenMarkDistance(at + e, markSize) - gardenMarkDistance(at - e, markSize),
                       gardenMarkDistance(at + e.yx, markSize) - gardenMarkDistance(at - e.yx, markSize));
      grad /= max(length(grad), 1e-6);
      // The top is flat, its normal tipping outward over the worn rounding at its edge; the front
      // edge is the rounding's lower half, turned out toward the viewer and up to the sky.
      float wear = max(0.35 * GARDEN_MARK_STROKE * markSize, 0.004);
      gardenSlateRim = side ? 1.0 : smoothstep(-wear, 0.0, dTop);
      gardenSlateN = side ? normalize(vec3(grad, 0.8)) : normalize(vec3(grad * 1.2 * gardenSlateRim * gardenSlateRim, 1.0));
      S = side ? vec3(S.xy, 0.5 * GARDEN_SLATE) : vec3(topAt, GARDEN_SLATE);
    }
  }
#endif

  // ---- the border along the wall's foot (K_border): fern and mondo grass in the gutter, side-on
  // in the plane they stand in from the veranda (in front of the wall and the gutter behind them,
  // behind whatever the ray meets first), laid out toward the gravel from above ----
  gardenBorderCov = 0.0;
  gardenBorderTip = 0.0;
  gardenBorderPheno = 0.0;
  gardenBorderForm = 0.0;
  gardenBorderQ = vec2(0.0);
  gardenBorderAt = vec3(0.0);
  gardenBorderAlong = 1e9;
#if LAYER_BORDER
  if (K_border > 0.0 && borderSimOn() && !beyond) {
    float along;
    float borderFoot;
#if GARDEN_ABOVE
    gardenBorderQ = vec2(S.x, GARDEN_BORDER_Y - S.y);
    along = (ro.z - GARDEN_BORDER_LIE) / -rd.z * rdLength;
    borderFoot = max(foot.x, foot.y);
    gardenBorderAt = vec3(S.xy, GARDEN_BORDER_LIE);
    bool open = hit < 0 && gardenSlate <= 0.0;
#else
    float tB = (GARDEN_BORDER_Y - ro.y) / rd.y;
    gardenBorderQ = vec2(ro.x + rd.x * tB, ro.z + rd.z * tB);
    along = tB * rdLength;
    borderFoot = pixel * along;
    gardenBorderAt = vec3(gardenBorderQ.x, GARDEN_BORDER_Y, gardenBorderQ.y);
    bool open = true;
#endif
    if (gardenBorderQ.y >= 0.0 && gardenBorderQ.y < GARDEN_BORDER_REACH && along < depth && open) {
      gardenBorderCov = gardenBorder(gardenBorderQ, borderFoot, gardenBorderTip, gardenBorderPheno, gardenBorderForm);
      gardenBorderAlong = along;
      if (gardenBorderCov > 0.5) depth = along;
    }
  }
#endif
  gardenDepth = depth;
  gardenHit = hit;
  gardenS = S;

#if !GARDEN_ABOVE && (WORLD_SHADOWS || WORLD_CUMULUS)
  // The World's cloud shadows (K_shadows) and the cumulus' where the ray first meets the garden, or
  // at the woods over the wall: a cloud's shadow is far larger than anything here, so that one point
  // shades everything the cell shows.
  vec3 shadowAt = (ro + rdn * min(depth, 3.0) - ro) * GARDEN_DEPTH_M;
  float clouded = worldSunlit(w, v, vec3(shadowAt.x, shadowAt.z, shadowAt.y));
  gardenSun *= clouded;
  gardenBounce = vec3(0.86, 0.84, 0.8) * (gardenSun * L.z + gardenFill) * 0.45 * (1.0 - 0.4 * gardenWet);
#endif

  // ---- leaves: the nearest one in front along this ray, and their shadows on what it meets ----
  gardenLeafCov = 0.0;
  gardenLeafT = 1e9;
  gardenLeafCol = vec3(0.0);
  gardenLeafShade = 1.0;
#if LAYER_BOUGHS
  float lightUp = L.z > 0.03 && !beyond && !wall ? 1.0 : 0.0;
  for (int i = 0; i < GARDEN_LEAVES; i++) {
    vec4 c0 = boughsRecord(4 * i, 0);
    if (c0.w <= 0.0) continue;
    vec3 C = vec3(c0.xy + GARDEN_CENTRE, c0.z);
    vec3 oc = C - ro;
    float along = dot(oc, rdn);
    bool near = along > 0.0 && along < depth + 0.02 && length(oc - rdn * along) < GARDEN_LEAF_REACH + 2.0 * pixel * along;
    // Its shadow lands where the light ray from S passes through it: low enough over S, and the
    // light high enough to cast it nearby.
    float rise = (C.z - S.z) / L.z;
    bool shadowNear = lightUp > 0.0 && rise > -0.002 && rise < 0.3 && distance(S.xy + L.xy * rise, C.xy) < GARDEN_LEAF_REACH;
    if (!near && !shadowNear) continue;
    vec4 c1 = boughsRecord(4 * i + 1, 0);
    vec4 c2 = boughsRecord(4 * i + 2, 0);
    vec4 c3 = boughsRecord(4 * i + 3, 0);
    vec3 n = cross(c1.xyz, c2.xyz);
    float radius = c1.w;
    int kind = int(c2.w + 0.5);
    if (shadowNear) {
      float facing = dot(L, n);
      if (abs(facing) > 0.05) {
        float s = dot(C - S, n) / facing;
        vec3 Q = S + L * s - C;
        float blur = (0.0015 + 0.03 * max(s, 0.0)) / radius;
        float cov = gardenLeafShape(vec2(dot(Q, c1.xyz), dot(Q, c2.xyz)) / radius, kind, blur);
        gardenLeafShade = min(gardenLeafShade, 1.0 - 0.8 * c0.w * cov * (1.0 - smoothstep(0.05, 0.3, s)));
      }
    }
    if (!near || along >= gardenLeafT) continue;
    float pw = pixel * along;
    float facing = dot(rdn, n);
    float cov = 0.0;
    if (abs(facing) > 0.02) {
      float s = dot(oc, n) / facing;
      vec3 Q = rdn * s - oc;
      cov = gardenLeafShape(vec2(dot(Q, c1.xyz), dot(Q, c2.xyz)) / radius, kind, pw / radius / max(abs(facing), 0.2));
    }
    // Turned edge-on it would thin to a sliver the dither cannot hold: draw its edge as a stroke at
    // least a couple of cells thick instead.
    float edgeOn = 1.0 - smoothstep(0.1, 0.35, abs(facing));
    if (edgeOn > 0.0) {
      vec3 wv = normalize(cross(n, rdn) + vec3(1e-5));
      vec3 e1 = oc + wv * radius * 0.8;
      vec3 e2 = oc - wv * radius * 0.8;
      e1 -= rdn * dot(e1, rdn);
      e2 -= rdn * dot(e2, rdn);
      vec3 ed = e2 - e1;
      float dist = length(e1 + ed * clamp(-dot(e1, ed) / max(dot(ed, ed), 1e-9), 0.0, 1.0));
      float thick = max(0.1 * radius, 1.1 * pw);
      cov = max(cov, edgeOn * smoothfall(thick + pw, thick - pw, dist));
    }
    cov *= c0.w;
    if (cov <= 0.01) continue;
    // Lit on the face turned to us; the sun shining through it from behind sets it glowing.
    vec3 nv = facing > 0.0 ? -n : n;
    vec3 colour = gardenLeafColour(kind, c3.x, c3.y);
    // Its underside (the side n points away from) is paler.
    if (facing > 0.0) colour = mix(colour, vec3(dot(colour, LUMA)) * 0.9 + 0.12, 0.3);
    // On the ground it gets wet, or snowed on.
    if (c3.z > 0.5) colour = mix(wetten(colour, gardenWet, 0.5), GARDEN_SNOW, snowCover(vec3(0.0, 1.0, 0.0), C.xy / GARDEN_METRE, gardenLying));
    float ndl = dot(nv, L);
#if LAYER_GRAVEL
    float shadeHere = c3.z > 0.5 ? gardenStoneShade(C, L, -1) : 1.0;
#else
    float shadeHere = 1.0;
#endif
    vec3 lit = colour * (gardenSun * max(ndl, 0.0) * shadeHere + gardenFill * 0.9 + gardenGlow * 0.5);
    lit += colour * gardenSun * max(-ndl, 0.0) * (0.45 + 0.9 * pow(max(dot(rdn, L), 0.0), 3.0)) * shadeHere * (1.0 - 0.6 * c3.z);
    gardenLeafT = along;
    gardenLeafCov = cov;
    gardenLeafCol = lit;
  }
#endif
}

#if LAYER_GRAVEL
// What the ray meets on the ground (not the wall or over it): the slate, an island's stone or
// moss, (from above) the walls' tiled caps, the drip line and gutter, or the raked gravel; lit, wet,
// pooled, splashed and snowed on.
vec3 gardenGroundColour() {
  vec3 S = gardenS;
  vec3 L = gardenL;
  vec3 rdn = gardenRdn;
  vec2 foot = gardenFoot;
  float wet = gardenWet;
  float lying = gardenLying;
  float overcast = gardenOvercast;
  int hit = gardenHit;
  GardenIsland isl = gardenIsl;
  vec3 n;
  vec3 albedo;
  float ao = 1.0;
  float sheen = 0.0;
  float velvet = 0.0;
  // How the weather takes to it: porous (1 soaks water up and darkens .. 0 hard and glossy),
  // how wet it is, how much snow lies on it, drops bursting on it (hard upward faces, and at
  // what rate), and water standing in the grooves.
  float porous = 0.5;
  float wetHere = wet;
  float snowHere = 0.0;
  float hard = 0.0;
  float splashRate = min(1.0, 1.5 * gardenRain);
  float pool = 0.0;
  // Gravel only: 1 on the ridges' crests, which see the whole sky.
  float crest = 0.0;
  if (gardenSlate > 0.0) {
    // The slate M: grey-blue, its cleavage showing as faint broad laminae, finely pitted; its
    // worn edges gone pale, pale lichen and the odd orange rosette on its flat, moss creeping
    // in over its edge here and there; snow on it in winter.
    n = gardenSlateN;
    vec2 q = S.xy;
    float slateRim = gardenSlateRim;
    float lamina = vnoise(vec2(dot(q, vec2(0.8, 0.6)) * 70.0, dot(q, vec2(-0.6, 0.8)) * 9.0));
    albedo = vec3(0.35, 0.39, 0.44) * (0.85 + 0.22 * lamina) * (0.94 + 0.12 * vnoise(q * 320.0));
    albedo = mix(albedo, vec3(0.6, 0.62, 0.63), 0.65 * slateRim * slateRim);
    float lichen = smoothstep(0.6, 0.72, vnoise(q * 85.0 + 11.0)) * (1.0 - 0.6 * slateRim);
    albedo = mix(albedo, vec3(0.74, 0.76, 0.64), 0.7 * lichen);
    albedo = mix(albedo, vec3(0.8, 0.54, 0.22), 0.6 * smoothstep(0.82, 0.88, vnoise(q * 170.0 + 5.0)));
    float creep = smoothstep(0.55, 0.75, vnoise(q * 60.0 + 2.0)) * smoothstep(0.3, 1.0, slateRim) * smoothstep(0.0, 0.3, K_moss);
    albedo = mix(albedo, gardenMossColour(q), 0.85 * creep);
    snowHere = snowCover(n.xzy, q / GARDEN_METRE, lying);
    ao = 0.85 + 0.15 * n.z;
    sheen = 0.1;
    porous = 0.05;
    hard = 1.0;
  } else if (hit >= 0) {
    // An island: whichever stands higher here, a stone or the moss.
    float s0 = gardenStone(S.xy, isl.a0, isl.b0);
    float s1 = gardenStone(S.xy, isl.a1, isl.b1);
    float s2 = gardenStone(S.xy, isl.a2, isl.b2);
    float stoneTop = max(s0, max(s1, s2));
    vec4 b = s0 >= max(s1, s2) ? isl.b0 : (s1 >= s2 ? isl.b1 : isl.b2);
    float moss = gardenMoss(S.xy, isl);
    n = gardenIslandNormal(S.xy, isl, 0.0015);
    vec3 mossColour = gardenMossColour(S.xy);
    if (stoneTop > moss) {
      // A weathered stone, its planes catching the light differently: grey granite, warm
      // brown, now and then a dark schist; mottled, cracked, pale lichen on its upper faces
      // with the odd orange rosette, dark streaks down its sides, moss climbing its foot,
      // snow on its top.
      float hf = clamp(S.z / max(b.x, 1e-3), 0.0, 1.0);
      vec2 sp = S.xy * 140.0 + b.z * 40.0;
      vec2 bump = vec2(vnoise(sp + vec2(S.z * 80.0, 0.0)), vnoise(sp.yx + vec2(3.1, S.z * 80.0))) - 0.5;
      n = normalize(n + vec3(bump * 0.25, 0.0));
      albedo = mix(vec3(0.5, 0.49, 0.46), vec3(0.56, 0.47, 0.37), b.z);
      albedo = mix(albedo, vec3(0.3, 0.31, 0.33), smoothstep(0.7, 0.9, fract(b.z * 7.3)));
      albedo *= 0.85 + 0.3 * vnoise(S.xy * 60.0 + S.z * 30.0 + b.z * 9.0);
      float crack = abs(vnoise(vec2(dot(S.xy, vec2(0.8, 0.6)) * 70.0 + b.z * 31.0, S.z * 40.0)) - 0.5);
      albedo *= 1.0 - 0.55 * smoothfall(0.035, 0.0, crack) * smoothstep(0.1, 0.4, hf);
      float lichen = smoothstep(0.58, 0.72, vnoise(S.xy * 110.0 + S.z * 40.0 + b.z * 17.0)) * smoothstep(0.35, 0.8, n.z + 0.3 * hf);
      albedo = mix(albedo, vec3(0.76, 0.78, 0.64), 0.65 * lichen);
      float rosette = smoothstep(0.8, 0.86, vnoise(S.xy * 190.0 + b.z * 5.0)) * smoothstep(0.3, 0.7, hf);
      albedo = mix(albedo, vec3(0.8, 0.52, 0.2), 0.6 * rosette);
      float streak = smoothstep(0.55, 0.8, vnoise(vec2(dot(S.xy, vec2(0.7, 0.7)) * 120.0 + b.z * 9.0, S.z * 8.0)));
      albedo *= 1.0 - 0.3 * streak * (1.0 - n.z);
      albedo = mix(albedo, mossColour, smoothfall(0.28, 0.0, hf) * smoothstep(0.0, 0.3, K_moss) * 0.85);
      snowHere = snowCover(n.xzy, S.xy / GARDEN_METRE, lying) * smoothstep(0.15, 0.4, hf);
      ao = 0.7 + 0.3 * hf;
      porous = 0.12;
      hard = 1.0;
    } else {
      // Moss: a velvet cushion, its tufts catching the light, darker at its rim.
      float r = distance(S.xy, isl.c) / max(isl.clear * (GARDEN_MOSS.y + GARDEN_MOSS.z * K_moss), 1e-3);
      vec2 tuft = vec2(vnoise(S.xy * 260.0), vnoise(S.xy * 260.0 + 9.7)) - 0.5;
      n = normalize(n + vec3(tuft * 0.5, 0.0));
      albedo = mossColour * (1.0 - 0.3 * smoothstep(0.6, 1.0, r));
      snowHere = snowCover(n.xzy, S.xy / GARDEN_METRE, lying);
      velvet = 0.8 * (1.0 - snowHere);
      porous = 0.75;
    }
#if GARDEN_ABOVE
  } else if (S.y > GARDEN_WALL_Y || S.x < -0.03 || S.x > GARDEN_ASPECT + 0.03) {
    // From above, the walls round the garden are their tiled caps: rolls of grey tile running
    // across the wall, snow along them in winter.
    float across = S.y > GARDEN_WALL_Y ? S.x : S.y;
    float roll = sin(fract(across / 0.028) * TAU);
    n = S.y > GARDEN_WALL_Y ? normalize(vec3(0.55 * roll, 0.0, 0.8)) : normalize(vec3(0.0, 0.55 * roll, 0.8));
    albedo = vec3(0.17, 0.17, 0.18);
    ao = 0.8;
    porous = 0.0;
    hard = 1.0;
    snowHere = snowCover(n.xzy, S.xy / GARDEN_METRE, lying);
#endif
  } else if (S.y < GARDEN_DRIP || S.y > 1.0) {
    // The drip line along the veranda and the gutter at the wall's foot: dark river pebbles,
    // a granite curb along the gravel's edge.
    float tone;
    vec4 pebble = gardenPebbles(S.xy, tone);
    n = pebble.xyz;
    albedo = mix(vec3(0.1, 0.1, 0.11), mix(vec3(0.26, 0.27, 0.29), vec3(0.46, 0.44, 0.41), tone), pebble.w);
    float curb = S.y < GARDEN_DRIP ? smoothstep(GARDEN_DRIP - 0.007, GARDEN_DRIP - 0.0055, S.y) : smoothfall(1.006, 1.0045, S.y);
    albedo = mix(albedo, vec3(0.5, 0.49, 0.46), curb);
    n = normalize(mix(n, vec3(0.0, 0.0, 1.0), curb));
    sheen = 0.2 * (1.0 - curb);
    snowHere = snowCover(n.xzy, S.xy / GARDEN_METRE, lying) * max(pebble.w, curb);
    porous = mix(0.1, 0.3, curb);
    hard = 1.0;
    // The drip line and the gutter catch what runs off the roofs: they splash hardest.
    splashRate = min(1.0, gardenDripping * 1.6);
  } else {
    // Raked gravel. The normal from the height field, over at least the cell's footprint, so
    // grooves finer than the dither (far from the veranda) melt into an even texture; the same
    // taps give the height averaged over the footprint, for the ridges' light and shade.
    vec2 fuv = vec2(S.x / GARDEN_ASPECT, S.y);
    // Differences over ±1.2 footprints: a groove period of ~4 cells keeps a third of its contrast.
    vec2 e = max(GARDEN_TEXEL, 1.2 * foot * vec2(1.0 / GARDEN_ASPECT, 1.0));
    float h = texture(gravelField0, fuv).r;
    float hE = texture(gravelField0, fuv + vec2(e.x, 0.0)).r;
    float hW = texture(gravelField0, fuv - vec2(e.x, 0.0)).r;
    float hN = texture(gravelField0, fuv + vec2(0.0, e.y)).r;
    float hS = texture(gravelField0, fuv - vec2(0.0, e.y)).r;
    float hx = (hE - hW) / (2.0 * e.x * GARDEN_ASPECT);
    float hy = (hN - hS) / (2.0 * e.y);
    // -1 in a groove's bottom .. 1 on a crest.
    float ridge = clamp((2.0 * h + hE + hW + hN + hS) / (6.0 * 0.0022), -1.0, 1.0);
    float outside = max(-S.x, S.x - GARDEN_ASPECT);
    float relief = 1.3 * (1.0 - 0.5 * smoothstep(0.3, 1.0, lying)) * (1.0 - smoothstep(0.0, 0.05, outside));
    n = normalize(vec3(-hx * relief, -hy * relief, 1.0));
    // Crests see the whole sky, groove bottoms a slot of it: under cloud, where the sky's light
    // is nearly all there is, that is most of the ridges' light and shade.
    crest = smoothstep(0.0, 0.9, ridge);
    ao = 1.0 - mix(0.3, 0.6, overcast) * smoothfall(0.1, -0.9, ridge);
    // White gravel, warm in the light: a fine grain (where a grain is at least a cell), the odd
    // darker pebble, a broad mottle.
    float grainScale = 260.0;
    float grainSeen = 1.0 - smoothstep(0.4, 1.0, max(foot.x, foot.y) * grainScale);
    float speck = step(0.95, hash12(floor(S.xy * grainScale * 0.5)));
    albedo = vec3(0.88, 0.86, 0.81) * (1.0 + grainSeen * (0.08 * (vnoise(S.xy * grainScale) - 0.5) - 0.18 * speck) + 0.05 * (vnoise(S.xy * 18.0) - 0.5));
    // Freshly turned gravel is damp and darker, drying back over a minute or two of the sim's
    // drying clock. Drying with the weather (K_drying, its dampness), the damp lingers in the groove
    // bottoms while the crests pale first, and the sim runs the clock at the weather's pace.
    float age = max(gardenClock - texture(gravelField1, fuv).r, 0.0);
    float damp = K_drying > 0.0
      ? 0.26 * K_drying * exp(-age / (45.0 * mix(1.6, 0.4, 0.5 + 0.5 * ridge)))
      : 0.13 * exp(-age / 45.0);
    albedo *= 1.0 - damp * (gravelField1On() ? 1.0 : 0.0);
    // A patchy fringe of moss in the smooth gravel along the slate M's edge, before its rings.
    float markEdge = gardenMarkEdge;
    if (markEdge < 0.012) {
      float fringe = smoothfall(0.003 + 0.004 * vnoise(S.xy * 70.0), 0.0, markEdge) * smoothstep(0.35, 0.6, vnoise(S.xy * 45.0 + 8.0) + 0.25 * K_moss);
      albedo = mix(albedo, gardenMossColour(S.xy), fringe * smoothstep(0.0, 0.3, K_moss));
      ao *= 1.0 - 0.2 * smoothfall(0.003, 0.0, markEdge);
    }
    // Wet, the crests drain and dry first.
    wetHere = clamp(1.2 * wet - 0.2 * crest, 0.0, 1.0);
    porous = 0.85;
    // Water stands in the groove bottoms once the garden is wet (from wet 0.35, where the
    // library's pools begin), rising with it and brimming in the low patches (rainPuddles): a
    // line of mirrored sky along every groove, about a third of its width in steady rain. Where
    // the grooves come closer than ~7 cells the lines would thin below two: only their share of
    // water shows there, as a sheen.
    float level = mix(-0.0017, -0.0007, smoothstep(0.35, 1.0, wet)) + 0.0006 * rainPuddles(S.xy / GARDEN_METRE, wet);
    float edge = max(0.00012, 0.5 * length(vec2(hx, hy)) * max(foot.x, foot.y));
    float lines = smoothfall(level + edge, level - edge, h);
    float resolved = 1.0 - smoothstep(0.15, 0.3, max(foot.x, foot.y) / GARDEN_GROOVE);
    pool = mix(0.3, lines, resolved) * smoothstep(0.35, 0.6, wet) * (1.0 - lying);
    // Snow settles on the crests first, the grooves last.
    snowHere = snowCover(n.xzy, S.xy / GARDEN_METRE, clamp(lying + 0.2 * smoothstep(-0.001, 0.003, h) - 0.1, 0.0, 1.0));
  }
  // Wet, it darkens and deepens in colour; snow lies over it.
  albedo = mix(wetten(albedo, wetHere * (1.0 - snowHere), porous), GARDEN_SNOW, snowHere);
#if LAYER_BOUGHS
  float dapple = gardenDapple(S, L, gardenTm, gardenT, gardenGust);
#else
  float dapple = 1.0;
#endif
  float lit = gardenStoneShade(S, L, hit) * dapple * gardenLeafShade;
  if (gardenSlate <= 0.0 && gardenMarkEdge < 0.07) lit *= gardenSlateShade(S.xy, L, gardenMarkSize);
  float ndl = max(dot(n, L), 0.0);
  // The sky's light: the fill, the bright low sky and, under cloud, the soft key; crests, open to
  // all of it, are lifted under cloud.
  float skyLit = ao * (1.0 + 0.35 * overcast * crest);
  vec3 col = albedo * (gardenSun * ndl * lit + (gardenFill * (0.55 + 0.45 * n.z) + gardenGlow * max(dot(n, gardenGlowDir), 0.0) + gardenSoftKey * max(dot(n, gardenSoftL), 0.0)) * skyLit);
  // Pebbles and slate give back a little of the bright sky; moss has a velvet rim.
  col += sheen * gardenGlow * pow(max(dot(reflect(rdn, n), gardenGlowDir), 0.0), 6.0);
  col += albedo * gardenFill * velvet * pow(max(1.0 - abs(dot(n, rdn)), 0.0), 2.0);
  // Stone faces turned from the sky still get the light thrown back off the gravel round them.
  if (hit >= 0) col += albedo * gardenBounce * (1.0 - n.z) * 0.9;
  // Wet stone, slate, tiles and pebbles mirror the sky; on the gravel the wet crests glint.
  col += gardenSheen(n, rdn, gardenSkyBright, wetGloss(wetHere * (1.0 - snowHere), n.z) * (1.0 - 0.8 * porous) * (1.0 + 1.5 * crest));
  // Water standing in the grooves: the pale sky in it, well above the wet crests, faint rings
  // where drops land.
  if (pool > 0.0) {
    vec3 rings = rainRipples(S.xy / GARDEN_RIPPLE_CELL, uFallTime, gardenRain);
    col = mix(col, gardenSkyBright * (1.6 + 0.15 * rings.x), pool);
  }
  // Drops bursting into crowns on the upward faces of stone, slate, tile and pebble, sized so a
  // crown always spans a few cells (larger than life far off).
  if (hard > 0.0 && splashRate > 0.0) {
    float unit = max(GARDEN_SPLASH_UNIT, 28.0 * max(foot.x, foot.y));
    float crown = rainSplashes(S.xy / unit, uFallTime, splashRate) * hard * smoothstep(0.4, 0.8, n.z) * (1.0 - snowHere);
    col = mix(col, gardenDropLight * 1.1, crown);
  }
  return col;
}
#endif

#if LAYER_BORDER
// The border over what lies behind it: fern a fresh green, mondo grass near black-green, turned by
// the year and paler toward the tips; lit by the sky, the low sky's glow, the gravel's bounce and
// the sun through the maple's dapple; darker wet, flecked with lying snow.
vec3 gardenBorderColour() {
  vec3 green = abs(gardenBorderForm - GARDEN_FERN) < 0.5 ? vec3(0.2, 0.38, 0.1) : vec3(0.06, 0.15, 0.07);
  vec3 albedo = wetten(plantPhenology(green, gardenBorderPheno) * (0.8 + 0.35 * gardenBorderTip), gardenWet, 0.3);
#if LAYER_BOUGHS
  float dapple = gardenDapple(gardenBorderAt, gardenL, gardenTm, gardenT, gardenGust);
#else
  float dapple = 1.0;
#endif
  vec3 lit = albedo * (gardenSun * max(gardenL.z, 0.0) * 0.8 * dapple + gardenFill * 1.1 + gardenGlow * 0.5 + gardenBounce * 0.5);
  vec3 snowLit = GARDEN_SNOW * (gardenFill * 1.2 + gardenGlow * 0.4 + gardenSun * 0.3 * max(gardenL.z, 0.0));
  return mix(lit, snowLit, 0.7 * snowCover(vec3(0.0, 1.0, 0.0), gardenBorderQ / GARDEN_METRE, gardenLying));
}
#endif

#if LAYER_BOUGHS
// The maple over col, what the cell shows so far: its limbs and twigs, then its foliage over them,
// the nearest leaf behind or in front of them, the drops falling from it. depth: how far the ray
// meets what the cell shows (garden depths; 1e9 over the wall); opaque: how far the nearest opaque
// thing is (the woods' crowns over the wall), brought nearer by the maple's. leafSeen and
// canopySeen: their share of the accent.
void gardenMapleOver(vec2 uv, float depth, inout float opaque, inout vec3 col, out float leafSeen, out float canopySeen) {
  float aspect = gardenAspect;
  float tm = gardenTm;
  float t = gardenT;
  float gust = gardenGust;
  vec3 ro = gardenRo;
  vec3 rdn = gardenRdn;
  vec3 L = gardenL;
  vec3 sun = gardenSun;
  vec3 fill = gardenFill;
  vec3 glow = gardenGlow;
  float wet = gardenWet;
  float lying = gardenLying;
  float dripping = gardenDripping;
  float dripGap = gardenDripGap;
  float season = gardenSeason;
  vec2 sp = vec2(uv.x * aspect, uv.y);
  float cellH = 1.0 / uRes.y;
  float bark = 0.0;
  float barkT = 1e9;
  float barkTop = 0.0;
  // Below the maple's lowest reach (most of the frame) these loops would find nothing; while it
  // drips, its drops fall some five drip spacings further.
  // The boughs may be carried well below their place while they come in or leave (and swing past it).
  float boughDip = (passageIn() < 1.0 || passageOut() > 0.0) ? 0.07 : 0.0;
#if GARDEN_ABOVE
  bool maple = uv.y > GARDEN_MAPLE_LOW.y - boughDip;
#else
  bool maple = uv.y > (GARDEN_MAPLE_LOW.x - (dripping > 0.0 ? 5.2 * dripGap : 0.0)) - boughDip;
#endif
  for (int k = 0; k < GARDEN_LIMB_COUNT && maple; k++) {
    vec4 a = GARDEN_LIMB_A[k];
    vec4 b = GARDEN_LIMB_B[k];
    vec3 sway = gardenSway(k, tm, t, gust);
    vec3 pa = gardenProject(a.xyz + 0.3 * sway + gardenBough(a.xyz), aspect);
    vec3 pb = gardenProject(b.xyz + sway + gardenBough(b.xyz), aspect);
    vec2 A = vec2(pa.x * aspect, pa.y);
    vec2 ab = vec2(pb.x * aspect, pb.y) - A;
    float h = clamp(dot(sp - A, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    vec2 off = sp - A - ab * h;
    float w = max(mix(a.w * pa.z, b.w * pb.z, h), 1.1 * cellH);
    float cov = smoothfall(w + 0.8 * cellH, w - 0.8 * cellH, length(off));
    if (cov > bark) {
      bark = cov;
      barkT = distance(mix(a.xyz, b.xyz, h), ro);
      barkTop = dot(off, normalize(vec2(-ab.y, ab.x)) * sign(ab.x + 1e-6)) / w;
    }
  }
  float drips = 0.0;
  float canopyCov = 0.0;
  float canopyT = 1e9;
  vec3 canopyCol = vec3(0.0);
  float spring = 1.0 - step(0.5, season);
  float summer = step(0.5, season) * (1.0 - step(1.5, season));
  for (int k = 0; k < GARDEN_CLUMP_COUNT && maple; k++) {
    vec4 c = GARDEN_CLUMPS[k];
    vec3 C = c.xyz + gardenSway(k, tm, t, gust) + gardenBough(c.xyz);
    vec3 pr = gardenProject(C, aspect);
    float R = c.w * pr.z;
    vec2 q = (sp - vec2(pr.x * aspect, pr.y)) / R;
    float d2 = dot(q, q);
    float fk = float(k);
    float ct = distance(C, ro) - c.w * 0.7;
#if !GARDEN_ABOVE
    // Drops gathering on the leaves' tips and falling from under the clump, after the rain too.
    if (dripping > 0.0 && ct < opaque && abs(q.x) < 0.8 && q.y < -0.4 && (-0.4 - q.y) * R < 5.2 * dripGap) {
      drips = max(drips, rainDrips(vec2(q.x * R + fk * 0.37, (-0.4 - q.y) * R), uFallTime, dripping, dripGap));
    }
#endif
    // Leaves on the rim reach half a radius past it.
    if (d2 > 2.3) continue;
    // Twigs fanning out from the clump's heart: what winter leaves of it, seen through the
    // foliage otherwise.
    for (int j = 0; j < 6; j++) {
      float hj = hash12(vec2(fk * 7.0 + float(j), 3.3));
      float ang = TAU * (float(j) + 0.6 * hj) / 6.0;
      vec2 tip = vec2(cos(ang), sin(ang) * 0.8 - 0.25) * (0.75 + 0.35 * hj);
      vec2 off = q - tip * clamp(dot(q, tip) / dot(tip, tip), 0.0, 1.0);
      float w = max(0.035, 1.1 * cellH / R);
      float cov = smoothfall(w + 0.8 * cellH / R, w - 0.8 * cellH / R, length(off));
      if (cov > bark) {
        bark = cov;
        barkT = ct + c.w * 0.5;
        barkTop = dot(off, vec2(-tip.y, tip.x) * sign(tip.x + 1e-6)) / w;
      }
    }
    if (gardenWinter > 0.5) continue;
    // Foliage as leaves: a jittered lattice of them in the clump's own frame (so they sway with
    // it), each its own size, turn, shade and tilt, kept within the clump's ragged outline, the
    // sky showing between them. Blossom is smaller and finer; from above the clumps hang close to
    // the eye, out of focus.
    int stamp = spring > 0.5 ? GARDEN_PETAL : (summer > 0.5 ? GARDEN_GREEN : GARDEN_MAPLE);
    float lattice = spring > 0.5 ? 0.2 : 0.3;
    vec2 g = q / lattice;
    vec2 gid = floor(g);
    float cover = 0.0;
    float pick = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 cid = gid + vec2(float(i), float(j));
        float h = hash12(cid + fk * 13.7);
        vec2 centre = (cid + 0.5 + 0.7 * (vec2(h, fract(h * 41.7)) - 0.5)) * lattice;
        float outline = 1.0 - length(centre) + 0.28 * (vnoise(centre * 2.6 + fk * 7.3) - 0.5);
        if (outline < -0.05) continue;
        float size = lattice * (0.72 + 0.38 * fract(h * 3.7)) * (0.6 + 0.4 * smoothstep(-0.05, 0.25, outline));
        vec2 lq = rotate(q - centre, TAU * fract(h * 7.13)) / size;
        if (dot(lq, lq) > 1.3) continue;
#if GARDEN_ABOVE
        float leafAa = max(1.2 * cellH / (R * size), 0.22);
#else
        float leafAa = max(1.2 * cellH / (R * size), 0.0);
#endif
        float cv = gardenLeafShape(lq, stamp, leafAa);
        if (cv > cover) {
          cover = cv;
          pick = h;
        }
      }
    }
    if (cover <= 0.0 || ct > canopyT) continue;
    // Each leaf tilted its own way on the ball of the clump: lit on the sun's side, glowing where
    // the low sun shines through it toward us.
    float nz = sqrt(max(1.0 - d2, 0.0));
    vec2 tilt = (vec2(fract(pick * 5.3), fract(pick * 9.1)) - 0.5) * 1.4;
#if GARDEN_ABOVE
    vec3 nv = vec3(q + tilt, nz + 0.4);
#else
    vec3 nv = vec3(q.x + tilt.x, -(nz + 0.4), q.y + tilt.y);
#endif
    float sunSide = max(dot(normalize(nv), L), 0.0);
    float through = pow(max(dot(rdn, L), 0.0), 2.0);
    float tone = fract(pick * 3.3);
    vec3 base;
    vec3 shine;
    if (spring > 0.5) {
      base = mix(vec3(0.88, 0.64, 0.72), vec3(0.99, 0.9, 0.92), tone);
      shine = vec3(1.0, 0.85, 0.88);
    } else if (summer > 0.5) {
      base = mix(vec3(0.1, 0.26, 0.05), vec3(0.32, 0.52, 0.1), tone);
      shine = vec3(0.45, 0.75, 0.15);
    } else {
      base = mix(vec3(0.55, 0.05, 0.04), vec3(0.86, 0.17, 0.05), smoothstep(0.0, 0.6, tone));
      base = mix(base, vec3(0.93, 0.44, 0.08), smoothstep(0.75, 0.95, tone));
      shine = vec3(1.0, 0.42, 0.1);
    }
    // Wet leaves go darker and deeper and catch the grey sky; snow settles on those turned up.
    base = wetten(base, wet, 0.25);
    vec3 leafN = normalize(nv);
    canopyCol = base * (fill * 0.8 + glow * 0.4 + sun * sunSide * 0.6) + shine * sun * through * (0.15 + 0.3 * tone);
    canopyCol += gardenSheen(leafN, rdn, gardenSkyBright, 0.5 * wetGloss(wet, leafN.z));
    canopyCol = mix(canopyCol, GARDEN_SNOW * (fill * 1.3 + glow * 0.5 + sun * 0.3 + 0.03), 0.9 * snowCover(leafN.xzy, q * 0.8, lying));
    canopyCol = greyed(canopyCol, GARDEN_MOONLIT, 0.6 * gardenSky.night);
    canopyCov = max(canopyCov, cover);
    canopyT = ct;
  }
  // Bark: near black, a rim of light along its top, darker still when wet; snow lies along it.
  vec3 barkCol = (vec3(0.05, 0.035, 0.03) * (1.0 + 2.0 * (fill + glow * 0.5)) + vec3(0.06, 0.05, 0.04) * sun * L.z) * (1.0 - 0.35 * wet);
  float barkUp = clamp(barkTop, -1.0, 1.0);
  barkCol = mix(barkCol, GARDEN_SNOW * (fill * 1.2 + sun * 0.4 + 0.05), snowCover(vec3(0.0, barkUp, -sqrt(1.0 - barkUp * barkUp)), sp * 10.0, lying));

  // Composite back to front: what the ray met, the leaf (if it is behind the foliage), the limbs
  // and the foliage, then the leaf (if it is in front).
  float leafCov = gardenLeafCov;
  float leafT = gardenLeafT;
  bool leafFront = leafCov > 0.0 && leafT < depth + 0.02;
  bool canopyFront = canopyT < depth;
  bool barkFront = barkT < depth;
  if (leafFront && leafT > min(canopyFront ? canopyT : 1e9, barkFront ? barkT : 1e9)) col = mix(col, gardenLeafCol, leafCov);
  if (barkFront) col = mix(col, barkCol, bark);
  if (canopyFront) col = mix(col, canopyCol, canopyCov);
  if (leafFront && leafT <= min(canopyFront ? canopyT : 1e9, barkFront ? barkT : 1e9)) col = mix(col, gardenLeafCol, leafCov);
  leafSeen = leafFront ? leafCov : 0.0;
  canopySeen = 0.45 * canopyCov * (canopyFront ? 1.0 : 0.0);
  // Drops falling from the maple.
  col = mix(col, gardenDropLight, drips);
  if (canopyFront && canopyCov > 0.5) opaque = min(opaque, canopyT);
  if (barkFront && bark > 0.5) opaque = min(opaque, barkT);
  if (leafFront && leafCov > 0.5) opaque = min(opaque, leafT);
}
#endif
`;

/** The garden's part every layer holds (outdoor-code.ts STONE_GARDEN): the veranda's cell, its begin. */
export const stoneGardenSharedGlsl = `
// ---- the stone garden (garden/shader.ts), shared by its layers: the veranda ----
#define GARDEN_ABOVE 0
${GARDEN_COMMON}
// Every garden layer's state for this cell, from the veranda (gardenCell).
void stoneGardenBegin(Ctx x) {
  gardenCell(x.w, x.v, x.gust, x.uv, uTime);
}
`;

/** The temple wall's GLSL: the haze and deck over the wall, the wall, the veranda's boards, the air. */
export const templeWallGlsl = `
// ---- the temple wall ----
// The haze over the wall, which the woods' crowns fade into (templeWallSky).
vec3 gardenHaze;

// The garden's air: the haze toward the wall, what mist and the rain's veil show of the sky, the
// drops' light, the bright sky; the floor ends at the wall's foot.
void templeWallBegin(inout Ctx x) {
  x.air = Air(gardenAir, gardenAir, gardenDropLight, gardenSkyBright, 0.0, 0.0, 0.0);
  x.groundTo = GARDEN_HORIZON - GARDEN_FOCAL * GARDEN_EYE_H / (GARDEN_WALL_Y - GARDEN_EYE_Y);
  x.landZ = (GARDEN_WALL_Y - GARDEN_EYE_Y) * GARDEN_DEPTH_M;
}

// Over the wall: between the woods' crowns only the haze of the sky just below the horizon (the
// horizon is the frame's top edge: no stars, moon or open sky show). Under cloud it is a grey deck
// drifting with the wind, darker bellied in heavy rain.
void templeWallSky(Ctx x, inout Cell c) {
  if (!gardenBeyond) return;
  vec3 rd = gardenRd;
  vec3 dir = normalize(vec3(rd.x, rd.z, rd.y));
  vec3 col = skyColor(gardenSky, dir);
  vec3 haze = skyColor(gardenSky, normalize(vec3(dir.x, 0.02, dir.z)));
  float overcast = gardenOvercast;
  if (overcast > 0.0) {
    float xs = x.uv.x * gardenAspect;
    float drift = 0.012 * (K_wind + 0.3) * gardenTm;
    float belly = 0.6 * vnoise(vec2(xs * 1.3 - drift, 2.0)) + 0.4 * vnoise(vec2(xs * 3.1 - 1.6 * drift, 5.0 + x.uv.y * 6.0));
    vec3 deck = gardenCloudLight * (1.0 - 0.35 * gardenHeavy * smoothstep(0.45, 0.8, belly)) * (0.92 + 0.12 * belly);
    col = mix(col, deck, overcast);
    haze = mix(haze, gardenCloudLight * 0.95, overcast);
  }
  gardenHaze = haze;
  // By moonlight the eye loses colour: the garden reads silver-blue.
  c.col = greyed(col, GARDEN_MOONLIT, 0.6 * gardenSky.night);
}

// The earthen wall: warm ochre clay over a course of stone blocks, under its tiled cap; drops
// running off the eave in rain.
void templeWallMiddle(Ctx x, inout Cell c) {
  if (!gardenWall) return;
  vec3 S = gardenS;
  vec3 L = gardenL;
  float wet = gardenWet;
  vec3 n;
  vec3 albedo;
  float ao = 1.0;
  float h = S.z;
  float up = 0.0;
  float porous = 1.0;
  float wetHere = wet;
  float snowHere = 0.0;
  if (h < GARDEN_WALL_H) {
    n = vec3(0.0, -1.0, 0.0);
    if (h < 0.014) {
      // A course of grey stone blocks at its foot.
      float joint = max(smoothfall(0.0022, 0.0012, abs(fract(S.x / 0.075) - 0.5) * 0.075), smoothfall(0.0016, 0.0006, abs(h - 0.0135)));
      albedo = vec3(0.52, 0.51, 0.48) * (0.9 + 0.12 * vnoise(vec2(S.x * 90.0, h * 300.0))) * (1.0 - 0.5 * joint);
      porous = 0.25;
    } else {
      // The earthen wall: warm ochre clay laid in faint courses, blotched and streaked with
      // the oil that has seeped from it over the centuries.
      float stain = fbm(vec2(S.x * 5.0, h * 14.0));
      float streak = vnoise(vec2(S.x * 48.0, h * 2.5));
      albedo = mix(vec3(0.8, 0.6, 0.37), vec3(0.56, 0.38, 0.22), smoothstep(0.42, 0.78, stain));
      albedo *= 1.0 - 0.16 * smoothstep(0.5, 0.85, streak) * smoothstep(0.1, 0.9, h / GARDEN_WALL_H);
      albedo *= 0.96 + 0.04 * sin(h * 330.0);
    }
    // The eave shades its top; rain splashing up darkens its foot.
    ao = (1.0 - 0.5 * smoothstep(GARDEN_WALL_H - 0.022, GARDEN_WALL_H, h)) * (1.0 - 0.2 * smoothfall(0.02, 0.0, h));
    up = 1.0 - 0.5 * h / GARDEN_WALL_H;
    // Rain slanting in under the eave wets the clay from the foot up and in runs down from the
    // tiles; its top stays drier in the eave's lee.
    float runs = smoothstep(0.55, 0.8, vnoise(vec2(S.x * 70.0, h * 3.0)));
    wetHere = wet * clamp(0.3 + 0.5 * (1.0 - h / GARDEN_WALL_H) + 0.45 * runs, 0.0, 1.0);
  } else {
    // Its cap: the eave's dark edge, then rows of round grey tiles running back over the wall,
    // their rolls catching the light, the ridge along the top; snow settles on them.
    float u = (h - GARDEN_WALL_H) / GARDEN_CAP_H;
    float roll = sin(fract(S.x / 0.028) * TAU);
    if (u < 0.22) {
      n = normalize(vec3(0.0, -1.0, -0.15));
      albedo = vec3(0.15, 0.15, 0.17) * (1.0 + 0.8 * smoothstep(0.12, 0.2, u));
    } else if (u < 0.88) {
      n = normalize(vec3(0.55 * roll, -0.25, 0.9));
      albedo = vec3(0.3, 0.31, 0.34);
    } else {
      n = vec3(0.0, 0.0, 1.0);
      albedo = vec3(0.4, 0.4, 0.42);
    }
    porous = 0.0;
    snowHere = snowCover(n.xzy, S.xz / GARDEN_METRE, gardenLying) * smoothstep(0.2, 0.3, u);
  }
  albedo = mix(wetten(albedo, wetHere * (1.0 - snowHere), porous), GARDEN_SNOW, snowHere);
  // The key from the front (rarely), the sky, and warm light thrown up off the gravel.
  vec3 col = albedo * (gardenSun * max(dot(n, L), 0.0) + (gardenFill * (0.7 + 0.3 * n.z) + gardenGlow * 0.3 + gardenSoftKey * clamp(0.5 + 0.5 * dot(n, gardenSoftL), 0.0, 1.0)) * ao + gardenBounce * up * ao);
  // Wet tiles and foot stones mirror the grey sky.
  col += gardenSheen(n, gardenRdn, gardenSkyBright, wetGloss(wetHere * (1.0 - snowHere), n.z) * (1.0 - porous));
  // Drops running off the tiles' eave, falling past the wall's face toward the gutter.
  if (h < GARDEN_WALL_H && gardenDripping > 0.0) {
    float below = (GARDEN_WALL_H - h) * GARDEN_FOCAL / (GARDEN_WALL_Y - GARDEN_EYE_Y);
    col = mix(col, gardenDropLight, rainDrips(vec2(x.uv.x * gardenAspect, below), uFallTime, gardenDripping, gardenDripGap));
  }
  cellPut(c, vec4(greyed(col, GARDEN_MOONLIT, 0.6 * gardenSky.night), 1.0), gardenHitDepth * gardenZ);
}

// ---- the veranda's edge (engawa) along the bottom: long boards of warm, polished wood running
// along the garden, a seam between two, the rounded nosing lit along its top; it covers the drip
// line, so the boards meet the gravel, which lies in the eaves' shade just beyond. The boards are
// under the temple's eaves: no rain falls in front of them ----
void templeWallFront(Ctx x, inout Cell c) {
  vec2 uv = x.uv;
  float cellH = 1.0 / uRes.y;
  float top = GARDEN_HORIZON - GARDEN_FOCAL * GARDEN_EYE_H / (GARDEN_DRIP - GARDEN_EYE_Y) + 0.004;
  c.col *= 1.0 - 0.22 * smoothfall(top + 0.03, top, uv.y);
  float board = smoothfall(top + cellH, top - cellH, uv.y);
  if (board > 0.0) {
    vec3 fill = gardenFill;
    vec3 glow = gardenGlow;
    float xs = uv.x * gardenAspect;
    float grain = 0.55 * vnoise(vec2(xs * 1.6, uv.y * 38.0)) + 0.45 * vnoise(vec2(xs * 4.0 + 7.0, uv.y * 90.0));
    vec3 wood = vec3(0.56, 0.36, 0.2) * (0.86 + 0.24 * grain);
    float rowW = (uv.y - 0.42 * top) / (0.9 * cellH);
    wood *= 1.0 - 0.45 * exp(-rowW * rowW);
    // Rain blown in past the eave wets the boards' outer edge.
    float edgeWet = gardenWet * smoothstep(top - 0.03, top - 0.006, uv.y);
    wood = wetten(wood, edgeWet, 0.6);
    // Under the temple's eaves: lit by the sky and the gravel's glow, the bright garden softly
    // in the polish toward the edge.
    vec3 boards = wood * (fill * 0.9 + gardenBounce * 1.2 + glow * 0.3) + (fill + glow) * 0.08 * smoothstep(0.3, 1.0, uv.y / top);
    float nose = smoothstep(top - 0.014, top - 0.005, uv.y);
    float highW = (uv.y - (top - 0.0065)) / (1.6 * cellH);
    float highlight = exp(-highW * highW);
    boards = mix(boards, boards * 0.78, nose * (1.0 - highlight)) + highlight * (fill * 0.5 + glow * 0.5 + gardenSun * gardenL.z * 0.3) * 0.5;
    // The wet polish mirrors the grey sky; drops burst on the nosing (seen at a slant, so its
    // metres are half as tall as they are wide).
    boards += gardenSkyBright * 0.3 * wetGloss(edgeWet, 1.0) * smoothstep(0.5, 1.0, uv.y / top);
    float onNose = step(abs(uv.y - (top - 0.005)), 0.0042);
    boards = mix(boards, gardenDropLight, onNose * rainSplashes(vec2(xs, 2.0 * (uv.y - top)) / GARDEN_NOSE_METRE, uFallTime, gardenRain));
    c.col = mix(c.col, boards, board);
    c.accent *= 1.0 - board;
  }
  if (board > 0.5) {
    float z = 0.08 * GARDEN_DEPTH_M;
    c.z = min(c.z, z);
    c.zs = min(c.zs, z);
  }
}
`;

/** The temple woods' GLSL: the two rows of crowns over the wall, on their stems' records. */
export const templeWoodsGlsl = `
// ---- the woods over the wall (their records) ----

// How far the stem of a row's crown k (record first + k) carries the crown now: where the stem's tip
// stands minus where it stands unbent, in screen heights; exactly 0 without a record or unbent.
vec2 gardenCrownShift(int first, int k) {
  if (!templeWoodsSimOn() || k < 0 || k >= ${GARDEN_WOODS.crowns}) return vec2(0.0);
  PlantOrgan o = plantOrgan(templeWoodsAtlas, templeWoodsRow, first + k);
  if (o.tier < 0.5 || o.bend == 0.0) return vec2(0.0);
  return plantPoint(o, o.bend, 1.0) - plantPoint(o, 0.0, 1.0);
}

// The top (uv height) of a row of the woods' crowns at x (screen heights from the frame's left
// edge), as the woods have always been drawn: crown k spans [k, k + 1) of the phase x * row.x +
// row.y * vnoise(x * shape.x, shape.y), a bump amp high over the row's line, base + 0.03 * vnoise(x
// * line.x, line.y). Each crown stands where its stem carries it (gardenCrownShift), so with every
// stem unbent the row is that silhouette exactly; where swaying crowns part, the line shows between
// them. shift: how far across the crown on top at x is carried (0 over the bare line).
float gardenCrowns(float x, int first, vec2 row, vec2 shape, float base, vec2 line, float amp, out float shift) {
  float phase = x * row.x + row.y * vnoise(vec2(x * shape.x, shape.y));
  float k = floor(phase);
  int ik = int(k);
  vec2 dl = gardenCrownShift(first, ik - 1);
  vec2 dc = gardenCrownShift(first, ik);
  vec2 dr = gardenCrownShift(first, ik + 1);
  shift = 0.0;
  if (dl == vec2(0.0) && dc == vec2(0.0) && dr == vec2(0.0)) {
    float w = 2.0 * fract(phase) - 1.0;
    return base + 0.03 * vnoise(vec2(x * line.x, line.y)) + amp * (1.0 - w * w);
  }
  float top = base + 0.03 * vnoise(vec2(x * line.x, line.y));
  for (int i = -1; i <= 1; i++) {
    vec2 d = i < 0 ? dl : (i > 0 ? dr : dc);
    float xs = x - d.x;
    float ps = xs * row.x + row.y * vnoise(vec2(xs * shape.x, shape.y));
    if (floor(ps) != k + float(i)) continue;
    float w = 2.0 * fract(ps) - 1.0;
    float crown = base + 0.03 * vnoise(vec2(xs * line.x, line.y)) + amp * (1.0 - w * w) + d.y;
    if (crown > top) {
      top = crown;
      shift = d.x;
    }
  }
  return top;
}

// Over the wall: the woods of the temple grounds, two rows of rounded crowns, dark green but lit by
// the sky, the farther row paler in the haze. Each crown is a tree swaying on its stem (sim.ts),
// carrying the snow lying on it; rain hangs in grey shafts between here and the woods.
void templeWoodsFar(Ctx x, inout Cell c) {
  if (!gardenBeyond) return;
  vec2 uv = x.uv;
  float xs = uv.x * gardenAspect;
  vec3 haze = gardenHaze;
  float capTop = GARDEN_HORIZON + GARDEN_FOCAL * (GARDEN_WALL_H + GARDEN_CAP_H - GARDEN_EYE_H) / (GARDEN_WALL_Y - GARDEN_EYE_Y);
  float shiftFar;
  float shiftNear;
  float far = gardenCrowns(xs, 0, vec2(${glslFloat(GARDEN_WOODS.far.rate)}, ${glslFloat(GARDEN_WOODS.far.wobble)}), vec2(2.0, 4.0), capTop + 0.05, vec2(2.5, 1.7), 0.018, shiftFar);
  float near = gardenCrowns(xs, ${GARDEN_WOODS.crowns}, vec2(${glslFloat(GARDEN_WOODS.near.rate)}, ${glslFloat(GARDEN_WOODS.near.wobble)}), vec2(3.0, 9.0), capTop + 0.012, vec2(4.0, 1.3), 0.022, shiftNear);
  float farRow = smoothfall(far + 0.003, far - 0.003, uv.y);
  float nearRow = smoothfall(near + 0.003, near - 0.003, uv.y);
  float xc = xs - (nearRow > 0.5 ? shiftNear : shiftFar);
  vec3 foliage = vec3(0.12, 0.2, 0.1) * (gardenFill * 1.3 + gardenGlow * 0.7) + vec3(0.1, 0.09, 0.04) * gardenSun * gardenL.z;
  foliage = mix(foliage, mix(gardenFill, GARDEN_SNOW * 0.7, 0.5) * (0.6 + 0.4 * vnoise(vec2(xc * 50.0, uv.y * 120.0))), 0.55 * smoothstep(0.2, 0.8, gardenLying));
  float shaft = gardenRain * (0.35 + 0.65 * smoothstep(0.35, 0.75, vnoise(vec2((xs + (1.0 - uv.y) * 2.0 * K_wind) * 2.2 - 0.02 * gardenTm, 9.1))));
  float night = 0.6 * gardenSky.night;
  cellPut(c, vec4(greyed(mix(foliage, haze, min(0.55 + 0.4 * shaft, 1.0)), GARDEN_MOONLIT, night), farRow), 6.0 * gardenZ);
  cellPut(c, vec4(greyed(mix(foliage, haze, min(0.22 + 0.5 * shaft, 1.0)), GARDEN_MOONLIT, night), nearRow), 3.0 * gardenZ);
}
`;

/** The gravel's GLSL: the ground the ray meets short of the wall. */
export const gravelGlsl = `
// ---- the raked gravel, its islands, the drip line, the gutter and the slate M ----
void gravelGround(Ctx x, inout Cell c) {
  if (gardenWall || gardenBeyond) return;
  vec3 col = gardenGroundColour();
  float z = gardenHitDepth * gardenZ;
  c.col = greyed(col, GARDEN_MOONLIT, 0.6 * gardenSky.night);
  c.z = z;
  if (gardenHit >= 0 || gardenSlate > 0.0) c.zs = z;
  // The accent: the slate M.
  c.accent = gardenSlate;
}
`;

/** The border's GLSL: its plants over what lies behind them. */
export const borderGlsl = `
// ---- the border along the wall's foot ----
void borderMiddle(Ctx x, inout Cell c) {
  if (gardenBorderCov <= 0.0) return;
  cellPut(c, vec4(greyed(gardenBorderColour(), GARDEN_MOONLIT, 0.6 * gardenSky.night), gardenBorderCov), gardenBorderAlong * gardenZ);
}
`;

/** The boughs' GLSL: the maple, its leaves, its drops over what the cell shows. */
export const boughsGlsl = `
// ---- the maple's boughs ----
void boughsMiddle(Ctx x, inout Cell c) {
  // How far the nearest opaque thing stands, in garden depths: the woods' crowns over the wall.
  float opaque = gardenBeyond ? c.z / gardenZ : gardenDepth;
  float was = opaque;
  vec3 col = c.col;
  float leafSeen;
  float canopySeen;
  gardenMapleOver(x.uv, gardenDepth, opaque, col, leafSeen, canopySeen);
  c.col = col;
  if (opaque < was) {
    float z = opaque * gardenZ;
    c.z = min(c.z, z);
    c.zs = min(c.zs, z);
  }
  // The accent: the maple's leaves, its foliage a little.
  c.accent = max(c.accent, max(leafSeen, canopySeen));
}
`;

/** Accessors for the layers' data where the composed sim allocates it (composer/glsl.ts's own form). */
function accessors(alloc: Allocation): string {
  return alloc.layers
    .map((id) => {
      const out: string[] = [];
      const rows = alloc.rows[id];
      if (rows !== undefined)
        out.push(
          `#define ${id}Atlas uSim${ATLAS_SLOT}`,
          `const int ${id}Row = ${rows.base};`,
          `bool ${id}SimOn() { return ${simOn(ATLAS_SLOT)} > 0.5; }`,
          `vec4 ${id}Record(int x, int y) { return texelFetch(uSim${ATLAS_SLOT}, ivec2(x, ${id}Row + y), 0); }`,
        );
      (alloc.fields[id] ?? []).forEach((slot, k) => {
        out.push(
          `#define ${id}Field${k} uSim${slot}`,
          `bool ${id}Field${k}On() { return ${simOn(slot)} > 0.5; }`,
        );
      });
      return out.join("\n");
    })
    .join("\n");
}

/**
 * The view from straight above (the gravel's camera at 1), a program of the garden's own (see the
 * header), reading the layers' data where the composed sim allocates it for the layers on (`alloc`):
 * what the ray meets straight below, the border laid out toward the gravel, the maple hanging close
 * to the eye; the rain and snow falling away from the eye, drawn in log-polar coordinates round the
 * point straight below, where falling is moving inward.
 */
export function gardenAboveGlsl(alloc: Allocation): string {
  return `
${worldGlsl}
${gustGlsl(WORLD_TRIGGERS.gusts, undefined)}
${plantsGlsl}
${accessors(alloc)}
// ---- the stone garden from straight above (garden/shader.ts gardenAboveGlsl) ----
#define GARDEN_ABOVE 1
${GARDEN_COMMON}

Shade ${COMPOSER_ENTRY}(vec2 uv, vec2 cell, float t) {
  World w = worldAt(${WORLD_TRIGGERS.meteors}, ${WORLD_TRIGGERS.lightning});
  WorldView v = worldView(uv, GARDEN_HORIZON, GARDEN_FOCAL, GARDEN_EYE_H * GARDEN_DEPTH_M, 0.0, 1.0);
  gardenCell(w, v, gustWind(), uv, t);
  float aspect = gardenAspect;
  float tm = gardenTm;
  vec3 col = vec3(0.0);
#if LAYER_GRAVEL
  col = gardenGroundColour();
#endif
#if LAYER_BORDER
  if (gardenBorderCov > 0.0) col = mix(col, gardenBorderColour(), gardenBorderCov);
#endif
  // By moonlight the eye loses colour: the garden reads silver-blue.
  col = greyed(col, GARDEN_MOONLIT, 0.6 * gardenSky.night);
  float opaque = gardenDepth;
  float leafSeen = 0.0;
  float canopySeen = 0.0;
#if LAYER_BOUGHS
  gardenMapleOver(uv, gardenDepth, opaque, col, leafSeen, canopySeen);
#endif

  // ---- falling rain and snow, in depth: only what falls nearer than the first thing the ray meets.
  // Looking down, drops fall away from the eye toward the point straight below, so they are drawn in
  // log-polar coordinates round it (angle, log distance), where falling is moving inward. The map
  // draws a drop at r / 0.25 of its size, so toward the centre, where drops are seen end-on anyway,
  // the farther, finer layers are let go: the drops are handed a depth that shrinks with r there,
  // while the veil keeps the true one. ----
  float rain = gardenRain;
  float snow = gardenSnow;
  if (rain > 0.0 || snow > 0.0) {
    vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
    float r = max(length(c), 1e-4);
    vec2 fallUv = vec2(atan(c.y, c.x), log(r)) * 0.25 + vec2(0.5, 0.8);
    float reach = 0.75 * smoothstep(0.06, 0.5, r);
    float zN = opaque > 1e8 ? 1.0 : weatherDepth(opaque / GARDEN_METRE);
    float zDrops = min(zN, reach);
    // Drizzle is mostly a grey mist over the distance (its optical depth growing faster than the
    // distance, so the near garden stays clear); the falling water's own veil, with its gust
    // curtains, closes in as it gets heavier.
    float mistDensity = 0.15 * smoothstep(0.0, 0.15, rain) + 0.1 * rain;
    float veil = 1.0 - exp(-mistDensity * zN * (1.0 + 4.0 * zN));
    float drops = 0.0;
    float flakes = 0.0;
    if (rain > 0.0) {
      Precip pr = rainFall(fallUv, 1.0, tm, uFallTime, rain, 0.0, zN);
      veil = max(veil, pr.veil);
      if (zDrops < zN) pr = rainFall(fallUv, 1.0, tm, uFallTime, rain, 0.0, zDrops);
      drops = pr.cover;
    }
    if (snow > 0.0) {
      Precip ps = snowFall(fallUv, 1.0, tm, snow, 0.0, zN);
      veil = max(veil, ps.veil);
      if (zDrops < zN) ps = snowFall(fallUv, 1.0, tm, snow, 0.0, zDrops);
      flakes = ps.cover;
    }
    col = precipOver(col, gardenAir, gardenDropLight, Precip(drops, veil, 0.0));
    col = mix(col, GARDEN_SNOW * (gardenDropLight + gardenSun * 0.1), flakes);
  }

  col = clamp(col, 0.0, 1.0);
  // The accent: the maple's leaves, its foliage a little, and the slate M.
  float accent = clamp(max(max(leafSeen, canopySeen), gardenSlate), 0.0, 1.0);
  return shadeOf(col, inkOf(col, 1.15, 0.85), accent);
}
`;
}
