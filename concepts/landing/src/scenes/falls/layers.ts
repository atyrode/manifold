// The Waterfall preset's layers (ADR 0062 Phase 2a): their manifests, which load without their code
// (shader.ts, sim.ts). The gorge is painted on the frame through its own rig (FALLS_RIG), so each is
// offered there alone; every one stands on the cliff, the spray on the falls (`requires`).
//   cliff     backdrop: the rock of the gorge (its choice of rock), the trees on the rim, the woods
//             upstream, the fallen blocks, the carved M; the World's sky over the rim, seen half
//             turned, its aurora lifted over the rim; the gorge's air and its rain's. The site's floor
//             ends at the waterline.
//   pool      ground: the plunge pool mirroring the cliff and the fall, its rings and foam rafts, the
//             fireflies over it, the near bank's boulders.
//   falls     dressing: the falling sheet (its flow) and the plunge's white water, their glow after
//             dark; without it the cliff is dry and the pool still.
//   spray     dressing: the spray from the plunge and off the sheet (its switch's amount), the rainbow
//             in it.
//   greenery  cover: moss and ferns on the ledges, the rock, the blocks and the bank (the cliff and the
//             pool draw them at its amount), the near bank's fern clumps (sim.ts); the plants' year.
// What each draws is at the top of shader.ts, how the bank's ferns live at the top of sim.ts.
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { plantKnobs } from "../plants.ts";
import { FALLS_RIG, FALLS_ROWS } from "./constants.ts";

/** The gorge's own rig, and no other. */
const GORGE_RIG = {
  eye: [FALLS_RIG.eye, FALLS_RIG.eye],
  horizon: [FALLS_RIG.horizon, FALLS_RIG.horizon],
  focal: [FALLS_RIG.focal, FALLS_RIG.focal],
  pitch: [FALLS_RIG.pitch, FALLS_RIG.pitch],
} as const;

const NO_SPACE = { anchors: [], claims: [] } as const;

export const cliffLayer: LayerDef = {
  id: "cliff",
  title: "Gorge",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: NO_SPACE,
  camera: GORGE_RIG,
  switch: toggle(
    "layers",
    "cliff",
    "gorge",
    false,
    "A cliff across the view at the back of a plunge pool, notched where the river comes over its lip, blocks fallen from it heaped at its foot, trees on its rim and the woods upstream glimpsed through the notch; over the rim the sky, seen with the sun behind you.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "cliff",
      "gorge",
      "gorge",
      [
        { label: "basalt", value: 0 },
        { label: "sandstone", value: 1 },
        { label: "limestone slot", value: 2 },
      ],
      0,
      "The rock the river has cut through. Basalt: dark lava flows stacked on rusty ash, dipping and folded, standing out as ledges. Sandstone: thin, level beds of buff and red stone stepped into ledges over soft shale, cross-bedded. Limestone slot: a narrow gorge of pale, massive limestone, its walls closing in on both sides and leaving a strip of sky, fluted by runnels, streaked dark under the lips and crusted with tufa where the water runs.",
    ),
    feature(
      "manifold",
      "cliffMark",
      "carved M",
      false,
      "parting",
      0.5,
      "A Manifold M cut into the rock behind the falling water, glimpsed through it where it runs thin. A horn of rock at the lip splits the flow in front of it: more parts the water wider.",
    ),
  ],
  groups: {
    cliff: {
      title: "Gorge",
      blurb: "The rock the river has cut through, with the trees on its rim and the sky over it.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  mark: "cliffMark",
  precip: { air: "cliffRainAir" },
  passes: { begin: "cliffBegin", sky: "cliffSky", far: "cliffFar", shade: "cliffShade" },
};

export const poolLayer: LayerDef = {
  id: "pool",
  title: "Plunge pool",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: NO_SPACE,
  camera: GORGE_RIG,
  switch: toggle(
    "layers",
    "pool",
    "plunge pool",
    false,
    "The pool at the cliff's foot, mirroring the rock and the fall, ringed by the plunge, by the wind and by the rain, foam rafts drifting out on it; the dark boulders of the near bank along the bottom of the view.",
    { icon: "ripple" },
  ),
  params: [
    feature(
      "pool",
      "poolFireflies",
      "fireflies",
      true,
      "amount",
      0.5,
      "Fireflies blinking over the pool from dusk on, each flash doubled in the water.",
    ),
  ],
  groups: {
    pool: {
      title: "Pool",
      blurb: "The plunge pool and the near bank, and the fireflies over the water after dark.",
    },
  },
  requires: ["cliff"],
  passes: { begin: "poolBegin", ground: "poolGround", front: "poolFront" },
};

export const fallsLayer: LayerDef = {
  id: "falls",
  title: "Waterfall",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: NO_SPACE,
  camera: GORGE_RIG,
  switch: toggle(
    "layers",
    "falls",
    "waterfall",
    false,
    "The river pouring over the notch in the cliff's lip into the pool: a sheet of water fraying into white ropes as it falls, boiling up where it lands; after dark the white water seems to glow.",
    { icon: "drop" },
  ),
  params: [
    range(
      "falls",
      "flow",
      "flow",
      0.55,
      "How much water comes over the lip: a thin ribbon breaking into strands at the left end, a roaring white curtain at the right.",
    ),
  ],
  groups: {
    falls: {
      title: "Waterfall",
      blurb: "How much water pours over the lip.",
    },
  },
  requires: ["cliff"],
  passes: { begin: "fallsWaterBegin", middle: "fallsMiddle", air: "fallsAir" },
};

export const sprayLayer: LayerDef = {
  id: "spray",
  title: "Spray",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: NO_SPACE,
  camera: GORGE_RIG,
  switch: feature(
    "layers",
    "spray",
    "spray",
    false,
    "mist",
    0.6,
    "Spray thrown up where the water lands, and off the falling sheet: a low haze over the pool at the left end, clouds billowing up the cliff at the right.",
    { min: 0, icon: "fog" },
  ),
  params: [
    feature(
      "spray",
      "rainbow",
      "rainbow",
      true,
      "strength",
      0.7,
      "A rainbow in the spray, 42° from the point opposite the sun. Like a real one it shows only while the sun is up and only where there is spray to hold it, standing higher the lower the sun.",
    ),
  ],
  groups: {
    spray: {
      title: "Spray",
      blurb: "The rainbow standing in the spray.",
    },
  },
  requires: ["falls"],
  passes: { begin: "sprayBegin", middleVeil: "sprayMiddleVeil" },
};

/** The bank ferns' time of year (scenes/plants.ts): the composer lists it among its own knobs. */
const [season] = plantKnobs({ group: "greenery", season: 0.35 });

export const greeneryLayer: LayerDef = {
  id: "greenery",
  title: "Moss & ferns",
  composers: ["outdoor"],
  role: "cover",
  bands: ["far", "middle", "front"],
  space: NO_SPACE,
  camera: GORGE_RIG,
  switch: feature(
    "layers",
    "greenery",
    "moss & ferns",
    false,
    "amount",
    0.6,
    "Moss on the ledges and the wet rock, ferns and creepers hanging from them, ferns on the near bank.",
    { min: 0, icon: "leaf" },
  ),
  params: plantKnobs({ group: "greenery", growth: 0.4 }),
  ...(season === undefined ? {} : { season }),
  groups: {
    greenery: {
      title: "Moss & ferns",
      blurb:
        "The ferns on the near bank keep growing, turning with the year and shed and renewed, swaying on their own springs in the wind and the gusts.",
    },
  },
  requires: ["cliff"],
  data: { rows: FALLS_ROWS },
  passes: { begin: "greeneryBegin", front: "greeneryFront" },
};
