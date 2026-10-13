// Entry point: call the scene's entry, dither its coverage into the palette.

/**
 * The fragment `main` for a scene whose entry is `Shade <entry>(vec2 uv, vec2 cell, float t)`.
 * It sets `cellTh` before the entry runs and scales the Shade's shimmer by uMotion.
 */
export function main(entry: string): string {
  return `
void main() {
  vec2 cell = gl_FragCoord.xy;
  vec2 uv = cell / uRes;
  float t = uTime;
  cellTh = threshold(cell);

  Shade s = ${entry}(uv, cell, t);

  s.ink *= uReveal;
  s.accent *= uReveal;
  s.rgb = mix(uBg, s.rgb, uReveal);

  float th = threshold(cell);
  // Shimmer re-rolls the threshold 7 times a second; it stills with the motion.
  th = fract(th + s.shimmer * uMotion * hash12(cell + floor(uTime * 7.0)));
  float th2 = threshold(cell + vec2(3.0, 5.0));

  vec3 col;
  bool raw = uView == 1 || (uView == 2 && uv.x < 0.5);
  if (raw) {
    col = s.source;
  } else if (uColor == 2) {
    col = vec3(quantize(s.rgb.r, th), quantize(s.rgb.g, th), quantize(s.rgb.b, th));
  } else if (uColor == 1) {
    col = mix(uBg, uInk, quantize(max(s.ink, s.accent), th));
  } else {
    float a = quantize(s.accent, th);
    col = a > 0.0 ? mix(uBg, uAccent, a) : mix(uBg, uInk, quantize(s.ink, th2));
  }
  if (uView == 2 && abs(cell.x - floor(uRes.x * 0.5)) < 0.5) col = uAccent;
  outColor = vec4(col, 1.0);
}
`;
}
