// One full-screen pass. The canvas backing store is one texel per dither cell and the browser
// upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
// Scene functions return coverage for ink and accent; `main` dithers them into the palette.

export const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const common = `#version 300 es
precision highp float;

#define MAX_STARS 16
#define TAU 6.2831853

uniform vec2 uRes;
uniform float uTime;
uniform int uScene;      // index into sceneIds
uniform int uDither;     // 0 bayer8, 1 bayer4, 2 interleaved gradient noise, 3 none
uniform int uColor;      // 0 accent, 1 mono, 2 full
uniform float uLevels;
uniform float uMotion;
uniform vec2 uPointer;   // -1..1, smoothed
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform sampler2D uImage;
uniform sampler2D uBackdrop; // R: 1 where the painting's paper/sky is dropped to black
uniform sampler2D uFlow;     // RG: brushstroke velocity in image uv per cycle, y up
uniform vec2 uImageSize;
uniform vec2 uFocus;
uniform float uReveal;
uniform vec4 uStars[MAX_STARS]; // image uv (y up), radius in image heights, spin
uniform int uStarCount;
#define MAX_PARAMS 16
#define MAX_CON_STARS 48
#define MAX_CON_LINES 48
uniform float uParams[MAX_PARAMS]; // the scene's knobs, in params.ts order
uniform int uView;                 // 0 dithered, 1 source, 2 split (source left)
uniform vec4 uConStars[MAX_CON_STARS]; // anchor (half-width fraction, y), offset
uniform float uConBright[MAX_CON_STARS];
uniform vec2 uConLines[MAX_CON_LINES];
uniform int uConStarCount;
uniform int uConLineCount;

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

vec2 rotateAbout(vec2 p, vec2 pivot, float angle) {
  vec2 d = p - pivot;
  float c = cos(angle), s = sin(angle);
  return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

// Cover-fit the artwork, keeping the focal point in frame.
vec2 coverUV(vec2 uv, float zoom, vec2 pan) {
  float sa = uRes.x / uRes.y;
  float ia = uImageSize.x / uImageSize.y;
  vec2 scale = (sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0)) / zoom;
  vec2 c = clamp(uFocus + pan, scale * 0.5, 1.0 - scale * 0.5);
  return c + (uv - 0.5) * scale;
}

// Mostly steady stars that dim now and then. 'twinkle' sets the rate; 'scatter' spreads rates and
// phases and shortens the dips so stars flicker independently rather than in unison.
float starfield(vec2 cell, float density, float twinkle, float scatter) {
  float h = hash12(cell);
  float on = step(1.0 - density, h);
  float h2 = fract(h * 431.7);
  float h3 = fract(h * 719.3);
  float rate = (0.15 + 2.5 * twinkle) * mix(1.0, 0.25 + 1.75 * h2, scatter);
  float wave = 0.5 + 0.5 * sin(uTime * rate * uMotion + h3 * TAU * (1.0 + 9.0 * scatter));
  float dip = pow(wave, mix(1.0, 9.0, scatter)) * step(0.001, twinkle);
  return on * (1.0 - 0.75 * dip * uMotion) * (0.4 + 0.6 * fract(h * 97.0));
}

struct Shade {
  float ink;      // coverage of the neutral ink
  float accent;   // coverage of the single accent colour
  float shimmer;  // per-cell threshold jitter, for sparkle
  vec3 rgb;       // full-colour rendition for the 'full' palette
  vec3 source;    // undithered picture for the source/split views
};
`;

const paintings = `
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

// The great wave leans about its base, the foreground swells roll underneath, and nearer water
// parallaxes more than Fuji and the horizon. Works in image uv, y up.
vec2 waveMotion(vec2 b, float t, float m, vec2 cam) {
  vec2 e = (b - vec2(0.36, 0.56)) / vec2(0.3, 0.36);
  float body = exp(-dot(e, e));
  float reach = smoothstep(0.15, 0.9, length(b - vec2(0.26, 0.0)));
  float lean = (0.03 * sin(t * 0.45) + 0.008 * sin(t * 1.3 + 0.7)) * body * reach * m * uParams[0] * 2.0;
  b = rotateAbout(b, vec2(0.26, 0.0), lean);
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
    acc = max(acc, step(dot(dc, dc), 0.7) * (1.0 - tau / life) * step(fi, amount * 96.0));
  }
  return acc;
}

Shade sceneWave(vec2 uv, float t) {
  float m = uMotion;
  vec2 cam = (uPointer * 0.8 + vec2(sin(t * 0.11), 0.5 * sin(t * 0.07 + 1.0))) * 0.6 * m;
  vec2 base = waveMotion(coverUV(uv, 1.04, vec2(0.0)), t, m, cam);
  vec4 s4 = flowSample(base, t, 3.0, 0.07 * m * uParams[1]);
  vec3 s = s4.rgb;
  float sea = 1.0 - s4.a;

  float lum = dot(s, LUMA);
  float blue = clamp((s.b - s.r) * 3.5, 0.0, 1.0);
  float foam = smoothstep(0.6, 0.86, lum) * (1.0 - blue * 0.7) * sea;
  float line = smoothstep(0.4, 0.18, lum) * (1.0 - blue);

  Shade o;
  o.accent = blue * (0.2 + 0.9 * (1.0 - lum)) * sea;
  float droplets = uParams[2] > 0.0 ? spray(base, t * m, uParams[2]) : 0.0;
  o.ink = max(foam * uParams[4] + line * 0.35, droplets * 0.9);
  o.shimmer = foam * 0.22 * m;
  o.rgb = mix(uBg, s, max(sea, line));
  o.source = s;
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

// The cypress flickers like a flame about its root.
vec2 cypressSway(vec2 b, float t, float m) {
  float w = exp(-pow((b.x - 0.28) / 0.13, 2.0)) * smoothstep(0.05, 0.95, b.y);
  float angle = (0.012 * sin(t * 0.8) + 0.006 * sin(t * 2.1 + 1.3)) * w * m * uParams[2] * 2.0;
  return rotateAbout(b, vec2(0.28, 0.0), angle);
}

Shade sceneStarry(vec2 uv, float t) {
  float m = uMotion;
  vec2 base = cypressSway(coverUV(uv, 1.03, uPointer * 0.006 * m), t, m);
  vec3 s = flowSample(base, t, 4.0, 0.08 * m * uParams[0]).rgb;
  float pulse = 1.0 + 0.64 * uParams[1] * starPulse(base, t) * m;
  float lum = dot(s, LUMA) * pulse;
  float yellow = smoothstep(0.02, 0.16, (s.r + s.g) * 0.5 - s.b) * smoothstep(0.3, 0.65, lum);

  Shade o;
  o.accent = yellow * (0.85 + 0.15 * pulse);
  // Stretch the painting's mid-blue range so the swirls separate from the night sky.
  o.ink = pow(smoothstep(0.24, 0.72, lum), 1.4) * 0.9 * (1.0 - yellow * 0.7);
  o.shimmer = yellow * 0.12 * m;
  o.rgb = s * 0.92 * pulse;
  o.source = s;
  return o;
}
`;

const space = `
// Real constellations, drifting with the sky: glinting stars and optional dotted figure lines.
vec2 constellations(vec2 sky, float aspect, float px, float showLines, float tm) {
  float star = 0.0;
  float line = 0.0;
  for (int i = 0; i < MAX_CON_STARS; i++) {
    if (i >= uConStarCount) break;
    vec4 s = uConStars[i];
    vec2 q = (sky - (vec2(s.x * aspect * 0.5, s.y) + s.zw)) / px;
    float b = uConBright[i];
    float core = smoothstep(1.3 + b, 0.4 + b, length(q));
    float glint = step(min(abs(q.x), abs(q.y)), 0.5) * smoothstep(2.0 + 4.0 * b, 0.0, max(abs(q.x), abs(q.y))) * b;
    star = max(star, max(core, glint * 0.8) * (0.85 + 0.15 * sin(tm * 0.9 + float(i) * 2.3)));
  }
  if (showLines > 0.5) {
    for (int i = 0; i < MAX_CON_LINES; i++) {
      if (i >= uConLineCount) break;
      vec4 sa = uConStars[int(uConLines[i].x)];
      vec4 sb = uConStars[int(uConLines[i].y)];
      vec2 a = vec2(sa.x * aspect * 0.5, sa.y) + sa.zw;
      vec2 b = vec2(sb.x * aspect * 0.5, sb.y) + sb.zw;
      vec2 ba = b - a;
      float h = clamp(dot(sky - a, ba) / dot(ba, ba), 0.0, 1.0);
      float d = length(sky - a - ba * h) / px;
      float fromEnds = min(h, 1.0 - h) * length(ba) / px;
      float dash = step(0.45, fract(h * length(ba) / px / 3.0));
      line = max(line, step(d, 0.5) * dash * step(3.0, fromEnds));
    }
  }
  return vec2(star, line);
}

// Shooting stars: each time slot may throw one streak across the upper sky.
float meteors(vec2 p, float rate, float px, float t) {
  float acc = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float slotLength = mix(10.0, 1.6, rate) * (1.0 + 0.37 * float(layer));
    float k = t / slotLength + float(layer) * 0.5;
    float slot = floor(k);
    float tau = fract(k) * slotLength;
    vec2 seed = vec2(slot, float(layer) * 17.0);
    if (rate <= 0.0 || hash12(seed) > 0.35 + 0.65 * rate) continue;
    float duration = 0.6 + 0.5 * hash12(seed + 2.0);
    if (tau > duration) continue;
    vec2 start = vec2((hash12(seed + 4.0) - 0.3) * 1.6, 0.2 + 0.3 * hash12(seed + 6.0));
    float angle = 3.65 + 0.5 * hash12(seed + 8.0);
    vec2 dir = vec2(cos(angle), sin(angle));
    vec2 head = start + dir * tau * 0.9;
    vec2 tail = head - dir * 0.16;
    vec2 pa = p - tail;
    float along = clamp(dot(pa, dir) / 0.16, 0.0, 1.0);
    float d = length(pa - dir * along * 0.16) / px;
    float fade = 1.0 - smoothstep(0.6 * duration, duration, tau);
    acc = max(acc, step(d, 0.6 + 0.6 * along) * along * along * fade);
  }
  return acc;
}

// Orbit knobs (params.ts order): 0 stars, 1 twinkle, 2 scatter, 3 constellations, 4 lines,
// 5 meteors, 6 nebula, 7 drift, 8 planet, 9 clouds, 10 storms, 11 moons, 12 ring, 13 ringTilt,
// 14 ringWidth.
Shade sceneOrbit(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * 0.012 * m;

  Shade o;
  o.shimmer = 0.0;
  vec2 sky = p + vec2(tm * 0.006 * uParams[7], 0.0);
  o.ink = starfield(floor(sky * uRes.y), 0.001 + 0.009 * uParams[0], uParams[1], uParams[2]);
  o.ink += 0.16 * uParams[6] * smoothstep(0.5, 0.95, fbm(p * 1.8 + vec2(tm * 0.012 * uParams[7], 3.0)));
  o.accent = 0.08 * uParams[6] * smoothstep(0.55, 0.95, fbm(p * 2.4 + vec2(9.0, -tm * 0.008 * uParams[7])));
  if (uParams[3] > 0.5) {
    vec2 figures = constellations(sky, aspect, px, uParams[4], tm);
    o.ink = max(o.ink, figures.x);
    o.accent = max(o.accent, figures.y * 0.6);
  }
  o.ink = max(o.ink, meteors(p, uParams[5], px, tm));

  float r = 1.12 * uParams[8];
  vec2 c = vec2(aspect * 0.18, -0.2 - r);
  vec2 q = (p - c) / r;
  float d = length(q);
  vec3 L = normalize(vec3(-0.55, 0.75, 0.38));
  float sunSide = smoothstep(-0.3, 0.7, dot(normalize(q), normalize(L.xy)));
  float sphereZ = d < 1.0 ? sqrt(1.0 - d * d) * r : -1e9;

  // Ring plane through the planet's centre, seen orthographically. Its far side passes behind the
  // planet; the planet's shadow falls across it.
  float ring = 0.0;
  if (uParams[12] > 0.5) {
    // The planet's centre sits below the frame, so the ring only shows where its far side clears the
    // limb: tilt runs from 'just clears it' to 'seen from above'.
    float outer = 1.3 + 1.0 * uParams[14];
    float facing = mix(1.08 / outer, 0.97, uParams[13]);
    vec3 n = normalize(vec3(-0.18 * facing, sqrt(1.0 - facing * facing), facing));
    vec2 dp = p - c;
    float z = -(n.x * dp.x + n.y * dp.y) / max(n.z, 0.02);
    vec3 point = vec3(dp, z);
    float radius = length(point) / r;
    float band = smoothstep(1.2, 1.23, radius) * smoothstep(outer, outer - 0.03, radius);
    float gap = smoothstep(0.006, 0.016, abs(radius - mix(1.23, outer, 0.64)));
    float grooves = 0.62 + 0.22 * sin(radius * 190.0) + 0.16 * (vnoise(vec2(radius * 120.0, 1.0)) - 0.5);
    float lit = dot(point, L) < 0.0 && length(point - dot(point, L) * L) < r ? 0.15 : 1.0;
    bool hidden = d < 1.0 && z < sphereZ;
    ring = hidden ? 0.0 : band * gap * grooves * lit;
  }

  if (d < 1.0) {
    vec3 n = vec3(q, sqrt(1.0 - d * d));
    float diff = max(dot(n, L), 0.0);
    float lon = atan(n.x, n.z) + tm * 0.012;
    float bands = fbm(vec2(lon * 3.0, n.y * 11.0));
    float rim = pow(1.0 - n.z, 3.0);
    float limbSun = smoothstep(-0.2, 0.6, dot(normalize(q), normalize(L.xy)));
    float night = smoothstep(0.15, 0.0, diff);
    float lights = step(0.992, hash12(floor(vec2(lon * 90.0, n.y * 140.0)))) * night;
    o.ink = diff * diff * (0.2 + 0.6 * bands) * 0.85;
    o.accent = rim * limbSun * 1.4 + lights * (0.6 + 0.4 * sin(t * 2.0 + lon * 30.0) * m);
    // Cloud decks drift faster than the surface and catch the light.
    float cloud = smoothstep(0.52, 0.72, fbm(vec2(lon * 4.0 + tm * 0.02, n.y * 9.0) + vec2(5.0, 1.0)));
    o.ink = max(o.ink, cloud * uParams[9] * (0.15 + 0.8 * diff));
    // Storms: brief flashes inside the night-side clouds, each cell on its own clock.
    vec2 stormCell = floor(vec2(lon * 40.0, n.y * 60.0));
    float strike = step(1.0 - 0.06 * uParams[10], hash12(stormCell + floor(t * 6.0 + hash12(stormCell) * 6.0)));
    float storm = strike * uParams[10] * (0.4 + 0.6 * cloud) * smoothstep(0.35, 0.0, diff) * step(0.001, m);
    o.ink = max(o.ink, storm);
    o.shimmer = storm * 0.3;
  } else {
    float halo = exp(-(d - 1.0) * r * 26.0);
    o.accent += halo * sunSide * 0.9;
    o.ink *= 1.0 - halo;
  }
  if (ring > 0.0) {
    o.accent = max(o.accent * 0.3, ring * 0.6);
    o.ink *= 0.35;
  }

  // Moons on inclined orbits: they rise from behind the limb, cross the sky and set again.
  for (int i = 0; i < 3; i++) {
    if (float(i) >= uParams[11]) break;
    float fi = float(i);
    float a = r * (1.2 + 0.18 * fi);
    float angle = tm * (0.06 - 0.014 * fi) + 1.2 + fi * 0.9;
    vec2 local = vec2(cos(angle) * a, sin(angle) * a * (0.9 - 0.1 * fi));
    float tilt = -0.15 + 0.15 * fi;
    vec2 centre = c + vec2(cos(tilt) * local.x - sin(tilt) * local.y, sin(tilt) * local.x + cos(tilt) * local.y);
    float size = (0.016 + 0.01 * fi) * uParams[8];
    vec2 mq = (p - centre) / size;
    float md = length(mq);
    bool hidden = sin(angle) > 0.0 && length((centre - c) / r) < 1.0;
    if (md < 1.0 && !hidden) {
      vec3 mn = vec3(mq, sqrt(1.0 - md * md));
      float lit = max(dot(mn, L), 0.0);
      o.ink = 0.08 + 0.85 * lit * (0.7 + 0.3 * vnoise(mq * 4.0 + fi * 9.0));
      o.accent = 0.0;
    }
  }
  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}

float swellHeight(vec2 w, float t, float chop) {
  float s = 0.0;
  s += sin(dot(w, vec2(0.9, 0.42)) * 1.3 + t * 1.05) * 0.5;
  s += sin(dot(w, vec2(-0.55, 0.83)) * 2.1 + t * 1.45) * 0.25;
  s += sin(dot(w, vec2(0.18, 0.98)) * 3.7 + t * 2.05) * 0.12 * chop;
  s += (fbm(w * 1.4 + vec2(t * 0.18, t * 0.1)) - 0.5) * 0.35 * chop;
  return s;
}

Shade sceneSwell(vec2 uv, float t) {
  float m = uMotion;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * vec2(0.012, 0.006) * m;
  float horizon = -0.06;
  vec2 moon = vec2(-aspect * 0.2, 0.24);
  float moonRadius = 0.03 + 0.09 * uParams[2];
  float height = uParams[0] * 2.0;
  float chop = uParams[1] * 2.0;
  float wt = t * m;

  Shade o;
  o.shimmer = 0.0;
  o.ink = 0.0;
  o.accent = 0.0;

  if (p.y > horizon) {
    float md = length(p - moon);
    float disc = smoothstep(moonRadius, moonRadius - 0.003, md);
    float craters = fbm((p - moon) * 30.0);
    o.ink = disc * (0.7 + 0.3 * craters) + exp(-md * 12.0 * 0.075 / moonRadius) * 0.16;
    o.ink += starfield(floor(p * uRes.y), 0.001 + 0.007 * uParams[3], 0.3, 0.8) * (1.0 - disc);
    o.ink += 0.06 * smoothstep(0.25, 0.0, p.y - horizon);
  } else {
    vec3 rd = normalize(vec3(p.x, p.y - horizon, 1.6));
    float dist = 1.0 / -rd.y;
    vec3 pos = rd * dist;
    vec2 w = pos.xz * 2.2;
    float e = 0.02 + dist * 0.004;
    float h = swellHeight(w, wt, chop) * height;
    float hx = swellHeight(w + vec2(e, 0.0), wt, chop) * height - h;
    float hz = swellHeight(w + vec2(0.0, e), wt, chop) * height - h;
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
  o.source = o.rgb;
  return o;
}
`;

const main = `
void main() {
  vec2 cell = gl_FragCoord.xy;
  vec2 uv = cell / uRes;
  float t = uTime;

  Shade s;
  if (uScene == 0) s = sceneWave(uv, t);
  else if (uScene == 1) s = sceneStarry(uv, t);
  else if (uScene == 2) s = sceneOrbit(uv, cell, t);
  else s = sceneSwell(uv, t);

  s.ink *= uReveal;
  s.accent *= uReveal;
  s.rgb = mix(uBg, s.rgb, uReveal);

  float th = threshold(cell);
  th = fract(th + s.shimmer * hash12(cell + floor(uTime * 7.0)));
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

export const fragmentSource = common + paintings + space + main;
