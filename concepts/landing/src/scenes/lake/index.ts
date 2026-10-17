// A northern night under the aurora, in one of two places. A frozen lake: black ice swept clear by
// the wind, white methane bubbles frozen in layers beneath it, long pressure cracks hanging their
// fracture planes down into it and now and then a new one singing across with a flash, snow lying in
// wind-carved patches and streaming over the ice, and on the far shore a cabin with a lit window. Or
// a fjord (`setting`): still open water under snowy mountains going straight into it, freezing over
// with the `ice` knob and ruffled by the wind with `ripples`, a red cabin with birches on the far
// shore and birches on the near bank. Over both, one sky: the hour, the moon, the stars and the Milky
// Way, and the aurora, the shared arcs surging overhead every few minutes or the slow drapes
// (`drapes`) with their corona, both on the substorm clock, mirrored in the ice or the water.
// sim.ts grows the cracks, drifts the snow and paces the substorms; shader.ts draws the night. On
// the lake it comes in with the camera tilting down from the aurora onto the ice as a crack sings
// across, and goes out as a gust of snow streams over the ice and the camera tilts back up; on the
// fjord the camera comes down from the stars as the chimney's smoke climbs and lifts to them again
// (LAKE_PASSAGE), and the drapes unfurl coming in and roll up going out.
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { atmosphereGroups, skyComponentKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { LAKE_CORONA_TRIGGER, LAKE_METEOR_TRIGGER, lakeGlsl } from "./shader.ts";
import { LAKE_PASSAGE, lakeSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice(
    "place",
    "setting",
    "place",
    [
      { label: "frozen lake", value: 0 },
      { label: "fjord", value: 1 },
    ],
    0,
    "Where the night is: on the black ice of a frozen lake (the Ice knobs), or on the bank of a fjord, still open water between snowy mountains that go straight down into it, a red cabin and its birches on the far shore (the fjord ice and wind ripples). The sky, the aurora, the cabin's light, the birds and the weather are the same over both.",
  ),
  range(
    "place",
    "ice",
    "fjord ice",
    0,
    "On the fjord: open still water, mirroring the whole sky, to the left; to the right the fjord freezes over, first in plates with dark leads between them, then wholly: dull dark ice, hairline cracks, snow lying in patches.",
  ),
  range(
    "place",
    "ripples",
    "wind ripples",
    0,
    "On the fjord: 0, a still fjord, a clear mirror of the sky. Higher lets the wind (under Weather) ruffle the open water: cat's-paws drift downwind and break the reflections into long vertical streaks. Ice stays still.",
  ),
  ...weatherKnobs({ auroraGroup: "aurora", aurora: true, on: { aurora: true } }),
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
    { trigger: LAKE_CORONA_TRIGGER, when: "drapes" },
  ),
  feature(
    "aurora",
    "substorm",
    "substorms",
    true,
    "frequency",
    0.4,
    "Every few minutes the quiet arc brightens for a while, then breaks up: the light surges, curtains spread overhead and ripple faster, and over a couple of minutes the sky calms again. Now: start one.",
    { trigger: 0 },
  ),
  range(
    "aurora",
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
    { trigger: 1 },
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
  seed(
    "ice",
    "iceSeed",
    "lake",
    "Where the cracks run, where the bubbles froze and how the snow lies; re-seed for another lake.",
  ),
  range(
    "night",
    "hour",
    "hour",
    0.75,
    "From the blue hour, the last light glowing low on the left, to the deep of the night.",
  ),
  feature(
    "sky",
    "moon",
    "moon",
    true,
    "phase",
    0.3,
    "A moon low over the mountains, on the right over the lake and on the left over the fjord, from a thin crescent to full: it lights the snow, draws a path of glints down the ice or the water and drowns the faintest stars.",
  ),
  range(
    "sky",
    "stars",
    "stars",
    0.7,
    "How many stars come out over the lake: none to the left, a dark northern sky to the right. The Milky Way fades with them.",
  ),
  ...skyComponentKnobs({
    milkyWay: { on: true },
    meteors: { trigger: LAKE_METEOR_TRIGGER },
    constellations: true,
  }),
  toggle(
    "night",
    "cabin",
    "cabin",
    true,
    "A cabin on the far shore, its window lit by the fire and its light drawn down the ice or the water toward you: a log cabin on the point across the lake, its smoke rising until it flattens under the cold air above; a small red one among birches across the fjord, its thread of smoke leaning with the wind.",
  ),
  ...birdKnobs({
    kind: "geese",
    help: "Birds crossing the night over the lake, geese by default, a skein migrating under the aurora: dark against the sky, mirrored in the black ice, behind the cabin and the trees on the point; few fly in snow.",
  }),
  ...weatherKnobs({ snow: true, fog: true, wind: true }),
  toggle(
    "manifold",
    "mark",
    "M",
    false,
    "On the lake a crack in the near ice draws the Manifold M and keeps a little of the aurora's green in it; it sings in a moment after you switch it on. On the fjord a curtain of the aurora folds itself into the M high in the sky, with the same vertical rays, breathing slowly. Now: the crack sings again.",
    { trigger: 2 },
  ),
];

/**
 * What the knobs compile in (SceneDef.featuresFor): the fjord only while it is the place, the slow
 * drapes only while they are on, so the default lake's program carries neither. Each keeps its
 * runtime test of its knob in the shader, so the all-features program draws every setting as its
 * own program does.
 */
export function lakeFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  return {
    LAKE_FJORD: (values["setting"] ?? 0) > 0 ? 1 : 0,
    LAKE_DRAPES: (values["drapes"] ?? 0) > 0 ? 1 : 0,
  };
}

export const lakeScene: SceneDef = {
  id: "lake",
  title: "Frozen lake",
  blurb:
    "Black ice under the aurora: bubbles frozen deep, cracks that sing, snow drifting across; or an open fjord under slow drapes.",
  accent: "#4cf08c",
  look: { color: "full", levels: 4 },
  passage: LAKE_PASSAGE,
  params,
  planets: { group: "sky", across: [-45, -22, 45], up: [2, 21, 38] },
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
            snow: 0,
            fog: 0,
          },
        },
      ],
    },
    aurora: {
      title: "Aurora",
      blurb:
        "The northern lights overhead and in the ice or the water: how bright, what colours, the shared arcs or the slow drapes with their corona, and the substorms that set them dancing.",
    },
    ice: {
      title: "Ice",
      blurb:
        "Black ice swept by the wind: its cracks and the singing of new ones, the bubbles frozen in it, the snow lying and drifting on it. Click the ice to knock on it; drag to sweep the snow away.",
    },
    night: {
      title: "Night",
      blurb:
        "The hour, from the last light of the blue hour to the deep of the night, and the cabin on the far shore.",
    },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "The night sky over the lake or the fjord: the moon's phase, the stars and the Milky Way, the odd shooting star, all mirrored in the ice or the water.",
    },
    birds: birdsGroup,
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "Snow falls from a closing sky, hiding the aurora and slowly burying the ice; mist settles on the lake or the fjord; the wind drives the drifting snow, ruffles the fjord's open water and leans the cabin's smoke.",
    },
    manifold: {
      title: "Manifold mark",
      blurb:
        "A landmark of its own: an M cracked into the near ice, or folded into a curtain of the aurora over the fjord.",
    },
  },
  glsl: lakeGlsl,
  entry: "sceneLake",
  sim: lakeSim(params),
  // The moon's and the window's paths down the ice and over the fjord: the water's glint
  // (waterGlint, its mirror tier); the ice's own mirror, bubbles and cracks are the scene's. The
  // fjord's open water: the breeze's cat's-paws breaking up its screen-space mirror and widening the
  // paths (windRipples, windMirror: the ripples tier, which the mirror tier includes).
  features: { WATER_TIER: WATER_TIERS.mirror },
  featuresFor: lakeFeatures,
  featuresAll: lakeFeatures({ setting: 1, drapes: 1 }),
};
