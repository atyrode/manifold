// The ground's code (src/engine/glsl.ts, the kind contract): the heightfield marched along the ray
// with detail by distance (height.ts), refined by halving, its normal from the height's slopes; its
// shadow a soft march toward the light over the same land; its surface the material's colour
// mottled over a few metres and tens of centimetres, stone showing on steep slopes.
import { glslFloat, glslVec3 } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { groundShape, groundShapeGlsl } from "./height.ts";
import { GROUND_MATERIALS, GROUND_TRUST } from "./index.ts";

/** Each material's albedo (the outdoor composer's floors'). */
const ALBEDO: Readonly<
  Record<(typeof GROUND_MATERIALS)[number], readonly [number, number, number]>
> = {
  grass: [0.26, 0.44, 0.16],
  earth: [0.32, 0.25, 0.17],
  sand: [0.76, 0.66, 0.47],
  snow: [0.88, 0.9, 0.95],
  stone: [0.42, 0.41, 0.39],
};

const STONE = GROUND_MATERIALS.indexOf("stone");
const SNOW = GROUND_MATERIALS.indexOf("snow");
/** How much the tone mottles (the outdoor composer's floors' 0.5, a touch less). */
const MOTTLE = 0.45;

export const glsl: KindCode["glsl"] = () => `${groundShapeGlsl}
// The shape at the ground's origin, taken off so that the origin lies on the land.
const float GROUND_LEVEL = ${glslFloat(groundShape(0, 0))};
const float GROUND_TRUST = ${glslFloat(GROUND_TRUST)};
const int GROUND_STEPS = 160;

// The land's height over the ground's origin at plan point x (its frame, metres), with no detail
// finer than foot metres: the kind contract's <id>Land, which engineLand reads for every kind.
float groundLand(EngineObj o, vec2 x, float foot) {
  float spread = groundSpread(o);
  return groundRelief(o) * (groundShape(x / spread, foot / spread) - GROUND_LEVEL);
}

// How far a step may go per metre the ray stands over the land: the slope it trusts, and the ray's
// own fall.
float groundLean(EngineObj o, vec3 rd) {
  return max(GROUND_TRUST * GROUND_SLOPE * groundRelief(o) / groundSpread(o) + max(-rd.y, 0.0), 1e-3);
}

float groundHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  n = vec3(0.0, 1.0, 0.0);
  part = 0.0;
  float lean = groundLean(o, rd);
  float t = span.x;
  float before = t;
  float d = ro.y + rd.y * t - groundLand(o, ro.xz + rd.xz * t, t * engineCell);
  // An eye under the land sees none of it.
  if (d < 0.0) return -1.0;
  for (int i = 0; i < GROUND_STEPS; i++) {
    if (d < 0.0 || t >= span.y) break;
    before = t;
    t = min(span.y, t + max(d / lean, 0.01 + t * 0.008));
    d = ro.y + rd.y * t - groundLand(o, ro.xz + rd.xz * t, t * engineCell);
  }
  // Out of its bounds without meeting it; a ray still skimming it once the steps run out meets it
  // there, at the far edge of what it can draw.
  if (d >= 0.0 && t >= span.y) return -1.0;
  if (d < 0.0) {
    float after = t;
    for (int i = 0; i < 6; i++) {
      float mid = 0.5 * (before + after);
      if (ro.y + rd.y * mid - groundLand(o, ro.xz + rd.xz * mid, mid * engineCell) >= 0.0) before = mid;
      else after = mid;
    }
    t = before;
  }
  vec2 x = ro.xz + rd.xz * t;
  float foot = t * engineCell;
  float e = max(0.04, foot);
  n = normalize(vec3(
    groundLand(o, x - vec2(e, 0.0), foot) - groundLand(o, x + vec2(e, 0.0), foot),
    2.0 * e,
    groundLand(o, x - vec2(0.0, e), foot) - groundLand(o, x + vec2(0.0, e), foot)));
  part = t;
  return t;
}

// The land between a point and a light, soft-edged: the nearest the ray comes to it over how far it
// has gone. No finer than the surface it starts from (engineFoot).
float groundShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  if (groundRelief(o) <= 0.0) return 1.0;
  float lean = groundLean(o, rd);
  float lit = 1.0;
  float t = span.x + 0.05 + engineFoot;
  for (int i = 0; i < 40; i++) {
    if (t >= span.y || lit <= 0.0) break;
    float d = ro.y + rd.y * t - groundLand(o, ro.xz + rd.xz * t, engineFoot);
    lit = min(lit, 10.0 * d / t);
    t += max(0.8 * d / lean, 0.05 + 0.03 * t);
  }
  return clamp(lit, 0.0, 1.0);
}

void groundSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = part * engineCell;
  int m = int(groundMaterial(o) + 0.5);
${GROUND_MATERIALS.map(
  (name, k) =>
    `  ${k === 0 ? "vec3 albedo = " : "if (m == " + k + ") albedo = "}${glslVec3(ALBEDO[name])};`,
).join("\n")}
  float tone = fbmLod(p.xz * 0.3 + 17.0, foot * 0.3, 2).x + 0.6 * (fbmLod(p.xz * 2.7, foot * 2.7, 2).x - 0.5);
  albedo *= 1.0 + ${glslFloat(MOTTLE)} * (tone - 0.5) * 1.6;
  float rock = m == ${STONE} || m == ${SNOW} ? 0.0 : smoothstep(0.84, 0.7, n.y);
  h.albedo = mix(albedo, ${glslVec3(ALBEDO.stone)}, rock);
  h.rough = 1.0;
  h.mat = m;
}
`;
