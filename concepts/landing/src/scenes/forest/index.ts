// An ancient misty forest of cedar and beech: huge mossy trunks in depth, a great cedar with its rope
// and paper streamers gripping a boulder with its roots, a stream winding out of the mist under a torii
// half swallowed by moss, a fallen log, stepping stones, ferns, shafts of light in the mist; and the
// mystical layer, strongest at dusk and night: small pale forest spirits (kodama) appearing on the
// roots, stones and branches, rattling their heads round and fading, glowing mushrooms, drifting
// spores, and now and then a great stag crossing far off between the trunks. A preset of the
// `outdoor` composer (src/composer, README "Composers"): the misty woods behind (the mist, the canopy,
// the far trunks, the shafts), the forest floor and its stream, the shrine (the torii, the log, the
// beech, the boulders, the great cedar, the mushrooms, the M), the ferns and the kodama (layers.ts).
// The sky in the canopy's gaps, the weather and the birds are the World's.
// Passage: the camera glides in between the trunks, braking, and settles, then the spirits pop up
// one by one on their perches; on the way out they turn their heads and vanish one by one while the
// camera drifts back into the mist, gathering speed (FOREST_RIG's dolly, FOREST_PASSAGE).
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { FOREST_GRADE, FOREST_PASSAGE, FOREST_RIG } from "./constants.ts";

const preset: ScenePreset = {
  id: "forest",
  composer: "outdoor",
  title: "Mystic forest",
  blurb: "An ancient misty cedar forest, where small spirits appear on the mossy roots.",
  accent: "#bff5cf",
  look: { color: "full", levels: 4 },
  passage: FOREST_PASSAGE,
  // The World's planets hang in the canopy's gaps: high in the frame (its lens is a radian tall, the
  // gaps open from about 27 degrees up to its top edge's 35), over the shafts' middle gap first.
  planets: { group: "sky", across: [-35, 4, 35], up: [27, 32, 35] },
  rig: FOREST_RIG,
  grade: FOREST_GRADE,
  // Dusk turning to night, the stars in the canopy's gaps; no cloud of its own and no Milky Way over
  // the gaps; birds to switch on.
  world: {
    time: 0.82,
    stars: 0.5,
    clouds: 0,
    milkyWay: { on: false },
    birds: {
      kind: "pigeons",
      on: false,
      help: "Birds crossing the gaps in the canopy by day, wood pigeons by default; the leaves and the trunks hide them, and few fly in rain or snow.",
    },
  },
  // Shooting stars set out in the band of gaps across the top of the frame (the gaps' own lens).
  meteors: [-0.6, 0.45, 1.2, 0.12],
  // Birds crossing beyond the canopy's underside (20 m), seen only in its gaps, hazed by the mist.
  flyway: {
    depth: [22, 60],
    above: 0.42,
    top: 1,
    seed: 4.1,
    skim: 6,
    spread: 1.5,
    ext: 0.05,
  },
  floor: "moss",
  layers: ["woods", "forestFloor", "shrine", "undergrowth", "kodama"],
  // No gusts under the canopy until switched on.
  values: { gusts: 0 },
  // The moon takes a phase (K_moon) in the gaps and in its shafts at night, compiled in at every
  // setting, a full moon's too, as the forest always drew it.
  features: { SKY_MOON_PHASE: 1 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky in the canopy's gaps: its stars, the moon's phase in the gaps and in its shafts, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain closes the sky and greys the mist; the canopy shelters the forest from rain and snow but lets some through. The beards of lichen, the torii and the canopy gather water and drip long after; roots and stones go dark and glossy, pools gather on the floor, rings spread on the stream and drops burst on the stones. Fog thickens the distance; the wind slants the rain and sets the mist and the spores drifting.",
    },
  },
};

/** The forest composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const forestComposed = composeScene(outdoor, preset);

export const forestScene: SceneDef = { ...forestComposed.def, code: () => import("./code.ts") };
