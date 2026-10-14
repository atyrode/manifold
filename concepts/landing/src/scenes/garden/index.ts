// A dry stone garden (karesansui): white gravel raked into lines and rings around islands of
// weathered stones and moss, always being re-raked by an unseen hand, under a maple letting go of
// its leaves. The gravel, the rake and the falling leaves are simulated in sim.ts; shader.ts lights
// it all from the veranda or from straight above.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { gardenGlsl } from "./shader.ts";
import { GARDEN_PAPER, GARDEN_PASSAGE, gardenPatterns, gardenSeasons, gardenSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("garden", "pattern", "raked pattern", gardenPatterns.map((label, value) => ({ label, value })), 0, "Waves: parallel lines meandering across the garden like a slow current, five rings round each island. Straight: the still-water lines of the classic gardens, rings round the islands. Circles: rings spreading out from every stone until they meet the next stone's. The garden is laid out afresh; the rake then keeps it."),
  range("garden", "speed", "raking", 0.4, "How fast the unseen rake works its way round the garden: a board levels the old pattern just ahead of five tines cutting the new, pass after pass, then lap after lap round the stones. Fresh gravel is a little darker until it dries. At 0 the rake rests."),
  range("garden", "soften", "weathering", 0.4, "How quickly grooves slump and soften once raked: crisp just behind the rake, gentler the longer since it passed."),
  range("garden", "moss", "moss", 0.6, "Moss cushions round the stones: none leaves bare stones in smooth gravel; full gives deep green collars, creeping up the stones' feet."),
  seed("garden", "stones", "stones", "Another arrangement of the stone islands; the garden is raked afresh round them."),
  choice("maple", "season", "season", gardenSeasons.map((label, value) => ({ label, value })), 2, "Spring: cherry blossom, its petals drifting down. Summer: a deep green maple, a leaf now and then, dappled shade. Autumn: the maple turns red and lets go of its leaves. Winter: bare branches, snow on the stones, the moss and the wall; turn on snow (Weather) to have it falling."),
  range("maple", "leaves", "leaf fall", 0.5, "How often a leaf lets go. Light ones flutter, swinging from side to side and gliding up at the end of each swing; heavier ones tumble end over end. They lie on the gravel a while, then fade or are raked away. Now: a gust shakes a shower loose and blows lying leaves along the gravel.", { trigger: 0 }),
  range("maple", "dapple", "dappled shade", 0.6, "The maple's shadow on the gravel, pierced by round flecks of sun; it shows when the sun stands high enough to throw it into the garden."),
  choice("view", "camera", "view", [{ label: "veranda", value: 0 }, { label: "above", value: 1 }], 0, "Sit on the temple veranda looking across the garden to its earthen wall, or look straight down on it like a plan. Drag on the gravel to rake your own lines.", { steady: true }),
  // 0.735: golden hour, the sun low on the left behind the wall, raking across the grooves.
  ...skyKnobs({ time: 0.735 }),
  ...weatherKnobs({ rain: true, snow: true, wind: true }),
  feature("manifold", "mark", "M stone", false, "size", 0.5, "A low slab of grey-blue slate in the shape of the Manifold M, set nearly flush in the gravel: worn pale at its edges, lichen on it, a fringe of moss round it, and rings raked round it in its own shape, as round the other stones. The garden is laid out afresh round it."),
];

export const gardenScene: SceneDef = {
  id: "garden",
  title: "Stone garden",
  blurb: "Raked gravel, stones and moss, always being tended, under a maple letting go of its leaves. Drag to rake.",
  accent: "#c8321e",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    garden: { title: "Garden", blurb: "The raked pattern, the unseen rake's pace, the stones and their moss. Drag on the gravel to rake your own lines." },
    maple: { title: "Maple", blurb: "The season, and the leaves it lets fall on the gravel." },
    view: { title: "View", blurb: "From the veranda, or from above." },
    sky: atmosphereGroups.sky,
    // The shared heading, with what the weather does here.
    weather: { ...atmosphereGroups.weather, blurb: "Rain greys the sky and soaks the garden: wet gravel darkens, stones and tiles shine, water stands in the grooves and the eaves and maple drip; drizzle is a soft grey mist, a downpour closes the garden in. Snow settles, crests and stone tops first. Wind sways the maple and carries its leaves." },
    manifold: { title: "Manifold M", blurb: "A landmark of its own: a slate M among the stones, the gravel raked round it." },
  },
  glsl: gardenGlsl,
  entry: "sceneGarden",
  sim: gardenSim(params),
  passage: GARDEN_PASSAGE,
  // White gravel in daylight is a light page, golden hour included: the copy goes dark on it from
  // just after sunrise to just before sunset, on a still clock, unless steady rain greys it. The
  // shader follows the page (pagePaper in inkOf).
  theme: skyTheme(params, { from: GARDEN_PAPER.from, to: GARDEN_PAPER.to, rainBelow: GARDEN_PAPER.rain }),
};
