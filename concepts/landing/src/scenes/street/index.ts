// A scramble crossing at dusk, seen from a high window: people gather at the kerbs, the lights
// turn, and everyone crosses at once, every way, while cars queue at the red and flow on the green
// under the shop signs. sim.ts walks the crowd, drives the traffic and runs the lights; shader.ts
// draws the street, the city round it and everyone in it.
import { feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { streetGlsl } from "./shader.ts";
import { STREET_PASSAGE, streetSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("crossing", "crowd", "crowd", 0.5, "How many people are out: a few late walkers, an evening's comings and goings, or a Friday-night crowd that floods every crosswalk at once when the lights turn."),
  range("crossing", "signal", "signal cycle", 80, "Seconds for the lights to come round: the avenue's traffic, then the side street's, then every crosswalk at once (diagonals too) until the green men flash. Now (or a click on the street): the lights change.", { min: 50, max: 120, step: 5, trigger: 0 }),
  feature("crossing", "outing", "school outing", true, "how often", 0.3, "Now and then a teacher leads a line of small children in yellow hats across, two by two, an assistant at the back; they wait at the kerb with everyone else. Now: one sets out.", { trigger: 1 }),
  seed("crossing", "streetSeed", "evening", "Who is out and which cars come by: re-seed for another evening at the crossing."),
  range("traffic", "traffic", "traffic", 0.5, "Cars, taxis, kei cars, vans and bicycles: they queue at the red with their brake lights on and flow on the green; eastbound cars turn into the side street, and the side street's turn out onto the avenue."),
  feature("traffic", "delivery", "late delivery", false, "how often", 0.4, "Now and then a white van comes along the avenue, crosses the junction and pulls in at the far kerb past the konbini, clear of the crossing. Its hazards blink while the driver wheels stacks of crates across the sidewalk to the shop's service door and back, a few trips; walkers step round the trolley, cyclists swing out round the van, and it pulls out when the lane behind is clear. How often: from about every ten minutes to every two. Now: one sets out.", { trigger: 2 }),
  range("city", "signs", "sign glow", 0.7, "How brightly the blade signs, the fascias, the konbini and the shop windows glow, and how much light they spill onto the sidewalks."),
  range("city", "windows", "lit windows", 0.5, "Windows lit in the rooms over the shops, switching on and off now and then; in the rain the wet street mirrors them too."),
  ...skyKnobs({ time: 0.81, stars: 0.55, moon: 1 }),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true }),
  toggle("manifold", "mark", "zebra M", false, "The diagonal crosswalks repainted as a V between the two straight ones, so that from up here the zebras spell the Manifold M across the crossing, in the accent colour; the crowd still crosses over it every way."),
];

export const streetScene: SceneDef = {
  id: "street",
  title: "City crossing",
  blurb: "A scramble crossing at dusk from a high window: the crowd gathers, the lights turn, everyone crosses at once.",
  accent: "#2fe0b0",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    crossing: { title: "Crossing", blurb: "The people and the lights. Hover the street and the people under the pointer look up at your window; click to change the lights." },
    traffic: { title: "Traffic", blurb: "What drives through between the crossings." },
    city: { title: "City", blurb: "The shops, signs and windows round the crossing." },
    sky: atmosphereGroups.sky,
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain opens the umbrellas one by one and turns the street into a mirror of signs, windows and lamps, streaked toward you; puddles ring, tyres throw spray, awnings drip. Snow settles everywhere but the wheel tracks and the trodden crosswalks." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the crossing's paint." },
  },
  glsl: streetGlsl,
  entry: "sceneStreet",
  sim: streetSim(params),
  // Entrance: the camera comes down from the skyline onto the crossing as the crowd walks in along its
  // sidewalks to gather. Exit: the camera tilts up to the skyline again (the rain follows the pitch).
  passage: STREET_PASSAGE,
  // The moon takes a phase (K_moon) in the shared sky: the windows and the wet street mirror it.
  features: { SKY_MOON_PHASE: 1 },
  // A sunlit street is bright paving and paint: the copy needs dark ink on it, from the time the
  // sun is about 12 degrees up until it sinks back there. With the day cycle running the light keeps
  // changing, so the page stays on the night theme. The shader repeats this test to turn its ink
  // dark on the paper theme: keep the two in step.
  theme: (values) => {
    const time = values.time ?? 0.81;
    const cycling = (values.cycle ?? 0) > 0.5;
    return !cycling && time > 0.33 && time < 0.67 ? "paper" : "night";
  },
};
