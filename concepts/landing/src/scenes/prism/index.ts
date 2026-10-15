// Newton's prism: a sunbeam slants down through a dark room into a glass prism, which turns it
// aside and fans it out into a spectrum. The optics (Snell, Cauchy dispersion, Fresnel, total
// internal reflection) are traced per wavelength in sim.ts; shader.ts integrates the fans into
// continuous colour and draws the glass, the dust and Newton's shutter.
import { choice, feature, range, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { prismGlsl } from "./shader.ts";
import { PRISM_PASSAGE, prismSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice(
    "light",
    "turn",
    "motion",
    [
      { label: "rock", value: 0 },
      { label: "spin", value: 1 },
    ],
    0,
    "Rock: the prism sways slowly about minimum deviation, where the fan swings, pauses and swings back. Spin: it turns round and round, and the light finds every way through the glass. Drag the page to turn it by hand.",
  ),
  range("light", "speed", "speed", 0.35, "How fast the prism turns."),
  range(
    "light",
    "dispersion",
    "dispersion",
    0.5,
    "How far the glass spreads the colours apart. Left: real flint glass, a narrow fan. Right: an impossible glass that throws the spectrum wide.",
  ),
  range(
    "light",
    "beam",
    "beam width",
    0.25,
    "The width of the sunbeam, from a thread of light to a broad shaft.",
  ),
  feature(
    "light",
    "eclipse",
    "eclipse",
    true,
    "how often",
    0.4,
    'Now and then the rocking prism turns further, until total internal reflection traps the light inside the glass: the rainbow drains away from violet to red and the light leaves by another face, white again. Then it turns back and the colours return. "Now" plays one at once.',
    { trigger: 0 },
  ),
  feature(
    "light",
    "second",
    "second prism",
    false,
    "gap",
    0.4,
    "Newton's second prism, turned the other way round, catches the fan and bends every colour back to the sunbeam's direction. Close up the colours merge into white again; further off they leave side by side as a parallel ribbon. Set close, it steps back while an eclipse or your hand turns the first prism into it. \"Now\" slides it in along the fan for a while.",
    { trigger: 1 },
  ),
  range(
    "glass",
    "edges",
    "glass edges",
    0.6,
    "Brightness of the glass: its silhouette and bevelled edges catching the room's light, glints on the corners, and the faint body of the glass.",
  ),
  range(
    "glass",
    "reflections",
    "reflections",
    0.18,
    "The faint partial reflections at every face: a ghost of the sunbeam glancing off the glass, and a second, dimmer rainbow leaving by another face. They fade as they travel.",
  ),
  feature(
    "glass",
    "dust",
    "dust",
    true,
    "amount",
    0.5,
    "Motes drifting slowly through the room, sparkling where they cross the light, and the faint haze they make around the beams.",
  ),
  feature(
    "glass",
    "screen",
    "screen",
    true,
    "brightness",
    0.5,
    "A plane at the far right where the spectrum lands, glowing there as a soft band of its colours. Off: the fan runs on into the dark.",
  ),
  choice(
    "glass",
    "backdrop",
    "room",
    [
      { label: "black", value: 0 },
      { label: "deep blue", value: 1 },
    ],
    0,
    "The dark room behind the light: black, or a deep night blue.",
  ),
  feature(
    "manifold",
    "mark",
    "M shutter",
    false,
    "size",
    0.5,
    'Newton let the sun in through a hole in his window shutter. Here the hole is cut as the Manifold M, glowing high on the left, and the sunbeam leaves from it. "Now" opens it for a while.',
    { trigger: 2 },
  ),
];

export const prismScene: SceneDef = {
  id: "prism",
  title: "Prism",
  blurb: "A sunbeam through turning glass, fanned out into its spectrum.",
  accent: "#7c6cff",
  look: { color: "full", levels: 5 },
  params,
  groups: {
    light: {
      title: "Light",
      blurb:
        "The sunbeam, how the prism turns and spreads it, and the moments its light is trapped or recombined.",
    },
    glass: {
      title: "Glass and room",
      blurb: "The glass itself, its faint reflections, the dust in the air and the dark around it.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "The M cut in Newton's window shutter, where the sunlight comes in.",
    },
  },
  glsl: prismGlsl,
  entry: "scenePrism",
  sim: prismSim(params),
  // Entrance: the sunbeam swings down onto the glass and the spectrum sweeps down the wall into place. Exit: the glass turns and the spectrum is thrown up the wall and off it.
  passage: { enter: PRISM_PASSAGE.enter, exit: PRISM_PASSAGE.exit },
};
