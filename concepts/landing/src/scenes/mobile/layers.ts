// The mobile's layers (ADR 0062 Phase 3): their manifests, which load without their code (code.ts).
// Both are drawn through the mobile's own pinhole (shader.ts mobileBegin), so both are locked to its
// rig (UNDER_THE_SUN).
//   quietRoom    backdrop, the room's shell: the plaster wall and its skirting, the oak floor, the
//                ceiling, the window's dim light on the right, the M of glow-in-the-dark stars on the
//                wall, and the night room falling away into the dark toward the picture's edges. Its
//                surfaces take the Sun's light through `localLight` (the mobile's declared light).
//   solarMobile  dressing, the subject: the Sun on its cord and the rose it hangs from, the arms,
//                wires and links, the planets and Saturn's rings, the Sun's glow in the air; its sim
//                (the air, the motors, the passage's pose) its one field. The Sun is its light, and its
//                shapes stop it (`rayCasters`): the quiet room's wall, floor and ceiling take the
//                mobile's shadows through `roomRayCaster`.
// Space: the room is the mobile's, in its own metres; the quiet room claims the floor along the wall,
// so no guest drawn on the frame (the lava lamp) stands in it.
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { UNDER_THE_SUN } from "./constants.ts";
import { SOLAR_SETS } from "./solar.ts";

export const quietRoomLayer: LayerDef = {
  id: "quietRoom",
  title: "Quiet room",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: {
    anchors: [],
    // The room is drawn in the mobile's own metres, which nothing drawn on the frame shares.
    claims: [
      {
        name: "the floor under the mobile",
        kind: "exclusive",
        shape: { kind: "box", at: [0, 0], half: [0.5, 0.5] },
      },
    ],
  },
  camera: UNDER_THE_SUN,
  switch: toggle(
    "layers",
    "quietRoom",
    "quiet room",
    false,
    "A quiet room: a plaster wall, an oak floor and a plain ceiling, a window somewhere on the right.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "light",
      "room",
      "room",
      [
        { label: "night", value: 0 },
        { label: "daylight", value: 1 },
      ],
      0,
      "A dark room lit by the Sun, its shadows crisp on the wall, or a white room in daylight, its shadows pale.",
    ),
    feature(
      "light",
      "fill",
      "window light",
      true,
      "strength",
      0.35,
      "A dim light from a window on the right, cool at night and warm by day, so the room and the planets' night sides still show.",
    ),
    feature(
      "manifold",
      "mark",
      "M of stars",
      false,
      "glow",
      0.6,
      "Glow-in-the-dark stars stuck on the wall in the shape of the Manifold M: pale where the Sun lights them, glowing green in the planets' shadows and the dark.",
    ),
  ],
  groups: {
    // The solar system's Sun and soft shadows stand here too: the section stays with the room, which
    // always stands, and those two knobs hide with the solar system.
    light: {
      title: "Light",
      blurb: "The room, the Sun that lights it, and the window.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M of glow-in-the-dark stars on the wall.",
    },
  },
  mark: "mark",
  passes: { far: "quietRoomFar", frontVeil: "quietRoomFrontVeil" },
};

export const solarMobileLayer: LayerDef = {
  id: "solarMobile",
  title: "Solar system",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: UNDER_THE_SUN,
  switch: toggle(
    "layers",
    "solarMobile",
    "solar system",
    false,
    "A mobile of the solar system hung under a glowing Sun, each planet on a balanced arm of its own, its shadow wheeling across the wall.",
    { icon: "sparkle" },
  ),
  params: [
    choice(
      "mobile",
      "planets",
      "planets",
      SOLAR_SETS.map((set, value) => ({ label: set.label, value })),
      1,
      "Which bodies hang under the Sun: the four inner planets and the Moon; all eight planets; or with the dwarf planets Ceres, between Mars and Jupiter, and Pluto beyond Neptune. Each has an arm of its own, farther out the farther it is from the Sun.",
    ),
    feature(
      "mobile",
      "motor",
      "motor",
      true,
      "speed",
      0.5,
      "A motor turns each arm once in its planet's year, at the real ratios (a year grows as the distance to the power 1.5): at the middle the Earth goes round in about a minute, Mercury four times as often, Mars about half as often, Jupiter once in twelve, and Saturn and beyond hardly seem to move. The Moon goes round the Earth thirteen times a year. Off: the arms only turn as the air takes them.",
      { min: 0.05, max: 1 },
    ),
    range(
      "mobile",
      "clearance",
      "clearance",
      1,
      "How far each arm hangs below the one above: a compact mobile to the left, where planets and arms knock and push each other round as they pass, a tall one to the right.",
      { min: 0.5, max: 1.5 },
    ),
    range(
      "air",
      "wind",
      "draft",
      0.15,
      "Air from a window to the left or the right, and how strongly it comes: the planets lean and rock in it, and the gusts come from that side.",
      { min: -1, max: 1 },
    ),
    feature(
      "air",
      "gusts",
      "gusts",
      true,
      "strength",
      0.5,
      "Now and then a gust from the window crosses the room: the arms swing and rock, a motor is set back for a moment, and the mobile takes a while to settle. Higher: stronger and more often. Now: a gust.",
    ),
    range(
      "air",
      "drift",
      "room air",
      0.5,
      "The room's slow currents: they keep the arms swaying a little, each its own way, even when the window is still.",
    ),
    range(
      "light",
      "sun",
      "Sun",
      0.5,
      "How brightly the Sun shines: the light on the planets' day sides and the warm pool it throws on the wall.",
    ),
    range(
      "light",
      "softness",
      "soft shadows",
      0.4,
      "How big the light inside the Sun is: a small bulb throws crisp shadows, the whole glowing globe soft ones, the more the farther a planet hangs from the wall.",
    ),
  ],
  groups: {
    mobile: {
      title: "Solar system",
      blurb:
        "Which planets hang under the Sun, the motor that turns them at their real periods, and how much room each arm has. Click a planet to blow on it.",
    },
    air: {
      title: "Air",
      blurb: "The draft from the window, its gusts, and the room's slow currents.",
    },
  },
  triggers: ["gusts"],
  lights: [{ name: "the Sun", glsl: "solarMobileSun" }],
  rayCasters: ["solarMobileCaster"],
  data: { fields: 1 },
  passes: { begin: "solarMobileBegin", middle: "solarMobileMiddle" },
};
