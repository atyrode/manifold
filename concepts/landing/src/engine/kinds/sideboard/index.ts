// A sideboard: a long low cabinet of wood on four short legs, a row of drawers under its top and
// doors under them, its back to a wall (-z). Its size and its wood's tone are its options; it casts
// shadows, and things stand on its top (the lab casts against its boxes exactly).
import { range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";
import { castBox, Nearest, WOOD_TEAK } from "../joinery.ts";

/** Its measures, metres: the top's thickness and overhang in front, the legs' height, section and inset. */
export const SIDEBOARD = {
  top: 0.028,
  overhang: 0.015,
  legs: 0.15,
  leg: 0.035,
  inset: [0.09, 0.08],
  /** The drawers' band under the top. */
  drawers: 0.13,
} as const;

/** Its boxes for these options, its own frame, each with its part: 0 the top, 1 the carcass, 2 a leg. */
export function sideboardBoxes(
  options: Readonly<Record<string, number>>,
): (readonly [Vec3, Vec3, number])[] {
  const w = (options["width"] ?? 1.6) / 2;
  const d = (options["depth"] ?? 0.45) / 2;
  const h = options["height"] ?? 0.75;
  const { top, overhang, legs, leg, inset } = SIDEBOARD;
  return [
    [[-w, h - top, -d], [w, h, d], 0],
    [[-w + 0.01, legs, -d], [w - 0.01, h - top, d - overhang], 1],
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz): readonly [Vec3, Vec3, number] => {
        const x = sx * (w - inset[0]);
        const z = sz * (d - inset[1]);
        return [[x - leg / 2, 0, z - leg / 2], [x + leg / 2, legs + 0.005, z + leg / 2], 2];
      }),
    ),
  ];
}

export const sideboardKind: KindDef = {
  id: "sideboard",
  title: "Sideboard",
  blurb: "A long low cabinet on short legs, drawers over its doors: things stand on its top.",
  family: "furniture",
  options: [
    range("sideboard", "width", "width", 1.6, "Across, metres.", { min: 0.6, max: 3, step: 0.05 }),
    range("sideboard", "depth", "depth", 0.45, "Front to back, metres.", {
      min: 0.3,
      max: 0.7,
      step: 0.01,
    }),
    range("sideboard", "height", "height", 0.75, "Its top over the floor, metres.", {
      min: 0.45,
      max: 1.2,
      step: 0.01,
    }),
    range(
      "sideboard",
      "tone",
      "wood",
      WOOD_TEAK,
      "Its wood: dark walnut at the left, teak in the middle, pale birch at the right.",
    ),
  ],
  bounds(options) {
    const w = (options["width"] ?? 1.6) / 2;
    const d = (options["depth"] ?? 0.45) / 2;
    return { min: [-w, 0, -d], max: [w, options["height"] ?? 0.75, d] };
  },
  max: 8,
  rests: "surface",
  casts: true,
  cast(options, ro, rd, [from, to]) {
    const near = new Nearest(to);
    for (const [lo, hi, part] of sideboardBoxes(options))
      near.take(castBox(lo, hi, ro, rd, from, near.t), part);
    return near.piece < 0 ? undefined : { t: near.t, normal: near.normal };
  },
  code: () => import("./code.ts"),
};
