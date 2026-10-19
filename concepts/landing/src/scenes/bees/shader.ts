// The Bees preset's layers' GLSL (ADR 0062 Phase 1; the composer: src/composer, README "Composers"):
// a summer hillside, painted, seen from eye level in the low light of a warm afternoon through the
// garden's rig (constants.ts BEES_RIG: horizon BEES_YH, focal 1, the eye BEES_CAM up, RIG_* in the
// program). Its parts, each a layer, drawn in the order the garden always painted them:
//   hillside  (backdrop) rolling layered hills (patchwork fields, hedgerows, tree clumps, a farmhouse,
//             a windmill on a crest) under the World's sky with its towering cumulus; the valley's
//             air (haze, the fog's and the rain's colour, the drops' light) and the golden haze the
//             low sun scatters; the land ends at the garden's far edge (x.groundTo, x.landZ).
//   lawn      (ground) the grass with its clover and windfalls, the hedge along the garden's far
//             edge, the path up to the gate, the blades at the lens (LAWN_BLADES, suppressed by a
//             cover that brings its own) and the wet lawn's sheen.
//   apiary    (dressing, the subject) the flower drifts (lavender rows, poppies, daisies, wild
//             flowers, cosmos), the old orchard behind a dry-stone wall with its gate and fence, three
//             pastel box hives drawn 1.5 times life size so their entrances read, the lantern among
//             them and the fairy lights along the wall, the near foxgloves and blooms; the things
//             standing in the wet garden take a sheen.
//   insects   (life) the specks of the simulation (sim.ts) in the shared speck map, lit by the light
//             where they are drawn.
//   gardening (chore) the beds the cast's agents dig and sow on the lawn (beds.ts, gardening.ts):
//             turned soil, seedlings growing into poppies, daisies, cosmos and wild flowers, the
//             weeds creeping back; compiled in only while the cast has agents (PRINCIPAL_CURSORS).
// The garden is a ground plane in perspective: a metre at row y is beesS(y) screen heights, and a point
// of the picture has ground coordinates w = (X, Z) in metres. Places on the stage are fractions of its
// half width (layout.ts), which spreads across a wider frame (the apiary's claims stretch with it).
// Flower drifts are irregular scatters of blooms of every size, set in rows a step apart in log depth
// with their positions jittered, thinned toward the edge of a drift and clumped by noise; lavender is
// rounded bushes in perspective rows. The sun stands behind the scene to the left, so the trees and
// the hives throw long soft shadows across the grass toward the viewer (the composer's casterShadow:
// the hives' from their claims, the crowns' from apiaryCrowns), dappled under the crowns, and clouds
// throw theirs over the land (`beesLit`). All of them are switched per cell against the dither, so a
// passing edge flips each cell once. Wind runs through the grass as the composer's one gust field
// (gustAt, ADR 0062 D4), the wind every other layer moves in: its fronts roll across the lawn as
// swells of paler light, and the drifts' leaves, the lavender and the blooms sway in them.
//
// The sky, the weather, the light and the birds are the World's and the composer's (the light graded
// by BEES_GRADE: the moon is the key once the sun has set, so a moonlit night reads on the land). Rain
// wets the garden (uWeather.x, which lingers after it: darker, richer, glistening); snow settles
// (uWeather.y, which melts after it) on the grass and the path, the hills, the lavender, the wall's
// top, the hives' roofs and the crowns.
//
// The apiary's own parts, each compiled in only while its knob can show it (layers.ts featuresFor):
// the flowers knob thins the drifts (beesThin) down to bare grass at 0, or past 1 grows them lusher
// (beesLush: wider, more of their blooms open and from BEES_LUSH_FROM a second set between them, the
// lavender's rows longer and plumper) and from 2 runs their near sides down the slope to the lens
// (beesReach, beesDriftQ), keeping them off the path; each near foxglove and bloom stands from a
// value of its own, the lush garden's more from BEES_LUSH_FROM (APIARY_LUSH). The lantern
// (APIARY_LANTERN) hangs among the hives and the fairy lights (APIARY_FAIRY) along the wall; after
// dusk (beesDusk, the sun's height) they light what is near them through beesShade (beesLamp, set by
// whoever draws: the lantern's light is a layer light the composer sums, localLight, the hives keeping
// it from the grass behind them, beesLampShadow) and the air round them (the fog's and the rain's
// veil, the drops).
//
// Passage (BEES_PASSAGE): the World's cumulus (and their shadows) drift in from the sides and settle,
// then the near foxgloves, poppies, daisies and blades of grass at the bottom edge spring up into the
// frame, each after its own delay, with a small overshoot; the bees and butterflies are the
// simulation's. At rest every term is exactly 0.
//
// Knobs read here: the composer's K_seed (the hills, the World's cumulus and their shadows, the
// flowers) and K_wind; the apiary's K_flowers, K_lantern, K_fairyLights, K_mark (the M painted on
// the middle hive's front); uWeather.x for how wet the garden is, uWeather.y how much snow lies on it.
import { glslFloat } from "../../shaders/glsl.ts";
import { BED_GROW_SECONDS, BED_HEAD, BED_SOW_SECONDS, BED_TALL } from "./beds.ts";
import { BEES_GRADE } from "./constants.ts";
import {
  BEES_ALONG_WALL,
  BEES_BED_DEPTH,
  BEES_BED_ROWS,
  BEES_BED_SPACING,
  BEES_BLOOMS as BLOOMS,
  BEES_BLOOMS_ALL as BLOOM_ALL,
  BEES_BOARD_HALF,
  BEES_CAM,
  BEES_CODE,
  BEES_COSMOS,
  BEES_DAISY,
  BEES_FOXGLOVES as FOXGLOVES,
  BEES_FOXGLOVES_ALL as FOX_ALL,
  BEES_GROUND_PATCHES,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_LAVENDER,
  BEES_LUSH_FROM,
  BEES_PASSAGE,
  BEES_PATCHES,
  BEES_POPPY,
  BEES_STAGE_MIN,
  BEES_TREES as TREES,
  BEES_WILD,
  BEES_YH,
} from "./layout.ts";

function floats(values: readonly number[]): string {
  return `float[${values.length}](${values.map(glslFloat).join(", ")})`;
}

function ints(values: readonly number[]): string {
  return `int[${values.length}](${values.join(", ")})`;
}

/** Hives far to near, so a nearer one is drawn over a farther. */
const HIVE_ORDER = BEES_HIVES.map((hive, i) => ({ hive, i }))
  .sort((a, b) => b.hive.y - a.hive.y)
  .map((entry) => entry.i);

/** The slot in DRIFT_ORDER where the orchard and the wall are drawn. */
const ORCHARD_SLOT = -1;
/** The drifts in the order they are drawn, the orchard and the wall in their slot: all but the wild flowers along the wall's foot behind them, those in front. */
const DRIFT_ORDER = [
  ...BEES_PATCHES.map((_, i) => i).filter((i) => i !== BEES_ALONG_WALL),
  ORCHARD_SLOT,
  BEES_ALONG_WALL,
];

/**
 * The afternoon's light on a speck (time 0.64, the default, in a clear sky: beesShade's light with
 * the grade's exposure of 1.1), which its colour in beesSpeck was picked under: a speck is lit by the
 * light at its cell over this.
 */
const SPECK_DAY = [0.896, 0.825, 0.736] as const;

/**
 * The garden lantern (the `lantern` knob), hanging from an iron crook a little in front of the hives,
 * between the middle one and the right, so that its light reaches all three: x (fraction of the
 * stage) and the y of the ground under the flame, the flame's height and how far the crook's hook
 * reaches right of its post (m).
 */
const LANTERN = { f: 0.05, y: 0.25, hang: 1.08, reach: 0.2 } as const;

/** The valley's own haze per metre beside the World's air, for what the hillside's air hazes (Air.dust). */
const BEES_HAZE = 0.002;

const [SUN_R = 1, SUN_G = 1, SUN_B = 1] = BEES_GRADE.sunTint ?? [];

/**
 * The garden's shared GLSL (every bees layer holds it): its layout and tuning, the light and view
 * each cell takes (beesBegin), the skyline, the path's edge and the swells of wind.
 */
export const beesSharedGlsl = `
// ---- the garden's layout and light (bees/shader.ts), shared by its layers ----
const float BEES_YH = ${glslFloat(BEES_YH)};
const float BEES_CAM = ${glslFloat(BEES_CAM)};
const float BEES_STAGE_MIN = ${glslFloat(BEES_STAGE_MIN)};
const float BEES_ROW = 0.14;
const float BEES_BOARD_HALF = ${glslFloat(BEES_BOARD_HALF)};
const float BEES_HIVE_SCALE = ${glslFloat(BEES_HIVE_SCALE)};
const float BEES_STAND = ${glslFloat(BEES_HIVE.stand)};
const float BEES_BOX = ${glslFloat(BEES_HIVE.box)};
const float BEES_ROOF = ${glslFloat(BEES_HIVE.roof)};
const float BEES_HIVE_W = ${glslFloat(BEES_HIVE.width)};
const float BEES_SLOT = ${glslFloat(BEES_HIVE.slot)};
const float BEES_BOARD = ${glslFloat(BEES_HIVE.board)};
const int BEES_HIVE_N = ${BEES_HIVES.length};
const float BEES_HIVE_F[${BEES_HIVES.length}] = ${floats(BEES_HIVES.map((h) => h.f))};
const float BEES_HIVE_Y[${BEES_HIVES.length}] = ${floats(BEES_HIVES.map((h) => h.y))};
const int BEES_HIVE_ORDER[${BEES_HIVES.length}] = ${ints(HIVE_ORDER)};
const int BEES_PATCH_N = ${BEES_PATCHES.length};
const float BEES_PATCH_F[${BEES_PATCHES.length}] = ${floats(BEES_PATCHES.map((p) => p.f))};
const float BEES_PATCH_Y[${BEES_PATCHES.length}] = ${floats(BEES_PATCHES.map((p) => p.y))};
const float BEES_PATCH_RX[${BEES_PATCHES.length}] = ${floats(BEES_PATCHES.map((p) => p.rx))};
const float BEES_PATCH_RY[${BEES_PATCHES.length}] = ${floats(BEES_PATCHES.map((p) => p.ry))};
const int BEES_PATCH_KIND[${BEES_PATCHES.length}] = ${ints(BEES_PATCHES.map((p) => p.kind))};
const int BEES_LAVENDER = ${BEES_LAVENDER};
const int BEES_POPPY = ${BEES_POPPY};
const int BEES_DAISY = ${BEES_DAISY};
const int BEES_WILD = ${BEES_WILD};
const int BEES_COSMOS = ${BEES_COSMOS};
// The wild flowers along the wall's foot (a patch), and the drifts in the order they are drawn, the
// orchard and the wall in the slot BEES_ORCHARD_SLOT.
const int BEES_ALONG_WALL = ${BEES_ALONG_WALL};
const int BEES_ORCHARD_SLOT = ${ORCHARD_SLOT};
const int BEES_DRIFT_ORDER[${DRIFT_ORDER.length}] = ${ints(DRIFT_ORDER)};
// The near foxgloves and blooms: those standing at flowers 1, and with APIARY_LUSH the lush garden's
// more after them; BEES_FOX_SHOW and BEES_BLOOM_SHOW the flowers value each stands from.
#if APIARY_LUSH
const int BEES_FOX_N = ${FOX_ALL.length};
const int BEES_BLOOM_N = ${BLOOM_ALL.length};
#else
const int BEES_FOX_N = ${FOXGLOVES.length};
const int BEES_BLOOM_N = ${BLOOMS.length};
#endif
const float BEES_FOX_F[${FOX_ALL.length}] = ${floats(FOX_ALL.map((f) => f[0]))};
const float BEES_FOX_Y[${FOX_ALL.length}] = ${floats(FOX_ALL.map((f) => f[1]))};
const float BEES_FOX_H[${FOX_ALL.length}] = ${floats(FOX_ALL.map((f) => f[2]))};
const float BEES_FOX_SHOW[${FOX_ALL.length}] = ${floats(FOX_ALL.map((f) => f[3]))};
const float BEES_BLOOM_F[${BLOOM_ALL.length}] = ${floats(BLOOM_ALL.map((b) => b[0]))};
const float BEES_BLOOM_Y[${BLOOM_ALL.length}] = ${floats(BLOOM_ALL.map((b) => b[1]))};
const float BEES_BLOOM_K[${BLOOM_ALL.length}] = ${floats(BLOOM_ALL.map((b) => b[2]))};
const float BEES_BLOOM_SHOW[${BLOOM_ALL.length}] = ${floats(BLOOM_ALL.map((b) => b[3]))};
const int BEES_GROUND_PATCHES = ${BEES_GROUND_PATCHES};
// The flowers value the lush garden (APIARY_LUSH) starts at.
const float BEES_LUSH_FROM = ${glslFloat(BEES_LUSH_FROM)};
const int BEES_TREE_N = ${TREES.length};
const float BEES_TREE_F[${TREES.length}] = ${floats(TREES.map((t) => t[0]))};
const float BEES_TREE_Y[${TREES.length}] = ${floats(TREES.map((t) => t[1]))};
const float BEES_TREE_S[${TREES.length}] = ${floats(TREES.map((t) => t[2]))};
const float BEES_TREE_SEED[${TREES.length}] = ${floats(TREES.map((t) => t[3]))};
// Seconds of the entrance and the exit (BEES_PASSAGE).
const float BEES_ENTER = ${glslFloat(BEES_PASSAGE.enter)};
// The crown of an old apple tree: lobes (x, y, radius) in metres from the foot of the trunk, spreading
// wide; each tree jitters, stretches and resizes them by its seed.
const vec3 BEES_CROWN[9] = vec3[9](vec3(-2.7, 2.7, 1.15), vec3(-1.5, 3.1, 1.3), vec3(-0.2, 3.5, 1.45), vec3(1.2, 3.2, 1.3), vec3(2.6, 2.8, 1.1), vec3(-1.1, 3.9, 1.0), vec3(0.5, 4.0, 1.05), vec3(-2.0, 2.2, 0.8), vec3(2.0, 2.3, 0.85));
// The valley's distances (m) for the weather and the clouds' shadows: the near, middle and far hills.
const vec3 BEES_HILL_Z = vec3(500.0, 1200.0, 2500.0);
// The sun's warm tint (the grade's, BEES_GRADE), for the golden haze it scatters.
const vec3 BEES_SUN_TINT = vec3(${glslFloat(SUN_R)}, ${glslFloat(SUN_G)}, ${glslFloat(SUN_B)});
// The valley's haze per metre (Air.dust).
const float BEES_HAZE = ${glslFloat(BEES_HAZE)};
// Wet (uWeather.x): how porous the garden's surfaces are taken to be (wetten), how upward the lawn and
// the path, and the things standing in the garden, face (wetGloss), and how much of the low sky their
// sheen holds.
const float BEES_POROUS = 0.5;
const float BEES_WET_UP_GROUND = 0.85;
const float BEES_WET_UP_THINGS = 0.3;
const float BEES_WET_SHEEN = 0.35;
// Lying snow (uWeather.y): its white, and how much of it the hills' fields and the crowns hold.
const vec3 BEES_SNOW = vec3(0.92, 0.94, 0.98);
const float BEES_SNOW_HILLS = 0.85;
const float BEES_SNOW_CROWN = 0.8;
// The wall's foot (uv) and the gate in it, as fractions of the stage.
const float BEES_WALL_Y = 0.372;
const float BEES_GATE_0 = 0.27;
const float BEES_GATE_1 = 0.4;
// The garden's lights. The lantern (BEES_LANTERN_AT): the ground under its flame (x a fraction of the
// stage, the y of the ground there), the flame's height and the crook's reach (m); the flame's colour,
// its brightness at the knob's 1, the distance (m) its light halves at and the one it is gone by.
// The fairy lights (APIARY_FAIRY): pins on the wall's top this far apart (m), the wire's sag between
// them, a bulb this often along it; their warm light.
const vec4 BEES_LANTERN_AT = vec4(${glslFloat(LANTERN.f)}, ${glslFloat(LANTERN.y)}, ${glslFloat(LANTERN.hang)}, ${glslFloat(LANTERN.reach)});
const vec3 BEES_FLAME = vec3(1.0, 0.74, 0.46);
const float BEES_LAMP_GAIN = 1.15;
const float BEES_LAMP_NEAR = 1.8;
const float BEES_LAMP_FAR = 10.0;
const float BEES_FAIRY_PIN = 1.7;
const float BEES_FAIRY_SAG = 0.2;
const float BEES_FAIRY_STEP = 0.34;
const vec3 BEES_FAIRY_WARM = vec3(1.0, 0.74, 0.42);

// Light and view, set once per cell by beesBegin: the composer's light (the key: the sun's, or the
// moon's once the sun has set, in the valley's warm tint), the key's bearing in the rig's frame and
// its height, and how much of it the clouds let through here (worldSunlit).
vec3 beesAmb = vec3(0.5);
vec3 beesSun = vec3(1.0, 0.9, 0.7);
vec2 beesSunGround = vec2(-0.6, 0.8);
float beesSunTan = 0.4;
float beesSunUp = 1.0;
float beesSunX = -0.5;
float beesLit = 1.0;
float beesW = 0.9;
float beesAa = 0.002;
float beesAspect = 1.78;
float beesSeed = 0.0;
float beesCut = 0.0;
// How wet the garden is and how much snow lies on it (uWeather), and the snow on the ground at this cell.
float beesWet = 0.0;
float beesLying = 0.0;
float beesSnowGround = 0.0;
// wetten (weather.ts) at this wet, BEES_POROUS, as one matrix and a dimming, set once by beesBegin:
// a wet albedo is max(beesWetM * albedo, 0.0) * beesWetDim, the same function inlined once.
mat3 beesWetM = mat3(1.0);
float beesWetDim = 1.0;
// The depth (m) of the nearest thing drawn at this cell that can hide a bee behind it: the wall, a tree, a
// hive, the foreground flowers, a bird. 1e4 for the sky, the hills and the ground (a bee is always in front of that).
float beesZ = 1e4;
#if APIARY_LANTERN || APIARY_FAIRY
// The garden's lights now (beesGardenBegin): how far past dusk it is (0 by day, 1 once the sun is down), the
// lantern's flame (metres: X right, H up, Z ahead) and its light there, the fairy lights' brightness;
// and the lights' light on the surface being drawn, set by whoever draws it (beesShade adds it).
float beesDusk = 0.0;
vec3 beesLampPos = vec3(0.0, 1.0, 8.0);
vec3 beesLampColor = vec3(0.0);
float beesFairyOn = 0.0;
vec3 beesLamp = vec3(0.0);
#endif
#if APIARY_FLOWERS
// The drifts as the flowers knob grows them (beesGardenBegin): how much of them is left below 1 (1 from
// there up), how far they have grown lusher above it (0 up to 1, 1 by 3: wider), and from 2 on how
// far their near sides reach down the slope.
float beesThin = 1.0;
float beesLush = 0.0;
float beesReach = 0.0;
#endif
// Per cell (beesBegin): the point in the picture (x from the view's centre line, screen heights), where
// its ray meets the garden's ground (beesXz, metres; beesDepth its depth, held off the horizon), the
// ground's footprint in a cell (for the textures' detail), the skyline at its x (the garden's far
// edge, the near, middle and far ridges), and the clouds' shadows on the garden and on the hills.
vec2 beesP = vec2(0.0);
float beesDepth = 1.0;
vec2 beesXz = vec2(0.0);
vec2 beesFoot = vec2(0.0);
vec4 beesSky = vec4(0.0);
float beesLitNear = 1.0;
float beesLitFar = 1.0;
// The garden's ground at this cell (beesGardenBegin): whether the ray meets it (below the backdrop's
// land line); the composer's gust there (gustAt: one wind for every layer), which runs through the
// grass as a swell of paler light and sways the blooms; its shade from what casts on it
// (casterShadow); and the garden lights' light on it, the hives' shadows taken out.
bool beesOnGround = false;
float beesGustHere = 0.0;
float beesGs = 0.0;
#if APIARY_LANTERN || APIARY_FAIRY
vec3 beesLampGround = vec3(0.0);
#endif
// The valley's bright sky low over the hills (hillsideBegin), toward which the far land hazes.
vec3 beesHazeB = vec3(0.0);

float beesS(float y) {
  return max(BEES_YH - y, 0.012) / BEES_CAM;
}

// How far a plant of the foreground is still below the frame, as a share of its travel: 1 while it waits,
// then down through 0 (a little below, the overshoot) as it springs up, 0 for good once arrived. 'key'
// sets its delay (0.4 to 0.8 s into the entrance) so they do not rise as one.
float beesRise(float key) {
  if (passageIn() >= 1.0) return 0.0;
  float tin = passageIn() * BEES_ENTER;
  float t = clamp((tin - 0.4 - 0.4 * hash12(vec2(key, 83.0))) / 1.3, 0.0, 1.0);
  float u = t - 1.0;
  return -(2.2 * u * u * u + 1.2 * u * u);
}

// An albedo in the valley's light, wet as the garden is (beesWetM): the sky's ambient plus the warm key,
// more of it on a surface turned toward the key (nx: the surface's sideways normal, -1 left .. 1
// right); shade (a tree's, a hive's: beesCut) takes most of the key, and so do the clouds' shadows
// (beesLit), the darker of the two where both fall. The garden's lights add theirs (beesLamp).
vec3 beesShade(vec3 albedo, float nx) {
  float f = clamp(nx * beesSunX * 1.4, -1.0, 1.0);
  vec3 a = beesWet > 0.0 ? max(beesWetM * albedo, 0.0) * beesWetDim : albedo;
  vec3 c = a * (beesAmb * 0.55 + beesSun * (0.5 + 0.35 * f) * min(beesLit, 1.0 - 0.72 * beesCut));
#if APIARY_LANTERN || APIARY_FAIRY
  c += a * beesLamp;
#endif
  return c;
}

// Light that passes through a thin leaf or petal toward the eye, the key being behind the scene.
vec3 beesGlow(vec3 albedo, float amount) {
  vec3 a = beesWet > 0.0 ? max(beesWetM * albedo, 0.0) * beesWetDim : albedo;
  return a * beesSun * amount * min(beesLit, 1.0 - 0.72 * beesCut);
}

// ---- the skyline ---------------------------------------------------------------------------------------

float beesRidge(float x, float base, float amp, float freq, float seed, float bump) {
  float s = seed + beesSeed;
  float a = vnoise1(x * freq + s, s).x - 0.5;
  float b = vnoise1(x * freq * 2.3 + s * 1.7, s + 4.0).x - 0.5;
  float trees = vnoise1(x * 18.0 + s * 3.1, s + 9.0).x;
  return base + amp * (2.0 * a + 0.7 * b) + bump * smoothstep(0.6, 0.8, trees);
}

// (the garden's far edge, then the ridges of the near, middle and far hills) at x
vec4 beesSkyline(float x) {
  float g = beesRidge(x, 0.385, 0.025, 1.3, 5.0, 0.0);
  float y1 = max(beesRidge(x, 0.455, 0.07, 1.1, 9.0, 0.012), g + 0.014);
  float y2 = max(beesRidge(x, 0.525, 0.075, 0.9, 21.0, 0.009), y1 + 0.012);
  float y3 = max(beesRidge(x, 0.59, 0.06, 0.7, 33.0, 0.005), y2 + 0.012);
  return vec4(g, y1, y2, y3);
}

// How far p lies outside the path's edge (screen units; negative on the path, which ends at the
// gate, y 0.4): it winds up from the lens to the gate, 1.2 m wide.
float beesPathEdge(vec2 p) {
  float y = p.y;
  float xp = beesW * (0.05 + 0.3 * smoothstep(0.0, 0.38, y)) + 0.05 * beesW * sin(y * 8.0 + 1.0) * smoothstep(0.02, 0.2, y);
  return abs(p.x - xp) - 0.6 * beesS(y) * (0.9 + 0.25 * (vnoise(vec2(y * 40.0, beesSeed)) - 0.5));
}

#if APIARY_LANTERN
// How much of the lantern's light the hives keep from the grass at ground point w (metres): each,
// standing taller than the flame, throws a shadow from its foot away from the lantern without end,
// widening with the distance and soft at its sides. 0 lit .. 1 shaded.
float beesLampShadow(vec2 w) {
  vec2 l = beesLampPos.xz;
  vec2 r = w - l;
  float s = 0.0;
  for (int i = 0; i < BEES_HIVE_N; i++) {
    float Zh = BEES_CAM / (BEES_YH - BEES_HIVE_Y[i]);
    vec2 a = vec2(BEES_HIVE_F[i] * beesW * Zh, Zh) - l;
    float la = length(a);
    vec2 u = a / la;
    float along = dot(r, u);
    float across = abs(r.x * u.y - r.y * u.x);
    // The hive's half width (as it is drawn: BEES_HIVE_SCALE) seen from the flame, spread with the distance.
    float spread = 0.5 * BEES_HIVE_W * BEES_HIVE_SCALE * max(along, 0.1) / la;
    float side = 1.0 - smoothstep(0.75 * spread, 1.25 * spread + 0.12 * max(along - la, 0.0), across);
    s = max(s, smoothstep(la - 0.15, la + 0.3, along) * side);
  }
  return 0.9 * s;
}
#endif

// What every garden layer reads in each cell: the stage for this frame, the seed, the wet, the
// composer's light, the point and its ground, the clouds' shadows, the skyline.
void beesBegin(Ctx x) {
  beesAspect = x.aspect;
  beesW = max(0.5 * beesAspect, BEES_STAGE_MIN);
  beesAa = x.aa;
  beesSeed = K_seed * 0.37;
  beesWet = uWeather.x;
  beesLying = uWeather.y;
  // wetten's colour change at this wet, once (beesWetM): the colour deepened, the albedo dimmed.
  float wetW = clamp(beesWet, 0.0, 1.0);
  float wetRich = 1.0 + wetW * mix(0.2, 0.45, BEES_POROUS);
  beesWetM = mat3(wetRich) + outerProduct(vec3(1.0 - wetRich), LUMA);
  beesWetDim = 1.0 - wetW * mix(0.22, 0.55, BEES_POROUS);
  beesSun = x.light.sun;
  beesAmb = x.light.amb;
  beesSunX = x.light.keyGround.x;
  beesSunGround = x.light.keyGround;
  beesSunTan = x.light.keyTan;
  beesSunUp = x.light.keyUp;
  beesP = vec2((x.uv.x - 0.5) * beesAspect, x.uv.y);
  // How much of the sun the clouds let through (worldSunlit: the cumulus' shadows, and the deck's
  // with its shadows on), by day: on the garden where this cell's ray meets the ground (above the
  // horizon, in the air as far out over the orchard), and on the hills.
  float dy = max(BEES_YH - beesP.y, 0.03);
  beesDepth = BEES_CAM / dy;
  beesXz = vec2(beesP.x * beesDepth, beesDepth);
  beesFoot = vec2(beesDepth / uRes.y, beesDepth / (dy * uRes.y));
  vec3 ray = vec3(beesP.x, beesP.y - BEES_YH, 1.0);
  beesLitNear = x.light.moonKey ? 1.0 : worldSunlit(x.w, x.v, ray * beesDepth);
  beesLitFar = x.light.moonKey ? 1.0 : worldSunlit(x.w, x.v, ray * BEES_HILL_Z.y);
  beesLit = beesLitNear;
  beesSky = beesSkyline(beesP.x);
}
`;

/**
 * The garden's ground state, shared by the lawn and the apiary (beesGardenBegin, after the backdrop
 * has set where its land ends): the swells of wind, the snow lying on the ground, the ground's shade,
 * the garden lights now and their light on the ground.
 */
export const gardenSharedGlsl = `
// ---- the garden's ground (bees/shader.ts), shared by the lawn and the apiary ----
void beesGardenBegin(Ctx x) {
  beesOnGround = beesP.y < x.groundTo;
  // The gust where the ray meets the ground, sampled over a cell and a half of it along the wind,
  // so far fronts blur, never alias.
  beesGustHere = clamp(gustAt(x.gust, beesXz, x.tm, 1.5 * (abs(x.gust.dir.x) * beesFoot.x + x.gust.dir.y * beesFoot.y)), 0.0, 1.0);
#if APIARY_LANTERN || APIARY_FAIRY
  // The garden's lights come on as the sun goes down to the horizon and burn through the night.
  beesDusk = 1.0 - smoothstep(-0.04, 0.1, x.w.sky.sun.y);
#endif
#if APIARY_LANTERN
  float zLamp = BEES_CAM / (BEES_YH - BEES_LANTERN_AT.y);
  beesLampPos = vec3(BEES_LANTERN_AT.x * beesW * zLamp, BEES_LANTERN_AT.z, zLamp);
  beesLampColor = BEES_FLAME * BEES_LAMP_GAIN * K_lantern * beesDusk;
#endif
#if APIARY_FAIRY
  beesFairyOn = K_fairyLights * beesDusk;
#endif
#if APIARY_FLOWERS
  beesThin = min(K_flowers, 1.0);
  beesLush = clamp(0.5 * (K_flowers - 1.0), 0.0, 1.0);
  beesReach = smoothstep(2.0, 3.0, K_flowers);
#endif
  if (!beesOnGround) return;
  beesSnowGround = snowCover(vec3(0.0, 1.0, 0.0), beesXz, beesLying);
  beesGs = casterShadow(beesXz, x);
#if APIARY_LANTERN
  // The lantern's light on the ground at this cell, the hives' shadows taken out.
  beesLampGround = localLight(vec3(beesXz.x, 0.0, beesXz.y), vec3(0.0, 1.0, 0.0)) * (1.0 - beesLampShadow(beesXz));
#endif
}

// Something of the garden's drawn at this cell at depth z (m): what the cell shows, and what hides a
// speck behind it (beesZ, the nearest the garden drew).
void beesAt(inout Cell c, float z) {
  c.z = z;
  c.zs = z;
  beesZ = z;
}
`;

/** The hillside's GLSL: the hills, the far orchard's farmhouse and windmill, the valley's air. */
export const hillsideGlsl = `

// ---- the hills ---------------------------------------------------------------------------------------

// Patchwork fields on a hill k = 1 (near) .. 3 (far): small parcels that follow the contours in hay gold,
// bright and deep greens, ploughed brown, the yellow of rape and the odd lavender field, hedgerows
// between many of them with clumps of trees, lit warm along the ridge, saturated on the near hill
// (summer green-gold) and gone to haze with distance.
vec3 beesHill(vec2 p, float ridge, float k, vec3 haze, float hazeAmt) {
  float deep = max(ridge - p.y, 0.0);
  float v = deep * (60.0 - 12.0 * k) + 1.5 * (vnoise1(p.x * 2.2 + k * 5.0 + beesSeed, k).x - 0.5);
  float rowId = floor(v);
  float rh = hash12(vec2(rowId, k * 11.0));
  float cu = p.x * (5.0 - 0.8 * k + 3.0 * rh) + rh * 9.0;
  float colId = floor(cu);
  float hf = hash12(vec2(colId, rowId + k * 17.0));
  vec3 c = hf < 0.2 ? vec3(0.90, 0.74, 0.26) : hf < 0.42 ? vec3(0.50, 0.72, 0.18) : hf < 0.64 ? vec3(0.26, 0.54, 0.14) : hf < 0.78 ? vec3(0.14, 0.36, 0.12) : hf < 0.88 ? vec3(0.70, 0.46, 0.24) : hf < 0.96 ? vec3(1.0, 0.86, 0.18) : vec3(0.60, 0.45, 0.75);
  c *= 0.9 + 0.2 * hash12(vec2(colId, rowId) + 3.7);
  float rowEdge = (1.0 - smoothstep(0.0, 0.14, fract(v))) * step(0.3, rh);
  float colEdge = (1.0 - smoothstep(0.0, 0.08, fract(cu))) * step(0.4, hash12(vec2(colId, rowId + 4.0)));
  c = mix(c, vec3(0.08, 0.20, 0.07), max(rowEdge, colEdge) * 0.9);
  vec2 tc = vec2(p.x * (40.0 - 8.0 * k), v * 2.0);
  float tree = step(0.84, hash12(floor(tc) + k * 7.0)) * hardEdge(1.0 - smoothstep(0.22, 0.42, length(fract(tc) - 0.5)));
  c = mix(c, vec3(0.06, 0.18, 0.07) * (0.8 + 0.7 * smoothstep(0.7, 0.2, fract(tc).y)), tree);
  c *= mix(1.12, 0.88, smoothstep(0.0, 0.1, deep));
  if (k < 1.5) c *= vec3(1.1, 1.05, 0.86);
  // Lying snow whitens the fields; the hedgerows and the tree clumps stay dark over it.
  c = mix(c, BEES_SNOW, BEES_SNOW_HILLS * beesLying * (1.0 - max(max(rowEdge, colEdge) * 0.9, tree)));
  c = beesShade(c, 0.0);
  c += beesSun * vec3(0.6, 0.45, 0.15) * 0.2 * (1.0 - smoothstep(0.0, 0.012, deep));
  c = mix(vec3(dot(c, LUMA)), c, 1.4 - 0.2 * k);
  return mix(c, haze, hazeAmt);
}

// A farmhouse on the near hill and a windmill on the far one's crest, small and hazy.
void beesFar(vec2 p, float tm, vec3 haze, vec3 hazeB, inout vec3 col) {
  float xh = -0.5 * beesW;
  if (abs(p.x - xh) < 0.06 && p.y > 0.4 && p.y < 0.58) {
    float u = 0.0155;
    vec2 q = (p - vec2(xh, beesSkyline(xh).y - 0.002)) / u;
    float body = hardFill(sdBox(q - vec2(0.0, 0.5), vec2(1.5, 0.5), 0.0) * u, beesAa);
    float roof = hardFill(max(abs(q.x) / 1.8 + (q.y - 1.0) / 0.7 - 1.0, 1.0 - q.y) * 0.55 * u, beesAa);
    float chimney = hardFill(sdBox(q - vec2(0.95, 1.55), vec2(0.15, 0.3), 0.0) * u, beesAa);
    float shrub = hardFill((length(q - vec2(2.4, 0.85)) - 0.9) * u, beesAa);
    float shrub2 = hardFill((length(q - vec2(-2.3, 0.7)) - 0.75) * u, beesAa);
    float win = hardFill((min(length(q - vec2(-0.7, 0.55)), length(q - vec2(0.7, 0.55))) - 0.14) * u, beesAa);
    col = mix(col, mix(beesShade(vec3(0.12, 0.26, 0.10), 0.0), haze, 0.25), max(shrub, shrub2));
    col = mix(col, mix(beesShade(vec3(0.93, 0.88, 0.78), 0.0), haze, 0.22), body);
    col = mix(col, mix(beesShade(vec3(0.28, 0.20, 0.17), 0.0), haze, 0.22), win * body);
    col = mix(col, mix(beesShade(vec3(0.66, 0.30, 0.18), 0.0), haze, 0.22), max(roof, chimney));
  }
  float xw = 0.52 * beesW;
  if (abs(p.x - xw) < 0.08 && p.y > 0.46 && p.y < 0.72) {
    float u = 0.015;
    vec2 q = (p - vec2(xw, beesSkyline(xw).w - 0.004)) / u;
    float tower = hardFill(max(max(abs(q.x) - (1.2 - 0.18 * q.y), -q.y), q.y - 3.3) * 0.9 * u, beesAa);
    float cap = hardFill(sdEllipse(q - vec2(0.0, 3.4), vec2(1.0, 0.6)) * u, beesAa);
    vec2 hub = vec2(0.0, 3.3);
    float sails = 1e3;
    for (int k = 0; k < 4; k++) {
      float a = tm * 0.04 + float(k) * 1.5708;
      vec2 tip = hub + 3.2 * vec2(cos(a), sin(a));
      sails = min(sails, min(sdTaperCapsule(q, hub, tip, 0.1, 0.1), sdTaperCapsule(q, hub + 1.0 * vec2(cos(a), sin(a)), tip, 0.3, 0.3)));
    }
    float blades = hardFill(sails * u, beesAa);
    vec3 wall = mix(beesShade(vec3(0.90, 0.88, 0.80), 0.0), hazeB, 0.4);
    col = mix(col, wall, max(tower, blades));
    col = mix(col, mix(beesShade(vec3(0.40, 0.28, 0.20), 0.0), hazeB, 0.4), cap);
  }
}

// ---- the hillside's passes ----
// Per cell: the valley's air, the backdrop's: the haze toward this bearing and the sky high up, greyed
// under the deck; the air full of rain or snow, greyer and darker the heavier it falls (the fog's and
// the rain's colour); the drops' light, from the bright sky low over the hills and the sun. The land
// ends at the garden's far edge.
void hillsideBegin(inout Ctx x) {
  Sky sky = x.w.sky;
  vec3 haze = horizonHaze(sky, x.v.dir, 0.04);
  vec3 zen = skyColor(sky, normalize(vec3(0.0, 0.85, 0.5)));
  haze = mix(haze, vec3(dot(haze, LUMA)) * 0.85 + 0.03, 0.55 * x.w.overcast);
  zen = mix(zen, vec3(dot(zen, LUMA)) * 0.85 + 0.03, 0.55 * x.w.overcast);
  beesHazeB = mix(haze, zen, 0.45);
  vec3 air = greyed(haze, vec3(0.94, 0.97, 1.02), 0.5 * x.w.overcast) * (1.0 - 0.25 * x.w.heavy);
  vec3 drop = max(beesHazeB * 1.2 + sky.sunColor * 0.3, vec3(0.08));
  x.air = Air(haze, air, drop, beesHazeB, 0.0, BEES_HAZE, 0.0);
  x.groundTo = beesSky.x;
  x.landZ = BEES_CAM / (BEES_YH - beesSky.x);
}

// Above the far hills the World's sky: the dome, the aurora, the deck with the painted cumulus in
// front of it, the stars and the Milky Way in their gaps, shooting stars over the hills, the lightning.
void hillsideSky(Ctx x, inout Cell c) {
  if (beesP.y < beesSky.w) return;
  WorldSky heaven = worldSky(x.w, x.v, WORLD_METEOR_FIELD);
  c.col = heaven.col + heaven.strike;
}

// The hills, far to near, down to the garden's far edge, lit by the clouds' shadows on them; the
// farmhouse and the windmill on their ridges.
void hillsideFar(Ctx x, inout Cell c) {
  vec2 p = beesP;
  float y = p.y;
  beesLit = beesLitFar;
  if (y < beesSky.w) {
    if (y >= beesSky.z) {
      c.col = beesHill(p, beesSky.w, 3.0, beesHazeB, 0.55);
      c.z = BEES_HILL_Z.z;
    } else if (y >= beesSky.y) {
      c.col = beesHill(p, beesSky.z, 2.0, beesHazeB, 0.3);
      c.z = BEES_HILL_Z.y;
    } else if (y >= beesSky.x) {
      c.col = beesHill(p, beesSky.y, 1.0, x.air.haze, 0.08);
      c.z = BEES_HILL_Z.x;
    }
  }
  if (y > 0.4 && y < 0.72) {
    vec3 bare = c.col;
    beesFar(p, x.tm, x.air.haze, beesHazeB, c.col);
    if (c.col != bare) c.z = min(c.z, BEES_HILL_Z.z);
  }
  beesLit = beesLitNear;
}

// The golden haze the low sun scatters toward the eye, over everything.
void hillsideAir(inout Ctx x, inout Cell c) {
  c.col += x.w.sky.sunColor * BEES_SUN_TINT * 0.07 * exp(-5.0 * length(x.v.dir - x.w.sky.sun)) * (1.0 + 0.4 * (1.0 - smoothstep(0.4, 0.7, x.uv.y)));
}
`;

/** The lawn's GLSL: the grass, the hedge, the path, the blades at the lens, the wet lawn's sheen. */
export const lawnGlsl = `
// ---- the grass and the path ----

// The grass: patches of yellower and bluer green, a mottle, flecks, clover and its flowers, windfalls
// where a tree shades it, and the pale sheen of the wind, under any snow lying on it (beesSnowGround).
// The light and shade come from beesShade (the caller has put the shade in beesCut).
vec3 beesGround(vec2 p, vec2 w, vec2 foot, float gust, float gs) {
  float y = p.y;
  float ft = max(foot.x, foot.y);
  float tone = fbmLod(w * 0.16 + vec2(beesSeed, 0.0), ft * 0.16, 2).x;
  vec3 c = mix(vec3(0.17, 0.38, 0.19), vec3(0.30, 0.48, 0.12), smoothstep(0.28, 0.5, tone));
  c = mix(c, vec3(0.52, 0.57, 0.15), smoothstep(0.5, 0.72, tone));
  c *= 0.78 + 0.45 * fbmLod(w * 0.55, ft * 0.55, 3).x;
  float fine = 1.0 - smoothstep(0.3, 0.9, ft * 9.0);
  c *= 1.0 + (hash12(floor(w * 9.0)) - 0.5) * 0.4 * fine;
  // Clover: dark leaf clusters and a few pale flowers.
  vec2 cg = w / 0.42;
  vec2 ch = hash22(floor(cg) + 11.0);
  float show = smoothstep(0.7, 1.5, 0.07 / ft);
  float cd = length(fract(cg) - (0.5 + (ch - 0.5) * 0.4)) * 0.42;
  float clover = step(0.78, ch.x) * hardEdge((1.0 - smoothstep(0.05, 0.07, cd)) * show);
  c = mix(c, ch.y < 0.3 ? vec3(0.94, 0.88, 0.93) : vec3(0.14, 0.34, 0.10), clover);
  // Windfalls in the shade.
  if (gs > 0.4) {
    vec2 ag = w / 0.9;
    vec2 ah = hash22(floor(ag) + 5.0);
    float ad = length(fract(ag) - (0.5 + (ah - 0.5) * 0.6)) * 0.9;
    float apple = step(0.9, ah.x) * hardEdge((1.0 - smoothstep(0.06, 0.08, ad)) * smoothstep(0.7, 1.5, 0.08 / ft));
    c = mix(c, ah.y < 0.5 ? vec3(0.72, 0.14, 0.08) : vec3(0.80, 0.66, 0.20), apple);
  }
  c = mix(c, c * vec3(1.45, 1.32, 0.78) + 0.04, 0.6 * gust);
  c = mix(c, vec3(0.62, 0.62, 0.36), 0.35 * smoothstep(0.22, 0.4, y));
  c = mix(c, BEES_SNOW, beesSnowGround);
  return beesShade(c, 0.0) + beesGlow(c, 0.25 * gust * (1.0 - beesSnowGround));
}

void beesPath(vec2 p, vec2 w, inout vec3 col) {
  float y = p.y;
  if (y > 0.4) return;
  float S = beesS(y);
  float d = beesPathEdge(p);
  if (hardFill(d, beesAa) < 0.5) return;
  float speck = hash12(floor(w * 12.0));
  vec3 c = vec3(0.74, 0.62, 0.42) * (0.85 + 0.3 * speck);
  c = mix(c, vec3(0.50, 0.46, 0.30), smoothstep(-0.1 * S, 0.0, d) * 0.6);
  col = beesShade(mix(c, BEES_SNOW, beesSnowGround), 0.0);
}

// Blades of grass at the lens along the bottom edge, leaning with the breeze.
void beesBlades(vec2 p, float tm, inout vec3 col) {
  if (p.y > 0.2) return;
  float cw = 0.09;
  float base = floor(p.x / cw);
  for (int k = -1; k <= 1; k++) {
    float id = base + float(k);
    if (hash12(vec2(id, 4.7)) < 0.4) continue;
    vec2 h2 = hash22(vec2(id, 9.1));
    float root = (id + 0.15 + 0.7 * h2.x) * cw;
    float height = 0.06 + 0.12 * h2.y;
    float lean = (hash12(vec2(id, 2.2)) - 0.5) * 0.12;
    float sway = (vnoise1(tm * 0.22 + id * 3.7, 5.0).x - 0.5) * (0.02 + 0.07 * (0.3 + abs(K_wind)));
    vec2 a = vec2(root, -0.03);
    vec2 pk = vec2(p.x, p.y + 0.24 * beesRise(id + 100.0));
    vec2 tip = vec2(root + lean + sway, height);
    vec2 mid = vec2(root + 0.3 * (lean + sway), 0.55 * height);
    float d = min(sdTaperCapsule(pk, a, mid, 0.011, 0.007), sdTaperCapsule(pk, mid, tip, 0.007, 0.001));
    if (hardFill(d, beesAa) > 0.5) {
      vec3 green = mix(vec3(0.12, 0.26, 0.07), vec3(0.42, 0.56, 0.16), h2.y);
      col = beesShade(green, clamp((p.x - root) * 90.0, -1.0, 1.0)) + beesGlow(green, 0.3);
    }
  }
}

// ---- the lawn's passes ----
// The ground below the backdrop's land line: the grass in its shade (beesCut: the casters'), lit by
// the garden's lights; along its far edge the hedge (dark leaves, a golden rim on top, dusted by any
// lying snow); the path over it.
void lawnGround(Ctx x, inout Cell c) {
  if (!beesOnGround) return;
  vec2 p = beesP;
  float y = p.y;
  c.z = beesDepth;
  beesCut = hardEdge(beesGs);
#if APIARY_LANTERN || APIARY_FAIRY
  beesLamp = beesLampGround;
#endif
  c.col = beesGround(p, beesXz, beesFoot, beesGustHere, beesGs);
  if (y > x.groundTo - 0.03 + 0.01 * (vnoise(vec2(p.x * 30.0, beesSeed)) - 0.5)) {
    float n = fbm3(p * vec2(18.0, 40.0));
    vec3 hedge = mix(vec3(0.07, 0.17, 0.06), vec3(0.28, 0.44, 0.12), n);
    hedge = mix(hedge, BEES_SNOW, 0.6 * beesLying * smoothstep(x.groundTo - 0.02, x.groundTo, y));
    c.col = beesShade(hedge, 0.0) + beesGlow(hedge, 0.8 * smoothstep(x.groundTo - 0.012, x.groundTo, y));
  }
  beesPath(p, beesXz, c.col);
  beesCut = 0.0;
}

// Over everything in front: the blades at the lens (unless a cover brings its own, LAWN_BLADES), and,
// wet, the lawn and the path glistening with the low sky where the cell still shows them.
void lawnFrontVeil(Ctx x, inout Cell c) {
#if LAWN_BLADES
#if APIARY_LANTERN || APIARY_FAIRY
  beesLamp = beesLampGround;
#endif
  vec3 before = c.col;
  beesBlades(beesP, x.tm, c.col);
  if (c.col != before) beesAt(c, 3.0);
#endif
  if (beesWet > 0.0 && beesZ >= 1e4 && beesOnGround && c.z >= beesDepth * 0.999) c.col += wetGloss(beesWet, BEES_WET_UP_GROUND) * x.air.haze * BEES_WET_SHEEN;
}
`;

/**
 * The apiary's GLSL: the flower drifts, the orchard, the wall and its gate, the hives, the lantern
 * and the fairy lights, the near foxgloves and blooms; the crowns' shadows (apiaryCrowns, a caster)
 * and the lantern's light (beesLampLight, a layer light).
 */
export const apiaryGlsl = `
// ---- the orchard's shadows and the lantern's light ----
// How much of the key light the ground at point xz (metres) loses to the orchard's crowns (the apiary's
// caster, composer: casterShadow, which takes the hives' shadows from their claims): each tree's crown
// throws a wide soft shadow away from the light, long when it is low, with sun spots through its
// leaves. 0 lit .. 1 shaded.
float apiaryCrowns(vec2 xz, Ctx x) {
  vec2 away = -x.light.keyGround;
  float reach = clamp(1.0 / x.light.keyTan, 0.8, 4.0);
  float s = 0.0;
  for (int k = 0; k < BEES_TREE_N; k++) {
    float sz = BEES_TREE_S[k];
    float Zt = BEES_CAM / (BEES_YH - BEES_TREE_Y[k]);
    vec2 foot = vec2(BEES_TREE_F[k] * beesW * Zt, Zt);
    vec2 d = (xz - (foot + away * 3.0 * sz * reach * 0.7)) / vec2(3.0 * sz, 2.1 * sz);
    if (dot(d, d) > 2.5) continue;
    float e = length(d) + 0.35 * (vnoise(xz * 0.9 + float(k) * 7.0) - 0.5);
    float inside = 1.0 - smoothstep(0.6, 1.0, e);
    float dapple = smoothstep(0.55, 0.72, vnoise(xz * 2.1 + float(k) * 3.0 + beesSeed));
    s = max(s, inside * (0.92 - 0.5 * dapple));
  }
  return s;
}

#if APIARY_LANTERN
// The lantern's light reaching a surface at 'at' (metres: X right, H up, Z ahead) whose normal is n,
// or lit all round for n = 0 (a bell, a bloom): the flame's falling off with the square of the
// distance past BEES_LAMP_NEAR, gone by BEES_LAMP_FAR, and soft-wrapped round the surface so that a
// face turned away still takes a little.
vec3 beesLampLight(vec3 at, vec3 n) {
  vec3 v = beesLampPos - at;
  float d2 = dot(v, v);
  float facing = dot(n, n) > 0.0 ? 0.3 + 0.7 * max(dot(n, v), 0.0) * inversesqrt(d2) : 0.75;
  float far = 1.0 - smoothstep(0.4, 1.0, d2 / (BEES_LAMP_FAR * BEES_LAMP_FAR));
  return beesLampColor * facing * far / (1.0 + d2 / (BEES_LAMP_NEAR * BEES_LAMP_NEAR));
}
#endif

// ---- flower drifts -------------------------------------------------------------------------------------

#if APIARY_FLOWERS
// Drift i's ellipse at p, in its radii (0 at its middle, 1 at its edge): as laid out at flowers 1,
// wider above it and, from 2 on, each drift on the garden's ground (but the wild flowers along the
// wall, BEES_ALONG_WALL) running its near side on down the slope to the lens, widening as it comes
// (beesReach). The sim reads the same ellipses (garden.ts patchPoint).
vec2 beesDriftQ(int i, vec2 p) {
  vec2 c = vec2(BEES_PATCH_F[i] * beesW, BEES_PATCH_Y[i]);
  vec2 r = vec2(BEES_PATCH_RX[i] * beesW, BEES_PATCH_RY[i]) * (1.0 + 0.5 * beesLush);
  vec2 q = (p - c) / r;
  if (q.y < 0.0 && i < BEES_GROUND_PATCHES && i != BEES_ALONG_WALL) {
    q.y = (p.y - c.y) / mix(r.y, c.y / 0.55, beesReach);
    q.x = (p.x - c.x) / (r.x * (1.0 + 0.5 * beesReach * min(-q.y, 1.0)));
  }
  return q;
}
#endif

// How much of drift i covers p (0..1), its edge ragged with noise.
float beesPatchCover(int i, vec2 p) {
#if APIARY_FLOWERS
  vec2 q = beesDriftQ(i, p);
#else
  vec2 c = vec2(BEES_PATCH_F[i] * beesW, BEES_PATCH_Y[i]);
  vec2 r = vec2(BEES_PATCH_RX[i] * beesW, BEES_PATCH_RY[i]);
  vec2 q = (p - c) / r;
#endif
  if (abs(q.x) > 1.25 || abs(q.y) > 1.25) return 0.0;
  float e = length(q) + 0.3 * (vnoise(p * vec2(7.0, 24.0) + float(i) * 5.3 + beesSeed) - 0.5) + 0.15 * (vnoise(p * vec2(19.0, 60.0) + float(i) * 2.0) - 0.5);
  return 1.0 - smoothstep(0.7, 1.0, e);
}

// The same without the fine noise, for the density of blooms at a point.
float beesPatchDensity(int i, vec2 p) {
#if APIARY_FLOWERS
  vec2 q = beesDriftQ(i, p);
#else
  vec2 q = (p - vec2(BEES_PATCH_F[i] * beesW, BEES_PATCH_Y[i])) / vec2(BEES_PATCH_RX[i] * beesW, BEES_PATCH_RY[i]);
#endif
  return 1.0 - smoothstep(0.5, 1.0, length(q) + 0.3 * (vnoise(p * vec2(7.0, 24.0) + float(i) * 5.3 + beesSeed) - 0.5));
}

// Lavender: six long narrow rows of rounded mounds running away from the viewer to the horizon, so they
// converge in perspective, with lanes of soil and grass between them. Each row is a string of low domes
// (the slices 0.3 m apart along it overlap into one ridge), lit on the side toward the sun and shaded on
// the other, its top textured with flower spikes, grey-green foliage at its foot. A pixel can lie on the
// slices of up to eight depths, nearest on top.
void beesLavender(vec2 p, float gust, inout vec3 col) {
  if (p.x > 0.0 || p.y > 0.34) return;
  float x0 = -6.2;
  float pitch = 0.8;
  float dy = max(BEES_YH - p.y, 0.03);
  float Zp = BEES_CAM / dy;
  float Xp = p.x * Zp;
  float lane = step(x0 - 0.5 * pitch, Xp) * step(Xp, x0 + 5.5 * pitch) * step(Zp, 9.2);
  vec3 soil = beesShade(vec3(0.58, 0.46, 0.28) * (0.85 + 0.3 * hash12(floor(vec2(Xp, Zp) * 7.0))), 0.0);
#if APIARY_FLOWERS
  col = mix(col, soil, 0.55 * lane * beesThin);
#else
  col = mix(col, soil, 0.55 * lane);
#endif
  float jTop = floor(Zp / 0.3);
  for (int m = 0; m < 8; m++) {
    float j = jTop - float(m);
    float Z = j * 0.3;
    if (Z < 2.0) break;
    float S = 1.0 / Z;
    float yb = BEES_YH - BEES_CAM / Z;
    float fi = floor((p.x * Z - x0) / pitch + 0.5);
    if (fi < 0.0 || fi > 5.0) continue;
#if APIARY_FLOWERS
    // Lusher, the rows run on toward the hives; thinner, each breaks into bushes a metre or so long,
    // fewer the thinner.
    if (Z > mix(7.2 + 1.8 * hash12(vec2(fi, 3.0 + beesSeed)), 9.0, beesLush)) continue;
    if (hash12(vec2(floor(j / 3.0), fi + 11.0 + beesSeed)) > K_flowers) continue;
#else
    if (Z > 7.2 + 1.8 * hash12(vec2(fi, 3.0 + beesSeed))) continue;
#endif
    float lump = 0.8 + 0.4 * vnoise1(Z * 1.4 + fi * 9.0 + beesSeed, 7.0).x;
#if APIARY_FLOWERS
    // And plumper.
    lump *= 1.0 + 0.15 * beesLush;
#endif
    vec2 r = vec2(0.24, 0.17) * S * lump;
    vec2 c = vec2((x0 + fi * pitch) * S, yb + 0.07 * S * lump);
    vec2 q = (p - c) / r;
    float e = length(q) + 0.1 * (vnoise(vec2(q.x * 5.0, Z * 3.0 + fi * 5.0)) - 0.5);
    if (e > 1.0 || p.y < yb - 0.02 * S) continue;
    if (hardFill((e - 1.0) * r.y, beesAa) < 0.5) continue;
    float lit = 0.5 + 0.5 * clamp(q.x * beesSunX * 1.4 + q.y * 0.7, -1.0, 1.0);
    float fineOk = smoothstep(5.0, 12.0, r.x / beesAa);
    float tex = (hash12(floor(vec2(q.x * 6.0, q.y * 4.0 + Z * 5.0) + fi * 13.0)) - 0.5) * 0.6 * fineOk * smoothstep(-0.2, 0.3, q.y);
    vec3 c3 = mix(vec3(0.26, 0.16, 0.48), vec3(0.72, 0.54, 0.95), clamp(lit * 0.9 + 0.2 * gust + tex, 0.0, 1.0));
#if APIARY_FLOWERS
    c3 = mix(c3, vec3(0.34, 0.40, 0.30), smoothfall(-0.15, -0.6, q.y) * 0.8 * (1.0 - 0.35 * beesLush));
#else
    c3 = mix(c3, vec3(0.34, 0.40, 0.30), smoothfall(-0.15, -0.6, q.y) * 0.8);
#endif
    // Lying snow on the bush's top (q in its radii: about 0.24 m across, 0.17 m up).
    c3 = mix(c3, BEES_SNOW, snowCover(vec3(0.0, smoothstep(-0.2, 0.6, q.y), 0.0), q * vec2(0.24, 0.17) + vec2(fi * 3.1, Z), beesLying));
    col = beesShade(c3, q.x * 0.7) + beesGlow(c3, 0.5 * smoothstep(0.6, 1.0, e) * max(lit, 0.3));
  }
}

// The blooms of a drift at p. They stand in rows a fixed step apart in log depth (so their size follows
// the perspective) but are jittered in both directions, vary about fivefold in size, come in clumps
// (noise) and thin toward the drift's edge; a few in each drift are another kind. Each pixel looks at
// its own row and the nearer of its neighbours, the farther row first; each sways in the composer's
// gust where the cell's ray meets the ground (gust). The flowers knob (APIARY_FLOWERS)
// scales how many of them open, each where it stood, and once the drifts have grown past their beds
// keeps them off the path; the lush garden (APIARY_LUSH) opens a second set in each row, half a place
// along from the first, from BEES_LUSH_FROM to all of them by 3.
void beesBlooms(int pi, int kind, vec2 p, float gust, float tm, inout vec3 col) {
  float dy = max(BEES_YH - p.y, 0.02);
  float u = log(BEES_CAM / dy) / BEES_ROW;
  float k0 = floor(u + 0.5);
  float k1 = k0 + (u > k0 ? 1.0 : -1.0);
  float sizeK = kind == BEES_POPPY ? 0.12 : kind == BEES_COSMOS ? 0.1 : 0.085;
  float seed = float(pi) * 13.7 + beesSeed;
#if APIARY_LUSH
  float second = clamp((K_flowers - BEES_LUSH_FROM) / (3.0 - BEES_LUSH_FROM), 0.0, 1.0);
#endif
  for (int r = 0; r < 2; r++) {
    float k = r == 0 ? max(k0, k1) : min(k0, k1);
    float dk = BEES_CAM * exp(-k * BEES_ROW);
    float yk = BEES_YH - dk;
    float sig = sizeK * dk;
    float off = hash12(vec2(k, seed));
    float c0 = floor(p.x / sig + off + 0.5);
    // Each bloom's place in its row (at), and what it is hashed by (id): the second set's own.
#if APIARY_LUSH
    float c0b = floor(p.x / sig + off);
    for (int cn = 0; cn < 6; cn++) {
      bool late = cn >= 3;
      float ci = (late ? c0b : c0) + float(late ? cn - 4 : cn - 1);
      float at = late ? ci + 0.5 : ci;
      float id = late ? ci + 1000.0 : ci;
#else
    for (int cj = -1; cj <= 1; cj++) {
      float ci = c0 + float(cj);
      float at = ci;
      float id = ci;
#endif
      vec2 h = hash22(vec2(id, k * 1.7 + seed));
      vec2 h2 = hash22(vec2(id + 17.0, k * 2.3 + seed));
      vec2 ctr = vec2((at - off + 0.9 * (h.x - 0.5)) * sig, yk + (h2.y - 0.5) * dk * BEES_ROW);
      float rr = 0.3 * sig * (0.3 + 1.3 * h.y * h.y);
      float ph = hash12(vec2(id, k) + 31.0) * 6.2831853;
      float sway = rr * 0.5 * (gust - 0.3) * (0.7 + 0.5 * sin(tm * 0.8 + ph));
      vec2 d = p - ctr - vec2(sway, 0.0);
      float dist = length(d);
      if (dist > rr * 1.15) continue;
      float dens = beesPatchDensity(pi, ctr) * (0.1 + 0.9 * smoothstep(0.35, 0.7, vnoise(ctr * vec2(11.0, 38.0) + seed)));
#if APIARY_LUSH
      dens *= late ? second : K_flowers;
#elif APIARY_FLOWERS
      dens *= K_flowers;
#endif
      if (h2.x > dens) continue;
#if APIARY_FLOWERS
      if (ctr.y < 0.4 && hash12(vec2(id, k) + 77.0) < 2.0 * (K_flowers - 1.0) && beesPathEdge(ctr) < 0.0) continue;
#endif
      int ke = kind;
      float hm = hash12(vec2(id, k) + 51.0);
      if ((kind == BEES_POPPY && hm < 0.2) || (kind == BEES_DAISY && hm < 0.15) || (kind == BEES_COSMOS && hm < 0.1)) ke = BEES_WILD;
      float th = atan(d.y, d.x);
      float edge = 1.0;
      vec3 petal = vec3(1.0);
      vec3 core = vec3(0.0);
      float coreR = 0.0;
      if (ke == BEES_POPPY) {
        edge = 0.9 + 0.1 * cos(4.0 * th + ph);
        petal = mix(vec3(1.0, 0.16, 0.08), vec3(1.0, 0.42, 0.10), h.y);
        core = vec3(0.10, 0.05, 0.06);
        coreR = 0.2;
      } else if (ke == BEES_DAISY) {
        edge = 0.82 + 0.18 * cos(9.0 * th + ph);
        petal = vec3(0.97, 0.96, 0.90);
        core = vec3(0.96, 0.78, 0.12);
        coreR = 0.36;
      } else if (ke == BEES_COSMOS) {
        edge = 0.88 + 0.12 * cos(8.0 * th + ph);
        petal = h.y < 0.4 ? vec3(0.92, 0.35, 0.62) : h.y < 0.75 ? vec3(0.96, 0.78, 0.86) : vec3(0.97, 0.95, 0.95);
        core = vec3(0.95, 0.72, 0.12);
        coreR = 0.28;
      } else {
        petal = hm < 0.3 ? vec3(0.98, 0.82, 0.16) : hm < 0.55 ? vec3(0.45, 0.50, 0.90) : hm < 0.8 ? vec3(0.95, 0.55, 0.70) : vec3(0.98, 0.95, 0.85);
      }
      if (hardFill(dist - rr * edge, beesAa * 0.8) < 0.5) continue;
      vec3 c = mix(beesShade(petal, d.x / rr), petal, 0.4) + beesGlow(petal, 0.55 * smoothstep(0.5, 1.0, dist / rr));
      if (coreR > 0.0 && rr / beesAa > 3.5) c = mix(c, beesShade(core, 0.0), hardFill(dist - rr * coreR, beesAa * 0.8));
      col = c;
    }
  }
}

void beesPatch(int i, vec2 p, float gust, float tm, inout vec3 col) {
  int kind = BEES_PATCH_KIND[i];
  if (kind == BEES_LAVENDER) {
    beesLavender(p, gust, col);
    return;
  }
  float cov = beesPatchCover(i, p);
#if APIARY_FLOWERS
  // Thinned, the drift's leaves and its mass of colour go with its blooms; grown past its bed, it
  // keeps off the path as its blooms do.
  cov *= beesThin;
  if (p.y < 0.4) cov *= 1.0 - hardFill(beesPathEdge(p), beesAa) * clamp(2.0 * (K_flowers - 1.0), 0.0, 1.0);
#endif
  if (cov <= 0.0) return;
  float seed = float(i) * 13.7 + beesSeed;
  float clump = smoothstep(0.3, 0.65, vnoise(p * vec2(11.0, 38.0) + seed));
  // Under lying snow the drift's leaves whiten with the lawn, its colour half showing through.
  vec3 lush = beesShade(mix(vec3(0.18, 0.42, 0.08) * (1.0 + 0.2 * gust), BEES_SNOW, beesSnowGround), 0.0);
  col = mix(col, lush, hardEdge(cov * 0.7) * 0.6);
  // A faint mass of the drift's colour under the blooms (none under poppies, which stay red on green),
  // broken by the clumps; far away the blooms are less than a cell and the drift is then only this tint.
  float dk = max(BEES_YH - p.y, 0.02);
  float rcFar = 0.33 * 0.1 * dk / beesAa;
  float far = 1.0 - smoothstep(1.0, 2.5, rcFar);
  vec3 tintCol = kind == BEES_POPPY ? vec3(0.9, 0.18, 0.1) : kind == BEES_DAISY ? vec3(0.9, 0.88, 0.72) : kind == BEES_COSMOS ? vec3(0.9, 0.5, 0.68) : vec3(0.85, 0.75, 0.45);
  float mass = hardEdge(cov * (0.2 + 0.8 * clump)) * ((kind == BEES_POPPY ? 0.0 : 0.1) + 0.4 * far);
  col = mix(col, beesShade(mix(tintCol, BEES_SNOW, 0.5 * beesSnowGround), 0.0), mass);
  beesBlooms(i, kind, p, gust, tm, col);
}

// ---- the orchard, the wall, the hives ------------------------------------------------------------------

// An old apple tree, wide and irregular: a gnarled trunk flaring at the foot and three limbs, a crown of
// lobes jittered, stretched and sized by the tree's seed, its outline ragged with leaves, sky showing
// through, the leaves dark inside and lit warm and golden along the sunward edge where the sun comes
// through them, a few apples.
void beesTree(int t, vec2 p, inout vec3 col) {
  float by = BEES_TREE_Y[t];
  float seed = BEES_TREE_SEED[t];
  float S = beesS(by) * BEES_TREE_S[t];
  vec2 q = (p - vec2(BEES_TREE_F[t] * beesW, by)) / S;
  if (abs(q.x) > 5.0 || q.y < -0.4 || q.y > 5.6) return;
  vec2 hh = hash22(vec2(seed, 2.0));
  float stretch = 0.85 + 0.4 * hh.x;
  vec2 a1 = vec2((hh.y - 0.5) * 0.5, 0.8);
  vec2 a2 = vec2(a1.x + (hash12(vec2(seed, 3.0)) - 0.5) * 0.7, 1.45);
  vec2 a3 = vec2(a2.x + (hash12(vec2(seed, 4.0)) - 0.5) * 0.6, 2.1);
  float dT = min(sdTaperCapsule(q, vec2(0.0, -0.1), a1, 0.34, 0.26), min(sdTaperCapsule(q, a1, a2, 0.26, 0.2), sdTaperCapsule(q, a2, a3, 0.2, 0.16)));
  dT = min(dT, sdEllipse(q, vec2(0.55, 0.2)));
  vec2 b1 = vec2(-1.4 - 0.9 * hh.x, 3.1);
  vec2 b2 = vec2(1.5 + 0.8 * hh.y, 3.2);
  vec2 b3 = vec2(a3.x - 0.2, 3.7);
  dT = min(dT, min(sdTaperCapsule(q, a3, b1, 0.14, 0.07), min(sdTaperCapsule(q, a3, b2, 0.13, 0.07), sdTaperCapsule(q, a3, b3, 0.12, 0.07))));
  dT += 0.03 * (vnoise(q * 6.0 + seed) - 0.5);
  if (hardFill(dT * S, beesAa) > 0.5) {
    vec3 bark = mix(vec3(0.22, 0.16, 0.11), vec3(0.45, 0.36, 0.26), vnoise(vec2(q.x * 8.0, q.y * 1.8) + seed));
    bark = mix(bark, vec3(0.5, 0.55, 0.4), 0.25 * step(0.7, vnoise(q * 5.0 + seed)));
    col = beesShade(bark, clamp((q.x - a1.x) * 3.0, -1.0, 1.0)) + beesGlow(bark, 0.15);
  }
  float dC = 1e3;
  for (int k = 0; k < 9; k++) {
    vec3 c = BEES_CROWN[k];
    c.xy += (hash22(vec2(float(k), seed + 1.0)) - 0.5) * vec2(1.1, 0.9);
    c.x *= stretch;
    c.z *= 0.8 + 0.45 * hash12(vec2(float(k) + 9.0, seed));
    dC = min(dC, length(q - c.xy) - c.z);
  }
  dC += 0.5 * (vnoise(q * 1.8 + seed) - 0.5) + 0.22 * (vnoise(q * 4.7 + vec2(3.0, seed)) - 0.5) + 0.1 * (vnoise(q * 11.0 + seed) - 0.5);
  if (hardFill(dC * S, beesAa * 1.2) < 0.5) return;
  float inner = clamp(-dC / 1.3, 0.0, 1.0);
  float gap = smoothstep(0.74, 0.86, vnoise(q * 3.3 + vec2(seed, 7.0))) * smoothstep(0.1, 0.6, inner);
  if (hardEdge(gap) > 0.5) return;
  float cluster = 0.6 * vnoise(q * 4.2 + seed) + 0.4 * vnoise(q * 9.0 + seed * 2.0);
  float l = 0.5 + 0.3 * (q.y - 3.2) / 1.8 - 0.55 * inner + 0.9 * (cluster - 0.5) + 0.3 * clamp(q.x / 2.5, -1.0, 1.0) * beesSunX * 1.4;
  l = clamp(l, 0.0, 1.0);
  vec3 leaf = mix(vec3(0.07, 0.17, 0.06), vec3(0.24, 0.42, 0.12), smoothstep(0.0, 0.6, l));
  leaf = mix(leaf, vec3(0.58, 0.70, 0.22), smoothstep(0.62, 1.0, l));
  leaf *= 0.92 + 0.16 * hash12(vec2(seed, 5.0));
  float nxl = clamp(q.x / 2.6, -1.0, 1.0);
  vec3 c = beesShade(leaf, nxl);
  // The sun through the thin leaves of the crown's edge and underside: warm gold; and bright spots inside.
  float rim = 1.0 - smoothstep(0.0, 0.55, -dC);
  c += beesGlow(leaf, 1.6 * rim * (0.5 + 0.5 * clamp(q.y / 4.0, 0.0, 1.0)));
  float spot = smoothstep(0.78, 0.9, vnoise(q * 6.1 + seed));
  c = mix(c, beesGlow(leaf, 1.8) + c * 0.6, spot * 0.5 * smoothstep(0.1, 0.5, inner));
  // Lying snow on the upper leaves (l: high and outer in the crown), lit but not shining through.
  c = mix(c, beesShade(BEES_SNOW, nxl), BEES_SNOW_CROWN * snowCover(vec3(0.0, smoothstep(0.35, 0.85, l), 0.0), q, beesLying));
  vec2 ap = q * 2.3;
  vec2 ah = hash22(floor(ap) + seed);
  if (ah.x > 0.975) {
    float apple = hardFill((length(fract(ap) - (0.5 + (ah - 0.5) * 0.5)) / 2.3 - 0.09) * S, beesAa);
    c = mix(c, beesShade(vec3(0.75, 0.2, 0.08), nxl) + beesGlow(vec3(0.75, 0.2, 0.08), 0.3), apple);
  }
  // Apple blossom clusters in the sunlit upper crowns of the two orchard trees the bees visit.
  if (seed > 5.0 && seed < 13.0) {
    vec2 bg = q * 3.4;
    vec2 bh = hash22(floor(bg) + seed * 3.0);
    float bd = length(fract(bg) - (0.5 + (bh - 0.5) * 0.5)) / 3.4;
    float bl = step(0.62, bh.x) * hardEdge((1.0 - smoothstep(0.11, 0.17, bd)) * smoothstep(0.15, 0.5, l));
    vec3 pink = mix(vec3(0.99, 0.90, 0.93), vec3(0.95, 0.62, 0.74), bh.y);
    c = mix(c, beesShade(pink, nxl) + beesGlow(pink, 0.4), bl);
  }
  col = c;
}

// The top of the dry-stone wall x metres along it, in metres above its foot.
float beesWallTop(float x) {
  return 0.85 + 0.12 * (vnoise1(x * 0.8 + 2.0, 2.0).x - 0.5) + 0.04 * (vnoise1(x * 4.1 + beesSeed, 7.0).x - 0.5);
}

#if APIARY_FAIRY
// The fairy lights (the fairyLights knob) run along the stone wall, from beyond the frame's left edge
// to the last pin before the gate; this many metres along the wall.
float beesFairyEnd() {
  return floor((BEES_GATE_0 * beesW / beesS(BEES_WALL_Y) - 0.3) / BEES_FAIRY_PIN) * BEES_FAIRY_PIN;
}

// Their wire x metres along the wall, in metres above its foot: pinned to the wall's top every
// BEES_FAIRY_PIN metres and sagging between the pins, each span by its own amount.
float beesFairyWire(float x) {
  float k = floor(x / BEES_FAIRY_PIN);
  float t = x / BEES_FAIRY_PIN - k;
  float sag = BEES_FAIRY_SAG * (0.75 + 0.5 * hash12(vec2(k, 5.3)));
  return mix(beesWallTop(k * BEES_FAIRY_PIN), beesWallTop((k + 1.0) * BEES_FAIRY_PIN), t) - 0.02 - 4.0 * sag * t * (1.0 - t);
}

// Their warm light on the stones at q (metres along the wall and up from its foot): strongest just
// under the wire and round each bulb, fading down the wall's face and faster over the wire.
vec3 beesFairyStones(vec2 q) {
  if (beesFairyOn <= 0.0 || q.x > beesFairyEnd()) return vec3(0.0);
  float below = beesFairyWire(q.x) - q.y;
  float along = (fract(q.x / BEES_FAIRY_STEP) - 0.5) * BEES_FAIRY_STEP;
  return BEES_FAIRY_WARM * beesFairyOn * 0.8 * exp(-max(below, -3.0 * below) / 0.18) * (0.5 + 0.5 * exp(-along * along / 0.01));
}

// The fairy lights over col at p: the wire and the bulbs hanging from it, by day a dark thread of
// pale beads; after dusk each bulb glows in a warm hue of its own, with a little glow in the air round
// it (the accent). The two bulbs either side of p are drawn. Returns how much of the wire or a bulb
// covers p, which hides the insects behind.
float beesFairy(vec2 p, inout vec3 col, inout float accent) {
  if (K_fairyLights <= 0.0) return 0.0;
  float S = beesS(BEES_WALL_Y);
  if (p.x > BEES_GATE_0 * beesW || p.y < BEES_WALL_Y + 0.45 * S || p.y > BEES_WALL_Y + 1.05 * S) return 0.0;
  vec2 q = vec2(p.x, p.y - BEES_WALL_Y) / S;
  float end = beesFairyEnd();
  if (q.x > end + 0.3) return 0.0;
  // A cell, in metres at the wall.
  float aa = beesAa / S;
  float wire = step(q.x, end) * hardFill((abs(q.y - beesFairyWire(q.x)) - max(0.006, 0.35 * aa)) * S, beesAa);
  col = mix(col, beesShade(vec3(0.10, 0.11, 0.09), 0.0), wire);
  float cover = wire;
  float rb = max(0.03, 0.6 * aa);
  float j0 = floor(q.x / BEES_FAIRY_STEP - 0.5);
  for (int k = 0; k < 2; k++) {
    float j = j0 + float(k);
    float bx = (j + 0.5) * BEES_FAIRY_STEP;
    if (bx > end) continue;
    vec2 d = q - vec2(bx, beesFairyWire(bx) - 0.035);
    float hue = hash12(vec2(j, 2.9));
    vec3 tint = hue < 0.4 ? vec3(1.0, 0.84, 0.56) : hue < 0.65 ? vec3(1.0, 0.62, 0.26) : hue < 0.85 ? vec3(1.0, 0.52, 0.44) : vec3(0.96, 0.9, 0.64);
    col += tint * beesFairyOn * 0.45 * exp(-dot(d, d) / (4.8 * rb * rb));
    if (hardFill((length(d * vec2(1.0, 0.8)) - rb) * S, beesAa) > 0.5) {
      col = mix(beesShade(vec3(0.86, 0.86, 0.8), 0.0), tint * 1.25, beesFairyOn);
      accent = max(accent, beesFairyOn);
      cover = 1.0;
    }
  }
  return cover;
}
#endif

// The dry-stone wall behind the garden, a gate for the path, and the wooden fence beyond it, lit by
// the lantern, and by the fairy lights along the stones.
void beesWall(vec2 p, inout vec3 col) {
  float S = beesS(BEES_WALL_Y);
  if (p.y < BEES_WALL_Y - 0.002 || p.y > BEES_WALL_Y + 1.1 * S) return;
  vec2 q = vec2(p.x, p.y - BEES_WALL_Y) / S;
#if APIARY_LANTERN
  beesLamp = localLight(vec3(q.x, q.y, 1.0 / S), vec3(0.0, 0.0, -1.0));
#endif
  float g0 = BEES_GATE_0 * beesW;
  float g1 = BEES_GATE_1 * beesW;
  if (p.x < g0) {
    float top = beesWallTop(q.x);
    if (hardEdge(softFill((q.y - top) * S, beesAa)) < 0.5 || q.y < -0.01) return;
    float course = q.y / 0.19;
    float row = floor(course);
    float u = q.x / 0.5 + hash12(vec2(row, 1.7)) * 7.0;
    float id = floor(u);
    float fu = fract(u);
    float fr = fract(course);
    float line = min(smoothstep(0.0, 0.14, fr), smoothstep(0.0, 0.07, fu) * smoothstep(0.0, 0.07, 1.0 - fu));
    vec3 stone = mix(vec3(0.52, 0.48, 0.42), vec3(0.74, 0.68, 0.58), hash12(vec2(id, row)));
    stone *= 0.85 + 0.3 * hash12(vec2(id, row + 9.0));
    stone = mix(vec3(0.2, 0.18, 0.15), stone, line);
    stone = mix(stone, vec3(0.30, 0.42, 0.16), smoothstep(0.7, 0.9, q.y / top) * smoothstep(0.35, 0.6, vnoise(vec2(q.x * 3.0, q.y * 2.0))));
    // Lying snow along the top (q in metres).
    stone = mix(stone, BEES_SNOW, snowCover(vec3(0.0, smoothstep(0.7, 0.95, q.y / top), 0.0), q, beesLying));
#if APIARY_FAIRY
    beesLamp += beesFairyStones(q);
#endif
    col = beesShade(stone, 0.0);
  } else if (p.x > g1) {
    float spacing = 1.15 * S;
    float lx = mod(p.x - g1, spacing) - 0.5 * spacing;
    float post = hardFill(sdBox(vec2(lx, p.y - BEES_WALL_Y - 0.5 * S), vec2(0.055 * S, 0.5 * S), 0.0), beesAa);
    float rails = max(hardFill(sdBox(vec2(0.0, p.y - BEES_WALL_Y - 0.38 * S), vec2(10.0, 0.035 * S), 0.0), beesAa), hardFill(sdBox(vec2(0.0, p.y - BEES_WALL_Y - 0.78 * S), vec2(10.0, 0.035 * S), 0.0), beesAa));
    vec3 wood = vec3(0.50, 0.40, 0.28);
    col = mix(col, beesShade(wood, 0.0) + beesGlow(wood, 0.15), max(post, rails));
  }
}

vec3 beesHivePaint(int i) {
  return i == 0 ? vec3(0.93, 0.91, 0.85) : i == 1 ? vec3(0.56, 0.73, 0.83) : vec3(0.95, 0.85, 0.46);
}

// A box hive in front view, 1.5 times life size so the entrance reads: legs, a plank and the landing
// board under the entrance slot, two boxes (the middle hive's front painted with the Manifold M), a
// pitched roof, its front lit by the lantern in front of it. The ground shadow is its claim's (the
// composer's casterShadow; the lantern's in beesLampShadow).
void beesHive(int i, vec2 p, inout vec3 col, inout float accent) {
  float by = BEES_HIVE_Y[i];
  float S = beesS(by) * BEES_HIVE_SCALE;
  vec2 q = (p - vec2(BEES_HIVE_F[i] * beesW, by)) / S;
  if (abs(q.x) > 0.5 || q.y < -0.1 || q.y > 1.2) return;
  float contact = hardFill(sdEllipse(q - vec2(0.0, -0.01), vec2(0.5, 0.07)) * S, beesAa * 2.0);
  col = mix(col, col * 0.6, contact * 0.7);
  if (q.y < 0.0) return;
#if APIARY_LANTERN
  float Zh = 1.0 / beesS(by);
  beesLamp = localLight(vec3(p.x * Zh, q.y * BEES_HIVE_SCALE, Zh), vec3(0.0, 0.0, -1.0));
#endif
  vec2 a = vec2(abs(q.x), q.y);
  float hw = 0.5 * BEES_HIVE_W;
  float legs = hardFill(sdBox(a - vec2(0.2, 0.5 * BEES_STAND), vec2(0.035, 0.5 * BEES_STAND), 0.0) * S, beesAa);
  col = mix(col, beesShade(vec3(0.36, 0.28, 0.20), 0.0), legs);
  float plank = hardFill(sdBox(a - vec2(0.0, BEES_STAND - 0.035), vec2(hw + 0.04, 0.0175), 0.0) * S, beesAa);
  col = mix(col, beesShade(vec3(0.42, 0.40, 0.38), 0.0), plank);
  float board = hardFill(sdBox(a - vec2(0.0, BEES_STAND - 0.012), vec2(BEES_BOARD_HALF, BEES_BOARD * 0.5), 0.0) * S, beesAa);
  col = mix(col, beesShade(vec3(0.82, 0.72, 0.55), 0.0) + beesGlow(vec3(0.82, 0.72, 0.55), 0.2), board);
  float boxes = hardFill(sdBox(a - vec2(0.0, BEES_STAND + BEES_BOX), vec2(hw, BEES_BOX), 0.0) * S, beesAa);
  if (boxes > 0.5) {
    vec3 paint = beesHivePaint(i);
    float sgn = beesSunX < 0.0 ? -1.0 : 1.0;
    float rim = smoothstep(0.17, 0.26, q.x * sgn);
    float seam = 1.0 - smoothstep(0.0, 0.014, abs(q.y - (BEES_STAND + BEES_BOX)));
    vec3 c = beesShade(paint * (1.0 - 0.18 * seam), 0.0) + beesGlow(paint, 0.3 * rim);
    c *= 1.0 - 0.1 * smoothstep(BEES_STAND, BEES_STAND + 2.0 * BEES_BOX, q.y);
    col = c;
    if (i == 1 && K_mark > 0.0) {
      vec2 m = (q - vec2(0.0, BEES_STAND + BEES_BOX)) / 0.46;
      float dm = (markDistance(m) - 0.085 * (0.8 + 0.5 * K_mark)) * 0.46;
      float paintM = hardFill(dm * S, beesAa);
      vec3 ochre = vec3(0.86, 0.56, 0.12);
      col = mix(col, beesShade(ochre, 0.0) + beesGlow(ochre, 0.3), paintM);
      accent = max(accent, paintM);
    }
  }
  float slot = hardFill(sdBox(a - vec2(0.0, BEES_STAND + 0.5 * BEES_SLOT), vec2(0.15, 0.5 * BEES_SLOT), 0.0) * S, beesAa);
  col = mix(col, vec3(0.16, 0.11, 0.07), slot);
  float roof = hardFill(sdBox(a - vec2(0.0, BEES_STAND + 2.0 * BEES_BOX + 0.5 * BEES_ROOF), vec2(hw + 0.06, 0.5 * BEES_ROOF), 0.01) * S, beesAa);
  float roofTop = smoothstep(0.55, 1.0, (q.y - (BEES_STAND + 2.0 * BEES_BOX)) / BEES_ROOF);
  // Lying snow on the roof's top.
  vec3 tin = mix(vec3(0.55, 0.58, 0.60), BEES_SNOW, snowCover(vec3(0.0, roofTop, 0.0), q * 4.0, beesLying));
  col = mix(col, beesShade(tin, 0.0) + beesGlow(tin, 0.35 * roofTop) + vec3(0.1, 0.12, 0.16) * roofTop, roof);
}

#if APIARY_LANTERN
// The lantern (the lantern knob) over col at p: a small square lantern hanging from an iron crook
// planted in the grass, its glass in a dark frame under a little pyramid cap and a ring. By day the
// glass holds the pale sky with the candle inside; after dusk the flame fills it with warm light (the
// accent), brightest round the wick, and the iron by it catches a little.
void beesLantern(vec2 p, float tm, vec3 haze, inout vec3 col, inout float accent) {
  if (K_lantern <= 0.0) return;
  float Z = beesLampPos.z;
  float reach = BEES_LANTERN_AT.w;
  // Metres from the crook's foot: x right, y up.
  vec2 q = vec2(p.x * Z - (beesLampPos.x - reach), (p.y - BEES_YH) * Z + BEES_CAM);
  float hang = BEES_LANTERN_AT.z;
  float bend = hang + 0.257;
  if (q.x < -0.1 || q.x > reach + 0.15 || q.y < -0.02 || q.y > bend + 0.5 * reach + 0.06) return;
  // It stands still, so its shapes are cut at each cell's middle, crisp rather than dithered, the
  // iron never under a cell wide.
  float rod = max(0.016, 0.5 * beesAa * Z);
  // The post, the crook bending over its top to the hook, and the ring on the hook.
  float dIron = sdBox(q - vec2(0.0, 0.5 * bend), vec2(rod, 0.5 * bend), 0.0);
  vec2 qa = q - vec2(0.5 * reach, bend);
  dIron = min(dIron, qa.y > 0.0 ? abs(length(qa) - 0.5 * reach) - rod : length(vec2(abs(qa.x) - 0.5 * reach, qa.y)) - rod);
  vec2 qb = q - vec2(reach, hang);
  dIron = min(dIron, abs(length(qb - vec2(0.0, 0.223)) - 0.026) - 0.7 * rod);
  // The lantern: the cap tapering from its eaves to the ring, the frame round the glass, its base.
  float capT = clamp((qb.y - 0.115) / 0.08, 0.0, 1.0);
  float dLamp = max(abs(qb.x) - mix(0.11, 0.025, capT), abs(qb.y - 0.155) - 0.04);
  dLamp = min(dLamp, sdBox(qb, vec2(0.085, 0.115), 0.006));
  dLamp = min(dLamp, sdBox(qb + vec2(0.0, 0.127), vec2(0.1, 0.014), 0.004));
  if (min(dIron, dLamp) > 0.0) return;
  // The flame's light on the iron, fading down the post.
  beesLamp = beesLampColor * 1.6 * exp(-2.2 * length(qb));
  col = beesShade(vec3(0.16, 0.15, 0.13), clamp(qb.x / 0.1, -1.0, 1.0));
  // The glass inside the frame (too thin to show from afar, where the lantern is then one glow): by
  // day the sky's pale light in it and the candle behind; lit, the flame.
  if (sdBox(qb, vec2(0.067, 0.097), 0.0) > 0.0) return;
  vec3 day = mix(haze, vec3(0.78, 0.82, 0.86), 0.4) * (0.62 + 0.2 * smoothstep(-0.1, 0.1, qb.y));
  if (sdBox(qb - vec2(0.0, -0.065), vec2(0.018, 0.035), 0.004) < 0.0) day = beesShade(vec3(0.92, 0.88, 0.76), 0.0);
  float flicker = 1.0 + 0.04 * sin(tm * 2.3 + 1.7 * sin(tm * 0.9));
  vec2 fq = (qb - vec2(0.0, -0.01)) / vec2(0.06, 0.09);
  vec3 lit = mix(vec3(1.0, 0.56, 0.2), vec3(1.0, 0.92, 0.66), exp(-dot(fq, fq))) * (0.75 + 0.45 * K_lantern) * flicker;
  col = mix(day, lit, beesDusk);
  accent = max(accent, beesDusk);
}
#endif

// ---- the foreground ------------------------------------------------------------------------------------

// A foxglove: a spike of nodding bells tapering to buds on a leaning stem, its leaves at the foot;
// standing only from its own flowers value (BEES_FOX_SHOW), lit by the lantern as a whole.
void beesFoxglove(int i, vec2 p, float tm, inout vec3 col) {
#if APIARY_FLOWERS
  if (K_flowers < BEES_FOX_SHOW[i]) return;
#endif
  float y0 = BEES_FOX_Y[i];
  float S = beesS(y0);
  float hgt = BEES_FOX_H[i] * S;
  float x0 = BEES_FOX_F[i] * beesW;
  // The near ones spring up from below the frame; the far ones stand where they are.
  if (y0 < 0.15) p.y += (y0 + 1.1 * hgt) * beesRise(float(i));
  float t = (p.y - y0) / hgt;
  if (t < -0.05 || t > 1.08 || abs(p.x - x0) > 0.45 * hgt) return;
#if APIARY_LANTERN
  beesLamp = localLight(vec3(x0 / S, 0.7 * BEES_FOX_H[i], 1.0 / S), vec3(0.0));
#endif
  float fi = float(i);
  float bend = (0.4 + 0.8 * abs(K_wind)) * 0.05 * hgt * sin(tm * 0.55 + fi * 2.1) + 0.04 * hgt * sin(fi * 1.9);
  float xc = x0 + bend * t * t;
  float across = p.x - xc;
  vec3 green = vec3(0.20, 0.38, 0.10);
  for (int k = 0; k < 3; k++) {
    float side = float(k) - 1.0;
    vec2 lq = rotate(p - vec2(x0 + side * 0.1 * hgt, y0 + 0.06 * hgt), side * 0.8);
    if (hardFill(sdEllipse(lq - vec2(0.0, 0.1 * hgt), vec2(0.04 * hgt, 0.17 * hgt)), beesAa) > 0.5) col = beesShade(green * (0.8 + 0.3 * fi / 8.0), side) + beesGlow(green, 0.2);
  }
  if (t < 0.0) return;
  float stem = hardFill(abs(across) - max(0.012 * S, 0.6 * beesAa), beesAa);
  col = mix(col, beesShade(green, clamp(across / (0.012 * S), -1.0, 1.0)), stem * step(t, 0.95));
  float bi = t * BEES_FOX_H[i] / 0.085;
  float scallop = 0.78 + 0.22 * (1.0 - abs(2.0 * fract(bi) - 1.0));
  float wS = 0.07 * S * (1.0 - 0.65 * smoothstep(0.42, 1.0, t)) * scallop;
  if (t > 0.4 && hardFill(abs(across) - wS, beesAa) > 0.5) {
    vec3 bell = mix(vec3(0.84, 0.34, 0.64), vec3(0.95, 0.70, 0.85), smoothstep(0.0, 1.0, fract(bi)));
    bell = mix(bell, vec3(0.72, 0.80, 0.50), smoothstep(0.9, 1.0, t));
    float spots = step(0.82, hash12(floor(vec2(across / (0.02 * S), t * BEES_FOX_H[i] / 0.03)))) * (1.0 - smoothstep(0.7, 0.95, t));
    bell = mix(bell, vec3(0.36, 0.08, 0.28), 0.7 * spots);
    float nx = clamp(across / max(wS, 1e-4), -1.0, 1.0);
    col = beesShade(bell, nx) + beesGlow(bell, 0.4 * max(nx * beesSunX, 0.0) + 0.15);
  }
}

// A poppy or a daisy close to the lens, petals and all, on its stem with two leaves; standing only
// from its own flowers value (BEES_BLOOM_SHOW), lit by the lantern as a whole.
void beesBloomNear(int i, vec2 p, float tm, inout vec3 col) {
#if APIARY_FLOWERS
  if (K_flowers < BEES_BLOOM_SHOW[i]) return;
#endif
  float yh = BEES_BLOOM_Y[i];
  float S = beesS(yh);
  float R = 0.13 * S;
  float fi = float(i);
  p.y += (yh + 0.03 + 1.5 * R) * beesRise(fi + 10.0);
  vec2 head = vec2(BEES_BLOOM_F[i] * beesW + 0.004 * (0.5 + abs(K_wind)) * sin(tm * 0.5 + fi * 2.3), yh);
  if (abs(p.x - head.x) > 3.0 * R || p.y > yh + 1.4 * R || p.y < -0.03) return;
#if APIARY_LANTERN
  beesLamp = localLight(vec3(BEES_BLOOM_F[i] * beesW / S, 0.4, 1.0 / S), vec3(0.0));
#endif
#if APIARY_LUSH
  // The lush garden's more lean as the first three do, in turn.
  float lean = mod(fi, 3.0) - 1.0;
#else
  float lean = fi - 1.0;
#endif
  float tt = clamp((p.y + 0.03) / (yh + 0.03), 0.0, 1.0);
  float sx = head.x - 0.18 * (1.0 - tt) * (1.0 - tt) * R * lean;
  vec3 green = vec3(0.20, 0.38, 0.10);
  if (p.y < yh && hardFill(abs(p.x - sx) - max(0.016 * S, 0.6 * beesAa), beesAa) > 0.5) col = beesShade(green, 0.0);
  for (int k = 0; k < 2; k++) {
    float side = float(k) * 2.0 - 1.0;
    vec2 lq = rotate(p - vec2(sx + side * 0.12 * R, yh * 0.35), side * 0.9);
    if (hardFill(sdEllipse(lq - vec2(0.0, 0.5 * R), vec2(0.28 * R, 1.0 * R)), beesAa) > 0.5) col = beesShade(green, side) + beesGlow(green, 0.25);
  }
  vec2 d = p - head;
  float r = length(d) / R;
  float th = atan(d.y, d.x);
  float ph = fi * 1.7;
  if (BEES_BLOOM_K[i] < 0.5) {
    float edge = 0.92 + 0.1 * cos(4.0 * th + ph) + 0.05 * cos(9.0 * th + ph * 2.0);
    if (hardFill((r - edge) * R, beesAa) < 0.5) return;
    vec3 petal = mix(vec3(0.84, 0.10, 0.06), vec3(0.98, 0.40, 0.12), smoothstep(0.3, 1.0, r));
    petal *= 1.0 - 0.14 * (0.5 + 0.5 * cos(14.0 * th + ph));
    petal = mix(petal, vec3(0.10, 0.04, 0.06), 1.0 - smoothstep(0.2, 0.3, r));
    float stamens = step(0.7, 0.5 + 0.5 * cos(22.0 * th)) * step(0.28, r) * (1.0 - smoothstep(0.34, 0.4, r));
    petal = mix(petal, vec3(0.92, 0.86, 0.5), stamens);
    col = beesShade(petal, d.x / R) + beesGlow(petal, 0.7 * smoothstep(0.4, 1.0, r));
  } else {
    float edge = 0.78 + 0.22 * pow(abs(cos(6.0 * th + ph)), 0.5);
    if (hardFill((r - edge) * R, beesAa) < 0.5) return;
    vec3 petal = vec3(0.97, 0.96, 0.9);
    petal = mix(petal, vec3(0.96, 0.78, 0.12), 1.0 - smoothstep(0.3, 0.38, r));
    col = beesShade(petal, d.x / R) + beesGlow(petal, 0.6 * smoothstep(0.4, 1.0, r));
  }
}

// ---- the apiary's passes ----
// The garden's middle, in its order (BEES_DRIFT_ORDER): the drifts on the ground, the orchard and the
// wall in their slot (beyond the reach of the garden's lights), the wild flowers along the wall's
// foot in front of them; the hives, far to near; the lantern. Each thing drawn that changes the cell
// notes its depth (beesAt), which hides a speck behind it.
void apiaryMiddle(Ctx x, inout Cell c) {
  vec2 p = beesP;
  float tm = x.tm;
#if APIARY_LANTERN || APIARY_FAIRY
  beesLamp = beesLampGround;
#endif
  vec3 before = c.col;
  for (int k = 0; k < BEES_DRIFT_ORDER.length(); k++) {
    int i = BEES_DRIFT_ORDER[k];
    if (i != BEES_ORCHARD_SLOT) {
      if (beesOnGround) {
        beesCut = hardEdge(beesGs);
        beesPatch(i, p, beesGustHere, tm, c.col);
        beesCut = 0.0;
      }
      continue;
    }
#if APIARY_LANTERN || APIARY_FAIRY
    beesLamp = vec3(0.0);
#endif
    for (int tree = 0; tree < BEES_TREE_N; tree++) {
      before = c.col;
      beesTree(tree, p, c.col);
      if (c.col != before) beesAt(c, BEES_CAM / (BEES_YH - BEES_TREE_Y[tree]));
    }
    before = c.col;
    beesWall(p, c.col);
    if (c.col != before) beesAt(c, BEES_CAM / (BEES_YH - BEES_WALL_Y));
#if APIARY_FAIRY
    if (beesFairy(p, c.col, c.accent) > 0.0) beesAt(c, BEES_CAM / (BEES_YH - BEES_WALL_Y));
#endif
#if APIARY_LANTERN || APIARY_FAIRY
    beesLamp = beesLampGround;
#endif
  }
  for (int k = 0; k < BEES_HIVE_N; k++) {
    int hi = BEES_HIVE_ORDER[k];
    before = c.col;
    beesHive(hi, p, c.col, c.accent);
    if (c.col != before) beesAt(c, BEES_CAM / (BEES_YH - BEES_HIVE_Y[hi]));
  }
#if APIARY_LANTERN
  before = c.col;
  beesLantern(p, tm, x.air.haze, c.col, c.accent);
  if (c.col != before) beesAt(c, beesLampPos.z);
#endif
}

// The near foxgloves and blooms, springing up through the passage.
void apiaryFront(Ctx x, inout Cell c) {
  vec2 p = beesP;
  for (int i = 0; i < BEES_FOX_N; i++) {
    vec3 before = c.col;
    beesFoxglove(i, p, x.tm, c.col);
    if (c.col != before) beesAt(c, BEES_CAM / (BEES_YH - BEES_FOX_Y[i]));
  }
  for (int i = 0; i < BEES_BLOOM_N; i++) {
    vec3 before = c.col;
    beesBloomNear(i, p, x.tm, c.col);
    if (c.col != before) beesAt(c, BEES_CAM / (BEES_YH - BEES_BLOOM_Y[i]));
  }
}

// Wet, the things standing in the garden take a sheen of the low sky where the cell still shows them,
// and the lantern's light glints in the wet ground round it.
void apiaryFrontVeil(Ctx x, inout Cell c) {
  if (beesWet <= 0.0) return;
  if (beesZ < 1e4 && c.z >= beesZ * 0.999) c.col += wetGloss(beesWet, BEES_WET_UP_THINGS) * x.air.haze * BEES_WET_SHEEN;
#if APIARY_LANTERN
  if (beesZ >= 1e4 && beesOnGround && c.z >= beesDepth * 0.999) c.col += wetGloss(beesWet, BEES_WET_UP_GROUND) * beesLampGround * 0.35;
#endif
}

// The garden's lights in the air (Weather in the world): the fog, the rain's veil and its drops round
// them lit, the more widely the thicker the air, where this cell's ray passes them rather than
// stopping short; and a little glow round the lantern in clear air too.
void apiaryAir(inout Ctx x, inout Cell c) {
#if APIARY_LANTERN || APIARY_FAIRY
  float thick = x.w.fog + 0.8 * x.w.rain + 0.6 * x.w.snow;
#endif
#if APIARY_LANTERN
  if (K_lantern > 0.0) {
    // Metres from the flame, at its depth.
    vec2 hv = (beesP - vec2(0.0, BEES_YH)) * beesLampPos.z - vec2(beesLampPos.x, beesLampPos.y - BEES_CAM);
    float r2 = dot(hv, hv);
    vec3 glow = beesLampColor * smoothstep(beesLampPos.z - 1.0, beesLampPos.z + 0.5, c.z);
    c.col += glow * 0.1 * exp(-r2 / 0.05);
    x.air.fog += glow * exp(-r2 / (0.15 + 0.8 * thick));
    x.air.drop += glow * 2.5 * exp(-r2 / 1.5);
  }
#endif
#if APIARY_FAIRY
  if (beesFairyOn > 0.0) {
    // Metres along the wall and from the string's height, as far along as it runs.
    float sw = beesS(BEES_WALL_Y);
    float hy = (beesP.y - BEES_WALL_Y) / sw - 0.72;
    float run = 1.0 - smoothstep(-0.3, 0.3, beesP.x / sw - beesFairyEnd());
    vec3 glow = BEES_FAIRY_WARM * beesFairyOn * run * smoothstep(1.0 / sw - 1.0, 1.0 / sw + 0.5, c.z) * exp(-hy * hy / (0.1 + 0.5 * thick));
    x.air.fog += glow * 0.5;
    x.air.drop += glow;
  }
#endif
}
`;

/** The insects' GLSL: what each code of theirs in the shared speck map looks like. */
export const insectsGlsl = `
// ---- the insects' codes in the shared speck map (bees/shader.ts) ----
const int BEES_C_BEE = ${BEES_CODE.bee};
const int BEES_C_WING = ${BEES_CODE.beeWing};
const int BEES_C_LOADED = ${BEES_CODE.beeLoaded};
const int BEES_C_BODY = ${BEES_CODE.butterflyBody};
const int BEES_C_ORANGE = ${BEES_CODE.orange};
const int BEES_C_WHITE = ${BEES_CODE.white};
const int BEES_C_BLUE = ${BEES_CODE.blue};
const int BEES_C_ORANGE_DIM = ${BEES_CODE.orangeDim};
const int BEES_C_WHITE_DIM = ${BEES_CODE.whiteDim};
const int BEES_C_BLUE_DIM = ${BEES_CODE.blueDim};
const int BEES_C_DIM = ${BEES_CODE.beeDim};
const int BEES_C_FAINT = ${BEES_CODE.beeFaint};
const int BEES_C_SWARM = ${BEES_CODE.swarm};
const int BEES_C_BUMBLE = ${BEES_CODE.bumblebee};
const int BEES_C_BAND = ${BEES_CODE.bumblebeeBand};
const int BEES_C_HOVER = ${BEES_CODE.hoverfly};
const int BEES_C_DRAGON = ${BEES_CODE.dragonfly};
const int BEES_C_DRAGON_WING = ${BEES_CODE.dragonflyWing};
const int BEES_C_FIREFLY = ${BEES_CODE.firefly};
const int BEES_C_GLOW = ${BEES_CODE.fireflyGlow};
const int BEES_C_WORM = ${BEES_CODE.glowworm};
const int BEES_C_WORM_GLOW = ${BEES_CODE.glowwormGlow};
// The afternoon light a speck's colour (beesSpeck) is as seen in (SPECK_DAY).
const vec3 BEES_SPECK_DAY = vec3(${SPECK_DAY.map(glslFloat).join(", ")});

// What the simulation's cell map holds, each as seen in the afternoon light (BEES_SPECK_DAY) and lit
// by 'light' (the light here over that one): a bee (near-black, a golden back cell with pollen), the
// pale glint of its wing, a butterfly's wings and body; the honey-brown mass of a swarm's cluster, a
// bumblebee's black fur and yellow band, an amber hoverfly, a blue dragonfly and the glint of its
// wings; a far bee and a wing part speck, part what is under them. The lights are their own: a
// firefly's yellow-green flash, a glow-worm's steady green, and the glow of either, which lights what
// is under it.
vec3 beesSpeck(int code, vec3 under, vec3 light) {
  if (code == BEES_C_BEE) return vec3(0.05, 0.03, 0.02) * light;
  if (code == BEES_C_DIM) return mix(under, vec3(0.05, 0.03, 0.02) * light, 0.6);
  if (code == BEES_C_FAINT) return mix(under, vec3(0.05, 0.03, 0.02) * light, 0.4);
  if (code == BEES_C_LOADED) return vec3(1.0, 0.75, 0.10) * light;
  if (code == BEES_C_WING) return mix(under, vec3(1.0, 1.0, 0.94) * light, 0.95);
  if (code == BEES_C_BODY) return vec3(0.12, 0.08, 0.06) * light;
  if (code == BEES_C_ORANGE) return vec3(1.0, 0.55, 0.05) * light;
  if (code == BEES_C_WHITE) return vec3(1.0, 1.0, 0.97) * light;
  if (code == BEES_C_BLUE) return vec3(0.30, 0.55, 1.0) * light;
  if (code == BEES_C_ORANGE_DIM) return vec3(0.62, 0.30, 0.08) * light;
  if (code == BEES_C_WHITE_DIM) return vec3(0.78, 0.76, 0.66) * light;
  if (code == BEES_C_SWARM) return vec3(0.55, 0.32, 0.06) * light;
  if (code == BEES_C_BUMBLE) return vec3(0.06, 0.05, 0.04) * light;
  if (code == BEES_C_BAND) return vec3(1.0, 0.80, 0.22) * light;
  if (code == BEES_C_HOVER) return vec3(0.70, 0.50, 0.08) * light;
  if (code == BEES_C_DRAGON) return vec3(0.10, 0.45, 0.70) * light;
  if (code == BEES_C_DRAGON_WING) return mix(under, vec3(0.92, 0.97, 1.0) * light, 0.8);
  if (code == BEES_C_FIREFLY) return vec3(0.85, 1.0, 0.35);
  if (code == BEES_C_GLOW) return min(under + vec3(0.30, 0.40, 0.08), vec3(1.0));
  if (code == BEES_C_WORM) return vec3(0.55, 1.0, 0.42);
  if (code == BEES_C_WORM_GLOW) return min(under + vec3(0.12, 0.34, 0.12), vec3(1.0));
  return vec3(0.22, 0.34, 0.66) * light;
}

// A speck of the insects' at this cell, lit by the light here as the garden is (the lights in the
// grass shine on their own); the composer then sets it in the air at its own depth.
vec3 insectsSpeck(int code, vec3 under, Ctx x) {
  return beesSpeck(code, under, (beesAmb * 0.55 + beesSun * 0.5 * min(beesLit, 1.0)) / BEES_SPECK_DAY);
}
`;

/** Each bed as gardeningGlsl takes it: its depth, its kind's height and head, the band of rows it can show in. */
const BEDS = BEES_BED_ROWS.map((row) => {
  const z = BEES_CAM / (BEES_YH - row.y);
  const tall = BED_TALL[row.kind] ?? 0.3;
  const head = BED_HEAD[row.kind] ?? 0.04;
  return {
    ...row,
    z,
    tall,
    head,
    low: BEES_YH - BEES_CAM / (z - 1.4 * BEES_BED_DEPTH - 0.02),
    top: row.y + (1.2 * tall + head + 0.06) / z,
  };
});

/**
 * The gardening chore's GLSL: the beds it tends on the apiary's lawn (beds.ts, the host's state, which
 * its sim mirrors into its records: gardening.ts), drawn after the apiary's middle, each where it is
 * nearer than what the cell shows. Only a program drawn while the cast has agents (PRINCIPAL_CURSORS,
 * shaders/index.ts CURSORS_GATE) holds them: without agents there are no beds (the chore gives them
 * back to the lawn), so the garden's own program carries none of their cost.
 */
export const gardeningGlsl = `
// ---- the beds the gardening chore tends (bees/shader.ts; beds.ts, gardening.ts) ----
#ifdef PRINCIPAL_CURSORS
const int GARDENING_ROWS = ${BEDS.length};
const float GARDENING_F[${BEDS.length}] = ${floats(BEDS.map((b) => b.f))};
const float GARDENING_Y[${BEDS.length}] = ${floats(BEDS.map((b) => b.y))};
const float GARDENING_Z[${BEDS.length}] = ${floats(BEDS.map((b) => b.z))};
const float GARDENING_LOW[${BEDS.length}] = ${floats(BEDS.map((b) => b.low))};
const float GARDENING_TOP[${BEDS.length}] = ${floats(BEDS.map((b) => b.top))};
const int GARDENING_N[${BEDS.length}] = ${ints(BEDS.map((b) => b.plants))};
const int GARDENING_KIND[${BEDS.length}] = ${ints(BEDS.map((b) => b.kind))};
const float GARDENING_TALL[${BEDS.length}] = ${floats(BEDS.map((b) => b.tall))};
const float GARDENING_HEAD[${BEDS.length}] = ${floats(BEDS.map((b) => b.head))};
const float GARDENING_SPACING = ${glslFloat(BEES_BED_SPACING)};
const float GARDENING_DEPTH = ${glslFloat(BEES_BED_DEPTH)};
const float GARDENING_SOW = ${glslFloat(BED_SOW_SECONDS)};
const float GARDENING_GROW = ${glslFloat(BED_GROW_SECONDS)};
// Metres between two weeds' tufts along a bed, and how far before and behind its middle they stand.
const float GARDENING_TUFT = 0.11;
const float GARDENING_TUFT_Z = 0.09;

// Bed k's soil (its middle xm metres right of the centre line and z ahead; st its record: dug, sown,
// age, weeds) where this cell shows the ground: dug out from its middle as far as st.x, its edges
// ragged, clods of earth lighter and darker, a drill line down its middle as far as it is sown, and
// the lawn back over it in patches as its weeds thicken; whitened by lying snow with the lawn.
void gardeningSoil(int k, float xm, float z, vec4 st, inout Cell c) {
  if (!beesOnGround || c.z < beesDepth * 0.999) return;
  vec2 w = beesXz;
  float halfLen = 0.5 * float(GARDENING_N[k]) * GARDENING_SPACING;
  float rag = vnoise(w * 7.0 + float(k) * 3.7) - 0.5;
  float d = max(abs(w.y - z) - GARDENING_DEPTH * (1.0 + 0.35 * rag), abs(w.x - xm) - st.x * halfLen - 0.05 * rag);
  if (hardFill(d / w.y, beesAa) < 0.5) return;
  if (vnoise(w * 4.5 + float(k) * 5.1) < 1.25 * st.w - 0.15) return;
  vec3 soil = vec3(0.36, 0.25, 0.15) * (0.78 + 0.4 * hash12(floor(w * 14.0) + float(k) * 9.0));
  if (abs(w.x - xm) < st.y * halfLen) soil *= 1.0 - 0.3 * hardFill((abs(w.y - z) - 0.035) / w.y, beesAa);
  beesCut = hardEdge(beesGs);
#if APIARY_LANTERN || APIARY_FAIRY
  beesLamp = beesLampGround;
#endif
  c.col = beesShade(mix(soil, BEES_SNOW, beesSnowGround), 0.0);
  beesCut = 0.0;
}

// Bed k's weeds (how thick: weeds), tufts of coarse grass coming up through its soil one after
// another, before and behind its middle in turn, and on some a dandelion's head once they are thick;
// the three nearest this column, each where it is nearer than what the cell shows.
void gardeningWeeds(int k, float xm, float z, float weeds, inout Cell c) {
  if (weeds < 0.04) return;
  float halfLen = 0.5 * float(GARDENING_N[k]) * GARDENING_SPACING;
  vec2 p = beesP;
  float j0 = floor((p.x * z - xm + halfLen) / GARDENING_TUFT);
  for (int m = -1; m <= 1; m++) {
    float j = j0 + float(m);
    if (j < 0.0 || j * GARDENING_TUFT > 2.0 * halfLen) continue;
    vec2 h = hash22(vec2(j, float(k) * 5.0 + 11.0));
    float grown = clamp((1.15 * weeds - h.x) * 4.0, 0.0, 1.0);
    float zt = z + (mod(j, 2.0) < 0.5 ? -GARDENING_TUFT_Z : GARDENING_TUFT_Z);
    if (grown <= 0.0 || zt >= c.z) continue;
    float S = 1.0 / zt;
    vec2 foot = vec2((xm - halfLen + (j + 0.5 + 0.6 * (h.y - 0.5)) * GARDENING_TUFT) * S, BEES_YH - BEES_CAM * S);
    float ht = (0.05 + 0.05 * h.y) * grown;
    vec2 q = (p - foot) / (vec2(0.035, ht) * S);
    float e = length(q) + 0.3 * abs(sin(q.x * 7.0 + h.y * 6.0)) * smoothstep(0.0, 1.0, q.y);
    if (q.y < -0.05 || hardFill((e - 1.0) * ht * S, beesAa) < 0.5) continue;
    vec3 green = mix(vec3(0.13, 0.30, 0.08), vec3(0.34, 0.50, 0.15), clamp(q.y, 0.0, 1.0));
    vec3 col = beesShade(mix(green, BEES_SNOW, 0.5 * beesLying), q.x * 0.6);
    if (h.y < 0.3 && weeds > 0.45 && length(p - foot - vec2(0.0, ht * S)) < 0.02 * S) col = beesShade(vec3(0.98, 0.80, 0.12), 0.0);
    c.col = col;
    beesAt(c, zt);
  }
}

// One plant at growth g, in metres from its stem's foot (q: right, up): two seed leaves, then a stem
// rising to its height (tall) with a pair of leaves, leaning lean metres at its top, then its bud
// swelling and opening into the kind's flower (head radius headR) over 0.6..0.95 of its growth.
void gardeningPlant(int kind, vec2 q, float g, float tall, float headR, float lean, vec2 h, float S, inout vec3 col) {
  vec3 green = mix(vec3(0.18, 0.38, 0.09), BEES_SNOW, 0.4 * beesLying);
  float L = 0.02 + 0.05 * smoothstep(0.02, 0.4, g);
  for (int k = 0; k < 2; k++) {
    float side = float(k) * 2.0 - 1.0;
    vec2 lq = rotate(q - vec2(0.0, 0.2 * L), side * 1.0);
    if (hardFill(sdEllipse(lq - vec2(0.0, 0.5 * L), vec2(0.3 * L, 0.55 * L)) * S, beesAa) > 0.5) col = beesShade(green, side) + beesGlow(green, 0.25);
  }
  if (g < 0.12) return;
  float stem = tall * smoothstep(0.12, 0.75, g);
  vec2 top = vec2(lean, stem);
  float r = max(0.006, 0.6 * beesAa / S);
  if (hardFill(sdTaperCapsule(q, vec2(0.0), top, r, 0.8 * r) * S, beesAa) > 0.5) col = beesShade(green, clamp(q.x / r, -1.0, 1.0));
  if (g > 0.3) {
    float ll = 0.07 * smoothstep(0.3, 0.6, g);
    for (int k = 0; k < 2; k++) {
      float side = float(k) * 2.0 - 1.0;
      vec2 lq = rotate(q - vec2(0.12 * lean, 0.35 * stem), side * 0.9);
      if (hardFill(sdEllipse(lq - vec2(0.0, 0.5 * ll), vec2(0.25 * ll, 0.5 * ll)) * S, beesAa) > 0.5) col = beesShade(green, side) + beesGlow(green, 0.3);
    }
  }
  if (g < 0.6) return;
  float open = smoothstep(0.8, 0.95, g);
  float rr = headR * mix(0.45, 1.0, smoothstep(0.6, 0.95, g));
  vec2 d = q - top;
  float dist = length(d);
  if (dist > 1.2 * rr) return;
  float th = atan(d.y, d.x);
  float ph = h.x * 6.2831853;
  float edge = 1.0;
  vec3 petal;
  vec3 core = vec3(0.0);
  float coreR = 0.0;
  if (kind == BEES_POPPY) {
    edge = 0.9 + 0.1 * cos(4.0 * th + ph);
    petal = mix(vec3(1.0, 0.16, 0.08), vec3(1.0, 0.42, 0.10), h.y);
    core = vec3(0.10, 0.05, 0.06);
    coreR = 0.25;
  } else if (kind == BEES_DAISY) {
    edge = 0.82 + 0.18 * cos(9.0 * th + ph);
    petal = vec3(0.97, 0.96, 0.90);
    core = vec3(0.96, 0.78, 0.12);
    coreR = 0.36;
  } else if (kind == BEES_COSMOS) {
    edge = 0.88 + 0.12 * cos(8.0 * th + ph);
    petal = h.y < 0.4 ? vec3(0.92, 0.35, 0.62) : h.y < 0.75 ? vec3(0.96, 0.78, 0.86) : vec3(0.97, 0.95, 0.95);
    core = vec3(0.95, 0.72, 0.12);
    coreR = 0.28;
  } else {
    petal = h.y < 0.3 ? vec3(0.98, 0.82, 0.16) : h.y < 0.55 ? vec3(0.45, 0.50, 0.90) : h.y < 0.8 ? vec3(0.95, 0.55, 0.70) : vec3(0.98, 0.95, 0.85);
  }
  // The bud: green and closed, colouring as it opens.
  edge = mix(0.75, edge, open);
  petal = mix(vec3(0.30, 0.46, 0.14), petal, open);
  if (hardFill((dist - rr * edge) * S, beesAa * 0.8) < 0.5) return;
  col = mix(beesShade(petal, d.x / rr), petal, 0.4 * open) + beesGlow(petal, 0.55 * smoothstep(0.5, 1.0, dist / rr));
  if (coreR > 0.0 && open > 0.5 && rr * S / beesAa > 3.0) col = mix(col, beesShade(core, 0.0), hardFill((dist - rr * coreR) * S, beesAa * 0.8));
}

// Bed k's plants, sown out from its middle as far as st.y: each comes up |u| * GARDENING_SOW seconds
// after the first seed (st.z its age), grows at its own rate, sways with the composer's gust at the
// bed, and is gone once the weeds have choked it (its share of them at or under lost), each hashed as
// beds.ts hashes it. The two nearest this column, shaded by what casts on the bed there.
void gardeningPlants(Ctx x, int k, float xm, float z, vec4 st, float lost, inout Cell c) {
  if (st.y <= 0.0 || z >= c.z) return;
  int n = GARDENING_N[k];
  vec2 p = beesP;
  float S = 1.0 / z;
  float at = (p.x * z - xm) / GARDENING_SPACING + 0.5 * float(n);
  float i0 = floor(at);
  float i1 = at - i0 < 0.5 ? i0 - 1.0 : i0 + 1.0;
  float gust = clamp(gustAt(x.gust, vec2(xm, z), x.tm, 0.0), 0.0, 1.0);
  float key = 7.0 * float(k) + 3.0;
  vec3 before = c.col;
  beesCut = hardEdge(casterShadow(vec2(p.x * z, z), x));
#if APIARY_LANTERN
  beesLamp = localLight(vec3(xm, 0.3, z), vec3(0.0));
#endif
  for (int m = 0; m < 2; m++) {
    float fi = m == 0 ? i1 : i0;
    if (fi < 0.0 || fi >= float(n)) continue;
    float u = (2.0 * fi + 1.0) / float(n) - 1.0;
    if (abs(u) > st.y || 0.45 + 0.5 * hash12(vec2(fi + 41.0, key)) <= lost) continue;
    float g = clamp((st.z - abs(u) * GARDENING_SOW) * (0.85 + 0.3 * hash12(vec2(fi + 17.0, key))) / GARDENING_GROW, 0.0, 1.0);
    if (g < 0.02) continue;
    vec2 h = hash22(vec2(fi, key));
    float xr = xm + (fi + 0.5 - 0.5 * float(n) + 0.35 * (h.x - 0.5)) * GARDENING_SPACING;
    float tall = GARDENING_TALL[k] * (0.8 + 0.4 * h.y);
    float stem = tall * smoothstep(0.12, 0.75, g);
    float lean = stem * (0.08 * (h.x - 0.5) + 0.12 * (gust - 0.3) * x.gust.dir.x);
    gardeningPlant(GARDENING_KIND[k], (p - vec2(xr * S, GARDENING_Y[k])) / S, g, tall, GARDENING_HEAD[k], lean, h, S, c.col);
  }
  beesCut = 0.0;
  if (c.col != before) beesAt(c, z);
}

#endif

// The beds, after the apiary's middle: each one dug (its record's x above 0) in the band of the
// frame it can show in, its soil, then its weeds, then its plants.
void gardeningMiddle(Ctx x, inout Cell c) {
#ifdef PRINCIPAL_CURSORS
  if (!gardeningSimOn() || gardeningRecord(0, 0).x < 0.5) return;
  vec2 p = beesP;
  for (int k = 0; k < GARDENING_ROWS; k++) {
    float z = GARDENING_Z[k];
    float xc = GARDENING_F[k] * beesW;
    float halfLen = 0.5 * float(GARDENING_N[k]) * GARDENING_SPACING;
    if (p.y < GARDENING_LOW[k] || p.y > GARDENING_TOP[k] || abs(p.x - xc) > (halfLen + 0.3) / z) continue;
    vec4 st = gardeningRecord(1 + 2 * k, 0);
    if (st.x <= 0.0) continue;
    float xm = xc * z;
    gardeningSoil(k, xm, z, st, c);
    gardeningWeeds(k, xm, z, st.w, c);
    gardeningPlants(x, k, xm, z, st, gardeningRecord(2 + 2 * k, 0).x, c);
  }
#endif
}
`;
