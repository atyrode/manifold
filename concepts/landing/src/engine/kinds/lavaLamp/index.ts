// A lava lamp: the classic rocket of brushed metal and glass (shape.ts), its wax heating on the coil,
// tearing free, rising, cooling under the cap and sinking back (sim.ts, a sim per lamp), drawn as 3D
// blobs seen through the glowing liquid; it lights what is round it and casts a shadow.
import { range } from "../../../params.ts";
import type { KindDef } from "../../types.ts";
import { castLathe, FOOT, STATE_TEXELS } from "./shape.ts";

export const lavaLampKind: KindDef = {
  id: "lavaLamp",
  title: "Lava lamp",
  blurb:
    "Wax heating on the coil, tearing free, rising and sinking in a glowing glass: it lights what is round it.",
  family: "light",
  options: [
    range("lavaLamp", "wax", "wax", 0.01, "The wax's colour round the hues, red at both ends."),
    range(
      "lavaLamp",
      "liquid",
      "liquid",
      0.11,
      "The liquid's colour round the hues, and the light the lamp throws.",
    ),
    range(
      "lavaLamp",
      "heat",
      "bulb heat",
      0.5,
      "How hot the bulb runs. Left: a lazy lamp, a blob tearing free of the heap now and then. Right: a busy one, wax rising and falling all the time.",
    ),
    range("lavaLamp", "size", "size", 0.42, "Its height, metres.", {
      min: 0.2,
      max: 1.2,
      step: 0.01,
    }),
  ],
  bounds(options) {
    const size = options["size"] ?? 0.42;
    return { min: [-FOOT * size, 0, -FOOT * size], max: [FOOT * size, size, FOOT * size] };
  },
  max: 4,
  rests: "surface",
  casts: true,
  emits: true,
  state: { width: STATE_TEXELS, height: 1 },
  cast(options, ro, rd, span) {
    const size = options["size"] ?? 0.42;
    const hit = castLathe([ro[0] / size, ro[1] / size, ro[2] / size], rd, [
      span[0] / size,
      span[1] / size,
    ]);
    return hit === undefined ? undefined : { t: hit.t * size, normal: hit.normal };
  },
  code: () => import("./code.ts"),
};
