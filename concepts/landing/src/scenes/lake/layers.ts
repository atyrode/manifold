// The Frozen lake preset's layers (ADR 0062 Phase 2b): their manifests, which load without their
// code (shader.ts, sim.ts). Both are drawn through the lake's own rig alone (LAKE_RIG): the crack and
// snow fields are laid out for that eye on the ice, and the fjord is drawn through a camera of its
// own, so another rig is not offered them.
//   farShore  backdrop: the lake's own night (ADR 0062 D10: the hour, our moon on its fixed bearing,
//             the stars and the Milky Way, the shooting stars, the aurora's shared curtains or slow
//             drapes with their corona on the substorm clock (its sim, a row of the records atlas), the
//             World's cloud deck), staged on the World so its weather and any guest are lit by it;
//             the place it is (`setting`): across the frozen lake the snowbank, the log cabin on its
//             point and its smoke, the spruce forest, the hills and the mountains, or across the fjord
//             its red cabin and birches, the mountains going straight into the water; the skein of
//             geese in that night (the World's birds knobs); its view in a level mirror, which the
//             lake asks through composerMirror; the exit's gust of blown snow; the air the World's
//             rain and snow fuse into.
//   lake      ground: the black ice (its mirror, the bubbles frozen in it, the cracks and their
//             songs, the snow lying and drifting on it, the hands' knocks and brooms: its sim, three
//             field slots and a row), and the M cracked into it; or over the fjord the open water
//             freezing over and ruffled by the wind, mirroring the far shore, with the near bank and
//             its birches, and the M folded into a curtain of the aurora. It lies under the far
//             shore's night, so it needs it; nothing grows on it.
// What each draws is at the top of shader.ts, how the ice and the aurora live at the top of sim.ts.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { LAKE_DATA, LAKE_RIG } from "./constants.ts";

/** The lake's own rig, and no other. */
const ON_THE_ICE: CameraRange = {
  eye: [LAKE_RIG.eye, LAKE_RIG.eye],
  horizon: [LAKE_RIG.horizon, LAKE_RIG.horizon],
  focal: [LAKE_RIG.focal, LAKE_RIG.focal],
  pitch: [LAKE_RIG.pitch, LAKE_RIG.pitch],
};

export const farShoreLayer: LayerDef = {
  id: "farShore",
  title: "Far shore",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ICE,
  switch: toggle(
    "layers",
    "farShore",
    "far shore",
    false,
    "The northern night across the water: a log cabin on a point, spruce forest, hills and snowy mountains under the moon, the stars and the aurora; or a fjord's far shore, a red cabin among birches under mountains going straight into the water.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "place",
      "setting",
      "place",
      [
        { label: "frozen lake", value: 0 },
        { label: "fjord", value: 1 },
      ],
      0,
      "Where the night is: on the black ice of a frozen lake (the Ice knobs), or on the bank of a fjord, still open water between snowy mountains that go straight down into it, a red cabin and its birches on the far shore (the Fjord knobs). The sky, the aurora, the cabin's light, the birds and the weather are the same over both.",
    ),
    range(
      "night",
      "hour",
      "hour",
      0.75,
      "From the blue hour, the last light glowing low on the left, to the deep of the night: the lake's own night, whatever the World's time of day.",
    ),
    toggle(
      "night",
      "cabin",
      "cabin",
      true,
      "A cabin on the far shore, its window lit by the fire and its light drawn down the ice or the water toward you: a log cabin on the point across the lake, its smoke rising until it flattens under the cold air above; a small red one among birches across the fjord, its thread of smoke leaning with the wind.",
    ),
    choice(
      "aurora",
      "hue",
      "colour",
      [
        { label: "green", value: 4 },
        { label: "green + violet", value: 0 },
        { label: "teal", value: 1 },
        { label: "storm", value: 2 },
        { label: "crimson", value: 3 },
      ],
      0,
      "The aurora's colours: the common oxygen green alone, green with violet above it, teal under blue-violet tops, a storm's green under crimson, or the rare deep red aurora.",
    ),
    toggle(
      "aurora",
      "drapes",
      "slow drapes",
      false,
      "Instead of the shared arcs, slow drapes: up to three curtains hanging along slowly evolving S-bends, a sharp bright hem under fine vertical rays, a pulse of light running along each, lit stretches and dark gaps, the colour's fringe toward the top. They unfurl as the scene comes in and roll up as it goes; a substorm brightens them, folds them deeper and quickens them.",
      { icon: "aurora" },
    ),
    range(
      "aurora",
      "activity",
      "activity",
      0.5,
      "How lively the drapes are: calm, gently rippling arcs, or deep folds, brightening pulses running along the arcs and a third curtain high behind.",
      { when: "drapes" },
    ),
    feature(
      "aurora",
      "corona",
      "corona",
      true,
      "frequency",
      0.35,
      "Now and then the drapes gather overhead into a corona: rays streaming down from a point high in the sky, for half a minute or so. Now: one at once.",
      { when: "drapes" },
    ),
    feature(
      "aurora",
      "substorm",
      "substorms",
      true,
      "frequency",
      0.4,
      "Every few minutes the quiet arc brightens for a while, then breaks up: the light surges, curtains spread overhead and ripple faster, and over a couple of minutes the sky calms again. Now: start one.",
    ),
  ],
  groups: {
    place: {
      title: "Place",
      blurb:
        "The frozen lake, or a fjord of open water between the mountains that freezes over as you like and ripples in the wind.",
      icon: "mountain",
      recipes: [
        {
          label: "Aurora fjord",
          icon: "aurora",
          help: "The still fjord at the deep of the night under the quiet slow drapes, green under violet with their corona now and then, a thin crescent low over the mountains and no Milky Way, the sky clear.",
          set: {
            setting: 1,
            ice: 0,
            ripples: 0,
            aurora: 1,
            "aurora-amount": 0.7,
            hue: 0,
            drapes: 1,
            activity: 0.5,
            corona: 1,
            "corona-amount": 0.35,
            substorm: 0,
            hour: 1,
            moon: 1,
            "moon-amount": 0.25,
            milkyWay: 0,
            clouds: 0,
            rain: 0,
            snow: 0,
            fog: 0,
          },
        },
      ],
    },
    aurora: {
      title: "Aurora",
      blurb:
        "The northern lights overhead and in the ice or the water: what colours, the shared arcs or the slow drapes with their corona, and the substorms that set them dancing. How bright: the aurora under Sky.",
    },
    night: {
      title: "Night",
      blurb:
        "The hour, from the last light of the blue hour to the deep of the night, and the cabin on the far shore.",
    },
  },
  triggers: ["corona", "substorm"],
  // The far rain and snow fuse into the snowy night's air, lit by the moon and the aurora.
  precip: { air: "farShoreSnowAir" },
  data: LAKE_DATA.farShore,
  featuresFor: (values) => ({
    LAKE_FJORD: (values["setting"] ?? 0) > 0 ? 1 : 0,
    LAKE_DRAPES: (values["drapes"] ?? 0) > 0 ? 1 : 0,
  }),
  featuresAll: { LAKE_FJORD: 1, LAKE_DRAPES: 1 },
  passes: {
    begin: "farShoreBegin",
    far: "farShoreFar",
    mirror: "farShoreMirror",
    air: "farShoreAir",
  },
};

export const lakeLayer: LayerDef = {
  id: "lake",
  title: "Lake",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ICE,
  switch: toggle(
    "layers",
    "lake",
    "lake",
    false,
    "The water before the far shore: black ice swept by the wind, bubbles frozen deep in it, cracks that sing, snow lying and drifting on it; over the fjord open still water, freezing over as you like and ruffled by the wind.",
    { icon: "waves" },
  ),
  params: [
    range(
      "ice",
      "mirror",
      "ice mirror",
      0.7,
      "How clearly the black ice mirrors the aurora, the moon and the far shore: low for rough, hazy ice, high for dark glass you could fall into.",
    ),
    feature(
      "ice",
      "cracks",
      "singing ice",
      true,
      "frequency",
      0.45,
      "Now and then the ice sings: a new crack zips across it with a flash, branching off an old one or running in from beyond the frame; later in the night old cracks sing again. Click the ice to knock on it and it answers. Now: one at once.",
    ),
    range(
      "ice",
      "fractures",
      "cracks",
      0.5,
      "How cracked the ice is: a few long pressure cracks across a clear sheet, or a web of branches and hairlines. Under each crack its fracture plane hangs down into the black ice.",
    ),
    feature(
      "ice",
      "bubbles",
      "frozen bubbles",
      true,
      "density",
      0.6,
      "Methane bubbles frozen in the ice as it thickened: white discs stacked in columns over the seeps on the lake bed, fainter and bluer deeper down, with clouds of small ones near the surface.",
    ),
    range(
      "ice",
      "cover",
      "snow patches",
      0.35,
      "How much of the ice lies under wind-packed snow. Drag across the ice to sweep it clear; the wind slowly brings loose snow back.",
    ),
    range(
      "ice",
      "fresh",
      "fresh snow",
      0,
      "How recently snow fell on the lake, for the same snow on the same ice. None: old snow, packed hard by the wind and carved into low ridges, greyer where it lies thin, its edges crisp. Higher: more of its surface is fresh powder, smooth and brighter, white even where it lies thin, its edges feathering out into a dusting over the black ice, more crystals glinting in it; freshest where the wind has just laid loose snow down.",
    ),
    feature(
      "ice",
      "drift",
      "drifting snow",
      true,
      "amount",
      0.5,
      "Loose snow lifted by the gusts and blown across the ice in long, thin streamers trailing off every patch, settling again when the wind drops. The wind sets which way and how hard.",
    ),
    range(
      "fjord",
      "ice",
      "fjord ice",
      0,
      "On the fjord: open still water, mirroring the whole sky, to the left; to the right the fjord freezes over, first in plates with dark leads between them, then wholly: dull dark ice, hairline cracks, snow lying in patches.",
    ),
    range(
      "fjord",
      "ripples",
      "wind ripples",
      0,
      "On the fjord: 0, a still fjord, a clear mirror of the sky. Higher lets the wind (under Wind) ruffle the open water: cat's-paws drift downwind and break the reflections into long vertical streaks. Ice stays still.",
    ),
    toggle(
      "manifold",
      "lakeMark",
      "M",
      false,
      "On the lake a crack in the near ice draws the Manifold M and keeps a little of the aurora's green in it; it sings in a moment after you switch it on. On the fjord a curtain of the aurora folds itself into the M high in the sky, with the same vertical rays, breathing slowly. Now: the crack sings again.",
    ),
  ],
  groups: {
    ice: {
      title: "Ice",
      blurb:
        "Black ice swept by the wind: how it mirrors the night, its cracks and the singing of new ones, the bubbles frozen in it, the snow lying and drifting on it. Click the ice to knock on it; drag to sweep the snow away.",
    },
    fjord: {
      title: "Fjord",
      blurb: "The fjord's open water: how far it has frozen over, and how the wind ruffles it.",
    },
    manifold: {
      title: "Manifold mark",
      blurb:
        "A landmark of its own: an M cracked into the near ice, or folded into a curtain of the aurora over the fjord.",
    },
  },
  triggers: ["cracks", "lakeMark"],
  mark: "lakeMark",
  requires: ["farShore"],
  excludes: [
    { layer: "grass", why: "nothing grows on the ice or in the fjord" },
    { layer: "wildflowers", why: "nothing grows on the ice or in the fjord" },
    { layer: "dandelions", why: "nothing grows on the ice or in the fjord" },
  ],
  data: LAKE_DATA.lake,
  passes: { ground: "lakeGround", front: "lakeFront" },
};
