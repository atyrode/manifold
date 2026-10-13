// The painting scenes (wave, starry): flow-map advection along the brushstroke field.

export const paintings = `
// Two-phase flow-map advection: paint slides along uFlow and cross-fades back to its origin
// before it can smear. A low-frequency phase offset hides the synchronous reset.
vec4 flowSample(vec2 uv, float t, float cycle, float len) {
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

// Wave knobs: 0 lean, 1 flow, 2 spray, 3 depth, 4 foam, 5 paper, 6 rise.
// The great wave leans about its base, the foreground swells roll underneath, and nearer water
// parallaxes more than Fuji and the horizon. Works in image uv, y up.
vec2 waveMotion(vec2 b, float t, float m, vec2 cam, float gather) {
  vec2 e = (b - vec2(0.36, 0.56)) / vec2(0.3, 0.36);
  float body = exp(-dot(e, e));
  float reach = smoothstep(0.15, 0.9, length(b - vec2(0.26, 0.0)));
  float lean = (0.03 * sin(t * 0.45) + 0.008 * sin(t * 1.3 + 0.7)) * m * uParams[0] * 2.0;
  b = rotateAbout(b, vec2(0.26, 0.0), (lean - gather) * body * reach);
  float fore = smoothstep(0.55, 0.1, b.y) * (1.0 - body * 0.6);
  float roll = b.x * 9.0 - t * 0.9;
  b += vec2(0.005 * cos(roll), 0.009 * sin(roll)) * fore * m;
  float near = max(smoothstep(0.45, 0.0, b.y), body * 0.8);
  return b + cam * (0.002 + 0.02 * near) * uParams[3] * 2.0;
}

// Spray thrown off the claws: single-cell droplets on ballistic arcs, respawning each life.
float spray(vec2 b, float t, float amount) {
  vec2 cellSize = max(fwidth(b), vec2(1e-5));
  float acc = 0.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    float life = 2.2 + hash12(vec2(fi, 7.3));
    float k = t / life + hash12(vec2(fi, 1.7));
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

Shade sceneWave(vec2 uv, float t) {
  float m = uMotion;
  bool paper = uParams[5] > 0.5;
  // On the loading page the crest can gather as the bar fills and break when it completes.
  float loading = uParams[6] > 0.5 && uProgress >= 0.0 ? uProgress : -1.0;
  float gather = loading >= 0.0 ? (loading * 0.06 - 0.02) * (1.0 - smoothstep(0.9, 1.0, loading)) : 0.0;
  vec2 cam = (uPointer * 0.8 + vec2(sin(t * 0.11), 0.5 * sin(t * 0.07 + 1.0))) * 0.6 * m;
  vec2 base = waveMotion(coverUV(uv, 1.04, vec2(0.0)), t, m, cam, gather);
  vec4 s4 = flowSample(base, t, 3.0, 0.07 * m * uParams[1]);
  vec3 s = s4.rgb;
  float sea = 1.0 - s4.a;

  float lum = dot(s, LUMA);
  float blue = clamp((s.b - s.r) * 3.5, 0.0, 1.0);
  float foam = smoothstep(0.6, 0.86, lum) * (1.0 - blue * 0.7) * sea;
  float line = smoothstep(0.4, 0.18, lum) * (1.0 - blue);
  float burst = loading > 0.88 ? 1.0 : uParams[2];
  float droplets = burst > 0.0 ? spray(base, t * m, burst) : 0.0;

  Shade o = blankShade();
  o.accent = blue * (0.2 + 0.9 * (1.0 - lum)) * sea;
  if (paper) {
    // Ink on paper: foam stays bare paper, outlines and darks print in ink.
    o.ink = max(smoothstep(0.55, 0.2, lum) * (1.0 - blue) * 0.9, droplets * 0.9);
    o.rgb = s;
  } else {
    o.ink = max(foam * uParams[4] + line * 0.35, droplets * 0.9);
    o.shimmer = foam * 0.22 * m;
    o.rgb = mix(uBg, s, max(sea, line));
  }
  o.source = s;
  if (uParams[7] > 0.5) {
    // Hanko seal with the M cut out, where the title cartouche was cleared.
    vec2 q = (base - vec2(0.062, 0.825)) * vec2(uImageSize.x / uImageSize.y, 1.0) / 0.045;
    float rough = (vnoise(q * 9.0) - 0.5) * 0.08;
    float box = length(max(abs(q) - 0.84, 0.0)) - 0.14 + rough;
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

// Light rings travelling outward through every star's halo.
float starPulse(vec2 b, float t) {
  float aspect = uImageSize.x / uImageSize.y;
  float ring = 0.0;
  for (int i = 0; i < MAX_STARS; i++) {
    if (i >= uStarCount) break;
    vec4 star = uStars[i];
    float d = length((b - star.xy) * vec2(aspect, 1.0)) / star.z;
    float halo = smoothstep(1.9, 0.9, d) * smoothstep(0.15, 0.5, d);
    ring += halo * sin(d * 8.0 - t * 2.2 + float(i) * 1.7);
  }
  return ring;
}

// Starry knobs: 0 swirl, 1 pulse, 2 stir, 3 sway, 4 windows.
Shade sceneStarry(vec2 uv, float t) {
  float m = uMotion;
  float aspect = uImageSize.x / uImageSize.y;
  vec2 base = coverUV(uv, 1.03, uPointer * 0.006 * m);
  // The cypress flickers like a flame about its root.
  float w = exp(-pow((base.x - 0.28) / 0.13, 2.0)) * smoothstep(0.05, 0.95, base.y);
  base = rotateAbout(base, vec2(0.28, 0.0), (0.012 * sin(t * 0.8) + 0.006 * sin(t * 2.1 + 1.3)) * w * m * uParams[3] * 2.0);
  if (uParams[2] > 0.5) {
    // Stir: the paint twists around the pointer like a spoon drawn through it.
    vec2 centre = coverUV(uPointer * 0.5 + 0.5, 1.03, vec2(0.0));
    vec2 d = (base - centre) * vec2(aspect, 1.0);
    float twist = 1.1 * exp(-dot(d, d) / 0.012) * (0.75 + 0.25 * sin(t * 0.9));
    base = centre + rotate(d, twist) / vec2(aspect, 1.0);
  }
  vec3 s = flowSample(base, t, 4.0, 0.08 * m * uParams[0]).rgb;
  float pulse = 1.0 + 0.64 * uParams[1] * starPulse(base, t) * m;
  float lum = dot(s, LUMA) * pulse;
  float yellow = smoothstep(0.02, 0.16, (s.r + s.g) * 0.5 - s.b) * smoothstep(0.3, 0.65, lum);
  if (uParams[4] > 0.0) {
    // Village windows switch on and off one by one.
    float village = step(base.y, 0.36) * step(0.42, base.x);
    vec2 window = floor(base * vec2(150.0, 120.0));
    float lit = step(0.4, hash12(window + floor(t * m * uParams[4] * 1.5 + hash12(window) * 9.0)));
    yellow *= mix(1.0, lit, village);
  }

  Shade o = blankShade();
  o.accent = yellow * (0.85 + 0.15 * pulse);
  // Stretch the painting's mid-blue range so the swirls separate from the night sky.
  o.ink = pow(smoothstep(0.24, 0.72, lum), 1.4) * 0.9 * (1.0 - yellow * 0.7);
  o.shimmer = yellow * 0.12 * m;
  o.rgb = s * 0.92 * pulse;
  o.source = s;
  if (uParams[5] > 0.5) {
    // Five haloed stars at the M's corners, joined by a faint painted stroke.
    vec2 centre = vec2(0.5, 0.84);
    float size = 0.15;
    vec2 local = (base - centre) * vec2(aspect, 1.0) / size;
    for (int i = 0; i < 5; i++) {
      float d = length(local - markVertex(i)) * size / 0.017;
      float core = smoothstep(1.0, 0.4, d);
      float halo = smoothstep(3.4, 1.2, d) * smoothstep(0.6, 1.1, d) * (0.55 + 0.45 * sin(d * 3.0 - t * 2.2 * m + float(i)));
      o.accent = max(o.accent, core);
      o.ink = max(o.ink * (1.0 - core), halo * 0.8);
    }
    float stroke = smoothstep(0.045, 0.015, markDistance(local)) * (0.6 + 0.4 * vnoise(local * 30.0 + t * m));
    o.accent = max(o.accent, stroke * 0.55);
  }
  return o;
}
`;
