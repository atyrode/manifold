// Shallow water over a bed, on the GPU (sims/gpu.ts): tide pools filling over their rims, surf
// running up a reef and draining back, floods, puddles, a plunge pool, a river building its delta.
// Water stands on a bed of any shape, runs downhill, sloshes, piles up into bores, overtops ridges
// and settles behind them; waves travel at sqrt(g · depth), so they slow, steepen and break as the
// water shoals.
//
// Model. The shallow water equations in conservative form, on a grid of square cells, by a
// first-order finite volume scheme: depth and velocity at each cell's centre, and through each face
// the flux of the HLL Riemann solver (Harten, Lax & van Leer, SIAM Review 25, 1983) with Toro's wave
// speeds, wet or dry ("Shock-Capturing Methods for Free-Surface Shallow Flows", 2001), so a bore runs
// at the speed its jump conditions give and stands as deep (Stoker's dam break). The bed enters by
// hydrostatic reconstruction (Audusse, Bouchut, Bristeau, Klein & Perthame, SIAM J. Sci. Comput. 25,
// 2004): at each face both sides' water levels stand over the higher of the two beds, so a lake at
// rest over any bed stays at rest and water crosses a ridge only where it stands above it. Momentum
// along a face rides with the water from its upwind side. Bed friction drags the flow by
// friction · speed / depth per second (a Chézy law, so thin sheets stop first). No cell gives away
// more water than it holds: its outflows are scaled down to what it has, and their momentum with
// them (the draining time step of Bollermann, Chen, Kurganov & Noelle, J. Sci. Comput. 2013), so
// depths never go negative and no water is made or lost except by forcing, sources and splats. The
// delta scene runs its river on it (scenes/delta/sim.ts), in its own units, over a bed it erodes.
//
// Order. The first-order scheme (`order: 1`, the default) takes each cell's water as level across
// it, which smears a wave a little every step: a wave 32 cells long keeps under half its height over
// two wavelengths at Courant 0.3, one 64 long two thirds (a friction-dominated river loses nothing
// to it). `order: 2` is MUSCL–Hancock (van Leer, J. Comput. Phys. 32, 1979; Toro's book, 2001):
// each cell's level, depth and velocity slope across it, limited by the MC limiter so no new peak
// or trough appears, and are carried half a step forward by those slopes before the faces' fluxes
// are worked out; the bed enters by Audusse et al.'s second-order hydrostatic reconstruction (the
// faces' beds from the level's and depth's slopes, and the push of the bed between a cell's faces),
// so a lake at rest still stays at rest. The same waves keep 98% and 99.6%, and one 16 long 89%; a
// bore still runs at Stoker's speed. Where water thinner than MIN_DEPTH lies on either
// side, or a face would run dry, a cell stays first order, so shores wet and dry as before, and the
// draining step keeps every depth at or above 0 whatever the fluxes.
//
// Units. Lengths and heights in cells; time in seconds. `gravity` (cells/s²) sets the wave speed,
// sqrt(gravity · depth) cells a second. A step is stable while dt · (|u| + |v| + 2 sqrt(gravity · d))
// stays under 1 in every cell (d its depth, u and v its velocity): over still water, while
// dt · sqrt(gravity · deepest) stays under 0.5. Pick dt from the deepest water and the fastest flow.
//
// Textures (rows bottom to top, uv as everywhere in the lab). Edges are walls: seas, rivers and
// drains come in through the forcing and source snippets.
//   bed      r32f nearest: bed height (cells), from setBed; or the caller's (`bed`), read in r
//   water    rgba32f nearest ping-pong: x depth, yz velocity (cells/s), w the source snippet's own
//            (0 without one)
//   flux     rgba32f nearest: the water each face passed in the last step, as outflow through the
//            left, right, bottom and top faces (cells²/s); a face's water runs one way, so either
//            its cell or the neighbour across it holds 0 there
//   slopes   two rgba32f nearest, at order 2: each cell's limited slopes along x and along y of its
//            level, depth and velocity xy (cells per cell; 0 at a shore)
//   carried  rgba16f linear ping-pong, with a carry snippet: the scene's tracers (foam, dye, wetness)
//   surface  rgba16f linear, refreshed by view(): x depth, yz the slope of the water level (cells per
//            cell, 0 where dry), w the caustic focus det(I + refraction · depth · H), H the level's
//            Hessian: the Jacobian of sunlight refracted through the surface onto the bed beneath it.
//            Light there is 1 / |w| times what still water lets through: 1 calm, above 1 under
//            crests (which focus), with bright lines where w crosses 0.
//
// Forcing snippet (`forcing`): GLSL defining
//     vec4 shallowForcing(vec2 uv, float bed)
// for the texel at uv and its bed, returning (target level, target velocity xy in cells/s, rate per
// second): the depth relaxes toward max(target - bed, 0) and the velocity toward the target's at
// that rate; rate 0 leaves the water free. A wave maker forces both the level and the flow of the
// wave it makes (for a shallow-water wave, velocity c · η / h along its heading,
// c = sqrt(uGravity · h)), so its waves run one way and the ones coming back are soaked up; a band
// along an edge forced to the still sea is a beach that never reflects. It may read uTime, uDt,
// uGravity, uTexel and uSize and declare its own uniforms (fed through `step`).
//
// Source snippet (`source`): GLSL defining
//     vec4 shallowSource(vec2 uv, vec4 water, float bed)
// returning the cell's water at the end of every step, from `water` as the step left it (depth,
// velocity xy, and w as this snippet last returned it): what a forcing cannot say, such as a river
// held at its stage, a sea held at its level, evaporation, or a mark the scene keeps in w (how
// lately the cell was wet). The depth it returns is clamped at 0. It may read what the forcing may,
// and declare its own uniforms and samplers (fed through `step`).
//
// Carry snippet (`carry`): GLSL defining
//     vec4 shallowCarry(vec2 uv, vec4 carried, vec4 here, vec4 water)
// returning the field's new value at uv: `carried` is the field back-traced along the flow (what
// the water brought here), `here` the field's own value at this texel (for marks that stay put),
// water = (depth, velocity xy in cells/s, bed). It may read uDt, uTime, uGravity, uTexel, uSize, the
// samplers uWater, uBed and uCarry, and declare its own uniforms (fed through `carry`). Foam:
//     return vec4(carried.x * exp(-0.3 * uDt) + uDt * smoothstep(1.0, 2.0, length(water.yz) / sqrt(uGravity * max(water.x, 0.01))), 0.0, 0.0, 0.0);
// (white water where the flow runs faster than its own waves: bores, overtopping, swash).
//
// Splats: `splat(x, y, radius, height)` queues a push that lands at the start of the next step: a
// dimple with a ring of the same volume around it, height · (1 - r²/R²) · e^(-r²/R²) (R = radius,
// both in cells), so a finger, a pebble or a drip makes ripples without adding water.
//
// Still water (CPU): `stillWater(bed, width, height, outlet, level)` is where water settles with the
// outlet cells (a sea, a drain) held at `level`: every pool fills to its lowest spill point and the
// rest drains. Seed `reset` with its depths so a scene opens settled. `LevelHeap` is its min-heap of
// cells by level (push(cell, level), pop() the lowest, size), for other priority floods.
//
// Cost per step at 356×200 (71k cells): two passes, 10 and 15 reads per texel, each working out the
// cell's four face fluxes; at order 2 four, the slopes along x and along y (6 reads each), then 20
// and 25 reads, a cell's water, bed and slopes for itself and its four neighbours. A real GPU runs
// hundreds of steps a frame; a software rasterizer (SwiftShader) a few. `carry` and `view` add one
// pass each and usually run once a frame.
//
// Usage (a basin by a sea along the top edge, a wave maker in the top rows):
//   const gpu = GpuCompute.create(gl);
//   if (!gpu) return stillPicture(gl);
//   const { width, height } = gridSize(frame.aspect, 200);
//   const water = new ShallowWater(gpu, {
//     width, height, gravity: 90, friction: 0.04,
//     forcing: `
//       uniform float uSwell;
//       vec4 shallowForcing(vec2 uv, float bed) {
//         float band = smoothstep(0.9, 1.0, uv.y);                 // the top tenth of the frame
//         float h = max(-bed, 0.1);                                // the still sea's depth
//         float eta = uSwell * cos(0.05 * gl_FragCoord.y + sqrt(uGravity * h) * 0.05 * uTime);
//         return vec4(eta, 0.0, -sqrt(uGravity / h) * eta, 20.0 * band);   // running down the frame
//       }`,
//   });
//   water.setBed(bed);                                            // Float32Array(width * height), cells
//   const sea = new Uint8Array(width * height).fill(1, (height - 1) * width);   // the top row
//   const level = stillWater(bed, width, height, sea, 0);
//   water.reset(level.map((l, i) => l - bed[i]));
//   const clock = new FixedStep(1 / 90, 8);
//   frame(frame) {
//     if (pointer.pressed) water.splat(pointer.x * width, pointer.y * height, 3, 0.6);
//     const steps = clock.advance(frame.dt * frame.motion);
//     for (let i = 0; i < steps; i++) water.step({ dt: clock.step, time: (time += clock.step), uniforms: { uSwell: 1 } });
//     water.view();
//     return [water.surface.texture];                                 // read it every frame
//   }
import {
  GpuError,
  type GpuCompute,
  type Pass,
  type PingPong,
  type RenderTarget,
  type TextureSource,
  type UniformValue,
} from "./gpu.ts";

export interface ShallowOptions {
  /** Grid size in cells (square: `gridSize(aspect, short)`). */
  width: number;
  height: number;
  /** Cells per second²: waves in water d cells deep run at sqrt(gravity · d) cells a second. */
  gravity: number;
  /** Bed friction: the flow slows by friction · speed / depth per second (speed in cells/s, depth in cells). Default 0.05. */
  friction?: number;
  /** Fastest the water may run (cells/s): a cap on thin sheets racing down steep beds. Default 1000. */
  maxSpeed?: number;
  /** Refraction distance per cell of depth for the caustic focus: 1 - 1/n, 0.25 for water. Default 0.25. */
  refraction?: number;
  /**
   * 1: first order, the cheaper: waves lose height as they travel, a little every step. 2: second
   * order (MUSCL–Hancock), for waves that must arrive as tall as they set out; about twice the reads
   * a step, and two more passes (see the file header). Default 1.
   */
  order?: 1 | 2;
  /**
   * The bed from the caller: a texture of the grid's size whose r is the bed height (cells), such as
   * a ping-pong a scene's own pass erodes, read afresh every step (setBed is then refused). Default:
   * the solver's own r32f bed, laid by setBed.
   */
  bed?: TextureSource;
  /** GLSL defining `vec4 shallowForcing(vec2 uv, float bed)` (see the file header). */
  forcing?: string;
  /** GLSL defining `vec4 shallowSource(vec2 uv, vec4 water, float bed)` (see the file header). */
  source?: string;
  /** GLSL defining `vec4 shallowCarry(vec2 uv, vec4 carried, vec4 here, vec4 water)` (see the file header). */
  carry?: string;
}

export interface ShallowStep {
  /** Seconds to advance (keep dt · (|u| + |v| + 2 sqrt(gravity · depth)) under 1). At 0 only queued splats land. */
  dt: number;
  /** uTime for the forcing and source snippets. Default 0. */
  time?: number;
  /** The forcing and source snippets' own uniforms (they persist). */
  uniforms?: Readonly<Record<string, UniformValue>>;
  /** The forcing and source snippets' own samplers (they persist). */
  textures?: Readonly<Record<string, TextureSource>>;
}

/** Invalid options, snippet uniforms or data sizes. */
export class ShallowError extends GpuError {}

/** Splats per batch: the splat pass loops over at most this many. */
const SPLATS = 8;
const DEFAULT_FRICTION = 0.05;
const DEFAULT_MAX_SPEED = 1000;
const DEFAULT_REFRACTION = 0.25;
/** Velocity is taken over at least this depth, so a film's velocity stays finite. */
const MIN_DEPTH = 0.05;

const RESERVED: Readonly<Record<string, true>> = {
  uTexel: true,
  uSize: true,
  uBed: true,
  uWater: true,
  uFlux: true,
  uSlopeX: true,
  uSlopeY: true,
  uAxis: true,
  uCarry: true,
  uDt: true,
  uTime: true,
  uGravity: true,
  uFriction: true,
  uMaxSpeed: true,
  uRefraction: true,
  uSplat: true,
  uSplatCount: true,
};
/** The slope pass's axes. */
const X_AXIS = [1, 0] as const;
const Y_AXIS = [0, 1] as const;

// ---- GLSL ---------------------------------------------------------------------------------------

const HEAD = `
uniform sampler2D uBed;    // r: bed height (cells)
uniform sampler2D uWater;  // depth, velocity xy (cells/s), the source snippet's w
uniform float uDt;
uniform float uTime;
uniform float uGravity;
// Water thinner than this (cells) counts as dry for the surface and splats.
const float SHALLOW_WET = 1e-3;
`;

/** Neighbouring cells, wall mirrors at the grid's edges. */
const CELLS = `
// A wall's mirror of s (bed, depth, velocity xy) across the face whose normal is n: the same water,
// its flow through the face reversed.
vec4 shallowWall(vec4 s, vec2 n) {
  return vec4(s.xy, s.zw - 2.0 * dot(s.zw, n) * n);
}

// Bed, depth, velocity xy of the cell at c. Off the grid: the wall's mirror of 'from', across the
// edge whose normal is n.
vec4 shallowCell(ivec2 c, vec4 from, vec2 n) {
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(uSize)))) return shallowWall(from, n);
  return vec4(texelFetch(uBed, c, 0).x, texelFetch(uWater, c, 0).xyz);
}
`;

/** The face fluxes, shared by the flux and water passes so both work out the same numbers. */
const FACES = `
// The flux through the face from cell a to cell b, whose normal n is +x or +y: x the water
// (cells²/s), yz the momentum (cells³/s²). a and b: bed, depth, velocity xy, each side's at the face.
vec3 shallowFlux(vec4 a, vec4 b, vec2 n) {
  // Hydrostatic reconstruction: both sides' levels over the higher of the two beds.
  float top = max(a.x, b.x);
  float ha = max(a.x + a.y - top, 0.0);
  float hb = max(b.x + b.y - top, 0.0);
  if (ha <= 0.0 && hb <= 0.0) return vec3(0.0);
  float ua = dot(a.zw, n);
  float ub = dot(b.zw, n);
  float ca = sqrt(uGravity * ha);
  float cb = sqrt(uGravity * hb);
  // The fastest waves either way (Toro's estimates); onto a dry side, the front of the water.
  float sl;
  float sr;
  if (ha <= 0.0) {
    sl = ub - 2.0 * cb;
    sr = ub + cb;
  } else if (hb <= 0.0) {
    sl = ua - ca;
    sr = ua + 2.0 * ca;
  } else {
    float us = 0.5 * (ua + ub) + ca - cb;
    float cs = max(0.5 * (ca + cb) + 0.25 * (ua - ub), 0.0);
    sl = min(ua - ca, us - cs);
    sr = max(ub + cb, us + cs);
  }
  vec2 fa = vec2(ha * ua, ha * ua * ua + 0.5 * uGravity * ha * ha);
  vec2 fb = vec2(hb * ub, hb * ub * ub + 0.5 * uGravity * hb * hb);
  // HLL, written so that two equal states pass exactly their own flux (still water stays still).
  vec2 f = sl >= 0.0 ? fa : sr <= 0.0 ? fb
    : 0.5 * (fa + fb) - 0.5 * (sr + sl) / (sr - sl) * (fb - fa) + sl * sr / (sr - sl) * vec2(hb - ha, hb * ub - ha * ua);
  // Momentum along the face rides with the water, from the side it comes from.
  vec2 along = n.yx;
  return vec3(f.x, n * f.y + along * (f.x * dot(f.x > 0.0 ? a.zw : b.zw, along)));
}
`;

/** Second order: each cell's water at its faces, half a step on (MUSCL–Hancock). */
const HALF = `
uniform sampler2D uSlopeX;  // each cell's limited slopes along x: level, depth, velocity xy
uniform sampler2D uSlopeY;  // along y

// Cell c half a step on: bed, depth and velocity xy at its centre, carried by its slopes along x
// and y (level, depth, velocity xy) through the shallow water equations in primitive form,
// dh/dt = -(u·∇h + h ∇·u) and du/dt = -(u·∇)u - g ∇level. Where a face would run dry it stays as
// it is, first order.
struct ShallowHalf {
  vec4 centre;
  vec4 sx;
  vec4 sy;
};

ShallowHalf shallowHalf(ivec2 c) {
  ShallowHalf s;
  vec3 w = texelFetch(uWater, c, 0).xyz;
  float bed = texelFetch(uBed, c, 0).x;
  s.sx = texelFetch(uSlopeX, c, 0);
  s.sy = texelFetch(uSlopeY, c, 0);
  float dh = -(w.y * s.sx.y + w.z * s.sy.y + w.x * (s.sx.z + s.sy.w));
  vec2 dv = -(w.y * s.sx.zw + w.z * s.sy.zw + uGravity * vec2(s.sx.x, s.sy.x));
  s.centre = vec4(bed, w + 0.5 * uDt * vec3(dh, dv));
  if (s.centre.y < 0.5 * max(abs(s.sx.y), abs(s.sy.y))) {
    s.centre = vec4(bed, w);
    s.sx = vec4(0.0);
    s.sy = vec4(0.0);
  }
  return s;
}

// Its water at the face whose outward normal is n (±x or ±y): bed, depth, velocity xy, half its
// slopes from the centre. The face's bed is its level less its depth (Audusse et al.'s second-order
// reconstruction).
vec4 shallowSide(ShallowHalf s, vec2 n) {
  vec4 d = 0.5 * (n.x * s.sx + n.y * s.sy);
  return vec4(s.centre.x + d.x - d.y, s.centre.y + d.y, s.centre.zw + d.zw);
}
`;

/**
 * The cell's water at its left, right, bottom and top faces (il, ir, ib, it) and its neighbours'
 * across them (l, r, b, t), from c, last, w, bed, x and y: at order 1 each cell's own.
 */
const SIDES = (order: 1 | 2): string =>
  order === 1
    ? `  vec4 here = vec4(bed, w.xyz);
  vec4 il = here;
  vec4 ir = here;
  vec4 ib = here;
  vec4 it = here;
  vec4 l = shallowCell(c - ivec2(1, 0), here, x);
  vec4 r = shallowCell(c + ivec2(1, 0), here, x);
  vec4 b = shallowCell(c - ivec2(0, 1), here, y);
  vec4 t = shallowCell(c + ivec2(0, 1), here, y);
`
    : `  ShallowHalf own = shallowHalf(c);
  vec4 il = shallowSide(own, -x);
  vec4 ir = shallowSide(own, x);
  vec4 ib = shallowSide(own, -y);
  vec4 it = shallowSide(own, y);
  vec4 l = c.x > 0 ? shallowSide(shallowHalf(c - ivec2(1, 0)), x) : shallowWall(il, x);
  vec4 r = c.x < last.x ? shallowSide(shallowHalf(c + ivec2(1, 0)), -x) : shallowWall(ir, x);
  vec4 b = c.y > 0 ? shallowSide(shallowHalf(c - ivec2(0, 1)), y) : shallowWall(ib, y);
  vec4 t = c.y < last.y ? shallowSide(shallowHalf(c + ivec2(0, 1)), -y) : shallowWall(it, y);
`;

/** Second order: each cell's slopes along uAxis. */
const SLOPE = `${HEAD}${CELLS}
uniform ivec2 uAxis;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 n = vec2(uAxis);
  vec4 here = vec4(texelFetch(uBed, c, 0).x, texelFetch(uWater, c, 0).xyz);
  vec4 prev = shallowCell(c - uAxis, here, n);
  vec4 next = shallowCell(c + uAxis, here, n);
  // At a shore the level's slope is the bed's rather than the water's: first order there.
  if (min(min(prev.y, here.y), next.y) < ${MIN_DEPTH.toFixed(2)}) {
    fragColor = vec4(0.0);
    return;
  }
  // Level, depth, velocity xy: the differences either way, and between them the MC limiter's slope
  // (van Leer's monotonized central): the centred difference held within twice either one-sided
  // one, and 0 at a peak or a trough, so a face never stands beyond its neighbour.
  vec4 a = vec4(here.x + here.y, here.yzw) - vec4(prev.x + prev.y, prev.yzw);
  vec4 b = vec4(next.x + next.y, next.yzw) - vec4(here.x + here.y, here.yzw);
  fragColor = vec4(greaterThan(a * b, vec4(0.0))) * sign(a) * min(2.0 * min(abs(a), abs(b)), 0.5 * abs(a + b));
}
`;

const FLUX = (order: 1 | 2): string => `${HEAD}${CELLS}${FACES}${order === 2 ? HALF : ""}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec4 w = texelFetch(uWater, c, 0);
  float bed = texelFetch(uBed, c, 0).x;
  vec2 x = vec2(1.0, 0.0);
  vec2 y = vec2(0.0, 1.0);
${SIDES(order)}  // The water each face would pass outward; the grid's edges are walls.
  vec4 q = vec4(
    c.x > 0 ? max(-shallowFlux(l, il, x).x, 0.0) : 0.0,
    c.x < last.x ? max(shallowFlux(ir, r, x).x, 0.0) : 0.0,
    c.y > 0 ? max(-shallowFlux(b, ib, y).x, 0.0) : 0.0,
    c.y < last.y ? max(shallowFlux(it, t, y).x, 0.0) : 0.0);
  // No cell gives away more than it holds.
  float total = q.x + q.y + q.z + q.w;
  fragColor = total > 0.0 ? q * min(1.0, w.x / (uDt * total)) : vec4(0.0);
}
`;

const WATER = (
  order: 1 | 2,
  forcing: string | undefined,
  source: string | undefined,
): string => `${HEAD}${CELLS}${FACES}${order === 2 ? HALF : ""}
uniform sampler2D uFlux;   // the water each face passed, outward: left, right, bottom, top
uniform float uFriction;
uniform float uMaxSpeed;
${forcing ?? ""}
${source ?? ""}

// The share of a face's flux that went through: the water it passed over the water the flux would
// carry, both outward. Where rounding leaves them of opposite signs, all of it.
float shallowShare(float passed, float flux) {
  return passed * flux > 0.0 ? min(passed / flux, 1.0) : 1.0;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec4 w = texelFetch(uWater, c, 0);
  float bed = texelFetch(uBed, c, 0).x;
  vec2 x = vec2(1.0, 0.0);
  vec2 y = vec2(0.0, 1.0);
${SIDES(order)}  // The water each face passed outward: this cell's outflow less the neighbour's.
  vec4 passed = texelFetch(uFlux, c, 0) - vec4(
    c.x > 0 ? texelFetch(uFlux, c - ivec2(1, 0), 0).y : 0.0,
    c.x < last.x ? texelFetch(uFlux, c + ivec2(1, 0), 0).x : 0.0,
    c.y > 0 ? texelFetch(uFlux, c - ivec2(0, 1), 0).w : 0.0,
    c.y < last.y ? texelFetch(uFlux, c + ivec2(0, 1), 0).z : 0.0);
  float depth = max(w.x - uDt * (passed.x + passed.y + passed.z + passed.w), 0.0);
  // Momentum: each face's flux, in the share of it that went through (all of it at a wall)...
  vec3 fl = shallowFlux(l, il, x);
  vec3 fr = shallowFlux(ir, r, x);
  vec3 fb = shallowFlux(b, ib, y);
  vec3 ft = shallowFlux(it, t, y);
  vec2 flow = (c.x < last.x ? shallowShare(passed.y, fr.x) : 1.0) * fr.yz
            - (c.x > 0 ? shallowShare(-passed.x, fl.x) : 1.0) * fl.yz
            + (c.y < last.y ? shallowShare(passed.w, ft.x) : 1.0) * ft.yz
            - (c.y > 0 ? shallowShare(-passed.z, fb.x) : 1.0) * fb.yz;
  // ...and the bed's push: this cell's own pressure at each face, its depth there over the higher
  // bed, worked out as the flux works it out, so that over still water the two cancel exactly.
  vec4 face = max(
    vec4(il.x + il.y, ir.x + ir.y, ib.x + ib.y, it.x + it.y) - max(vec4(il.x, ir.x, ib.x, it.x), vec4(l.x, r.x, b.x, t.x)),
    0.0);
  vec4 pressure = 0.5 * uGravity * face * face;
  vec2 push = vec2(pressure.y - pressure.x, pressure.w - pressure.z);
${
  order === 1
    ? ""
    : `  // At second order the bed also pushes inside the cell: its mean depth at its faces times the
  // level's rise across it (Audusse et al.'s centred term), nothing where the level is flat.
  push -= 0.5 * uGravity * vec2(
    (il.y + ir.y) * ((ir.x + ir.y) - (il.x + il.y)),
    (ib.y + it.y) * ((it.x + it.y) - (ib.x + ib.y)));
`
}  // Velocity over the new depth, held back by friction (implicitly, so it stops a sheet, never turns it).
  float film = max(depth, ${MIN_DEPTH.toFixed(2)});
  vec2 velocity = (w.x * w.yz - uDt * (flow - push)) / film;
  velocity /= 1.0 + uDt * uFriction * length(velocity) / film;
${
  forcing === undefined
    ? ""
    : `  vec4 force = shallowForcing(vUv, bed);
  if (force.w > 0.0) {
    float k = 1.0 - exp(-force.w * uDt);
    depth = mix(depth, max(force.x - bed, 0.0), k);
    velocity = mix(velocity, force.yz, k);
  }
`
}  float speed = length(velocity);
  if (speed > uMaxSpeed) velocity *= uMaxSpeed / speed;
  vec4 next = vec4(depth, velocity, w.w);
${source === undefined ? "" : "  next = shallowSource(vUv, next, bed);\n"}  fragColor = vec4(max(next.x, 0.0), next.yzw);
}
`;

const CARRY = (carry: string): string => `${HEAD}
uniform sampler2D uCarry;
${carry}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 w = texelFetch(uWater, c, 0);
  vec4 water = vec4(w.xyz, texelFetch(uBed, c, 0).x);
  vec2 back = vUv - uDt * w.yz * uTexel;
  fragColor = shallowCarry(vUv, texture(uCarry, back), texture(uCarry, vUv), water);
}
`;

const SURFACE = `${HEAD}
uniform float uRefraction;

// The water level at c, or 'fallback' where c is dry or off the grid (one-sided differences at a
// shore, so the bed's slope never leaks into the water's).
float shallowLevelAt(ivec2 c, float fallback) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uSize.x) || c.y >= int(uSize.y)) return fallback;
  float d = texelFetch(uWater, c, 0).x;
  return d > SHALLOW_WET ? texelFetch(uBed, c, 0).x + d : fallback;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uWater, c, 0).x;
  if (d <= SHALLOW_WET) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float e = texelFetch(uBed, c, 0).x + d;
  float l = shallowLevelAt(c - ivec2(1, 0), e);
  float r = shallowLevelAt(c + ivec2(1, 0), e);
  float b = shallowLevelAt(c - ivec2(0, 1), e);
  float t = shallowLevelAt(c + ivec2(0, 1), e);
  float bl = shallowLevelAt(c - ivec2(1, 1), e);
  float br = shallowLevelAt(c + ivec2(1, -1), e);
  float tl = shallowLevelAt(c + ivec2(-1, 1), e);
  float tr = shallowLevelAt(c + ivec2(1, 1), e);
  vec2 slope = 0.5 * vec2(r - l, t - b);
  float hxx = r - 2.0 * e + l;
  float hyy = t - 2.0 * e + b;
  float hxy = 0.25 * (tr - tl - br + bl);
  float k = uRefraction * d;
  fragColor = vec4(d, slope, (1.0 + k * hxx) * (1.0 + k * hyy) - k * k * hxy * hxy);
}
`;

const SPLAT = `${HEAD}
#define SHALLOW_SPLATS ${SPLATS}
uniform vec4 uSplat[SHALLOW_SPLATS];  // centre (cells), 1 / radius², height
uniform int uSplatCount;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 w = texelFetch(uWater, c, 0);
  float add = 0.0;
  for (int i = 0; i < SHALLOW_SPLATS; i++) {
    if (i >= uSplatCount) break;
    vec2 d = gl_FragCoord.xy - uSplat[i].xy;
    float r2 = dot(d, d) * uSplat[i].z;
    add += uSplat[i].w * (1.0 - r2) * exp(-r2);
  }
  // Only standing water is pushed about: a splat on dry rock does nothing.
  fragColor = vec4(w.x > SHALLOW_WET ? max(w.x + add, 0.0) : w.x, w.yzw);
}
`;

// ---- the solver --------------------------------------------------------------------------------

/**
 * The water. Construct with a GpuCompute (`new ShallowWater(gpu, options)`, which throws GpuError on
 * a snippet that does not compile), `setBed` (unless the bed is the caller's), `reset` it to still
 * water, then each frame queue splats, `step` a fixed dt as often as the clock asks, `carry` and
 * `view` once, and hand the renderer `surface.texture` (and `carried.texture`, `water.texture`):
 * read them every frame, since ping-pong sides swap.
 */
export class ShallowWater {
  readonly gpu: GpuCompute;
  readonly width: number;
  readonly height: number;
  /** The bed the passes read, in r (cells): the solver's own r32f target, or the caller's (`bed`). */
  readonly bed: TextureSource;
  /** rgba32f nearest: depth (cells), velocity xy (cells/s), the source snippet's w. */
  readonly water: PingPong;
  /** rgba32f nearest: the water each face passed in the last step, outward through the left, right, bottom, top faces (cells²/s). */
  readonly flux: RenderTarget;
  /** rgba16f linear: the carry snippet's field; undefined without one. */
  readonly carried: PingPong | undefined;
  /** rgba16f linear, as of the last `view`: depth, level slope xy, caustic focus. */
  readonly surface: RenderTarget;
  /** The bed setBed lays; undefined when the bed is the caller's. */
  readonly #ownBed: RenderTarget | undefined;
  readonly #slope: Pass | undefined;
  readonly #flux: Pass;
  readonly #water: Pass;
  readonly #carry: Pass | undefined;
  readonly #surface: Pass;
  readonly #splat: Pass;
  readonly #all: readonly Pass[];
  /** Order 2: each cell's slopes along x and along y (rgba32f nearest). */
  readonly #slopes: readonly [RenderTarget, RenderTarget] | undefined;
  readonly #splats = new Float32Array(SPLATS * 4);
  #splatCount = 0;
  #disposed = false;

  constructor(gpu: GpuCompute, options: ShallowOptions) {
    const { width, height } = options;
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 2 && height >= 2)) {
      throw new ShallowError(
        `shallow: the grid must be whole cells, at least 2×2, got ${width}×${height}`,
      );
    }
    if (!(options.gravity > 0))
      throw new ShallowError(`shallow: gravity must be positive, got ${options.gravity}`);
    this.gpu = gpu;
    this.width = width;
    this.height = height;

    // The programs first: a snippet that does not compile should leave nothing behind.
    const all: Pass[] = [];
    const pass = (body: string, name: string): Pass => {
      const built = gpu.pass(body, name);
      all.push(built);
      return built;
    };
    const order = options.order ?? 1;
    try {
      this.#slope = order === 2 ? pass(SLOPE, "shallow slope") : undefined;
      this.#flux = pass(FLUX(order), "shallow flux");
      this.#water = pass(WATER(order, options.forcing, options.source), "shallow water");
      this.#carry =
        options.carry === undefined ? undefined : pass(CARRY(options.carry), "shallow carry");
      this.#surface = pass(SURFACE, "shallow surface");
      this.#splat = pass(SPLAT, "shallow splat");
    } catch (error: unknown) {
      for (const built of all) built.dispose();
      throw error;
    }
    this.#all = all;

    const size = { width, height };
    if (options.bed === undefined) {
      this.#ownBed = gpu.target({ ...size, format: "r32f", filter: "nearest" });
      this.bed = this.#ownBed;
    } else {
      this.#ownBed = undefined;
      this.bed = options.bed;
    }
    this.water = gpu.pingPong({ ...size, format: "rgba32f", filter: "nearest" });
    this.flux = gpu.target({ ...size, format: "rgba32f", filter: "nearest" });
    this.#slopes =
      order === 2
        ? [
            gpu.target({ ...size, format: "rgba32f", filter: "nearest" }),
            gpu.target({ ...size, format: "rgba32f", filter: "nearest" }),
          ]
        : undefined;
    this.carried =
      options.carry === undefined ? undefined : gpu.pingPong({ ...size, format: "rgba16f" });
    this.surface = gpu.target({ ...size, format: "rgba16f" });

    const gravity = options.gravity;
    for (const built of all)
      built.bind({ uBed: this.bed, uWater: this.water }).set({ uGravity: gravity });
    this.#water.bind({ uFlux: this.flux }).set({
      uFriction: options.friction ?? DEFAULT_FRICTION,
      uMaxSpeed: options.maxSpeed ?? DEFAULT_MAX_SPEED,
    });
    if (this.#carry && this.carried) this.#carry.bind({ uCarry: this.carried });
    if (this.#slopes) {
      const slopes = { uSlopeX: this.#slopes[0], uSlopeY: this.#slopes[1] };
      this.#flux.bind(slopes);
      this.#water.bind(slopes);
    }
    this.#surface.set({ uRefraction: options.refraction ?? DEFAULT_REFRACTION });
  }

  /** Lay the bed: width × height heights in cells, row 0 at the bottom. Not for a caller's bed. */
  setBed(heights: Float32Array): void {
    this.#check();
    if (!this.#ownBed)
      throw new ShallowError("shallow: the bed is the caller's texture; setBed has none to lay");
    this.#checkLength(heights, "bed");
    this.#ownBed.seed(heights);
  }

  /**
   * Still water at these depths (width × height cells, row 0 at the bottom): no flow, w 0, no queued
   * splats, the carried field emptied.
   */
  reset(depths: Float32Array): void {
    this.#check();
    this.#checkLength(depths, "depths");
    const state = new Float32Array(this.width * this.height * 4);
    for (let i = 0; i < depths.length; i++) state[i * 4] = Math.max(0, depths[i] ?? 0);
    this.water.seed(state);
    this.flux.clear();
    this.carried?.clear();
    this.#splatCount = 0;
  }

  /** Queue a mass-neutral push at cell (x, y), `radius` and `height` in cells (see the file header). */
  splat(x: number, y: number, radius: number, height: number): void {
    this.#check();
    if (this.#splatCount === SPLATS) this.#flushSplats();
    const k = this.#splatCount * 4;
    this.#splats[k] = x;
    this.#splats[k + 1] = y;
    this.#splats[k + 2] = 1 / Math.max(radius * radius, 1e-6);
    this.#splats[k + 3] = height;
    this.#splatCount++;
  }

  /**
   * Land the queued splats, then advance `dt` seconds: at order 2 the slopes, then the face fluxes,
   * then the water, forced and sourced.
   */
  step(step: ShallowStep): void {
    this.#check();
    this.#flushSplats();
    if (step.uniforms) this.#snippet(step.uniforms, undefined, this.#water);
    if (step.textures) this.#snippet(undefined, step.textures, this.#water);
    const dt = Math.max(0, step.dt);
    if (dt === 0) return;
    const time = step.time ?? 0;
    if (this.#slope && this.#slopes) {
      this.#slope.run(this.#slopes[0], { uniforms: { uAxis: X_AXIS } });
      this.#slope.run(this.#slopes[1], { uniforms: { uAxis: Y_AXIS } });
    }
    this.#flux.run(this.flux, { uniforms: { uDt: dt, uTime: time } });
    this.#water.run(this.water, { uniforms: { uDt: dt, uTime: time } });
  }

  /**
   * Advance the carried field `dt` seconds along the current flow: the seconds the steps since the
   * last carry covered, so the field runs on the water's own clock. Needs a carry snippet; its own
   * uniforms persist.
   */
  carry(dt: number, time = 0, uniforms?: Readonly<Record<string, UniformValue>>): void {
    this.#check();
    const carry = this.#carry;
    if (!carry || !this.carried) throw new ShallowError("shallow: carry() needs a carry snippet");
    if (uniforms) this.#snippet(uniforms, undefined, carry);
    carry.run(this.carried, { uniforms: { uDt: Math.max(0, dt), uTime: time } });
  }

  /** Refresh `surface` from the current water. */
  view(): void {
    this.#check();
    this.#surface.run(this.surface);
  }

  /** Free the solver's targets and programs (the GpuCompute stays). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const built of this.#all) built.dispose();
    this.#ownBed?.dispose();
    this.water.dispose();
    this.flux.dispose();
    for (const target of this.#slopes ?? []) target.dispose();
    this.carried?.dispose();
    this.surface.dispose();
  }

  #flushSplats(): void {
    if (this.#splatCount === 0) return;
    this.#splat.run(this.water, {
      uniforms: { uSplat: this.#splats, uSplatCount: this.#splatCount },
    });
    this.#splatCount = 0;
  }

  /** Hand a snippet's own uniforms and samplers to the pass that compiles it (a typo throws). */
  #snippet(
    uniforms: Readonly<Record<string, UniformValue>> | undefined,
    textures: Readonly<Record<string, TextureSource>> | undefined,
    pass: Pass,
  ): void {
    for (const values of [uniforms, textures]) {
      for (const name in values) {
        if (RESERVED[name] === true)
          throw new ShallowError(`shallow: ${name} is the solver's own uniform`);
        if (!pass.declares(name))
          throw new ShallowError(`shallow: the ${pass.name} snippet declares no ${name}`);
      }
    }
    if (uniforms) pass.set(uniforms);
    if (textures) pass.bind(textures);
  }

  #checkLength(data: Float32Array, what: string): void {
    if (data.length !== this.width * this.height) {
      throw new ShallowError(
        `shallow: ${what} has ${data.length} values for a ${this.width}×${this.height} grid`,
      );
    }
  }

  #check(): void {
    if (this.#disposed) throw new ShallowError("shallow: used after dispose");
  }
}

// ---- still water (CPU) --------------------------------------------------------------------------

/**
 * The level still water settles at on `bed` (width × height heights, row 0 at the bottom) with the
 * cells marked in `outlet` held at `level` (a sea, a drain): each cell's level is the lowest at which
 * water standing there could still run off to an outlet, so every pool fills to its lowest spill
 * point and everything else drains; a dry cell's level is its bed. Depth = level - bed. Priority
 * flood (Barnes, Lehman & Mulla, "Priority-flood: An optimal depression-filling and watershed-labeling
 * algorithm for digital elevation models", Computers & Geosciences 62, 2014), 4-connected, O(n log n).
 * Without any outlet every cell keeps its bed.
 */
export function stillWater(
  bed: Float32Array,
  width: number,
  height: number,
  outlet: Uint8Array,
  level: number,
): Float32Array {
  const n = width * height;
  if (bed.length !== n || outlet.length !== n)
    throw new ShallowError(`stillWater: bed and outlet need ${width}×${height} values`);
  const out = Float32Array.from(bed);
  const done = new Uint8Array(n);
  const heap = new LevelHeap(n);
  for (let i = 0; i < n; i++) {
    if (outlet[i] === 0) continue;
    out[i] = Math.max(bed[i] ?? 0, level);
    done[i] = 1;
    heap.push(i, out[i] ?? 0);
  }
  // Cells a depression's water covers (bed at or below the level reaching them) take a plain FIFO
  // instead of the heap: they all stand at that level, in any order (Barnes et al.'s Algorithm 2).
  const pit = new Int32Array(n);
  let pitHead = 0;
  let pitTail = 0;
  while (pitHead < pitTail || heap.size > 0) {
    const i = pitHead < pitTail ? (pit[pitHead++] ?? 0) : heap.pop();
    const at = out[i] ?? 0;
    const x = i % width;
    const y = (i - x) / width;
    for (let k = 0; k < 4; k++) {
      const j =
        k === 0
          ? x > 0
            ? i - 1
            : -1
          : k === 1
            ? x < width - 1
              ? i + 1
              : -1
            : k === 2
              ? y > 0
                ? i - width
                : -1
              : y < height - 1
                ? i + width
                : -1;
      if (j < 0 || done[j] === 1) continue;
      done[j] = 1;
      const ground = bed[j] ?? 0;
      if (ground <= at) {
        out[j] = at;
        pit[pitTail++] = j;
      } else {
        out[j] = ground;
        heap.push(j, ground);
      }
    }
  }
  return out;
}

/**
 * A binary min-heap of cell indices by level. Ties may pop in any order: the flood's levels are the
 * lowest spill height over all paths, which no visiting order changes. Exported for other priority
 * floods over a grid (sims/terrain.ts's drainage, which also keeps each cell's receiver).
 */
export class LevelHeap {
  readonly #cells: Int32Array;
  readonly #levels: Float64Array;
  #size = 0;

  constructor(capacity: number) {
    this.#cells = new Int32Array(capacity);
    this.#levels = new Float64Array(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(cell: number, level: number): void {
    const cells = this.#cells;
    const levels = this.#levels;
    let i = this.#size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((levels[parent] ?? 0) <= level) break;
      cells[i] = cells[parent] ?? 0;
      levels[i] = levels[parent] ?? 0;
      i = parent;
    }
    cells[i] = cell;
    levels[i] = level;
  }

  /** The lowest cell, removed. Only while size > 0. */
  pop(): number {
    const cells = this.#cells;
    const levels = this.#levels;
    const top = cells[0] ?? 0;
    const last = --this.#size;
    const cell = cells[last] ?? 0;
    const level = levels[last] ?? 0;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && (levels[child + 1] ?? 0) < (levels[child] ?? 0)) child++;
      if ((levels[child] ?? 0) >= level) break;
      cells[i] = cells[child] ?? 0;
      levels[i] = levels[child] ?? 0;
      i = child;
    }
    cells[i] = cell;
    levels[i] = level;
    return top;
  }
}
