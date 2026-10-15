// A soap film in a wire loop or frame, or a free bubble, against the dark. Its colours are thin-film
// interference: light reflected from the film's front and back surfaces interferes (half a wave
// apart where it bounces off the denser water at the front), so each thickness reflects its own
// colour, black where the film is far thinner than a wavelength. Its flow is a 2D fluid on the GPU
// (sims/fluid.ts) and its thickness that fluid's dye.
//
// uSim0  the film, rg16f, DYE_RESOLUTION texels on the short side (569×320 at 16:9):
//          r  thickness in µm: BLACK for black film, ~1 low down, ~1.3 freshly drawn
//          g  share of the texel holding film, 0..1 (0 where it has burst)
// uSim1  the interference colours, rgba16f LUT_SIZE×1: linear sRGB reflected by a film
//        (i / (LUT_SIZE - 1)) × LUT_MAX µm thick in white light, scaled so REFLECT_PEAK is 1
// uSim2  the film's life, rgba16f 2×1:
//          texel 0  the break (q: frame heights from the view's centre, y up), seconds since it
//                   broke, 1 while the hole is opening (2 while the exit paces it: the seconds are
//                   then a share of when the rim reaches the far point, see filmFarPoint)
//          texel 1  the liquid line drawing a new film (its height where it meets the wire), or the
//                   radius of a bubble being blown; 1 while drawing; unused; 1 while there is a film
// uSim3  the burst's arrival field (sims/front.ts), rg16f at the film's size, made as the film breaks:
//          r  seconds after the break the rim reaches the texel; g its slowness there
//
// Thickness, after each fluid step (the physics pass):
//   drainage       gravity pulls the film's water down at DRAIN × h^1.5 (thick film falls fastest),
//                  carried down from above, so the film thins from the top and its profile
//                  steepens there (Mysels' h ∝ √depth, between that and linear): dense colour bands
//                  under the top wire spreading down, and black film creeping after them
//   evaporation    a slow thinning everywhere
//   black film     below BLACK_ONSET the film collapses to the common black film, BLACK thick
//   Plateau border the meniscus along the lower wire feeds thick film back in
//   regeneration   "marginal regeneration": patches of thin film pulled out of the wire low on the
//                  sides and along the bottom (spots) that rise as plumes
// Flow (the fluid's force snippet): thin film is light and rises against the mean of its own
// level (so a level stratification sits still and only plumes and tilted bands are driven); warm
// air turns slow convection cells, harder where the film is thick; the M wire, when shown, holds
// the film still round it. No vorticity confinement: even faint, it spins the grid's own noise up
// into streaks finer than the dither, while the plumes curl well enough on their own.
//
// Life: a film lives a few minutes, then bursts at its black top (or at "now"). The hole's rim runs
// out at the Taylor–Culick speed, ∝ 1/√h: it races through the black film and slows in the thick.
// The moment it breaks, the time the rim takes to reach every point is worked out through the film
// as it stands (sims/front.ts: the least time along the straight line from the break, eased round
// slow patches), so the hole is always one piece growing from the break: a thin patch beyond a
// thick band opens only once the rim has crossed the band, never ahead of it.
// Once all is gone a liquid line rises from the bottom wire drawing up a fresh film, thin at the
// top that left the bath first (a bubble is blown again, growing from its middle).
//
// Passage: entered through one, the scene opens on the bare wire and the same liquid line draws the
// film up from the bottom wire over FILM_PASSAGE.enter seconds, rising fastest at first and slowing
// to the top (no prewarm: the fluid starts empty); leaving, the film bursts at its top and the exit
// paces the burst: its rim sets off slowly and gathers speed, reaching the film's farthest point
// as the exit ends (EXIT_RIM_POWER), and no new film is drawn. Both run whatever the motion amount
// (the entrance on frame time). Without a passage nothing changes.
//
// Without float render targets the shader draws an analytic film (filmAnalytic) that still lives
// the life above, which runs here on the CPU either way.
import { KnobReader, type ParamDef } from "../../params.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { FluidSim, type FluidStep } from "../../sims/fluid.ts";
import { ArrivalField } from "../../sims/front.ts";
import { GpuCompute, GpuError, type Pass, type RunOptions } from "../../sims/gpu.ts";
import { clamp } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** What holds the film, in `shape` knob order. */
export const filmShapes = ["frame", "loop", "bubble"] as const;
type FilmShape = (typeof filmShapes)[number];

// ---- the outline (mirrored in GLSL by filmOutline) -----------------------------------------------

/** A frame: half height, centre's height above the view's middle, least side margin, widest half width, corner radius. */
const RECT_HALF_HEIGHT = 0.37;
const RECT_Y = 0.03;
const RECT_MARGIN = 0.1;
const RECT_MAX_HALF_WIDTH = 1.25;
const RECT_CORNER = 0.035;
/** A loop and a bubble: radius and centre height; both keep this margin on a narrow view. */
const LOOP_RADIUS = 0.39;
const LOOP_Y = 0.05;
const BUBBLE_RADIUS = 0.41;
const BUBBLE_Y = 0.02;
const ROUND_MARGIN = 0.04;
/** Radius of the wire, frame heights (about four dither cells across at 540 cells high). */
const WIRE_RADIUS = 0.0042;
/** The fluid's walls stand this far outside the wire's axis, under the wire. */
const OBSTACLE_GAP = 0.004;
/** The M's height at the smallest and largest size knob, and how far its feet sink into the wire. */
const MARK_MIN = 0.2;
const MARK_SPAN = 0.2;
const MARK_SINK = 0.002;
/** The liquid line drawing a new film sags this much in the middle. */
const SAG = 0.03;

// ---- thickness, µm ------------------------------------------------------------------------------

const REFRACTIVE_INDEX = 1.33;
/** The colour table spans 0..LUT_MAX µm in LUT_SIZE entries. */
const LUT_SIZE = 512;
const LUT_MAX = 2.4;
/** Common black film, and the thickness below which a film collapses to it (per second rate). */
const BLACK = 0.008;
const BLACK_ONSET = 0.06;
const BLACK_RATE = 0.6;
/** The Plateau border on the lower wire: the thickness it feeds, how far in, how fast. */
const FEED = 1.0;
const FEED_BAND = 0.035;
const FEED_RATE = 0.25;
/** Thickest film the physics keeps. */
const MAX_THICKNESS = 2.0;
/** Plumes and breath thin a film no further than this (first-order white): pale patches, not holes. */
const SPOT_FLOOR = 0.12;
/** The opening film's thickness at the bottom (black at the top). */
const SEED_BOTTOM = 0.95;
/** A film just drawn: at the top, which left the bath first, and at the bottom. */
const FRESH_TOP = 0.25;
const FRESH_BOTTOM = 1.3;
/** Drainage speed of 1 µm film, frame heights per second, and evaporation in µm per second, at the knob's middle. */
const DRAIN = 0.0042;
const EVAPORATION = 0.0006;
/** The drainage knob scales both by DRAIN_RANGE^(2 knob - 1). */
const DRAIN_RANGE = 3;

// ---- the burst ----------------------------------------------------------------------------------

/** Rim speed in film RIM_REF µm thick, frame heights per second; ∝ 1/sqrt(h + RIM_SOFT). */
const RIM_SPEED = 3;
const RIM_REF = 0.25;
const RIM_SOFT = 0.04;
/** The break is this far inside the top of the outline, in the black film. */
const BREAK_INSET = 0.022;
/** Seconds the frame stands empty after a burst, and a new film takes to draw. */
const EMPTY_SECONDS = 1.4;
const DRAW_SECONDS = 4.5;
/**
 * The scene's passage, seconds: the entrance draws a fresh film up from the bottom wire (a bubble is
 * blown) in as long, and the exit pops the film.
 */
export const FILM_PASSAGE = { enter: 3, exit: 1.6 } as const;
/**
 * The exit paces a burst it begins: the rim's clock stands at exit^EXIT_RIM_POWER of the time the
 * rim takes to reach the film's farthest point (filmFarPoint), so the hole opens slowly and the rim
 * is still racing through the last of the film as the exit ends.
 */
const EXIT_RIM_POWER = 2;
/** A burst already under way when the exit begins runs this much faster than a film's own. */
const EXIT_PACE = 1.3;
/** A film lasts LIFETIME_LONG seconds at the pop knob's least, LIFETIME_SHORT at its most, give or take a quarter. */
const LIFETIME_LONG = 400;
const LIFETIME_SHORT = 90;
/** The film on show when the scene opens is this many seconds old. */
const OPENING_AGE = 45;

// ---- flow ---------------------------------------------------------------------------------------

/** Grids, texels on the short side. */
const VELOCITY_RESOLUTION = 128;
const DYE_RESOLUTION = 320;
/** Velocity fade per second: the film's own viscosity and the air's drag. */
const VELOCITY_DISSIPATION = 0.15;
/** Upward acceleration per µm the film is thinner than its level, frame heights / s². */
const BUOYANCY = 0.015;
/** Convection cells' acceleration at full swirl, frame heights / s². */
const STIR = 0.005;
/** Thin-film patches pulled from the wire per second at full plumes, and how many may be under way. */
const PLUME_RATE = 0.5;
const MAX_PLUMES = 6;
/** Thinning sources the physics pass takes: the pointer's breath and the plumes. */
const SPOTS = 8;
/** Prewarm: steps of this many seconds when a film is (re)made, so the first frame has settled. */
const PREWARM_STEPS = 5;
const PREWARM_DT = 0.2;

// ---- the pointer's breath -----------------------------------------------------------------------

/** Share of the pointer's velocity a frame passes into the film, per second, at full breath, and the most one frame may add. */
const BLOW_GAIN = 2.5;
const BLOW_MAX = 0.15;
const BLOW_RADIUS = 0.05;
/** Slower than this (frame heights per second) the pointer is still. */
const BLOW_STILL = 0.02;
/** Thinning under the pointer per second: moving (at BLOW_FULL_SPEED and faster) and held down. */
const BLOW_THIN = 0.8;
const BLOW_HOLD = 2;
const BLOW_FULL_SPEED = 1;
const BLOW_SPOT_RADIUS = 0.04;

// ---- shared GLSL --------------------------------------------------------------------------------

/**
 * Every constant the GLSL shares with this file, as `const float` declarations (a float literal
 * needs its decimal point).
 */
const GLSL_CONSTANTS = Object.entries({
  FILM_RECT_HALF: RECT_HALF_HEIGHT,
  FILM_RECT_Y: RECT_Y,
  FILM_RECT_MARGIN: RECT_MARGIN,
  FILM_RECT_MAX: RECT_MAX_HALF_WIDTH,
  FILM_CORNER: RECT_CORNER,
  FILM_LOOP_R: LOOP_RADIUS,
  FILM_LOOP_Y: LOOP_Y,
  FILM_BUBBLE_R: BUBBLE_RADIUS,
  FILM_BUBBLE_Y: BUBBLE_Y,
  FILM_ROUND_MARGIN: ROUND_MARGIN,
  FILM_WIRE_R: WIRE_RADIUS,
  FILM_OBSTACLE_GAP: OBSTACLE_GAP,
  FILM_MARK_MIN: MARK_MIN,
  FILM_MARK_SPAN: MARK_SPAN,
  FILM_MARK_SINK: MARK_SINK,
  FILM_SAG: SAG,
  FILM_N: REFRACTIVE_INDEX,
  FILM_LUT_SIZE: LUT_SIZE,
  FILM_LUT_MAX: LUT_MAX,
  FILM_BLACK: BLACK,
  FILM_BLACK_ONSET: BLACK_ONSET,
  FILM_BLACK_RATE: BLACK_RATE,
  FILM_FEED: FEED,
  FILM_FEED_BAND: FEED_BAND,
  FILM_FEED_RATE: FEED_RATE,
  FILM_MAX_THICK: MAX_THICKNESS,
  FILM_SPOT_FLOOR: SPOT_FLOOR,
  FILM_SEED_BOTTOM: SEED_BOTTOM,
  FILM_FRESH_TOP: FRESH_TOP,
  FILM_FRESH_BOTTOM: FRESH_BOTTOM,
  FILM_RIM_SPEED: RIM_SPEED,
  FILM_RIM_REF: RIM_REF,
  FILM_RIM_SOFT: RIM_SOFT,
})
  .map(([name, value]) => `const float ${name} = ${glslFloat(value)};`)
  .join("\n");

/**
 * The film's geometry and thickness models, shared by the fluid's snippets, the physics and seed
 * passes (which prepend gpuCommonGlsl for hash12, rotate and markDistance) and the scene's shader
 * (which has them in common, so every name here is prefixed). q is in frame heights from the
 * view's centre, y up.
 */
export const filmCommonGlsl = `
${GLSL_CONSTANTS}

// What holds the film (shape 0 frame, 1 loop, 2 bubble) at a view aspect: centre (xy) and half
// size (zw); a loop and a bubble are round, z = w = radius.
vec4 filmOutline(float shape, float aspect) {
  if (shape < 0.5) {
    float wide = max(0.5 * aspect - min(FILM_RECT_MARGIN, 0.15 * aspect), 0.1);
    return vec4(0.0, FILM_RECT_Y, min(wide, FILM_RECT_MAX), FILM_RECT_HALF);
  }
  bool loop = shape < 1.5;
  float r = max(min(loop ? FILM_LOOP_R : FILM_BUBBLE_R, 0.5 * aspect - FILM_ROUND_MARGIN), 0.05);
  return vec4(0.0, loop ? FILM_LOOP_Y : FILM_BUBBLE_Y, r, r);
}

// Signed distance to the outline (the wire's axis), frame heights, negative inside the film.
float filmEdge(vec2 q, float shape, vec4 o) {
  vec2 d = q - o.xy;
  if (shape < 0.5) {
    vec2 b = abs(d) - (o.zw - FILM_CORNER);
    return length(max(b, 0.0)) + min(max(b.x, b.y), 0.0) - FILM_CORNER;
  }
  return length(d) - o.z;
}

// The point nearest q that lies at least inset inside the outline (q itself when it already does).
vec2 filmInside(vec2 q, float shape, vec4 o, float inset) {
  vec2 d = q - o.xy;
  if (shape < 0.5) return o.xy + clamp(d, inset - o.zw, o.zw - inset);
  float r = length(d);
  float reach = o.z - inset;
  return r > reach ? o.xy + d * (reach / r) : q;
}

// Where the Manifold M stands, feet on the lower wire: its centre (xy) and height (z).
vec3 filmMarkPlace(float shape, vec4 o, float size) {
  float foot = shape < 0.5 ? o.y - o.w : o.y - sqrt(max(o.z * o.z - 0.2209 * size * size, 0.0));
  return vec3(o.x, foot + 0.5 * size - FILM_MARK_SINK, size);
}

// Distance from the M wire's axis, frame heights: markDistance on the M scaled to height m.z.
float filmMarkDistance(vec2 q, vec3 m) {
  return markDistance((q - m.xy) / m.z) * m.z;
}

// The rim of a hole in film h µm thick runs at this many frame heights per second (Taylor–Culick).
float filmRimSpeed(float h) {
  return FILM_RIM_SPEED * sqrt(FILM_RIM_REF / (max(h, 0.0) + FILM_RIM_SOFT));
}

// Where a burst from p reaches last: the outline's farthest point (the film breaks near its top: a
// lower corner of a frame, or the point of a loop or bubble straight across), read a little inside
// the wire. A burst the exit began (the life's hole.w 2) is paced by the exit: its hole.z is then
// the share of the rim's way here, and the rim clock that share of when it reaches this point.
vec2 filmFarPoint(vec2 p, float shape, vec4 o) {
  vec2 far;
  if (shape < 0.5) {
    vec2 left = vec2(o.x - o.z, o.y - o.w);
    vec2 right = vec2(o.x + o.z, o.y - o.w);
    far = distance(left, p) > distance(right, p) ? left : right;
  } else {
    vec2 d = o.xy - p;
    far = o.xy + d * (o.z / max(length(d), 1e-5));
  }
  return filmInside(far, shape, o, 0.02);
}

// A film below the black-film onset, collapsed to common black film.
float filmBlacken(float h) {
  return mix(FILM_BLACK, h, smoothstep(0.5 * FILM_BLACK_ONSET, FILM_BLACK_ONSET, h));
}

// The height of the liquid line drawing a new film up, at q.x: front where it meets the wire,
// sagging in the middle under its own weight.
float filmLevel(vec2 q, vec4 o, float front) {
  float span = clamp((q.x - o.x) / o.z, -1.0, 1.0);
  return front - FILM_SAG * (1.0 - span * span);
}

// How much of q a film being drawn already covers: below the liquid line, or inside the bubble
// being blown (front is then its radius).
float filmDrawn(vec2 q, float shape, vec4 o, float front, float soft) {
  if (shape > 1.5) return 1.0 - smoothstep(front - soft, front + soft, length(q - o.xy));
  float level = filmLevel(q, o, front);
  return 1.0 - smoothstep(level - soft, level + soft, q.y);
}

// A film some way into its life, µm: drained to a stratification, black at the very top,
// FILM_SEED_BOTTOM at the bottom and steeper near the top (as drainage leaves it), swayed by four
// eddies placed by the seed, mostly low down. t turns them a little to and fro (only where there is
// no simulation).
float filmAnalytic(vec2 q, vec4 o, float seed, float t) {
  vec2 w = q;
  for (int i = 0; i < 4; i++) {
    float k = float(i) + 1.0;
    vec2 r = vec2(hash12(vec2(seed + 0.37, k * 3.1)), hash12(vec2(k * 5.7, seed + 1.3)));
    vec2 centre = o.xy + (r * 2.0 - 1.0) * o.zw * vec2(0.72, 0.45) - vec2(0.0, 0.25 * o.w);
    float radius = (0.2 + 0.16 * hash12(vec2(seed + k, 9.1))) * o.w;
    float turn = (r.x < 0.5 ? -1.0 : 1.0) * (0.55 + 0.75 * r.y) + 0.4 * sin(0.05 * t + 2.3 * k);
    vec2 d = w - centre;
    w = centre + rotate(d, turn * exp(-dot(d, d) / (radius * radius)));
  }
  float depth = clamp((o.y + o.w - w.y) / (2.0 * o.w) + 0.012 * sin(9.0 * w.x + seed), 0.0, 1.0);
  return filmBlacken(FILM_SEED_BOTTOM * pow(depth, 0.65));
}

// A film just drawn up, µm: thinner at the top, which left the bath first, faintly uneven.
float filmFresh(vec2 q, vec4 o, float seed) {
  float depth = clamp((o.y + o.w - q.y) / (2.0 * o.w), 0.0, 1.0);
  return mix(FILM_FRESH_TOP, FILM_FRESH_BOTTOM, depth) * (1.0 + 0.06 * sin(11.0 * q.x + seed) * sin(7.0 * q.y - 0.7 * seed));
}
`;

// ---- the fluid's snippets and the film's passes ---------------------------------------------------

const OBSTACLE_GLSL = `
uniform float uFilmShape;
${gpuCommonGlsl}
${filmCommonGlsl}
// Everything outside the film is solid; its walls stand under the wire.
float fluidObstacle(vec2 p) {
  vec2 q = p - 0.5 * uDomain;
  return FILM_OBSTACLE_GAP - filmEdge(q, uFilmShape, filmOutline(uFilmShape, uDomain.x));
}
`;

const FORCE_GLSL = `
uniform float uFilmShape;
uniform float uFilmMark;
uniform float uFilmBuoyancy;
uniform float uFilmStir;
${gpuCommonGlsl}
${filmCommonGlsl}
// Thickness is compared with its level this far to either side, frame heights.
const float FILM_LATERAL[3] = float[3](0.04, 0.1, 0.22);

// Warm air rising past the film: slow convection cells, the curl of a stream function of three
// plane waves drifting at their own pace (divergence free, so the pressure solve has nothing to
// undo). Unit amplitude per wave.
vec2 filmCells(vec2 q, float t) {
  vec2 k1 = vec2(6.3, 3.1);
  vec2 k2 = vec2(-4.2, 5.6);
  vec2 k3 = vec2(1.7, -7.4);
  return cos(dot(k1, q) - 0.061 * t) * vec2(k1.y, -k1.x) / length(k1)
    + cos(dot(k2, q) + 0.047 * t + 1.9) * vec2(k2.y, -k2.x) / length(k2)
    + cos(dot(k3, q) - 0.053 * t + 4.2) * vec2(k3.y, -k3.x) / length(k3);
}

vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
  vec2 q = p - 0.5 * uDomain;
  float present = clamp(dye.g, 0.0, 1.0);
  // Thin film is light: it rises against the mean thickness of its level, where there is film, so
  // a level stratification is in balance and only plumes and tilted bands are driven.
  float sum = 0.0;
  float weight = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 dx = vec2(FILM_LATERAL[i] / uDomain.x, 0.0);
    vec2 a = texture(uDye, uv + dx).rg;
    vec2 b = texture(uDye, uv - dx).rg;
    sum += a.x * a.y + b.x * b.y;
    weight += a.y + b.y;
  }
  float level = weight > 0.05 ? sum / weight : dye.r;
  vec2 force = vec2(0.0, uFilmBuoyancy * (level - dye.r) * present);
  // The cells push thick film harder than thin.
  force += uFilmStir * (0.3 + 0.7 * clamp(dye.r / 0.8, 0.0, 1.0)) * present * filmCells(q, uTime);
  // The M wire holds the film still where it stands.
  if (uFilmMark > 0.0) {
    vec3 m = filmMarkPlace(uFilmShape, filmOutline(uFilmShape, uDomain.x), uFilmMark);
    float wire = 1.0 - smoothstep(FILM_WIRE_R, FILM_WIRE_R + 1.5 * uTexel.y, filmMarkDistance(q, m));
    force -= wire * velocity / max(uDt, 1e-4);
  }
  return force;
}
`;

const PHYSICS_GLSL = `
#define FILM_SPOTS ${SPOTS}
uniform sampler2D uFilmDye;
uniform sampler2D uFilmArrival;
uniform vec2 uFilmDomain;
uniform float uFilmShape;
uniform float uFilmSeed;
uniform float uFilmDt;
uniform float uFilmDrain;
uniform float uFilmEvaporate;
uniform vec4 uFilmHole;
uniform vec2 uFilmDraw;
uniform vec4 uFilmSpots[FILM_SPOTS];
uniform int uFilmSpotCount;
${gpuCommonGlsl}
${filmCommonGlsl}

float filmRow(int x, int row) {
  return texelFetch(uFilmDye, ivec2(x, clamp(row, 0, int(uSize.y) - 1)), 0).r;
}

void main() {
  vec2 q = (vUv - 0.5) * uFilmDomain;
  vec4 o = filmOutline(uFilmShape, uFilmDomain.x);
  ivec2 at = ivec2(gl_FragCoord.xy);
  vec2 film = texelFetch(uFilmDye, at, 0).rg;
  float present = film.y;

  // Drainage: the film here came down from above, faster the thicker it is (h^1.5). A Catmull–Rom
  // through the four texels round the source, clamped to the two between, so the bands keep
  // their edges over thousands of small steps.
  float y = float(at.y) + uFilmDt * uFilmDrain * pow(max(film.x, 0.0), 1.5) * uSize.y;
  int row = int(floor(y));
  float f = y - float(row);
  float a = filmRow(at.x, row - 1);
  float b = filmRow(at.x, row);
  float c = filmRow(at.x, row + 1);
  float d = filmRow(at.x, row + 2);
  float h = b + 0.5 * f * (c - a + f * (2.0 * a - 5.0 * b + 4.0 * c - d + f * (3.0 * (b - c) + d - a)));
  h = clamp(h, min(b, c), max(b, c));

  // Evaporation, and the lower wire's meniscus feeding thick film back in.
  h -= uFilmEvaporate * uFilmDt * present;
  float edge = filmEdge(q, uFilmShape, o);
  float low = 1.0 - smoothstep(-0.8, -0.2, (q.y - o.y) / o.w);
  float feed = (1.0 - smoothstep(0.0, FILM_FEED_BAND, -edge)) * low * present;
  h = mix(h, FILM_FEED, (1.0 - exp(-FILM_FEED_RATE * uFilmDt)) * feed);

  // Below the onset the film collapses to common black film.
  float black = (1.0 - smoothstep(0.5 * FILM_BLACK_ONSET, FILM_BLACK_ONSET, h)) * present;
  h = mix(h, FILM_BLACK, (1.0 - exp(-FILM_BLACK_RATE * uFilmDt)) * black);

  // Thin patches: plumes pulled from the wire, and the pointer's breath.
  for (int i = 0; i < FILM_SPOTS; i++) {
    if (i >= uFilmSpotCount) break;
    vec4 s = uFilmSpots[i];
    vec2 e = q - s.xy;
    h = max(h * exp(-s.w * uFilmDt * exp(-dot(e, e) / (s.z * s.z))), min(h, FILM_SPOT_FLOOR));
  }

  // A burst: the film is gone wherever the rim has passed. ahead: how far the rim still has to come,
  // its arrival time from now at the speed it will have here (a burst the exit paces: see
  // filmFarPoint).
  if (uFilmHole.w > 0.5) {
    float clock = uFilmHole.z;
    if (uFilmHole.w > 1.5) {
      vec2 far = filmFarPoint(uFilmHole.xy, uFilmShape, o);
      clock *= texture(uFilmArrival, far / uFilmDomain + 0.5).r;
    }
    float ahead = (texture(uFilmArrival, vUv).r - clock) * filmRimSpeed(h * present);
    float gone = 1.0 - smoothstep(-uTexel.y, uTexel.y, ahead);
    present *= 1.0 - gone;
    h *= 1.0 - gone;
  }

  // A new film, drawn in behind the rising line (or the growing bubble).
  if (uFilmDraw.y > 0.5) {
    float drawn = filmDrawn(q, uFilmShape, o, uFilmDraw.x, uTexel.y) * step(edge, 0.0);
    h = mix(h, filmFresh(q, o, uFilmSeed), drawn * (1.0 - present));
    present = max(present, drawn);
  }
  fragColor = vec4(clamp(h, 0.0, FILM_MAX_THICK), clamp(present, 0.0, 1.0), 0.0, 1.0);
}
`;

const SEED_GLSL = `
uniform vec2 uFilmDomain;
uniform float uFilmShape;
uniform float uFilmSeed;
${gpuCommonGlsl}
${filmCommonGlsl}
void main() {
  vec2 q = (vUv - 0.5) * uFilmDomain;
  vec4 o = filmOutline(uFilmShape, uFilmDomain.x);
  float inside = step(filmEdge(q, uFilmShape, o), 0.0);
  fragColor = vec4(filmAnalytic(q, o, uFilmSeed, 0.0) * inside, inside, 0.0, 1.0);
}
`;

/** The rim's speed for the burst's arrival field (sims/front.ts): Taylor–Culick in the film as it stands. */
const RIM_GLSL = `
uniform sampler2D uFilmDye;
${gpuCommonGlsl}
${filmCommonGlsl}
float frontSpeed(vec2 uv) {
  vec2 film = texture(uFilmDye, uv).rg;
  return filmRimSpeed(film.r * clamp(film.g, 0.0, 1.0));
}
`;

// ---- interference colours ------------------------------------------------------------------------

/** Wavelengths integrated over, nm. */
const LAMBDA_FROM = 380;
const LAMBDA_TO = 780;
const LAMBDA_STEP = 4;
/** Colour temperature of the studio light, K. */
const LIGHT_KELVIN = 6000;
/** Reflectance the table maps to 1: about the first-order white of a 0.1 µm film. */
const REFLECT_PEAK = 0.075;

function lobe(nm: number, mean: number, below: number, above: number): number {
  const t = (nm - mean) / (nm < mean ? below : above);
  return Math.exp(-0.5 * t * t);
}

/**
 * The CIE 1931 2° colour matching functions x̄, ȳ, z̄ at a wavelength, from the multi-lobe fit of
 * Wyman, Sloan and Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching
 * Functions", JCGT 2(2), 2013.
 */
function matching(nm: number): readonly [number, number, number] {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31.0) +
      0.362 * lobe(nm, 442.0, 16.0, 26.7) -
      0.065 * lobe(nm, 501.1, 20.4, 26.2),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1),
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8),
  ];
}

/** Black-body spectral radiance at a wavelength, relative. */
function planck(nm: number, kelvin: number): number {
  const um = nm / 1000;
  return 1 / (um ** 5 * (Math.exp(14388 / (um * kelvin)) - 1));
}

/** CIE XYZ to linear sRGB (D65). */
function linearRgb(x: number, y: number, z: number): [number, number, number] {
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
}

/**
 * The colour a film reflects at each thickness, as uSim1 holds it: for every wavelength the Airy
 * reflectance of a water film in air at normal incidence, F sin²(δ/2) / (1 + F sin²(δ/2)) with
 * δ = 4π n h / λ and F = 4r² / (1 - r²)², weighted by the light and the colour matching functions;
 * then white-balanced to the light, pulled into the sRGB gamut toward its own luminance (hue kept)
 * and scaled by 1 / REFLECT_PEAK. Thick films average out to a silvery grey near 0.53.
 */
function filmSpectrumTable(): Float32Array {
  const bands: { k: number; x: number; y: number; z: number }[] = [];
  for (let nm = LAMBDA_FROM; nm <= LAMBDA_TO; nm += LAMBDA_STEP) {
    const power = planck(nm, LIGHT_KELVIN);
    const [x, y, z] = matching(nm);
    bands.push({
      k: (2 * Math.PI * REFRACTIVE_INDEX) / nm,
      x: power * x,
      y: power * y,
      z: power * z,
    });
  }
  let wx = 0;
  let wy = 0;
  let wz = 0;
  for (const band of bands) {
    wx += band.x;
    wy += band.y;
    wz += band.z;
  }
  const white = linearRgb(wx, wy, wz);
  const r = (REFRACTIVE_INDEX - 1) / (REFRACTIVE_INDEX + 1);
  const finesse = (4 * r * r) / (1 - r * r) ** 2;
  const table = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const nm = (LUT_MAX * 1000 * i) / (LUT_SIZE - 1);
    let x = 0;
    let y = 0;
    let z = 0;
    for (const band of bands) {
      const s = Math.sin(band.k * nm) ** 2;
      const reflect = (finesse * s) / (1 + finesse * s);
      x += reflect * band.x;
      y += reflect * band.y;
      z += reflect * band.z;
    }
    const [lr, lg, lb] = linearRgb(x, y, z);
    let red = lr / white[0];
    let green = lg / white[1];
    let blue = lb / white[2];
    const luminance = Math.max(0.2126 * red + 0.7152 * green + 0.0722 * blue, 0);
    const least = Math.min(red, green, blue);
    if (least < 0) {
      const keep = luminance > 0 ? luminance / (luminance - least) : 0;
      red = luminance + (red - luminance) * keep;
      green = luminance + (green - luminance) * keep;
      blue = luminance + (blue - luminance) * keep;
    }
    table[i * 4] = red / REFLECT_PEAK;
    table[i * 4 + 1] = green / REFLECT_PEAK;
    table[i * 4 + 2] = blue / REFLECT_PEAK;
    table[i * 4 + 3] = 1;
  }
  return table;
}

// ---- outline, on the CPU ------------------------------------------------------------------------

class FilmError extends Error {}

interface Outline {
  shape: FilmShape;
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** filmOutline: the outline's centre and half size, frame heights, written into `out`. */
function outlineInto(out: Outline, shape: FilmShape, aspect: number): void {
  out.shape = shape;
  out.x = 0;
  switch (shape) {
    case "frame": {
      const wide = Math.max(0.5 * aspect - Math.min(RECT_MARGIN, 0.15 * aspect), 0.1);
      out.y = RECT_Y;
      out.hw = Math.min(wide, RECT_MAX_HALF_WIDTH);
      out.hh = RECT_HALF_HEIGHT;
      return;
    }
    case "loop":
    case "bubble": {
      const loop = shape === "loop";
      const r = Math.max(
        Math.min(loop ? LOOP_RADIUS : BUBBLE_RADIUS, 0.5 * aspect - ROUND_MARGIN),
        0.05,
      );
      out.y = loop ? LOOP_Y : BUBBLE_Y;
      out.hw = r;
      out.hh = r;
      return;
    }
    default: {
      const unreachable: never = shape;
      throw new FilmError(`film: unknown shape ${String(unreachable)}`);
    }
  }
}

/** The Taylor–Culick rim speed, frame heights per second, as filmRimSpeed. */
function rimSpeed(h: number): number {
  return RIM_SPEED * Math.sqrt(RIM_REF / (Math.max(h, 0) + RIM_SOFT));
}

// ---- the film's life ----------------------------------------------------------------------------

type Phase = "film" | "burst" | "empty" | "draw";

/** A thinning source: centre (q), radius (frame heights) and thinning rate per second at its peak. */
interface Spot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly rate: number;
}

/** A plume pulled from the wire: a spot that swells and fades over its duration. */
interface Plume extends Spot {
  age: number;
  readonly duration: number;
}

/** What the knobs ask of the film this frame; the sim rewrites one in place each frame. */
interface Tuning {
  shape: FilmShape;
  seed: number;
  readonly outline: Outline;
  /** The pop knob's amount while on, 0 while off. */
  pop: number;
  drain: number;
  evaporate: number;
  swirl: number;
  plumes: number;
  /** Height of the M wire, 0 without it. */
  mark: number;
}

/** A film's life on the CPU: drained, burst, gone, drawn again; and its plumes. */
class FilmLife {
  phase: Phase = "film";
  /** Seconds since the phase began. */
  since = 0;
  /** Seconds since the film on show was drawn. */
  age = OPENING_AGE;
  /** Where the film broke (q), and the farthest point of the outline from there (frame heights). */
  breakX = 0;
  breakY = 0;
  reach = 0;
  /** Bursts so far: each new one needs its rim's arrival field. */
  bursts = 0;
  /** The drawing line's height where it meets the wire, or the bubble's radius. */
  front = 0;
  /** Whether the scene is being entered: the film on show is drawn at the entrance's pace. */
  entering = false;
  /** Whether the scene is being left: the film pops and stays gone. */
  leaving = false;
  /** The exit's progress, 0..1 (0 until the scene leaves). */
  exit = 0;
  /** The burst under way began with the exit, which paces it (see packState). */
  #paced = false;
  readonly #plumes: Plume[] = [];
  #rand: () => number = mulberry32(0);
  #seed = 0;
  #films = 0;
  /** Seconds the hole takes to clear the whole outline. */
  #burstSeconds = 1;
  /** This film's lifetime as a share of the pop knob's. */
  #lifeShare = 1;
  /** Plume clock: expected plumes so far, and the count the next one waits for. */
  #plumeClock = 0;
  #plumeDue = 1;

  /** The opening film of a seed, OPENING_AGE seconds old, or when `entering` a film drawn up as the scene comes in. */
  reset(seed: number, entering: boolean): void {
    this.#seed = seed;
    this.#films = 0;
    this.entering = entering;
    this.phase = entering ? "draw" : "film";
    this.since = 0;
    this.age = entering ? 0 : OPENING_AGE;
    this.#plumes.length = 0;
    this.#newFilm();
  }

  /** The scene is leaving: burst the film (if it has not burst already) and never draw another. */
  leave(o: Outline): void {
    this.leaving = true;
    if (this.phase !== "film" && this.phase !== "draw") return;
    this.burst(o);
    this.#paced = true;
  }

  /** Break the film at the top of its outline (only while there is one to break). */
  burst(o: Outline): void {
    if (this.phase !== "film" && this.phase !== "draw") return;
    const share = this.#rand();
    let far: number;
    if (o.shape === "frame") {
      this.breakX = o.x + (share * 1.4 - 0.7) * o.hw;
      this.breakY = o.y + o.hh - BREAK_INSET;
      far = Math.max(
        Math.hypot(o.x - o.hw - this.breakX, o.y - o.hh - this.breakY),
        Math.hypot(o.x + o.hw - this.breakX, o.y - o.hh - this.breakY),
      );
    } else {
      const angle = Math.PI / 2 + (share - 0.5) * 1.1;
      const reach = o.hw - BREAK_INSET;
      this.breakX = o.x + reach * Math.cos(angle);
      this.breakY = o.y + reach * Math.sin(angle);
      far = Math.hypot(this.breakX - o.x, this.breakY - o.y) + o.hw;
    }
    this.reach = far;
    this.bursts++;
    this.#burstSeconds = far / rimSpeed(MAX_THICKNESS) + 0.15;
    this.phase = "burst";
    this.since = 0;
    this.entering = false;
  }

  /** Whether the phase just moved from `burst` to `empty`: the fluid should be cleared. */
  advance(dt: number, tuning: Tuning): boolean {
    let cleared = false;
    switch (this.phase) {
      case "film":
        this.age += dt;
        if (
          tuning.pop > 0 &&
          this.age >=
            this.#lifeShare * (LIFETIME_LONG + (LIFETIME_SHORT - LIFETIME_LONG) * tuning.pop)
        )
          this.burst(tuning.outline);
        break;
      case "burst":
        // A burst the exit began runs on the exit's progress, and lasts as long as the scene does.
        if (this.#paced) break;
        this.since += this.leaving ? dt * EXIT_PACE : dt;
        if (this.since >= this.#burstSeconds) {
          this.phase = "empty";
          this.since = 0;
          this.#plumes.length = 0;
          cleared = true;
        }
        break;
      case "empty":
        this.since += dt;
        if (!this.leaving && this.since >= EMPTY_SECONDS) {
          this.phase = "draw";
          this.since = 0;
          this.age = 0;
          this.#newFilm();
        }
        break;
      case "draw":
        this.since += dt;
        this.age += dt;
        if (this.since >= (this.entering ? FILM_PASSAGE.enter : DRAW_SECONDS)) {
          this.phase = "film";
          this.since = 0;
          this.entering = false;
        }
        break;
      default: {
        const unreachable: never = this.phase;
        throw new FilmError(`film: unknown phase ${String(unreachable)}`);
      }
    }
    if (this.phase === "draw") this.front = this.#frontAt(tuning.outline);
    this.#advancePlumes(dt, tuning);
    return cleared;
  }

  /** The thinning sources for the physics pass, `extra` (the pointer) first; returns how many. */
  packSpots(target: Float32Array, extra: Spot | undefined): number {
    let count = 0;
    const put = (spot: Spot, rate: number): void => {
      if (count >= SPOTS || rate <= 0) return;
      target[count * 4] = spot.x;
      target[count * 4 + 1] = spot.y;
      target[count * 4 + 2] = spot.radius;
      target[count * 4 + 3] = rate;
      count++;
    };
    if (extra) put(extra, extra.rate);
    for (const plume of this.#plumes)
      put(plume, plume.rate * Math.sin(Math.PI * Math.min(plume.age / plume.duration, 1)));
    return count;
  }

  /** The life as uSim2 holds it (see the file header). */
  packState(target: Float32Array): void {
    const bursting = this.phase === "burst";
    const drawing = this.phase === "draw";
    target[0] = this.breakX;
    target[1] = this.breakY;
    target[2] = bursting ? (this.#paced ? this.exit ** EXIT_RIM_POWER : this.since) : 0;
    target[3] = bursting ? (this.#paced ? 2 : 1) : 0;
    target[4] = drawing ? this.front : 0;
    target[5] = drawing ? 1 : 0;
    target[6] = 0;
    target[7] = this.phase === "empty" ? 0 : 1;
  }

  #newFilm(): void {
    this.#rand = mulberry32(
      Math.imul(this.#seed + 1, 0x9e3779b1) ^ Math.imul(this.#films + 1, 0x85ebca6b),
    );
    this.#films++;
    this.#lifeShare = 0.75 + 0.5 * this.#rand();
    this.#plumeClock = 0;
    this.#plumeDue = -Math.log(1 - this.#rand());
  }

  /**
   * The drawing line rises from below the bottom wire to above the top one (eased in and out; while
   * the scene enters, fastest at first and slowing to the top); a bubble grows from its middle.
   */
  #frontAt(o: Outline): number {
    const p = Math.min(this.since / (this.entering ? FILM_PASSAGE.enter : DRAW_SECONDS), 1);
    if (o.shape === "bubble") return o.hw * (1 - (1 - p) ** 3);
    const from = o.y - o.hh - 0.02;
    const to = o.y + o.hh + SAG + 0.02;
    return from + (to - from) * (this.entering ? 1 - (1 - p) ** 3 : p * p * (3 - 2 * p));
  }

  #advancePlumes(dt: number, tuning: Tuning): void {
    for (let i = this.#plumes.length - 1; i >= 0; i--) {
      const plume = this.#plumes[i];
      if (!plume) continue;
      plume.age += dt;
      if (plume.age >= plume.duration) this.#plumes.splice(i, 1);
    }
    if (this.phase !== "film" && this.phase !== "draw") return;
    this.#plumeClock += dt * PLUME_RATE * tuning.plumes;
    while (this.#plumeClock >= this.#plumeDue && this.#plumes.length < MAX_PLUMES) {
      this.#plumeClock -= this.#plumeDue;
      this.#plumeDue = -Math.log(1 - this.#rand());
      this.#plumes.push(this.#plume(tuning.outline));
    }
    // A full house does not bank plumes for later.
    this.#plumeClock = Math.min(this.#plumeClock, this.#plumeDue);
  }

  /** A patch of thin film pulled from the wire low on a side (four in five) or along the bottom. */
  #plume(o: Outline): Plume {
    const rand = this.#rand;
    const radius = 0.022 + 0.018 * rand();
    const inset = radius + 0.012;
    const side = rand();
    const along = rand();
    let x: number;
    let y: number;
    if (o.shape === "frame") {
      if (side < 0.8) {
        x = o.x + (side < 0.4 ? -1 : 1) * (o.hw - inset);
        y = o.y + o.hh * (-0.85 + 0.95 * along);
      } else {
        x = o.x + o.hw * (-0.85 + 1.7 * along);
        y = o.y - o.hh + inset;
      }
    } else {
      // Angles from +x, counter-clockwise: low on the left, low on the right, or the bottom.
      const angle =
        side < 0.4 ? 3.49 + 0.79 * along : side < 0.8 ? 5.15 + 0.79 * along : 4.36 + 0.7 * along;
      x = o.x + (o.hw - inset) * Math.cos(angle);
      y = o.y + (o.hw - inset) * Math.sin(angle);
    }
    return { x, y, radius, rate: 0.5 + 0.4 * rand(), age: 0, duration: 1.5 + 1.5 * rand() };
  }
}

// ---- the flow on the GPU ------------------------------------------------------------------------

/** One step of the film's flow and thickness; the sim rewrites dt, time and spotCount in place. */
interface FlowStep {
  dt: number;
  time: number;
  readonly tuning: Tuning;
  readonly hole: Float32Array;
  readonly draw: Float32Array;
  readonly spots: Float32Array;
  spotCount: number;
}

/** The film's snippets' own uniforms (a type literal, so it passes as a uniform record). */
type SnippetUniforms = {
  uFilmShape: number;
  uFilmMark: number;
  uFilmBuoyancy: number;
  uFilmStir: number;
};

type PhysicsUniforms = {
  uFilmDomain: Float32Array;
  uFilmShape: number;
  uFilmSeed: number;
  uFilmDt: number;
  uFilmDrain: number;
  uFilmEvaporate: number;
  uFilmHole: Float32Array;
  uFilmDraw: Float32Array;
  uFilmSpots: Float32Array;
  uFilmSpotCount: number;
};

/** The fluid carrying the film, the passes for its thickness and the arrival field of its burst. */
class FilmFlow {
  readonly gpu: GpuCompute;
  readonly fluid: FluidSim;
  /** When the rim of the latest burst reaches each texel (uSim3). */
  readonly rim: ArrivalField;
  readonly #physics: Pass;
  readonly #seeder: Pass;
  readonly #domain = new Float32Array(2);
  readonly #breakUv: [number, number] = [0, 0];
  readonly #rimDomain: [number, number] = [1, 1];
  readonly #rimInputs: RunOptions;
  readonly #snippet: SnippetUniforms = {
    uFilmShape: 0,
    uFilmMark: 0,
    uFilmBuoyancy: BUOYANCY,
    uFilmStir: 0,
  };
  readonly #fluidStep: FluidStep = {
    dt: 0,
    time: 0,
    velocityDissipation: VELOCITY_DISSIPATION,
    uniforms: this.#snippet,
  };
  readonly #physicsUniforms: PhysicsUniforms = {
    uFilmDomain: this.#domain,
    uFilmShape: 0,
    uFilmSeed: 0,
    uFilmDt: 0,
    uFilmDrain: 0,
    uFilmEvaporate: 0,
    uFilmHole: new Float32Array(4),
    uFilmDraw: new Float32Array(2),
    uFilmSpots: new Float32Array(SPOTS * 4),
    uFilmSpotCount: 0,
  };

  /** Throws GpuError when a pass does not compile; the caller disposes `gpu`. */
  constructor(gpu: GpuCompute) {
    this.gpu = gpu;
    this.fluid = new FluidSim(gpu, {
      velocityResolution: VELOCITY_RESOLUTION,
      dyeResolution: DYE_RESOLUTION,
      dyeFormat: "rg16f",
      force: FORCE_GLSL,
      obstacle: OBSTACLE_GLSL,
    });
    this.#physics = gpu.pass(PHYSICS_GLSL, "film physics");
    this.#seeder = gpu.pass(SEED_GLSL, "film seed");
    this.rim = new ArrivalField(gpu, { speed: RIM_GLSL, name: "film rim" });
    this.#rimInputs = { textures: { uFilmDye: this.fluid.dye } };
    this.#physics.bind({ uFilmDye: this.fluid.dye, uFilmArrival: this.rim.source });
  }

  /** The film breaks at q (frame heights from the view's centre): when its rim will reach every texel, `reach` the farthest point. */
  breakAt(x: number, y: number, reach: number): void {
    const aspect = this.fluid.aspect;
    this.#breakUv[0] = x / aspect + 0.5;
    this.#breakUv[1] = y + 0.5;
    this.#rimDomain[0] = aspect;
    const dye = this.fluid.dye;
    this.rim.compute(dye.width, dye.height, this.#breakUv, reach, this.#rimDomain, this.#rimInputs);
  }

  /** A still film well into its life (filmAnalytic). */
  reseed(shape: FilmShape, seed: number): void {
    this.fluid.clear();
    this.#seeder.run(this.fluid.dye, {
      uniforms: {
        uFilmDomain: this.#updateDomain(),
        uFilmShape: filmShapes.indexOf(shape),
        uFilmSeed: seed,
      },
    });
  }

  step(step: FlowStep): void {
    const { tuning, dt } = step;
    const shape = filmShapes.indexOf(tuning.shape);
    const snippet = this.#snippet;
    snippet.uFilmShape = shape;
    snippet.uFilmMark = tuning.mark;
    snippet.uFilmStir = STIR * tuning.swirl;
    const fluidStep = this.#fluidStep;
    fluidStep.dt = dt;
    fluidStep.time = step.time;
    this.fluid.step(fluidStep);
    if (dt <= 0) return;
    const uniforms = this.#physicsUniforms;
    uniforms.uFilmDomain = this.#updateDomain();
    uniforms.uFilmShape = shape;
    uniforms.uFilmSeed = tuning.seed;
    uniforms.uFilmDt = dt;
    uniforms.uFilmDrain = tuning.drain;
    uniforms.uFilmEvaporate = tuning.evaporate;
    uniforms.uFilmHole = step.hole;
    uniforms.uFilmDraw = step.draw;
    uniforms.uFilmSpots = step.spots;
    uniforms.uFilmSpotCount = step.spotCount;
    this.#physics.set(uniforms).run(this.fluid.dye);
  }

  #updateDomain(): Float32Array {
    this.#domain[0] = this.fluid.aspect;
    this.#domain[1] = 1;
    return this.#domain;
  }
}

// ---- the simulation -----------------------------------------------------------------------------

type FilmKnob = "shape" | "pop" | "filmSeed" | "drainage" | "swirl" | "plumes" | "blow" | "mark";

/** Write what the knobs ask of the film this frame into `out`. */
function tune(out: Tuning, frame: SimFrame, knobs: KnobReader<FilmKnob>): void {
  const shape =
    filmShapes[clamp(Math.round(knobs.value(frame, "shape")), 0, filmShapes.length - 1)] ?? "loop";
  const pace = DRAIN_RANGE ** (2 * knobs.value(frame, "drainage") - 1);
  const mark = knobs.value(frame, "mark");
  out.shape = shape;
  out.seed = Math.round(knobs.value(frame, "filmSeed"));
  outlineInto(out.outline, shape, frame.aspect);
  out.pop = knobs.value(frame, "pop");
  out.drain = DRAIN * pace;
  out.evaporate = EVAPORATION * pace;
  out.swirl = knobs.value(frame, "swirl");
  out.plumes = knobs.value(frame, "plumes");
  out.mark = mark > 0 ? MARK_MIN + MARK_SPAN * mark : 0;
}

/** The soap film, for a scene whose `params` carry the knobs `FilmKnob` names. */
export function filmSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<FilmKnob>("film", params, [
    "shape",
    "pop",
    "filmSeed",
    "drainage",
    "swirl",
    "plumes",
    "blow",
    "mark",
  ]);
  const popSlot = knobs.trigger("pop");
  return (gl): SceneSim => {
    const colours = new DataTexture(gl, { width: LUT_SIZE, height: 1, format: "rgba16f" });
    colours.upload(filmSpectrumTable());
    const state = new DataTexture(gl, {
      width: 2,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    const stateData = new Float32Array(8);
    // The physics pass reads the break and the drawing line straight from the state.
    const hole = stateData.subarray(0, 4);
    const draw = stateData.subarray(4, 6);

    let flow: FilmFlow | undefined;
    const gpu = GpuCompute.create(gl);
    if (gpu) {
      try {
        flow = new FilmFlow(gpu);
      } catch (error: unknown) {
        gpu.dispose();
        if (!(error instanceof GpuError)) throw error;
        console.error("evt=landing.film.sim_failed", error);
      }
    }

    const life = new FilmLife();
    const spots = new Float32Array(SPOTS * 4);
    // Everything a frame or a step needs is built here once and rewritten in place.
    const tuning: Tuning = {
      shape: "loop",
      seed: 0,
      outline: { shape: "loop", x: 0, y: 0, hw: 0, hh: 0 },
      pop: 0,
      drain: 0,
      evaporate: 0,
      swirl: 0,
      plumes: 0,
      mark: 0,
    };
    const flowStep: FlowStep = { dt: 0, time: 0, tuning, hole, draw, spots, spotCount: 0 };
    const breath = { x: 0, y: 0, radius: BLOW_SPOT_RADIUS, rate: 0 };
    const impulse = { velocity: new Float32Array(2) };
    const textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined, undefined];
    let time = 0;
    let shownShape: FilmShape | undefined;
    let shownSeed: number | undefined;
    /** Where the pointer was last frame while blowing (if it was). */
    let blowing = false;
    let lastX = 0;
    let lastY = 0;
    /** Whether the scene was entered through a passage (decided on the first frame), until its film is drawn. */
    let arriving: boolean | undefined;
    /** The burst the rim's arrival field was made for. */
    let rimFor = life.bursts;

    const advance = (dt: number, breathing: boolean): void => {
      if (life.advance(dt, tuning)) flow?.fluid.clear();
      // A new burst: when its rim reaches every point, through the film as it stands at the break.
      if (life.bursts !== rimFor) {
        rimFor = life.bursts;
        flow?.breakAt(life.breakX, life.breakY, life.reach);
      }
      life.packState(stateData);
      time += dt;
      if (!flow) return;
      flowStep.dt = dt;
      flowStep.time = time;
      flowStep.spotCount = life.packSpots(spots, breathing ? breath : undefined);
      flow.step(flowStep);
    };

    /** A fresh opening film for this shape and seed, settled by a few steps; while entering, an empty wire the film is drawn onto. */
    const restart = (entering: boolean): void => {
      shownShape = tuning.shape;
      shownSeed = tuning.seed;
      blowing = false;
      // Leaving, the film that is bursting or gone stays so, a resize notwithstanding.
      if (life.leaving) {
        flow?.fluid.clear();
        return;
      }
      life.reset(tuning.seed, entering);
      time = 0;
      if (!flow) return;
      if (entering) {
        flow.fluid.clear();
        return;
      }
      flow.reseed(tuning.shape, tuning.seed);
      for (let i = 0; i < PREWARM_STEPS; i++) advance(PREWARM_DT, false);
    };

    return {
      frame(frame) {
        tune(tuning, frame, knobs);
        // Entered through a passage the film is drawn up from the bottom wire; otherwise it is on show already.
        arriving ??= frame.passage.enter < 1;
        const resized = flow?.fluid.resize(frame.width, frame.height) ?? false;
        if (resized || tuning.shape !== shownShape || tuning.seed !== shownSeed) restart(arriving);

        // The exit: the film pops, and no new one is drawn.
        life.exit = clamp(frame.passage.exit, 0, 1);
        if (frame.passage.exit > 0 && !life.leaving) life.leave(tuning.outline);

        // "now": burst the film at once (a film still being drawn too).
        if (frame.fired[popSlot] === true) life.burst(tuning.outline);

        // The pointer blows on the film: a push along its motion, and a thin spot under it.
        const dt = frame.dt * frame.motion;
        const { pointer } = frame;
        const amount = knobs.value(frame, "blow");
        const hadLast = blowing;
        const fromX = lastX;
        const fromY = lastY;
        blowing = flow !== undefined && amount > 0 && pointer.inside;
        lastX = pointer.x;
        lastY = pointer.y;
        let breathing = false;
        if (flow && blowing && hadLast && dt > 0 && frame.dt > 0) {
          const vx = ((pointer.x - fromX) * frame.aspect) / frame.dt;
          const vy = (pointer.y - fromY) / frame.dt;
          const speed = Math.hypot(vx, vy);
          if (speed > BLOW_STILL) {
            const gain = Math.min(BLOW_GAIN * amount * dt, BLOW_MAX / speed);
            impulse.velocity[0] = gain * vx;
            impulse.velocity[1] = gain * vy;
            flow.fluid.splat(pointer.x, pointer.y, BLOW_RADIUS, impulse);
          }
          breath.x = (pointer.x - 0.5) * frame.aspect;
          breath.y = pointer.y - 0.5;
          breath.rate =
            amount *
            (BLOW_THIN * Math.min(1, speed / BLOW_FULL_SPEED) + (pointer.down ? BLOW_HOLD : 0));
          breathing = true;
        }

        // The entrance and the exit run on frame time, whatever the motion amount.
        advance(life.entering || life.leaving ? frame.dt : dt, breathing);
        if (!life.entering) arriving = false;
        state.upload(stateData);
        textures[0] = flow?.fluid.dye.texture;
        textures[1] = colours.texture;
        textures[2] = state.texture;
        textures[3] = flow?.rim.texture;
        return textures;
      },
      dispose() {
        colours.dispose();
        state.dispose();
        flow?.gpu.dispose();
      },
    };
  };
}
