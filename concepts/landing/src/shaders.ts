// One full-screen pass. The canvas backing store is one texel per dither cell and the browser
// upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.

export const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const fragmentSource = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform int uScene;      // 0 wave, 1 starry, 2 orbit, 3 swell
uniform int uDither;     // 0 bayer8, 1 bayer4, 2 interleaved gradient noise, 3 none
uniform int uColor;      // 0 accent, 1 mono, 2 full
uniform float uLevels;
uniform float uMotion;
uniform vec2 uPointer;   // -1..1, smoothed
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform sampler2D uImage;
uniform sampler2D uBackdrop;
uniform vec2 uImageSize;
uniform vec2 uFocus;
uniform float uReveal;   // 0..1 fade-in once the artwork is decoded

out vec4 outColor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

float threshold(vec2 cell) {
  if (uDither == 0) return bayer8(cell);
  if (uDither == 1) return bayer4(cell);
  if (uDither == 2) return fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
  return 0.5;
}

float quantize(float v, float t) {
  float n = max(uLevels - 1.0, 1.0);
  return clamp(floor(clamp(v, 0.0, 1.0) * n + t) / n, 0.0, 1.0);
}

// Cover-fit the artwork, keeping the focal point in frame.
vec2 coverUV(vec2 uv, float zoom, vec2 pan) {
  float sa = uRes.x / uRes.y;
  float ia = uImageSize.x / uImageSize.y;
  vec2 scale = (sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0)) / zoom;
  vec2 c = clamp(uFocus + pan, scale * 0.5, 1.0 - scale * 0.5);
  return c + (uv - 0.5) * scale;
}

struct Shade {
  float ink;      // coverage of the neutral ink
  float accent;   // coverage of the single accent colour
  float shimmer;  // per-cell threshold jitter, for sparkle
  vec3 rgb;       // full-colour rendition for the 'full' palette
};

Shade sceneWave(vec2 uv, float t) {
  float m = uMotion;
  float zoom = 1.0 + 0.03 * m * (0.5 - 0.5 * cos(t * 0.07));
  vec2 base = coverUV(uv, zoom, uPointer * 0.01 * m);

  // Paper and sky (flood-filled from the top-right on load) go to black; only the sea is drawn.
  float sea = 1.0 - texture(uBackdrop, base).r;

  // Water drifts along a slow noise field; paper and sky stay put.
  vec2 flow = vec2(
    fbm(base * 7.0 + vec2(t * 0.22, -t * 0.08)),
    fbm(base * 7.0 + vec2(4.7, 2.3) - vec2(t * 0.17, t * 0.12))
  ) - 0.5;
  vec3 s = texture(uImage, base + flow * 0.007 * m * sea).rgb;

  float lum = dot(s, LUMA);
  float blue = clamp((s.b - s.r) * 3.5, 0.0, 1.0);
  float foam = smoothstep(0.6, 0.86, lum) * (1.0 - blue * 0.7) * sea;
  float line = smoothstep(0.4, 0.18, lum) * (1.0 - blue);

  Shade o;
  o.accent = blue * (0.2 + 0.9 * (1.0 - lum));
  o.ink = foam * 0.6 + line * 0.35;
  o.shimmer = foam * 0.22 * m;
  o.rgb = mix(uBg, s, max(sea, line));
  return o;
}

Shade sceneStarry(vec2 uv, float t) {
  float m = uMotion;
  float zoom = 1.0 + 0.02 * m * (0.5 - 0.5 * cos(t * 0.05));
  vec2 base = coverUV(uv, zoom, uPointer * 0.01 * m);
  vec2 flow = vec2(
    fbm(base * 4.0 + vec2(t * 0.05, 0.0)),
    fbm(base * 4.0 + vec2(3.1, 7.7) - vec2(0.0, t * 0.05))
  ) - 0.5;
  vec3 s = texture(uImage, base + flow * 0.009 * m).rgb;
  float lum = dot(s, LUMA);
  float yellow = smoothstep(0.02, 0.16, (s.r + s.g) * 0.5 - s.b) * smoothstep(0.3, 0.65, lum);
  float twinkle = 1.0 - 0.25 * m * (0.5 + 0.5 * sin(t * 1.7 + hash12(floor(base * 40.0)) * 6.2831));

  Shade o;
  o.accent = yellow * twinkle;
  // Stretch the painting's mid-blue range so the swirls separate from the night sky.
  o.ink = pow(smoothstep(0.24, 0.72, lum), 1.4) * 0.9 * (1.0 - yellow * 0.7);
  o.shimmer = yellow * 0.12 * m;
  o.rgb = s * 0.92;
  return o;
}

float starfield(vec2 cell, float density) {
  float h = hash12(cell);
  float on = step(1.0 - density, h);
  float tw = 0.55 + 0.45 * sin(uTime * (0.6 + h * 2.0) * uMotion + h * 40.0);
  return on * mix(1.0, tw, uMotion) * (0.4 + 0.6 * fract(h * 97.0));
}

Shade sceneOrbit(vec2 uv, float t) {
  float m = uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * 0.012 * m;

  Shade o;
  o.shimmer = 0.0;
  vec2 starCell = floor((p + vec2(t * 0.003 * m, 0.0)) * uRes.y);
  o.ink = starfield(starCell, 0.004);
  o.ink += 0.16 * smoothstep(0.5, 0.95, fbm(p * 1.8 + vec2(t * 0.006 * m, 3.0)));
  o.accent = 0.08 * smoothstep(0.55, 0.95, fbm(p * 2.4 + vec2(9.0, -t * 0.004 * m)));

  vec2 c = vec2(aspect * 0.18, -1.32);
  float r = 1.12;
  vec2 q = (p - c) / r;
  float d = length(q);
  vec3 L = normalize(vec3(-0.55, 0.75, 0.38));

  if (d < 1.0) {
    vec3 n = vec3(q, sqrt(1.0 - d * d));
    float diff = max(dot(n, L), 0.0);
    float lon = atan(n.x, n.z) + t * 0.012 * m;
    float bands = fbm(vec2(lon * 3.0, n.y * 11.0));
    float rim = pow(1.0 - n.z, 3.0);
    float sunSide = smoothstep(-0.2, 0.6, dot(normalize(q), normalize(L.xy)));
    float lights = step(0.992, hash12(floor(vec2(lon * 90.0, n.y * 140.0)))) * smoothstep(0.15, 0.0, diff);
    o.ink = diff * diff * (0.2 + 0.6 * bands) * 0.85;
    o.accent = rim * sunSide * 1.4 + lights * (0.6 + 0.4 * sin(t * 2.0 + lon * 30.0) * m);
  } else {
    float halo = exp(-(d - 1.0) * r * 26.0);
    float sunSide = smoothstep(-0.3, 0.7, dot(normalize(q), normalize(L.xy)));
    o.accent += halo * sunSide * 0.9;
    o.ink *= 1.0 - halo;
  }
  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  return o;
}

float swellHeight(vec2 w, float t) {
  float s = 0.0;
  s += sin(dot(w, vec2(0.9, 0.42)) * 1.3 + t * 1.05) * 0.5;
  s += sin(dot(w, vec2(-0.55, 0.83)) * 2.1 + t * 1.45) * 0.25;
  s += sin(dot(w, vec2(0.18, 0.98)) * 3.7 + t * 2.05) * 0.12;
  s += (fbm(w * 1.4 + vec2(t * 0.18, t * 0.1)) - 0.5) * 0.35;
  return s;
}

Shade sceneSwell(vec2 uv, float t) {
  float m = uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * vec2(0.012, 0.006) * m;
  float horizon = -0.06;
  vec2 moon = vec2(-aspect * 0.2, 0.24);
  float wt = t * m;

  Shade o;
  o.shimmer = 0.0;
  o.ink = 0.0;
  o.accent = 0.0;

  if (p.y > horizon) {
    float md = length(p - moon);
    float disc = smoothstep(0.075, 0.072, md);
    float craters = fbm((p - moon) * 30.0);
    o.ink = disc * (0.7 + 0.3 * craters) + exp(-md * 9.0) * 0.18;
    o.ink += starfield(floor(p * uRes.y), 0.0035) * (1.0 - disc);
    o.ink += 0.06 * smoothstep(0.25, 0.0, p.y - horizon);
  } else {
    vec3 rd = normalize(vec3(p.x, p.y - horizon, 1.6));
    float dist = 1.0 / -rd.y;
    vec3 pos = rd * dist;
    vec2 w = pos.xz * 2.2;
    float e = 0.02 + dist * 0.004;
    float h = swellHeight(w, wt);
    float hx = swellHeight(w + vec2(e, 0.0), wt) - h;
    float hz = swellHeight(w + vec2(0.0, e), wt) - h;
    vec3 n = normalize(vec3(-hx / e * 0.35, 1.0, -hz / e * 0.35));
    vec3 refl = reflect(rd, n);
    vec3 moonDir = normalize(vec3(moon.x, moon.y - horizon, 1.6));
    float spec = pow(max(dot(refl, moonDir), 0.0), 90.0);
    float fres = pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
    float fog = exp(-dist * 0.05);
    float crest = smoothstep(0.35, 0.8, h);
    o.ink = spec * 1.6 + fres * 0.1 + crest * 0.18 * fog;
    o.accent = (0.05 + 0.4 * smoothstep(0.0, 0.8, h)) * fog * (1.0 - min(spec * 2.0, 1.0));
    o.shimmer = min(spec, 1.0) * 0.3 * m;
  }
  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  return o;
}

void main() {
  vec2 cell = gl_FragCoord.xy;
  vec2 uv = cell / uRes;
  float t = uTime;

  Shade s;
  if (uScene == 0) s = sceneWave(uv, t);
  else if (uScene == 1) s = sceneStarry(uv, t);
  else if (uScene == 2) s = sceneOrbit(uv, t);
  else s = sceneSwell(uv, t);

  float reveal = (uScene <= 1) ? uReveal : 1.0;
  s.ink *= reveal;
  s.accent *= reveal;
  s.rgb = mix(uBg, s.rgb, reveal);

  float th = threshold(cell);
  th = fract(th + s.shimmer * hash12(cell + floor(uTime * 7.0)));
  float th2 = threshold(cell + vec2(3.0, 5.0));

  vec3 col;
  if (uColor == 2) {
    col = vec3(quantize(s.rgb.r, th), quantize(s.rgb.g, th), quantize(s.rgb.b, th));
  } else if (uColor == 1) {
    col = mix(uBg, uInk, quantize(max(s.ink, s.accent), th));
  } else {
    float a = quantize(s.accent, th);
    col = a > 0.0 ? mix(uBg, uAccent, a) : mix(uBg, uInk, quantize(s.ink, th2));
  }
  outColor = vec4(col, 1.0);
}
`;
