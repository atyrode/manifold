// Van Gogh's Starry Night, advected along its own brushstrokes, its stars pulsing. The painting, its
// flow field and star vortices come from artwork.ts; the GLSL is shared with wave
// (src/shaders/paintings.ts).
import { feature, toggle } from "../../params.ts";
import { paintings } from "../../shaders/paintings.ts";
import type { SceneDef } from "../types.ts";

export const starryScene: SceneDef = {
  id: "starry",
  title: "Starry",
  blurb: "Van Gogh's sky swirling, stars pulsing with light.",
  accent: "#f2c94c",
  credit: "after Vincent van Gogh, The Starry Night, 1889 — public domain",
  // The shader indexes uParams directly in this order: append only.
  params: [
    feature("sky", "swirl", "swirl", true, "distance", 0.5, "The sky's paint travels along its strokes."),
    feature("sky", "pulse", "star pulse", true, "strength", 0.5, "Rings of light travel outward through each star's halo."),
    toggle("sky", "stir", "stir with mouse", false, "The paint twists around the pointer like a spoon in paint."),
    feature("land", "sway", "cypress sway", true, "amount", 0.5, "The cypress flickers like a flame."),
    feature("land", "windows", "village lights", false, "pace", 0.4, "Windows in the village switch on and off one by one."),
    toggle("manifold", "mstars", "M of stars", false, "Five haloed stars, painted into the sky in the shape of the Manifold M."),
  ],
  groups: {
    sky: { title: "Sky", blurb: "The painted sky in motion, and the pointer's stir." },
    land: { title: "Land", blurb: "The cypress and the sleeping village." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live inside the painting." },
  },
  glsl: paintings,
  entry: "sceneStarry",
};
