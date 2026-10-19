// A waterfall seen level from the edge of its plunge pool: a cliff of basalt flows and rusty ash
// beds (or sandstone ledges, or a pale limestone slot) with fallen blocks heaped at its foot, the
// fall pouring from a notch in the lip, spray rising from the plunge with a rainbow in it, ferns on
// the ledges and fireflies over the water at dusk. A variant of the `outdoor` composer's baseline
// (src/composer, README "The outdoor composer"): the cliff behind for the baseline's downs (the
// gorge's rock, its rim and the sky over it), the pool, the falls, the spray and the greenery
// (layers.ts); the near bank's ferns are rooted plants of the shared plant component (sim.ts) that
// sway in the composer's one wind and turn with the year. The sky, the weather and the birds are the
// World's, the sky seen half turned (FALLS_RIG).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { FALLS_PASSAGE, FALLS_RIG } from "./constants.ts";

/** The waterfall over the outdoor's baseline: its cliff, pool and fall, its turned lens, its noon. */
export const fallsVariant: Variant = {
  id: "falls",
  base: "outdoor",
  title: "Waterfall",
  blurb: "A waterfall pouring into its pool: spray, a rainbow, ferns on the wet rock.",
  accent: "#7fdce6",
  // Designed in full colour; in two-tone mode the spray carries the accent.
  look: { color: "full", levels: 4 },
  // The camera starts up at the lip and tilts down the fall to the pool as the ferns spring up on
  // the bank and the spray rises, the rainbow forming in it; on the way out it tilts back up the
  // fall into a surge of spray (FALLS_RIG's passage).
  passage: FALLS_PASSAGE,
  // In the sky's frame, which the view faces half turned from (straight ahead is 180): the strip over
  // the rim, 40 degrees to either side, from the treetops (about 21 degrees up at the frame's sides,
  // 27 in its middle) to the frame's top (32).
  planets: { group: "sky", across: [140, 166, 220], up: [20, 29, 33] },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the gorge: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud over the strip of sky above the rim, and the weather: rain hanging in shafts over the skyline and falling between you and the cliff, soaking the rock, running off the ledges and dripping from the ferns, ringing the pool; snow, fog and lightning.",
    },
  },
  layers: { remove: ["downs"], add: ["cliff", "pool", "falls", "spray", "greenery"] },
  camera: FALLS_RIG,
  // The gorge keeps its own light (shader.ts fallsBegin: the eye adapting to the dark); the grade
  // only inks it.
  grade: { ink: { gain: 1.15, gamma: 1 } },
  // Water below the waterline wherever the pool is switched off.
  floor: "water",
  // Just past noon under broken cloud, no Milky Way over the narrow strip of sky; swifts by day once
  // switched on.
  world: {
    time: 0.55,
    stars: 0.45,
    clouds: 0.3,
    milkyWay: { on: false },
    birds: {
      kind: "swifts",
      on: false,
      often: 0.5,
      help: "Birds crossing the gorge by day, swifts by default, sailing past the cliff and now and then swooping low over the pool; the rock, the trees on the rim and the spray hide them, and few fly in the rain.",
    },
  },
  // Shooting stars set out in the band of sky over the rim and fall behind it.
  meteors: [-0.6, 0.5, 1.2, 0.05],
  // Swifts crossing between 8 and 45 m, from just over the eye's level to the frame's top, drawn
  // twice life size, hazed as the baseline's; a swooping party skims the pool half a metre over the
  // eye.
  flyway: { depth: [8, 45], above: 0.08, top: 1, seed: 11.9, skim: 2.5, spread: 2 },
  // No gusts of their own across the gorge until switched on; the swifts' flights on the arrangement
  // the gorge always flew (K_seed 10: its birds' seed, 3.7).
  values: { gusts: 0, seed: 10 },
  // The moon's phase code is compiled in at every setting, a full moon's too (where the World leaves
  // it out), as the gorge always drew it.
  features: { SKY_MOON_PHASE: 1 },
};

/** The waterfall composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const fallsComposed = composeScene(outdoor, variantPreset(outdoor.baseline, fallsVariant));

export const fallsScene: SceneDef = { ...fallsComposed.def, code: () => import("./code.ts") };
