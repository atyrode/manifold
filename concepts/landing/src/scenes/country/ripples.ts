// Wind ripples on the river (`ripples`, with K_wind): the shared water's ripples tier
// (shaders/lib/water.ts, WATER_TIER: WATER_TIERS.ripples, compiled in only while the knob is up).
// The breeze's cat's-paws (windRipples, shaders/windWater.ts) drift downwind over the river, the
// streams and the bay; this far off most of their ripples are finer than a cell, so they only
// roughen the mirror (their slope variance jitters the reflected ray cell by cell, smearing the sky
// it shows into streaks down the view), and where a cell is small enough the longer trains tilt it
// themselves. The paws glitter in the dither (the water branch's shimmer). Zero leaves the river's
// own gentle shimmer of the sky.
export const countryRipplesGlsl = /* glsl */ `
#if WATER_TIER >= WATER_RIPPLES
// ---- wind ripples on the river (ripples.ts) ----
// The breeze on the water at p (map metres) seen along rd, foot metres a cell spans across there:
// xy the tilt it adds to the water's normal (world x, z; the water branch's convention), z the
// cat's-paws' cover 0..1. windRipples works in the camera's frame (x right, the wind's convention;
// y ahead, foreshortened by the view's slant).
vec3 countryRipples(vec3 p, vec3 rd, float foot) {
  if (K_ripples <= 0.0) return vec3(0.0);
  Ground g = Ground(vec2(dot(p.xz, countryRight.xz), dot(p.xz, countryFwd.xz)), vec2(foot, foot / max(-rd.y, 0.02)));
  vec4 r = windRipples(g, uMotionTime, K_wind, K_ripples);
  // The ripples too fine to draw: a slope along the view jittered per cell by their spread.
  vec2 slope = r.xy + vec2(0.0, (cellTh - 0.5) * 2.0 * sqrt(r.z));
  return vec3(-(countryRight.xz * slope.x + countryFwd.xz * slope.y), r.w);
}
#endif
`;
