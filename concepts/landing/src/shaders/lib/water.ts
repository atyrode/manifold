// A water surface in tiers, cheapest first, composed from the shared water parts rather than written
// again: a scene selects the highest tier it draws (`features: { WATER_TIER: WATER_TIERS.mirror }`
// in its SceneDef), and its program gets that tier and every one below it. A tier it did not select
// is not in its program, so calling one of its functions fails to compile, never silently. Compiled
// into every scene program after surface.ts; nothing here exists without WATER_TIER. The contract
// and the tier each scene selects are in src/scenes/README.md ("Water").
//
//   flat      WATER_FLAT 0      the scene's own tint (and, if it likes, its sky mirrored flat): no surface
//   ripples   WATER_RIPPLES 1   wind ripples: rippleSpectrum (surface.ts, a scene's own trains) and the
//                               breeze's cat's-paws with their screen-space mirror (windWater.ts)
//   mirror    WATER_MIRROR 2    reflections: the rippled normal, the reflected ray and Fresnel
//                               (waterMirror), the glitter of a light on it (waterGlint) and the
//                               single facets that flash in it (waterFacets)
//   flow      WATER_FLOW 3      currents: a pattern carried by a steady current (waterDrift)
//   caustics  WATER_CAUSTICS 4  the bed lit through the surface: causticRipples' net (caustics.ts) times
//                               a simulated surface's focus (ShallowWater.surface, sims/shallow.ts);
//                               or the stylised cellular net (causticCells) for water with no spectrum
//
// Projected size: every tier fades its detail to the area mean once a cell outgrows it and then stops
// working it out (rippleTrain, causticRipples and causticCells skip their trains and seams), so far
// or small water costs little more than the flat tier whatever tier the scene selects, and resolved
// water is bit for bit the full-detail picture.
import { causticsGlsl } from "../caustics.ts";
import { windWaterGlsl } from "../windWater.ts";

/** The water tiers, cheapest first; a tier includes every one below it (SceneDef.features WATER_TIER). */
export const WATER_TIERS = { flat: 0, ripples: 1, mirror: 2, flow: 3, caustics: 4 } as const;

const tierDefines = Object.entries(WATER_TIERS)
  .map(([name, value]) => `#define WATER_${name.toUpperCase()} ${value}`)
  .join("\n");

export const waterGlsl = `
// ---- water (shaders/lib/water.ts) ----
#ifdef WATER_TIER
${tierDefines}

#if WATER_TIER >= WATER_RIPPLES
${windWaterGlsl}
#endif

#if WATER_TIER >= WATER_MIRROR
// The water as a mirror seen along dir (a view ray, y up) where its slope is (dh/dx, dh/dz): the
// rippled normal, the reflected ray (it may dip below the horizon: lift or clamp it as the scene's
// sky needs) and water's Fresnel reflectance toward the eye, its cosine floored by minCos as in
// fresnelSchlick (a rough surface never turns into the full grazing mirror).
struct WaterMirror {
  vec3 normal;
  vec3 ray;
  float fresnel;
};

WaterMirror waterMirror(vec3 dir, vec2 slope, float minCos) {
  WaterMirror m;
  m.normal = normalize(vec3(-slope.x, 1.0, -slope.y));
  m.ray = reflect(dir, m.normal);
  m.fresnel = fresnelSchlick(dot(m.normal, -dir), 0.02, minCos);
  return m;
}

// The share of a rough water surface's facets (slope variance s2) that a direction at cosine c to
// its normal sees, or lights, unhidden by the others: Smith's masking for a Beckmann surface, in the
// fit of Walter, Marschner, Li & Torrance (2007). 1 face on, falling off at grazing, 0 behind.
float waterMasking(float c, float s2) {
  if (c <= 0.0) return 0.0;
  float a = c / sqrt(s2 * max(1.0 - c * c, 1e-6));
  return a < 1.6 ? (3.535 * a + 2.181 * a * a) / (1.0 + 2.276 * a + 2.577 * a * a) : 1.0;
}

// The glitter of a light (the sun, the moon, a lamp) on the water: toward the eye (view) from the
// light (toward it, y up; none once it is down), about the drawn normal n, the facets' slopes spread
// with variance s2. s2 is the roughness the cells do not draw: rippleSpectrum's z (the trains too
// fine for them) plus the scene's own floor for ripples finer still, so the path widens with the
// wind and toward the horizon, where trains fade into it. Its radiance against the light's is Cox &
// Munk's (1954), F(v.h) P(h) G / (4 (n.v) (n.h)^4): P the facets' slope density (a Gaussian
// holding 1 over the half vector's tangent plane, so a rougher sea lays a wider and dimmer path),
// F the Fresnel reflectance on a facet, G Smith's share of it neither hidden from the eye nor
// shaded from the light. So a low light lays a long blazing path that brightens toward the
// horizon, a high one a short faint one. exposure is the light's radiance times the solid angle it
// fills, in the scene's units of brightness; for a lamp, its intensity over the squared distance
// to the water, so its path fades away from it. Returns 1 - exp(-exposure * radiance): 0..1 of the
// light's colour, filling in where the facets crowd to mirror it, so a brighter light widens the
// path's solid core rather than burning through the dither, as glitter photographs.
float waterGlint(vec3 n, vec3 view, vec3 light, float s2, float exposure) {
  float nv = dot(n, view);
  float nl = dot(n, light);
  if (light.y <= 0.0 || nv <= 0.0 || nl <= 0.0) return 0.0;
  vec3 h = normalize(view + light);
  float c2 = max(dot(n, h), 1e-3);
  c2 *= c2;
  float density = exp((c2 - 1.0) / (c2 * s2)) / (0.5 * TAU * s2);
  float shown = waterMasking(nv, s2) * waterMasking(nl, s2);
  float radiance = fresnelSchlick(dot(view, h), 0.02, 0.0) * density * shown / (4.0 * nv * c2 * c2);
  return 1.0 - exp(-exposure * radiance);
}

// Glints in the glitter: single wave facets catching the light for a moment, to multiply a path's
// exposure by (1 + flicker x this). They live on a grid fixed to the water, gp = (x / z, eye / z)
// scaled to cells, so each grid cell is 9 x 4 dither cells wherever it lies and a glint is never
// thinner than two; each one swells and fades over a second or two, never from one frame to the
// next. tm: the motion clock (uMotionTime). Returns 0..1.
float waterFacets(vec2 gp, float tm) {
  vec2 g = gp / vec2(9.0, 4.0);
  vec2 id = floor(g);
  float h = hash12(id + 0.37);
  float age = tm / (0.9 + 0.9 * h) + fract(h * 7.31);
  float turn = floor(age);
  vec2 seed = id + turn * vec2(0.73, 1.37); // a fresh place and chance for each glint
  if (hash12(seed + 5.3) > 0.55) return 0.0;
  vec2 at = 0.3 + 0.4 * vec2(hash12(seed + 1.1), hash12(seed + 2.9));
  vec2 r = (fract(g) - at) * vec2(9.0 / 2.6, 4.0 / 1.2); // in glint radii: 2.6 x 1.2 cells
  float swell = sin(3.14159265 * (age - turn));
  return swell * swell * (1.0 - smoothstep(0.35, 1.0, dot(r, r)));
}
#endif

#if WATER_TIER >= WATER_FLOW
// Where to evaluate a surface pattern (ripples, cat's-paws, lace) at p so that a steady current
// (the water's velocity, the pattern's units per second of tm) has carried it there by tm.
vec2 waterDrift(vec2 p, vec2 current, float tm) {
  return p - current * tm;
}
#endif

#if WATER_TIER >= WATER_CAUSTICS
${causticsGlsl}
// The light on a bed depth below the surface (p's units) relative to still water: the ripples' net
// (causticRipples' hessian) times a simulated surface's own focus (ShallowWater.surface's w; 1
// without a sim), capped at 1 / soft (0.1..0.4: smaller is sharper and flickers sooner).
float waterCaustic(vec3 hessian, float depth, float focus, float soft) {
  return 1.0 / max(abs(focus * causticJacobian(hessian, 0.25 * depth)), soft);
}
#endif
#endif
`;
