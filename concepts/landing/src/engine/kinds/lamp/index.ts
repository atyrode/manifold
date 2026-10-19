// A lamp: a glowing bulb on a slim stem over a round foot, lighting what is round it (a point light,
// shadowed by whatever casts between). Its power, its warmth and how it flickers are its options.
import { range } from "../../../params.ts";
import type { KindDef } from "../../types.ts";

/** The foot's radius and the bulb's, metres. */
export const LAMP_FOOT = 0.12;
export const LAMP_BULB = 0.07;

export const lampKind: KindDef = {
  id: "lamp",
  title: "Lamp",
  blurb:
    "A glowing bulb on a slim stem: it lights what is round it, and walls between keep its light out.",
  family: "light",
  options: [
    range("lamp", "height", "height", 1.4, "How high the bulb stands, metres.", {
      min: 0.2,
      max: 3,
      step: 0.05,
    }),
    range("lamp", "power", "power", 1.5, "How bright it shines.", { min: 0, max: 4, step: 0.05 }),
    range(
      "lamp",
      "warmth",
      "warmth",
      0.7,
      "Its colour: cool white to the left, amber to the right.",
    ),
    range(
      "lamp",
      "flicker",
      "flicker",
      0,
      "How much it flickers, as a flame or a failing bulb does.",
    ),
  ],
  bounds(options) {
    return {
      min: [-LAMP_FOOT, 0, -LAMP_FOOT],
      max: [LAMP_FOOT, (options["height"] ?? 1.4) + 2 * LAMP_BULB, LAMP_FOOT],
    };
  },
  max: 8,
  rests: "surface",
  emits: true,
  code: () => import("./code.ts"),
};
