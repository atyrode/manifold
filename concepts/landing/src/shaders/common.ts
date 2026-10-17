// Shared preamble: uniforms, hashing and noise, the dither threshold and hard edges, ink and the
// Shade, SDF primitives, the Manifold mark. The helpers that read no uniform are also exported on
// their own as `gpuCommonGlsl`, for GPU simulation passes, which do not get this preamble.

import { markGlsl } from "../mark.ts";
import { MAX_PARAMS, MAX_TRIGGERS } from "../params.ts";

/**
 * The preamble's GLSL helpers that read no uniform: hashing, value noise, band-limited fbm,
 * rotation, smoothfall, SDF and coverage primitives, height-texture gradients and the Manifold
 * mark. Every scene program has them through `common`. A `gpu.pass` or `gpu.scatter` body
 * (sims/gpu.ts) prepends them to use them in a GPU simulation: `gpu.pass(gpuCommonGlsl + body)`.
 * They declare no uniform or define; the only globals are the mark's vertices `M0`..`M4`.
 */
export const gpuCommonGlsl = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Two independent 0..1 hashes of p (Hoskins, "Hash without Sine", the family of hash12). It is not
// vec2(hash12(a), hash12(b)): putting it in place of such a pair moves every seeded position.
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// vnoise's lattice values round its cell i (floor of the point): x at i, y at i + (1, 0), z at
// i + (0, 1), w at i + (1, 1). A loop that steps across the lattice can carry them from point to
// point (vnoiseLatticeNext) instead of hashing every cell again.
vec4 vnoiseLattice(vec2 i) {
  return vec4(hash12(i), hash12(i + vec2(1.0, 0.0)), hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)));
}

// The lattice values of cell i from those of the cell before it in x (i - (1, 0)): two hashes, not four.
vec4 vnoiseLatticeNext(vec4 before, vec2 i) {
  return vec4(before.y, hash12(i + vec2(1.0, 0.0)), before.w, hash12(i + vec2(1.0, 1.0)));
}

// vnoise at the point f = fract(p) within its cell, from the cell's lattice values (vnoiseLattice).
float vnoiseFrom(vec4 lattice, vec2 f) {
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lattice.x, lattice.y, u.x), mix(lattice.z, lattice.w, u.x), u.y);
}

float vnoise(vec2 p) {
  return vnoiseFrom(vnoiseLattice(floor(p)), fract(p));
}

// vnoise (the same lattice, so the same values) with its gradient: x the value, y d/dp.x, z d/dp.y.
vec3 vnoiseD(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return vec3(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(b - a, d - c, u.y) * du.x, mix(c - a, d - b, u.x) * du.y);
}

// Value noise along x alone, one independent lane per seed (half the cost of vnoise): x the value
// 0..1, y its derivative d/dx.
vec2 vnoise1(float x, float seed) {
  float i = floor(x);
  float f = x - i;
  float a = hash12(vec2(i, seed));
  float b = hash12(vec2(i + 1.0, seed));
  return vec2(mix(a, b, f * f * (3.0 - 2.0 * f)), (b - a) * 6.0 * f * (1.0 - f));
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

// Three octaves of value noise, 0..1, for layers that do not need fbm's finest detail.
float fbm3(vec2 p) {
  return (0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + vec2(17.1, 9.2)) + 0.125 * vnoise(p * 4.11 + vec2(4.3, 31.7))) / 0.875;
}

// Band-limited fbm, for texture that moves under the dither: 'octaves' octaves (1 or more) of value
// noise, each 2.03 times finer, each fading to its mean 0.5 as its lattice shrinks from 4 to 2
// cells across, so detail finer than the cells never crawls. foot: one cell's size in p units (the
// larger side of an anisotropic footprint; scale it up where the texture travels fast). x: the
// noise, 0..1 with mean 0.5; y: the share of its detail kept (1 up close, 0 where all of it is finer
// than a cell), for instance to soften a threshold on the noise where it no longer resolves.
vec2 fbmLod(vec2 p, float foot, int octaves) {
  float s = 0.0;
  float kept = 0.0;
  float total = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < octaves; i++) {
    float keep = 1.0 - smoothstep(0.25, 0.5, foot * f);
    s += a * (keep > 0.0 ? mix(0.5, vnoise(p * f + float(i) * vec2(17.1, 9.2)), keep) : 0.5);
    kept += a * keep;
    total += a;
    f *= 2.03;
    a *= 0.5;
  }
  return vec2(s, kept) / total;
}

vec2 rotate(vec2 v, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

vec2 rotateAbout(vec2 p, vec2 pivot, float angle) {
  return pivot + rotate(p - pivot, angle);
}

// 1 at x <= b falling smoothly to 0 at x >= a, for a > b: the reversed smoothstep(a, b, x), which
// GLSL ES leaves undefined, spelled so it is defined. Same arguments in the same order.
float smoothfall(float a, float b, float x) {
  return 1.0 - smoothstep(b, a, x);
}

// Coverage of the inside (d < 0) of a signed distance, softened over -aa..aa.
float softFill(float d, float aa) {
  return 1.0 - smoothstep(-aa, aa, d);
}

// The Gaussian bell: 1 at 0, 1/e at x = +-1.
float bell(float x) {
  return exp(-x * x);
}

// The polynomial smooth minimum (Quilez): min(a, b) with the corner rounded over a blend k wide, so
// shapes melt into one another instead of meeting at a crease.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Signed distance to a box centred on the origin with half extents halfSize, its corners rounded
// by r within that extent (r = 0: sharp corners).
float sdBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// Signed distance to a capsule from a to b whose radius tapers from ra at a to rb at b; t returns
// where along a..b (0..1) the nearest point of the axis lies. The radius is taken at that point:
// exact for ra = rb, close for gentle tapers.
float sdTaperCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb, out float t) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t) - mix(ra, rb, t);
}

float sdTaperCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  float t;
  return sdTaperCapsule(p, a, b, ra, rb, t);
}

// Signed distance to an ellipse centred on the origin with radii r: the scaled radial distance
// inside (smooth all the way to the centre) and Quilez's gradient-normalised estimate outside.
// Close to exact near the outline, where coverage is decided.
float sdEllipse(vec2 p, vec2 r) {
  float k0 = length(p / r);
  if (k0 < 1.0) return (k0 - 1.0) * min(r.x, r.y);
  return k0 * (k0 - 1.0) / length(p / (r * r));
}

// A height texture's red channel at uv and its gradient by central differences a texel either
// side: x the height, y dh/du, z dh/dv (per uv unit: multiply by texel for the slope per texel,
// divide y by the aspect for x in view heights).
vec3 heightGrad(sampler2D h, vec2 uv, vec2 texel) {
  float e = texture(h, uv + vec2(texel.x, 0.0)).r;
  float w = texture(h, uv - vec2(texel.x, 0.0)).r;
  float n = texture(h, uv + vec2(0.0, texel.y)).r;
  float s = texture(h, uv - vec2(0.0, texel.y)).r;
  return vec3(texture(h, uv).r, (e - w) / (2.0 * texel.x), (n - s) / (2.0 * texel.y));
}
${markGlsl}`;

export const common = `#version 300 es
precision highp float;
// Fragment shaders default to mediump int and lowp sampler2D: where those are fp16 (Mali, ANGLE on
// Vulkan), a 32-bit sim texture would be read at half precision.
precision highp int;
precision highp sampler2D;

#define MAX_PARAMS ${MAX_PARAMS}
#define MAX_CON_STARS 48
#define MAX_CON_LINES 48
#define MAX_TRIGGERS ${MAX_TRIGGERS}
#define TAU 6.2831853

uniform vec2 uRes;
uniform float uTime;
uniform int uDither;     // 0 bayer8, 1 bayer4, 2 interleaved gradient noise, 3 none
uniform int uColor;      // 0 accent, 1 mono, 2 full
uniform int uView;       // 0 dithered, 1 source, 2 split (source left)
uniform float uLevels;
uniform float uMotion;
uniform float uMotionTime; // the scene clock integrated with motion (seconds of motion-scaled time): no jump when uMotion changes
uniform float uFallTime;   // the scene clock integrated with min(1, 2.5 uMotion): gravity's clock, real time once motion is above 0.4
uniform vec2 uPointer;   // -1..1, smoothed
uniform vec4 uMouse;     // raw pointer: xy in uv (y up), z 1 while pressed, w uTime of the last press (-1e4: none)
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uParams[MAX_PARAMS];
uniform vec4 uConStars[MAX_CON_STARS]; // anchor (half-width fraction, y), offset
uniform float uConBright[MAX_CON_STARS];
uniform vec2 uConLines[MAX_CON_LINES];
uniform int uConStarCount;
uniform int uConLineCount;
uniform int uConMarkStar;  // first star / line of the Manifold asterism
uniform int uConMarkLine;
uniform float uTriggers[MAX_TRIGGERS]; // uTime when each "now" button fired
uniform float uMotionTriggers[MAX_TRIGGERS]; // uMotionTime when each "now" button fired
uniform sampler2D uSim0;  // the scene simulation's textures (see scenes/types.ts SceneSim)
uniform sampler2D uSim1;
uniform sampler2D uSim2;
uniform sampler2D uSim3;
uniform vec4 uSimOn;      // 1 in each component whose uSim texture the simulation supplied
uniform vec2 uWeather;    // x: how wet the world is 0..1 (rises while it rains, dries after); y: how much snow lies 0..1 (settles while it snows, melts after)
uniform vec2 uPassage;    // x: how far the scene has come in 0..1 (1 once arrived, and with passages off); y: how far it has gone out 0..1 (0 unless leaving)
uniform vec3 uDissolve;   // x: share of the outgoing picture still showing 1..0; y: 1 when that is the leaving scene (uLeaving), 0 for the bare page (uBg); z: blend (renderer's blendIds)
uniform sampler2D uLeaving; // the leaving scene, drawn this frame at its own cell size

out vec4 outColor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
${gpuCommonGlsl}
// Only each coordinate's parity counts: reduced to it first, the product a.y * a.y stays exact in
// float32 on every row (unreduced, it went wrong from row 2365 on).
float bayer2(vec2 a) { a = mod(floor(a), 2.0); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
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

// Hard edges. A soft edge that moves steps through the palette levels, each colour channel at its
// own moment, and flickers. Cut it per cell instead: compare its coverage with a threshold from the
// lab's dither pattern, so a passing edge flips each cell once and the coverage still reads as the
// share of cells covered.

// This cell's dither threshold, threshold(cell): main() sets it before the scene's entry runs.
// Read it; never write it.
float cellTh;

// A threshold for a second, decorrelated edge layer: offset moves it to another cell of the dither
// pattern. Kept within 0.004..0.996, so cover 0 never shows and cover 1 always does, whichever
// way it is compared.
float edgeThreshold(vec2 cell, vec2 offset) {
  return 0.004 + 0.992 * threshold(cell + offset);
}

// 1 where cover exceeds the threshold th, else 0; without th, against cellTh.
float hardEdge(float cover, float th) {
  return cover > th ? 1.0 : 0.0;
}

float hardEdge(float cover) {
  return hardEdge(cover, cellTh);
}

// The inside (d < 0) of a signed distance, cut per cell: hardEdge(softFill(d, aa), th).
float hardFill(float d, float aa, float th) {
  return hardEdge(softFill(d, aa), th);
}

float hardFill(float d, float aa) {
  return hardFill(d, aa, cellTh);
}

// c snapped per channel to the nearest palette level.
vec3 snapLevel(vec3 c) {
  float n = max(uLevels - 1.0, 1.0);
  return floor(clamp(c, 0.0, 1.0) * n + 0.5) / n;
}

// Light of brightness b (0..1) in the hue of tint, drawn whole: rgb is palette level k = round(b * n)
// times tint, snapped per channel, so no channel rounds off on its own into a stray hue; a is
// hardEdge(cover, th). Fainter than the first level, level 1 shows on a share b * n * 2 of the
// covered cells: a sparse, still stipple.
vec4 hardRamp(float b, float cover, vec3 tint, float th) {
  float n = max(uLevels - 1.0, 1.0);
  float k = floor(clamp(b, 0.0, 1.0) * n + 0.5);
  float alpha = cover;
  if (k < 0.5) {
    alpha *= b * n * 2.0;
    k = 1.0;
  }
  return vec4(floor(k * tint + 0.5) / n, hardEdge(alpha, th));
}

// Mostly steady stars that dim now and then. 'twinkle' sets the rate (0 = steady); 'scatter'
// spreads rates and phases and shortens the dips so stars flicker independently. The twinkle runs
// on the motion clock (uMotionTime) and its dips deepen with the motion: still stars at motion 0.
float starfield(vec2 cell, float density, float twinkle, float scatter) {
  float h = hash12(cell);
  float on = step(1.0 - density, h);
  float h2 = fract(h * 431.7);
  float h3 = fract(h * 719.3);
  float rate = (0.15 + 2.5 * twinkle) * mix(1.0, 0.25 + 1.75 * h2, scatter);
  float wave = 0.5 + 0.5 * sin(uMotionTime * rate + h3 * TAU * (1.0 + 9.0 * scatter));
  float dip = pow(wave, mix(1.0, 9.0, scatter)) * step(0.001, twinkle);
  return on * (1.0 - 0.75 * dip * uMotion) * (0.4 + 0.6 * fract(h * 97.0));
}

// Seconds since a "now" button fired (negative or huge when idle).
float sinceTrigger(int slot) {
  return uTime - uTriggers[slot];
}

// Motion seconds (uMotionTime) since a "now" button fired: for a response that plays at the motion's
// pace, as the scene's own events on uMotionTime do. Huge while the slot is idle (uTriggers -1e4).
float sinceTriggerM(int slot) {
  return uTriggers[slot] < -1000.0 ? 1e4 : uMotionTime - uMotionTriggers[slot];
}

// A scene's entrance and exit (scenes/types.ts SceneDef.passage), linear in real time: ease them.
float passageIn() {
  return uPassage.x;
}
float passageOut() {
  return uPassage.y;
}

// An entrance's ease-out with an overshoot: 0 at x = 0 and moving fastest there (slope s + 3),
// running past 1 by 4s³ / (27 (s + 1)²) (about 5% at s = 1.2) and braking to rest on exactly 1 from
// x = 1: 1 + (s + 1) u³ + s u², u = clamp(x, 0, 1) - 1.
float passageSettle(float x, float s) {
  float u = clamp(x, 0.0, 1.0) - 1.0;
  return 1.0 + (s + 1.0) * u * u * u + s * u * u;
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

// Whether the page shows its paper theme (the scene's theme chose "paper"). It reads the page's
// own background, so the shader can never disagree with the page.
bool pagePaper() {
  return dot(uBg, LUMA) > 0.5;
}

// Ink coverage for a final colour. On paper ink is dark: clamp((white - lum) / range) with
// paper = (white, range). At night ink is light: clamp(gain * lum^gamma), lum floored at 0 (pow of
// a negative is undefined) and gamma 1 taken without pow (which is not exact). Without paper,
// white 0.9 and range 0.8.
float inkOf(vec3 col, float gain, float gamma, vec2 paper) {
  float lum = dot(col, LUMA);
  if (pagePaper()) return clamp((paper.x - lum) / paper.y, 0.0, 1.0);
  float l = max(lum, 0.0);
  return clamp(gain * (gamma == 1.0 ? l : pow(l, gamma)), 0.0, 1.0);
}

float inkOf(vec3 col, float gain, float gamma) {
  return inkOf(col, gain, gamma, vec2(0.9, 0.8));
}

// A scene's result: col as both the full-colour rendition and the source, the given ink and
// accent coverage, no shimmer. Typically shadeOf(col, inkOf(col, 1.3, 0.8), accent).
Shade shadeOf(vec3 col, float ink, float accent) {
  Shade o = blankShade();
  o.ink = ink;
  o.accent = accent;
  o.rgb = col;
  o.source = col;
  return o;
}
`;
