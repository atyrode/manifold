// A window pane on a winter night, frosting over: fern frost grown on the CPU (build.ts), melted by
// a warm fingertip and refreezing, on a growth clock that opens on a pane already frosted along its
// bottom (sim.ts). Behind the glass, out of focus: a snowy street or a cabin in the woods, under the
// World's sky and snowfall. Entering, the glass starts clear and the frost grows in from the frame;
// leaving, a warm breath clears a patch that spreads over the pane (FROST_PASSAGE). A variant of the
// `interior` composer's baseline (src/composer, README "The interior composer"): the view and its
// window frame behind (layers.ts) for the baseline's window and sill, the frost on its glass, a layer
// any room with a glazed window is offered.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import { atmosphereGroups } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { FROST_PASSAGE, FROST_RIG, FROST_ROOM } from "./constants.ts";

/** The frost over the interior's baseline: its own view, rig and room, the frost, its night. */
export const frostVariant: Variant = {
  id: "frost",
  base: "interior",
  title: "Frost",
  blurb: "A window on a winter night, slowly frosting over.",
  accent: "#8fd8ff",
  look: { color: "full", levels: 4 },
  passage: FROST_PASSAGE,
  planets: { group: "sky", across: [-45, -18, 45], up: [4, 23, 40] },
  groups: {
    sky: {
      ...atmosphereGroups.sky,
      blurb:
        "Time of day, and the night over the town or the woods: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
  },
  layers: { remove: ["cityWindow", "sill"], add: ["frostView", "frostGlass"] },
  // A winter night, snowing, no fair-weather cloud (the view keeps its own, FROST_COVER). The
  // baseline's stars thinned over the town (the cabin shows 1.7 times as many), its full moon and
  // no Milky Way are the frost's too.
  values: { time: 0.9, clouds: 0, snow: 1 },
  camera: FROST_RIG,
  room: FROST_ROOM,
  // Lights past 1 roll off softly rather than clipping.
  grade: { rolloff: 1.2 },
};

/** The frost composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const frostComposed = composeScene(interior, variantPreset(interior.baseline, frostVariant));

const { featuresFor } = frostComposed.def;

// The view's snow cloud stands in fair weather too (its FROST_COVER), so the World's cloud deck is
// compiled in at every setting, as the scene's own sky held it, not only while it snows or rains.
export const frostScene: SceneDef = {
  ...frostComposed.def,
  featuresFor: (values) => ({ ...featuresFor?.(values), WORLD_CLOUDS: 1 }),
  code: () => import("./code.ts"),
};
