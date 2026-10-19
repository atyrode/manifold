// When a front spreading from one point through a field of speeds reaches each texel, on the GPU
// (sims/gpu.ts): a soap film's burst rim racing through thin film and crawling through thick (film).
// The same shape fits a crack running through ice, fire creeping through grass, ink bleeding into
// paper.
//
// The front reaches p after T(p), the least time over paths from the source of ∫ ds / speed.
// `compute` writes it in two parts:
//   1. Along the straight line from the source, in fixed steps of reach / samples (each step's
//      slowness taken at its middle), so T only grows outward along every ray: where the front has
//      been, T ≤ t, is star-shaped about the source and so always one piece. A pocket of fast ground
//      past slow ground is reached only once the slow ground is crossed, never on its own.
//   2. `relax` sweeps of T = min(T, T(n) + edge time) over the 8 neighbours n (the edge time from
//      both ends' slowness), which let the front bend round slow patches and run along fast lanes,
//      a texel further per sweep. A texel only takes a time through a neighbour reached before it,
//      but corner to corner: keep the sweeps few. Against a 16-neighbour least-time solve of a
//      burst film, 8 sweeps leave the median 0.6% early and none 10% early (17% of texels 10%
//      late, where the quickest path bends far off the straight line); 64 sweeps let the front slip
//      diagonally through one-texel ridges (10% of texels 10% early) and part a speck off the hole.
// Then T ≤ t is where the front has been t seconds after it set off.
//
// Units. Positions are p = uv * domain (domain = (aspect, 1): frame heights, as in fluid.ts), speed
// in domain units per second, T in seconds. The target is rg16f with linear filtering: r is T
// (half floats: a step of about 1/2000 of T), g the slowness 1 / speed sampled where T was taken.
//
// Speed snippet (`speed`): GLSL defining
//     float frontSpeed(vec2 uv)   // domain units per second, > 0
// It may declare its own uniforms and samplers (give them in `compute`'s `uniforms` and
// `textures`); the names uFront*, front* other than frontSpeed are reserved.
//
//   new ArrivalField(gpu, { speed, samples?, relax?, name? })
//   compute(width, height, source, reach, domain, inputs?)   source: uv; reach: domain units the
//                                         straight steps span (the farthest point that matters:
//                                         farther ones carry on at the last step's slowness)
//   texture                               the latest arrival field, to hand the renderer (it
//                                         changes on every compute: read it every frame)
//   source                                the same for a pass's `bind` (follows every compute)
//   dispose()
//
// Cost per compute: width × height × (samples + 1) reads, then relax × 9 per texel, in 1 + relax
// draws: some 31 M reads for 569×320 at the defaults. Run it once per front, never per frame.
//
// Usage (the burst of a film whose thickness is in uFilm.r, rim speed from thickness):
//   const arrival = new ArrivalField(gpu, { speed: `
//     uniform sampler2D uFilm;
//     float frontSpeed(vec2 uv) { return 3.0 * inversesqrt(texture(uFilm, uv).r + 0.04); }` });
//   arrival.compute(columns, rows, [0.5, 0.95], 1.2, [aspect, 1], { textures: { uFilm: film } });
//   // later, t seconds after the break: gone = T(uv) <= t
import type { GpuCompute, Pass, PingPong, RunOptions, TextureSource } from "./gpu.ts";

export interface ArrivalOptions {
  /** GLSL defining `float frontSpeed(vec2 uv)` (see the file header). */
  speed: string;
  /** Straight steps over `reach` (default 96). */
  samples?: number;
  /** Neighbour sweeps after the straight pass (default 8). */
  relax?: number;
  /** Shown in errors. */
  name?: string;
}

const STRAIGHT = (samples: number) => `
uniform vec2 uFrontSource;
uniform vec2 uFrontDomain;
uniform float uFrontStep;
void main() {
  vec2 ray = (vUv - uFrontSource) * uFrontDomain;
  float d = length(ray);
  vec2 along = d > 0.0 ? ray / (d * uFrontDomain) * uFrontStep : vec2(0.0);
  int last = min(int(d / uFrontStep), ${samples - 1});
  float time = 0.0;
  float slowness = 0.0;
  for (int k = 0; k < ${samples}; k++) {
    slowness = 1.0 / max(frontSpeed(uFrontSource + (float(k) + 0.5) * along), 1e-4);
    if (k == last) break;
    time += uFrontStep * slowness;
  }
  time += (d - float(last) * uFrontStep) * slowness;
  fragColor = vec4(time, 1.0 / max(frontSpeed(vUv), 1e-4), 0.0, 1.0);
}
`;

const RELAX = `
uniform sampler2D uFront;
uniform vec2 uFrontDomain;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uSize) - 1;
  vec2 here = texelFetch(uFront, at, 0).rg;
  float best = here.r;
  for (int i = 0; i < 9; i++) {
    ivec2 o = ivec2(i % 3 - 1, i / 3 - 1);
    if (i == 4) continue;
    vec2 n = texelFetch(uFront, clamp(at + o, ivec2(0), last), 0).rg;
    best = min(best, n.r + length(vec2(o) * uTexel * uFrontDomain) * 0.5 * (here.g + n.g));
  }
  fragColor = vec4(best, here.g, 0.0, 1.0);
}
`;

/** Arrival times of a front from one point through a speed field (see the file header). */
export class ArrivalField {
  readonly #field: PingPong;
  readonly #straight: Pass;
  readonly #relax: Pass;
  readonly #sweeps: number;
  readonly #samples: number;
  readonly #source = new Float32Array(2);
  readonly #domain = new Float32Array(2);

  constructor(gpu: GpuCompute, options: ArrivalOptions) {
    const name = options.name ?? "front";
    this.#samples = Math.max(1, Math.round(options.samples ?? 96));
    this.#sweeps = Math.max(0, Math.round(options.relax ?? 8));
    this.#field = gpu.pingPong({ width: 1, height: 1, format: "rg16f" });
    this.#straight = gpu.pass(options.speed + STRAIGHT(this.#samples), `${name} arrival`);
    this.#relax = gpu.pass(RELAX, `${name} arrival relax`);
    this.#relax.bind({ uFront: this.#field });
  }

  /** The latest arrival field for the renderer: r seconds, g slowness (it changes on every compute). */
  get texture(): WebGLTexture {
    return this.#field.texture;
  }

  /** The arrival field for a pass to sample (looked up when the pass runs, so it follows computes). */
  get source(): TextureSource {
    return this.#field;
  }

  /**
   * Arrival times on a width × height grid from `source` (uv), straight steps spanning `reach`
   * domain units, positions p = uv * domain; `inputs` feeds the speed snippet.
   */
  compute(
    width: number,
    height: number,
    source: readonly [number, number],
    reach: number,
    domain: readonly [number, number],
    inputs: RunOptions = {},
  ): void {
    this.#field.resize(width, height);
    this.#source[0] = source[0];
    this.#source[1] = source[1];
    this.#domain[0] = domain[0];
    this.#domain[1] = domain[1];
    if (inputs.textures) this.#straight.bind(inputs.textures);
    if (inputs.uniforms) this.#straight.set(inputs.uniforms);
    this.#straight.run(this.#field, {
      uniforms: {
        uFrontSource: this.#source,
        uFrontDomain: this.#domain,
        uFrontStep: Math.max(reach, 1e-6) / this.#samples,
      },
    });
    this.#relax.set({ uFrontDomain: this.#domain });
    for (let i = 0; i < this.#sweeps; i++) this.#relax.run(this.#field);
  }

  dispose(): void {
    this.#field.dispose();
    this.#straight.dispose();
    this.#relax.dispose();
  }
}
