// The starry scene: Van Gogh's sky advected along its brushstrokes, its stars pulsing.
import { paintingsGlsl } from "../../shaders/paintings.ts";

export const starryGlsl = `${paintingsGlsl}
// Light rings travelling outward through every star's halo.
float starryPulse(vec2 b, float t) {
  float aspect = uImageSize.x / uImageSize.y;
  float ring = 0.0;
  for (int i = 0; i < MAX_STARS; i++) {
    if (i >= uStarCount) break;
    vec4 star = uStars[i];
    float d = length((b - star.xy) * vec2(aspect, 1.0)) / star.z;
    float halo = smoothfall(1.9, 0.9, d) * smoothstep(0.15, 0.5, d);
    ring += halo * sin(d * 8.0 - t * 2.2 + float(i) * 1.7);
  }
  return ring;
}

Shade sceneStarry(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float aspect = uImageSize.x / uImageSize.y;
  vec2 base = coverUV(uv, 1.03, uPointer * 0.006 * m);
  // The cypress flickers like a flame about its root.
  float w = bell((base.x - 0.28) / 0.13) * smoothstep(0.05, 0.95, base.y);
  base = rotateAbout(base, vec2(0.28, 0.0), (0.012 * sin(t * 0.8) + 0.006 * sin(t * 2.1 + 1.3)) * w * m * K_sway * 2.0);
  if (K_stir > 0.5) {
    // Stir: the paint twists around the pointer like a spoon drawn through it.
    vec2 centre = coverUV(uPointer * 0.5 + 0.5, 1.03, vec2(0.0));
    vec2 d = (base - centre) * vec2(aspect, 1.0);
    float twist = 1.1 * exp(-dot(d, d) / 0.012) * (0.75 + 0.25 * sin(t * 0.9));
    base = centre + rotate(d, twist) / vec2(aspect, 1.0);
  }
  vec3 s = paintingFlow(base, t, 4.0, 0.08 * m * K_swirl).rgb;
  float pulse = 1.0 + 0.64 * K_pulse * starryPulse(base, t) * m;
  float lum = dot(s, LUMA) * pulse;
  float yellow = smoothstep(0.02, 0.16, (s.r + s.g) * 0.5 - s.b) * smoothstep(0.3, 0.65, lum);
  if (K_windows > 0.0) {
    // Village windows switch on and off one by one.
    float village = step(base.y, 0.36) * step(0.42, base.x);
    vec2 window = floor(base * vec2(150.0, 120.0));
    float lit = step(0.4, hash12(window + floor(uMotionTime * K_windows * 1.5 + hash12(window) * 9.0)));
    yellow *= mix(1.0, lit, village);
  }

  Shade o = blankShade();
  o.accent = yellow * (0.85 + 0.15 * pulse);
  // Stretch the painting's mid-blue range so the swirls separate from the night sky.
  o.ink = pow(smoothstep(0.24, 0.72, lum), 1.4) * 0.9 * (1.0 - yellow * 0.7);
  o.shimmer = yellow * 0.12;
  o.rgb = s * 0.92 * pulse;
  o.source = s;
  if (K_mstars > 0.5) {
    // Five haloed stars at the M's corners, joined by a faint painted stroke.
    vec2 centre = vec2(0.5, 0.84);
    float size = 0.15;
    vec2 local = (base - centre) * vec2(aspect, 1.0) / size;
    for (int i = 0; i < 5; i++) {
      float d = length(local - markVertex(i)) * size / 0.017;
      float core = smoothfall(1.0, 0.4, d);
      float halo = smoothfall(3.4, 1.2, d) * smoothstep(0.6, 1.1, d) * (0.55 + 0.45 * sin(d * 3.0 - uMotionTime * 2.2 + float(i)));
      o.accent = max(o.accent, core);
      o.ink = max(o.ink * (1.0 - core), halo * 0.8);
    }
    float stroke = smoothfall(0.045, 0.015, markDistance(local)) * (0.6 + 0.4 * vnoise(local * 30.0 + uMotionTime));
    o.accent = max(o.accent, stroke * 0.55);
  }
  return o;
}
`;
