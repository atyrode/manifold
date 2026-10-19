// A wall shelf: a wooden board on two iron brackets, its back to a wall (-z), hung at any height
// (it rests where it is put: KindDef.rests "free"). Its size and its wood's tone are its options; it
// casts shadows, and things stand on its board (the lab casts against its pieces exactly).
import { range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";
import { castBox, type Cut, Nearest } from "../joinery.ts";

/** Its measures, metres: the board's thickness, the brackets' drop, their arms' and plate's thickness. */
export const SHELF = { board: 0.025, drop: 0.17, arm: 0.018, plate: 0.012, web: 0.006 } as const;

/**
 * Its pieces for these options, its own frame, each with its part (0 the board, 1 a bracket) and the
 * plane that cuts it, if any (a bracket's web, a triangle under its arms).
 */
export function shelfPieces(
  options: Readonly<Record<string, number>>,
): (readonly [Vec3, Vec3, number, Cut?])[] {
  const w = (options["width"] ?? 0.9) / 2;
  const d = (options["depth"] ?? 0.22) / 2;
  const { board, drop, arm, plate, web } = SHELF;
  const reach = 2 * d - 0.03;
  const slope = drop / (reach - 0.01);
  return [
    [[-w, drop, -d], [w, drop + board, d], 0],
    ...[-1, 1].flatMap((side): (readonly [Vec3, Vec3, number, Cut?])[] => {
      const x = side * (w - Math.min(0.12, w / 2));
      return [
        [[x - plate, 0, -d], [x + plate, drop, -d + arm], 1],
        [[x - plate, drop - arm, -d], [x + plate, drop, -d + reach], 1],
        [[x - web, 0, -d], [x + web, drop, -d + reach - 0.01], 1, [0, -1, slope, -slope * d]],
      ];
    }),
  ];
}

export const shelfKind: KindDef = {
  id: "shelf",
  title: "Wall shelf",
  blurb: "A wooden board on two iron brackets, hung on a wall at any height: things stand on it.",
  family: "furniture",
  options: [
    range("shelf", "width", "width", 0.9, "Across, metres.", { min: 0.3, max: 2.4, step: 0.05 }),
    range("shelf", "depth", "depth", 0.22, "Out from the wall, metres.", {
      min: 0.12,
      max: 0.4,
      step: 0.01,
    }),
    range(
      "shelf",
      "tone",
      "wood",
      0.5,
      "Its board's wood: dark walnut at the left, teak in the middle, pale birch at the right.",
    ),
  ],
  bounds(options) {
    const w = (options["width"] ?? 0.9) / 2;
    const d = (options["depth"] ?? 0.22) / 2;
    return { min: [-w, 0, -d], max: [w, SHELF.drop + SHELF.board, d] };
  },
  max: 16,
  rests: "free",
  casts: true,
  cast(options, ro, rd, [from, to]) {
    const near = new Nearest(to);
    for (const [lo, hi, part, cut] of shelfPieces(options))
      near.take(castBox(lo, hi, ro, rd, from, near.t, cut), part);
    return near.piece < 0 ? undefined : { t: near.t, normal: near.normal };
  },
  code: () => import("./code.ts"),
};
