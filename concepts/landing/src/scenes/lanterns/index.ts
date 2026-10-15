// Tōrō nagashi: paper lanterns set on a river at dusk, drifting downstream past a temple on the far
// bank, their light trembling down the water. The lanterns float on an analytic current (stream,
// eddies along our bank, potential flow round two stones) in sim.ts; shader.ts traces each as a
// small glowing box, with its reflection in the rippled river, the far bank, the hills and the sky.
import { choice, counts, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { LANTERNS_METEOR_TRIGGER, LANTERNS_STARS, lanternsGlsl } from "./shader.ts";
import { LANTERN_COUNTS, PASSAGE_ENTER, PASSAGE_EXIT, lanternsSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("river", "lanterns", "lanterns", counts(...LANTERN_COUNTS), 24, "How many lanterns float on the river at once: a procession from small lights far out by the far bank, sweeping in past the near stone, and a second string drifting by close in front of you. As they drift away downstream, new ones come round the bend."),
  range("river", "current", "current", 0.3, "How fast the river runs: a slow drift that lets the lanterns gather and turn, or a steady stream that strings them out. It runs fast along the far side and slows in the shallows near you, so the procession closes up as it comes near."),
  feature("river", "flotilla", "flotillas", true, "frequency", 0.3, "Now and then a family sets a little group of lanterns on the water from this bank: big and close, they glide out together along the front and drift away downstream.", { trigger: 0 }),
  seed("river", "lanternSeed", "evening", "Where the lanterns float and how the eddies turn; re-seed for another evening on the river."),
  range("water", "ripple", "water ripple", 0.45, "Glassy calm to the left: the river is a mirror. To the right a breeze ruffles it and every reflection breaks into wavering bands."),
  range("water", "reflection", "reflection length", 0.55, "How far each lantern's light runs down the water toward you: a few glints under it, or long trails of trembling amber dashes."),
  range("water", "mist", "mist", 0.35, "Mist lying on the river: the far bank fades into it, and each lantern wears a halo."),
  ...skyKnobs({ time: 0.79, stars: LANTERNS_STARS, meteors: { trigger: LANTERNS_METEOR_TRIGGER } }),
  ...weatherKnobs({ rain: true, wind: true, aurora: true }),
  toggle("manifold", "mark", "M lantern", false, "One lantern of indigo paper with the Manifold M cut through it, glowing amber. Set on the water from this bank as it comes on, it keeps to the near water where the M reads, turns back to face you, and comes round again soon after it has drifted away. Now: set it on the water again.", { trigger: 1 }),
];

export const lanternsScene: SceneDef = {
  id: "lanterns",
  title: "Lantern river",
  blurb: "Paper lanterns drifting down a river at dusk, their light trembling on the water.",
  accent: "#ffa040",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    river: { title: "River", blurb: "The lanterns and the current carrying them. Click the water to set a lantern down; hold and drag to push the water along." },
    water: { title: "Water", blurb: "How the river's surface moves and mirrors the lights, and the mist lying on it." },
    sky: { title: atmosphereGroups.sky.title, blurb: "Time of day, whether the days pass, and the night over the temple: its stars, and the odd shooting star, seen again in the river." },
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain brings cloud down over the dusk, rings the whole river, glistens on the temple roofs and streaks amber only where it falls through the lantern light; in a downpour the far bank fades and candles gutter. Wind slants it, ruffles the river and leans on the lanterns. On a clear night the aurora hangs over the temple, trembling in the water." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: one lantern among the others, its indigo paper cut with the M." },
  },
  glsl: lanternsGlsl,
  entry: "sceneLanterns",
  // Arriving: the river opens at deep dusk and unlit, the dusk settles, the candles catch in a wave
  // from upstream and new lanterns come round the bend lit as they come in. Leaving: the flames
  // gutter out one by one and the river darkens.
  passage: { enter: PASSAGE_ENTER, exit: PASSAGE_EXIT },
  sim: lanternsSim(params),
  // A sunlit river is bright water and sky: the copy needs dark ink on it, from the time the sun is
  // about 12 degrees up until it sinks back there. With the day cycle running the light keeps
  // changing, so the page stays on the night theme. The shader follows the page (inkOf).
  theme: skyTheme(params),
  // The river: wind ripples carried by the current, tilting a mirror (rippleSpectrum, waterDrift,
  // waterMirror).
  features: { WATER_TIER: WATER_TIERS.flow },
};
