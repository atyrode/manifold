// A bonsai through the seasons: a single tree on a rosewood stand against a plaster wall (or shoji,
// or a dark alcove), lit from the side, its shadow moving over the wall with the sun. The tree is
// grown for its species and seed by space colonisation inside sculpted cloud pads (tree.ts) and
// lives through the year (sim.ts): leaves open, colour and fall to lie on the moss and the stand,
// snow settles in winter, new shoots reach out each spring and are trimmed back by an unseen hand.
// Hover to stir the pads; click to snip a twig. The picture is painted in shader.ts. It comes in as
// the stand glides in from the side along the veranda, the pads leaning on its braking and springing
// back, and leaves as the stand is pushed off to the side with a gust and a few leaves shaken loose.
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { bonsaiGlsl } from "./shader.ts";
import { BONSAI_PASSAGE, bonsaiSim } from "./sim.ts";

// The day passes slowly by default, so the shadow creeps over the wall: afternoon to dusk to the
// lamp in about ten minutes.
const sky = skyKnobs({ time: 0.6 }).map((def): ParamDef => (def.kind === "feature" && def.key === "cycle" ? { ...def, on: true, value: 0.1 } : def));

const params: readonly ParamDef[] = [
  choice("tree", "species", "tree", [{ label: "pine", value: 0 }, { label: "maple", value: 1 }, { label: "cherry", value: 2 }], 1, "A Japanese black pine (evergreen: its new candles rise each spring and are pinched back), a Japanese maple (red new leaves, green summer, crimson autumn, bare winter), or a flowering cherry (a cloud of blossom in early spring, petals drifting down)."),
  seed("tree", "treeSeed", "tree", "How this tree was grown and styled: the line of its trunk, its roots, where the branches leave and how the pads sit. Re-seed for another tree."),
  choice("tree", "pot", "pot", [{ label: "unglazed", value: 0 }, { label: "celadon", value: 1 }, { label: "cobalt", value: 2 }, { label: "cream", value: 3 }], 2, "The pot: an unglazed red-brown rectangle with the potter's seal, or an oval in crackled celadon, cobalt blue breaking brown at the rim, or speckled cream."),
  toggle("tree", "figure", "clay figure", true, "A little glazed clay sage in a straw hat, sitting on the moss under the tree."),
  feature("tree", "breeze", "breeze", true, "strength", 0.35, "Air moving through the foliage pads, each swaying at its own pace; now and then a gust that shakes leaves loose in autumn. Hover over the tree to stir the pads. Now: a gust.", { trigger: 0 }),
  toggle("tree", "growth", "new shoots", true, "Each spring new shoots reach out beyond the pads (candles on the pine), and an unseen gardener trims them back through the summer to keep the shape. Click a shoot or a twig to snip it yourself; it falls and lies with the leaves, and grows back next spring. Now: a snip.", { trigger: 1 }),
  range("seasons", "season", "season", 0.58, "Where the year stands: spring at the left end, then summer, autumn and winter.", { steady: true }),
  feature("seasons", "year", "seasons pass", true, "minutes per season", 3, "The year turns at this pace: buds and new leaves, full summer pads, autumn colour and leaf fall, bare branches and snow.", { min: 0.5, max: 10, step: 0.5 }),
  feature("seasons", "leaves", "falling leaves", true, "amount", 0.5, "How much comes down when its time comes: maple and cherry leaves in autumn, cherry petals in spring, old pine needles; they settle on the moss, the stand and the floor and rot away through the season. Now: a few let go.", { trigger: 3 }),
  feature("seasons", "snowfall", "winter snow", true, "amount", 0.5, "Snow falls a few times each winter and lies on the branches, the pads, the pot's rim, the moss and the stand, melting as spring comes. Now: a flurry, whatever the season.", { trigger: 4 }),
  ...sky,
  range("light", "light", "sun from", 0.35, "Where the sun comes from: the left, the front or the right. The tree's shadow falls across the wall the other way and creeps as the day goes.", { min: -1, max: 1 }),
  choice("light", "wall", "wall", [{ label: "plaster", value: 0 }, { label: "shoji", value: 1 }, { label: "dark", value: 2 }], 0, "Behind the tree: warm earthen plaster, a shoji screen of paper and lattice glowing with the day, or a dark alcove."),
  feature("light", "lamp", "paper lamp", true, "glow", 0.6, "A paper lamp off to the left, lit as the light fails: warm light on the tree and its shadow thrown big and soft up the wall."),
  feature("manifold", "mark", "kintsugi M", false, "glow", 0.7, "The stone on the moss carries a Manifold M mended into it in gold lacquer, kintsugi style; it catches the sun and the lamp. Now: it gleams.", { trigger: 2 }),
];

export const bonsaiScene: SceneDef = {
  id: "bonsai",
  title: "Bonsai",
  blurb: "A bonsai on its stand through the seasons, its shadow moving on the wall.",
  accent: "#d8432e",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    tree: { title: "Tree", blurb: "The tree, its pot and stand-mates, the breeze, and the gardener's hand. Hover to stir the pads; click to snip." },
    seasons: { title: "Seasons", blurb: "The year turning on the tree: leaves out, colour, leaf fall and winter snow." },
    sky: atmosphereGroups.sky,
    light: { title: "Light", blurb: "Where the sun comes from, what stands behind the tree, and the lamp for the evening." },
    manifold: { title: "Manifold mark", blurb: "A gold M mended into the stone on the moss." },
  },
  glsl: bonsaiGlsl,
  entry: "sceneBonsai",
  sim: bonsaiSim(params),
  passage: BONSAI_PASSAGE,
};
