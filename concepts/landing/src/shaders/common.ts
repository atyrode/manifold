// Shared preamble: uniforms, hashing and noise, the Manifold mark.

import { MAX_PARAMS, MAX_TRIGGERS } from "../params.ts";

export const common = `#version 300 es
precision highp float;

#define MAX_STARS 16
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
uniform vec2 uPointer;   // -1..1, smoothed
uniform vec4 uMouse;     // raw pointer: xy in uv (y up), z 1 while pressed, w uTime of the last press (-1e4: none)
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
uniform sampler2D uSim0;  // the scene simulation's textures (see scenes/types.ts SceneSim)
uniform sampler2D uSim1;
uniform sampler2D uSim2;
uniform sampler2D uSim3;
uniform vec4 uSimOn;      // 1 in each component whose uSim texture the simulation supplied

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
