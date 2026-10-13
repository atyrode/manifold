// The petri dish's chemistry, stepped on the GPU (sims/gpu.ts) on a square grid over the dish's
// bounding box; the shader (shader.ts) masks it to the circle, lights it and draws the glass.
//
// uSim0  the view, rgba16f N×N (linear): x the shown quantity, smoothed over 3×3 texels (Turing:
//        the activator v; BZ: the oxidised share, the blue of ferroin), yz its gradient per texel,
//        w Turing: how young the growth is (1 fresh .. 0 mature), BZ: the excitation u, smoothed.
//        Grid uv = (frame position - dish centre) / dish diameter + 0.5. N follows the dish's
//        diameter in dither cells and the scale knob, so features stay a readable size.
// uSim1  events, rgba16f 8×2 (nearest): row 0 the bubbles that mark BZ pacemakers (grid uv x, y,
//        radius, presence 0..1) and, in its last texel, the Turing M's ridge (height in grid uv,
//        0 = none; how far it has grown 0..1); row 1 the ripples of falling drops (x, y, age in
//        seconds, strength; 0 strength = none).
//
// State. An rgba32f ping-pong (half floats round away the tiny per-step changes both models live
// on). Texels outside the inscribed disc hold the medium at rest and never change; inside, a texel
// whose stencil reaches outside reads its own value there, so nothing flows through the glass.
//
// Turing: Gray–Scott (u substrate, v activator, z how long v has stood here), on Karl Sims's
// 9-point stencil (D_u 1, D_v 0.5, steps ≤ 1). Feed and kill drift along a loop through Pearson's
// classes (J. E. Pearson, "Complex patterns in a simple system", Science 261, 1993): fingerprints,
// coral, worms, dividing spots, still spots, mazes, holes. Regions of the dish run a little ahead of
// the drift or behind it, so neighbouring classes share the dish and the frontier between them
// sweeps by; staying on the loop keeps every region alive. A drop of fresh gel clears a disc,
// which the pattern grows back into from its rim and from a seed at its centre. The etched M grows
// a ridge of coral along its strokes: v is held there to a stripe's rounded profile, a little
// wider than a stripe, so the M keeps one width everywhere with clean ends and holds still, while
// the stripes round it arrange themselves parallel to it, as they do along any wall.
//
// BZ: Barkley's excitable medium (D. Barkley, "A model for fast computer simulation of waves in
// excitable media", Physica D 49, 1991): u the fast activator, v the slow recovery, with his
// semi-implicit step for the stiff cubic. Excitability drifts slowly over the dish, so spiral cores
// wander. Pacemakers, specks of dust marked by a bubble, fire rings at their own pace; drops bring
// new ones, which dissolve after a few minutes.
//
// Start. A fresh dish is seeded with a pattern already of the right kind: Turing, a band-pass noise
// at the pattern's natural wavelength, saturated into a labyrinth and set to the labyrinth's own
// levels of u and v (seeding bare gel between the stripes instead starves them, and most die),
// with the M's ridge and its parallel echoes already in place when the M is on; BZ, a phase field
// of a counter-rotating spiral pair and two pacemakers' target rings turned into the wave profile.
// A short prewarm then lets the chemistry settle the seed before the first frame.
//
// Clocks. "Chemistry seconds" are scene seconds × motion × tempo as actually simulated: steps per
// frame are capped, so a slow machine's dish runs slow rather than its events running ahead of it.
// Drops, drift and pacemakers all run on that clock (and the model time it stands for).
import { MARK_VERTICES, markDistance } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { GpuCompute, type Pass, type PingPong, type RenderTarget } from "../../sims/gpu.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

export const petriChemistries = ["Turing", "BZ"] as const;
export const petriPalettes = ["stain", "ink", "UV"] as const;

/** Inner radius of the dish in frame heights at the middle of the size knob... */
export const PETRI_RADIUS = 0.43;
/** ...and its cap as a share of the frame's width, for portrait screens. */
export const PETRI_FIT = 0.45;
/** Height of the Manifold M in dish diameters: base + span × the mark knob. */
export const PETRI_MARK = { base: 0.22, span: 0.36 } as const;
/** Bubbles (BZ pacemakers) and ripples (falling drops) the events texture holds. */
export const PETRI_BUBBLES = 6;
export const PETRI_RIPPLES = 4;
/** The texel of the events texture's row 0 that holds the Turing M's ridge. */
export const PETRI_RIDGE_TEXEL = 7;
/**
 * A drop's ripples: ring speed in dish diameters per second, width of the wave packet and how far
 * it bends the view of the bottom (dish diameters), seconds until it has died away.
 */
export const PETRI_RIPPLE = { speed: 0.2, width: 0.022, shift: 0.0035, life: 1.8 } as const;

/** The dish's inner radius in frame heights; the shader's petriRadius matches. */
export function petriRadius(aspect: number, size: number): number {
  return Math.min(PETRI_RADIUS * (0.75 + 0.5 * size), PETRI_FIT * aspect);
}

/** The Manifold M's height in dish diameters for the mark knob's size. */
export function petriMarkHeight(amount: number): number {
  return PETRI_MARK.base + PETRI_MARK.span * amount;
}

const TAU = Math.PI * 2;

const TURING = 0;
const BZ = 1;
type Chemistry = typeof TURING | typeof BZ;

/** Dither cells per grid texel across the dish at the fine and the bold end of the scale knob. */
const GRID_CELLS = [1.25, 2.75] as const;
/** Grid sizes, texels on a side: bounds, and the step they are rounded to (so resizes are rare). */
const GRID_MIN = 128;
const GRID_MAX = 320;
const GRID_ROUND = 16;

/** Gray–Scott model time per chemistry second, the longest step and the most steps in a frame. */
const TURING_RATE = 160;
const TURING_STEP = 1;
const TURING_STEPS = 10;
/** Steps a fresh dish takes before it is shown. */
const TURING_PREWARM = 140;
/**
 * The drift's loop over the (feed, kill) map, eased from one stop to the next. Feed and kill are
 * independent of the diffusion's scale, so these are the classic values.
 */
const TURING_PATH: readonly (readonly [number, number])[] = [
  [0.037, 0.06], //    fingerprints: long, parallel stripes
  [0.0545, 0.062], //  coral: stripes branching as they grow
  [0.05, 0.0635], //   worms: stripes breaking into short segments
  [0.0367, 0.0649], // mitosis: spots dividing to fill the dish
  [0.03, 0.062], //    solitons: spots holding still
  [0.029, 0.057], //   mazes: spots stretching into a maze
  [0.039, 0.058], //   holes: the maze swelling round dark holes
];
/** Path stops per chemistry second at full drift. */
const TURING_DRIFT = 1 / 40;
/** How far along the path, in stops, the dish's regions run ahead of the drift or behind it. */
const TURING_LEAD = 0.35;
/** Ripening of the growth per model time unit (it fades six times faster where the growth is gone). */
const TURING_RIPEN = 1 / 1600;
/**
 * The seed: the pattern's natural wavelength in texels, the plane waves its noise sums, and u and v
 * on a stripe and between stripes of the labyrinth.
 */
const TURING_PERIOD = 12.5;
const TURING_WAVES = 12;
const TURING_STRIPE = [0.37, 0.3] as const;
const TURING_GAP = [0.68, 0.07] as const;
/** Radius of the reagent the pointer paints, and of a drop's central seed, in texels. */
const TURING_BRUSH = 3.2;
const TURING_SEED = 3.5;
/** A drop's cleared disc, grid uv (smallest, largest), and how long it takes to spread. */
const TURING_DROP = [0.06, 0.1] as const;
const TURING_SPREAD = 1.6;
/**
 * The M's ridge: v is held to a rounded profile peaking at TURING_RIDGE_PEAK and falling to 0
 * TURING_RIDGE texels from the stroke's centre line (shown about 12 texels wide, a stripe and a
 * half), closing TURING_HOLD of the gap per model time unit.
 */
const TURING_RIDGE = 9;
const TURING_RIDGE_PEAK = 0.36;
const TURING_HOLD = 0.5;
/** Soft end of a growing ridge, as a share of the M's whole stroke. */
const TURING_RIDGE_TIP = 0.03;
/**
 * Chemistry seconds the ridge takes to grow along the M's strokes, and that one laid by 'now'
 * while the M is off holds before it is let go into the pattern.
 */
const TURING_MARK_GROW = 10;
const TURING_MARK_LINGER = 60;
/** The disc washed clean round the M on 'now': × its height, and at most (grid uv). */
const TURING_MARK_CLEAR = 0.75;
const TURING_MARK_CLEAR_MAX = 0.38;
/** The seed's stripes follow the M's outline out to this many wavelengths, fading into the labyrinth by the second. */
const TURING_ECHO = [1.5, 3] as const;

/** Barkley's a, b, ε and the grid spacing in model space units (diffusion 1). */
const BZ_A = 0.75;
const BZ_B = 0.06;
const BZ_EPS = 0.02;
const BZ_H = 0.4;
/** Model time per chemistry second, the longest step and the most steps in a frame. */
const BZ_RATE = 0.4;
const BZ_STEP = 0.03;
const BZ_STEPS = 4;
const BZ_PREWARM = 40;
/**
 * For the seeded start: wave speed in texels per model time unit, a spiral's period, and how long a
 * point stays excited (until v reaches a - b, rising as 1 - e^-t). Measured on this grid: a lone
 * front runs 7.3 texels per unit; a spiral turns in 4.5 units; a spark (BZ_FIRE) launches a ring
 * every time only at periods above about 4.
 */
const BZ_SPEED = 7.3;
const BZ_SPIRAL_PERIOD = 4.5;
const BZ_EXCITED = Math.log(1 / (1 - (BZ_A - BZ_B)));
/** The recovery v over which the dish turns blue (oxidised ferroin). */
const BZ_SHOWN = [0.25, 0.55] as const;
/** How far b varies over the dish, and how fast that field turns (radians per model time unit). */
const BZ_VARY = 0.008;
const BZ_DRIFT = 0.05;
/**
 * Model time between a pacemaker's rings: a fresh dish's are slower than its spirals, which in time
 * take over their ground; a dropped one may be faster, and push the spirals back while it lasts.
 * Chemistry seconds a dropped one lives.
 */
const BZ_PACE_SEEDED = [4.7, 5.6] as const;
const BZ_PACE = [4.1, 5.6] as const;
const BZ_LIFE = [90, 200] as const;
/** Pacemakers in a fresh dish (they stay), and the most dropped ones at a time. */
const BZ_SEED_PACEMAKERS = 2;
const BZ_TEMPORARY = 3;
/** Radii in texels: a pacemaker's spark, a drop's, the pointer's; half-width of the M's strokes. */
const BZ_FIRE = 3;
const BZ_DROP = 4.5;
const BZ_BRUSH = 3;
const BZ_MARK_WIDTH = 2.2;
/** Model time between the M's firings: faster than the spirals, so its fronts rule the dish. */
const BZ_MARK_PERIOD = 4.3;
/** A pacemaker's bubble: radius in grid uv, chemistry seconds to appear and to dissolve. */
const BUBBLE_RADIUS = 0.016;
const BUBBLE_GROW = 3;
const BUBBLE_DISSOLVE = 6;

/** Chemistry seconds between drops at the rare and the frequent end of the knob; before the first. */
const DROP_INTERVAL = [170, 35] as const;
const DROP_FIRST = 40;
/** Drops, sparks and spreading discs the touch pass applies in one frame. */
const MAX_TOUCHES = 6;
/** Width of the events texture (row 0 bubbles, row 1 ripples). */
const EVENT_WIDTH = 8;

/**
 * The M and the Turing ridge grown along it, for the passes here and the scene shader:
 *   petriMarkNear(q)   q in mark units: the distance to the M's strokes and how far along them,
 *                      0..1 from the foot of the left leg, the nearest point lies
 *   petriRidge(g, height, grown, texels)
 *                      g in grid uv, the M's height in grid uv, how far the ridge has grown 0..1,
 *                      grid texels per grid uv: the v held there and how firmly (0 off the strokes
 *                      and ahead of the growing tip)
 */
export const PETRI_MARK_GLSL = `
const vec2 PETRI_M[5] = vec2[5](${MARK_VERTICES.map(([x, y]) => `vec2(${glslFloat(x)}, ${glslFloat(y)})`).join(", ")});

vec2 petriMarkNear(vec2 q) {
  vec2 best = vec2(1e9, 0.0);
  float start = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = PETRI_M[i];
    vec2 ba = PETRI_M[i + 1] - a;
    float len = length(ba);
    float h = clamp(dot(q - a, ba) / (len * len), 0.0, 1.0);
    float d = length(q - a - ba * h);
    if (d < best.x) best = vec2(d, start + h * len);
    start += len;
  }
  return vec2(best.x, best.y / start);
}

vec2 petriRidge(vec2 g, float height, float grown, float texels) {
  vec2 near = petriMarkNear((g - 0.5) / height);
  float d = near.x * height * texels;
  float front = grown * (1.0 + ${glslFloat(TURING_RIDGE_TIP)});
  float hold = (1.0 - smoothstep(${glslFloat(TURING_RIDGE - 1)}, ${glslFloat(TURING_RIDGE + 1)}, d))
    * (1.0 - smoothstep(front - ${glslFloat(TURING_RIDGE_TIP)}, front, near.y));
  float q = d / ${glslFloat(TURING_RIDGE)};
  return vec2(${glslFloat(TURING_RIDGE_PEAK)} * max(0.0, 1.0 - q * q), hold);
}
`;

/** Helpers every pass shares; each pass declares `uniform sampler2D uState;` before them. */
const PASS_COMMON = `
// Inside the dish: the disc inscribed in the grid, less a texel and a half, so the stencil round any
// texel inside stays on the grid.
bool petriInside(ivec2 q) {
  vec2 d = vec2(q) + 0.5 - 0.5 * uSize;
  float r = 0.5 * uSize.x - 1.5;
  return dot(d, d) < r * r;
}

// A neighbour's state; beyond the glass, the texel's own (no flux through the wall).
vec4 petriTap(ivec2 q, vec4 here) {
  return petriInside(q) ? texelFetch(uState, q, 0) : here;
}

float petriSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0));
}
${PETRI_MARK_GLSL}
// A smooth field over the dish (g from its centre, in diameters), about -1..1: a long swell along
// 'heading' and a shorter one across it, both sliding with 'phase'.
float petriVary(vec2 g, float phase, float heading) {
  vec2 a = vec2(cos(heading), sin(heading));
  vec2 b = vec2(-a.y, a.x);
  return 0.65 * sin(dot(g, a) * 4.0 + phase) + 0.35 * sin(dot(g, b) * 7.0 - 0.6 * phase + 1.3);
}
`;

/** One Gray–Scott step: rgba = (u, v, ripeness, 0). */
const TURING_PASS = `
uniform sampler2D uState;
uniform float uDt;
uniform vec4 uFeedKill;  // (feed, kill) behind the drift and ahead of it on its path
uniform vec2 uVary;      // the variation field's phase and heading
uniform vec2 uMark;      // the M's ridge: height (grid uv; 0 = none), how far it has grown 0..1
${PASS_COMMON}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  if (!petriInside(ij)) {
    fragColor = vec4(1.0, 0.0, 0.0, 0.0);
    return;
  }
  vec4 c = texelFetch(uState, ij, 0);
  vec2 side = petriTap(ij + ivec2(1, 0), c).xy + petriTap(ij - ivec2(1, 0), c).xy
            + petriTap(ij + ivec2(0, 1), c).xy + petriTap(ij - ivec2(0, 1), c).xy;
  vec2 corner = petriTap(ij + ivec2(1, 1), c).xy + petriTap(ij + ivec2(-1, 1), c).xy
              + petriTap(ij + ivec2(1, -1), c).xy + petriTap(ij - ivec2(1, 1), c).xy;
  vec2 lap = 0.2 * side + 0.05 * corner - c.xy;
  float ahead = 0.5 + 0.5 * petriVary(vUv - 0.5, uVary.x, uVary.y);
  float feed = mix(uFeedKill.x, uFeedKill.z, ahead);
  float kill = mix(uFeedKill.y, uFeedKill.w, ahead);
  float u = c.x;
  float v = c.y;
  float r = u * v * v;
  u = clamp(u + uDt * (lap.x - r + feed * (1.0 - u)), 0.0, 1.0);
  v = clamp(v + uDt * (0.5 * lap.y + r - (feed + kill) * v), 0.0, 1.0);
  if (uMark.x > 0.0) {
    vec2 ridge = petriRidge(vUv, uMark.x, uMark.y, uSize.x);
    v += (ridge.x - v) * ridge.y * min(1.0, uDt * ${glslFloat(TURING_HOLD)});
  }
  // Growth ripens where v stands and is forgotten where it is gone; the edges of a still stripe
  // count as standing, so only newly covered gel reads as fresh.
  float here = smoothstep(0.02, 0.07, v);
  float ripe = c.z + uDt * ${glslFloat(TURING_RIPEN)} * (here * (1.0 - c.z) - 6.0 * (1.0 - here) * c.z);
  fragColor = vec4(u, v, clamp(ripe, 0.0, 1.0), 0.0);
}
`;

/** One Barkley step: rgba = (u, v, 0, 0). */
const BZ_PASS = `
uniform sampler2D uState;
uniform float uDt;
uniform vec4 uModel; // a, b, 1 / eps, diffusion / h^2
uniform vec4 uVary;  // amplitude of b, unused, phase, heading
${PASS_COMMON}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  if (!petriInside(ij)) {
    fragColor = vec4(0.0);
    return;
  }
  vec4 c = texelFetch(uState, ij, 0);
  float side = petriTap(ij + ivec2(1, 0), c).x + petriTap(ij - ivec2(1, 0), c).x
             + petriTap(ij + ivec2(0, 1), c).x + petriTap(ij - ivec2(0, 1), c).x;
  float corner = petriTap(ij + ivec2(1, 1), c).x + petriTap(ij + ivec2(-1, 1), c).x
               + petriTap(ij + ivec2(1, -1), c).x + petriTap(ij - ivec2(1, 1), c).x;
  // The isotropic 9-point Laplacian (Patra & Karttunen), so fronts stay round on the grid.
  float lap = (4.0 * side + corner - 20.0 * c.x) / 6.0 * uModel.w;
  float b = uModel.y + uVary.x * petriVary(vUv - 0.5, uVary.z, uVary.w);
  float u = c.x;
  float v = c.y;
  float threshold = (v + b) / uModel.x;
  float k = uDt * uModel.z;
  // Barkley's step: implicit in the stiff cubic, so u stays in 0..1 at any step.
  float next;
  if (u < threshold) {
    next = u / (1.0 + k * (1.0 - u) * (threshold - u));
  } else {
    float q = k * (u - threshold);
    next = u * (1.0 + q) / (1.0 + q * u);
  }
  next = clamp(next + uDt * lap, 0.0, 1.0);
  fragColor = vec4(next, v + uDt * (u - v), 0.0, 0.0);
}
`;

/**
 * What the pointer, drops, pacemakers and the M put into the dish this frame. Turing: reagent
 * (u 0.5, v 0.25, fresh), and fresh gel clearing discs; BZ: excitation (u 1), the M's included.
 */
const TOUCH_PASS = `
uniform sampler2D uState;
uniform float uChem;          // 0 Turing, 1 BZ
uniform vec4 uStroke;         // the pointer's path this frame: from xy to zw, grid uv
uniform float uStrokeRadius;  // grid uv; 0: no stroke
uniform vec4 uDrops[${MAX_TOUCHES}];  // centre xy; Turing: cleared radius, seed radius; BZ: spark radius
uniform int uDropCount;
uniform vec2 uMark;           // BZ's M firing: height (grid uv; 0: not this frame), half-width of its strokes
${PASS_COMMON}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, ij, 0);
  if (!petriInside(ij)) {
    fragColor = s;
    return;
  }
  vec2 g = vUv;
  float add = 0.0;
  float clear = 0.0;
  if (uStrokeRadius > 0.0) {
    float d = petriSegment(g, uStroke.xy, uStroke.zw);
    add = 1.0 - smoothstep(0.5 * uStrokeRadius, uStrokeRadius, d);
  }
  for (int i = 0; i < ${MAX_TOUCHES}; i++) {
    if (i >= uDropCount) break;
    vec4 drop = uDrops[i];
    float d = distance(g, drop.xy);
    if (uChem < 0.5) {
      clear = max(clear, 1.0 - smoothstep(0.85 * drop.z, drop.z, d));
      if (drop.w > 0.0) add = max(add, 1.0 - smoothstep(0.5 * drop.w, drop.w, d));
    } else {
      add = max(add, 1.0 - smoothstep(0.5 * drop.z, drop.z, d));
    }
  }
  if (uMark.x > 0.0) {
    float d = petriMarkNear((g - 0.5) / uMark.x).x * uMark.x;
    add = max(add, 1.0 - smoothstep(0.5 * uMark.y, uMark.y, d));
  }
  if (uChem < 0.5) {
    s = mix(s, vec4(1.0, 0.0, 0.0, 0.0), clear);
    s.x = mix(s.x, 0.5, add);
    s.y = max(s.y, 0.25 * add);
    s.z = min(s.z, 1.0 - add);
  } else {
    s.x = max(s.x, add);
  }
  fragColor = s;
}
`;

/** The view the scene samples: the shown quantity smoothed, its Sobel gradient, and the extra. */
const VIEW_PASS = `
uniform sampler2D uState;
uniform float uChem; // 0 Turing, 1 BZ
float petriShown(vec4 s) {
  return uChem < 0.5 ? s.y : smoothstep(${glslFloat(BZ_SHOWN[0])}, ${glslFloat(BZ_SHOWN[1])}, s.y);
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  ivec2 hi = ivec2(uSize) - 1;
  float sum = 0.0;
  float extra = 0.0;
  float weight = 0.0;
  vec2 grad = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 s = texelFetch(uState, clamp(ij + ivec2(x, y), ivec2(0), hi), 0);
      float h = petriShown(s);
      float wx = x == 0 ? 2.0 : 1.0;
      float wy = y == 0 ? 2.0 : 1.0;
      sum += wx * wy * h;
      grad += vec2(float(x) * wy, float(y) * wx) * h;
      // Turing: the growth's youth, averaged over the growth only (bare gel would read as fresh
      // round every stripe); BZ: the excitation.
      float w = uChem < 0.5 ? wx * wy * smoothstep(0.02, 0.07, s.y) : wx * wy;
      extra += w * (uChem < 0.5 ? 1.0 - s.z : s.x);
      weight += w;
    }
  }
  fragColor = vec4(sum / 16.0, grad / 8.0, extra / max(weight, 1e-3));
}
`;

/** A BZ pacemaker: a speck that fires a ring now and then, marked by a bubble. */
interface Pacemaker {
  /** Grid uv. */
  x: number;
  y: number;
  /** Model time between its rings, and the model time of its next. */
  period: number;
  next: number;
  /** Chemistry seconds it appeared and dissolves (Infinity: it stays). */
  born: number;
  dies: number;
}

/** A Turing drop of fresh gel spreading over the dish. */
interface Spread {
  /** Grid uv. */
  x: number;
  y: number;
  /** Final radius of the cleared disc, and of the reagent seeded at its centre (grid uv; 0: none). */
  radius: number;
  seed: number;
  /** Chemistry seconds it landed. */
  start: number;
}

/** Rings on the surface where a drop fell, for the shader. */
interface Ripple {
  x: number;
  y: number;
  /** Seconds since it fell (scene seconds × motion). */
  age: number;
  strength: number;
}

/** The knobs the sim reads. */
type Knob = "chemistry" | "tempo" | "drift" | "scale" | "drops" | "pattern" | "size" | "mark";

/** Texels across the dish for its diameter in dither cells and the scale knob. */
function gridFor(diameterCells: number, scale: number): number {
  const perTexel = lerp(GRID_CELLS[0], GRID_CELLS[1], clamp(scale, 0, 1));
  const texels = Math.round(diameterCells / perTexel / GRID_ROUND) * GRID_ROUND;
  return Number.isFinite(texels) ? Math.min(GRID_MAX, Math.max(GRID_MIN, texels)) : GRID_MIN;
}

/** Feed and kill at a position along TURING_PATH (stops, wrapping), eased between stops, into out[at..]. */
function turingAt(position: number, out: Float32Array, at: number): void {
  const count = TURING_PATH.length;
  const wrapped = ((position % count) + count) % count;
  const i = Math.floor(wrapped);
  const from = TURING_PATH[i % count] ?? [0.037, 0.06];
  const to = TURING_PATH[(i + 1) % count] ?? from;
  const e = smoothstep(0, 1, wrapped - i);
  out[at] = from[0] + (to[0] - from[0]) * e;
  out[at + 1] = from[1] + (to[1] - from[1]) * e;
}

/**
 * Seed a Turing dish: band-pass noise (plane waves at the natural wavelength, all directions)
 * saturated into a labyrinth, at a stripe's and a gap's own u and v. With the M's height (grid uv;
 * 0 = none), the stripes near it run parallel to its strokes, a stripe on the strokes themselves,
 * as the labyrinth arranges itself round the ridge. rgba = (u, v, ripeness, 0): the seeded growth
 * counts as mature.
 */
function seedTuring(data: Float32Array, n: number, random: () => number, markHeight: number): void {
  const k = TAU / TURING_PERIOD;
  const waves = new Float64Array(TURING_WAVES * 3);
  const turn = random() * Math.PI;
  for (let i = 0; i < TURING_WAVES; i++) {
    const angle = turn + (Math.PI * (i + 0.7 * (random() - 0.5))) / TURING_WAVES;
    waves[i * 3] = Math.cos(angle) * k;
    waves[i * 3 + 1] = Math.sin(angle) * k;
    waves[i * 3 + 2] = random() * TAU;
  }
  const norm = Math.sqrt(2 / TURING_WAVES);
  const half = n / 2;
  const inside = (half - 1.5) ** 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      data[i] = 1;
      if (dx * dx + dy * dy >= inside) continue;
      let sum = 0;
      for (let w = 0; w < waves.length; w += 3) sum += Math.cos((waves[w] ?? 0) * x + (waves[w + 1] ?? 0) * y + (waves[w + 2] ?? 0));
      let field = sum * norm;
      if (markHeight > 0) {
        const d = markDistance(dx / (markHeight * n), dy / (markHeight * n)) * markHeight * n;
        const echo = smoothstep(TURING_ECHO[1] * TURING_PERIOD, TURING_ECHO[0] * TURING_PERIOD, d);
        field += (1.2 * Math.cos(k * d) - field) * echo;
      }
      const m = 0.5 + 0.5 * Math.tanh(3 * field);
      data[i] = TURING_GAP[0] + (TURING_STRIPE[0] - TURING_GAP[0]) * m;
      data[i + 1] = TURING_GAP[1] + (TURING_STRIPE[1] - TURING_GAP[1]) * m;
      data[i + 2] = 0.9;
    }
  }
}

/**
 * Seed a BZ dish: a counter-rotating spiral pair and two pacemakers' target rings, as a phase
 * field (each texel takes the nearest source) turned into the wave profile: excited for
 * BZ_EXCITED after the front, then recovering. Returns the pacemakers, timed to their rings.
 */
function seedBz(data: Float32Array, n: number, random: () => number): Pacemaker[] {
  const half = n / 2;
  const inside = (half - 1.5) ** 2;
  const spiral = BZ_SPEED * BZ_SPIRAL_PERIOD;
  const bearing = random() * TAU;
  const out = Math.sqrt(random()) * 0.18 * n;
  const mx = half + Math.cos(bearing) * out;
  const my = half + Math.sin(bearing) * out;
  const turn = random() * TAU;
  const gap = (0.04 + 0.02 * random()) * n;
  const ax = mx + Math.cos(turn) * gap;
  const ay = my + Math.sin(turn) * gap;
  const bx = mx - Math.cos(turn) * gap;
  const by = my - Math.sin(turn) * gap;
  const spin = random();

  const pacemakers: Pacemaker[] = [];
  const phases: number[] = [];
  for (let tries = 0; tries < 60 && pacemakers.length < BZ_SEED_PACEMAKERS; tries++) {
    const angle = random() * TAU;
    const reach = (0.12 + 0.24 * Math.sqrt(random())) * n;
    const x = half + Math.cos(angle) * reach;
    const y = half + Math.sin(angle) * reach;
    if (Math.hypot(x - mx, y - my) < 0.24 * n) continue;
    if (pacemakers.some((p) => Math.hypot(x - p.x * n, y - p.y * n) < 0.22 * n)) continue;
    const period = lerp(BZ_PACE_SEEDED[0], BZ_PACE_SEEDED[1], random());
    const phase = random();
    phases.push(phase);
    pacemakers.push({ x: x / n, y: y / n, period, next: (1 - phase) * period, born: -Infinity, dies: Infinity });
  }

  const excitedV = 1 - Math.exp(-BZ_EXCITED);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      if ((px - half) ** 2 + (py - half) ** 2 >= inside) continue;
      let nearest = Math.hypot(px - mx, py - my);
      let phase = (Math.atan2(py - ay, px - ax) - Math.atan2(py - by, px - bx)) / TAU - nearest / spiral + spin;
      let period = BZ_SPIRAL_PERIOD;
      for (let j = 0; j < pacemakers.length; j++) {
        const pacemaker = pacemakers[j];
        if (!pacemaker) continue;
        const d = Math.hypot(px - pacemaker.x * n, py - pacemaker.y * n);
        if (d >= nearest) continue;
        nearest = d;
        phase = (phases[j] ?? 0) - d / (BZ_SPEED * pacemaker.period);
        period = pacemaker.period;
      }
      // Model time since the front passed here: excited, then recovering.
      const since = (phase - Math.floor(phase)) * period;
      if (since < BZ_EXCITED) {
        data[i] = 1;
        data[i + 1] = 1 - Math.exp(-since);
      } else {
        data[i + 1] = excitedV * Math.exp(-(since - BZ_EXCITED));
      }
    }
  }
  return pacemakers;
}

/** The dish's chemistry on the GPU. */
class PetriLab implements SceneSim {
  readonly #gpu: GpuCompute;
  readonly #knobs: KnobReader<Knob>;
  /** Trigger slots of the drops and mark knobs. */
  readonly #dropSlot: number;
  readonly #markSlot: number;
  readonly #state: PingPong;
  readonly #view: RenderTarget;
  readonly #turing: Pass;
  readonly #bz: Pass;
  readonly #touch: Pass;
  readonly #shade: Pass;
  readonly #eventTexture: DataTexture;
  readonly #eventData = new Float32Array(EVENT_WIDTH * 2 * 4);
  readonly #eventShown = new Float32Array(EVENT_WIDTH * 2 * 4);
  // Uniform values, reused frame to frame.
  readonly #feedKill = new Float32Array(4);
  readonly #turingVary = new Float32Array(2);
  readonly #bzVary = new Float32Array(4);
  /** Turing: the M's ridge, as uMark: height (grid uv; 0 = none), how far it has grown 0..1. */
  readonly #ridge = new Float32Array(2);
  readonly #model4 = new Float32Array([BZ_A, BZ_B, 1 / BZ_EPS, 1 / (BZ_H * BZ_H)]);
  readonly #stroke = new Float32Array(4);
  readonly #touches = new Float32Array(MAX_TOUCHES * 4);
  /** BZ: the M firing this frame, as the touch pass's uMark: height (grid uv; 0 = not now), half-width. */
  readonly #touchMark = new Float32Array(2);
  #touchCount = 0;

  #chemistry: Chemistry | undefined;
  #pattern = 0;
  #random: () => number = mulberry32(1);
  /** Chemistry seconds and model time simulated since the dish was seeded. */
  #clock = 0;
  #model = 0;
  /** Turing: position along TURING_PATH; BZ: phase of the excitability field. */
  #drift = 0;
  #heading = 0;
  #untilDrop = DROP_FIRST;
  #pacemakers: Pacemaker[] = [];
  #spreads: Spread[] = [];
  #ripples: Ripple[] = [];
  #markOn = false;
  /** BZ: model time of the M's next firing. */
  #nextMark = 0;
  /** Turing: the chemistry second a ridge laid by 'now' with the M off is let go. */
  #ridgeUntil = 0;
  #lastX = 0;
  #lastY = 0;
  #held = false;
  /** The view needs redrawing even without a step (reseeded, resized). */
  #dirty = true;

  constructor(gpu: GpuCompute, knobs: KnobReader<Knob>) {
    this.#gpu = gpu;
    this.#knobs = knobs;
    this.#dropSlot = knobs.trigger("drops");
    this.#markSlot = knobs.trigger("mark");
    const size = { width: GRID_MIN, height: GRID_MIN };
    this.#state = gpu.pingPong({ ...size, format: "rgba32f", filter: "nearest" });
    this.#view = gpu.target({ ...size, format: "rgba16f" });
    this.#turing = gpu.pass(TURING_PASS, "petri gray-scott").bind({ uState: this.#state });
    this.#bz = gpu.pass(BZ_PASS, "petri barkley").bind({ uState: this.#state });
    this.#bz.set({ uModel: this.#model4 });
    this.#touch = gpu.pass(TOUCH_PASS, "petri touch").bind({ uState: this.#state });
    this.#shade = gpu.pass(VIEW_PASS, "petri view").bind({ uState: this.#state });
    this.#eventTexture = new DataTexture(gpu.gl, { width: EVENT_WIDTH, height: 2, format: "rgba16f", filter: "nearest" });
    this.#eventTexture.upload(this.#eventShown);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 && Number.isFinite(frame.aspect) ? frame.aspect : 16 / 9;
    const chemistry: Chemistry = this.#knobs.value(frame, "chemistry") > 0.5 ? BZ : TURING;
    const pattern = Math.round(this.#knobs.value(frame, "pattern"));
    const radius = petriRadius(aspect, this.#knobs.value(frame, "size"));
    const n = gridFor(2 * radius * frame.height, this.#knobs.value(frame, "scale"));
    if (chemistry !== this.#chemistry || pattern !== this.#pattern) {
      this.#reseed(chemistry, pattern, n, this.#knobs.value(frame, "mark"));
    } else if (n !== this.#state.width) {
      // A new scale or frame size: stretch the pattern over the new grid; it re-forms at its own size.
      this.#state.resize(n, n, true);
      this.#view.resize(n, n);
      this.#dirty = true;
    }
    const turing = chemistry === TURING;

    // This frame's chemistry: model time in equal steps, capped, so a slow machine's dish runs slow.
    const rate = turing ? TURING_RATE : BZ_RATE;
    const longest = turing ? TURING_STEP : BZ_STEP;
    const wanted = Math.max(0, frame.dt) * Math.max(0, frame.motion) * Math.max(0, this.#knobs.value(frame, "tempo")) * rate;
    const steps = wanted > 0 ? Math.min(turing ? TURING_STEPS : BZ_STEPS, Math.ceil(wanted / longest - 1e-6)) : 0;
    const model = steps > 0 ? Math.min(wanted, steps * longest) : 0;
    const seconds = model / rate;
    this.#clock += seconds;
    this.#model += model;

    this.#touchCount = 0;
    this.#touchMark[0] = 0;
    this.#events(frame, turing, seconds, n);
    const stroke = this.#pointer(frame, aspect, radius);
    const touched = stroke || this.#touchCount > 0 || (this.#touchMark[0] ?? 0) > 0;
    if (touched) {
      this.#touch.run(this.#state, {
        uniforms: {
          uChem: turing ? 0 : 1,
          uStroke: this.#stroke,
          uStrokeRadius: stroke ? (turing ? TURING_BRUSH : BZ_BRUSH) / n : 0,
          uDrops: this.#touches,
          uDropCount: this.#touchCount,
          uMark: this.#touchMark,
        },
      });
    }

    if (steps > 0) {
      const drift = Math.max(0, this.#knobs.value(frame, "drift"));
      const dt = model / steps;
      if (turing) {
        this.#drift += seconds * drift * TURING_DRIFT;
        this.#setTuring(dt);
        for (let i = 0; i < steps; i++) this.#turing.run(this.#state);
      } else {
        this.#drift += model * drift * BZ_DRIFT;
        this.#setBz(dt);
        for (let i = 0; i < steps; i++) this.#bz.run(this.#state);
      }
    }
    if (steps > 0 || touched || this.#dirty) {
      this.#shade.run(this.#view, { uniforms: { uChem: turing ? 0 : 1 } });
      this.#dirty = false;
    }

    this.#ageRipples(Math.max(0, frame.dt) * Math.max(0, frame.motion));
    this.#publish();
    return [this.#view.texture, this.#eventTexture.texture];
  }

  dispose(): void {
    this.#gpu.dispose();
    this.#eventTexture.dispose();
  }

  /**
   * A fresh dish of `chemistry` for this pattern seed, settled by a short prewarm. A Turing M
   * already on stands grown in it from the start, the stripes round it already following it.
   */
  #reseed(chemistry: Chemistry, pattern: number, n: number, mark: number): void {
    this.#chemistry = chemistry;
    this.#pattern = pattern;
    this.#state.resize(n, n);
    this.#view.resize(n, n);
    this.#random = mulberry32((Math.imul(pattern + 1, 0x9e3779b1) ^ Math.imul(chemistry + 1, 0x85ebca6b)) >>> 0);
    const data = new Float32Array(n * n * 4);
    const ridge = chemistry === TURING && mark > 0 ? petriMarkHeight(mark) : 0;
    if (chemistry === TURING) {
      seedTuring(data, n, this.#random, ridge);
      this.#pacemakers = [];
    } else {
      this.#pacemakers = seedBz(data, n, this.#random);
    }
    this.#state.seed(data);
    this.#clock = 0;
    this.#model = 0;
    this.#drift = 0;
    this.#heading = this.#random() * TAU;
    this.#untilDrop = DROP_FIRST;
    this.#spreads = [];
    this.#ripples = [];
    this.#ridge[0] = ridge;
    this.#ridge[1] = 1;
    this.#ridgeUntil = 0;
    // BZ's M, already on, fires into the fresh dish at once.
    this.#markOn = ridge > 0;
    this.#held = false;
    if (chemistry === TURING) {
      this.#setTuring(TURING_STEP);
      for (let i = 0; i < TURING_PREWARM; i++) this.#turing.run(this.#state);
    } else {
      this.#setBz(BZ_STEP);
      for (let i = 0; i < BZ_PREWARM; i++) this.#bz.run(this.#state);
    }
    this.#dirty = true;
  }

  /**
   * Gray–Scott's uniforms: feed and kill behind and ahead of the drift (regions of the dish pick
   * their place between by the variation field, which slides and turns with the drift), and the
   * M's ridge.
   */
  #setTuring(dt: number): void {
    turingAt(this.#drift - TURING_LEAD, this.#feedKill, 0);
    turingAt(this.#drift + TURING_LEAD, this.#feedKill, 2);
    this.#turingVary[0] = this.#drift * 0.9;
    this.#turingVary[1] = this.#heading + this.#drift * 0.35;
    this.#turing.set({ uDt: dt, uFeedKill: this.#feedKill, uVary: this.#turingVary, uMark: this.#ridge });
  }

  /** Barkley's uniforms: the step, and the excitability field sliding and turning with the drift. */
  #setBz(dt: number): void {
    const vary = this.#bzVary;
    vary[0] = BZ_VARY;
    vary[2] = this.#drift;
    vary[3] = this.#heading + this.#drift * 0.3;
    this.#bz.set({ uDt: dt, uVary: vary });
  }

  #addTouch(x: number, y: number, a: number, b: number): void {
    if (this.#touchCount >= MAX_TOUCHES) return;
    const i = this.#touchCount * 4;
    this.#touches[i] = x;
    this.#touches[i + 1] = y;
    this.#touches[i + 2] = a;
    this.#touches[i + 3] = b;
    this.#touchCount++;
  }

  #ripple(x: number, y: number, strength: number): void {
    if (this.#ripples.length >= PETRI_RIPPLES) this.#ripples.shift();
    this.#ripples.push({ x, y, age: 0, strength });
  }

  /** A random spot in the dish, away from the glass. */
  #somewhere(): { x: number; y: number } {
    const angle = this.#random() * TAU;
    const reach = Math.sqrt(this.#random()) * 0.34;
    return { x: 0.5 + Math.cos(angle) * reach, y: 0.5 + Math.sin(angle) * reach };
  }

  /** A drop lands: Turing, fresh gel spreading from it; BZ, a spark and a new pacemaker. */
  #drop(turing: boolean, n: number): void {
    const { x, y } = this.#somewhere();
    this.#ripple(x, y, 1);
    if (turing) {
      this.#spreads.push({ x, y, radius: lerp(TURING_DROP[0], TURING_DROP[1], this.#random()), seed: TURING_SEED / n, start: this.#clock });
      return;
    }
    this.#addTouch(x, y, BZ_DROP / n, 0);
    this.#addPacemaker(x, y);
  }

  #addPacemaker(x: number, y: number): void {
    const now = this.#clock;
    const dropped = this.#pacemakers.filter((p) => p.dies !== Infinity && p.dies - BUBBLE_DISSOLVE > now);
    const oldest = dropped[0];
    if (oldest && dropped.length >= BZ_TEMPORARY) oldest.dies = Math.min(oldest.dies, now + BUBBLE_DISSOLVE);
    if (this.#pacemakers.length >= PETRI_BUBBLES) {
      const gone = this.#pacemakers.findIndex((p) => p.dies !== Infinity);
      this.#pacemakers.splice(gone < 0 ? 0 : gone, 1);
    }
    const period = lerp(BZ_PACE[0], BZ_PACE[1], this.#random());
    this.#pacemakers.push({ x, y, period, next: this.#model + period, born: now, dies: now + lerp(BZ_LIFE[0], BZ_LIFE[1], this.#random()) });
  }

  /** The 'now' buttons, the scheduled drops, the pacemakers' rings, the M and spreading drops. */
  #events(frame: SimFrame, turing: boolean, seconds: number, n: number): void {
    const dropNow = frame.fired[this.#dropSlot] === true;
    const markNow = frame.fired[this.#markSlot] === true;

    const rate = this.#knobs.value(frame, "drops");
    if (dropNow) this.#drop(turing, n);
    if (rate > 0) {
      this.#untilDrop -= seconds;
      if (this.#untilDrop <= 0) {
        this.#drop(turing, n);
        this.#untilDrop = lerp(DROP_INTERVAL[0], DROP_INTERVAL[1], clamp(rate, 0, 1)) * (0.7 + 0.6 * this.#random());
      }
    }

    // The M. Turing: a ridge of coral along its strokes, grown when switched on and held while on;
    // 'now' washes the dish round it clean and grows it afresh (with the M off, at the middle size,
    // let go after a while). BZ: it fires when switched on and on 'now', and keeps firing while on.
    const amount = this.#knobs.value(frame, "mark");
    const on = amount > 0;
    if (turing) {
      const ridge = this.#ridge;
      if (markNow) {
        const height = petriMarkHeight(on ? amount : 0.5);
        ridge[0] = height;
        ridge[1] = 0;
        this.#ridgeUntil = this.#clock + TURING_MARK_LINGER;
        this.#spreads.push({ x: 0.5, y: 0.5, radius: Math.min(TURING_MARK_CLEAR * height, TURING_MARK_CLEAR_MAX), seed: 0, start: this.#clock });
        this.#ripple(0.5, 0.5, 0.7);
      } else if (on) {
        if (ridge[0] === 0) ridge[1] = 0;
        ridge[0] = petriMarkHeight(amount);
      } else if (this.#clock >= this.#ridgeUntil) {
        ridge[0] = 0;
      }
      ridge[1] = Math.min(1, (ridge[1] ?? 0) + seconds / TURING_MARK_GROW);
    } else if (markNow || (on && (!this.#markOn || this.#model >= this.#nextMark))) {
      this.#touchMark[0] = petriMarkHeight(on ? amount : 0.5);
      this.#touchMark[1] = BZ_MARK_WIDTH / n;
      this.#nextMark = this.#model + BZ_MARK_PERIOD;
    }
    this.#markOn = on;

    if (turing) {
      // Spreading drops clear a growing disc (easing out), holding their seed until they settle.
      const spreads = this.#spreads;
      let kept = 0;
      for (let i = 0; i < spreads.length; i++) {
        const spread = spreads[i];
        if (!spread) continue;
        const k = clamp((this.#clock - spread.start) / TURING_SPREAD, 0, 1);
        const reach = spread.radius * (1 - (1 - k) ** 3);
        this.#addTouch(spread.x, spread.y, reach, spread.seed);
        if (k < 1) spreads[kept++] = spread;
      }
      spreads.length = kept;
      return;
    }

    // Pacemakers fire on time unless dissolving; dissolved ones are gone.
    const pacemakers = this.#pacemakers;
    let alive = 0;
    for (let i = 0; i < pacemakers.length; i++) {
      const pacemaker = pacemakers[i];
      if (!pacemaker || this.#clock >= pacemaker.dies) continue;
      if (this.#clock < pacemaker.dies - BUBBLE_DISSOLVE && this.#model >= pacemaker.next) {
        this.#addTouch(pacemaker.x, pacemaker.y, BZ_FIRE / n, 0);
        pacemaker.next += pacemaker.period;
        if (pacemaker.next <= this.#model) pacemaker.next = this.#model + pacemaker.period;
      }
      pacemakers[alive++] = pacemaker;
    }
    pacemakers.length = alive;
  }

  /** Held down in the dish, the pointer paints reagent (Turing) or sparks waves (BZ) along its path. */
  #pointer(frame: SimFrame, aspect: number, radius: number): boolean {
    const pointer = frame.pointer;
    if (frame.dt <= 0 || !pointer.inside || !pointer.down) {
      this.#held = false;
      return false;
    }
    const x = ((pointer.x - 0.5) * aspect) / (2 * radius) + 0.5;
    const y = (pointer.y - 0.5) / (2 * radius) + 0.5;
    const stroke = this.#stroke;
    stroke[0] = this.#held ? this.#lastX : x;
    stroke[1] = this.#held ? this.#lastY : y;
    stroke[2] = x;
    stroke[3] = y;
    if (!this.#held && Math.hypot(x - 0.5, y - 0.5) < 0.48) this.#ripple(x, y, 0.5);
    this.#held = true;
    this.#lastX = x;
    this.#lastY = y;
    return true;
  }

  #ageRipples(dt: number): void {
    const ripples = this.#ripples;
    let kept = 0;
    for (let i = 0; i < ripples.length; i++) {
      const ripple = ripples[i];
      if (!ripple) continue;
      ripple.age += dt;
      if (ripple.age < PETRI_RIPPLE.life) ripples[kept++] = ripple;
    }
    ripples.length = kept;
  }

  /** Write the bubbles, the ridge and the ripples for the shader; upload only when they changed. */
  #publish(): void {
    const data = this.#eventData;
    data.fill(0);
    let i = 0;
    for (const pacemaker of this.#pacemakers) {
      if (i >= PETRI_BUBBLES) break;
      const presence = clamp((this.#clock - pacemaker.born) / BUBBLE_GROW, 0, 1) * clamp((pacemaker.dies - this.#clock) / BUBBLE_DISSOLVE, 0, 1);
      if (presence <= 0) continue;
      data[i * 4] = pacemaker.x;
      data[i * 4 + 1] = pacemaker.y;
      data[i * 4 + 2] = BUBBLE_RADIUS;
      data[i * 4 + 3] = presence;
      i++;
    }
    data[PETRI_RIDGE_TEXEL * 4] = this.#ridge[0] ?? 0;
    data[PETRI_RIDGE_TEXEL * 4 + 1] = this.#ridge[1] ?? 0;
    for (let j = 0; j < this.#ripples.length; j++) {
      const ripple = this.#ripples[j];
      if (!ripple) continue;
      const at = (EVENT_WIDTH + j) * 4;
      data[at] = ripple.x;
      data[at + 1] = ripple.y;
      data[at + 2] = ripple.age;
      data[at + 3] = ripple.strength;
    }
    let changed = false;
    for (let k = 0; k < data.length; k++) {
      if (data[k] !== this.#eventShown[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.#eventShown.set(data);
    this.#eventTexture.upload(data);
  }
}

/**
 * The petri dish's chemistry. `knobs` are the scene's params, so it reads its own knobs from
 * `SimFrame.values` by key. Without float render targets it supplies nothing and the shader draws
 * a still dish of its own.
 */
export function petriSim(knobs: readonly ParamDef[]): SimFactory {
  const reader = new KnobReader<Knob>("petri", knobs, ["chemistry", "tempo", "drift", "scale", "drops", "pattern", "size", "mark"]);
  return (gl): SceneSim => {
    const gpu = GpuCompute.create(gl);
    if (!gpu) return { frame: () => [], dispose: () => undefined };
    return new PetriLab(gpu, reader);
  };
}
