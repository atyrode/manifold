// The lamp's code (src/engine/glsl.ts, the kind contract): its foot and stem are capped upright
// cylinders, its bulb a sphere on top that glows (its emission, the cell's accent); its light sits
// at the bulb's centre, its colour by its warmth, its power flickering on the motion clock by its
// flicker, each lamp out of step with the others.
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { LAMP_BULB, LAMP_FOOT } from "./index.ts";

export const glsl: KindCode["glsl"] = () => `
const float LAMP_FOOT = ${glslFloat(LAMP_FOOT)};
const float LAMP_FOOT_TOP = 0.025;
const float LAMP_STEM = 0.012;
const float LAMP_BULB = ${glslFloat(LAMP_BULB)};
// The light's reach, metres: it falls to half there.
const float LAMP_REACH = 2.5;

// The upright cylinder of radius r from y = 0 to top, its top capped: t (else -1) and its normal.
float lampCylinder(vec3 ro, vec3 rd, float r, float top, out vec3 n) {
  float t = -1.0;
  n = vec3(0.0, 1.0, 0.0);
  float a = dot(rd.xz, rd.xz);
  float b = dot(ro.xz, rd.xz);
  float disc = b * b - a * (dot(ro.xz, ro.xz) - r * r);
  if (disc >= 0.0 && a > 1e-9) {
    float s = (-b - sqrt(disc)) / a;
    float y = ro.y + rd.y * s;
    if (s > 0.0 && y >= 0.0 && y <= top) {
      t = s;
      vec2 side = (ro.xz + rd.xz * s) / r;
      n = vec3(side.x, 0.0, side.y);
    }
  }
  if (rd.y < 0.0) {
    float s = (top - ro.y) / rd.y;
    vec2 xz = ro.xz + rd.xz * s;
    if (s > 0.0 && dot(xz, xz) <= r * r && (t < 0.0 || s < t)) {
      t = s;
      n = vec3(0.0, 1.0, 0.0);
    }
  }
  return t;
}

vec3 lampColour(EngineObj o) {
  return mix(vec3(0.82, 0.9, 1.0), vec3(1.0, 0.6, 0.26), lampWarmth(o));
}

// Its power now: steady, or flickering on the motion clock, out of step with every other lamp.
float lampGlow(EngineObj o) {
  float n = vnoise(vec2(uMotionTime * 8.0, o.at.x * 3.1 + o.at.z * 1.7));
  return lampPower(o) * (1.0 - lampFlicker(o) * 0.6 * n);
}

float lampHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float h = lampHeight(o);
  vec3 m;
  float t = lampCylinder(ro, rd, LAMP_FOOT, LAMP_FOOT_TOP, n);
  part = 0.0;
  float s = lampCylinder(ro, rd, LAMP_STEM, h, m);
  if (s > 0.0 && (t < 0.0 || s < t)) {
    t = s;
    n = m;
    part = 1.0;
  }
  vec3 oc = ro - vec3(0.0, h + LAMP_BULB, 0.0);
  float b = dot(oc, rd);
  float disc = b * b - dot(oc, oc) + LAMP_BULB * LAMP_BULB;
  s = disc < 0.0 ? -1.0 : -b - sqrt(disc);
  if (s > 0.0 && (t < 0.0 || s < t)) {
    t = s;
    n = normalize(oc + rd * s);
    part = 2.0;
  }
  return t >= span.x && t <= span.y ? t : -1.0;
}

void lampSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  if (part > 1.5) {
    h.albedo = vec3(0.9);
    h.emit = lampColour(o) * (0.35 + 0.65 * min(lampGlow(o), 1.5) / 1.5);
    h.rough = 0.2;
    h.mat = 1;
  } else {
    h.albedo = vec3(0.09, 0.085, 0.08);
    h.rough = 0.35;
    h.mat = 0;
  }
}

EngineLight lampLight(EngineObj o) {
  return EngineLight(vec3(0.0, lampHeight(o) + LAMP_BULB, 0.0), lampColour(o) * lampGlow(o), LAMP_REACH);
}
`;
