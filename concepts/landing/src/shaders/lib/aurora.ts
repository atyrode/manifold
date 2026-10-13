// Shared aurora: curtains of light over the night sky for a ground view. Compiled into every scene
// program after the lightning library; the contract and conventions are in src/scenes/README.md.

export const auroraGlsl = `
// ---- aurora ----

// One curtain: a vertical sheet hanging along an east-west arc dist ahead (units in which its lower
// edge is ~1 up and its top ~3.6). The arc bows away toward the sides (+0.06 x^2), so on screen it
// arches over the view like an auroral arc, and ripples in depth. The ray meets it where its reach
// across the ground equals the arc's; one fixed-point step solves for the bend and the ripples.
// Light: a bright, sharp lower edge; above it rays (vertical striations) that drift along the sheet
// and flicker slowly up and down it; lit stretches and dark gaps; more glow where the sheet folds
// edge-on to the viewer.
vec3 auroraCurtain(vec3 dir, float dist, float T, float salt) {
  float s = dist / dir.z;
  float x = dir.x * s;
  float ph1 = x * 0.35 + T * 0.05 + salt;
  float ph2 = x * 0.9 - T * 0.08 + salt * 2.3;
  float ph3 = x * 2.3 + T * 0.15 + salt * 4.1;
  s = (dist + 0.06 * x * x + 0.8 * sin(ph1) + 0.35 * sin(ph2) + 0.12 * sin(ph3)) / dir.z;
  x = dir.x * s;
  float slope = 0.28 * cos(ph1) + 0.315 * cos(ph2) + 0.276 * cos(ph3); // d(ripple)/dx
  float base = 0.7 + 0.6 * vnoise(vec2(x * 0.4 + T * 0.02, salt));      // ragged lower edge
  float hn = (dir.y * s - base) / 2.6;                                  // 0 lower edge .. 1 top
  if (hn < -0.05 || hn > 1.0) return vec3(0.0);
  // Rays are spaced by angle (x / dist), so far curtains keep the same on-screen stripe width
  // instead of aliasing into noise; stretched noise lets each ray brighten and fade along its height.
  float u = x / dist;
  float r = vnoise(vec2(u * 38.0 - T * 0.08, hn * 2.5 - T * 0.1 + salt)) * 0.6 + vnoise(vec2(u * 11.0 + T * 0.03, salt * 5.0)) * 0.4;
  float rays = smoothstep(0.38, 0.85, r);
  float stretch = smoothstep(0.3, 0.75, vnoise(vec2(u * 3.0 - T * 0.02, salt + 7.0)));
  float edge = smoothstep(-0.05, 0.01, hn);
  float lum = edge * (exp(-hn * 7.0) * (0.55 + 0.45 * rays) + 0.5 * rays * exp(-hn * 1.6)) * (1.0 - smoothstep(0.7, 1.0, hn))
            * stretch * (1.0 + 0.8 * min(abs(slope), 1.0));
  // Oxygen green (557.7 nm) low in the curtain, giving way to oxygen red (630 nm) and nitrogen
  // violet toward the top.
  return mix(vec3(0.25, 1.0, 0.55), vec3(0.78, 0.2, 0.58), smoothstep(0.2, 0.75, hn)) * lum;
}

// Aurora for a view ray, to add to the night sky: three curtains at increasing distance, so nearer
// ones hang higher and farther ones crowd toward the horizon, all rippling with t * uMotion. 0 below
// the horizon and behind the viewer; not faded by daylight (multiply by sky.night). strength 0..1.
vec3 aurora(vec3 dir, float t, float strength) {
  if (strength <= 0.0 || dir.y <= 0.0 || dir.z <= 0.05) return vec3(0.0);
  float T = t * uMotion;
  vec3 c = vec3(0.0);
  float dist = 3.5;
  float gain = 1.0;
  for (int i = 0; i < 3; i++) {
    c += auroraCurtain(dir, dist, T, float(i) * 2.7) * gain;
    dist *= 1.7;
    gain *= 0.75;
  }
  return c * strength * 0.7 * (0.8 + 0.2 * sin(T * 0.21)) * smoothstep(0.0, 0.06, dir.y);
}
`;
