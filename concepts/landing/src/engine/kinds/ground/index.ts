// The ground: rolling land out to the horizon, a heightfield in the ground's own frame (its origin
// lies on it: height.ts). One a document (exclusive group `ground`), and the document's land
// (KindDef.land): what stands on the land reads it through the core's engineLand, never this kind.
// Its relief and spread shape it, its material colours it; the code marches it with detail by
// distance and lets it shade itself where the land stands between a point and the sun.
import { choice, range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";
import { GROUND_SLOPE, groundHeight, groundShape } from "./height.ts";

/** The materials, in the `material` option's order. */
export const GROUND_MATERIALS = ["grass", "earth", "sand", "snow", "stone"] as const;

/** Share of GROUND_SLOPE a march step trusts (the CPU's and the shader's). */
export const GROUND_TRUST = 0.35;
/** Metres of bounds over and under the land's extremes. */
const GROUND_MARGIN = 0.1;

export const groundKind: KindDef = {
  id: "ground",
  title: "Ground",
  blurb:
    "Rolling land to the horizon: its relief, how broad its hills are, and what it is made of.",
  family: "ground",
  options: [
    range(
      "ground",
      "relief",
      "relief",
      10,
      "How high the hills rise and the hollows sink, metres.",
      {
        min: 0,
        max: 60,
        step: 0.5,
      },
    ),
    range("ground", "spread", "spread", 320, "How broad the hills are: their wavelength, metres.", {
      min: 40,
      max: 1200,
      step: 10,
    }),
    choice(
      "ground",
      "material",
      "material",
      GROUND_MATERIALS.map((label, value) => ({ label, value })),
      0,
      "What the land is: grass, bare earth, sand, snow or stone. Steep slopes show stone through grass, earth and sand.",
    ),
    range("ground", "extent", "extent", 3000, "How far the land reaches from its origin, metres.", {
      min: 100,
      max: 6000,
      step: 100,
    }),
  ],
  bounds(options) {
    const relief = options["relief"] ?? 0;
    const extent = options["extent"] ?? 0;
    const level = groundShape(0, 0);
    // A margin over and under the land, so a ray from above always enters over it (flat land too).
    return {
      min: [-extent, relief * (-1 - level) - GROUND_MARGIN, -extent],
      max: [extent, relief * (1 - level) + GROUND_MARGIN, extent],
    };
  },
  exclusive: "ground",
  max: 1,
  rests: "free",
  casts: true,
  cast(options, ro, rd, span) {
    const relief = options["relief"] ?? 0;
    const spread = options["spread"] ?? 1;
    const lean = (GROUND_TRUST * GROUND_SLOPE * relief) / spread + Math.max(-rd[1], 0);
    const above = (t: number) =>
      ro[1] + rd[1] * t - groundHeight(ro[0] + rd[0] * t, ro[2] + rd[2] * t, relief, spread);
    let t = span[0];
    let before = t;
    let d = above(t);
    if (d < 0) return undefined;
    while (d >= 0) {
      if (t >= span[1]) return undefined;
      before = t;
      t = Math.min(span[1], t + Math.max(d / Math.max(lean, 1e-3), 0.01 + t * 0.002));
      d = above(t);
    }
    // The crossing lies between `before` (above) and `t` (below): halve the bracket.
    let after = t;
    for (let i = 0; i < 40; i++) {
      const mid = (before + after) / 2;
      if (above(mid) >= 0) before = mid;
      else after = mid;
    }
    const x = ro[0] + rd[0] * before;
    const z = ro[2] + rd[2] * before;
    const e = 0.01;
    const dx = groundHeight(x + e, z, relief, spread) - groundHeight(x - e, z, relief, spread);
    const dz = groundHeight(x, z + e, relief, spread) - groundHeight(x, z - e, relief, spread);
    const n: Vec3 = [-dx / (2 * e), 1, -dz / (2 * e)];
    const length = Math.hypot(n[0], n[1], n[2]);
    return { t: before, normal: [n[0] / length, n[1] / length, n[2] / length] };
  },
  land: (options, x, z) => groundHeight(x, z, options["relief"] ?? 0, options["spread"] ?? 1),
  code: () => import("./code.ts"),
};
