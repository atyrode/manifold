// The handscroll's picture. Everything painted is a pure function of P = (x along the scroll, y),
// in screen heights; the sim (sim.ts) says how far the scroll has unrolled:
//   uSim0  texel 0 scroll within its section (k, hi, lo, mist reshaping clock); texel 1 mist drift
//          (k, hi, lo, section number); texel 2 geese leader (x hi, x lo, y, skein number); texel 3
//          seal (x hi, x lo, y, age)
//   uSim1  the pointer's breath over the page (uv), thinning the mist.
// Five layers of forms are painted front to back: river banks, the near peaks, a middle range and
// two far ranges. Each layer is a row of overlapping mountain forms on a lattice along the scroll,
// each form asymmetric, craggy and often shouldered or stepped; at a pixel the frontmost form
// covering it is painted (contour, wash, fold lines with texture strokes hung beneath them, moss
// dots), so forms stack and outline one another as in a painting. Mist is bare paper: bands of it
// fade what lies behind them. Ink is laid as a density and turned into colour through the paper.
// Knobs read here: K_seed, K_detail, K_palette, K_season, K_density, K_wetness, K_cun, K_age,
// K_mist, K_boats, K_dwellings, K_falls, K_inscription, K_seal (K_speed, K_drift, K_birds: sim).
// The scroll comes in sections of SHANSHUI_SECTION heights, each painted from its own origin (and
// its own row of the seed's hash plane) and joined to the one before by a strip of mounting silk,
// the paintings either side dissolving into bare paper toward it, as separators join the sections
// of a long handscroll. So P stays small however long the scroll unrolls: measured on a 540-row
// frame, from ~4000 heights out a float32 P only moved every few frames, from ~32000 the frame
// froze between one-cell jumps and seal strokes broke into two-cell columns, and the half floats
// handing over the scroll run out at 65536.
import { glslFloat } from "../../shaders/glsl.ts";

/**
 * Seconds of the scroll's entrance (it is drawn open from its roll, the painting riding in behind
 * its roller) and exit (it is wound up again) (SceneDef.passage).
 */
export const SHANSHUI_PASSAGE = { enter: 3, exit: 1.4 } as const;

/**
 * Screen heights of one section of the scroll (at the default speed about six days of unrolling,
 * at the fastest a day and a half), and how many sections the seed rows cycle through. Texel 1's
 * alpha is the section number modulo SHANSHUI_SECTIONS, plus SHANSHUI_SECTIONS once there is an
 * earlier section to join on to.
 */
export const SHANSHUI_SECTION = 2048;
export const SHANSHUI_SECTIONS = 1024;

export const shanshuiGlsl = `
const float SHAN_SECTION = ${glslFloat(SHANSHUI_SECTION)};
const float SHAN_SECTIONS = ${glslFloat(SHANSHUI_SECTIONS)};
// The join with the section before: where it lies on the new section's painting (so it enters off
// the left edge), the silk's half width, and the bare paper either side.
const float SHAN_JOIN_AT = -0.4;
const float SHAN_JOIN_SILK = 0.026;
const float SHAN_JOIN_FADE = 0.3;
const vec3 SHAN_PAPER_NEW = vec3(0.949, 0.925, 0.851); // fresh paper
const vec3 SHAN_PAPER_OLD = vec3(0.851, 0.769, 0.604); // tea-coloured with age
const vec3 SHAN_ABSORB = vec3(0.94, 1.0, 1.12);        // sumi: dilute it greys a little warm
const vec3 SHAN_CINNABAR = vec3(0.77, 0.19, 0.12);     // seal paste
const vec3 SHAN_AZURITE = vec3(0.21, 0.42, 0.63);
const vec3 SHAN_MALACHITE = vec3(0.27, 0.55, 0.45);
const vec3 SHAN_OCHRE = vec3(0.77, 0.56, 0.35);
const vec3 SHAN_BLOSSOM = vec3(0.93, 0.66, 0.7);      // peach blossom (spring)
const vec3 SHAN_MAPLE = vec3(0.8, 0.36, 0.16);        // maple leaves (autumn)
const float SHAN_SHEET = 1.9;  // width of one sheet of paper along the scroll, in screen heights

// Set once per pixel by the entry: the seed's hash row and one dither cell in screen heights.
float shanSeed = 0.0;
float shanPx = 0.001;

// The seed's row on the hash plane for a section of the scroll: each seed reads the plane at its
// own offset, scattered by an irrational step, and each section after the first steps on again.
float shanSeedOf(float section) {
  return 0.5 + fract(floor(K_seed + 0.5) * 0.7548777 + section * 0.618034) * 640.0;
}

float shanHash(float x, float row) {
  return hash12(vec2(x, row + shanSeed));
}

// 1D value noise along the scroll and its derivative, on the seed's hash row.
vec2 shanNoise(float x, float row) {
  return vnoise1(x, row + shanSeed);
}

// The sim's split half floats rebuilt: k * 32 + (hi + lo) / 64.
float shanUnsplit(vec4 v) {
  return v.x * 32.0 + (v.y + v.z) / 64.0;
}

// Layers: 0 river banks, 1 near peaks, 2 middle range, 3 far peaks, 4 the farthest range.
// Lattice cell, base height, lowest and tallest form; all in screen heights.
vec4 shanLayerShape(int layer) {
  if (layer == 0) return vec4(0.9, -0.05, 0.1, 0.24);
  if (layer == 1) return vec4(0.21, 0.07, 0.12, 0.86);
  if (layer == 2) return vec4(0.17, 0.24, 0.05, 0.3);
  if (layer == 3) return vec4(0.26, 0.37, 0.06, 0.4);
  return vec4(0.4, 0.47, 0.05, 0.34);
}

// Contour width in cells, wash, texture strokes, overall ink. Nearer is bolder; the two far ranges
// are boneless washes with no contour at all.
vec4 shanLayerStyle(int layer) {
  if (layer == 0) return vec4(2.6, 0.3, 1.0, 1.15);
  if (layer == 1) return vec4(2.4, 0.26, 1.0, 1.0);
  if (layer == 2) return vec4(1.4, 0.36, 0.45, 0.7);
  if (layer == 3) return vec4(0.0, 0.8, 0.0, 0.55);
  return vec4(0.0, 0.75, 0.0, 0.34);
}

struct ShanForm {
  float c;         // centre along the scroll
  float w;         // half width
  float H;         // height above the layer's base (0: no form here)
  vec2 a;          // fall of the left and right flanks: low is sheer, high a long concave slope
  float skew;      // where the summit stands, in half widths from the centre
  float shoulder;  // a lower second summit on the gentler flank, as a share of H (0: none)
  float steps;     // rock planes stacked into ledges, how many (0: none)
  float z;         // depth order within the layer: low is in front
  float kind;      // texture strokes: 0 hemp-fibre, 1 axe-cut
  float seed;      // 0..1, for everything else
  float fall;      // where a waterfall drops, in half widths from the centre; -9: none
};

ShanForm shanFormAt(int layer, float i) {
  vec4 L = shanLayerShape(layer);
  float row = float(layer) * 17.0;
  float h1 = shanHash(i, row);
  float h2 = shanHash(i, row + 1.0);
  float h3 = fract(h1 * 41.3 + h2 * 7.1);
  float h4 = fract(h1 * 13.9 + h2 * 29.3);
  ShanForm f;
  f.seed = fract(h1 * 7.13 + h2 * 3.71);
  f.c = (i + 0.2 + 0.6 * h1) * L.x;
  f.w = L.x * (0.4 + 0.45 * h2);
  f.z = fract(h1 * 91.7 + h2 * 3.3);
  f.kind = K_cun < 0.5 ? 0.0 : K_cun < 1.5 ? 1.0 : step(0.5, fract(h2 * 57.3));
  bool axe = f.kind > 0.5;
  // No two alike, none symmetric: the summit off centre, one flank sheer and the other a long fall,
  // often a shoulder, and rock that breaks into ledges where it is cut with the axe.
  f.skew = (h4 - 0.5) * 0.7;
  f.a = axe ? vec2(0.3 + 0.35 * h4, 0.5 + 0.9 * h3) : vec2(0.7 + 0.8 * h3, 0.6 + 0.7 * h4);
  if (fract(h1 * 3.1) > 0.5) f.a = f.a.yx;
  f.shoulder = fract(h2 * 11.3) < 0.6 ? 0.35 + 0.35 * fract(h1 * 17.9) : 0.0;
  f.steps = axe ? 3.0 + floor(3.0 * fract(h2 * 5.7)) : 0.0;
  f.fall = -9.0;
  // Massifs rise and fall along the scroll, then the land opens out to water and level distance.
  float env = shanNoise(f.c / (layer == 1 ? 2.0 : 1.6), row + 2.0).x;
  float massif = smoothstep(0.28, 0.72, env);
  f.H = L.z + (L.w - L.z) * h3 * (0.15 + 0.85 * massif);
  if (layer == 0) {
    // Banks are low, flat-topped and only here and there: between them lies open water.
    f.a = vec2(0.22 + 0.15 * h4);
    f.skew = 0.0;
    f.shoulder = 0.0;
    f.steps = 0.0;
    f.w = L.x * (0.28 + 0.3 * h2);
    if (fract(h2 * 23.1) > 0.55) f.H = 0.0;
  } else if (layer == 1) {
    // The near peaks come in massifs, a main peak among many lower ones; between massifs only
    // the odd low hill stands in the water.
    massif = smoothstep(0.4, 0.74, env);
    f.H = massif > 0.2 ? L.z + (L.w - L.z) * (0.25 + 0.75 * h3 * h3) * massif : (fract(h1 * 3.7 + h2 * 1.9) < 0.2 ? 0.1 + 0.1 * h3 : 0.0);
    // Tall peaks stand broader at the foot. (At most 1.15 cells either side: the lattice search
    // looks one cell each way.)
    f.w *= 0.85 + 0.5 * h3 * massif;
    // Needle peaks, as on Huangshan: sheer pillars of stacked stone.
    if (massif > 0.3 && fract(h2 * 31.7) < 0.3) {
      f.w *= 0.42;
      f.H = max(f.H, L.z + (L.w - L.z) * (0.45 + 0.4 * h4) * massif);
      f.a = vec2(0.28, 0.34);
      f.skew *= 0.3;
      f.shoulder = 0.0;
      f.steps = 4.0 + floor(3.0 * h4);
    }
    if (K_falls > 0.5 && f.H > 0.34 && f.w > 0.09 && fract(h2 * 13.9) < 0.45) f.fall = f.skew + (fract(h1 * 5.3) - 0.5) * 0.4;
  } else if (layer == 4) {
    // The farthest range only shows now and then, high and pale over everything else.
    if (env < 0.45) f.H = 0.0;
  }
  return f;
}

// Height of a form above its layer's base at X, and its slope. The summit stands off centre and
// each flank falls at its own pace; a shoulder rises on the gentler flank with a notch between;
// stacked rock steps down in ledges; a waterfall comes over a notch in the crest.
vec2 shanProfile(ShanForm f, float X) {
  if (f.H <= 0.0) return vec2(-1.0, 0.0);
  float u = (X - f.c) / f.w;
  if (abs(u) >= 1.0) return vec2(-1.0, 0.0);
  bool left = u < f.skew;
  float span = left ? 1.0 + f.skew : 1.0 - f.skew;
  float t = (u - f.skew) / span;
  float a = left ? f.a.x : f.a.y;
  float q = max(1.0 - t * t, 0.0);
  float s = pow(q, a);
  float ds = -2.0 * a * t * s / max(q, 0.02) / (span * f.w);
  if (f.shoulder > 0.0) {
    float side = f.a.y > f.a.x ? 1.0 : -1.0;
    float v = (u - f.skew - side * 0.55 * (1.0 - side * f.skew)) / 0.3;
    float qs = 1.0 - v * v;
    if (qs > 0.0) {
      float ss = f.shoulder * pow(qs, 0.6);
      if (ss > s) {
        s = ss;
        ds = -1.2 * f.shoulder * v * pow(max(qs, 0.02), -0.4) / (0.3 * f.w);
      }
    }
  }
  if (f.steps > 0.0) {
    // Ledges: the lower half of each step is a near-level shelf, the upper half a short cliff.
    float y = s * f.steps;
    float k = floor(y);
    float r = clamp((y - k - 0.5) * 2.0, 0.0, 1.0);
    float terrace = (k + r * r * (3.0 - 2.0 * r)) / f.steps;
    s = mix(s, terrace, 0.6);
    ds *= mix(1.0, 12.0 * r * (1.0 - r), 0.6);
  }
  vec2 h = f.H * vec2(s, ds);
  if (f.fall > -2.0) {
    float d = (X - f.c - f.fall * f.w) / 0.022;
    float g = exp(-d * d);
    h -= 0.05 * f.H * vec2(g * s, g * ds - 2.0 * d * g * s / 0.022);
  }
  return h;
}

// The frontmost form of a layer covering P (and its crest height and slope at P.x), and the
// layer's skyline there (height, slope). Forms reach at most one lattice cell either side of their
// own.
bool shanLayerHit(int layer, vec2 P, out ShanForm hit, out vec2 top, out vec2 sky) {
  vec4 L = shanLayerShape(layer);
  float n = floor(P.x / L.x);
  // The crest breaks into crags: V-shaped notches between rounded knuckles, and a finer grain of
  // knobs where moss dots and little pines sit.
  float row = float(layer) * 17.0 + 5.0;
  vec2 g0 = shanNoise(P.x * 13.0, row + 2.0);
  float crag = abs(2.0 * g0.x - 1.0) - 0.5;
  float dcrag = sign(2.0 * g0.x - 1.0) * 26.0 * g0.y;
  vec2 g1 = shanNoise(P.x * 31.0, row);
  vec2 g2 = shanNoise(P.x * 83.0, row + 1.0);
  float grain = (g1.x - 0.5) * 0.7 + (g2.x - 0.5) * 0.3;
  float dgrain = g1.y * 31.0 * 0.7 + g2.y * 83.0 * 0.3;
  float cragged = layer >= 3 ? 0.03 : 0.07;
  hit = shanFormAt(layer, n);
  top = vec2(-1.0, 0.0);
  sky = vec2(-1.0, 0.0);
  float best = 2.0;
  for (int k = -1; k <= 1; k++) {
    ShanForm f = shanFormAt(layer, n + float(k));
    vec2 h = shanProfile(f, P.x);
    if (h.x < 0.0) continue;
    float fade = min(1.0, h.x / (0.3 * f.H));
    float amp = (0.004 + 0.025 * f.H) * fade;
    float ampC = cragged * f.H * fade;
    float y = L.y + h.x + amp * grain + ampC * crag;
    float slope = h.y + amp * dgrain + ampC * dcrag;
    if (y > sky.x) sky = vec2(y, slope);
    if (P.y < y && f.z < best) {
      best = f.z;
      hit = f;
      top = vec2(y, slope);
    }
  }
  return best < 1.5;
}

// Texture strokes hung beneath one fold of the rock (band m, fb from the fold down to the next),
// in clusters. side: which flank, -1 left of the summit. x: the stroke's coverage, y: its tone.
vec2 shanCun(vec2 P, ShanForm f, float dz, float m, float fb, float side, float px) {
  if (f.kind < 0.5) {
    // Hemp-fibre: long wavering parallel strokes running down and out across the slope.
    float lines = mix(34.0, 66.0, K_detail);  // strokes per screen height
    float xi = (P.x - f.c - side * 0.35 * dz) * lines + 0.25 * sin(dz * 70.0 + f.seed * 20.0 + m);
    float k = floor(xi);
    float r = shanHash(k + m * 131.0, 300.0 + f.seed * 97.0);
    float cluster = smoothstep(0.35, 0.65, shanNoise(k * 0.21 + m * 3.7, 301.0 + f.seed * 97.0).x);
    if (r > cluster * (0.45 + 0.5 * K_detail)) return vec2(0.0);
    float along = fb / (0.4 + 0.55 * fract(r * 37.1));
    float cell = px * lines;  // one cell in xi units
    float line = 1.0 - smoothstep(0.95 * cell, 1.9 * cell, abs(fract(xi) - 0.5));
    return vec2(line * smoothstep(0.0, 0.08, along) * (1.0 - smoothstep(0.6, 1.0, along)), 1.0);
  }
  // Axe-cut: short angular side-brush wedges slanting down and out, dark along the edge the brush
  // tip cut, with dry gaps running down the belly.
  float S = mix(0.03, 0.018, K_detail);
  float xs = (P.x - f.c - side * 0.6 * dz) / S * side;
  float k = floor(xs);
  float b = fract(xs);
  float r = shanHash(k + m * 131.0, 320.0 + f.seed * 97.0);
  float cluster = smoothstep(0.3, 0.6, shanNoise(k * 0.37 + m * 2.9, 321.0 + f.seed * 97.0).x);
  if (r > cluster * (0.5 + 0.45 * K_detail)) return vec2(0.0);
  float t = fb / (0.4 + 0.55 * fract(r * 13.7));
  if (t > 1.0) return vec2(0.0);
  float width = 0.9 * (1.0 - t * t);
  float body = 1.0 - smoothstep(width - 1.2 * px / S, width, b);
  float rim = 1.0 - smoothstep(0.0, 2.5 * px / S, b);
  float gaps = smoothstep(0.2, 0.4, vnoise(vec2(b * 2.5 + k * 3.0, t * 1.5)));
  return vec2(body * gaps, 0.45 + 0.55 * hardEdge(rim));
}

// Moss dots: flattened blots hung along the crest in clusters, thickest on gentle tops.
float shanDots(vec2 P, float d, float slope, float px, float scale) {
  if (d > 8.0 * px * scale) return 0.0;
  float gentle = 1.0 - smoothstep(0.8, 1.8, abs(slope));
  float cluster = smoothstep(0.25, 0.65, shanNoise(P.x * 9.0, 40.0).x) * gentle * (0.3 + 0.7 * K_detail);
  if (cluster <= 0.0) return 0.0;
  float sp = 0.015 * scale;
  float j = floor(P.x / sp);
  float dots = 0.0;
  for (int k = -1; k <= 1; k++) {
    float jj = j + float(k);
    float h = shanHash(jj, 41.0 + scale * 3.0);
    if (h > cluster) continue;
    float x = (jj + 0.5 + 0.6 * (fract(h * 17.3) - 0.5)) * sp;
    float r = (1.4 + 1.4 * fract(h * 31.7)) * px * scale;
    float dd = length(vec2((P.x - x) * 0.72, d - r * 1.05));
    dots = max(dots, 1.0 - smoothstep(r - 0.6 * px, r + 0.6 * px, dd));
  }
  return dots;
}

// The season's light colour wash on a form (K_season 1 spring .. 4 winter), as Guo Xi saw them:
// spring hills pale as if smiling, blossom pink at the foot and young green up the slopes;
// summer's deep green as if dripping; autumn clear and bright as if made up, ochre at the foot
// turning russet toward the crest; winter asleep under snow, with no colour at all. crestward: 0
// at the foot .. 1 at the crest. rgb colour, a cover.
vec4 shanSeasonTint(int layer, float crestward, float fall, float seed) {
  bool far = layer >= 3;
  if (K_season < 1.5) return far ? vec4(0.66, 0.76, 0.64, 0.2) : vec4(mix(vec3(0.92, 0.7, 0.7), vec3(0.54, 0.74, 0.42), smoothstep(0.15, 0.6, crestward)), 0.32 + 0.18 * fall);
  if (K_season < 2.5) return far ? vec4(0.44, 0.58, 0.6, 0.28) : vec4(mix(vec3(0.44, 0.58, 0.38), vec3(0.26, 0.46, 0.36), crestward), 0.42 + 0.2 * fall);
  if (K_season < 3.5) return far ? vec4(0.78, 0.66, 0.54, 0.2) : vec4(mix(vec3(0.82, 0.62, 0.36), vec3(0.76, 0.36, 0.18), smoothstep(0.3, 0.9, crestward) * (0.6 + 0.4 * seed)), 0.4 + 0.2 * fall);
  return vec4(0.0);
}

// Ink of one form at P: sumi density (x) and mineral colour cover (y; its colour in 'mineral').
vec2 shanFormInk(int layer, ShanForm f, vec2 top, vec2 P, out vec3 mineral) {
  float px = shanPx;
  vec4 style = shanLayerStyle(layer);
  float wet = K_wetness;
  float H = max(f.H, 0.04);
  float dz = top.x - P.y;
  float slopeN = inversesqrt(1.0 + top.y * top.y);
  // Distance in from the contour, its edge feathered into the paper's fibres when the ink is wet.
  float d = dz * slopeN + wet * 2.5 * px * (vnoise(P * 140.0 + f.seed * 50.0) - 0.5);
  float a = (P.x + top.y * P.y) * slopeN;  // distance along the contour
  float u = (P.x - f.c) / f.w;
  float side = u < f.skew ? -1.0 : 1.0;
  float depth = clamp(dz / H, 0.0, 1.5);
  // The light comes from the right: the left flank of each form is in shade.
  float shade = 0.15 + 0.85 * smoothfall(0.35, -0.45, u - f.skew);
  float blue = step(0.5, K_palette);
  mineral = vec3(0.0);

  // The contour: one stroke pressed hard where it turns over a crest or into a notch, thinning
  // down the long slopes, breaking into flying white where the brush runs dry, and lost in mist.
  float line = 0.0;
  float bleed = 0.0;
  if (style.x > 0.0) {
    float pressure = shanNoise(a * 8.0, 60.0 + f.seed * 100.0).x;
    float crest = exp(-1.5 * top.y * top.y);
    float lw = style.x * px * (0.55 + 0.8 * pressure * pressure + 0.7 * crest);
    float mist = 1.0 - smoothstep(0.35, 0.9, depth);
    float dry = (1.0 - wet) * smoothstep(0.4, 0.8, shanNoise(a * 5.0, 61.0 + f.seed * 100.0).x) * (0.5 + 0.5 * smoothstep(0.4, 1.6, abs(top.y)));
    float streak = vnoise(vec2(a * 70.0, d / px * 0.2 + f.seed * 9.0));
    line = hardEdge((1.0 - smoothstep(lw - 0.6 * px, lw + 0.6 * px, d)) * (1.0 - dry * smoothfall(0.55, 0.35, streak))) * mist;
    // Wet ink bleeds in from the stroke and dries with a pale tide line at its edge.
    float past = max(d - lw, 0.0) / px;
    float tide = hardEdge(exp(-(past - 8.0) * (past - 8.0) / 3.2));
    bleed = wet * (0.3 * exp(-past / 5.0) + 0.2 * tide) * mist;
  }

  // Folds: the rock is built of stacked planes. Their edges run below the crest, never quite
  // parallel to it; each plane is darkest just under its upper edge, and the texture strokes hang
  // from it in clusters, thickest in shade, thinning down into the mist.
  float band = (0.03 + 0.025 * fract(f.seed * 5.3)) * (0.7 + 0.6 * H) * (0.75 + 0.5 * shanNoise(a * 7.0, 63.0 + f.seed * 100.0).x);
  float beta = d / band;
  float m = floor(beta);
  float fb = beta - m;
  float planes = min(5.0, 2.0 + floor(H * 6.0));
  float fold = 0.0;
  float tex = 0.0;
  if (style.z > 0.0 && m <= planes) {
    float kf = floor(beta + 0.5);
    if (kf >= 1.0 && kf <= planes) {
      float on = smoothstep(0.42, 0.62, shanNoise(a * 11.0 + kf * 5.0, 62.0 + f.seed * 100.0).x);
      fold = hardEdge((1.0 - smoothstep(1.0 * px, 1.9 * px, abs(beta - kf) * band)) * on) * (1.3 - 0.18 * kf) * (0.35 + 0.65 * shade) * (0.4 + 0.6 * K_detail);
    }
    float amount = style.z * shade * (1.0 - 0.15 * m) * (1.0 - smoothstep(0.45, 1.0, depth));
    if (amount > 0.01) {
      vec2 cun = shanCun(P, f, dz, m, fb, side, px);
      tex = amount * cun.y * hardEdge(cun.x);
    }
  }
  float dots = layer < 3 ? hardEdge(shanDots(P, d, top.y, px, layer == 2 ? 0.75 : 1.0)) : 0.0;

  // The wash: darkest under the crest and under each fold, dissolving downward, deeper in shade,
  // unevenly taken up by the paper.
  float mottle = 0.7 + 0.6 * vnoise(P * vec2(9.0, 14.0) + f.seed * 20.0);
  float fall = exp(-dz / (0.18 * H + 0.015));
  float plane = style.z > 0.0 && m >= 1.0 ? 0.8 + 0.4 * exp(-3.0 * fb) : 1.0;
  float wash = style.y * (0.3 + 0.7 * fall) * (0.55 + 0.65 * shade) * plane * mottle * mix(0.9, 1.2, wet);

  // A waterfall: a thread of bare paper falling from the notch, between dark lips of rock.
  float water = 0.0;
  float lips = 0.0;
  if (f.fall > -2.0) {
    float xw = f.c + f.fall * f.w + 0.005 * sin(P.y * 23.0 + f.seed * 40.0);
    float hw = (0.0045 + 0.004 * fract(f.seed * 9.1)) * (1.0 + 1.6 * clamp(depth, 0.0, 1.0));
    float s = abs(P.x - xw);
    float from = smoothstep(0.012, 0.03, dz);
    water = (1.0 - smoothstep(hw - px, hw, s)) * from;
    lips = hardEdge((1.0 - smoothstep(hw + 0.5 * px, hw + 2.6 * px, s)) * (1.0 - water) * from) * (1.0 - smoothstep(0.6, 1.0, depth));
    // the water's faint falling grain, painted, still
    water = hardEdge(water * (1.0 - 0.3 * smoothstep(0.62, 0.8, vnoise(vec2((P.x - xw) / hw * 1.6, P.y * 9.0)))));
  }

  // Winter: snow settles as on any surface, by the slope of the crest above (the weather library's
  // snowCover), but the painter keeps it to the upper faces and each ledge of stacked rock: below,
  // the rock stays dark and its wash deepens to set the snow off.
  float snow = 0.0;
  if (K_season > 3.5) {
    float tops = 1.0 - smoothstep(0.18, 0.42, depth + 0.25 * (vnoise(P * vec2(14.0, 34.0) + f.seed * 9.0) - 0.5));
    float ledge = m >= 1.0 ? 0.85 * (1.0 - smoothstep(0.08, 0.4, fb)) : 0.0;
    snow = hardEdge(max(tops, ledge) * snowCover(vec3(-top.y, 1.0, 0.0) * slopeN, P * 24.0 + f.seed * 7.0, 0.6));
    wash *= mix(1.5, 0.0, snow);
    tex *= 1.0 - snow;
    dots *= 1.0 - snow;
  } else if (K_season > 1.5 && K_season < 2.5) {
    wash *= 1.15;
  }
  // Spring blossom and autumn leaves: some clusters of the dots open in colour.
  float flower = 0.0;
  if (abs(K_season - 1.0) < 0.5 || abs(K_season - 3.0) < 0.5) {
    flower = dots * hardEdge(smoothstep(0.36, 0.5, vnoise(P * 26.0 + f.seed * 31.0)));
    dots -= flower;
  }

  float ink = style.w * (2.4 * line + bleed + wash * (1.0 - 0.45 * blue) + 1.2 * tex + 1.1 * fold + 2.4 * dots);
  ink = ink * (1.0 - water) + 1.6 * lips;

  // Blue-green: ochre at the foot, malachite up the slopes, azurite capping the peaks.
  float cover = 0.0;
  float crestward = clamp(1.0 - dz / (H * 0.9), 0.0, 1.0);
  if (blue > 0.5) {
    mineral = mix(SHAN_OCHRE, SHAN_MALACHITE, smoothstep(0.1, 0.45, crestward));
    mineral = mix(mineral, SHAN_AZURITE, smoothstep(0.55, 0.9, crestward) * (0.5 + 0.5 * f.seed));
    if (layer >= 3) mineral = mix(SHAN_AZURITE, vec3(0.6, 0.7, 0.78), layer == 4 ? 0.55 : 0.35);
    cover = (layer >= 3 ? 0.4 : 0.55 + 0.3 * fall) * clamp(mottle, 0.0, 1.0) * (1.0 - water);
  }
  // The season's wash: the only colour over the ink, a glaze over the minerals; none on snow.
  if (K_season > 0.5) {
    vec4 tint = shanSeasonTint(layer, crestward, fall, f.seed);
    tint.a *= clamp(mottle, 0.0, 1.0) * (1.0 - water);
    if (tint.a > 0.0) mineral = cover > 0.0 ? mix(mineral, tint.rgb, 0.5) : tint.rgb;
    cover = max(cover, tint.a) * (1.0 - snow);
    if (flower > 0.0) {
      mineral = K_season < 1.5 ? SHAN_BLOSSOM : SHAN_MAPLE;
      cover = 0.95;
    }
  }
  return vec2(ink, cover);
}

// Small pines on a layer's skyline, drawn the way distant pines are: a crooked stem and three or
// four flat tiers of dark needles, fringed at the edges. They gather in groves on the crests and
// cling to the edges of cliffs, leaning out over the drop. Coverage 0..1.
float shanRidgePines(int layer, vec2 P, float sky) {
  float hMax = layer == 1 ? 0.07 : 0.036;
  if (sky < 0.0 || P.y < sky - 0.015 || P.y > sky + hMax) return 0.0;
  float sp = layer == 1 ? 0.036 : 0.03;
  float j = floor(P.x / sp);
  float pine = 0.0;
  for (int k = -1; k <= 1; k++) {
    float jj = j + float(k);
    float h = shanHash(jj, 90.0 + float(layer));
    if (h > 0.6) continue;
    float x = (jj + 0.5 + 0.5 * (fract(h * 13.7) - 0.5)) * sp;
    ShanForm f;
    vec2 top;
    vec2 base;
    shanLayerHit(layer, vec2(x, -10.0), f, top, base);
    if (base.x < shanLayerShape(layer).y + 0.04) continue;
    bool cliff = abs(base.y) > 1.3;
    float grove = smoothstep(0.35, 0.75, shanNoise(jj * sp * 4.0, 92.0 + float(layer)).x);
    if (h > grove * (0.15 + 0.7 * K_detail) && !(cliff && h < 0.15 + 0.3 * K_detail)) continue;
    float hp = hMax * (0.55 + 0.45 * fract(h * 31.3));
    vec2 q = (P - vec2(x, base.x - 0.006)) / hp;
    if (abs(q.x) > 0.75 || q.y < -0.05 || q.y > 1.05) continue;
    float lean = cliff ? -clamp(base.y * 0.3, -0.75, 0.75) : (fract(h * 7.9) - 0.5) * 0.5;
    float cell = shanPx / hp;
    vec2 crown = vec2(lean * 0.6, 0.85 - 0.25 * abs(lean));
    float stem = segmentDistance(q, vec2(0.0), crown) - max(0.035, 0.8 * cell);
    float tiers = 1.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float y = 0.3 + 0.2 * fi;
      vec2 r = (q - vec2(crown.x * y / 0.85 + 0.06 * sin(fi * 2.3 + h * 9.0), y * crown.y / 0.85)) / vec2(0.34 - 0.065 * fi, 0.075);
      r.y = r.y < 0.0 ? r.y * 2.2 : r.y;  // flat underneath, domed above
      float fringe = 0.22 * (vnoise(q * vec2(5.0, 3.0) + fi * 5.0 + h * 40.0) - 0.5);
      tiers = min(tiers, (length(r) - 1.0 - fringe) * 0.075);
    }
    pine = max(pine, hardFill(min(stem, tiers), 0.6 * cell));
  }
  return pine;
}

// A layer's form (or a pine on its skyline) at P composited behind what is already there: vis is
// how much of the picture behind still shows; ink and mineral (premultiplied) gather what it adds.
void shanPaintLayer(int layer, vec2 P, inout float vis, inout float ink, inout vec4 mineral) {
  if (vis < 0.004) return;
  ShanForm f;
  vec2 top;
  vec2 sky;
  bool hit = shanLayerHit(layer, P, f, top, sky);
  float pine = layer == 1 || layer == 2 ? shanRidgePines(layer, P, sky.x) : 0.0;
  if (!hit && pine <= 0.0) return;
  vec4 L = shanLayerShape(layer);
  vec4 style = shanLayerStyle(layer);
  // Each layer's foot dissolves into the bare paper below it.
  float foot = smoothstep(L.y - 0.03, L.y + 0.07, P.y + 0.03 * (vnoise(vec2(P.x * 6.0, float(layer))) - 0.5));
  vec3 colour = vec3(0.0);
  vec2 paint = vec2(0.0);
  if (hit) paint = shanFormInk(layer, f, top, P, colour);
  paint = mix(paint, vec2(2.3 * style.w, 0.0), pine);
  float alpha = foot * max(hit ? 1.0 : 0.0, pine);
  ink += vis * alpha * paint.x;
  mineral += vis * alpha * paint.y * vec4(colour, 1.0);
  vis *= 1.0 - alpha;
}

// One needle cluster of a big pine, a fan of strokes radiating from a point under its middle.
// q in pine units from the cluster's centre, r its radius, cell one dither cell in pine units.
float shanNeedles(vec2 q, float r, float id, float cell) {
  vec2 e = q / vec2(r, 0.5 * r);
  if (dot(e, e) > 1.3) return 0.0;
  vec2 v = q + vec2(0.0, 0.35 * r);
  float angle = atan(v.y, v.x);
  float spokes = 15.0;
  float s = angle / TAU * spokes + id * 3.7;
  float spoke = floor(s);
  float tip = r * (0.78 + 0.3 * hash12(vec2(spoke, id * 13.0)));
  float across = abs(fract(s) - 0.5) * TAU / spokes * length(v);
  float needle = 1.0 - smoothstep(0.7 * cell, 1.5 * cell, across - 0.006);
  float within = 1.0 - smoothstep(tip - cell, tip + cell, length(v / vec2(1.0, 0.62)));
  // The heart of the cluster is a dark wash where the needles crowd.
  float heart = 1.0 - smoothstep(0.25, 0.7, length(e));
  return max(hardEdge(needle * within * step(-0.1 * r, v.y)), 0.8 * heart);
}

// A big pine on a river bank, rooted at its foot, height hp: a leaning, twisting trunk with bark
// scales and branches ending in needle clusters. x: coverage, y: ink.
vec2 shanBigPine(vec2 P, vec2 foot, float hp, float id) {
  vec2 q = (P - foot) / hp;
  if (q.x < -0.75 || q.x > 0.75 || q.y < -0.04 || q.y > 1.12) return vec2(0.0);
  float cell = shanPx / hp;
  float lean = (fract(id * 7.3) - 0.5) * 0.7;
  vec2 a = vec2(0.0);
  vec2 b = vec2(lean * 0.12 + 0.04, 0.36);
  vec2 c = vec2(lean * 0.3 - 0.03, 0.7);
  vec2 d = vec2(lean * 0.42, 0.98);
  float trunk = min(segmentDistance(q, a, b), min(segmentDistance(q, b, c), segmentDistance(q, c, d)));
  float girth = mix(0.03, 0.012, clamp(q.y, 0.0, 1.0)) + 0.6 * cell;
  float body = hardEdge(1.0 - smoothstep(girth - cell, girth + cell, trunk));
  float bark = hardEdge(1.0 - smoothstep(girth - 2.2 * cell, girth - 1.0 * cell, trunk));
  float scales = hardEdge(smoothstep(0.55, 0.75, vnoise(q * vec2(36.0, 20.0) + id * 11.0)));
  float cover = body;
  float ink = body * (0.35 + 1.8 * (1.0 - bark) + 0.9 * scales * bark);
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    float y = 0.44 + 0.13 * fk;
    float side = (mod(fk + floor(id * 4.0), 2.0) < 0.5 ? -1.0 : 1.0) * (k == 4 ? 0.2 : 1.0);
    vec2 from = vec2(lean * 0.42 * y + 0.02 * sin(y * 9.0), y * 0.98);
    vec2 at = from + vec2(side * (0.18 - 0.025 * fk) * (0.75 + 0.5 * fract(id * 17.0 + fk * 0.37)), 0.05 + 0.02 * fk);
    float branch = segmentDistance(q, from, at) - max(0.008, 0.7 * cell);
    float limb = hardFill(branch, cell);
    float r = 0.15 - 0.016 * fk;
    float needles = shanNeedles(q - at, r, id * 5.0 + fk, cell);
    float c2 = max(limb, needles);
    cover = max(cover, c2);
    ink = max(ink, 2.2 * limb + 2.0 * needles);
  }
  return vec2(cover, ink);
}

// A pavilion on the bank, an open roof on four posts over a stone platform; now and then a scholar
// sits in it looking out over the water. q in pavilion units (its width ~1.6, foot at 0).
vec2 shanPavilion(vec2 q, float scholar, float cell) {
  if (abs(q.x) > 0.9 || q.y < -0.25 || q.y > 1.08) return vec2(0.0);
  float ax = abs(q.x);
  // the hipped roof, sweeping up at the eaves
  float t = ax / 0.8;
  float roof = step(ax, 0.8) * step(0.62 + 0.12 * pow(t, 5.0), q.y) * step(q.y, 0.98 - 0.36 * pow(t, 1.4));
  float finial = hardEdge(1.0 - smoothstep(0.04 - cell, 0.04 + cell, length(q - vec2(0.0, 1.01))));
  float posts = hardEdge(1.0 - smoothstep(0.035, 0.035 + cell, abs(ax - 0.44))) * step(0.08, q.y) * step(q.y, 0.64);
  float rail = hardEdge(1.0 - smoothstep(0.022, 0.022 + cell, abs(q.y - 0.27))) * step(ax, 0.44);
  float deck = step(ax, 0.6) * step(0.0, q.y) * step(q.y, 0.09);
  float stones = step(ax, 0.52 - 0.15 * (-q.y)) * step(-0.22, q.y) * step(q.y, 0.0);
  float stoneEdge = stones * hardEdge(1.0 - smoothstep(cell, 2.5 * cell, min(0.52 + 0.15 * q.y - ax, q.y + 0.22)));
  float head = hardEdge(1.0 - smoothstep(0.06 - cell, 0.06 + cell, length(q - vec2(0.12, 0.42)))) * scholar;
  float robe = hardEdge(1.0 - smoothstep(0.12 - cell, 0.12 + cell, length((q - vec2(0.1, 0.2)) / vec2(1.0, 1.2)))) * scholar * step(0.09, q.y);
  float cover = max(max(roof, finial), max(max(posts, rail), max(deck, max(stones, max(head, robe)))));
  float ink = max(max(2.4 * roof, 2.4 * finial), max(2.0 * max(posts, deck), max(1.4 * rail, max(0.25 * stones + 1.6 * stoneEdge, max(2.2 * head, 0.55 * robe)))));
  return vec2(cover, ink);
}

// What stands on the river banks: pines, and pavilions under them. x: coverage, y: ink.
// Nested loops (3 banks x 3 pines x 5 branches) look costly, but each bank and each pine leaves at
// a bounding-box test first: away from the pines nothing inner runs (the common path is the three
// bank lookups), and within a grove a pixel usually meets one bank's three pines, 15 branches.
vec2 shanBankLife(vec2 P) {
  float cellW = shanLayerShape(0).x;
  float n = floor(P.x / cellW);
  vec2 life = vec2(0.0);
  for (int k = -1; k <= 1; k++) {
    ShanForm f = shanFormAt(0, n + float(k));
    if (f.H <= 0.0) continue;
    if (P.y > -0.05 + f.H + 0.62 || abs(P.x - f.c) > f.w + 0.3) continue;
    float pines = 1.0 + step(0.45, f.seed) + step(0.8 - 0.3 * K_detail, fract(f.seed * 5.1));
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      if (fi >= pines) break;
      float x = f.c + f.w * (-0.5 + 0.22 * fi + 0.08 * sin(f.seed * 40.0 + fi * 3.0));
      float base = shanLayerShape(0).y + shanProfile(f, x).x - 0.012;
      float hp = (0.3 + 0.22 * fract(f.seed * 9.7 + fi * 0.31)) * (1.0 - 0.25 * fi);
      vec2 tree = shanBigPine(P, vec2(x, base), hp, fract(f.seed * 3.3 + fi * 0.27));
      life = vec2(max(life.x, tree.x), max(life.y, tree.y));
    }
    if (K_dwellings > 0.5 && fract(f.seed * 2.9) < 0.6) {
      float x = f.c + f.w * 0.32;
      float base = shanLayerShape(0).y + shanProfile(f, x).x - 0.004;
      float size = 0.04;
      vec2 hall = shanPavilion((P - vec2(x, base)) / size, step(0.4, fract(f.seed * 6.1)), shanPx / size);
      life = vec2(max(life.x, hall.x), max(life.y, hall.y));
    }
  }
  return life;
}

// Open water: a fisherman poling a small boat with a mat awning, drifting slowly between the
// banks, and a few level ripple strokes. x: coverage, y: ink. 'swing' is the sim's slow clock.
vec2 shanWater(vec2 P, float swing, float t) {
  if (P.y > 0.2) return vec2(0.0);
  float cellW = shanLayerShape(0).x;
  float n = floor(P.x / cellW);
  vec2 water = vec2(0.0);
  // Ripples: short level strokes, painted, still, thinning toward the far shore.
  float row = floor(P.y / 0.016);
  float ry = (row + 0.5) * 0.016;
  float rx = P.x / 0.05 + shanHash(row, 95.0) * 7.0;
  float rh = shanHash(floor(rx), 96.0 + row);
  float dash = step(rh, 0.22) * (1.0 - smoothstep(0.75 * shanPx, 1.5 * shanPx, abs(P.y - ry)));
  dash = hardEdge(dash * smoothstep(0.0, 0.2, fract(rx)) * (1.0 - smoothstep(0.5 + 0.4 * fract(rh * 9.0), 1.0, fract(rx))));
  water.y = 0.45 * dash * (1.0 - smoothstep(0.06, 0.14, P.y));
  if (K_boats < 0.5) return water;
  for (int k = -1; k <= 1; k++) {
    float i = n + float(k);
    ShanForm bank = shanFormAt(0, i);
    if (bank.H > 0.0 || bank.seed > 0.75) continue;
    float x = (i + 0.5) * cellW + 0.24 * cellW * sin(swing * 0.0245 * 2.0 + bank.seed * TAU);
    float y = 0.075 + 0.05 * fract(bank.seed * 7.1) + 0.0018 * sin(t * 0.8 + bank.seed * 20.0);
    float size = 0.042;
    vec2 q = (P - vec2(x, y)) / size;
    if (abs(q.x) > 1.1 || q.y < -0.3 || q.y > 0.95) continue;
    float cell = shanPx / size;
    // The hull: a slim crescent, bow to the left, both ends turned up.
    float hull = step(abs(q.x), 0.62) * step(-0.07 + 0.14 * q.x * q.x, q.y) * step(q.y, 0.05 + 0.3 * q.x * q.x);
    // The mat awning amidships.
    float awning = hardEdge(1.0 - smoothstep(1.0 - 2.0 * cell, 1.0, length((q - vec2(0.12, 0.05)) / vec2(0.22, 0.2)))) * step(0.05, q.y);
    // The boatman at the stern under a broad hat, leaning on his pole, which he plants and lifts.
    float stroke = sin(t * 0.35 + bank.seed * 9.0);
    vec2 hand = vec2(0.36, 0.5);
    float body = segmentDistance(q, vec2(0.42, 0.06), vec2(0.4 - 0.03 * stroke, 0.44)) - 0.045;
    float hat = max(abs(q.x - 0.4 + 0.03 * stroke) - 0.13 * (1.0 - (q.y - 0.47) / 0.1), abs(q.y - 0.52) - 0.05);
    float pole = segmentDistance(q, hand + vec2(0.1, 0.25), vec2(0.62 + 0.22 * stroke, -0.32)) - max(0.012, 0.7 * cell);
    float man = hardFill(min(min(body, hat), pole), cell);
    float wake = (1.0 - smoothstep(0.02, 0.02 + cell, abs(q.y + 0.13))) * step(0.5, q.x) * step(q.x, 1.0);
    wake = hardEdge(max(wake, (1.0 - smoothstep(0.02, 0.02 + cell, abs(q.y + 0.21))) * step(0.66, q.x) * step(q.x, 1.08)));
    float cover = max(max(hull, man), awning);
    water = vec2(max(water.x, cover), max(water.y, max(max(2.3 * hull, 2.2 * man), max(1.1 * awning, 0.5 * wake))));
  }
  return water;
}

// A skein of wild geese, each a small beating 'v', in a loose line or a chevron. g: leader (x, y)
// on screen, skein number. Ink coverage.
float shanGeese(vec2 S, vec3 g, float t) {
  if (g.z < 0.5 || S.y < g.y - 0.15 || S.y > g.y + 0.15) return 0.0;
  float count = 5.0 + mod(g.z, 4.0);
  bool chevron = fract(g.z * 0.618) > 0.5;
  float size = 0.0095;
  float cell = shanPx / size;
  float w = max(0.11, 0.85 * cell);
  float geese = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float rank = chevron ? ceil(fi * 0.5) : fi;
    float side = chevron && mod(fi, 2.0) > 0.5 ? -1.0 : 1.0;
    vec2 off = chevron ? vec2(rank * 0.05, side * rank * 0.021) : vec2(fi * 0.046, -fi * 0.013);
    off += vec2(0.006 * sin(t * 0.21 + fi * 2.1), 0.004 * sin(t * 0.33 + fi * 1.3));
    vec2 q = (S - g.xy - off) / size;
    if (dot(q, q) > 2.5) continue;
    float flap = sin(t * 2.4 + fi * 1.7);
    vec2 joint = vec2(0.42, 0.18 + 0.2 * flap);
    vec2 tip = vec2(0.95, 0.15 + 0.55 * flap);
    vec2 m = vec2(abs(q.x), q.y);
    float wing = min(segmentDistance(m, vec2(0.0), joint), segmentDistance(m, joint, tip)) - w;
    float body = length((q - vec2(-0.1, -0.02)) / vec2(1.6, 1.0)) - 1.5 * w;
    geese = max(geese, hardFill(min(wing, body), 0.5 * cell));
  }
  return geese;
}

// The mist field along the scroll: billows drifting their own way and slowly reshaping. ~0.2..0.8.
// 'morph' wraps at 256, so it only drives whole cycles of its sines.
float shanMistField(vec2 P, float drift, float morph) {
  vec2 q = vec2((P.x - drift) * 1.7, P.y * 5.5);
  q.x += 0.35 * sin(P.y * 7.0 + morph * 0.0491) + 0.25 * sin(q.x * 0.6 - morph * 0.0736);
  q.y += 0.3 * sin(q.x * 0.8 + morph * 0.0982);
  return fbm(q);
}

// How much of everything behind a band of mist centred at y0 (half height sig) it hides.
float shanMistBand(float y, float field, float y0, float sig, float breath) {
  float band = exp(-(y - y0) * (y - y0) / (sig * sig));
  float m = smoothstep(0.3, 0.8, band * (0.35 + 0.95 * K_mist) + (field - 0.5) * 1.1);
  return m * min(1.0, 2.5 * K_mist) * (1.0 - 0.85 * breath);
}

// Paper fibres in cell space, so they never crawl as the scroll moves: streaks of stretched value
// noise in three directions, two lighter than the sheet and one darker. Roughly -1..2.
float shanFibre(vec2 cell) {
  vec2 q = cell / 2.5;
  float f = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 r = rotate(q, fk * 2.09 + 0.6) * vec2(0.07, 0.8) + vec2(fk * 23.7, fk * 5.3);
    float streak = smoothstep(0.8, 0.94, vnoise(r));
    f += k == 1 ? -0.8 * streak : streak;
  }
  return f;
}

// The seal's impression in seal units (a square of side 1 centred on 0): cinnabar where the paste
// took. Intaglio, as a name seal: the M is cut into the stone and prints as bare paper, its strokes
// even and rounded at the turns in the manner of seal script. The stone's edge is a little worn and
// the paste skips in a few specks.
float shanSealInk(vec2 q, float id, float cellUnit) {
  vec2 e = abs(q) - vec2(0.5);
  float edge = max(e.x, e.y) + 0.03 * (vnoise(q * 9.0 + id * 7.0) - 0.5);
  float body = softFill(edge, cellUnit);
  if (body <= 0.0) return 0.0;
  float dm = markDistance(q / 0.68) * 0.68;
  float cut = 1.0 - smoothstep(0.068 - cellUnit, 0.068 + cellUnit, dm);
  float speck = smoothstep(0.74, 0.82, vnoise(q * 6.5 + id * 3.1));
  return body * (1.0 - cut) * (1.0 - 0.9 * speck);
}

// The painter's own seal, cut in relief: the M and a border stand proud on the stone and print in
// cinnabar on the bare paper, the border worn thinner in places and the paste skipping here and
// there. q in seal units (a square of side 1 centred on 0).
float shanSealRelief(vec2 q, float id, float cellUnit) {
  vec2 e = abs(q) - vec2(0.455);
  float frame = abs(max(e.x, e.y)) - 0.045 * (0.8 + 0.4 * vnoise(q * 7.0 + id * 5.0));
  float mark = markDistance(q / 0.58) * 0.58 - 0.06;
  float paste = softFill(min(frame, mark), cellUnit);
  float skip = smoothstep(0.8, 0.86, vnoise(q * 6.0 + id * 3.1));
  return paste * (1.0 - 0.9 * skip);
}

// One character of an inscription, in a square of side 1 centred on 0: three to five brush strokes
// picked from the basic ones (level, upright, falling left, falling right, dot) on a three-by-three
// frame, each pressed at its start and lifted at its end (the right-falling one swells to its
// foot). Not a real script, but it reads as a hand at a glance. Coverage.
float shanGlyph(vec2 q, float id, float cell) {
  float d = 1.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float h = hash12(vec2(id, fi * 7.1 + 3.0));
    if (i >= 3 && fract(h * 29.1) < 0.4) continue;
    float kind = floor(h * 5.0);
    float r0 = -0.3 + 0.3 * floor(fract(h * 13.7) * 3.0);
    float c0 = -0.3 + 0.3 * floor(fract(h * 71.3) * 3.0);
    vec2 a = vec2(c0, r0 + 0.08);
    vec2 b = a + vec2(0.07, -0.08);
    vec2 w = vec2(0.085, 0.06);  // half width at the start and at the end
    if (kind < 1.0) {
      a = vec2(-0.38 + 0.1 * fract(h * 3.3), r0);
      b = vec2(0.38 - 0.1 * fract(h * 5.9), r0 + 0.05);
      w = vec2(0.07, 0.06);
    } else if (kind < 2.0) {
      a = vec2(c0, 0.42);
      b = vec2(c0, -0.42 + 0.35 * fract(h * 5.9));
      w = vec2(0.08, 0.06);
    } else if (kind < 3.0) {
      a = vec2(c0 + 0.12, 0.3);
      b = vec2(c0 - 0.28, -0.4);
      w = vec2(0.08, 0.05);
    } else if (kind < 4.0) {
      a = vec2(c0 - 0.1, 0.2);
      b = vec2(c0 + 0.3, -0.4);
      w = vec2(0.05, 0.095);
    }
    d = min(d, sdTaperCapsule(q, a, b, w.x, w.y));
  }
  return hardFill(d, cell);
}

// Characters of an inscription are this many screen heights high, set in columns.
const float SHAN_GLYPH = 0.036;

struct ShanInscription {
  float x;          // centre of the poem's column; the name's stands one column to its left
  float top;        // top of the poem's column
  float nameTop;    // top of the name's column, a little lower
  float lines;      // characters in the poem (0: no inscription on this sheet)
  float nameLines;  // characters in the name
};

// Now and then a sheet carries an inscription in its empty sky, as poets and owners wrote on
// scrolls: a column of characters, read top to bottom, and a shorter one to its left with the
// writer's name. Where they stand on sheet j.
ShanInscription shanInscriptionOn(float j) {
  float h = shanHash(j, 86.0);
  ShanInscription s;
  s.x = (j + 0.3 + 0.45 * fract(h * 7.3)) * SHAN_SHEET;
  s.top = 0.93 - 0.03 * fract(h * 3.9);
  s.nameTop = s.top - SHAN_GLYPH * (2.0 + 2.0 * fract(h * 5.1));
  s.lines = h > 0.55 || K_inscription < 0.5 ? 0.0 : 4.0 + floor(4.0 * fract(h * 11.1));
  s.nameLines = 2.0 + floor(2.0 * fract(h * 17.3));
  return s;
}

// The inscription's ink at P. Coverage.
float shanInscription(vec2 P) {
  if (P.y < 0.45) return 0.0;
  float j = floor(P.x / SHAN_SHEET);
  ShanInscription s = shanInscriptionOn(j);
  if (s.lines < 1.0) return 0.0;
  float cs = SHAN_GLYPH;
  float column = floor((s.x - P.x) / (cs * 1.35) + 0.5);  // 0: the poem, 1: the name beside it
  if (column < 0.0 || column > 1.0) return 0.0;
  float count = column < 0.5 ? s.lines : s.nameLines;
  float start = column < 0.5 ? s.top : s.nameTop;
  float k = floor((start - P.y) / (cs * 1.12));
  if (k < 0.0 || k >= count) return 0.0;
  vec2 q = (P - vec2(s.x - column * cs * 1.35, start - (k + 0.5) * cs * 1.12)) / cs;
  if (abs(q.x) > 0.55) return 0.0;
  return shanGlyph(q, j * 31.0 + column * 11.0 + k + shanSeed, shanPx / cs);
}

// How fully a seal of the given size centred at screen x lies inside the frame: 0 while any of it
// would be cut by an edge, rising to 1 once it is well inside.
float shanSealShown(float x, float size, float aspect) {
  float reach = 0.75 * size;
  return smoothstep(0.012, 0.05, min(x - reach, aspect - x - reach));
}

// ---- passage ----
// The scroll is laid open on a mount of pale silk brocade. At the start it is still rolled up near
// the right edge, its free end tied to a wooden roller that lies against the roll. The roller is
// drawn out to the left and the paper pays out from the roll behind it, so the painting slides in
// with the roller at its leading edge, which keeps going until it has left the frame and the
// painting lies as it always does. The roll thins and slips away off the right edge. The exit is
// the same, run back: the roller comes in from the left and the paper winds up onto the roll, which
// ends near the right edge. Everything below is inert (and never evaluated) at rest: passageIn() 1
// and passageOut() 0.
const vec3 SHAN_MOUNT = vec3(0.8, 0.765, 0.69);      // the brocade the scroll lies on: near the paper's value
const vec3 SHAN_WOOD = vec3(0.21, 0.125, 0.08);      // the roller
const float SHAN_ROD = 0.028;                        // the roller's radius, in screen heights
const float SHAN_ROLL = 0.125;                       // the rolled-up scroll's radius at the start
const float SHAN_ROLL_END = 0.022;                   // and when nearly all of it has been paid out
const float SHAN_FRONT_END = -0.32;                  // the roller's x once it has left the frame

struct ShanUnroll {
  float front;  // the roller's x (screen heights)
  float rollX;  // the roll's axis
  float rollR;  // the roll's radius
};

// How far the scroll is open: 0 rolled up, 1 laid out. The pull starts briskly (about four fifths
// of the way out after a third of the entrance), runs past a little and settles back; the winding
// up starts gently and gathers pace until the scroll is shut.
float shanOpen() {
  float v = clamp(passageIn(), 0.0, 1.0) - 1.0;
  float arrive = 1.0 + 1.9 * v * v * v + 0.9 * v * v;
  float x = clamp(passageOut(), 0.0, 1.0);
  return arrive * (1.0 - x * x);
}

ShanUnroll shanUnroll(float aspect) {
  float e = shanOpen();
  float ec = clamp(e, 0.0, 1.0);
  ShanUnroll un;
  un.rollR = sqrt(mix(SHAN_ROLL_END * SHAN_ROLL_END, SHAN_ROLL * SHAN_ROLL, 1.0 - ec));
  un.rollX = aspect - 0.09 + 0.32 * ec;
  un.front = mix(aspect - 0.09 - SHAN_ROLL - SHAN_ROD, SHAN_FRONT_END, e);
  return un;
}

// The brocade, fixed to the dither cells so it never crawls: a basket weave of threads, small
// checks of warp and weft, and over it a lattice of lozenges with a dot at the heart of each.
vec3 shanMount(vec2 cell) {
  vec2 c3 = floor(cell / 3.0);
  float warp = mod(c3.x + c3.y, 2.0);
  vec2 t = mod(cell, 3.0);
  float thread = warp > 0.5 ? t.x : t.y;
  float weave = 0.025 * (warp - 0.5) - 0.03 * step(thread, 0.5);
  vec2 f = abs(fract(cell / 30.0) - 0.5);
  float lozenge = 1.0 - step(1.4 / 30.0, abs(f.x + f.y - 0.25));
  float heart = 1.0 - step(2.0 / 30.0, f.x + f.y);
  float motif = -0.055 * lozenge + 0.04 * heart;
  return SHAN_MOUNT * (1.0 + weave + motif + 0.008 * shanFibre(cell));
}

// The bare mount as the scene's result: what lies beyond the paper, left of the roller.
Shade shanMountShade(vec2 cell) {
  vec3 m = shanMount(cell);
  float ref = dot(mix(SHAN_PAPER_NEW, SHAN_PAPER_OLD, K_age), LUMA);
  return shadeOf(m, clamp((1.0 - dot(m, LUMA) / max(ref, 0.2)) * 1.25, 0.0, 1.0), 0.0);
}

// A roller lit from the upper left, in three bands cut per cell so that it never flickers as it
// moves: u runs -1..1 across it; gloss adds a hard highlight.
vec3 shanCylinder(vec3 base, float u, float gloss) {
  float a = clamp(u, -1.0, 1.0);
  float n = sqrt(max(1.0 - a * a, 0.0));
  float l = 0.5 + 0.5 * dot(vec2(a, n), vec2(-0.5, 0.866));
  float tone = 0.55 + 0.27 * hardEdge(smoothstep(0.22, 0.5, l)) + 0.2 * hardEdge(smoothstep(0.6, 0.88, l));
  return base * tone + gloss * 0.3 * hardEdge(smoothstep(0.93, 0.995, l));
}

// The shade a roller of radius r at c casts on what lies beside it, per cell: long to its right
// (the light is from the upper left), short to its left. 1 where shaded.
float shanRollShadow(float x, float c, float r) {
  float d = abs(x - c) - r;
  if (d <= 0.0) return 0.0;
  float reach = (x > c ? 1.0 : 0.35) * r + 0.012;
  return hardEdge(0.8 * (1.0 - smoothstep(0.0, reach, d)));
}

Shade sceneShanshui(vec2 uv, vec2 cell, float t) {
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  shanPx = px;

  float scroll = uMotionTime * 0.0048;
  float drift = uMotionTime * 0.0021;
  float morph = uMotionTime * 0.45;
  float section = 0.0;
  vec4 geese = vec4(-9.0, 0.0, 0.0, 0.0);
  vec4 stamp = vec4(-9.0, 0.0, 0.0, -1.0);
  float breath = 0.0;
  if (uSimOn.x > 0.5) {
    vec4 s0 = texelFetch(uSim0, ivec2(0, 0), 0);
    scroll = shanUnsplit(s0);
    morph = s0.w;
    vec4 s1 = texelFetch(uSim0, ivec2(1, 0), 0);
    drift = shanUnsplit(s1);
    section = s1.w;
    vec4 g = texelFetch(uSim0, ivec2(2, 0), 0);
    geese = vec4((g.x + g.y) / 64.0, g.z, g.w, 0.0);
    vec4 s = texelFetch(uSim0, ivec2(3, 0), 0);
    stamp = vec4((s.x + s.y) / 64.0, s.z, 0.0, s.w);
  }
  if (uSimOn.y > 0.5) breath = texture(uSim1, uv).r;

  // P: on the painting. The scroll is read right to left, so the painting slides right.
  vec2 S = vec2(uv.x * aspect, uv.y);
  // The passage: while the scroll is being unrolled or wound up the painting rides with its roller.
  bool passing = passageIn() < 1.0 || passageOut() > 0.0;
  ShanUnroll un = ShanUnroll(0.0, 0.0, 0.0);
  float shift = 0.0;
  if (passing) {
    un = shanUnroll(aspect);
    // Beyond the roller there is only the mount.
    if (S.x < un.front - SHAN_ROD - 0.05) return shanMountShade(cell);
    shift = un.front - SHAN_FRONT_END;
  }
  vec2 P = vec2(S.x - scroll - shift, S.y);
  // Right of the join lies the section before, its painting running on from where it was when
  // this one began (so the change of origin moves nothing on screen), on its own row of the seed.
  bool joined = section > SHAN_SECTIONS - 0.5;
  float number = joined ? section - SHAN_SECTIONS : section;
  float join = P.x - SHAN_JOIN_AT;
  if (joined && join > 0.0) {
    P.x -= SHAN_SECTION;
    number = mod(number + SHAN_SECTIONS - 1.0, SHAN_SECTIONS);
  }
  shanSeed = shanSeedOf(number);
  // Toward the join both paintings dissolve into bare paper, as mist.
  float apart = joined ? smoothstep(SHAN_JOIN_SILK, SHAN_JOIN_SILK + SHAN_JOIN_FADE, abs(join)) : 1.0;

  // The paper: its tone and age, a broad mottling, each sheet a shade apart with a faint lap where
  // two are pasted together, and its fibres.
  float age = K_age;
  float sheet = floor(P.x / SHAN_SHEET);
  vec3 paper = mix(SHAN_PAPER_NEW, SHAN_PAPER_OLD, age);
  paper *= 1.0 + (0.012 + 0.02 * age) * (shanHash(sheet, 70.0) - 0.5);
  paper *= 1.0 + (0.02 + 0.05 * age) * (vnoise(P * vec2(3.0, 4.0) + 11.0) - 0.5);
  float lap = abs(P.x - floor(P.x / SHAN_SHEET + 0.5) * SHAN_SHEET);
  paper *= 1.0 - (0.012 + 0.04 * age) * hardEdge(1.0 - smoothstep(1.5 * px, 3.0 * px, lap));
  // Foxing: small brown spots that come with age.
  float fox = smoothstep(0.86, 0.93, vnoise(P * 23.0 + 5.0)) * smoothstep(0.35, 0.9, age);
  paper = mix(paper, paper * vec3(0.86, 0.76, 0.6), fox * 0.6);
  paper += 0.012 * shanFibre(cell);

  // The picture, front to back. Every band of mist lies below 0.8; above, the field is not needed.
  float field = P.y < 0.8 ? shanMistField(P, drift, morph) : 0.5;
  float vis = 1.0;
  float ink = 0.0;
  vec4 mineral = vec4(0.0);
  // The river banks, their pines and pavilions standing in front of them.
  vec2 life = shanBankLife(P);
  ink += life.y;
  mineral += life.x * step(0.5, K_palette) * 0.45 * vec4(SHAN_MALACHITE, 1.0);
  vis *= 1.0 - life.x;
  shanPaintLayer(0, P, vis, ink, mineral);
  // Open water in front of the near peaks' misty feet: ripples, and the boatman.
  vec2 water = shanWater(P, morph, t);
  ink += vis * water.y;
  vis *= 1.0 - water.x;
  vis *= 1.0 - shanMistBand(P.y, field, 0.16, 0.075, breath);
  shanPaintLayer(1, P, vis, ink, mineral);
  // Cloud belts drift across the peaks' middles, and mist lies along the middle range's foot.
  float beltY = (P.y - 0.56) / 0.12;
  float belt = smoothstep(0.58, 0.78, field) * exp(-beltY * beltY) * min(1.0, 2.0 * K_mist) * (1.0 - 0.85 * breath);
  vis *= (1.0 - shanMistBand(P.y, field, 0.31, 0.06, breath)) * (1.0 - belt);
  shanPaintLayer(2, P, vis, ink, mineral);
  // Thinner mist between the distant ranges, so their pale washes stand one behind the other.
  vis *= 1.0 - 0.85 * shanMistBand(P.y, 1.0 - field, 0.43, 0.045, breath);
  shanPaintLayer(3, P, vis, ink, mineral);
  vis *= 1.0 - 0.7 * shanMistBand(P.y, field, 0.52, 0.04, breath);
  shanPaintLayer(4, P, vis, ink, mineral);
  // A winter scroll washes its sky and water grey, so that the snow left as bare paper shines.
  if (K_season > 3.5) ink += 0.32 * vis;

  // An inscription now and then, faint, in the sky of a sheet.
  ink += 0.8 * shanInscription(P);

  // Wild geese high over everything.
  ink += 2.2 * shanGeese(S, geese.xyz, t);
  ink *= apart;
  mineral *= apart;

  // Ink through the paper.
  vec3 base = mineral.a > 0.0 ? mix(paper, mineral.rgb / mineral.a, clamp(mineral.a, 0.0, 1.0)) : paper;
  float k = mix(0.55, 1.6, K_density);
  vec3 col = base * exp(-ink * k * SHAN_ABSORB);

  if (joined && abs(join) < SHAN_JOIN_SILK + 3.0 * px) {
    // The join itself: a strip of the mount's brocade between the two sheets, a fine shadow along
    // each edge where the paper is pasted over it.
    float silk = hardFill(abs(join) - SHAN_JOIN_SILK, 0.75 * px);
    float lip = hardEdge(1.0 - smoothstep(0.5 * px, 2.0 * px, abs(abs(join) - SHAN_JOIN_SILK)));
    col = mix(col, shanMount(cell), silk) * (1.0 - 0.16 * lip);
  }

  // The seals. A collector's rides each join of the sheets near the foot of the scroll, a little
  // askew; the painter's own sits high in the sky of every stretch of the scroll; the last one
  // pressed by hand travels with the scroll from where it was put. The painted ones keep off the
  // silk of a join between sections; one pressed by hand may ride it, as collectors' seals do.
  float seal = 0.0;
  if (K_seal > 0.0) {
    float size = mix(0.04, 0.09, K_seal);
    float j = floor(P.x / SHAN_SHEET + 0.5);
    float h = shanHash(j, 80.0);
    vec2 c = vec2(j * SHAN_SHEET + (h - 0.5) * 0.3 * size, 0.035 + 0.6 * size + 0.02 * fract(h * 13.1));
    vec2 q = rotate(P - c, (fract(h * 7.7) - 0.5) * 0.09) / size;
    bool onSilk = joined && abs(join + c.x - P.x) < SHAN_JOIN_SILK + 0.75 * size;
    // Only joins well inside the frame show their seal, so no seal is ever cut by an edge.
    if (max(abs(q.x), abs(q.y)) < 0.6 && !onSilk) seal = shanSealShown(c.x + S.x - P.x, size, aspect) * shanSealInk(q, h, px / size);
    // The painter's seals come one to every stretch of the scroll a frame wide, less the margins
    // in which a seal is not yet wholly shown, so one is always fully in view. Each sits high in
    // the empty sky, or beneath an inscription's columns when it falls among them, as a writer's
    // seal does.
    float ps = 0.85 * size;
    float reach = 0.75 * ps;
    float spacing = max(0.97 * (aspect - 2.0 * reach - 0.1), 0.25);
    float i = floor(P.x / spacing - 0.3);
    float sx = (i + 0.8) * spacing;
    if (abs(P.x - sx) < 0.65 * ps && !(joined && abs(join + sx - P.x) < SHAN_JOIN_SILK + reach)) {
      float hs = shanHash(i, 83.0);
      float sy = min(0.8 + 0.06 * hs, 1.0 - reach - 0.06);
      ShanInscription s = shanInscriptionOn(floor(sx / SHAN_SHEET));
      if (s.lines > 0.0) {
        float clear = reach + 0.55 * SHAN_GLYPH + 0.01;
        float under = 1.0;
        if (abs(sx - s.x) < clear) under = s.top - s.lines * SHAN_GLYPH * 1.12;
        if (abs(sx - s.x + 1.35 * SHAN_GLYPH) < clear) under = min(under, s.nameTop - s.nameLines * SHAN_GLYPH * 1.12);
        sy = min(sy, under - 0.015 - reach);
      }
      vec2 sq = rotate(P - vec2(sx, sy), (hs - 0.5) * 0.06) / ps;
      if (max(abs(sq.x), abs(sq.y)) < 0.6) seal = max(seal, shanSealShown(sx + S.x - P.x, ps, aspect) * shanSealRelief(sq, hs, px / ps));
    }
    if (stamp.w >= 0.0) {
      float since = stamp.w;
      float press = smoothstep(0.0, 0.18, since) * shanSealShown(stamp.x, size, aspect);
      float squash = 1.0 + 0.08 * (1.0 - smoothstep(0.0, 0.3, since));
      vec2 sq = rotate(S - stamp.xy, 0.03) / (size * squash);
      if (max(abs(sq.x), abs(sq.y)) < 0.6) seal = max(seal, press * shanSealInk(sq, 0.37, px / size));
    }
    seal = hardEdge(seal);
    if (seal > 0.0) {
      vec3 red = SHAN_CINNABAR * (0.92 + 0.16 * vnoise(P * 60.0)) * mix(vec3(1.0), exp(-ink * k * SHAN_ABSORB), 0.55);
      col = mix(col, red, seal * 0.94);
    }
  }

  float paperLum = dot(paper, LUMA);
  if (passing) {
    // Paper lies between the roller and the roll; the roller and the roll stand over its ends.
    float onPaper = (S.x > un.front && S.x < un.rollX) ? 1.0 : 0.0;
    vec3 surface = mix(shanMount(cell), col, onPaper);
    float shaded = max(shanRollShadow(S.x, un.front, SHAN_ROD), shanRollShadow(S.x, un.rollX, un.rollR));
    surface *= 1.0 - 0.26 * shaded;
    float rod = hardFill(abs(S.x - un.front) - SHAN_ROD, 1.5 * px);
    float roll = hardFill(abs(S.x - un.rollX) - un.rollR, 1.5 * px);
    surface = mix(surface, shanCylinder(SHAN_WOOD, (S.x - un.front) / SHAN_ROD, 1.0), rod);
    surface = mix(surface, shanCylinder(SHAN_PAPER_NEW * 0.94, (S.x - un.rollX) / un.rollR, 0.0), roll);
    float shown = onPaper * (1.0 - rod) * (1.0 - roll);
    seal *= shown;
    col = surface;
    paperLum = mix(dot(mix(SHAN_PAPER_NEW, SHAN_PAPER_OLD, K_age), LUMA), paperLum, shown);
  }
  return shadeOf(col, clamp((1.0 - dot(col, LUMA) / max(paperLum, 0.2)) * 1.25, 0.0, 1.0) * (1.0 - seal), seal);
}
`;
