// The plant component's GLSL (sims/plants.ts simulates the plants): reading the organ records a
// PlantTexture packs, the organs' shared shapes and the year's colour. Opt-in: a scene that draws
// plants per fragment puts `${plantsGlsl}` in its own GLSL, before the functions that call it. The
// scene decides where its plants stand in the picture (its projection, what hides them), their
// palette and light; the component decides where every organ is, how it bends and what the year and
// its age have done to it.
//
//   PLANT_DETAIL                   compile-time tier (SceneDef.features), default 2: 2 draws the shapes'
//                                  fine detail (a frond's leaflets), fading it below two cells of
//                                  `foot`; 1 draws silhouettes only (leaflets at their mean width).
//   struct PlantOrgan { at, dir, len, width, bend, a, b, pheno, form, variant, side, tier };
//   PlantOrgan plantOrgan(sampler2D organs, int rowBase, int r)
//                                  record r (sims/plants.ts header); tier 0: nothing to draw. An
//                                  upright organ's dir is its lean (radians toward x and y).
//   vec2 plantLocal(vec2 p, PlantOrgan o)
//                                  p in the organ's frame: x along its base direction from its base,
//                                  y to its left, mirrored where side < 0
//   float plantArc(vec2 l, float len, float turn, out float s)
//                                  an organ turning `turn` radians over its length, l in its frame:
//                                  s how far along (0 base .. 1 tip; outside: past the ends), returns
//                                  the distance to the left of its spine (l's units)
//   vec2 plantPoint(PlantOrgan o, float turn, float s)
//                                  where the spine of an organ turning `turn` radians over its length
//                                  (in the scene's frame: its curl + o.bend if flexible, 0 if rigid)
//                                  lies a share s along, in scene units (RootedPlants.pointAt): a
//                                  swaying stem's tip, a point to hang things from
//   float plantFrond(vec2 rel, float side, float len, float lift, float droop, float bend, float foot,
//                    out float u, out float under)
//                                  a fern frond from its root (rel = point - root, y up): the spine a
//                                  parabola rising by lift and drooping by droop (frond lengths), bent
//                                  by bend toward the tip; leaflets comb along it. Coverage 0..1; u how
//                                  far along, under how far below the spine (negative above).
//                                  foot = a cell in rel's units (0: full detail).
//   float plantKeep(float period, float foot)
//                                  how much of a detail repeating every `period` units to draw where a
//                                  cell spans `foot`: exactly 1 from two cells a period, 0 at one
//   vec3 plantPhenology(vec3 green, float pheno)
//                                  a leaf's colour for its phenology: young pale, green, gold, brown;
//                                  green itself, untouched, at pheno 0
export const plantsGlsl = /* glsl */ `
// ---- plants (sims/plants.ts, shaders/lib/plants.ts) ----
#ifndef PLANT_DETAIL
#define PLANT_DETAIL 2
#endif

struct PlantOrgan {
  vec2 at;
  vec2 dir;
  float len;
  float width;
  float bend;
  float a;
  float b;
  float pheno;
  float form;
  float variant;
  float side;
  float tier;
};

PlantOrgan plantOrgan(sampler2D organs, int rowBase, int r) {
  int w = textureSize(organs, 0).x;
  ivec2 c = ivec2(r % w, rowBase + 4 * (r / w));
  vec4 t0 = texelFetch(organs, c, 0);
  vec4 t1 = texelFetch(organs, c + ivec2(0, 1), 0);
  vec4 t2 = texelFetch(organs, c + ivec2(0, 2), 0);
  vec4 t3 = texelFetch(organs, c + ivec2(0, 3), 0);
  return PlantOrgan(vec2(t0.x + t0.y, t0.z + t0.w), t1.xy, t1.z, t1.w, t2.x, t2.y, t2.z, t2.w, t3.x, t3.y, t3.z, t3.w);
}

vec2 plantLocal(vec2 p, PlantOrgan o) {
  vec2 d = p - o.at;
  return vec2(dot(d, o.dir), o.side * (o.dir.x * d.y - o.dir.y * d.x));
}

float plantArc(vec2 l, float len, float turn, out float s) {
  if (abs(turn) < 1e-3) {
    s = l.x / len;
    return l.y - 0.5 * turn * l.x * l.x / len;
  }
  float r = len / turn;
  vec2 v = l - vec2(0.0, r);
  vec2 w = v / r;
  s = atan(w.x, -w.y) / turn;
  return r - sign(r) * length(v);
}

vec2 plantPoint(PlantOrgan o, float turn, float s) {
  // The chord from the base: s len sinc(h) long, turned h = turn s / 2 from the base direction, so
  // nothing cancels however little it bends.
  float h = 0.5 * turn * s;
  float chord = o.len * s * (abs(h) < 1e-4 ? 1.0 : sin(h) / h);
  float c = cos(h);
  float n = sin(h);
  return o.at + chord * vec2(o.dir.x * c - o.dir.y * n, o.dir.x * n + o.dir.y * c);
}

float plantKeep(float period, float foot) {
  return foot <= 0.0 ? 1.0 : clamp(period / foot - 1.0, 0.0, 1.0);
}

float plantFrond(vec2 rel, float side, float len, float lift, float droop, float bend, float foot, out float u, out float under) {
  u = rel.x * side / len;
  under = -1.0;
  if (u < 0.0 || u > 1.0) return 0.0;
  float spine = len * (lift * u - (droop - bend) * u * u);
  under = spine - rel.y;
  float slope = lift - 2.0 * (droop - bend) * u;
  float dist = abs(under) / sqrt(1.0 + slope * slope);
  // Leaflets: a comb of period len * pi / 23 along the frond, its mean 0.3 + 0.7 * 2 / pi.
#if PLANT_DETAIL >= 2
  float comb = 0.3 + 0.7 * abs(sin(u * 23.0));
  float keep = plantKeep(len * 0.1366, foot);
  if (keep < 1.0) comb = mix(0.7456, comb, keep);
#else
  float comb = 0.7456;
#endif
  float width = len * 0.17 * (1.0 - u) * comb + 0.0011;
  return smoothfall(width, width * 0.5, dist);
}

vec3 plantPhenology(vec3 green, float pheno) {
  if (pheno == 0.0) return green;
  float l = dot(green, LUMA);
  if (pheno < 0.0) return mix(green, vec3(0.6, 0.8, 0.32) * (0.5 + 1.1 * l), -0.6 * pheno);
  vec3 gold = vec3(0.86, 0.62, 0.16) * (0.5 + 1.1 * l);
  vec3 brown = vec3(0.42, 0.25, 0.11) * (0.5 + 1.1 * l);
  return pheno < 0.6 ? mix(green, gold, pheno / 0.6) : mix(gold, brown, (pheno - 0.6) / 0.4);
}
`;
