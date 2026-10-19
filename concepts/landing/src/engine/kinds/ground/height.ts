// The ground's height, on the CPU and in GLSL from the same numbers, so what the lab drags over is
// the ground drawn. A shape of rolling land in -1..1: the plan warped once at the base scale, then
// five octaves, each a product of two sines on axes turned by the golden angle, finer and fainter in
// turn. `relief` scales it to metres and the ground's origin lies on it (its level there is taken
// off), `spread` is the base octave's wavelength in metres. Detail by distance: an octave fades out
// once a cell's footprint spans a fair share of its wavelength (GLSL `groundShape`'s `foot`); the CPU
// reads every octave, as the shader does near the eye.
import { glslFloat } from "../../../shaders/glsl.ts";

interface Octave {
  /** Cycles per `spread`. */
  readonly f: number;
  /** Its share of the shape; the shares sum to 1. */
  readonly a: number;
  /** The turn of its axes, radians. */
  readonly turn: number;
  /** Its phases along its two axes. */
  readonly phase: readonly [number, number];
}

const OCTAVES: readonly Octave[] = [
  { f: 1, a: 0.55, turn: 0, phase: [0.4, 1.9] },
  { f: 2.13, a: 0.25, turn: 2.39996, phase: [2.7, 0.6] },
  { f: 4.41, a: 0.12, turn: 4.79993, phase: [1.3, 3.8] },
  { f: 8.93, a: 0.05, turn: 7.19989, phase: [5.1, 2.2] },
  { f: 17.6, a: 0.03, turn: 9.59986, phase: [0.9, 4.6] },
];
/** How far the warp moves the plan, in base wavelengths, and the warp's own frequencies. */
const WARP = 0.18;
const WARP_F: readonly [number, number] = [0.71, 0.53];
/** The second axis's frequency against the first: the hills are longer one way than the other. */
const ASPECT = 0.77;
const TAU = Math.PI * 2;

/** The shape at plan point (x, z) in base wavelengths, every octave: -1..1. */
export function groundShape(x: number, z: number): number {
  const wx = x + WARP * Math.sin(TAU * WARP_F[0] * z + 0.7);
  const wz = z + WARP * Math.sin(TAU * WARP_F[1] * x + 2.3);
  let sum = 0;
  for (const { f, a, turn, phase } of OCTAVES) {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const u = (c * wx - s * wz) * f * TAU;
    const v = (s * wx + c * wz) * f * TAU * ASPECT;
    sum += a * Math.sin(u + phase[0]) * Math.cos(v + phase[1]);
  }
  return sum;
}

/** The ground's height over its origin at (x, z) in its own frame, metres. */
export function groundHeight(x: number, z: number, relief: number, spread: number): number {
  return relief * (groundShape(x / spread, z / spread) - groundShape(0, 0));
}

/**
 * The steepest slope the shape can have, per unit of relief over spread (its Lipschitz bound). The
 * march trusts a share of it (GROUND_TRUST, the kind's GLSL) and refines what it overshoots.
 */
export const GROUND_SLOPE =
  TAU *
  Math.hypot(1, ASPECT) *
  (1 + TAU * WARP * Math.max(...WARP_F)) *
  OCTAVES.reduce((sum, { f, a }) => sum + a * f, 0);

/** `groundShape` in GLSL, with detail by distance: `foot`, a cell's footprint in base wavelengths. */
export const groundShapeGlsl = `
// The ground's shape at plan point q (base wavelengths): -1..1, src/engine/kinds/ground/height.ts's
// twin; foot, a cell's footprint in base wavelengths, fades an octave out once it spans a fair share
// of its wavelength.
float groundShape(vec2 q, float foot) {
  vec2 w = q + ${glslFloat(WARP)} * sin(TAU * vec2(${glslFloat(WARP_F[0])} * q.y + 0.7 / TAU, ${glslFloat(WARP_F[1])} * q.x + 2.3 / TAU));
  float sum = 0.0;
${OCTAVES.map(
  ({ f, a, turn, phase }) =>
    `  {
    vec2 r = vec2(${glslFloat(Math.cos(turn))} * w.x - ${glslFloat(Math.sin(turn))} * w.y, ${glslFloat(Math.sin(turn))} * w.x + ${glslFloat(Math.cos(turn))} * w.y) * ${glslFloat(f * TAU)};
    sum += ${glslFloat(a)} * (1.0 - smoothstep(0.12, 0.35, foot * ${glslFloat(f)})) * sin(r.x + ${glslFloat(phase[0])}) * cos(r.y * ${glslFloat(ASPECT)} + ${glslFloat(phase[1])});
  }`,
).join("\n")}
  return sum;
}
const float GROUND_SLOPE = ${glslFloat(GROUND_SLOPE)};
`;
