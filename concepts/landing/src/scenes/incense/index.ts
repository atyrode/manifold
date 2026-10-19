// Incense smoke in a quiet, dark room: a thread rising from the ember through a shaft of window
// light, breaking a hand-span up into curls and soft veils. The smoke is a fluid simulated on the
// GPU and the incense burns down on the CPU (sim.ts). A variant of the `interior` composer's
// baseline (src/composer, README "The interior composer"): the wall in the window's light behind
// (layers.ts) and the low table in front for the baseline's window and sill, the incense on it; the
// shaft the World's moon (or by day its sun) through the window off to the left (INCENSE_WINDOW,
// INCENSE_ROOM's facing), the hour pinned at midnight; the shadows of its smoke on the wall are the
// room's (roomCaster). Its ink is the baseline's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { INCENSE_PASSAGE, INCENSE_RIG, INCENSE_ROOM, INCENSE_WINDOW } from "./constants.ts";

/** The incense over the interior's baseline: its own shell, rig and room, its window, the incense. */
export const incenseVariant: Variant = {
  id: "incense",
  base: "interior",
  title: "Incense",
  blurb: "A thread of smoke rising through a shaft of light, curling into veils.",
  accent: "#ff6a1f",
  look: { color: "full", levels: 4 },
  passage: INCENSE_PASSAGE,
  // Washi walls are pale: the page copy goes dark on them (the shader's `pagePaper()` follows this).
  theme: (params) => paletteTheme(params, "room", (room) => room > 2.5),
  // No glass in frame: the window off to the left lists the light-only World (compose.ts).
  layers: { remove: ["cityWindow"], add: ["shaftWall", "lowTable", "incense"] },
  camera: INCENSE_RIG,
  room: INCENSE_ROOM,
  elements: [INCENSE_WINDOW],
  // Midnight, the full moon in at the window.
  values: { time: 0 },
};

/** The incense composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const incenseComposed = composeScene(
  interior,
  variantPreset(interior.baseline, incenseVariant),
);

export const incenseScene: SceneDef = { ...incenseComposed.def, code: () => import("./code.ts") };
