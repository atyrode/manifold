// Skyward: lying on your back at a busy crossroads, looking up between the buildings. The facades
// rise and lean together toward a patch of sky; trams' wires, a signal gantry and a streetlamp cross
// it overhead, a plane draws its contrail across the clouds, pigeons wheel and swifts scream by, and
// the traffic below is felt only as light and shadow sliding over the lower floors. shader.ts draws
// everything analytically (no simulation).
import { feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { skywardGlsl } from "./shader.ts";

const params: readonly ParamDef[] = [
  range("city", "towers", "glass towers", 0.4, "The mix of the street: from old stone and brick houses with balconies and window boxes to glass towers that mirror the clouds, the opposite roofline and, now and then, the sun."),
  range("city", "windows", "lit windows", 0.4, "How many windows have a light on: a few by day, more as the evening comes in, the whole street by night."),
  range("city", "greenery", "greenery", 0.6, "Window boxes and trailing plants on the balconies, and the leafy edge of the street tree in the corner of the sky."),
  range("city", "traffic", "traffic", 0.5, "The road you cannot see: buses and cars sweeping their shadows, headlights and glints along the lower floors, and a tram now and then, its pantograph sparking on the wire."),
  seed("city", "citySeed", "street", "Which buildings stand where: re-seed for another street."),
  ...skyKnobs({ time: 0.58, stars: 0.3 }),
  range("air", "birds", "birds", 0.5, "A flock of pigeons wheeling over the street and a few swifts higher up, by day and in the golden hour."),
  feature("air", "planes", "airliners", true, "frequency", 0.4, "Planes crossing the strip of sky far overhead, a contrail growing behind each, spreading and fading over a minute or two."),
  ...weatherKnobs({ clouds: 0.35, rain: true, snow: true, fog: true, wind: true }),
  toggle("manifold", "mark", "banner M", false, "A cloth banner strung across the crossroads on four cables, the Manifold M painted on it in the accent colour, lit from within at night."),
];

export const skywardScene: SceneDef = {
  id: "skyward",
  title: "Skyward",
  blurb: "Lying on your back at a crossroads: the buildings lean in, wires cross a strip of sky, pigeons wheel and a plane draws a line.",
  accent: "#ff8a4a",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    city: { title: "City", blurb: "The buildings round the crossroads, their windows and balconies, and the traffic that passes below." },
    sky: atmosphereGroups.sky,
    air: { title: "In the air", blurb: "Who is up there with you." },
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain comes down out of the strip of sky straight at you, streaks the glass and darkens the stone; snow drifts down, and settles on the ledges." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the banner over the crossroads." },
  },
  glsl: skywardGlsl,
  entry: "sceneSkyward",
  // A sunlit sky puts the page in its paper theme (ink dark on light); pagePaper() follows it.
  theme: skyTheme(params, { from: 0.33, to: 0.67, rainBelow: 0.2 }),
};
