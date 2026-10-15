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
//   6. pressure   `iterations` Jacobi sweeps of ∇²p = ∇·v, warm-started from the last solve
//   7. project    v −= ∇p: divergence free, zero inside the obstacle
//   8. dye        carried by the projected velocity: MacCormack (Selle, Fedkiw, Kim, Liu &
//                 Rossignac, "An Unconditionally Stable MacCormack Method", 2008), clamped to the
//                 texels it read so it never rings, or plain semi-Lagrangian; then faded
// Splats queued since the last step land first. `advect(field)` carries any other ping-pong field
// (a director field, a second dye) with the velocity of the last step. Pressure is kept in
// velocity units (p divided by a velocity texel's height), which half floats hold comfortably.
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
//   forces        6  (+4 force)     pressure      5 × 20 sweeps
//   advect        3  (+1 obstacle)  project       6  (+2)
//   dye           13 MacCormack (forward 3, correction 10), 3 semi-Lagrangian
// ≈ 3.7 M reads on the velocity grid and 3.4 M on the dye (0.8 M semi-Lagrangian), in 27 draws
// (+1 with an obstacle, +1 per batch of up to 16 splats per grid, +2 per `advect`ed field with
// MacCormack, +1 semi-Lagrangian). That is well under a millisecond on an integrated GPU; on a
// software rasterizer (SwiftShader) budget tens of milliseconds, and prewarm with few, long steps
// (semi-Lagrangian advection stays stable at dt = 0.1). Memory ≈ 0.5 MB on the velocity side,
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
  /** Jacobi sweeps of the pressure solve. Default 20; fewer leaves the flow a little compressible. */
  iterations?: number;
  /**
   * Vorticity confinement ε (Fedkiw et al., with h one velocity texel): 0 off, ~5–15 curling
   * smoke, 30+ boils. Default 0.
   */
  vorticity?: number;
  /** Velocity fade per second (exponential rate). Default 0. */
  velocityDissipation?: number;
  /** Dye fade per second: one rate, or one per channel (missing ones 0). Default 0. */
  dyeDissipation?: number | ArrayLike<number>;
  /** Share of the last pressure the solve starts from, 0..1. Default 0.8. */
  pressureRetain?: number;
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
const DEFAULT_ITERATIONS = 20;
const DEFAULT_PRESSURE_RETAIN = 0.8;
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
  // The same at the obstacle's faces, noting them for the pressure passes: 1 left, 2 right,
  // 4 below, 8 above.
  float faces = 0.0;
#if FLUID_OBSTACLE
  if (fluidSolid(vUv - dx)) { l = -c.x; faces += 1.0; }
  if (fluidSolid(vUv + dx)) { r = -c.x; faces += 2.0; }
  if (fluidSolid(vUv - dy)) { b = -c.y; faces += 4.0; }
  if (fluidSolid(vUv + dy)) { t = -c.y; faces += 8.0; }
#endif
  // Times a texel's height, so the solve runs in velocity units.
  float divergence = 0.5 * ((r - l) * cell.y / cell.x + (t - b));
  if (fluidSolid(vUv)) divergence = 0.0;
  fragColor = vec4(divergence, faces, 0.0, 1.0);
}
`;

const PRESSURE = `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
// The pressure left, right, below and above: 0 past an open edge; the centre's own past a wall
// (the clamped sample already is) or an obstacle face, so no flow is driven through them.
vec4 fluidAround(float faces) {
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec4 p = vec4(texture(uPressure, vUv - dx).x, texture(uPressure, vUv + dx).x,
                texture(uPressure, vUv - dy).x, texture(uPressure, vUv + dy).x);
  if (fluidBeyond(vUv - dx, FLUID_OPEN)) p.x = 0.0;
  if (fluidBeyond(vUv + dx, FLUID_OPEN)) p.y = 0.0;
  if (fluidBeyond(vUv - dy, FLUID_OPEN)) p.z = 0.0;
  if (fluidBeyond(vUv + dy, FLUID_OPEN)) p.w = 0.0;
#if FLUID_OBSTACLE
  int solid = int(faces + 0.5);
  if (solid != 0) {
    float centre = texture(uPressure, vUv).x;
    if ((solid & 1) != 0) p.x = centre;
    if ((solid & 2) != 0) p.y = centre;
    if ((solid & 4) != 0) p.z = centre;
    if ((solid & 8) != 0) p.w = centre;
  }
#endif
  return p;
}
`;

const JACOBI = `
uniform float uRetain;  // scales the previous solve on the first sweep (warm start), then 1
void main() {
  vec2 cell = uTexel * uDomain;
  float k = (cell.y * cell.y) / (cell.x * cell.x);
  vec2 d = texture(uDivergence, vUv).xy;
  vec4 p = uRetain * fluidAround(d.y);
  fragColor = vec4((k * (p.x + p.y) + p.z + p.w - d.x) / (2.0 * k + 2.0), 0.0, 0.0, 1.0);
}
`;

const PROJECT = `
uniform sampler2D uVelocity;
void main() {
  vec2 cell = uTexel * uDomain;
  vec4 p = fluidAround(texture(uDivergence, vUv).y);
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
  readonly jacobi: Pass;
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
  const head = `#define FLUID_LEFT ${EDGE_CODE[edges.left]}
#define FLUID_RIGHT ${EDGE_CODE[edges.right]}
#define FLUID_BOTTOM ${EDGE_CODE[edges.bottom]}
#define FLUID_TOP ${EDGE_CODE[edges.top]}
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
      divergence: pass(SOLID + DIVERGENCE, "fluid divergence"),
      jacobi: pass(PRESSURE + JACOBI, "fluid pressure"),
      project: pass(SOLID + PRESSURE + PROJECT, "fluid project"),
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
  /** r16f: the last pressure solve, in velocity units (pressure / velocity texel height). */
  readonly pressure: PingPong;
  /** r16f: vorticity per second (counter-clockwise positive), from the start of the last step. */
  readonly curl: RenderTarget;
  /** r8: share of each velocity cell inside the obstacle; undefined without one. */
  readonly solid: RenderTarget | undefined;
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
    this.pressure = gpu.pingPong({ ...v, format: "r16f", wrap });
    this.curl = gpu.target({ ...v, format: "r16f", wrap });
    this.#divergence = gpu.target({ ...v, format: "rg16f", wrap });
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
    p.jacobi.bind({ uPressure: this.pressure, uDivergence: this.#divergence });
    p.project.bind({
      uVelocity: this.velocity,
      uPressure: this.pressure,
      uDivergence: this.#divergence,
    });
    if (this.solid)
      for (const reader of [p.advect, p.correct, p.divergence, p.project])
        reader.bind({ uSolid: this.solid });
    this.#setDomain();
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
    const iterations = Math.max(0, Math.round(step.iterations ?? DEFAULT_ITERATIONS));
    const retain = Math.min(1, Math.max(0, step.pressureRetain ?? DEFAULT_PRESSURE_RETAIN));
    for (let i = 0; i < iterations; i++)
      p.jacobi.run(this.pressure, { uniforms: { uRetain: i === 0 ? retain : 1 } });
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
