// The sphere's code (src/engine/glsl.ts, the kind contract): an exact ray-sphere test, the same for
// its shadow; its surface its hue at its tone, matte, glossy or a mirror, each material compiled in
// only while an instance of the document holds it (its bit in `compiled.material`).
import type { KindCode } from "../../types.ts";
import { SPHERE_MATERIALS } from "./index.ts";

const MIRROR = SPHERE_MATERIALS.indexOf("mirror");

/** Each material's roughness and mirror share. */
const FINISH: Readonly<Record<(typeof SPHERE_MATERIALS)[number], readonly [number, number]>> = {
  matte: [1, 0],
  gloss: [0.2, 0],
  mirror: [0.05, 0.85],
};

export const mirror: NonNullable<KindCode["mirror"]> = (compiled) =>
  ((compiled["material"] ?? 0) & (1 << MIRROR)) !== 0;

export const glsl: KindCode["glsl"] = (compiled) => {
  const held = SPHERE_MATERIALS.flatMap((name, k) =>
    ((compiled["material"] ?? 0) & (1 << k)) !== 0 ? [[name, k] as const] : [],
  );
  const finish =
    held.length <= 1
      ? `  vec2 finish = vec2(${FINISH[held[0]?.[0] ?? "matte"].map((x) => x.toFixed(2)).join(", ")});`
      : `  int m = int(sphereMaterial(o) + 0.5);
  vec2 finish = vec2(1.0, 0.0);
${held.map(([name, k]) => `  if (m == ${k}) finish = vec2(${FINISH[name].map((x) => x.toFixed(2)).join(", ")});`).join("\n")}`;
  return `
// The nearer root of the ray against the sphere of radius r on its base: t, else -1.
float sphereRoot(vec3 ro, vec3 rd, float r) {
  vec3 oc = ro - vec3(0.0, r, 0.0);
  float b = dot(oc, rd);
  float disc = b * b - dot(oc, oc) + r * r;
  return disc < 0.0 ? -1.0 : -b - sqrt(disc);
}

float sphereHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float r = sphereRadius(o);
  float t = sphereRoot(ro, rd, r);
  n = normalize(ro + rd * t - vec3(0.0, r, 0.0));
  part = 0.0;
  return t >= span.x && t <= span.y ? t : -1.0;
}

float sphereShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  float t = sphereRoot(ro, rd, sphereRadius(o));
  return t >= span.x && t <= span.y ? 0.0 : 1.0;
}

void sphereSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  vec3 hue = clamp(abs(mod(sphereHue(o) * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  h.albedo = mix(vec3(1.0), hue, 0.6) * sphereTone(o);
${finish}
  h.rough = finish.x;
  h.mirror = finish.y;
  h.mat = int(sphereMaterial(o) + 0.5);
}
`;
};
