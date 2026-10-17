// The Bees preset's layers (ADR 0062 Phase 1): their manifests, which load without their code
// (shader.ts, sim.ts). Each is drawn through the garden's own rig alone (BEES_RIG): its parts are laid
// out on the garden's stage (layout.ts), so another rig is not offered them.
//   hillside  backdrop: the World's sky over three bands of hills and the far farmhouse and windmill,
//             the valley's air; the land ends at the garden's far edge.
//   lawn      ground: the lawn with its clover and windfalls, the hedge, the path, the blades at the
//             lens (LAWN_BLADES), the wet lawn's sheen.
//   apiary    dressing, the subject: the flower drifts, the orchard behind the dry-stone wall, the
//             three hives (drawn 1.5 times life size), the lantern and the fairy lights, the near
//             foxgloves and blooms; its claims (the hives, the wall, the path, the orchard, the drifts)
//             are laid out at the rig's minAspect and spread with a wider frame.
//   insects   life: the colony and the garden's other insects (sim.ts), specks in the shared map;
//             they keep to the apiary's hives and flowers, so they need it.
// What each draws is at the top of shader.ts, how the insects live at the top of sim.ts.
import type { Claim, LayerDef, Shape } from "../../composer/types.ts";
import { counts, feature, range, toggle } from "../../params.ts";
import { BEES_RIG } from "./constants.ts";
import {
  BEES_CAM,
  BEES_CODE,
  BEES_GROUND_PATCHES,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_LUSH_FROM,
  BEES_PATCHES,
  BEES_STAGE_MIN,
  BEES_YH,
} from "./layout.ts";

/** The garden's own rig, and no other. */
const GARDEN_RIG = {
  eye: [BEES_RIG.eye, BEES_RIG.eye],
  horizon: [BEES_RIG.horizon, BEES_RIG.horizon],
  focal: [BEES_RIG.focal, BEES_RIG.focal],
  pitch: [BEES_RIG.pitch, BEES_RIG.pitch],
} as const;

/** The ground's depth (m) at uv height y, as the garden's rig sees it. */
const depth = (y: number) => BEES_CAM / (BEES_YH - y);

/** A place on the stage (f of its half width, ground at uv height y) on the floor, at minAspect (m). */
const atStage = (f: number, y: number): readonly [number, number] => [
  f * BEES_STAGE_MIN * depth(y),
  depth(y),
];

/** The path's centre line at uv height y (shader.ts beesPathEdge), on the floor at minAspect. */
function pathAt(y: number): readonly [number, number] {
  const ease = Math.min(1, Math.max(0, y / 0.38));
  const wind = Math.min(1, Math.max(0, (y - 0.02) / 0.18));
  const f =
    0.05 +
    0.3 * ease * ease * (3 - 2 * ease) +
    0.05 * Math.sin(y * 8 + 1) * wind * wind * (3 - 2 * wind);
  return atStage(f, y);
}

/** A drift's ellipse on the stage as a box on the floor round it. */
function driftBox(f: number, y: number, rx: number, ry: number): Shape {
  const near = depth(y - ry);
  const far = depth(y + ry);
  return {
    kind: "box",
    at: atStage(f, y),
    half: [rx * BEES_STAGE_MIN * depth(y), 0.5 * (far - near)],
  };
}

/** The wall's foot (uv) and the trees' (shader.ts BEES_WALL_Y, layout.ts BEES_TREES). */
const WALL_Y = 0.372;
const ORCHARD_Y = 0.386;

/**
 * The apiary's claims, at minAspect: the three hives (exclusive, as drawn: 1.5 times life size,
 * each throwing the long soft key-light shadow the garden always gave them), the dry-stone wall and
 * the orchard behind it (exclusive), the path up to the gate (cleared), and the five flower drifts
 * on the ground (shared: a cover grows into them by its overgrowth).
 */
const APIARY_CLAIMS: readonly Claim[] = [
  ...BEES_HIVES.map((hive): Claim => ({
    name: "the hives",
    kind: "exclusive",
    shape: {
      kind: "box",
      at: atStage(hive.f, hive.y),
      half: [0.5 * BEES_HIVE.width * BEES_HIVE_SCALE + 0.05, 0.35],
    },
    shadow: { height: 1.6, radius: 0.75, length: 3.5 },
    mustShow: true,
  })),
  {
    name: "the wall",
    kind: "exclusive",
    shape: { kind: "strip", points: [atStage(-1.2, WALL_Y), atStage(1.2, WALL_Y)], half: 0.3 },
  },
  {
    name: "the orchard",
    kind: "exclusive",
    shape: { kind: "box", at: [0, depth(ORCHARD_Y)], half: [14, 1.5] },
  },
  {
    name: "the path",
    kind: "clears",
    shape: { kind: "strip", points: [0, 0.1, 0.2, 0.3, 0.38].map(pathAt), half: 0.6 },
  },
  ...BEES_PATCHES.slice(0, BEES_GROUND_PATCHES).map((patch): Claim => ({
    name: "the flower drifts",
    kind: "shared",
    shape: driftBox(patch.f, patch.y, patch.rx, patch.ry),
  })),
];

export const hillsideLayer: LayerDef = {
  id: "hillside",
  title: "Hillside",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: GARDEN_RIG,
  switch: toggle(
    "layers",
    "hillside",
    "hillside",
    false,
    "Rolling hills beyond the garden: patchwork fields, hedgerows and tree clumps, a farmhouse and a windmill on a crest, hazing into the distance under towering cumulus.",
    { icon: "fields" },
  ),
  params: [],
  groups: {},
  passes: { begin: "hillsideBegin", sky: "hillsideSky", far: "hillsideFar", air: "hillsideAir" },
};

export const lawnLayer: LayerDef = {
  id: "lawn",
  title: "Lawn",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: GARDEN_RIG,
  switch: toggle(
    "layers",
    "lawn",
    "lawn",
    false,
    "The garden's lawn: patches of yellower and bluer green, clover and windfalls, swells of wind running through it; the hedge along its far edge, a path winding up to the gate, blades of grass at your feet.",
    { icon: "sprout" },
  ),
  params: [],
  groups: {},
  featuresFor: () => ({ LAWN_BLADES: 1 }),
  featuresAll: { LAWN_BLADES: 1 },
  passes: { ground: "lawnGround", frontVeil: "lawnFrontVeil" },
};

export const apiaryLayer: LayerDef = {
  id: "apiary",
  title: "Apiary",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["middle", "front"],
  space: { anchors: [{ name: "the garden", at: [0, 0] }], claims: APIARY_CLAIMS, stretch: true },
  camera: GARDEN_RIG,
  display: { scale: BEES_HIVE_SCALE },
  switch: toggle(
    "layers",
    "apiary",
    "apiary",
    false,
    "Three pastel box hives in a garden of flower drifts (lavender rows, poppies, daisies, wild flowers, cosmos, foxgloves), an old orchard behind a dry-stone wall.",
    { icon: "fence" },
  ),
  params: [
    range(
      "garden",
      "flowers",
      "flowers",
      1,
      "How thickly the flower drifts bloom: thinner below 1, down to bare grass at 0; above 1 denser and wider drifts with more poppies, daisies and foxgloves close by, and near 3 the drifts run down the slope to your feet.",
      { min: 0, max: 3, step: 0.05, icon: "flower" },
    ),
    feature(
      "garden",
      "lantern",
      "lantern",
      false,
      "brightness",
      0.7,
      "An iron lantern hanging from a crook among the hives, unlit by day. After dusk it glows warm: it lights the hives, the path, the nearby flowers and the grass, fading over a few metres, the hives throwing soft shadows away from it, and it hangs a halo in fog and rain.",
    ),
    toggle(
      "garden",
      "fairyLights",
      "fairy lights",
      false,
      "A string of small garden lights sagging along the top of the dry-stone wall: after dusk each bulb glows warm on the stones, haloed in fog and rain.",
      { icon: "bulb" },
    ),
    feature(
      "manifold",
      "mark",
      "M on the hive",
      false,
      "boldness",
      0.8,
      "The Manifold M painted on the front of the middle hive, in ochre on its powder-blue boxes.",
    ),
  ],
  groups: {
    garden: {
      title: "Garden",
      blurb:
        "How thickly the flowers bloom, and the lights for the evening: a lantern among the hives and fairy lights along the wall.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  lights: [{ name: "the lantern", glsl: "beesLampLight", gate: "APIARY_LANTERN" }],
  casters: ["apiaryCrowns"],
  mark: "mark",
  // The lantern and the fairy lights while on, the drifts' density while the flowers are other than
  // 1, the extra near blooms and foxgloves once they can stand (BEES_LUSH_FROM).
  featuresFor: (values) => ({
    APIARY_LANTERN: (values["lantern"] ?? 0) > 0 ? 1 : 0,
    APIARY_FAIRY: (values["fairyLights"] ?? 0) > 0 ? 1 : 0,
    APIARY_FLOWERS: (values["flowers"] ?? 1) !== 1 ? 1 : 0,
    APIARY_LUSH: (values["flowers"] ?? 1) >= BEES_LUSH_FROM ? 1 : 0,
  }),
  featuresAll: { APIARY_LANTERN: 1, APIARY_FAIRY: 1, APIARY_FLOWERS: 1, APIARY_LUSH: 1 },
  passes: {
    middle: "apiaryMiddle",
    front: "apiaryFront",
    frontVeil: "apiaryFrontVeil",
    air: "apiaryAir",
  },
};

export const insectsLayer: LayerDef = {
  id: "insects",
  title: "Insects",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: GARDEN_RIG,
  switch: toggle(
    "layers",
    "insects",
    "insects",
    false,
    "The colony working the hives, its foragers out to the flowers and home loaded with pollen; butterflies, bumblebees, hoverflies and dragonflies by day, glow-worms in the grass after dusk.",
    { icon: "bee" },
  ),
  params: [
    feature(
      "life",
      "bees",
      "bees",
      true,
      "colony",
      48,
      "How many bees are about, each flying in the garden's space at its real size (a speck of a cell at the hives, a little bigger close to you): foragers leave the hives for the flowers in a nearly straight line, now and then passing close by, hop from flower to flower, and fly home loaded with pollen; some mill at the entrances, and young bees fly orientation loops in front of their hive. They go home at dusk and stay in through the night, and in rain or snow.",
      { options: counts(16, 48, 96, 200) },
    ),
    range(
      "life",
      "silly",
      "pollen-drunk",
      0.2,
      "How pollen-drunk the colony gets. At 0 every bee flies its own nearly straight line; a little, and a few of the most heavily loaded foragers reel home fat and bouncy, in big curvy wobbly loops, bumping off the flowers, the hives' fronts and each other before they manage to land; from the middle on, more and more of every flight; at 1 every bee, the crowds at the entrances bouncing too.",
      { min: 0, max: 1, step: 0.05, icon: "bee" },
    ),
    toggle(
      "life",
      "swarm",
      "swarm",
      false,
      "Now and then on a dry day a swarm: a few hundred bees pour out of one hive, mill in a loose ball over the garden, settle as a cluster hanging from a low branch of an apple tree, rest there a while, then lift off together and leave. Now: a swarm at once (one at a time).",
      { icon: "bee" },
    ),
    feature(
      "life",
      "butterflies",
      "butterflies",
      true,
      "how many",
      5,
      "Orange, white and blue butterflies: a lazy, bobbing flutter with the odd glide, the wingbeat seen as the size of the speck, now and then settling on a flower with the wings slowly opening and closing. From the golden hour, and in rain or snow, they settle with their wings shut until it is light and dry.",
      { options: counts(3, 4, 5, 6) },
    ),
    feature(
      "life",
      "bumblebees",
      "bumblebees",
      true,
      "how many",
      2,
      "Big, slow bumblebees, low and heavy between the flowers: up a foxglove's spike from its lowest bells to the top, swaying with it, then on to the next plant; the poppies and daisies close by, the lavender, now and then the poppies' drift or the cosmos; only what the flowers knob leaves standing, and the more it grows the more they work. By day, in dry weather.",
      { options: counts(1, 2, 4, 6), icon: "bee" },
    ),
    feature(
      "life",
      "hoverflies",
      "hoverflies",
      true,
      "how many",
      3,
      "Amber hoverflies over the drifts: dead still in the air, a dart too quick to follow, still again, now and then down onto a flower. By day, in dry weather.",
      { options: counts(2, 3, 6, 10), icon: "bee" },
    ),
    feature(
      "life",
      "dragonflies",
      "dragonflies",
      true,
      "how many",
      1,
      "A blue dragonfly patrolling the path and the garden: fast straight runs that turn sharply at their ends, a hover or a rest on a foxglove's tip between them, the wings catching the light. By day, in dry weather.",
      { options: counts(1, 2, 3), icon: "bee" },
    ),
    feature(
      "life",
      "glowworms",
      "glow-worms",
      true,
      "how many",
      10,
      "After dusk glow-worms light up low in the grass all over the garden: each a steady green glow on a grass stem, the wingless females calling for a mate, each lighting at its own darkness and going out as the night lifts, and in rain or snow. None by day.",
      { options: counts(5, 10, 20, 40) },
    ),
    feature(
      "life",
      "fireflies",
      "fireflies",
      false,
      "how many",
      24,
      "Fireflies as well, as on a summer night far from this garden: once the sky is dark they rise from the grass, drifting slowly and blinking a slow yellow-green, each in its own time, and sink back as the night lifts, and in rain or snow. None by day.",
      { options: counts(12, 24, 48) },
    ),
  ],
  groups: {
    life: {
      title: "Bees & insects",
      blurb:
        "A colony working three hives, a few of its foragers pollen-drunk, swarming now and then; butterflies, bumblebees, hoverflies and dragonflies by day, glow-worms in the grass after dusk (fireflies too, if you like).",
    },
  },
  triggers: ["swarm"],
  requires: ["apiary"],
  data: { specks: Math.max(...Object.values(BEES_CODE)) },
  passes: { speck: "insectsSpeck" },
};
