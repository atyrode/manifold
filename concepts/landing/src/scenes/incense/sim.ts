// Incense in a dark room. The smoke is a 2D fluid on the GPU (sims/fluid.ts): the ember lays smoke
// and heat into the dye, the heat lifts the air (buoyancy, in the force snippet) and fades within
// seconds, the smoke lingers. Just above the ember the air is held to the room's slow draft, so the
// smoke leaves in a laminar thread that leans and sways with it; a hand-span up, the room's faint
// currents (a divergence-free stir acting only where there is smoke) and vorticity confinement roll
// it into Kelvin–Helmholtz curls. Higher up the cooled smoke meets the warmer air under the ceiling
// (the frame's top is a wall), stops rising and spreads into slow layered veils that a faint
// ceiling draft carries off to the right, out through the open side. A ceiling vent (its own knob)
// draws that layer off harder, toward an extractor high on the right wall, without reaching down
// to the thread, which the room's draft would bend as it carried the veils.
// Now and then a door opens somewhere and a draft sweeps across the room (trigger 0); the pointer
// is a hand moving the air. Dust motes drift in the light: GPU particles carried by the same air.
//
// The incense burns on the CPU (Burner): a stick in a dish, a cone, a coil on a little stand, or a
// backflow cone on a ceramic mountain whose smoke pours out cold and heavy and falls ledge to ledge.
// Each burns down over minutes (the stick's ash curling and dropping into the dish), goes out, and
// a fresh one is set down and lit (trigger 1: at once).
//
// Entering, the room starts empty: the ember takes light and the thread of smoke is drawn up out of
// it (Plume.#rise) to fray into the veils, the fluid carrying it on. Leaving, a draught sweeps
// through from the left, cuts the ember's smoke off and carries the thread and veils off (Plume.#blow).
// Without a passage the scene opens on the seeded, prewarmed plume as ever (INCENSE_PASSAGE).
//
// Time: the smoke, the motes, the burner and the doors step STEP at a time on one FixedStep
// (sims/clock.ts), so the room plays the same at any frame rate. The smoke and its velocity are
// shown between their last two steps by the clock's alpha (FieldBetween, sims/between.ts), the
// motes and the falling ash with them; the hand gives the air a step's push for every step's worth
// of time a frame holds.
//
// Textures for the shader (shader.ts), the incense layer's four fields (incenseLayerSim), the
// fluid's between its last two steps:
//   field 0  the dye, rgba16f over the frame: r smoke, g heat (negative: the backflow's cold smoke),
//            b fresh smoke (faded faster than r, so b / r says how young the smoke is), a unused
//   field 1  the velocity, rg16f, frame heights per second: bends the candle flame, fans the ember
//   field 2  the burner, 3×1 rgba16f (Burner.write)
//   field 3  the dust motes, r16f over the frame (while the dust knob is up)
// Without float render targets only field 2 is supplied and the shader paints an analytic plume.
// Its "now" slots are its knobs' (the composer numbers them): the new incense's and the door's.
//
// Units are frame heights, p = uv * (aspect, 1), as in the fluid. Everything stands on the table at
// the anchor (INCENSE_X of the width, INCENSE_FLOOR up); the table is the fluid's floor.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { FieldBetween } from "../../sims/between.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { FluidSim, type FluidStep, type SplatImpulse } from "../../sims/fluid.ts";
import {
  GpuCompute,
  GpuError,
  gridSize,
  type Pass,
  type PingPong,
  type RenderTarget,
  type Scatter,
  type ScatterRunOptions,
} from "../../sims/gpu.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { INCENSE_PASSAGE, incenseKinds } from "./constants.ts";

export type IncenseKind = (typeof incenseKinds)[number];

/** An impossible burner state. */
export class IncenseError extends Error {}

const TAU = Math.PI * 2;

// ---- layout (frame heights), shared with the shader through incenseLayoutGlsl -------------------

/** The anchor: share of the frame's width, and the table top's height under the burner. */
const ANCHOR_X = 0.58;
const FLOOR = 0.1;
/** The dish a stick or cone stands in: half its width, its height. */
const DISH_W = 0.04;
const DISH_H = 0.014;
/** The stick: where it enters the dish's sand, its length, lean (radians, to the right), and the share that burns. */
const STICK_BASE = 0.012;
const STICK_LENGTH = 0.26;
const STICK_LEAN = 0.05;
const STICK_BURN = 0.8;
/** The cone: base height on the sand, height, half width; the ember ring's and the crumbling tip's descent. */
const CONE_BASE = 0.012;
const CONE_H = 0.046;
const CONE_W = 0.015;
const CONE_BURN = 0.9;
const CONE_CRUMBLE = 0.3;
/** The coil's stand (plate height, half width) and the coil: centre height, radii, turns, foreshortening. */
const PLATE_Y = 0.01;
const PLATE_W = 0.09;
const COIL_Y = 0.016;
const COIL_IN = 0.014;
const COIL_OUT = 0.084;
const COIL_TURNS = 4.25;
const COIL_END = 0.3;
const COIL_SQUASH = 0.3;
/** The backflow mountain's cup (where its cone stands) and the outlet the cold smoke pours from. */
const MOUNT_CUP_X = -0.044;
const MOUNT_TOP = 0.169;
const MOUNT_CONE_H = 0.034;
const MOUNT_CONE_W = 0.011;
const OUTLET_X = 0.008;
const OUTLET_Y = 0.13;
/** The candle, from the anchor: its base (a little in front of the burner), half width, height. */
const CANDLE_DX = -0.27;
const CANDLE_Y = -0.012;
const CANDLE_W = 0.024;
const CANDLE_H = 0.075;
/** The candle flame's base above the candle's top, and its height. */
const FLAME_BASE = 0.005;
const FLAME_H = 0.042;
/** The stick's ash: fall acceleration (frame heights / s²) and most pieces lying in the dish. */
const ASH_GRAVITY = 1.6;
const MAX_FALLEN = 7;

/** The coil's pitch to five places, as the shader has always read it: a finer value would shift the spiral. */
const COIL_PITCH = Number(((COIL_OUT - COIL_IN) / COIL_TURNS).toFixed(5));

/** The layout as GLSL defines, for the scene's shader and the fluid's snippets. */
export const incenseLayoutGlsl = `
#define INCENSE_X ${glslFloat(ANCHOR_X)}
#define INCENSE_FLOOR ${glslFloat(FLOOR)}
#define INCENSE_DISH_W ${glslFloat(DISH_W)}
#define INCENSE_DISH_H ${glslFloat(DISH_H)}
#define INCENSE_STICK_BASE ${glslFloat(STICK_BASE)}
#define INCENSE_STICK_LEAN ${glslFloat(STICK_LEAN)}
#define INCENSE_CONE_BASE ${glslFloat(CONE_BASE)}
#define INCENSE_CONE_H ${glslFloat(CONE_H)}
#define INCENSE_CONE_W ${glslFloat(CONE_W)}
#define INCENSE_CONE_BURN ${glslFloat(CONE_BURN)}
#define INCENSE_CONE_CRUMBLE ${glslFloat(CONE_CRUMBLE)}
#define INCENSE_PLATE_Y ${glslFloat(PLATE_Y)}
#define INCENSE_PLATE_W ${glslFloat(PLATE_W)}
#define INCENSE_COIL_Y ${glslFloat(COIL_Y)}
#define INCENSE_COIL_IN ${glslFloat(COIL_IN)}
#define INCENSE_COIL_PITCH ${glslFloat(COIL_PITCH)}
#define INCENSE_COIL_TURNS ${glslFloat(COIL_TURNS)}
#define INCENSE_COIL_END ${glslFloat(COIL_END)}
#define INCENSE_COIL_SQUASH ${glslFloat(COIL_SQUASH)}
#define INCENSE_MOUNT_CUP_X ${glslFloat(MOUNT_CUP_X)}
#define INCENSE_MOUNT_TOP ${glslFloat(MOUNT_TOP)}
#define INCENSE_MOUNT_CONE_H ${glslFloat(MOUNT_CONE_H)}
#define INCENSE_MOUNT_CONE_W ${glslFloat(MOUNT_CONE_W)}
#define INCENSE_OUTLET_X ${glslFloat(OUTLET_X)}
#define INCENSE_OUTLET_Y ${glslFloat(OUTLET_Y)}
#define INCENSE_CANDLE_DX ${glslFloat(CANDLE_DX)}
#define INCENSE_CANDLE_Y ${glslFloat(CANDLE_Y)}
#define INCENSE_CANDLE_W ${glslFloat(CANDLE_W)}
#define INCENSE_CANDLE_H ${glslFloat(CANDLE_H)}
#define INCENSE_FLAME_BASE ${glslFloat(FLAME_BASE)}
#define INCENSE_FLAME_H ${glslFloat(FLAME_H)}
#define INCENSE_ASH_GRAVITY ${glslFloat(ASH_GRAVITY)}
#define INCENSE_MAX_FALLEN ${MAX_FALLEN}
`;

/**
 * Side-on silhouettes as signed distances (frame heights, negative inside), q from the anchor: the
 * fluid's obstacle and the shader's drawing share them. They use sdBox and smin, from the shared GLSL
 * (the scene's `common`, or `gpuCommonGlsl` in the obstacle's pass).
 */
export const incenseShapesGlsl = `
// The glazed dish a stick or a cone stands in.
float incenseDish(vec2 q) {
  return sdBox(q - vec2(0.0, 0.5 * INCENSE_DISH_H), vec2(INCENSE_DISH_W, 0.5 * INCENSE_DISH_H), 0.005);
}

// The coil's stand: a thin round plate on three short feet.
float incensePlate(vec2 q) {
  return sdBox(q - vec2(0.0, INCENSE_PLATE_Y), vec2(INCENSE_PLATE_W, 0.003), 0.003);
}

// The backflow burner: a little ceramic mountain of three ledges stepping down to the right, with a
// cup on top for its cone. The cold smoke pours from an outlet on the top ledge's right face.
float incenseMountain(vec2 q) {
  float d = sdBox(q - vec2(0.0, 0.022), vec2(0.1, 0.022), 0.016);
  d = smin(d, sdBox(q - vec2(-0.022, 0.07), vec2(0.068, 0.028), 0.018), 0.01);
  d = smin(d, sdBox(q - vec2(-0.04, 0.122), vec2(0.04, 0.026), 0.018), 0.01);
  return smin(d, sdBox(q - vec2(INCENSE_MOUNT_CUP_X, 0.157), vec2(0.022, 0.012), 0.008), 0.006);
}

// What the incense stands on, by kind (0 stick, 1 cone, 2 coil, 3 waterfall).
float incenseHolder(vec2 q, float kind) {
  if (kind < 1.5) return incenseDish(q);
  if (kind < 2.5) return incensePlate(q);
  return incenseMountain(q);
}

// The candle's wax pillar.
float incenseCandleBody(vec2 q) {
  vec2 c = vec2(INCENSE_CANDLE_DX, INCENSE_CANDLE_Y + 0.5 * INCENSE_CANDLE_H);
  return sdBox(q - c, vec2(INCENSE_CANDLE_W, 0.5 * INCENSE_CANDLE_H), 0.004);
}
`;

// ---- the fluid ---------------------------------------------------------------------------------

/** Velocity and dye texels on the frame's short side. */
const VELOCITY_RES = 112;
const DYE_RES = 320;
/**
 * Seconds per step of the room (one FixedStep for the smoke, the motes, the burner and the doors),
 * and the most steps one frame takes: below 20 frames a second the smoke slows rather than a slow
 * frame piling up steps.
 */
const STEP = 1 / 60;
const MAX_STEPS = 3;

/** Smoke and heat laid per second at the ember (the smoke knob scales the smoke), and the splat's radius. */
const EMIT_SMOKE = 3;
const EMIT_HEAT = 6;
const EMIT_RADIUS = 0.0045;
/** Upward acceleration per unit of heat, frame heights per second². */
const BUOYANCY = 0.3;
/** Fade rates per second: smoke (slow: old smoke lingers in veils), heat, fresh smoke, velocity. */
const SMOKE_FADE = 0.03;
const HEAT_FADE = 0.32;
const FRESH_FADE = 0.35;
const VELOCITY_FADE = 0.2;
/** Vorticity confinement and the stir at full turbulence. */
const VORTICITY = 4;
const STIR = 5;
/** The laminar span above the ember (frame heights) and how firmly its air keeps to the draft (per second). */
const LAMINAR_SPAN = 0.13;
const LAMINAR_RATE = 10;
/** The room's draft at full knob (frame heights per second) and how firmly the air follows it. */
const AIR_SPEED = 0.045;
const AIR_RATE = 0.25;
/**
 * Under the ceiling: the faint draft there at full draft knob (frame heights per second, to the
 * right) and the height it starts at; how firmly the warmer air there stops cooled smoke rising
 * (per unit of smoke) and the height that starts at.
 */
const CEILING_DRIFT = 0.075;
const CEILING_FROM = 0.65;
const STRATIFY = 0.6;
const STRATIFY_FROM = 0.86;
/**
 * The ceiling vent, at full draw: its pull along the ceiling toward the extractor on the right
 * (frame heights per second at the frame's right edge, half that at its left), the height it reaches
 * down to (above the thread, which frays out below it), and how firmly the layer follows it.
 */
const VENT_SPEED = 0.16;
const VENT_FROM = 0.72;
const VENT_RATE = 0.8;
/** The backflow: cold (negative heat) and smoke per second at the outlet, its push out, and the wisp from the cone's tip. */
const BACKFLOW_COLD = 9;
const BACKFLOW_SMOKE = 1.4;
const BACKFLOW_RADIUS = 0.0065;
const BACKFLOW_PUSH = 0.6;
const WISP_SMOKE = 0.3;
const WISP_HEAT = 0.7;
/** The candle's heat per second, laid just above its flame. */
const CANDLE_HEAT = 9;
/** A hand: share of the pointer's speed given to the air each step, the strongest push a step, its reach. */
const HAND_GAIN = 0.3;
const HAND_MAX = 0.25;
const HAND_RADIUS = 0.04;

/** A door's draft: its strongest speed, how firmly the air follows, its front's speed and softness. */
const GUST_SPEED = 0.08;
const GUST_RATE = 0.8;
const FRONT_SPEED = 0.6;
const FRONT_SOFT = 0.25;
/** The draft's shape in seconds: rising, falling away, the swing back as the door closes, its end. */
const GUST_RISE = 1.5;
const GUST_FALL = 4;
const GUST_SWING = 0.3;
const GUST_SWING_AT = 8;
const GUST_SWING_WIDTH = 2.5;
const GUST_SECONDS = 16;
/** Seconds between doors at the knob's ends (jittered), and before the first. */
const DOOR_RARE = 300;
const DOOR_OFTEN = 40;
const DOOR_FIRST = 45;

/**
 * First-frame prewarm: this many steps of this length (short, so the thread is laid smooth, not
 * beaded), run within a CPU-time budget per frame: PREWARM_MS at least (the plume is the first
 * thing shown), more when the frame's budget allows. A slow machine takes more frames to get
 * through them, never fewer steps, and the scene holds still until they are done.
 */
const PREWARM_DT = 0.05;
const PREWARM_STEPS = 48;
const PREWARM_MS = 150;

// ---- the passage -------------------------------------------------------------------------------

/** Shares of the entrance: the ember takes light from the first to the second; the thread's head climbs between the next two. */
const KINDLE_FROM = 0.06;
const KINDLE_TO = 0.36;
const RISE_FROM = 0.22;
const RISE_TO = 0.92;
/** Where the head climbs to (frame heights, up in the layered air under the ceiling). */
const RISE_TOP = 0.88;
/** The thread at its foot: half width, how much it flares, and the upward speed it is drawn with (as in seedPlume) over this half width. */
const THREAD_W = 0.0035;
const THREAD_FLARE = 0.008;
const THREAD_LIFT = 0.06;
const THREAD_LIFT_W = 0.02;
/** The head is drawn in steps of this many frame heights, at most this many a frame (a slow frame catches up over the next). */
const RISE_STEP = 0.005;
const RISE_MAX_STEPS = 80;
/** Veils are laid from this height above the ember, a row every VEIL_STEP, each of this many soft patches across. */
const VEIL_FROM = 0.22;
const VEIL_STEP = 0.02;
const VEIL_BLOBS = 5;

/** The exit's draught: speed (frame heights per second), how firmly the air follows, and shares of the exit: its front crosses the room in, it cuts the ember's smoke off in. */
const DRAUGHT_SPEED = 0.9;
const DRAUGHT_RATE = 5;
const DRAUGHT_SWEEP = 0.3;
const DRAUGHT_BREAK = 0.18;

/** The entrance's beats as GLSL defines, for the analytic plume (shader.ts) that stands in without float targets. */
export const incensePassageGlsl = `
#define INCENSE_RISE_FROM ${glslFloat(RISE_FROM)}
#define INCENSE_RISE_TO ${glslFloat(RISE_TO)}
#define INCENSE_RISE_TOP ${glslFloat(RISE_TOP)}
#define INCENSE_BREAK ${glslFloat(DRAUGHT_BREAK)}
`;

/** How far the ember has taken light, 0..1, at this progress of the entrance. */
function kindle(progress: number): number {
  return smoothstep(KINDLE_FROM, KINDLE_TO, progress);
}

/** How far the thread's head has climbed above a source at height sourceY, at this progress of the entrance (fast out of the ember, easing in under the ceiling). */
function riseHead(progress: number, sourceY: number): number {
  const s = clamp((progress - RISE_FROM) / (RISE_TO - RISE_FROM), 0, 1);
  return Math.max(0, RISE_TOP - sourceY) * (1 - (1 - s) * (1 - s));
}

/** Dust motes: the particle grid (one mote per texel), their point size in field texels. */
const MOTES_X = 24;
const MOTES_Y = 16;
const MOTE_SIZE = 3.2;
/** Motes leaving the frame come back in at the other side, above the table. */
const MOTE_LOW = FLOOR + 0.05;

const FORCE_GLSL = `
uniform float uBuoyancy;  // upward acceleration per unit of heat (dye.g)
uniform vec4 uAir;        // the room's draft: x velocity, sway amplitude, sway phase, coupling per second
uniform vec4 uGust;       // a door's draft: x velocity, front x, direction (+1 rightward), coupling per second
uniform vec4 uSource;     // where the smoke leaves the ember (p), laminar span, laminar coupling per second
uniform vec4 uStir;       // the room's faint currents: strength, height above the source, ramp, smoke gain
uniform vec4 uCeiling;    // under the ceiling: drift speed, height it starts; stratification, height it starts
uniform vec4 uVent;       // the ceiling vent: pull at the right edge (0: shut), height it reaches down to, coupling per second, 0

vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
  // Warm air rises; under the ceiling the air is warmer still, so cooled smoke stops rising there
  // and spreads out in layers.
  vec2 a = vec2(0.0, uBuoyancy * dye.g - uCeiling.z * dye.r * smoothstep(uCeiling.w, 1.0, p.y));

  // The air follows the room's slow draft, sheared with height and drifting off to the right under
  // the ceiling; a door's draft takes over behind its front, strongest along the floor.
  float target = uAir.x + uAir.y * sin(uAir.z + 2.5 * p.y) + uCeiling.x * smoothstep(uCeiling.y, 1.0, p.y);
  float rate = uAir.w;
  float swept = smoothstep(-${glslFloat(FRONT_SOFT)}, ${glslFloat(FRONT_SOFT)}, uGust.z * (uGust.y - p.x));
  target += swept * uGust.x * mix(1.0, 0.55, smoothstep(0.15, 0.9, p.y));
  rate += swept * uGust.w;

  // The ceiling vent draws the layer under the ceiling off to the right, harder toward its
  // extractor; it never reaches down to the thread.
  if (uVent.x > 0.0) {
    float layer = smoothstep(uVent.y, 1.0, p.y);
    target += layer * uVent.x * (0.5 + 0.5 * p.x / uDomain.x);
    rate += layer * uVent.z;
  }

  // Just above the ember the air keeps firmly to the draft: the thread rises laminar, leaning.
  vec2 s = p - uSource.xy;
  float calm = (1.0 - smoothstep(0.025, 0.05, abs(s.x))) * smoothstep(-0.03, 0.0, s.y) * (1.0 - smoothstep(0.6 * uSource.z, uSource.z, s.y));
  rate += uSource.w * calm;
  a.x += min(rate, 0.8 / uDt) * (target - velocity.x);

  // A hand-span up, faint currents curl it: the curl of a slowly drifting stream function, only
  // where there is smoke.
  float stir = uStir.x * smoothstep(uSource.y + uStir.y, uSource.y + uStir.y + uStir.z, p.y) * min(1.0, uStir.w * dye.r);
  if (stir > 0.0) {
    vec3 k0 = vec3(40.0, 18.0, 0.0010);
    vec3 k1 = vec3(-27.0, 35.0, 0.0010);
    vec3 k2 = vec3(55.0, -30.0, 0.0006);
    vec2 g = k0.xy * (k0.z * cos(dot(k0.xy, p) + 0.7 * uTime + 0.3))
           + k1.xy * (k1.z * cos(dot(k1.xy, p) - 0.9 * uTime + 1.7))
           + k2.xy * (k2.z * cos(dot(k2.xy, p) + 0.5 * uTime + 4.1));
    a += stir * vec2(g.y, -g.x);
  }
  return a;
}
`;

const OBSTACLE_GLSL = `
uniform vec2 uHolder;  // kind (0 stick, 1 cone, 2 coil, 3 waterfall), candle (0 / 1)
${gpuCommonGlsl}
${incenseLayoutGlsl}
${incenseShapesGlsl}
float fluidObstacle(vec2 p) {
  vec2 q = p - vec2(INCENSE_X * uDomain.x, INCENSE_FLOOR);
  float d = min(q.y, incenseHolder(q, uHolder.x));
  return uHolder.y > 0.5 ? min(d, incenseCandleBody(q)) : d;
}
`;

const MOTE_MOVE_GLSL = `
uniform sampler2D uMotes;
uniform sampler2D uVelocity;
uniform float uDt;
uniform float uTime;
uniform float uAspect;
uniform float uLow;
void main() {
  vec4 m = texelFetch(uMotes, ivec2(gl_FragCoord.xy), 0);
  vec2 air = texture(uVelocity, m.xy).xy;
  // Each mote also wanders slowly on its own and settles a little: dust is barely heavier than air.
  float k = m.z * 6.2831853;
  vec2 wander = 0.006 * vec2(sin(uTime * (0.21 + 0.1 * m.w) + k), cos(uTime * (0.17 + 0.08 * m.w) + 1.7 * k));
  vec2 xy = m.xy + uDt * (0.85 * air + wander - vec2(0.0, 0.002)) / vec2(uAspect, 1.0);
  xy.x = fract(xy.x);
  xy.y = uLow + mod(xy.y - uLow, 1.0 - uLow);
  fragColor = vec4(xy, m.zw);
}
`;

const MOTE_DEPOSIT_GLSL = `
uniform sampler2D uMotes;
uniform sampler2D uWas;  // the motes as the step before last left them
uniform float uAlpha;    // how far the frame is from that step to the last (FixedStep.alpha)
uniform float uTime;
uniform float uLow;
bool particle(int id, out vec2 uv, out vec4 value) {
  ivec2 at = particleTexel(id, textureSize(uMotes, 0));
  vec4 m = texelFetch(uMotes, at, 0);
  vec2 was = texelFetch(uWas, at, 0).xy;
  // Between the two steps, unless the mote came back in at the other side between them.
  vec2 jump = abs(m.xy - was);
  uv = jump.x < 0.5 && jump.y < 0.5 * (1.0 - uLow) ? mix(was, m.xy, uAlpha) : m.xy;
  // A flake turning over catches the light now and then: a slow glint.
  float glint = 0.5 + 0.5 * sin(uTime * (0.35 + 0.5 * m.w) + m.z * 6.2831853);
  value = vec4((0.35 + 0.65 * m.w) * (0.25 + 0.75 * glint * glint), 0.0, 0.0, 0.0);
  pointSize = uPointSize * (0.75 + 0.5 * m.w);
  return true;
}
`;

// ---- small helpers -----------------------------------------------------------------------------

function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function fbm3(x: number, y: number): number {
  return (
    0.55 * valueNoise(x, y) +
    0.3 * valueNoise(2.03 * x + 17.1, 2.03 * y + 9.2) +
    0.15 * valueNoise(4.1 * x + 3.7, 4.1 * y + 21.4)
  );
}

interface Point {
  x: number;
  y: number;
}

// ---- the knobs ---------------------------------------------------------------------------------

type IncenseKnob =
  | "stick"
  | "smoke"
  | "renew"
  | "draft"
  | "turbulence"
  | "vent"
  | "door"
  | "hand"
  | "candle"
  | "dust";

interface Settings {
  kind: IncenseKind;
  /** Emission scale for the smoke. */
  smoke: number;
  renew: boolean;
  draft: number;
  turbulence: number;
  /** The ceiling vent's draw, 0 (shut) to 1. */
  vent: number;
  /** How often doors open, 0 (never by themselves) to 1. */
  doors: number;
  hand: boolean;
  candle: boolean;
  dust: boolean;
}

/** Write this frame's settings into `out`. */
function readSettings(out: Settings, frame: SimFrame, knobs: KnobReader<IncenseKnob>): void {
  out.kind =
    incenseKinds[clamp(Math.round(knobs.value(frame, "stick")), 0, incenseKinds.length - 1)] ??
    "stick";
  out.smoke = 0.25 + 1.5 * clamp(knobs.value(frame, "smoke"), 0, 1);
  out.renew = knobs.value(frame, "renew") > 0.5;
  out.draft = clamp(knobs.value(frame, "draft"), 0, 1);
  out.turbulence = clamp(knobs.value(frame, "turbulence"), 0, 1);
  out.vent = clamp(knobs.value(frame, "vent"), 0, 1);
  out.doors = clamp(knobs.value(frame, "door"), 0, 1);
  out.hand = knobs.value(frame, "hand") > 0.5;
  out.candle = knobs.value(frame, "candle") > 0.5;
  out.dust = knobs.value(frame, "dust") > 0.001;
}

// ---- the incense, burning ----------------------------------------------------------------------

type BurnPhase = "arriving" | "lighting" | "burning" | "dying" | "out" | "leaving";

/** Minutes of burning, by kind (seconds on the scene's motion clock). */
const BURN_SECONDS: Readonly<Record<IncenseKind, number>> = {
  stick: 360,
  cone: 210,
  coil: 900,
  waterfall: 210,
};
/** How far the first incense has burnt when the scene opens. */
const OPENING_PROGRESS: Readonly<Record<IncenseKind, number>> = {
  stick: 0.12,
  cone: 0.22,
  coil: 0.06,
  waterfall: 0.22,
};
/** Seconds: set down (fading in), lit (glow rising), going out, resting cold, taken away. */
const ARRIVE_SECONDS = 2.5;
const LIGHT_SECONDS = 2.5;
const DIE_SECONDS = 6;
const REST_SECONDS = 8;
const LEAVE_SECONDS = 2.5;
/** The stick's ash breaks off at a length between these (frame heights). */
const ASH_BREAK: readonly [number, number] = [0.016, 0.03];

interface FallingAsh {
  age: number;
  /** Where it broke off, from the anchor. */
  x: number;
  y: number;
  length: number;
}

class Burner {
  kind: IncenseKind;
  #phase: BurnPhase = "burning";
  #phaseTime = 0;
  progress: number;
  glow = 1;
  presence = 1;
  /** The stick's ash above the ember, its length and its curl (signed, radians at full length). */
  ash = 0;
  #breakAt: number;
  curl: number;
  falling: FallingAsh | undefined;
  fallen = 0;
  readonly #rand = mulberry32(0x1ce5e);

  constructor(kind: IncenseKind) {
    this.kind = kind;
    this.progress = OPENING_PROGRESS[kind];
    this.#breakAt = lerp(ASH_BREAK[0], ASH_BREAK[1], this.#rand());
    // The opening stick has been burning a while: some ash on it, a few pieces already in the dish.
    this.ash = kind === "stick" ? 0.7 * this.#breakAt : 0;
    this.fallen = kind === "stick" ? 2 : 0;
    this.curl = this.#newCurl();
  }

  /** A different incense: the old one is gone at once, the new one set down and lit. */
  replace(kind: IncenseKind): void {
    this.kind = kind;
    this.#restart();
  }

  /** "Now": take the burning one away and light a fresh one. */
  renew(): void {
    if (this.#phase === "leaving" || this.#phase === "arriving") return;
    this.#enter("leaving");
  }

  step(dt: number, renew: boolean): void {
    if (dt <= 0) return;
    this.#phaseTime += dt;
    const t = this.#phaseTime;
    const phase = this.#phase;
    switch (phase) {
      case "arriving":
        this.presence = smoothstep(0, 1, t / ARRIVE_SECONDS);
        if (t >= ARRIVE_SECONDS) this.#enter("lighting");
        break;
      case "lighting":
        this.glow = smoothstep(0, 1, t / LIGHT_SECONDS);
        this.#burn(dt);
        if (t >= LIGHT_SECONDS) this.#enter("burning");
        break;
      case "burning":
        this.glow = 1;
        this.#burn(dt);
        if (this.progress >= 1) this.#enter("dying");
        break;
      case "dying":
        this.glow = 1 - smoothstep(0, 1, t / DIE_SECONDS);
        if (t >= DIE_SECONDS) this.#enter("out");
        break;
      case "out":
        this.glow = 0;
        if (renew && t >= REST_SECONDS) this.#enter("leaving");
        break;
      case "leaving":
        // Taken away still burning ("now"): its ember fades with it.
        this.presence = 1 - smoothstep(0, 1, t / LEAVE_SECONDS);
        this.glow = Math.min(this.glow, this.presence);
        if (t >= LEAVE_SECONDS) this.#restart();
        break;
      default: {
        const unreachable: never = phase;
        throw new IncenseError(`incense: unknown burn phase ${String(unreachable)}`);
      }
    }
    const falling = this.falling;
    if (falling) {
      falling.age += dt;
      if (falling.age >= Math.sqrt((2 * Math.max(0, falling.y - DISH_H)) / ASH_GRAVITY)) {
        this.falling = undefined;
        this.fallen = Math.min(MAX_FALLEN, this.fallen + 1);
      }
    }
  }

  /** The ember, from the anchor: the stick's top, the cone's ring, the point on the coil. */
  ember(): Point {
    const s = this.progress;
    const kind = this.kind;
    switch (kind) {
      case "stick": {
        const length = STICK_LENGTH * (1 - STICK_BURN * s);
        return { x: Math.sin(STICK_LEAN) * length, y: STICK_BASE + Math.cos(STICK_LEAN) * length };
      }
      case "cone":
        return { x: 0, y: CONE_BASE + CONE_H * (1 - CONE_BURN * s) };
      case "coil": {
        const turns = COIL_TURNS - s * (COIL_TURNS - COIL_END);
        const radius = COIL_IN + ((COIL_OUT - COIL_IN) / COIL_TURNS) * turns;
        const angle = TAU * turns;
        return { x: radius * Math.cos(angle), y: COIL_Y + COIL_SQUASH * radius * Math.sin(angle) };
      }
      case "waterfall":
        return { x: MOUNT_CUP_X, y: MOUNT_TOP + MOUNT_CONE_H * (1 - CONE_BURN * s) };
      default: {
        const unreachable: never = kind;
        throw new IncenseError(`incense: unknown kind ${String(unreachable)}`);
      }
    }
  }

  /** Where the rising smoke leaves the incense, from the anchor. */
  source(): Point {
    const s = this.progress;
    const kind = this.kind;
    switch (kind) {
      case "stick": {
        const ember = this.ember();
        return {
          x: ember.x + Math.sin(STICK_LEAN) * 0.005,
          y: ember.y + Math.cos(STICK_LEAN) * 0.005,
        };
      }
      case "cone":
        return { x: 0, y: CONE_BASE + CONE_H * (1 - CONE_CRUMBLE * s) + 0.003 };
      case "coil": {
        const ember = this.ember();
        return { x: ember.x, y: ember.y + 0.005 };
      }
      case "waterfall":
        return { x: MOUNT_CUP_X, y: MOUNT_TOP + MOUNT_CONE_H * (1 - CONE_CRUMBLE * s) + 0.003 };
      default: {
        const unreachable: never = kind;
        throw new IncenseError(`incense: unknown kind ${String(unreachable)}`);
      }
    }
  }

  /**
   * The shader's view, three rgba texels, `lag` seconds before the last step (where the smoke is
   * shown, between its last two steps): the falling ash at that moment, the rest as the last step
   * left it (they change over seconds and minutes, about a hundredth or less a step):
   *   0  ember from the anchor (x, y), glow 0..1, presence 0..1 (fading in and out)
   *   1  progress 0..1, ash length, ash curl (radians), ash pieces lying in the dish
   *   2  falling ash: seconds falling (-1: none), where it broke off from the anchor (x, y), length
   */
  write(out: Float32Array, lag: number): void {
    const ember = this.ember();
    out[0] = ember.x;
    out[1] = ember.y;
    out[2] = this.glow;
    out[3] = this.presence;
    out[4] = this.progress;
    out[5] = this.ash;
    out[6] = this.curl * clamp(this.ash / this.#breakAt, 0, 1) ** 2;
    out[7] = this.fallen;
    const falling = this.falling;
    out[8] = falling ? Math.max(0, falling.age - lag) : -1;
    out[9] = falling ? falling.x : 0;
    out[10] = falling ? falling.y : 0;
    out[11] = falling ? falling.length : 0;
  }

  #burn(dt: number): void {
    const before = this.progress;
    this.progress = Math.min(1, before + dt / BURN_SECONDS[this.kind]);
    if (this.kind !== "stick") return;
    this.ash += STICK_LENGTH * STICK_BURN * (this.progress - before);
    if (this.ash < this.#breakAt) return;
    // The ash breaks off and drops into the dish; the next piece curls the other way, or not.
    const ember = this.ember();
    const lean = STICK_LEAN + 0.5 * this.curl;
    this.falling = {
      age: 0,
      x: ember.x + 0.5 * this.ash * Math.sin(lean),
      y: ember.y + 0.5 * this.ash * Math.cos(lean),
      length: this.ash,
    };
    this.ash = 0;
    this.#breakAt = lerp(ASH_BREAK[0], ASH_BREAK[1], this.#rand());
    this.curl = this.#newCurl();
  }

  #newCurl(): number {
    return (this.#rand() < 0.5 ? -1 : 1) * lerp(0.25, 0.7, this.#rand());
  }

  #enter(phase: BurnPhase): void {
    this.#phase = phase;
    this.#phaseTime = 0;
  }

  #restart(): void {
    this.progress = 0;
    this.glow = 0;
    this.presence = 0;
    this.ash = 0;
    this.falling = undefined;
    this.fallen = 0;
    this.#enter("arriving");
  }
}

// ---- doors -------------------------------------------------------------------------------------

/** Now and then a door opens somewhere: a draft sweeps across the room, then swings back a little. */
class Doors {
  #clock = 0;
  #next: number | undefined;
  #gust: { start: number; dir: number } | undefined;
  readonly #rand = mulberry32(0xd002);
  /** The force snippet's uGust. */
  readonly uniform = new Float32Array([0, 0, 1, 0]);

  /** A door opens now (the next one by itself comes a full interval later). */
  open(): void {
    this.#gust = { start: this.#clock, dir: this.#rand() < 0.5 ? -1 : 1 };
    this.#next = undefined;
  }

  /** Advance by a step of the plume; `often` 0 (no doors by themselves) to 1. */
  update(dt: number, often: number, aspect: number): void {
    this.#clock += dt;
    const now = this.#clock;
    if (often <= 0) this.#next = undefined;
    else if (this.#next === undefined)
      this.#next = Math.max(
        DOOR_FIRST,
        now + lerp(DOOR_RARE, DOOR_OFTEN, often) * (0.6 + 0.8 * this.#rand()),
      );
    else if (now >= this.#next) this.open();

    const u = this.uniform;
    const gust = this.#gust;
    if (gust === undefined || now - gust.start > GUST_SECONDS) {
      this.#gust = undefined;
      u[0] = 0;
      u[3] = 0;
      return;
    }
    // The draft rises, falls away, and swings back a little as the door swings shut.
    const tau = now - gust.start;
    const swing = (tau - GUST_SWING_AT) / GUST_SWING_WIDTH;
    const strength =
      (tau < GUST_RISE
        ? smoothstep(0, 1, tau / GUST_RISE)
        : Math.exp(-(tau - GUST_RISE) / GUST_FALL)) -
      GUST_SWING * Math.exp(-swing * swing);
    u[0] = gust.dir * GUST_SPEED * strength;
    u[1] = (gust.dir > 0 ? -FRONT_SOFT : aspect + FRONT_SOFT) + gust.dir * FRONT_SPEED * tau;
    u[2] = gust.dir;
    u[3] = GUST_RATE * Math.min(1, 3 * Math.abs(strength));
  }
}

// ---- dust motes --------------------------------------------------------------------------------

/** Dust motes in the light: moved by the air a step at a time, drawn between their last two steps. */
class Motes {
  readonly #state: PingPong;
  readonly field: RenderTarget;
  readonly #move: Pass;
  readonly #deposit: Scatter;
  readonly #moveUniforms = { uDt: 0, uTime: 0, uAspect: 1 };
  readonly #depositUniforms = { uTime: 0, uAlpha: 1 };
  /** The deposit's uWas: after a move, the pair's write side holds the motes as they stood before it. */
  readonly #depositTextures: { uWas: RenderTarget };
  readonly #depositRun: ScatterRunOptions;
  #aspect: number;
  #moved = false;

  constructor(gpu: GpuCompute, aspect: number, velocity: PingPong) {
    this.#aspect = aspect;
    this.#state = gpu.pingPong({
      width: MOTES_X,
      height: MOTES_Y,
      format: "rgba32f",
      filter: "nearest",
    });
    const rand = mulberry32(0x0d057);
    const start = new Float32Array(MOTES_X * MOTES_Y * 4);
    for (let i = 0; i < MOTES_X * MOTES_Y; i++) {
      start[i * 4] = rand();
      start[i * 4 + 1] = MOTE_LOW + (1 - MOTE_LOW) * rand();
      start[i * 4 + 2] = rand();
      start[i * 4 + 3] = rand();
    }
    this.#state.seed(start);
    this.field = gpu.target({ ...gridSize(aspect, DYE_RES), format: "r16f" });
    this.#move = gpu
      .pass(MOTE_MOVE_GLSL, "incense motes move")
      .bind({ uMotes: this.#state, uVelocity: velocity });
    this.#deposit = gpu
      .scatter(MOTE_DEPOSIT_GLSL, { name: "incense motes deposit", shape: "soft" })
      .bind({ uMotes: this.#state });
    this.#move.set({ uLow: MOTE_LOW });
    this.#deposit.set({ uLow: MOTE_LOW });
    this.#depositTextures = { uWas: this.#state.write };
    this.#depositRun = {
      count: MOTES_X * MOTES_Y,
      pointSize: MOTE_SIZE,
      uniforms: this.#depositUniforms,
      textures: this.#depositTextures,
    };
  }

  /** One step of `dt` seconds, ending at `time`: the air carries the motes on. */
  move(dt: number, time: number, aspect: number): void {
    const uniforms = this.#moveUniforms;
    uniforms.uDt = dt;
    uniforms.uTime = time;
    uniforms.uAspect = aspect;
    this.#move.set(uniforms).run(this.#state);
    this.#moved = true;
  }

  /**
   * The motes into the field, `alpha` of the way from where the step before last left them to where
   * the last did (FixedStep.alpha; where they lie until they first move), glinting at `time`.
   */
  draw(alpha: number, time: number, aspect: number): void {
    if (aspect !== this.#aspect) {
      this.#aspect = aspect;
      const size = gridSize(aspect, DYE_RES);
      this.field.resize(size.width, size.height);
    }
    this.field.clear(0);
    const uniforms = this.#depositUniforms;
    uniforms.uTime = time;
    uniforms.uAlpha = this.#moved ? alpha : 1;
    this.#depositTextures.uWas = this.#state.write;
    this.#deposit.run(this.field, this.#depositRun);
  }
}

// ---- the smoke ---------------------------------------------------------------------------------

/** How far the thread's axis has swayed off its lean at height h above the source (see seedPlume). */
function threadSway(h: number): number {
  return 0.02 * smoothstep(0.1, 0.32, h) * Math.sin(70 * h + 0.7 + 5 * fbm3(5.3, 9 * h));
}

/**
 * A plume as it stands after a while of burning, painted straight into the fluid on the first
 * frame so the scene opens on one (the prewarm steps that follow then only settle it, however slow the machine): a
 * laminar thread, leaning a little, beginning to sway a hand-span up and fraying out; and above it
 * the older smoke, spread into faint veils that widen and drift off to the right under the ceiling.
 */
function seedPlume(fluid: FluidSim, source: Point, smoke: number): void {
  const aspect = fluid.aspect;
  // The thread's axis and width h above the source, and how much of it is still a thread.
  const thread = (x: number, h: number): { dx: number; width: number; share: number } => {
    const sway = threadSway(h);
    return {
      dx: x - source.x + 0.03 * h - sway,
      width: 0.0035 + 0.008 * smoothstep(0.1, 0.4, h),
      share: 1 - smoothstep(0.28, 0.42, h),
    };
  };
  // The veils' middle and breadth.
  const veil = (x: number, y: number, h: number): { dx: number; width: number } => ({
    dx:
      x -
      source.x +
      0.02 -
      0.12 * smoothstep(0.35, 0.65, h) -
      0.08 * (fbm3(3 * x + 5.1, 4 * y) - 0.5),
    width: 0.03 + 0.1 * smoothstep(0.25, 0.6, h),
  });

  const vw = fluid.velocity.width;
  const vh = fluid.velocity.height;
  const velocity = new Float32Array(vw * vh * 2);
  for (let j = 0; j < vh; j++) {
    const y = (j + 0.5) / vh;
    const h = y - source.y;
    if (h < -0.01) continue;
    for (let i = 0; i < vw; i++) {
      const x = ((i + 0.5) / vw) * aspect;
      if (Math.abs(x - source.x) > 0.45) continue;
      const t = thread(x, h);
      const v = veil(x, y, h);
      const rise =
        0.06 * Math.exp(-((t.dx / 0.02) ** 2)) * t.share +
        0.03 * Math.exp(-((v.dx / v.width) ** 2)) * smoothstep(0.2, 0.35, h);
      velocity[(j * vw + i) * 2 + 1] =
        rise * smoothstep(-0.01, 0.02, h) * (1 - smoothstep(0.8, 1, y));
    }
  }

  const dw = fluid.dye.width;
  const dh = fluid.dye.height;
  const dye = new Float32Array(dw * dh * 4);
  for (let j = 0; j < dh; j++) {
    const y = (j + 0.5) / dh;
    const h = y - source.y;
    if (h < -0.004) continue;
    for (let i = 0; i < dw; i++) {
      const x = ((i + 0.5) / dw) * aspect;
      if (Math.abs(x - source.x) > 0.45) continue;
      const t = thread(x, h);
      const v = veil(x, y, h);
      const fresh =
        0.4 *
        smoke *
        (0.0035 / t.width) ** 0.7 *
        Math.exp(-((t.dx / t.width) ** 2)) *
        t.share *
        smoothstep(-0.004, 0.004, h);
      const old =
        0.16 *
        smoke *
        smoothstep(0.22, 0.38, h) *
        Math.exp(-((v.dx / v.width) ** 2)) *
        (0.3 + 1.4 * fbm3(14 * x + 1.3, 10 * y - 2.1)) *
        (1 - smoothstep(0.95, 1, y));
      if (fresh + old < 1e-4) continue;
      const age = Math.max(0, h) / 0.07;
      const k = (j * dw + i) * 4;
      dye[k] = fresh + old;
      dye[k + 1] = 0.6 * Math.exp(-((t.dx / t.width) ** 2)) * t.share * Math.exp(-age * HEAT_FADE);
      dye[k + 2] = fresh * Math.exp(-age * (FRESH_FADE - SMOKE_FADE)) + 0.15 * old;
    }
  }
  fluid.velocity.seed(velocity);
  fluid.dye.seed(dye);
}

/** The force and obstacle snippets' own uniforms (a type literal, so it passes as a uniform record). */
type SnippetUniforms = {
  uBuoyancy: number;
  uAir: Float32Array;
  uGust: Float32Array;
  uSource: Float32Array;
  uStir: Float32Array;
  uCeiling: Float32Array;
  uVent: Float32Array;
  uHolder: Float32Array;
};

/**
 * The entrance's clock: 0..1 over INCENSE_PASSAGE.enter seconds of frame time (which the renderer
 * caps per frame, so a slow first frame delays the entrance instead of using it up). Exactly 1 once
 * arrived, and from the start when the scene was not entered with a passage or has no motion to
 * play it with.
 */
class Arrival {
  #arriving: boolean | undefined = undefined;
  #seconds = 0;
  progress = 1;

  get active(): boolean {
    return this.progress < 1;
  }

  advance(frame: SimFrame): void {
    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1 && frame.motion > 0;
    if (!this.#arriving) return;
    this.#seconds += Math.max(0, frame.dt);
    if (this.#seconds >= INCENSE_PASSAGE.enter) {
      this.#arriving = false;
      this.progress = 1;
      return;
    }
    this.progress = this.#seconds / INCENSE_PASSAGE.enter;
  }
}

class Plume {
  readonly fluid: FluidSim;
  readonly motes: Motes;
  /** The smoke and its velocity as the shader sees them: between their last two steps. */
  readonly #smoke: FieldBetween;
  readonly #flow: FieldBetween;
  /** Seconds of smoke stepped, prewarm included. */
  #clock = 0;
  #seeded = false;
  /** Prewarm steps done so far. */
  #warmed = 0;
  /** Each hand (by principal): whether it was over the page last frame, and where. */
  readonly #handed = new Array<boolean>(MAX_PRINCIPALS).fill(false);
  readonly #handX = new Float64Array(MAX_PRINCIPALS);
  readonly #handY = new Float64Array(MAX_PRINCIPALS);
  /** The entrance's thread: how high its head has been drawn, and the last row of veils (heights above the source). */
  #headH = 0;
  #veilH = VEIL_FROM - VEIL_STEP;
  /** The exit's progress 0..1 (0 unless leaving), and the draught as the force snippet's uGust. */
  #leave = 0;
  readonly #draught = new Float32Array([0, 0, 1, 0]);
  readonly #air = new Float32Array(4);
  readonly #source = new Float32Array(4);
  readonly #stir = new Float32Array(4);
  readonly #ceiling = new Float32Array(4);
  readonly #vent = new Float32Array(4);
  readonly #holder = new Float32Array(2);
  readonly #dye = new Float32Array(4);
  readonly #push = new Float32Array(2);
  readonly #dissipation = [SMOKE_FADE, HEAT_FADE, FRESH_FADE, 0] as const;
  /** Splats and the fluid's step, built once and rewritten in place. */
  readonly #splatDye: SplatImpulse = { dye: this.#dye };
  readonly #splatBackflow: SplatImpulse = { dye: this.#dye, velocity: this.#push };
  readonly #splatHand: SplatImpulse = { velocity: this.#push };
  readonly #uniforms: SnippetUniforms = {
    uBuoyancy: BUOYANCY,
    uAir: this.#air,
    uGust: new Float32Array(4),
    uSource: this.#source,
    uStir: this.#stir,
    uCeiling: this.#ceiling,
    uVent: this.#vent,
    uHolder: this.#holder,
  };
  readonly #fluidStep: FluidStep = {
    dt: 0,
    time: 0,
    vorticity: 0,
    velocityDissipation: VELOCITY_FADE,
    dyeDissipation: this.#dissipation,
    uniforms: this.#uniforms,
  };

  constructor(gpu: GpuCompute) {
    this.fluid = new FluidSim(gpu, {
      velocityResolution: VELOCITY_RES,
      dyeResolution: DYE_RES,
      // Open sides let the drafts through; the floor (the table) and the ceiling are walls.
      boundary: { left: "open", right: "open" },
      force: FORCE_GLSL,
      obstacle: OBSTACLE_GLSL,
    });
    this.motes = new Motes(gpu, this.fluid.aspect, this.fluid.velocity);
    this.#smoke = new FieldBetween(gpu, this.fluid.dye, "incense smoke");
    this.#flow = new FieldBetween(gpu, this.fluid.velocity, "incense flow");
  }

  /**
   * Lay the grids out for the frame; on the first, paint the opening plume in and settle it with
   * PREWARM_STEPS real steps, as many a frame as the budget allows. Returns whether that is done:
   * until it is, the burner, the doors and the live steps hold.
   */
  ready(
    frame: SimFrame,
    burner: Burner,
    doors: Doors,
    settings: Settings,
    arrival: Arrival,
  ): boolean {
    const fluid = this.fluid;
    fluid.resize(frame.width, frame.height);
    const aspect = fluid.aspect;
    if (!this.#seeded) {
      this.#seeded = true;
      if (arrival.active) {
        // An entrance: the room starts empty and the thread is drawn out of the ember as it takes
        // light (#rise), so there is no plume to paint in or settle.
        this.#warmed = PREWARM_STEPS;
      } else {
        // The opening plume: painted in, then PREWARM_STEPS real steps to settle it.
        const source = burner.source();
        seedPlume(fluid, { x: ANCHOR_X * aspect + source.x, y: FLOOR + source.y }, settings.smoke);
      }
    }
    if (this.#warmed < PREWARM_STEPS) {
      // A count of steps, the same on every machine: the budget only spreads them over frames.
      this.#warmed = runBudgeted(
        () => this.#step(PREWARM_DT, burner, doors, settings, aspect),
        Math.max(PREWARM_MS, frame.budget),
        PREWARM_STEPS,
        this.#warmed,
      );
    }
    return this.#warmed >= PREWARM_STEPS;
  }

  /** This frame's hand and passage: the hand's push, the exit's draught or the entrance's thread. */
  feel(frame: SimFrame, burner: Burner, settings: Settings, arrival: Arrival): void {
    const aspect = this.fluid.aspect;
    this.#touch(frame, aspect, settings.hand);
    this.#leave = frame.passage.exit;
    if (this.#leave > 0) this.#blow(aspect);
    else if (arrival.active) this.#rise(arrival.progress, burner, settings, aspect);
  }

  /** One live step; the frame's `last` keeps the fluid as it stood before it, to show between the two. */
  step(burner: Burner, doors: Doors, settings: Settings, last: boolean): void {
    const aspect = this.fluid.aspect;
    if (last) {
      this.#smoke.keep();
      this.#flow.keep();
    }
    this.#step(STEP, burner, doors, settings, aspect);
    if (settings.dust) this.motes.move(STEP, this.#clock, aspect);
  }

  /**
   * The shader's smoke (slot 0), velocity (1) and, while the dust is up, motes (3), `alpha` of the
   * way from the step before last to the last (FixedStep.alpha).
   */
  show(alpha: number, dust: boolean, out: (WebGLTexture | undefined)[]): void {
    out[0] = this.#smoke.show(alpha);
    out[1] = this.#flow.show(alpha);
    if (dust) this.motes.draw(alpha, this.#clock - (1 - alpha) * STEP, this.fluid.aspect);
    out[3] = dust ? this.motes.field.texture : undefined;
  }

  /**
   * The entrance: the thread's head climbs out of the ember to riseHead, drawn into the fluid slice
   * by slice with the dye, heat and lift a thread has at that height (seedPlume's profile), the
   * fresh thread fraying out above its first hand-span, and from VEIL_FROM up, rows of soft patches
   * laid where the veils lie. The fluid carries it from there: it leans, sways, curls and
   * stratifies as ever. The backflow's smoke pours down from its outlet instead, started by the
   * ember's light alone.
   */
  #rise(progress: number, burner: Burner, settings: Settings, aspect: number): void {
    if (burner.kind === "waterfall") return;
    const fluid = this.fluid;
    const source = burner.source();
    const sx = ANCHOR_X * aspect + source.x;
    const sy = FLOOR + source.y;
    const head = riseHead(progress, sy);
    const light = kindle(progress);
    const dye = this.#dye;
    const push = this.#push;
    for (let steps = 0; this.#headH < head && steps < RISE_MAX_STEPS; steps++) {
      const h = Math.min(head, this.#headH + RISE_STEP);
      const ds = h - this.#headH;
      this.#headH = h;
      const y = sy + h;

      // A slice of thread: a Gaussian of half width w, spaced ds apart, adds up to the profile seedPlume paints.
      const w = THREAD_W + THREAD_FLARE * smoothstep(0.1, 0.4, h);
      const share = (1 - smoothstep(0.28, 0.42, h)) * light;
      if (share > 0) {
        const x = sx - 0.03 * h + threadSway(h);
        const slice = (ds / (w * Math.sqrt(Math.PI))) * share;
        const fresh = 0.4 * settings.smoke * (THREAD_W / w) ** 0.7;
        const age = h / 0.07;
        dye[0] = fresh * slice;
        dye[1] = 0.6 * Math.exp(-age * HEAT_FADE) * slice;
        dye[2] = fresh * Math.exp(-age * (FRESH_FADE - SMOKE_FADE)) * slice;
        fluid.splat(x / aspect, y, w, this.#splatDye);
        push[0] = 0;
        push[1] = THREAD_LIFT * (ds / (THREAD_LIFT_W * Math.sqrt(Math.PI))) * share;
        fluid.splat(x / aspect, y, THREAD_LIFT_W, this.#splatHand);
      }

      // A row of veil patches across the veils' breadth (seedPlume's `old`): each Gaussian of radius
      // half the veil's half width, 1.1 radii apart across, a row apart up.
      if (h >= VEIL_FROM && h - this.#veilH >= VEIL_STEP) {
        const rows = h - this.#veilH;
        this.#veilH = h;
        const width = 0.03 + 0.1 * smoothstep(0.25, 0.6, h);
        const centre =
          sx - 0.02 + 0.12 * smoothstep(0.35, 0.65, h) + 0.08 * (fbm3(3 * sx + 5.1, 4 * y) - 0.5);
        const radius = 0.5 * width;
        const grow =
          0.16 * settings.smoke * smoothstep(0.22, 0.38, h) * (1 - smoothstep(0.95, 1, y));
        const patch = (rows * 1.1) / (Math.PI * radius);
        for (let i = 0; i < VEIL_BLOBS; i++) {
          const t = (2 * i) / (VEIL_BLOBS - 1) - 1;
          const x = centre + 1.1 * width * t;
          const amount =
            grow *
            Math.exp(-((1.1 * t) ** 2)) *
            (0.3 + 1.4 * fbm3(14 * x + 1.3, 10 * y - 2.1)) *
            patch;
          dye[0] = amount;
          dye[1] = 0;
          dye[2] = 0.15 * amount;
          fluid.splat(x / aspect, y, radius, this.#splatDye);
        }
      }
    }
  }

  /**
   * The exit: a draught from the left, its front crossing the room within DRAUGHT_SWEEP of the exit
   * and its wind gathering all the way through it, so the smoke is still being carried off as the
   * exit ends. It takes the force snippet's uGust (a door's draft's place), so the same wind bends
   * the candle's flame and fans the ember.
   */
  #blow(aspect: number): void {
    const leave = this.#leave;
    const strength = leave * leave;
    const draught = this.#draught;
    draught[0] = DRAUGHT_SPEED * strength;
    draught[1] = -FRONT_SOFT + (aspect + 2 * FRONT_SOFT) * clamp(leave / DRAUGHT_SWEEP, 0, 1);
    draught[2] = 1;
    draught[3] = DRAUGHT_RATE * Math.min(1, 3 * strength);
  }

  /**
   * Every hand moving through the air pushes it along: a share of its speed, up to HAND_MAX, given
   * to the air for each step's worth of time this frame holds, so a sweep of the hand pushes as hard
   * at any frame rate.
   */
  #touch(frame: SimFrame, aspect: number, on: boolean): void {
    const dt = frame.dt * frame.motion;
    for (let p = 0; p < MAX_PRINCIPALS; p++) {
      const hand = frame.principals[p];
      const hadHand = this.#handed[p] === true;
      const lastX = this.#handX[p] ?? 0;
      const lastY = this.#handY[p] ?? 0;
      this.#handed[p] = hand?.inside === true;
      if (hand === undefined) continue;
      this.#handX[p] = hand.x;
      this.#handY[p] = hand.y;
      if (!on || !hadHand || !hand.inside || dt <= 0 || frame.dt <= 0) continue;
      let vx = ((hand.x - lastX) * aspect) / frame.dt;
      let vy = (hand.y - lastY) / frame.dt;
      const speed = Math.hypot(vx, vy);
      if (speed < 0.01) continue;
      const scale = Math.min(HAND_GAIN, HAND_MAX / speed) * (dt / STEP);
      vx *= scale;
      vy *= scale;
      this.#push[0] = vx;
      this.#push[1] = vy;
      this.fluid.splat(
        hand.x,
        hand.y,
        hand.down ? 1.4 * HAND_RADIUS : HAND_RADIUS,
        this.#splatHand,
      );
    }
  }

  #step(dt: number, burner: Burner, doors: Doors, settings: Settings, aspect: number): void {
    const fluid = this.fluid;
    const anchor = ANCHOR_X * aspect;
    const source = burner.source();
    const sx = anchor + source.x;
    const sy = FLOOR + source.y;
    // Leaving, the draught cuts the ember's smoke off: the thread is not fed past its first moments.
    const glow =
      this.#leave > 0 ? burner.glow * (1 - smoothstep(0, DRAUGHT_BREAK, this.#leave)) : burner.glow;

    if (glow > 0) {
      const smoke = EMIT_SMOKE * settings.smoke * glow * dt;
      const heat = EMIT_HEAT * glow * dt;
      const dye = this.#dye;
      if (burner.kind === "waterfall") {
        // Cold, heavy smoke out of the outlet, nudged out over the ledge; a faint warm wisp rises
        // from the cone's tip.
        dye[0] = BACKFLOW_SMOKE * smoke;
        dye[1] = -BACKFLOW_COLD * glow * dt;
        // Cooled on its way down through the cone, its particles grown: whiter than a rising thread.
        dye[2] = 0.3 * dye[0];
        this.#push[0] = BACKFLOW_PUSH * glow * dt;
        this.#push[1] = 0;
        fluid.splat(
          (anchor + OUTLET_X) / aspect,
          FLOOR + OUTLET_Y,
          BACKFLOW_RADIUS,
          this.#splatBackflow,
        );
        dye[0] = WISP_SMOKE * smoke;
        dye[1] = WISP_HEAT * heat;
        dye[2] = dye[0];
      } else {
        dye[0] = smoke;
        dye[1] = heat;
        dye[2] = smoke;
      }
      fluid.splat(sx / aspect, sy, EMIT_RADIUS, this.#splatDye);
    }
    if (settings.candle) {
      const dye = this.#dye;
      dye[0] = 0;
      dye[1] = CANDLE_HEAT * dt;
      dye[2] = 0;
      fluid.splat(
        (anchor + CANDLE_DX) / aspect,
        FLOOR + CANDLE_Y + CANDLE_H + FLAME_BASE + 0.6 * FLAME_H,
        0.007,
        this.#splatDye,
      );
    }

    // The room's draft: a slow sway, sheared with height (see FORCE_GLSL).
    const t = this.#clock;
    const draft = AIR_SPEED * settings.draft;
    const air = this.#air;
    air[0] = draft * (0.6 * Math.sin(0.21 * t + 1) + 0.25 * Math.sin(0.083 * t + 2));
    air[1] = 0.4 * draft;
    air[2] = 0.13 * t + 2.3;
    air[3] = AIR_RATE;
    doors.update(dt, settings.doors, aspect);
    const turbulence = settings.turbulence;
    const span = LAMINAR_SPAN * (1.3 - 0.6 * turbulence);
    const src = this.#source;
    src[0] = sx;
    src[1] = sy;
    src[2] = span;
    src[3] = LAMINAR_RATE;
    const stir = this.#stir;
    stir[0] = STIR * turbulence;
    stir[1] = 0.75 * span;
    stir[2] = 0.1;
    stir[3] = 4;
    const ceiling = this.#ceiling;
    ceiling[0] = CEILING_DRIFT * settings.draft;
    ceiling[1] = CEILING_FROM;
    ceiling[2] = STRATIFY;
    ceiling[3] = STRATIFY_FROM;
    const vent = this.#vent;
    vent[0] = VENT_SPEED * settings.vent;
    vent[1] = VENT_FROM;
    vent[2] = VENT_RATE;
    const holder = this.#holder;
    holder[0] = incenseKinds.indexOf(burner.kind);
    holder[1] = settings.candle ? 1 : 0;

    const uniforms = this.#uniforms;
    uniforms.uGust = this.#leave > 0 ? this.#draught : doors.uniform;
    const step = this.#fluidStep;
    step.dt = dt;
    step.time = t;
    step.vorticity = VORTICITY * turbulence;
    fluid.step(step);
    this.#clock += dt;
  }
}

// ---- the simulation ----------------------------------------------------------------------------

/** The incense, for a scene whose `params` carry the knobs IncenseKnob names. */
function incenseSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): SceneSim {
  const knobs = new KnobReader<IncenseKnob>("incense", params, [
    "stick",
    "smoke",
    "renew",
    "draft",
    "turbulence",
    "vent",
    "door",
    "hand",
    "candle",
    "dust",
  ]);
  const renewSlot = knobs.trigger("renew");
  const doorSlot = knobs.trigger("door");
  const state = new DataTexture(gl, {
    width: 3,
    height: 1,
    format: "rgba16f",
    filter: "nearest",
  });
  const stateData = new Float32Array(12);
  const doors = new Doors();
  const arrival = new Arrival();
  const settings: Settings = {
    kind: "stick",
    smoke: 0,
    renew: false,
    draft: 0,
    turbulence: 0,
    vent: 0,
    doors: 0,
    hand: false,
    candle: false,
    dust: false,
  };
  const textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined, undefined];
  const clock = new FixedStep(STEP, MAX_STEPS);
  let burner: Burner | undefined;

  /** Entering, the ember takes light first: the stick stands in the dish, unlit. */
  const kindled = (lit: Burner): void => {
    if (arrival.active) lit.glow = Math.min(lit.glow, kindle(arrival.progress));
  };

  const gpu = GpuCompute.create(gl);
  let plume: Plume | undefined;
  if (gpu) {
    try {
      plume = new Plume(gpu);
    } catch (error: unknown) {
      if (!(error instanceof GpuError)) throw error;
      // No smoke simulation here: the shader paints its analytic plume instead.
      console.error("evt=landing.incense.fluid_unavailable", error);
      gpu.dispose();
    }
  }

  return {
    frame(frame) {
      readSettings(settings, frame, knobs);
      arrival.advance(frame);
      if (!burner) burner = new Burner(settings.kind);
      else if (burner.kind !== settings.kind) burner.replace(settings.kind);
      if (frame.fired[renewSlot] === true) burner.renew();
      if (frame.fired[doorSlot] === true) doors.open();

      // While the opening plume warms up over several frames, the burner, the doors and the
      // clock hold still with it.
      if (!plume || plume.ready(frame, burner, doors, settings, arrival)) {
        plume?.feel(frame, burner, settings, arrival);
        const steps = clock.advance(Math.max(0, frame.dt) * frame.motion);
        for (let i = 0; i < steps; i++) {
          burner.step(STEP, settings.renew);
          kindled(burner);
          plume?.step(burner, doors, settings, i === steps - 1);
        }
      }
      kindled(burner);

      const alpha = clock.alpha;
      burner.write(stateData, (1 - alpha) * STEP);
      state.upload(stateData);
      // Without a plume (no float targets) slots 0, 1 and 3 stay empty: the analytic plume.
      plume?.show(alpha, settings.dust, textures);
      textures[2] = state.texture;
      return textures;
    },
    dispose() {
      state.dispose();
      gpu?.dispose();
    },
  };
}

/**
 * The incense layer's sim (README "The interior composer"): the fluid, the burner, the doors and
 * the motes, its four textures to its fields (incenseField0..3).
 */
export function incenseLayerSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  const sim = incenseSim(gl, params);
  return {
    frame(frame: LayerFrame) {
      const textures = sim.frame(frame);
      frame.fields.forEach((field, k) => {
        field.texture = textures[k];
      });
    },
    dispose() {
      sim.dispose();
    },
  };
}
