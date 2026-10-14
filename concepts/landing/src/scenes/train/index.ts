// The night train: the view from a seat by the window of a slow night train. A glass of tea on the
// table trembles at every clack of the rails, the curtain sways with the carriage, the lamp shows in
// the glass; outside, the country slides past in depth under the moon (telegraph poles whipping by,
// fields and farms with lit windows, a river catching the moonlight, hills, a village at the foot of
// the mountains), and now and then a station glides past under its lamps, a level crossing flashes,
// a bridge's girders flick by over a misty valley, or a tunnel turns the window into a mirror.
// sim.ts runs the journey (distance, speed, the timetable, the cars alongside); shader.ts paints it.
// The passage is the line's own: the train comes out of a tunnel (dark wall streaming past, the
// mouth sweeping by, the cutting's rock sinking away to open the country, the tea settling from the
// jolt) and, leaving, runs into one.
import { feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { trainGlsl } from "./shader.ts";
import { TRAIN_PASSAGE, trainSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("journey", "speed", "speed", 0.4, "How fast the train runs, from a crawl to an express; the default is a slow night train, about 43 km/h. Near things blur past and the wires dip and rise quicker, the wheels clack faster, the far hills hardly move.", { min: 0.1, max: 1 }),
  range("journey", "rhythm", "rail rhythm", 0.5, "How hard the wheels knock over the rail joints, da-dum ... da-dum: the tea shivers in rings, the spoon rattles, the lamp's reflection trembles and the carriage rocks the curtain. Low: smooth welded rails."),
  seed("journey", "route", "route", "The country along the line (hills, fields, farms, the river) and where the journey starts; re-seed for another line."),
  feature("line", "stations", "stations", true, "frequency", 0.5, "Now and then a small country station: the train slows right down and the platform glides past under its lamps, the station house with its lit waiting room, a clock under the canopy, a passenger waiting, the stationmaster with his lamp. Now: the next stop.", { trigger: 0 }),
  feature("line", "crossings", "level crossings", true, "frequency", 0.5, "A road across the line: the flashers wig-wag red (a bell you can see), a car waits at the lowered barrier with its lights on you, and the road runs off into the fields under its lamps. Now: one just ahead.", { trigger: 1 }),
  feature("line", "bridges", "bridges", true, "frequency", 0.4, "Over a valley on an old iron bridge, slowly: girders flicking past the window and between them the river far below, winding away under the mist. Now: a bridge.", { trigger: 2 }),
  feature("line", "tunnels", "tunnels", true, "frequency", 0.35, "Into a hill: rock walls rise beside the line, then the dark, the tunnel wall streaming past an arm's length away, and the window turns into a mirror of the compartment and your own face. Now: a tunnel.", { trigger: 3 }),
  feature("line", "cars", "cars", true, "traffic", 0.4, "Cars on the country road alongside, headlights sweeping the road ahead; now and then one keeps pace with the train for a while before it falls behind or pulls away. Now: a car overtakes.", { trigger: 4 }),
  feature("country", "lights", "lit windows", true, "lit", 0.4, "Lights in the night: farmhouse windows, a village strung along the foot of the mountains, a farm high on the hills, a radio mast's slow red blink. How many windows are lit."),
  toggle("country", "river", "river", true, "A river that comes alongside the line for a while, the moon breaking on it in a long path of glints and the far bank's trees mirrored, then wanders off across the fields."),
  range("compartment", "lamp", "reading lamp", 0.7, "The warm lamp above your seat: it lights the wall, the table and the tea, and shows in the glass. Low: a dark compartment, and the night outside comes clearer."),
  range("compartment", "reflection", "reflections", 0.5, "How strongly the window mirrors the lit compartment over the night: the lamp, the luggage rack, the seats, your own dark head (it leans as you move the pointer). In a tunnel the glass becomes a mirror."),
  feature("compartment", "tea", "glass of tea", true, "steam", 0.5, "A glass of tea in a silver holder, a slice of lemon, a spoon: the surface rings at every clack and sloshes as the train brakes, and the tea glows amber when lamps pass behind it. Click to knock on the table. The amount is how much it steams."),
  feature("compartment", "curtain", "curtain", true, "sway", 0.5, "A red velvet curtain gathered at the window's edge, swaying with the carriage's rocking and swinging forward as the train brakes."),
  ...skyKnobs({ time: 0.15 }),
  feature("sky", "clouds", "clouds", true, "cover", 0.3, "A deck of cloud drifting back over the train, silvered round the moon. Rain or snow closes it over, low and grey, whatever the cover."),
  feature("sky", "meteors", "shooting stars", true, "frequency", 0.3, "Now and then a shooting star streaks across the window's patch of sky. Now: one.", { trigger: 5 }),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, aurora: true }),
  toggle("weather", "streaks", "rain on the glass", true, "Raindrops driven back along the pane by the air the train pushes through: they run aft and a little down, flatter the faster it goes, steeply down as it slows for a station, and leave trails of beads. In a tunnel the glass clears.", { when: "rain" }),
  feature("manifold", "mark", "M stars", false, "brightness", 0.8, "Five bright stars in the shape of the Manifold M, up to the right of the moon, with the faintest chart lines between them; the stations' name boards carry the M too."),
];

export const trainScene: SceneDef = {
  id: "train",
  title: "Night train",
  blurb: "The view from a slow night train: tea trembling with the rails, the country sliding by under the moon.",
  accent: "#ffae4a",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    journey: { title: "Journey", blurb: "How fast the train runs, how the rails knock, and which line it runs on. Move the pointer to lean toward the glass; click to knock on the table." },
    line: { title: "Along the line", blurb: "What the train passes now and then, and how often: stations, level crossings, bridges, tunnels, and the cars on the road alongside." },
    country: { title: "Country", blurb: "The land outside: lit windows in the night, and the river that comes and goes alongside." },
    compartment: { title: "Compartment", blurb: "Your side of the glass: the reading lamp, its reflection, the glass of tea and the curtain." },
    sky: atmosphereGroups.sky,
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain closes the sky, wets the land (the platforms and roads shine with the lamps) and is driven back along the pane; snow streams past the window and settles on the fields, the roofs and the foot of the glass. Fog lies in the hollows; the train's own speed slants whatever falls." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the M as a constellation over the country, and on the stations' boards." },
  },
  glsl: trainGlsl,
  entry: "sceneTrain",
  sim: trainSim(params),
  // Entrance: out of a tunnel into the night country, the tea settling from the jolt. Exit: into a tunnel.
  passage: TRAIN_PASSAGE,
};
