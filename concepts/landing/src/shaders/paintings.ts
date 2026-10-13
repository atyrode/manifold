// What the painting scenes (wave, starry) share: flow-map advection along the brushstroke field.
// Each scene's `glsl` starts with this module and adds its own entry and helpers, so each reads
// only its own K_<key> knob defines.

export const paintingsGlsl = `
// Two-phase flow-map advection: paint slides along uFlow and cross-fades back to its origin
// before it can smear. A low-frequency phase offset hides the synchronous reset.
vec4 paintingFlow(vec2 uv, float t, float cycle, float len) {
  vec2 f = texture(uFlow, uv).rg * len;
  float p0 = fract(t / cycle + vnoise(uv * 5.0));
  float p1 = fract(p0 + 0.5);
  vec2 a = uv - f * (p0 - 0.5);
  vec2 b = uv - f * (p1 - 0.5);
  float w = abs(1.0 - 2.0 * p0);
  // Mip selection from the undisplaced uv: displacement must not blur the paint.
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  vec3 col = mix(textureGrad(uImage, a, gx, gy).rgb, textureGrad(uImage, b, gx, gy).rgb, w);
  float back = mix(textureGrad(uBackdrop, a, gx, gy).r, textureGrad(uBackdrop, b, gx, gy).r, w);
  return vec4(col, back);
}
`;
