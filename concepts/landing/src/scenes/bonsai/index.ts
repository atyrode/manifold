// A bonsai through the seasons: a single tree on a rosewood stand against a plaster wall (or shoji,
// or a dark alcove), lit from the side, its shadow moving over the wall with the sun. The tree is
// grown for its species and seed by space colonisation inside sculpted cloud pads (tree.ts) and
// lives through the year (sim.ts): leaves open, colour and fall to lie on the moss and the stand,
// snow settles in winter, new shoots reach out each spring and are trimmed back by an unseen hand.
// Hover to stir the pads; click to snip a twig. It comes in as the stand glides in from the side
// along the veranda, the pads leaning on its braking and springing back, and leaves as the stand is
// pushed off to the side with a gust and a few leaves shaken loose. A variant of the `interior`
// composer's baseline (src/composer, README "The interior composer"): the veranda behind (layers.ts)
// and the stand in front for the baseline's window and sill, the tree on it; the World's sun through
// the window behind the eye (BONSAI_WINDOW, BONSAI_ROOM's facing) at its hour and date, the tree's
// shadow on the wall the room's (roomCaster).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { BONSAI_PASSAGE, BONSAI_RIG, BONSAI_ROOM, BONSAI_WINDOW } from "./constants.ts";

/** The bonsai over the interior's baseline: its own shell, rig and room, the tree, its window, its ink. */
export const bonsaiVariant: Variant = {
  id: "bonsai",
  base: "interior",
  title: "Bonsai",
  blurb: "A bonsai on its stand through the seasons, its shadow moving on the wall.",
  accent: "#d8432e",
  look: { color: "full", levels: 4 },
  passage: BONSAI_PASSAGE,
  // No glass in frame: the window behind the eye lists the light-only World (compose.ts).
  layers: { remove: ["cityWindow"], add: ["veranda", "stand", "bonsaiTree"] },
  camera: BONSAI_RIG,
  room: BONSAI_ROOM,
  elements: [BONSAI_WINDOW],
  // An afternoon, the day passing slowly so the shadow creeps over the wall: afternoon to dusk to
  // the lamp in about ten minutes.
  values: { time: 0.6, cycle: 1, "cycle-amount": 0.1 },
  grade: { ink: { gain: 1.6, gamma: 1 } },
};

/** The bonsai composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const bonsaiComposed = composeScene(
  interior,
  variantPreset(interior.baseline, bonsaiVariant),
);

export const bonsaiScene: SceneDef = { ...bonsaiComposed.def, code: () => import("./code.ts") };
