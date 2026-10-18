// The frost's layers (ADR 0062 Phase 3): their manifests, which load without their code (code.ts).
//   frostView   backdrop, a window: the room's shell. The window frame round the frame's edges and,
//               through the glass, out of focus and blurred further where the frost is thick, a
//               snowy street with lit windows and a street lamp or a cabin among snowy spruces,
//               under the World's sky and snow; drawn through the window's own camera, 1.8 m over
//               the street (D11), locked to the frost's rig (AT_THE_PANE). Its glass is the pane
//               inside the frame (roomGlass), the World's light comes in through it (its daylight).
//   frostGlass  dressing on a window's glass (`glass`: offered to every room whose window has glass,
//               the frost's own and the sill's): the fern frost, the fur between the fronds, the rime
//               along the glass's edges, the condensation, the lines a warm fingertip melts and the
//               traced M; lit by the room's light and by what shows through the glass. Its sim grows
//               the crystals and melts them, its four textures its fields.
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, seed, toggle } from "../../params.ts";
import { AT_THE_PANE } from "./constants.ts";

export const frostViewLayer: LayerDef = {
  id: "frostView",
  title: "Winter night",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: AT_THE_PANE,
  window: true,
  switch: toggle(
    "layers",
    "frostView",
    "winter night",
    false,
    "A window pane on a winter night in its painted frame: beyond the glass, out of focus, a snowy street or a cabin in the woods under the World's sky and snowfall.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "outside",
      "outside",
      "outside",
      [
        { label: "street", value: 0 },
        { label: "cabin", value: 1 },
      ],
      0,
      "What lies beyond the glass: a snowy street with lit windows and a street lamp, or a log cabin among snowy spruces.",
    ),
  ],
  groups: {
    outside: {
      title: "Outside",
      blurb: "The winter night beyond the glass, out of focus behind the frost.",
    },
  },
  passes: {
    begin: "frostViewBegin",
    far: "frostViewFar",
    daylight: "frostViewDaylight",
    glass: "frostViewGlass",
  },
};

export const frostGlassLayer: LayerDef = {
  id: "frostGlass",
  title: "Frost",
  composers: ["interior"],
  role: "dressing",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: {},
  glass: true,
  switch: toggle(
    "layers",
    "frostGlass",
    "frost",
    false,
    "Frost growing over the window's glass: fern fronds from its edges, a fine fur between them, thick rime in the corners; a warm fingertip melts lines through it.",
    { icon: "sparkle" },
  ),
  params: [
    range(
      "frost",
      "speed",
      "growth speed",
      1,
      "How fast the frost creeps over the glass: fern fronds first, then the finer frost between them.",
      { min: 0.2, max: 4, step: 0.1 },
    ),
    range(
      "frost",
      "style",
      "ferns or fur",
      0.35,
      "Left: clean fern fronds on clear glass. Right: a fine fur of frost soon filling in between them.",
    ),
    range(
      "frost",
      "sparkle",
      "sparkle",
      0.5,
      "How much the crystals glint where the light behind them catches their facets.",
    ),
    range(
      "frost",
      "condensation",
      "condensation",
      0.35,
      "A milky film of moisture on the glass, heaviest low down, softening the lights outside.",
    ),
    seed(
      "frost",
      "pattern",
      "pattern",
      "Where the frost takes hold; re-seed and a fresh pane frosts over from the start.",
    ),
    feature(
      "touch",
      "warmth",
      "warm touch",
      true,
      "warmth",
      0.5,
      "Hold and drag to warm the glass: your fingertip melts clear lines through the frost, which slowly grows back in from their edges. Warmer melts wider.",
    ),
    feature(
      "manifold",
      "mark",
      "traced M",
      false,
      "size",
      0.5,
      "An M written in the frost by a fingertip, frosting slowly over again; while on, it is traced afresh now and then.",
    ),
  ],
  groups: {
    frost: {
      title: "Frost",
      blurb: "How the frost grows across the glass and how it catches the light.",
    },
    touch: {
      title: "Touch",
      blurb: "Warm the glass with your fingertip and draw through the frost.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: an M traced in the frost with a fingertip.",
    },
  },
  triggers: ["mark"],
  mark: "mark",
  data: { fields: 4 },
  passes: { begin: "frostGlassBegin", farVeil: "frostGlassFarVeil" },
};
