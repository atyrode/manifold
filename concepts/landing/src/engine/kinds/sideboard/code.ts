// The sideboard's code (src/engine/glsl.ts, the kind contract): index.ts's boxes (its top, its
// carcass, its legs) against the ray, the same for its shadow; its surface the wood's figure along
// its boards, and on its front the drawers' band and the doors under it, a groove round each, a
// finger pull on each, all gone to their mean once a cell spans them.
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { joineryGlsl } from "../joinery.ts";
import { SIDEBOARD } from "./index.ts";

export const glsl: KindCode["glsl"] = () => `${joineryGlsl("sideboard")}
const float SIDEBOARD_TOP = ${glslFloat(SIDEBOARD.top)};
const float SIDEBOARD_OVERHANG = ${glslFloat(SIDEBOARD.overhang)};
const float SIDEBOARD_LEGS = ${glslFloat(SIDEBOARD.legs)};
const float SIDEBOARD_LEG = ${glslFloat(SIDEBOARD.leg)};
const vec2 SIDEBOARD_INSET = vec2(${glslFloat(SIDEBOARD.inset[0])}, ${glslFloat(SIDEBOARD.inset[1])});
const float SIDEBOARD_DRAWERS = ${glslFloat(SIDEBOARD.drawers)};

// The nearest of its boxes in span: t, else -1; part 0 the top, 1 the carcass, 2 a leg.
float sideboardHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float w = 0.5 * sideboardWidth(o);
  float d = 0.5 * sideboardDepth(o);
  float h = sideboardHeight(o);
  vec3 inv = sideboardInv(rd);
  float t = span.y;
  n = vec3(0.0, 1.0, 0.0);
  part = -1.0;
  if (sideboardBox(ro, inv, vec3(-w, h - SIDEBOARD_TOP, -d), vec3(w, h, d), span.x, t, n)) part = 0.0;
  if (sideboardBox(ro, inv, vec3(-w + 0.01, SIDEBOARD_LEGS, -d), vec3(w - 0.01, h - SIDEBOARD_TOP, d - SIDEBOARD_OVERHANG), span.x, t, n)) part = 1.0;
  for (int i = 0; i < 4; i++) {
    vec2 c = vec2(i % 2 == 0 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * (vec2(w, d) - SIDEBOARD_INSET);
    if (sideboardBox(ro, inv, vec3(c.x - 0.5 * SIDEBOARD_LEG, 0.0, c.y - 0.5 * SIDEBOARD_LEG), vec3(c.x + 0.5 * SIDEBOARD_LEG, SIDEBOARD_LEGS + 0.005, c.y + 0.5 * SIDEBOARD_LEG), span.x, t, n)) part = 2.0;
  }
  return part < 0.0 ? -1.0 : t;
}

float sideboardShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  vec3 n;
  float part;
  return sideboardHit(o, ro, rd, span, n, part) < 0.0 ? 1.0 : 0.0;
}

void sideboardSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = h.t * engineCell / o.scale;
  vec3 wood = sideboardWood(sideboardTone(o));
  h.rough = 0.5;
  h.mat = int(part);
  if (part > 1.5) {
    h.albedo = wood * 0.8 * sideboardGrain(p.yx, foot, 5.0);
    return;
  }
  vec2 q = abs(n.x) > 0.5 ? p.zy : abs(n.y) > 0.5 ? p.xz : p.xy;
  h.albedo = wood * sideboardGrain(q, foot, part * 3.0);
  if (part < 0.5 || n.z < 0.5) return;
  // Its front: the drawers' band under the top, the doors under it, one of each per half metre.
  float w = sideboardWidth(o);
  float band = sideboardHeight(o) - SIDEBOARD_TOP - SIDEBOARD_DRAWERS;
  float doors = clamp(floor(w / 0.5 + 0.5), 2.0, 5.0);
  float u = (p.x + 0.5 * w) / w * doors;
  float k = floor(u);
  float across = (fract(u) - 0.5) * w / doors;
  float seam = min(abs(abs(across) - 0.5 * w / doors), abs(p.y - band));
  float detail = 1.0 - smoothstep(0.004, 0.015, foot);
  float groove = (1.0 - smoothstep(0.0015, 0.0015 + foot, seam)) * detail;
  // A finger pull at the top of each drawer, and at the top of each door.
  vec2 pull = vec2(abs(across), abs(p.y - (p.y > band ? sideboardHeight(o) - SIDEBOARD_TOP - 0.025 : band - 0.05)));
  float grip = (1.0 - smoothstep(0.04, 0.04 + foot, pull.x)) * (1.0 - smoothstep(0.006, 0.006 + foot, pull.y)) * detail;
  h.albedo *= (0.92 + 0.14 * hash12(vec2(k, step(band, p.y)) + float(o.col))) * (1.0 - 0.75 * max(groove, grip));
}
`;
