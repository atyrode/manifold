// The late bar's layers (ADR 0062 Phase 3): their manifests, which load without their code
// (code.ts). Every one is drawn through the bar's own pinhole (shader.ts barBegin), so all are locked
// to its rig (IN_THE_BOOTH).
//   storefront  backdrop, the room's shell: the front wall and its tall window onto the rainy
//               street (the laundromat, the flats, the cars and the passers-by, the rain, the drops
//               on the pane, the jukebox reflected, the OPEN sign hanging inside), the column with
//               its sconce, the coat and the wet umbrella; the pressed-tin ceiling, the oak floor and
//               the back wall's bare panelling. The street is the window's own view, drawn through
//               the bar's camera under its own rain: it lists no World (see the README).
//   booth       ground: your table, the candle, the coffee and the whisky; nearest the eye, it paints
//               over all that stands in the room (its front veil).
//   backBar     dressing, the subject: the mirror wall with its shelves of bottles and the M, the
//               bartender, the counter and its glasses, the stools and the patrons coming and going;
//               its sim schedules the evening (one field).
//   pendants    dressing: the four green pendants over the counter and their light on the room.
//   ceilingFan  dressing: the fan turning under the tin, its bowl's light and the blades' shadows.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line, the table's far edge
// (README "The interior composer").
import type { LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, toggle, type Blurb } from "../../params.ts";
import { atmosphereGroups, weatherKnobs } from "../atmosphere.ts";
import { IN_THE_BOOTH } from "./constants.ts";

const LIGHT: Blurb = {
  title: "Light",
  blurb: "The lamps over the counter, the bottles behind it, the fan overhead.",
};

export const storefrontLayer: LayerDef = {
  id: "storefront",
  title: "Storefront",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: IN_THE_BOOTH,
  switch: toggle(
    "layers",
    "storefront",
    "storefront",
    false,
    "The bar's front wall and its tall window onto a rainy street at night, the column with a coat and a dripping umbrella on its hook, the pressed-tin ceiling and the oak floor.",
    { icon: "mountain" },
  ),
  params: [
    range(
      "street",
      "traffic",
      "window traffic",
      0.4,
      "How often cars crawl past outside and people walk by the window under their umbrellas. Now: a taxi goes by.",
    ),
    toggle(
      "street",
      "sign",
      "OPEN sign",
      true,
      "A neon OPEN sign hanging in the window, read from behind: it shines on the frame, the wet glass and the people passing, and reads the right way round in the mirror behind the bar. It goes dark at last call.",
    ),
    feature(
      "street",
      "jukebox",
      "jukebox",
      true,
      "glow",
      0.5,
      "A jukebox somewhere behind you, seen only as its reflection in the window: bubble tubes slowly changing colour. Now: someone drops a coin in and a new record starts.",
    ),
    // A gentle rain by default: steady enough to streak the street and bead the glass.
    ...weatherKnobs({ rain: true, wind: true, on: { rain: true } }).map((def) =>
      def.key === "rain" ? { ...def, value: 0.3 } : def,
    ),
    toggle(
      "weather",
      "drops",
      "drops on the glass",
      true,
      "Raindrops beading and running down the window, each holding a tiny bright picture of the street.",
      { when: "rain" },
    ),
  ],
  groups: {
    street: {
      title: "The window",
      blurb:
        "The street outside the front window, the sign hanging in it, and what the glass reflects.",
    },
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "Rain on the street outside: it streaks past the lamps and headlights, pools and splashes on the road, drips from the awning, beads the glass and leaves a wet umbrella dripping by the door; wind slants it.",
    },
  },
  triggers: ["traffic", "jukebox"],
  passes: { far: "storefrontFar", front: "storefrontFront" },
};

export const boothLayer: LayerDef = {
  id: "booth",
  title: "Your table",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: {
    anchors: [],
    // The table's top: the whisky, the candle and the coffee across its right, and off its left
    // edge nothing to stand on.
    claims: [
      {
        name: "the whisky, the candle and the coffee",
        kind: "exclusive",
        shape: { kind: "box", at: [0.4, 0], half: [0.32, 0.12] },
      },
      {
        name: "off the table's left edge",
        kind: "exclusive",
        shape: { kind: "box", at: [-0.5, 0], half: [0.44, 0.12] },
      },
    ],
  },
  camera: IN_THE_BOOTH,
  switch: toggle(
    "layers",
    "booth",
    "your table",
    false,
    "Your table in the corner booth: a candle in an amber glass, a coffee steaming, a whisky on the rocks.",
  ),
  params: [
    feature(
      "table",
      "candle",
      "candle",
      true,
      "flame",
      0.6,
      "A candle in an amber glass on your table, lighting the wood, the cup and the whisky. Sweep the pointer past it and the flame bends with the air you push, then rights itself.",
    ),
    feature(
      "table",
      "steam",
      "coffee steam",
      true,
      "amount",
      0.6,
      "Steam curling up from your coffee in slow ribbons.",
    ),
    toggle(
      "table",
      "whisky",
      "whisky",
      true,
      "A whisky on the rocks beside the candle: the ice catches the flame, the amber throws a small patch of light on the table, and now and then a cube settles.",
    ),
  ],
  groups: {
    table: { title: "Your table", blurb: "The candle, the coffee and the whisky in front of you." },
  },
  passes: { frontVeil: "boothFrontVeil" },
};

export const backBarLayer: LayerDef = {
  id: "backBar",
  title: "Back bar",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: IN_THE_BOOTH,
  switch: toggle(
    "layers",
    "backBar",
    "back bar",
    false,
    "A long counter with a leather rail before a mirrored back bar of glowing bottles; the bartender at work behind it, and people on the stools coming and going over the evening.",
    { icon: "sparkle" },
  ),
  params: [
    range(
      "bar",
      "night",
      "time of night",
      0.3,
      "Early in the evening the stools fill up and the lamps burn bright; toward last call people drift home one by one, the lights go down, the bartender wipes down the counter and the OPEN sign in the window goes dark. Now: last call. The bartender rings a brass hand bell and the lamps blink twice (with him off, someone in the back just flicks the lights); everyone at the bar looks up and takes a last sip, and some order one for the road, or, with nobody at the bar, he comes over to you. Then it is closing time: nobody new comes in, the room empties one by one, the lamps go down and the sign goes dark, until you move this slider.",
    ),
    choice(
      "bar",
      "patrons",
      "patrons",
      counts(0, 1, 2, 3, 4),
      3,
      "How many stools are taken on a busy evening. People come in out of the rain, order, sip, turn to talk to a neighbour or glance back at the window, and after a few minutes climb down and go home; someone new comes in a little later. Now: someone comes in.",
    ),
    toggle(
      "bar",
      "bartender",
      "bartender",
      true,
      "Behind the counter in his waistcoat: he polishes glasses, takes orders, turns to the shelf for a bottle and pours (its place on the shelf stays empty until he puts it back), shakes cocktails, clears and wipes. Click the bar and he comes over to you. Now: he shakes a cocktail.",
    ),
    range(
      "light",
      "bokeh",
      "bottle bokeh",
      0.5,
      "How far out of focus the bottles on the back bar are: crisp to the left; to the right soft, the lamps' glints on them swelling into round discs of light.",
    ),
    feature(
      "manifold",
      "mark",
      "Manifold M",
      true,
      "style",
      1,
      "The M on the back bar's upper mirror: etched into the glass and catching the lamps (now and then a glint of light runs along it), or a small amber neon doubled by its own reflection. Now: a glint, or a stutter.",
      {
        options: [
          { label: "etched", value: 1 },
          { label: "neon", value: 2 },
        ],
      },
    ),
  ],
  groups: {
    bar: {
      title: "The bar",
      blurb:
        "Who is in tonight and how late it is getting. Click the bar to call the bartender over.",
    },
    light: LIGHT,
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: the M on the back bar's mirror.",
    },
  },
  triggers: ["night", "patrons", "bartender", "mark"],
  mark: "mark",
  data: { fields: 1 },
  passes: { middle: "backBarMiddle", front: "backBarFront" },
};

export const pendantsLayer: LayerDef = {
  id: "pendants",
  title: "Pendant lamps",
  composers: ["interior"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: IN_THE_BOOTH,
  switch: toggle(
    "layers",
    "pendants",
    "pendant lamps",
    false,
    "Four green pendant lamps hanging over the counter, their warm light on the counter, the floor and the tin.",
  ),
  params: [
    range(
      "light",
      "warmth",
      "lamp warmth",
      0.65,
      "The pendant lamps' light: clean white to the left, deep amber tungsten to the right.",
    ),
  ],
  groups: { light: LIGHT },
  passes: { middle: "pendantsMiddle" },
};

export const ceilingFanLayer: LayerDef = {
  id: "ceilingFan",
  title: "Ceiling fan",
  composers: ["interior"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: IN_THE_BOOTH,
  switch: toggle(
    "layers",
    "ceilingFan",
    "ceiling fan",
    false,
    "A slow fan under the pressed-tin ceiling, its little bowl light sweeping the blades' shadows round the tin.",
  ),
  params: [
    feature(
      "light",
      "fan",
      "ceiling fan",
      true,
      "speed",
      0.35,
      "A fan turning lazily under the pressed-tin ceiling, its little bowl light sweeping the blades' shadows round the tin. Off, it stands still.",
    ),
  ],
  groups: { light: LIGHT },
  passes: { front: "ceilingFanFront" },
};
