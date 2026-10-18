// Incense smoke in a quiet, dark room: a thread rising from the ember through a shaft of window
// light, breaking a hand-span up into curls and soft veils. The smoke is a fluid simulated on the
// GPU and the incense burns down on the CPU (sim.ts). A preset of the `interior` composer
// (src/composer, README "The interior composer"): the wall in the window's light behind (layers.ts),
// the low table in front, the incense on it; the shadows of its smoke on the wall are the room's
// (roomCaster).
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { INCENSE_PASSAGE, INCENSE_RIG, INCENSE_ROOM } from "./constants.ts";

const preset: ScenePreset = {
  id: "incense",
  composer: "interior",
  title: "Incense",
  blurb: "A thread of smoke rising through a shaft of light, curling into veils.",
  accent: "#ff6a1f",
  look: { color: "full", levels: 4 },
  passage: INCENSE_PASSAGE,
  // Washi walls are pale: the page copy goes dark on them (the shader's `pagePaper()` follows this).
  theme: (params) => paletteTheme(params, "room", (room) => room > 2.5),
  rig: INCENSE_RIG,
  room: INCENSE_ROOM,
  grade: { ink: { gain: 1.25, gamma: 1 } },
  // The room shows no window, so it lists no World (compose.ts): these name its options alone.
  world: { time: 0, birds: { kind: "rooks", help: "" } },
  meteors: [0, 0, 0, 0],
  flyway: { depth: [10, 100], above: 0, top: 1, seed: 0, skim: 1, spread: 1, ext: 0 },
  floor: "earth",
  layers: ["shaftWall", "lowTable", "incense"],
  values: {},
};

/** The incense composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const incenseComposed = composeScene(interior, preset);

export const incenseScene: SceneDef = { ...incenseComposed.def, code: () => import("./code.ts") };
