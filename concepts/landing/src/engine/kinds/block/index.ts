// A block: a box standing on its base, sized each way, of one material. Walls, steps, plinths;
// it casts shadows. Its shape is its bounds, so the lab picks it by them (no `cast`).
import { choice, range } from "../../../params.ts";
import type { KindDef } from "../../types.ts";

/** The materials, in the `material` option's order. */
export const BLOCK_MATERIALS = ["plaster", "timber", "stone", "brick", "slate"] as const;

const size = (key: string, label: string, value: number, help: string) =>
  range("block", key, label, value, help, { min: 0.02, max: 30, step: 0.01 });

export const blockKind: KindDef = {
  id: "block",
  title: "Block",
  blurb:
    "A box standing on its base: a wall, a step, a plinth, of plaster, timber, stone, brick or slate.",
  family: "structure",
  options: [
    size("width", "width", 1, "Across, metres."),
    size("height", "height", 1, "Up, metres."),
    size("depth", "depth", 1, "Front to back, metres."),
    choice(
      "block",
      "material",
      "material",
      BLOCK_MATERIALS.map((label, value) => ({ label, value })),
      0,
      "What it is made of: plaster, timber planks, stone blocks, brick courses or dark slate.",
    ),
  ],
  bounds(options) {
    const w = (options["width"] ?? 1) / 2;
    const d = (options["depth"] ?? 1) / 2;
    return { min: [-w, 0, -d], max: [w, options["height"] ?? 1, d] };
  },
  max: 32,
  rests: "surface",
  casts: true,
  code: () => import("./code.ts"),
};
