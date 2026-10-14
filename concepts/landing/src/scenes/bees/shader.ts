// The flower border's picture, back to front: the afternoon sky with its clouds, a far line of trees
// and the hedge (heavily out of focus: a dark green mass broken by soft, sun-lit bokeh), the M of
// clematis blossoms trained over the hedge (opt-in), then the flowers from the farthest to the
// nearest, each with its stem, leaves and head, with the bees and butterflies drawn between them at
// their own depth, and last the near foliage and blades of grass at the lens.
//
// Focus: every flower, bee and butterfly has a depth 0 (at the lens) .. 1 (at the hedge). K_focus is
// the depth that is sharp; the further from it, the wider the blur (a disc of radius `beesBlur`
// screen heights), which softens the edge, washes out the detail and makes the thing translucent.
// All of it is cut per cell with `hardEdge` against the dither's threshold, so a moving edge flips
// each cell once and a blurred disc is a clean stipple, never a shimmer.
//
// The simulation (sim.ts) places and moves everything; see its header for the textures: uSim0 the
// flowers (far to near), uSim1 the bees and butterflies. A creature is drawn just after the first
// flower that is farther than it, so it sits in front of its own flower and behind nearer ones.
//
// Knobs read here: K_focus, K_breeze, K_glow, K_time, K_cycle, K_mark (and its "now").
import { glslFloat } from "../../shaders/glsl.ts";
import {
  BEES_AGENTS,
  BEES_MARK_TRIGGER,
  BEES_MAX_FLOWERS,
  BEES_ROOT_Y,
  BEES_SCALE_FAR,
  BEES_SCALE_NEAR,
} from "./sim.ts";

export const beesGlsl = `
const int BEES_FLOWERS = ${BEES_MAX_FLOWERS};
const int BEES_AGENTS = ${BEES_AGENTS};
const int BEES_MARK_TRIGGER = ${BEES_MARK_TRIGGER};
const float BEES_ROOT_Y = ${glslFloat(BEES_ROOT_Y)};
const float BEES_SCALE_NEAR = ${glslFloat(BEES_SCALE_NEAR)};
const float BEES_SCALE_FAR = ${glslFloat(BEES_SCALE_FAR)};
// The camera looks level over the border: the horizon at mid-height, a 46 degree field, turned left of
// the sky library's 'ahead' so the low afternoon sun stands up left of centre.
const float BEES_HORIZON = 0.5;
const float BEES_FOCAL = 1.18;
const float BEES_FOV = 0.8;
const float BEES_TURN = 0.56;
// The depth range around the focus that stays sharp, and the blur radius (screen heights) at depth 1 away.
const float BEES_SHARP = 0.14;
const float BEES_BLUR_MAX = 0.13;
// The M's clematis: height in screen heights, blossoms per stroke and the strokes' lengths along the path.
const float BEES_MARK_HEIGHT = 0.34;
const float BEES_MARK_TOTAL = 3.493;

// Light and view, set once per cell by sceneBees.
vec3 beesAmb = vec3(0.0);
vec3 beesSun = vec3(0.0);
vec2 beesSunDir = vec2(-0.7, 0.7);
float beesAa = 0.002;
float beesAspect = 1.0;

float beesScale(float depth) {
  return mix(BEES_SCALE_NEAR, BEES_SCALE_FAR, depth);
}

// Radius (screen heights) of the disc a point at this depth is spread over by the lens.
float beesBlur(float depth) {
  return max(abs(depth - K_focus) - BEES_SHARP, 0.0) * BEES_BLUR_MAX;
}

// An albedo in the afternoon light: the sky's blue ambient plus the low sun's gold, more of it on a
// surface that faces the sun (facing -1 .. 1).
vec3 beesLit(vec3 albedo, float facing) {
  return albedo * (beesAmb * 0.55 + beesSun * (0.42 + 0.38 * clamp(facing, -1.0, 1.0)));
}

// Whether this cell is inside d (an SDF in the units soft is in), cut against its own threshold; alpha
// below 1 leaves a share of the cells, a stipple.
float beesCut(float d, float soft, float alpha) {
  return hardEdge(softFill(d, soft) * alpha);
}

// ---- the backdrop ----------------------------------------------------------------------------

// The hedge in deep shade with the sun coming through it: a dark leafy mass, and two sizes of
// out-of-focus bokeh, each disc a leaf or a gap of sky catching the light.
vec3 beesHedge(vec2 p, float glow, float tm) {
  float n = fbm3(p * vec2(3.0, 4.5) + vec2(7.0, 2.0));
  vec3 col = mix(vec3(0.06, 0.13, 0.05), vec3(0.22, 0.38, 0.09), smoothstep(0.3, 0.75, n));
  col *= beesAmb * 0.75 + beesSun * 0.5;
  col *= mix(0.55, 1.1, smoothstep(0.0, 0.6, p.y));
  for (int k = 0; k < 2; k++) {
    float g = k == 0 ? 0.072 : 0.125;
    vec2 off = vec2(0.31, 0.17) * float(k);
    vec2 id = floor((p + off) / g);
    vec2 f = (p + off) / g - id;
    vec2 h = hash22(id + float(k) * 31.7);
    float b = hash12(id + vec2(91.0 + float(k) * 7.0, 13.0));
    if (b < 0.35) continue;
    vec2 c = vec2(0.3) + h * 0.4;
    float rad = 0.14 + 0.1 * hash12(id * 1.37 + 5.1);
    float d = (length(f - c) - rad) * g;
    float cov = softFill(d, 0.3 * rad * g);
    float breathe = 0.9 + 0.1 * sin(tm * 0.2 + b * 20.0);
    float lit = clamp(b * 0.8 + glow * 0.7, 0.0, 1.0);
    vec3 dc = mix(vec3(0.40, 0.58, 0.14), vec3(0.98, 0.86, 0.38), smoothstep(0.35, 1.0, lit));
    dc *= beesAmb * 0.6 + beesSun * 0.75;
    col = mix(col, dc, hardEdge(cov * (0.4 + 0.45 * b) * breathe));
  }
  return col;
}

// The sky, the far trees and the hedge, with the M's blossoms on the hedge.
vec3 beesBackdrop(vec2 p, vec3 dir, Sky sky, float glow, float t, float tm, inout float accent) {
  float y = p.y;
  float treeTop = 0.66 + 0.10 * vnoise1(p.x * 1.1 + 3.0, 3.0).x + 0.035 * vnoise1(p.x * 4.7 + 1.0, 4.0).x;
  float hedgeTop = 0.55 + 0.07 * vnoise1(p.x * 2.1 + 11.3, 1.0).x + 0.02 * vnoise1(p.x * 8.3 + 5.0, 2.0).x;
  vec3 col = vec3(0.0);
  if (y > hedgeTop - 0.04) {
    col = skyColor(sky, dir);
    vec4 cl = skyClouds(sky, dir, t, 0.3, 0.3);
    col = mix(col, cl.rgb, cl.a);
    col += skyStarLight(sky, dir, 0.5) * (1.0 - cl.a);
    if (y < treeTop + 0.04) {
      vec3 haze = horizonHaze(sky, dir, 0.012);
      float leaves = fbm3(p * vec2(4.0, 7.0) + vec2(2.0, 9.0));
      vec3 trees = mix(haze, vec3(0.16, 0.28, 0.12) * (beesAmb * 0.7 + beesSun * 0.4) * (0.75 + 0.5 * leaves), 0.55);
      col = mix(col, trees, hardEdge(softFill(y - treeTop, 0.02)));
    }
  }
  col = mix(col, beesHedge(p, glow, tm), hardEdge(softFill(y - hedgeTop, 0.012)));
  return col;
}

// The Manifold M in clematis trained over the hedge: a thin vine along its four strokes and a violet
// blossom at each of nineteen places along it, a pulse of light running along them every so often
// (and at once on "now").
void beesMark(vec2 p, float tm, inout vec3 col, inout float accent) {
  if (K_mark <= 0.0) return;
  float H = BEES_MARK_HEIGHT;
  vec2 c = vec2(clamp(0.2 * beesAspect, 0.18, 0.4), 0.665);
  vec2 q = (p - c) / H;
  if (abs(q.x) > 0.72 || abs(q.y) > 0.72) return;
  float blur = beesBlur(0.93);
  float soft = beesAa + 0.3 * blur;
  float seg = 0.0;
  float tt = 0.0;
  float dist = 1e9;
  for (int i = 0; i < 4; i++) {
    vec2 a = markVertex(i);
    vec2 ba = markVertex(i + 1) - a;
    float u = clamp(dot(q - a, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(q - a - ba * u);
    if (d < dist) {
      dist = d;
      seg = float(i);
      tt = u;
    }
  }
  float vine = beesCut(dist * H - 0.0042, soft, 0.9);
  col = mix(col, vec3(0.10, 0.24, 0.08) * (beesAmb * 0.8 + beesSun * 0.6), vine);
  float n = (seg < 0.5 || seg > 2.5) ? 5.0 : 4.0;
  float acc = seg < 0.5 ? 0.0 : seg < 1.5 ? 1.0 : seg < 2.5 ? 1.7465 : 2.493;
  float slen = (seg < 0.5 || seg > 2.5) ? 1.0 : 0.7465;
  vec2 a = markVertex(int(seg));
  vec2 b = markVertex(int(seg) + 1);
  float k0 = floor(tt * n + 0.5);
  float size = 0.75 + 0.25 * K_mark;
  float rb = 0.0225 / H * size;
  float since = sinceTrigger(BEES_MARK_TRIGGER);
  for (int j = -1; j <= 1; j++) {
    float k = clamp(k0 + float(j), 0.0, n);
    vec2 bc = mix(a, b, k / n);
    vec2 r = q - bc;
    float hb = hash12(bc * 17.0 + 3.0);
    float edge = rb * (0.82 + 0.18 * cos(5.0 * atan(r.y, r.x + 1e-5) + hb * 6.28));
    float cov = beesCut((length(r) - edge) * H, soft, 1.0);
    if (cov > 0.0) {
      float u = (acc + slen * k / n) / BEES_MARK_TOTAL;
      float wave = fract(tm / 24.0) * 1.3 - 0.15;
      float pulse = bell((u - wave) * 7.0);
      if (since < 8.0) pulse = max(pulse, bell((u - (since * 0.2 - 0.15)) * 7.0));
      vec3 petal = mix(vec3(0.46, 0.28, 0.84), vec3(0.80, 0.66, 0.98), pulse);
      vec3 bloom = beesLit(petal, 0.4) + petal * pulse * 0.25;
      float eye = 1.0 - smoothstep(0.0, 0.3, length(r) / rb);
      bloom = mix(bloom, vec3(0.97, 0.92, 0.62) * (0.7 + 0.3 * pulse), hardEdge(eye) * (1.0 - blur * 8.0));
      col = mix(col, bloom, cov);
      accent = max(accent, cov);
    }
  }
}

// ---- stems and leaves -------------------------------------------------------------------------

// The stem from its root below the frame to the head: a curve that leans toward the head's sway,
// tapering as it climbs.
void beesStem(vec2 p, vec2 head, float rootX, float sc, float blur, float hash, inout vec3 col) {
  float tall = head.y - BEES_ROOT_Y;
  float s = clamp((p.y - BEES_ROOT_Y) / tall, 0.0, 1.0);
  float dx = head.x - rootX;
  float slope = 2.0 * dx * s / tall;
  float xc = rootX + dx * s * s;
  float d = abs(p.x - xc) * inversesqrt(1.0 + slope * slope);
  float w = max(mix(0.0052, 0.0036, s) * sc, 0.7 * beesAa);
  float alpha = w / (w + 0.35 * blur);
  float cover = beesCut(d - w, beesAa + 0.5 * blur, alpha) * step(p.y, head.y);
  if (cover > 0.0) {
    vec3 green = mix(vec3(0.20, 0.38, 0.10), vec3(0.36, 0.52, 0.14), fract(hash * 5.7));
    float face = clamp((p.x - xc) / w * beesSunDir.x, -1.0, 1.0);
    col = mix(col, beesLit(green, face), cover);
  }
}

// Three leaves up the stem, alternating, lance-shaped (lavender, cosmos), broad (poppy, echinacea)
// or small and round (clover).
void beesLeaves(vec2 p, vec2 head, float rootX, float sc, float blur, float hash, float type, inout vec3 col) {
  float tall = head.y - BEES_ROOT_Y;
  float dx = head.x - rootX;
  float len = (type < 0.5 ? 0.105 : type < 1.5 ? 0.09 : type < 2.5 ? 0.095 : type < 3.5 ? 0.11 : 0.045) * sc;
  float wid = (type < 0.5 ? 0.0075 : type < 1.5 ? 0.007 : type < 2.5 ? 0.021 : type < 3.5 ? 0.02 : 0.022) * sc;
  float soft = beesAa + 0.5 * blur;
  float alpha = wid / (wid + 0.25 * blur);
  for (int k = 0; k < 3; k++) {
    float kf = float(k);
    float s = 0.16 + 0.2 * kf + 0.07 * fract(hash * (3.1 + kf));
    vec2 at = vec2(rootX + dx * s * s, BEES_ROOT_Y + tall * s);
    if (at.y > head.y - 0.03) continue;
    if (length(p - at) > len * 1.1 + soft * 3.0) continue;
    float side = mod(kf + floor(hash * 2.0), 2.0) < 0.5 ? 1.0 : -1.0;
    float ang = 0.5 + 0.25 * fract(hash * 7.7 + kf);
    if (side < 0.0) ang = 3.14159 - ang;
    vec2 q = rotate(p - at, -ang);
    float d = sdEllipse(q - vec2(0.5 * len, 0.0), vec2(0.5 * len, wid));
    if (beesCut(d, soft, alpha) > 0.0) {
      vec3 green = mix(vec3(0.18, 0.36, 0.10), vec3(0.32, 0.50, 0.14), fract(hash * 3.3 + kf * 0.37));
      float face = beesSunDir.x * side * 0.6 + 0.3 * q.y / wid;
      col = mix(col, beesLit(green, face), 1.0);
    }
  }
}

// ---- flower heads -----------------------------------------------------------------------------

// One flower head: type 0 lavender (three spikes of whorled florets), 1 cosmos (eight notched petals
// round a yellow eye), 2 poppy (four crumpled petals, dark blotched, a black ring of stamens),
// 3 echinacea (drooping rays round a copper cone), 4 clover (a ball of florets in a collar of leaves).
// R is the head's radius (half a spike's length), tilt the head's turn. Out of focus the detail
// fades into the colour and the whole head thins to a stipple disc.
void beesHead(vec2 p, vec2 head, float R, float tilt, float blur, float type, float hash, vec3 petal, vec3 tip, inout vec3 col) {
  vec2 q = rotate(p - head, -tilt);
  float soft = beesAa + 0.6 * blur;
  float con = 1.0 / (1.0 + 1.2 * (blur / R) * (blur / R));
  float det = 1.0 - smoothstep(0.12 * R, 0.55 * R, blur);
  float ph = hash * 6.2831853;
  float sq = 0.74 + 0.26 * fract(hash * 7.31);
  vec2 ls = rotate(beesSunDir, -tilt);

  if (type < 0.5) {
    // Lavender: three spikes (left and right shorter), each a tapering stack of florets.
    for (int k = 0; k < 3; k++) {
      float frac = k == 0 ? 0.74 : k == 1 ? 0.66 : 1.0;
      float xo = (k == 0 ? -0.11 : k == 1 ? 0.105 : 0.0) * R;
      float lean = k == 0 ? -0.1 : k == 1 ? 0.09 : 0.0;
      float hl = R * frac;
      float cy = -R + hl;
      vec2 sp = vec2(q.x - xo - lean * (q.y + R), (q.y - cy) / hl);
      float vv = sp.y;
      if (abs(vv) > 1.15) continue;
      float u = smoothstep(0.0, 1.0, vv);
      float whorl = fract((vv * 0.5 + 0.5) * 8.0 + 0.3 * float(k));
      float scallop = 0.8 + 0.2 * sin(whorl * 3.14159);
      float hw = 0.115 * R * mix(0.45, 1.0, smoothstep(-1.0, -0.45, vv)) * sqrt(max(1.0 - u * u, 0.0)) * scallop;
      float d = max(max(abs(sp.x) - hw, (-1.0 - vv) * hl), (vv - 1.0) * hl);
      if (beesCut(d, soft, con) > 0.0) {
        vec3 floret = mix(petal, tip, smoothstep(-0.2, 1.0, vv));
        floret *= 1.0 - 0.25 * det * (1.0 - smoothstep(0.0, 0.16, min(whorl, 1.0 - whorl)));
        floret = mix(floret, vec3(0.45, 0.55, 0.38), (1.0 - smoothstep(-0.8, -0.5, vv)) * det);
        float facing = clamp(sp.x / max(hw, 1e-4) * ls.x, -1.0, 1.0) * 0.8 + 0.2 * vv * ls.y;
        col = mix(col, beesLit(floret, facing), 1.0);
      }
    }
    return;
  }

  if (type < 1.5) {
    // Cosmos.
    vec2 qq = vec2(q.x, q.y / sq);
    float r = length(qq) / R;
    float th = atan(qq.y, qq.x + 1e-5);
    float lobe = abs(cos(4.0 * th + ph));
    float edge = 0.7 + 0.3 * pow(lobe, 0.7);
    float f = dot(qq / R, ls);
    if (beesCut((r - edge) * R, soft, con) > 0.0) {
      vec3 c = mix(petal, tip, smoothstep(0.35, 1.0, r));
      c *= 1.0 - det * 0.3 * pow(1.0 - lobe, 3.0) * smoothstep(0.3, 0.9, r);
      col = mix(col, beesLit(c, f) + petal * beesSun * 0.1, 1.0);
    }
    if (beesCut((r - 0.24) * R, soft, con * det) > 0.0) {
      vec3 eye = r < 0.12 ? vec3(0.80, 0.46, 0.08) : vec3(0.96, 0.74, 0.14);
      col = mix(col, beesLit(eye, f), 1.0);
    }
    return;
  }

  if (type < 2.5) {
    // Poppy.
    vec2 qq = vec2(q.x, q.y / sq);
    float r = length(qq) / R;
    float th = atan(qq.y, qq.x + 1e-5);
    float crumple = 0.05 * sin(5.0 * th + ph) + 0.035 * sin(9.0 * th + ph * 2.3);
    float edge = 0.88 + 0.12 * cos(4.0 * th + ph) + crumple;
    float f = dot(qq / R, ls);
    if (beesCut((r - edge) * R, soft, con) > 0.0) {
      vec3 c = mix(petal, tip, smoothstep(0.4, 1.0, r));
      c = mix(c, vec3(0.14, 0.03, 0.09), (1.0 - smoothstep(0.3, 0.62, r)) * 0.85 * det);
      c *= 1.0 - det * 0.1 * (0.5 + 0.5 * cos(14.0 * th + ph * 3.0)) * smoothstep(0.3, 0.9, r);
      col = mix(col, beesLit(c, f) + petal * beesSun * 0.12, 1.0);
    }
    if (beesCut((r - 0.3) * R, soft, con * det) > 0.0) {
      float stamens = pow(0.5 + 0.5 * cos(18.0 * th), 5.0) * smoothstep(0.15, 0.2, r);
      vec3 ring = r < 0.15 ? vec3(0.6, 0.68, 0.28) : (hardEdge(stamens) > 0.5 ? vec3(0.9, 0.85, 0.55) : vec3(0.1, 0.06, 0.12));
      col = mix(col, beesLit(ring, f), 1.0);
    }
    return;
  }

  if (type < 3.5) {
    // Echinacea: rays that droop, round a spiky copper cone.
    vec2 qq = vec2(q.x, q.y / mix(1.0, sq, 0.6));
    float r = length(qq) / R;
    float th = atan(qq.y, qq.x + 1e-5);
    float a = 0.5 + 0.5 * cos(13.0 * th + ph);
    float edge = (0.58 + 0.42 * pow(a, 0.6)) * (1.0 + 0.28 * max(-sin(th), 0.0) - 0.2 * max(sin(th), 0.0));
    if (beesCut((r - edge) * R, soft, con) > 0.0) {
      vec3 c = mix(petal, tip, smoothstep(0.35, 1.0, r));
      c *= 1.0 - det * 0.22 * (1.0 - a) * smoothstep(0.3, 0.8, r);
      col = mix(col, beesLit(c, dot(qq / R, ls)) + petal * beesSun * 0.1, 1.0);
    }
    vec2 cq = (qq - vec2(0.0, 0.1 * R)) / (0.36 * R);
    float cedge = 1.0 + 0.07 * cos(17.0 * atan(cq.y, cq.x + 1e-5) + ph);
    if (beesCut((length(cq) - cedge) * 0.36 * R, soft, con) > 0.0) {
      float hl = clamp(dot(cq, ls) * 0.6 + 0.4, 0.0, 1.0);
      vec3 cone = mix(vec3(0.62, 0.26, 0.07), vec3(0.93, 0.58, 0.16), hl);
      col = mix(col, mix(beesLit(cone, hl), cone, 0.35), 1.0);
    }
    return;
  }

  // Clover: leaflets in a collar, then the ball.
  vec2 lq = vec2(abs(q.x), q.y) - vec2(0.55 * R, -0.8 * R);
  if (beesCut(sdEllipse(rotate(lq, -0.45), vec2(0.55 * R, 0.22 * R)), soft, con) > 0.0) {
    col = mix(col, beesLit(vec3(0.22, 0.42, 0.12), 0.2), 1.0);
  }
  float r = length(q) / R;
  if (beesCut((r - 1.0) * R, soft, con) > 0.0) {
    vec2 n2 = q / R;
    float nz = sqrt(max(1.0 - r * r, 0.0));
    float f = dot(n2, ls) * 0.8 + 0.2 * nz;
    float bumps = 0.5 + 0.5 * cos(5.5 * n2.x + ph) * cos(5.5 * n2.y + ph * 1.7);
    vec3 c = mix(petal, tip, clamp(smoothstep(0.55, 1.0, r) * 0.7 + bumps * 0.35 * det, 0.0, 1.0));
    c *= 1.0 - 0.16 * det * (1.0 - bumps);
    col = mix(col, beesLit(c, f), 1.0);
  }
}

// ---- the creatures ----------------------------------------------------------------------------

// A bee in side view: striped abdomen, furry thorax, head, legs hanging or walking with a pollen sac
// on the hind one, and the wings: folded flat on the back, or a pale blur fanned above it. a: x, y,
// body length, presence; b: depth; c: facing, pitch, wings, pollen; e: leg phase, how much it walks.
void beesBee(vec2 p, vec4 a, vec4 b, vec4 c, vec4 e, inout vec3 col, inout float accent) {
  float L = a.z;
  float blur = beesBlur(b.x);
  float con = a.w / (1.0 + 2.4 * blur / L);
  float det = 1.0 - smoothstep(0.1 * L, 0.5 * L, blur);
  float sgn = c.x < 0.0 ? -1.0 : 1.0;
  vec2 q = p - a.xy;
  q.x *= sgn;
  q = rotate(q, -c.y);
  q.x /= max(abs(c.x), 0.3);
  q /= L;
  float soft = (beesAa + blur) / L;
  vec2 sl = rotate(vec2(beesSunDir.x * sgn, beesSunDir.y), -c.y);
  float lit = clamp(dot(q, sl) * 2.4, -1.0, 1.0);
  float crawl = e.y;
  float pollen = c.w;
  vec3 dark = vec3(0.13, 0.09, 0.05);

  float legs = 1e3;
  float sacs = 1e3;
  for (int k = 0; k < 3; k++) {
    float kf = float(k);
    float lx = 0.2 - 0.115 * kf;
    float sw = sin(e.x + kf * 2.1);
    vec2 foot = vec2(lx + mix(-0.1 - 0.03 * kf, 0.12 * sw, crawl), -0.3);
    legs = min(legs, sdTaperCapsule(q, vec2(lx, -0.07), foot, max(0.032, 0.5 * soft), max(0.022, 0.5 * soft)));
    if (k == 2 && pollen > 0.06) sacs = sdEllipse(q - mix(vec2(lx, -0.07), foot, 0.55), vec2(0.085, 0.065) * sqrt(pollen));
  }
  col = mix(col, beesLit(dark, 0.0), beesCut(legs, soft, con));
  col = mix(col, beesLit(vec3(1.0, 0.74, 0.1), lit), beesCut(sacs, soft, con));

  float cA = beesCut(sdEllipse(q - vec2(-0.22, -0.01), vec2(0.27, 0.17)), soft, con);
  float stripe = step(0.2, sin((q.x + 0.49) * 28.0 + 0.4)) * det;
  col = mix(col, beesLit(mix(vec3(0.95, 0.66, 0.14), vec3(0.12, 0.08, 0.04), stripe), lit), cA);
  float cT = beesCut(sdEllipse(q - vec2(0.12, 0.015), vec2(0.175, 0.16)), soft, con);
  col = mix(col, beesLit(vec3(0.66, 0.42, 0.12), lit), cT);
  float cH = beesCut(sdEllipse(q - vec2(0.335, -0.01), vec2(0.095, 0.088)), soft, con);
  col = mix(col, beesLit(dark, lit), cH);
  accent = max(accent, max(cA, max(cT, cH)) * con);

  // The wings: from folded along the back to a fan of two blurred discs; translucent, so a stipple.
  float wm = smoothstep(0.0, 1.0, c.z);
  vec2 wc = mix(vec2(-0.12, 0.13), vec2(0.02, 0.22), wm);
  vec2 wr = mix(vec2(0.3, 0.045), vec2(0.13, 0.3), wm);
  float wa = mix(0.05, 0.5, wm);
  float dW1 = sdEllipse(rotate(q - wc, -wa), wr);
  float dW2 = sdEllipse(rotate(q - wc - vec2(0.07, -0.02) * wm, -(wa + 0.45 * wm)), wr * 0.85);
  vec3 wingCol = vec3(0.86, 0.92, 1.0) * (beesAmb * 0.6 + beesSun * 0.85);
  float wAlpha = con * mix(0.75, 0.4, wm);
  col = mix(col, wingCol, beesCut(dW1, soft, wAlpha));
  col = mix(col, wingCol, beesCut(dW2, soft, wAlpha * 0.8));
}

// A butterfly seen from behind: two pairs of wings spread to either side of a slim body, their width
// the wingbeat (closed wings are a narrow upright pair showing the underside). a: x, y, half span,
// presence; b: depth, kind (1 peacock, 2 cabbage white, 3 swallowtail); c: tilt, wings open, underside.
void beesButterfly(vec2 p, vec4 a, vec4 b, vec4 c, inout vec3 col) {
  float S = a.z;
  float kind = b.y;
  float blur = beesBlur(b.x);
  float con = a.w / (1.0 + 1.6 * blur / S);
  float det = 1.0 - smoothstep(0.1 * S, 0.5 * S, blur);
  vec2 q = rotate(p - a.xy, -c.x) / S;
  float soft = (beesAa + blur) / S;
  float w = mix(0.16, 1.0, clamp(c.y, 0.0, 1.0));
  vec2 wq = vec2(abs(q.x) / w, q.y);
  float dF = sdEllipse(rotate(wq - vec2(0.44, 0.28), -0.62), vec2(0.52, 0.27));
  float dH = sdEllipse(rotate(wq - vec2(0.34, -0.25), 0.35), vec2(0.34, 0.28));
  float dT = kind > 2.5 ? sdTaperCapsule(wq, vec2(0.28, -0.46), vec2(0.4, -0.92), 0.075, 0.035) : 1.0;
  float dW = min(min(dF, dH), dT) * (0.5 + 0.5 * w);
  if (beesCut(dW, soft, con) > 0.0) {
    float eyeF = length(wq - vec2(0.72, 0.45));
    float eyeH = length(wq - vec2(0.5, -0.22));
    float body = 1.0 - smoothstep(0.0, 0.2, wq.x);
    vec3 topc;
    vec3 undc;
    if (kind < 1.5) {
      topc = mix(vec3(0.68, 0.16, 0.07), vec3(0.16, 0.08, 0.07), smoothstep(-0.14, -0.03, dW));
      topc = mix(topc, vec3(0.22, 0.1, 0.08), body);
      if (det > 0.3) {
        topc = eyeF < 0.15 ? vec3(0.93, 0.78, 0.38) : topc;
        topc = eyeF < 0.115 ? vec3(0.1, 0.06, 0.09) : topc;
        topc = eyeF < 0.075 ? vec3(0.24, 0.38, 0.8) : topc;
        topc = eyeF < 0.035 ? vec3(0.03, 0.03, 0.05) : topc;
        topc = eyeH < 0.11 ? vec3(0.93, 0.78, 0.38) : topc;
        topc = eyeH < 0.08 ? vec3(0.1, 0.06, 0.09) : topc;
        topc = eyeH < 0.05 ? vec3(0.24, 0.38, 0.8) : topc;
      }
      undc = mix(vec3(0.2, 0.13, 0.1), vec3(0.38, 0.28, 0.2), smoothstep(-0.2, -0.05, dW));
    } else if (kind < 2.5) {
      topc = vec3(0.96, 0.94, 0.86);
      topc = mix(topc, vec3(0.24, 0.23, 0.21), 1.0 - smoothstep(0.1, 0.34, length(wq - vec2(0.84, 0.56))));
      topc = mix(topc, vec3(0.68, 0.68, 0.62), body);
      topc = (det > 0.3 && length(wq - vec2(0.56, 0.22)) < 0.055) ? vec3(0.2, 0.2, 0.19) : topc;
      undc = vec3(0.82, 0.83, 0.56);
    } else {
      topc = vec3(0.97, 0.88, 0.38);
      float stripes = step(0.85, abs(sin(atan(wq.y - 0.02, wq.x + 0.05) * 5.0))) * step(0.14, wq.x) * det;
      topc = mix(topc, vec3(0.09, 0.07, 0.05), stripes);
      float blueBand = smoothstep(-0.25, -0.18, dW) * (1.0 - smoothstep(-0.18, -0.1, dW)) * step(wq.y, 0.0);
      topc = mix(topc, vec3(0.28, 0.45, 0.85), blueBand);
      topc = mix(topc, vec3(0.09, 0.07, 0.05), smoothstep(-0.17, -0.08, dW) * (1.0 - blueBand));
      topc = (det > 0.3 && length(wq - vec2(0.4, -0.4)) < 0.05) ? vec3(0.95, 0.5, 0.1) : topc;
      undc = mix(vec3(0.9, 0.8, 0.42), vec3(0.25, 0.2, 0.12), stripes * 0.5);
    }
    vec3 wing = mix(topc, undc, clamp(c.z, 0.0, 1.0));
    wing *= 1.0 - 0.4 * smoothstep(-0.05, -0.012, dW) * det;
    col = mix(col, beesLit(wing, 0.4) + wing * beesSun * 0.12, 1.0);
  }
  float dB = min(sdTaperCapsule(q, vec2(0.0, 0.32), vec2(0.0, -0.46), 0.045, 0.028), length(q - vec2(0.0, 0.4)) - 0.055);
  float rA = max(0.012, 0.5 * soft);
  float dAnt = sdTaperCapsule(vec2(abs(q.x), q.y), vec2(0.02, 0.43), vec2(0.17, 0.82), rA, rA);
  vec3 bodyCol = (kind > 1.5 && kind < 2.5) ? vec3(0.35, 0.33, 0.3) : vec3(0.12, 0.08, 0.06);
  col = mix(col, beesLit(bodyCol, 0.2), beesCut(min(dB, dAnt), soft, con));
}

// Which creatures could cover this cell: a bit per agent whose disc (body plus its blur) holds it.
int beesAgentMask(vec2 p) {
  int m = 0;
  for (int i = 0; i < BEES_AGENTS; i++) {
    vec4 a = texelFetch(uSim1, ivec2(0, i), 0);
    if (a.w <= 0.004) continue;
    vec4 b = texelFetch(uSim1, ivec2(1, i), 0);
    float reach = a.z * (b.y < 0.5 ? 0.62 : 1.15) + beesBlur(b.x) + 3.0 * beesAa;
    vec2 q = p - a.xy;
    if (dot(q, q) < reach * reach) m |= (1 << i);
  }
  return m;
}

// The creatures of the mask whose depth lies between nearD and farD (the flowers either side of
// them in depth): drawn after the farther flower and before the nearer.
void beesAgents(vec2 p, int mask, float nearD, float farD, inout vec3 col, inout float accent) {
  for (int i = 0; i < BEES_AGENTS; i++) {
    if (((mask >> i) & 1) == 0) continue;
    vec4 b = texelFetch(uSim1, ivec2(1, i), 0);
    if (!(b.x > nearD && b.x <= farD)) continue;
    vec4 a = texelFetch(uSim1, ivec2(0, i), 0);
    vec4 c = texelFetch(uSim1, ivec2(2, i), 0);
    if (b.y < 0.5) {
      vec4 e = texelFetch(uSim1, ivec2(3, i), 0);
      beesBee(p, a, b, c, e, col, accent);
    } else {
      beesButterfly(p, a, b, c, col);
    }
  }
}

// The border: every flower from the farthest to the nearest (stem, leaves, head), the creatures
// between them.
void beesFlowers(vec2 p, inout vec3 col, inout float accent) {
  if (uSimOn.x < 0.5 || uSimOn.y < 0.5) return;
  int mask = beesAgentMask(p);
  float prevD = 2.0;
  for (int f = 0; f < BEES_FLOWERS; f++) {
    if (mask != 0) {
      float dF = texelFetch(uSim0, ivec2(1, f), 0).x;
      beesAgents(p, mask, dF, prevD, col, accent);
      prevD = dF;
    }
    vec4 t0 = texelFetch(uSim0, ivec2(0, f), 0);
    float R = t0.w;
    if (R <= 0.0) continue;
    vec2 head = t0.xy;
    if (p.y > head.y + 1.5 * R + 0.07 || p.y < BEES_ROOT_Y) continue;
    float reach = max(1.3 * R, 0.17) + 0.07;
    if (p.x < min(head.x, t0.z) - reach || p.x > max(head.x, t0.z) + reach) continue;
    vec4 t1 = texelFetch(uSim0, ivec2(1, f), 0);
    float sc = beesScale(t1.x);
    float blur = beesBlur(t1.x);
    beesStem(p, head, t0.z, sc, blur, t1.w, col);
    beesLeaves(p, head, t0.z, sc, blur, t1.w, t1.y, col);
    vec2 dq = p - head;
    float hr = 1.35 * R + 1.2 * blur + 0.01;
    if (dot(dq, dq) < hr * hr) {
      vec3 petal = texelFetch(uSim0, ivec2(2, f), 0).rgb;
      vec3 tip = texelFetch(uSim0, ivec2(3, f), 0).rgb;
      beesHead(p, head, R, t1.z, blur, t1.y, t1.w, petal, tip, col);
    }
  }
  if (mask != 0) beesAgents(p, mask, -1.0, prevD, col, accent);
}

// ---- the lens-side foliage ----------------------------------------------------------------------

// Leaves at the bottom of the frame and a few blades of grass, right at the lens: so far out of
// focus they are only soft, translucent shapes of light and shade.
void beesForeground(vec2 p, float tm, inout vec3 col) {
  float blur = 0.012 + 0.45 * beesBlur(0.0);
  float soft = beesAa + blur;
  float bedTop = 0.04 + 0.045 * vnoise1(p.x * 2.6 + 4.0, 6.0).x + 0.025 * vnoise1(p.x * 9.0, 7.0).x;
  float bed = beesCut(p.y - bedTop, soft, 0.95);
  vec3 bedCol = mix(vec3(0.08, 0.17, 0.05), vec3(0.2, 0.36, 0.09), fbm3(p * vec2(7.0, 14.0)));
  col = mix(col, bedCol * (beesAmb * 0.6 + beesSun * 0.45), bed);
  float cw = 0.105;
  float base = floor(p.x / cw);
  for (int k = -1; k <= 1; k++) {
    float id = base + float(k);
    if (hash12(vec2(id, 4.7)) < 0.38) continue;
    vec2 h2 = hash22(vec2(id, 9.1));
    float root = (id + 0.15 + 0.7 * h2.x) * cw;
    float height = 0.13 + 0.2 * h2.y;
    float lean = (hash12(vec2(id, 2.2)) - 0.5) * 0.14;
    float sway = (vnoise1(tm * 0.22 + id * 3.7, 5.0).x - 0.5) * (0.02 + 0.07 * K_breeze);
    vec2 a = vec2(root, -0.03);
    vec2 tipP = vec2(root + lean + sway, height);
    vec2 mid = vec2(root + 0.3 * (lean + sway), 0.55 * height);
    float d = min(sdTaperCapsule(p, a, mid, 0.022, 0.014), sdTaperCapsule(p, mid, tipP, 0.014, 0.002));
    float alpha = 0.014 / (0.014 + 0.35 * blur);
    if (beesCut(d, soft, alpha) > 0.0) {
      vec3 green = mix(vec3(0.2, 0.42, 0.1), vec3(0.5, 0.62, 0.18), h2.y);
      col = mix(col, beesLit(green, clamp((p.x - root) * 20.0 * beesSunDir.x, -1.0, 1.0)), 1.0);
    }
  }
}

// ---- the scene --------------------------------------------------------------------------------

Shade sceneBees(vec2 uv, vec2 cell, float t) {
  beesAspect = uRes.x / uRes.y;
  vec2 p = vec2((uv.x - 0.5) * beesAspect, uv.y);
  beesAa = 1.0 / uRes.y;
  float tm = uMotionTime;

  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, tm));
  beesSun = sky.sunColor;
  beesAmb = sky.ambient + vec3(0.03);
  vec3 cam = viewRay(uv, beesAspect, BEES_HORIZON, BEES_FOV);
  vec3 dir = skyFacing(cam, BEES_TURN);
  vec3 sunCam = skyFacing(sky.sun, -BEES_TURN);
  float up = smoothstep(-0.03, 0.03, sky.sun.y);
  bool ahead = sunCam.z > 0.05;
  vec2 sunP = ahead ? vec2(0.0, BEES_HORIZON) + sunCam.xy / sunCam.z * BEES_FOCAL : vec2(sunCam.x * 4.0, 0.9);
  vec2 toSun = ahead ? sunP - vec2(0.0, 0.45) : vec2(sunCam.x, 0.5);
  beesSunDir = normalize(toSun + vec2(1e-4));
  float glow = ahead ? exp(-length(p - sunP) / 0.55) * up : 0.0;

  float accent = 0.0;
  vec3 col = beesBackdrop(p, dir, sky, glow, t, tm, accent);
  beesMark(p, tm, col, accent);
  beesFlowers(p, col, accent);
  beesForeground(p, tm, col);
  // The golden haze the low sun scatters toward the eye, over everything.
  col += beesSun * (0.04 + 0.28 * K_glow) * exp(-5.0 * length(dir - sky.sun));

  return shadeOf(col, inkOf(col, 1.25, 1.0), clamp(accent, 0.0, 1.0));
}
`;
