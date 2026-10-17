// Hanging mobile: a solar system hung in a quiet room under a glowing Sun that is the room's lamp.
// Mercury to Neptune (with the Moon on the Earth's sub-arm, and Ceres and Pluto if asked for) ride
// balanced wire arms stacked down the Sun's axis, coupled pendulums that swing and rock in the air
// of the room, a draft from the window and its gusts, and knock when they crowd; a motor turns each
// arm at its planet's real period (the shared part sims/mobile.ts, with the wind conventions of
// sims/wind.ts; the layout in solar.ts, the room's air in sim.ts). The shader (shader.ts) traces the
// mobile, lights each planet from where the Sun is, and throws the mobile's shadows from the Sun onto
// the wall, the ceiling and the other planets.
import { choice, feature, range, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { MOBILE_PASSAGE, MOBILE_SUN } from "./constants.ts";
import { SOLAR_SETS } from "./solar.ts";

const params: readonly ParamDef[] = [
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
    { trigger: 0 },
  ),
  range(
    "air",
    "drift",
    "room air",
    0.5,
    "The room's slow currents: they keep the arms swaying a little, each its own way, even when the window is still.",
  ),
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
];

export const mobileScene: SceneDef = {
  id: "mobile",
  title: "Mobile",
  blurb:
    "A solar system hung under a glowing Sun, each planet turning at its own pace, its shadow wheeling across the wall.",
  accent: MOBILE_SUN,
  look: { color: "full", levels: 4 },
  params,
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
    light: {
      title: "Light",
      blurb: "The room, the Sun that lights it, and the window.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M of glow-in-the-dark stars on the wall.",
    },
  },
  code: () => import("./code.ts"),
  // The white room by day is pale: the page copy goes dark on it.
  theme: paletteTheme(params, "room", (index) => index === 1),
  // Entrance: lowered from above on the Sun's cord as the Sun lights up. Exit: the motors wind down,
  // the Sun cools and the mobile is hoisted away.
  passage: MOBILE_PASSAGE,
};
