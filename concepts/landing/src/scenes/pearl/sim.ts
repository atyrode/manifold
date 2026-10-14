// A tank of rheoscopic fluid (pearl fluid, as in Paul Matisse's Kalliroscope): microscopic flakes
// suspended in the liquid line up with the shear, so every current shows as satin. The flow is a
// FluidSim on the GPU (sims/fluid.ts); the flakes are a second field it carries: their mean
// orientation as a doubled-angle vector q = S (cos 2θ, sin 2θ), θ the flakes' direction (θ and θ + π
// are the same flake) and S 0..1 how well they agree (0 a milky jumble, 1 all aligned). Each step:
//   1. sources  heat along the floor and a cool lid (convection), the pigment nozzle, the trace of
//               the Manifold rod (dye: r pigment, g temperature, b the M's trace for the accent)
//   2. fluid    forces (turntable, buoyancy, rods, drifting eddies, swirl), advection, projection
//   3. flakes   Jeffery's equation for thin flakes (G. B. Jeffery, "The motion of ellipsoidal
//               particles immersed in a viscous fluid", Proc. R. Soc. A 102, 1922), in doubled angles:
//                 dq/dt = ω q⊥ + 2λ (e − (e·q) q)
//               ω the vorticity (flakes spin at ω/2, so their doubled angle at ω) and e the strain
//               (½(∂u/∂x − ∂v/∂y), ½(∂u/∂y + ∂v/∂x)), which combs them toward its stretching axis
//               and raises their order (|q| → 1 along e). λ a little over 1 gives steady shear a
//               stable angle, so shear layers never tumble the flakes round and round into ever
//               finer stripes. Then a slow settling toward disorder, and damping that falls mostly
//               on the finest scales (a little diffusion, more hyperdiffusion): stripes a texel or
//               two wide melt into milk within a second, bands of six cells and up live on.
//   4. carry    the flakes advected by the flow (MacCormack)
// The pour is seeded with history: a silk of orientations varying at two scales, wound into
// spirals by a dozen eddies of many sizes, which go on turning. Drifting eddies (the room's warmth
// stirring the tank) keep winding new spirals and filaments at several scales for as long as it
// runs. The shader lights q with a lamp: flakes along the lamp's doubled angle glint, flakes across
// it go dark, and on either flank of a bright band they show nacre's rose and green.
//
// Forcing, in the fluid's units (frame heights, seconds):
//   turntable   the camera rides the tank, which turns about an eighth of a turn, rests and turns
//               back. In the tank's frame the only force is Euler's, −dΩ/dt ẑ × r (Coriolis and
//               centrifugal forces are gradients in 2D: the pressure takes them); the walls drag
//               (no-slip), so the lagging fluid curls off them in eddies and spirals.
//   convection  the tank stands upright over a heater: buoyancy from the temperature in dye.g.
//   rods        three glass rods trade places, the left pair clockwise, then the right pair
//               counter-clockwise: the σ1σ2⁻¹ braid, which stretches the fluid by the golden ratio
//               squared every period (P. L. Boyland, H. Aref, M. A. Stremler, "Topological fluid
//               mechanics of stirring", J. Fluid Mech. 403, 2000). The rods grip the fluid by
//               penalisation: inside them it is set to their velocity.
// A drag across the page adds velocity splats along the path; the swirl spins a slow vortex up at
// the centre; the Manifold rod writes the M, laying the flakes along its path as it goes. Drifting
// eddies stir every mode: a few vortex forces wandering on slow Lissajous paths, each waxing,
// waning and turning about over a minute or two.
//
// Textures: uSim0 the flakes (rg16f q), uSim1 the dye (rgba16f), uSim2 the props (rgba32f, 5×1):
// texels 0–2 the braid rods and 3 the Manifold rod (x, y in frame heights, shown 0..1, radius),
// texel 4 the pigment nozzle (x, y, shown) with the share of convection in w.
// Without float render targets the scene returns no textures and the shader draws still eddies.
import { KnobReader, type ParamDef } from "../../params.ts";
import { markVertex } from "../../mark.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { FluidSim, type FluidStep } from "../../sims/fluid.ts";
import { GpuCompute, GpuError, gridSize, type Pass, type PingPong, type RenderTarget } from "../../sims/gpu.ts";
import { hash31, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

export const pearlForcings = ["turntable", "convection", "rods"] as const;
type PearlForcing = (typeof pearlForcings)[number];

/** The sim reached a state its knobs cannot produce. */
export class PearlError extends Error {}

// ---- tuning ---------------------------------------------------------------------------------------

/** Grids, in texels on the frame's short side: velocity, dye, flakes. A flake texel is about 1.7
 * dither cells on a 540-row frame: bands of four cells and up are drawn cleanly. The dye only
 * carries heat, a pigment thread and the M's trace, all soft, so it is coarse and plainly advected. */
const VELOCITY_RESOLUTION = 128;
const DYE_RESOLUTION = 160;
const FLAKE_RESOLUTION = 320;

/** Longest step and most steps per frame (the renderer's dt is at most 0.1 s, speed at most 2). */
const MAX_STEP = 0.1;
const MAX_STEPS = 2;
/** A fresh pour runs this many long steps before it is shown, so it is already moving. */
const PREWARM_STEPS = 3;
const PREWARM_STEP = 0.2;

/** Bottom friction (per second) everywhere, and the drag of the no-slip walls within ~0.025. */
const BOTTOM_FRICTION = 0.05;
const WALL_DRAG = 1;
/**
 * Viscosity, velocity texels² per second: a checkerboard fades at 8× this per second, an eddy 40
 * texels across at a hundredth of it.
 */
const VISCOSITY = 2;
/** Fade per second of the dye's channels: pigment, temperature (slow enough that a plume still
 * carries warmth to the lid), the M's trace. */
const DYE_FADE: readonly number[] = [0.015, 0.06, 0.03, 0];

/**
 * Jeffery's shape factor. 1 is the infinitely thin flake, whose angle in steady shear is only
 * marginally stable; a little over 1 makes it a firm attractor, so persistent shear (along the
 * walls, in a rod's wake) lays the flakes down instead of tumbling them into fine stripes.
 */
const ALIGN = 1.1;
/** Order lost per second as flakes settle and jostle. */
const SETTLE = 0.015;
/** Diffusion (flake texels² per second) and hyperdiffusion (texels⁴ per second) of the flakes'
 * orientation: stripes of a 2-texel period fade at ~2.2 / s, 4-texel ~0.6, 7-texel ~0.13. */
const SPREAD = 0.08;
const HYPER = 0.12;

/** The turntable: an eighth of a turn (give or take a quarter of that) eased over TURN_SECONDS,
 * a rest, and back. */
const TURN_ANGLE = 0.25 * Math.PI;
const TURN_SECONDS = 16;
const TURN_REST = 10;

/** Convection: floor heating (and lid cooling) per second, lift per unit of temperature. */
const HEAT = 0.5;
const BUOYANCY = 0.004;
/** How fast the heater's warmer spots wander (radians per second), so the plumes drift. */
const HEATER_DRIFT = 0.02;
/** A fresh pour over the heater starts with this much warmth along the floor. */
const WARM_FLOOR = 1.2;

/** The braid: rod radius, spacing of the three rods, seconds per swap and the pause after it. */
const ROD_RADIUS = 0.024;
const BRAID_SPACING = 0.26;
const SWAP_SECONDS = 14;
const SWAP_REST = 2;

/** Drifting eddies: how many, peak angular acceleration (rad/s²) at full drift, radii. */
const DRIFTERS = 6;
const DRIFT_ACCEL = 0.02;
const DRIFT_RADIUS_MIN = 0.08;
const DRIFT_RADIUS_MAX = 0.22;

/** Seconds for the forcing, the rods and the nozzle to ease in or out when the knobs change. */
const BLEND_SECONDS = 2;

/** The swirl: seconds it pushes, peak angular acceleration (rad/s²) at strength 0.5, radius. */
const SWIRL_SECONDS = 8;
const SWIRL_ACCEL = 0.08;
const SWIRL_RADIUS = 0.26;
/** First swirl after a pour, then about every SWIRL_EVERY ± SWIRL_JITTER / 2 seconds. */
const SWIRL_FIRST = 40;
const SWIRL_EVERY = 60;
const SWIRL_JITTER = 20;
/** Turned back on, the next swirl comes no sooner than this. */
const SWIRL_RESUME = 4;

/** The Manifold rod: radius, peak speed, seconds lowering in and lifting out, schedule. */
const MARK_ROD_RADIUS = 0.02;
const MARK_SPEED = 0.2;
const MARK_FADE = 0.9;
const MARK_FIRST = 3;
const MARK_EVERY = 110;
/** smoothstep's peak rate is 1.5× its mean: strokes take this much longer than at full speed. */
const MARK_EASE = 1.5;
/** How firmly the rod lays the flakes along its path, and the reach of that and of its trace. */
const MARK_PAINT = 1.5;
const MARK_PAINT_RADIUS = 0.024;
const MARK_TRACE_RADIUS = 0.02;

/** Stirring with the pointer: splat radius, share of the pointer's speed given to the fluid, cap. */
const STIR_RADIUS = 0.04;
const STIR_GAIN = 0.8;
const STIR_MAX = 0.45;
const STIR_SPLATS = 8;

/**
 * The pour: eddies (radii spread evenly in log between the bounds), the spin at their centres
 * (vorticity, rad/s: the same for all sizes, so a small eddy never whirls its satin round fast
 * enough to blink), and how far round each had wound the fluid before the scene opens (radians
 * at its centre). A Gaussian stream function a·exp(−r²/R²) spins at 4a / R² at its centre.
 */
const POUR_EDDIES = 12;
const POUR_RADIUS_MIN = 0.06;
const POUR_RADIUS_MAX = 0.26;
const POUR_SPIN = 0.35;
const POUR_TWIST_MIN = 1.5;
const POUR_TWIST_MAX = 5;

/** The pigment nozzle: where it dips (share of the width, height), its radius, pigment per second. */
const NOZZLE_X = 0.2;
const NOZZLE_Y = 0.76;
const NOZZLE_RADIUS = 0.008;
const PIGMENT_BASE = 1;
const PIGMENT_RATE = 4;

const PROP_TEXELS = 5;
const TAU = 2 * Math.PI;

// ---- GLSL -----------------------------------------------------------------------------------------

/** The fluid's forces (see sims/fluid.ts for the snippet's contract). */
const FORCE = `
uniform float uPearlEuler;     // turntable: dOmega/dt (rad/s^2)
uniform float uPearlBuoyancy;  // lift per unit of temperature
uniform float uPearlWallDrag;  // per second, at the walls
uniform vec4 uPearlRods[4];    // centre, velocity (frame heights, per second)
uniform vec2 uPearlGrip[4];    // grip 0..1, radius
uniform vec4 uPearlSwirl;      // centre, angular acceleration (rad/s^2), radius
uniform vec4 uPearlDrift[${DRIFTERS}];   // drifting eddies: centre, angular acceleration, radius

vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
  // Viscosity: without it every shear layer rolls up into eddies a few texels across, a fur of
  // streaks along each band. Explicit; ${glslFloat(VISCOSITY)} texels^2/s, a step taking at most a fifth.
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec2 laplacian = texture(uVelocity, uv + dx).xy + texture(uVelocity, uv - dx).xy
                 + texture(uVelocity, uv + dy).xy + texture(uVelocity, uv - dy).xy - 4.0 * velocity;
  vec2 force = min(${glslFloat(VISCOSITY)} * uDt, 0.2) / max(uDt, 1e-3) * laplacian;
  // In the turning tank's frame: Euler's force, -dOmega/dt z x r.
  vec2 r = p - 0.5 * uDomain;
  force += uPearlEuler * vec2(r.y, -r.x);
  // No-slip walls: the fluid drags along the glass.
  float wall = min(min(p.x, uDomain.x - p.x), min(p.y, uDomain.y - p.y));
  force -= uPearlWallDrag * exp(-wall / 0.025) * velocity;
  force.y += uPearlBuoyancy * dye.g;
  vec2 s = p - uPearlSwirl.xy;
  force += uPearlSwirl.z * vec2(-s.y, s.x) * exp(-dot(s, s) / (uPearlSwirl.w * uPearlSwirl.w));
  for (int i = 0; i < ${DRIFTERS}; i++) {
    vec4 drift = uPearlDrift[i];
    vec2 d = p - drift.xy;
    force += drift.z * vec2(-d.y, d.x) * exp(-dot(d, d) / (drift.w * drift.w));
  }
  // The rods carry the fluid inside them at their own velocity (penalisation, at most all of the
  // way in one step).
  float grab = 1.0 / max(uDt, 1e-3);
  for (int i = 0; i < 4; i++) {
    vec4 rod = uPearlRods[i];
    vec2 grip = uPearlGrip[i];
    float inside = 1.0 - smoothstep(0.5 * grip.y, 1.2 * grip.y, length(p - rod.xy));
    force += grab * grip.x * inside * (rod.zw - velocity);
  }
  return force;
}
`;

/** One step of the flakes: diffuse, spin and comb by the flow, settle, and the Manifold rod. */
const FLAKES = `
uniform sampler2D uDirector;
uniform sampler2D uVelocity;
uniform vec2 uDomain;         // (aspect, 1)
uniform vec2 uVelocityTexel;  // 1 / the velocity grid's size
uniform float uDt;
uniform float uAlign;
uniform float uSettle;
uniform float uSpread;        // diffusion, texels^2 per second
uniform float uHyper;         // hyperdiffusion, texels^4 per second
uniform vec4 uStroke;         // the Manifold rod's path this step: from xy to zw, frame heights
uniform vec2 uStrokePaint;    // its reach, and how firmly it lays the flakes (0: not painting)

// Turn a doubled-angle vector by angle.
vec2 pearlTurn(vec2 q, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
}

void main() {
  // Damping, mostly of the finest scales: the 13-point biharmonic takes stripes a texel or two
  // wide down within a second and barely touches bands of six texels and more. (Explicit: the
  // caps keep a checkerboard's factor, 1 - 8a - 64b, above -1.)
  vec2 q = texture(uDirector, vUv).xy;
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec2 sides = texture(uDirector, vUv + dx).xy + texture(uDirector, vUv - dx).xy
             + texture(uDirector, vUv + dy).xy + texture(uDirector, vUv - dy).xy;
  vec2 corners = texture(uDirector, vUv + dx + dy).xy + texture(uDirector, vUv + dx - dy).xy
               + texture(uDirector, vUv - dx + dy).xy + texture(uDirector, vUv - dx - dy).xy;
  vec2 far = texture(uDirector, vUv + 2.0 * dx).xy + texture(uDirector, vUv - 2.0 * dx).xy
           + texture(uDirector, vUv + 2.0 * dy).xy + texture(uDirector, vUv - 2.0 * dy).xy;
  vec2 laplacian = sides - 4.0 * q;
  vec2 biharmonic = 20.0 * q - 8.0 * sides + 2.0 * corners + far;
  q += min(uSpread * uDt, 0.03) * laplacian - min(uHyper * uDt, 0.025) * biharmonic;

  // The velocity gradient, per second: central differences two velocity texels wide, each averaged
  // over half a texel either side across it. Both are blind to a grid-scale checkerboard in the
  // velocity (which the projection cannot see) wherever the flake texel falls between velocity
  // texels, so the coarser grid never prints its own stripes into the flakes.
  vec2 hx = vec2(uVelocityTexel.x, 0.0);
  vec2 hy = vec2(0.0, uVelocityTexel.y);
  vec2 span = 4.0 * uVelocityTexel * uDomain;
  vec2 ddx = (texture(uVelocity, vUv + hx + 0.5 * hy).xy + texture(uVelocity, vUv + hx - 0.5 * hy).xy
            - texture(uVelocity, vUv - hx + 0.5 * hy).xy - texture(uVelocity, vUv - hx - 0.5 * hy).xy) / span.x;
  vec2 ddy = (texture(uVelocity, vUv + hy + 0.5 * hx).xy + texture(uVelocity, vUv + hy - 0.5 * hx).xy
            - texture(uVelocity, vUv - hy + 0.5 * hx).xy - texture(uVelocity, vUv - hy - 0.5 * hx).xy) / span.y;
  float spin = ddx.y - ddy.x;
  vec2 strain = 0.5 * vec2(ddx.x - ddy.y, ddy.x + ddx.y);

  // Jeffery: the flakes turn with the fluid, exactly, and strain combs them toward its stretching
  // axis (a step never combs more than halfway, however hard the shear).
  q = pearlTurn(q, spin * uDt);
  vec2 comb = 2.0 * uAlign * uDt * strain;
  comb *= min(1.0, 0.5 / max(length(comb), 1e-6));
  q += comb - dot(comb, q) * q;
  q *= exp(-uSettle * uDt);

  // The Manifold rod lays the flakes along its path, tilting them either way on its flanks as
  // the shear of its wake would: a satin ribbon with a bright edge and a dark one.
  if (uStrokePaint.y > 0.0) {
    vec2 p = vUv * uDomain;
    vec2 ab = uStroke.zw - uStroke.xy;
    float len = length(ab);
    vec2 m = len > 1e-6 ? ab / len : vec2(1.0, 0.0);
    vec2 ap = p - uStroke.xy;
    vec2 off = ap - clamp(dot(ap, m), 0.0, len) * m;
    float r = uStrokePaint.x;
    float across = dot(ap, vec2(-m.y, m.x));
    vec2 along = vec2(m.x * m.x - m.y * m.y, 2.0 * m.x * m.y);
    vec2 target = pearlTurn(along, -1.1 * clamp(across / r, -1.0, 1.0));
    float exposure = uStrokePaint.y * exp(-dot(off, off) / (r * r)) * min(len, 1.77 * r) / r;
    q = mix(q, target, 1.0 - exp(-exposure));
  }
  float order = length(q);
  if (order > 1.0) q /= order;
  fragColor = vec4(q, 0.0, 1.0);
}
`;

/** What enters the dye this step: heat and cool lid, pigment, the M's trace. */
const SOURCES = `
uniform sampler2D uDye;
uniform vec2 uDomain;
uniform float uDt;
uniform float uHeat;       // floor heating per second (0 unless convecting)
uniform float uHeatPhase;  // walks the heater's warmer and cooler spots
uniform vec4 uNozzle;      // the pigment nozzle: centre (frame heights), pigment per second, radius
uniform vec4 uStroke;      // the Manifold rod's path this step
uniform vec2 uTrace;       // its trace's reach and strength (0: none)

void main() {
  vec2 p = vUv * uDomain;
  vec4 dye = texture(uDye, vUv);
  if (uHeat > 0.0) {
    float floorBand = exp(-p.y / 0.03);
    float lid = exp(-(uDomain.y - p.y) / 0.03);
    float uneven = 1.0 + 0.4 * sin(6.2831853 * p.x / 0.43 + uHeatPhase)
                             * sin(6.2831853 * p.x / 0.71 - 0.6 * uHeatPhase + 1.3);
    dye.g += uDt * uHeat * (floorBand * uneven - lid * (dye.g + 0.6));
  }
  if (uNozzle.z > 0.0) {
    vec2 d = p - uNozzle.xy;
    dye.r = min(dye.r + uDt * uNozzle.z * exp(-dot(d, d) / (uNozzle.w * uNozzle.w)), 1.5);
  }
  if (uTrace.y > 0.0) {
    vec2 ab = uStroke.zw - uStroke.xy;
    vec2 ap = p - uStroke.xy;
    vec2 off = ap - clamp(dot(ap, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0) * ab;
    dye.b = max(dye.b, uTrace.y * exp(-dot(off, off) / (uTrace.x * uTrace.x)));
  }
  fragColor = dye;
}
`;

// ---- choreography -------------------------------------------------------------------------------

/** A rod's centre and velocity (frame heights, per second) and how far it is lowered in, 0..1. */
interface Rod {
  x: number;
  y: number;
  vx: number;
  vy: number;
  shown: number;
}

const rod = (): Rod => ({ x: 0, y: 0, vx: 0, vy: 0, shown: 0 });

/**
 * The turntable's angular acceleration (rad/s²): θ = A (1 − cos πs) / 2 over a turn, then a rest,
 * then back the other way. Each turn is a little longer or shorter than TURN_ANGLE (seeded), so the
 * tank never settles into one exact rhythm.
 */
function turntableAcceleration(time: number, seed: number): number {
  const leg = TURN_SECONDS + TURN_REST;
  const n = Math.floor(time / leg);
  const s = (time - n * leg) / TURN_SECONDS;
  if (s >= 1) return 0;
  const angle = (n % 2 === 0 ? 1 : -1) * TURN_ANGLE * (0.75 + 0.5 * hash31(n, 29, seed));
  return (angle * Math.PI * Math.PI * Math.cos(Math.PI * s)) / (2 * TURN_SECONDS * TURN_SECONDS);
}

function orbit(out: Rod, cx: number, cy: number, radius: number, angle: number, rate: number): void {
  out.x = cx + radius * Math.cos(angle);
  out.y = cy + radius * Math.sin(angle);
  out.vx = -radius * rate * Math.sin(angle);
  out.vy = radius * rate * Math.cos(angle);
  out.shown = 1;
}

/**
 * The braid at `time`: the pair on the left trades places clockwise (σ1), then the pair on the
 * right counter-clockwise (σ2⁻¹), each on a half circle eased in and out. Which rod is which does
 * not matter (they look alike), so a, b are the moving pair and c the one standing.
 */
function braidRods(time: number, aspect: number, a: Rod, b: Rod, c: Rod): void {
  const spacing = Math.min(BRAID_SPACING, 0.3 * aspect);
  const radius = 0.5 * spacing;
  const period = SWAP_SECONDS + SWAP_REST;
  const t = Math.max(0, time);
  const n = Math.floor(t / period);
  const s = Math.min(1, (t - n * period) / SWAP_SECONDS);
  const turn = 0.5 * Math.PI * (1 - Math.cos(Math.PI * s));
  const rate = s < 1 ? (0.5 * Math.PI * Math.PI * Math.sin(Math.PI * s)) / SWAP_SECONDS : 0;
  const left = n % 2 === 0;
  const sense = left ? -1 : 1;
  const cx = 0.5 * aspect + (left ? -radius : radius);
  orbit(a, cx, 0.5, radius, Math.PI + sense * turn, sense * rate);
  orbit(b, cx, 0.5, radius, sense * turn, sense * rate);
  c.x = 0.5 * aspect + (left ? spacing : -spacing);
  c.y = 0.5;
  c.vx = 0;
  c.vy = 0;
  c.shown = 1;
}

interface MarkStroke {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  length: number;
}

const markStroke = (k: number): MarkStroke => {
  const a = markVertex(k);
  const b = markVertex(k + 1);
  return { ax: a[0], ay: a[1], bx: b[0], by: b[1], length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
};

/** The Manifold M (mark.ts) as the four strokes the rod draws. */
const MARK_STROKES = [markStroke(0), markStroke(1), markStroke(2), markStroke(3)] as const;

/**
 * The Manifold rod `elapsed` seconds into writing an M of height `size` at the centre: lowered in
 * at the M's foot, drawn along each stroke (easing into every corner, as a hand does), lifted out.
 * Returns whether it is still in the tank.
 */
function markRod(elapsed: number, size: number, aspect: number, out: Rod): boolean {
  const cx = 0.5 * aspect;
  out.vx = 0;
  out.vy = 0;
  let t = elapsed;
  if (t < MARK_FADE) {
    const first = MARK_STROKES[0];
    out.x = cx + first.ax * size;
    out.y = 0.5 + first.ay * size;
    out.shown = smoothstep(0, 1, Math.max(0, t) / MARK_FADE);
    return true;
  }
  t -= MARK_FADE;
  for (const stroke of MARK_STROKES) {
    const duration = (MARK_EASE * stroke.length * size) / MARK_SPEED;
    if (t < duration) {
      const s = t / duration;
      const along = smoothstep(0, 1, s);
      const rate = (6 * s * (1 - s)) / duration;
      out.x = cx + (stroke.ax + (stroke.bx - stroke.ax) * along) * size;
      out.y = 0.5 + (stroke.ay + (stroke.by - stroke.ay) * along) * size;
      out.vx = (stroke.bx - stroke.ax) * size * rate;
      out.vy = (stroke.by - stroke.ay) * size * rate;
      out.shown = 1;
      return true;
    }
    t -= duration;
  }
  const last = MARK_STROKES[3];
  out.x = cx + last.bx * size;
  out.y = 0.5 + last.by * size;
  out.shown = 1 - smoothstep(0, 1, Math.min(1, t / MARK_FADE));
  return t < MARK_FADE;
}

// ---- the pour -----------------------------------------------------------------------------------

/** Smooth value noise, 0..1. */
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = smoothstep(0, 1, x - ix);
  const uy = smoothstep(0, 1, y - iy);
  const a = hash31(ix, iy, seed);
  const b = hash31(ix + 1, iy, seed);
  const c = hash31(ix, iy + 1, seed);
  const d = hash31(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * An eddy of the pour: a Gaussian stream function a·exp(−|p − c|² / r²) (a > 0 turns
 * counter-clockwise), which had already wound the fluid `twist` radians round at its centre.
 */
interface Eddy {
  x: number;
  y: number;
  r: number;
  a: number;
  twist: number;
}

/**
 * The pour's velocity at (x, y): the eddies' stream functions, times sin(πx / aspect) sin(πy) so it
 * vanishes on the walls and nothing flows through them. Writes (u, v) = (∂ψ/∂y, −∂ψ/∂x).
 */
function pourVelocity(eddies: readonly Eddy[], aspect: number, x: number, y: number, out: Float64Array): void {
  let g = 0;
  let gx = 0;
  let gy = 0;
  for (const eddy of eddies) {
    const dx = x - eddy.x;
    const dy = y - eddy.y;
    const e = eddy.a * Math.exp(-(dx * dx + dy * dy) / (eddy.r * eddy.r));
    const k = -2 / (eddy.r * eddy.r);
    g += e;
    gx += k * dx * e;
    gy += k * dy * e;
  }
  const sx = Math.sin((Math.PI * x) / aspect);
  const sy = Math.sin(Math.PI * y);
  const w = sx * sy;
  const wx = (Math.PI / aspect) * Math.cos((Math.PI * x) / aspect) * sy;
  const wy = Math.PI * sx * Math.cos(Math.PI * y);
  out[0] = w * gy + g * wy;
  out[1] = -(w * gx + g * wx);
}

/**
 * A drifting eddy: a vortex force wandering on a Lissajous path about (x, y) (shares of the width,
 * height) with amplitudes ax, ay and rates fx, fy (radians per second), its strength swelling,
 * fading and turning about at rate `beat`.
 */
interface Drifter {
  x: number;
  y: number;
  ax: number;
  ay: number;
  fx: number;
  fy: number;
  phaseX: number;
  phaseY: number;
  beat: number;
  phase: number;
  r: number;
}

// ---- knobs --------------------------------------------------------------------------------------

type PearlKnob = "forcing" | "speed" | "vorticity" | "drift" | "swirl" | "pour" | "pigment" | "mark";

// ---- the tank -----------------------------------------------------------------------------------

/** The fluid snippet's uniforms (a type literal, so it passes as a uniform record). */
type ForceUniforms = {
  uPearlEuler: number;
  uPearlBuoyancy: number;
  uPearlWallDrag: number;
  uPearlRods: Float32Array;
  uPearlGrip: Float32Array;
  uPearlSwirl: Float32Array;
  uPearlDrift: Float32Array;
};

type FlakeUniforms = {
  uDomain: Float32Array;
  uVelocityTexel: Float32Array;
  uDt: number;
  uAlign: number;
  uSettle: number;
  uSpread: number;
  uHyper: number;
  uStroke: Float32Array;
  uStrokePaint: Float32Array;
};

type SourceUniforms = {
  uDomain: Float32Array;
  uDt: number;
  uHeat: number;
  uHeatPhase: number;
  uNozzle: Float32Array;
  uStroke: Float32Array;
  uTrace: Float32Array;
};

class PearlTank implements SceneSim {
  readonly #gpu: GpuCompute;
  readonly #knobs: KnobReader<PearlKnob>;
  readonly #fluid: FluidSim;
  readonly #flakes: PingPong;
  readonly #props: RenderTarget;
  readonly #comb: Pass;
  readonly #source: Pass;

  readonly #domain = new Float32Array(2);
  readonly #stroke = new Float32Array(4);
  readonly #force: ForceUniforms = {
    uPearlEuler: 0,
    uPearlBuoyancy: 0,
    uPearlWallDrag: WALL_DRAG,
    uPearlRods: new Float32Array(16),
    uPearlGrip: new Float32Array([0, ROD_RADIUS, 0, ROD_RADIUS, 0, ROD_RADIUS, 0, MARK_ROD_RADIUS]),
    uPearlSwirl: new Float32Array([0, 0, 0, SWIRL_RADIUS]),
    uPearlDrift: new Float32Array(DRIFTERS * 4),
  };
  readonly #flakeUniforms: FlakeUniforms = {
    uDomain: this.#domain,
    uVelocityTexel: new Float32Array(2),
    uDt: 0,
    uAlign: ALIGN,
    uSettle: SETTLE,
    uSpread: SPREAD,
    uHyper: HYPER,
    uStroke: this.#stroke,
    uStrokePaint: new Float32Array(2),
  };
  readonly #sourceUniforms: SourceUniforms = {
    uDomain: this.#domain,
    uDt: 0,
    uHeat: 0,
    uHeatPhase: 0,
    uNozzle: new Float32Array([0, NOZZLE_Y, 0, NOZZLE_RADIUS]),
    uStroke: this.#stroke,
    uTrace: new Float32Array(2),
  };
  readonly #step: FluidStep = {
    dt: 0,
    time: 0,
    vorticity: 0,
    velocityDissipation: BOTTOM_FRICTION,
    dyeDissipation: DYE_FADE,
    uniforms: this.#force,
  };
  readonly #impulse = { velocity: new Float32Array(2) };
  readonly #rodA = rod();
  readonly #rodB = rod();
  readonly #rodC = rod();
  readonly #rodM = rod();
  readonly #propData = new Float32Array(PROP_TEXELS * 4);

  // The knobs, as of this frame.
  #forcing: PearlForcing = "turntable";
  #speed = 1;
  #vorticity = 0;
  #drift = 0;
  #pigment = 0;

  /** The pour on show; undefined until the first frame pours one. */
  #pour: number | undefined;
  /** The tank's own clock: seconds simulated since the pour. */
  #clock = 0;
  /** Easing shares of each forcing, the braid rods and the nozzle, 0..1. */
  #turnShare = 0;
  #convectShare = 0;
  #rodShare = 0;
  #nozzleShare = 0;
  #layoutAspect = 0;
  /** The pour's drifting eddies. */
  #drifters: readonly Drifter[] = [];

  #swirl: { start: number; strength: number } | undefined;
  #swirls = 0;
  #nextSwirl = SWIRL_FIRST;
  #mark: { start: number; size: number } | undefined;
  /** When the Manifold rod writes next; undefined while it is off. */
  #nextMark: number | undefined;
  readonly #swirlSlot: number;
  readonly #markSlot: number;
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined];
  #stirring = false;
  #lastX = 0;
  #lastY = 0;

  constructor(gpu: GpuCompute, knobs: KnobReader<PearlKnob>) {
    this.#gpu = gpu;
    this.#knobs = knobs;
    this.#swirlSlot = knobs.trigger("swirl");
    this.#markSlot = knobs.trigger("mark");
    const fluid = new FluidSim(gpu, {
      velocityResolution: VELOCITY_RESOLUTION,
      dyeResolution: DYE_RESOLUTION,
      dyeFormat: "rgba16f",
      dyeScheme: "linear",
      force: FORCE,
    });
    this.#fluid = fluid;
    this.#flakes = gpu.pingPong({ ...gridSize(fluid.aspect, FLAKE_RESOLUTION), format: "rg16f" });
    this.#props = gpu.target({ width: PROP_TEXELS, height: 1, format: "rgba32f", filter: "nearest" });
    this.#comb = gpu.pass(FLAKES, "pearl flakes").bind({ uDirector: this.#flakes, uVelocity: fluid.velocity });
    this.#source = gpu.pass(SOURCES, "pearl sources").bind({ uDye: fluid.dye });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    this.#read(frame);
    this.#layout(frame.width, frame.height);
    const pour = Math.round(this.#knobs.value(frame, "pour"));
    if (pour !== this.#pour) this.#reset(pour);
    this.#events(frame);
    const h = Math.max(0, frame.dt) * frame.motion * this.#speed;
    this.#stir(frame, h);
    if (h > 0) {
      const steps = Math.min(MAX_STEPS, Math.ceil(h / MAX_STEP));
      for (let i = 0; i < steps; i++) this.#advance(h / steps);
    }
    this.#writeProps();
    const textures = this.#textures;
    textures[0] = this.#flakes.texture;
    textures[1] = this.#fluid.dye.texture;
    textures[2] = this.#props.texture;
    return textures;
  }

  dispose(): void {
    this.#fluid.dispose();
    this.#gpu.dispose();
  }

  #read(frame: SimFrame): void {
    const knobs = this.#knobs;
    this.#forcing = knobs.pick(frame, "forcing", pearlForcings, "turntable");
    this.#speed = Math.max(0, knobs.value(frame, "speed"));
    this.#vorticity = Math.max(0, knobs.value(frame, "vorticity"));
    this.#drift = Math.max(0, knobs.value(frame, "drift"));
    this.#pigment = Math.max(0, knobs.value(frame, "pigment"));
  }

  /** Fit the grids to the frame (the fluid stretches what it holds over a new shape; so do the flakes). */
  #layout(width: number, height: number): void {
    const fluid = this.#fluid;
    fluid.resize(width, height);
    const aspect = fluid.aspect;
    if (aspect !== this.#layoutAspect) {
      this.#layoutAspect = aspect;
      const grid = gridSize(aspect, FLAKE_RESOLUTION);
      this.#flakes.resize(grid.width, grid.height, true);
      this.#domain[0] = aspect;
      this.#domain[1] = 1;
    }
    const texel = this.#flakeUniforms.uVelocityTexel;
    texel[0] = 1 / fluid.velocity.width;
    texel[1] = 1 / fluid.velocity.height;
  }

  /** A fresh pour: still events, the pour's eddies and sheen, then a few long steps to set it moving. */
  #reset(pour: number): void {
    this.#pour = pour;
    this.#clock = 0;
    this.#swirl = undefined;
    this.#swirls = 0;
    this.#nextSwirl = SWIRL_FIRST;
    this.#mark = undefined;
    this.#nextMark = undefined;
    this.#ease(1);
    this.#fluid.clear();
    this.#flakes.clear();
    this.#pourInto(pour);
    for (let i = 0; i < PREWARM_STEPS; i++) this.#advance(PREWARM_STEP);
  }

  /**
   * Seed the pour. A dozen eddies of many sizes (the velocity) had already wound the fluid round
   * before the scene opens: each flake texel is traced back through their twists to where it lay
   * in a silk of orientations varying at two scales, and its flakes turned with the fluid on the
   * way, so each eddy holds spiral arms and rings of satin. Over the heater the floor starts warm.
   * Also the drifting eddies that keep stirring the tank.
   */
  #pourInto(pour: number): void {
    const fluid = this.#fluid;
    const aspect = fluid.aspect;
    const rand = mulberry32(Math.imul(pour + 1, 0x9e3779b1));
    const eddies: Eddy[] = [];
    for (let i = 0; i < POUR_EDDIES; i++) {
      const r = POUR_RADIUS_MIN * (POUR_RADIUS_MAX / POUR_RADIUS_MIN) ** rand();
      const x = (0.06 + 0.88 * rand()) * aspect;
      const y = 0.06 + 0.88 * rand();
      const spin = rand() < 0.5 ? -1 : 1;
      const a = (spin * (0.6 + 0.6 * rand()) * POUR_SPIN * r * r) / 4;
      // Small eddies wind less, so their innermost rings stay a few cells wide.
      const twist = spin * (POUR_TWIST_MIN + (POUR_TWIST_MAX - POUR_TWIST_MIN) * rand()) * Math.min(1, r / 0.12);
      eddies.push({ x, y, r, a, twist });
    }
    const drifters: Drifter[] = [];
    for (let i = 0; i < DRIFTERS; i++) {
      drifters.push({
        x: 0.25 + 0.5 * rand(),
        y: 0.3 + 0.4 * rand(),
        ax: 0.1 + 0.12 * rand(),
        ay: 0.1 + 0.12 * rand(),
        fx: TAU / (90 + 150 * rand()),
        fy: TAU / (90 + 150 * rand()),
        phaseX: TAU * rand(),
        phaseY: TAU * rand(),
        beat: TAU / (50 + 70 * rand()),
        phase: TAU * rand(),
        r: DRIFT_RADIUS_MIN * (DRIFT_RADIUS_MAX / DRIFT_RADIUS_MIN) ** rand(),
      });
    }
    this.#drifters = drifters;
    const silk = Math.floor(rand() * 0x7fffffff);
    const ripple = Math.floor(rand() * 0x7fffffff);
    const sheen = Math.floor(rand() * 0x7fffffff);
    const flow = new Float64Array(2);

    const velocity = fluid.velocity;
    const v = new Float32Array(velocity.width * velocity.height * 2);
    for (let j = 0; j < velocity.height; j++) {
      const y = (j + 0.5) / velocity.height;
      for (let i = 0; i < velocity.width; i++) {
        pourVelocity(eddies, aspect, ((i + 0.5) / velocity.width) * aspect, y, flow);
        const k = 2 * (j * velocity.width + i);
        v[k] = flow[0] ?? 0;
        v[k + 1] = flow[1] ?? 0;
      }
    }
    velocity.seed(v);

    const flakes = this.#flakes;
    const q = new Float32Array(flakes.width * flakes.height * 2);
    for (let j = 0; j < flakes.height; j++) {
      const y = (j + 0.5) / flakes.height;
      for (let i = 0; i < flakes.width; i++) {
        const x = ((i + 0.5) / flakes.width) * aspect;
        // Back through each eddy's twist (a turn by −θ about its centre, θ falling off as a
        // Gaussian), adding up how far the fluid here has turned.
        let px = x;
        let py = y;
        let turned = 0;
        for (const eddy of eddies) {
          const dx = px - eddy.x;
          const dy = py - eddy.y;
          const reach = eddy.r * eddy.r;
          const d2 = dx * dx + dy * dy;
          if (d2 > 9 * reach) continue;
          const theta = eddy.twist * Math.exp(-d2 / reach);
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          px = eddy.x + c * dx + s * dy;
          py = eddy.y - s * dx + c * dy;
          turned += theta;
        }
        // Doubled angles: the silk turns a full circle across a broad noise cell and half one
        // across a fine one, and a flake turned by θ turns its doubled angle by 2θ.
        const phi = TAU * (valueNoise(px / 0.45, py / 0.45, silk) + 0.5 * valueNoise(px / 0.18, py / 0.18, ripple)) + 2 * turned;
        const order = 0.5 + 0.45 * valueNoise(px / 0.3, py / 0.3, sheen);
        const k = 2 * (j * flakes.width + i);
        q[k] = order * Math.cos(phi);
        q[k + 1] = order * Math.sin(phi);
      }
    }
    flakes.seed(q);

    if (this.#forcing === "convection") {
      const dye = fluid.dye;
      const d = new Float32Array(dye.width * dye.height * 4);
      for (let j = 0; j < dye.height; j++) {
        const y = (j + 0.5) / dye.height;
        for (let i = 0; i < dye.width; i++) {
          const x = ((i + 0.5) / dye.width) * aspect;
          const warm = WARM_FLOOR * Math.exp(-y / 0.05) * (0.7 + 0.6 * valueNoise(x / 0.2, 3.7, silk));
          d[4 * (j * dye.width + i) + 1] = warm - 0.5 * Math.exp(-(1 - y) / 0.05);
        }
      }
      dye.seed(d);
    }
  }

  /** Start, schedule and retire the swirls and the Manifold rod. */
  #events(frame: SimFrame): void {
    const knobs = this.#knobs;
    const clock = this.#clock;

    const swirl = knobs.value(frame, "swirl");
    if (frame.fired[this.#swirlSlot] === true) this.#startSwirl(knobs.amount(frame, "swirl"));
    else if (swirl > 0 && clock >= this.#nextSwirl) this.#startSwirl(swirl);
    if (swirl <= 0) this.#nextSwirl = Math.max(this.#nextSwirl, clock + SWIRL_RESUME);
    if (this.#swirl && clock >= this.#swirl.start + SWIRL_SECONDS) this.#swirl = undefined;

    const mark = knobs.value(frame, "mark");
    if (frame.fired[this.#markSlot] === true) this.#startMark(knobs.amount(frame, "mark"));
    else if (mark > 0 && this.#nextMark !== undefined && clock >= this.#nextMark) this.#startMark(mark);
    if (mark <= 0) this.#nextMark = undefined;
    else if (this.#nextMark === undefined) this.#nextMark = clock + MARK_FIRST;
    const run = this.#mark;
    if (run && !markRod(clock - run.start, run.size, this.#fluid.aspect, this.#rodM)) this.#mark = undefined;
  }

  /** A swirl from the centre, turning the other way each time so the tank never winds up. */
  #startSwirl(amount: number): void {
    const sense = this.#swirls % 2 === 0 ? 1 : -1;
    this.#swirl = { start: this.#clock, strength: sense * SWIRL_ACCEL * (0.4 + 1.2 * amount) };
    this.#swirls++;
    this.#nextSwirl = this.#clock + SWIRL_EVERY + SWIRL_JITTER * (hash31(this.#swirls, 17, this.#pour ?? 0) - 0.5);
  }

  #startMark(amount: number): void {
    // An M from 0.3 to 0.65 of the frame's height.
    this.#mark = { start: this.#clock, size: 0.3 + 0.35 * amount };
    this.#nextMark = this.#clock + MARK_EVERY;
  }

  #swirlAcceleration(time: number): number {
    const swirl = this.#swirl;
    if (!swirl) return 0;
    const u = (time - swirl.start) / SWIRL_SECONDS;
    if (u <= 0 || u >= 1) return 0;
    const bump = Math.sin(Math.PI * u);
    return swirl.strength * bump * bump;
  }

  /** Ease the forcing shares, the braid rods and the nozzle toward the knobs by share `k` (1: at once). */
  #ease(k: number): void {
    let turn = 0;
    let convect = 0;
    let rods = 0;
    switch (this.#forcing) {
      case "turntable":
        turn = 1;
        break;
      case "convection":
        convect = 1;
        break;
      case "rods":
        rods = 1;
        break;
      default: {
        const unreachable: never = this.#forcing;
        throw new PearlError(`pearl: unknown forcing ${String(unreachable)}`);
      }
    }
    this.#turnShare += (turn - this.#turnShare) * k;
    this.#convectShare += (convect - this.#convectShare) * k;
    this.#rodShare += (rods - this.#rodShare) * k;
    this.#nozzleShare += ((this.#pigment > 0 ? 1 : 0) - this.#nozzleShare) * k;
  }

  /**
   * Stir along the pointer's path while the button is held: splats a little apart along this
   * frame's stretch, each adding its share of the pointer's velocity, so a pass of the hand leaves
   * the fluid it crossed moving at about STIR_GAIN of its speed, whatever the frame rate.
   */
  #stir(frame: SimFrame, h: number): void {
    const pointer = frame.pointer;
    if (!pointer.inside || !pointer.down) {
      this.#stirring = false;
      return;
    }
    const was = this.#stirring;
    const x0 = this.#lastX;
    const y0 = this.#lastY;
    this.#stirring = true;
    this.#lastX = pointer.x;
    this.#lastY = pointer.y;
    if (!was || h <= 0 || frame.dt <= 0) return;
    const dx = (pointer.x - x0) * this.#fluid.aspect;
    const dy = pointer.y - y0;
    const travel = Math.hypot(dx, dy);
    if (travel < 1e-6) return;
    const gain = Math.min(STIR_GAIN, (STIR_MAX * frame.dt) / travel);
    const n = Math.min(STIR_SPLATS, Math.max(1, Math.ceil(travel / (0.5 * STIR_RADIUS))));
    const k = ((gain / frame.dt) * (travel / n)) / (1.77 * STIR_RADIUS);
    const impulse = this.#impulse;
    impulse.velocity[0] = dx * k;
    impulse.velocity[1] = dy * k;
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      this.#fluid.splat(x0 + (pointer.x - x0) * s, y0 + (pointer.y - y0) * s, STIR_RADIUS, impulse);
    }
  }

  /** Hand a rod to the fluid snippet, in slot 0..3. */
  #grip(slot: number, at: Rod, grip: number): void {
    const rods = this.#force.uPearlRods;
    rods[4 * slot] = at.x;
    rods[4 * slot + 1] = at.y;
    rods[4 * slot + 2] = at.vx;
    rods[4 * slot + 3] = at.vy;
    this.#force.uPearlGrip[2 * slot] = grip;
  }

  /**
   * The Manifold rod's path from t0 to t1, for the flakes and the trace; false while it is not in
   * the fluid.
   */
  #paint(t0: number, t1: number): boolean {
    const paint = this.#flakeUniforms.uStrokePaint;
    const trace = this.#sourceUniforms.uTrace;
    paint[1] = 0;
    trace[1] = 0;
    const run = this.#mark;
    if (!run) return false;
    const at = this.#rodM;
    const aspect = this.#fluid.aspect;
    markRod(t0 - run.start, run.size, aspect, at);
    const x0 = at.x;
    const y0 = at.y;
    const shown0 = at.shown;
    markRod(t1 - run.start, run.size, aspect, at);
    const shown = Math.min(shown0, at.shown);
    if (shown <= 0.5) return false;
    const stroke = this.#stroke;
    stroke[0] = x0;
    stroke[1] = y0;
    stroke[2] = at.x;
    stroke[3] = at.y;
    paint[0] = MARK_PAINT_RADIUS;
    paint[1] = MARK_PAINT * shown;
    trace[0] = MARK_TRACE_RADIUS;
    trace[1] = shown;
    return true;
  }

  /** One step of `h` seconds: sources, fluid, flakes. */
  #advance(h: number): void {
    const fluid = this.#fluid;
    const aspect = fluid.aspect;
    const t0 = this.#clock;
    const t1 = t0 + h;
    const mid = t0 + 0.5 * h;
    this.#ease(1 - Math.exp(-h / BLEND_SECONDS));

    const force = this.#force;
    force.uPearlEuler = this.#turnShare * turntableAcceleration(mid, this.#pour ?? 0);
    force.uPearlBuoyancy = this.#convectShare * BUOYANCY;
    braidRods(mid, aspect, this.#rodA, this.#rodB, this.#rodC);
    this.#grip(0, this.#rodA, this.#rodShare);
    this.#grip(1, this.#rodB, this.#rodShare);
    this.#grip(2, this.#rodC, this.#rodShare);
    const run = this.#mark;
    const m = this.#rodM;
    if (run) markRod(mid - run.start, run.size, aspect, m);
    else m.shown = 0;
    this.#grip(3, m, m.shown);
    const swirl = force.uPearlSwirl;
    swirl[0] = 0.5 * aspect;
    swirl[1] = 0.5;
    swirl[2] = this.#swirlAcceleration(mid);
    const drift = force.uPearlDrift;
    const strength = DRIFT_ACCEL * this.#drift;
    let at = 0;
    for (const d of this.#drifters) {
      drift[at] = (d.x + d.ax * Math.sin(d.fx * mid + d.phaseX)) * aspect;
      drift[at + 1] = d.y + d.ay * Math.sin(d.fy * mid + d.phaseY);
      drift[at + 2] = strength * Math.sin(d.beat * mid + d.phase);
      drift[at + 3] = d.r;
      at += 4;
    }

    const painting = this.#paint(t0, t1);
    const heat = this.#convectShare * HEAT;
    const drip = this.#pigment > 0 ? (PIGMENT_BASE + PIGMENT_RATE * this.#pigment) * this.#nozzleShare : 0;
    if (heat > 1e-3 || drip > 0 || painting) {
      const source = this.#sourceUniforms;
      source.uDt = h;
      source.uHeat = heat > 1e-3 ? heat : 0;
      source.uHeatPhase = HEATER_DRIFT * mid;
      source.uNozzle[0] = NOZZLE_X * aspect;
      source.uNozzle[2] = drip;
      this.#source.set(source).run(fluid.dye);
    }

    const step = this.#step;
    step.dt = h;
    step.time = t1;
    step.vorticity = this.#vorticity;
    fluid.step(step);

    this.#flakeUniforms.uDt = h;
    this.#comb.set(this.#flakeUniforms).run(this.#flakes);
    fluid.advect(this.#flakes);
    this.#clock = t1;
  }

  /** The props texture: where the rods and the nozzle stand now. */
  #writeProps(): void {
    const aspect = this.#fluid.aspect;
    braidRods(this.#clock, aspect, this.#rodA, this.#rodB, this.#rodC);
    this.#prop(0, this.#rodA, this.#rodShare, ROD_RADIUS);
    this.#prop(1, this.#rodB, this.#rodShare, ROD_RADIUS);
    this.#prop(2, this.#rodC, this.#rodShare, ROD_RADIUS);
    const run = this.#mark;
    const m = this.#rodM;
    if (run) markRod(this.#clock - run.start, run.size, aspect, m);
    else m.shown = 0;
    this.#prop(3, m, m.shown, MARK_ROD_RADIUS);
    const data = this.#propData;
    data[16] = NOZZLE_X * aspect;
    data[17] = NOZZLE_Y;
    data[18] = this.#nozzleShare;
    data[19] = this.#convectShare;
    this.#props.seed(data);
  }

  /** One rod's texel of the props texture. */
  #prop(texel: number, at: Rod, shown: number, radius: number): void {
    const data = this.#propData;
    data[4 * texel] = at.x;
    data[4 * texel + 1] = at.y;
    data[4 * texel + 2] = shown;
    data[4 * texel + 3] = radius;
  }
}

/** Where float render targets are missing: no textures (it holds no state), and the shader draws still eddies. */
const stillTank: SceneSim = {
  frame: () => [],
  dispose: () => undefined,
};

/** The tank of pearl fluid, for a scene whose `params` carry the knobs `PearlKnob` names. */
export function pearlSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<PearlKnob>("pearl", params, ["forcing", "speed", "vorticity", "drift", "swirl", "pour", "pigment", "mark"]);
  return (gl) => {
    const gpu = GpuCompute.create(gl);
    if (!gpu) return stillTank;
    try {
      return new PearlTank(gpu, knobs);
    } catch (error: unknown) {
      gpu.dispose();
      if (!(error instanceof GpuError)) throw error;
      console.error("evt=landing.pearl.sim_failed", error);
      return stillTank;
    }
  };
}
