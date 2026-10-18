// Tōrō nagashi: paper lanterns set on a river at dusk, drifting downstream past a temple on the far
// bank, their light trembling down the water. A preset of the `outdoor` composer (src/composer,
// README "Composers"): the temple grounds behind (layers.ts), the river and its two stones, and the
// lanterns floating on an analytic current (stream, eddies along our bank, potential flow round the
// stones) in sim.ts; shader.ts traces each as a small glowing box, with its reflection in the
// rippled river, the far bank, the hills and the sky. The sky, the weather and the birds are the
// World's.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { LANTERNS_GRADE, LANTERNS_RIG, PASSAGE_ENTER, PASSAGE_EXIT } from "./constants.ts";

const preset: ScenePreset = {
  id: "lanterns",
  composer: "outdoor",
  title: "Lantern river",
  blurb: "Paper lanterns drifting down a river at dusk, their light trembling on the water.",
  accent: "#ffa040",
  look: { color: "full", levels: 4 },
  // Arriving: the river opens at deep dusk and unlit, the dusk settles, the candles catch in a wave
  // from upstream and new lanterns come round the bend lit as they come in. Leaving: the flames
  // gutter out one by one and the river darkens.
  passage: { enter: PASSAGE_ENTER, exit: PASSAGE_EXIT },
  // In the sky's frame, which the view faces 20 degrees left of: the stretch over the far bank.
  planets: { group: "sky", across: [-43, -8, 3], up: [2, 8, 13] },
  // A sunlit river is bright water and sky: the copy needs dark ink on it, from the time the sun is
  // about 12 degrees up until it sinks back there. With the day cycle running the light keeps
  // changing, so the page stays on the night theme. The shader follows the page (inkOf).
  theme: skyTheme,
  rig: LANTERNS_RIG,
  grade: LANTERNS_GRADE,
  // Dusk, the full moon rising out of the frame on the right; no fair-weather cloud and no Milky Way
  // (the river's dusk sky had neither); geese over the far bank, off until switched on.
  world: {
    time: 0.79,
    stars: 0.55,
    clouds: 0,
    milkyWay: { on: false },
    birds: {
      kind: "geese",
      on: false,
      often: 0.5,
      help: "Birds crossing the evening sky above the far bank, geese by default, a skein against the afterglow and its image in the river; by day and into the dusk, few in the rain.",
    },
  },
  // Shooting stars set out high over the far bank.
  meteors: [-0.3, 0.15, 0.6, 0.04],
  // The skein crosses 40 to 125 m out, nearer than the far bank, high over it; geese never swoop.
  flyway: {
    depth: [40, 125],
    above: 0.06,
    top: 0.98,
    seed: 2.9,
    skim: 1e9,
    spread: 1,
    ext: 0.002,
  },
  floor: "water",
  layers: ["temple", "river", "lanterns"],
  values: {},
  // The river: wind ripples carried by the current, tilting a mirror (rippleSpectrum, waterDrift,
  // waterMirror).
  features: { WATER_TIER: WATER_TIERS.flow },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night over the temple: its stars, the odd shooting star and on a clear night the aurora, all seen again in the river.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain brings cloud down over the dusk, rings the whole river, glistens on the temple roofs and streaks amber where it falls through the lantern light; in a downpour the far bank fades and candles gutter. Wind slants it and ruffles the river; snow, fog and lightning are the World's too.",
    },
  },
};

/** The lantern river composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const lanternsComposed = composeScene(outdoor, preset);

export const lanternsScene: SceneDef = { ...lanternsComposed.def, code: () => import("./code.ts") };
