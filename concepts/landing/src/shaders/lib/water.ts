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
//                               (waterMirror), and the sun's or moon's glitter on it (waterGlitter)
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

// The sun's or moon's glitter on the water, after Cox & Munk's 1954 sea-slope measurements: the
// share of the surface's facets tilted to mirror light (toward the sun or moon, y up; none once it
// is down) into view (toward the eye), about the drawn normal n, their slopes spread with variance
// s2. s2 is the roughness the cells do not draw: rippleSpectrum's z (the trains too fine for them)
// plus the scene's own floor for ripples finer still, so the path widens with the wind and toward
// the horizon, where trains fade into it. A Beckmann distribution of the half vector, normalised to
// 1 at the heart of the path: a rougher surface draws a wider path rather than a dimmer one, and the
// path never burns out into a solid block. Its half width at half height, in the tangent of the
// half vector's tilt, is sqrt(s2 ln 2); its area over that tangent plane is pi s2.
float waterGlitter(vec3 n, vec3 view, vec3 light, float s2) {
  if (light.y <= 0.0) return 0.0;
  vec3 h = normalize(view + light);
  float c = max(dot(n, h), 1e-3);
  float tan2 = (1.0 - c * c) / (c * c);
  return exp(-tan2 / s2);
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
