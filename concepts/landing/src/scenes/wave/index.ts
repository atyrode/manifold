// Hokusai's Great Wave, advected along its own brushstrokes. The print and its flow field come from
// artwork.ts; the GLSL is shared with starry (src/shaders/paintings.ts).
import { feature, range, toggle } from "../../params.ts";
import { paintings } from "../../shaders/paintings.ts";
import type { SceneDef } from "../types.ts";

export const waveScene: SceneDef = {
  id: "wave",
  title: "Wave",
  blurb: "Hokusai's Great Wave, moving along its own brushstrokes.",
  accent: "#4c6ef5",
  credit: "after Katsushika Hokusai, The Great Wave off Kanagawa, c. 1831 — public domain",
  // The shader indexes uParams directly in this order: append only.
  params: [
    feature("motion", "lean", "rock", true, "amount", 0.5, "The big wave rocks forward and back about its base."),
    feature("motion", "flow", "paint flow", true, "distance", 0.5, "Paint slides along the brushstrokes, then fades back before it smears."),
    toggle("motion", "spray", "spray", true, "Droplets thrown off the claws of the crest."),
    feature("motion", "depth", "parallax", true, "depth", 0.5, "Nearer water shifts against the horizon as the camera drifts."),
    range("look", "foam", "foam", 0.6, "Density of the white foam dots. Lower is more sober."),
    toggle("look", "paper", "ink on paper", false, "Light theme: dark ink and blue on the print's paper colour instead of night."),
    toggle("loading", "rise", "rise with loading", false, "On the loading page, the crest gathers as the bar fills and breaks when it completes."),
    toggle("manifold", "seal", "seal", false, "A hanko seal stamped with the Manifold M, where the print's title cartouche was."),
  ],
  groups: {
    motion: { title: "Movement", blurb: "How the print comes alive: rocking, flowing paint, spray and depth." },
    look: { title: "Print", blurb: "Foam density, and night versus ink-on-paper." },
    loading: { title: "Loading page", blurb: "Behaviour when the loading page is on top." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live inside the print." },
  },
  glsl: paintings,
  entry: "sceneWave",
  theme: (params) => ((params.paper ?? 0) > 0.5 ? "paper" : "night"),
};
