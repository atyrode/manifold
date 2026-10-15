// A summer hillside, painted: separate towering cumulus over a deep blue sky, rolling layered hills
// (patchwork fields, hedgerows, tree clumps, a farmhouse, a windmill on a crest), an old orchard behind a
// dry-stone wall, a path and three pastel box hives in a garden of flower drifts (lavender bushes in
// rows, poppies, daisies, wild flowers, cosmos, foxgloves), seen from eye level in the low light of a
// warm afternoon. The bees and butterflies are specks: the simulation (sim.ts) draws them into a map of
// dither cells and the shader reads it back one texel per cell.
//
// The garden is a ground plane in perspective (sim.ts: horizon BEES_YH, eye BEES_CAM above it): a metre
// at row y is beesS(y) screen heights, and a point of the picture has ground coordinates w = (X, Z) in
// metres. Flower drifts are irregular scatters of blooms of every size, set in rows a step apart in log
// depth with their positions jittered, thinned toward the edge of a drift and clumped by noise;
// lavender is rounded bushes in perspective rows. The sun stands behind the scene to the left, so trees
// and hives throw long soft shadows across the grass toward the viewer (`beesGroundShadow`), dappled
// under the crowns, and clouds throw theirs over the land (`beesCut`). All of them are switched per cell
// against the dither, so a passing edge flips each cell once. Wind runs through the grass as slow
// travelling swells of paler light (`beesGust`).
//
// Passage (BEES_PASSAGE): the cumulus (and their shadows) drift in from the sides and settle, then the
// near foxgloves, poppies, daisies and blades of grass at the bottom edge spring up into the frame, each
// after its own delay, with a small overshoot; the bees and butterflies are the simulation's. On the
// way out the clouds drift on a little. At rest every term is exactly 0.
//
// Knobs read here: K_time, K_cycle, K_clouds, K_wind, K_scenerySeed, K_mark (the M painted on the
// middle hive's front), and the shared sky components over the valley (src/scenes/README.md, "Composing
// components"): K_stars, K_moon (SKY_MOON_PHASE), K_aurora and K_meteors, behind the cumulus.
import { glslFloat } from "../../shaders/glsl.ts";
import {
  BEES_BOARD_HALF,
  BEES_CAM,
  BEES_CODE,
  BEES_COSMOS,
  BEES_DAISY,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_LAVENDER,
  BEES_PATCHES,
  BEES_PASSAGE,
  BEES_POPPY,
  BEES_STAGE_MIN,
  BEES_WILD,
  BEES_DEPTH_STEP,
  BEES_YH,
} from "./sim.ts";

function floats(values: readonly number[]): string {
  return `float[${values.length}](${values.map(glslFloat).join(", ")})`;
}

function ints(values: readonly number[]): string {
  return `int[${values.length}](${values.join(", ")})`;
}

/** Hives far to near, so a nearer one is drawn over a farther. */
const HIVE_ORDER = BEES_HIVES.map((hive, i) => ({ hive, i })).sort((a, b) => b.hive.y - a.hive.y).map((entry) => entry.i);

/** Foxgloves in the foreground: x (fraction of the stage), the y of their feet, height (m). */
const FOXGLOVES: readonly (readonly [number, number, number])[] = [
  [-0.92, 0.035, 1.2],
  [-0.8, 0.075, 1.0],
  [0.83, 0.04, 1.15],
  [0.93, 0.09, 1.0],
  [0.5, 0.28, 1.0],
  [0.45, 0.3, 0.9],
];

/** Foreground blooms with their petals drawn: x, the y of the head, kind (0 poppy, 1 daisy). */
const BLOOMS: readonly (readonly [number, number, number])[] = [
  [-0.5, 0.11, 0],
  [-0.33, 0.06, 1],
  [0.55, 0.07, 0],
];

/** The orchard, far to near: x (fraction of the stage), the y of the trunk's foot, size, seed. */
const TREES: readonly (readonly [number, number, number, number])[] = [
  [-0.74, 0.389, 0.65, 3.1],
  [0.62, 0.388, 0.75, 19.4],
  [-0.22, 0.385, 1.0, 7.7],
  [0.2, 0.383, 0.85, 12.3],
];

/** The cumulus, small ones first: x (fraction of the stage), the y of the flat base, width scale, height factor, seed. */
const CLOUDS: readonly (readonly [number, number, number, number, number])[] = [
  [0.05, 0.69, 0.07, 0.6, 4.1],
  [-0.85, 0.6, 0.06, 0.55, 9.3],
  [0.68, 0.73, 0.055, 0.6, 14.9],
  [-0.38, 0.66, 0.26, 0.85, 21.7],
  [0.95, 0.63, 0.2, 0.8, 30.2],
  [0.42, 0.64, 0.3, 0.85, 41.3],
];
const CLOUD_PUFFS = 3;

/** Trigger slot of the shooting stars' "now" button. */
export const BEES_METEOR_TRIGGER = 0;

export const beesGlsl = `
// Where shooting stars set out, in screen heights (p): the sky over the hills, among the cumulus.
const int BEES_METEOR_SLOT = ${BEES_METEOR_TRIGGER};
const vec4 BEES_METEOR_FIELD = vec4(-0.55, 0.8, 1.1, 0.12);
const float BEES_YH = ${glslFloat(BEES_YH)};
const float BEES_CAM = ${glslFloat(BEES_CAM)};
const float BEES_STAGE_MIN = ${glslFloat(BEES_STAGE_MIN)};
const float BEES_FOV = ${glslFloat(2 * Math.atan(0.5))};
// The view turns this far left of the sky library's 'ahead' so the afternoon sun stands upper left.
const float BEES_TURN = 0.3;
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
const int BEES_FOX_N = ${FOXGLOVES.length};
const float BEES_FOX_F[${FOXGLOVES.length}] = ${floats(FOXGLOVES.map((f) => f[0]))};
const float BEES_FOX_Y[${FOXGLOVES.length}] = ${floats(FOXGLOVES.map((f) => f[1]))};
const float BEES_FOX_H[${FOXGLOVES.length}] = ${floats(FOXGLOVES.map((f) => f[2]))};
const int BEES_BLOOM_N = ${BLOOMS.length};
const float BEES_BLOOM_F[${BLOOMS.length}] = ${floats(BLOOMS.map((b) => b[0]))};
const float BEES_BLOOM_Y[${BLOOMS.length}] = ${floats(BLOOMS.map((b) => b[1]))};
const float BEES_BLOOM_K[${BLOOMS.length}] = ${floats(BLOOMS.map((b) => b[2]))};
const int BEES_TREE_N = ${TREES.length};
const float BEES_TREE_F[${TREES.length}] = ${floats(TREES.map((t) => t[0]))};
const float BEES_TREE_Y[${TREES.length}] = ${floats(TREES.map((t) => t[1]))};
const float BEES_TREE_S[${TREES.length}] = ${floats(TREES.map((t) => t[2]))};
const float BEES_TREE_SEED[${TREES.length}] = ${floats(TREES.map((t) => t[3]))};
const int BEES_CLOUD_N = ${CLOUDS.length};
const int BEES_CLOUD_PUFFS = ${CLOUD_PUFFS};
const float BEES_CLOUD_F[${CLOUDS.length}] = ${floats(CLOUDS.map((c) => c[0]))};
const float BEES_CLOUD_Y[${CLOUDS.length}] = ${floats(CLOUDS.map((c) => c[1]))};
const float BEES_CLOUD_S[${CLOUDS.length}] = ${floats(CLOUDS.map((c) => c[2]))};
const float BEES_CLOUD_T[${CLOUDS.length}] = ${floats(CLOUDS.map((c) => c[3]))};
const float BEES_CLOUD_SEED[${CLOUDS.length}] = ${floats(CLOUDS.map((c) => c[4]))};
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
const float BEES_DEPTH_STEP = ${glslFloat(BEES_DEPTH_STEP)};
// Seconds of the entrance and the exit (BEES_PASSAGE).
const float BEES_ENTER = ${glslFloat(BEES_PASSAGE.enter)};
// The crown of an old apple tree: lobes (x, y, radius) in metres from the foot of the trunk, spreading
// wide; each tree jitters, stretches and resizes them by its seed.
const vec3 BEES_CROWN[9] = vec3[9](vec3(-2.7, 2.7, 1.15), vec3(-1.5, 3.1, 1.3), vec3(-0.2, 3.5, 1.45), vec3(1.2, 3.2, 1.3), vec3(2.6, 2.8, 1.1), vec3(-1.1, 3.9, 1.0), vec3(0.5, 4.0, 1.05), vec3(-2.0, 2.2, 0.8), vec3(2.0, 2.3, 0.85));
// A cumulus: ellipse lobes (x, y, half width, half height) in the cloud's own units, a flat base at y = 0:
// three wide flat lobes at the foot, a few big billows above them, then many small ones along the edges
// and the crown, so the outline is lumpy at every scale.
const vec4 BEES_CLOUDLOBE[17] = vec4[17](vec4(-0.55, 0.10, 0.34, 0.13), vec4(0.0, 0.11, 0.42, 0.14), vec4(0.55, 0.09, 0.32, 0.12), vec4(-0.25, 0.42, 0.30, 0.26), vec4(0.20, 0.50, 0.34, 0.30), vec4(0.62, 0.30, 0.20, 0.17), vec4(-0.70, 0.28, 0.18, 0.15), vec4(-0.05, 0.86, 0.26, 0.22), vec4(0.30, 0.82, 0.20, 0.17), vec4(0.05, 1.10, 0.13, 0.10), vec4(-0.88, 0.15, 0.10, 0.09), vec4(0.88, 0.14, 0.10, 0.09), vec4(-0.52, 0.58, 0.11, 0.10), vec4(0.60, 0.62, 0.12, 0.10), vec4(-0.30, 1.00, 0.10, 0.09), vec4(0.45, 1.02, 0.10, 0.08), vec4(0.72, 0.50, 0.10, 0.09));
// The wall's foot (uv) and the gate in it, as fractions of the stage.
const float BEES_WALL_Y = 0.372;
const float BEES_GATE_0 = 0.27;
const float BEES_GATE_1 = 0.4;

// Light and view, set once per cell by sceneBees.
vec3 beesAmb = vec3(0.5);
vec3 beesSun = vec3(1.0, 0.9, 0.7);
vec3 beesCloudShade = vec3(0.5, 0.58, 0.8);
vec2 beesSunDir = vec2(-0.6, 0.8);
vec2 beesSunGround = vec2(-0.6, 0.8);
float beesSunTan = 0.4;
float beesSunUp = 1.0;
float beesSunX = -0.5;
float beesW = 0.9;
float beesAa = 0.002;
float beesAspect = 1.78;
float beesSeed = 0.0;
float beesCut = 0.0;
// The depth (m) of the nearest thing drawn at this cell that can hide a bee behind it: the wall, a tree, a
// hive, the foreground flowers. 1e4 for the sky, the hills and the ground (a bee is always in front of that).
float beesZ = 1e4;

float beesS(float y) {
  return max(BEES_YH - y, 0.012) / BEES_CAM;
}

// 1 - ease-out cubic of the entrance: how far the cumulus still have to drift in, 1 down to 0 (exactly 0 once arrived).
float beesDriftIn() {
  float u = 1.0 - clamp(passageIn(), 0.0, 1.0);
  return u * u * u;
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

// An albedo in the afternoon light: the sky's ambient plus the warm sun, more of it on a surface turned
// toward the sun (nx: the surface's sideways normal, -1 left .. 1 right); shade (a cloud's, a tree's)
// takes most of the direct sun.
vec3 beesShade(vec3 albedo, float nx) {
  float f = clamp(nx * beesSunX * 1.4, -1.0, 1.0);
  return albedo * (beesAmb * 0.55 + beesSun * (0.5 + 0.35 * f) * (1.0 - 0.72 * beesCut));
}

// Light that passes through a thin leaf or petal toward the eye, the sun being behind the scene.
vec3 beesGlow(vec3 albedo, float amount) {
  return albedo * beesSun * amount * (1.0 - 0.72 * beesCut);
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

// ---- the sky -------------------------------------------------------------------------------------------

// The signed distance (in the cloud's own units, roughly) to a cumulus: a union of ellipse lobes, cut
// flat at the base.
float beesCloudSdf(vec2 q, float seed) {
  float d = 1e3;
  for (int k = 0; k < 17; k++) {
    vec4 c = BEES_CLOUDLOBE[k];
    c.xy += (hash22(vec2(float(k), seed)) - 0.5) * 0.06;
    c.zw *= 0.88 + 0.28 * hash12(vec2(float(k) + 7.0, seed));
    d = min(d, (length((q - c.xy) / c.zw) - 1.0) * min(c.z, c.w));
  }
  return max(d, -q.y);
}

// One cumulus at p: rgb and coverage (0 or 1). The light comes from the outline's normal (taken over a
// wide step, so the billows blend into one mass) mixed with the cloud's overall facing: the sunward side
// and the crown are bright cream, the shaded side and the flat base blue-grey, the sunward rim glows.
vec4 beesCloudAt(vec2 p, float cx, float by, float s, float tall, float seed) {
  vec2 q = vec2((p.x - cx) / s, (p.y - by) / (s * tall));
  if (q.x < -1.15 || q.x > 1.2 || q.y < -0.05 || q.y > 1.5) return vec4(0.0);
  float sd = seed + beesSeed;
  float d = beesCloudSdf(q, sd);
  d += 0.045 * (vnoise(q * 9.0 + seed) - 0.5) + 0.02 * (vnoise(q * 23.0 + seed) - 0.5);
  if (hardFill(d * s, beesAa) < 0.5) return vec4(0.0);
  float e = 0.12;
  vec2 grad = vec2(beesCloudSdf(q + vec2(e, 0.0), sd) - beesCloudSdf(q - vec2(e, 0.0), sd), beesCloudSdf(q + vec2(0.0, e), sd) - beesCloudSdf(q - vec2(0.0, e), sd));
  vec2 n = grad / max(length(grad), 1e-3);
  vec2 toSun = normalize(vec2(beesSunDir.x, beesSunDir.y / tall));
  float facing = dot(n, toSun);
  float wide = dot(normalize(q - vec2(0.0, 0.5) + 1e-3), toSun);
  float lit = smoothstep(-1.0, 0.9, 0.55 * facing + 0.45 * wide);
  lit *= 0.5 + 0.5 * smoothstep(0.0, 0.5, q.y);
  vec3 litC = beesSun * 0.7 + beesAmb * 0.55 + vec3(0.14, 0.13, 0.12);
  vec3 c = mix(beesCloudShade, litC, lit);
  float rim = 1.0 - smoothstep(0.0, 0.07, -d);
  c += beesSun * 0.4 * rim * max(facing, 0.0) * smoothstep(0.1, 0.5, q.y);
  c = mix(c, beesCloudShade * 0.85, (1.0 - smoothstep(0.0, 0.2, q.y)) * 0.6);
  return vec4(c, 1.0);
}

vec3 beesSky(vec2 p, vec3 dir, Sky sky, float tm) {
  // The aurora and shooting stars first, so the cumulus pass in front of them.
  vec3 col = skyColor(sky, dir) + auroraM(dir, tm, K_aurora, beesAa) * auroraSeen(sky, 0.0);
  float meteorSeed;
  float meteorAt = meteorAge(tm, K_meteors, BEES_METEOR_SLOT, meteorSeed);
  col += METEOR_TINT * hardEdge(meteorStreak(p, BEES_METEOR_FIELD, meteorAt, meteorSeed, beesAa) * sky.night);
  float span = 2.0 * beesW + 1.7;
  float cover = clamp(K_clouds, 0.0, 1.0);
  for (int i = 0; i < BEES_CLOUD_N; i++) {
    bool puff = i < BEES_CLOUD_PUFFS;
    if (!puff && i == BEES_CLOUD_N - 2 && cover < 0.2) continue;
    float s = BEES_CLOUD_S[i] * (puff ? 1.0 : mix(0.65, 1.08, cover));
    float lead = (0.22 + 0.04 * float(i)) * beesDriftIn() + 0.1 * smoothstep(0.0, 1.0, passageOut());
    float x = mod(BEES_CLOUD_F[i] * beesW + tm * 0.0035 + 0.5 * span, span) - 0.5 * span + sign(BEES_CLOUD_F[i]) * lead;
    vec4 cl = beesCloudAt(p, x, BEES_CLOUD_Y[i], s, BEES_CLOUD_T[i], BEES_CLOUD_SEED[i]);
    col = mix(col, cl.rgb, cl.a);
  }
  return col + skyStarLight(sky, dir, K_stars);
}

// The shadow of the clouds on the land, drifting slowly: 1 in shadow, per cell.
float beesCloudShadow(vec2 p, float tm) {
  vec2 q = vec2(p.x * 0.75 - tm * 0.011 + 0.2 * (beesDriftIn() + 0.5 * smoothstep(0.0, 1.0, passageOut())), p.y * 2.4);
  float n = 0.65 * vnoise(q + vec2(5.0 + beesSeed, 1.0)) + 0.35 * vnoise(q * 2.3 + vec2(9.0, 3.0));
  return hardEdge(smoothstep(0.54, 0.7, n));
}

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

// ---- the grass, its shadows and the path -----------------------------------------------------------------

// Slow travelling swells of wind through the grass, 0..1: wide bands moving along the wind, bent by a
// slow noise. w = ground coordinates (X, Z) in metres.
float beesGust(vec2 w, float tm) {
  float sgn = K_wind < -0.02 ? -1.0 : 1.0;
  float ph = (w.x * sgn * 0.8 + w.y * 0.5) / 15.0 - tm * 0.04 * (0.45 + 0.9 * abs(K_wind));
  ph += 0.4 * vnoise(vec2(w.x * 0.05, w.y * 0.06) + vec2(beesSeed, 0.0));
  float f = fract(ph);
  return smoothstep(0.0, 0.3, f) * smoothfall(0.9, 0.45, f);
}

// How much of the sun the grass at ground point w (metres) loses to the orchard and the hives: each
// tree's crown throws a wide soft shadow away from the sun, long in the low light, with sun spots
// through its leaves; each hive a narrower one. 0 lit .. 1 shaded.
float beesGroundShadow(vec2 w) {
  vec2 away = -beesSunGround;
  float reach = clamp(1.0 / beesSunTan, 0.8, 4.0);
  float s = 0.0;
  for (int k = 0; k < BEES_TREE_N; k++) {
    float sz = BEES_TREE_S[k];
    float Zt = BEES_CAM / (BEES_YH - BEES_TREE_Y[k]);
    vec2 foot = vec2(BEES_TREE_F[k] * beesW * Zt, Zt);
    vec2 d = (w - (foot + away * 3.0 * sz * reach * 0.7)) / vec2(3.0 * sz, 2.1 * sz);
    if (dot(d, d) > 2.5) continue;
    float e = length(d) + 0.35 * (vnoise(w * 0.9 + float(k) * 7.0) - 0.5);
    float inside = 1.0 - smoothstep(0.6, 1.0, e);
    float dapple = smoothstep(0.55, 0.72, vnoise(w * 2.1 + float(k) * 3.0 + beesSeed));
    s = max(s, inside * (0.92 - 0.5 * dapple));
  }
  for (int i = 0; i < BEES_HIVE_N; i++) {
    float Zh = BEES_CAM / (BEES_YH - BEES_HIVE_Y[i]);
    vec2 foot = vec2(BEES_HIVE_F[i] * beesW * Zh, Zh);
    float dd = segmentDistance(w, foot, foot + away * min(1.6 * reach, 3.5));
    s = max(s, (1.0 - smoothstep(0.35, 0.75, dd)) * 0.85);
  }
  return s * beesSunUp;
}

// The grass: patches of yellower and bluer green, a mottle, flecks, clover and its flowers, windfalls
// where a tree shades it, and the pale sheen of the wind. The light and shade come from beesShade (the
// caller has put the shade in beesCut).
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
  return beesShade(c, 0.0) + beesGlow(c, 0.25 * gust);
}

void beesPath(vec2 p, vec2 w, inout vec3 col) {
  float y = p.y;
  if (y > 0.4) return;
  float S = beesS(y);
  float xp = beesW * (0.05 + 0.3 * smoothstep(0.0, 0.38, y)) + 0.05 * beesW * sin(y * 8.0 + 1.0) * smoothstep(0.02, 0.2, y);
  float d = abs(p.x - xp) - 0.6 * S * (0.9 + 0.25 * (vnoise(vec2(y * 40.0, beesSeed)) - 0.5));
  if (hardFill(d, beesAa) < 0.5) return;
  float speck = hash12(floor(w * 12.0));
  vec3 c = vec3(0.74, 0.62, 0.42) * (0.85 + 0.3 * speck);
  c = mix(c, vec3(0.50, 0.46, 0.30), smoothstep(-0.1 * S, 0.0, d) * 0.6);
  col = beesShade(c, 0.0);
}

// ---- flower drifts -------------------------------------------------------------------------------------

// How much of drift i covers p (0..1), its edge ragged with noise.
float beesPatchCover(int i, vec2 p) {
  vec2 c = vec2(BEES_PATCH_F[i] * beesW, BEES_PATCH_Y[i]);
  vec2 r = vec2(BEES_PATCH_RX[i] * beesW, BEES_PATCH_RY[i]);
  vec2 q = (p - c) / r;
  if (abs(q.x) > 1.25 || abs(q.y) > 1.25) return 0.0;
  float e = length(q) + 0.3 * (vnoise(p * vec2(7.0, 24.0) + float(i) * 5.3 + beesSeed) - 0.5) + 0.15 * (vnoise(p * vec2(19.0, 60.0) + float(i) * 2.0) - 0.5);
  return 1.0 - smoothstep(0.7, 1.0, e);
}

// The same without the fine noise, for the density of blooms at a point.
float beesPatchDensity(int i, vec2 p) {
  vec2 q = (p - vec2(BEES_PATCH_F[i] * beesW, BEES_PATCH_Y[i])) / vec2(BEES_PATCH_RX[i] * beesW, BEES_PATCH_RY[i]);
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
  col = mix(col, soil, 0.55 * lane);
  float jTop = floor(Zp / 0.3);
  for (int m = 0; m < 8; m++) {
    float j = jTop - float(m);
    float Z = j * 0.3;
    if (Z < 2.0) break;
    float S = 1.0 / Z;
    float yb = BEES_YH - BEES_CAM / Z;
    float fi = floor((p.x * Z - x0) / pitch + 0.5);
    if (fi < 0.0 || fi > 5.0) continue;
    if (Z > 7.2 + 1.8 * hash12(vec2(fi, 3.0 + beesSeed))) continue;
    float lump = 0.8 + 0.4 * vnoise1(Z * 1.4 + fi * 9.0 + beesSeed, 7.0).x;
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
    c3 = mix(c3, vec3(0.34, 0.40, 0.30), smoothfall(-0.15, -0.6, q.y) * 0.8);
    col = beesShade(c3, q.x * 0.7) + beesGlow(c3, 0.5 * smoothstep(0.6, 1.0, e) * max(lit, 0.3));
  }
}

// The blooms of a drift at p. They stand in rows a fixed step apart in log depth (so their size follows
// the perspective) but are jittered in both directions, vary about fivefold in size, come in clumps
// (noise) and thin toward the drift's edge; a few in each drift are another kind. Each pixel looks at
// its own row and the nearer of its neighbours, the farther row first.
void beesBlooms(int pi, int kind, vec2 p, float gust, float tm, inout vec3 col) {
  float dy = max(BEES_YH - p.y, 0.02);
  float u = log(BEES_CAM / dy) / BEES_ROW;
  float k0 = floor(u + 0.5);
  float k1 = k0 + (u > k0 ? 1.0 : -1.0);
  float sizeK = kind == BEES_POPPY ? 0.12 : kind == BEES_COSMOS ? 0.1 : 0.085;
  float seed = float(pi) * 13.7 + beesSeed;
  for (int r = 0; r < 2; r++) {
    float k = r == 0 ? max(k0, k1) : min(k0, k1);
    float dk = BEES_CAM * exp(-k * BEES_ROW);
    float yk = BEES_YH - dk;
    float sig = sizeK * dk;
    float off = hash12(vec2(k, seed));
    float c0 = floor(p.x / sig + off + 0.5);
    for (int cj = -1; cj <= 1; cj++) {
      float ci = c0 + float(cj);
      vec2 h = hash22(vec2(ci, k * 1.7 + seed));
      vec2 h2 = hash22(vec2(ci + 17.0, k * 2.3 + seed));
      vec2 ctr = vec2((ci - off + 0.9 * (h.x - 0.5)) * sig, yk + (h2.y - 0.5) * dk * BEES_ROW);
      float rr = 0.3 * sig * (0.3 + 1.3 * h.y * h.y);
      float ph = hash12(vec2(ci, k) + 31.0) * 6.2831853;
      float sway = rr * 0.5 * (gust - 0.3) * (0.7 + 0.5 * sin(tm * 0.8 + ph));
      vec2 d = p - ctr - vec2(sway, 0.0);
      float dist = length(d);
      if (dist > rr * 1.15) continue;
      float dens = beesPatchDensity(pi, ctr) * (0.1 + 0.9 * smoothstep(0.35, 0.7, vnoise(ctr * vec2(11.0, 38.0) + seed)));
      if (h2.x > dens) continue;
      int ke = kind;
      float hm = hash12(vec2(ci, k) + 51.0);
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
  if (cov <= 0.0) return;
  float seed = float(i) * 13.7 + beesSeed;
  float clump = smoothstep(0.3, 0.65, vnoise(p * vec2(11.0, 38.0) + seed));
  vec3 lush = beesShade(vec3(0.18, 0.42, 0.08) * (1.0 + 0.2 * gust), 0.0);
  col = mix(col, lush, hardEdge(cov * 0.7) * 0.6);
  // A faint mass of the drift's colour under the blooms (none under poppies, which stay red on green),
  // broken by the clumps; far away the blooms are less than a cell and the drift is then only this tint.
  float dk = max(BEES_YH - p.y, 0.02);
  float rcFar = 0.33 * 0.1 * dk / beesAa;
  float far = 1.0 - smoothstep(1.0, 2.5, rcFar);
  vec3 tintCol = kind == BEES_POPPY ? vec3(0.9, 0.18, 0.1) : kind == BEES_DAISY ? vec3(0.9, 0.88, 0.72) : kind == BEES_COSMOS ? vec3(0.9, 0.5, 0.68) : vec3(0.85, 0.75, 0.45);
  float mass = hardEdge(cov * (0.2 + 0.8 * clump)) * ((kind == BEES_POPPY ? 0.0 : 0.1) + 0.4 * far);
  col = mix(col, beesShade(tintCol, 0.0), mass);
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

// The dry-stone wall behind the garden, a gate for the path, and the wooden fence beyond it.
void beesWall(vec2 p, inout vec3 col) {
  float S = beesS(BEES_WALL_Y);
  if (p.y < BEES_WALL_Y - 0.002 || p.y > BEES_WALL_Y + 1.1 * S) return;
  vec2 q = vec2(p.x, p.y - BEES_WALL_Y) / S;
  float g0 = BEES_GATE_0 * beesW;
  float g1 = BEES_GATE_1 * beesW;
  if (p.x < g0) {
    float top = 0.85 + 0.12 * (vnoise1(q.x * 0.8 + 2.0, 2.0).x - 0.5) + 0.04 * (vnoise1(q.x * 4.1 + beesSeed, 7.0).x - 0.5);
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
// pitched roof. The ground shadow is cast in beesGroundShadow.
void beesHive(int i, vec2 p, inout vec3 col, inout float accent) {
  float by = BEES_HIVE_Y[i];
  float S = beesS(by) * BEES_HIVE_SCALE;
  vec2 q = (p - vec2(BEES_HIVE_F[i] * beesW, by)) / S;
  if (abs(q.x) > 0.5 || q.y < -0.1 || q.y > 1.2) return;
  float contact = hardFill(sdEllipse(q - vec2(0.0, -0.01), vec2(0.5, 0.07)) * S, beesAa * 2.0);
  col = mix(col, col * 0.6, contact * 0.7);
  if (q.y < 0.0) return;
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
  vec3 tin = vec3(0.55, 0.58, 0.60);
  col = mix(col, beesShade(tin, 0.0) + beesGlow(tin, 0.35 * roofTop) + vec3(0.1, 0.12, 0.16) * roofTop, roof);
}

// ---- the foreground ------------------------------------------------------------------------------------

// A foxglove: a spike of nodding bells tapering to buds on a leaning stem, its leaves at the foot.
void beesFoxglove(int i, vec2 p, float tm, inout vec3 col) {
  float y0 = BEES_FOX_Y[i];
  float S = beesS(y0);
  float hgt = BEES_FOX_H[i] * S;
  float x0 = BEES_FOX_F[i] * beesW;
  // The near ones spring up from below the frame; the far ones stand where they are.
  if (y0 < 0.15) p.y += (y0 + 1.1 * hgt) * beesRise(float(i));
  float t = (p.y - y0) / hgt;
  if (t < -0.05 || t > 1.08 || abs(p.x - x0) > 0.45 * hgt) return;
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

// A poppy or a daisy close to the lens, petals and all, on its stem with two leaves.
void beesBloomNear(int i, vec2 p, float tm, inout vec3 col) {
  float yh = BEES_BLOOM_Y[i];
  float S = beesS(yh);
  float R = 0.13 * S;
  float fi = float(i);
  p.y += (yh + 0.03 + 1.5 * R) * beesRise(fi + 10.0);
  vec2 head = vec2(BEES_BLOOM_F[i] * beesW + 0.004 * (0.5 + abs(K_wind)) * sin(tm * 0.5 + fi * 2.3), yh);
  if (abs(p.x - head.x) > 3.0 * R || p.y > yh + 1.4 * R || p.y < -0.03) return;
  float tt = clamp((p.y + 0.03) / (yh + 0.03), 0.0, 1.0);
  float sx = head.x - 0.18 * (1.0 - tt) * (1.0 - tt) * R * (fi - 1.0);
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

// ---- the specks --------------------------------------------------------------------------------------------

// What the simulation's cell map holds: a bee (near-black, a golden back cell with pollen), the pale
// glint of its wing, the dotted line it leaves in the air, a butterfly's wings and body.
vec3 beesSpeck(int code, vec3 under) {
  if (code == BEES_C_BEE) return vec3(0.05, 0.03, 0.02);
  if (code == BEES_C_DIM) return mix(under, vec3(0.05, 0.03, 0.02), 0.6);
  if (code == BEES_C_FAINT) return mix(under, vec3(0.05, 0.03, 0.02), 0.4);
  if (code == BEES_C_LOADED) return vec3(1.0, 0.75, 0.10);
  if (code == BEES_C_WING) return mix(under, vec3(1.0, 1.0, 0.94), 0.95);
  if (code == BEES_C_BODY) return vec3(0.12, 0.08, 0.06);
  if (code == BEES_C_ORANGE) return vec3(1.0, 0.55, 0.05);
  if (code == BEES_C_WHITE) return vec3(1.0, 1.0, 0.97);
  if (code == BEES_C_BLUE) return vec3(0.30, 0.55, 1.0);
  if (code == BEES_C_ORANGE_DIM) return vec3(0.62, 0.30, 0.08);
  if (code == BEES_C_WHITE_DIM) return vec3(0.78, 0.76, 0.66);
  return vec3(0.22, 0.34, 0.66);
}

Shade sceneBees(vec2 uv, vec2 cell, float t) {
  beesAspect = uRes.x / uRes.y;
  beesW = max(0.5 * beesAspect, BEES_STAGE_MIN);
  beesAa = 1.0 / uRes.y;
  beesSeed = K_scenerySeed * 0.37;
  float tm = uMotionTime;
  vec2 p = vec2((uv.x - 0.5) * beesAspect, uv.y);
  float y = p.y;

  Sky sky = skyMoonPhase(skyAt(timeOfDayM(K_time, K_cycle, tm)), K_moon);
  beesSun = sky.sunColor * vec3(1.15, 1.05, 0.88);
  beesAmb = sky.ambient * vec3(1.05, 0.98, 0.88) + vec3(0.04) + auroraGlow(tm, K_aurora) * auroraSeen(sky, 0.0);
  vec3 cam = viewRay(uv, beesAspect, BEES_YH, BEES_FOV);
  vec3 dir = skyFacing(cam, BEES_TURN);
  vec3 sunCam = skyFacing(sky.sun, -BEES_TURN);
  float sunLen = max(length(sunCam.xz), 1e-3);
  beesSunX = sunCam.x / sunLen;
  beesSunGround = sunCam.xz / sunLen;
  beesSunTan = max(sunCam.y, 0.04) / sunLen;
  beesSunUp = smoothstep(-0.02, 0.12, sky.sun.y);
  beesSunDir = normalize(vec2(sunCam.x, 0.45 + 1.2 * max(sunCam.y, 0.0)) + 1e-4);
  vec3 zen = skyColor(sky, normalize(vec3(0.0, 0.85, 0.5)));
  beesCloudShade = mix(vec3(dot(zen, LUMA)), zen, 0.5) * 1.5 + vec3(0.12, 0.13, 0.17);
  float cloudCut = beesCloudShadow(p, tm);
  beesCut = cloudCut;

  vec4 sk = beesSkyline(p.x);
  float g = sk.x;
  float y1 = sk.y;
  float y2 = sk.z;
  float y3 = sk.w;
  vec3 haze = y < 0.75 ? horizonHaze(sky, dir, 0.04) : vec3(0.0);
  vec3 hazeB = mix(haze, zen, 0.45);
  vec3 col = vec3(0.0);
  float accent = 0.0;

  // Sky and hills, far to near, then the ground of the garden.
  if (y >= y3) col = beesSky(p, dir, sky, tm);
  else if (y >= y2) col = beesHill(p, y3, 3.0, hazeB, 0.55);
  else if (y >= y1) col = beesHill(p, y2, 2.0, hazeB, 0.3);
  else if (y >= g) col = beesHill(p, y1, 1.0, haze, 0.08);
  if (y > 0.4 && y < 0.72) beesFar(p, tm, haze, hazeB, col);

  float dy = max(BEES_YH - y, 0.03);
  float Z = BEES_CAM / dy;
  vec2 w = vec2(p.x * Z, Z);
  vec2 foot = vec2(Z / uRes.y, Z / (dy * uRes.y));
  float gust = beesGust(w, tm);
  float gs = 0.0;
  if (y < g) {
    gs = beesGroundShadow(w);
    beesCut = max(cloudCut, hardEdge(gs));
    col = beesGround(p, w, foot, gust, gs);
    if (y > g - 0.03 + 0.01 * (vnoise(vec2(p.x * 30.0, beesSeed)) - 0.5)) {
      // The hedge along the far edge of the garden: dark leaves, a golden rim on top.
      float n = fbm3(p * vec2(18.0, 40.0));
      vec3 hedge = mix(vec3(0.07, 0.17, 0.06), vec3(0.28, 0.44, 0.12), n);
      col = beesShade(hedge, 0.0) + beesGlow(hedge, 0.8 * smoothstep(g - 0.012, g, y));
    }
    beesPath(p, w, col);
    for (int i = 0; i < BEES_PATCH_N; i++) {
      if (i != 3) beesPatch(i, p, gust, tm, col);
    }
    beesCut = cloudCut;
  }

  // What can hide a bee: each thing drawn that changes the cell notes its depth in beesZ.
  vec3 before = col;
  for (int k = 0; k < BEES_TREE_N; k++) {
    before = col;
    beesTree(k, p, col);
    if (col != before) beesZ = BEES_CAM / (BEES_YH - BEES_TREE_Y[k]);
  }
  before = col;
  beesWall(p, col);
  if (col != before) beesZ = BEES_CAM / (BEES_YH - BEES_WALL_Y);
  if (y < g) {
    beesCut = max(cloudCut, hardEdge(gs));
    beesPatch(3, p, gust, tm, col);
    beesCut = cloudCut;
  }
  for (int k = 0; k < BEES_HIVE_N; k++) {
    int hi = BEES_HIVE_ORDER[k];
    before = col;
    beesHive(hi, p, col, accent);
    if (col != before) beesZ = BEES_CAM / (BEES_YH - BEES_HIVE_Y[hi]);
  }
  for (int i = 0; i < BEES_FOX_N; i++) {
    before = col;
    beesFoxglove(i, p, tm, col);
    if (col != before) beesZ = BEES_CAM / (BEES_YH - BEES_FOX_Y[i]);
  }
  for (int i = 0; i < BEES_BLOOM_N; i++) {
    before = col;
    beesBloomNear(i, p, tm, col);
    if (col != before) beesZ = BEES_CAM / (BEES_YH - BEES_BLOOM_Y[i]);
  }
  before = col;
  beesBlades(p, tm, col);
  if (col != before) beesZ = 3.0;

  // The golden haze the low sun scatters toward the eye, and a soft darkening toward the corners.
  col += beesSun * 0.07 * exp(-5.0 * length(dir - sky.sun)) * (1.0 + 0.4 * (1.0 - smoothstep(0.4, 0.7, y)));
  col *= 1.0 - 0.22 * smoothstep(0.7, 1.4, length((uv - 0.5) * vec2(1.0, 0.9)) * 1.5);
  col = clamp(col * 1.1, 0.0, 1.0);

  // Bees and butterflies, from the simulation's map of cells.
  ivec2 ic = ivec2(cell);
  ivec2 size = textureSize(uSim0, 0);
  if (uSimOn.x > 0.5 && ic.x < size.x && ic.y < size.y) {
    vec2 tex = texelFetch(uSim0, ic, 0).rg;
    int code = int(tex.r * 255.0 + 0.5);
    if (code > 0 && tex.g * 255.0 / BEES_DEPTH_STEP < beesZ) col = snapLevel(beesSpeck(code, col));
  }
  return shadeOf(col, inkOf(col, 1.25, 1.0), clamp(accent, 0.0, 1.0));
}
`;
