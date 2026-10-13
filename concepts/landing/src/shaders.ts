// One full-screen pass. The canvas backing store is one texel per dither cell and the browser
// upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
// Scene functions return coverage for ink and accent; `main` dithers them into the palette.
// Each scene reads its knobs from `uParams` in the order declared in params.ts.

export const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const common = `#version 300 es
precision highp float;

#define MAX_STARS 16
#define MAX_PARAMS 40
#define MAX_CON_STARS 48
#define MAX_CON_LINES 48
#define MAX_TRIGGERS 8
#define TAU 6.2831853

uniform vec2 uRes;
uniform float uTime;
uniform int uScene;      // index into sceneIds
uniform int uDither;     // 0 bayer8, 1 bayer4, 2 interleaved gradient noise, 3 none
uniform int uColor;      // 0 accent, 1 mono, 2 full
uniform int uView;       // 0 dithered, 1 source, 2 split (source left)
uniform float uLevels;
uniform float uMotion;
uniform vec2 uPointer;   // -1..1, smoothed
uniform float uProgress; // loading page progress 0..1, -1 elsewhere
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
uniform float uParams[MAX_PARAMS];
uniform vec4 uConStars[MAX_CON_STARS]; // anchor (half-width fraction, y), offset
uniform float uConBright[MAX_CON_STARS];
uniform vec2 uConLines[MAX_CON_LINES];
uniform int uConStarCount;
uniform int uConLineCount;
uniform int uConMarkStar;  // first star / line of the Manifold asterism
uniform int uConMarkLine;
uniform float uTriggers[MAX_TRIGGERS]; // uTime when each "now" button fired

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

vec2 rotate(vec2 v, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

vec2 rotateAbout(vec2 p, vec2 pivot, float angle) {
  return pivot + rotate(p - pivot, angle);
}

// Cover-fit the artwork, keeping the focal point in frame.
vec2 coverUV(vec2 uv, float zoom, vec2 pan) {
  float sa = uRes.x / uRes.y;
  float ia = uImageSize.x / uImageSize.y;
  vec2 scale = (sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0)) / zoom;
  vec2 c = clamp(uFocus + pan, scale * 0.5, 1.0 - scale * 0.5);
  return c + (uv - 0.5) * scale;
}

// Mostly steady stars that dim now and then. 'twinkle' sets the rate (0 = steady); 'scatter'
// spreads rates and phases and shortens the dips so stars flicker independently.
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

// Seconds since a "now" button fired (negative or huge when idle).
float sinceTrigger(int slot) {
  return uTime - uTriggers[slot];
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// The Manifold M, after the app icon, in mark units: x in [-0.47, 0.47], y in [-0.5, 0.5].
const vec2 M0 = vec2(-0.47, -0.5);
const vec2 M1 = vec2(-0.47, 0.5);
const vec2 M2 = vec2(0.0, -0.08);
const vec2 M3 = vec2(0.47, 0.5);
const vec2 M4 = vec2(0.47, -0.5);

float markDistance(vec2 q) {
  return min(min(segmentDistance(q, M0, M1), segmentDistance(q, M1, M2)), min(segmentDistance(q, M2, M3), segmentDistance(q, M3, M4)));
}

// Point at fraction s (0..1) of the way along the M's strokes, by length.
vec2 markPoint(float s) {
  float d = clamp(s, 0.0, 1.0) * 3.493;
  if (d < 1.0) return mix(M0, M1, d);
  d -= 1.0;
  if (d < 0.7465) return mix(M1, M2, d / 0.7465);
  d -= 0.7465;
  if (d < 0.7465) return mix(M2, M3, d / 0.7465);
  return mix(M3, M4, d - 0.7465);
}

vec2 markVertex(int i) {
  return i == 0 ? M0 : i == 1 ? M1 : i == 2 ? M2 : i == 3 ? M3 : M4;
}

struct Shade {
  float ink;      // coverage of the neutral ink
  float accent;   // coverage of the single accent colour
  float shimmer;  // per-cell threshold jitter, for sparkle
  vec3 rgb;       // full-colour rendition for the 'full' palette
  vec3 source;    // undithered picture for the source/split views
};

Shade blankShade() {
  Shade o;
  o.ink = 0.0;
  o.accent = 0.0;
  o.shimmer = 0.0;
  o.rgb = vec3(0.0);
  o.source = vec3(0.0);
  return o;
}
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

const orbit = `
// Real constellations, plus the optional Manifold asterism, drifting with the sky.
vec2 constellations(vec2 sky, float aspect, float px, bool figures, bool lines, bool mark, float tm) {
  float star = 0.0;
  float line = 0.0;
  for (int i = 0; i < MAX_CON_STARS; i++) {
    if (i >= uConStarCount) break;
    if (!(i < uConMarkStar ? figures : mark)) continue;
    vec4 s = uConStars[i];
    vec2 q = (sky - (vec2(s.x * aspect * 0.5, s.y) + s.zw)) / px;
    float b = uConBright[i];
    float core = smoothstep(1.3 + b, 0.4 + b, length(q));
    float glint = step(min(abs(q.x), abs(q.y)), 0.5) * smoothstep(2.0 + 4.0 * b, 0.0, max(abs(q.x), abs(q.y))) * b;
    star = max(star, max(core, glint * 0.8) * (0.85 + 0.15 * sin(tm * 0.9 + float(i) * 2.3)));
  }
  for (int i = 0; i < MAX_CON_LINES; i++) {
    if (i >= uConLineCount) break;
    if (!(i < uConMarkLine ? figures && lines : mark)) continue;
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
  return vec2(star, line);
}

// One shooting star 'tau' seconds into its flight.
float meteorStreak(vec2 p, float tau, vec2 seed, float px) {
  float duration = 0.6 + 0.5 * hash12(seed + 2.0);
  if (tau < 0.0 || tau > duration) return 0.0;
  vec2 start = vec2((hash12(seed + 4.0) - 0.3) * 1.6, 0.2 + 0.3 * hash12(seed + 6.0));
  float angle = 3.65 + 0.5 * hash12(seed + 8.0);
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 head = start + dir * tau * 0.9;
  vec2 tail = head - dir * 0.16;
  vec2 pa = p - tail;
  float along = clamp(dot(pa, dir) / 0.16, 0.0, 1.0);
  float d = length(pa - dir * along * 0.16) / px;
  float fade = 1.0 - smoothstep(0.6 * duration, duration, tau);
  return step(d, 0.6 + 0.6 * along) * along * along * fade;
}

// Shooting stars: each time slot may throw one streak; trigger slot 0 throws one now.
float meteors(vec2 p, float rate, float px, float t) {
  float acc = meteorStreak(p, sinceTrigger(0), vec2(uTriggers[0], 91.0), px);
  if (rate <= 0.0) return acc;
  for (int layer = 0; layer < 2; layer++) {
    float slotLength = mix(10.0, 1.6, rate) * (1.0 + 0.37 * float(layer));
    float k = t / slotLength + float(layer) * 0.5;
    vec2 seed = vec2(floor(k), float(layer) * 17.0);
    if (hash12(seed) > 0.35 + 0.65 * rate) continue;
    acc = max(acc, meteorStreak(p, fract(k) * slotLength, seed, px));
  }
  return acc;
}

// A body on an inclined orbit about the planet's centre: x, y on screen (relative to the centre),
// z toward the viewer. 'tilt' is cos of the inclination; 'roll' turns the orbit on screen.
vec3 inclined(float angle, float radius, float tilt, float roll) {
  vec3 p = vec3(cos(angle) * radius, sin(angle) * radius * tilt, -sin(angle) * radius * sqrt(1.0 - tilt * tilt));
  p.xy = rotate(p.xy, roll);
  return p;
}

bool behindPlanet(vec3 p, float r) {
  float l2 = dot(p.xy, p.xy);
  return l2 < r * r && p.z < sqrt(r * r - l2);
}

// Captured meteor 'tau' seconds after it appears: spirals inward around the planet and burns up
// in the atmosphere. Returns (ink, accent).
vec2 capturedEvent(vec2 dp, float r, float tau, float id, float px) {
  vec2 acc = vec2(0.0);
  float duration = 8.0;
  if (tau < 0.0 || tau > duration + 1.4) return acc;
  float tilt = 0.3 + 0.55 * hash12(vec2(id, 5.1));
  float roll = (hash12(vec2(id, 9.7)) - 0.5) * 0.9;
  float start = hash12(vec2(id, 3.3)) * TAU;
  float turn = hash12(vec2(id, 1.9)) > 0.5 ? 1.0 : -1.0;
  for (int i = 0; i < 16; i++) {
    float back = float(i) * 0.05;
    if (tau - back < 0.0) break;
    float tt = clamp((tau - back) / duration, 0.0, 1.0);
    vec3 pos = inclined(start + turn * TAU * 1.4 * pow(tt, 0.8), mix(3.4, 1.02, pow(tt, 1.25)) * r, tilt, roll);
    if (behindPlanet(pos, r) || tau - back > duration) continue;
    float d = length(dp - pos.xy) / px;
    acc.x = max(acc.x, step(d, i == 0 ? 1.4 : 0.75) * (1.0 - float(i) / 16.0));
  }
  if (tau > duration) {
    vec3 end = inclined(start + turn * TAU * 1.4, 1.02 * r, tilt, roll);
    float f = (tau - duration) / 1.4;
    float d = length(dp - end.xy) / px;
    float flash = (1.0 - f) * smoothstep(3.0 + 30.0 * f, 0.0, d);
    if (!behindPlanet(end, r)) acc.y = max(acc.y, flash);
  }
  return acc;
}

// Scheduled captures at the chosen frequency; trigger slot 1 starts one now.
vec2 captured(vec2 dp, float r, float t, float freq, float px) {
  vec2 acc = capturedEvent(dp, r, sinceTrigger(1), 1000.0 + uTriggers[1], px);
  if (freq <= 0.0) return acc;
  float slot = mix(40.0, 10.0, freq);
  float k = t / slot;
  return max(acc, capturedEvent(dp, r, fract(k) * slot, floor(k), px));
}

// Auroral oval around a pole tipped toward the viewer: a band at a set distance from the pole,
// broken into drifting folds and patches. 'n' is a unit direction from the planet's centre.
float auroraOval(vec3 n, float size, float tm) {
  vec3 pole = normalize(vec3(0.12, 0.86, 0.5));
  float colat = acos(clamp(dot(n, pole), -1.0, 1.0));
  vec3 e1 = normalize(cross(pole, vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(pole, e1);
  float az = atan(dot(n, e2), dot(n, e1));
  vec2 ring = vec2(cos(az), sin(az));
  float wobble = (fbm(ring * 2.2 + vec2(tm * 0.06, -tm * 0.04)) - 0.5) * 0.22;
  float band = exp(-pow((colat - mix(0.25, 0.75, size) - wobble) / 0.09, 2.0));
  float folds = 0.55 + 0.45 * sin(az * 38.0 + fbm(ring * 3.0 + tm * 0.08) * 7.0 + tm * 0.4);
  float mass = smoothstep(0.25, 0.7, fbm(ring * 4.0 + vec2(colat * 6.0, tm * 0.12)));
  return band * folds * mass;
}

// Ring plane geometry shared by the ring itself and the shadows it casts.
vec3 ringNormal() {
  float facing = mix(0.06, 0.97, uParams[24]);
  vec3 n = vec3(0.0, sqrt(1.0 - facing * facing), facing);
  n.xy = rotate(n.xy, uParams[25] * 0.7);
  return n;
}

// Ring cover at an in-plane point (planet radii), and whether that band is drawn in ink.
float ringCover(vec3 point, vec3 n, float t, out float inkTone) {
  inkTone = 0.0;
  float rho = length(point);
  float inner = 1.1 + 0.9 * uParams[22];
  float outer = inner + 0.15 + 1.6 * uParams[23];
  float u = (rho - inner) / (outer - inner);
  if (u < 0.0 || u > 1.0) return 0.0;
  float count = max(uParams[20], 1.0);
  float band = floor(u * count);
  float v = fract(u * count);
  float gap = uParams[21] * 0.5;
  float soft = 0.015 * count;
  float inBand = count < 1.5 ? 1.0 : smoothstep(gap, gap + soft, v) * smoothstep(1.0 - gap, 1.0 - gap - soft, v);
  vec3 e1 = normalize(vec3(n.y, -n.x, 0.0));
  vec3 e2 = cross(n, e1);
  // Inner bands orbit faster (Kepler); the texture rides along with them.
  float spin = uParams[29] * t * 0.6 / pow(rho, 1.5);
  vec2 plane = rotate(vec2(dot(point, e1), dot(point, e2)), -spin);
  int kind = int(uParams[28] + 0.5);
  float density = uParams[26];
  float texture;
  if (kind == 0) {
    texture = (0.65 + 0.35 * vnoise(plane * 7.0)) * density;
  } else if (kind == 1) {
    texture = (0.62 + 0.22 * sin(rho * 190.0) + 0.16 * (vnoise(vec2(rho * 120.0, 1.0)) - 0.5) + 0.12 * (vnoise(plane * 18.0) - 0.5)) * density;
  } else {
    vec2 grid = plane * 45.0;
    vec2 id = floor(grid);
    vec2 f = fract(grid) - 0.5 - (vec2(hash12(id), hash12(id + 7.0)) - 0.5) * 0.5;
    float size = 0.12 + 0.28 * hash12(id + 3.0);
    texture = step(length(f), size) * step(1.0 - density * 0.9, hash12(id + 11.0)) * 1.2;
  }
  int tone = int(uParams[27] + 0.5);
  inkTone = tone == 1 ? 1.0 : tone == 2 ? mod(band, 2.0) : 0.0;
  return inBand * texture * (0.6 + 0.4 * hash12(vec2(band, 5.0)));
}

// Orbit knobs: 0 stars, 1 twinkle, 2 scatter, 3 constellations, 4 lines, 5 mark, 6 meteors,
// 7 captures, 8 nebula, 9 drift, 10 planetX, 11 planetY, 12 planet, 13 clouds, 14 storms,
// 15 aurora, 16 daycycle, 17 moons, 18 eclipses, 19 ring, 20 ringCount, 21 ringSpacing,
// 22 ringInner, 23 ringWidth, 24 ringTilt, 25 ringRoll, 26 ringDensity, 27 ringTone,
// 28 ringTexture, 29 ringSpin.
Shade sceneOrbit(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) + uPointer * 0.012 * m;

  Shade o = blankShade();
  vec2 sky = p + vec2(tm * 0.006 * uParams[9], 0.0);
  o.ink = starfield(floor(sky * uRes.y), 0.001 + 0.009 * uParams[0], uParams[1], uParams[2]);
  o.ink += 0.16 * uParams[8] * smoothstep(0.5, 0.95, fbm(p * 1.8 + vec2(tm * 0.012 * uParams[9], 3.0)));
  o.accent = 0.08 * uParams[8] * smoothstep(0.55, 0.95, fbm(p * 2.4 + vec2(9.0, -tm * 0.008 * uParams[9])));
  if (uParams[3] > 0.5 || uParams[5] > 0.5) {
    vec2 figures = constellations(sky, aspect, px, uParams[3] > 0.5, uParams[4] > 0.5, uParams[5] > 0.5, tm);
    o.ink = max(o.ink, figures.x);
    o.accent = max(o.accent, figures.y * 0.6);
  }
  o.ink = max(o.ink, meteors(p, uParams[6], px, tm));

  float r = 1.12 * uParams[12];
  vec2 c = vec2(uParams[10] * aspect * 0.5, uParams[11]);
  vec2 dp = p - c;
  vec2 q = dp / r;
  float d = length(q);
  // The sun can circle the planet (day cycle), sweeping the terminator across it.
  vec3 L = normalize(vec3(-0.55, 0.75, 0.38));
  float sweep = tm * uParams[16] * 0.25;
  L = vec3(L.x * cos(sweep) + L.z * sin(sweep), L.y, -L.x * sin(sweep) + L.z * cos(sweep));
  float sunSide = smoothstep(-0.3, 0.7, dot(normalize(q), normalize(L.xy + 1e-4)));

  // Ring sample along this pixel's line of sight, with the planet's shadow across it.
  float ring = 0.0;
  float ringInk = 0.0;
  float ringZ = 0.0;
  vec3 n = ringNormal();
  if (uParams[19] > 0.5) {
    float z = -(n.x * dp.x + n.y * dp.y) / max(n.z, 0.02);
    vec3 point = vec3(dp, z) / r;
    ring = ringCover(point, n, tm, ringInk);
    if (dot(point, L) < 0.0 && length(point - dot(point, L) * L) < 1.0) ring *= 0.15;
    ringZ = z;
  }

  if (d < 1.0) {
    vec3 normal = vec3(q, sqrt(1.0 - d * d));
    float diff = max(dot(normal, L), 0.0);
    float lon = atan(normal.x, normal.z) + tm * 0.012;
    float bands = fbm(vec2(lon * 3.0, normal.y * 11.0));
    float rim = pow(1.0 - normal.z, 3.0);
    float limbSun = smoothstep(-0.2, 0.6, dot(normalize(q), normalize(L.xy + 1e-4)));
    float night = smoothstep(0.15, 0.0, diff);
    vec2 city = floor(vec2(lon * 90.0, normal.y * 140.0));
    float lights = step(0.992, hash12(city)) * night * step(0.5, uParams[32]);
    lights *= 1.0 - uParams[33] * m * (0.5 + 0.5 * sin(t * (1.0 + 3.0 * hash12(city + 7.0)) + hash12(city) * 40.0));
    o.ink = diff * diff * (0.2 + 0.6 * bands) * 0.85;
    o.accent = rim * limbSun * 1.4 + lights * 0.85;
    if (uParams[15] > 0.0) o.accent = max(o.accent, auroraOval(normal, uParams[31], tm) * mix(0.6, 1.0, night) * uParams[15] * 2.0);
    // Cloud decks drift faster than the surface and catch the light.
    float cloud = smoothstep(0.52, 0.72, fbm(vec2(lon * 4.0 + tm * 0.02, normal.y * 9.0) + vec2(5.0, 1.0)));
    o.ink = max(o.ink, cloud * uParams[13] * (0.15 + 0.8 * diff));
    // Storms: brief flashes inside the night-side clouds, each cell on its own clock.
    vec2 stormCell = floor(vec2(lon * 40.0, normal.y * 60.0));
    float burst = sinceTrigger(2) >= 0.0 ? 0.9 * (1.0 - smoothstep(1.5, 3.0, sinceTrigger(2))) : 0.0;
    float stormLevel = max(uParams[14] * step(0.001, m), burst);
    float strike = step(1.0 - 0.06 * stormLevel, hash12(stormCell + floor(t * 6.0 + hash12(stormCell) * 6.0)));
    float storm = strike * step(0.001, stormLevel) * (0.4 + 0.6 * cloud) * smoothstep(0.35, 0.0, diff);
    o.ink = max(o.ink, storm);
    o.shimmer = storm * 0.3;
    if (uParams[30] > 0.5) {
      // City lights on the night side, laid out as the M.
      vec2 at = (normal.xy + normalize(L.xy + 1e-4) * 0.45) / 0.3;
      vec2 town = floor(normal.xy * 180.0);
      float lit = step(0.6, hash12(town)) * (0.8 + 0.2 * hash12(town + 3.0));
      o.accent = max(o.accent, step(markDistance(at), 0.06) * lit * smoothstep(0.25, 0.0, diff));
    }
    // The rings' shadow bands across the surface.
    if (uParams[19] > 0.5) {
      float toward = dot(n, L);
      float s = -dot(n, normal) / (abs(toward) < 1e-3 ? 1e-3 : toward);
      float tone;
      if (s > 0.0) {
        float shadow = ringCover(normal + L * s, n, tm, tone);
        o.ink *= 1.0 - 0.75 * min(shadow * 1.3, 1.0);
      }
    }
    // Rings in front of the planet's surface cover it; rings behind it are hidden.
    float surfaceZ = sqrt(1.0 - d * d) * r;
    if (ring > 0.0 && ringZ < surfaceZ) ring = 0.0;
  } else {
    // Atmosphere glow. Ring material in front of the planet hides it; glow veils rings behind.
    float halo = exp(-(d - 1.0) * r * 26.0) * sunSide;
    float cover = min(ring * 1.4, 1.0);
    if (ringZ > 0.0) halo *= 1.0 - cover;
    else ring *= 1.0 - 0.8 * min(halo, 1.0);
    if (uParams[15] > 0.0) {
      // Where the oval meets the horizon its curtains rise into space.
      float height = d - 1.0;
      float curtain = auroraOval(vec3(q / d, 0.0), uParams[31], tm) * exp(-height / 0.06) * smoothstep(0.0, 0.008, height);
      halo += curtain * uParams[15] * 1.2;
    }
    o.accent += halo * 0.9;
    o.ink *= 1.0 - min(halo, 1.0);
  }
  if (ring > 0.0) {
    float opacity = min(ring * 1.4, 1.0);
    o.ink *= 1.0 - opacity;
    o.accent *= 1.0 - opacity;
    if (ringInk > 0.5) o.ink = max(o.ink, ring * 0.8);
    else o.accent = max(o.accent, ring * 0.75);
  }

  // Moons on inclined orbits: they rise from behind the planet, cross the sky and set again,
  // and can cast their shadow onto it.
  for (int i = 0; i < 3; i++) {
    if (float(i) >= uParams[17]) break;
    float fi = float(i);
    float size = (0.016 + 0.01 * fi) * uParams[12];
    vec3 moon = inclined(tm * (0.06 - 0.014 * fi) + 1.2 + fi * 0.9, r * (1.2 + 0.18 * fi), 0.9 - 0.1 * fi, -0.15 + 0.15 * fi);
    if (uParams[18] > 0.5 && d < 1.0) {
      float toward = dot(moon, L);
      float disc = toward * toward - dot(moon, moon) + r * r;
      if (toward > 0.0 && disc > 0.0) {
        vec3 hit = moon - L * (toward - sqrt(disc));
        float shade = smoothstep(size * 1.25, size * 0.8, length(dp - hit.xy));
        if (hit.z > 0.0) { o.ink *= 1.0 - 0.9 * shade; o.accent *= 1.0 - 0.6 * shade; }
      }
    }
    vec2 mq = (dp - moon.xy) / size;
    float md = length(mq);
    if (md < 1.0 && !behindPlanet(moon, r)) {
      vec3 mn = vec3(mq, sqrt(1.0 - md * md));
      float lit = max(dot(mn, L), 0.0);
      o.ink = 0.08 + 0.85 * lit * (0.7 + 0.3 * vnoise(mq * 4.0 + fi * 9.0));
      o.accent = 0.0;
    }
  }

  vec2 meteor = captured(dp, r, tm, uParams[7], px);
  o.ink = max(o.ink, meteor.x);
  o.accent = max(o.accent, meteor.y);

  o.rgb = uBg + uInk * o.ink + uAccent * o.accent;
  o.source = o.rgb;
  return o;
}
`;

const swell = `
float swellHeight(vec2 w, float t, float chop) {
  float s = 0.0;
  s += sin(dot(w, vec2(0.9, 0.42)) * 1.3 + t * 1.05) * 0.5;
  s += sin(dot(w, vec2(-0.55, 0.83)) * 2.1 + t * 1.45) * 0.25;
  s += sin(dot(w, vec2(0.18, 0.98)) * 3.7 + t * 2.05) * 0.12 * chop;
  s += (fbm(w * 1.4 + vec2(t * 0.18, t * 0.1)) - 0.5) * 0.35 * chop;
  return s;
}

// Swell knobs: 0 height, 1 chop, 2 moon, 3 stars.
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

  Shade o = blankShade();
  if (p.y > horizon) {
    float md = length(p - moon);
    float disc = smoothstep(moonRadius, moonRadius - 0.003, md);
    float craters = fbm((p - moon) * 30.0);
    float maria = uParams[4] > 0.5 ? smoothstep(0.11, 0.07, markDistance((p - moon) / moonRadius / 1.3)) : 0.0;
    o.ink = disc * (0.7 + 0.3 * craters) * (1.0 - 0.6 * maria) + exp(-md * 12.0 * 0.075 / moonRadius) * 0.16;
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

const pond = `
// One layer of animated cellular light: bright where neighbouring cells meet.
float causticLayer(vec2 x, float t) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.1));
      o = 0.5 + 0.45 * sin(t + TAU * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return 1.0 - smoothstep(0.0, 0.06, f2 - f1);
}

// Pebble floor: cells with dark seams, each stone its own shade. Returns brightness.
float pebbles(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  float shade = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      vec2 o = 0.15 + 0.7 * vec2(hash12(i + g + 3.1), hash12(i + g + 8.7));
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; shade = hash12(i + g + 1.3); } else if (d < f2) { f2 = d; }
    }
  }
  return smoothstep(0.02, 0.12, f2 - f1) * (0.35 + 0.65 * shade) * (1.0 - 0.5 * f1);
}

// Smooth looping swim path for koi number i at path time s.
vec2 koiPath(float i, float s, float aspect) {
  float a = 0.13 + 0.07 * hash12(vec2(i, 1.0));
  float b = 0.11 + 0.08 * hash12(vec2(i, 2.0));
  float ph = hash12(vec2(i, 3.0)) * TAU;
  return vec2(
    sin(s * a + ph) * 0.42 * aspect + sin(s * a * 2.3 + ph * 1.7) * 0.12,
    sin(s * b + ph * 0.7) * 0.34 + cos(s * b * 1.9 + ph) * 0.1
  );
}

// Where koi i is: its own loop, pulled toward the lure, or (in formation) gliding along the M.
vec2 koiAt(float i, float s, float aspect, vec2 lure, float follow, float formation, float count) {
  vec2 free = mix(koiPath(i, s, aspect), lure + (vec2(hash12(vec2(i, 4.0)), hash12(vec2(i, 5.0))) - 0.5) * 0.25, follow);
  vec2 inLine = markPoint(fract((i + 0.5) / count + s * 0.012)) * 0.82;
  return mix(free, inLine, formation);
}

// 0..1 presence of a koi formation that started 'tau' seconds ago (12 s long).
float formationWindow(float tau) {
  return tau < 0.0 ? 0.0 : smoothstep(0.0, 2.5, tau) * smoothstep(12.0, 9.5, tau);
}

// Distance-like test for a koi in its own frame (x forward from the nose, y across).
// Returns 0 outside, 1 on the body, 2 on a fin.
float koiShape(vec2 q, float len, float swim) {
  float u = (0.3 * len - q.x) / len; // 0 at the nose, 1 at the tail tip
  if (u < 0.0 || u > 1.05) return 0.0;
  q.y -= len * 0.09 * sin(u * 5.0 - swim) * u * u;
  float body = len * 0.17 * pow(sin(3.14159 * clamp(u / 0.74, 0.0, 1.0)), 0.6) * (1.0 - 0.35 * u);
  if (u < 0.74 && abs(q.y) < body) return 1.0;
  float tail = len * (0.04 + 0.2 * smoothstep(0.7, 1.02, u));
  bool notch = u > 0.95 && abs(q.y) < (u - 0.95) * len * 0.9;
  if (u > 0.68 && abs(q.y) < tail && !notch) return 2.0;
  vec2 fin = vec2((u - 0.26) / 0.07, (abs(q.y) - len * 0.2) / (len * 0.06));
  if (dot(fin, fin) < 1.0) return 2.0;
  return 0.0;
}

// Pond knobs: 0 koi, 1 swim, 2 follow, 3 caustics, 4 rays, 5 lilies, 6 ripples, 7 depth, 8 stones.
Shade scenePond(vec2 uv, vec2 cell, float t) {
  float m = uMotion;
  float tm = t * m;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float depth = uParams[7];
  Shade o = blankShade();

  // Surface: rings spreading from drops, used for refraction and glints.
  float surface = 0.0;
  float ringLight = 0.0;
  if (uParams[6] > 0.0) {
    vec2 grid = p / 0.28;
    for (int y = -1; y <= 1; y++) {
      for (int k = -1; k <= 1; k++) {
        vec2 id = floor(grid) + vec2(float(k), float(y));
        float slot = mix(9.0, 2.2, uParams[6]);
        float kk = tm / slot + hash12(id);
        float age = fract(kk) * slot;
        vec2 drop = (id + vec2(hash12(id + floor(kk)), hash12(id + floor(kk) + 4.0))) * 0.28;
        float dist = length(p - drop);
        float radius = age * 0.07;
        float fade = exp(-age * 1.1) * step(0.3, hash12(id + floor(kk) * 3.1));
        float wave = sin((dist - radius) * 160.0) * exp(-pow((dist - radius) / 0.012, 2.0)) * fade;
        surface += wave;
        ringLight = max(ringLight, smoothstep(0.004, 0.0, abs(dist - radius)) * fade + smoothstep(0.003, 0.0, abs(dist - radius * 0.6)) * fade * 0.6);
      }
    }
  }
  // "now": one drop at a random spot.
  float dropAge = sinceTrigger(0);
  if (dropAge >= 0.0 && dropAge < 5.0) {
    vec2 drop = (vec2(hash12(vec2(uTriggers[0], 1.0)), hash12(vec2(uTriggers[0], 2.0))) - 0.5) * vec2(aspect * 0.7, 0.7);
    float dist = length(p - drop);
    float radius = dropAge * 0.07;
    float fade = exp(-dropAge * 0.9);
    surface += sin((dist - radius) * 160.0) * exp(-pow((dist - radius) / 0.012, 2.0)) * fade;
    ringLight = max(ringLight, (smoothstep(0.004, 0.0, abs(dist - radius)) + 0.6 * smoothstep(0.003, 0.0, abs(dist - radius * 0.6))) * fade);
  }
  vec2 refract = vec2(dFdx(surface), dFdy(surface)) * 0.01 + vec2(sin(p.y * 9.0 + tm * 0.7), cos(p.x * 8.0 + tm * 0.6)) * 0.0025 * m;
  vec2 floorP = p + refract;

  // Floor: pebbles or silt, dimmer when deep.
  float floorLight = uParams[8] > 0.5 ? pebbles(floorP * 22.0) * 0.14 : 0.04 + 0.05 * fbm(floorP * 9.0);
  if (uParams[9] > 0.5) {
    // Flat stepping stones laid along the M.
    for (int i = 0; i < 26; i++) {
      vec2 stone = markPoint(float(i) / 25.0) * 0.72 + vec2(0.006 * sin(float(i) * 4.1), 0.006 * sin(float(i) * 2.7));
      vec2 d = floorP - stone;
      float edge = 0.026 + 0.006 * (vnoise(d * 60.0 + float(i) * 7.0) - 0.5) + 0.004 * hash12(vec2(float(i), 2.0));
      float r = length(d * vec2(1.0, 1.15));
      if (r < edge) floorLight = (0.3 + 0.1 * vnoise(d * 120.0)) * smoothstep(edge, edge * 0.8, r) + 0.06;
    }
  }
  floorLight *= 1.0 - depth * 0.6;
  float caustic = 0.0;
  if (uParams[3] > 0.0) {
    // Two drifting layers; light gathers where their seams cross.
    float a = causticLayer(floorP * 4.2 + vec2(tm * 0.03, 0.0), tm * 0.7);
    float b = causticLayer(floorP * 5.6 + vec2(4.0, -tm * 0.025), tm * 0.9 + 2.0);
    caustic = (a * 0.3 + b * 0.2 + a * b * 0.9) * uParams[3] * (1.0 - depth * 0.45);
  }

  // Koi, their shadows on the floor, and the lure when they follow the pointer.
  int count = int(uParams[0] + 0.5);
  vec2 lure = uPointer * vec2(aspect * 0.5, 0.5);
  float follow = uParams[2] > 0.5 ? 0.55 : 0.0;
  float swimTime = tm * (0.6 + 2.4 * uParams[1]);
  float formation = formationWindow(sinceTrigger(1));
  if (uParams[10] > 0.0) {
    float period = mix(70.0, 20.0, uParams[10]);
    formation = max(formation, formationWindow(mod(tm, period)));
  }
  float shadow = 0.0;
  float fish = 0.0;
  float fishAccent = 0.0;
  vec2 shadowOffset = vec2(0.015, -0.03) * (0.4 + 1.2 * depth);
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float fi = float(i);
    float s = swimTime + fi * 11.0;
    vec2 pos = koiAt(fi, s, aspect, lure, follow, formation, float(count));
    vec2 dir = normalize(koiAt(fi, s + 0.05, aspect, lure, follow, formation, float(count)) - koiAt(fi, s - 0.05, aspect, lure, follow, formation, float(count)) + 1e-5);
    vec2 side = vec2(-dir.y, dir.x);
    float len = 0.11 + 0.06 * hash12(vec2(fi, 6.0));
    float swim = tm * (3.0 + 4.0 * uParams[1]) + fi;
    vec2 rel = p - pos;
    vec2 q = vec2(dot(rel, dir), dot(rel, side));
    vec2 rs = rel - shadowOffset;
    shadow = max(shadow, step(0.5, koiShape(vec2(dot(rs, dir), dot(rs, side)), len, swim)));
    float shape = koiShape(q, len, swim);
    if (shape > 0.0) {
      float u = (0.3 * len - q.x) / len;
      float style = hash12(vec2(fi, 9.0));
      float marking = vnoise(vec2(u * 4.0, q.y / len * 6.0) + fi * 13.0);
      bool orange = style > 0.75 ? true : style > 0.2 ? marking > 0.5 : marking > 0.72;
      if (shape > 1.5) { fish = 0.45; fishAccent = 0.0; }
      else { fish = orange ? 0.0 : 0.92; fishAccent = orange ? 0.95 : 0.0; }
      // Eyes, set wide on the head as seen from above.
      if (abs(u - 0.07) < 0.025 && abs(abs(q.y) - len * 0.085) < len * 0.03) { fish = 0.0; fishAccent = 0.0; }
    }
  }

  // Lily pads float above everything, slowly turning; some carry a flower.
  float pad = 0.0;
  float padShadow = 0.0;
  float flower = 0.0;
  int pads = int(uParams[5] * 9.0 + 0.5);
  for (int i = 0; i < 9; i++) {
    if (i >= pads) break;
    float fi = float(i);
    vec2 centre = (vec2(hash12(vec2(fi, 21.0)), hash12(vec2(fi, 22.0))) - 0.5) * vec2(aspect * 0.9, 0.85);
    centre += vec2(sin(tm * 0.07 + fi), cos(tm * 0.05 + fi * 2.0)) * 0.012;
    float radius = 0.045 + 0.05 * hash12(vec2(fi, 23.0));
    vec2 d = rotate(p - centre, -(tm * 0.02 + fi * 1.7));
    float notch = abs(atan(d.y, d.x)) < 0.16 && length(d) > radius * 0.08 ? 1.0 : 0.0;
    float inside = step(length(d), radius) * (1.0 - notch);
    float veins = smoothstep(0.06, 0.0, abs(sin(atan(d.y, d.x) * 8.0))) * smoothstep(radius * 0.1, radius * 0.3, length(d));
    float rim = smoothstep(radius * 0.86, radius * 0.97, length(d));
    pad = max(pad, inside * (0.22 + 0.12 * veins + 0.45 * rim));
    vec2 ds = p - centre - shadowOffset * 0.6;
    padShadow = max(padShadow, step(length(ds), radius));
    if (hash12(vec2(fi, 24.0)) > 0.6) {
      vec2 f = rotate(p - centre - vec2(radius * 0.25, radius * 0.1), tm * 0.05);
      float fr = radius * 0.32;
      float petals = fr * (0.55 + 0.45 * abs(cos(atan(f.y, f.x) * 4.0)));
      flower = max(flower, step(length(f), petals) * (length(f) < fr * 0.25 ? 2.0 : 1.0));
    }
  }

  // Slanted sunbeams through the water.
  float rays = 0.0;
  if (uParams[4] > 0.0) {
    vec2 across = normalize(vec2(1.0, 0.55));
    float x = dot(p, across);
    rays = smoothstep(0.55, 0.95, vnoise(vec2(x * 7.0 + tm * 0.04, tm * 0.05))) * smoothstep(-0.6, 0.6, dot(p, vec2(-0.55, 1.0)));
    rays *= uParams[4] * 0.3;
  }

  float floorTotal = (floorLight + caustic) * (1.0 - 0.85 * max(shadow, padShadow * 0.8));
  o.ink = floorTotal + rays;
  o.accent = 0.0;
  if (fish > 0.0 || fishAccent > 0.0) {
    o.ink = fish + caustic * 0.25;
    o.accent = fishAccent;
  }
  if (pad > 0.0) { o.ink = pad; o.accent = 0.0; }
  if (flower > 0.0) { o.ink = flower > 1.5 ? 0.0 : 0.95; o.accent = flower > 1.5 ? 0.9 : 0.0; }
  o.ink = max(o.ink, ringLight * 0.7);
  o.shimmer = caustic * 0.15 * m;
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
  else if (uScene == 3) s = sceneSwell(uv, t);
  else s = scenePond(uv, cell, t);

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

export const fragmentSource = common + paintings + orbit + swell + pond + main;
