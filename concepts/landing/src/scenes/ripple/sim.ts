// The ripple tank's water, stepped on the GPU (sims/gpu.ts): the damped wave equation on a grid
// over the whole frame, driven by the experiment's dippers (layout.ts), walled by its barriers,
// slowed over its lens plate and soaked up at the tank's edges by sponges.
//
// uSim0  the shown tank's view, rgba16f at grid size (linear), frame uv: x the surface height, y the
//        Jacobian of the light's path through it to the screen (1 flat; under 1 the light is focused,
//        brighter), zw the surface slope, 1 at a unit wave's steepest
// uSim1  the same for the tank fading in during a change of experiment (stale otherwise)
// uSim2  the layout, rgba32f 16×2 (nearest): row 0 the shown tank, row 1 the one fading in; texels
//        as RIPPLE_TEXELS, lengths in short sides
//
// The model. Height u on a grid with a short side of N texels, N set so a wavelength spans about
// PER_WAVE texels; leapfrog in time (state rgba32f: u now, u a step ago, wall or box damping, wave
// speed over open water) with the isotropic 9-point Laplacian (Patra & Karttunen), stable to a
// Courant number of 0.87 and kept under COURANT. Walls reflect (a wall texel reads as its
// neighbour's own height: no flow through it); the lens plate's shallow water carries waves at 0.62
// of the speed, so its waves are shorter and bend; damping is a drag on the surface's speed. Dippers
// push a small Gaussian of the surface up and down at the drive frequency; the bar and the M push
// along a line. Their pushes are scaled so a dipper's ring is 1 high a wavelength out and the bar's
// plane waves are their `amp` high (calibrated against the 2D and 1D Green's functions).
//
// Pace. Real ripple tanks are watched under a strobe that slows the waves to a crawl; here the
// dippers beat at a quarter hertz and the waves crawl at 0.028 short sides a second, so the screen
// moves slowly enough for the dither. The sim steps at STEP scene seconds (shorter if the Courant
// number would pass COURANT) and the view interpolates between the last two steps, so the picture
// moves smoothly at any frame rate.
//
// Experiments. A fresh tank is seeded with the experiment's steady state worked out in closed form
// (rings from each dipper, the bar's plane waves and their reflection off the barrier, the slits as
// new sources, the lens's delay, the moving dipper's retarded rings, the M as a row of sources), then
// stepped PREWARM times, so the first frame looks finished. A scheduled change seeds the next tank
// PREP seconds early and runs it PREP_RATE times faster, so it has settled for real by the time it
// crossfades in over FADE seconds.
import type { ParamDef } from "../../params.ts";
import { GpuCompute, gridSize, type Pass, type PingPong, type RenderTarget } from "../../sims/gpu.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";
import {
  MARK,
  RIPPLE_DIPPER,
  RIPPLE_EXPERIMENTS,
  RIPPLE_FREQUENCY,
  RIPPLE_M,
  RIPPLE_SPEED,
  TWO,
  rippleLayout,
  tankFrame,
  trackAt,
  type Experiment,
  type Layout,
  type Point,
  type TankFrame,
} from "./layout.ts";

/** Texels of a layout row (uSim2). */
export const RIPPLE_TEXELS = {
  /** weight (row 1: how far faded in), experiment, contrast, wavelength */
  meta: 0,
  /** four dippers: x, y, radius, presence */
  dippers: 1,
  /** the beam over the water: ends */
  beam: 5,
  /** the plane-wave bar: ends */
  bar: 6,
  /** four walls: ends */
  walls: 7,
  /** the walls' half-widths (0: none) */
  halves: 11,
  /** the lens: centre, half aperture, half thickness (0: none) */
  lens: 12,
  /** the lens: axis, speed ratio, 0 */
  axis: 13,
  /** the M: centre, height, presence */
  mark: 14,
  /** beam present, bar present, 0, 0 */
  flags: 15,
} as const;
export const RIPPLE_LAYOUT_WIDTH = 16;

/** How hard the screen focuses the light (D k² for a unit wave) at the focus knob's ends, × the experiment's contrast. */
export const RIPPLE_FOCUS = [0.35, 1.25] as const;

/** Sim step (scene seconds) and the Courant number it may not pass. */
const STEP = 0.05;
const COURANT = 0.6;
/** Grid texels per wavelength wanted; bounds and rounding of the grid's short side. */
const PER_WAVE = 34;
const GRID_MIN = 224;
const GRID_MAX = 384;
const GRID_ROUND = 16;
/** Width of a dipper's push, and of the bar's and the M's (short sides). */
const SIGMA = 0.009;
/** Open-water damping rate (1/s) at the damping knob's 1; it grows as the knob's 1.5th power. */
const DAMP_MAX = 0.22;
/** Sponges: width in wavelengths, bounded (short sides), and their damping rate at the very edge (1/s). */
const SPONGE_WAVES = 1.2;
const SPONGE_WIDTH = [0.12, 0.24] as const;
const SPONGE_RATE = 6;
/** Damping rate inside the standing-wave box (1/s): it rings, but settles within a few seconds. */
const BOX_DAMP = 0.08;
/** The lens plate's edge: a slope this wide (short sides), so it bends the waves without echoing them. */
const LENS_EDGE = 0.012;
/** Steps a fresh tank takes before it is shown. */
const PREWARM = 100;
/** Seconds before a scheduled change the next tank is seeded; how much faster it runs; crossfade. */
const PREP = 30;
const PREP_RATE = 3;
const FADE = 6;
/** Seconds an experiment holds at the slow and the quick end of the pace knob. */
const HOLD = [150, 40] as const;
/** Most steps a frame takes for the shown tank and for one being prepared. */
const MAX_STEPS = 4;
const MAX_PREP_STEPS = 10;
/** A pebble from a tap and a drip from the faucet: height, radius in wavelengths. */
const PEBBLE = { height: -3, radius: 0.3 } as const;
const DRIP = { height: -1.8, radius: 0.22 } as const;
/** Seconds between drips at the rare and the frequent end of the knob; before the first. */
const DRIP_INTERVAL = [140, 25] as const;
const DRIP_FIRST = 12;
/** A finger dragged through open water beats like a dipper this strong. */
const FINGER = 0.8;
/** How near (short sides) a press must be to a dipper to pick it up; how far to drag to dip a finger. */
const GRAB = 0.05;
const DIP = 0.02;
/** The Doppler dipper, let go, eases back onto its track over these seconds. */
const TRACK_RETURN = 2.5;
const MAX_PEBBLES = 4;
/** Dipper slots in the step pass; the last is the finger's. */
const DIPPERS = 4;
/** Point and plane emitters the seed pass sums. */
const SEED_POINTS = 6;
const SEED_PLANES = 2;
/** Samples along the M for its seed. */
const SEED_MARK = 32;
/** A slit's ring for the seed, × the bar's wave reaching it × slit width / wavelength (fitted against the sim). */
const SLIT_RING = 0.7;
/** The row of dippers standing in for the lens plate's far side in the seed: its reach across the tank (short sides), dippers in it, and their complex gain (fitted against the sim). */
const EXIT_SPAN = 1.2;
const SEED_EXIT = 64;
const LENS_RING = { re: 0.55 * Math.cos(0.65), im: 0.55 * Math.sin(0.65) } as const;

const glsl = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const TAU = Math.PI * 2;

/** The M's vertices as GLSL constants. */
const MARK_GLSL = RIPPLE_M.map(([x, y], i) => `const vec2 RIPPLE_M${i} = vec2(${x.toFixed(2)}, ${y.toFixed(2)});`).join("\n");

/**
 * How far inside the lens plate p lies (short sides; negative outside): the lesser of the depth
 * along its axis to the nearer face and the distance in from its aperture's edge. lens = centre,
 * half aperture, half thickness; axis a unit vector. The faces are circular arcs meeting at the
 * aperture's edges. Shared with the scene shader.
 */
export const RIPPLE_LENS_GLSL = `
float rippleLensDepth(vec2 p, vec4 lens, vec2 axis) {
  vec2 d = p - lens.xy;
  float s = dot(d, axis);
  float q = dot(d, vec2(-axis.y, axis.x));
  float R = (lens.z * lens.z + lens.w * lens.w) / (2.0 * lens.w);
  float sag = lens.w - R + sqrt(max(R * R - q * q, 0.0));
  return min(sag - abs(s), lens.z - abs(q));
}
`;

/** Helpers every pass shares. */
const PASS_COMMON = `
${MARK_GLSL}
float rippleSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0));
}
// Distance to the M's strokes, in mark units.
float rippleMark(vec2 q) {
  return min(min(rippleSegment(q, RIPPLE_M0, RIPPLE_M1), rippleSegment(q, RIPPLE_M1, RIPPLE_M2)),
             min(rippleSegment(q, RIPPLE_M2, RIPPLE_M3), rippleSegment(q, RIPPLE_M3, RIPPLE_M4)));
}
${RIPPLE_LENS_GLSL}
`;

/** One leapfrog step of the damped wave equation: rgba = (u, u a step ago, wall 1 or box damping, speed ratio). */
const STEP_PASS = `
uniform sampler2D uState;
uniform vec2 uFrame;        // frame size, short sides
uniform float uC2;          // Courant number squared over open water
uniform float uDamp;        // open-water damping per step
uniform vec2 uSponge;       // the sponges' width (short sides), their damping per step at the very edge
uniform float uPrevScale;   // 1, or new step / old step on the first step after the step changed
uniform float uPhase;       // the drive's phase at the new step
uniform float uSigma;       // width of a push, short sides
uniform vec4 uDippers[${DIPPERS}]; // x, y (short sides), push per step (0: none), phase offset
uniform vec4 uBar;          // the bar's ends
uniform float uBarPush;     // per step (0: none)
uniform vec4 uMark;         // the M's centre, height (short sides), push per step (0: none)
${PASS_COMMON}
// A neighbour's height; a wall reads as the texel's own, so nothing flows through it.
float rippleTap(ivec2 q, float here) {
  vec4 s = texelFetch(uState, clamp(q, ivec2(0), ivec2(uSize) - 1), 0);
  return s.z > 0.75 ? here : s.x;
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uState, ij, 0);
  if (c.z > 0.75) {
    fragColor = vec4(0.0, 0.0, c.zw);
    return;
  }
  float u = c.x;
  float side = rippleTap(ij + ivec2(1, 0), u) + rippleTap(ij - ivec2(1, 0), u)
             + rippleTap(ij + ivec2(0, 1), u) + rippleTap(ij - ivec2(0, 1), u);
  float corner = rippleTap(ij + ivec2(1, 1), u) + rippleTap(ij + ivec2(-1, 1), u)
               + rippleTap(ij + ivec2(1, -1), u) + rippleTap(ij - ivec2(1, 1), u);
  float lap = (4.0 * side + corner - 20.0 * u) / 6.0;
  vec2 p = vUv * uFrame;
  vec2 e = min(p, uFrame - p);
  float sponge = max(1.0 - min(e.x, e.y) / uSponge.x, 0.0);
  float damp = min(uDamp + c.z + uSponge.y * sponge * sponge, 0.9);
  float s2 = uSigma * uSigma;
  float push = 0.0;
  for (int i = 0; i < ${DIPPERS}; i++) {
    vec4 d = uDippers[i];
    if (d.z == 0.0) continue;
    vec2 q = p - d.xy;
    push += d.z * exp(-dot(q, q) / s2) * sin(uPhase + d.w);
  }
  if (uBarPush != 0.0) {
    float d = rippleSegment(p, uBar.xy, uBar.zw);
    push += uBarPush * exp(-d * d / s2) * sin(uPhase);
  }
  if (uMark.w != 0.0) {
    float d = rippleMark((p - uMark.xy) / uMark.z) * uMark.z;
    push += uMark.w * exp(-d * d / s2) * sin(uPhase);
  }
  float prev = u - (u - c.y) * uPrevScale;
  float next = u + (u - prev) * (1.0 - damp) + uC2 * c.w * c.w * lap + push;
  fragColor = vec4(next, u, c.z, c.w);
}
`;

/** The experiment's fixtures into the state: walls (z = 1, the water in them stilled), the box's damping, the lens's speed. */
const MEDIA_PASS = `
uniform sampler2D uState;
uniform vec2 uFrame;
uniform vec4 uWalls[4];     // ends, short sides
uniform vec4 uWallHalf;     // half-widths (0: none)
uniform vec4 uLens;         // centre, half aperture, half thickness (0: none)
uniform vec4 uLensAxis;     // axis, speed ratio over the plate, half-width of its edge's slope
uniform vec4 uBox;          // inner corners; x1 <= x0: no box
uniform float uBoxDamp;     // per step inside it
${PASS_COMMON}
void main() {
  vec4 c = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  vec2 p = vUv * uFrame;
  bool wall = false;
  for (int i = 0; i < 4; i++) {
    if (uWallHalf[i] > 0.0 && rippleSegment(p, uWalls[i].xy, uWalls[i].zw) < uWallHalf[i]) wall = true;
  }
  if (wall) {
    fragColor = vec4(0.0, 0.0, 1.0, 1.0);
    return;
  }
  float speed = 1.0;
  if (uLens.z > 0.0) {
    speed = mix(1.0, uLensAxis.z, smoothstep(-uLensAxis.w, uLensAxis.w, rippleLensDepth(p, uLens, uLensAxis.xy)));
  }
  bool box = uBox.z > uBox.x && all(greaterThan(p, uBox.xy)) && all(lessThan(p, uBox.zw));
  fragColor = vec4(c.xy, box ? uBoxDamp : 0.0, speed);
}
`;

/** Pebbles and drips: a dimple (a Mexican hat, so no water is added) pressed into the surface at rest. */
const TOUCH_PASS = `
uniform sampler2D uState;
uniform vec2 uFrame;
uniform vec4 uPebbles[${MAX_PEBBLES}]; // centre, radius (short sides), height (0: none)
void main() {
  vec4 c = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  if (c.z > 0.75) {
    fragColor = c;
    return;
  }
  vec2 p = vUv * uFrame;
  float dh = 0.0;
  for (int i = 0; i < ${MAX_PEBBLES}; i++) {
    vec4 b = uPebbles[i];
    if (b.w == 0.0) continue;
    vec2 q = (p - b.xy) / b.z;
    float r2 = dot(q, q);
    dh += b.w * (1.0 - r2) * exp(-r2);
  }
  fragColor = vec4(c.x + dh, c.y + dh, c.zw);
}
`;

/**
 * What the scene samples: the height between the last two steps, the Jacobian of the light's
 * path to the screen (det(I + D H), H the height's Hessian, D the screen's distance; over the lens
 * D shrinks with the square of the speed, so its shorter waves focus no harder), and the slope.
 */
const VIEW_PASS = `
uniform sampler2D uState;
uniform float uFrac;    // how far the frame is past the step before last, 0..1 of a step
uniform float uFocus;   // the screen's distance, texels squared
uniform float uSlope;   // 1 / wavenumber per texel: a unit wave's steepest slope reads 1
float rippleH(ivec2 q, float here) {
  vec4 s = texelFetch(uState, clamp(q, ivec2(0), ivec2(uSize) - 1), 0);
  return s.z > 0.75 ? here : mix(s.y, s.x, uFrac);
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uState, ij, 0);
  if (c.z > 0.75) {
    fragColor = vec4(0.0, 1.0, 0.0, 0.0);
    return;
  }
  float h = mix(c.y, c.x, uFrac);
  float e = rippleH(ij + ivec2(1, 0), h);
  float w = rippleH(ij - ivec2(1, 0), h);
  float n = rippleH(ij + ivec2(0, 1), h);
  float s = rippleH(ij - ivec2(0, 1), h);
  float ne = rippleH(ij + ivec2(1, 1), h);
  float nw = rippleH(ij + ivec2(-1, 1), h);
  float se = rippleH(ij + ivec2(1, -1), h);
  float sw = rippleH(ij - ivec2(1, 1), h);
  float D = uFocus * c.w * c.w;
  float hxx = e + w - 2.0 * h;
  float hyy = n + s - 2.0 * h;
  float hxy = 0.25 * (ne - nw - se + sw);
  float J = (1.0 + D * hxx) * (1.0 + D * hyy) - D * D * hxy * hxy;
  fragColor = vec4(h, J, 0.5 * uSlope * c.w * vec2(e - w, n - s));
}
`;

/**
 * A fresh tank's water: the experiment's steady state in closed form, as (u now, u a step ago).
 * Every source adds a complex amplitude z (height, phase) whose wave is |z| sin(phase now + arg z):
 * a dipper's ring falls off as the root of the distance and lags its push by an eighth of a turn,
 * a line's plane wave by a quarter; a slit is a dipper fed by the wave reaching it (Kirchhoff).
 */
const SEED_PASS = `
uniform vec2 uFrame;
uniform float uK;            // wavenumber, radians per short side
uniform float uLambda;       // wavelength, short sides
uniform float uPhase;        // the drive's phase now
uniform float uPhaseStep;    // ... and its advance per step
uniform float uAtten;        // open-water damping's fall-off per short side travelled
uniform vec4 uPoints[${SEED_POINTS}];     // x, y, height a wavelength out (0: none), phase
uniform vec4 uPointSide[${SEED_POINTS}];  // unit normal, offset: only where dot(n, p) >= offset
uniform vec4 uPlanes[${SEED_PLANES}];     // a point on the bar, its unit normal
uniform vec4 uPlaneDrive[${SEED_PLANES}]; // height (0: none), phase, stop: only where dot(n, p) <= stop
uniform vec4 uLens;          // the lens plate (as the media pass); delays the planes' forward waves
uniform vec4 uLensAxis;
uniform vec4 uMoving;        // the moving dipper's position and velocity (short sides, per second)
uniform vec2 uMovingDrive;   // its height (0: none), the waves' speed
uniform vec4 uMark;          // the M's centre, height, line height (0: none)
uniform vec4 uBox;           // only inside the box (x1 <= x0: everywhere)
${PASS_COMMON}
vec2 rippleRing(float amp, float r, float phase) {
  float a = amp * sqrt(uLambda / max(r, 0.25 * uLambda)) * exp(-uAtten * r);
  float arg = phase - uK * r - 0.785398;
  return a * vec2(cos(arg), sin(arg));
}
void main() {
  vec2 p = vUv * uFrame;
  vec2 z = vec2(0.0);
  for (int i = 0; i < ${SEED_POINTS}; i++) {
    vec4 s = uPoints[i];
    if (s.z == 0.0 || dot(uPointSide[i].xy, p) < uPointSide[i].z) continue;
    z += rippleRing(s.z, distance(p, s.xy), s.w);
  }
  // Past the lens plate the wave is worked out from the plate's far side (Huygens): a row of
  // dippers across the tank there, each fed by the wave leaving the plate, behind by the slow
  // water it crossed. The row's height and lead are fitted against the sim (a thick plate).
  bool beyond = false;
  if (uLens.z > 0.0) {
    vec4 bar = uPlanes[0];
    float from = dot(bar.xy, bar.zw);
    float exitAt = dot(uLens.xy, bar.zw) + uLens.w + uLensAxis.w;
    if (dot(p, bar.zw) > exitAt) {
      beyond = true;
      vec2 tangent = vec2(-bar.w, bar.z);
      vec2 foot = uLens.xy + (exitAt - dot(uLens.xy, bar.zw)) * bar.zw;
      float R = (uLens.z * uLens.z + uLens.w * uLens.w) / (2.0 * uLens.w);
      float ds = ${glsl(EXIT_SPAN)} / float(${SEED_EXIT});
      float amp = uPlaneDrive[0].x * exp(-uAtten * (exitAt - from)) * ds / uLambda;
      vec2 row = vec2(0.0);
      for (int j = 0; j < ${SEED_EXIT}; j++) {
        float q = (float(j) + 0.5) * ds - ${glsl(EXIT_SPAN / 2)};
        float sag = uLens.w - R + sqrt(max(R * R - q * q, 0.0));
        float lag = abs(q) < uLens.z ? (1.0 / uLensAxis.z - 1.0) * uK * 2.0 * sag : 0.0;
        row += rippleRing(amp, distance(p, foot + q * tangent), -uK * (exitAt - from) - lag);
      }
      z += vec2(${glsl(LENS_RING.re)} * row.x - ${glsl(LENS_RING.im)} * row.y, ${glsl(LENS_RING.re)} * row.y + ${glsl(LENS_RING.im)} * row.x);
    }
  }
  for (int i = 0; i < ${SEED_PLANES}; i++) {
    vec4 b = uPlanes[i];
    vec4 drive = uPlaneDrive[i];
    if (beyond || drive.x == 0.0 || dot(b.zw, p) > drive.z) continue;
    float d = dot(p - b.xy, b.zw);
    float arg = drive.y - uK * abs(d) - 1.570796;
    if (uLens.z > 0.0 && d > 0.0) {
      // Over the plate the wave falls behind by the extra wavelengths in the slow water it crossed.
      vec2 q = p - uLens.xy;
      float along = dot(q, uLensAxis.xy);
      float across = dot(q, vec2(-uLensAxis.y, uLensAxis.x));
      if (abs(across) < uLens.z) {
        float R = (uLens.z * uLens.z + uLens.w * uLens.w) / (2.0 * uLens.w);
        float sag = uLens.w - R + sqrt(max(R * R - across * across, 0.0));
        arg -= (1.0 / uLensAxis.z - 1.0) * uK * clamp(along + sag, 0.0, 2.0 * sag);
      }
    }
    z += drive.x * exp(-uAtten * abs(d)) * vec2(cos(arg), sin(arg));
  }
  if (uMovingDrive.x != 0.0) {
    // The ring passing p left the dipper tau seconds ago (tau < 0), when it was at x + v tau.
    vec2 d = p - uMoving.xy;
    vec2 v = uMoving.zw;
    float c = uMovingDrive.y;
    float a = c * c - dot(v, v);
    float dv = dot(d, v);
    float tau = (-dv - sqrt(dv * dv + a * dot(d, d))) / a;
    // The ring's phase is the drive's when it left: behind the dipper's now by the retarded distance.
    z += rippleRing(uMovingDrive.x, -c * tau, 0.0);
  }
  if (uMark.w != 0.0) {
    // A row of dippers along the strokes, each worth its share of the line: height x step / wavelength.
    float stroke = 0.0;
    vec2 m[5] = vec2[5](RIPPLE_M0, RIPPLE_M1, RIPPLE_M2, RIPPLE_M3, RIPPLE_M4);
    for (int i = 0; i < 4; i++) stroke += distance(m[i], m[i + 1]);
    float ds = stroke / float(${SEED_MARK});
    float amp = uMark.w * ds * uMark.z / uLambda;
    for (int j = 0; j < ${SEED_MARK}; j++) {
      float at = (float(j) + 0.5) * ds;
      vec2 q = m[0];
      for (int i = 0; i < 4; i++) {
        float len = distance(m[i], m[i + 1]);
        if (at <= len) {
          q = mix(m[i], m[i + 1], at / len);
          break;
        }
        at -= len;
      }
      z += rippleRing(amp, distance(p, uMark.xy + q * uMark.z), 0.0);
    }
  }
  if (uBox.z > uBox.x && (any(lessThan(p, uBox.xy)) || any(greaterThan(p, uBox.zw)))) z = vec2(0.0);
  float now = z.x * sin(uPhase) + z.y * cos(uPhase);
  float before = z.x * sin(uPhase - uPhaseStep) + z.y * cos(uPhase - uPhaseStep);
  fragColor = vec4(now, before, 0.0, 1.0);
}
`;

interface Slots {
  experiment: number;
  pace: number;
  frequency: number;
  speed: number;
  damping: number;
  drips: number;
  focus: number;
  mark: number;
}

/** The water's physics for this frame's knobs and frame. */
interface Physics {
  frame: TankFrame;
  /** Wave speed (short sides per second), drive frequency (radians per second), wavelength (short sides). */
  speed: number;
  omega: number;
  lambda: number;
  /** Grid short side, the step (seconds), the Courant number over open water. */
  n: number;
  step: number;
  courant: number;
  /** Open-water damping rate (1/s). */
  damp: number;
  /** The M's size knob (its middle while the M is off but called up by 'now'). */
  markSize: number;
}

/** One tank of water: its grid, view and experiment. */
class Tank {
  readonly state: PingPong;
  readonly view: RenderTarget;
  experiment: Experiment = TWO;
  layout: Layout | undefined;
  layoutKey = "";
  /** Seconds since its experiment started (negative while it is being prepared), and the drive's phase. */
  time = 0;
  phase = 0;
  /** Steps owed: after stepping, how far into the next step the frame is. */
  pending = 0;
  /** Scale for the step's previous height on the next step (the step's length changed). */
  prevScale = 1;
  /** Where the dragged dippers (0..3) and the M (4) have been moved from their places, short sides. */
  readonly offsets: (Point | undefined)[] = [undefined, undefined, undefined, undefined, undefined];

  constructor(gpu: GpuCompute, width: number, height: number) {
    this.state = gpu.pingPong({ width, height, format: "rgba32f", filter: "nearest" });
    this.view = gpu.target({ width, height, format: "rgba16f" });
  }
}

/** Mulberry32: a small, fast, seedable PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (range: readonly [number, number], t: number): number => range[0] + (range[1] - range[0]) * t;

/** The tank's water and its experiments on the GPU. */
class RippleLab implements SceneSim {
  readonly #gpu: GpuCompute;
  readonly #at: Slots;
  readonly #defaults: readonly number[];
  readonly #step: Pass;
  readonly #media: Pass;
  readonly #touch: Pass;
  readonly #shade: Pass;
  readonly #seed: Pass;
  readonly #layoutTarget: RenderTarget;
  readonly #layoutData = new Float32Array(RIPPLE_LAYOUT_WIDTH * 2 * 4);
  readonly #layoutShown = new Float32Array(RIPPLE_LAYOUT_WIDTH * 2 * 4);
  // Uniform values, reused frame to frame.
  readonly #dippers = new Float32Array(DIPPERS * 4);
  readonly #bar = new Float32Array(4);
  readonly #mark = new Float32Array(4);
  readonly #pebbles = new Float32Array(MAX_PEBBLES * 4);
  readonly #walls = new Float32Array(16);
  readonly #halves = new Float32Array(4);
  readonly #lens = new Float32Array(4);
  readonly #axis = new Float32Array(4);
  readonly #box = new Float32Array(4);
  readonly #points = new Float32Array(SEED_POINTS * 4);
  readonly #sides = new Float32Array(SEED_POINTS * 4);
  readonly #planes = new Float32Array(SEED_PLANES * 4);
  readonly #drives = new Float32Array(SEED_PLANES * 4);
  readonly #moving = new Float32Array(4);
  readonly #movingDrive = new Float32Array(2);
  readonly #frameSize = new Float32Array(2);
  readonly #sponge = new Float32Array(2);

  /** The tank on show and the one being prepared or faded in. */
  #tanks: [Tank, Tank] | undefined;
  #physics: Physics | undefined;
  /** Seconds the shown experiment still holds. */
  #hold = 0;
  /** The coming tank is being run ahead for a scheduled change. */
  #preparing = false;
  /** 0..1 while the coming tank fades in. */
  #fade: number | undefined;
  #pebbleCount = 0;
  #random = mulberry32(0x5eed);
  #untilDrip = DRIP_FIRST;
  #seen: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
  #experimentKnob: number | undefined;
  #markOn: boolean | undefined;
  /** What the pointer holds: a dipper (0..3) or the M (4); and the finger it draws through open water. */
  #grabbed: number | undefined;
  #finger: Point | undefined;
  #pressedAt: Point = { x: 0, y: 0 };

  constructor(gpu: GpuCompute, at: Slots, defaults: readonly number[]) {
    this.#gpu = gpu;
    this.#at = at;
    this.#defaults = defaults;
    this.#step = gpu.pass(STEP_PASS, "ripple step");
    this.#media = gpu.pass(MEDIA_PASS, "ripple media");
    this.#touch = gpu.pass(TOUCH_PASS, "ripple touch");
    this.#shade = gpu.pass(VIEW_PASS, "ripple view");
    this.#seed = gpu.pass(SEED_PASS, "ripple seed");
    this.#layoutTarget = gpu.target({ width: RIPPLE_LAYOUT_WIDTH, height: 2, format: "rgba32f", filter: "nearest" });
    this.#layoutTarget.seed(this.#layoutShown);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const physics = this.#physicsFor(frame);
    const { width, height } = gridSize(frame.aspect > 0 && Number.isFinite(frame.aspect) ? frame.aspect : 16 / 9, physics.n);
    const previous = this.#physics;
    this.#physics = physics;
    this.#frameSize[0] = physics.frame.width;
    this.#frameSize[1] = physics.frame.height;

    let tanks = this.#tanks;
    if (!tanks) {
      tanks = [new Tank(this.#gpu, width, height), new Tank(this.#gpu, width, height)];
      this.#tanks = tanks;
      const fixed = this.#fixed(frame);
      const first = this.#value(frame, this.#at.mark) > 0 ? MARK : (fixed ?? TWO);
      this.#start(tanks[0], first, 0, PREWARM);
      this.#hold = this.#holdFor(frame);
      this.#experimentKnob = Math.round(this.#value(frame, this.#at.experiment));
      this.#markOn = this.#value(frame, this.#at.mark) > 0;
      this.#seen = [frame.triggers[0] ?? -1e4, frame.triggers[1] ?? -1e4, frame.triggers[2] ?? -1e4];
    } else {
      for (const tank of tanks) {
        if (tank.state.width !== width || tank.state.height !== height) {
          // A new frame or wavelength: stretch the water over the new grid; it re-forms at its own size.
          tank.state.resize(width, height, true);
          tank.view.resize(width, height);
        }
        if (previous && previous.step !== physics.step) tank.prevScale = physics.step / previous.step;
      }
    }

    const seconds = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    this.#schedule(frame, seconds);
    this.#pebbleCount = 0;
    this.#pebbles.fill(0);
    this.#pointer(frame.pointer, frame.dt > 0);
    this.#drip(frame, seconds);

    const [shown, coming] = this.#order();
    const fading = this.#fade !== undefined;
    this.#ensureLayout(shown);
    if (this.#preparing || fading) this.#ensureLayout(coming);
    if (this.#pebbleCount > 0) {
      this.#touch.run(shown.state, { textures: { uState: shown.state }, uniforms: { uFrame: this.#frameSize, uPebbles: this.#pebbles } });
      if (fading) this.#touch.run(coming.state, { textures: { uState: coming.state } });
    }
    this.#easeTrack(shown, seconds);
    this.#advance(shown, seconds, MAX_STEPS, this.#finger);
    if (fading) this.#advance(coming, seconds, MAX_STEPS, undefined);
    else if (this.#preparing) this.#advance(coming, seconds * PREP_RATE, MAX_PREP_STEPS, undefined);
    this.#render(frame, shown);
    if (fading) this.#render(frame, coming);
    this.#publish(shown, coming);
    return [shown.view.texture, (fading ? coming : shown).view.texture, this.#layoutTarget.texture];
  }

  dispose(): void {
    this.#gpu.dispose();
  }

  #value(frame: SimFrame, index: number): number {
    return frame.values[index] ?? this.#defaults[index] ?? 0;
  }

  /** The experiment the knob holds, or undefined while it cycles. */
  #fixed(frame: SimFrame): Experiment | undefined {
    const choice = Math.round(this.#value(frame, this.#at.experiment));
    return choice >= 1 ? RIPPLE_EXPERIMENTS[choice - 1] : undefined;
  }

  #holdFor(frame: SimFrame): number {
    return lerp(HOLD, Math.min(1, Math.max(0, this.#value(frame, this.#at.pace))));
  }

  #physicsFor(frame: SimFrame): Physics {
    const tank = tankFrame(frame.aspect);
    const speed = RIPPLE_SPEED * Math.max(0.1, this.#value(frame, this.#at.speed));
    const hertz = RIPPLE_FREQUENCY * Math.max(0.1, this.#value(frame, this.#at.frequency));
    const lambda = speed / hertz;
    const cells = Math.min(frame.width, frame.height);
    const wanted = Math.round(PER_WAVE / lambda / GRID_ROUND) * GRID_ROUND;
    const n = Math.min(Math.max(wanted, GRID_MIN), GRID_MAX, Math.max(96, Math.round(cells / GRID_ROUND) * GRID_ROUND));
    const step = Math.min(STEP, COURANT / (speed * n));
    const mark = Math.max(0, this.#value(frame, this.#at.mark));
    return {
      frame: tank,
      speed,
      omega: TAU * hertz,
      lambda,
      n,
      step,
      courant: speed * n * step,
      damp: DAMP_MAX * Math.min(1, Math.max(0, this.#value(frame, this.#at.damping))) ** 1.5,
      markSize: mark > 0 ? mark : 0.5,
    };
  }

  /** [shown, coming]. */
  #order(): [Tank, Tank] {
    const tanks = this.#tanks;
    if (!tanks) throw new Error("landing: the ripple tank was used before its first frame");
    return tanks;
  }

  /** Whether a 'now' button fired since the last frame. */
  #fired(frame: SimFrame, slot: 0 | 1 | 2): boolean {
    const fired = frame.triggers[slot] ?? -1e4;
    const seen = this.#seen[slot];
    this.#seen[slot] = fired;
    return seen !== undefined && fired !== seen && fired > -1e3;
  }

  /**
   * The experiment after the shown one. Cycling: the next in turn, the M last while it is on.
   * Holding one: that one (back from the M), or undefined when it is already shown.
   */
  #upcoming(frame: SimFrame, shown: Experiment): Experiment | undefined {
    const fixed = this.#fixed(frame);
    if (fixed !== undefined) return shown === fixed ? undefined : fixed;
    const order: Experiment[] = this.#value(frame, this.#at.mark) > 0 ? [...RIPPLE_EXPERIMENTS, MARK] : [...RIPPLE_EXPERIMENTS];
    const at = order.indexOf(shown);
    return order[(at + 1) % order.length] ?? TWO;
  }

  /** Knob changes and 'now' buttons change the experiment at once; the hold schedules the rest. */
  #schedule(frame: SimFrame, seconds: number): void {
    const [shown] = this.#order();
    const knob = Math.round(this.#value(frame, this.#at.experiment));
    const markOn = this.#value(frame, this.#at.mark) > 0;
    const nextNow = this.#fired(frame, 0);
    const markNow = this.#fired(frame, 1);
    let now: Experiment | undefined;
    if (markNow || (markOn && this.#markOn === false)) now = MARK;
    else if (nextNow) now = this.#upcoming(frame, shown.experiment) ?? shown.experiment;
    else if (knob !== this.#experimentKnob && knob >= 1) now = this.#fixed(frame);
    else if (!markOn && this.#markOn === true && shown.experiment === MARK) now = this.#upcoming(frame, MARK) ?? TWO;
    if (knob !== this.#experimentKnob && knob === 0) this.#hold = this.#holdFor(frame);
    this.#experimentKnob = knob;
    this.#markOn = markOn;
    if (now !== undefined && (now !== shown.experiment || nextNow)) {
      this.#change(frame, now);
      return;
    }

    if (this.#fade !== undefined) {
      this.#fade += seconds / FADE;
      if (this.#fade >= 1) this.#finishFade(frame);
      return;
    }
    const upcoming = this.#upcoming(frame, shown.experiment);
    if (upcoming === undefined) {
      this.#hold = this.#holdFor(frame);
      this.#preparing = false;
      return;
    }
    this.#hold -= seconds;
    const [, coming] = this.#order();
    if (!this.#preparing && this.#hold <= PREP) {
      this.#start(coming, upcoming, -Math.max(0, this.#hold) * PREP_RATE, 0);
      this.#preparing = true;
    }
    if (this.#preparing && this.#hold <= 0) {
      this.#preparing = false;
      this.#fade = 0;
    }
  }

  /** Change to `experiment` now: a fresh tank, prewarmed, fades in. */
  #change(frame: SimFrame, experiment: Experiment): void {
    if (this.#fade !== undefined) this.#finishFade(frame);
    const [, coming] = this.#order();
    this.#start(coming, experiment, 0, PREWARM);
    this.#preparing = false;
    this.#fade = 0;
  }

  #finishFade(frame: SimFrame): void {
    const tanks = this.#order();
    this.#tanks = [tanks[1], tanks[0]];
    this.#fade = undefined;
    this.#hold = this.#holdFor(frame);
    this.#grabbed = undefined;
  }

  /** Seed `tank` with `experiment`'s steady state at `time` seconds into it, then run it `prewarm` steps. */
  #start(tank: Tank, experiment: Experiment, time: number, prewarm: number): void {
    const physics = this.#need();
    tank.experiment = experiment;
    tank.time = time;
    tank.phase = (physics.omega * time) % TAU;
    tank.pending = 0;
    tank.prevScale = 1;
    tank.offsets.fill(undefined);
    tank.layoutKey = "";
    const layout = this.#ensureLayout(tank);
    this.#seedUniforms(layout, tank, physics);
    this.#seed.run(tank.state, {
      uniforms: {
        uFrame: this.#frameSize,
        uK: TAU / physics.lambda,
        uLambda: physics.lambda,
        uPhase: tank.phase,
        uPhaseStep: physics.omega * physics.step,
        uAtten: physics.damp / (2 * physics.speed),
        uPoints: this.#points,
        uPointSide: this.#sides,
        uPlanes: this.#planes,
        uPlaneDrive: this.#drives,
        uLens: this.#lens,
        uLensAxis: this.#axis,
        uMoving: this.#moving,
        uMovingDrive: this.#movingDrive,
        uMark: this.#mark,
        uBox: this.#box,
      },
    });
    this.#runMedia(tank, layout, physics);
    for (let i = 0; i < prewarm; i++) this.#stepTank(tank, undefined);
  }

  #need(): Physics {
    const physics = this.#physics;
    if (!physics) throw new Error("landing: the ripple tank's physics were used before its first frame");
    return physics;
  }

  /** The tank's layout for this frame's physics, rebuilt (and its walls redrawn) when they change. */
  #ensureLayout(tank: Tank): Layout {
    const physics = this.#need();
    const { frame } = physics;
    const key = `${tank.experiment}|${frame.width.toFixed(5)}|${frame.height.toFixed(5)}|${physics.lambda.toFixed(6)}|${physics.speed.toFixed(6)}|${physics.markSize.toFixed(3)}|${tank.state.width}x${tank.state.height}`;
    if (tank.layout && key === tank.layoutKey) return tank.layout;
    const layout = rippleLayout(tank.experiment, frame, physics.lambda, physics.speed, physics.markSize);
    tank.layout = layout;
    tank.layoutKey = key;
    this.#runMedia(tank, layout, physics);
    return layout;
  }

  /** Draw the layout's walls, box and lens into the tank's state. */
  #runMedia(tank: Tank, layout: Layout, physics: Physics): void {
    this.#walls.fill(0);
    this.#halves.fill(0);
    layout.walls.forEach((wall, i) => {
      if (i >= 4) return;
      this.#walls.set([wall.ax, wall.ay, wall.bx, wall.by], i * 4);
      this.#halves[i] = wall.half;
    });
    this.#lensUniforms(layout);
    const box = layout.box;
    this.#box.set(box ? [box.x0, box.y0, box.x1, box.y1] : [0, 0, 0, 0]);
    this.#media.run(tank.state, {
      textures: { uState: tank.state },
      uniforms: {
        uFrame: this.#frameSize,
        uWalls: this.#walls,
        uWallHalf: this.#halves,
        uLens: this.#lens,
        uLensAxis: this.#axis,
        uBox: this.#box,
        uBoxDamp: BOX_DAMP * physics.step,
      },
    });
  }

  #lensUniforms(layout: Layout): void {
    const lens = layout.lens;
    this.#lens.set(lens ? [lens.x, lens.y, lens.half, lens.thick] : [0, 0, 0, 0]);
    this.#axis.set(lens ? [lens.ux, lens.uy, lens.ratio, LENS_EDGE] : [1, 0, 1, LENS_EDGE]);
  }

  /** The seed pass's emitters for a layout. */
  #seedUniforms(layout: Layout, tank: Tank, physics: Physics): void {
    const k = TAU / physics.lambda;
    this.#points.fill(0);
    this.#sides.fill(0);
    this.#planes.fill(0);
    this.#drives.fill(0);
    this.#moving.fill(0);
    this.#movingDrive.fill(0);
    this.#mark.fill(0);
    this.#lensUniforms(layout);
    const box = layout.box;
    this.#box.set(box ? [box.x0, box.y0, box.x1, box.y1] : [0, 0, 0, 0]);
    let points = 0;
    for (const dipper of layout.dippers) {
      if (points >= SEED_POINTS) break;
      this.#points.set([dipper.x, dipper.y, dipper.amp, 0], points * 4);
      points++;
    }
    const bar = layout.bar;
    if (bar) {
      const from = bar.ax * bar.nx + bar.ay * bar.ny;
      const slits = layout.slits;
      this.#planes.set([bar.ax, bar.ay, bar.nx, bar.ny], 0);
      this.#drives.set([bar.amp, 0, slits ? slits.near : 1e6, 0], 0);
      if (slits) {
        // The barrier sends the bar's waves back: a mirrored bar beyond its near face.
        const mirror = 2 * (slits.near - from);
        this.#planes.set([bar.ax + mirror * bar.nx, bar.ay + mirror * bar.ny, bar.nx, bar.ny], 4);
        this.#drives.set([bar.amp, 0, slits.near, 0], 4);
        // Past it, each slit is a dipper fed by the wave that reached it: a ring SLIT_RING × (that
        // wave's height × slit width / wavelength) high, a quarter turn ahead of it.
        const phase = -k * (slits.far - from);
        const reached = bar.amp * Math.exp((-physics.damp / (2 * physics.speed)) * (slits.far - from));
        for (const centre of slits.centres) {
          if (points >= SEED_POINTS) break;
          this.#points.set([centre.x, centre.y, (SLIT_RING * reached * slits.width) / physics.lambda, phase], points * 4);
          this.#sides.set([bar.nx, bar.ny, slits.far, 0], points * 4);
          points++;
        }
      }
    }
    const track = layout.track;
    if (track) {
      const at = trackAt(track, tank.time);
      this.#moving.set([at.x, at.y, at.vx, at.vy]);
      this.#movingDrive.set([track.amp, physics.speed]);
    }
    const mark = layout.mark;
    if (mark) this.#mark.set([mark.x, mark.y, mark.height, mark.amp]);
  }

  /** Step a tank through `seconds` of its time, at most `most` steps (a slow machine's tank runs slow). */
  #advance(tank: Tank, seconds: number, most: number, finger: Point | undefined): void {
    const physics = this.#need();
    tank.pending += seconds / physics.step;
    const steps = Math.min(Math.floor(tank.pending), most);
    for (let i = 0; i < steps; i++) this.#stepTank(tank, finger);
    tank.pending = Math.min(tank.pending - steps, 0.999);
  }

  /** One step: move the dippers to where they are now and push the water. */
  #stepTank(tank: Tank, finger: Point | undefined): void {
    const physics = this.#need();
    const layout = tank.layout;
    if (!layout) return;
    tank.time += physics.step;
    tank.phase = (tank.phase + physics.omega * physics.step) % TAU;
    const C2 = physics.courant * physics.courant;
    const sigma = SIGMA * physics.n;
    // Pushes per step for a ring 1 high a wavelength out, and for plane waves 1 high.
    const pointPush = (4 * C2) / (sigma * sigma);
    const linePush = (2 * physics.omega * physics.step * physics.courant) / (sigma * Math.sqrt(Math.PI));
    this.#dippers.fill(0);
    let slot = 0;
    layout.dippers.forEach((dipper, i) => {
      if (slot >= DIPPERS - 1) return;
      const offset = tank.offsets[i];
      this.#dippers.set([dipper.x + (offset?.x ?? 0), dipper.y + (offset?.y ?? 0), dipper.amp * pointPush, 0], slot * 4);
      slot++;
    });
    const track = layout.track;
    if (track && slot < DIPPERS - 1) {
      const at = trackAt(track, tank.time);
      const offset = tank.offsets[slot];
      this.#dippers.set([at.x + (offset?.x ?? 0), at.y + (offset?.y ?? 0), track.amp * pointPush, 0], slot * 4);
    }
    if (finger) this.#dippers.set([finger.x, finger.y, FINGER * pointPush, 0], (DIPPERS - 1) * 4);
    const bar = layout.bar;
    if (bar) this.#bar.set([bar.ax, bar.ay, bar.bx, bar.by]);
    const mark = layout.mark;
    const markOffset = tank.offsets[4];
    if (mark) this.#mark.set([mark.x + (markOffset?.x ?? 0), mark.y + (markOffset?.y ?? 0), mark.height, mark.amp * linePush]);
    else this.#mark.fill(0);
    const edge = Math.min(Math.max(SPONGE_WAVES * physics.lambda, SPONGE_WIDTH[0]), SPONGE_WIDTH[1]);
    this.#sponge[0] = edge;
    this.#sponge[1] = SPONGE_RATE * physics.step;
    this.#step.run(tank.state, {
      textures: { uState: tank.state },
      uniforms: {
        uFrame: this.#frameSize,
        uC2: C2,
        uDamp: physics.damp * physics.step,
        uSponge: this.#sponge,
        uPrevScale: tank.prevScale,
        uPhase: tank.phase,
        uSigma: SIGMA,
        uDippers: this.#dippers,
        uBar: this.#bar,
        uBarPush: bar ? bar.amp * linePush : 0,
        uMark: this.#mark,
      },
    });
    tank.prevScale = 1;
  }

  /** The Doppler dipper, let go, eases back onto its track. */
  #easeTrack(tank: Tank, seconds: number): void {
    const layout = tank.layout;
    if (!layout?.track) return;
    const slot = layout.dippers.length;
    const offset = tank.offsets[slot];
    if (!offset || this.#grabbed === slot) return;
    const keep = Math.exp(-seconds / TRACK_RETURN);
    offset.x *= keep;
    offset.y *= keep;
  }

  /** The view: the height between the last two steps, the light's focus, the slope. */
  #render(frame: SimFrame, tank: Tank): void {
    const physics = this.#need();
    const k = (TAU / physics.lambda) / physics.n;
    const focus = Math.min(1, Math.max(0, this.#value(frame, this.#at.focus)));
    const kappa = lerp(RIPPLE_FOCUS, focus) * (tank.layout?.contrast ?? 1);
    this.#shade.run(tank.view, {
      textures: { uState: tank.state },
      uniforms: { uFrac: tank.pending, uFocus: kappa / (k * k), uSlope: 1 / k },
    });
  }

  #addPebble(x: number, y: number, radius: number, height: number): void {
    if (this.#pebbleCount >= MAX_PEBBLES) return;
    this.#pebbles.set([x, y, radius, height], this.#pebbleCount * 4);
    this.#pebbleCount++;
  }

  /** A drip from the faucet now and then, somewhere over open water; 'now' lets one fall at once. */
  #drip(frame: SimFrame, seconds: number): void {
    const physics = this.#need();
    const rate = this.#value(frame, this.#at.drips);
    let fall = this.#fired(frame, 2);
    if (rate > 0) {
      this.#untilDrip -= seconds;
      if (this.#untilDrip <= 0) {
        fall = true;
        this.#untilDrip = lerp(DRIP_INTERVAL, Math.min(1, rate)) * (0.6 + 0.8 * this.#random());
      }
    }
    if (!fall) return;
    const { width, height } = physics.frame;
    const margin = 0.2;
    const x = margin + this.#random() * Math.max(width - 2 * margin, 0);
    const y = margin + this.#random() * Math.max(height - 2 * margin, 0);
    this.#addPebble(x, y, DRIP.radius * physics.lambda, DRIP.height);
  }

  /**
   * Press on a dipper (or the M) to pick it up and drag it; press on open water to drop a pebble,
   * and drag on from there to draw a finger through the water, beating like a dipper.
   */
  #pointer(pointer: PointerState, live: boolean): void {
    const physics = this.#need();
    const [shown] = this.#order();
    const layout = shown.layout;
    if (!live || !pointer.inside || !layout) {
      if (!pointer.down) this.#grabbed = undefined;
      this.#finger = undefined;
      return;
    }
    const p = { x: pointer.x * physics.frame.width, y: pointer.y * physics.frame.height };
    const homes: (Point | undefined)[] = layout.dippers.map((dipper) => ({ x: dipper.x, y: dipper.y }));
    if (layout.track) homes.push(trackAt(layout.track, shown.time));
    while (homes.length < 4) homes.push(undefined);
    homes.push(layout.mark ? { x: layout.mark.x, y: layout.mark.y } : undefined);
    if (pointer.pressed) {
      this.#grabbed = undefined;
      this.#finger = undefined;
      let best = GRAB;
      homes.forEach((home, i) => {
        if (!home) return;
        const offset = shown.offsets[i];
        const reach = i === 4 && layout.mark ? 0.6 * layout.mark.height : best;
        const d = Math.hypot(p.x - home.x - (offset?.x ?? 0), p.y - home.y - (offset?.y ?? 0));
        if (d < reach) {
          best = Math.min(best, d);
          this.#grabbed = i;
        }
      });
      this.#pressedAt = p;
      if (this.#grabbed === undefined) this.#addPebble(p.x, p.y, PEBBLE.radius * physics.lambda, PEBBLE.height);
    }
    if (!pointer.down) {
      this.#grabbed = undefined;
      this.#finger = undefined;
      return;
    }
    const grabbed = this.#grabbed;
    const home = grabbed === undefined ? undefined : homes[grabbed];
    if (grabbed !== undefined && home) {
      shown.offsets[grabbed] = { x: p.x - home.x, y: p.y - home.y };
      return;
    }
    if (this.#finger || Math.hypot(p.x - this.#pressedAt.x, p.y - this.#pressedAt.y) > DIP) this.#finger = p;
  }

  /** The layout texture: each tank's fixtures where they are now, and how far the coming one has faded in. */
  #publish(shown: Tank, coming: Tank): void {
    const data = this.#layoutData;
    data.fill(0);
    const physics = this.#need();
    const fade = this.#fade;
    this.#writeRow(data, 0, shown, 1, physics);
    if (fade !== undefined) this.#writeRow(data, 1, coming, Math.min(1, Math.max(0, fade)), physics);
    let changed = false;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== this.#layoutShown[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.#layoutShown.set(data);
    this.#layoutTarget.seed(data);
  }

  #writeRow(data: Float32Array, row: number, tank: Tank, weight: number, physics: Physics): void {
    const layout = tank.layout;
    if (!layout) return;
    const base = row * RIPPLE_LAYOUT_WIDTH * 4;
    const put = (texel: number, a: number, b: number, c: number, d: number): void => {
      data.set([a, b, c, d], base + texel * 4);
    };
    put(RIPPLE_TEXELS.meta, weight, layout.experiment, layout.contrast, physics.lambda);
    const dippers: Point[] = layout.dippers.map((dipper, i) => ({ x: dipper.x + (tank.offsets[i]?.x ?? 0), y: dipper.y + (tank.offsets[i]?.y ?? 0) }));
    let beam = layout.beam;
    if (layout.track) {
      const slot = layout.dippers.length;
      const at = trackAt(layout.track, tank.time);
      const offset = tank.offsets[slot];
      const dipper = { x: at.x + (offset?.x ?? 0), y: at.y + (offset?.y ?? 0) };
      dippers.push(dipper);
      // The dipper rides on an arm reaching in from the tank's near side.
      beam = { ax: dipper.x, ay: dipper.y, bx: dipper.x - layout.track.wx, by: dipper.y - layout.track.wy };
    }
    dippers.forEach((dipper, i) => {
      if (i < 4) put(RIPPLE_TEXELS.dippers + i, dipper.x, dipper.y, RIPPLE_DIPPER, 1);
    });
    if (beam) put(RIPPLE_TEXELS.beam, beam.ax, beam.ay, beam.bx, beam.by);
    const bar = layout.bar;
    if (bar) put(RIPPLE_TEXELS.bar, bar.ax, bar.ay, bar.bx, bar.by);
    const halves = [0, 0, 0, 0];
    layout.walls.forEach((wall, i) => {
      if (i >= 4) return;
      put(RIPPLE_TEXELS.walls + i, wall.ax, wall.ay, wall.bx, wall.by);
      halves[i] = wall.half;
    });
    put(RIPPLE_TEXELS.halves, halves[0] ?? 0, halves[1] ?? 0, halves[2] ?? 0, halves[3] ?? 0);
    const lens = layout.lens;
    if (lens) {
      put(RIPPLE_TEXELS.lens, lens.x, lens.y, lens.half, lens.thick);
      put(RIPPLE_TEXELS.axis, lens.ux, lens.uy, lens.ratio, 0);
    }
    const mark = layout.mark;
    const offset = tank.offsets[4];
    if (mark) put(RIPPLE_TEXELS.mark, mark.x + (offset?.x ?? 0), mark.y + (offset?.y ?? 0), mark.height, 1);
    put(RIPPLE_TEXELS.flags, beam ? 1 : 0, bar ? 1 : 0, 0, 0);
  }
}

/**
 * The ripple tank's water. `knobs` are the scene's params, so it reads its own knobs from
 * `SimFrame.values` by key. Without float render targets it supplies nothing and the shader draws
 * a still interference picture of its own.
 */
export function rippleSim(knobs: readonly ParamDef[]): SimFactory {
  const slot = (key: string): number => {
    const index = knobs.findIndex((knob) => knob.key === key);
    if (index < 0) throw new Error(`landing: the ripple scene has no "${key}" knob`);
    return index;
  };
  const at: Slots = {
    experiment: slot("experiment"),
    pace: slot("pace"),
    frequency: slot("frequency"),
    speed: slot("speed"),
    damping: slot("damping"),
    drips: slot("drips"),
    focus: slot("focus"),
    mark: slot("mark"),
  };
  const defaults = knobs.map((knob) => (knob.kind === "feature" ? (knob.on ? knob.value : 0) : knob.value));
  return (gl): SceneSim => {
    const gpu = GpuCompute.create(gl);
    if (!gpu) return { frame: () => [], dispose: () => undefined };
    return new RippleLab(gpu, at, defaults);
  };
}
