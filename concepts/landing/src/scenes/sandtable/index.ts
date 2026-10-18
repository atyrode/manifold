// A sand table under a low lamp, seen from straight above. A preset of the `overhead` composer
// (src/composer, README "The overhead composer"): the table (sandBed: the sand, or the slate, of one
// height field, its rim and the floor), the lamp (tableLamp), and a machine drawing on it (layers.ts,
// sim.ts): a steel ball pulled by a hidden magnet along slow theta–rho tracks, ploughing grooves and
// erasing the last drawing as it crosses it (ball); or a swinging funnel trickling rosettes of sand
// onto dark slate, wiped clean and swung again once the swing has died away (pendulum). The shader
// (shader.ts) lights the sand's relief with the raking lamp, every groove a bright side and a
// shadowed one.
import { composeScene } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadPreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { SANDTABLE_PASSAGE } from "./constants.ts";
import { SANDTABLE_SPAN_METRES } from "./layers.ts";

const preset: OverheadPreset = {
  id: "sandtable",
  composer: "overhead",
  title: "Sand table",
  blurb:
    "A steel ball ploughing slow patterns through sand under a low lamp; or a pendulum pouring rosettes onto slate.",
  accent: "#d9a441",
  look: { color: "full", levels: 4 },
  // Entering: the ball rolls in from the side and ploughs on along its track (the funnel is carried
  // in on its string and starts to pour); leaving: a straight edge sweeps the table smooth, pushing
  // the ball (carrying the funnel) off the frame. The machine's sim plays both on its own clock.
  passage: SANDTABLE_PASSAGE,
  rig: { span: SANDTABLE_SPAN_METRES, minAspect: 1 },
  // The pendulum is offered, not home: its switch puts it on the table in the ball's place.
  layers: ["sandBed", "tableLamp", "ball"],
  values: {},
};

/** The sand table composed (composer/compose.ts): its definition, and what its code is built from. */
export const sandtableComposed = composeScene(overhead, preset);

export const sandtableScene: SceneDef = {
  ...sandtableComposed.def,
  code: () => import("./code.ts"),
};
