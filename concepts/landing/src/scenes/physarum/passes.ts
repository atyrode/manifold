// The slime mould's GPU passes (sim.ts runs them): Jones's agent step (MOVE, DEPOSIT, DIFFUSE), the
// agar's state (ENV, SALT), the distance along the veins (DISTANCE), the view (VIEW, with the trunk
// level it is toned by, SUMS and LEVEL), and the CPU twins of the view's tone for the still picture.
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { clamp } from "../../sims/math.ts";
import { PHYSARUM_FAR, PHYSARUM_MAX_FOOD } from "./grid.ts";

// ---- the mould --------------------------------------------------------------------------------

/** Texels per step. */
const SPEED = 1;
/** Random wobble per step (radians, full width): a little, so filaments wander rather than rule lines. */
const WANDER = 0.08;
/** Rotation per step (degrees): Jones's 45°, or the sensor angle where that is wider. */
export const TURN_MIN = 45;
/**
 * Sensed trail saturates here (× the trunk level): every filament above it smells alike, so specks
 * spread over the mesh instead of piling into a few heavy bands that starve the rest, and a crowd on
 * a flake reads flat, so they cross it.
 */
const SENSE_CAP = 0.3;
/**
 * Food as sensed (× the trunk level) by a fed and by a hungry speck (hungry: under HUNGRY of LIFE
 * left): a halo round each flake, flat over its pool and falling off linearly over HALO_REACH sensor
 * offsets beyond, so trunks passing near a flake bend into it and run through it, and the lace
 * round it gathers into a fan. Flat on top, so specks cross a flake along the trail rather than
 * circling it; weaker than a trunk's trail across one sensor offset, so they leave along trunks.
 */
const FOOD_FED = 0.4;
const FOOD_SENSE = 0.9;
const HUNGRY = 0.5;
export const HALO_REACH = 2.5;
/** Each speck's sensor reach is the knob's times its own factor in this range: fine and coarse at once. */
const REACH_LOW = 0.6;
const REACH_HIGH = 1.4;
/** Salt, light and the dish's wall as sensed (× the trunk level). */
const REPEL = 6;
/** The scent laid along the M's strokes (0..1 of a flake's halo, sensed as food), and its half-width in trail texels. */
const MARK_SCENT = 0.8;
const MARK_WIDTH = 10;

// ---- the view ---------------------------------------------------------------------------------

/**
 * Tone: a typical filament is shown at LACE_TONE (trunks at 1), through a power curve whose
 * exponent follows the mould's own contrast (the filament's share of the trunk level, as measured,
 * held within SHARE_MIN..SHARE_MAX; the exponent within GAMMA_MIN..GAMMA_MAX).
 */
const LACE_TONE = 0.3;
/** Below this share of the trunk level the trail is background haze, not a filament. */
const FILAMENT_FLOOR = 0.04;
const SHARE_MIN = 0.02;
const SHARE_MAX = 0.9;
const GAMMA_MIN = 0.3;
const GAMMA_MAX = 1.2;

/** The view pass's tone curve (see VIEW): `level` in trunk levels, `share` a filament's share of it. */
export function tone(level: number, share: number): number {
  const gamma = clamp(
    Math.log(LACE_TONE) / Math.log(clamp(share, SHARE_MIN, SHARE_MAX)),
    GAMMA_MIN,
    GAMMA_MAX,
  );
  return Math.pow(Math.max(level, 1e-6), gamma);
}

/** The sketch's trunk level (Σs³ / Σs²) and a typical filament's share of it, as SUMS and LEVEL measure the trail. */
export function sketchLevel(sketch: Float32Array): { level: number; share: number } {
  let s2 = 0;
  let s3 = 0;
  for (let i = 0; i < sketch.length; i++) {
    const s = sketch[i] ?? 0;
    s2 += s * s;
    s3 += s * s * s;
  }
  if (s2 <= 0) return { level: 1, share: LACE_TONE };
  const level = s3 / s2;
  let lit = 0;
  let sum = 0;
  for (let i = 0; i < sketch.length; i++) {
    const s = sketch[i] ?? 0;
    if (s < FILAMENT_FLOOR * level) continue;
    lit++;
    sum += s;
  }
  return { level, share: lit > 0 ? sum / lit / level : LACE_TONE };
}

/** Crossing lace or bare agar costs this many times more than following a vein (DISTANCE). */
const COST_OFF = 40;

// ---- GPU passes -------------------------------------------------------------------------------

const HASH = `
uint physarumHash(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float physarumRandom(inout uint state) {
  state = physarumHash(state);
  return float(state >> 8u) * (1.0 / 16777216.0);
}
`;

/** Jones's step: sense at three sensors, turn, move (or bounce), starve or feed; the dead are reborn at a flake. */
export const MOVE = `
const float TAU = 6.2831853;
uniform sampler2D uAgents;   // x, y (domain uv), heading, steps left without food (<= 0: waiting to be reborn)
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uRef;
uniform vec2 uGrid;
uniform float uReach;
uniform float uAngle;
uniform float uTurn;
uniform float uLife;
uniform int uStep;
uniform vec4 uFood[${PHYSARUM_MAX_FOOD}];
uniform int uFoodCount;
${HASH}
// What a sensor smells: the trail (saturating), food (the flakes' halos and the M's strokes, more
// keenly when hungry), less salt, light and the dish's wall.
float physarumSense(vec2 at, float cap, float food, float repel) {
  vec4 env = texture(uEnv, at);
  return min(texture(uTrail, at).r, cap) + food * env.r - repel * (env.g + env.a);
}
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 agent = texelFetch(uAgents, texel, 0);
  uint state = physarumHash(uint(texel.y) * uint(uSize.x) + uint(texel.x) + physarumHash(uint(uStep)));
  vec2 unit = 1.0 / uGrid;
  if (agent.w <= 0.0) {
    for (int k = 0; k < 4; k++) {
      if (uFoodCount <= 0) break;
      int i = min(int(physarumRandom(state) * float(uFoodCount)), uFoodCount - 1);
      vec4 food = uFood[i];
      if (physarumRandom(state) >= food.w) continue;
      float a = physarumRandom(state) * TAU;
      float r = food.z * (0.4 + 0.5 * physarumRandom(state));
      float heading = a + (physarumRandom(state) - 0.5) * 1.2;
      fragColor = vec4(food.xy + vec2(cos(a), sin(a)) * r * unit, mod(heading, TAU), uLife * (0.5 + 0.5 * physarumRandom(state)));
      return;
    }
    fragColor = vec4(agent.xyz, 0.0);
    return;
  }
  float ref = max(texelFetch(uRef, ivec2(0), 0).r, 1e-4);
  float cap = ${glslFloat(SENSE_CAP)} * ref;
  float food = (agent.w < ${glslFloat(HUNGRY)} * uLife ? ${glslFloat(FOOD_SENSE)} : ${glslFloat(FOOD_FED)}) * ref;
  float repel = ${glslFloat(REPEL)} * ref;
  // This speck's own reach, fixed by its slot: short-sighted ones knit fine branches, long-sighted ones trunks.
  uint id = uint(texel.y) * uint(uSize.x) + uint(texel.x);
  float reach = uReach * mix(${glslFloat(REACH_LOW)}, ${glslFloat(REACH_HIGH)}, float(physarumHash(id ^ 0x9e3779b9u) >> 8u) * (1.0 / 16777216.0));
  float heading = agent.z;
  float front = physarumSense(agent.xy + reach * vec2(cos(heading), sin(heading)) * unit, cap, food, repel);
  float left = physarumSense(agent.xy + reach * vec2(cos(heading + uAngle), sin(heading + uAngle)) * unit, cap, food, repel);
  float right = physarumSense(agent.xy + reach * vec2(cos(heading - uAngle), sin(heading - uAngle)) * unit, cap, food, repel);
  float coin = physarumRandom(state);
  if (front < left && front < right) heading += coin < 0.5 ? uTurn : -uTurn;
  else if (front <= max(left, right)) heading += left > right ? uTurn : (right > left ? -uTurn : 0.0);
  heading += (physarumRandom(state) - 0.5) * ${glslFloat(WANDER)};
  vec2 next = agent.xy + vec2(cos(heading), sin(heading)) * unit * ${glslFloat(SPEED)};
  vec4 there = texture(uEnv, next);
  if (any(lessThan(next, unit)) || any(greaterThan(next, 1.0 - unit)) || there.g + there.a > 0.5) {
    next = agent.xy;
    heading = physarumRandom(state) * TAU;
    there = texture(uEnv, next);
  }
  float energy = there.b > 0.5 ? uLife : agent.w - 1.0;
  if (there.g + there.a > 0.9) energy = 0.0;
  fragColor = vec4(next, mod(heading, TAU), energy);
}
`;

/** Every living speck adds its deposit where it stands. */
export const DEPOSIT = `
uniform sampler2D uAgents;
uniform float uDeposit;
bool particle(int id, out vec2 uv, out vec4 value) {
  vec4 agent = texelFetch(uAgents, particleTexel(id, textureSize(uAgents, 0)), 0);
  uv = agent.xy;
  value = vec4(uDeposit);
  return agent.w > 0.0;
}
`;

/**
 * The trail spreads and evaporates, but never falls below the film (the flow network's veins, lace
 * and fans in trunk levels, uFilm, redrawn as the network adapts; the gain fades it under the M);
 * salt, light and the dish's wall kill it.
 */
export const DIFFUSE = `
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uFilm;
uniform sampler2D uRef;
uniform float uKeep;
uniform float uFilmGain;
void main() {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) sum += texture(uTrail, vUv + vec2(float(x), float(y)) * uTexel).r;
  }
  vec4 env = texture(uEnv, vUv);
  float trail = uKeep * sum / 9.0;
  trail = max(trail, uFilmGain * texelFetch(uRef, ivec2(0), 0).r * texture(uFilm, vUv).r);
  trail *= 1.0 - clamp(1.6 * (env.g + env.a), 0.0, 1.0);
  fragColor = vec4(trail, 0.0, 0.0, 1.0);
}
`;

/**
 * The agar's state at half resolution: R food as the specks smell it (0..1: each flake's halo, flat
 * over its pool and falling off over uHalo texels beyond, the largest where they overlap; the M's
 * strokes), G salt, A light (the lit sea, and everything past the dish's glass wall), B feeding:
 * 1 in a flake's pool, 0.5 at its rim (specks feed above 0.5), then a fringe out to 2.6 radii that
 * the trunk level is never measured in, so the plasmodium crowding onto the flakes never sets it.
 */
export const ENV = `
uniform sampler2D uSalt;
uniform sampler2D uSea;
uniform vec2 uGrid;
uniform vec4 uFood[${PHYSARUM_MAX_FOOD}];
uniform int uFoodCount;
uniform vec4 uMark;
uniform float uLight;
uniform vec3 uDish;   // centre (domain uv), radius (trail texels)
uniform float uHalo;  // the food halo's fall-off beyond a flake's pool, trail texels
${gpuCommonGlsl}
void main() {
  vec2 p = vUv * uGrid;
  float scent = 0.0;
  float feed = 0.0;
  for (int i = 0; i < ${PHYSARUM_MAX_FOOD}; i++) {
    if (i >= uFoodCount) break;
    vec4 food = uFood[i];
    float dist = length(p - food.xy * uGrid);
    float pool = 1.0 - smoothstep(0.8 * food.z, 1.2 * food.z, dist);
    float fringe = 1.0 - smoothstep(1.2 * food.z, 2.6 * food.z, dist);
    feed = max(feed, food.w * 0.5 * (pool + fringe));
    scent = max(scent, food.w * clamp(1.0 - (dist - food.z) / uHalo, 0.0, 1.0));
  }
  if (uMark.w > 0.0 && uMark.z > 0.0) {
    float m = markDistance((p - uMark.xy * uGrid) / uMark.z) * uMark.z;
    scent = max(scent, uMark.w * ${glslFloat(MARK_SCENT)} * exp(-m * m / ${glslFloat(MARK_WIDTH * MARK_WIDTH)}));
  }
  // The dish's glass wall is light to the mould: it blocks it and nothing grows past it.
  float wall = smoothstep(uDish.z - 1.5, uDish.z + 0.5, length(p - uDish.xy * uGrid));
  fragColor = vec4(scent, texture(uSalt, vUv).r, feed, max(texture(uSea, vUv).r * uLight, wall));
}
`;

/** Salt dissolves; a drag sprinkles a frayed line of it. Half-resolution texels. */
export const SALT = `
uniform sampler2D uSalt;
uniform float uKeep;
uniform float uPaint;
uniform vec4 uSegment;
uniform float uRadius;
${HASH}
void main() {
  float salt = texelFetch(uSalt, ivec2(gl_FragCoord.xy), 0).r * uKeep;
  if (uPaint > 0.5) {
    vec2 pa = gl_FragCoord.xy - uSegment.xy, ba = uSegment.zw - uSegment.xy;
    float d = length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
    uint state = physarumHash(uint(gl_FragCoord.x) * 7919u + uint(gl_FragCoord.y) * 104729u);
    float fray = physarumRandom(state);
    salt = max(salt, 1.0 - smoothstep(uRadius * (0.5 + 0.4 * fray), uRadius * (1.0 + 0.35 * fray), d));
  }
  fragColor = vec4(salt, 0.0, 0.0, 1.0);
}
`;

/**
 * One relaxation of the distance from the heart along the veins (Bellman–Ford on the texel grid):
 * each texel takes its cheapest neighbour plus the step, cheap along veins and dear across agar.
 * Recomputed from the neighbours every pass, so it also grows back where a vein is lost.
 */
export const DISTANCE = `
uniform sampler2D uDist;
uniform sampler2D uView;
uniform vec4 uHeart;   // domain uv, radius (texels), 1 while the heart is on the dish
uniform vec2 uStepH;   // one texel in screen heights
uniform float uStride;
const vec2 PHYSARUM_RING[8] = vec2[8](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0));
float physarumCost(vec2 at) {
  return 1.0 + ${glslFloat(COST_OFF)} * (1.0 - smoothstep(0.35, 0.6, texture(uView, at).r));
}
void main() {
  vec2 toHeart = (vUv - uHeart.xy) * uSize;
  if (uHeart.w > 0.5 && length(toHeart) < uHeart.z) {
    fragColor = vec4(length(toHeart * uStepH), 0.0, 0.0, 1.0);
    return;
  }
  float here = physarumCost(vUv);
  float best = ${glslFloat(PHYSARUM_FAR)};
  for (int k = 0; k < 8; k++) {
    vec2 o = PHYSARUM_RING[k] * uStride;
    vec2 at = vUv + o * uTexel;
    float cost = length(o * uStepH) * 0.5 * (here + physarumCost(at));
    best = min(best, texture(uDist, at).r + cost);
  }
  fragColor = vec4(min(best, ${glslFloat(PHYSARUM_FAR)}), 0.0, 0.0, 1.0);
}
`;

/**
 * What the shader sees: the trail in tone, smoothed in time, and its slow memory. Tone is the trail
 * over its trunk level raised to the power that puts a typical filament (the share of the trunk
 * level uRef.g) at LACE_TONE: whatever the mould's own contrast, trunks read ~1 and the lace a dim,
 * steady ~0.3, never lost in the dark nor shouting as loud as the trunks.
 */
export const VIEW = `
uniform sampler2D uPrev;
uniform sampler2D uTrail;
uniform sampler2D uRef;
uniform float uBlend;
uniform float uRemember;
void main() {
  vec2 h = 0.5 * uTexel;
  float trail = 0.25 * (texture(uTrail, vUv + h).r + texture(uTrail, vUv - h).r
    + texture(uTrail, vUv + vec2(h.x, -h.y)).r + texture(uTrail, vUv + vec2(-h.x, h.y)).r);
  vec2 ref = texelFetch(uRef, ivec2(0), 0).rg;
  float gamma = clamp(log(${glslFloat(LACE_TONE)}) / log(clamp(ref.y, ${glslFloat(SHARE_MIN)}, ${glslFloat(SHARE_MAX)})), ${glslFloat(GAMMA_MIN)}, ${glslFloat(GAMMA_MAX)});
  float tone = pow(max(trail / max(ref.x, 1e-4), 1e-6), gamma);
  vec2 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rg;
  float now = mix(prev.r, tone, uBlend);
  fragColor = vec4(now, mix(prev.g, now, uRemember), 0.0, 1.0);
}
`;

/**
 * Block moments of the trail away from the flakes and their halos: (Σt², Σt³) for the trunk level,
 * and the sum and count of texels lit above FILAMENT_FLOOR of it, for a typical filament.
 */
export const SUMS = `
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uRef;
void main() {
  float haze = ${glslFloat(FILAMENT_FLOOR)} * texelFetch(uRef, ivec2(0), 0).r;
  vec2 grid = vec2(textureSize(uTrail, 0));
  vec2 base = floor(gl_FragCoord.xy) * 16.0;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      // Each tap sits on a texel corner, so the linear filter averages a 2 × 2 block.
      vec2 at = base + vec2(float(i), float(j)) * 2.0 + 1.0;
      if (at.x > grid.x || at.y > grid.y) continue;
      vec2 uv = at / grid;
      float t = texture(uTrail, uv).r * (1.0 - smoothstep(0.01, 0.1, texture(uEnv, uv).b));
      float lit = step(haze, t);
      sum += vec4(t * t, t * t * t, t * lit, lit);
    }
  }
  fragColor = sum;
}
`;

/**
 * The trunk level (the trail's mean weighted by its square, Σt³ / Σt²) and a typical filament's
 * share of it (the mean of the lit texels, over the trunk level), followed smoothly.
 */
export const LEVEL = `
uniform sampler2D uSums;
uniform sampler2D uPrev;
uniform float uBlend;
void main() {
  ivec2 size = textureSize(uSums, 0);
  vec4 total = vec4(0.0);
  for (int j = 0; j < 64; j++) {
    if (j >= size.y) break;
    for (int i = 0; i < 64; i++) {
      if (i >= size.x) break;
      total += texelFetch(uSums, ivec2(i, j), 0);
    }
  }
  vec2 prev = texelFetch(uPrev, ivec2(0), 0).rg;
  vec2 now = prev;
  if (total.x > 1e-9 && total.w > 0.5) {
    float trunk = total.y / total.x;
    now = vec2(trunk, (total.z / total.w) / trunk);
  }
  fragColor = vec4(max(mix(prev, now, uBlend), vec2(1e-5)), 0.0, 1.0);
}
`;
