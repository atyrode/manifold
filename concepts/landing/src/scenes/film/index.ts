// A soap film in a wire loop, a frame or a free bubble, against the dark: thin-film interference
// colours on a film that drains, swirls and now and then bursts. The film flows as a 2D fluid on
// the GPU with its thickness as the dye (sim.ts); shader.ts colours it from a thickness → colour
// table integrated over the visible spectrum and draws the wire, the burst and the new film.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { filmBackdrops, filmGlsl } from "./shader.ts";
import { filmShapes, filmSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("film", "shape", "held by", filmShapes.map((label, value) => ({ label, value })), 1, "What holds the film: a wide rectangular frame or a round loop like a bubble wand, each on a twisted wire handle, or nothing at all: a free bubble floating in the dark."),
  range("film", "colour", "colour", 0.5, "How vivid the interference colours are: pale and pearly to the left; deep magentas, golds, cyans and greens to the right."),
  choice("film", "backdrop", "background", filmBackdrops.map((label, value) => ({ label, value })), 0, "What the film is seen against: black velvet, a deep midnight blue, or a dim plum glow."),
  feature("film", "pop", "pop", true, "how often", 0.5, "Worn thin at its top, a film bursts after a few minutes: its rim races out from the break, flinging droplets, and a fresh film is drawn up from the bottom wire (a bubble is blown again). More: sooner.", { trigger: 0 }),
  seed("film", "filmSeed", "film", "Where the first eddies turn, where plumes rise and where each film breaks; re-seed for a fresh film."),
  range("flow", "drainage", "drainage", 0.5, "How fast gravity drains the film: the colour bands sliding down, and the black film creeping after them from the top."),
  range("flow", "swirl", "swirl", 0.5, "Warm air rising past the film: slow convection eddies marbling the bands, livelier where the film is thick."),
  range("flow", "plumes", "plumes", 0.5, "Thin film pulled from the wire low on the sides and along the bottom, rising through the bands like little mushroom clouds of colour."),
  feature("flow", "blow", "blow", true, "breath", 0.5, "Move the pointer to blow across the film and stir it; hold the button to blow a thin spot that floats up through the colours."),
  feature("manifold", "mark", "wire M", false, "size", 0.5, "A wire bent into the Manifold M, standing on the lower wire inside the film: the film flows round it and its fringes of colour trace the M."),
];

export const filmScene: SceneDef = {
  id: "film",
  title: "Soap film",
  blurb: "A soap film in a wire loop, draining into bands of colour.",
  accent: "#d94bd0",
  look: { color: "full", levels: 5 },
  params,
  groups: {
    film: { title: "Soap film", blurb: "What holds the film, how vivid it is and what it is seen against. Move over it to blow; hold to blow a thin spot." },
    flow: { title: "Flow", blurb: "Gravity draining the film, warm air stirring it and thin film rising from the wire." },
    manifold: { title: "Manifold M", blurb: "A wire M standing in the film, its colours hugging the wire." },
  },
  glsl: filmGlsl,
  entry: "sceneFilm",
  sim: filmSim(params),
};
