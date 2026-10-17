// A park in autumn, late afternoon: a great maple (or ginkgo, or oak) over a gravel path, a wooden
// bench on the lawn and a cast-iron lamp, the low sun behind the canopy so that the leaves glow and the
// shadows run long across the grass. The leaves let go and fall as the plates they are, fluttering,
// gliding and tumbling and turning to show their paler undersides, and land to thicken the carpet on the
// lawn and the path; now and then a gust lifts a swirl of them along the path. The leaves, the carpet
// and the gusts live in sim.ts; shader.ts paints the park around them, and layout.ts holds the
// geometry the two share.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGates } from "../world.ts";
import { AUTUMN_PASSAGE } from "./layout.ts";
import { AUTUMN_METEOR_TRIGGER, autumnGlsl } from "./shader.ts";
import { autumnSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice(
    "tree",
    "species",
    "tree",
    [
      { label: "maple", value: 0 },
      { label: "ginkgo", value: 1 },
      { label: "oak", value: 2 },
    ],
    0,
    "The great tree over the path. A maple: five-pointed leaves from crimson to gold, grey bark. A ginkgo: butter-yellow fans on pale furrowed bark, falling light and steady. An oak: russet and ochre lobes on dark ridged bark, heavier, tumbling more.",
  ),
  range(
    "tree",
    "season",
    "season progress",
    0.35,
    "How far autumn has come. Early: leaves just turning, some still green, a thin carpet. Middle: a full golden canopy and a growing carpet. Late: browning, the canopy thinning to sky and boughs, the ground deep in leaves.",
    { widget: { kind: "sky", part: "season", year: { span: [0.5, 0.75] } } },
  ),
  seed(
    "tree",
    "parkSeed",
    "park",
    "How the canopy hangs and where its gaps open, where the leaves lie thick on the lawn, what rests on the bench; re-seed for another corner of the park.",
  ),
  range(
    "leaves",
    "fall",
    "leaf fall",
    0.5,
    "How often a leaf lets go. Light ones flutter, swinging from side to side and gliding up at the end of each swing; heavier ones tumble end over end, each turning to show its paler underside. They land and add to the carpet, and the oldest ones slowly rot away.",
  ),
  feature(
    "leaves",
    "gusts",
    "gusts",
    true,
    "strength",
    0.5,
    "A gust now and then: the canopy sways, a shower of leaves is shaken loose, and often a swirl of the fallen leaves is lifted off the path and carried along it before it settles. Higher: stronger and more often. Now: a gust.",
    { trigger: 0 },
  ),
  feature(
    "park",
    "lamp",
    "lamp post",
    true,
    "glow",
    0.7,
    "The cast-iron lamp beside the path lights as the day fades or a storm darkens it, throwing a warm pool on the leaves.",
  ),
  ...skyKnobs({
    time: 0.69,
    stars: 0.5,
    moon: 1,
    meteors: { trigger: AUTUMN_METEOR_TRIGGER },
    constellations: true,
  }),
  ...weatherKnobs({ clouds: 0.3, shadows: true, rain: true, fog: true, wind: true, aurora: true }),
  feature(
    "manifold",
    "mark",
    "leaf M",
    false,
    "amount",
    0.8,
    "The wind sweeps a Manifold M together out of the fallen leaves, gold ones laid out along the path like a road marking; the ground round it is cleared. It gathers over about ten seconds. Now: gather it (even while off), and it scatters again after a while.",
    { trigger: 1 },
  ),
];

export const autumnScene: SceneDef = {
  id: "autumn",
  title: "Autumn park",
  blurb:
    "A great tree letting go of its leaves over a park path, the low sun glowing through them.",
  accent: "#e8a23a",
  look: { color: "full", levels: 4 },
  params,
  planets: { group: "sky", across: [-30, 14, 40], up: [2, 14, 26] },
  groups: {
    tree: {
      title: "Tree",
      blurb: "Which tree, how far autumn has come, and how this corner of the park is arranged.",
    },
    leaves: {
      title: "Leaves",
      blurb: "How the leaves let go and fall, and the gusts that carry them.",
    },
    park: { title: "Park", blurb: "The lamp post beside the path." },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night sky over the park: its stars, the moon's phase, the odd shooting star, and on a clear night the aurora over the far trees.",
    },
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "Clouds drift over, and if you like their shadows sweep across the park. Rain greys the light and darkens the canopy; the path and the leaves turn dark and glossy, pools gather on the gravel and rings spread in them. Fog fades the far trees. The wind leans the leaves as they fall and carries the gusts.",
    },
    manifold: { title: "Manifold mark", blurb: "An M of gold leaves swept together on the path." },
  },
  glsl: autumnGlsl,
  entry: "sceneAutumn",
  sim: autumnSim(params),
  theme: skyTheme(params, { rainBelow: 0.4 }),
  // Entrance: the camera lowers from the canopy onto the path as a gust blows a flurry of leaves through
  // the swaying boughs. Exit: a stronger gust whirls the leaves up across the frame as the camera tilts
  // up into the canopy.
  passage: AUTUMN_PASSAGE,
  // The world's sky, every part its knobs can show compiled in: the moon's phase (K_moon), the cloud
  // deck and its shadows (CLOUD_TIER at shadows), the stars, the aurora and shooting stars, the rain.
  features: worldGates(params),
};
