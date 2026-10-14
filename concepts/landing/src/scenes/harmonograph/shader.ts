// The harmonograph's picture: a dark wooden desk under a warm lamp, a sheet of paper with the ink the
// pendulums have drawn (and, if asked, the Manifold M signed in a second pigment), and the pen on its
// arm with its shadow. The sim (sim.ts) rasterises the ink and moves the sheet and the pen.
//   uSim0  rg8 ink in the sheet's frame: r the figure, g the signature (layout in sim.ts)
//   uSim1  rgba16f, 2 texels: the pen's tip; the sheet's centre x, tilt and the pen's height
// Knobs read here: K_ink, K_paper, K_lamp.
// Everything that moves (the sheet's edge, the ink as it lands, the pen and its shadow) is cut per
// cell with hardEdge/hardFill, so a passing edge flips each cell once; the wood and paper are static
// smooth tones that move only when the whole sheet slides.
import { glslFloat, glslPick, glslVec3 } from "../../shaders/glsl.ts";
import { unsplitHalfGlsl } from "../../sims/half.ts";
import { HARMONOGRAPH } from "./sim.ts";

// Display-sRGB colours as the picture was tuned with: paper stocks, ink pigments (a mid tone and a
// deeper one for pooled, crossed or fresh ink) and the pigments the M is signed with.
const papers = ["#f2e3bd", "#e6e6d9", "#c29a6b"].map((c) => glslVec3(c));
const inkMid = ["#67391a", "#2e38a0", "#d9391b"].map((c) => glslVec3(c));
const inkDeep = ["#2c170a", "#0f1344", "#8a1609"].map((c) => glslVec3(c));

export const harmonographGlsl = `
const float HARMONOGRAPH_HALF = ${glslFloat(HARMONOGRAPH.half)};
const float HARMONOGRAPH_FIT = ${glslFloat(HARMONOGRAPH.fit)};
const float HARMONOGRAPH_DOWN = ${glslFloat(HARMONOGRAPH.down)};
const vec2 HARMONOGRAPH_LAMP = vec2(-0.42, 0.34);     // the lamp's pool of light on the desk
const vec2 HARMONOGRAPH_ANCHOR = vec2(0.38, 1.5);     // where the pen's arm is pivoted, off screen
const vec3 HARMONOGRAPH_LIGHT = vec3(1.0, 0.91, 0.76); // the lamp's light
const vec3 HARMONOGRAPH_WOOD = vec3(0.34, 0.19, 0.095);
const vec3 HARMONOGRAPH_SIGNATURE = vec3(0.85, 0.20, 0.10);
const vec3 HARMONOGRAPH_SIGNATURE_DEEP = vec3(0.52, 0.08, 0.04);
const vec3 HARMONOGRAPH_SIGNATURE_ALT = vec3(0.18, 0.22, 0.58);      // the M's pigment when the ink is vermilion
const vec3 HARMONOGRAPH_SIGNATURE_ALT_DEEP = vec3(0.06, 0.07, 0.27);
${unsplitHalfGlsl}

vec3 harmonographPaper() {
${glslPick("paper", papers, papers[0] ?? "vec3(0.95, 0.89, 0.74)")}
}

vec3 harmonographInkMid() {
${glslPick("ink", inkMid, inkMid[0] ?? "vec3(0.4, 0.22, 0.1)")}
}

vec3 harmonographInkDeep() {
${glslPick("ink", inkDeep, inkDeep[0] ?? "vec3(0.17, 0.09, 0.04)")}
}

// The lamp's pool of light: 1 under it, falling away over the desk.
float harmonographPool(vec2 p) {
  vec2 d = (p - HARMONOGRAPH_LAMP) * vec2(0.85, 1.0);
  return exp(-dot(d, d) / 0.77);
}

// Planks of dark walnut running along the desk: broad tone, fine grain, a seam between boards.
vec3 harmonographWood(vec2 p) {
  float row = (p.y + 0.07) / 0.3;
  float id = floor(row);
  float seam = min(fract(row), 1.0 - fract(row)) * 0.3;
  float grain = 0.55 * vnoise(vec2(p.x * 1.4 + id * 5.1, p.y * 70.0)) + 0.45 * vnoise(vec2(p.x * 0.5 + id * 3.7, p.y * 9.0));
  float board = 0.85 + 0.3 * hash12(vec2(id, 3.0));
  vec3 wood = HARMONOGRAPH_WOOD * (0.5 + 0.95 * grain) * board;
  return wood * (1.0 - 0.75 * (1.0 - smoothstep(0.0, 0.0035, seam)));
}

// The pen's shadow: its holder and its arm thrown down and to the right of the lamp, wider and fainter
// the higher the pen is held. Two layers cut per cell, tight and dark inside a wide, faint one.
float harmonographPenShadow(vec2 p, vec2 cell, vec2 pen, float height, float px) {
  vec2 off = vec2(0.6, -0.8) * (height * 1.5);
  float soft = px * 1.2 + height * 0.35;
  float body = length(p - pen - off) - 0.013 * (1.0 + 2.2 * height);
  float arm = sdTaperCapsule(p, pen + off, HARMONOGRAPH_ANCHOR + off, 0.0055, 0.0085);
  float d = min(body, arm);
  float tight = hardEdge(softFill(d, soft) * 0.9);
  float wide = hardEdge(0.8 * softFill(d, soft * 2.5), edgeThreshold(cell, vec2(37.0, 11.0)));
  return min(0.34 * tight + 0.14 * wide, 0.42);
}

// The pen on its arm, over whatever is under it. The arm runs to its pivot beyond the top of the
// screen in two flat tones (its lit edge and its shaded one); the holder is an ebony ring round a
// brass collar and a bright cap. Each piece is cut per cell; none carries a gradient.
vec3 harmonographPen(vec3 col, vec2 p, vec2 pen, float height, float px, float pool, float lamp) {
  float scale = 1.0 + 2.2 * height;
  float aa = 0.6 * px;
  vec3 lit = HARMONOGRAPH_LIGHT * ((0.55 + 0.6 * pool) * lamp);

  float dArm = sdTaperCapsule(p, pen, HARMONOGRAPH_ANCHOR, 0.0055 * scale, 0.0085);
  vec2 dir = normalize(HARMONOGRAPH_ANCHOR - pen);
  float side = dot(p - pen, vec2(-dir.y, dir.x)) / (0.0065 * scale);
  vec3 armTone = side > 0.2 ? vec3(0.74, 0.52, 0.22) : vec3(0.38, 0.25, 0.10);
  col = mix(col, armTone * lit, hardFill(dArm, aa));

  float r = length(p - pen);
  col = mix(col, vec3(0.10, 0.07, 0.055) * lit, hardFill(r - 0.0135 * scale, aa));
  col = mix(col, vec3(0.66, 0.46, 0.20) * lit, hardFill(r - 0.0095 * scale, aa));
  vec2 shine = p - pen - vec2(-0.0028, 0.0028) * scale;
  col = mix(col, vec3(0.96, 0.86, 0.62) * lit, hardFill(length(shine) - 0.0036 * scale, aa));
  return col;
}

// The sheet: paper stock lit by the lamp with a faint static fibre, then the ink on it. The ink's
// coverage is sampled over the footprint of the cell and cut against the cell's own threshold, so
// a thin line is a firm dotted line and a line being drawn lands cell by cell, once. out sig: how much
// of the cell is the signature's pigment.
vec3 harmonographSheet(vec2 q, vec2 cell, float px, float pool, float lamp, out float sig) {
  vec2 uv = q / (2.0 * HARMONOGRAPH_HALF) + 0.5;
  float foot = px / (2.0 * HARMONOGRAPH_HALF);
  vec2 o = vec2(0.28 * foot);
  vec2 c0 = textureLod(uSim0, uv, 0.0).rg;
  vec2 c1 = textureLod(uSim0, uv + vec2(o.x, o.y), 0.0).rg;
  vec2 c2 = textureLod(uSim0, uv + vec2(-o.x, o.y), 0.0).rg;
  vec2 c3 = textureLod(uSim0, uv + vec2(o.x, -o.y), 0.0).rg;
  vec2 c4 = textureLod(uSim0, uv + vec2(-o.x, -o.y), 0.0).rg;
  vec2 avg = 0.2 * (c0 + c1 + c2 + c3 + c4);
  vec2 top = max(max(max(c0, c1), max(c2, c3)), c4);
  vec2 cover = clamp(1.05 * avg + 0.25 * top, 0.0, 1.0);

  float fibre = 0.6 * vnoise(q * 110.0 + 3.7) + 0.4 * vnoise(q * 38.0 + 9.1);
  float lit = (0.62 + 0.5 * pool) * lamp;
  vec3 col = harmonographPaper() * (0.965 + 0.07 * fibre) * HARMONOGRAPH_LIGHT * lit;
  // The paper's edge, thick enough to catch the lamp on the side that faces it.
  float edge = 1.0 - smoothstep(0.0, 0.004, -sdBox(q, vec2(HARMONOGRAPH_HALF), 0.002));
  col *= 1.0 + 0.1 * edge * smoothstep(-0.3, 0.3, (q.y - q.x) / HARMONOGRAPH_HALF);

  float inkLight = 0.55 + 0.45 * clamp(lit, 0.0, 1.2);
  float mid = hardEdge(cover.x);
  float deep = mid * hardEdge((top.x - 0.62) * 5.0, edgeThreshold(cell, vec2(23.0, 7.0)));
  col = mix(col, harmonographInkMid() * inkLight, mid);
  col = mix(col, harmonographInkDeep() * inkLight, deep);

  bool alt = K_ink > 1.5;
  float sigMid = hardEdge(cover.y);
  float sigDeep = sigMid * hardEdge((top.y - 0.6) * 5.0, edgeThreshold(cell, vec2(5.0, 41.0)));
  col = mix(col, (alt ? HARMONOGRAPH_SIGNATURE_ALT : HARMONOGRAPH_SIGNATURE) * inkLight, sigMid);
  col = mix(col, (alt ? HARMONOGRAPH_SIGNATURE_ALT_DEEP : HARMONOGRAPH_SIGNATURE_DEEP) * inkLight, sigDeep);
  sig = sigMid;
  return col;
}

Shade sceneHarmonograph(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float k = min(1.0, HARMONOGRAPH_FIT * aspect);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) / k;
  float px = 1.0 / (uRes.y * k); // one cell in p units

  bool ready = uSimOn.x > 0.5 && uSimOn.y > 0.5;
  vec2 pen = vec2(0.0);
  float cx = 0.0;
  float tilt = 0.0;
  float height = HARMONOGRAPH_DOWN;
  if (ready) {
    vec4 s0 = texelFetch(uSim1, ivec2(0, 0), 0);
    vec4 s1 = texelFetch(uSim1, ivec2(1, 0), 0);
    pen = unsplitHalf(s0);
    cx = unsplitHalf(s1.xy);
    tilt = s1.z;
    height = s1.w;
  }
  float lamp = mix(0.7, 1.3, K_lamp);
  float pool = harmonographPool(p);

  // The desk.
  vec3 col = harmonographWood(p) * HARMONOGRAPH_LIGHT * ((0.16 + 0.95 * pool) * lamp);

  // The sheet and its shadow on the desk.
  vec2 centre = vec2(cx, 0.0);
  vec2 q = rotate(p - centre, -tilt);
  float dSheet = sdBox(q, vec2(HARMONOGRAPH_HALF), 0.002);
  float accent = 0.0;
  if (dSheet > -px) {
    float dShadow = sdBox(rotate(p - centre - vec2(0.007, -0.010), -tilt), vec2(HARMONOGRAPH_HALF), 0.002);
    float shadow = 0.4 * hardEdge(softFill(dShadow, 0.008)) + 0.22 * hardEdge(0.55 * softFill(dShadow, 0.04), edgeThreshold(cell, vec2(11.0, 29.0)));
    col *= 1.0 - min(shadow, 0.55);
  }
  if (ready && hardFill(dSheet, 0.7 * px) > 0.5) {
    float sig;
    col = harmonographSheet(q, cell, px, pool, lamp, sig);
    accent = sig;
  }

  // The pen and its arm, over everything.
  if (ready) {
    col *= 1.0 - harmonographPenShadow(p, cell, pen, height, px);
    col = harmonographPen(col, p, pen, height, px, pool, lamp);
  }

  return shadeOf(col, inkOf(col, 1.3, 1.0), clamp(accent, 0.0, 1.0));
}
`;
