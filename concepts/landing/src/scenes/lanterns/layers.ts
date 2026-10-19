// The Lantern river preset's layers (ADR 0062 Phase 2a): their manifests, which load without their
// code (shader.ts, sim.ts). Each is drawn through the river's own rig alone (LANTERNS_RIG): the far
// bank stands at FAR_BANK in its own plane, the stones and the procession are laid out for its view
// (sim.ts), so another rig is not offered them.
//   temple    backdrop: the World's sky over the far bank, with the river's warm grey under the
//             rain's deck and the shafts of rain under it; two ranges of hills; the temple grounds
//             (tree crowns, the hall and its pagoda, two houses, the quay with its stone lanterns, the
//             vermilion arched bridge hung with lamps, an old pine), the warm glow over them and the
//             mist at their foot; the river's air. Its view in a level mirror (`templeMirror`) is
//             what the river mirrors. The land ends at the far bank's waterline.
//   river     ground: the rippled river mirroring the backdrop (composerMirror) and the bank's lamps
//             as glitter down the water, darker toward our bank, rung by the rain; the two stones in
//             the stream, their lee, their wakes and their reflections; the mist lying on the water.
//             Its water claims the floor from our bank to the far one: no cover grows on it, nothing
//             stands in it.
//   lanterns  life: the floating lanterns (sim.ts: potential flow round the stones, eddies, soft
//             contacts), their reflections and glitter, pools of light and rings on the water, their
//             halos in the air and the drops they light; the M lantern. They float on the river, so
//             they need it, and their light falls on every other layer (`lanternsLight`).
// What each draws is at the top of shader.ts, how the lanterns float at the top of sim.ts.
import type { LayerDef } from "../../composer/types.ts";
import { counts, feature, range, toggle } from "../../params.ts";
import { EYE, FAR_BANK, FOCAL, HORIZON, LANTERN_COUNTS, LANTERNS_ROWS } from "./constants.ts";

/** The river's own rig, and no other. */
const RIVER_RIG = {
  eye: [EYE, EYE],
  horizon: [HORIZON, HORIZON],
  focal: [FOCAL, FOCAL],
  pitch: [0, 0],
} as const;

/** Our bank's waterline (m ahead): just below the frame, where lanterns are set down from it. */
const NEAR_BANK = 6;

export const templeLayer: LayerDef = {
  id: "temple",
  title: "Temple grounds",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: RIVER_RIG,
  switch: toggle(
    "layers",
    "temple",
    "temple grounds",
    false,
    "The far bank at dusk: a temple hall and its pagoda among tree crowns, two houses, a quay with stone lanterns, a vermilion arched bridge hung with lamps and an old pine leaning over the water, the haze warm over the grounds, wooded hills beyond falling away toward the sunset.",
    { icon: "bridge" },
  ),
  params: [],
  groups: {},
  passes: { begin: "templeBegin", sky: "templeSky", far: "templeFar", mirror: "templeMirror" },
};

export const riverLayer: LayerDef = {
  id: "river",
  title: "River",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the river's waters",
        kind: "exclusive",
        shape: {
          kind: "box",
          at: [0, 0.5 * (NEAR_BANK + FAR_BANK)],
          half: [4 * FAR_BANK, 0.5 * (FAR_BANK - NEAR_BANK)],
        },
      },
    ],
  },
  camera: RIVER_RIG,
  switch: toggle(
    "layers",
    "river",
    "river",
    false,
    "A wide, slow river from our low bank to the far one, mirroring the sky and the far bank in broad bands its ripples fold; two stones in the stream, a glassy lee and a wake behind each.",
    { icon: "waves" },
  ),
  params: [
    range(
      "water",
      "current",
      "current",
      0.3,
      "How fast the river runs: a slow drift that lets the lanterns gather and turn, or a steady stream that strings them out. It runs fast along the far side and slows in the shallows near you, so the procession closes up as it comes near.",
    ),
    range(
      "water",
      "ripple",
      "water ripple",
      0.45,
      "Glassy calm to the left: the river is a mirror. To the right a breeze ruffles it and every reflection breaks into wavering bands.",
    ),
    range(
      "water",
      "reflection",
      "reflection length",
      0.55,
      "How far each light's reflection runs down the water toward you: a few glints under it, or long trails of trembling amber dashes.",
    ),
    range(
      "water",
      "mist",
      "mist",
      0.35,
      "Mist lying on the river: the far bank fades into it, and each lantern wears a halo.",
    ),
  ],
  groups: {
    water: {
      title: "Water",
      blurb:
        "How fast the river runs, how its surface moves and mirrors the lights, and the mist lying on it.",
    },
  },
  passes: { ground: "riverGround", middle: "riverMiddle", middleVeil: "riverMiddleVeil" },
};

export const lanternsLayer: LayerDef = {
  id: "lanterns",
  title: "Lanterns",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: RIVER_RIG,
  switch: feature(
    "layers",
    "lanterns",
    "lanterns",
    false,
    "how many",
    24,
    "Paper lanterns floating on the river at once: a procession from small lights far out by the far bank, sweeping in past the near stone, and a second string drifting by close in front of you. As they drift away downstream, new ones come round the bend. Click the water to set a lantern down; hold and drag to push the water along.",
    { options: counts(...LANTERN_COUNTS), icon: "lantern" },
  ),
  params: [
    feature(
      "lanterns",
      "flotilla",
      "flotillas",
      true,
      "frequency",
      0.3,
      "Now and then a family sets a little group of lanterns on the water from this bank: big and close, they glide out together along the front and drift away downstream.",
    ),
    toggle(
      "manifold",
      "lanternsMark",
      "M lantern",
      false,
      "One lantern of indigo paper with the Manifold M cut through it, glowing amber. Set on the water from this bank as it comes on, it keeps to the near water where the M reads, turns back to face you, and comes round again soon after it has drifted away. Now: set it on the water again.",
    ),
  ],
  groups: {
    lanterns: {
      title: "Lanterns",
      blurb:
        "Flotillas set on the water from this bank. Click the water to set a lantern down; hold and drag to push the water along.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  triggers: ["flotilla", "lanternsMark"],
  mark: "lanternsMark",
  requires: ["river"],
  lights: [{ name: "the lanterns", glsl: "lanternsLight" }],
  data: { rows: LANTERNS_ROWS },
  passes: { middle: "lanternsMiddle", middleVeil: "lanternsMiddleVeil", air: "lanternsAir" },
};
