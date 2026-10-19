// The wall shelf's code (src/engine/glsl.ts, the kind contract): index.ts's pieces (its board, and
// each bracket's two arms and the web between them, a box cut along its slope) against the ray, the
// same for its shadow; its board the wood's figure along it, its brackets black iron.
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { joineryGlsl } from "../joinery.ts";
import { SHELF } from "./index.ts";

export const glsl: KindCode["glsl"] = () => `${joineryGlsl("shelf")}
const float SHELF_BOARD = ${glslFloat(SHELF.board)};
const float SHELF_DROP = ${glslFloat(SHELF.drop)};
const float SHELF_ARM = ${glslFloat(SHELF.arm)};
const float SHELF_PLATE = ${glslFloat(SHELF.plate)};
const float SHELF_WEB = ${glslFloat(SHELF.web)};

// The nearest of its pieces in span: t, else -1; part 0 the board, 1 a bracket.
float shelfHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float w = 0.5 * shelfWidth(o);
  float d = 0.5 * shelfDepth(o);
  float reach = 2.0 * d - 0.03;
  float slope = SHELF_DROP / (reach - 0.01);
  vec3 inv = shelfInv(rd);
  float t = span.y;
  n = vec3(0.0, 1.0, 0.0);
  part = -1.0;
  if (shelfBox(ro, inv, vec3(-w, SHELF_DROP, -d), vec3(w, SHELF_DROP + SHELF_BOARD, d), span.x, t, n)) part = 0.0;
  float before = t;
  for (int i = 0; i < 2; i++) {
    float x = (i == 0 ? -1.0 : 1.0) * (w - min(0.12, 0.5 * w));
    shelfBox(ro, inv, vec3(x - SHELF_PLATE, 0.0, -d), vec3(x + SHELF_PLATE, SHELF_DROP, -d + SHELF_ARM), span.x, t, n);
    shelfBox(ro, inv, vec3(x - SHELF_PLATE, SHELF_DROP - SHELF_ARM, -d), vec3(x + SHELF_PLATE, SHELF_DROP, -d + reach), span.x, t, n);
    shelfCutBox(ro, rd, inv, vec3(x - SHELF_WEB, 0.0, -d), vec3(x + SHELF_WEB, SHELF_DROP, -d + reach - 0.01), vec4(0.0, -1.0, slope, -slope * d), span.x, t, n);
  }
  if (t < before) part = 1.0;
  return part < 0.0 ? -1.0 : t;
}

float shelfShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  vec3 n;
  float part;
  return shelfHit(o, ro, rd, span, n, part) < 0.0 ? 1.0 : 0.0;
}

void shelfSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = h.t * engineCell / o.scale;
  h.mat = int(part);
  if (part > 0.5) {
    h.albedo = vec3(0.06, 0.06, 0.065);
    h.rough = 0.45;
    return;
  }
  vec2 q = abs(n.x) > 0.5 ? p.zy : abs(n.y) > 0.5 ? p.xz : p.xy;
  h.albedo = shelfWood(shelfTone(o)) * shelfGrain(q, foot, 4.0);
  h.rough = 0.55;
}
`;
