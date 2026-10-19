// A table: a wooden top on an apron and four square legs. Its size and its wood's tone are its
// options; it casts shadows, and things stand on its top (the lab casts against its boxes exactly).
import { range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";
import { castBox, Nearest } from "../joinery.ts";

/** Its measures, metres: the top's thickness, the apron's height and board, the legs' section and inset. */
export const TABLE = { top: 0.035, apron: 0.085, board: 0.02, leg: 0.05, inset: 0.06 } as const;

/** Its boxes for these options, its own frame, each with its part: 0 the top, 1 the apron, 2 a leg. */
export function tableBoxes(
  options: Readonly<Record<string, number>>,
): (readonly [Vec3, Vec3, number])[] {
  const w = (options["width"] ?? 1.2) / 2;
  const d = (options["depth"] ?? 0.75) / 2;
  const h = options["height"] ?? 0.75;
  const { top, apron, board, leg, inset } = TABLE;
  const under = h - top;
  const x = w - inset;
  const z = d - inset;
  return [
    [[-w, under, -d], [w, h, d], 0],
    [[-x, under - apron, z - board], [x, under, z], 1],
    [[-x, under - apron, -z], [x, under, -z + board], 1],
    [[x - board, under - apron, -z], [x, under, z], 1],
    [[-x, under - apron, -z], [-x + board, under, z], 1],
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz): readonly [Vec3, Vec3, number] => [
        [sx > 0 ? x - leg : -x, 0, sz > 0 ? z - leg : -z],
        [sx > 0 ? x : -x + leg, under, sz > 0 ? z : -z + leg],
        2,
      ]),
    ),
  ];
}

export const tableKind: KindDef = {
  id: "table",
  title: "Table",
  blurb: "A wooden top on an apron and four legs: things stand on it.",
  family: "furniture",
  options: [
    range("table", "width", "width", 1.2, "Across, metres.", { min: 0.4, max: 3, step: 0.05 }),
    range("table", "depth", "depth", 0.75, "Front to back, metres.", {
      min: 0.4,
      max: 1.6,
      step: 0.05,
    }),
    range("table", "height", "height", 0.75, "Its top over the floor, metres.", {
      min: 0.35,
      max: 1.1,
      step: 0.01,
    }),
    range(
      "table",
      "tone",
      "wood",
      0.62,
      "Its wood: dark walnut at the left, teak in the middle, pale birch at the right.",
    ),
  ],
  bounds(options) {
    const w = (options["width"] ?? 1.2) / 2;
    const d = (options["depth"] ?? 0.75) / 2;
    return { min: [-w, 0, -d], max: [w, options["height"] ?? 0.75, d] };
  },
  max: 8,
  rests: "surface",
  casts: true,
  cast(options, ro, rd, [from, to]) {
    const near = new Nearest(to);
    for (const [lo, hi, part] of tableBoxes(options))
      near.take(castBox(lo, hi, ro, rd, from, near.t), part);
    return near.piece < 0 ? undefined : { t: near.t, normal: near.normal };
  },
  code: () => import("./code.ts"),
};
