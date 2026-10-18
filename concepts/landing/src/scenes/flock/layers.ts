// The Murmuration preset's layers (ADR 0062 Phase 2c): their manifests, which load without their
// code (shader.ts, sim.ts).
//   roost        backdrop: the World's sky over the roost, with the afterglow low toward the sun as
//                the accent; the skyline laid out across the foot of the frame (`skyline`): rooftops in
//                two rows whose windows light up as night falls, a reed bed on still water under a low
//                far shore with two lamps, or the open sea under a headland with its turning
//                lighthouse; the still water and the sea mirroring the sky's dome and the cloud deck,
//                the reeds swaying in the wind (no gust: see shader.ts). It is drawn through the
//                roost's own rig alone (FLOCK_RIG): the skyline is laid out on the frame, the water
//                and the rooftops are the land in front, and no site floor shows below them.
//   murmuration  life: the starlings (sim.ts: a choreographed sheet, or with `emergent` topological
//                boids), inked from their density field (a field slot) far out in the sky, so every
//                nearer thing hides them; the falcon that stoops through them and the Manifold M they
//                draw (a row of the records atlas). They fly in the band of sky over the rig's
//                horizon, so any level rig that shows enough sky offers them (MURMURATION_CAMERA).
// What each draws is at the top of shader.ts, how the flock flies at the top of sim.ts.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, toggle } from "../../params.ts";
import { FLOCK_RIG, FLOCK_SIZES, MURMURATION_DATA } from "./constants.ts";

/** The roost's own rig, and no other. */
const ON_THE_BANK: CameraRange = {
  eye: [FLOCK_RIG.eye, FLOCK_RIG.eye],
  horizon: [FLOCK_RIG.horizon, FLOCK_RIG.horizon],
  focal: [FLOCK_RIG.focal, FLOCK_RIG.focal],
  pitch: [FLOCK_RIG.pitch, FLOCK_RIG.pitch],
};

/**
 * The rigs the murmuration flies over: a level eye on open ground, from the roost's low horizon to
 * one with two fifths of the frame left for sky, at an everyday field of view (the meadow, the bees'
 * garden, the shore, the waterfall's gorge).
 */
const MURMURATION_CAMERA: CameraRange = {
  eye: [1.6, FLOCK_RIG.eye],
  horizon: [FLOCK_RIG.horizon, 0.6],
  focal: [0.9, 1.4],
  pitch: [0, 0],
};

export const roostLayer: LayerDef = {
  id: "roost",
  title: "Roost",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_BANK,
  switch: toggle(
    "layers",
    "roost",
    "roost",
    false,
    "Where the starlings come to roost at dusk: a low skyline along the foot of a sky that fills the view, rooftops, a reed bed on still water or the sea under a headland.",
    { icon: "city" },
  ),
  params: [
    choice(
      "skyline",
      "skyline",
      "skyline",
      [
        { label: "city", value: 0 },
        { label: "reeds", value: 1 },
        { label: "sea", value: 2 },
      ],
      1,
      "The low silhouette along the bottom: rooftops, a reed bed on still water, or the sea under a headland. Lights come on as night falls.",
    ),
  ],
  groups: { skyline: { title: "Skyline", blurb: "The thin silhouette that grounds the sky." } },
  // Each skyline is compiled in only while it is the one shown; the all-features program has all
  // three, each behind the same test of the knob.
  featuresFor: (values) => {
    const skyline = Math.round(values["skyline"] ?? 1);
    return {
      ROOST_CITY: skyline === 0 ? 1 : 0,
      ROOST_REEDS: skyline === 1 ? 1 : 0,
      ROOST_SEA: skyline !== 0 && skyline !== 1 ? 1 : 0,
    };
  },
  featuresAll: { ROOST_CITY: 1, ROOST_REEDS: 1, ROOST_SEA: 1 },
  passes: {
    begin: "roostBegin",
    sky: "roostSky",
    far: "roostFar",
    farVeil: "roostFarVeil",
    middle: "roostMiddle",
    shade: "roostShade",
  },
};

export const murmurationLayer: LayerDef = {
  id: "murmuration",
  title: "Murmuration",
  composers: ["outdoor"],
  role: "life",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: MURMURATION_CAMERA,
  switch: feature(
    "layers",
    "murmuration",
    "murmuration",
    false,
    "starlings",
    3000,
    "Starlings at dusk, thousands of birds folding into one shape far out over the land: more make a deeper, darker cloud; fewer leave single birds easy to pick out.",
    { options: counts(...FLOCK_SIZES), icon: "bird" },
  ),
  params: [
    range(
      "flock",
      "cohesion",
      "cohesion",
      0.55,
      "Low: a loose flock that stretches into ribbons, tears and joins up again. High: a tight, dark ball.",
    ),
    range(
      "flock",
      "chaos",
      "chaos",
      0.35,
      "Calm: the flock sweeps as one smooth sheet. Restless: it folds and splits, and ripples run through it now and then with no falcon in sight.",
    ),
    range(
      "flock",
      "speed",
      "speed",
      0.5,
      "How fast the flock sweeps across the sky and changes shape.",
    ),
    feature(
      "flock",
      "predator",
      "falcon",
      true,
      "frequency",
      0.35,
      "A peregrine dives through now and then: the birds flash apart around it and dark waves ripple out across the flock.",
    ),
    feature(
      "flock",
      "emergent",
      "emergent flight",
      false,
      "neighbours",
      7,
      "Off: the flock flies as one choreographed sheet that stretches, banks, folds and parts on cue. On: every starling steers only by its nearest few neighbours, keeping its distance, matching their heading and closing on them, and the flock's shape, its turns and its splits come out of that alone; startles hop from bird to bird. The amount is how many neighbours each bird watches; real starlings watch about seven.",
      { min: 3, max: 12, step: 1 },
    ),
    feature(
      "manifold",
      "murmurationMark",
      "M formation",
      false,
      "frequency",
      0.3,
      "Every so often the flock gathers into the Manifold M, streams along its strokes for a few seconds, then lets go.",
    ),
  ],
  groups: {
    flock: {
      title: "Flock",
      blurb:
        "How tightly the starlings keep together, how restless they are, the falcon that scatters them, and whether they fly a choreographed sheet or steer by their neighbours.",
    },
    manifold: { title: "Manifold mark", blurb: "The flock itself draws the M, then lets it go." },
  },
  triggers: ["predator", "murmurationMark"],
  mark: "murmurationMark",
  data: MURMURATION_DATA,
  passes: { far: "murmurationFar" },
};
