// Hanging mobile: a solar system hung in a quiet room under a glowing Sun that is the room's lamp.
// Mercury to Neptune (with the Moon on the Earth's sub-arm, and Ceres and Pluto if asked for) ride
// balanced wire arms stacked down the Sun's axis, coupled pendulums that swing and rock in the air
// of the room, a draft from the window and its gusts, and knock when they crowd; a motor turns each
// arm at its planet's real period (the shared part sims/mobile.ts, with the wind conventions of
// sims/wind.ts; the layout in solar.ts, the room's air in sim.ts). A preset of the `interior`
// composer (src/composer, README "The interior composer"): the quiet room behind (layers.ts: the
// wall, the floor, the ceiling and the window's light) and the solar system in it, its Sun the light
// that throws the mobile's shadows on the room (shader.ts).
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { MOBILE_PASSAGE, MOBILE_RIG, MOBILE_ROOM, MOBILE_SUN } from "./constants.ts";

const preset: ScenePreset = {
  id: "mobile",
  composer: "interior",
  title: "Mobile",
  blurb:
    "A solar system hung under a glowing Sun, each planet turning at its own pace, its shadow wheeling across the wall.",
  accent: MOBILE_SUN,
  look: { color: "full", levels: 4 },
  // The white room by day is pale: the page copy goes dark on it.
  theme: (params) => paletteTheme(params, "room", (index) => index === 1),
  // Entrance: lowered from above on the Sun's cord as the Sun lights up. Exit: the motors wind down,
  // the Sun cools and the mobile is hoisted away.
  passage: MOBILE_PASSAGE,
  rig: MOBILE_RIG,
  room: MOBILE_ROOM,
  // The mobile's own ink; its night room's falling away is the quiet room's (its front veil).
  grade: { ink: { gain: 1.4, gamma: 0.8 } },
  // The room shows no World through a window (compose.ts): these name its options alone.
  world: { time: 0, birds: { kind: "rooks", help: "" } },
  meteors: [0, 0, 0, 0],
  flyway: { depth: [10, 100], above: 0, top: 1, seed: 0, skim: 1, spread: 1, ext: 0 },
  floor: "earth",
  layers: ["quietRoom", "solarMobile"],
  values: {},
};

/** The mobile composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const mobileComposed = composeScene(interior, preset);

export const mobileScene: SceneDef = { ...mobileComposed.def, code: () => import("./code.ts") };
