// A river delta from above, as a satellite time-lapse. A preset of the `overhead` composer
// (src/composer, README "The overhead composer"): the land and the sea's bed (deltaBed, laid out per
// seed), the river and the sea over it (deltaWater: a live simulation on the GPU, shallow water over
// an eroding, silting bed, so channels really split at their mouth bars, wander, silt up and drown,
// and the river now and then breaks out to build a new lobe), and fair-weather clouds over it
// (clouds) (layers.ts, sim.ts); the shader (shader.ts) shows it as a satellite picture, a
// false-colour infrared scene or a surveyor's chart.
import { composeScene } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadPreset } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { DELTA_PASSAGE } from "./constants.ts";
import { DELTA_CHART, DELTA_SPAN } from "./layers.ts";

const preset: OverheadPreset = {
  id: "delta",
  composer: "overhead",
  title: "Delta",
  blurb: "A river building its delta into the sea, seen from orbit. Drag to dig a new channel.",
  accent: "#3fb8a6",
  look: { color: "full", levels: 4 },
  passage: DELTA_PASSAGE,
  // The chart is printed on paper: the page copy goes dark on it.
  theme: (params) => paletteTheme(params, "palette", (palette) => palette === DELTA_CHART),
  // Its open water is the sea, the river's fresh water running into it (layers.ts).
  rig: { span: DELTA_SPAN, minAspect: 1, salt: true },
  // The clouds are offered, not home.
  layers: ["deltaBed", "deltaWater"],
  values: {},
};

/** The delta composed (composer/compose.ts): its definition, and what its code is built from. */
export const deltaComposed = composeScene(overhead, preset);

export const deltaScene: SceneDef = {
  ...deltaComposed.def,
  code: () => import("./code.ts"),
};
