// The dry garden scene: raked gravel (sim.ts's height field, uSim0), stone islands with moss
// collars (uSim1), the leaves in the air and on the ground (uSim2) and when each spot was last raked
// (uSim3), seen from the temple veranda across to the earthen wall, or from straight above.
//
// Everything is worked in garden space (sim.ts GARDEN): X right, Y away from the veranda, Z up, in
// garden depths. That is the sky library's frame with y and z swapped, so its sun and moon light the
// garden directly. The veranda camera is viewRay's shifted-lens pinhole (verticals stay vertical);
// the stones are marched as height fields inside their islands' bounding cylinders, the gravel is
// the plane with the raked height field for its normals. A low sun rakes across the grooves: the
// flanks turned to it catch the light, the others fall into the sky's cool shade.
import { GARDEN, GARDEN_CANOPY, GARDEN_ISLANDS, GARDEN_LEAF_KIND, GARDEN_LEAF_SLOTS, GARDEN_MARK, GARDEN_MOSS, GARDEN_STONES } from "./sim.ts";

const glsl = (value: number): string => value.toFixed(4);

/**
 * The maple's limbs, garden space, as polylines of (x, y, z, radius): the trunk stands beyond the
 * wall off the left of the frame; one limb sweeps over the wall toward the middle, one rises over
 * the garden, two short ones carry the low foliage over the wall's cap.
 */
const LIMBS: readonly (readonly (readonly [number, number, number, number])[])[] = [
  [[-0.2, 1.18, 0.12, 0.016], [0.05, 1.1, 0.25, 0.012], [0.3, 1.03, 0.205, 0.009], [0.62, 0.94, 0.215, 0.007], [0.88, 0.86, 0.24, 0.005], [1.1, 0.79, 0.255, 0.003]],
  [[0.3, 1.03, 0.205, 0.007], [0.5, 1.0, 0.16, 0.004]],
  [[0.05, 1.1, 0.25, 0.01], [0.22, 0.92, 0.29, 0.008], [0.46, 0.82, 0.285, 0.006], [0.74, 0.73, 0.3, 0.004]],
  [[0.3, 1.03, 0.205, 0.006], [0.4, 1.13, 0.14, 0.004]],
];
const SEGMENTS = LIMBS.flatMap((limb) => limb.slice(1).map((end, k) => [limb[k] ?? end, end] as const));
const vec4s = (rows: readonly (readonly number[])[]): string => rows.map((row) => `vec4(${row.map(glsl).join(", ")})`).join(",\n  ");

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
    low = Math.min(low, v - 1.35 * r * s);
  }
  return low - 0.04;
}

export const gardenGlsl = `
const float GARDEN_ASPECT = ${glsl(GARDEN.aspect)};
const vec2 GARDEN_CENTRE = vec2(${glsl(GARDEN.aspect / 2)}, 0.5);
const vec2 GARDEN_TEXEL = vec2(${(1 / GARDEN.cols).toFixed(6)}, ${(1 / GARDEN.rows).toFixed(6)});
const float GARDEN_DRIP = ${glsl(GARDEN.drip)};
const float GARDEN_WALL_Y = ${glsl(GARDEN.wallY)};
const float GARDEN_WALL_H = ${glsl(GARDEN.wallHeight)};
const float GARDEN_CAP_H = ${glsl(GARDEN.capHeight)};
const float GARDEN_FOCAL = ${glsl(GARDEN.focal)};
const float GARDEN_HORIZON = ${glsl(GARDEN.horizon)};
const float GARDEN_EYE_H = ${glsl(GARDEN.eyeHeight)};
const float GARDEN_EYE_Y = ${glsl(GARDEN.eyeY)};
const float GARDEN_SPAN = ${glsl(GARDEN.span)};
const float GARDEN_HIGH = ${glsl(GARDEN.overheadHeight)};
const float GARDEN_ABOVE_Y = ${glsl(GARDEN.overheadY)};
const vec2 GARDEN_MARK_AT = vec2(${glsl(GARDEN_MARK.x)}, ${glsl(GARDEN_MARK.y)});
const vec2 GARDEN_MARK_SIZE = vec2(${glsl(GARDEN_MARK.small)}, ${glsl(GARDEN_MARK.grow)});
const float GARDEN_MARK_STROKE = ${glsl(GARDEN_MARK.stroke)};
const float GARDEN_SLATE = ${glsl(GARDEN_MARK.slate)};
const vec3 GARDEN_MOSS = vec3(${glsl(GARDEN_MOSS.height)}, ${glsl(GARDEN_MOSS.base)}, ${glsl(GARDEN_MOSS.grow)});
const int GARDEN_LEAVES = ${GARDEN_LEAF_SLOTS};
const int GARDEN_ISLAND_COUNT = ${GARDEN_ISLANDS};
// GardenIsland below holds exactly this many stones.
const int GARDEN_STONE_COUNT = ${GARDEN_STONES};
const int GARDEN_MAPLE = ${GARDEN_LEAF_KIND.maple};
const int GARDEN_PETAL = ${GARDEN_LEAF_KIND.petal};
const int GARDEN_GREEN = ${GARDEN_LEAF_KIND.green};
const int GARDEN_WITHERED = ${GARDEN_LEAF_KIND.withered};
// The largest leaf radius the sim draws, with room for its edge: rays farther off skip a leaf.
const float GARDEN_LEAF_REACH = 0.016;
const int GARDEN_CLUMP_COUNT = ${GARDEN_CANOPY.length};
const vec4 GARDEN_CLUMPS[${GARDEN_CANOPY.length}] = vec4[${GARDEN_CANOPY.length}](
  ${vec4s(GARDEN_CANOPY)}
);
// The lowest screen height the maple reaches: from the veranda (x), from above (y).
const vec2 GARDEN_MAPLE_LOW = vec2(${glsl(mapleLow(false))}, ${glsl(mapleLow(true))});
const int GARDEN_LIMB_COUNT = ${SEGMENTS.length};
const vec4 GARDEN_LIMB_A[${SEGMENTS.length}] = vec4[${SEGMENTS.length}](
  ${vec4s(SEGMENTS.map(([a]) => a))}
);
const vec4 GARDEN_LIMB_B[${SEGMENTS.length}] = vec4[${SEGMENTS.length}](
  ${vec4s(SEGMENTS.map(([, b]) => b))}
);

// ---- the gravel, the islands ----

float gardenGravel(vec2 p) {
  return texture(uSim0, vec2(p.x / GARDEN_ASPECT, p.y)).r;
}

// A stone's height at p: a rounded dome on a wobbly footprint, steep-sided (sim.ts stoneHeight).
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
  return r < 1.0 ? b.x * pow(1.0 - pow(r, 2.6), 0.45) : 0.0;
}

struct GardenIsland {
  vec2 c;      // centre
  float clear; // the smooth gravel (and moss) within this radius; 0: no island
  float top;   // the tallest stone
  vec4 a0; vec4 b0; vec4 a1; vec4 b1; vec4 a2; vec4 b2;
};

GardenIsland gardenIsland(int i) {
  GardenIsland g;
  vec4 d = texelFetch(uSim1, ivec2(i, 0), 0);
  g.c = d.xy + GARDEN_CENTRE;
  g.clear = d.z;
  g.top = max(d.w, GARDEN_MOSS.x + 0.002);
  g.a0 = texelFetch(uSim1, ivec2(2 * i, 1), 0);
  g.b0 = texelFetch(uSim1, ivec2(2 * i + 1, 1), 0);
  g.a1 = texelFetch(uSim1, ivec2(2 * i, 2), 0);
  g.b1 = texelFetch(uSim1, ivec2(2 * i + 1, 2), 0);
  g.a2 = texelFetch(uSim1, ivec2(2 * i, 3), 0);
  g.b2 = texelFetch(uSim1, ivec2(2 * i + 1, 3), 0);
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
    vec4 d = texelFetch(uSim1, ivec2(i, 0), 0);
    if (d.z <= 0.0) continue;
    vec2 v = d.xy + GARDEN_CENTRE - p.xy;
    float along = dot(v, l2);
    if (along < -d.z || p.z + (along - d.z) * rise > d.w || abs(dot(v, side)) > d.z) continue;
    for (int j = 0; j < GARDEN_STONE_COUNT; j++) {
      vec4 a = texelFetch(uSim1, ivec2(2 * i, 1 + j), 0);
      vec4 b = texelFetch(uSim1, ivec2(2 * i + 1, 1 + j), 0);
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

// ---- the maple ----

// A "now" gust (sim.ts gustAt): rises over a second, then dies away.
float gardenGust(float age) {
  if (age <= 0.0 || age >= 12.0) return 0.0;
  return age * age * exp(2.0 * (1.0 - age));
}

// How far clump k of the foliage leans now: a slow sway on the breeze, livelier with the wind,
// tossed by a gust (on the scene clock, so a gust plays with motion off).
vec3 gardenSway(int k, float tm, float t, float gust) {
  float fk = float(k);
  float breeze = (0.0022 + 0.006 * abs(K_wind)) * (sin(tm * 0.55 + fk * 1.7) + 0.5 * sin(tm * 0.93 + fk * 2.9));
  float lean = 0.006 * K_wind + 0.02 * gust;
  float toss = 0.008 * abs(gust) * sin(t * 2.4 + fk * 1.3);
  return vec3(breeze + lean + toss, 0.0, 0.4 * breeze + 0.5 * toss);
}

// Screen uv of garden point p in this view, and screen heights per garden depth there (z).
vec3 gardenProject(vec3 p, float aspect, bool above) {
  if (above) {
    float s = GARDEN_HIGH / max(GARDEN_HIGH - p.z, 0.05) / GARDEN_SPAN;
    return vec3(0.5 + (p.x - GARDEN_CENTRE.x) * s / aspect, 0.5 + (p.y - GARDEN_ABOVE_Y) * s, s);
  }
  float s = GARDEN_FOCAL / max(p.y - GARDEN_EYE_Y, 0.02);
  return vec3(0.5 + (p.x - GARDEN_CENTRE.x) * s / aspect, GARDEN_HORIZON + (p.z - GARDEN_EYE_H) * s, s);
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

// ---- leaves ----

// Coverage of a leaf of kind k at q (its radius 1, its tip toward +y), antialiased over aa.
float gardenLeafShape(vec2 q, int k, float aa) {
  if (k == GARDEN_PETAL) {
    // A cherry petal: obovate, notched at the tip, narrowing to its base.
    vec2 p = vec2(q.x * (1.25 + 0.45 * smoothstep(0.3, -0.9, q.y)), q.y + 0.05);
    float a = atan(p.x, p.y);
    return smoothstep(aa, -aa, length(p) - (0.92 - 0.3 * exp(-a * a * 30.0)));
  }
  // A palmate maple leaf: seven pointed lobes, the lowest small, a notch at the stalk. A withered
  // one has curled up narrow.
  if (k == GARDEN_WITHERED) q.x *= 1.55;
  float a = atan(q.x, q.y);
  float lobe = pow(0.5 + 0.5 * cos(4.0 * a), 2.2);
  float r = mix(0.36, 1.0, lobe) * (1.0 - 0.3 * smoothstep(1.3, 2.7, abs(a))) * (1.0 - 0.75 * smoothstep(2.6, 3.1, abs(a)));
  float blade = smoothstep(aa, -aa, length(q) - r);
  float stalk = smoothstep(0.05 + aa, 0.05 - aa, segmentDistance(q, vec2(0.0, -0.25), vec2(0.04, -0.8)));
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

Shade sceneGarden(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  float tm = t * uMotion;
  bool above = K_camera > 0.5;
  float season = floor(K_season + 0.5);
  float winter = step(2.5, season);
  bool paper = K_cycle <= 0.0 && K_time > 0.33 && K_time < 0.67;
  float gust = gardenGust(sinceTrigger(0)) * (K_wind < -0.05 ? -1.0 : 1.0);
  float markSize = K_mark > 0.0 ? GARDEN_MARK_SIZE.x + GARDEN_MARK_SIZE.y * K_mark : 0.0;
  float clock = texelFetch(uSim1, ivec2(GARDEN_ISLAND_COUNT, 0), 0).x;

  // Light. The key is the sun, or the moon once the sun is down. A low sun is weak on the flat but
  // strong on the flanks turned to it: expose it up as it sinks, as dunes does.
  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  bool moonlit = sky.sun.y < -0.03;
  vec3 key = moonlit ? sky.moon : sky.sun;
  vec3 L = normalize(vec3(key.x, key.z, max(key.y, 0.004)));
  vec3 sun = (moonlit ? sky.moonColor * 1.6 : sky.sunColor) * 0.95 / (0.3 + 0.7 * L.z);
  vec3 fill = sky.ambient * 0.45;
  // The bright sky low on the sun's side: a soft light that keeps the grooves legible at dusk.
  vec2 sunward = normalize(vec2(sky.sun.x, sky.sun.z) + vec2(1e-4, 0.0));
  vec3 glowDir = normalize(vec3(sunward * 0.93, 0.36));
  vec3 glow = skyColor(sky, normalize(vec3(sunward.x, 0.18, sunward.y))) * 0.26 * (1.0 - 0.6 * sky.night);
  vec3 snowWhite = vec3(0.9, 0.93, 0.98);

  // The ray, in garden space.
  vec3 ro;
  vec3 rd;
  if (above) {
    ro = vec3(GARDEN_CENTRE.x, GARDEN_ABOVE_Y, GARDEN_HIGH);
    rd = vec3((uv - 0.5) * vec2(aspect, 1.0) * GARDEN_SPAN, -GARDEN_HIGH);
  } else {
    ro = vec3(GARDEN_CENTRE.x, GARDEN_EYE_Y, GARDEN_EYE_H);
    rd = vec3((uv.x - 0.5) * aspect, GARDEN_FOCAL, uv.y - GARDEN_HORIZON);
  }
  float rdLength = length(rd);
  vec3 rdn = rd / rdLength;
  // Garden depths per cell across the ray, per unit of distance along it.
  float pixel = (above ? GARDEN_SPAN : 1.0) / (uRes.y * rdLength);
  // Where the ray meets the gravel's plane, and the cell's footprint there: taken in uniform
  // control flow, because fwidth needs every neighbour to run it.
  float tG = min(ro.z / max(-rd.z, 1e-3), 60.0);
  vec3 P = ro + rd * tG;
  vec2 foot = fwidth(P.xy);

  // The wall: the ground's plane past it is hidden; above it, the woods and sky.
  float tW = above ? 1e9 : (GARDEN_WALL_Y - ro.y) / rd.y;
  float zW = ro.z + rd.z * tW;
  bool wall = !above && P.y > GARDEN_WALL_Y && zW < GARDEN_WALL_H + GARDEN_CAP_H;
  bool beyond = !above && P.y > GARDEN_WALL_Y && !wall;
  float tHit = wall ? tW : (beyond ? 1e9 : tG);

  // Islands: the nearest moss or stone along the ray (veranda), or under it (above).
  int hit = -1;
  if (!beyond && !wall) {
    for (int i = 0; i < GARDEN_ISLAND_COUNT; i++) {
      vec4 d = texelFetch(uSim1, ivec2(i, 0), 0);
      if (d.z <= 0.0) continue;
      vec2 c = d.xy + GARDEN_CENTRE;
      if (above) {
        if (distance(P.xy, c) < d.z) hit = i;
        continue;
      }
      // A cheap look before the march: does the ray's ground track pass within reach?
      vec2 toC = c - ro.xy;
      vec2 dir2 = normalize(rd.xy);
      if (abs(toC.x * dir2.y - toC.y * dir2.x) > d.z) continue;
      float th = gardenMarch(ro, rd, gardenIsland(i), tHit);
      if (th > 0.0 && th <= tHit) {
        tHit = th;
        hit = i;
      }
    }
  }
  vec3 S = ro + rd * tHit;
  GardenIsland isl;
  if (hit >= 0) isl = gardenIsland(hit);
  float islandTop = hit >= 0 ? gardenIslandHeight(S.xy, isl) : 0.0;
  if (above && hit >= 0) {
    if (islandTop > max(gardenGravel(S.xy), 0.0) + 0.0003) S.z = islandTop;
    else hit = -1;
  }
  float depth = beyond ? 1e9 : tHit * rdLength;

  // The M: a slab of slate lying in the gravel (its top a little above it; from the veranda, its
  // front edge shows below the top).
  float slate = 0.0;
  vec3 slateN = vec3(0.0, 0.0, 1.0);
  if (markSize > 0.0 && !beyond && !wall && hit < 0) {
    float stroke = GARDEN_MARK_STROKE * markSize;
    vec2 topAt = above ? S.xy : (ro + rd * ((ro.z - GARDEN_SLATE) / -rd.z)).xy;
    float dTop = gardenMarkDistance(topAt, markSize);
    float dFoot = gardenMarkDistance(S.xy, markSize);
    float aa = 0.7 * max(max(foot.x, foot.y), 0.0008);
    float onTop = smoothstep(stroke + aa, stroke - aa, dTop);
    float onSide = above ? 0.0 : smoothstep(stroke + aa, stroke - aa, dFoot) * (1.0 - onTop);
    slate = max(onTop, onSide);
    if (slate > 0.0) {
      // A bevelled rim: the top's normal tips outward over its last stretch.
      vec2 e = vec2(0.0015, 0.0);
      vec2 grad = vec2(gardenMarkDistance(topAt + e, markSize) - gardenMarkDistance(topAt - e, markSize),
                       gardenMarkDistance(topAt + e.yx, markSize) - gardenMarkDistance(topAt - e.yx, markSize)) / (2.0 * e.x);
      float bevel = smoothstep(stroke - 0.006, stroke, dTop);
      slateN = onSide > onTop ? vec3(0.0, -1.0, 0.0) : normalize(vec3(grad * bevel * 1.2, 1.0));
      S = onTop > 0.5 ? vec3(topAt, GARDEN_SLATE) : S;
    }
  }

  // ---- leaves: the nearest one in front along this ray, and their shadows on what it meets ----
  float leafCov = 0.0;
  float leafT = 1e9;
  vec3 leafCol = vec3(0.0);
  float leafShade = 1.0;
  float lightUp = L.z > 0.03 && !beyond && !wall ? 1.0 : 0.0;
  for (int i = 0; i < GARDEN_LEAVES; i++) {
    vec4 c0 = texelFetch(uSim2, ivec2(0, i), 0);
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
    vec4 c1 = texelFetch(uSim2, ivec2(1, i), 0);
    vec4 c2 = texelFetch(uSim2, ivec2(2, i), 0);
    vec4 c3 = texelFetch(uSim2, ivec2(3, i), 0);
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
        leafShade = min(leafShade, 1.0 - 0.8 * c0.w * cov * (1.0 - smoothstep(0.05, 0.3, s)));
      }
    }
    if (!near || along >= leafT) continue;
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
      cov = max(cov, edgeOn * smoothstep(thick + pw, thick - pw, dist));
    }
    cov *= c0.w;
    if (cov <= 0.01) continue;
    // Lit on the face turned to us; the sun shining through it from behind sets it glowing.
    vec3 nv = facing > 0.0 ? -n : n;
    vec3 colour = gardenLeafColour(kind, c3.x, c3.y);
    // Its underside (the side n points away from) is paler.
    if (facing > 0.0) colour = mix(colour, vec3(dot(colour, LUMA)) * 0.9 + 0.12, 0.3);
    float ndl = dot(nv, L);
    float shadeHere = c3.z > 0.5 ? gardenStoneShade(C, L, -1) : 1.0;
    vec3 lit = colour * (sun * max(ndl, 0.0) * shadeHere + fill * 0.9 + glow * 0.5);
    lit += colour * sun * max(-ndl, 0.0) * (0.45 + 0.9 * pow(max(dot(rdn, L), 0.0), 3.0)) * shadeHere * (1.0 - 0.6 * c3.z);
    leafT = along;
    leafCov = cov;
    leafCol = lit;
  }

  // ---- what the ray meets ----
  vec3 col;
  if (beyond) {
    // Over the wall: the evening sky, and a band of far woods dark against it.
    vec3 dir = normalize(vec3(rd.x, rd.z, rd.y));
    col = skyColor(sky, dir) + skyStars(sky, dir, 0.85) * vec3(0.92, 0.94, 1.0) * 1.2;
    float capTop = GARDEN_HORIZON + GARDEN_FOCAL * (GARDEN_WALL_H + GARDEN_CAP_H - GARDEN_EYE_H) / (GARDEN_WALL_Y - GARDEN_EYE_Y);
    float x = uv.x * aspect;
    float ridge = capTop + 0.018 + 0.035 * vnoise(vec2(x * 4.0, 1.3)) + 0.018 * vnoise(vec2(x * 13.0, 7.1)) + 0.007 * vnoise(vec2(x * 37.0, 3.3));
    float woods = smoothstep(ridge + 0.0025, ridge - 0.0025, uv.y);
    vec3 dark = vec3(0.02, 0.035, 0.03) + sky.ambient * 0.1 + glow * 0.2;
    dark = mix(dark, mix(fill, snowWhite * 0.5, 0.4) * (0.5 + 0.5 * vnoise(vec2(x * 60.0, uv.y * 140.0))), 0.45 * winter);
    col = mix(col, dark, woods);
  } else if (wall) {
    vec3 n;
    vec3 albedo;
    float ao = 1.0;
    float h = S.z;
    if (h < GARDEN_WALL_H) {
      // The earthen wall: ochre clay, blotched and streaked with the oil that seeps from it over
      // the years, darker under the eave and at its foot where rain splashes up.
      float stain = fbm(vec2(S.x * 7.0, h * 22.0));
      float streak = vnoise(vec2(S.x * 55.0, h * 3.0));
      albedo = mix(vec3(0.6, 0.43, 0.27), vec3(0.4, 0.27, 0.17), smoothstep(0.4, 0.75, stain));
      albedo *= 1.0 - 0.2 * smoothstep(0.5, 0.85, streak) * smoothstep(0.0, 0.8, h / GARDEN_WALL_H);
      n = vec3(0.0, -1.0, 0.0);
      ao = (1.0 - 0.6 * smoothstep(GARDEN_WALL_H - 0.03, GARDEN_WALL_H, h)) * (1.0 - 0.3 * smoothstep(0.025, 0.0, h));
    } else {
      // Its cap: a short roof of round grey tiles, their rolls catching the light, the eave's
      // edge a bright line; snow along it in winter.
      float u = (h - GARDEN_WALL_H) / GARDEN_CAP_H;
      float roll = sin(fract(S.x / 0.028) * TAU);
      n = normalize(vec3(0.55 * roll, -0.6 + 0.9 * u, 0.7));
      albedo = vec3(0.17, 0.17, 0.18) * (1.0 + 0.25 * smoothstep(0.0, 0.2, u) * (1.0 - smoothstep(0.2, 0.4, u)));
      albedo = mix(albedo, snowWhite, winter * smoothstep(0.35, 0.7, u));
    }
    // The sky, the key from the front, and warm light thrown up off the gravel.
    vec3 gravelBounce = vec3(0.8, 0.76, 0.68) * sun * L.z * 0.35;
    col = albedo * (sun * max(dot(n, L), 0.0) + (fill * 0.75 + glow * 0.4 + gravelBounce * smoothstep(0.1, 0.0, h)) * ao);
  } else {
    vec3 n;
    vec3 albedo;
    float ao = 1.0;
    float sheen = 0.0;
    if (slate > 0.0) {
      // The slate M: blue-black, finely cleft, its bevel catching the light.
      n = slateN;
      float cleft = vnoise(vec2(dot(S.xy, vec2(0.8, 0.6)) * 340.0, dot(S.xy, vec2(-0.6, 0.8)) * 30.0));
      albedo = vec3(0.13, 0.14, 0.17) * (0.85 + 0.3 * cleft);
      albedo = mix(albedo, snowWhite, winter * 0.8 * n.z);
      sheen = 0.25;
    } else if (hit >= 0) {
      // An island: whichever stands higher here, a stone or the moss.
      float s0 = gardenStone(S.xy, isl.a0, isl.b0);
      float s1 = gardenStone(S.xy, isl.a1, isl.b1);
      float s2 = gardenStone(S.xy, isl.a2, isl.b2);
      float stoneTop = max(s0, max(s1, s2));
      vec4 b = s0 >= max(s1, s2) ? isl.b0 : (s1 >= s2 ? isl.b1 : isl.b2);
      float moss = gardenMoss(S.xy, isl);
      n = gardenIslandNormal(S.xy, isl, 0.0015);
      vec3 mossColour = mix(vec3(0.06, 0.14, 0.035), vec3(0.15, 0.26, 0.05), vnoise(S.xy * 230.0 + 7.0));
      if (stoneTop > moss) {
        // A weathered stone: granite or brown chert or dark schist, faceted, lichen on its
        // shoulders, dark streaks down its faces, moss creeping up its foot, snow on its top.
        float hf = clamp(S.z / max(b.x, 1e-3), 0.0, 1.0);
        vec2 sp = S.xy * 90.0 + b.z * 40.0;
        vec2 bump = vec2(vnoise(sp + vec2(S.z * 60.0, 0.0)), vnoise(sp.yx + vec2(3.1, S.z * 60.0))) - 0.5;
        n = normalize(n + vec3(bump * 0.7, 0.0));
        albedo = mix(vec3(0.3, 0.29, 0.27), vec3(0.37, 0.3, 0.23), b.z);
        albedo = mix(albedo, vec3(0.19, 0.2, 0.21), smoothstep(0.65, 0.9, fract(b.z * 7.3)));
        float lichen = smoothstep(0.62, 0.76, vnoise(S.xy * 160.0 + S.z * 40.0 + b.z * 17.0)) * smoothstep(0.2, 0.6, hf);
        albedo = mix(albedo, vec3(0.62, 0.64, 0.52), 0.55 * lichen);
        float streak = smoothstep(0.55, 0.8, vnoise(vec2(dot(S.xy, vec2(0.7, 0.7)) * 120.0 + b.z * 9.0, S.z * 8.0)));
        albedo *= 1.0 - 0.3 * streak * (1.0 - n.z);
        albedo = mix(albedo, mossColour, smoothstep(0.3, 0.0, hf) * smoothstep(0.0, 0.3, K_moss) * 0.8);
        albedo = mix(albedo, snowWhite, winter * smoothstep(0.55, 0.8, n.z) * smoothstep(0.15, 0.4, hf));
        ao = 0.75 + 0.25 * hf;
      } else {
        // Moss: a velvet cushion, its tufts catching the light, darker at its rim.
        float r = distance(S.xy, isl.c) / max(isl.clear * (GARDEN_MOSS.y + GARDEN_MOSS.z * K_moss), 1e-3);
        vec2 tuft = vec2(vnoise(S.xy * 260.0), vnoise(S.xy * 260.0 + 9.7)) - 0.5;
        n = normalize(n + vec3(tuft * 0.5, 0.0));
        albedo = mossColour * (1.0 - 0.35 * smoothstep(0.6, 1.0, r));
        albedo = mix(albedo, snowWhite, winter * (0.75 + 0.2 * vnoise(S.xy * 120.0)));
        sheen = 0.15;
      }
    } else if (above && (S.y > GARDEN_WALL_Y || S.x < -0.03 || S.x > GARDEN_ASPECT + 0.03)) {
      // From above, the walls round the garden are their tiled caps: rolls of grey tile running
      // across the wall, snow along them in winter.
      float across = S.y > GARDEN_WALL_Y ? S.x : S.y;
      float roll = sin(fract(across / 0.028) * TAU);
      n = S.y > GARDEN_WALL_Y ? normalize(vec3(0.55 * roll, 0.0, 0.8)) : normalize(vec3(0.0, 0.55 * roll, 0.8));
      albedo = mix(vec3(0.17, 0.17, 0.18), snowWhite, winter * 0.85);
      ao = 0.8;
    } else if (S.y < GARDEN_DRIP || S.y > 1.0) {
      // The drip line along the veranda and the gutter at the wall's foot: dark river pebbles,
      // a granite curb along the gravel's edge.
      float tone;
      vec4 pebble = gardenPebbles(S.xy, tone);
      n = pebble.xyz;
      albedo = mix(vec3(0.03), mix(vec3(0.1, 0.11, 0.12), vec3(0.24, 0.22, 0.2), tone), pebble.w);
      albedo = mix(albedo, snowWhite, winter * smoothstep(0.5, 0.9, n.z) * pebble.w);
      float curb = S.y < GARDEN_DRIP ? smoothstep(GARDEN_DRIP - 0.007, GARDEN_DRIP - 0.0055, S.y) : smoothstep(1.006, 1.0045, S.y);
      albedo = mix(albedo, mix(vec3(0.5, 0.49, 0.46), snowWhite, winter), curb);
      n = normalize(mix(n, vec3(0.0, 0.0, 1.0), curb));
      sheen = 0.2 * (1.0 - curb);
    } else {
      // Raked gravel. The normal from the height field, over at least the cell's footprint, so
      // grooves finer than the dither (far from the veranda) melt into an even texture.
      vec2 fuv = vec2(S.x / GARDEN_ASPECT, S.y);
      // Differences over ±1.2 footprints: a groove period of ~4 cells keeps a third of its contrast.
      vec2 e = max(GARDEN_TEXEL, 1.2 * foot * vec2(1.0 / GARDEN_ASPECT, 1.0));
      float h = texture(uSim0, fuv).r;
      float hx = (texture(uSim0, fuv + vec2(e.x, 0.0)).r - texture(uSim0, fuv - vec2(e.x, 0.0)).r) / (2.0 * e.x * GARDEN_ASPECT);
      float hy = (texture(uSim0, fuv + vec2(0.0, e.y)).r - texture(uSim0, fuv - vec2(0.0, e.y)).r) / (2.0 * e.y);
      float outside = max(-S.x, S.x - GARDEN_ASPECT);
      float relief = mix(1.3, 0.65, winter) * (1.0 - smoothstep(0.0, 0.05, outside));
      n = normalize(vec3(-hx * relief, -hy * relief, 1.0));
      ao = 1.0 - 0.3 * smoothstep(0.0, -0.003, h);
      // White gravel: a fine grain (where a grain is at least a cell), the odd dark pebble, a
      // broad mottle.
      float grainScale = 260.0;
      float grainSeen = 1.0 - smoothstep(0.4, 1.0, max(foot.x, foot.y) * grainScale);
      float speck = step(0.95, hash12(floor(S.xy * grainScale * 0.5)));
      albedo = vec3(0.8, 0.77, 0.7) * (1.0 + grainSeen * (0.1 * (vnoise(S.xy * grainScale) - 0.5) - 0.28 * speck) + 0.06 * (vnoise(S.xy * 18.0) - 0.5));
      // Freshly turned gravel is damp and darker, drying back over a minute or two.
      float age = clock - texture(uSim3, fuv).r;
      albedo *= 1.0 - 0.13 * exp(-max(age, 0.0) / 45.0) * uSimOn.w;
      // Snow lies on it, deepest in the grooves.
      albedo = mix(albedo, snowWhite, winter * (0.78 + 0.22 * smoothstep(0.0, -0.002, h)));
    }
    float lit = gardenStoneShade(S, L, hit) * gardenDapple(S, L, tm, t, gust) * leafShade;
    float ndl = max(dot(n, L), 0.0);
    col = albedo * (sun * ndl * lit + (fill * (0.55 + 0.45 * n.z) + glow * max(dot(n, glowDir), 0.0)) * ao);
    // Wet pebbles, slate and velvet give back a little of the bright sky.
    col += sheen * glow * pow(max(dot(reflect(rdn, n), glowDir), 0.0), 6.0);
    // Faces turned from the sun still get its light thrown back off the gravel.
    if (hit >= 0) col += albedo * vec3(0.8, 0.76, 0.68) * sun * L.z * 0.3 * (1.0 - n.z) * lit;
  }
  // By moonlight the eye loses colour: the garden reads silver-blue.
  col = mix(col, vec3(dot(col, LUMA)) * vec3(0.75, 0.88, 1.2), 0.6 * sky.night);

  // ---- the maple: limbs and twigs, then its foliage over them ----
  vec2 sp = vec2(uv.x * aspect, uv.y);
  float cellH = 1.0 / uRes.y;
  float bark = 0.0;
  float barkT = 1e9;
  float barkTop = 0.0;
  // Below the maple's lowest reach (most of the frame) these loops would find nothing.
  bool maple = uv.y > (above ? GARDEN_MAPLE_LOW.y : GARDEN_MAPLE_LOW.x);
  for (int k = 0; k < GARDEN_LIMB_COUNT && maple; k++) {
    vec4 a = GARDEN_LIMB_A[k];
    vec4 b = GARDEN_LIMB_B[k];
    vec3 sway = gardenSway(k, tm, t, gust);
    vec3 pa = gardenProject(a.xyz + 0.3 * sway, aspect, above);
    vec3 pb = gardenProject(b.xyz + sway, aspect, above);
    vec2 A = vec2(pa.x * aspect, pa.y);
    vec2 ab = vec2(pb.x * aspect, pb.y) - A;
    float h = clamp(dot(sp - A, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
    vec2 off = sp - A - ab * h;
    float w = max(mix(a.w * pa.z, b.w * pb.z, h), 1.1 * cellH);
    float cov = smoothstep(w + 0.8 * cellH, w - 0.8 * cellH, length(off));
    if (cov > bark) {
      bark = cov;
      barkT = distance(mix(a.xyz, b.xyz, h), ro);
      barkTop = dot(off, normalize(vec2(-ab.y, ab.x)) * sign(ab.x + 1e-6)) / w;
    }
  }
  float canopyCov = 0.0;
  float canopyT = 1e9;
  vec3 canopyCol = vec3(0.0);
  float spring = 1.0 - step(0.5, season);
  float summer = step(0.5, season) * (1.0 - step(1.5, season));
  for (int k = 0; k < GARDEN_CLUMP_COUNT && maple; k++) {
    vec4 c = GARDEN_CLUMPS[k];
    vec3 C = c.xyz + gardenSway(k, tm, t, gust);
    vec3 pr = gardenProject(C, aspect, above);
    float R = c.w * pr.z;
    vec2 q = (sp - vec2(pr.x * aspect, pr.y)) / R;
    float d2 = dot(q, q);
    if (d2 > 1.7) continue;
    float fk = float(k);
    float ct = distance(C, ro) - c.w * 0.7;
    // Twigs fanning out from the clump's heart: what winter leaves of it, seen through the
    // foliage otherwise.
    for (int j = 0; j < 6; j++) {
      float hj = hash12(vec2(fk * 7.0 + float(j), 3.3));
      float ang = TAU * (float(j) + 0.6 * hj) / 6.0;
      vec2 tip = vec2(cos(ang), sin(ang) * 0.8 - 0.25) * (0.75 + 0.35 * hj);
      vec2 off = q - tip * clamp(dot(q, tip) / dot(tip, tip), 0.0, 1.0);
      float w = max(0.035, 1.1 * cellH / R);
      float cov = smoothstep(w + 0.8 * cellH / R, w - 0.8 * cellH / R, length(off));
      if (cov > bark) {
        bark = cov;
        barkT = ct + c.w * 0.5;
        barkTop = dot(off, vec2(-tip.y, tip.x) * sign(tip.x + 1e-6)) / w;
      }
    }
    if (winter > 0.5) continue;
    // Foliage: a leafy mass with a ragged rim and gaps between its sprays (blossom is sparser);
    // its rim soft from above, where it hangs close to the eye.
    float soft = above ? 0.16 : 1.5 * cellH / R;
    float edge = 1.0 - sqrt(d2) + 0.3 * (vnoise(q * 2.6 + fk * 7.3) - 0.5) + 0.22 * (vnoise(q * 6.5 + fk * 3.1) - 0.5);
    float gaps = vnoise(q * 11.0 + fk * 5.7);
    float cover = smoothstep(0.05 - soft, 0.05 + soft, edge) * (1.0 - smoothstep(0.55, 0.75, gaps + 0.25 * spring - 0.15 * summer) * smoothstep(0.25, 0.0, -edge + 0.3));
    if (cover <= 0.0 || ct > canopyT) continue;
    // Shaded as a ball of leaves: lit on the sun's side, and glowing where the low sun shines
    // through it toward us.
    float nz = sqrt(max(1.0 - d2, 0.0));
    vec3 nv = above ? vec3(q, nz) : vec3(q.x, -nz, q.y);
    float sunSide = max(dot(normalize(nv), L), 0.0);
    float through = pow(max(dot(rdn, L), 0.0), 2.0) * (1.0 - 0.5 * nz);
    float sprays = vnoise(q * 9.0 + fk * 2.3);
    vec3 base;
    vec3 shine;
    if (spring > 0.5) {
      base = mix(vec3(0.86, 0.62, 0.7), vec3(0.98, 0.88, 0.9), sprays);
      shine = vec3(1.0, 0.85, 0.88);
    } else if (summer > 0.5) {
      base = mix(vec3(0.06, 0.18, 0.04), vec3(0.2, 0.4, 0.08), sprays);
      shine = vec3(0.45, 0.75, 0.15);
    } else {
      base = mix(vec3(0.45, 0.04, 0.03), vec3(0.82, 0.16, 0.05), sprays);
      base = mix(base, vec3(0.9, 0.42, 0.08), 0.35 * smoothstep(0.6, 0.9, sprays));
      shine = vec3(1.0, 0.42, 0.1);
    }
    canopyCol = base * (fill * 0.75 + glow * 0.4 + sun * sunSide * 0.7) + shine * sun * through * (0.18 + 0.32 * sprays);
    canopyCol = mix(canopyCol, vec3(dot(canopyCol, LUMA)) * vec3(0.75, 0.88, 1.2), 0.6 * sky.night);
    canopyCov = max(canopyCov, cover);
    canopyT = ct;
  }
  // Bark: near black, a rim of light along its top; in winter a line of snow lies there.
  vec3 barkCol = vec3(0.05, 0.035, 0.03) * (1.0 + 2.0 * (fill + glow * 0.5)) + vec3(0.06, 0.05, 0.04) * sun * L.z;
  barkCol = mix(barkCol, snowWhite * (fill * 1.2 + sun * 0.4 + 0.05), winter * smoothstep(0.1, 0.6, barkTop));

  // Composite back to front: what the ray met, the leaf (if it is behind the foliage), the limbs
  // and the foliage, then the leaf (if it is in front).
  bool leafFront = leafCov > 0.0 && leafT < depth + 0.02;
  bool canopyFront = canopyT < depth;
  bool barkFront = barkT < depth;
  if (leafFront && leafT > min(canopyFront ? canopyT : 1e9, barkFront ? barkT : 1e9)) col = mix(col, leafCol, leafCov);
  if (barkFront) col = mix(col, barkCol, bark);
  if (canopyFront) col = mix(col, canopyCol, canopyCov);
  if (leafFront && leafT <= min(canopyFront ? canopyT : 1e9, barkFront ? barkT : 1e9)) col = mix(col, leafCol, leafCov);
  float leafSeen = leafFront ? leafCov : 0.0;

  // ---- the veranda's edge along the bottom: polished dark boards, their nosing catching the sky ----
  float board = 0.0;
  if (!above) {
    float top = 0.042;
    board = smoothstep(top + cellH, top - cellH, uv.y);
    if (board > 0.0) {
      float grain = vnoise(vec2(uv.x * aspect * 3.0, uv.y * 160.0)) * 0.6 + vnoise(vec2(uv.x * aspect * 11.0, uv.y * 420.0)) * 0.4;
      vec3 wood = vec3(0.13, 0.075, 0.045) * (0.8 + 0.4 * grain);
      // The garden glimmers in the polish; the rounded nosing is a line of light.
      float polish = smoothstep(0.0, top, uv.y) * 0.35;
      vec3 boards = wood * (fill * 1.4 + glow * 0.6 + 0.04) + polish * (fill * 0.6 + glow * 0.8) * 0.5;
      float nosing = exp(-pow((uv.y - (top - 2.0 * cellH)) / (1.5 * cellH), 2.0));
      boards += nosing * (fill * 0.8 + glow * 0.9 + sun * L.z * 0.3) * 0.6;
      col = mix(col, boards, board);
      leafSeen *= 1.0 - board;
    }
  }

  // Falling snow, the weather layer's, over everything.
  if (K_snow > 0.0) {
    float flakes = snowFlakes(uv, aspect, t, K_snow, K_wind);
    col = mix(col, snowWhite * (fill * 1.3 + glow * 0.6 + sun * 0.25 + 0.04), flakes * 0.9);
  }

  col = clamp(col, 0.0, 1.0);
  float lum = dot(col, LUMA);
  // Daylight on white gravel puts the page in its paper theme (index.ts): there ink is dark.
  o.ink = paper ? clamp((0.9 - lum) / 0.8, 0.0, 1.0) : clamp(pow(lum, 0.85) * 1.15, 0.0, 1.0);
  // The accent: the maple's leaves, its foliage a little, and the slate M.
  o.accent = clamp(max(max(leafSeen, 0.45 * canopyCov * (canopyFront ? 1.0 : 0.0) * (1.0 - board)), slate * (1.0 - board)), 0.0, 1.0);
  o.rgb = col;
  o.source = col;
  return o;
}
`;
