// A river delta from above, as a satellite time-lapse. A variant of the `overhead` composer's
// baseline (src/composer, README "The overhead composer"), a frame 20 km tall over the sea: the
// baseline's pond floor gives way to the land and the sea's bed (deltaBed, laid out per seed), the
// river and the sea over it (deltaWater: a live simulation on the GPU, shallow water over an
// eroding, silting bed, so channels really split at their mouth bars, wander, silt up and drown,
// and the river now and then breaks out to build a new lobe), and fair-weather clouds over it
// (clouds) (layers.ts, sim.ts); the shader (shader.ts) shows it as a satellite picture, a
// false-colour infrared scene or a surveyor's chart.
import { composeScene, overheadVariantPreset } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadVariant } from "../../composer/types.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { DELTA_PASSAGE } from "./constants.ts";
import { DELTA_CHART, DELTA_SPAN } from "./layers.ts";

/** The delta over the overhead's baseline: its land, its river and sea, 20 km tall. */
export const deltaVariant: OverheadVariant = {
  id: "delta",
  base: "overhead",
  title: "Delta",
  blurb: "A river building its delta into the sea, seen from orbit. Drag to dig a new channel.",
  accent: "#3fb8a6",
  look: { color: "full", levels: 4 },
  passage: DELTA_PASSAGE,
  // The chart is printed on paper: the page copy goes dark on it.
  theme: (params) => paletteTheme(params, "palette", (palette) => palette === DELTA_CHART),
  // The clouds are offered, not home. Its water not yet open to the sky, it takes neither the
  // World's knobs nor the baseline's painted hour.
  layers: { remove: ["pondBed"], add: ["deltaBed", "deltaWater"] },
  // Its open water is the sea, the river's fresh water running into it (layers.ts).
  camera: { span: DELTA_SPAN, minAspect: 1, salt: true },
};

/** The delta composed (composer/compose.ts): its definition, and what its code is built from. */
export const deltaComposed = composeScene(
  overhead,
  overheadVariantPreset(overhead.baseline, deltaVariant),
);

export const deltaScene: SceneDef = {
  ...deltaComposed.def,
  code: () => import("./code.ts"),
};
