// Countryside: overlooking rolling hills from a vantage point, a patchwork of fields with a village
// in the middle distance and woods beyond, under the shared sky and weather. Rain and snow leave their
// mark through the renderer's weather state (uWeather): the land, the farm track and the roofs
// wetten while it rains and dry after, and the land turns white while it snows and thaws after.
import { choice, feature, range, seed, toggle } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { countryGlsl } from "./shader.ts";

const params = [
  ...skyKnobs({ time: 0.7 }),
  range("clouds", "clouds", "cloud cover", 0.4, "How much of the sky the cloud deck covers; rain and snow thicken it."),
  feature("clouds", "shadows", "cloud shadows", true, "darkness", 0.6, "Shadows of the clouds sweeping across the fields and hills."),
  choice(
    "fields", "season", "season",
    [{ label: "summer", value: 0 }, { label: "harvest", value: 1 }, { label: "autumn", value: 2 }],
    1,
    "The farming year, separate from field weights. Summer: green wheat and yellow rapeseed. Harvest: golden wheat, stubble and bales. Autumn: ploughed earth and broadleaf trees on the turn; pines remain evergreen.",
  ),
  range("woodland", "pines", "pine mix", 0.25, "The proportion of the distant woodland made of evergreen pines: zero is all broadleaf, 100% is pine woodland. Tapered crowns stay green through autumn; the ground and tree arrangement do not change. Field-edge trees remain broadleaf.", { step: 0.01 }),
  feature("village", "lights", "village lights", true, "windows lit", 0.7, "Windows light up one by one as dusk falls, and most go dark late at night."),
  feature("village", "smoke", "chimney smoke", true, "amount", 0.5, "Smoke curling up from the chimneys and leaning with the wind."),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, lightning: 0 }),
  toggle("manifold", "chalk", "chalk M", false, "A giant M cut into the turf of a far hillside, in the manner of the Uffington White Horse."),
  range("fields", "crops", "crops weight", 100, "Relative weight of the original seasonal crops. Weights are normalized together: 2 crops and 1 wildflowers gives about two crop fields for each flower field. Zero excludes a type; all zero restores crops.", { max: 100, step: 1 }),
  range("fields", "wildflowers", "wildflowers weight", 0, "Relative weight of colourful meadow fields among all fields; zero excludes them.", { max: 100, step: 1 }),
  range("fields", "lavender", "lavender weight", 0, "Relative weight of purple lavender-row fields among all fields; zero excludes them.", { max: 100, step: 1 }),
  range("fields", "sunflowers", "sunflowers weight", 0, "Relative weight of golden sunflower fields among all fields; zero excludes them.", { max: 100, step: 1 }),
  seed("fields", "landscape", "landscape", "The arrangement of the hills, fields and village; the same number always returns to the same valley. Zero keeps the original countryside. Re-seed for another view."),
];

export const countryScene: SceneDef = {
  id: "country",
  title: "Countryside",
  blurb: "Rolling hills and patchwork fields, a village with its church in the valley.",
  // Lamplight in the village windows.
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sky: atmosphereGroups.sky,
    clouds: { title: "Clouds", blurb: "How much cloud drifts over, and the shadows it sweeps across the fields." },
    fields: { title: "Fields", blurb: "Mix crops and flowers with relative weights, follow the farming year, and re-seed the valley. Zero excludes a type; all zero uses crops. Shares are approximate across the visible fields, not exact screen-area percentages." },
    woodland: { title: "Woodland", blurb: "Mix rounded broadleaf crowns with pointed evergreen pines on the distant hills." },
    village: { title: "Village", blurb: "Signs of life: windows lighting up at dusk, smoke from the chimneys." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A chalk figure of the M, cut into the turf of a far hillside." },
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  // Enter: the camera comes down from the sky and settles on the valley as the haze thins. Exit: it
  // drifts back up toward the clouds as the light goes grey.
  passage: { enter: 2.6, exit: 1.4 },
};
