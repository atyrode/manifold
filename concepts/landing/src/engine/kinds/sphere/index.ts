// A sphere resting on its base: matte, glossy or a mirror (a compile-time choice: a mirror traces
// the one reflected ray), of any hue; it casts shadows.
import { choice, range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";

/** The materials, in the `material` option's order. */
export const SPHERE_MATERIALS = ["matte", "gloss", "mirror"] as const;

export const sphereKind: KindDef = {
  id: "sphere",
  title: "Sphere",
  blurb: "A ball resting on its base: matte, glossy or a mirror that shows the world round it.",
  family: "prop",
  options: [
    range("sphere", "radius", "radius", 0.5, "Its radius, metres.", {
      min: 0.05,
      max: 10,
      step: 0.05,
    }),
    choice(
      "sphere",
      "material",
      "material",
      SPHERE_MATERIALS.map((label, value) => ({ label, value })),
      0,
      "Matte, glossy with the sun's highlight, or a mirror showing the world round it.",
    ),
    range("sphere", "hue", "hue", 0.02, "Its colour round the hues, red at both ends."),
    range("sphere", "tone", "tone", 0.6, "Dark to light."),
  ],
  compiled: ["material"],
  bounds(options) {
    const r = options["radius"] ?? 0.5;
    return { min: [-r, 0, -r], max: [r, 2 * r, r] };
  },
  max: 32,
  rests: "surface",
  casts: true,
  cast(options, ro, rd, span) {
    const r = options["radius"] ?? 0.5;
    const o: Vec3 = [ro[0], ro[1] - r, ro[2]];
    const b = o[0] * rd[0] + o[1] * rd[1] + o[2] * rd[2];
    const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
    const disc = b * b - c;
    if (disc < 0) return undefined;
    const t = -b - Math.sqrt(disc);
    if (t < span[0] || t > span[1]) return undefined;
    return {
      t,
      normal: [(o[0] + rd[0] * t) / r, (o[1] + rd[1] * t) / r, (o[2] + rd[2] * t) / r],
    };
  },
  code: () => import("./code.ts"),
};
