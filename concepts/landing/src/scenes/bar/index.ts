// A quiet bar late at night, seen from a corner booth while it rains outside: a long counter under
// green pendant lamps, bottles glowing on the back bar in front of a mirror that doubles the room,
// a bartender at work, a few people on the stools coming and going over the evening, a slow fan
// under a pressed-tin ceiling, the street through the rain-streaked front window, and your table
// with a candle, a coffee and a whisky. A variant of the `interior` composer's baseline
// (src/composer, README "The interior composer"): the storefront and its street behind (layers.ts)
// and your table in front for the baseline's window and sill, the back bar, the pendants and the
// fan; the picture is shader.ts, who comes and goes and what the bartender does is scheduled on the
// CPU (sim.ts, the back bar's sim).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { BAR_RIG, BAR_ROOM, PASSAGE } from "./constants.ts";

/** The late bar over the interior's baseline: its own shell, rig and room, the bar, its grade. */
export const barVariant: Variant = {
  id: "bar",
  base: "interior",
  title: "Late bar",
  blurb: "A quiet bar late at night, seen from a corner booth while it rains outside.",
  accent: "#ffb347",
  look: { color: "full", levels: 4 },
  // You sit down in the booth: the view lowers and turns to rest, the bartender looks up from his
  // glass and nods, the fan starts turning, the lamps warm up a little. Leaving, you stand: the view
  // rises and turns to the door as he gives a small wave.
  passage: PASSAGE,
  // The room shows no World through its window (compose.ts).
  layers: {
    remove: ["cityWindow"],
    add: ["storefront", "booth", "backBar", "pendants", "ceilingFan"],
  },
  camera: BAR_RIG,
  room: BAR_ROOM,
  // Its own shell: none of the baseline's window and lamp.
  elements: [],
  // The bar's own grade: its soft vignette from half a screen height out, its ink.
  grade: {
    vignette: 0.2,
    vignetteReach: { from: 0.5, to: 1, across: 1.2 },
    ink: { gain: 1.15, gamma: 0.8 },
  },
};

/** The late bar composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const barComposed = composeScene(interior, variantPreset(interior.baseline, barVariant));

export const barScene: SceneDef = { ...barComposed.def, code: () => import("./code.ts") };
