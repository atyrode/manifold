// Countryside: overlooking rolling hills from a vantage point, a patchwork of fields with a village
// in the middle distance and woods beyond, under the shared sky and weather. Rain and snow leave their
// mark through the renderer's weather state (uWeather): the land, the farm track and the roofs
// wetten while it rains and dry after, and the land turns white while it snows and thaws after.
import { choice, feature, range, toggle } from "../../params.ts";
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
    "Summer: green wheat and yellow rapeseed. Harvest: golden wheat, stubble and bales. Autumn: ploughed earth and the trees on the turn.",
  ),
  feature("village", "lights", "village lights", true, "windows lit", 0.7, "Windows light up one by one as dusk falls, and most go dark late at night."),
  feature("village", "smoke", "chimney smoke", true, "amount", 0.5, "Smoke curling up from the chimneys and leaning with the wind."),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, lightning: 0 }),
  toggle("manifold", "chalk", "chalk M", false, "A giant M cut into the turf of a far hillside, in the manner of the Uffington White Horse."),
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
    fields: { title: "Fields", blurb: "The patchwork through the farming year." },
    village: { title: "Village", blurb: "Signs of life: windows lighting up at dusk, smoke from the chimneys." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A chalk figure of the M, cut into the turf of a far hillside." },
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  // Enter: the camera comes down from the sky and settles on the valley as the haze thins. Exit: it
  // drifts back up toward the clouds as the light goes grey.
  passage: { enter: 4.2, exit: 2.0 },
};
