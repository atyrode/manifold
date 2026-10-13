// The wave scene: Hokusai's print advected along its brushstrokes.
import { paintingsGlsl } from "../../shaders/paintings.ts";

export const waveGlsl = `${paintingsGlsl}
// The great wave leans about its base, the foreground swells roll underneath, and nearer water
// parallaxes more than Fuji and the horizon. Works in image uv, y up.
vec2 waveMotion(vec2 b, float t, float m, vec2 cam, float gather) {
  vec2 e = (b - vec2(0.36, 0.56)) / vec2(0.3, 0.36);
  float body = exp(-dot(e, e));
  float reach = smoothstep(0.15, 0.9, length(b - vec2(0.26, 0.0)));
  float lean = (0.03 * sin(t * 0.45) + 0.008 * sin(t * 1.3 + 0.7)) * m * K_lean * 2.0;
  b = rotateAbout(b, vec2(0.26, 0.0), (lean - gather) * body * reach);
  float fore = smoothfall(0.55, 0.1, b.y) * (1.0 - body * 0.6);
  float roll = b.x * 9.0 - t * 0.9;
  b += vec2(0.005 * cos(roll), 0.009 * sin(roll)) * fore * m;
  float near = max(smoothfall(0.45, 0.0, b.y), body * 0.8);
  return b + cam * (0.002 + 0.02 * near) * K_depth * 2.0;
}

// Spray thrown off the claws: single-cell droplets on ballistic arcs, respawning each life.
float waveSpray(vec2 b, float tm, float amount) {
  vec2 cellSize = max(fwidth(b), vec2(1e-5));
  float acc = 0.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    float life = 2.2 + hash12(vec2(fi, 7.3));
    float k = tm / life + hash12(vec2(fi, 1.7));
    float tau = fract(k) * life;
    float gen = floor(k);
    vec2 origin = vec2(0.46 + 0.14 * hash12(vec2(fi, gen)), 0.6 + 0.18 * hash12(vec2(gen, fi)));
    vec2 vel = vec2(0.015 + 0.045 * hash12(vec2(fi, 9.1)), 0.01 + 0.035 * hash12(vec2(fi, 4.4)));
    vec2 pos = origin + vel * tau + vec2(0.0, -0.022) * tau * tau;
    vec2 dc = (b - pos) / cellSize;
    acc = max(acc, step(dot(dc, dc), 0.7) * (1.0 - tau / life) * step(fi, amount * 48.0));
  }
  return acc;
}

Shade sceneWave(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  bool paper = pagePaper();
  // On the loading page the crest can gather as the bar fills and break when it completes.
  float loading = K_rise > 0.5 && uProgress >= 0.0 ? uProgress : -1.0;
  float gather = loading >= 0.0 ? (loading * 0.06 - 0.02) * (1.0 - smoothstep(0.9, 1.0, loading)) : 0.0;
  vec2 cam = (uPointer * 0.8 + vec2(sin(t * 0.11), 0.5 * sin(t * 0.07 + 1.0))) * 0.6 * m;
  vec2 base = waveMotion(coverUV(uv, 1.04, vec2(0.0)), t, m, cam, gather);
  vec4 s4 = paintingFlow(base, t, 3.0, 0.07 * m * K_flow);
  vec3 s = s4.rgb;
  float sea = 1.0 - s4.a;

  float lum = dot(s, LUMA);
  float blue = clamp((s.b - s.r) * 3.5, 0.0, 1.0);
  float foam = smoothstep(0.6, 0.86, lum) * (1.0 - blue * 0.7) * sea;
  float line = smoothfall(0.4, 0.18, lum) * (1.0 - blue);
  float burst = loading > 0.88 ? 1.0 : K_spray;
  float droplets = burst > 0.0 ? waveSpray(base, uMotionTime, burst) : 0.0;

  Shade o = blankShade();
  o.accent = blue * (0.2 + 0.9 * (1.0 - lum)) * sea;
  if (paper) {
    // Ink on paper: foam stays bare paper, outlines and darks print in ink.
    o.ink = max(smoothfall(0.55, 0.2, lum) * (1.0 - blue) * 0.9, droplets * 0.9);
    o.rgb = s;
  } else {
    o.ink = max(foam * K_foam + line * 0.35, droplets * 0.9);
    o.shimmer = foam * 0.22;
    o.rgb = mix(uBg, s, max(sea, line));
  }
  o.source = s;
  if (K_seal > 0.5) {
    // Hanko seal with the M cut out, where the title cartouche was cleared.
    vec2 q = (base - vec2(0.062, 0.825)) * vec2(uImageSize.x / uImageSize.y, 1.0) / 0.045;
    float rough = (vnoise(q * 9.0) - 0.5) * 0.08;
    float box = sdBox(q, vec2(0.98), 0.14) + rough;
    if (box < 0.0) {
      float cut = step(markDistance(q * 0.6), 0.085);
      o.accent = (1.0 - cut) * (0.82 + 0.18 * vnoise(q * 22.0));
      o.ink = 0.0;
      o.rgb = mix(o.rgb, uAccent, o.accent);
      o.source = mix(s, uAccent, o.accent);
    }
  }
  return o;
}
`;
