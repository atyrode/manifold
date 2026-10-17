// The meadow's layers' GLSL (ADR 0062 Phase 1; the composer: src/composer, README "Composers"):
// the downs (the backdrop: the golden-hour sky's staging, soft hills in the haze with the mown M on
// the nearer one, the tree line at the field's far edge with mist at its feet, the meadow's air),
// the grass (a cover: the sea of grass with the gusts sweeping across it as broad waves of paler
// light, the two layers of near grass, the curtains of heavy rain) and the dandelions (a dressing:
// the clocks and their seeds in the air, from the simulation, sim.ts). The wildflowers are their own
// layer (wildflowers.ts). The sky, the weather and the birds are the World's, composed by the
// composer through the rig the preset gives (meadow's: horizon 0.4, focal 1.18, the eye 2 m up,
// RIG_* in the program); every layer's parts are drawn in the order the meadow painted them: the
// downs' sky and distance, the sea of grass, the World's birds, the golden haze, the curtains, the
// near grass's farther layer, the clocks and the seeds, the nearest grass.
//
// Rain belongs to the sky here: the World's deck closes over and the light goes flat, grey and dim
// with the amount, and the downs' own overcast lowers and darkens the sky further. A drizzle is a
// soft grey mist over the distance; steady rain hangs in shafts over the far hills; in a downpour the
// sky goes dark and low, the hills vanish, and the gusts drive curtains of rain across the field
// with the honami bands. The grass gets wet (uWeather.x, which lingers after the rain): darker and
// richer, glistening at the tops, the field sagging, the near blades bowing with beads of water along
// them and their seed heads nodding and dripping; the clocks close. Snow settles (uWeather.y, which
// melts after it stops): on the grass tops and the ground between the stems, on the hills and the
// trees, along the near blades.
//
// The sea of grass is drawn as grass: rows of blades at depths evenly spaced in log depth, each row
// a fixed ground distance between blades, so the strokes are big and wide at the bottom of the frame
// and crowd into a fine stipple toward the horizon, where they fade into their average. The gusts
// lean the blades that are wide enough to move cleanly, turn every blade toward its paler side and
// light the gaps between them; the tips catch the low sun. Under another backdrop the field runs out
// to where that backdrop's land ends (x.landZ), and over another ground it grows where the claims
// let covers grow (coverAllowed), by its `overgrowth` in shared claims, in the claims' shadows and the
// layers' lights; anything standing nearer than the floor hides the rows behind it. Under a sun
// higher than golden hour's (another preset's afternoon, the time knob) the grass is lit from above
// and glows green through its blades (meadowAbove); at golden hour that light is exactly 0.
//
// The gust field is the composer's (composer/gust.ts, gustAt): meadow's own honami field, promoted,
// so a wave of light crossing the field is the gust that bows the near blades and lifts the seeds.
// Data (sim.ts): the grass's record (the pointer's breath) and its field 0 (the bend of each column
// of near grass); the dandelions' records (rows 0-2 the seeds, from MEADOW_CLOCK_ROW the clocks).
//
// Passage (entrance and exit): the rig's lift over its rest height (the preset's rigLift, constants.ts
// `meadowDrop`). The sea of grass is drawn from that height (x.eye), the sky and the distance are not
// moved, and the near grass layers sit lower in the frame by focal length x lift / their depth (the
// sim lowers the clocks and the seeds the same way): one camera, one projection, nearer things moving
// more. Moving, edges are cut per cell (x.moving). The passage gust is one more term of the gust
// field. At rest, none of it changes a pixel.
//
// Knobs read here: the downs' K_haze, K_mown (and its "now"); the grass's K_grassHeight,
// K_grassDensity, K_overgrowth; the composer's K_seed, K_wind, K_gusts, K_gustRate, K_rain (the
// drips); uWeather.x for how wet the grass is, uWeather.y how much snow lies on it. K_dandelions only
// reaches the shader through the clocks the simulation grows.
import { glslFloat } from "../../shaders/glsl.ts";
import { MAX_CLOCKS, MEADOW_TREES_Z } from "./constants.ts";
import {
  MEADOW_AWAY_MAX,
  MEADOW_BEND_SHAPE,
  MEADOW_BOW,
  MEADOW_HEIGHT_MIN,
  MEADOW_HEIGHT_SPAN,
  MEADOW_LAYER_PAD,
  MEADOW_LAYERS,
  MEADOW_LEAN_MAX,
  MEADOW_MARGIN,
  MEADOW_REACH,
  SECTORS,
  SEED_GROUP,
  SEED_GROUPS,
  SEED_ROWS,
  type MeadowLayer,
} from "./sim.ts";

/** A const float array initialiser. */
function floats(values: readonly number[]): string {
  return `float[${values.length}](${values.map(glslFloat).join(", ")})`;
}

/** One property of every near-grass layer, as a const float array initialiser. */
function layerFloats(key: keyof MeadowLayer): string {
  return floats(MEADOW_LAYERS.map((layer) => layer[key]));
}

const LAYERS = MEADOW_LAYERS.length;

/** Rows of the sea of grass: this far apart in log depth, from this depth out to the land's end. */
const ROW = 0.1;
const FIELD_NEAR = 3;

export const meadowSharedGlsl = `
// ---- the meadow's constants and per-cell light, shared by its layers (the shaker keeps what a
// program reaches) ----
const float MEADOW_TREES_Z = ${glslFloat(MEADOW_TREES_Z)};
const int MEADOW_CLOCK_ROW = ${SEED_ROWS};
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
const float MEADOW_LAYER_Z[${LAYERS}] = ${layerFloats("z")};
const float MEADOW_PAD[${LAYERS}] = ${floats(MEADOW_LAYER_PAD)};
const float MEADOW_HEIGHT_MIN = ${glslFloat(MEADOW_HEIGHT_MIN)};
const float MEADOW_HEIGHT_SPAN = ${glslFloat(MEADOW_HEIGHT_SPAN)};
const float MEADOW_LEAN_MAX = ${glslFloat(MEADOW_LEAN_MAX)};
const float MEADOW_AWAY_MAX = ${glslFloat(MEADOW_AWAY_MAX)};
const float MEADOW_BEND_SHAPE = ${glslFloat(MEADOW_BEND_SHAPE)};
const float MEADOW_BOW = ${glslFloat(MEADOW_BOW)};
const float MEADOW_REACH = ${glslFloat(MEADOW_REACH)};
const int MEADOW_MARGIN = ${MEADOW_MARGIN};
const int MEADOW_MAX_CLOCKS = ${MAX_CLOCKS};
const int MEADOW_SECTORS = ${SECTORS};
const int MEADOW_SEED_GROUP = ${SEED_GROUP};
const int MEADOW_SEED_GROUPS = ${SEED_GROUPS};

// ---- the picture's own tuning ----
// How far off the hills stand (world units, metres): where the cloud deck's shadows fall on them.
const float MEADOW_HILLS_Z = 1500.0;
// Grass density knob 0..1 maps onto this much of the near layers' full density and more.
const float MEADOW_DENSITY_MIN = 0.15;
// The near blades' natural lean.
const float MEADOW_CURL = 0.4;
// The near blades' backlit edge (only the side facing the sun, fading across the blade) away from the
// sun; near it, it brightens with the forward scattering.
const float MEADOW_RIM_BASE = 0.08;

// The near stalks (the nearest layers' flowering grasses). Half-width at the root in cells, at the
// nearest layer (thinner further off) and how much more the thickest has; the share of it kept at the
// top; never under this many cells (thinner stalks would only dot the cells). The lean they are given
// on top of the blades' own curl, and the exponent range of their curve (2 is the blades' own bow:
// lower bends nearer the root, higher holds upright and bends late). Clumps over the columns: their
// scale, the share of stalks left between them and the extra in them. The share of stalks standing
// bare, and carrying a plain ear (the rest carry panicles); the longest head x the layer's seed head;
// panicle spikelets at least this many cells apart, and its width x the layer's seed head width.
const float MEADOW_STALK_CELLS = 1.0;
const float MEADOW_STALK_CELLS_SPAN = 1.0;
const float MEADOW_STALK_TIP = 0.4;
const float MEADOW_STALK_MIN = 0.8;
const float MEADOW_STALK_LEAN = 0.3;
const float MEADOW_STALK_CURVE_MIN = 1.4;
const float MEADOW_STALK_CURVE_MAX = 2.3;
const float MEADOW_CLUMP_SCALE = 0.2;
const float MEADOW_CLUMP_GAP = 0.2;
const float MEADOW_CLUMP_GAIN = 2.0;
const float MEADOW_BARE_SHARE = 0.22;
const float MEADOW_EAR_SHARE = 0.22;
const float MEADOW_HEAD_MAX = 1.4;
const float MEADOW_SPIKELET_CELLS = 3.6;
const float MEADOW_PANICLE_WIDTH = 1.8;
// Against the glare (the clock's backdrop this bright, in luma) a clock's body darkens by this much,
// so its starburst reads as a pale fan over a dim disc.
const float MEADOW_GLARE_FROM = 0.55;
const float MEADOW_GLARE_TO = 1.0;
const float MEADOW_GLARE_DARK = 0.45;

// The sea of grass: rows ${ROW} apart in log depth from depth ${FIELD_NEAR} to the tree line; blades a
// ground distance apart in each row, their half-width at the root, heights (before the grass height
// knob), the share of columns holding a blade (and more with the density knob), flowering stalks,
// flowers (more in drifts and far off, a band of colour before the trees), their seed heads and
// flowers (world units), how far a gust leans them and their own combed curl.
const float MEADOW_ROW = ${glslFloat(ROW)};
const int MEADOW_ROW_FIRST = ${Math.floor(Math.log(FIELD_NEAR) / ROW)};
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
// The soft golden veil over the far field: from this depth to MEADOW_VEIL_FAR it takes this much more
// of the haze (and more with the haze knob), warmed by the sun, so the field's texture fades into haze
// well before the tree line.
const float MEADOW_VEIL_NEAR = 9.0;
const float MEADOW_VEIL_FAR = 80.0;
const float MEADOW_VEIL = 0.45;
const float MEADOW_VEIL_HAZE = 0.4;
const float MEADOW_VEIL_GOLD = 0.08;
// How strongly the gust load turns the grass to its pale, pressed side, and darkens it on the rebound.
const float MEADOW_SHEEN = 1.1;
const float MEADOW_REBOUND_SHADE = 0.6;
// The gust is sampled over this many cells along the wind, so far fronts blur, never alias.
const float MEADOW_BLUR_CELLS = 1.5;
// A sun standing higher than golden hour's (meadowAbove: 0 up to 0.1 up, 1 from 0.55) lights the
// grass from above: the sea of grass's blades (their lower parts less shaded) and the depths between
// them, the near blades' faces and seed heads, the flowers; and it shines green through the green
// blades (MEADOW_SUNLIT; not the dry ones). At golden hour all of it is 0, and the grass glows by
// the low sun behind it alone.
const float MEADOW_ABOVE_LIT = 1.2;
const float MEADOW_ABOVE_THROUGH = 0.9;
const float MEADOW_ABOVE_SHADE = 0.4;
const float MEADOW_ABOVE_FLOOR = 1.0;
const float MEADOW_ABOVE_NEAR = 0.9;
// Aerial haze per world unit: always, and at full haze.
const float MEADOW_HAZE_BASE = 0.0025;
const float MEADOW_HAZE_GAIN = 0.011;
// The rain's own extinction of the land per world unit, on top of the world's veil (worldPrecip,
// which takes each cell's depth in world units, metres here): a grey mist from the first drizzle,
// then visibility falling with the square of the amount.
const float MEADOW_DRIZZLE_MIST = 0.004;
const float MEADOW_RAIN_MIST = 0.016;
// The meadow's own overcast over the world's grey sky (worldGrey): how much darker it gets overhead
// (x the storm's amount).
const float MEADOW_OVERCAST_DARK = 0.35;
// The bright sky the rain refracts and the wet grass mirrors: sampled this high (screen heights above
// the horizon) toward this cell's bearing. Drops shine at MEADOW_DROP_SKY x it plus the sun's light,
// never below MEADOW_DROP_FLOOR (night); the overcast deck also lights the field flatly by this much.
const float MEADOW_DECK_ABOVE = 0.25;
const float MEADOW_DROP_SKY = 1.2;
const float MEADOW_DROP_FLOOR = 0.08;
const float MEADOW_DECK_LIGHT = 0.6;
// Wet grass tops mirror the sky: how upward they face (for wetGloss), and how bright the sky in them
// is, so each row of the field carries a band of light along its tops.
const float MEADOW_TOP_UP = 0.75;
const float MEADOW_WET_SHEEN = 1.4;
// Rain shafts hanging over the far hills: opacity, how high they reach (screen heights, more in
// heavier rain), lean downwind (across per height) and drift (screen heights per second per wind).
const float MEADOW_SHAFT = 0.55;
const float MEADOW_SHAFT_HEIGHT = 0.22;
const float MEADOW_SHAFT_LEAN = 0.35;
const float MEADOW_SHAFT_DRIFT = 0.012;
// Gust curtains in heavy rain: the gust load at which they start and fill, their veil and the extra
// drops in them.
const float MEADOW_CURTAIN_FROM = 0.1;
const float MEADOW_CURTAIN_TO = 0.8;
const float MEADOW_CURTAIN = 0.25;
// Wet grass: how far the near blades bow and the field sags; how far the near seed heads nod
// (radians); beads per blade length and the share of places holding one when soaked; the spacing of
// the drip lanes in cells, at least ~15 (a drop is ~0.22 of it across and falls ~5 of it, fading
// after 3). A closed clock folds this much narrower.
const float MEADOW_WET_BOW = 0.3;
const float MEADOW_WET_SAG = 0.12;
const float MEADOW_WET_NOD = 0.9;
const float MEADOW_BEADS = 7.0;
const float MEADOW_BEAD_SHARE = 0.55;
const float MEADOW_DRIP_CELLS = 16.0;
const float MEADOW_FOLD = 0.55;
// Lying snow (uWeather.y): how much of it the grass tops hold (most toward their tips), the near
// blades along their upper half, the hills and the tree line.
const float MEADOW_SNOW_TOPS = 0.7;
const float MEADOW_SNOW_NEAR = 0.45;
const float MEADOW_SNOW_LAND = 0.85;
const float MEADOW_SNOW_TREES = 0.35;
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
// (the hillside leans back), stroke half-width (and at least this many cells); all in screen heights.
// It stands in the open middle of the view, left of where the near blades rise past the horizon.
const float MEADOW_MARK_SHARE = 0.15;
const float MEADOW_MARK_Y = 0.062;
const float MEADOW_MARK_SIZE = 0.06;
const float MEADOW_MARK_SQUASH = 0.82;
const float MEADOW_MARK_STROKE = 0.0042;
const float MEADOW_MARK_CELLS = 1.6;
// The down the M is mown into: its rise above the hills, its half-width; how much of its own colour
// it keeps against the haze, and the path's (both less with the haze knob); the low sun on the stubble.
const float MEADOW_DOWN = 0.095;
const float MEADOW_DOWN_WIDTH = 0.34;
const float MEADOW_DOWN_CLEAR = 0.62;
const float MEADOW_PATH_CLEAR = 0.85;
const float MEADOW_PATH_SUN = 0.95;

const vec3 MEADOW_GREEN = vec3(0.13, 0.17, 0.05);      // the meadow's grasses, still green
const vec3 MEADOW_STRAW = vec3(0.36, 0.29, 0.12);      // and gone to seed
const vec3 MEADOW_PALE = vec3(0.86, 0.8, 0.56);        // the paler backs of the blades, shown as the wind presses them
const vec3 MEADOW_LEAF = vec3(0.1, 0.17, 0.045);
const vec3 MEADOW_STEM = vec3(0.17, 0.16, 0.06);
const vec3 MEADOW_HEAD = vec3(0.42, 0.34, 0.16);       // a flowering grass's seed head
const vec3 MEADOW_THROUGH = vec3(0.55, 0.62, 0.22);    // low sun through a bowed blade
const vec3 MEADOW_SUNLIT = vec3(0.3, 0.62, 0.22);      // a high sun through a green blade
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
const vec3 MEADOW_SNOW = vec3(0.86, 0.88, 0.92);

// The light the meadow's layers read in every cell (meadowBegin): their screen point (x from the
// frame's left edge) and its x from the centre line; forward scattering, how much light comes
// through thin things between this cell and the key light; how far the cell's bearing turns toward
// it on the ground; its point in the frame, and the glow round it there; the key light at the eye's
// feet, through the cloud shadows; how high the sun stands above golden hour's.
vec2 meadowP;
float meadowCx;
float meadowBehind;
float meadowToward;
float meadowSunX;
float meadowSunNear;
vec3 meadowSunHere;
float meadowAbove;

void meadowBegin(Ctx x) {
  meadowP = vec2(x.uv.x * x.aspect, x.uv.y);
  meadowCx = meadowP.x - 0.5 * x.aspect;
  vec3 cam = x.v.ray;
  vec3 sunCam = x.light.key;
  float up = smoothstep(-0.03, 0.03, x.w.sky.sun.y);
  float toSun = max(dot(cam, sunCam), 0.0);
  meadowBehind = (0.6 * pow(toSun, 6.0) + 0.9 * pow(toSun, 90.0)) * up;
  meadowToward = max(dot(normalize(cam.xz), normalize(sunCam.xz)), 0.0);
  vec2 sunP = vec2(0.5 * x.aspect, RIG_HORIZON) + sunCam.xy / max(sunCam.z, 0.05) * RIG_FOCAL;
  meadowSunX = sunP.x;
  meadowSunNear = sunCam.z > 0.05 ? exp(-length(meadowP - sunP) / 0.2) * up : 0.0;
  meadowSunHere = x.light.sun * worldSunlit(x.w, x.v, vec3(0.0, -x.eye, 0.0));
  meadowAbove = smoothstep(0.1, 0.55, x.w.sky.sun.y);
}
`;

/** The downs' GLSL: the sky's staging, the hills with the mown M, the tree line, the meadow's air. */
export const downsGlsl = `
// ---- the distance ----
// Heights above the horizon (screen heights) at x (screen heights right of centre).
float meadowFarHill(float x) {
  return 0.02 + 0.03 * vnoise(vec2(x * 1.1 + 3.7, 0.5)) + 0.012 * vnoise(vec2(x * 3.3 + 1.2, 2.5));
}

// The nearer hills, rising into a broad down on the right where the M can be mown.
float meadowNearHill(float x, float markX) {
  float d = (x - markX) / MEADOW_DOWN_WIDTH;
  return 0.006 + 0.022 * vnoise(vec2(x * 1.9 + 7.1, 4.5)) + 0.006 * vnoise(vec2(x * 6.1, 6.5)) + MEADOW_DOWN * exp(-d * d);
}

// The tree line: clumps of crowns and lower hedges between them, a leafy edge three cells across,
// opening into a gap in front of the down.
float meadowCrown(float x, float markX) {
  float n = 0.6 * vnoise(vec2(x * 7.0 + 11.3, 1.5)) + 0.3 * vnoise(vec2(x * 19.0, 3.5)) + 0.1 * vnoise(vec2(x * 47.0, 5.5));
  float gap = (x - markX) / 0.13;
  return (0.009 + 0.04 * smoothstep(0.3, 0.75, n)) * (1.0 - 0.65 * exp(-gap * gap)) + 0.0025 * vnoise(vec2(x * 160.0, 7.5));
}

// Rain shafts under the cloud deck over the far hills: soft grey curtains reaching down from the
// cloud base, leaning downwind toward the ground, drifting slowly with the wind and faintly streaked
// along their fall; more of them, denser and taller the harder it rains. above: height above the
// horizon.
float meadowShafts(float cx, float above, float tm, float rain) {
  float x = cx + K_wind * (MEADOW_SHAFT_LEAN * above - MEADOW_SHAFT_DRIFT * tm);
  float n = 0.7 * vnoise(vec2(x * 4.5, 7.7)) + 0.3 * vnoise(vec2(x * 11.0, 3.1));
  float on = smoothstep(0.62 - 0.3 * rain, 0.8 - 0.25 * rain, n);
  float streak = 0.8 + 0.2 * vnoise(vec2(x * 90.0, above * 2.5 + tm * 0.25));
  float reach = 1.0 - smoothstep(0.02, MEADOW_SHAFT_HEIGHT * (0.6 + 0.6 * rain), above);
  return MEADOW_SHAFT * on * streak * reach * smoothstep(0.1, 0.4, rain);
}

// Hills fading into the haze, the mown M on the down, and the tree line at the meadow's far edge,
// its leaves flashing pale as a gust runs along it and mist at its feet. above: height above the
// horizon (negative down to the tree line's foot). In rain the land fades into the grey air by
// 'far', and the shafts hang over the hills in front of it and behind the trees. The hills take the
// sun as it reaches them (sunHills), the trees as it reaches the meadow's edge (sun). Lying snow
// (lying, uWeather.y) whitens the hills and dusts the trees.
vec3 meadowDistance(vec3 col, float cx, float above, float markX, vec3 haze, vec3 amb, vec3 sun, vec3 sunHills, float sunNear, GustWind wind, float tm, float aa, float far, vec3 air, float shaft, vec3 shaftCol, float lying, inout float accent) {
  if (above < meadowFarHill(cx)) {
    col = mix(mix(haze, mix(MEADOW_FAR * (amb * 0.7 + sunHills * 0.15), MEADOW_SNOW * (amb * 1.1 + sunHills * 0.4), MEADOW_SNOW_LAND * lying), 0.28 - 0.14 * K_haze), air, far);
    accent = 0.0;
  }
  float near = meadowNearHill(cx, markX);
  if (above < near) {
    // Slopes rising to the right face the low sun on the left.
    float slope = (meadowNearHill(cx + 0.01, markX) - meadowNearHill(cx - 0.01, markX)) * 50.0;
    vec3 land = MEADOW_HILL * (amb * 0.6 + sunHills * (0.15 + 0.35 * clamp(slope * 3.0, 0.0, 1.0)));
    land = mix(land, MEADOW_SNOW * (amb * 1.1 + sunHills * (0.3 + 0.5 * clamp(slope * 3.0, 0.0, 1.0))), MEADOW_SNOW_LAND * lying);
    col = mix(haze, land, MEADOW_DOWN_CLEAR - 0.22 * K_haze);
    accent = 0.0;
    // The M mown into the down: a path of pale stubble four or five cells wide, lit gold by the low
    // sun, standing well clear of the trees in the gap below it. 'Now' brings it out for a while (if
    // it is off) and the sun catches the cut grass in a glint sweeping along it.
    float age = uTriggers[TRIGGER_mown] < -1000.0 ? -1.0 : sinceTrigger(TRIGGER_mown);
    float summon = age < 0.0 ? 0.0 : smoothstep(0.0, 2.5, age) * (1.0 - smoothstep(11.0, 16.0, age));
    float mown = max(K_mown, summon);
    if (mown > 0.0) {
      vec2 q = (vec2(cx, above) - vec2(markX, MEADOW_MARK_Y)) / MEADOW_MARK_SIZE;
      q.y /= MEADOW_MARK_SQUASH;
      float d = markDistance(q) * MEADOW_MARK_SIZE;
      float halfWidth = max(MEADOW_MARK_STROKE, MEADOW_MARK_CELLS * aa);
      float stroke = 1.0 - smoothstep(halfWidth - 0.7 * aa, halfWidth + 0.7 * aa, d);
      float across = (cx - markX + 1.5 * MEADOW_MARK_SIZE - 0.06 * age) / (0.6 * MEADOW_MARK_SIZE);
      float glint = age < 0.0 ? 0.0 : exp(-across * across) * (1.0 - smoothstep(4.0, 6.0, age));
      vec3 stubble = MEADOW_STUBBLE * (amb * 0.6 + sunHills * (MEADOW_PATH_SUN + 1.2 * glint));
      col = mix(col, mix(haze, stubble, MEADOW_PATH_CLEAR - 0.25 * K_haze), stroke * mown);
      accent = max(accent, stroke * mown * (1.0 - far));
    }
    col = mix(col, air, far);
  }
  col = mix(col, shaftCol, shaft);
  float crown = meadowCrown(cx, markX);
  if (above < crown) {
    float gust = gustAt(wind, vec2(cx * MEADOW_TREES_Z / RIG_FOCAL, MEADOW_TREES_Z), tm, 0.0);
    vec3 tree = MEADOW_TREE * (amb * 0.6 + sun * 0.12);
    tree = mix(tree, MEADOW_SNOW * (amb * 0.9 + sun * 0.3), MEADOW_SNOW_TREES * lying);
    tree = mix(tree, tree * 1.7 + amb * 0.025, clamp(0.8 * gust, 0.0, 0.7));
    tree = mix(tree, haze, 0.2 + 0.3 * K_haze);
    // Low golden mist lying along the trees' feet, behind the far grass.
    tree = mix(tree, haze, (0.35 + 0.35 * K_haze) * (1.0 - smoothstep(-0.022, 0.012, above)));
    tree = mix(tree, air, 0.9 * far);
    // The crowns' leafy edge lit through by the sun behind them.
    float rim = (1.0 - smoothstep(0.0, 2.5 * aa, crown - above)) * sunNear;
    col = tree + sun * MEADOW_RIM * rim * 0.8;
    accent = 0.0;
  }
  return col;
}

// The meadow's own overcast over the world's grey sky (col, worldGrey'd: the deck's gaps by the world,
// the deck by the meadow), what it adds beyond it: its grey a little cooler and lifted, and darker
// overhead the harder it rains or snows (storm). above: height above the horizon (screen heights).
vec3 meadowDeck(vec3 col, float above, float overcast, float storm) {
  col += WORLD_DECK_GREY * overcast * (dot(col, LUMA) * (vec3(0.92, 0.95, 1.0) - 1.0) + 0.02);
  return col * (1.0 - storm * MEADOW_OVERCAST_DARK * smoothstep(0.0, 0.45, above));
}

// ---- the downs' passes ----
// Per cell (downsBegin): the air, the backdrop's: the low sky toward this bearing gilded toward the
// sun by the haze (closing the distance), greyed under the deck rain or snow closes; the air full of
// rain or snow, darker the heavier it falls (the fog's and the rain's colour); how much rain hides of
// the distance per metre, and of the land at the meadow's edge and beyond (downsMist); the bright sky
// (or overcast deck) above this bearing that the rain refracts and wet things mirror, looked up only
// while there is rain, snow or water about; the drops' light; the golden dust and its veil over the
// far field. And the land: the floor ends at the tree line's foot (x.groundTo, x.landZ), the cloud
// deck's shadows on the trees (where the ray meets the field, or above it the tree line) and on the
// hills, a broad part of a cloud's shadow.
float downsAbove;
bool downsInSky;
float downsMist;
float downsShaft;
vec3 downsShaftCol;
vec3 downsSunLand;
vec3 downsSunHills;

void downsBegin(inout Ctx x) {
  Sky sky = x.w.sky;
  vec3 sun = x.light.sun;
  vec3 dir = x.v.dir;
  float overcast = x.w.overcast;
  vec3 haze = horizonHaze(sky, dir, 0.012) + sun * K_haze * 0.22 * pow(meadowToward, 6.0);
  haze = mix(haze, vec3(dot(haze, LUMA)) * 0.85 + 0.03, 0.55 * overcast);
  vec3 air = greyed(haze, vec3(0.94, 0.97, 1.02), 0.5 * overcast) * (1.0 - 0.25 * x.w.heavy);
#if WORLD_RAIN
  float rainExt = x.w.rain > 0.0 ? MEADOW_DRIZZLE_MIST + MEADOW_RAIN_MIST * x.w.rain * x.w.rain : 0.0;
#else
  float rainExt = 0.0;
#endif
  downsMist = 1.0 - exp(-rainExt * MEADOW_TREES_Z);
  vec3 deck = x.w.storm > 0.0 || uWeather.x > 0.0 ? meadowDeck(worldGrey(x.w, horizonHaze(sky, dir, MEADOW_DECK_ABOVE / RIG_FOCAL * length(dir.xz)), 1.0), MEADOW_DECK_ABOVE, overcast, x.w.storm) : vec3(0.0);
  float zLand = x.uv.y < RIG_HORIZON ? min(x.eye * RIG_FOCAL / (RIG_HORIZON - x.uv.y), MEADOW_TREES_Z) : MEADOW_TREES_Z;
  downsSunLand = sun * worldSunlit(x.w, x.v, vec3(meadowCx * zLand / RIG_FOCAL, -x.eye, zLand));
  downsSunHills = sun * worldSunlit(x.w, x.v, vec3(meadowCx * MEADOW_HILLS_Z / RIG_FOCAL, -x.eye, MEADOW_HILLS_Z));
  vec3 drop = max(deck * MEADOW_DROP_SKY + sun * (0.3 + 2.5 * meadowBehind + 1.5 * meadowSunNear), vec3(MEADOW_DROP_FLOOR));
  x.air = Air(haze, air, drop, deck, rainExt, MEADOW_HAZE_BASE + MEADOW_HAZE_GAIN * K_haze, MEADOW_VEIL_HAZE * K_haze);
  x.groundTo = RIG_HORIZON - x.eye * RIG_FOCAL / MEADOW_TREES_Z;
  x.landZ = MEADOW_TREES_Z;
}

// Above the tree line's foot the world's sky: the dome, the aurora ahead behind the clouds, the
// deck, the stars and the Milky Way in its gaps, shooting stars high over the hills, greyed in rain
// or snow where the deck leaves it open; the deck greyed as well and the meadow's own overcast over
// it, and the lightning over that, its bolts dropping behind the hills; rain shafts under the deck.
void downsSky(Ctx x, inout Cell c) {
  downsAbove = x.uv.y - RIG_HORIZON;
  downsInSky = x.uv.y >= x.groundTo;
  if (!downsInSky) return;
  Sky sky = x.w.sky;
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  c.col = meadowDeck(worldGrey(x.w, heaven.col, heaven.cloud), downsAbove, x.w.overcast, x.w.storm) + heaven.strike;
  float up = smoothstep(-0.03, 0.03, sky.sun.y);
  c.accent = (1.0 - smoothstep(0.016, 0.021, length(x.v.dir - sky.sun))) * up * (1.0 - heaven.cloud) * (1.0 - x.w.overcast);
#if WORLD_RAIN
  downsShaft = x.w.rain > 0.0 ? meadowShafts(meadowCx, downsAbove, x.tm, x.w.rain) : 0.0;
#else
  downsShaft = 0.0;
#endif
  downsShaftCol = x.air.fog * 0.8 + x.light.sun * 0.5 * pow(meadowToward, 4.0);
  if (downsAbove >= 0.13) c.col = mix(c.col, downsShaftCol, downsShaft);
}

// The hills, the mown M and the tree line, low over the horizon.
void downsFar(Ctx x, inout Cell c) {
  if (downsInSky && downsAbove < 0.13) c.col = meadowDistance(c.col, meadowCx, downsAbove, MEADOW_MARK_SHARE * x.aspect, x.air.haze, x.light.amb, downsSunLand, downsSunHills, meadowSunNear, x.gust, x.tm, x.aa, downsMist, x.air.fog, downsShaft, downsShaftCol, uWeather.y, c.accent);
}

// Golden haze: light scattered toward the eye around the sun, over everything beyond the front band.
void downsMiddleVeil(Ctx x, inout Cell c) {
  c.col += x.light.sun * (0.05 + 0.3 * K_haze) * exp(-5.0 * length(x.v.dir - x.w.sky.sun)) * (1.0 - x.w.overcast);
}
`;

/** The grass's GLSL: the sea of grass, the near grass and the curtains of heavy rain. */
export const grassGlsl = `
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
// log depth, and at row depth z it is the eye's height x (1 - z / zg) above the ground: where that height
// is below a blade's top, the blade can cover the cell. The cell walks those rows nearest first and
// stops once covered. Each blade is box-filtered across the cell (its half-width against the cell's
// width, both in ground units at the blade), and rows whose blades are under two cells apart give way
// to their average, which a golden veil of haze softens further toward the tree line. Leaning is a
// warp of the lookup, the same for every blade of a row at a given height, so blades bend without
// tearing; only blades several cells wide lean, and only a little. Lying snow (lying, uWeather.y)
// whitens the blades toward their tops and the ground between the stems.
//
// The loop is the scene's longest: (ln G / (G - tallest)) / MEADOW_ROW rows, 10 at the default grass
// height, 15 at the tallest, most of them cheap (no blade, or the cell already covered).
// Composed: the rows end where the backdrop's land does (x.landZ), stop behind anything standing
// nearer than the floor (zHit, what the cell shows), and grow only where the claims let covers grow
// (coverAllowed, by K_overgrowth in shared ones); the claims' shadows fall on them and the layers'
// lights light them. zs takes the field's depth where it covers the cell.
vec3 meadowGrass(Ctx x, vec3 behind, vec3 sun, vec4 breath, float hScale, inout float zHit, inout float zs, out float gHit) {
  vec2 uv = x.uv;
  float aspect = x.aspect;
  GustWind wind = x.gust;
  float tm = x.tm;
  float sunUp = x.w.sky.sun.y;
  float toward = meadowToward;
  vec3 amb = x.light.amb;
  vec3 haze = x.air.haze;
  float wet = uWeather.x;
  float lying = uWeather.y;
  float rainExt = x.air.rain;
  vec3 deck = x.air.deck;
  float overcast = x.w.overcast;
  float aa = x.aa;
  float eye = x.eye;
  bool moving = x.moving;
  float zg = eye * RIG_FOCAL / (RIG_HORIZON - uv.y);
  float a = (uv.x - 0.5) * aspect / RIG_FOCAL; // the ray's slope across: ground x = a z
  float pixel = aa / RIG_FOCAL;                // a cell's width as a slope
  // Nothing beyond a thing standing nearer than the floor this cell's ray meets.
  float zIn = zHit;
  float zStop = zIn < zg * 0.999 ? zIn : WORLD_FAR;
  float hMin = MEADOW_GRASS_MIN * hScale;
  float hMax = MEADOW_GRASS_MAX * hScale;
  float top = hMax + MEADOW_HEAD_LENGTH;
  float fill = MEADOW_FIELD_FILL + MEADOW_FIELD_FILL_SPAN * K_grassDensity;

  // The gust where the grass this cell sees stands: it presses the grass pale and leans it downwind;
  // the breath presses and parts it.
  float zv = min(zg, x.landZ) * (1.0 - 0.3 * (hMin + hMax) / eye);
  float across = zv * pixel;
  float deep = across * zv / eye;
  float g = gustAt(wind, vec2(a * zv, zv), tm, MEADOW_BLUR_CELLS * (abs(wind.dir.x) * across + wind.dir.y * deep));
  gHit = g;
  vec2 bq = (vec2(uv.x * aspect, uv.y) - vec2(breath.x * aspect, breath.y)) / MEADOW_BREATH_RADIUS;
  float puff = breath.z * exp(-dot(bq, bq));
  g += MEADOW_BREATH_FIELD * puff;
  float lean = clamp(wind.dir.x * MEADOW_FIELD_BEND * g + MEADOW_BREATH_LEAN * puff * sign(bq.x), -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX);
  float press = clamp(MEADOW_SHEEN * g, 0.0, 0.85);

  // Backlit by a low sun the grass glows, most of all in a broad swath below the sun; a higher sun
  // lights it from above instead.
  float low = 1.0 - meadowAbove;
  float high = clamp(sunUp, 0.0, 1.0);
  float glow = (0.22 + 0.6 * pow(toward, 3.0) + pow(toward, 24.0)) * low;
  // Under an overcast the whole deck lights the grass flatly, so its texture stays readable.
  sun *= 1.0 - casterShadow(vec2(a * zv, zv), x);
  vec3 lit = amb * 0.45 + sun * (0.7 * high + 0.6 * glow + MEADOW_ABOVE_LIT * meadowAbove) + deck * MEADOW_DECK_LIGHT * overcast + localLight(vec3(a * zv, 0.3, zv), vec3(0.0, 1.0, 0.0));
  vec3 pale = MEADOW_PALE * 0.62 * (amb * 0.5 + sun * (0.6 * high + 0.5 * glow + 0.12));
  vec3 gold = sun * MEADOW_RIM * (0.08 + 0.5 * glow) * (1.0 + max(g, 0.0));
  vec3 through = sun * MEADOW_SUNLIT * MEADOW_ABOVE_THROUGH * meadowAbove;
  float lift = MEADOW_ABOVE_SHADE * meadowAbove;
  vec3 bloomLit = amb * 0.6 + sun * (0.35 + 0.9 * glow + MEADOW_ABOVE_LIT * meadowAbove);
  // Wet grass is darker and richer, and its tops glisten: the bright sky in the water on them (a band
  // of light along the top of every row, over the dark wet depths), and the low sun once it is back.
  vec3 green = wetten(MEADOW_GREEN, wet, 0.5);
  vec3 straw = wetten(MEADOW_STRAW, wet, 0.5);
  vec3 seedCol = wetten(MEADOW_HEAD, wet, 0.7);
  gold += wetGloss(wet, MEADOW_TOP_UP) * (deck * MEADOW_WET_SHEEN + sun * (0.2 + 0.7 * glow));
  vec3 snowLit = MEADOW_SNOW * (amb * 1.4 + sun * (0.4 + 0.6 * high + 0.4 * glow));
  float snowTops = MEADOW_SNOW_TOPS * lying;

  // Patches: green and gone to straw; drifts of flowers, thickening far off into a band of colour
  // before the trees.
  vec2 ground = vec2(a * zv, zv);
  float ripe = smoothstep(0.3, 0.78, vnoise(ground * 0.045 + vec2(K_seed * 0.73, 2.1)));
  float drift = smoothstep(0.5, 0.8, vnoise(ground * vec2(0.035, 0.05) + vec2(5.3, K_seed * 0.31)));
  float flowerShare = MEADOW_FLOWER_SHARE * (0.25 + drift) * (0.4 + smoothstep(12.0, 60.0, zv));
  vec3 driftColour = meadowFlower(vnoise(ground * 0.02 + vec2(17.0, K_seed * 0.17)));

  float lg = log(zg);
  int first = max(int(floor((lg + log(1.0 - top / eye)) / MEADOW_ROW)), MEADOW_ROW_FIRST);
  int last = min(int(floor(lg / MEADOW_ROW)), int(floor(log(x.landZ) / MEADOW_ROW)));
  vec3 acc = vec3(0.0);
  float cover = 0.0;
  float zsum = 0.0;
  for (int j = first; j <= last; j++) {
    float lj = float(j) * MEADOW_ROW;
    float zj = exp(lj);
    if (zj > zStop) break;
    float allowed = coverAllowed(vec2(a * zj, zj), x.stretch, K_overgrowth);
    float rise = eye * (1.0 - zj / zg); // the ray's height above the ground over this row
    float tRow = clamp(rise / hMax, 0.0, 1.0);
    float px = zj * pixel;                         // a cell's size in ground units at this row
    // Far rows, whose blades stand under two cells apart, give way to their average.
    float lod = smoothstep(0.4, 0.9, px / MEADOW_BLADE_SPACING);
    float c = 0.0;
    vec3 premult = vec3(0.0);
    if (lod < 1.0) {
      // Lean only blades wide enough to move cleanly; the fine far ones hold still.
      float curl = MEADOW_FIELD_CURL * sin(a * zj * 1.7 + lj * 13.0);
      float sway = lean * smoothstep(MEADOW_LEAN_FROM, MEADOW_LEAN_TO, 2.0 * MEADOW_BLADE_WIDTH / px);
      float u = (a - (curl + sway) * MEADOW_BEND_SHAPE * hMax * tRow * tRow / zj) * zj / MEADOW_BLADE_SPACING;
      float k = floor(u);
      vec2 key = vec2(k, lj * 31.0 + K_seed * 0.53);
      if (hash12(key) < fill * allowed) {
        float h2 = hash12(key + 5.3);
        float h3 = hash12(key + 9.1);
        float h4 = hash12(key + 13.7);
        float jr = 0.9 * MEADOW_ROW * h2;
        float zr = zj * (1.0 + jr * (1.0 + 0.5 * jr)); // exp(jr): the root, jittered in depth
        float hb = mix(hMin, hMax, h3);
        float above = eye * (1.0 - zr / zg);  // the ray's height above this blade's root
        float t = above / hb;
        bool flower = h4 < flowerShare;
        bool stalk = !flower && h4 < flowerShare + MEADOW_FIELD_STALKS;
        float dw = abs(u - k - 0.5 - 0.2 * (h2 - 0.5)) * MEADOW_BLADE_SPACING * zr / zj; // across, at the blade
        float pw = zr * pixel;
        if (above >= 0.0 && t <= 1.0 + MEADOW_HEAD_LENGTH / hb) {
          float w = (stalk || flower) ? 0.35 * MEADOW_BLADE_WIDTH : MEADOW_BLADE_WIDTH * pow(max(1.0 - t, 0.0), 0.7);
          c = t <= 1.0 ? clamp(min(dw + w, 0.5 * pw) - max(dw - w, -0.5 * pw), 0.0, pw) / pw : 0.0;
          float dry = clamp(ripe + h3 - 0.5, 0.0, 1.0);
          vec3 albedo = mix(green, straw, dry);
          float up = sqrt(clamp(t, 0.0, 1.0));
          vec3 blade = albedo * lit * (mix(0.35, 1.0, up) + lift * (1.0 - up)) + through * (1.0 - dry) * up;
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
              blade = meadowFlower(fract(h2 * 7.31)) * bloomLit;
            }
          } else if (stalk) {
            float e = length(vec2(2.0 * hq / MEADOW_HEAD_LENGTH - 1.0, dw / MEADOW_HEAD_WIDTH));
            float girth = max(MEADOW_HEAD_WIDTH, 0.5 * pw);
            float head = clamp((1.0 - e) * girth / pw + 0.5, 0.0, 1.0) * (MEADOW_HEAD_WIDTH / girth);
            if (head > c) {
              c = head;
              blade = mix(seedCol * lit, pale, 0.6 * press) + gold;
            }
          }
          blade = mix(blade, snowLit, snowTops * smoothstep(0.3, 1.0, t));
          // Moving (the camera, not only the wind), a blade's edge is cut per cell.
          if (moving) c = hardEdge(c);
          premult = c * blade;
        }
      }
    }
    if (lod > 0.0) {
      // The row's average: its blades' share of the cell at this height, an average blade's colour,
      // and the flowers in bloom at their tops.
      float t = rise / (0.5 * (hMin + hMax));
      // Heights vary from blade to blade, so on average a row thins out smoothly toward its tops.
      float share = fill * allowed * 1.4 * MEADOW_BLADE_WIDTH * (1.0 - smoothstep(0.0, 1.25, t)) / MEADOW_BLADE_SPACING;
      share += fill * allowed * flowerShare * smoothstep(0.75, 1.05, t) * (1.0 - smoothstep(1.05, 1.2, t));
      vec3 blade = green + (straw - green) * ripe;
      float up = sqrt(clamp(t, 0.0, 1.0));
      blade = blade * lit * (mix(0.35, 1.0, up) + lift * (1.0 - up)) + through * (1.0 - ripe) * up;
      blade = mix(blade, pale, press * (0.35 + 0.65 * t)) + gold * smoothstep(0.5, 1.0, tRow);
      blade = mix(blade, driftColour * bloomLit, flowerShare * 2.5 * smoothstep(0.75, 1.0, t));
      blade = mix(blade, snowLit, snowTops * smoothstep(0.3, 1.0, t));
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
  float hazeDensity = x.air.dust + rainExt;
  float veil = MEADOW_VEIL + x.air.veil;
  vec3 veilCol = haze + sun * MEADOW_VEIL_GOLD * (0.5 + 0.5 * toward);
  float zf = cover > 0.0 ? zsum / cover : zg;
  acc = mix(acc * rebound, veilCol * cover, 1.0 - exp(-hazeDensity * zf) * (1.0 - veil * smoothstep(MEADOW_VEIL_NEAR, MEADOW_VEIL_FAR, zf)));
  zHit = mix(min(min(zg, x.landZ), zIn), zf, cover);
  if (cover > 0.5) zs = min(zs, zf);
  if (zg < x.landZ && zIn >= zg * 0.999) {
    // Between the stems: the shaded depths of the grass, lighter where a gust opens it to the sky;
    // the floor shows through where the claims keep the grass off it.
    vec3 floorCol = mix(green, straw, ripe) * (amb * 0.22 + sun * (0.15 * glow + MEADOW_ABOVE_FLOOR * meadowAbove)) * (1.0 + 0.8 * max(g, 0.0)) * rebound;
    floorCol = mix(floorCol, snowLit * 0.6, lying);
    vec3 ground = mix(floorCol, veilCol, 1.0 - exp(-hazeDensity * zg) * (1.0 - veil * smoothstep(MEADOW_VEIL_NEAR, MEADOW_VEIL_FAR, zg)));
    float open = coverAllowed(vec2(a * zg, zg), x.stretch, K_overgrowth);
    behind = open >= 1.0 ? ground : mix(behind, ground, open);
  }
  return acc + (1.0 - cover) * behind;
}

// ---- the near grass ----
// One layer of blades and flowering stalks rooted below the frame, bent as the simulation bends
// their column (grassField0: lean, bow away from the viewer). Tall at the sides and short in the middle,
// they frame the view; dark against the light, glowing through where they are thin and along their
// edges, paler as a gust bows them away.
// The stalks are a meadow edge, not a fence: they stand in clumps with gaps between, each at its own
// place in its column, leaning and curving its own way (a static lean and curve on top of the
// column's sway), two to four cells thick at the root and thinning to the top, cut hard per cell. A
// stalk carries a panicle (a rachis hung with fine spikelets), a plain ear of seeds, or nothing.
// Lying snow (lying, uWeather.y) clings along their upper half.
void meadowLayer(int layer, vec2 p, float aspect, float stretch, float hScale, float density, vec3 amb, vec3 sun, float behind, float sunNear, float sunX, float wet, float lying, vec3 deck, float aa, bool moving, inout vec3 col, inout float accent, inout float zHit) {
  float yy = p.y - MEADOW_ROOT[layer];
  if (yy <= 0.0) return;
  float pitch = MEADOW_PITCH[layer];
  float hMin = MEADOW_HMIN[layer] * hScale;
  float hMax = MEADOW_HMAX[layer] * hScale;
  float spike = MEADOW_SPIKE[layer] * hScale;
  float spikeMax = spike * MEADOW_HEAD_MAX;
  float low = MEADOW_LOW[layer];
  // A leaning stalk's head can stray further than the layer's own padding allows for.
  float pad = MEADOW_PAD[layer] + 0.6 * spike;
  // The tallest blade that could reach this cell grows from the root furthest toward the frame's
  // side within reach; above it there is nothing of this layer.
  float reach0 = MEADOW_REACH * yy + pad;
  float side = smoothstep(0.15, 0.75, abs(p.x / aspect - 0.5) * 2.0 + 2.0 * reach0 / aspect);
  float tallest = hMax * mix(low, 1.0, side);
  if (yy > tallest + spikeMax) return;
  float girth = MEADOW_WIDTH[layer];
  float spikeGirth = MEADOW_SPIKE_WIDTH[layer];
  // Stalks of the layers further off are thinner, as their blades are.
  float stalkScale = clamp(girth / MEADOW_WIDTH[0], 0.6, 1.0);
  int columns = textureSize(grassField0, 0).x;
  bool bent = grassField0On();
  // A blade's centreline strays at most MEADOW_REACH x its height above the roots (sim.ts), so only
  // the columns that close can reach this cell: a few near the roots and in the middle of the frame,
  // up to ~25 at the tips of the tall blades at the sides. With the sea of grass these are the
  // scene's longest loops; together over 32 only in a band of the lower frame.
  // Wet seed heads drip: then a stalk can also reach this cell from a head up to five drip spacings
  // above it (~2-3 more columns each side).
  float dripWidth = MEADOW_DRIP_CELLS * aa;
  float yr = min(yy + (wet > 0.0 ? 5.0 * dripWidth : 0.0), tallest + spikeMax);
  int reach = min(int(ceil((MEADOW_REACH * yr + pad) / pitch)), MEADOW_MARGIN);
  float column = floor(p.x / pitch);
  float salt = float(layer) * 57.0 + K_seed * 1.37;
  float layerZ = MEADOW_LAYER_Z[layer];
  // Wet, the blades darken and their lit side glistens; a bead of water holds the sky and the sun.
  vec3 leaf = wetten(MEADOW_LEAF, wet, 0.45);
  vec3 stem = wetten(MEADOW_STEM, wet, 0.45);
  vec3 seedCol = wetten(MEADOW_HEAD, wet, 0.7);
  float gloss = wetGloss(wet, 0.3);
  vec3 bead = deck * MEADOW_DROP_SKY + amb * 0.3 + sun * (0.4 + 2.0 * behind + sunNear);
  // A column holds a stalk where its hash falls under a share the clumps raise (a slow noise over the
  // columns: more stalks in some stretches, fewer in the gaps between). The share never leaves these
  // bounds, so only a hash between them needs the noise. A lattice cell of either octave of the noise
  // spans one to five columns: their lattice values are carried from column to column, and a cell is
  // hashed only as the columns reach it (clumpCellA, B: the cells held, none yet).
  float stalksFew = min(MEADOW_STALKS[layer] * MEADOW_CLUMP_GAP, 0.9);
  float stalksMany = min(MEADOW_STALKS[layer] * (MEADOW_CLUMP_GAP + MEADOW_CLUMP_GAIN), 0.9);
  float clumpCellA = -1.0e9;
  float clumpCellB = -1.0e9;
  vec4 clumpA = vec4(0.0);
  vec4 clumpB = vec4(0.0);
  // A column's hashes are drawn only where they can change this cell: a stalk's only for a stalk, the
  // blade's shape only below its top, its colour only where it covers the cell, its head's near it.
  for (int k = -reach; k <= reach; k++) {
    float i = column + float(k);
    vec2 key = vec2(i, salt);
    // Anywhere in its column, so neighbours crowd together or leave gaps.
    float x0 = (i + hash12(key + 3.1)) * pitch;
    float edge = smoothstep(0.15, 0.75, abs(x0 / aspect - 0.5) * 2.0);
    // None where a claim keeps covers off the ground under its root (composer: coverAllowed).
    if (hash12(key) > density * mix(MEADOW_CENTRE[layer], 1.0, edge) * coverAllowed(vec2((x0 - 0.5 * aspect) * layerZ / RIG_FOCAL, layerZ), stretch, K_overgrowth)) continue;
    float stalkH = hash12(key + 11.3);
    bool stalk = stalkH < stalksFew;
    if (!stalk && stalkH < stalksMany) {
      vec2 pa = vec2(i * MEADOW_CLUMP_SCALE, salt);
      vec2 pb = vec2(i * MEADOW_CLUMP_SCALE * 3.7 + 9.1, salt);
      vec2 ia = floor(pa);
      vec2 ib = floor(pb);
      if (ia.x == clumpCellA + 1.0) clumpA = vnoiseLatticeNext(clumpA, ia);
      else if (ia.x != clumpCellA) clumpA = vnoiseLattice(ia);
      if (ib.x == clumpCellB + 1.0) clumpB = vnoiseLatticeNext(clumpB, ib);
      else if (ib.x != clumpCellB) clumpB = vnoiseLattice(ib);
      clumpCellA = ia.x;
      clumpCellB = ib.x;
      float clump = smoothstep(0.4, 0.68, 0.65 * vnoiseFrom(clumpA, fract(pa)) + 0.35 * vnoiseFrom(clumpB, fract(pb)));
      stalk = stalkH < min(MEADOW_STALKS[layer] * (MEADOW_CLUMP_GAP + MEADOW_CLUMP_GAIN * clump), 0.9);
    }
    float hHeight = hash12(key + 7.7);
    float h = mix(hMin, hMax, stalk ? sqrt(hHeight) : hHeight) * mix(low, 1.0, edge);
    // What the stalk carries: nothing (0), a panicle (1) or a plain ear (2), and how long it is.
    int kind = 0;
    float headLen = 0.0;
    if (stalk) {
      float kindH = hash12(key + 53.9);
      kind = kindH < MEADOW_BARE_SHARE ? 0 : (kindH < MEADOW_BARE_SHARE + MEADOW_EAR_SHARE ? 2 : 1);
      float lenH = hash12(key + 47.3);
      headLen = kind == 0 ? 0.0 : spike * (kind == 1 ? 0.9 + 0.5 * lenH : 0.6 + 0.4 * lenH);
    }
    vec2 bend = bent ? texelFetch(grassField0, ivec2(clamp(int(i) + MEADOW_MARGIN, 0, columns - 1), layer), 0).rg : vec2(0.0);
    float bow = clamp(bend.y + MEADOW_WET_BOW * wet, -0.2, MEADOW_AWAY_MAX);
    float tall = h * (1.0 - MEADOW_BOW * bow);
    float s = yy / tall;
    if (s > 1.0 + headLen / tall) continue;
    float leanH = hash12(key + 17.9);
    float lean = clamp(MEADOW_CURL * (leanH - 0.5) + (stalk ? MEADOW_STALK_LEAN * 2.0 * (hash12(key + 59.3) - 0.5) : 0.0) + bend.x, -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX);
    // The centreline: offset tip x (s^curve); curve 2 is the blades' own bow, a stalk's runs from a
    // quick lean near the root to a late bend near the head.
    float curve = stalk ? mix(MEADOW_STALK_CURVE_MIN, MEADOW_STALK_CURVE_MAX, hash12(key + 41.9)) : 2.0;
    float tip = MEADOW_BEND_SHAPE * lean * h;
    float sc = min(s, 1.0);
    float slope = curve * tip * pow(sc, curve - 1.0) / tall;
    float across = (p.x - x0 - tip * pow(sc, curve)) * inversesqrt(1.0 + slope * slope); // signed, + to the right
    float d = abs(across);
    // A stalk is two to four cells thick at the root, thinning to the head; blades taper to a point.
    float w = stalk ? max(aa * (MEADOW_STALK_CELLS + MEADOW_STALK_CELLS_SPAN * hash12(key + 37.1)) * stalkScale * mix(1.0, MEADOW_STALK_TIP, pow(sc, 0.8)), MEADOW_STALK_MIN * aa) : girth * pow(max(1.0 - s, 0.0), 0.6);
    float soft = stalk ? 0.5 * aa : aa;
    float cover = s <= 1.0 ? 1.0 - smoothstep(w - soft, w + soft, d) : 0.0;
    // Stalks are cut per cell, so a swaying edge changes one cell at a time, once.
    if (stalk || moving) cover = hardEdge(cover);
    float pressed = clamp(bend.y, 0.0, 1.0); // bowed by the wind (not the rain) shows the light through it
    if (cover > 0.0) {
      // The backlit edge on the side facing the sun only, fading across the blade: as a blade sways,
      // a cell sees one soft change of light, not a thin bright line passing.
      float facing = clamp(across * sign(sunX - p.x) / max(w, aa), 0.0, 1.0);
      float rim = facing * facing * cover;
      vec3 body = stalk ? stem * mix(vec3(0.75), vec3(1.4, 1.2, 0.8), hash12(key + 61.1)) : leaf;
      vec3 shade = body * (amb * 0.3 + sun * (0.1 + 0.55 * behind + MEADOW_ABOVE_NEAR * meadowAbove)) * MEADOW_SHADE[layer];
      if (!stalk) shade += sun * MEADOW_SUNLIT * MEADOW_ABOVE_THROUGH * meadowAbove * MEADOW_SHADE[layer];
      shade += sun * MEADOW_THROUGH * pressed * (0.45 + behind) * 0.9;
      shade += sun * MEADOW_RIM * rim * (MEADOW_RIM_BASE + 1.1 * behind + 0.6 * sunNear);
      shade += gloss * (deck * 0.4 + sun * (0.15 + 0.8 * behind)) * facing;
      shade = mix(shade, MEADOW_SNOW * (amb * 1.0 + sun * (0.25 + 0.6 * behind)), MEADOW_SNOW_NEAR * lying * smoothstep(0.4, 1.0, s));
      col = mix(col, shade, cover);
      accent *= 1.0 - cover;
      zHit = mix(zHit, layerZ, cover);
      if (wet > 0.0 && s < 0.95) {
        // Beads of rain caught along the blade, more as it gets wetter, fixed to it as it sways.
        float n = floor(s * MEADOW_BEADS);
        float hb = hash12(key + vec2(n * 1.7, 29.3));
        if (hb < wet * MEADOW_BEAD_SHARE) {
          float sb = (n + 0.3 + 0.4 * fract(hb * 13.1)) / MEADOW_BEADS;
          float rb = max(0.55 * (stalk ? w : girth * pow(max(1.0 - sb, 0.0), 0.6)), 1.3 * aa);
          vec2 bv = vec2(across - (fract(hb * 7.3) - 0.5) * w, (s - sb) * tall);
          float drop = (1.0 - smoothstep(rb - aa, rb + aa, length(bv))) * min(1.0, 2.0 * cover);
          col = mix(col, bead, 0.85 * drop);
        }
      }
    }
    if (kind > 0) {
      // The head, nodding on along the stalk's tip; heavy with rain it droops toward the side the
      // stalk leans, glistens, and drips from its end.
      vec2 base = vec2(x0 + tip, MEADOW_ROOT[layer] + tall);
      vec2 q = p - base;
      float reachHead = headLen + 3.0 * spikeGirth + 2.0 * aa;
      bool headNear = dot(q, q) < reachHead * reachHead;
      if (headNear || wet > 0.0) {
        float nodSide = leanH < 0.5 ? -1.0 : 1.0;
        vec2 axis = rotate(normalize(vec2(curve * tip / tall, 1.0)), -nodSide * MEADOW_WET_NOD * wet);
        float head = 0.0;
        float e = 1.0; // 0 along the head's axis, 1 at its rim
        if (headNear) {
          float u = dot(q, axis);
          float v = dot(q, vec2(axis.y, -axis.x));
          if (kind == 2) {
            // A plain ear: a dense ellipse of seeds.
            float girthEar = spikeGirth * (0.8 + 0.5 * hash12(key + 43.3));
            e = length(vec2(2.0 * u / headLen - 1.0, v / girthEar));
            head = 1.0 - smoothstep(1.0 - 0.5 * aa / girthEar, 1.0 + 0.5 * aa / girthEar, e);
          } else {
            // A panicle: a rachis arching to one side, a spikelet hung from it every few cells,
            // alternating sides, longest in the middle.
            float spikelets = clamp(floor(headLen / (MEADOW_SPIKELET_CELLS * aa)), 3.0, 8.0);
            float gapU = headLen / spikelets;
            float arch = (hash12(key + 67.3) < 0.5 ? -1.0 : 1.0) * 0.22 * headLen;
            float ut = clamp(u / headLen, 0.0, 1.0);
            float wv = v - arch * ut * ut;
            float rachis = length(vec2(u - clamp(u, 0.0, headLen), wv));
            float dist = 1e3;
            float n1 = floor(u / gapU - 0.5);
            for (int dn = 0; dn < 2; dn++) {
              float n = n1 - float(dn);
              if (n < 0.0 || n >= spikelets) continue;
              float fr = (n + 0.5) / spikelets;
              float hn = hash12(key + vec2(n * 1.3, 71.7));
              float sgn = mod(n, 2.0) < 0.5 ? 1.0 : -1.0;
              float lat = MEADOW_PANICLE_WIDTH * spikeGirth * (0.35 + 0.65 * sin(0.5 * TAU * fr)) * (0.8 + 0.4 * hn);
              vec2 a = vec2(fr * headLen, arch * fr * fr);
              vec2 b = a + vec2(gapU * (0.9 + 0.5 * hn), sgn * lat);
              dist = min(dist, segmentDistance(vec2(u, v), a, b));
            }
            float r = 0.7 * aa;
            head = 1.0 - smoothstep(r - 0.5 * aa, r + 0.5 * aa, min(rachis, dist));
            e = clamp(abs(wv) / (MEADOW_PANICLE_WIDTH * spikeGirth), 0.0, 1.0);
          }
          head = hardEdge(head);
        }
        if (head > 0.0) {
          vec3 seeds = seedCol * mix(0.7, 1.3, hash12(key + 73.1)) * (amb * 0.35 + sun * (0.2 + 0.9 * behind + 0.4 * pressed + MEADOW_ABOVE_NEAR * meadowAbove));
          seeds += sun * MEADOW_RIM * smoothstep(0.2, 1.0, e) * (MEADOW_RIM_BASE + 1.6 * behind + sunNear);
          seeds += gloss * (deck * 0.5 + sun * (0.2 + behind)) * smoothstep(0.3, 1.0, e);
          col = mix(col, seeds, head);
          accent *= 1.0 - head;
          zHit = mix(zHit, layerZ, head);
        }
        if (wet > 0.0) {
          vec2 end = base + axis * headLen;
          vec2 below = vec2(p.x - end.x, end.y - p.y);
          if (below.y > 0.0 && below.y < 5.0 * dripWidth && abs(below.x) < 0.5 * dripWidth) {
            // Each head drips from a lane of its own (so on its own clock), placed on that lane's drip
            // point (weather.ts: lane k drips at (k + 0.3 + 0.4 hash12(k, 3.7)) x width), while it is wet.
            float lane = floor(hash12(key + 23.1) * 256.0);
            float dripAt = (lane + 0.3 + 0.4 * hash12(vec2(lane, 3.7))) * dripWidth;
            float drip = rainDrips(vec2(below.x + dripAt, below.y), uFallTime, max(K_rain, 0.4 * wet), dripWidth);
            col = mix(col, bead, drip);
          }
        }
      }
    }
  }
}

// ---- the grass layer's passes ----
// Per cell: the breath (the grass's record), its height, the field's sag when wet, the sun on the
// land this cell sees (out to where the backdrop's land ends, x.landZ), and the gust the field's
// grass there takes (meadowGrass), for the curtains of heavy rain.
vec4 grassBreath;
float grassHScale;
float grassFieldScale;
vec3 grassSunLand;
float grassGust;

void grassBegin(Ctx x) {
  grassBreath = grassSimOn() ? grassRecord(0, 0) : vec4(0.0);
  grassHScale = MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN * K_grassHeight;
  // Soaked, the sea of grass sags a little under the water on it.
  grassFieldScale = grassHScale * (1.0 - MEADOW_WET_SAG * uWeather.x);
  float zLand = x.uv.y < RIG_HORIZON ? min(x.eye * RIG_FOCAL / (RIG_HORIZON - x.uv.y), x.landZ) : x.landZ;
  grassSunLand = x.light.sun * worldSunlit(x.w, x.v, vec3(meadowCx * zLand / RIG_FOCAL, -x.eye, zLand));
  grassGust = 0.0;
}

// The sea of grass, below the horizon, over what the cell shows (the floor gives way to it, a thing
// standing nearer hides the rows behind it).
void grassMiddle(Ctx x, inout Cell c) {
  if (x.uv.y < RIG_HORIZON) c.col = meadowGrass(x, c.col, grassSunLand, grassBreath, grassFieldScale, c.z, c.zs, grassGust);
}

// Heavy rain: the gusts drive curtains of it across the field and the sky, with the honami bands:
// below the horizon by the gust on the grass the cell sees, above it by the gust over the field's
// far edge.
void grassMiddleVeil(Ctx x, inout Cell c) {
#if WORLD_RAIN || WORLD_SNOW
  float heavy = x.w.heavy;
  if (heavy <= 0.0) return;
  float gHit = grassGust;
  if (x.uv.y >= RIG_HORIZON) {
    float zc = x.landZ * (1.0 - 0.3 * (MEADOW_GRASS_MIN + MEADOW_GRASS_MAX) * grassFieldScale / x.eye);
    float span = zc * x.aa / RIG_FOCAL;
    gHit = gustAt(x.gust, vec2(meadowCx * zc / RIG_FOCAL, zc), x.tm, MEADOW_BLUR_CELLS * (abs(x.gust.dir.x) * span + x.gust.dir.y * span * zc / x.eye));
  }
  float curtain = heavy * smoothstep(MEADOW_CURTAIN_FROM, MEADOW_CURTAIN_TO, gHit);
  c.col = mix(c.col, x.air.fog, MEADOW_CURTAIN * curtain);
#endif
}

// The near grass, lowered in the frame by the rig's lift over rest: the nearer the layer, the more.
// Layer 1 stands in the front band before the dandelions; layer 0, the nearest, over them.
void grassNear(int layer, Ctx x, inout Cell c) {
  float z = c.z;
  float density = MEADOW_DENSITY_MIN + (1.0 - MEADOW_DENSITY_MIN) * K_grassDensity;
  meadowLayer(layer, meadowP + vec2(0.0, RIG_FOCAL * x.lift / MEADOW_LAYER_Z[layer]), x.aspect, x.stretch, grassHScale, density, x.light.amb, meadowSunHere, meadowBehind, meadowSunNear, meadowSunX, uWeather.x, uWeather.y, x.air.deck, x.aa, x.moving, c.col, c.accent, c.z);
  if (c.z < z) c.zs = min(c.zs, c.z);
}

void grassFront(Ctx x, inout Cell c) {
  grassNear(1, x, c);
}

void grassFrontVeil(Ctx x, inout Cell c) {
  grassNear(0, x, c);
}
`;

/** The dandelions' GLSL: the clocks and the seeds in the air (dandelionsFront). */
export const dandelionsGlsl = `
// ---- the dandelion clocks ----
// The share of seeds left on clock c toward angle a, blended between the sim's sectors.
float meadowSectorFill(int c, float a) {
  float u = fract(a / TAU) * float(MEADOW_SECTORS) - 0.5;
  float i0 = floor(u);
  float sectors = float(MEADOW_SECTORS);
  int s0 = int(mod(i0 + sectors, sectors));
  int s1 = int(mod(i0 + 1.0, sectors));
  return mix(dandelionsRecord(2 + s0, MEADOW_CLOCK_ROW + c).r, dandelionsRecord(2 + s1, MEADOW_CLOCK_ROW + c).r, smoothstep(0.0, 1.0, u - i0));
}

// Each clock on a stalk that thins toward the head: a closed bud that opens into a sphere of seeds.
// The head is a starburst: from the knob each seed's fine beak runs out to a fan of pappus, the fans'
// ragged outer ends making the rim, brightest when the sun is behind; between them the head is open,
// with only a faint veil of the seeds pointing toward and away from us. A spoke stays while its part
// of the head still holds seeds, so the gusts and the breath bite gaps into the rim.
void meadowClocks(vec2 p, float aspect, vec3 amb, vec3 sun, float behind, float sunNear, float wet, float aa, bool moving, inout vec3 col, inout float accent, inout float zHit) {
  if (!dandelionsSimOn()) return;
  for (int c = 0; c < MEADOW_MAX_CLOCKS; c++) {
    vec4 shape = dandelionsRecord(1, MEADOW_CLOCK_ROW + c); // radius, presence, open, fullness
    float presence = shape.y;
    if (presence < 0.004) continue;
    vec4 at = dandelionsRecord(0, MEADOW_CLOCK_ROW + c);    // root uv, head uv
    vec2 root = vec2(at.x * aspect, at.y);
    vec2 head = vec2(at.z * aspect, at.w);
    float R = shape.x;
    float reach = 1.6 * R;
    if (p.y < root.y || p.y > head.y + reach || p.x < min(root.x, head.x) - reach || p.x > max(root.x, head.x) + reach) continue;
    float open = shape.z;
    float fullness = shape.w;
    float cf = float(c);
    vec4 extra = dandelionsRecord(2, MEADOW_CLOCK_ROW + c); // g: depth (world units), b: closed against the rain
    float cz = extra.g;
    float closed = extra.b;

    // The stalk: the sim's bend curve from the root up to the head, thinning as it goes.
    float tall = head.y - root.y;
    float s = clamp((p.y - root.y) / tall, 0.0, 1.0);
    float dx = head.x - root.x;
    float slope = 2.0 * dx * s / tall;
    float d = abs(p.x - root.x - dx * s * s) * inversesqrt(1.0 + slope * slope);
    float w = max(mix(MEADOW_STALK_BASE, MEADOW_STALK_TOP, s), 0.75 * aa);
    float stalk = (1.0 - smoothstep(w - aa, w + aa, d)) * step(p.y, head.y) * presence;
    if (moving) stalk = hardEdge(stalk);
    float rim = smoothstep(w - 1.4 * aa, w, d);
    vec3 stalkCol = MEADOW_STALK * (amb * 0.35 + sun * (0.15 + 0.5 * behind)) + sun * MEADOW_RIM * rim * (0.3 + 1.2 * behind + 0.5 * sunNear);
    col = mix(col, stalkCol, stalk);
    accent *= 1.0 - stalk;
    zHit = mix(zHit, cz, stalk);

    vec2 q = p - head;
    // Closed against the rain, the seeds fold up into a narrow brush.
    vec2 qf = vec2(q.x / (1.0 - MEADOW_FOLD * closed), q.y);
    float r = length(qf);
    // The closed bud: bracts drawn to a point, giving way as the clock opens.
    float bud = 1.0 - smoothstep(0.05, 0.6, open);
    if (bud > 0.0) {
      vec2 bq = q / R - vec2(0.0, 0.12);
      float e = length(vec2(bq.x / (0.24 * (1.0 - 0.6 * clamp(bq.y / 0.45, 0.0, 1.0))), bq.y / 0.45));
      float budCover = (1.0 - smoothstep(1.0 - 2.5 * aa / R, 1.0, e)) * bud * presence;
      if (moving) budCover = hardEdge(budCover);
      vec3 bract = MEADOW_BRACT * (amb * 0.4 + sun * (0.15 + 0.6 * behind)) + sun * MEADOW_RIM * smoothstep(0.6, 1.0, e) * (0.25 + behind);
      col = mix(col, bract, budCover);
      accent *= 1.0 - budCover;
    }

    // The knob the seeds sit on: dark with seeds, pale once bare.
    float knob = (1.0 - smoothstep(MEADOW_KNOB - aa / R, MEADOW_KNOB + aa / R, r / R)) * smoothstep(0.3, 0.7, open) * presence;
    if (moving) knob = hardEdge(knob);
    col = mix(col, mix(MEADOW_ACHENE, MEADOW_RECEPTACLE, 1.0 - fullness) * (amb * 0.4 + sun * (0.2 + 0.6 * behind)), knob);

    float shown = smoothstep(0.0, 1.0, open);
    float Rs = R * mix(0.3, 1.0, shown);
    float rr = r / Rs;
    if (rr < 1.6 && shown > 0.0) {
      // Against the glare (a backdrop this bright) the fluff would be lost: its body darkens there,
      // as a backlit head is seen against the sun, so the starburst reads as a pale fan over a dim disc.
      float glare = smoothstep(MEADOW_GLARE_FROM, MEADOW_GLARE_TO, dot(col, LUMA));
      col *= 1.0 - MEADOW_GLARE_DARK * glare * (1.0 - smoothstep(0.45, 1.05, rr)) * shown * presence;
      // Counted on the full head, so the starburst does not jump as the clock opens.
      float spokes = clamp(floor(TAU * R / (MEADOW_SPOKE_CELLS * aa)), 10.0, 32.0);
      float u = fract(atan(qf.y, qf.x) / TAU) * spokes;
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
      if (moving) fluff = hardEdge(fluff);
      float edgeGlow = smoothstep(0.7, 0.92, rr) * tuft * present;
      vec3 pappus = wetten(MEADOW_PAPPUS, wet, 0.3) * (amb * 0.5 + sun * (0.3 + 1.6 * behind + 0.9 * sunNear)) + sun * MEADOW_RIM * edgeGlow * (0.35 + 1.4 * behind + 0.8 * sunNear);
      col = mix(col, pappus, fluff);
      // A halo of light scattered by the fluff when the sun is behind it.
      float halo = smoothstep(0.75, 1.0, rr) * exp(-5.0 * max(rr - 1.0, 0.0)) * (1.0 - smoothstep(1.3, 1.6, rr));
      col += sun * 0.3 * halo * fullness * shown * presence * (behind + sunNear);
      accent = max(accent * (1.0 - fluff), fluff);
      zHit = mix(zHit, cz, fluff);
    }
  }
}

// ---- the seeds in the air ----
// Little parachutes: a soft tuft of bristles catching the light, the beak hanging under it with the
// seed at its end (once they are big enough to show it crisply), tilted as they drift. The sim sorts
// them by x in groups of eight, each with a bounding box, so a cell only looks at the groups near it.
void meadowSeeds(vec2 uv, vec2 p, float aspect, vec3 amb, vec3 sun, float behind, float sunNear, float aa, inout vec3 col, inout float accent) {
  if (!dandelionsSimOn()) return;
  vec3 lit = amb * 0.55 + sun * (0.35 + 2.0 * behind + sunNear);
  for (int g = 0; g < MEADOW_SEED_GROUPS; g++) {
    vec4 box = dandelionsRecord(g, 2);
    if (uv.x < box.x || uv.x > box.z || uv.y < box.y || uv.y > box.w) continue;
    for (int j = 0; j < MEADOW_SEED_GROUP; j++) {
      int i = g * MEADOW_SEED_GROUP + j;
      vec4 a = dandelionsRecord(i, 0); // uv xy, pappus radius, alpha
      if (a.w < 0.004) continue;
      float r = a.z;
      vec2 q = p - vec2(a.x * aspect, a.y);
      if (dot(q, q) > 9.0 * r * r) continue;
      vec4 b = dandelionsRecord(i, 1); // tilt, depth, squash
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

// The dandelions' front pass: the clocks over what lies behind them, then the seeds in the air,
// lowered with the rig through the meadow's passage (as the near grass is).
void dandelionsFront(Ctx x, inout Cell c) {
  float z = c.z;
  meadowClocks(meadowP, x.aspect, x.light.amb, meadowSunHere, meadowBehind, meadowSunNear, uWeather.x, x.aa, x.moving, c.col, c.accent, c.z);
  meadowSeeds(x.uv, meadowP, x.aspect, x.light.amb, meadowSunHere, meadowBehind, meadowSunNear, x.aa, c.col, c.accent);
  if (c.z < z) c.zs = min(c.zs, c.z);
}
`;
