// The dewy web, drawn: threads, beads, drops and stems from the simulation's records (sim.ts), the
// spider and her M at the hub, and behind it all a dawn meadow far out of focus.
//
// Every cell looks up its bin (uSim1) and walks the short list of threads, stems and drops that
// reach into it. Silk itself is nearly invisible: a thread is a faint, thin line that brightens
// where it lies across the light (a cylinder glints where its axis is square to the half-vector
// between the light and the eye; the capture spiral's axis is taken from its own winding round the
// hub, so its glints swell and fade smoothly along it). The dew carries the picture: beads strung at
// even spacing along the threads and the big drops, each a small ball lens with a lit body holding
// the scene behind it upside down, and a spark of the low sun.
//
// The entrance's spider is drawn here: she comes down the top radius to the hub in a walking gait and
// spins her M or ribbon out from it on arriving (DEW_WALK). The web's swing is in sim.ts.
//
// Fine features are dithered here, whole: a cell takes a feature's colour snapped to the palette's
// levels, or nothing, decided against the cell's own dither threshold (a feature fainter than the
// first level becomes a sparse, still stipple). A slowly moving edge then flips each cell once, and
// no thread or bead breaks into multicoloured dots. Depth of field only widens and thins them.
import {
  DEW_BEAD_HANG,
  DEW_BEAD_R,
  DEW_BEAD_SCALE,
  DEW_BLUR_MAX,
  DEW_CODE,
  DEW_DOF,
  DEW_FRAME_HALF,
  DEW_GLINT_SWELL,
  DEW_KIND_FRAME,
  DEW_KIND_SPIRAL,
  DEW_KIND_STEM,
  DEW_PASSAGE,
  DEW_PIECE_AWN,
  DEW_PIECE_HEAD,
  DEW_PIECE_LEAF,
  DEW_PRESENCE_BASE,
  DEW_PRESENCE_DEW,
  DEW_SEG_ROW,
  DEW_SEG_TEXELS,
  DEW_SILK_HALF,
  DEW_STEM_UNIT,
  DEW_WALK,
  DEW_WET_LEVELS,
} from "./sim.ts";
import { binListsGlsl } from "../../sims/bins.ts";
import { glslFloat, glslVec3 } from "../../shaders/glsl.ts";

export const dewGlsl = `
// Knobs: K_breeze, K_dew, K_dof and K_webSeed drive the simulation; the shader reads K_dew (bead
// sizes), K_dof, K_spider, K_backdrop, K_mark and the sky (K_time, K_cycle). Textures: sim.ts.
const int DEW_SEG_TEXELS = ${DEW_SEG_TEXELS};
const int DEW_SEG_ROW = ${DEW_SEG_ROW};
${binListsGlsl}
const float DEW_CODE = ${glslFloat(DEW_CODE)};
const float DEW_KIND_SPIRAL = ${glslFloat(DEW_KIND_SPIRAL)};
const float DEW_KIND_FRAME = ${glslFloat(DEW_KIND_FRAME)};
const float DEW_KIND_STEM = ${glslFloat(DEW_KIND_STEM)};
const float DEW_STEM_UNIT = ${glslFloat(DEW_STEM_UNIT)};
const float DEW_PIECE_LEAF = ${glslFloat(DEW_PIECE_LEAF)};
const float DEW_PIECE_HEAD = ${glslFloat(DEW_PIECE_HEAD)};
const float DEW_PIECE_AWN = ${glslFloat(DEW_PIECE_AWN)};
const float DEW_WET_LEVELS = ${glslFloat(DEW_WET_LEVELS)};
const float DEW_DOF = ${glslFloat(DEW_DOF)};
const float DEW_BLUR_MAX = ${glslFloat(DEW_BLUR_MAX)};
const float DEW_BEAD_R = ${glslFloat(DEW_BEAD_R)};
const vec3 DEW_BEAD_SCALE = ${glslVec3(DEW_BEAD_SCALE)};
const vec3 DEW_PRESENCE_BASE = ${glslVec3(DEW_PRESENCE_BASE)};
const vec3 DEW_PRESENCE_DEW = ${glslVec3(DEW_PRESENCE_DEW)};
const float DEW_BEAD_HANG = ${glslFloat(DEW_BEAD_HANG)};
const float DEW_SILK_HALF = ${glslFloat(DEW_SILK_HALF)};
const float DEW_FRAME_HALF = ${glslFloat(DEW_FRAME_HALF)};
const float DEW_GLINT_SWELL = ${glslFloat(DEW_GLINT_SWELL)};
// The entrance: its length, and the spider's walk down the top radius to the hub (the seconds she
// sets off and arrives, and the web radii above the hub she starts).
const float DEW_ENTER = ${glslFloat(DEW_PASSAGE.enter)};
const float DEW_WALK_FROM = ${glslFloat(DEW_WALK.from)};
const float DEW_WALK_TO = ${glslFloat(DEW_WALK.to)};
const float DEW_WALK_START = ${glslFloat(DEW_WALK.start)};

// The backdrop's camera: the horizon's height in the frame, the hedge's crown, the field of view.
const float DEW_HORIZON = 0.4;
const float DEW_HEDGE = 0.56;
const float DEW_FOV = 0.6;
// The camera keeps the sun beyond the frame's right edge, this share of the frame's width right of
// its centre (so the sun's glow comes in from the edge but its disc stays out of the frame); the
// sun wanders this much either way (radians) over DEW_DRIFT seconds, so glints and sparks travel.
const float DEW_SUN_X = 0.66;
const float DEW_SUN_WANDER = 0.07;
const float DEW_DRIFT = 90.0;
const float DEW_SUN_GAIN = 2.0;
// Silk: the little light it scatters (key light, sky); the soft sheen and the brighter glint where it
// lies across the light; how wide in angle they are on the smooth radii and frame and on the
// glue-beaded spiral; how much a thread's tilt out of the web's plane moves its glint.
const float DEW_SILK_GLOW = 0.02;
const float DEW_SILK_SKY = 0.03;
const float DEW_SHEEN = 0.12;
const float DEW_GLINT = 0.8;
const float DEW_SHARP_GLINT = 0.08;
const float DEW_SOFT_GLINT = 0.11;
const float DEW_TILT = 0.5;
// Water: how far behind it a drop sees (frame heights, edge to centre), the light its body gathers,
// and where on it the spark sits (share of the radius toward the half-vector).
const float DEW_LENS = 0.3;
const float DEW_BODY = 0.45;
const float DEW_SPARK_AT = 0.5;
// Beads on the stems: spacing (frame heights) and share of places taken at full dew.
const float DEW_STEM_BEADS = 0.014;
const float DEW_STEM_WET = 0.5;
// The spider's unit (her body is about 1.6 long) as a share of the web's radius; the hub's mat of
// dense silk under her (spider units); her M's height (web radii) at the smallest and largest size.
const float DEW_SPIDER = 0.11;
const float DEW_MAT = 1.2;
const float DEW_MARK_MIN = 0.4;
const float DEW_MARK_MAX = 0.8;

struct DewLight {
  vec3 L;      // toward the key light (x right, y up, z toward the viewer)
  vec3 H;      // halfway between the light and the eye
  vec3 color;  // key light
  vec3 sky;    // light from the whole sky
  float back;  // 0..1: how far behind the web the light stands
  vec2 glow;   // where the key light sits in the frame (uv, usually just outside it)
};

struct DewView {
  vec2 p;      // this cell, frame heights from the bottom-left corner
  vec2 hub;
  float px;    // one cell, frame heights
  float focus; // depth in focus
  float dof;   // blur (frame heights) per unit of depth off the focus
  float dew;
  float aspect;
  float tm;
  float stir;  // breeze and gust, for the backdrop's grass
};

struct DewAcc {
  vec3 silk;        // light on the brightest thread here (linear)
  float silkCover;  // its coverage
  float silkRank;   // coverage × brightness, to pick it
  float glint;      // its glint, for the accent
  vec4 water;       // the bead or drop in front: body colour (linear), coverage
  float spark;      // coverage of that drop's spark
  vec4 stem;        // the stem in front: colour (linear), coverage
};

vec3 dewTone(vec3 c) {
  return 1.0 - exp(-c * 1.15);
}

// Brightness of linear light once rolled off for display, for the ramp.
float dewBright(vec3 light) {
  return 1.0 - exp(-dot(light, LUMA) * 1.15);
}

float dewByKind(vec3 values, float kind) {
  return kind < 0.5 ? values.x : (kind < 1.5 ? values.y : values.z);
}

// The key light (the sun, or the moon at night) seen from the camera, which keeps it off to the right.
DewLight dewLight(Sky view, float aspect) {
  DewLight lt;
  float sunW = dot(view.sunColor, vec3(1.0));
  float moonW = dot(view.moonColor, vec3(1.0));
  vec3 key = normalize(view.sun * (sunW + 1e-3) + view.moon * moonW);
  lt.L = vec3(key.x, key.y, -key.z);
  lt.H = normalize(lt.L + vec3(0.0, 0.0, 1.0001));
  lt.color = (view.sunColor + view.moonColor * 2.0) * DEW_SUN_GAIN;
  lt.sky = view.ambient;
  lt.back = max(-lt.L.z, 0.0);
  float f = 0.5 / tan(0.5 * DEW_FOV);
  float depth = max(key.z, 0.05);
  lt.glow = vec2(0.5 + key.x / depth * f / aspect, DEW_HORIZON + key.y / depth * f);
  return lt;
}

// Out-of-focus highlights on the dewy leaves and grass far behind: a few big soft discs, faint, warm
// where they face the low sun and pale elsewhere, each swelling and fading very slowly. 'q' in frame
// heights, 'sun' where the key light sits in the same, 'key' its strength, 'land' how much of this
// height is foliage (discs only light leaves, not the sky), 'aspect' the frame's width in heights.
vec3 dewBokeh(vec2 q, vec2 sun, float key, float land, float tm, float aspect) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    vec2 h = hash22(vec2(fi, 3.7));
    float h3 = hash12(vec2(fi, 9.1));
    float h4 = hash12(vec2(fi, 14.3));
    vec2 at = vec2((h.x * 1.1 - 0.05) * aspect, 0.2 + 0.4 * h.y) + 0.012 * vec2(sin(tm * 0.05 + fi * 2.0), cos(tm * 0.04 + fi * 3.0));
    float r = 0.035 + 0.055 * h3;
    float d = length(q - at) / r;
    if (d > 1.0) continue;
    float disc = 1.0 - smoothstep(0.55, 1.0, d);
    float ring = smoothstep(0.6, 0.95, d) * disc;
    float breathe = 0.8 + 0.2 * sin(tm * (0.04 + 0.03 * h4) + fi * 7.0);
    float warm = clamp(h4 * 0.5 + exp(-length(at - sun) * 1.4) * 0.9, 0.0, 1.0);
    vec3 tint = mix(vec3(0.85, 0.95, 0.82), vec3(1.0, 0.68, 0.28), warm);
    float amount = (0.05 + 0.07 * fract(h3 * 7.0) + 0.16 * warm) * (0.25 + 0.75 * key);
    sum += tint * amount * (0.75 * disc + 0.25 * ring) * breathe;
  }
  return sum * land;
}

// What lies behind the web, far out of focus, nothing in it finer than a few cells: the dawn sky
// graded from the gold haze at the horizon to blue overhead; a low hedge as a soft, hazy crown; the
// mist lying over the meadow, catching the low sun; the meadow's grass tops as a broad dark band
// that fades up into the mist with no line; a few big soft bokeh discs. Also what the water drops
// hold, upside down.
vec3 dewBackdrop(vec2 uv, float aspect, Sky view, DewLight lt, float tm, float stir) {
  int mode = int(K_backdrop + 0.5);
  float x = uv.x * aspect;
  vec3 dir = viewRay(uv, aspect, DEW_HORIZON, DEW_FOV);
  vec2 toLight = (uv - lt.glow) * vec2(aspect, 1.0);
  float near = exp(-length(toLight) * 1.6);
  float key = min(dot(lt.color, vec3(0.333)), 1.5);
  vec3 glow = lt.color * (0.3 * near + 0.6 * near * near);

  // The sky, its height stretched so the gradient from haze to blue shows within the frame.
  vec3 air = skyColor(view, normalize(vec3(dir.x, max(dir.y, 0.0) * 2.0 + 0.03, dir.z)));
  vec3 col = air + glow;

  // The hedge across the back: a low crown of rounded bushes, hazed toward the sky, its top lit.
  float top = DEW_HEDGE + 0.06 * vnoise(vec2(x * 1.3 + 7.0, 1.5)) + 0.03 * vnoise(vec2(x * 2.9 + 1.0, 4.5)) - 0.045;
  if (mode == 1) top += 0.4;
  float hedge = 1.0 - smoothstep(top - 0.1, top + 0.1, uv.y);
  vec3 leaves = mix(vec3(0.02, 0.04, 0.03) + lt.sky * 0.05, air * 0.5, 0.3) + lt.color * near * 0.1;
  col = mix(col, leaves, hedge * 0.9);
  col += lt.color * vec3(1.0, 0.8, 0.5) * exp(-abs(uv.y - top) / 0.08) * near * 0.25;

  // The meadow: its grass tops sway a hair in the breeze; dark below, thinning into the mist above.
  float sway = sin(tm * 0.21 + x * 2.0) * (0.004 + 0.02 * stir);
  float grassTop = DEW_HORIZON - 0.065 + 0.05 * vnoise(vec2(x * 1.7 + 3.0, 2.0)) + sway;
  float ground = 1.0 - smoothstep(grassTop - 0.2, grassTop + 0.12, uv.y);
  vec3 grass = vec3(0.05, 0.065, 0.028) * (0.45 + 0.9 * clamp(uv.y / DEW_HORIZON, 0.0, 1.0)) + lt.sky * 0.05 + lt.color * near * 0.1;
  grass += lt.color * vec3(1.0, 0.85, 0.4) * bell((uv.y - grassTop) / 0.1) * near * 0.15;
  col = mix(col, grass, ground);

  // The mist, lying just over the grass tops, lit from the sun's side.
  float mist = bell((uv.y - grassTop - 0.07) / 0.1);
  col += (lt.sky * 0.5 + lt.color * (0.12 + 0.5 * near)) * mist * (mode == 1 ? 0.06 : 0.3);

  col += dewBokeh(vec2(x, uv.y), lt.glow * vec2(aspect, 1.0), key, hedge, tm, aspect);
  if (mode == 2) {
    vec3 fog = lt.sky * 1.3 + vec3(0.33, 0.32, 0.3) + lt.color * (0.1 + 0.45 * near);
    col = mix(col, fog, 0.82);
  } else if (mode == 1) {
    col *= 0.42;
  }
  return col;
}

// A drop of water at 'center' with half-axes 'radii' ('off' = this cell - centre, out of focus by
// 'blur'; frame heights): a ball lens. Its body holds the scene behind it upside down and shrunk,
// darkening to the rim where the view glances off, and gathers the low sun's light toward its far
// side (more where its thread glints, 'lit'); 'spark' gets the coverage of the key light mirrored
// on its near side. Returns the body's colour (linear) and coverage.
vec4 dewWater(vec2 off, vec2 radii, float blur, vec2 center, float lit, DewLight lt, Sky view, DewView v, out float spark) {
  spark = 0.0;
  vec2 o = off / radii;
  float rr = length(o);
  float rc = min(radii.x, radii.y) / v.px;
  float soft = blur / v.px;
  // A crisp edge in focus (a small bead is then the round run of cells whose centres it covers),
  // widening and thinning out of focus.
  float edge = (0.2 + soft) / max(rc, 0.5);
  float cover = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, rr)) * rc / (rc + soft);
  if (cover <= 0.0) return vec4(0.0);
  vec2 oc = o / max(rr, 1.0);
  vec2 behind = vec2(center.x / v.aspect, center.y) - oc * vec2(DEW_LENS / v.aspect, DEW_LENS);
  vec3 seen = dewBackdrop(behind, v.aspect, view, lt, v.tm, 0.0);
  // The dark lens rim only shows on drops big enough to hold it; small beads stay solid.
  float rim = smoothstep(0.45, 1.0, length(oc)) * smoothstep(2.0, 4.0, rc);
  vec2 g = oc + lt.L.xy * 0.45;
  float gather = exp(-dot(g, g) / 0.4) * (0.4 + 0.6 * lt.back);
  vec3 body = seen * (1.0 - 0.7 * rim) + lt.color * vec3(1.0, 0.9, 0.55) * DEW_BODY * (0.5 + gather) * (1.0 + 1.5 * lit) * (1.0 - 0.5 * rim);
  float sr = max(0.24, 0.8 / max(rc, 1.0));
  float sd = length(oc - lt.H.xy * DEW_SPARK_AT);
  spark = (1.0 - smoothstep(sr * 0.7, sr * 1.3, sd)) * cover * rc / (rc + 2.0 * soft);
  return vec4(body, cover);
}

// A piece of grass, rounded: stalk, leaf blade, the seed head's spindle or one of its awns (piece).
// Lit from the low sun: its own colour, a soft key on the side that faces the light, leaves and
// the head glowing where the light comes through them, a gold rim, and beads of dew on stalk and leaf.
void dewStem(vec2 a, vec2 ab, float tt, float radius, float piece, float blur, float id, DewLight lt, Sky view, DewView v, inout DewAcc acc) {
  float len = max(length(ab), 1e-6);
  vec2 dir = ab / len;
  vec2 n = vec2(-dir.y, dir.x);
  vec2 pq = v.p - (a + ab * tt);
  float d = length(pq);
  float e = 0.6 * v.px + blur;
  float cover = 1.0 - smoothstep(radius - e, radius + e, d);
  if (cover > 0.0 && cover > acc.stem.a) {
    float u = clamp(dot(pq, n) / radius, -1.0, 1.0);
    float nz = sqrt(1.0 - u * u);
    vec3 nrm = vec3(n * u, nz);
    float diff = max(dot(nrm, normalize(lt.L)), 0.0);
    float rim = pow(max(dot(nrm.xy, normalize(lt.L.xy + 1e-4)), 0.0), 2.0) * smoothstep(0.35, 0.95, abs(u));
    vec3 albedo;
    float through = 0.0;
    if (piece < DEW_PIECE_LEAF - 0.5) {
      // The stalk: green, going to straw toward the top, a darker node every so often.
      float node = smoothstep(0.93, 1.0, abs(fract(v.p.y * 6.0 + floor(v.p.x) * 0.37) - 0.5) * 2.0);
      albedo = mix(vec3(0.16, 0.23, 0.07), vec3(0.3, 0.26, 0.09), smoothstep(0.5, 1.0, v.p.y)) * (1.0 - 0.3 * node);
    } else if (piece < DEW_PIECE_HEAD - 0.5) {
      // The blade: a paler midrib, light through it.
      albedo = vec3(0.13, 0.26, 0.06) * (1.0 + 0.5 * exp(-u * u * 14.0));
      through = 0.5;
    } else if (piece < DEW_PIECE_AWN - 0.5) {
      // The head: tawny, banded by its spikelets.
      float seeds = 0.65 + 0.35 * smoothstep(0.2, 0.8, abs(fract((id + tt) * 3.0) - 0.5) * 2.0);
      albedo = vec3(0.36, 0.26, 0.09) * seeds;
      through = 0.35;
    } else {
      albedo = vec3(0.5, 0.38, 0.15);
      through = 1.0;
    }
    vec3 col = albedo * (lt.sky * 1.3 * (0.4 + 0.6 * nz) + lt.color * (0.08 * lt.back + 0.22 * diff + through * lt.back * 0.3) + 0.01)
      + lt.color * vec3(1.0, 0.85, 0.45) * rim * (0.25 + 0.35 * lt.back);
    acc.stem = vec4(col, cover);
  }
  if (v.dew <= 0.0 || piece > DEW_PIECE_LEAF + 0.5) return;
  float j = floor(tt * len / DEW_STEM_BEADS);
  float h = hash12(vec2(id * 7.1, j));
  if (h > DEW_STEM_WET * v.dew) return;
  float side = fract(h * 13.0) > 0.5 ? 1.0 : -1.0;
  float rb = max(DEW_BEAD_R * (0.8 + 0.4 * fract(h * 29.0)) * (0.55 + 0.45 * v.dew), 1.1 * v.px);
  vec2 c = a + dir * ((j + 0.5 + (fract(h * 7.0) - 0.5) * 0.3) * DEW_STEM_BEADS) + n * side * radius * 0.85 - vec2(0.0, rb * DEW_BEAD_HANG);
  vec2 off = v.p - c;
  if (dot(off, off) < pow(rb + blur + 2.0 * v.px, 2.0)) {
    float spark;
    vec4 water = dewWater(off, vec2(rb), blur, c, 0.3, lt, view, v, spark);
    if (water.a > acc.water.a) {
      acc.water = water;
      acc.spark = spark;
    }
  }
}

vec4 dewSegTexel(int s, int j) {
  return texelFetch(uSim0, ivec2((s % DEW_SEG_ROW) * DEW_SEG_TEXELS + j, s / DEW_SEG_ROW), 0);
}

// A bead of dew on a thread at parameter 'tc' and radius 'rb' (frame heights), hanging below it.
void dewBead(vec2 a, vec2 ab, vec4 m, float tc, float rb, float lit, DewLight lt, Sky view, DewView v, inout DewAcc acc) {
  vec2 center = a + ab * tc - vec2(0.0, rb * DEW_BEAD_HANG);
  vec2 off = v.p - center;
  float blur = min(DEW_BLUR_MAX, abs(mix(m.x, m.y, tc) - v.focus) * v.dof);
  if (dot(off, off) > pow(rb + blur + 2.0 * v.px, 2.0)) return;
  float spark;
  vec4 water = dewWater(off, vec2(rb), blur, center, lit, lt, view, v, spark);
  if (water.a > acc.water.a) {
    acc.water = water;
    acc.spark = spark;
  }
}

// One thread (or stem) from the records: its silk, its glint, its beads.
void dewSegment(int s, DewLight lt, Sky view, DewView v, inout DewAcc acc) {
  vec4 h = dewSegTexel(s, 0);
  vec4 l = dewSegTexel(s, 1);
  vec4 m = dewSegTexel(s, 2);
  vec2 a = h.xy + l.xy;
  vec2 b = h.zw + l.zw;
  vec2 ab = b - a;
  float len2 = max(dot(ab, ab), 1e-12);
  float tt = clamp(dot(v.p - a, ab) / len2, 0.0, 1.0);
  vec2 q = a + ab * tt;
  float blur = min(DEW_BLUR_MAX, abs(mix(m.x, m.y, tt) - v.focus) * v.dof);
  float kind = floor(m.w / DEW_CODE + 0.001);
  float extra = m.w - kind * DEW_CODE;
  if (kind > DEW_KIND_STEM - 0.5) {
    // A stem's piece: its radius at b rides in the wet slot, with the piece's kind (sim.ts #piece).
    float piece = floor(m.z / DEW_CODE + 0.001);
    float radiusB = m.z - piece * DEW_CODE;
    dewStem(a, ab, tt, max(mix(extra, radiusB, tt) * DEW_STEM_UNIT, 1e-4), piece, blur, float(s), lt, view, v, acc);
    return;
  }

  // The thread's axis: radii and frame threads run straight; the capture spiral winds round the
  // hub, so its axis comes from its winding here, and its glints swell and fade along it.
  bool spiral = abs(kind - DEW_KIND_SPIRAL) < 0.5;
  float len = sqrt(len2);
  vec2 axis = ab / len;
  if (spiral) {
    vec2 radial = q - v.hub;
    vec2 around = vec2(-radial.y, radial.x) / max(length(radial), 1e-5);
    axis = dot(around, axis) < 0.0 ? -around : around;
  }
  vec3 T = normalize(vec3(axis, (m.y - m.x) / len * DEW_TILT));
  float c = dot(T, lt.H);
  float sigma = spiral ? DEW_SOFT_GLINT : DEW_SHARP_GLINT;
  float glint = exp(-c * c / (sigma * sigma));
  float sheen = exp(-c * c / (4.0 * sigma * sigma));

  // Silk: a line as wide as the thread (swelling where it glints), box-filtered over the cell and
  // the blur, so a thread out of focus spreads and thins as one does through a lens.
  float d = length(v.p - q) / v.px;
  float e = 0.5 + blur / v.px;
  float w = (kind > DEW_KIND_FRAME - 0.5 ? DEW_FRAME_HALF : DEW_SILK_HALF) * (1.0 + DEW_GLINT_SWELL * glint);
  float cover = max(0.0, min(d + e, w) - max(d - e, -w)) / (2.0 * e);
  if (cover > 0.0) {
    vec3 light = lt.color * (DEW_SILK_GLOW * (0.35 + 0.65 * lt.back) + DEW_SHEEN * sheen + DEW_GLINT * glint) + lt.sky * DEW_SILK_SKY;
    float rank = cover * dot(light, LUMA);
    if (rank > acc.silkRank) {
      acc.silk = light;
      acc.silkCover = cover;
      acc.silkRank = rank;
      acc.glint = glint;
    }
  }

  // Beads: the dew strung along it at even spacing (Rayleigh-Plateau: a wet thread breaks up into a
  // row of beads), gone where a drop has swept it, regrowing as the dew condenses again.
  float wet = floor(m.z) / DEW_WET_LEVELS;
  float dry = (fract(m.z) - 0.5) / 0.45;
  if (extra < 0.5 || wet <= 0.0 || v.dew <= 0.0) return;
  float base = DEW_BEAD_R * dewByKind(DEW_BEAD_SCALE, kind) * (0.55 + 0.45 * v.dew) * pow(wet, 1.0 / 3.0);
  if (base < 0.5 * v.px) return;
  float presence = dewByKind(DEW_PRESENCE_BASE, kind) + dewByKind(DEW_PRESENCE_DEW, kind) * v.dew;
  float j = min(floor(tt * extra), extra - 1.0);
  vec2 key = vec2(float(s), j);
  float tc = (j + 0.5 + (hash12(key + 17.3) - 0.5) * 0.08) / extra;
  bool swept = dry > 0.02 ? tc < dry : (dry < -0.02 ? tc > -dry : false);
  if (hash12(key + 0.5) < presence && !swept) {
    dewBead(a, ab, m, tc, max(base * (0.85 + 0.3 * hash12(key + 41.9)), 1.1 * v.px), glint, lt, view, v, acc);
  }
  // Dew gathers where the capture spiral crosses a radius: a bigger bead at some crossings.
  if (spiral && hash12(vec2(float(s), 91.7)) < 0.35 * presence && !(dry > 0.02)) {
    dewBead(a, ab, m, 0.0, max(base * 1.25, 1.1 * v.px), glint, lt, view, v, acc);
  }
}

// One of the big drops: pendant on its thread (or falling, drawn out by its speed), wobbling when shaken.
void dewDrop(int d, DewLight lt, Sky view, DewView v, inout DewAcc acc) {
  vec4 h = texelFetch(uSim2, ivec2(d * 2, 0), 0);
  vec4 g = texelFetch(uSim2, ivec2(d * 2 + 1, 0), 0);
  if (g.x <= 0.0) return;
  vec2 c = h.xy + h.zw;
  vec2 radii = max(g.x * vec2(1.0 + g.w, (1.0 - g.w) * g.z), vec2(1.1 * v.px));
  float blur = min(DEW_BLUR_MAX, abs(g.y - v.focus) * v.dof);
  vec2 off = v.p - c;
  float reach = max(radii.x, radii.y) + blur + 2.0 * v.px;
  if (dot(off, off) > reach * reach) return;
  float spark;
  vec4 water = dewWater(off, radii, blur, c, 0.3, lt, view, v, spark);
  if (water.a > acc.water.a) {
    acc.water = water;
    acc.spark = spark;
  }
}

// The wasp spider (Argiope) resting head down at the hub with her legs held in pairs, the X her
// kind is named for; once in a while she shifts one leg and sets it back. A dark body: silvery
// carapace, a shield of cream, gold and black bands, dark legs ringed gold at the joints, every edge
// toward the low sun rimmed with light. 'q' in her units (y up the web), 'cells' per unit. Returns
// colour (linear) and coverage.
vec4 dewSpider(vec2 q, float cells, DewLight lt, float tm, vec2 gait) {
  if (dot(q, q) > 11.0) return vec4(0.0);
  float aa = 0.7 / cells;
  float thin = 0.8 / cells;
  float epoch = floor(tm / 23.0);
  float phase = fract(tm / 23.0);
  float lift = hash12(vec2(epoch, 9.1)) < 0.55 ? smoothstep(0.5, 0.6, phase) * (1.0 - smoothstep(0.72, 0.84, phase)) : 0.0;
  int twitch = int(hash12(vec2(epoch, 5.3)) * 8.0);
  vec2 lxy = normalize(lt.L.xy + 1e-4);
  // Neutral, so her cream, gold and silver keep their hues once snapped to the palette.
  vec3 lit = vec3(dot(lt.sky * 1.3 + lt.color * 0.22, LUMA) + 0.03) * vec3(1.0, 0.95, 0.8);

  float legD = 1e3;
  float legAlong = 0.0;
  vec2 legDir = vec2(0.0, 1.0);
  for (int i = 0; i < 8; i++) {
    int k = i / 2;
    float side = i % 2 == 0 ? 1.0 : -1.0;
    // Root angle from her head, femur, the bend at the knee, tibia and the rest.
    // Pairs: legs I and II held together reaching down either side, III and IV together up either side, an X.
    vec4 leg = k == 0 ? vec4(0.5, 1.0, 0.18, 1.1) : k == 1 ? vec4(0.82, 0.95, -0.05, 1.0) : k == 2 ? vec4(2.15, 0.85, 0.2, 0.95) : vec4(2.5, 1.0, -0.1, 1.0);
    // Walking, the legs swing in alternation: the amplitude and phase come in as 'gait' (zero at rest).
    float stride = gait.x * 0.22 * sin(gait.y + 3.14159265 * float(k + i % 2));
    float raise = (i == twitch ? 0.28 * lift : 0.0) + stride;
    vec2 d1 = vec2(side * sin(leg.x + raise), -cos(leg.x + raise));
    vec2 d2 = vec2(side * sin(leg.x + leg.z + raise * 0.5), -cos(leg.x + leg.z + raise * 0.5));
    vec2 root = vec2(0.0, -0.36) + d1 * 0.16;
    vec2 knee = root + d1 * leg.y;
    vec2 tip = knee + d2 * leg.w;
    float along;
    float df = sdTaperCapsule(q, root, knee, max(0.085, thin), max(0.07, thin), along);
    if (df < legD) { legD = df; legAlong = along * 0.5; legDir = d1; }
    float dt = sdTaperCapsule(q, knee, tip, max(0.065, thin), max(0.045, thin), along);
    if (dt < legD) { legD = dt; legAlong = 0.5 + along * 0.5; legDir = d2; }
  }
  // Legs: dark, ringed gold at the joints; the ones lying across the light catch it along their length.
  float ring = step(0.6, fract(legAlong * 3.0 + 0.1));
  float across = 1.0 - abs(dot(legDir, lxy));
  vec3 legCol = mix(vec3(0.03, 0.025, 0.02), vec3(0.7, 0.52, 0.16), ring) * lit + lt.color * (0.04 + 0.22 * across * across * lt.back);
  float legCover = 1.0 - smoothstep(-aa, aa, legD);
  // Premultiplied while the parts are laid over one another.
  vec4 col = vec4(legCol * legCover, legCover);

  // Cephalothorax: silvery hair, rimmed where it faces the sun.
  vec2 cq = (q - vec2(0.0, -0.36)) / vec2(0.25, 0.3);
  float cover = 1.0 - smoothstep(-aa, aa, (length(cq) - 1.0) * 0.25);
  if (cover > 0.0) {
    vec2 cn = cq / max(length(cq), 1.0);
    float nz = sqrt(max(1.0 - dot(cn, cn), 0.0));
    float rim = (1.0 - nz) * max(dot(cn, lxy), 0.0) * lt.back;
    vec3 c = vec3(0.8, 0.78, 0.7) * lit * (0.55 + 0.45 * nz) + lt.color * rim * 0.6;
    col = mix(col, vec4(c, 1.0), cover);
  }
  // Abdomen: a lobed shield, cream at the front, then gold and black bands, amber at its rim.
  vec2 aq = q - vec2(0.0, 0.42);
  float ay = aq.y / 0.58;
  float aw = 0.36 * (1.0 + 0.18 * ay) * (1.0 + 0.04 * sin(ay * 14.0));
  vec2 an = aq / vec2(aw, 0.58);
  cover = 1.0 - smoothstep(-aa, aa, (length(an) - 1.0) * aw);
  if (cover > 0.0) {
    vec2 nn = an / max(length(an), 1.0);
    float nz = sqrt(max(1.0 - dot(nn, nn), 0.0));
    float stripe = fract(ay * 2.2 + 0.25);
    float black = smoothstep(0.55, 0.62, stripe) * (1.0 - smoothstep(0.86, 0.93, stripe));
    vec3 skin = mix(mix(vec3(0.95, 0.74, 0.2), vec3(0.9, 0.88, 0.8), smoothstep(-0.3, 0.5, -ay)), vec3(0.02, 0.018, 0.015), black);
    float rim = (1.0 - nz) * max(dot(nn, lxy), 0.0) * lt.back;
    vec3 c = skin * lit * (0.55 + 0.45 * nz) + lt.color * vec3(1.0, 0.7, 0.3) * rim * 0.6;
    col = mix(col, vec4(c, 1.0), cover);
  }
  return vec4(col.rgb / max(col.a, 1e-4), col.a);
}

// The stabilimentum: a band of zig-zag silk across the hub, woven here as an M. 'q' in frame
// heights about the hub (y up the web). Returns the silk's coverage.
float dewStabilimentum(vec2 q, float size, float px) {
  vec2 m = q / size;
  if (abs(m.x) > 0.62 || abs(m.y) > 0.64) return 0.0;
  float amp = 4.5 * px / size;      // half-width of the zig-zag, mark units (~4.5 cells)
  float stride = 3.25 * px / size;  // one zig (half a period)
  float silk = 0.0;
  float sheet = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = markVertex(i);
    vec2 b = markVertex(i + 1);
    float len = length(b - a);
    vec2 dir = (b - a) / len;
    vec2 r = m - a;
    float u = dot(r, dir);
    float w = dot(r, vec2(-dir.y, dir.x));
    if (u < -amp || u > len + amp || abs(w) > 2.0 * amp) continue;
    float last = floor(len / stride);
    float k0 = clamp(floor(u / stride), 0.0, last - 1.0);
    for (int j = -1; j <= 1; j++) {
      float k = clamp(k0 + float(j), 0.0, last - 1.0);
      float s0 = mod(k, 2.0) < 0.5 ? -1.0 : 1.0;
      float dz = segmentDistance(vec2(u, w), vec2(k * stride, s0 * amp), vec2((k + 1.0) * stride, -s0 * amp)) * size / px;
      silk = max(silk, clamp(1.25 - dz, 0.0, 1.0));
    }
    sheet = max(sheet, (1.0 - smoothstep(amp * 0.8, amp * 1.05, abs(w))) * step(0.0, u) * step(u, len));
  }
  return max(silk, sheet * 0.22);
}

// The orb weaver's own stabilimentum: a ribbon of zig-zag silk up and down the web through the hub,
// above and below the spider, narrowing toward its ends. 'q' in frame heights about the hub (y up
// the web), 'unit' her unit in the same. Returns the silk's coverage.
float dewZigzag(vec2 q, float unit, float px) {
  float y = abs(q.y);
  float y0 = 1.1 * unit;
  float y1 = 5.6 * unit;
  float amp = max(0.3 * unit, 3.5 * px);   // half-width of the zig-zag
  float stride = max(0.2 * unit, 2.6 * px); // one zig (half a period)
  if (y < y0 - 2.0 * px || y > y1 + 2.0 * px || abs(q.x) > amp + 2.0 * px) return 0.0;
  float last = floor((y1 - y0) / stride);
  float k0 = clamp(floor((y - y0) / stride), 0.0, last - 1.0);
  float silk = 0.0;
  for (int j = -1; j <= 1; j++) {
    float k = clamp(k0 + float(j), 0.0, last - 1.0);
    float s0 = mod(k, 2.0) < 0.5 ? -1.0 : 1.0;
    float ak = amp * (1.0 - 0.5 * smoothstep(0.55, 1.0, k / last));
    float bk = amp * (1.0 - 0.5 * smoothstep(0.55, 1.0, (k + 1.0) / last));
    float dz = segmentDistance(vec2(q.x, y), vec2(s0 * ak, y0 + k * stride), vec2(-s0 * bk, y0 + (k + 1.0) * stride)) / px;
    silk = max(silk, clamp(1.25 - dz, 0.0, 1.0));
  }
  float sheet = (1.0 - smoothstep(amp * 0.8, amp * 1.05, abs(q.x))) * step(y0, y) * step(y, y1);
  return max(silk, sheet * 0.2);
}

Shade sceneDew(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float tm = uMotionTime;
  int mode = int(K_backdrop + 0.5);

  // The low sun, kept off the frame's right edge by the camera, wandering a few degrees.
  Sky sky = skyAt(timeOfDayM(K_time, K_cycle, uMotionTime));
  float bearing = atan(DEW_SUN_X * aspect * 2.0 * tan(0.5 * DEW_FOV)) + DEW_SUN_WANDER * sin(tm * TAU / DEW_DRIFT);
  float yaw = atan(sky.sun.x, sky.sun.z) - bearing;
  Sky view = skyFacing(sky, yaw);
  DewLight lt = dewLight(view, aspect);
  if (mode == 2) {
    // Mist scatters the sun: softer glints, more light from all round.
    lt.color *= 0.65;
    lt.sky = lt.sky * 1.3 + 0.08;
  }
  // The whites silk and dew are inked in: golden by day, bluer under the moon.
  float warmth = smoothstep(-0.2, 0.2, (lt.color.r - lt.color.b) / (lt.color.r + lt.color.b + 1e-3));
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 1.0, 0.6), warmth);

  DewView v;
  v.p = vec2(uv.x * aspect, uv.y);
  v.hub = vec2(-10.0);
  v.px = 1.0 / uRes.y;
  v.focus = 0.0;
  v.dof = DEW_DOF * K_dof;
  v.dew = K_dew;
  v.aspect = aspect;
  v.tm = tm;
  v.stir = 0.0;
  float turn = 0.0;
  float webR = 0.4;
  // Pages of bin lists: one unless a dense patch (the hub of a small or portrait frame) needs more.
  int binPages = 1;
  if (uSimOn.w > 0.5) {
    vec4 h0 = texelFetch(uSim3, ivec2(0, 0), 0);
    vec4 h1 = texelFetch(uSim3, ivec2(1, 0), 0);
    vec4 h2 = texelFetch(uSim3, ivec2(2, 0), 0);
    v.hub = h0.xy + h0.zw;
    v.focus = h1.y;
    turn = h1.z;
    webR = h1.w;
    v.stir = h2.x + 0.5 * h2.y;
    binPages = max(1, int(h2.z + 0.5));
  }

  // Behind, shifting a little against the web as the viewer moves.
  vec3 col = dewTone(dewBackdrop(uv - uPointer * vec2(0.008, 0.005), aspect, view, lt, tm, v.stir));

  DewAcc acc;
  acc.silk = vec3(0.0);
  acc.silkCover = 0.0;
  acc.silkRank = 0.0;
  acc.glint = 0.0;
  acc.water = vec4(0.0);
  acc.spark = 0.0;
  acc.stem = vec4(0.0);
  if (uSimOn.x > 0.5 && uSimOn.y > 0.5 && uSimOn.z > 0.5) {
    ivec3 bin = binListsAt(uSim1, binPages, v.p);
    int slots = BIN_PAGE * binPages;
    for (int k = 0; k < slots; k++) {
      float id = binListsEntry(uSim1, bin, k);
      if (id == 0.0) break;
      if (id > 0.0) dewSegment(int(id + 0.5) - 1, lt, view, v, acc);
      else dewDrop(int(-id + 0.5) - 1, lt, view, v, acc);
    }
  }

  // Stems: hard-edged against the cell's threshold, shaded smoothly.
  if (hardEdge(acc.stem.a) > 0.5) col = dewTone(acc.stem.rgb);
  // Silk: faint stipple, or solid where it glints.
  vec4 silk = hardRamp(dewBright(acc.silk), acc.silkCover, tint, cellTh);
  if (silk.a > 0.5) col = silk.rgb;

  // At the hub: a mat of dense silk under her, her M of zig-zag silk.
  vec2 local = rotate(v.p - v.hub, -turn);
  float unit = webR * DEW_SPIDER;
  // The entrance: she walks head down along the top radius from the frame to the hub (up the web from
  // the hub she is 'walkUnits' of her own), her legs in a gait that follows the ground she covers, and
  // on arrival spins her M or her ribbon out from the hub (the 'weave' reach, in her units and the M's
  // size). All of it is off at rest.
  float walkUnits = 0.0;
  vec2 gait = vec2(0.0);
  float weaveM = 1000.0;
  float weaveZ = 1000.0;
  if (passageIn() < 1.0) {
    float te = passageIn() * DEW_ENTER;
    float walkX = clamp((te - DEW_WALK_FROM) / (DEW_WALK_TO - DEW_WALK_FROM), 0.0, 1.0);
    float pos = walkX * walkX * (3.0 - 2.0 * walkX);
    walkUnits = (1.0 - pos) * DEW_WALK_START / DEW_SPIDER;
    gait = vec2(min(1.0, 6.0 * walkX * (1.0 - walkX)), walkUnits * 2.4);
    float weave = clamp((te - DEW_WALK_TO) / (DEW_ENTER - DEW_WALK_TO), 0.0, 1.0);
    weaveM = weave * 0.95;
    weaveZ = weave * 6.0;
  }
  vec3 silkWhite = vec3(0.95, 0.93, 0.88) * (lt.sky * 1.6 + lt.color * 0.45 * (0.5 + 0.5 * lt.back) + 0.08);
  if (K_spider > 0.5) {
    float mat = (1.0 - smoothstep(0.7, 1.0, length(local) / (unit * DEW_MAT))) * 0.35;
    vec4 hubSilk = hardRamp(dewBright(silkWhite * 0.4), mat, tint, cellTh);
    if (hubSilk.a > 0.5) col = hubSilk.rgb;
  }
  float markOn = 0.0;
  if (K_mark > 0.0) {
    float markSize = webR * mix(DEW_MARK_MIN, DEW_MARK_MAX, K_mark);
    vec4 band = hardRamp(dewBright(silkWhite), dewStabilimentum(local, markSize, v.px) * step(length(local), weaveM * markSize), tint, cellTh);
    markOn = band.a;
    if (markOn > 0.5) col = band.rgb;
  } else if (K_spider > 0.5) {
    // Her own stabilimentum: the zig-zag ribbon above and below the hub.
    vec4 band = hardRamp(dewBright(silkWhite), dewZigzag(local, unit, v.px) * step(abs(local.y), weaveZ * unit), tint, cellTh);
    if (band.a > 0.5) col = band.rgb;
  }

  // Dew: the bead or drop's body, then its spark.
  vec4 water = hardRamp(dewBright(acc.water.rgb), acc.water.a, tint, cellTh);
  if (water.a > 0.5) col = water.rgb;
  float sparkOn = hardEdge(acc.spark);
  if (sparkOn > 0.5) col = hardRamp(1.0, 1.0, vec3(1.0, 1.0, 0.9), cellTh).rgb;

  if (K_spider > 0.5) {
    // She is opaque: her colour snapped to the palette, black where she is dark, a silhouette on the mat.
    vec4 spider = dewSpider(local / unit - vec2(0.0, walkUnits), unit / v.px, lt, tm, gait);
    if (hardEdge(spider.a) > 0.5) {
      col = snapLevel(dewTone(spider.rgb));
      markOn = 0.0;
    }
  }

  // Mist is light: the page goes to its paper theme (index.ts) and ink turns dark on it.
  float ink = inkOf(col, 1.3, 0.8, vec2(0.92, 0.8));
  // The accent is all or nothing per cell too: glinting silk and the sparks on the dew.
  float accent = K_mark > 0.0 ? markOn : max(silk.a * step(0.5, acc.glint), sparkOn);
  return shadeOf(col, ink, accent);
}
`;
