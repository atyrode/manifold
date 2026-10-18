// The Shore preset's layers (ADR 0062 Phase 2a): their manifests, which load without their code
// (shader.ts, sim.ts, cairns.ts). Each is drawn through the beach's own rig alone (SHORE_RIG): the
// surf is laid out for that eye over the still water and that long lens, so another rig is not
// offered them.
//   sea     backdrop: the World's sky over the sea, the rain's grey cloud with its light gap and its
//           shafts out at sea, the storm bank right of ahead and its bolts on the World's strike
//           timing; the swell, the breakers and the swash running up the sand, the moon's path and
//           the sky mirrored in the water, the plankton lighting the surf and the hands' wake (its
//           sim, a field slot); the air (the mist low over the sea, the rain's grey) and its say over
//           the World's drops, thinned so they never bury the surf. The plankton's light, gathered
//           from every shore layer, is snapped per cell and laid on last (its shade pass).
//   beach   ground: the sand the sea's swash runs up, dry above it and darker where wet, a mirror
//           while a backwash's film drains off, the lines of foam at the top of each run, bubbles
//           sparking as it drains, the rain's glaze, puddles and splashes, snow on the dry sand; and
//           the M drawn in it. It needs the sea, whose surf wets it.
//   fish    life: a school darting through the shallows now and then, trailing light at night.
//   cairns  chore: the agents' cairns on the wet sand (cairns.ts, the atlas's rows), toppled by the
//           sea's bigger waves (its swash, read through the sea's sim); it needs the beach.
// What each draws is at the top of shader.ts, how the wake and the cairns live at the top of sim.ts.
import type { LayerDef } from "../../composer/types.ts";
import { counts, feature, range, toggle } from "../../params.ts";
import { SHORE_CAIRN_ROWS, SHORE_RIG } from "./constants.ts";

/** The beach's own rig, and no other. */
const BEACH_RIG = {
  eye: [SHORE_RIG.eye, SHORE_RIG.eye],
  horizon: [SHORE_RIG.horizon, SHORE_RIG.horizon],
  focal: [SHORE_RIG.focal, SHORE_RIG.focal],
  pitch: [SHORE_RIG.pitch, SHORE_RIG.pitch],
} as const;

export const seaLayer: LayerDef = {
  id: "sea",
  title: "Sea",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle", "front"],
  space: { anchors: [], claims: [] },
  camera: BEACH_RIG,
  switch: toggle(
    "layers",
    "sea",
    "sea",
    false,
    "The sea under the sky: swell lines rolling in from the horizon, breaking into surf and running up the sand, the moon's path laid across them; a storm bank out at sea while there is lightning, rain hanging in shafts under its cloud.",
    { icon: "waves" },
  ),
  params: [
    range(
      "surf",
      "size",
      "wave size",
      0.5,
      "How tall the breakers stand: small ones spill close in, big ones curl over further out and run higher up the sand.",
    ),
    range(
      "surf",
      "period",
      "wave period",
      8,
      "Seconds between waves: short for a busy surf, long for a slow, deep rhythm.",
      { min: 5, max: 14, step: 0.5 },
    ),
    feature(
      "glow",
      "glow",
      "bioluminescence",
      true,
      "strength",
      0.7,
      "Plankton that flash electric blue wherever the water is disturbed: breaking crests, the edge of the swash, bursting foam. Only visible in the dark.",
    ),
    toggle(
      "glow",
      "stir",
      "stir with pointer",
      true,
      "Moving the pointer over the water or the wet sand stirs the plankton into glowing swirls.",
      { when: "glow" },
    ),
  ],
  groups: {
    surf: {
      title: "Surf",
      blurb:
        "The breakers: how big they stand and how often they come in. The cairns the agents stack on the beach stand until a big one runs past them.",
    },
    glow: {
      title: "Bioluminescence",
      blurb: "Plankton that light up when the water is stirred: by the surf, by fish, by you.",
    },
  },
  // The drops are thinned (0.55 far, 0.35 for the near ones) so they never bury the surf, and the
  // far rain fuses into the rain cloud's grey rather than into the mist the fog takes.
  precip: { thin: [0.55, 0.35], air: "seaRainAir" },
  data: { fields: 1 },
  passes: {
    begin: "seaBegin",
    sky: "seaSky",
    far: "seaFar",
    middle: "seaMiddle",
    shade: "seaShade",
  },
};

export const beachLayer: LayerDef = {
  id: "beach",
  title: "Beach",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: BEACH_RIG,
  switch: toggle(
    "layers",
    "beach",
    "beach",
    false,
    "The sand the surf runs up: dry and rippled above the swash, darker where wet, a mirror of the sky while a backwash drains off it; snow settles on the dry sand.",
    { icon: "dunes" },
  ),
  params: [
    range(
      "sand",
      "sparkles",
      "sparkles",
      0.5,
      "Foam bubbles bursting on the wet sand as the water drains, each with a spark of the plankton's light.",
      { when: "glow" },
    ),
    toggle(
      "manifold",
      "mark",
      "M in the sand",
      false,
      "An M drawn in the wet sand: every wave that washes over it lights it up blue, then it fades until the next.",
    ),
  ],
  groups: {
    sand: {
      title: "Sand",
      blurb: "The wet sand the swash leaves: the plankton stranded on it sparks as the water drains.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: an M drawn in the sand where the waves reach it.",
    },
  },
  requires: ["sea"],
  mark: "mark",
  passes: { ground: "beachGround", front: "beachFront" },
};

export const fishLayer: LayerDef = {
  id: "fish",
  title: "Fish",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: BEACH_RIG,
  switch: feature(
    "layers",
    "fish",
    "fish",
    false,
    "frequency",
    0.3,
    "Now and then a school of fish darts through the shallows, leaving trails of light behind it at night. Now: a school at once.",
    { icon: "fish" },
  ),
  params: [],
  groups: {},
  triggers: ["fish"],
  requires: ["sea"],
  passes: { middle: "fishMiddle" },
};

export const cairnsLayer: LayerDef = {
  id: "cairns",
  title: "Cairns",
  composers: ["outdoor"],
  role: "chore",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: BEACH_RIG,
  switch: feature(
    "layers",
    "cairns",
    "cairns",
    false,
    "stones",
    5,
    "The agents' chore, while the lab has agents in the scene: they carry pebbles to the wet sand and balance them into small cairns, as far up the beach as only the bigger waves run. A big wave knocks a cairn down, and its stones lie round it for the agents to stack again. Stones: how tall a cairn is built.",
    { options: counts(3, 4, 5, 6, 7), icon: "stone" },
  ),
  params: [],
  groups: {},
  requires: ["beach"],
  data: { rows: SHORE_CAIRN_ROWS },
  passes: { front: "cairnsFront", frontVeil: "cairnsFrontVeil" },
};
