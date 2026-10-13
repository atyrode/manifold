// The meadow's picture, back to front: the golden-hour sky from the shared library, soft hills in
// the haze (the mown M on the nearer one), the tree line at the meadow's far edge with mist at its
// feet, the sea of grass with the gusts sweeping across it as broad waves of paler light, then the
// near grass, the dandelion clocks and the seeds in the air (from the simulation, sim.ts), the
// nearest blades, and rain.
//
// The sea of grass is drawn as grass: rows of blades at depths evenly spaced in log depth, each row
// a fixed ground distance between blades, so the strokes are big and wide at the bottom of the frame
// and crowd into a fine stipple toward the horizon, where they fade into their average. The gusts
// lean the blades that are wide enough to move cleanly, turn every blade toward its paler side and
// light the gaps between them; the tips catch the low sun.
//
// The gust field `meadowGust` here is sim.ts's `meadowGust` line for line, built from the same
// constants, so a wave of light crossing the field is the gust that bows the near blades and lifts
// the seeds. Textures (see sim.ts): uSim0 the seeds and the pointer's breath, uSim1 the bend of each
// column of near grass, uSim2 the clocks.
//
// Knobs read here: K_grassHeight, K_grassDensity, K_meadowSeed, K_wind, K_gusts (and its "now"),
// K_gustRate, K_time, K_cycle, K_haze, K_rain, K_mown (and its "now"). K_dandelions only reaches the
// shader through the clocks the simulation grows.
import {
  GUST_TRIGGER,
  MARK_TRIGGER,
  MAX_CLOCKS,
  MEADOW_AWAY_MAX,
  MEADOW_BEND_SHAPE,
  MEADOW_BOW,
  MEADOW_FOCAL,
  MEADOW_GROUND,
  MEADOW_GUST,
  MEADOW_HEIGHT_MIN,
  MEADOW_HEIGHT_SPAN,
  MEADOW_HORIZON,
  MEADOW_LAYER_PAD,
  MEADOW_LAYERS,
  MEADOW_LEAN_MAX,
  MEADOW_MARGIN,
  MEADOW_REACH,
  MEADOW_TREES_Z,
  SECTORS,
  SEED_GROUP,
  SEED_GROUPS,
  type MeadowLayer,
} from "./sim.ts";

/** A number as a GLSL float literal. */
function float(value: number): string {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/** A const float array initialiser. */
function floats(values: readonly number[]): string {
  return `float[${values.length}](${values.map(float).join(", ")})`;
}

/** One property of every near-grass layer, as a const float array initialiser. */
function layerFloats(key: keyof MeadowLayer): string {
  return floats(MEADOW_LAYERS.map((layer) => layer[key]));
}

const G = MEADOW_GUST;
const LAYERS = MEADOW_LAYERS.length;

/** Rows of the sea of grass: this far apart in log depth, from this depth out to the tree line. */
const ROW = 0.1;
const FIELD_NEAR = 3;

export const meadowGlsl = `
// ---- the view, the gust field and the near grass: constants shared with sim.ts ----
const float MEADOW_HORIZON = ${float(MEADOW_HORIZON)};
const float MEADOW_FOCAL = ${float(MEADOW_FOCAL)};
const float MEADOW_GROUND = ${float(MEADOW_GROUND)};
const float MEADOW_FOV = ${float(2 * Math.atan(0.5 / MEADOW_FOCAL))};
const float MEADOW_TREES_Z = ${float(MEADOW_TREES_Z)};
const int MEADOW_GUST_TRIGGER = ${GUST_TRIGGER};
const int MEADOW_MARK_TRIGGER = ${MARK_TRIGGER};

const float MEADOW_DIR_X = ${float(G.dirX)};
const float MEADOW_DIR_Z = ${float(G.dirZ)};
const float MEADOW_SPEED = ${float(G.speed)};
const float MEADOW_SPEED_WIND = ${float(G.speedWind)};
const float MEADOW_LAMBDA[3] = ${floats(G.lambda)};
const float MEADOW_TRAIN_OFFSET[3] = ${floats(G.offset)};
const float MEADOW_WOB_A[3] = ${floats(G.wobA)};
const float MEADOW_WOB_K[3] = ${floats(G.wobK)};
const float MEADOW_WOB_W[3] = ${floats(G.wobW)};
const float MEADOW_WOB_P[3] = ${floats(G.wobP)};
const float MEADOW_WOB_SECOND = ${float(G.wobSecond)};
const float MEADOW_GATE_STEP[3] = ${floats(G.gateStep)};
const float MEADOW_GATE_K[3] = ${floats(G.gateK)};
const float MEADOW_GATE_W[3] = ${floats(G.gateW)};
const float MEADOW_GATE_P[3] = ${floats(G.gateP)};
const float MEADOW_TRAIN_WEIGHT[3] = ${floats(G.weight)};
const float MEADOW_GATE_RARE = ${float(G.gateRare)};
const float MEADOW_GATE_OFTEN = ${float(G.gateOften)};
const float MEADOW_GATE_SOFT = ${float(G.gateSoft)};
const float MEADOW_FRONT_TAIL = ${float(G.tail)};
const float MEADOW_FRONT_PEAK = ${float(G.peak)};
const float MEADOW_FRONT_EDGE = ${float(G.edge)};
const float MEADOW_REBOUND = ${float(G.rebound)};
const float MEADOW_REBOUND_AT = ${float(G.reboundAt)};
const float MEADOW_REBOUND_WIDTH = ${float(G.reboundWidth)};
const float MEADOW_FRONT_MEAN = ${float(G.frontMean)};
const float MEADOW_BLUR_FROM = ${float(G.blurFrom)};
const float MEADOW_BLUR_TO = ${float(G.blurTo)};
const float MEADOW_SOFTCLIP = ${float(G.softclip)};
const float MEADOW_NOW_START = ${float(G.nowStart)};
const float MEADOW_NOW_PACE = ${float(G.nowPace)};
const float MEADOW_NOW_EDGE = ${float(G.nowEdge)};
const float MEADOW_NOW_TAIL = ${float(G.nowTail)};
const float MEADOW_NOW_GAIN = ${float(G.nowGain)};
const float MEADOW_NOW_LIFE = ${float(G.nowLife)};
const float MEADOW_NOW_RISE = ${float(G.nowRise)};
const float MEADOW_NOW_WOB = ${float(G.nowWob)};
const float MEADOW_NOW_WOB_K = ${float(G.nowWobK)};
const float MEADOW_NOW_WOB_P = ${float(G.nowWobP)};

const float MEADOW_ROOT[${LAYERS}] = ${layerFloats("root")};
const float MEADOW_PITCH[${LAYERS}] = ${layerFloats("pitch")};
const float MEADOW_HMIN[${LAYERS}] = ${layerFloats("hMin")};
const float MEADOW_HMAX[${LAYERS}] = ${layerFloats("hMax")};
const float MEADOW_WIDTH[${LAYERS}] = ${layerFloats("width")};
const float MEADOW_SPIKE[${LAYERS}] = ${layerFloats("spike")};
const float MEADOW_SPIKE_WIDTH[${LAYERS}] = ${layerFloats("spikeWidth")};
const float MEADOW_CENTRE[${LAYERS}] = ${layerFloats("centre")};
const float MEADOW_LOW[${LAYERS}] = ${layerFloats("low")};
const float MEADOW_STALKS[${LAYERS}] = ${layerFloats("stalks")};
const float MEADOW_SHADE[${LAYERS}] = ${layerFloats("shade")};
const float MEADOW_PAD[${LAYERS}] = ${floats(MEADOW_LAYER_PAD)};
const float MEADOW_HEIGHT_MIN = ${float(MEADOW_HEIGHT_MIN)};
const float MEADOW_HEIGHT_SPAN = ${float(MEADOW_HEIGHT_SPAN)};
const float MEADOW_LEAN_MAX = ${float(MEADOW_LEAN_MAX)};
const float MEADOW_AWAY_MAX = ${float(MEADOW_AWAY_MAX)};
const float MEADOW_BEND_SHAPE = ${float(MEADOW_BEND_SHAPE)};
const float MEADOW_BOW = ${float(MEADOW_BOW)};
const float MEADOW_REACH = ${float(MEADOW_REACH)};
const int MEADOW_MARGIN = ${MEADOW_MARGIN};
const int MEADOW_MAX_CLOCKS = ${MAX_CLOCKS};
const int MEADOW_SECTORS = ${SECTORS};
const int MEADOW_SEED_GROUP = ${SEED_GROUP};
const int MEADOW_SEED_GROUPS = ${SEED_GROUPS};

// ---- the picture's own tuning ----
// The view turns this far left (radians) of the sky library's 'ahead', toward the sinking sun.
const float MEADOW_TURN = 0.8;
// Grass density knob 0..1 maps onto this much of the near layers' full density and more.
const float MEADOW_DENSITY_MIN = 0.15;
// The near blades' natural lean.
const float MEADOW_CURL = 0.4;
// The near blades' backlit edge (only the side facing the sun, fading across the blade) away from the
// sun; near it, it brightens with the forward scattering.
const float MEADOW_RIM_BASE = 0.08;

// The sea of grass: rows ${ROW} apart in log depth from depth ${FIELD_NEAR} to the tree line; blades a
// ground distance apart in each row, their half-width at the root, heights (before the grass height
// knob), the share of columns holding a blade (and more with the density knob), flowering stalks,
// flowers (more in drifts and far off, a band of colour before the trees), their seed heads and
// flowers (world units), how far a gust leans them and their own combed curl.
const float MEADOW_ROW = ${float(ROW)};
const int MEADOW_ROW_FIRST = ${Math.floor(Math.log(FIELD_NEAR) / ROW)};
const int MEADOW_ROW_LAST = ${Math.floor(Math.log(MEADOW_TREES_Z) / ROW)};
const float MEADOW_BLADE_SPACING = 0.075;
const float MEADOW_BLADE_WIDTH = 0.026;
const float MEADOW_GRASS_MIN = 0.45;
const float MEADOW_GRASS_MAX = 0.85;
const float MEADOW_FIELD_FILL = 0.55;
const float MEADOW_FIELD_FILL_SPAN = 0.4;
const float MEADOW_FIELD_STALKS = 0.22;
const float MEADOW_FLOWER_SHARE = 0.12;
const float MEADOW_HEAD_LENGTH = 0.12;
const float MEADOW_HEAD_WIDTH = 0.026;
const float MEADOW_FLOWER_RADIUS = 0.04;
const float MEADOW_FIELD_BEND = 0.15;
const float MEADOW_FIELD_CURL = 0.18;
// Only field blades at least this wide at the root (cells) lean, fully from the second: thinner ones
// would slide their stipple across the cells.
const float MEADOW_LEAN_FROM = 3.0;
const float MEADOW_LEAN_TO = 5.0;
// The soft golden veil over the far field: from this depth to the tree line it takes this much more
// of the haze (and more with the haze knob), warmed by the sun.
const float MEADOW_VEIL_NEAR = 25.0;
const float MEADOW_VEIL = 0.3;
const float MEADOW_VEIL_HAZE = 0.35;
const float MEADOW_VEIL_GOLD = 0.08;
// How strongly the gust load turns the grass to its pale, pressed side, and darkens it on the rebound.
const float MEADOW_SHEEN = 1.1;
const float MEADOW_REBOUND_SHADE = 0.6;
// The gust is sampled over this many cells along the wind, so far fronts blur, never alias.
const float MEADOW_BLUR_CELLS = 1.5;
// Aerial haze per world unit: always, and at full haze.
const float MEADOW_HAZE_BASE = 0.0025;
const float MEADOW_HAZE_GAIN = 0.011;
// The breath over the field: reach (screen heights), how hard it presses and how far it leans the grass.
const float MEADOW_BREATH_RADIUS = 0.09;
const float MEADOW_BREATH_FIELD = 0.5;
const float MEADOW_BREATH_LEAN = 0.5;
// Clocks: the stalk's half-width at its root and under the head; the receptacle (share of the head);
// the spokes of seeds at least this many cells apart round the rim.
const float MEADOW_STALK_BASE = 0.0042;
const float MEADOW_STALK_TOP = 0.0026;
const float MEADOW_KNOB = 0.16;
const float MEADOW_SPOKE_CELLS = 4.5;
// The mown M: centre (share of the width right of centre, height above the horizon), size, squash
// (the hillside leans back), stroke half-width; all in screen heights.
const float MEADOW_MARK_SHARE = 0.24;
const float MEADOW_MARK_Y = 0.066;
const float MEADOW_MARK_SIZE = 0.042;
const float MEADOW_MARK_SQUASH = 0.82;
const float MEADOW_MARK_STROKE = 0.0026;

const vec3 MEADOW_GREEN = vec3(0.13, 0.17, 0.05);      // the meadow's grasses, still green
const vec3 MEADOW_STRAW = vec3(0.36, 0.29, 0.12);      // and gone to seed
const vec3 MEADOW_PALE = vec3(0.86, 0.8, 0.56);        // the paler backs of the blades, shown as the wind presses them
const vec3 MEADOW_LEAF = vec3(0.1, 0.17, 0.045);
const vec3 MEADOW_STEM = vec3(0.17, 0.16, 0.06);
const vec3 MEADOW_HEAD = vec3(0.42, 0.34, 0.16);       // a flowering grass's seed head
const vec3 MEADOW_THROUGH = vec3(0.55, 0.62, 0.22);    // low sun through a bowed blade
const vec3 MEADOW_RIM = vec3(1.0, 0.8, 0.45);          // backlit edges and tips
const vec3 MEADOW_PAPPUS = vec3(0.95, 0.93, 0.86);
const vec3 MEADOW_RECEPTACLE = vec3(0.55, 0.45, 0.3);  // a bare clock's knob
const vec3 MEADOW_ACHENE = vec3(0.16, 0.11, 0.06);
const vec3 MEADOW_BEAK = vec3(0.75, 0.72, 0.62);
const vec3 MEADOW_BRACT = vec3(0.16, 0.2, 0.07);
const vec3 MEADOW_STALK = vec3(0.12, 0.16, 0.06);
const vec3 MEADOW_TREE = vec3(0.05, 0.08, 0.05);
const vec3 MEADOW_HILL = vec3(0.12, 0.16, 0.1);
const vec3 MEADOW_FAR = vec3(0.14, 0.16, 0.22);
const vec3 MEADOW_STUBBLE = vec3(0.85, 0.74, 0.46);

// ---- the gust field (sim.ts: meadowWind, meadowFront, meadowGust) ----
struct MeadowWind {
  vec2 dir;        // unit downwind direction on the ground (x right, y = z away from the viewer)
  float speed;     // front speed, world units per second
  float strength;  // K_gusts
  float threshold; // the gate's threshold, from K_gustRate
  float nowAge;    // seconds (x motion) since 'now' sent a big gust; negative while idle
};

MeadowWind meadowWind() {
  MeadowWind w;
  float side = K_wind < 0.0 ? -1.0 : 1.0;
  w.dir = normalize(vec2(side * MEADOW_DIR_X, MEADOW_DIR_Z));
  w.speed = MEADOW_SPEED + MEADOW_SPEED_WIND * abs(K_wind);
  w.strength = K_gusts;
  w.threshold = MEADOW_GATE_RARE + (MEADOW_GATE_OFTEN - MEADOW_GATE_RARE) * K_gustRate;
  w.nowAge = uTriggers[MEADOW_GUST_TRIGGER] < -1000.0 ? -1.0 : sinceTrigger(MEADOW_GUST_TRIGGER) * uMotion;
  return w;
}

// One front over its period f (downwind = larger f): a long tail swelling to a soft leading edge,
// and a faint rebound just upwind of the tail. b widens it to the span of a cell (periods).
float meadowFront(float f, float b) {
  float rise = smoothstep(MEADOW_FRONT_TAIL - b, MEADOW_FRONT_PEAK + b, f);
  float fall = 1.0 - smoothstep(MEADOW_FRONT_PEAK - b, MEADOW_FRONT_EDGE + b, f);
  float width = sqrt(MEADOW_REBOUND_WIDTH * MEADOW_REBOUND_WIDTH + b * b);
  float df = f - MEADOW_REBOUND_AT;
  df -= floor(df + 0.5);
  return rise * fall - MEADOW_REBOUND * (MEADOW_REBOUND_WIDTH / width) * exp(-df * df / (width * width));
}

// The gust load at ground point p = (x, z) at time tm (t x motion); blur is the ground length the
// sample spans along the wind.
float meadowGust(MeadowWind w, vec2 p, float tm, float blur) {
  float s = p.x * w.dir.x + p.y * w.dir.y;
  float c = p.x * w.dir.y - p.y * w.dir.x;
  float sum = 0.0;
  for (int k = 0; k < 3; k++) {
    float lambda = MEADOW_LAMBDA[k];
    float wobK = MEADOW_WOB_K[k];
    float wobW = MEADOW_WOB_W[k];
    float wobP = MEADOW_WOB_P[k];
    float wob = MEADOW_WOB_A[k] * (sin(c * wobK + tm * wobW + wobP) + MEADOW_WOB_SECOND * sin(c * wobK * 2.3 - tm * wobW * 1.4 + wobP * 2.0 + 1.0));
    float u = (s - w.speed * tm + wob) / lambda + MEADOW_TRAIN_OFFSET[k];
    float b = blur / lambda;
    float raw = meadowFront(u - floor(u), b);
    float front = raw + (MEADOW_FRONT_MEAN - raw) * smoothstep(MEADOW_BLUR_FROM, MEADOW_BLUR_TO, b);
    float n = sin(TAU * MEADOW_GATE_STEP[k] * u + c * MEADOW_GATE_K[k] + tm * MEADOW_GATE_W[k] + MEADOW_GATE_P[k]);
    sum += MEADOW_TRAIN_WEIGHT[k] * smoothstep(w.threshold, w.threshold + MEADOW_GATE_SOFT, n) * front;
  }
  float g = w.strength * sum / (1.0 + MEADOW_SOFTCLIP * max(sum, 0.0));
  if (w.nowAge >= 0.0 && w.nowAge < MEADOW_NOW_LIFE) {
    float at = MEADOW_NOW_START + MEADOW_NOW_PACE * w.speed * w.nowAge;
    float d = at - s - MEADOW_NOW_WOB * sin(c * MEADOW_NOW_WOB_K + MEADOW_NOW_WOB_P);
    float edge = MEADOW_NOW_EDGE + blur;
    float life = smoothstep(0.0, MEADOW_NOW_RISE, w.nowAge) * (1.0 - smoothstep(MEADOW_NOW_LIFE * 0.6, MEADOW_NOW_LIFE, w.nowAge));
    g += MEADOW_NOW_GAIN * life * smoothstep(0.0, edge, d) * exp(-max(d - edge, 0.0) / MEADOW_NOW_TAIL);
  }
  return g;
}

// ---- the distance ----
// Heights above the horizon (screen heights) at x (screen heights right of centre).
float meadowFarHill(float x) {
  return 0.02 + 0.03 * vnoise(vec2(x * 1.1 + 3.7, 0.5)) + 0.012 * vnoise(vec2(x * 3.3 + 1.2, 2.5));
}

// The nearer hills, rising into a broad down on the right where the M can be mown.
float meadowNearHill(float x, float markX) {
  float d = (x - markX) / 0.34;
  return 0.006 + 0.022 * vnoise(vec2(x * 1.9 + 7.1, 4.5)) + 0.006 * vnoise(vec2(x * 6.1, 6.5)) + 0.085 * exp(-d * d);
}

// The tree line: clumps of crowns and lower hedges between them, a leafy edge three cells across,
// opening into a gap in front of the down.
float meadowCrown(float x, float markX) {
  float n = 0.6 * vnoise(vec2(x * 7.0 + 11.3, 1.5)) + 0.3 * vnoise(vec2(x * 19.0, 3.5)) + 0.1 * vnoise(vec2(x * 47.0, 5.5));
  float gap = (x - markX) / 0.13;
  return (0.009 + 0.04 * smoothstep(0.3, 0.75, n)) * (1.0 - 0.65 * exp(-gap * gap)) + 0.0025 * vnoise(vec2(x * 160.0, 7.5));
}

// Hills fading into the haze, the mown M on the down, and the tree line at the meadow's far edge,
// its leaves flashing pale as a gust runs along it and mist at its feet. above: height above the
// horizon (negative down to the tree line's foot).
vec3 meadowDistance(vec3 col, float cx, float above, float markX, vec3 haze, vec3 amb, vec3 sun, float sunNear, MeadowWind wind, float tm, float aa, inout float accent) {
  if (above < meadowFarHill(cx)) {
    col = mix(haze, MEADOW_FAR * (amb * 0.7 + sun * 0.15), 0.28 - 0.14 * K_haze);
    accent = 0.0;
  }
  float near = meadowNearHill(cx, markX);
  if (above < near) {
    // Slopes rising to the right face the low sun on the left.
    float slope = (meadowNearHill(cx + 0.01, markX) - meadowNearHill(cx - 0.01, markX)) * 50.0;
    vec3 land = MEADOW_HILL * (amb * 0.6 + sun * (0.15 + 0.35 * clamp(slope * 3.0, 0.0, 1.0)));
    col = mix(haze, land, 0.5 - 0.22 * K_haze);
    accent = 0.0;
    // The M mown into the down: paler stubble in a path three cells wide. 'Now' brings it out for a
    // while (if it is off) and the low sun catches the cut grass in a glint sweeping along it.
    float age = uTriggers[MEADOW_MARK_TRIGGER] < -1000.0 ? -1.0 : sinceTrigger(MEADOW_MARK_TRIGGER);
    float summon = age < 0.0 ? 0.0 : smoothstep(0.0, 2.5, age) * (1.0 - smoothstep(11.0, 16.0, age));
    float mown = max(K_mown, summon);
    if (mown > 0.0) {
      vec2 q = (vec2(cx, above) - vec2(markX, MEADOW_MARK_Y)) / MEADOW_MARK_SIZE;
      q.y /= MEADOW_MARK_SQUASH;
      float d = markDistance(q) * MEADOW_MARK_SIZE;
      float stroke = 1.0 - smoothstep(MEADOW_MARK_STROKE - 0.7 * aa, MEADOW_MARK_STROKE + 0.7 * aa, d);
      float across = (cx - markX + 0.1 - 0.06 * age) / 0.035;
      float glint = age < 0.0 ? 0.0 : exp(-across * across) * (1.0 - smoothstep(4.0, 6.0, age));
      vec3 stubble = MEADOW_STUBBLE * (amb * 0.55 + sun * (0.5 + 1.2 * glint));
      col = mix(col, mix(haze, stubble, 0.75 - 0.25 * K_haze), stroke * mown);
      accent = max(accent, stroke * mown);
    }
  }
  float crown = meadowCrown(cx, markX);
  if (above < crown) {
    float gust = meadowGust(wind, vec2(cx * MEADOW_TREES_Z / MEADOW_FOCAL, MEADOW_TREES_Z), tm, 0.0);
    vec3 tree = MEADOW_TREE * (amb * 0.6 + sun * 0.12);
    tree = mix(tree, tree * 1.7 + amb * 0.025, clamp(0.8 * gust, 0.0, 0.7));
    tree = mix(tree, haze, 0.2 + 0.3 * K_haze);
    // Low golden mist lying along the trees' feet, behind the far grass.
    tree = mix(tree, haze, (0.35 + 0.35 * K_haze) * (1.0 - smoothstep(-0.022, 0.012, above)));
    // The crowns' leafy edge lit through by the sun behind them.
    float rim = (1.0 - smoothstep(0.0, 2.5 * aa, crown - above)) * sunNear;
    col = tree + sun * MEADOW_RIM * rim * 0.8;
    accent = 0.0;
  }
  return col;
}

// ---- the sea of grass ----
// A flower's colour: ox-eye daisy, buttercup, knapweed, red clover.
vec3 meadowFlower(float h) {
  if (h < 0.35) return vec3(0.95, 0.93, 0.84);
  if (h < 0.6) return vec3(1.0, 0.8, 0.18);
  if (h < 0.82) return vec3(0.6, 0.3, 0.62);
  return vec3(0.78, 0.3, 0.42);
}

// The meadow out to the tree line, over 'behind' (what lies past the field's far edge). A cell's ray
// meets the ground at depth zg; on its way it passes over rows of blades, each MEADOW_ROW further in
// log depth, and at row depth z it is MEADOW_GROUND (1 - z / zg) above the ground: where that height
// is below a blade's top, the blade can cover the cell. The cell walks those rows nearest first and
// stops once covered. Each blade is box-filtered across the cell (its half-width against the cell's
// width, both in ground units at the blade), and rows whose blades are under two cells apart give way
// to their average, which a golden veil of haze softens further toward the tree line. Leaning is a
// warp of the lookup, the same for every blade of a row at a given height, so blades bend without
// tearing; only blades several cells wide lean, and only a little.
//
// The loop is the scene's longest: (ln G / (G - tallest)) / MEADOW_ROW rows, 10 at the default grass
// height, 15 at the tallest, most of them cheap (no blade, or the cell already covered).
vec3 meadowGrass(vec2 uv, float aspect, vec3 behind, MeadowWind wind, float tm, float sunUp, float toward, vec3 amb, vec3 sun, vec3 haze, vec4 breath, float hScale, float aa) {
  float zg = MEADOW_GROUND * MEADOW_FOCAL / (MEADOW_HORIZON - uv.y);
  float a = (uv.x - 0.5) * aspect / MEADOW_FOCAL; // the ray's slope across: ground x = a z
  float pixel = aa / MEADOW_FOCAL;                // a cell's width as a slope
  float hMin = MEADOW_GRASS_MIN * hScale;
  float hMax = MEADOW_GRASS_MAX * hScale;
  float top = hMax + MEADOW_HEAD_LENGTH;
  float fill = MEADOW_FIELD_FILL + MEADOW_FIELD_FILL_SPAN * K_grassDensity;

  // The gust where the grass this cell sees stands: it presses the grass pale and leans it downwind;
  // the breath presses and parts it.
  float zv = min(zg, MEADOW_TREES_Z) * (1.0 - 0.3 * (hMin + hMax) / MEADOW_GROUND);
  float across = zv * pixel;
  float deep = across * zv / MEADOW_GROUND;
  float g = meadowGust(wind, vec2(a * zv, zv), tm, MEADOW_BLUR_CELLS * (abs(wind.dir.x) * across + wind.dir.y * deep));
  vec2 bq = (vec2(uv.x * aspect, uv.y) - vec2(breath.x * aspect, breath.y)) / MEADOW_BREATH_RADIUS;
  float puff = breath.z * exp(-dot(bq, bq));
  g += MEADOW_BREATH_FIELD * puff;
  float lean = clamp(wind.dir.x * MEADOW_FIELD_BEND * g + MEADOW_BREATH_LEAN * puff * sign(bq.x), -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX);
  float press = clamp(MEADOW_SHEEN * g, 0.0, 0.85);

  // Backlit by a low sun the grass glows, most of all in a broad swath below the sun; a high sun
  // lights it from above instead.
  float low = 1.0 - smoothstep(0.1, 0.55, sunUp);
  float high = clamp(sunUp, 0.0, 1.0);
  float glow = (0.22 + 0.6 * pow(toward, 3.0) + pow(toward, 24.0)) * low;
  vec3 lit = amb * 0.45 + sun * (0.7 * high + 0.6 * glow);
  vec3 pale = MEADOW_PALE * 0.62 * (amb * 0.5 + sun * (0.6 * high + 0.5 * glow + 0.12));
  vec3 gold = sun * MEADOW_RIM * (0.08 + 0.5 * glow) * (1.0 + max(g, 0.0));

  // Patches: green and gone to straw; drifts of flowers, thickening far off into a band of colour
  // before the trees.
  vec2 ground = vec2(a * zv, zv);
  float ripe = smoothstep(0.3, 0.78, vnoise(ground * 0.045 + vec2(K_meadowSeed * 0.73, 2.1)));
  float drift = smoothstep(0.5, 0.8, vnoise(ground * vec2(0.035, 0.05) + vec2(5.3, K_meadowSeed * 0.31)));
  float flowerShare = MEADOW_FLOWER_SHARE * (0.25 + drift) * (0.4 + smoothstep(12.0, 60.0, zv));
  vec3 driftColour = meadowFlower(vnoise(ground * 0.02 + vec2(17.0, K_meadowSeed * 0.17)));

  float lg = log(zg);
  int first = max(int(floor((lg + log(1.0 - top / MEADOW_GROUND)) / MEADOW_ROW)), MEADOW_ROW_FIRST);
  int last = min(int(floor(lg / MEADOW_ROW)), MEADOW_ROW_LAST);
  vec3 acc = vec3(0.0);
  float cover = 0.0;
  float zsum = 0.0;
  for (int j = first; j <= last; j++) {
    float lj = float(j) * MEADOW_ROW;
    float zj = exp(lj);
    float rise = MEADOW_GROUND * (1.0 - zj / zg); // the ray's height above the ground over this row
    float tRow = clamp(rise / hMax, 0.0, 1.0);
    float px = zj * pixel;                         // a cell's size in ground units at this row
    // Far rows, whose blades stand under two cells apart, give way to their average.
    float lod = smoothstep(0.5, 1.5, px / MEADOW_BLADE_SPACING);
    float c = 0.0;
    vec3 premult = vec3(0.0);
    if (lod < 1.0) {
      // Lean only blades wide enough to move cleanly; the fine far ones hold still.
      float curl = MEADOW_FIELD_CURL * sin(a * zj * 1.7 + lj * 13.0);
      float sway = lean * smoothstep(MEADOW_LEAN_FROM, MEADOW_LEAN_TO, 2.0 * MEADOW_BLADE_WIDTH / px);
      float u = (a - (curl + sway) * MEADOW_BEND_SHAPE * hMax * tRow * tRow / zj) * zj / MEADOW_BLADE_SPACING;
      float k = floor(u);
      vec2 key = vec2(k, lj * 31.0 + K_meadowSeed * 0.53);
      if (hash12(key) < fill) {
        float h2 = hash12(key + 5.3);
        float h3 = hash12(key + 9.1);
        float h4 = hash12(key + 13.7);
        float jr = 0.9 * MEADOW_ROW * h2;
        float zr = zj * (1.0 + jr * (1.0 + 0.5 * jr)); // exp(jr): the root, jittered in depth
        float hb = mix(hMin, hMax, h3);
        float above = MEADOW_GROUND * (1.0 - zr / zg);  // the ray's height above this blade's root
        float t = above / hb;
        bool flower = h4 < flowerShare;
        bool stalk = !flower && h4 < flowerShare + MEADOW_FIELD_STALKS;
        float dw = abs(u - k - 0.5 - 0.2 * (h2 - 0.5)) * MEADOW_BLADE_SPACING * zr / zj; // across, at the blade
        float pw = zr * pixel;
        if (above >= 0.0 && t <= 1.0 + MEADOW_HEAD_LENGTH / hb) {
          float w = (stalk || flower) ? 0.35 * MEADOW_BLADE_WIDTH : MEADOW_BLADE_WIDTH * pow(max(1.0 - t, 0.0), 0.7);
          c = t <= 1.0 ? clamp(min(dw + w, 0.5 * pw) - max(dw - w, -0.5 * pw), 0.0, pw) / pw : 0.0;
          vec3 albedo = mix(MEADOW_GREEN, MEADOW_STRAW, clamp(ripe + h3 - 0.5, 0.0, 1.0));
          vec3 blade = albedo * lit * mix(0.35, 1.0, sqrt(clamp(t, 0.0, 1.0)));
          // The gold of backlit tips belongs to the height in the canopy, not to the blade, so a
          // swaying blade carries no bright tip across the cells.
          blade = mix(blade, pale, press * (0.35 + 0.65 * t)) + gold * smoothstep(0.5, 1.0, tRow);
          float hq = above - hb; // height above the stalk's top
          if (flower) {
            float r = MEADOW_FLOWER_RADIUS;
            float rr = max(r, 0.5 * pw);
            float head = clamp((rr - length(vec2(dw, hq - 0.6 * r))) / pw + 0.5, 0.0, 1.0) * (r / rr) * (r / rr);
            if (head > c) {
              c = head;
              blade = meadowFlower(fract(h2 * 7.31)) * (amb * 0.6 + sun * (0.35 + 0.9 * glow));
            }
          } else if (stalk) {
            float e = length(vec2(2.0 * hq / MEADOW_HEAD_LENGTH - 1.0, dw / MEADOW_HEAD_WIDTH));
            float girth = max(MEADOW_HEAD_WIDTH, 0.5 * pw);
            float head = clamp((1.0 - e) * girth / pw + 0.5, 0.0, 1.0) * (MEADOW_HEAD_WIDTH / girth);
            if (head > c) {
              c = head;
              blade = mix(MEADOW_HEAD * lit, pale, 0.6 * press) + gold;
            }
          }
          premult = c * blade;
        }
      }
    }
    if (lod > 0.0) {
      // The row's average: its blades' share of the cell at this height, an average blade's colour,
      // and the flowers in bloom at their tops.
      float t = rise / (0.5 * (hMin + hMax));
      // Heights vary from blade to blade, so on average a row thins out smoothly toward its tops.
      float share = fill * 1.4 * MEADOW_BLADE_WIDTH * (1.0 - smoothstep(0.0, 1.25, t)) / MEADOW_BLADE_SPACING;
      share += fill * flowerShare * smoothstep(0.75, 1.05, t) * (1.0 - smoothstep(1.05, 1.2, t));
      vec3 blade = MEADOW_GREEN + (MEADOW_STRAW - MEADOW_GREEN) * ripe;
      blade = blade * lit * mix(0.35, 1.0, sqrt(clamp(t, 0.0, 1.0)));
      blade = mix(blade, pale, press * (0.35 + 0.65 * t)) + gold * smoothstep(0.5, 1.0, tRow);
      blade = mix(blade, driftColour * (amb * 0.6 + sun * (0.35 + 0.9 * glow)), flowerShare * 2.5 * smoothstep(0.75, 1.0, t));
      premult = mix(premult, share * blade, lod);
      c = mix(c, share, lod);
    }
    float take = (1.0 - cover) * c;
    acc += (1.0 - cover) * premult;
    zsum += take * zj;
    cover += take;
    if (cover > 0.97) break;
  }

  // Just behind a gust the released grass springs up past upright and shows its darker side.
  float rebound = 1.0 + MEADOW_REBOUND_SHADE * min(g, 0.0);
  float hazeDensity = MEADOW_HAZE_BASE + MEADOW_HAZE_GAIN * K_haze + 0.012 * K_rain;
  float veil = MEADOW_VEIL + MEADOW_VEIL_HAZE * K_haze;
  vec3 veilCol = haze + sun * MEADOW_VEIL_GOLD * (0.5 + 0.5 * toward);
  float zf = cover > 0.0 ? zsum / cover : zg;
  acc = mix(acc * rebound, veilCol * cover, 1.0 - exp(-hazeDensity * zf) * (1.0 - veil * smoothstep(MEADOW_VEIL_NEAR, MEADOW_TREES_Z, zf)));
  if (zg < MEADOW_TREES_Z) {
    // Between the stems: the shaded depths of the grass, lighter where a gust opens it to the sky.
    vec3 floorCol = mix(MEADOW_GREEN, MEADOW_STRAW, ripe) * (amb * 0.22 + sun * 0.15 * glow) * (1.0 + 0.8 * max(g, 0.0)) * rebound;
    behind = mix(floorCol, veilCol, 1.0 - exp(-hazeDensity * zg) * (1.0 - veil * smoothstep(MEADOW_VEIL_NEAR, MEADOW_TREES_Z, zg)));
  }
  return acc + (1.0 - cover) * behind;
}

// ---- the near grass ----
// One layer of blades and flowering stalks rooted below the frame, bent as the simulation bends
// their column (uSim1: lean, bow away from the viewer). Tall at the sides and short in the middle,
// they frame the view; dark against the light, glowing through where they are thin and along their
// edges, paler as a gust bows them away.
void meadowLayer(int layer, vec2 p, float aspect, float hScale, float density, vec3 amb, vec3 sun, float behind, float sunNear, float sunX, float aa, inout vec3 col, inout float accent) {
  float yy = p.y - MEADOW_ROOT[layer];
  if (yy <= 0.0) return;
  float pitch = MEADOW_PITCH[layer];
  float hMin = MEADOW_HMIN[layer] * hScale;
  float hMax = MEADOW_HMAX[layer] * hScale;
  float spike = MEADOW_SPIKE[layer] * hScale;
  float low = MEADOW_LOW[layer];
  // The tallest blade that could reach this cell grows from the root furthest toward the frame's
  // side within reach; above it there is nothing of this layer.
  float reach0 = MEADOW_REACH * yy + MEADOW_PAD[layer];
  float side = smoothstep(0.15, 0.75, abs(p.x / aspect - 0.5) * 2.0 + 2.0 * reach0 / aspect);
  float tallest = hMax * mix(low, 1.0, side);
  if (yy > tallest + spike) return;
  float girth = MEADOW_WIDTH[layer];
  float spikeGirth = MEADOW_SPIKE_WIDTH[layer];
  int columns = textureSize(uSim1, 0).x;
  bool bent = uSimOn.y > 0.5;
  // A blade's centreline strays at most MEADOW_REACH x its height above the roots (sim.ts), so only
  // the columns that close can reach this cell: a few near the roots and in the middle of the frame,
  // up to ~25 at the tips of the tall blades at the sides. With the sea of grass these are the
  // scene's longest loops; together over 32 only in a band of the lower frame.
  int reach = min(int(ceil((MEADOW_REACH * min(yy, tallest) + MEADOW_PAD[layer]) / pitch)), MEADOW_MARGIN);
  float column = floor(p.x / pitch);
  float salt = float(layer) * 57.0 + K_meadowSeed * 1.37;
  for (int k = -reach; k <= reach; k++) {
    float i = column + float(k);
    vec2 key = vec2(i, salt);
    float x0 = (i + 0.15 + 0.7 * hash12(key + 3.1)) * pitch;
    float edge = smoothstep(0.15, 0.75, abs(x0 / aspect - 0.5) * 2.0);
    if (hash12(key) > density * mix(MEADOW_CENTRE[layer], 1.0, edge)) continue;
    float h = mix(hMin, hMax, hash12(key + 7.7)) * mix(low, 1.0, edge);
    bool stalk = hash12(key + 11.3) < MEADOW_STALKS[layer];
    vec2 bend = bent ? texelFetch(uSim1, ivec2(clamp(int(i) + MEADOW_MARGIN, 0, columns - 1), layer), 0).rg : vec2(0.0);
    float lean = clamp(MEADOW_CURL * (hash12(key + 17.9) - 0.5) + bend.x, -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX);
    float bow = clamp(bend.y, -0.2, MEADOW_AWAY_MAX);
    float tall = h * (1.0 - MEADOW_BOW * bow);
    float s = yy / tall;
    if (s > 1.0 + (stalk ? spike / tall : 0.0)) continue;
    float tip = MEADOW_BEND_SHAPE * lean * h;
    float sc = min(s, 1.0);
    float slope = 2.0 * tip * sc / tall;
    float across = (p.x - x0 - tip * sc * sc) * inversesqrt(1.0 + slope * slope); // signed, + to the right
    float d = abs(across);
    float w = stalk ? max(girth * 0.36 * (1.0 - 0.3 * sc), 1.2 * aa) : girth * pow(max(1.0 - s, 0.0), 0.6);
    float cover = s <= 1.0 ? 1.0 - smoothstep(w - aa, w + aa, d) : 0.0;
    // The backlit edge on the side facing the sun only, fading across the blade: as a blade sways,
    // a cell sees one soft change of light, not a thin bright line passing.
    float facing = clamp(across * sign(sunX - p.x) / max(w, aa), 0.0, 1.0);
    float rim = facing * facing * cover;
    float pressed = clamp(bow, 0.0, 1.0);
    vec3 shade = (stalk ? MEADOW_STEM : MEADOW_LEAF) * (amb * 0.3 + sun * (0.1 + 0.55 * behind)) * MEADOW_SHADE[layer];
    shade += sun * MEADOW_THROUGH * pressed * (0.45 + behind) * 0.9;
    shade += sun * MEADOW_RIM * rim * (MEADOW_RIM_BASE + 1.1 * behind + 0.6 * sunNear);
    col = mix(col, shade, cover);
    accent *= 1.0 - cover;
    if (stalk) {
      // The seed head, nodding on along the stalk's tip.
      vec2 axis = normalize(vec2(2.0 * tip / tall, 1.0));
      vec2 q = p - vec2(x0 + tip, MEADOW_ROOT[layer] + tall);
      float e = length(vec2(2.0 * dot(q, axis) / spike - 1.0, dot(q, vec2(axis.y, -axis.x)) / spikeGirth));
      float head = 1.0 - smoothstep(1.0 - aa / spikeGirth, 1.0 + aa / spikeGirth, e);
      vec3 seeds = MEADOW_HEAD * (amb * 0.35 + sun * (0.2 + 0.9 * behind + 0.4 * pressed));
      seeds += sun * MEADOW_RIM * smoothstep(0.2, 1.0, e) * (MEADOW_RIM_BASE + 1.6 * behind + sunNear);
      col = mix(col, seeds, head);
      accent *= 1.0 - head;
    }
  }
}

// ---- the dandelion clocks ----
// The share of seeds left on clock c toward angle a, blended between the sim's sectors.
float meadowSectorFill(int c, float a) {
  float u = fract(a / TAU) * float(MEADOW_SECTORS) - 0.5;
  float i0 = floor(u);
  float sectors = float(MEADOW_SECTORS);
  int s0 = int(mod(i0 + sectors, sectors));
  int s1 = int(mod(i0 + 1.0, sectors));
  return mix(texelFetch(uSim2, ivec2(2 + s0, c), 0).r, texelFetch(uSim2, ivec2(2 + s1, c), 0).r, smoothstep(0.0, 1.0, u - i0));
}

// Each clock on a stalk that thins toward the head: a closed bud that opens into a sphere of seeds.
// The head is a starburst: from the knob each seed's fine beak runs out to a fan of pappus, the fans'
// ragged outer ends making the rim, brightest when the sun is behind; between them the head is open,
// with only a faint veil of the seeds pointing toward and away from us. A spoke stays while its part
// of the head still holds seeds, so the gusts and the breath bite gaps into the rim.
void meadowClocks(vec2 p, float aspect, vec3 amb, vec3 sun, float behind, float sunNear, float aa, inout vec3 col, inout float accent) {
  if (uSimOn.z < 0.5) return;
  for (int c = 0; c < MEADOW_MAX_CLOCKS; c++) {
    vec4 shape = texelFetch(uSim2, ivec2(1, c), 0); // radius, presence, open, fullness
    float presence = shape.y;
    if (presence < 0.004) continue;
    vec4 at = texelFetch(uSim2, ivec2(0, c), 0);    // root uv, head uv
    vec2 root = vec2(at.x * aspect, at.y);
    vec2 head = vec2(at.z * aspect, at.w);
    float R = shape.x;
    float reach = 1.6 * R;
    if (p.y < root.y || p.y > head.y + reach || p.x < min(root.x, head.x) - reach || p.x > max(root.x, head.x) + reach) continue;
    float open = shape.z;
    float fullness = shape.w;
    float cf = float(c);

    // The stalk: the sim's bend curve from the root up to the head, thinning as it goes.
    float tall = head.y - root.y;
    float s = clamp((p.y - root.y) / tall, 0.0, 1.0);
    float dx = head.x - root.x;
    float slope = 2.0 * dx * s / tall;
    float d = abs(p.x - root.x - dx * s * s) * inversesqrt(1.0 + slope * slope);
    float w = max(mix(MEADOW_STALK_BASE, MEADOW_STALK_TOP, s), 0.75 * aa);
    float stalk = (1.0 - smoothstep(w - aa, w + aa, d)) * step(p.y, head.y) * presence;
    float rim = smoothstep(w - 1.4 * aa, w, d);
    vec3 stalkCol = MEADOW_STALK * (amb * 0.35 + sun * (0.15 + 0.5 * behind)) + sun * MEADOW_RIM * rim * (0.3 + 1.2 * behind + 0.5 * sunNear);
    col = mix(col, stalkCol, stalk);
    accent *= 1.0 - stalk;

    vec2 q = p - head;
    float r = length(q);
    // The closed bud: bracts drawn to a point, giving way as the clock opens.
    float bud = 1.0 - smoothstep(0.05, 0.6, open);
    if (bud > 0.0) {
      vec2 bq = q / R - vec2(0.0, 0.12);
      float e = length(vec2(bq.x / (0.24 * (1.0 - 0.6 * clamp(bq.y / 0.45, 0.0, 1.0))), bq.y / 0.45));
      float budCover = (1.0 - smoothstep(1.0 - 2.5 * aa / R, 1.0, e)) * bud * presence;
      vec3 bract = MEADOW_BRACT * (amb * 0.4 + sun * (0.15 + 0.6 * behind)) + sun * MEADOW_RIM * smoothstep(0.6, 1.0, e) * (0.25 + behind);
      col = mix(col, bract, budCover);
      accent *= 1.0 - budCover;
    }

    // The knob the seeds sit on: dark with seeds, pale once bare.
    float knob = (1.0 - smoothstep(MEADOW_KNOB - aa / R, MEADOW_KNOB + aa / R, r / R)) * smoothstep(0.3, 0.7, open) * presence;
    col = mix(col, mix(MEADOW_ACHENE, MEADOW_RECEPTACLE, 1.0 - fullness) * (amb * 0.4 + sun * (0.2 + 0.6 * behind)), knob);

    float shown = smoothstep(0.0, 1.0, open);
    float Rs = R * mix(0.3, 1.0, shown);
    float rr = r / Rs;
    if (rr < 1.6 && shown > 0.0) {
      // Counted on the full head, so the starburst does not jump as the clock opens.
      float spokes = clamp(floor(TAU * R / (MEADOW_SPOKE_CELLS * aa)), 10.0, 32.0);
      float u = fract(atan(q.y, q.x) / TAU) * spokes;
      float k = floor(u + 0.5);
      float kk = mod(k, spokes);
      float jitter = hash12(vec2(kk, cf * 7.1 + 0.5)) - 0.5;
      float gap = TAU / spokes * r;                       // spoke to spoke, screen heights, at this radius
      float arc = abs(u - k - 0.2 * jitter) * gap;        // across the nearest spoke
      float present = smoothstep(-0.05, 0.05, meadowSectorFill(c, (kk + 0.2 * jitter) / spokes * TAU) - hash12(vec2(kk, cf * 3.3 + 1.7)));
      float end = 0.92 + 0.1 * jitter;                    // the spokes' ragged ends
      float beak = (1.0 - smoothstep(0.5 * aa, 1.2 * aa, arc)) * smoothstep(0.14, 0.2, rr) * (1.0 - smoothstep(0.5, 0.6, rr)) * 0.3;
      float fan = mix(0.08, 0.3, smoothstep(0.5, end, rr)) * gap;
      float tuft = (1.0 - smoothstep(fan - 0.7 * aa, fan + 0.7 * aa, arc)) * smoothstep(0.5, 0.62, rr) * (1.0 - smoothstep(end - 0.05, end + 0.05, rr));
      float veil = fullness * 0.22 * smoothstep(0.15, 0.4, rr) * (1.0 - smoothstep(0.7, 0.95, rr));
      float fluff = clamp(max(beak, tuft) * present + veil, 0.0, 1.0) * shown * presence;
      float edgeGlow = smoothstep(0.7, 0.92, rr) * tuft * present;
      vec3 pappus = MEADOW_PAPPUS * (amb * 0.5 + sun * (0.3 + 1.6 * behind + 0.9 * sunNear)) + sun * MEADOW_RIM * edgeGlow * (0.35 + 1.4 * behind + 0.8 * sunNear);
      col = mix(col, pappus, fluff);
      // A halo of light scattered by the fluff when the sun is behind it.
      float halo = smoothstep(0.75, 1.0, rr) * exp(-5.0 * max(rr - 1.0, 0.0)) * (1.0 - smoothstep(1.3, 1.6, rr));
      col += sun * 0.3 * halo * fullness * shown * presence * (behind + sunNear);
      accent = max(accent * (1.0 - fluff), fluff);
    }
  }
}

// ---- the seeds in the air ----
// Little parachutes: a soft tuft of bristles catching the light, the beak hanging under it with the
// seed at its end (once they are big enough to show it crisply), tilted as they drift. The sim sorts
// them by x in groups of eight, each with a bounding box, so a cell only looks at the groups near it.
void meadowSeeds(vec2 uv, vec2 p, float aspect, vec3 amb, vec3 sun, float behind, float sunNear, float aa, inout vec3 col, inout float accent) {
  if (uSimOn.x < 0.5) return;
  vec3 lit = amb * 0.55 + sun * (0.35 + 2.0 * behind + sunNear);
  for (int g = 0; g < MEADOW_SEED_GROUPS; g++) {
    vec4 box = texelFetch(uSim0, ivec2(g, 2), 0);
    if (uv.x < box.x || uv.x > box.z || uv.y < box.y || uv.y > box.w) continue;
    for (int j = 0; j < MEADOW_SEED_GROUP; j++) {
      int i = g * MEADOW_SEED_GROUP + j;
      vec4 a = texelFetch(uSim0, ivec2(i, 0), 0); // uv xy, pappus radius, alpha
      if (a.w < 0.004) continue;
      float r = a.z;
      vec2 q = p - vec2(a.x * aspect, a.y);
      if (dot(q, q) > 9.0 * r * r) continue;
      vec4 b = texelFetch(uSim0, ivec2(i, 1), 0); // tilt, depth, squash
      q = rotate(q, -b.x);
      float spread = length(vec2(q.x, (q.y - 0.1 * r) / b.z)) / r;
      float tuft = 1.0 - smoothstep(0.45, 1.0, spread);
      float core = 1.0 - smoothstep(0.0, 0.55, spread);
      float big = smoothstep(3.0 * aa, 5.0 * aa, r);
      float beakW = max(0.06 * r, 0.55 * aa);
      float beak = (1.0 - smoothstep(beakW, beakW + aa, segmentDistance(q, vec2(0.0, -0.2 * r), vec2(0.0, -1.45 * r)))) * big;
      float achene = (1.0 - smoothstep(0.85, 1.15, length(vec2(q.x / (0.12 * r + aa), (q.y + 1.7 * r) / (0.3 * r + aa))))) * big;
      float halo = exp(-1.4 * length(q) / r) * (0.12 + 0.5 * behind + 0.6 * sunNear);
      col = mix(col, MEADOW_BEAK * (amb * 0.45 + sun * 0.45), 0.55 * beak * a.w);
      col = mix(col, MEADOW_ACHENE * (amb * 0.4 + sun * (0.3 + behind)), 0.85 * achene * a.w);
      col = mix(col, MEADOW_PAPPUS * lit, 0.85 * tuft * a.w);
      col += sun * (0.25 * core + 0.18 * halo) * a.w;
      accent = max(accent, tuft * a.w);
    }
  }
}

// Knobs read here: see the top of shader.ts.
Shade sceneMeadow(vec2 uv, vec2 cell, float t) {
  Shade o = blankShade();
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float cx = p.x - 0.5 * aspect;
  float tm = t * uMotion;
  float aa = 1.0 / uRes.y;
  float rain = K_rain;

  Sky sky = skyAt(timeOfDay(K_time, K_cycle, t));
  vec3 sun = sky.sunColor * (1.0 - 0.75 * rain);
  vec3 amb = mix(sky.ambient, vec3(dot(sky.ambient, LUMA)), 0.35 * rain);
  // The camera's own frame (cam, ground x and z) and the sky library's (dir), turned toward the sun.
  vec3 cam = viewRay(uv, aspect, MEADOW_HORIZON, MEADOW_FOV);
  vec3 dir = cam;
  dir.xz = rotate(cam.xz, MEADOW_TURN);
  vec2 sunXZ = rotate(sky.sun.xz, -MEADOW_TURN);
  vec3 sunCam = vec3(sunXZ.x, sky.sun.y, sunXZ.y);
  float up = smoothstep(-0.03, 0.03, sky.sun.y);
  // Forward scattering: how much light comes through thin things between this cell and the sun.
  float toSun = max(dot(cam, sunCam), 0.0);
  float behind = (0.6 * pow(toSun, 6.0) + 0.9 * pow(toSun, 90.0)) * up;
  float toward = max(dot(normalize(cam.xz), normalize(sunCam.xz)), 0.0);
  vec2 sunP = vec2(0.5 * aspect, MEADOW_HORIZON) + sunCam.xy / max(sunCam.z, 0.05) * MEADOW_FOCAL;
  float sunNear = sunCam.z > 0.05 ? exp(-length(p - sunP) / 0.2) * up : 0.0;
  // The low sky toward this bearing, gilded toward the sun by the haze; it closes the distance.
  vec3 haze = skyColor(sky, normalize(vec3(dir.x, 0.012, dir.z))) + sun * K_haze * 0.22 * pow(toward, 6.0);
  haze = mix(haze, vec3(dot(haze, LUMA)) * 0.85 + 0.03, 0.55 * rain);

  MeadowWind wind = meadowWind();
  vec4 breath = uSimOn.x > 0.5 ? texelFetch(uSim0, ivec2(MEADOW_SEED_GROUPS, 2), 0) : vec4(0.0);
  float hScale = MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN * K_grassHeight;
  float accent = 0.0;
  vec3 col = vec3(0.0);
  // Above the tree line's foot: sky, hills and trees. Below the horizon the grass is drawn over them.
  if (uv.y >= MEADOW_HORIZON - MEADOW_GROUND * MEADOW_FOCAL / MEADOW_TREES_Z) {
    col = skyColor(sky, dir);
    vec4 cloud = skyClouds(sky, dir, t, 0.2 + 0.65 * rain, K_wind);
    col = mix(col, cloud.rgb, cloud.a);
    col += vec3(0.85, 0.9, 1.0) * skyStars(sky, dir, 0.6) * (1.0 - cloud.a);
    col = mix(col, vec3(dot(col, LUMA)) * 0.8 + 0.04, 0.4 * rain);
    accent = (1.0 - smoothstep(0.016, 0.021, length(dir - sky.sun))) * up * (1.0 - cloud.a) * (1.0 - rain);
    float above = uv.y - MEADOW_HORIZON;
    if (above < 0.13) col = meadowDistance(col, cx, above, MEADOW_MARK_SHARE * aspect, haze, amb, sun, sunNear, wind, tm, aa, accent);
  }
  if (uv.y < MEADOW_HORIZON) col = meadowGrass(uv, aspect, col, wind, tm, sky.sun.y, toward, amb, sun, haze, breath, hScale, aa);
  // Golden haze: light scattered toward the eye around the sun, over everything beyond the near grass.
  col += sun * (0.05 + 0.3 * K_haze) * exp(-5.0 * length(dir - sky.sun)) * (1.0 - 0.6 * rain);

  float density = MEADOW_DENSITY_MIN + (1.0 - MEADOW_DENSITY_MIN) * K_grassDensity;
  meadowLayer(1, p, aspect, hScale, density, amb, sun, behind, sunNear, sunP.x, aa, col, accent);
  meadowClocks(p, aspect, amb, sun, behind, sunNear, aa, col, accent);
  meadowSeeds(uv, p, aspect, amb, sun, behind, sunNear, aa, col, accent);
  meadowLayer(0, p, aspect, hScale, density, amb, sun, behind, sunNear, sunP.x, aa, col, accent);

  if (rain > 0.0) {
    float streak = rainStreaks(uv, aspect, t, rain, K_wind);
    col = mix(col, amb * 0.9 + sun * 0.2 + 0.03, 0.45 * streak);
  }

  o.rgb = col;
  o.source = col;
  o.ink = clamp(dot(col, LUMA) * 1.3, 0.0, 1.0);
  o.accent = clamp(accent, 0.0, 1.0);
  return o;
}
`;
