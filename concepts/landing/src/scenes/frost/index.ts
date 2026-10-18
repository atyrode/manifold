// A window pane on a winter night, frosting over: fern frost grown on the CPU (build.ts), melted by
// a warm fingertip and refreezing, on a growth clock that opens on a pane already frosted along its
// bottom (sim.ts). Behind the glass, out of focus: a snowy street or a cabin in the woods, under the
// World's sky and snowfall. Entering, the glass starts clear and the frost grows in from the frame;
// leaving, a warm breath clears a patch that spreads over the pane (FROST_PASSAGE). A preset of the
// `interior` composer (src/composer, README "The interior composer"): the view and its window frame
// behind (layers.ts), the frost on its glass, a layer any room with a glazed window is offered.
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { atmosphereGroups } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { FROST_PASSAGE, FROST_RIG, FROST_ROOM } from "./constants.ts";

const preset: ScenePreset = {
  id: "frost",
  composer: "interior",
  title: "Frost",
  blurb: "A window on a winter night, slowly frosting over.",
  accent: "#8fd8ff",
  look: { color: "full", levels: 4 },
  passage: FROST_PASSAGE,
  planets: { group: "sky", across: [-45, -18, 45], up: [4, 23, 40] },
  rig: FROST_RIG,
  room: FROST_ROOM,
  // Lights past 1 roll off softly rather than clipping.
  grade: { ink: { gain: 1.25, gamma: 1 }, rolloff: 1.2 },
  // A winter night, snowing; the stars thinner over the town (the cabin shows 1.7 times as many), the
  // moon full, no Milky Way, no fair-weather cloud (the view keeps its own, FROST_COVER). A room lists
  // no birds (compose.ts): `birds` names the World's only to satisfy its options.
  world: {
    time: 0.9,
    stars: 0.5,
    moon: 1,
    clouds: 0,
    milkyWay: { on: false },
    on: { snow: true },
    birds: { kind: "rooks", help: "" },
  },
  meteors: [-0.6, 0.42, 1.2, 0.18],
  flyway: { depth: [10, 100], above: 0, top: 1, seed: 0, skim: 1, spread: 1, ext: 0 },
  floor: "snowfield",
  layers: ["frostView", "frostGlass"],
  values: {},
  groups: {
    sky: {
      ...atmosphereGroups.sky,
      blurb:
        "Time of day, and the night over the town or the woods: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
  },
};

/** The frost composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const frostComposed = composeScene(interior, preset);

const { featuresFor } = frostComposed.def;

// The view's snow cloud stands in fair weather too (its FROST_COVER), so the World's cloud deck is
// compiled in at every setting, as the scene's own sky held it, not only while it snows or rains.
export const frostScene: SceneDef = {
  ...frostComposed.def,
  featuresFor: (values) => ({ ...featuresFor?.(values), WORLD_CLOUDS: 1 }),
  code: () => import("./code.ts"),
};
