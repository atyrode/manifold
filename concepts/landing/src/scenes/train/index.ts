// The night train: the view from a seat by the window of a slow night train. A glass of tea on the
// table trembles at every clack of the rails, the curtain sways with the carriage, the lamp shows in
// the glass; outside, the country slides past in depth under the moon (telegraph poles whipping by,
// fields and farms with lit windows, a river catching the moonlight, hills, a village at the foot of
// the mountains), and now and then a station glides past under its lamps, a level crossing flashes,
// a bridge's girders flick by over a misty valley, or a tunnel turns the window into a mirror.
// A preset of the `interior` composer (src/composer, README "The interior composer"): the night
// line through the window behind (layers.ts), the compartment round it, the tea and the curtain;
// sim.ts runs the journey (distance, speed, the timetable, the cars alongside), shader.ts paints
// it. The `line` knob picks the country and its timetable together: the country line as it always
// ran, a rural branch line or a mountain line (sim.ts TRAIN_LINES, shader.ts trainLine).
// The passage is the line's own: the train comes out of a tunnel (dark wall streaming past, the
// mouth sweeping by, the cutting's rock sinking away to open the country, the tea settling from the
// jolt) and, leaving, runs into one.
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { TRAIN_PASSAGE, TRAIN_RIG, TRAIN_ROOM } from "./constants.ts";

const preset: ScenePreset = {
  id: "train",
  composer: "interior",
  title: "Night train",
  blurb:
    "The view from a slow night train: tea trembling with the rails, the country sliding by under the moon.",
  accent: "#ffae4a",
  look: { color: "full", levels: 4 },
  // Entrance: out of a tunnel into the night country, the tea settling from the jolt. Exit: into a tunnel.
  passage: TRAIN_PASSAGE,
  rig: TRAIN_RIG,
  room: TRAIN_ROOM,
  // The train's own grade: its vignette from half a screen height out, its ink.
  grade: {
    vignette: 0.3,
    vignetteReach: { from: 0.5, to: 1.05, across: 1.25 },
    ink: { gain: 1.2, gamma: 0.8 },
  },
  planets: { group: "sky", across: [-64, -35, 18], up: [2, 13, 24] },
  // The room shows no World through its window (compose.ts): these name its options alone.
  world: { time: 0.15, birds: { kind: "rooks", help: "" } },
  meteors: [0, 0, 0, 0],
  flyway: { depth: [10, 100], above: 0, top: 1, seed: 0, skim: 1, spread: 1, ext: 0 },
  floor: "earth",
  layers: ["nightLine", "compartment", "teaGlass", "velvetCurtain"],
  values: {},
};

/** The night train composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const trainComposed = composeScene(interior, preset);

export const trainScene: SceneDef = { ...trainComposed.def, code: () => import("./code.ts") };
