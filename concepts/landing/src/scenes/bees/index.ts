// Bees on the hillside: a painted summer landscape, eye level and warm, with the insects as tiny
// moving specks you know by their motion. Cumulus towers over hazy hills (a farmhouse, a windmill),
// an old orchard behind a dry-stone wall, a path and three pastel hives in a garden of lavender
// rows, poppies, daisies and foxgloves, the wind running through the grass and the shadows of clouds
// drifting over it all. Up to two hundred bees work the hives (sim.ts, colony.ts): foragers beeline
// to a flower drift, hop from flower to flower and fly home loaded with pollen, a few of the heaviest
// laden pollen-drunk, looping and bumping their way home; a crowd mills at each entrance and young
// bees fly orientation loops before it; now and then a swarm pours out of a hive, mills over the
// garden and hangs in an apple tree before it leaves. Butterflies, bumblebees, hoverflies and
// dragonflies work the flowers by day, and glow-worms light up in the grass after dusk; everyone
// keeps the world's hours and shelters from its rain, lit by its light and seen through its air.
import { counts, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";
import { BEES_PASSAGE, BEES_LUSH_FROM } from "./layout.ts";
import { BEES_LIGHTNING_TRIGGER, BEES_METEOR_TRIGGER, beesGlsl } from "./shader.ts";
import { BEES_SWARM_TRIGGER, beesSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  feature(
    "life",
    "bees",
    "bees",
    true,
    "colony",
    48,
    "How many bees are about, each flying in the garden's space at its real size (a speck of a cell at the hives, a little bigger close to you): foragers leave the hives for the flowers in a nearly straight line, now and then passing close by, hop from flower to flower, and fly home loaded with pollen; some mill at the entrances, and young bees fly orientation loops in front of their hive. They go home at dusk and stay in through the night, and in rain or snow.",
    // 32 and 64 stay offered: links made when they were the colony's sizes keep their bees.
    { options: counts(16, 32, 48, 64, 96, 200) },
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
    { trigger: BEES_SWARM_TRIGGER, icon: "bee" },
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
  seed(
    "scenery",
    "scenerySeed",
    "landscape",
    "The shape of the hills and their fields, the clouds, and the flowers in the drifts; re-seed for another view of the valley.",
  ),
  // The shared world: a summer afternoon under fair-weather cloud, the painted cumulus towers standing
  // over the hills (their size the cumulus amount, which bees' old cloud cover set), swallows by day.
  ...worldKnobs({
    time: 0.64,
    cumulus: { on: true },
    meteors: { trigger: BEES_METEOR_TRIGGER },
    lightning: BEES_LIGHTNING_TRIGGER,
    birds: {
      kind: "swallows",
      help: "Swallows hawking over the valley by day, now and then swooping down to skim the flowers; the orchard, the wall, the hives and the near flowers hide any that pass behind them, and few fly in rain or snow.",
    },
  }),
  // The garden: how thickly its drifts bloom, a lantern among the hives and fairy lights along the
  // wall, both lit after dusk.
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
    {},
  ),
];

export const beesScene: SceneDef = {
  id: "bees",
  title: "Bees",
  blurb:
    "A summer hillside at an orchard's edge: bees and butterflies at work among the hives and flowers.",
  // The gold of afternoon light, and of pollen.
  accent: "#f2b632",
  look: { color: "full", levels: 4 },
  params,
  planets: { group: "sky", across: [-55, -34, 20], up: [3, 18, 26] },
  groups: {
    life: {
      title: "Bees & insects",
      blurb:
        "A colony working three hives, a few of its foragers pollen-drunk, swarming now and then; butterflies, bumblebees, hoverflies and dragonflies by day, glow-worms in the grass after dusk (fireflies too, if you like).",
    },
    scenery: { title: "Landscape", blurb: "Which valley you are looking over." },
    garden: {
      title: "Garden",
      blurb:
        "How thickly the flowers bloom, and the lights for the evening: a lantern among the hives and fairy lights along the wall.",
    },
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the valley: its stars and the Milky Way, the moon's phase (its light on the land once the sun has set), its planets, the odd shooting star and the aurora over the hills.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "The cumulus towers over the hills in front of the cloud, and their shadows drifting over the land; rain, snow, fog, the wind through the grass, and lightning. Rain greys the sky, sinks the towers into it and wets the garden, which darkens and glistens; snow settles on the lawn, the hills, the wall, the hives and the trees.",
    },
    birds: worldGroups.birds,
    manifold: { title: "Manifold mark", blurb: "The M, painted on a hive." },
  },
  glsl: beesGlsl,
  entry: "sceneBees",
  sim: beesSim(params),
  // The cumulus drift into place, the bees pour out of the hives and fan out to the flowers, butterflies
  // flutter in from the edges and the near stalks and grass spring up; leaving, the bees stream home and
  // the butterflies flutter off.
  passage: BEES_PASSAGE,
  // A bright afternoon is a light page: dark copy from morning to evening on a still clock, unless
  // steady rain greys it.
  theme: skyTheme(params, { from: 0.31, to: 0.74, rainBelow: 0.3 }),
  // The moon keys the night's light and the orchard's shadows by its direction: its phase code is
  // compiled in at every setting, a full moon's too (where the world leaves it out), so a full moon's
  // own program draws byte for byte as the all-features one does. The world's parts only while their
  // knobs can show them (worldFeatures), and the garden's: the lantern and the fairy lights while on,
  // the drifts' density while the flowers are other than 1, the extra near blooms and foxgloves once
  // they can stand (BEES_LUSH_FROM).
  features: { SKY_MOON_PHASE: 1 },
  featuresFor: (values) => ({
    ...worldFeatures(values),
    BEES_LANTERN: (values.lantern ?? 0) > 0 ? 1 : 0,
    BEES_FAIRY: (values.fairyLights ?? 0) > 0 ? 1 : 0,
    BEES_FLOWERS: (values.flowers ?? 1) !== 1 ? 1 : 0,
    BEES_LUSH: (values.flowers ?? 1) >= BEES_LUSH_FROM ? 1 : 0,
  }),
  featuresAll: { ...WORLD_ALL, BEES_LANTERN: 1, BEES_FAIRY: 1, BEES_FLOWERS: 1, BEES_LUSH: 1 },
};
