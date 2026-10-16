// A 2D incompressible fluid on the GPU (sims/gpu.ts): incense smoke, soap films, rheoscopic
// swirls. Stable fluids (J. Stam, "Stable Fluids", SIGGRAPH 1999) on a velocity grid, carrying a
// finer dye grid the scene paints with.
//
// Units. Lengths are frame heights: the frame spans p = uv * uDomain, uDomain = (aspect, 1), so
// circles stay round at any aspect. Velocity is in frame heights per second (stored rg16f); splat
// positions are uv. The velocity grid has `velocityResolution` texels on the frame's short side
// (default 128: 228×128 at 16:9), the dye grid `dyeResolution` (default 384: 683×384), both with
// square texels.
//
// One `step`:
//   1. obstacle   the obstacle snippet's signed distance → r8 coverage per velocity cell
//   2. curl       ω = ∂v/∂x − ∂u/∂y (per second, counter-clockwise positive)
//   3. forces     vorticity confinement (Fedkiw, Stam & Jensen, "Visual Simulation of Smoke",
//                 SIGGRAPH 2001) plus the scene's force snippet, v += dt · a
//   4. advect     the velocity carries itself (semi-Lagrangian, midpoint back-trace), fading
//   5. divergence of the velocity; walls and the obstacle let nothing through their faces
//   6. pressure   ∇²p = ∇·v by one multigrid V-cycle (`cycles`), started from the last step's
//                 pressure: a red–black Gauss–Seidel sweep on each level of a pyramid of grids,
//                 each half the last, the residual handed down, the coarsest (≤ 16 cells) solved
//                 outright, each level's correction carried back up and swept again
//   7. project    v −= ∇p: divergence free, zero inside the obstacle
//   8. dye        carried by the projected velocity: MacCormack (Selle, Fedkiw, Kim, Liu &
//                 Rossignac, "An Unconditionally Stable MacCormack Method", 2008), clamped to the
//                 texels it read so it never rings, or plain semi-Lagrangian; then faded
// Splats queued since the last step land first. `advect(field)` carries any other ping-pong field
// (a director field, a second dye) with the velocity of the last step. Pressure is kept in
// velocity units (p divided by a velocity texel's height), in 32-bit floats: the solve converges
// further than half floats resolve.
//
// Incompressible at every scale. One V-cycle from rest removes over 80 % of the divergence at
// every wavelength the frame holds, its longest included (a little less beside an obstacle), and
// started from the last step's pressure it leaves a few percent: dye neither piles up where the
// flow converges nor thins where it spreads. (The 20 Jacobi sweeps this replaced removed under
// 10 % at the frame's scale, so a steady source such as buoyancy built divergence up to ten times
// and more what one step adds.) What remains is the collocated grid's own floor: velocities live
// at cell centres, so the projected field keeps a little divergence at the scale of a texel and in
// the cells along walls and the obstacle, most along a curved wall (sims/fluid.verify.ts).
//
// Edges (`boundary`, each "wall" by default): "wall" is a free-slip wall (nothing crosses it,
// fluid slides along it), "open" lets fluid leave and enter (pressure 0 beyond it; dye flows in
// empty), "wrap" joins it to the opposite edge, which must wrap too. A plume wants open sides
// and top; a film in a frame wants walls; a tank of pearl fluid may wrap.
//
// Force snippet (`force`): GLSL defining
//     vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye)
// uv 0..1; p = uv * uDomain; velocity in frame heights per second; dye averaged over the velocity
// cell (so a thin wisp still pushes). Returns an acceleration in frame heights per second². It may
// read uTime, uDt, uDomain, uTexel and uSize (of the velocity grid) and the samplers uVelocity,
// uDye and uCurl, and declare its own uniforms and samplers (fed through `step`'s `uniforms` and
// `textures`). Buoyancy: `return vec2(0.0, uBuoyancy * dye.g);` with temperature in dye.g.
//
// Obstacle snippet (`obstacle`): GLSL defining
//     float fluidObstacle(vec2 p)   // signed distance in frame heights, negative inside
// re-evaluated every step at the velocity grid (so it may move with uTime or its own uniforms;
// the fluid is pushed out of it as it moves, it does not drag the fluid along). Velocity and dye
// are emptied inside it, so deposit dye just outside (above an incense tip, not in it). `solid`
// is its coverage per velocity cell, for the scene's shader; scenes usually draw the solid from
// the same distance function at full resolution.
//
// Uniform names the solver uses itself (uTexel, uSize, uDomain, uVelocity, uCurl, uDye, uSolid,
// uDt, uTime, uVorticity) and the fluid* function prefix are reserved.
//
// Cost per step at the defaults, 16:9 (velocity 228×128 = 29,184 texels, dye 683×384 = 262,272):
//   pass          reads/texel       pass          reads/texel
//   curl          4                 divergence    5  (+5 with an obstacle)
//   forces        6  (+4 force)     pressure      ≈ 51 (+5 with an obstacle), in 25 draws
//   advect        3  (+1 obstacle)  project       6  (+2)
//   dye           13 MacCormack (forward 3, correction 10), 3 semi-Lagrangian
// The V-cycle reads 38 per velocity texel on the velocity grid (a sweep each way, 13 on average:
// a black cell relaxes its four red neighbours itself; the residual handed down, 7; the correction
// back, 5) and a third as much again on the coarser levels, in 4 draws per level but the coarsest
// and 1 for that: 25 for 228×128's seven levels.
// ≈ 2.2 M reads on the velocity grid and 3.4 M on the dye (0.8 M semi-Lagrangian), in 32 draws
// (+1 with an obstacle, +1 per batch of up to 16 splats per grid, +2 per `advect`ed field with
// MacCormack, +1 semi-Lagrangian). That is well under a millisecond on an integrated GPU; on a
// software rasterizer (SwiftShader) budget tens of milliseconds, and prewarm with few, long steps
// (semi-Lagrangian advection stays stable at dt = 0.1). Memory ≈ 0.9 MB on the velocity side,
// 6.3 MB for an rgba16f dye with its MacCormack scratch.
//
// Example: an incense stick. dye.r is smoke, dye.g heat; heat rises and fades fast, smoke lingers.
//
//   const gpu = GpuCompute.create(gl);
//   if (!gpu) return fallbackSim(gl);
//   const fluid = new FluidSim(gpu, {
//     boundary: { left: "open", right: "open", top: "open" },   // the floor stays a wall
//     force: `
//       uniform float uBuoyancy;
//       vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
//         return vec2(0.0, uBuoyancy * dye.g - 0.03 * dye.r);   // warm air rises, smoke weighs
//       }`,
//     obstacle: `
//       float fluidObstacle(vec2 p) {                            // the stick, tip at y = 0.3
//         vec2 q = abs(p - vec2(0.5 * uDomain.x, 0.15)) - vec2(0.004, 0.15);
//         return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
//       }`,
//   });
//   const burn = (dt: number, time: number) => {
//     fluid.splat(0.5, 0.306, 0.006, { dye: [1.2 * dt, 3 * dt] });   // the ember, per second
//     fluid.step({ dt, time, vorticity: 8, dyeDissipation: [0.06, 0.9], uniforms: { uBuoyancy: 0.5 } });
//   };
//   for (let i = 0; i < 40; i++) burn(1 / 20, i / 20);             // prewarm: a plume already up
//   let last: { x: number; y: number } | undefined;
//   return {
//     frame(frame) {
//       fluid.resize(frame.width, frame.height);
//       const dt = frame.dt * frame.motion;
//       const pointer = frame.pointer;
//       if (dt > 0 && pointer.inside && last) {                      // a hand waved through the smoke
//         const vx = ((pointer.x - last.x) * frame.aspect) / dt, vy = (pointer.y - last.y) / dt;
//         fluid.splat(pointer.x, pointer.y, 0.05, { velocity: [0.3 * vx, 0.3 * vy] });
//       }
//       last = pointer.inside ? { x: pointer.x, y: pointer.y } : undefined;
//       burn(dt, frame.time);
//       return [fluid.dye.texture, fluid.velocity.texture];          // read .texture every frame
//     },
//     dispose: () => gpu.dispose(),
//   };
import {
  GpuError,
  gridSize,
  type GpuCompute,
  type Pass,
  type PingPong,
  type RenderTarget,
  type RunOptions,
  type TargetWrap,
  type TextureSource,
  type UniformValue,
} from "./gpu.ts";

export type FluidEdge = "wall" | "open" | "wrap";

/** Each edge of the frame; any not given is a wall. */
export interface FluidBoundary {
  left?: FluidEdge;
  right?: FluidEdge;
  bottom?: FluidEdge;
  top?: FluidEdge;
}

/** "maccormack" keeps fields crisp for ~4× the reads; "linear" (semi-Lagrangian) blurs a little each step. */
export type AdvectScheme = "linear" | "maccormack";

export type DyeFormat = "r16f" | "rg16f" | "rgba16f";

export interface FluidOptions {
  /**
   * The frame's size (any unit: only the aspect matters). Defaults to the drawing buffer, which
   * is already the frame's size when the renderer builds a scene's sim.
   */
  width?: number;
  height?: number;
  /** Velocity texels on the frame's short side. Default 128. */
  velocityResolution?: number;
  /** Dye texels on the frame's short side. Default 384. */
  dyeResolution?: number;
  /** Default "rgba16f". */
  dyeFormat?: DyeFormat;
  boundary?: FluidBoundary;
  /** How the dye is carried. Default "maccormack". */
  dyeScheme?: AdvectScheme;
  /** GLSL defining `vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye)` (see the file header). */
  force?: string;
  /** GLSL defining `float fluidObstacle(vec2 p)` (see the file header). */
  obstacle?: string;
}

export interface FluidStep {
  /** Seconds to advance: usually frame.dt * frame.motion. At 0 only queued splats and uniforms land. */
  dt: number;
  /** uTime for the snippets. Default 0. */
  time?: number;
  /**
   * Multigrid V-cycles of the pressure solve. Default 1: started from the last step's pressure,
   * one leaves a few percent of the divergence; more only help a flow torn up from step to step.
   */
  cycles?: number;
  /**
   * Vorticity confinement ε (Fedkiw et al., with h one velocity texel): 0 off, ~5–15 curling
   * smoke, 30+ boils. Default 0.
   */
  vorticity?: number;
  /** Velocity fade per second (exponential rate). Default 0. */
  velocityDissipation?: number;
  /** Dye fade per second: one rate, or one per channel (missing ones 0). Default 0. */
  dyeDissipation?: number | ArrayLike<number>;
  /** The snippets' own uniforms (they persist, so set them when they change). */
  uniforms?: Readonly<Record<string, UniformValue>>;
  /** The snippets' own samplers (they persist). */
  textures?: Readonly<Record<string, TextureSource>>;
}

export interface SplatImpulse {
  /** Velocity added at the centre, frame heights per second (x, y). */
  velocity?: ArrayLike<number>;
  /** Dye added at the centre, per channel (missing ones 0). */
  dye?: ArrayLike<number>;
}

export interface AdvectOptions {
  /** Fade per second: one rate, or one per channel. Default 0. */
  dissipation?: number | ArrayLike<number>;
  /** Default: the sim's dyeScheme. */
  scheme?: AdvectScheme;
}

/** Invalid fluid options or snippet uniforms. */
export class FluidError extends GpuError {}

/** Splats per batch: the splat pass loops over at most this many. */
const SPLATS = 16;
const DEFAULT_VELOCITY_RESOLUTION = 128;
const DEFAULT_DYE_RESOLUTION = 384;
const DEFAULT_CYCLES = 1;
/** The pressure solve's coarsest level has at most this many cells, solved outright in one pass. */
const COARSEST_CELLS = 16;
/** Gauss–Seidel sweeps of that outright solve (in registers, per fragment). */
const COARSEST_SWEEPS = 32;
/** Coarsest grid the solver accepts on the short side. */
const MIN_RESOLUTION = 8;
const KEEP_ALL: readonly number[] = [1, 1, 1, 1];

const RESERVED: Readonly<Record<string, true>> = {
  uTexel: true,
  uSize: true,
  uDomain: true,
  uVelocity: true,
  uCurl: true,
  uDye: true,
  uSolid: true,
  uDt: true,
  uTime: true,
  uVorticity: true,
};

const EDGE_CODE: Readonly<Record<FluidEdge, number>> = { wall: 0, open: 1, wrap: 2 };

interface Edges {
  readonly left: FluidEdge;
  readonly right: FluidEdge;
  readonly bottom: FluidEdge;
  readonly top: FluidEdge;
}

// ---- GLSL ---------------------------------------------------------------------------------------

/**
 * Every pass starts with the sim's own defines (FLUID_LEFT, FLUID_RIGHT, FLUID_BOTTOM, FLUID_TOP
 * as edge kinds, FLUID_OBSTACLE, FLUID_FORCE as 0 / 1), then this.
 */
const EDGE_TESTS = `#define FLUID_WALL 0
#define FLUID_OPEN 1
#define FLUID_WRAP 2

// The frame in frame heights, (aspect, 1): the point at uv is p = uv * uDomain.
uniform vec2 uDomain;

// Whether uv lies past an edge of this kind (FLUID_WALL or FLUID_OPEN).
bool fluidBeyond(vec2 uv, int kind) {
  return (FLUID_LEFT == kind && uv.x < 0.0) || (FLUID_RIGHT == kind && uv.x > 1.0)
      || (FLUID_BOTTOM == kind && uv.y < 0.0) || (FLUID_TOP == kind && uv.y > 1.0);
}
`;

const SOLID = `
#if FLUID_OBSTACLE
uniform sampler2D uSolid;
// Share of the velocity cell at uv inside the obstacle, 0..1 (0.5 on its surface).
float fluidCoverage(vec2 uv) {
  return texture(uSolid, uv).x;
}
#else
float fluidCoverage(vec2 uv) {
  return 0.0;
}
#endif
bool fluidSolid(vec2 uv) {
  return fluidCoverage(uv) > 0.5;
}
`;

const TRACE = `
uniform sampler2D uVelocity;
uniform float uDt;
// Where the fluid now at uv was dt seconds ago (where it will be, for dt < 0), by the midpoint
// rule from its velocity there: second order, so eddies keep their shape.
vec2 fluidTrace(vec2 uv, vec2 velocity, float dt) {
  vec2 mid = uv - 0.5 * dt * velocity / uDomain;
  return uv - dt * texture(uVelocity, mid).xy / uDomain;
}
`;

const OBSTACLE_HEAD = `
uniform float uTime;
`;

const OBSTACLE_MAIN = `
void main() {
  // The share of this cell inside the obstacle, from the signed distance at its centre.
  float cell = uTexel.y * uDomain.y;
  fragColor = vec4(clamp(0.5 - fluidObstacle(vUv * uDomain) / cell, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const CURL = `
uniform sampler2D uVelocity;
void main() {
  vec2 cell = uTexel * uDomain;
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  float dv = texture(uVelocity, vUv + dx).y - texture(uVelocity, vUv - dx).y;
  float du = texture(uVelocity, vUv + dy).x - texture(uVelocity, vUv - dy).x;
  fragColor = vec4(0.5 * (dv / cell.x - du / cell.y), 0.0, 0.0, 1.0);
}
`;

const FORCES_HEAD = `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uDye;
uniform float uDt;
uniform float uTime;
uniform float uVorticity;
`;

const FORCES_MAIN = `
void main() {
  vec2 cell = uTexel * uDomain;
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec2 velocity = texture(uVelocity, vUv).xy;
  // Vorticity confinement: spin each eddy up along N x w, N pointing up the slope of |w|, giving
  // back the small curls the grid's numerical diffusion smooths away.
  float curl = texture(uCurl, vUv).x;
  vec2 slope = 0.5 * vec2(
    abs(texture(uCurl, vUv + dx).x) - abs(texture(uCurl, vUv - dx).x),
    abs(texture(uCurl, vUv + dy).x) - abs(texture(uCurl, vUv - dy).x)) / cell;
  vec2 n = slope / (length(slope) + 1e-4);
  vec2 force = uVorticity * cell.y * curl * vec2(n.y, -n.x);
#if FLUID_FORCE
  // The dye averaged over this velocity cell: four bilinear taps cover the finer dye grid.
  vec2 q = 0.25 * uTexel;
  vec4 dye = 0.25 * (texture(uDye, vUv - q) + texture(uDye, vUv + q)
                   + texture(uDye, vUv + vec2(q.x, -q.y)) + texture(uDye, vUv + vec2(-q.x, q.y)));
  force += fluidForce(vUv, vUv * uDomain, velocity, dye);
#endif
  fragColor = vec4(velocity + uDt * force, 0.0, 1.0);
}
`;

const ADVECT = `
uniform sampler2D uSource;
uniform vec4 uKeep;    // share of each channel kept this step
uniform float uClean;  // 1: what enters through an open edge is empty (dye); 0: the edge's value
uniform float uMask;   // 1: empty the obstacle
void main() {
  vec2 back = fluidTrace(vUv, texture(uVelocity, vUv).xy, uDt);
  vec4 value = texture(uSource, back);
  if (uClean > 0.5 && fluidBeyond(back, FLUID_OPEN)) value = vec4(0.0);
  fragColor = value * uKeep * (1.0 - uMask * smoothstep(0.4, 0.6, fluidCoverage(vUv)));
}
`;

const CORRECT = `
uniform sampler2D uSource;   // the field now
uniform sampler2D uForward;  // its plain semi-Lagrangian step
uniform vec4 uKeep;
uniform float uClean;
void main() {
  // Step forward, trace the result back, correct by half the round trip's error; then clamp to
  // the four texels the back-trace read, so the correction never makes a new extreme.
  vec2 velocity = texture(uVelocity, vUv).xy;
  vec2 back = fluidTrace(vUv, velocity, uDt);
  vec2 ahead = fluidTrace(vUv, velocity, -uDt);
  vec4 value = texture(uForward, vUv) + 0.5 * (texture(uSource, vUv) - texture(uForward, ahead));
  vec2 corner = (floor(back * uSize - 0.5) + 0.5) * uTexel;
  vec4 a = texture(uSource, corner);
  vec4 b = texture(uSource, corner + vec2(uTexel.x, 0.0));
  vec4 c = texture(uSource, corner + vec2(0.0, uTexel.y));
  vec4 d = texture(uSource, corner + uTexel);
  value = clamp(value, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
  if (uClean > 0.5 && fluidBeyond(back, FLUID_OPEN)) value = vec4(0.0);
  fragColor = value * uKeep * (1.0 - smoothstep(0.4, 0.6, fluidCoverage(vUv)));
}
`;

const DIVERGENCE = `
uniform sampler2D uVelocity;
void main() {
  vec2 cell = uTexel * uDomain;
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec2 c = texture(uVelocity, vUv).xy;
  float l = texture(uVelocity, vUv - dx).x;
  float r = texture(uVelocity, vUv + dx).x;
  float b = texture(uVelocity, vUv - dy).y;
  float t = texture(uVelocity, vUv + dy).y;
  // Nothing crosses a wall: mirror the normal velocity into it, so the face between is still.
  if (fluidBeyond(vUv - dx, FLUID_WALL)) l = -c.x;
  if (fluidBeyond(vUv + dx, FLUID_WALL)) r = -c.x;
  if (fluidBeyond(vUv - dy, FLUID_WALL)) b = -c.y;
  if (fluidBeyond(vUv + dy, FLUID_WALL)) t = -c.y;
  // The same at the obstacle's faces, closing them for the pressure passes; a solid cell is closed
  // on every side.
  vec4 open = vec4(1.0);
#if FLUID_OBSTACLE
  if (fluidSolid(vUv - dx)) { l = -c.x; open.x = 0.0; }
  if (fluidSolid(vUv + dx)) { r = -c.x; open.y = 0.0; }
  if (fluidSolid(vUv - dy)) { b = -c.y; open.z = 0.0; }
  if (fluidSolid(vUv + dy)) { t = -c.y; open.w = 0.0; }
#endif
  // Times a texel's height, so the solve runs in velocity units.
  float divergence = 0.5 * ((r - l) * cell.y / cell.x + (t - b));
  if (fluidSolid(vUv)) {
    divergence = 0.0;
    open = vec4(0.0);
  }
  fragColor = vec4(divergence, fluidPack(open), 0.0, 1.0);
}
`;

/**
 * The pressure solve: one multigrid V-cycle (or `cycles`) of ∇²p = ∇·v a step, warm-started from
 * the last step's pressure. Level 0 is the velocity grid (x the pressure, the right-hand side the
 * divergence); each level below halves the one above (rounding up) over the same frame, down to at
 * most COARSEST_CELLS cells, and solves for the error of the level above (x a correction, the
 * right-hand side its residual). A coarse cell gathers the finer cells whose centres fall in it.
 * Every cell carries how open each of its faces is: 1 between fluid cells, 0 at the obstacle; a
 * coarse face is the mean of the finer faces along it, so the obstacle stays closed all the way
 * down. Edges hold on every level as on the finest: nothing through a wall, the opposite edge
 * across a wrap, and past an open edge a pressure of 0 half a finest cell out.
 */
const FACES = `
// How open the faces of a cell are (left, right, below, above), 0..1, in sixteenths, packed 5 bits
// each into one float (exact in 32 bits). Without an obstacle every face is open.
float fluidPack(vec4 open) {
  ivec4 q = ivec4(clamp(open, 0.0, 1.0) * 16.0 + 0.5);
  return float(q.x | (q.y << 5) | (q.z << 10) | (q.w << 15));
}

vec4 fluidUnpack(float packed) {
#if FLUID_OBSTACLE
  int p = int(packed + 0.5);
  return vec4(ivec4(p, p >> 5, p >> 10, p >> 15) & 31) / 16.0;
#else
  return vec4(1.0);
#endif
}
`;

const LEVEL = `
uniform vec2 uFine;      // level 0's size in texels
uniform sampler2D uX;    // the level's x
uniform sampler2D uRhs;  // the level's right-hand side and packed faces

// The level worked on: its size; k = (cell height / cell width)^2, the weight of its left and
// right faces against those below and above; and how far beyond its outermost centres, in its own
// cells, an open edge's zero pressure lies.
ivec2 gSize;
float gK;
vec2 gGap;

void fluidLevel(ivec2 size) {
  gSize = size;
  float ratio = float(size.x) * uDomain.y / (uDomain.x * float(size.y));
  gK = ratio * ratio;
  gGap = 0.5 + 0.5 * vec2(size) / uFine;
}

const ivec2 FLUID_FACE[4] = ivec2[4](ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));

// The cell across face f (left, right, below, above) of q, round a wrapping edge. False past a
// wall or an open edge, with the face's share of the diagonal there in open: 1 / gap past an open
// edge (the pressure falls linearly to 0 at the gap), 0 past a wall.
bool fluidAcross(ivec2 q, int f, out ivec2 n, out float open) {
  n = q + FLUID_FACE[f];
  open = 0.0;
  if (n.x < 0 || n.x >= gSize.x) {
#if FLUID_LEFT == FLUID_WRAP
    n.x = (n.x + gSize.x) % gSize.x;
#else
    if ((n.x < 0 ? FLUID_LEFT : FLUID_RIGHT) == FLUID_OPEN) open = 1.0 / gGap.x;
    return false;
#endif
  }
  if (n.y < 0 || n.y >= gSize.y) {
#if FLUID_BOTTOM == FLUID_WRAP
    n.y = (n.y + gSize.y) % gSize.y;
#else
    if ((n.y < 0 ? FLUID_BOTTOM : FLUID_TOP) == FLUID_OPEN) open = 1.0 / gGap.y;
    return false;
#endif
  }
  return true;
}

// The level's equation at q, sum over faces of k_f open_f (x_across - x_q) = rhs_q, as
// (sum k_f open_f x_across, the diagonal sum k_f open_f, rhs_q); x is 0 on a fresh level.
vec3 fluidStencil(ivec2 q, bool fresh) {
  vec2 rhs = texelFetch(uRhs, q, 0).xy;
  vec4 weight = fluidUnpack(rhs.y) * vec4(gK, gK, 1.0, 1.0);
  float sum = 0.0;
  float diagonal = 0.0;
  for (int f = 0; f < 4; f++) {
    if (weight[f] <= 0.0) continue;
    ivec2 n;
    float open;
    if (fluidAcross(q, f, n, open)) {
      diagonal += weight[f];
      if (!fresh) sum += weight[f] * texelFetch(uX, n, 0).x;
    } else {
      diagonal += weight[f] * open;
    }
  }
  return vec3(sum, diagonal, rhs.x);
}
`;

// One red–black Gauss–Seidel sweep in one pass: a red cell (i + j even) relaxes against its
// neighbours' x, a black cell against its red neighbours as this sweep leaves them, recomputing
// each. A cell closed on every side holds 0.
const SMOOTH = `
uniform bool uFresh;  // the level's x is not set yet this cycle: start from 0

float fluidRelax(ivec2 q) {
  vec3 s = fluidStencil(q, uFresh);
  return s.y > 0.0 ? (s.x - s.z) / s.y : 0.0;
}

void main() {
  fluidLevel(ivec2(uSize));
  ivec2 q = ivec2(gl_FragCoord.xy);
  float x;
  if (((q.x + q.y) & 1) == 0) {
    x = fluidRelax(q);
  } else {
    vec2 rhs = texelFetch(uRhs, q, 0).xy;
    vec4 weight = fluidUnpack(rhs.y) * vec4(gK, gK, 1.0, 1.0);
    float sum = 0.0;
    float diagonal = 0.0;
    for (int f = 0; f < 4; f++) {
      if (weight[f] <= 0.0) continue;
      ivec2 n;
      float open;
      if (fluidAcross(q, f, n, open)) {
        diagonal += weight[f];
        sum += weight[f] * fluidRelax(n);
      } else {
        diagonal += weight[f] * open;
      }
    }
    x = diagonal > 0.0 ? (sum - rhs.x) / diagonal : 0.0;
  }
  fragColor = vec4(x, 0.0, 0.0, 1.0);
}
`;

// The next level's right-hand side: the finer level's residual averaged over the finer cells
// whose centres fall in each coarse cell (one or two a side; a closed one counts as 0), scaled by
// the cells' squared height ratio; and its faces, the mean of the finer faces along each side.
const RESTRICT = `
void main() {
  ivec2 coarse = ivec2(uSize);
  ivec2 at = ivec2(gl_FragCoord.xy);
  fluidLevel(textureSize(uRhs, 0));
  ivec2 lo = (2 * at * gSize + coarse - 1) / (2 * coarse);
  ivec2 hi = (2 * (at + 1) * gSize + coarse - 1) / (2 * coarse) - 1;
  float residual = 0.0;
  float cells = 0.0;
  vec4 open = vec4(0.0);
  vec4 along = vec4(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      ivec2 q = lo + ivec2(i, j);
      if (q.x > hi.x || q.y > hi.y) continue;
      vec3 s = fluidStencil(q, false);
      if (s.y > 0.0) residual += s.z - (s.x - s.y * texelFetch(uX, q, 0).x);
      cells += 1.0;
      vec4 faces = fluidUnpack(texelFetch(uRhs, q, 0).y);
      vec4 side = vec4(equal(q.xxyy, ivec4(lo.x, hi.x, lo.y, hi.y)));
      open += side * faces;
      along += side;
    }
  }
  float ratio = float(gSize.y) / float(coarse.y);
  fragColor = vec4(ratio * ratio * residual / cells, fluidPack(open / along), 0.0, 1.0);
}
`;

// x += the coarser level's correction, bilinear between the coarse cells round this one's centre.
// Coarse cells closed on every side (inside an obstacle) hold no correction and are left out of the
// blend; past an edge the correction goes on as the coarse equation has it (clamped at a wall, to
// 0 at an open edge's gap, round a wrap).
const PROLONG = `
uniform sampler2D uCoarse;     // the coarser level's x
uniform sampler2D uCoarseRhs;  // and its packed faces

// The correction at coarse cell q (x) and whether it holds one (y).
vec2 fluidCoarse(ivec2 q) {
  float scale = 1.0;
  if (q.x < 0 || q.x >= gSize.x) {
#if FLUID_LEFT == FLUID_WRAP
    q.x = (q.x + gSize.x) % gSize.x;
#else
    if ((q.x < 0 ? FLUID_LEFT : FLUID_RIGHT) == FLUID_OPEN) scale *= 1.0 - 1.0 / gGap.x;
    q.x = clamp(q.x, 0, gSize.x - 1);
#endif
  }
  if (q.y < 0 || q.y >= gSize.y) {
#if FLUID_BOTTOM == FLUID_WRAP
    q.y = (q.y + gSize.y) % gSize.y;
#else
    if ((q.y < 0 ? FLUID_BOTTOM : FLUID_TOP) == FLUID_OPEN) scale *= 1.0 - 1.0 / gGap.y;
    q.y = clamp(q.y, 0, gSize.y - 1);
#endif
  }
#if FLUID_OBSTACLE
  float holds = texelFetch(uCoarseRhs, q, 0).y > 0.5 ? 1.0 : 0.0;
#else
  float holds = 1.0;
#endif
  return vec2(scale * texelFetch(uCoarse, q, 0).x, holds);
}

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  fluidLevel(textureSize(uCoarse, 0));
  vec2 at = (vec2(q) + 0.5) * vec2(gSize) / uSize - 0.5;
  ivec2 base = ivec2(floor(at));
  vec2 f = at - vec2(base);
  vec2 a = fluidCoarse(base);
  vec2 b = fluidCoarse(base + ivec2(1, 0));
  vec2 c = fluidCoarse(base + ivec2(0, 1));
  vec2 d = fluidCoarse(base + ivec2(1, 1));
  vec4 blend = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y)
             * vec4(a.y, b.y, c.y, d.y);
  float total = blend.x + blend.y + blend.z + blend.w;
  float correction = total > 0.0 ? dot(blend, vec4(a.x, b.x, c.x, d.x)) / total : 0.0;
  fragColor = vec4(texelFetch(uX, q, 0).x + correction, 0.0, 0.0, 1.0);
}
`;

// The coarsest level (at most COARSEST cells) solved outright: every fragment runs Gauss–Seidel
// over the whole level and keeps its own cell. In a closed domain (no open edge) pressure is only
// defined up to a constant: the right-hand side's mean is taken out, so the solve is consistent,
// and so is the correction's, so the pressure never drifts.
const COARSEST = `
#define FLUID_CELLS ${COARSEST_CELLS}
void main() {
  fluidLevel(ivec2(uSize));
  int count = gSize.x * gSize.y;
  float rhs[FLUID_CELLS];
  float x[FLUID_CELLS];
  float diagonal[FLUID_CELLS];
  vec4 weight[FLUID_CELLS];
  float mean = 0.0;
  float live = 0.0;
  for (int i = 0; i < FLUID_CELLS; i++) {
    if (i >= count) break;
    ivec2 q = ivec2(i % gSize.x, i / gSize.x);
    vec2 t = texelFetch(uRhs, q, 0).xy;
    rhs[i] = t.x;
    x[i] = 0.0;
    weight[i] = fluidUnpack(t.y) * vec4(gK, gK, 1.0, 1.0);
    diagonal[i] = 0.0;
    for (int f = 0; f < 4; f++) {
      ivec2 n;
      float open;
      diagonal[i] += weight[i][f] * (fluidAcross(q, f, n, open) ? 1.0 : open);
    }
    if (diagonal[i] > 0.0) {
      mean += t.x;
      live += 1.0;
    }
  }
#if FLUID_CLOSED
  mean /= max(live, 1.0);
  for (int i = 0; i < FLUID_CELLS; i++) {
    if (i >= count) break;
    if (diagonal[i] > 0.0) rhs[i] -= mean;
  }
#endif
  for (int sweep = 0; sweep < ${COARSEST_SWEEPS}; sweep++) {
    for (int i = 0; i < FLUID_CELLS; i++) {
      if (i >= count) break;
      if (diagonal[i] <= 0.0) continue;
      ivec2 q = ivec2(i % gSize.x, i / gSize.x);
      float sum = 0.0;
      for (int f = 0; f < 4; f++) {
        ivec2 n;
        float open;
        if (weight[i][f] > 0.0 && fluidAcross(q, f, n, open)) sum += weight[i][f] * x[n.y * gSize.x + n.x];
      }
      x[i] = (sum - rhs[i]) / diagonal[i];
    }
  }
  ivec2 q = ivec2(gl_FragCoord.xy);
  float own = x[q.y * gSize.x + q.x];
#if FLUID_CLOSED
  float drift = 0.0;
  for (int i = 0; i < FLUID_CELLS; i++) {
    if (i >= count) break;
    if (diagonal[i] > 0.0) drift += x[i];
  }
  if (diagonal[q.y * gSize.x + q.x] > 0.0) own -= drift / max(live, 1.0);
#endif
  fragColor = vec4(own, 0.0, 0.0, 1.0);
}
`;

const PROJECT = `
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  vec2 cell = uTexel * uDomain;
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  // The pressure left, right, below and above: 0 past an open edge; the centre's own past a wall
  // (the clamped sample already is) or an obstacle face, so no flow is driven through them.
  vec4 p = vec4(texture(uPressure, vUv - dx).x, texture(uPressure, vUv + dx).x,
                texture(uPressure, vUv - dy).x, texture(uPressure, vUv + dy).x);
  if (fluidBeyond(vUv - dx, FLUID_OPEN)) p.x = 0.0;
  if (fluidBeyond(vUv + dx, FLUID_OPEN)) p.y = 0.0;
  if (fluidBeyond(vUv - dy, FLUID_OPEN)) p.z = 0.0;
  if (fluidBeyond(vUv + dy, FLUID_OPEN)) p.w = 0.0;
#if FLUID_OBSTACLE
  p = mix(vec4(texture(uPressure, vUv).x), p,
          fluidUnpack(texelFetch(uDivergence, ivec2(gl_FragCoord.xy), 0).y));
#endif
  vec2 velocity = texture(uVelocity, vUv).xy - 0.5 * vec2((p.y - p.x) * cell.y / cell.x, p.w - p.z);
  if (fluidSolid(vUv)) velocity = vec2(0.0);
  fragColor = vec4(velocity, 0.0, 1.0);
}
`;

const SPLAT = `
#define FLUID_SPLATS ${SPLATS}
uniform sampler2D uSource;
uniform vec4 uSplatAt[FLUID_SPLATS];     // centre in frame heights, 1 / radius^2, unused
uniform vec4 uSplatValue[FLUID_SPLATS];  // added at the centre
uniform int uSplatCount;
void main() {
  vec2 p = vUv * uDomain;
  vec4 value = texture(uSource, vUv);
  for (int i = 0; i < FLUID_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec2 d = p - uSplatAt[i].xy;
#if FLUID_LEFT == FLUID_WRAP
    d.x -= uDomain.x * round(d.x / uDomain.x);
#endif
#if FLUID_BOTTOM == FLUID_WRAP
    d.y -= round(d.y);
#endif
    value += uSplatValue[i] * exp(-dot(d, d) * uSplatAt[i].z);
  }
  fragColor = value;
}
`;

// ---- the solver --------------------------------------------------------------------------------

interface FluidPasses {
  readonly obstacle: Pass | undefined;
  readonly curl: Pass;
  readonly forces: Pass;
  readonly advect: Pass;
  readonly correct: Pass;
  readonly divergence: Pass;
  readonly smooth: Pass;
  readonly restrict: Pass;
  readonly prolong: Pass;
  readonly coarsest: Pass;
  readonly project: Pass;
  readonly splat: Pass;
}

/**
 * Compile the solver's passes for these edges and snippets; if one fails (a snippet that does not
 * compile), the ones already built are freed before the error goes on.
 */
function buildPasses(
  gpu: GpuCompute,
  edges: Edges,
  options: FluidOptions,
): { passes: FluidPasses; all: readonly Pass[] } {
  const closed = ![edges.left, edges.right, edges.bottom, edges.top].includes("open");
  const head = `#define FLUID_LEFT ${EDGE_CODE[edges.left]}
#define FLUID_RIGHT ${EDGE_CODE[edges.right]}
#define FLUID_BOTTOM ${EDGE_CODE[edges.bottom]}
#define FLUID_TOP ${EDGE_CODE[edges.top]}
#define FLUID_CLOSED ${closed ? 1 : 0}
#define FLUID_OBSTACLE ${options.obstacle === undefined ? 0 : 1}
#define FLUID_FORCE ${options.force === undefined ? 0 : 1}
${EDGE_TESTS}`;
  const all: Pass[] = [];
  const pass = (body: string, name: string): Pass => {
    const built = gpu.pass(head + body, name);
    all.push(built);
    return built;
  };
  try {
    const obstacle =
      options.obstacle === undefined
        ? undefined
        : pass(OBSTACLE_HEAD + options.obstacle + OBSTACLE_MAIN, "fluid obstacle");
    const passes: FluidPasses = {
      obstacle,
      curl: pass(CURL, "fluid curl"),
      forces: pass(FORCES_HEAD + (options.force ?? "") + FORCES_MAIN, "fluid forces"),
      advect: pass(SOLID + TRACE + ADVECT, "fluid advect"),
      correct: pass(SOLID + TRACE + CORRECT, "fluid maccormack"),
      divergence: pass(SOLID + FACES + DIVERGENCE, "fluid divergence"),
      smooth: pass(FACES + LEVEL + SMOOTH, "fluid pressure smooth"),
      restrict: pass(FACES + LEVEL + RESTRICT, "fluid pressure restrict"),
      prolong: pass(FACES + LEVEL + PROLONG, "fluid pressure prolong"),
      coarsest: pass(FACES + LEVEL + COARSEST, "fluid pressure coarsest"),
      project: pass(SOLID + FACES + PROJECT, "fluid project"),
      splat: pass(SPLAT, "fluid splat"),
    };
    return { passes, all };
  } catch (error: unknown) {
    for (const built of all) built.dispose();
    throw error;
  }
}

/** Splats waiting for the next step, as the splat pass's uniform arrays. */
interface SplatBatch {
  readonly at: Float32Array;
  readonly value: Float32Array;
  count: number;
}

/** A level of the pressure solve: its x (pressure or correction) and its right-hand side with the faces. */
interface Level {
  readonly x: PingPong;
  readonly rhs: RenderTarget;
}

/** One draw of a V-cycle, laid out once per grid size. */
interface Draw {
  readonly pass: Pass;
  readonly target: RenderTarget | PingPong;
  readonly options: RunOptions;
}

/**
 * The fluid. Construct with a GpuCompute (`new FluidSim(gpu, options)`, which throws GpuError on a
 * snippet that does not compile); each frame queue splats, `step`, `advect` any extra fields, and
 * hand the renderer `velocity.texture`, `dye.texture`, `pressure.texture`, `curl.texture` or
 * `solid.texture` (read them every frame: ping-pong sides swap).
 */
export class FluidSim {
  readonly gpu: GpuCompute;
  /** rg16f: velocity in frame heights per second. */
  readonly velocity: PingPong;
  /** What the fluid carries (smoke and heat, film thickness, ink...): the scene's to define. */
  readonly dye: PingPong;
  /**
   * r32f: the last pressure solve, in velocity units (pressure / velocity texel height); the next
   * step's solve starts from it.
   */
  readonly pressure: PingPong;
  /** r16f: vorticity per second (counter-clockwise positive), from the start of the last step. */
  readonly curl: RenderTarget;
  /** r8: share of each velocity cell inside the obstacle; undefined without one. */
  readonly solid: RenderTarget | undefined;
  /** rg32f: the velocity's divergence and each cell's packed faces (level 0's right-hand side). */
  readonly #divergence: RenderTarget;
  readonly #passes: FluidPasses;
  readonly #all: readonly Pass[];
  readonly #velocityResolution: number;
  readonly #dyeResolution: number;
  readonly #dyeScheme: AdvectScheme;
  /** MacCormack's forward step, one per field size and format. */
  readonly #scratch = new Map<string, RenderTarget>();
  readonly #domain = new Float32Array(2);
  readonly #keep = new Float32Array(4);
  /** The pressure solve's levels below the velocity grid, and one V-cycle's draws over all of them. */
  #coarse: readonly Level[] = [];
  #cycle: readonly Draw[] = [];
  readonly #fine = new Float32Array(2);
  readonly #velocitySplats: SplatBatch = {
    at: new Float32Array(SPLATS * 4),
    value: new Float32Array(SPLATS * 4),
    count: 0,
  };
  readonly #dyeSplats: SplatBatch = {
    at: new Float32Array(SPLATS * 4),
    value: new Float32Array(SPLATS * 4),
    count: 0,
  };
  #aspect: number;
  /** Seconds of the last step, for `advect`. */
  #lastDt = 0;
  #disposed = false;

  constructor(gpu: GpuCompute, options: FluidOptions = {}) {
    this.gpu = gpu;
    const boundary = options.boundary;
    const edges: Edges = {
      left: boundary?.left ?? "wall",
      right: boundary?.right ?? "wall",
      bottom: boundary?.bottom ?? "wall",
      top: boundary?.top ?? "wall",
    };
    const wrapX = edges.left === "wrap";
    const wrapY = edges.bottom === "wrap";
    if (wrapX !== (edges.right === "wrap") || wrapY !== (edges.top === "wrap")) {
      throw new FluidError(
        "fluid: an edge wraps only onto the opposite edge: make both left and right (or bottom and top) wrap",
      );
    }
    const wrap: TargetWrap = wrapX ? (wrapY ? "repeat" : "repeat-x") : wrapY ? "repeat-y" : "clamp";
    this.#velocityResolution = Math.max(
      MIN_RESOLUTION,
      Math.round(options.velocityResolution ?? DEFAULT_VELOCITY_RESOLUTION),
    );
    this.#dyeResolution = Math.max(
      MIN_RESOLUTION,
      Math.round(options.dyeResolution ?? DEFAULT_DYE_RESOLUTION),
    );
    this.#dyeScheme = options.dyeScheme ?? "maccormack";
    const width = options.width ?? gpu.gl.drawingBufferWidth;
    const height = options.height ?? gpu.gl.drawingBufferHeight;
    this.#aspect = width > 0 && height > 0 ? width / height : 1;

    // The programs first: a snippet that does not compile should leave nothing behind.
    const built = buildPasses(gpu, edges, options);
    this.#passes = built.passes;
    this.#all = built.all;

    const v = gridSize(this.#aspect, this.#velocityResolution);
    const d = gridSize(this.#aspect, this.#dyeResolution);
    this.velocity = gpu.pingPong({ ...v, format: "rg16f", wrap });
    this.pressure = gpu.pingPong({ ...v, format: "r32f", wrap });
    this.curl = gpu.target({ ...v, format: "r16f", wrap });
    this.#divergence = gpu.target({ ...v, format: "rg32f", filter: "nearest", wrap });
    this.solid =
      options.obstacle === undefined ? undefined : gpu.target({ ...v, format: "r8", wrap });
    this.dye = gpu.pingPong({ ...d, format: options.dyeFormat ?? "rgba16f", wrap });

    // Every pass reads the same fields: bound once (a PingPong resolves to its current side when
    // drawn); only the advected source changes per run.
    const p = this.#passes;
    p.curl.bind({ uVelocity: this.velocity });
    p.forces.bind({ uVelocity: this.velocity, uCurl: this.curl, uDye: this.dye });
    p.advect.bind({ uVelocity: this.velocity });
    p.correct.bind({ uVelocity: this.velocity });
    p.divergence.bind({ uVelocity: this.velocity });
    p.project.bind({
      uVelocity: this.velocity,
      uPressure: this.pressure,
      uDivergence: this.#divergence,
    });
    if (this.solid)
      for (const reader of [p.advect, p.correct, p.divergence, p.project])
        reader.bind({ uSolid: this.solid });
    this.#setDomain();
    this.#layLevels();
  }

  /** The frame's width / height the grids are laid out for. */
  get aspect(): number {
    return this.#aspect;
  }

  /**
   * Queue a Gaussian splat at uv (x, y), `radius` in frame heights (where it falls to 1/e): a
   * velocity impulse and/or dye. It lands at the start of the next `step`. A continuous source
   * scales its amounts by dt.
   */
  splat(x: number, y: number, radius: number, impulse: SplatImpulse): void {
    this.#check();
    const inverse = 1 / Math.max(radius * radius, 1e-10);
    if (impulse.velocity)
      this.#queue(this.#velocitySplats, this.velocity, x, y, inverse, impulse.velocity);
    if (impulse.dye) this.#queue(this.#dyeSplats, this.dye, x, y, inverse, impulse.dye);
  }

  /** Advance by `step.dt` seconds (see the file header for the passes). */
  step(step: FluidStep): void {
    this.#check();
    this.#flush(this.#velocitySplats, this.velocity);
    this.#flush(this.#dyeSplats, this.dye);
    const p = this.#passes;
    if (step.uniforms) {
      for (const name in step.uniforms) this.#checkSnippetName(name);
      p.forces.set(step.uniforms, false);
      p.obstacle?.set(step.uniforms, false);
    }
    if (step.textures) {
      for (const name in step.textures) this.#checkSnippetName(name);
      p.forces.bind(step.textures, false);
      p.obstacle?.bind(step.textures, false);
    }
    const dt = Math.max(0, step.dt);
    this.#lastDt = dt;
    if (dt === 0) return;
    const time = step.time ?? 0;

    if (p.obstacle && this.solid) p.obstacle.run(this.solid, { uniforms: { uTime: time } });
    p.curl.run(this.curl);
    p.forces.run(this.velocity, {
      uniforms: { uDt: dt, uTime: time, uVorticity: step.vorticity ?? 0 },
    });
    this.#keep.fill(Math.exp(-Math.max(0, step.velocityDissipation ?? 0) * dt));
    p.advect.run(this.velocity, {
      uniforms: { uDt: dt, uKeep: this.#keep, uClean: 0, uMask: 1 },
      textures: { uSource: this.velocity },
    });
    p.divergence.run(this.#divergence);
    const cycles = Math.max(0, Math.round(step.cycles ?? DEFAULT_CYCLES));
    for (let cycle = 0; cycle < cycles; cycle++)
      for (const draw of this.#cycle) draw.pass.run(draw.target, draw.options);
    p.project.run(this.velocity);
    this.#advect(this.dye, dt, step.dyeDissipation ?? 0, this.#dyeScheme);
  }

  /**
   * Carry another field with the velocity of the last step (nothing after a step of dt 0). Any
   * size and format; give it this sim's edges' wrap if it should wrap. Emptied inside the
   * obstacle; fills in empty through open edges.
   */
  advect(field: PingPong, options: AdvectOptions = {}): void {
    this.#check();
    if (this.#lastDt === 0) return;
    this.#advect(field, this.#lastDt, options.dissipation ?? 0, options.scheme ?? this.#dyeScheme);
  }

  /**
   * Lay the grids out for a new frame size. Returns whether they changed; when they do, `keep`
   * (default) stretches velocity, pressure and dye over the new grids, otherwise they start
   * empty for the scene to reseed. Cheap to call every frame.
   */
  resize(width: number, height: number, keep = true): boolean {
    this.#check();
    const aspect = width > 0 && height > 0 ? width / height : 1;
    if (aspect !== this.#aspect) {
      this.#aspect = aspect;
      this.#setDomain();
    }
    const v = gridSize(aspect, this.#velocityResolution);
    const d = gridSize(aspect, this.#dyeResolution);
    const same =
      v.width === this.velocity.width &&
      v.height === this.velocity.height &&
      d.width === this.dye.width &&
      d.height === this.dye.height;
    if (same) return false;
    this.velocity.resize(v.width, v.height, keep);
    this.pressure.resize(v.width, v.height, keep);
    this.curl.resize(v.width, v.height);
    this.#divergence.resize(v.width, v.height);
    this.solid?.resize(v.width, v.height);
    this.dye.resize(d.width, d.height, keep);
    this.#dropScratch();
    this.#layLevels();
    return true;
  }

  /** Still, empty fluid; queued splats are dropped. */
  clear(): void {
    this.#check();
    this.velocity.clear();
    this.pressure.clear();
    this.dye.clear();
    this.curl.clear();
    this.#velocitySplats.count = 0;
    this.#dyeSplats.count = 0;
  }

  /** Free the solver's targets and programs (the GpuCompute stays). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const built of this.#all) built.dispose();
    this.velocity.dispose();
    this.pressure.dispose();
    this.dye.dispose();
    this.curl.dispose();
    this.#divergence.dispose();
    this.solid?.dispose();
    this.#dropScratch();
    for (const level of this.#coarse) {
      level.x.dispose();
      level.rhs.dispose();
    }
  }

  #check(): void {
    if (this.#disposed) throw new FluidError("fluid: used after dispose");
  }

  #checkSnippetName(name: string): void {
    const { forces, obstacle } = this.#passes;
    if (RESERVED[name] === true) throw new FluidError(`fluid: ${name} is the solver's own uniform`);
    if (!forces.declares(name) && obstacle?.declares(name) !== true) {
      throw new FluidError(`fluid: neither the force nor the obstacle snippet declares ${name}`);
    }
  }

  #setDomain(): void {
    this.#domain[0] = this.#aspect;
    this.#domain[1] = 1;
    for (const built of this.#all) built.set({ uDomain: this.#domain });
  }

  /**
   * Lay out the pressure solve's levels for the velocity grid (freeing the old ones) and one
   * V-cycle's draws: down the levels a sweep, then the residual into the next level; the coarsest
   * solved outright; back up, the correction added, then a sweep.
   */
  #layLevels(): void {
    for (const level of this.#coarse) {
      level.x.dispose();
      level.rhs.dispose();
    }
    const levels: Level[] = [{ x: this.pressure, rhs: this.#divergence }];
    let width = this.velocity.width;
    let height = this.velocity.height;
    while (width * height > COARSEST_CELLS) {
      width = Math.ceil(width / 2);
      height = Math.ceil(height / 2);
      levels.push({
        x: this.gpu.pingPong({ width, height, format: "r32f", filter: "nearest" }),
        rhs: this.gpu.target({ width, height, format: "rg32f", filter: "nearest" }),
      });
    }
    this.#coarse = levels.slice(1);
    const p = this.#passes;
    const down: Draw[] = [];
    const up: Draw[] = [];
    for (const [index, level] of levels.entries()) {
      const textures = { uX: level.x, uRhs: level.rhs };
      const next = levels[index + 1];
      if (!next) {
        down.push({ pass: p.coarsest, target: level.x, options: { textures } });
        break;
      }
      // Below the velocity grid a level starts each cycle from 0.
      const uniforms = { uFresh: index > 0 };
      down.push({ pass: p.smooth, target: level.x, options: { textures, uniforms } });
      down.push({ pass: p.restrict, target: next.rhs, options: { textures } });
      const coarse = { ...textures, uCoarse: next.x, uCoarseRhs: next.rhs };
      up.unshift(
        { pass: p.prolong, target: level.x, options: { textures: coarse } },
        { pass: p.smooth, target: level.x, options: { textures, uniforms: { uFresh: false } } },
      );
    }
    this.#cycle = [...down, ...up];
    this.#fine[0] = this.velocity.width;
    this.#fine[1] = this.velocity.height;
    for (const pass of [p.smooth, p.restrict, p.prolong, p.coarsest])
      pass.set({ uFine: this.#fine });
  }

  #queue(
    batch: SplatBatch,
    field: PingPong,
    x: number,
    y: number,
    inverse: number,
    values: ArrayLike<number>,
  ): void {
    if (batch.count === SPLATS) this.#flush(batch, field);
    const k = batch.count * 4;
    batch.at[k] = x * this.#aspect;
    batch.at[k + 1] = y;
    batch.at[k + 2] = inverse;
    batch.at[k + 3] = 0;
    for (let i = 0; i < 4; i++) batch.value[k + i] = values[i] ?? 0;
    batch.count++;
  }

  #flush(batch: SplatBatch, field: PingPong): void {
    if (batch.count === 0) return;
    this.#passes.splat.run(field, {
      uniforms: { uSplatAt: batch.at, uSplatValue: batch.value, uSplatCount: batch.count },
      textures: { uSource: field },
    });
    batch.count = 0;
  }

  #advect(
    field: PingPong,
    dt: number,
    dissipation: number | ArrayLike<number>,
    scheme: AdvectScheme,
  ): void {
    const keep = this.#keep;
    for (let i = 0; i < 4; i++) {
      const rate = typeof dissipation === "number" ? dissipation : (dissipation[i] ?? 0);
      keep[i] = Math.exp(-Math.max(0, rate) * dt);
    }
    const p = this.#passes;
    switch (scheme) {
      case "linear":
        p.advect.run(field, {
          uniforms: { uDt: dt, uKeep: keep, uClean: 1, uMask: 1 },
          textures: { uSource: field },
        });
        return;
      case "maccormack": {
        const read = field.read;
        const key = `${read.width}x${read.height}:${read.format}:${read.filter}:${read.wrap}`;
        let forward = this.#scratch.get(key);
        if (!forward) {
          const { width, height, format, filter, wrap } = read;
          forward = this.gpu.target({ width, height, format, filter, wrap });
          this.#scratch.set(key, forward);
        }
        p.advect.run(forward, {
          uniforms: { uDt: dt, uKeep: KEEP_ALL, uClean: 1, uMask: 0 },
          textures: { uSource: field },
        });
        p.correct.run(field, {
          uniforms: { uDt: dt, uKeep: keep, uClean: 1 },
          textures: { uSource: field, uForward: forward },
        });
        return;
      }
      default: {
        const unreachable: never = scheme;
        throw new FluidError(`fluid: unknown advection scheme ${String(unreachable)}`);
      }
    }
  }

  #dropScratch(): void {
    for (const forward of this.#scratch.values()) forward.dispose();
    this.#scratch.clear();
  }
}
