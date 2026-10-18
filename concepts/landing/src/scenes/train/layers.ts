// The night train's layers (ADR 0062 Phase 3): their manifests, which load without their code
// (code.ts). The compartment is drawn on the train's frame and the country through the view's own
// pinhole (shader.ts trainBegin), so all are locked to its rig (BY_THE_WINDOW).
//   nightLine      backdrop, the window's view: through the glass the country sliding past under
//                  the night sky (the far ridge and its village, the hills, the fields and farms, the
//                  river, the road and its cars, the poles, and the stations, crossings, bridges and
//                  tunnels the line passes), the rain driven along the pane, the snow banked at its
//                  foot, and the lit compartment mirrored in the glass. Its sim runs the journey
//                  (one field); its knobs are the journey's, the line's, the country's, the sky's and
//                  the weather's: the view keeps its own sky, so the room lists no World.
//   compartment    ground: round the glass, its seal and cream-enamelled frame, the laminate wall,
//                  the curtain rod and the walnut table under the window, lit by the reading lamp.
//   teaGlass       dressing: the glass of tea in its silver holder on the table, and its steam.
//   velvetCurtain  dressing: the red velvet curtain gathered at the window's edge.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line, the table's back edge
// (README "The interior composer").
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, seed, toggle, type Blurb } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import { BY_THE_WINDOW, TRAIN_LINES } from "./constants.ts";

const COMPARTMENT: Blurb = {
  title: "Compartment",
  blurb:
    "Your side of the glass: the reading lamp, its reflection, the glass of tea and the curtain.",
};

/** The shared moon in its phase (K_moon); the shared clouds' calm deck (its own cover and light). */
const SKY_GATES = { SKY_MOON_PHASE: 1, CLOUD_TIER: CLOUD_TIERS.flat } as const;

export const nightLineLayer: LayerDef = {
  id: "nightLine",
  title: "Night line",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: BY_THE_WINDOW,
  switch: toggle(
    "layers",
    "nightLine",
    "night line",
    false,
    "The country sliding past a train's window at night: fields and farms with lit windows, a river catching the moon, hills, a village at the foot of the mountains, and now and then a station, a level crossing, a bridge or a tunnel.",
    { icon: "mountain" },
  ),
  params: [
    range(
      "journey",
      "speed",
      "speed",
      0.4,
      "How fast the train runs, from a crawl to an express; the default is a slow night train, about 43 km/h. Near things blur past and the wires dip and rise quicker, the wheels clack faster, the far hills hardly move.",
      { min: 0.1, max: 1 },
    ),
    range(
      "journey",
      "rhythm",
      "rail rhythm",
      0.5,
      "How hard the wheels knock over the rail joints, da-dum ... da-dum: the tea shivers in rings, the spoon rattles, the lamp's reflection trembles and the carriage rocks the curtain. Low: smooth welded rails.",
    ),
    seed(
      "journey",
      "route",
      "route",
      "The country along the line (hills, fields, farms, the river) and where the journey starts; re-seed for another line.",
    ),
    choice(
      "journey",
      "line",
      "line",
      TRAIN_LINES,
      0,
      "The country the line runs through, and what passes the window there (the frequencies below still say how often). Country: the night line as it always ran, through farmland and forested hills, a station now and then, level crossings, an iron bridge over a valley, a tunnel through a hill. Rural: a slower branch line across low, open farmland, farms and hedgerow trees all round; short halts where the train all but stops, most with a farm road crossing at the platform's end, crossings everywhere, little girder bridges over streams, no tunnels. Mountain: climbing slowly under high snowy peaks, through forest and alpine pasture; long tunnels, often straight out of one onto a stone viaduct over a deep gorge and into the next, few stations, hardly a road to cross. Changing it starts a fresh journey.",
    ),
    feature(
      "line",
      "stations",
      "stations",
      true,
      "frequency",
      0.5,
      "Now and then a small country station: the train slows right down and the platform glides past under its lamps, the station house with its lit waiting room, a clock under the canopy, a passenger waiting, the stationmaster with his lamp. Now: the next stop.",
    ),
    feature(
      "line",
      "crossings",
      "level crossings",
      true,
      "frequency",
      0.5,
      "A road across the line: the flashers wig-wag red (a bell you can see), a car waits at the lowered barrier with its lights on you, and the road runs off into the fields under its lamps. Now: one just ahead.",
    ),
    feature(
      "line",
      "bridges",
      "bridges",
      true,
      "frequency",
      0.4,
      "Over a valley on an old iron bridge, slowly: girders flicking past the window and between them the river far below, winding away under the mist. Now: a bridge.",
    ),
    feature(
      "line",
      "tunnels",
      "tunnels",
      true,
      "frequency",
      0.35,
      "Into a hill: rock walls rise beside the line, then the dark, the tunnel wall streaming past an arm's length away, and the window turns into a mirror of the compartment and your own face. Now: a tunnel.",
    ),
    feature(
      "line",
      "cars",
      "cars",
      true,
      "traffic",
      0.4,
      "Cars on the country road alongside, headlights sweeping the road ahead; now and then one keeps pace with the train for a while before it falls behind or pulls away. Now: a car overtakes.",
    ),
    feature(
      "country",
      "lights",
      "lit windows",
      true,
      "lit",
      0.4,
      "Lights in the night: farmhouse windows, a village strung along the foot of the mountains, a farm high on the hills, a radio mast's slow red blink. How many windows are lit.",
    ),
    toggle(
      "country",
      "river",
      "river",
      true,
      "A river that comes alongside the line for a while, the moon breaking on it in a long path of glints and the far bank's trees mirrored, then wanders off across the fields.",
    ),
    ...birdKnobs({
      kind: "mixed",
      mixed:
        "the line's own: rooks and skeins of geese over the country line; rooks, swallows low over the fields, gulls and pigeons on the rural line; choughs, swifts and a buzzard circling in the mountains.",
      help: "Birds crossing the country outside by day, from the fields to the far hills: nearer trees, houses and hills hide them, and a party swoops down over the fields now and then. None at night, fewer in snow, none in steady rain.",
    }),
    ...skyKnobs({
      time: 0.15,
      stars: 0.75,
      moon: 1,
      constellations: true,
    }),
    feature(
      "weather",
      "clouds",
      "clouds",
      true,
      "cover",
      0.3,
      "A deck of cloud drifting back over the train, silvered round the moon. Rain or snow closes it over, low and grey, whatever the cover.",
    ),
    feature(
      "sky",
      "meteors",
      "shooting stars",
      true,
      "frequency",
      0.3,
      "Now and then a shooting star streaks across the window's patch of sky. Now: one.",
    ),
    ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, aurora: true }),
    toggle(
      "weather",
      "streaks",
      "rain on the glass",
      true,
      "Raindrops driven back along the pane by the air the train pushes through: they run aft and a little down, flatter the faster it goes, steeply down as it slows for a station, and leave trails of beads. In a tunnel the glass clears.",
      { when: "rain" },
    ),
    feature(
      "manifold",
      "mark",
      "M stars",
      false,
      "brightness",
      0.8,
      "Five bright stars in the shape of the Manifold M, up to the right of the moon, with the faintest chart lines between them; the stations' name boards carry the M too.",
    ),
  ],
  groups: {
    journey: {
      title: "Journey",
      blurb:
        "How fast the train runs, how the rails knock, and which line it runs on. Move the pointer to lean toward the glass; click to knock on the table.",
    },
    line: {
      title: "Along the line",
      blurb:
        "What the train passes now and then, and how often: stations, level crossings, bridges, tunnels, and the cars on the road alongside.",
    },
    country: {
      title: "Country",
      blurb:
        "The land outside: lit windows in the night, and the river that comes and goes alongside.",
    },
    birds: birdsGroup,
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night over the line: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "A deck of cloud drifts back over the train. Rain closes the sky, wets the land (the platforms and roads shine with the lamps) and is driven back along the pane; snow streams past the window and settles on the fields, the roofs and the foot of the glass. Fog lies in the hollows; the train's own speed slants whatever falls.",
    },
    manifold: {
      title: "Manifold mark",
      blurb:
        "A landmark of its own: the M as a constellation over the country, and on the stations' boards.",
    },
  },
  triggers: ["stations", "crossings", "bridges", "tunnels", "cars", "meteors"],
  mark: "mark",
  featuresFor: () => ({ ...SKY_GATES }),
  featuresAll: SKY_GATES,
  data: { fields: 1 },
  passes: { far: "nightLineFar" },
};

export const compartmentLayer: LayerDef = {
  id: "compartment",
  title: "Compartment",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: {
    anchors: [],
    // The glass of tea on the table, right of the middle.
    claims: [
      {
        name: "the glass of tea",
        kind: "exclusive",
        shape: { kind: "box", at: [0.22, 0], half: [0.06, 0.08] },
      },
    ],
  },
  camera: BY_THE_WINDOW,
  switch: toggle(
    "layers",
    "compartment",
    "compartment",
    false,
    "A night train's compartment round its big window: the cream-enamelled frame, the warm laminate wall, a walnut table under the glass, and the reading lamp above your seat.",
  ),
  params: [
    range(
      "compartment",
      "lamp",
      "reading lamp",
      0.7,
      "The warm lamp above your seat: it lights the wall, the table and the tea, and shows in the glass. Low: a dark compartment, and the night outside comes clearer.",
    ),
    range(
      "compartment",
      "reflection",
      "reflections",
      0.5,
      "How strongly the window mirrors the lit compartment over the night: the lamp, the luggage rack, the seats, your own dark head (it leans as you move the pointer). In a tunnel the glass becomes a mirror.",
    ),
  ],
  groups: { compartment: COMPARTMENT },
  passes: { ground: "compartmentGround" },
};

export const teaGlassLayer: LayerDef = {
  id: "teaGlass",
  title: "Glass of tea",
  composers: ["interior"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: BY_THE_WINDOW,
  switch: toggle(
    "layers",
    "teaGlass",
    "glass of tea",
    false,
    "A glass of tea in a silver holder on the table, trembling at every clack of the rails.",
    { icon: "sparkle" },
  ),
  params: [
    feature(
      "compartment",
      "tea",
      "glass of tea",
      true,
      "steam",
      0.5,
      "A glass of tea in a silver holder, a slice of lemon, a spoon: the surface rings at every clack and sloshes as the train brakes, and the tea glows amber when lamps pass behind it. Click to knock on the table. The amount is how much it steams.",
    ),
  ],
  groups: { compartment: COMPARTMENT },
  passes: { front: "teaGlassFront" },
};

export const velvetCurtainLayer: LayerDef = {
  id: "velvetCurtain",
  title: "Velvet curtain",
  composers: ["interior"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: BY_THE_WINDOW,
  switch: toggle(
    "layers",
    "velvetCurtain",
    "velvet curtain",
    false,
    "A red velvet curtain gathered at the window's edge, swaying with the carriage.",
  ),
  params: [
    feature(
      "compartment",
      "curtain",
      "curtain",
      true,
      "sway",
      0.5,
      "A red velvet curtain gathered at the window's edge, swaying with the carriage's rocking and swinging forward as the train brakes.",
    ),
  ],
  groups: { compartment: COMPARTMENT },
  passes: { front: "velvetCurtainFront" },
};
