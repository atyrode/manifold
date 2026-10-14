// Wind on open water, for scenes that draw a lake, fjord, river or sea as a mirror under the side-on
// camera (surface.ts's Ground). Include `windWaterGlsl` once in the scene's glsl; it uses `Ground`,
// `rippleTrain` (shaders/lib/surface.ts) and `vnoise` (common), so it goes after them.
//
//   vec4 windRipples(Ground g, float tm, float wind, float amount)
//     Where the breeze touches the water (cat's-paws: patches tens of metres across that drift
//     downwind and change slowly), four trains of ripples run with it, spread about its heading.
//     g: the cell's Ground (metres); tm: uMotionTime; wind: the K_wind convention (-1..1, + blowing
//     to the right); amount 0..1: how much of the breeze reaches the water (0: none, a mirror).
//     xy: the slope (dh/dx, dh/dz) of the ripples this cell can draw; z: the slope variance of the
//     ones too fine to draw (rippleTrain's LEAN split), which roughens the mirror; w: the cat's-paw
//     cover 0..1.
//   vec2 windMirror(vec4 ripples, float below, float focal)
//     How far a screen-space mirror lookup moves under that slope (screen heights: x across, y up),
//     for a point `below` screen heights under the horizon and the camera's focal length in screen
//     heights. A slope along the depth tips the reflected ray up or down by twice itself, so
//     reflections stretch into vertical streaks; one across moves it sideways only a little at the
//     grazing angles a level camera sees water at.
//   float windMirrorSpread(vec4 ripples, float focal)
//     The vertical spread (screen heights, one standard deviation) the unresolved ripples smear a
//     reflection over: jitter the lookup by it per cell (the dither averages the samples) or blur.
//
// Usage (aurora's fjord):
//   Ground g = planeAt(uv, aspect, horizon, eye, focal);
//   vec4 rip = windRipples(g, uMotionTime, K_wind, K_ripples);
//   vec2 shift = windMirror(rip, horizon - uv.y, focal);
//   vec2 q = mirrored + shift + vec2(0.0, (cellTh - 0.5) * 2.0 * windMirrorSpread(rip, focal));

export const windWaterGlsl = `
// ---- wind on water (shaders/windWater.ts) ----

vec4 windRipples(Ground g, float tm, float wind, float amount) {
  if (amount <= 0.0) return vec4(0.0);
  float heading = wind < 0.0 ? -1.0 : 1.0;
  // A light air barely marks the water, a fresh breeze ruffles most of it.
  float breeze = amount * (0.25 + 0.75 * min(abs(wind) / 0.6, 1.0));
  vec2 drift = vec2(heading * tm * (0.4 + 2.0 * abs(wind)), tm * 0.15);
  float paws = vnoise((g.p - drift) * vec2(1.0 / 38.0, 1.0 / 24.0) + vec2(3.7, 1.1));
  float cover = smoothstep(0.66 - 0.5 * breeze, 0.86 - 0.35 * breeze, paws);
  float slope = breeze * cover;
  if (slope <= 0.0) return vec4(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float turn = (fi < 0.5 ? -0.5 : fi < 1.5 ? 0.35 : fi < 2.5 ? 1.1 : -1.25);
    vec2 along = vec2(heading * cos(turn), sin(turn));
    sum += rippleTrain(g.p, tm, g.foot, 5.0 * pow(0.53, fi), along, slope * (0.1 - 0.012 * fi), 0.5, fi * 2.3, vec2(7.0, 14.0));
  }
  return vec4(sum, cover);
}

vec2 windMirror(vec4 ripples, float below, float focal) {
  return vec2(-2.0 * ripples.x * below, 2.0 * focal * ripples.y);
}

float windMirrorSpread(vec4 ripples, float focal) {
  return 2.0 * focal * sqrt(ripples.z);
}
`;
