// Dew: one orb web up close at dawn, strung with dew between two grass stems, against a meadow far
// out of focus. The web is a Verlet net billowing in the breeze and its big drops creep, merge and
// fall (sim.ts); the shader (shader.ts) draws the glinting silk, the beads and drops as little
// lenses, the grass (stalk, leaves, seed head), and the wasp spider at the hub. The sky comes from
// the shared library.
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, paletteTheme, skyKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { dewGlsl } from "./shader.ts";
import { DEW_PASSAGE, dewSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range(
    "web",
    "breeze",
    "breeze",
    0.35,
    "How hard the breeze presses on the web. Still air to the left; to the right the web billows and ripples out of its plane and the grass stems nod. Now: a gust, shaking a few heavy drops loose.",
    { trigger: 0 },
  ),
  range(
    "web",
    "dew",
    "dew",
    0.6,
    "How heavy the dew lies. Left: a dry web with its silk catching the light. Right: every thread strung with beads, and big drops gathering, creeping down the threads, running together and falling.",
  ),
  range(
    "web",
    "dof",
    "depth of field",
    0.5,
    "How shallow the focus is. The camera stays focused on the hub; threads and drops that swing toward you or away soften and fade, like silk through a macro lens.",
  ),
  toggle(
    "web",
    "spider",
    "spider",
    true,
    "The wasp spider (an Argiope) resting head down at the hub, her abdomen banded yellow and black, her legs held in pairs in an X, a zig-zag ribbon of silk above and below her. Once in a while she shifts a leg.",
  ),
  seed(
    "web",
    "webSeed",
    "web",
    "How this web was spun: the spacing of its radii and spiral, the corners of its frame, where the dew gathers. Re-seed for another web.",
  ),
  choice(
    "scene",
    "backdrop",
    "backdrop",
    [
      { label: "meadow", value: 0 },
      { label: "dark", value: 1 },
      { label: "misty", value: 2 },
    ],
    0,
    "What lies behind, far out of focus: a dawn meadow with a hazy hedge, soft bokeh from the low sun on the dew, and mist over the grass tops; the same in deep shadow; or thick dawn mist.",
  ),
  ...skyKnobs({ time: 0.27 }),
  feature(
    "manifold",
    "mark",
    "M stabilimentum",
    false,
    "size",
    0.5,
    "Garden spiders weave a band of zig-zag silk across the hub, the stabilimentum, usually a cross or a line. This one weaves an M in place of her usual zig-zag ribbon, and sits at its heart.",
  ),
];

export const dewScene: SceneDef = {
  id: "dew",
  title: "Dew",
  blurb: "An orb web at dawn, strung with dew, glinting as it breathes in the breeze.",
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    web: {
      title: "Web",
      blurb:
        "The breeze, the dew and the focus, and the spider at the hub. Click a thread to pluck it; drag to strum.",
    },
    scene: { title: "Backdrop", blurb: "What lies behind the web, far out of focus." },
    sky: {
      ...atmosphereGroups.sky,
      blurb: "Time of day: the low sun sets the glints and the colour of the light.",
    },
    manifold: { title: "Manifold mark", blurb: "The spider's own landmark, woven into the hub." },
  },
  glsl: dewGlsl,
  entry: "sceneDew",
  sim: dewSim(params),
  // Entrance: the web swings in on its anchor threads as a gust settles, the dew swinging with it, and
  // the spider walks down to the hub. Exit: a gust swings the web aside and out of frame.
  passage: DEW_PASSAGE,
  // Mist is pale: the page copy goes dark on it.
  theme: paletteTheme(params, "backdrop", (index) => index === 2),
};
