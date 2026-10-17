// Gray–Scott reaction–diffusion: a substrate u fed in at rate `feed` and an activator v that
// feeds on it (u + 2v -> 3v) and is removed at rate `kill`. Feed and kill alone pick the pattern
// class, independent of the diffusion's scale (J. E. Pearson, "Complex patterns in a simple
// system", Science 261, 1993). This module holds the classes worth showing as curated regimes,
// a loop through them for a pattern that drifts from one class into the next, and the explicit
// reaction step for GpuCompute passes (sims/gpu.ts). Grid, stencil, walls and seeding stay with the
// scene (petri: a disc of glass, a labyrinth seed).
//
// Units: D_u 1 and D_v 0.5 per texel², Karl Sims's ratio; the step is stable for dt <= 1 with
// the 9-point Laplacian (0.2 per side, 0.05 per corner, -1 centre). Keep u, v in rg32f: half
// floats round away the tiny per-step changes the reaction lives on.
//
// Seeding. A labyrinth at a stripe's and a gap's levels for fingerprints (u 0.37/0.68, v 0.3/0.07:
// petri's seedTuring) lives under the first regime, but most other classes starve it within a
// few hundred steps, and a dish settled in one class often dies outright when switched to
// another (holes to anything sparser, mazes to coral). Settle the seed at the first regime (petri:
// 140 steps) and ease feed and kill over to the target across a few hundred steps (petri: 640).
//
// Usage:
//   const step = gpu.pass(`
//     uniform sampler2D uState;
//     uniform float uDt;
//     uniform vec2 uFeedKill;
//     ${grayScottGlsl}
//     void main() {
//       ivec2 ij = ivec2(gl_FragCoord.xy);
//       vec2 c = texelFetch(uState, ij, 0).xy;
//       vec2 lap = ...; // the 9-point Laplacian of (u, v) round ij
//       fragColor = vec4(grayScottStep(c, lap, uFeedKill.x, uFeedKill.y, uDt), 0.0, 0.0);
//     }`, "my gray-scott");
//   const coral = grayScottRegimes[1];
//   step.set({ uDt: 1, uFeedKill: new Float32Array([coral.feed, coral.kill]) });
//   // or drifting: grayScottAlong(position, feedKill, 0) with position advancing in stops.
import { smoothstep } from "./math.ts";

export interface GrayScottRegime {
  /** Lab label. */
  readonly label: string;
  readonly feed: number;
  readonly kill: number;
  /** What grows, in a few plain words: for help text. */
  readonly grows: string;
}

/**
 * Pearson's classes that stay alive on a labyrinth seed, in the order of the drift's loop (each
 * next to the classes it eases into).
 */
export const grayScottRegimes: readonly GrayScottRegime[] = [
  { label: "fingerprints", feed: 0.037, kill: 0.06, grows: "long, parallel stripes" },
  { label: "coral", feed: 0.0545, kill: 0.062, grows: "stripes branching as they grow" },
  { label: "worms", feed: 0.05, kill: 0.0635, grows: "stripes breaking into short segments" },
  { label: "mitosis", feed: 0.0367, kill: 0.0649, grows: "spots dividing to fill the dish" },
  { label: "spots", feed: 0.03, kill: 0.062, grows: "spots holding still" },
  { label: "mazes", feed: 0.029, kill: 0.057, grows: "spots stretching into a maze" },
  { label: "holes", feed: 0.039, kill: 0.058, grows: "the maze swelling round dark holes" },
];

/**
 * Feed and kill at `position` along the loop through grayScottRegimes, in stops (wrapping: 0 and
 * regimes.length are the first regime), eased from one stop to the next, written to out[at] and
 * out[at + 1].
 */
export function grayScottAlong(position: number, out: Float32Array, at: number): void {
  const count = grayScottRegimes.length;
  const wrapped = ((position % count) + count) % count;
  const i = Math.floor(wrapped);
  const from = grayScottRegimes[i];
  const to = grayScottRegimes[(i + 1) % count];
  if (from === undefined || to === undefined)
    throw new Error(`grayscott: no regime at stop ${i} of ${count}`);
  const e = smoothstep(0, 1, wrapped - i);
  out[at] = from.feed + (to.feed - from.feed) * e;
  out[at + 1] = from.kill + (to.kill - from.kill) * e;
}

/**
 * GLSL: one explicit step of the reaction and diffusion for c = (u, v) and its Laplacian per
 * texel² (D_u 1, D_v 0.5), both kept in 0..1.
 *   vec2 grayScottStep(vec2 c, vec2 lap, float feed, float kill, float dt)
 */
export const grayScottGlsl = `
vec2 grayScottStep(vec2 c, vec2 lap, float feed, float kill, float dt) {
  float u = c.x;
  float v = c.y;
  float r = u * v * v;
  return vec2(
    clamp(u + dt * (lap.x - r + feed * (1.0 - u)), 0.0, 1.0),
    clamp(v + dt * (0.5 * lap.y + r - (feed + kill) * v), 0.0, 1.0));
}
`;
