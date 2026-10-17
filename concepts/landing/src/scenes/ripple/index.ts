// Ripple tank: the physics-lab classic seen from above, its waves thrown as light and shadow on a
// screen. The water is the damped wave equation stepped on the GPU (sim.ts), set up one experiment
// after another (layout.ts): two dippers' interference, a double slit, a lens, a moving dipper's
// Doppler rings, standing waves in a box. shader.ts lights the screen or the surface.
import { choice, feature, range, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { RIPPLE_ENTER, RIPPLE_EXIT, rippleLights } from "./constants.ts";
import { rippleExperimentLabels } from "./layout.ts";

const params: readonly ParamDef[] = [
  choice(
    "tank",
    "experiment",
    "experiment",
    [
      { label: "cycle", value: 0 },
      ...rippleExperimentLabels.map((label, i) => ({ label, value: i + 1 })),
    ],
    0,
    "What is set up in the tank. Cycle: each experiment in turn, a minute or two apiece, crossfading between them. Interference: two dippers beating together, lines of calm water fanning out between their rings. Double slit: straight waves pass two gaps in a barrier and spread into the same fan. Lens: straight waves cross a lens-shaped shallow, slow down over it and bend to a focus. Doppler: a dipper drawn slowly along, its rings crowding ahead of it and spreading out behind. Standing: a dipper in a closed box, its waves bouncing to and fro until they pulse in place.",
  ),
  range(
    "tank",
    "pace",
    "cycle speed",
    0.5,
    "How long each experiment holds while the tank cycles: two and a half minutes to the left, forty seconds to the right. Now: on to the next experiment (or, holding one, set it up afresh).",
    { trigger: 0 },
  ),
  range(
    "tank",
    "frequency",
    "frequency",
    1,
    "How fast the dippers beat, as the strobe shows them: ripple tanks are watched under a strobe that slows their waves to a crawl. Slower: long, lazy waves; faster: shorter, busier ones.",
    { min: 0.6, max: 1.6, step: 0.05 },
  ),
  range(
    "tank",
    "speed",
    "wave speed",
    1,
    "How fast the waves travel: deeper water to the right. At the same beat, faster waves are longer.",
    { min: 0.6, max: 1.5, step: 0.05 },
  ),
  range(
    "tank",
    "damping",
    "damping",
    0.3,
    "How quickly the waves die away as they travel: from crossing the whole tank to fading within a few wavelengths.",
  ),
  range(
    "tank",
    "edges",
    "edge absorption",
    1,
    "How much of each wave the sloping beaches round the tank's rim soak up. Full: the waves run out at the edges as if the water went on for ever. Lower: the rim hands part of every wave back, and its reflections cross the pattern. None: bare walls reflect everything, and the tank slowly fills with standing waves. Damping still fades the waves everywhere; this is only the edges.",
  ),
  feature(
    "tank",
    "drips",
    "drips",
    true,
    "how often",
    0.3,
    "Now and then a drop falls from the tap over the tank, and a ring spreads through the pattern. Now: one falls at once.",
    { trigger: 2 },
  ),
  choice(
    "light",
    "render",
    "rendering",
    [
      { label: "projection", value: 0 },
      { label: "surface", value: 1 },
    ],
    0,
    "Projection: the lamp throws the water's light and shadow on the white screen under the tank, its crests gathering the light into bright bands. Surface: the dark water itself, the room's light on its slopes and the lamp mirrored in it.",
  ),
  choice(
    "light",
    "light",
    "lamp",
    rippleLights.map((label, value) => ({ label, value })),
    0,
    "The light's colour: sea-green through the water, a warm tungsten bulb, a darkroom's red safelight, or moonlight.",
  ),
  range(
    "light",
    "focus",
    "focus",
    0.5,
    "How far below the water the screen sits: close, and the waves show as soft bands; far, and the light gathers into bright, sharp lines.",
  ),
  feature(
    "manifold",
    "mark",
    "M dipper",
    false,
    "size",
    0.5,
    "A strip of coloured acrylic bent into the Manifold M dips into the water: its waves leave M-shaped and round off as they spread, and its shadow glows in the accent colour. While on, it takes its turn in the cycle. Now: set it up at once.",
    { trigger: 1 },
  ),
];

export const rippleScene: SceneDef = {
  id: "ripple",
  title: "Ripple tank",
  blurb:
    "A physics-lab ripple tank throwing its waves as light on a screen: interference, slits, a lens, Doppler, standing waves.",
  accent: "#ff7e5f",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    tank: {
      title: "Tank",
      blurb:
        "The experiment and the water. Tap to drop a pebble, drag a dipper to move it, drag through open water to draw a dipping finger.",
    },
    light: { title: "Light", blurb: "How the tank is seen." },
    manifold: { title: "Manifold mark", blurb: "An M-shaped dipper." },
  },
  // Entrance: still water, then the dippers start and the first wavefronts spread across the tank. Exit: the dippers stop and the last waves run out.
  passage: { enter: RIPPLE_ENTER, exit: RIPPLE_EXIT },
  code: () => import("./code.ts"),
};
