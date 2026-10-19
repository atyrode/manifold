// The table's code (src/engine/glsl.ts, the kind contract): index.ts's boxes (its top, the four
// boards of its apron, its legs) against the ray, the same for its shadow; its surface the wood's
// figure along its top's boards and up its legs.
import { glslFloat } from "../../../shaders/glsl.ts";
import type { KindCode } from "../../types.ts";
import { joineryGlsl } from "../joinery.ts";
import { TABLE } from "./index.ts";

export const glsl: KindCode["glsl"] = () => `${joineryGlsl("table")}
const float TABLE_TOP = ${glslFloat(TABLE.top)};
const float TABLE_APRON = ${glslFloat(TABLE.apron)};
const float TABLE_BOARD = ${glslFloat(TABLE.board)};
const float TABLE_LEG = ${glslFloat(TABLE.leg)};
const float TABLE_INSET = ${glslFloat(TABLE.inset)};

// The nearest of its boxes in span: t, else -1; part 0 the top, 1 the apron, 2 a leg.
float tableHit(EngineObj o, vec3 ro, vec3 rd, vec2 span, out vec3 n, out float part) {
  float w = 0.5 * tableWidth(o);
  float d = 0.5 * tableDepth(o);
  float under = tableHeight(o) - TABLE_TOP;
  float x = w - TABLE_INSET;
  float z = d - TABLE_INSET;
  float low = under - TABLE_APRON;
  vec3 inv = tableInv(rd);
  float t = span.y;
  n = vec3(0.0, 1.0, 0.0);
  part = -1.0;
  if (tableBox(ro, inv, vec3(-w, under, -d), vec3(w, under + TABLE_TOP, d), span.x, t, n)) part = 0.0;
  float before = t;
  tableBox(ro, inv, vec3(-x, low, z - TABLE_BOARD), vec3(x, under, z), span.x, t, n);
  tableBox(ro, inv, vec3(-x, low, -z), vec3(x, under, -z + TABLE_BOARD), span.x, t, n);
  tableBox(ro, inv, vec3(x - TABLE_BOARD, low, -z), vec3(x, under, z), span.x, t, n);
  tableBox(ro, inv, vec3(-x, low, -z), vec3(-x + TABLE_BOARD, under, z), span.x, t, n);
  if (t < before) part = 1.0;
  for (int i = 0; i < 4; i++) {
    vec2 c = vec2(i % 2 == 0 ? -x : x - TABLE_LEG, i < 2 ? -z : z - TABLE_LEG);
    if (tableBox(ro, inv, vec3(c.x, 0.0, c.y), vec3(c.x + TABLE_LEG, under, c.y + TABLE_LEG), span.x, t, n)) part = 2.0;
  }
  return part < 0.0 ? -1.0 : t;
}

float tableShadow(EngineObj o, vec3 ro, vec3 rd, vec2 span) {
  vec3 n;
  float part;
  return tableHit(o, ro, rd, span, n, part) < 0.0 ? 1.0 : 0.0;
}

void tableSurface(EngineObj o, vec3 p, inout vec3 n, float part, inout Hit h) {
  float foot = h.t * engineCell / o.scale;
  vec2 q = part > 1.5 ? p.yx : abs(n.x) > 0.5 ? p.zy : abs(n.y) > 0.5 ? p.xz : p.xy;
  h.albedo = tableWood(tableTone(o)) * tableGrain(q, foot, part * 3.0) * (part > 0.5 ? 0.88 : 1.0);
  h.rough = 0.5;
  h.mat = int(part);
}
`;
