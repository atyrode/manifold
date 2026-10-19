// The block's code (src/engine/glsl.ts, the kind contract): the box is its bounds, so its hit is the
// slab's entry and the face it came in through; it blocks every shadow ray that crosses it; its
// surface a material laid out on each face in metres: courses and joints that fade into the
// material's tone once a cell spans them.
import { glslVec3 } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { BLOCK_MATERIALS } from "./index.ts";

/** Each material: its tone, its joints' tone, its units' size (across, up) and course shift. */
const MATERIALS: Readonly<
  Record<
    (typeof BLOCK_MATERIALS)[number],
    {
      readonly albedo: readonly [number, number, number];
      readonly joint: readonly [number, number, number];
      readonly unit: readonly [number, number];
      readonly shift: number;
      readonly rough: number;
    }
  >
> = {
  plaster: { albedo: [0.8, 0.77, 0.7], joint: [0.8, 0.77, 0.7], unit: [3, 3], shift: 0, rough: 1 },
  timber: {
    albedo: [0.44, 0.3, 0.18],
    joint: [0.16, 0.1, 0.06],
    unit: [2.4, 0.15],
    shift: 0.37,
    rough: 0.8,
  },
  stone: {
    albedo: [0.56, 0.54, 0.5],
    joint: [0.36, 0.35, 0.33],
    unit: [0.46, 0.3],
    shift: 0.5,
    rough: 1,
  },
  brick: {
    albedo: [0.55, 0.25, 0.17],
    joint: [0.7, 0.68, 0.62],
    unit: [0.225, 0.075],
    shift: 0.5,
    rough: 1,
  },
  slate: {
    albedo: [0.17, 0.18, 0.2],
    joint: [0.12, 0.12, 0.14],
    unit: [0.6, 0.6],
    shift: 0,
    rough: 0.45,
  },
};

export const glsl: KindCode["glsl"] = () => `
float blockHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  vec3 side = vec3(rd.x < 0.0 ? -1.0 : 1.0, rd.y < 0.0 ? -1.0 : 1.0, rd.z < 0.0 ? -1.0 : 1.0);
  vec3 near = (mix(o.hi, o.lo, step(0.0, side)) - ro) * side / max(abs(rd), vec3(1e-9));
  float t = max(max(near.x, near.y), near.z);
  n = t == near.x ? vec3(-side.x, 0.0, 0.0) : t == near.y ? vec3(0.0, -side.y, 0.0) : vec3(0.0, 0.0, -side.z);
  part = t;
  return t >= span.x && t <= span.y ? t : -1.0;
}

// Called only where the ray crosses the box within reach: it blocks the light there.
float blockShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  return 0.0;
}

// How much of the face at q (metres) is joint, between units of size unit whose every other course
// shifts by shift of a unit; gone once a cell (foot metres) spans a third of a course.
float blockJoint(vec2 q, vec2 unit, float shift, float foot, out vec2 id) {
  float row = floor(q.y / unit.y);
  vec2 u = vec2(q.x / unit.x + shift * mod(row, 2.0), q.y / unit.y);
  id = floor(u);
  vec2 f = fract(u);
  vec2 edge = min(f, 1.0 - f) * unit;
  float joint = 1.0 - smoothstep(0.004, 0.004 + max(foot, 1e-3), min(edge.x, edge.y));
  return joint * (1.0 - smoothstep(unit.y * 0.3, unit.y, foot));
}

void blockSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = part * engineCell;
  int m = int(blockMaterial(o) + 0.5);
  vec2 q = abs(n.x) > 0.5 ? p.zy : abs(n.y) > 0.5 ? p.xz : p.xy;
${BLOCK_MATERIALS.map((name, k) => {
  const { albedo, joint, unit, shift, rough } = MATERIALS[name];
  return `  ${k === 0 ? "" : "else "}if (m == ${k}) {
    vec2 id;
    float j = blockJoint(q, vec2(${unit[0].toFixed(3)}, ${unit[1].toFixed(3)}), ${shift.toFixed(3)}, foot, id);
    vec3 tone = ${glslVec3(albedo)} * (0.86 + 0.28 * hash12(id + float(o.col)));
    h.albedo = mix(tone, ${glslVec3(joint)}, j);
    h.rough = ${rough.toFixed(3)};
  }`;
}).join("\n")}
  h.albedo *= 0.92 + 0.16 * fbmLod(q * 1.7, foot * 1.7, 2).x;
  h.mat = m;
}
`;
