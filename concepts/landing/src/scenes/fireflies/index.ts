// Fireflies that fall into step: a mangrove river at night, where thousands of fireflies, each an
// oscillator nudged by the flashes it sees (sim.ts), drift out of their own rhythms into one, the
// way Pteroptyx do along Malaysian rivers. A preset of the `outdoor` composer (src/composer, README
// "Composers"): the mangroves behind (the bank, its trees and the breeze crossing it), the creek
// mirroring them and the swarm in their crowns, with the lights nearer than the bank and the lantern
// the pointer carries (layers.ts); shader.ts draws them. The sky, the weather and the birds are the
// World's: a moonless night, its stars and the odd shooting star over the trees.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { FIREFLIES_GRADE, FIREFLIES_PASSAGE, FIREFLIES_RIG } from "./constants.ts";

const preset: ScenePreset = {
  id: "fireflies",
  composer: "outdoor",
  title: "Fireflies",
  blurb: "A mangrove river at night: thousands of fireflies falling into step.",
  accent: "#b6f03c",
  look: { color: "full", levels: 4 },
  // Entrance: the bank is dark, a few fireflies blink out of step in the first trees, more join tree
  // by tree, the clusters begin to fall into step, and the camera drifts along the river into place.
  // Exit: the beat is lost, the crowns go dark tree by tree, the camera drifts on.
  passage: FIREFLIES_PASSAGE,
  // The World's planets hang over the mangroves' crowns: the sky shows from the crowns' tops, about
  // 7 degrees up, to the frame's top edge at 28 (the lens is 1.2 screen heights per unit of slope,
  // the true horizon at 0.36 of the frame), a little right of the middle first.
  planets: { group: "sky", across: [-30, 8, 30], up: [12, 20, 26] },
  // A sunlit river is bright water and sky: the copy needs dark ink on it by day; at night, as it
  // opens, the night theme.
  theme: skyTheme,
  rig: FIREFLIES_RIG,
  grade: FIREFLIES_GRADE,
  // Deep in the evening, the moon off (the moon knob's off: no moon in the sky), sparse stars, no
  // cloud and no Milky Way (the river's night had neither); swifts over the water by day, off until
  // switched on.
  world: {
    time: 0.9,
    stars: 0.5,
    clouds: 0,
    milkyWay: { on: false },
    birds: {
      kind: "swifts",
      on: false,
      help: "Swifts hawking over the river by day, low over the water and up over the trees; few in the rain.",
    },
  },
  // Shooting stars set out high over the trees.
  meteors: [-0.6, 0.35, 1.2, 0.08],
  // The swifts cross 15 to 55 m out, nearer than the far bank, from just over its trees to the top of
  // the frame; they never come down to the water.
  flyway: {
    depth: [15, 55],
    above: 0.1,
    top: 0.98,
    seed: 4.1,
    skim: 1e9,
    spread: 1,
    ext: 0.003,
  },
  floor: "water",
  layers: ["mangroves", "creek", "fireflySwarm"],
  // The moon off; the breeze (the composer's gusts) now and then, as the river's own came.
  values: { moon: 0, gustRate: 0.3 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night over the river: sparse stars, the moon (off: a moonless night), the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud over the river, rain dulling its mirror and veiling the fireflies, snow, fog and lightning: the World's.",
    },
  },
};

/** The fireflies composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const firefliesComposed = composeScene(outdoor, preset);

export const firefliesScene: SceneDef = {
  ...firefliesComposed.def,
  code: () => import("./code.ts"),
};
