// Shallow water over a bed, on the GPU (sims/gpu.ts): tide pools filling over their rims, surf
// running up a reef and draining back, floods, puddles, a plunge pool. Water stands on a bed of any
// shape, runs downhill, sloshes, piles up into bores, overtops ridges and settles behind them; waves
// travel at sqrt(g · depth), so they slow, steepen and break as the water shoals.
//
// Model. Depth on a grid of square cells; the flow through each cell's four faces is kept as
// "virtual pipes" (Mei, Decaudin & Hu, "Fast Hydraulic Erosion Simulation and Visualization on
// GPU", Pacific Graphics 2007) obeying the local inertial equations (Bates, Horritt & Fewtrell,
// J. Hydrology 387, 2010): each face's outflow is pushed by the drop of the water level across it
// times the depth of water over it, held back by bed friction (a drag of friction · speed / depth
// per second, so thin sheets stop first), and scaled so no cell gives away more water than it holds.
// Depths never go negative and no water is made or lost except by forcing and splats. The delta
// scene runs the same scheme for its river (scenes/delta/sim.ts), in its own units.
//
// Units. Lengths and heights in cells; time in seconds. `gravity` (cells/s²) sets the wave speed,
// sqrt(gravity · depth) cells a second. A step is stable while dt · sqrt(gravity · deepest) stays
// under about 0.7 (a wave crosses less than a cell): pick dt from the deepest water.
//
// Textures (rows bottom to top, uv as everywhere in the lab). Edges are walls: seas, rivers and
// drains come in through the forcing snippet.
//   bed      r32f nearest: bed height (cells), from setBed
//   water    rgba32f nearest ping-pong: x depth, yz velocity (cells/s), w 0
//   flux     rgba32f nearest ping-pong: outflow through the left, right, bottom and top faces (cells²/s)
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
// second): the depth relaxes toward max(target - bed, 0) and the flow through the cell's faces
// toward that velocity at that rate; rate 0 leaves the water free. A wave maker forces both the
// level and the flow of the wave it makes (for a shallow-water wave, velocity c · η / h along its
// heading, c = sqrt(uGravity · h)), so its waves run one way and the ones coming back are soaked
// up; a band along an edge forced to the still sea is a beach that never reflects. It may read
// uTime, uDt, uGravity, uTexel and uSize and declare its own uniforms (fed through `step`).
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
// Cost per step at 356×200 (71k cells): two passes, ~16 reads per texel. A real GPU runs hundreds of
// steps a frame; a software rasterizer (SwiftShader) a few. `carry` and `view` add one pass each and
// usually run once a frame.
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
  /**
   * Share of each face's flow taken from the same face of its four neighbours every step, 0..0.3:
   * stills the scheme's own chequerboard of grid-sized waves in deep, frictionless water. Default 0.
   */
  viscosity?: number;
  /** Fastest the reported velocity may be (cells/s); fluxes are never clamped. Default 1000. */
  maxSpeed?: number;
  /** Refraction distance per cell of depth for the caustic focus: 1 - 1/n, 0.25 for water. Default 0.25. */
  refraction?: number;
  /** GLSL defining `vec2 shallowForcing(vec2 uv, float bed, float level)` (see the file header). */
  forcing?: string;
  /** GLSL defining `vec4 shallowCarry(vec2 uv, vec4 carried, vec4 here, vec4 water)` (see the file header). */
  carry?: string;
}

export interface ShallowStep {
  /** Seconds to advance (keep dt · sqrt(gravity · deepest) under ~0.7). At 0 only queued splats land. */
  dt: number;
  /** uTime for the forcing snippet. Default 0. */
  time?: number;
  /** The forcing snippet's own uniforms (they persist). */
  uniforms?: Readonly<Record<string, UniformValue>>;
  /** The forcing snippet's own samplers (they persist). */
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
  uCarry: true,
  uDt: true,
  uTime: true,
  uGravity: true,
  uFriction: true,
  uViscosity: true,
  uMaxSpeed: true,
  uRefraction: true,
  uSplat: true,
  uSplatCount: true,
};

// ---- GLSL ---------------------------------------------------------------------------------------

const HEAD = `
uniform sampler2D uBed;    // r: bed height (cells)
uniform sampler2D uWater;  // depth, velocity xy (cells/s), 0
uniform float uDt;
uniform float uTime;
uniform float uGravity;
// Water thinner than this (cells) counts as dry for the surface and splats.
const float SHALLOW_WET = 1e-3;
`;

const FLUX = (forcing: string | undefined): string => `${HEAD}
uniform sampler2D uFlux;   // outflow through the left, right, bottom, top faces (cells²/s)
uniform float uFriction;
uniform float uViscosity;
${forcing ?? ""}

// The outflow toward neighbour n: last step's, pushed by the level's drop over the face times the
// water standing over it, held back by friction; never negative (the neighbour pushes back with its
// own outflow). Off the grid n reads as the cell itself (and the caller shuts that face).
float shallowPipe(ivec2 n, float bed, float level, float flow) {
  n = clamp(n, ivec2(0), ivec2(uSize) - 1);
  float nb = texelFetch(uBed, n, 0).x;
  float nl = nb + texelFetch(uWater, n, 0).x;
  float face = max(level, nl) - max(bed, nb);
  if (face <= 0.0) return 0.0;
  float q = flow + uDt * uGravity * face * (level - nl);
  return q > 0.0 ? q / (1.0 + uDt * uFriction * q / (face * face)) : 0.0;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  float bed = texelFetch(uBed, c, 0).x;
  float depth = texelFetch(uWater, c, 0).x;
  vec4 flow = texelFetch(uFlux, c, 0);
  // Viscosity: each face's flow takes a share of the same face's in the four cells around, which
  // stills the grid's own chequerboard of short waves and costs the long ones little.
  if (uViscosity > 0.0) {
    vec4 around = texelFetch(uFlux, max(c - ivec2(1, 0), ivec2(0)), 0) + texelFetch(uFlux, min(c + ivec2(1, 0), last), 0)
                + texelFetch(uFlux, max(c - ivec2(0, 1), ivec2(0)), 0) + texelFetch(uFlux, min(c + ivec2(0, 1), last), 0);
    flow = mix(flow, 0.25 * around, uViscosity);
  }
  float level = bed + depth;
  vec4 open = vec4(c.x > 0, c.x < last.x, c.y > 0, c.y < last.y);
  vec4 q = open * vec4(
    shallowPipe(c - ivec2(1, 0), bed, level, flow.x),
    shallowPipe(c + ivec2(1, 0), bed, level, flow.y),
    shallowPipe(c - ivec2(0, 1), bed, level, flow.z),
    shallowPipe(c + ivec2(0, 1), bed, level, flow.w));
${
  forcing === undefined
    ? ""
    : `  // Forced: the outflows ease toward the target velocity's over the target depth.
  vec4 force = shallowForcing(vUv, bed);
  if (force.w > 0.0) {
    vec4 target = open * vec4(max(-force.y, 0.0), max(force.y, 0.0), max(-force.z, 0.0), max(force.z, 0.0)) * max(force.x - bed, 0.0);
    q = mix(q, target, 1.0 - exp(-force.w * uDt));
  }
`
}  // No cell gives away more than it holds.
  float total = q.x + q.y + q.z + q.w;
  fragColor = total > 0.0 ? q * min(1.0, depth / (uDt * total)) : vec4(0.0);
}
`;

const WATER = (forcing: string | undefined): string => `${HEAD}
uniform sampler2D uFlux;
uniform float uMaxSpeed;
${forcing ?? ""}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec4 w = texelFetch(uWater, c, 0);
  vec4 f = texelFetch(uFlux, c, 0);
  float bed = texelFetch(uBed, c, 0).x;
  float inL = c.x > 0 ? texelFetch(uFlux, c - ivec2(1, 0), 0).y : 0.0;
  float inR = c.x < last.x ? texelFetch(uFlux, c + ivec2(1, 0), 0).x : 0.0;
  float inB = c.y > 0 ? texelFetch(uFlux, c - ivec2(0, 1), 0).w : 0.0;
  float inT = c.y < last.y ? texelFetch(uFlux, c + ivec2(0, 1), 0).z : 0.0;
  float depth = max(w.x + uDt * (inL + inR + inB + inT - (f.x + f.y + f.z + f.w)), 0.0);
  // The flow through the cell's faces, each axis the mean of its two, over the mean depth.
  vec2 velocity = 0.5 * vec2(inL - f.x + f.y - inR, inB - f.z + f.w - inT) / max(0.5 * (w.x + depth), ${MIN_DEPTH.toFixed(2)});
  float speed = length(velocity);
  if (speed > uMaxSpeed) velocity *= uMaxSpeed / speed;
${
  forcing === undefined
    ? ""
    : `  vec4 force = shallowForcing(vUv, bed);
  if (force.w > 0.0) depth = mix(depth, max(force.x - bed, 0.0), 1.0 - exp(-force.w * uDt));
`
}  fragColor = vec4(depth, velocity, 0.0);
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
 * a snippet that does not compile), `setBed`, `reset` it to still water, then each frame queue
 * splats, `step` a fixed dt as often as the clock asks, `carry` and `view` once, and hand the
 * renderer `surface.texture` (and `carried.texture`, `water.texture`): read them every frame, since
 * ping-pong sides swap.
 */
export class ShallowWater {
  readonly gpu: GpuCompute;
  readonly width: number;
  readonly height: number;
  /** r32f nearest: bed height (cells). */
  readonly bed: RenderTarget;
  /** rgba32f nearest: depth (cells), velocity xy (cells/s), 0. */
  readonly water: PingPong;
  /** rgba32f nearest: outflow through the left, right, bottom, top faces (cells²/s). */
  readonly flux: PingPong;
  /** rgba16f linear: the carry snippet's field; undefined without one. */
  readonly carried: PingPong | undefined;
  /** rgba16f linear, as of the last `view`: depth, level slope xy, caustic focus. */
  readonly surface: RenderTarget;
  readonly #flux: Pass;
  readonly #water: Pass;
  readonly #carry: Pass | undefined;
  readonly #surface: Pass;
  readonly #splat: Pass;
  readonly #all: readonly Pass[];
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
    try {
      this.#flux = pass(FLUX(options.forcing), "shallow flux");
      this.#water = pass(WATER(options.forcing), "shallow water");
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
    this.bed = gpu.target({ ...size, format: "r32f", filter: "nearest" });
    this.water = gpu.pingPong({ ...size, format: "rgba32f", filter: "nearest" });
    this.flux = gpu.pingPong({ ...size, format: "rgba32f", filter: "nearest" });
    this.carried =
      options.carry === undefined ? undefined : gpu.pingPong({ ...size, format: "rgba16f" });
    this.surface = gpu.target({ ...size, format: "rgba16f" });

    const gravity = options.gravity;
    for (const built of all)
      built.bind({ uBed: this.bed, uWater: this.water }).set({ uGravity: gravity });
    this.#flux
      .bind({ uFlux: this.flux })
      .set({ uFriction: options.friction ?? DEFAULT_FRICTION, uViscosity: options.viscosity ?? 0 });
    this.#water
      .bind({ uFlux: this.flux })
      .set({ uMaxSpeed: options.maxSpeed ?? DEFAULT_MAX_SPEED });
    if (this.#carry && this.carried) this.#carry.bind({ uCarry: this.carried });
    this.#surface.set({ uRefraction: options.refraction ?? DEFAULT_REFRACTION });
  }

  /** Lay the bed: width × height heights in cells, row 0 at the bottom. */
  setBed(heights: Float32Array): void {
    this.#check();
    this.#checkLength(heights, "bed");
    this.bed.seed(heights);
  }

  /**
   * Still water at these depths (width × height cells, row 0 at the bottom): no flow, no queued
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

  /** Land the queued splats, then advance `dt` seconds: the face flows, then the depths, both forced. */
  step(step: ShallowStep): void {
    this.#check();
    this.#flushSplats();
    if (step.uniforms) this.#snippet(step.uniforms, undefined, this.#flux, this.#water);
    if (step.textures) this.#snippet(undefined, step.textures, this.#flux, this.#water);
    const dt = Math.max(0, step.dt);
    if (dt === 0) return;
    const time = step.time ?? 0;
    this.#flux.run(this.flux, { uniforms: { uDt: dt, uTime: time } });
    this.#water.run(this.water, { uniforms: { uDt: dt, uTime: time } });
  }

  /**
   * Advance the carried field `dt` seconds along the current flow (usually once a frame with the
   * frame's sim time). Needs a carry snippet; its own uniforms persist.
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
    this.bed.dispose();
    this.water.dispose();
    this.flux.dispose();
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

  /** Hand a snippet's own uniforms and samplers to the passes that compile it (a typo throws). */
  #snippet(
    uniforms: Readonly<Record<string, UniformValue>> | undefined,
    textures: Readonly<Record<string, TextureSource>> | undefined,
    ...passes: Pass[]
  ): void {
    for (const values of [uniforms, textures]) {
      for (const name in values) {
        if (RESERVED[name] === true)
          throw new ShallowError(`shallow: ${name} is the solver's own uniform`);
        if (!passes.some((pass) => pass.declares(name)))
          throw new ShallowError(
            `shallow: the ${passes[0]?.name ?? "shallow"} snippet declares no ${name}`,
          );
      }
    }
    for (const pass of passes) {
      if (uniforms) pass.set(uniforms, false);
      if (textures) pass.bind(textures, false);
    }
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
