// A tree: a trunk and limbs of tapered capsules branching from its seed, its foliage clumps of
// leaves (needles on the evergreens) by its species, coloured by the time of year, swaying in the
// World's wind and casting dappled shadows. The code (code.ts) builds the same tree for every ray
// from its seed; the lab picks it by its envelope (`treeEnvelope`: the trunk and the crown's
// ellipsoid), which every branch and clump of it lies within.
import { choice, range, seed } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";

/** The species, in the `species` option's order. */
export const TREE_SPECIES = ["oak", "birch", "pine", "windswept"] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];

/** How far below its base the trunk reaches, metres: it stays rooted on a slope. */
export const TREE_ROOT = 0.5;

/** A tree's outline: its trunk's foot radius and height, and the crown's ellipsoid (centre, radii). */
export interface TreeEnvelope {
  readonly trunk: number;
  readonly fork: number;
  readonly centre: Vec3;
  readonly radii: Vec3;
}

/** The trunk's radius at the foot, metres, for a tree `h` tall and `s` across. */
export function treeTrunk(species: TreeSpecies, h: number, s: number): number {
  switch (species) {
    case "oak":
      return 0.02 * h + 0.012 * s;
    case "birch":
      return 0.011 * h + 0.004 * s;
    case "pine":
      return 0.016 * h + 0.004 * s;
    case "windswept":
      return 0.028 * h + 0.012 * s;
  }
}

/** The species' outline (TreeEnvelope) for height `h` and crown width `s`, metres. */
export function treeEnvelope(species: TreeSpecies, h: number, s: number): TreeEnvelope {
  const trunk = treeTrunk(species, h, s);
  switch (species) {
    case "oak":
      return {
        trunk,
        fork: 0.42 * h,
        centre: [0, 0.68 * h, 0],
        radii: [0.6 * s, 0.36 * h, 0.6 * s],
      };
    case "birch":
      return { trunk, fork: h, centre: [0, 0.66 * h, 0], radii: [0.55 * s, 0.4 * h, 0.55 * s] };
    case "pine":
      return { trunk, fork: h, centre: [0, 0.6 * h, 0], radii: [0.56 * s, 0.46 * h, 0.56 * s] };
    case "windswept":
      return {
        trunk,
        fork: 0.35 * h,
        centre: [0.38 * s, 0.72 * h, 0],
        radii: [0.62 * s, 0.36 * h, 0.42 * s],
      };
  }
}

/** The species of these option values. */
export function treeSpecies(options: Readonly<Record<string, number>>): TreeSpecies {
  return TREE_SPECIES[Math.round(options["species"] ?? 0)] ?? "oak";
}

/** Where the ray ro + rd t first meets the ellipsoid (centre c, radii r) within span. */
function ellipsoid(
  ro: Vec3,
  rd: Vec3,
  c: Vec3,
  r: Vec3,
  span: readonly [number, number],
): { readonly t: number; readonly normal: Vec3 } | undefined {
  const o: Vec3 = [(ro[0] - c[0]) / r[0], (ro[1] - c[1]) / r[1], (ro[2] - c[2]) / r[2]];
  const d: Vec3 = [rd[0] / r[0], rd[1] / r[1], rd[2] / r[2]];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const disc = b * b - a * (o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1);
  if (disc < 0) return undefined;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < span[0] || t > span[1]) return undefined;
  const q: Vec3 = [(o[0] + d[0] * t) / r[0], (o[1] + d[1] * t) / r[1], (o[2] + d[2] * t) / r[2]];
  const length = Math.hypot(q[0], q[1], q[2]);
  return { t, normal: [q[0] / length, q[1] / length, q[2] / length] };
}

/** Where the ray first meets the upright trunk (radius r, from below the base to `top`). */
function trunk(
  ro: Vec3,
  rd: Vec3,
  r: number,
  top: number,
  span: readonly [number, number],
): { readonly t: number; readonly normal: Vec3 } | undefined {
  const a = rd[0] * rd[0] + rd[2] * rd[2];
  if (a < 1e-12) return undefined;
  const b = ro[0] * rd[0] + ro[2] * rd[2];
  const disc = b * b - a * (ro[0] * ro[0] + ro[2] * ro[2] - r * r);
  if (disc < 0) return undefined;
  const t = (-b - Math.sqrt(disc)) / a;
  const y = ro[1] + rd[1] * t;
  if (t < span[0] || t > span[1] || y < -TREE_ROOT || y > top) return undefined;
  return { t, normal: [(ro[0] + rd[0] * t) / r, 0, (ro[2] + rd[2] * t) / r] };
}

export const treeKind: KindDef = {
  id: "tree",
  title: "Tree",
  blurb:
    "A tree grown from its seed: an oak, a birch, a pine or a windswept pine, swaying in the wind, in leaf by the time of year.",
  family: "plant",
  options: [
    choice(
      "tree",
      "species",
      "species",
      TREE_SPECIES.map((label, value) => ({ label, value })),
      0,
      "A broad oak, a slender birch, a tiered pine, or a pine swept to one side by the wind.",
    ),
    range("tree", "height", "height", 8, "How tall it grows, metres.", {
      min: 1.5,
      max: 24,
      step: 0.5,
    }),
    range("tree", "spread", "spread", 6, "How wide its crown spreads, metres.", {
      min: 1,
      max: 18,
      step: 0.25,
    }),
    seed("tree", "seed", "seed", "Which tree of its species: how its limbs branch and lean."),
    range(
      "tree",
      "season",
      "season",
      0.3,
      "The time of year its leaves show where the World keeps none: 0 spring, .25 summer, .5 autumn, .75 winter (bare).",
      { step: 0.01 },
    ),
  ],
  compiled: ["species"],
  bounds(options) {
    const species = treeSpecies(options);
    const h = options["height"] ?? 8;
    const s = options["spread"] ?? 6;
    const { centre, radii } = treeEnvelope(species, h, s);
    // The crown sways downwind by up to a tenth of the height either way.
    const sway = 0.1 * h;
    return {
      min: [Math.min(centre[0] - radii[0], -s * 0.2) - sway, -TREE_ROOT, -radii[2] - sway],
      max: [centre[0] + radii[0] + sway, centre[1] + radii[1] + sway * 0.3, radii[2] + sway],
    };
  },
  max: 16,
  rests: "surface",
  casts: true,
  cast(options, ro, rd, span) {
    const species = treeSpecies(options);
    const h = options["height"] ?? 8;
    const s = options["spread"] ?? 6;
    const shape = treeEnvelope(species, h, s);
    const wood = trunk(ro, rd, shape.trunk, shape.fork, span);
    const crown = ellipsoid(ro, rd, shape.centre, shape.radii, span);
    if (wood === undefined) return crown;
    if (crown === undefined) return wood;
    return wood.t < crown.t ? wood : crown;
  },
  code: () => import("./code.ts"),
};
