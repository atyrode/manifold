// Countryside: overlooking rolling hills from a vantage point, a patchwork of fields with a village
// in the middle distance and woods beyond, under the shared sky and weather. Rain and snow leave their
// mark through the renderer's weather state (uWeather): the land, the farm track and the roofs
// wetten while it rains and dry after, and the land turns white while it snows and thaws after.
import { choice, counts, feature, range, seed, toggle } from "../../params.ts";
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
  range("woodland", "woodland", "woodland cover", 0.5, "How much of the distant hills is wooded: zero clears every wood, 50% is the original valley, 100% spreads forest over most far slopes. Woods grow and shrink at their edges; trees, fields and the village stay in place. Never covers the near fields, village or chalk down.", { step: 0.01 }),
  range("woodland", "pines", "pine mix", 0.25, "The proportion of the distant woodland made of evergreen pines: zero is all broadleaf, 100% is pine woodland. Tapered crowns stay green through autumn; the ground and tree arrangement do not change. Field-edge trees remain broadleaf.", { step: 0.01 }),
  feature("village", "lights", "village lights", true, "windows lit", 0.7, "Windows light up one by one as dusk falls, and most go dark late at night."),
  feature("village", "smoke", "chimney smoke", true, "amount", 0.5, "Smoke curling up from the chimneys and leaning with the wind."),
  range("routes", "river", "river width", 0.5, "How broad the river winding down toward the near field runs. 50% is the original stream; lower narrows it to a brook and zero dries it up; higher widens it into a broad river with shingle at its edges and wider reed beds, and hedgerow trees in its way give way. Its course stays put.", { step: 0.01 }),
  range("routes", "tracks", "tracks", 0, "How much of the road network shows. Zero keeps only the farm track over the near field. Raising it brings in the track's way on to the village (up the river's west bank, over the saddle and along the street between the cottages), then from 20% the road along the valley and a farm track over a stone bridge, then from 40% a hill track and a chalk track up the far down. Each grows plainer toward 100%; hedges open and hedgerow trees give way where tracks pass.", { step: 0.01 }),
  feature("activity", "walkers", "walkers", false, "busy", 0.5, "People out walking the tracks, sized by their distance: from one party to six as it gets busier, more of them in twos and threes. Half the parties stop now and then to take in the view, and some carry lanterns after dark. With no extra tracks they come over the brow on the near farm track and turn back.", { step: 0.05 }),
  feature("activity", "carts", "carts", false, "carts", 2, "Horses and carts and tractors with trailers on the roads and tracks, easing up the steep slopes, lamps lit after dark. With no extra tracks they come over the brow on the near farm track to a field gate and turn back.", { options: counts(1, 2, 3) }),
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
    woodland: { title: "Woodland", blurb: "How much of the far hills is wooded, and how many of the trees are evergreen pines." },
    village: { title: "Village", blurb: "Signs of life: windows lighting up at dusk, smoke from the chimneys." },
    routes: { title: "River & tracks", blurb: "How broad the river runs, and how much of the network of tracks shows, from the farm track on to the village to the roads and tracks over the far hills." },
    activity: { title: "People & carts", blurb: "Walkers and carts going about the tracks; they stand still while motion is off." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A chalk figure of the M, cut into the turf of a far hillside." },
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  // Enter: the camera comes down from the sky and settles on the valley as the haze thins. Exit: it
  // drifts back up toward the clouds as the light goes grey.
  passage: { enter: 2.6, exit: 1.4 },
};
