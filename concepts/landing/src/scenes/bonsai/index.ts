// A bonsai through the seasons: a single tree on a rosewood stand against a plaster wall (or shoji,
// or a dark alcove), lit from the side, its shadow moving over the wall with the sun. The tree is
// grown for its species and seed by space colonisation inside sculpted cloud pads (tree.ts) and
// lives through the year (sim.ts): leaves open, colour and fall to lie on the moss and the stand,
// snow settles in winter, new shoots reach out each spring and are trimmed back by an unseen hand.
// Hover to stir the pads; click to snip a twig. It comes in as the stand glides in from the side
// along the veranda, the pads leaning on its braking and springing back, and leaves as the stand is
// pushed off to the side with a gust and a few leaves shaken loose. A preset of the `interior`
// composer (src/composer, README "The interior composer"): the veranda behind (layers.ts), the stand
// in front, the tree on it; the tree's shadow on the wall is the room's (roomCaster).
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { BONSAI_PASSAGE, BONSAI_RIG, BONSAI_ROOM } from "./constants.ts";

const preset: ScenePreset = {
  id: "bonsai",
  composer: "interior",
  title: "Bonsai",
  blurb: "A bonsai on its stand through the seasons, its shadow moving on the wall.",
  accent: "#d8432e",
  look: { color: "full", levels: 4 },
  passage: BONSAI_PASSAGE,
  rig: BONSAI_RIG,
  room: BONSAI_ROOM,
  grade: { ink: { gain: 1.6, gamma: 1 } },
  // The room shows no window, so it lists no World (compose.ts): these name its options alone.
  world: { time: 0.6, birds: { kind: "rooks", help: "" } },
  meteors: [0, 0, 0, 0],
  flyway: { depth: [10, 100], above: 0, top: 1, seed: 0, skim: 1, spread: 1, ext: 0 },
  floor: "earth",
  layers: ["veranda", "stand", "bonsaiTree"],
  values: {},
};

/** The bonsai composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const bonsaiComposed = composeScene(interior, preset);

export const bonsaiScene: SceneDef = { ...bonsaiComposed.def, code: () => import("./code.ts") };
