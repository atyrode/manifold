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
  range("village", "village", "cottages", 11, "How many cottages the village has around its church: 11 is the original village. Fewer leave the ones nearest the church; more fill, in this order, a lane up the knoll beside the church, a lane down toward the river and the ends of the street, so no cottage moves as it grows. Lit windows and chimney smoke come with them.", { min: 2, max: 26, step: 1 }),
  choice("settlements", "hamlets", "hamlets", counts(0, 1, 2, 3), 0, "Small clusters of three to six cottages, some with a chapel, on the far hills: each in its own third of the view, on open, gently sloping ground clear of the woods and in sight over the nearer hills (a third with no such ground has none). Their windows light up at dusk."),
  toggle("settlements", "castle", "castle", false, "A castle on the top of the chalk down, the prominent far hill right of the middle, against the sky: battlemented curtain walls, round towers, a gatehouse and a keep, a few windows lit after dark. The woods clear from the hilltop around it."),
  range("settlements", "farms", "farmsteads", 0, "Outlying farms among the fields of the nearer hills: a farmhouse, most with a barn, or a lone house, each at the edge of its field, clear of the woods, the river and the village, some with smoke and lit windows. Zero has none; more adds farms without moving the others."),
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
    village: { title: "Village", blurb: "How big the village is, and its signs of life: windows lighting up at dusk, smoke from the chimneys." },
    settlements: { title: "Settlements", blurb: "Beyond the village: hamlets on the far hills, a castle on a hilltop, farms among the fields." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A chalk figure of the M, cut into the turf of a far hillside." },
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  // Enter: the camera comes down from the sky and settles on the valley as the haze thins. Exit: it
  // drifts back up toward the clouds as the light goes grey.
  passage: { enter: 2.6, exit: 1.4 },
};
