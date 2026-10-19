// The engine's canvas (src/engine/README.md): one world in metres seen through a free camera, the
// objects of a document (EngineDoc) placed anywhere in it. Its knobs are the World's (its hour, its
// sky, its weather, its wind and gusts); the camera and the objects are the document's, which the
// page's engine view shows (src/engine/view.ts) and which its program's features follow
// (src/engine/program.ts). Lab-only: outside the tour and `[` / `]` (src/lab/gallery-model.ts).
// The World's birds and painted cumulus are left out: both are drawn on the screen of a level camera.
import { GUST_KNOBS, WIND_GROUP, WORLD_TRIGGERS } from "../../composer/compose.ts";
import { engineStage } from "../../engine/stage.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";

/** The World's knobs a free camera cannot show: they draw on a level camera's screen. */
const SCREEN_ONLY: Readonly<Record<string, true>> = {
  birds: true,
  birdKind: true,
  birdFormation: true,
  cumulus: true,
};

export const canvasScene: SceneDef = {
  id: "canvas",
  title: "Canvas",
  blurb:
    "The engine's canvas: one world in metres and a free camera, with objects placed anywhere in it.",
  accent: "#c8a24a",
  look: { color: "full", levels: 4 },
  strips: true,
  // The night sky's planets, where the land's hang them (src/scenes/meadow).
  planets: { group: "sky", across: [-84, -22, -8], up: [0, 14, 26] },
  params: [
    ...worldKnobs({
      time: 0.62,
      meteors: { trigger: WORLD_TRIGGERS.meteors },
      lightning: WORLD_TRIGGERS.lightning,
      birds: { kind: "rooks", help: "" },
      groups: { wind: "wind" },
    }).filter((def) => SCREEN_ONLY[def.key] !== true),
    ...GUST_KNOBS,
  ],
  groups: { sky: worldGroups.sky, weather: worldGroups.weather, wind: WIND_GROUP },
  featuresFor: (values) => ({ ...worldFeatures(values), ...engineStage.features }),
  featuresAllFor: () => ({
    ...WORLD_ALL,
    WORLD_BIRDS: 0,
    WORLD_CUMULUS: 0,
    ...engineStage.features,
  }),
  code: async () => {
    await engineStage.ready();
    return import("./code.ts");
  },
};
