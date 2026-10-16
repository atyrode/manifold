// Seeded value noise on the CPU, for laying out terrain, coasts and beds before a sim starts.
//
//   valueNoise(x, y, seed)          smooth noise in [0, 1] on the integer lattice, Hermite-blended
//   fbm(x, y, seed, octaves)        fractal sum of valueNoise, 0..1: each octave twice as fine (×2.03,
//                                   shifted) at half the weight, each with its own seed (seed + 17·o)
//
// The lattice hash is `hash31(i, j, seed + 1)` (math.ts): a copy that hashed `hash31(i, j, salt)`
// is `valueNoise(x, y, salt - 1)` bit for bit, so it can switch without moving a layout.
// GLSL noise (vnoise, fbm) is a different hash: a layout drawn here is not the shader's noise.
//
// Usage:
//   const rock = fbm(x * 6, y * 6, seed, 4);                 // x, y in frame heights
//   const ridge = 1 - Math.abs(2 * valueNoise(x * 9, y * 2, seed + 5) - 1);
import { hash31 } from "./math.ts";

/** Smooth value noise in [0, 1]: lattice values blended with the Hermite curve. */
export function valueNoise(x: number, y: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash31(i, j, seed + 1);
  const b = hash31(i + 1, j, seed + 1);
  const c = hash31(i, j + 1, seed + 1);
  const d = hash31(i + 1, j + 1, seed + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Fractal value noise, 0..1 (see the header). */
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, seed + o * 17);
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.2;
    amp *= 0.5;
  }
  return sum / norm;
}
