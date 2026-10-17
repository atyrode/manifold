// Entry point: call the scene's entry, dither its coverage into the palette, and draw the other
// principals' cursors over it.

/**
 * The fragment `main` for a scene whose entry is `Shade <entry>(vec2 uv, vec2 cell, float t)`.
 * It sets `cellTh` before the entry runs and scales the Shade's shimmer by uMotion. With the gate
 * PRINCIPAL_CURSORS (shaders/index.ts `CURSORS_GATE`: while the cast has agents) it draws the
 * principals after the visitor over the picture, in the scene's accent.
 */
export function main(entry: string): string {
  return `
#ifdef PRINCIPAL_CURSORS
// The others present (principals 1 and up: the cast's agents) as small cursors of their own, never
// like the visitor's arrow, which is the page's: a soft ring with a short wisp behind it along the
// way it moves, drawn in to a dot while it presses and sending out a widening ring as it acts.
// Coverage 0..1 for the cell, cut per cell by the caller; nothing beyond seven rings away.
float principalCursors(vec2 cell) {
  float r = max(4.0, 0.011 * uRes.y);
  float w = max(1.25, 0.22 * r);
  float cover = 0.0;
  for (int i = 1; i < MAX_PRINCIPALS; i++) {
    if (i >= uPrincipalCount) break;
    vec4 p = uPrincipals[i];
    vec2 at = p.xy * uRes;
    float dist = length(cell - at);
    if (dist > 7.0 * r) continue;
    float ring = r * (1.0 - 0.3 * p.z);
    float c = softFill(abs(dist - ring) - 0.5 * w, 0.9);
    c = max(c, p.z * softFill(dist - 0.35 * r, 0.9));
    float age = uTime - p.w;
    if (age >= 0.0 && age < 0.9) {
      float k = age / 0.9;
      c = max(c, 0.8 * (1.0 - k) * softFill(abs(dist - r * (1.0 + 2.2 * k)) - 0.4 * w, 0.9));
    }
    // The wisp: the last 0.3 s of the way it came, at most six rings long, thinning and fading.
    vec2 v = principalMotion(i) * uRes;
    float speed = length(v);
    float len = min(0.3 * speed, 6.0 * r);
    if (len > ring + 1.0) {
      vec2 back = -v / speed;
      float h;
      float d = sdTaperCapsule(cell, at + back * ring, at + back * len, 0.45 * w, 0.15 * w, h);
      c = max(c, 0.75 * (1.0 - h) * softFill(d, 0.9));
    }
    cover = max(cover, c);
  }
  return cover;
}
#endif

void main() {
  vec2 cell = gl_FragCoord.xy;
  vec2 uv = cell / uRes;
  float t = uTime;
  cellTh = threshold(cell);

  Shade s = ${entry}(uv, cell, t);

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
#ifdef PRINCIPAL_CURSORS
  if (hardEdge(principalCursors(cell), edgeThreshold(cell, vec2(11.0, 7.0))) > 0.5)
    col = uColor == 1 ? uInk : uAccent;
#endif
  // An entrance takes over from the leaving scene, still moving (or, entering from nothing, from
  // the bare page) cell by cell in ordered-dither order: the middle first, an even fade, a sweep
  // from the left or coarse grain.
  if (uDissolve.x > 0.0) {
    float dots = bayer8(cell);
    int blend = int(uDissolve.z + 0.5);
    float order;
    if (blend == 1) {
      order = dots;
    } else if (blend == 2) {
      order = 0.2 * dots + 0.8 * (1.0 - (0.85 * uv.x + 0.15 * uv.y));
    } else if (blend == 3) {
      order = 0.3 * dots + 0.7 * hash12(floor(cell / 6.0) + 17.0);
    } else {
      vec2 q = (cell - 0.5 * uRes) / uRes.y;
      order = 0.75 * dots + 0.25 * (1.0 - min(length(q) * 1.3, 1.0));
    }
    // The leaving scene can have a different cell size: map it over the current frame.
    if (order < uDissolve.x) col = uDissolve.y > 0.5 ? texture(uLeaving, uv).rgb : uBg;
  }
  outColor = vec4(col, 1.0);
}
`;
}
