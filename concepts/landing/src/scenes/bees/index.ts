// Bees on the hillside: a painted summer landscape, eye level and warm, with the insects as tiny
// moving specks you know by their motion. A variant of the `outdoor` composer's baseline
// (src/composer, README "The outdoor composer"), the baseline's downs off: the hillside behind
// (cumulus towers over hazy hills, a farmhouse, a windmill), the lawn, the apiary (an old orchard
// behind a dry-stone wall, a path and three pastel hives in a garden of lavender rows, poppies,
// daisies and foxgloves) and its insects (layers.ts), through the garden's rig. Up to two hundred
// bees work the hives (sim.ts, colony.ts): foragers beeline to a flower drift, hop from flower to
// flower and fly home loaded with pollen, a few of the heaviest laden pollen-drunk; a crowd mills at
// each entrance and young bees fly orientation loops before it; now and then a swarm pours out of a
// hive, mills over the garden and hangs in an apple tree before it leaves. Butterflies, bumblebees,
// hoverflies and dragonflies work the flowers by day, and glow-worms light up in the grass after
// dusk; everyone keeps the World's hours and shelters from its rain, lit by its light and seen
// through its air. While the cast's agents are about they garden (the gardening chore): they dig
// beds in the lawn and sow them, the flowers come up over a minute or two, the bees follow them,
// and the weeds creep back.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { BEES_GRADE, BEES_RIG } from "./constants.ts";
import { BEES_PASSAGE } from "./layout.ts";

/** The bees over the outdoor's baseline: the garden's land and rig, its warm light, its moon. */
export const beesVariant: Variant = {
  id: "bees",
  base: "outdoor",
  title: "Bees",
  blurb:
    "A summer hillside at an orchard's edge: bees and butterflies at work among the hives and flowers.",
  // The gold of afternoon light, and of pollen.
  accent: "#f2b632",
  look: { color: "full", levels: 4 },
  // The cumulus drift into place, the bees pour out of the hives and fan out to the flowers,
  // butterflies flutter in from the edges and the near stalks and grass spring up; leaving, the bees
  // stream home and the butterflies flutter off.
  passage: BEES_PASSAGE,
  planets: { group: "sky", across: [-55, -34, 20], up: [3, 18, 26] },
  // A bright afternoon is a light page: dark copy from morning to evening on a still clock, unless
  // steady rain greys it.
  theme: (params) => skyTheme(params, { from: 0.31, to: 0.74, rainBelow: 0.3 }),
  layers: { remove: ["downs"], add: ["hillside", "lawn", "apiary", "insects", "gardening"] },
  camera: BEES_RIG,
  grade: BEES_GRADE,
  // A summer afternoon under fair-weather cloud, the painted cumulus towers standing over the hills,
  // swallows by day.
  world: {
    time: 0.64,
    cumulus: { on: true },
    birds: {
      kind: "swallows",
      help: "Swallows hawking over the valley by day, now and then swooping down to skim the flowers; the orchard, the wall, the hives and the near flowers hide any that pass behind them, and few fly in rain or snow.",
    },
  },
  // Shooting stars set out over the hills among the cumulus.
  meteors: [-0.5, 0.32, 1, 0.1],
  flyway: {
    depth: [8, 150],
    above: 0.03,
    top: 0.92,
    seed: 3.7,
    skim: 1.2,
    spread: 1.5,
    ext: 0.002,
  },
  // The moon keys the night's light and the orchard's shadows by its direction: its phase code is
  // compiled in at every setting, a full moon's too (where the World leaves it out), so a full moon's
  // own program draws byte for byte as the all-features one does.
  features: { SKY_MOON_PHASE: 1 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the valley: its stars and the Milky Way, the moon's phase (its light on the land once the sun has set), its planets, the odd shooting star and the aurora over the hills.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "The cumulus towers over the hills in front of the cloud, and their shadows drifting over the land; rain, snow, fog and lightning. Rain greys the sky, sinks the towers into it and wets the garden, which darkens and glistens; snow settles on the lawn, the hills, the wall, the hives and the trees.",
    },
  },
};

/** The bees composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const beesComposed = composeScene(outdoor, variantPreset(outdoor.baseline, beesVariant));

export const beesScene: SceneDef = { ...beesComposed.def, code: () => import("./code.ts") };
