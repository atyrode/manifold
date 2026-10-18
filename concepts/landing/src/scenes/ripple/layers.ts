// The Ripple tank preset's layers (ADR 0062 Phase 4, the overhead composer): their manifests, which
// load without their code (shader.ts, sim.ts). The tank is laid out on the frame in short sides
// (layout.ts), so both are drawn through the tank's span alone (TANK_SPAN).
//   tank       bed: the screen under the tank the lamp throws the water's light on (or, the water
//              seen as a surface, the table round it), the tray, and the lamp's colours
//   tankWater  water: the damped wave equation stepped on the GPU (sim.ts: its view, the next
//              experiment's while it fades in, and the layout of its fixtures, three fields), the
//              experiment set up in it, one after another (layout.ts), and how hard it focuses the
//              lamp's light on the screen (`focus`); it is drawn through its tank's lamp and screen,
//              so it needs the tank
// Keys kept from the scene, every one; `tank` and `tankWater` are new switches. The "now" slots are
// the composer's (the sim reads them from its knobs): pace, drips, the M, in the water's order.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { rippleLights } from "./constants.ts";
import { rippleExperimentLabels } from "./layout.ts";

/** Metres a screen height spans over the tank: a big demonstration tank, a metre across. */
export const TANK_SPAN = 1;

/** The tank's own span, and no other. */
const TANK: CameraRange = { span: [TANK_SPAN, TANK_SPAN] };

/** The water's fields: the shown tank's view, the one fading in, the layout (shader.ts). */
export const TANK_WATER_FIELDS = 3;

export const tankLayer: LayerDef = {
  id: "tank",
  title: "Ripple tank",
  composers: ["overhead"],
  role: "bed",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TANK,
  switch: toggle(
    "layers",
    "tank",
    "ripple tank",
    false,
    "A physics-lab ripple tank under a lamp: the white screen below it, where the lamp throws the water's light and shadow, the tray's frame, and the lamp's colours.",
    { icon: "bulb" },
  ),
  params: [
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
  ],
  groups: { light: { title: "Light", blurb: "How the tank is seen." } },
  passes: { bed: "tankBed" },
};

export const tankWaterLayer: LayerDef = {
  id: "tankWater",
  title: "Waves",
  composers: ["overhead"],
  role: "water",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TANK,
  switch: toggle(
    "layers",
    "tankWater",
    "waves",
    false,
    "The tank's water, its waves stepped as the wave equation and set up one experiment after another: two dippers' interference, a double slit, a lens, a moving dipper's Doppler rings, standing waves in a box.",
    { icon: "waves" },
  ),
  params: [
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
    range(
      "light",
      "focus",
      "focus",
      0.5,
      "How far below the water the screen sits: close, and the waves show as soft bands; far, and the light gathers into bright, sharp lines.",
    ),
    feature(
      "tank",
      "drips",
      "drips",
      true,
      "how often",
      0.3,
      "Now and then a drop falls from the tap over the tank, and a ring spreads through the pattern. Now: one falls at once.",
    ),
    feature(
      "manifold",
      "mark",
      "M dipper",
      false,
      "size",
      0.5,
      "A strip of coloured acrylic bent into the Manifold M dips into the water: its waves leave M-shaped and round off as they spread, and its shadow glows in the accent colour. While on, it takes its turn in the cycle. Now: set it up at once.",
    ),
  ],
  triggers: ["pace", "drips", "mark"],
  mark: "mark",
  requires: ["tank"],
  groups: {
    tank: {
      title: "Tank",
      blurb:
        "The experiment and the water. Tap to drop a pebble, drag a dipper to move it, drag through open water to draw a dipping finger.",
    },
    manifold: { title: "Manifold mark", blurb: "An M-shaped dipper." },
  },
  passes: { begin: "tankWaterBegin" },
  data: { fields: TANK_WATER_FIELDS },
};
