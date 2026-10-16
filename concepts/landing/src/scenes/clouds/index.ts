// Above the clouds: the view from an airliner window at cruise altitude, time of day as the dial.
import { feature, knobValue, range, toggle, type ParamDef } from "../../params.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { CLOUDS_PASSAGE, cloudsGlsl } from "./shader.ts";

const params: ParamDef[] = [
  ...skyKnobs({ time: 0.72, stars: 0.75, constellations: true, planets: true }),
  range(
    "clouds",
    "cover",
    "cloud cover",
    0.75,
    "How much of the sea below is cloud: lower opens gaps down to the ocean, higher is an unbroken white floor.",
  ),
  range(
    "clouds",
    "altitude",
    "height above",
    0.5,
    "How far above the cloud tops the plane flies: low skims over big billows, high looks down on a fine-grained sea.",
  ),
  range(
    "clouds",
    "drift",
    "drift speed",
    0.35,
    "How fast the cloud sea slides past below as the plane flies on.",
  ),
  feature(
    "clouds",
    "thunderheads",
    "thunderheads",
    true,
    "size",
    0.5,
    "Cumulonimbus on the horizon: cauliflower towers climbing out of dark rain into flat anvils the high winds fray downwind. With lightning on they darken into storm cells.",
  ),
  toggle(
    "seat",
    "window",
    "window",
    true,
    "Frame the view in the cabin's porthole: moulded bevel, scuffed pane, the dim cabin around it.",
  ),
  toggle(
    "seat",
    "wing",
    "wing",
    true,
    "The wingtip and its winglet in the airline's paint, reaching in from the lower corner: red navigation light blinking, white strobe flashing twice.",
  ),
  feature(
    "seat",
    "contrail",
    "passing plane",
    true,
    "frequency",
    0.3,
    "Now and then a distant plane crosses the sky, its contrail forming behind it, spreading and drifting away.",
    { trigger: 1 },
  ),
  ...weatherKnobs({ lightning: 0, aurora: true, wind: true }),
  toggle(
    "manifold",
    "livery",
    "M on the winglet",
    false,
    "The Manifold M painted on the winglet, lit by the sun or caught by the strobe.",
    { when: "wing" },
  ),
];

export const cloudsScene: SceneDef = {
  id: "clouds",
  title: "Above the clouds",
  blurb: "A window seat at cruise altitude: a sea of cloud below, the day turning overhead.",
  accent: "#ff8a3d",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sky: {
      ...atmosphereGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the stars and the aurora over the cloud sea at night.",
    },
    clouds: {
      title: "Cloud sea",
      blurb:
        "The deck below: how much cloud, how far down, how fast it passes, and storms on the horizon.",
    },
    seat: {
      title: "Window seat",
      blurb: "What frames the view: the porthole, the wing, and the odd plane passing far off.",
    },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold livery", blurb: "A landmark of its own: the M on the winglet." },
  },
  glsl: cloudsGlsl,
  entry: "sceneClouds",
  // Daylight fills the screen only without the dark cabin around it, and only on a still clock.
  theme: skyTheme(params, {
    from: 0.3,
    to: 0.68,
    when: (values) => knobValue(params, values, "window") < 0.5,
  }),
  // Entrance: climbing out through the deck, wisps streaming past and the tops sinking below as the
  // plane levels off; exit: banking and sinking back into the tops under streaming vapour.
  passage: CLOUDS_PASSAGE,
  // The cloud sea: the shared clouds' ray-marched tops seen from above (cloudSeaMarch, cloudSeaTop,
  // cloudSeaShadow); the light on them, the ocean and the haze are the scene's own.
  features: { CLOUD_TIER: CLOUD_TIERS.volume },
};
