// Kelp forest: side-on in mid-water among giant kelp, the sunlit surface above and the sea floor
// below. Every stipe is a buoyant Verlet chain swaying in the swell's surge, its top floating along
// the surface as the canopy; the fish school flies as boids and a sea lion passes now and then
// (sim.ts). The shader (shader.ts) draws the kelp as stipes hung with long ribbon blades (or, as bull
// kelp, bare stipes under a gas bulb and its fan of straps) and lights it all through the water:
// shafts through the canopy's gaps, caustics, Snell's window, haze.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { kelpGlsl } from "./shader.ts";
import { KELP_PASSAGE, kelpSim, kelpSpecies } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("sea", "surge", "surge", 0.3, "How far the swell's surge sways the forest back and forth. It travels across as a long, slow wave, so near and far plants lean in turn."),
  range("sea", "period", "surge period", 10, "Seconds for one sway, there and back.", { min: 5, max: 14, step: 0.5 }),
  range("sea", "current", "current", 0.35, "A steady current through the forest, to the left or the right: the kelp leans downstream, the floating tops trail along the surface with it and the snow drifts with it.", { min: -1, max: 1 }),
  feature("sea", "swell", "big swells", true, "frequency", 0.3, "Now and then a big swell rolls through: the whole forest bows in a wave from one side to the other, swings back and settles.", { trigger: 0 }),
  range("forest", "density", "kelp density", 0.6, "How many plants stand in the forest, and how closely the canopy covers the surface. Low: a few stipes in open water. High: a dense forest that closes in on the middle of the frame."),
  seed("forest", "kelpSeed", "arrangement", "Where the plants stand; re-seed for another stretch of forest."),
  choice("forest", "species", "kelp", kelpSpecies.map((label, value) => ({ label, value })), 0, "Giant: giant kelp, stipes hung with blades all the way up, the grown ones reaching the surface and trailing along it as a canopy. Bull: bull kelp, shorter bare stipes each held up by a single gas bulb with a fan of long strap blades streaming from it; the bulbs swing through the surge in wide arcs and the water above stays open. Mixed: some of each."),
  range("forest", "understory", "floor life", 0.6, "What grows on the sea floor between the holdfasts: boulders, some crusted pink, purple urchins, anemones and small kelp nodding in the surge."),
  range("forest", "haze", "depth haze", 0.5, "How quickly the forest fades into the blue-green distance."),
  feature("light", "rays", "light rays", true, "strength", 0.6, "Shafts of light falling through the gaps in the canopy and fanning down through the water."),
  feature("light", "caustics", "caustics", true, "strength", 0.6, "The soft net of light the waves focus onto the sea floor, the kelp and the stone, drifting slowly."),
  range("light", "surface", "surface", 0.6, "The surface seen from below: a rippled silver ceiling, with Snell's window opening onto the sky overhead."),
  ...skyKnobs({ time: 0.42 }),
  feature("life", "fish", "fish school", true, "fish", 24, "A school of small silver fish turning together, shimmering and flashing as they roll into a turn. Click to scatter them.", { options: counts(12, 24, 32) }),
  range("life", "marineSnow", "marine snow", 0.5, "Specks drifting through the water, sinking slowly and swaying with the surge."),
  feature("life", "visitor", "sea lion", true, "frequency", 0.3, "Now and then a sea lion glides past, far off in the blue.", { trigger: 1 }),
  feature("night", "plankton", "bioluminescence", true, "strength", 0.7, "At night, plankton spark blue-green where the kelp moves and where your hand stirs the water."),
  feature("night", "jellies", "jellyfish", true, "count", 3, "Jellyfish drifting through the forest, bells pulsing: glassy by day, glowing at night.", { options: counts(2, 3, 5) }),
  feature("manifold", "mark", "M stone", false, "size", 0.5, "A Manifold M carved in stone, standing on the sea floor crusted with coralline algae; the caustics play over it, and at night its crust glows."),
];

export const kelpScene: SceneDef = {
  id: "kelp",
  title: "Kelp forest",
  blurb: "Sunlight through a swaying kelp forest, a school of fish turning in the blue.",
  accent: "#c3d86b",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sea: { title: "Swell", blurb: "The surge that sways the forest, the current it leans into and the big swells. Drag through the water to push the kelp aside with your hand." },
    forest: { title: "Forest", blurb: "How densely the kelp stands and closes its canopy overhead, where, what grows on the floor between the holdfasts, and how far you can see through the water." },
    light: { title: "Light", blurb: "Sunlight from the surface: the shafts through the canopy's gaps, the caustics and the surface itself." },
    sky: { title: atmosphereGroups.sky.title, blurb: "The time of day above the water: sunlight by day, moonlight by night." },
    life: { title: "Life", blurb: "The fish, the drifting snow and the odd visitor." },
    night: { title: "Night", blurb: "What glows in the dark water." },
    manifold: { title: "Manifold mark", blurb: "An M of stone standing on the sea floor." },
  },
  glsl: kelpGlsl,
  entry: "sceneKelp",
  // Entrance: the camera sinks from just under the surface into the forest, a surge bends the fronds
  // over and they swing into place, and the school streams in from the side and forms up. Exit: the
  // school turns and leaves the frame, a surge sweeps the fronds and the camera rises toward the light.
  passage: KELP_PASSAGE,
  sim: kelpSim(params),
};
