// A scramble crossing at dusk, seen from a high window: people gather at the kerbs, the lights
// turn, and everyone crosses at once, every way, while cars queue at the red and flow on the green
// under the shop signs. A preset of the `outdoor` composer (src/composer, README "Composers"), through
// the street's own rig, pitched down from the window: the city round the crossing, the crossing
// itself, what stands at its kerbs, and the street's life (layers.ts). The sky and the weather are
// the World's; the passage tilts the window up to the skyline and down again.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import {
  STREET_FLYWAY,
  STREET_GRADE,
  STREET_METEORS,
  STREET_PASSAGE,
  STREET_RIG,
} from "./constants.ts";

const preset: ScenePreset = {
  id: "street",
  composer: "outdoor",
  title: "City crossing",
  blurb:
    "A scramble crossing at dusk from a high window: the crowd gathers, the lights turn, everyone crosses at once.",
  accent: "#2fe0b0",
  look: { color: "full", levels: 4 },
  // Entrance: the camera comes down from the skyline onto the crossing as the crowd walks in along its
  // sidewalks to gather. Exit: the camera tilts up to the skyline again (the rain follows the pitch).
  passage: STREET_PASSAGE,
  // Low over the skyline the passage tilts up to: the window, pitched down at rest, never shows them.
  planets: { group: "sky", across: [-28, 12, 28], up: [1, 3, 7] },
  // A sunlit street is bright paving and paint: the copy needs dark ink on it, from the time the
  // sun is about 12 degrees up until it sinks back there. With the day cycle running the light keeps
  // changing, so the page stays on the night theme. The shader follows the page (inkOf).
  theme: skyTheme,
  rig: STREET_RIG,
  grade: STREET_GRADE,
  // Dusk turning to night, the stars a city's few and a full moon, mirrored in the windows and the
  // wet street; no cloud deck, no Milky Way over the city's glow; the World's birds, which the window
  // pitched down never sees, off.
  world: {
    time: 0.81,
    stars: 0.55,
    clouds: 0,
    milkyWay: { on: false },
    birds: {
      kind: "pigeons",
      on: false,
      help: "Birds crossing the sky over the skyline by day, which the window pitched down onto the crossing sees only as the view rises to the roofs on the way in and out.",
    },
  },
  meteors: STREET_METEORS,
  flyway: STREET_FLYWAY,
  floor: "asphalt",
  layers: ["city", "crossing", "kerbside", "streetLife"],
  // The composer's gusts move nothing in the street.
  values: { gusts: 0 },
  // The moon takes a phase (K_moon) at every setting, a full moon's too: the windows and the wet
  // street mirror it.
  features: { SKY_MOON_PHASE: 1 },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night over the city: its few stars and the moon's phase, mirrored in the windows and the wet street; over the skyline, as the view rises to it, the World's sky.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain opens the umbrellas one by one and turns the street into a mirror of signs, windows and lamps, streaked toward you; puddles ring, tyres throw spray, awnings drip. Snow settles everywhere but the wheel tracks and the trodden crosswalks. Seen from the window, the drops and the flakes stream toward a point below the street.",
    },
  },
};

/** The city crossing composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const streetComposed = composeScene(outdoor, preset);

export const streetScene: SceneDef = { ...streetComposed.def, code: () => import("./code.ts") };
