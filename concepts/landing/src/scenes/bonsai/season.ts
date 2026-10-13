// The year on the tree, written twice on purpose: in TypeScript for the sim (which leaves are loose,
// what colour a falling leaf is) and in GLSL for the shader (each tuft's foliage), with the same
// numbers, so a leaf lets go from a tuft that is thinning and falls in that tuft's colour.
//
// The year phase y runs 0..1 from the start of spring: spring 0-0.25, summer 0.25-0.5, autumn
// 0.5-0.75, winter 0.75-1. Each tuft carries two random numbers r1 (timing) and r2 (colour) and how
// far out on its pad it sits (outer 0..1): outer tufts turn and drop first, as on a real tree.
// Hue is a position on the leaf palette: 0 deep summer green, 0.2 fresh green, 0.45 yellow,
// 0.62 orange, 0.85 red, 1 deep crimson.
import { BONSAI_MAPLE, BONSAI_PINE, BONSAI_SAKURA } from "./geometry.ts";

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** When a deciduous tuft's leaves come out, turn and fall (year phase). */
function timing(species: number, r1: number, outer: number): { out: number; turn: number; fall: number } {
  if (species === BONSAI_SAKURA) {
    const out = 0.1 + 0.04 * r1;
    const turn = 0.55 + 0.06 * r1 - 0.04 * outer;
    return { out, turn, fall: turn + 0.05 + 0.03 * r1 };
  }
  const out = 0.035 + 0.05 * r1 - 0.015 * outer;
  const turn = 0.53 + 0.07 * r1 - 0.05 * outer;
  return { out, turn, fall: turn + 0.05 + 0.03 * r1 };
}

/** How much of a tuft's foliage is on it, 0..1. Pine keeps its needles; a tuft regrowing after a
 *  cut fills in through spring whatever the species. */
export function bonsaiLeafiness(species: number, y: number, r1: number, outer: number, regrow: boolean): number {
  if (species === BONSAI_PINE) return regrow ? smoothstep(0.05 + 0.05 * r1, 0.2, y) : 1;
  const k = timing(species, r1, outer);
  return smoothstep(k.out, k.out + 0.09, y) * (1 - smoothstep(k.fall, k.fall + 0.075, y));
}

/** How fast a tuft is losing foliage (per unit of year phase), for leaf release. */
export function bonsaiShedding(species: number, y: number, r1: number, outer: number): number {
  if (species === BONSAI_PINE) {
    // Old inner needles yellow and drop through early autumn.
    const s = smoothstep(0.55, 0.62, y) * (1 - smoothstep(0.66, 0.74, y));
    return s * (1 - outer) * 1.5;
  }
  const k = timing(species, r1, outer);
  const a = smoothstep(k.fall, k.fall + 0.075, y - 0.004);
  const b = smoothstep(k.fall, k.fall + 0.075, y + 0.004);
  return Math.max(0, (b - a) / 0.008);
}

/** The palette position of a tuft's foliage now. */
export function bonsaiHue(species: number, y: number, r1: number, r2: number, outer: number): number {
  if (species === BONSAI_PINE) {
    // Needles: fresh tips in late spring, a little gold in the old inner needles in autumn.
    const fresh = smoothstep(0.12, 0.2, y) * (1 - smoothstep(0.3, 0.42, y));
    const gold = smoothstep(0.55, 0.63, y) * (1 - smoothstep(0.7, 0.78, y)) * (1 - outer);
    return 0.06 * r2 + 0.16 * fresh + 0.3 * gold;
  }
  const k = timing(species, r1, outer);
  // Japanese maple leaves open red-bronze and green over a few weeks; the cherry's open bronze-green.
  const opening = 1 - smoothstep(k.out + 0.03, k.out + 0.13, y);
  let hue = mix(0.2, species === BONSAI_MAPLE ? 0.86 : 0.5, opening);
  hue = mix(hue, 0.03 * r2, smoothstep(k.out + 0.1, 0.32, y));
  // Autumn: green to gold to orange to red; some tufts stop at orange.
  const autumn = species === BONSAI_MAPLE ? mix(0.66, 0.97, r2) : mix(0.5, 0.82, r2);
  const turn = smoothstep(k.turn, k.turn + 0.1, y);
  return mix(hue, autumn, turn);
}

/** Cherry blossom on a tuft, 0..1: opens before the leaves, then the petals fall. */
export function bonsaiBlossom(species: number, y: number, r1: number): number {
  if (species !== BONSAI_SAKURA) return 0;
  const b0 = 0.012 + 0.03 * r1;
  return smoothstep(b0, b0 + 0.03, y) * (1 - smoothstep(b0 + 0.06, b0 + 0.11, y));
}

/** How fast a cherry tuft is dropping petals. */
export function bonsaiPetalFall(species: number, y: number, r1: number): number {
  if (species !== BONSAI_SAKURA) return 0;
  const b0 = 0.012 + 0.03 * r1;
  const a = smoothstep(b0 + 0.06, b0 + 0.11, y - 0.004);
  const b = smoothstep(b0 + 0.06, b0 + 0.11, y + 0.004);
  return Math.max(0, (b - a) / 0.008) * smoothstep(b0, b0 + 0.03, y);
}

/** The same schedule in GLSL (species, y, and per-tuft r1, r2, outer, regrow). */
export const bonsaiSeasonGlsl = `
void bonsaiTiming(float species, float r1, float outer, out float outAt, out float turnAt, out float fallAt) {
  if (species > 1.5) {
    outAt = 0.1 + 0.04 * r1;
    turnAt = 0.55 + 0.06 * r1 - 0.04 * outer;
    fallAt = turnAt + 0.05 + 0.03 * r1;
  } else {
    outAt = 0.035 + 0.05 * r1 - 0.015 * outer;
    turnAt = 0.53 + 0.07 * r1 - 0.05 * outer;
    fallAt = turnAt + 0.05 + 0.03 * r1;
  }
}

float bonsaiLeafiness(float species, float y, float r1, float outer, float regrow) {
  if (species < 0.5) return regrow > 0.5 ? smoothstep(0.05 + 0.05 * r1, 0.2, y) : 1.0;
  float o, c, f;
  bonsaiTiming(species, r1, outer, o, c, f);
  return smoothstep(o, o + 0.09, y) * (1.0 - smoothstep(f, f + 0.075, y));
}

float bonsaiHue(float species, float y, float r1, float r2, float outer) {
  if (species < 0.5) {
    float fresh = smoothstep(0.12, 0.2, y) * (1.0 - smoothstep(0.3, 0.42, y));
    float gold = smoothstep(0.55, 0.63, y) * (1.0 - smoothstep(0.7, 0.78, y)) * (1.0 - outer);
    return 0.06 * r2 + 0.16 * fresh + 0.3 * gold;
  }
  float o, c, f;
  bonsaiTiming(species, r1, outer, o, c, f);
  float opening = 1.0 - smoothstep(o + 0.03, o + 0.13, y);
  float hue = mix(0.2, species < 1.5 ? 0.86 : 0.5, opening);
  hue = mix(hue, 0.03 * r2, smoothstep(o + 0.1, 0.32, y));
  float autumn = species < 1.5 ? mix(0.66, 0.97, r2) : mix(0.5, 0.82, r2);
  return mix(hue, autumn, smoothstep(c, c + 0.1, y));
}

float bonsaiBlossom(float species, float y, float r1) {
  if (species < 1.5) return 0.0;
  float b0 = 0.012 + 0.03 * r1;
  return smoothstep(b0, b0 + 0.03, y) * (1.0 - smoothstep(b0 + 0.06, b0 + 0.11, y));
}
`;
