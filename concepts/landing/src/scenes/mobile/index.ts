// Hanging mobile: a Calder mobile turning in the air of a quiet room, its shadows thrown large across
// the wall behind it. Balanced wire arms hang one from another on links, coupled pendulums that swing,
// rock and turn; a draft from the window, its gusts and the room's slow currents push on the plates,
// which knock against each other when the arms crowd (the shared part sims/mobile.ts, with the wind
// conventions of sims/wind.ts; the room's air in sim.ts). The shader (shader.ts) traces the mobile and
// the shadows it throws from one or two lights onto the wall, the floor and itself.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { MOBILE_PASSAGE } from "./layout.ts";
import { MOBILE_RED, mobilePaints, mobileSceneGlsl } from "./shader.ts";
import { mobileSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice(
    "mobile",
    "arms",
    "arms",
    counts(3, 4, 5, 6, 7),
    5,
    "How many arms hang one from another. Each balances what hangs from its two ends on a loop of wire, and is a little smaller than the one above.",
  ),
  choice(
    "mobile",
    "shapes",
    "plates",
    [
      { label: "leaves", value: 0 },
      { label: "discs", value: 1 },
      { label: "mixed", value: 2 },
    ],
    2,
    "What the plates are cut as: leaves, drops and crescents; plain discs; or all of them.",
  ),
  choice(
    "mobile",
    "palette",
    "paint",
    mobilePaints.map((paint, value) => ({ label: paint.label, value })),
    0,
    "Black, red, yellow, blue and white; black with one red; white; or polished brass catching the light.",
  ),
  range(
    "mobile",
    "clearance",
    "clearance",
    1,
    "How far each arm hangs below the one above: a compact mobile to the left, a tall one whose arms swing wider to the right. Wherever plates and wires meet as the arms turn, they knock and push each other round instead of passing through.",
    { min: 0.5, max: 1.5 },
  ),
  seed(
    "mobile",
    "mobileSeed",
    "design",
    "How the arms branch, how long each is, and the plates' shapes, sizes and colours; re-seed for another mobile.",
  ),
  range(
    "air",
    "wind",
    "draft",
    0.15,
    "Air from a window to the left or the right, and how strongly it comes: the stronger it blows, the faster the arms turn in it, and the gusts come from that side.",
    { min: -1, max: 1 },
  ),
  feature(
    "air",
    "gusts",
    "gusts",
    true,
    "strength",
    0.5,
    "Now and then a gust from the window crosses the room: the arms swing and spin, and take a while to settle. Higher: stronger and more often. Now: a gust.",
    { trigger: 0 },
  ),
  range(
    "air",
    "drift",
    "room air",
    0.5,
    "The room's slow currents: they keep the arms turning, each its own way, even when the window is still.",
  ),
  choice(
    "light",
    "room",
    "room",
    [
      { label: "lamp at night", value: 0 },
      { label: "daylight", value: 1 },
    ],
    0,
    "A dark room with a spotlight on a stand throwing crisp shadows on the wall, or a white room in daylight, its shadows soft and pale.",
  ),
  range(
    "light",
    "lamp",
    "light from",
    0.15,
    "Where the light stands, from far left to far right: the shadows fall across the wall the other way.",
  ),
  range(
    "light",
    "softness",
    "soft shadows",
    0.3,
    "How big the light is: a small bulb throws crisp shadows, a large one blurs their edges, the more the farther a plate hangs from the wall.",
  ),
  feature(
    "light",
    "fill",
    "second light",
    true,
    "strength",
    0.35,
    "A dimmer light from a window on the right, cool at night and warm by day, throws a second, paler shadow: where the two shadows part, each takes the other light's colour.",
  ),
  feature(
    "manifold",
    "mark",
    "M plate",
    false,
    "size",
    0.5,
    "The plate at the tip of the mobile is cut as the Manifold M, in red, and throws an M on the wall.",
  ),
];

export const mobileScene: SceneDef = {
  id: "mobile",
  title: "Mobile",
  blurb:
    "A Calder mobile turning in the air of a quiet room, its shadows wheeling across the wall.",
  accent: MOBILE_RED,
  look: { color: "full", levels: 4 },
  params,
  groups: {
    mobile: {
      title: "Mobile",
      blurb:
        "How many arms, how the plates are cut and painted, and how much room each arm has to turn. Click a plate to blow on it.",
    },
    air: {
      title: "Air",
      blurb: "The draft from the window, its gusts, and the room's slow currents.",
    },
    light: {
      title: "Light",
      blurb: "The room, and the lights that throw the shadows on the wall.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M cut from red sheet at the tip of the mobile.",
    },
  },
  glsl: mobileSceneGlsl,
  entry: "sceneMobile",
  sim: mobileSim(params),
  // The white room by day is pale: the page copy goes dark on it.
  theme: paletteTheme(params, "room", (index) => index === 1),
  // Entrance: lowered from the ceiling on its link, bobbing once as it stops. Exit: hoisted back up.
  passage: MOBILE_PASSAGE,
};
