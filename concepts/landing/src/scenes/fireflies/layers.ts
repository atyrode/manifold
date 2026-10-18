// The Fireflies preset's layers (ADR 0062 Phase 2b): their manifests, which load without their code
// (shader.ts, sim.ts). Each is drawn through the river's own rig alone (FIREFLIES_RIG): the bank, its
// lattice of fireflies and the river's mirror are laid out in the frame at the far bank's distance,
// so another rig is not offered them.
//   mangroves     backdrop: the moonless night over the bank, the World's sky (its stars, the odd
//                 shooting star) with the bank's own skyglow staged in place of the World's night
//                 dome; the distant hills; the mangroves in black (rooted plants: crowns, prop roots,
//                 Sonneratia trunks, or low scrub on an open mud bank) swaying in the breeze, the
//                 mist at their foot; the river's air. The breeze is the composer's gusts: now and
//                 then one crosses the river (its sim, lent to the swarm). Its view in a level mirror
//                 (`mangrovesMirror`) is what the creek mirrors. The land ends at the waterline.
//   creek         ground: the still river mirroring the backdrop (composerMirror), its long swells
//                 bending the reflection, the breeze's catspaw and the rain dulling it, the mist lying
//                 on it. Its water claims the floor from our bank to the far one: no cover grows on it.
//   fireflySwarm  life: the fireflies (sim.ts: pulse-coupled oscillators on a lattice over the bank,
//                 each pulse a wave or with `unison` one flash), their halos through the crowns, their
//                 reflections, the drifters low over the water and the out-of-focus ones close by, the
//                 lantern the pointer carries, the M; every light drawn two-state (its `shade` pass).
//                 It lives in the mangroves' crowns, so it needs them; its glow and the lantern light
//                 every other layer (`fireflySwarmGlow`, `fireflySwarmLanternLight`).
// What each draws is at the top of shader.ts, how the swarm keeps time at the top of sim.ts.
import type { LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, toggle } from "../../params.ts";
import { FIREFLIES_BANK, FIREFLIES_RIG, FIREFLY_SWARM_ROWS, MANGROVES_ROWS } from "./constants.ts";

/** The river's own rig, and no other. */
const RIVER_RIG = {
  eye: [FIREFLIES_RIG.eye, FIREFLIES_RIG.eye],
  horizon: [FIREFLIES_RIG.horizon, FIREFLIES_RIG.horizon],
  focal: [FIREFLIES_RIG.focal, FIREFLIES_RIG.focal],
  pitch: [FIREFLIES_RIG.pitch, FIREFLIES_RIG.pitch],
} as const;

/** Our bank's waterline (m ahead): just below the frame's bottom edge (about 4 m out). */
const NEAR_BANK = 3;

export const mangrovesLayer: LayerDef = {
  id: "mangroves",
  title: "Mangroves",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: RIVER_RIG,
  switch: toggle(
    "layers",
    "mangroves",
    "mangroves",
    false,
    "The far bank of a mangrove river at night: rounded crowns in black on arching prop roots, now and then a tall Sonneratia, against the skyglow low over the trees and distant hills, mist lying at their foot; a breeze crossing the river now and then sways them.",
    { icon: "tree" },
  ),
  params: [
    choice(
      "mangroves",
      "habitat",
      "bank",
      [
        { label: "dense crowns", value: 0 },
        { label: "open bank", value: 1 },
      ],
      0,
      "The bank. Dense crowns: a wall of mangroves, the fireflies packed into the crowns of the tall trees, so each pulse lights the trees from within. Open bank: low scrub along a wide mud bank with a lone tree here and there, the fireflies hovering low over all of it, so each pulse is a band of light along the waterline, doubled in the river. Both hold the same number of fireflies at any setting of 'fireflies'.",
    ),
  ],
  groups: {
    mangroves: {
      title: "Mangroves",
      blurb:
        "The far bank: a wall of mangrove crowns or an open mud bank. Its trees sway when a gust crosses the river.",
    },
  },
  data: { rows: MANGROVES_ROWS, fields: 2 },
  passes: {
    begin: "mangrovesBegin",
    sky: "mangrovesSky",
    far: "mangrovesFar",
    mirror: "mangrovesMirror",
  },
};

export const creekLayer: LayerDef = {
  id: "creek",
  title: "Creek",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the creek's waters",
        kind: "exclusive",
        shape: {
          kind: "box",
          at: [0, 0.5 * (NEAR_BANK + FIREFLIES_BANK)],
          half: [4 * FIREFLIES_BANK, 0.5 * (FIREFLIES_BANK - NEAR_BANK)],
        },
      },
    ],
  },
  camera: RIVER_RIG,
  switch: toggle(
    "layers",
    "creek",
    "creek",
    false,
    "The still tidal river between you and the far bank, mirroring the skyglow, the trees and their lights; long slow swells bend the reflection, a gust's catspaw breaks it up.",
    { icon: "ripple" },
  ),
  params: [
    range(
      "creek",
      "reflections",
      "reflections",
      0.85,
      "How clearly the still river mirrors the skyglow, the trees and their lights.",
    ),
    range(
      "creek",
      "creekMist",
      "mist",
      0.35,
      "Mist lying on the water and under the trees, glowing green with each pulse.",
    ),
  ],
  groups: {
    creek: { title: "River", blurb: "The mirror of the water, and the mist." },
  },
  passes: { ground: "creekGround" },
};

export const fireflySwarmLayer: LayerDef = {
  id: "fireflySwarm",
  title: "Fireflies",
  composers: ["outdoor"],
  role: "life",
  bands: ["far", "middle", "front"],
  space: { anchors: [], claims: [] },
  camera: RIVER_RIG,
  switch: toggle(
    "layers",
    "fireflySwarm",
    "fireflies",
    false,
    "Thousands of fireflies in the mangroves' crowns, each flashing on its own clock and nudged by the flashes it sees, until the whole bank pulses together; a few drift low over the water and a few hang close to you, out of focus.",
    { icon: "sparkle" },
  ),
  params: [
    range(
      "swarm",
      "coupling",
      "coupling",
      0.5,
      "How strongly each firefly answers the flashes it sees. Low: everyone keeps their own time and the bank twinkles. High: the beat spreads within seconds and the whole forest pulses as one.",
    ),
    range(
      "swarm",
      "unison",
      "unison",
      0,
      "How far each firefly's own pace gives way to the beat it sees. At 0 each keeps its own pace, so every pulse sweeps out from the fastest trees as a wave. Higher, each adapts its pace to the beat, as the mangrove fireflies of Malaysia do, and the bank flashes in a single instant.",
    ),
    range(
      "swarm",
      "density",
      "fireflies",
      0.65,
      "How many fireflies settle in the mangroves, from a few scattered sparks to crowns full of them, with a few more drifting low over the water.",
      { min: 0.1, max: 1 },
    ),
    range(
      "swarm",
      "fireflySwarmPeriod",
      "flash period",
      3,
      "Seconds from one flash to the next. A flash lasts under a second; the rest is dark.",
      { min: 1.5, max: 6, step: 0.1 },
    ),
    range(
      "swarm",
      "fireflySwarmDrift",
      "drift",
      0.35,
      "How far each firefly wanders about its leaf.",
    ),
    feature(
      "swarm",
      "near",
      "close fireflies",
      true,
      "how many",
      3,
      "Fireflies close to you, out of focus up at the sides: soft warm-green discs that pulse with the rest.",
      { options: counts(1, 3, 6) },
    ),
    toggle(
      "lantern",
      "fireflySwarmLantern",
      "lantern",
      true,
      "Your pointer carries a small lantern. Fireflies near a light lose the beat, and right beside it they stop flashing; click to flare it and scatter their rhythm.",
    ),
    feature(
      "manifold",
      "fireflySwarmMark",
      "M of fireflies",
      false,
      "beats",
      5,
      "A few seconds after you switch it on, and every minute after, the fireflies along the strokes of a Manifold M gather onto them, glowing faintly, and flash half a beat apart from the forest, so the M lights up alone between the pulses for a few beats, mirrored in the river, then lets go.",
      { options: counts(3, 5, 8) },
    ),
  ],
  groups: {
    swarm: {
      title: "Fireflies",
      blurb:
        "Each firefly flashes on its own clock and is nudged by the flashes it sees, until the whole bank pulses together. A gust crossing the river breaks the beat now and then.",
    },
    lantern: { title: "Lantern", blurb: "The light you carry along the river." },
    manifold: {
      title: "Manifold mark",
      blurb: "The fireflies themselves draw the M, flashing out of step with the forest.",
    },
  },
  triggers: ["fireflySwarmMark"],
  mark: "fireflySwarmMark",
  requires: ["mangroves"],
  lights: [
    { name: "the fireflies' glow", glsl: "fireflySwarmGlow" },
    { name: "the lantern", glsl: "fireflySwarmLanternLight" },
  ],
  data: { rows: FIREFLY_SWARM_ROWS, fields: 1 },
  passes: { front: "fireflySwarmFront", shade: "fireflySwarmShade" },
};
