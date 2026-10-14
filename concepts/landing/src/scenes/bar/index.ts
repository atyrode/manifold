// A quiet bar late at night, seen from a corner booth while it rains outside: a long counter under
// green pendant lamps, bottles glowing on the back bar in front of a mirror that doubles the room,
// a bartender at work, a few people on the stools coming and going over the evening, a slow fan
// under a pressed-tin ceiling, the street through the rain-streaked front window, and your table
// with a candle, a coffee and a whisky. The picture is shader.ts; who comes and goes and what the
// bartender does is scheduled on the CPU in sim.ts (uSim0).
import { choice, counts, feature, range, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { barGlsl } from "./shader.ts";
import { barSim, PASSAGE } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("bar", "night", "time of night", 0.3, "Early in the evening the stools fill up and the lamps burn bright; toward last call people drift home one by one, the lights go down, the bartender wipes down the counter and the OPEN sign in the window goes dark. Now: last call. The bartender rings a brass hand bell and the lamps blink twice (with him off, someone in the back just flicks the lights); everyone at the bar looks up and takes a last sip, and some order one for the road, or, with nobody at the bar, he comes over to you. Then it is closing time: nobody new comes in, the room empties one by one, the lamps go down and the sign goes dark, until you move this slider.", { trigger: 5 }),
  choice("bar", "patrons", "patrons", counts(0, 1, 2, 3, 4), 3, "How many stools are taken on a busy evening. People come in out of the rain, order, sip, turn to talk to a neighbour or glance back at the window, and after a few minutes climb down and go home; someone new comes in a little later. Now: someone comes in.", { trigger: 4 }),
  toggle("bar", "bartender", "bartender", true, "Behind the counter in his waistcoat: he polishes glasses, takes orders, turns to the shelf for a bottle and pours (its place on the shelf stays empty until he puts it back), shakes cocktails, clears and wipes. Click the bar and he comes over to you. Now: he shakes a cocktail.", { trigger: 0 }),
  range("light", "warmth", "lamp warmth", 0.65, "The pendant lamps' light: clean white to the left, deep amber tungsten to the right."),
  range("light", "bokeh", "bottle bokeh", 0.5, "How far out of focus the bottles on the back bar are: crisp to the left; to the right soft, the lamps' glints on them swelling into round discs of light."),
  feature("light", "fan", "ceiling fan", true, "speed", 0.35, "A fan turning lazily under the pressed-tin ceiling, its little bowl light sweeping the blades' shadows round the tin. Off, it stands still."),
  feature("table", "candle", "candle", true, "flame", 0.6, "A candle in an amber glass on your table, lighting the wood, the cup and the whisky. Sweep the pointer past it and the flame bends with the air you push, then rights itself."),
  feature("table", "steam", "coffee steam", true, "amount", 0.6, "Steam curling up from your coffee in slow ribbons."),
  toggle("table", "whisky", "whisky", true, "A whisky on the rocks beside the candle: the ice catches the flame, the amber throws a small patch of light on the table, and now and then a cube settles."),
  range("street", "traffic", "window traffic", 0.4, "How often cars crawl past outside and people walk by the window under their umbrellas. Now: a taxi goes by.", { trigger: 1 }),
  toggle("street", "sign", "OPEN sign", true, "A neon OPEN sign hanging in the window, read from behind: it shines on the frame, the wet glass and the people passing, and reads the right way round in the mirror behind the bar. It goes dark at last call."),
  feature("street", "jukebox", "jukebox", true, "glow", 0.5, "A jukebox somewhere behind you, seen only as its reflection in the window: bubble tubes slowly changing colour. Now: someone drops a coin in and a new record starts.", { trigger: 2 }),
  // A gentle rain by default: steady enough to streak the street and bead the glass.
  ...weatherKnobs({ rain: true, wind: true, on: { rain: true } }).map((def) => (def.key === "rain" ? { ...def, value: 0.3 } : def)),
  toggle("weather", "drops", "drops on the glass", true, "Raindrops beading and running down the window, each holding a tiny bright picture of the street.", { when: "rain" }),
  feature("manifold", "mark", "Manifold M", true, "style", 1, "The M on the back bar's upper mirror: etched into the glass and catching the lamps (now and then a glint of light runs along it), or a small amber neon doubled by its own reflection. Now: a glint, or a stutter.", {
    trigger: 3,
    options: [
      { label: "etched", value: 1 },
      { label: "neon", value: 2 },
    ],
  }),
];

export const barScene: SceneDef = {
  id: "bar",
  title: "Late bar",
  blurb: "A quiet bar late at night, seen from a corner booth while it rains outside.",
  accent: "#ffb347",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    bar: { title: "The bar", blurb: "Who is in tonight and how late it is getting. Click the bar to call the bartender over." },
    light: { title: "Light", blurb: "The lamps over the counter, the bottles behind it, the fan overhead." },
    table: { title: "Your table", blurb: "The candle, the coffee and the whisky in front of you." },
    street: { title: "The window", blurb: "The street outside the front window, the sign hanging in it, and what the glass reflects." },
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain on the street outside: it streaks past the lamps and headlights, pools and splashes on the road, drips from the awning, beads the glass and leaves a wet umbrella dripping by the door; wind slants it." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the M on the back bar's mirror." },
  },
  glsl: barGlsl,
  // You sit down in the booth: the view lowers and turns to rest, the bartender looks up from his
  // glass and nods, the fan starts turning, the lamps warm up a little. Leaving, you stand: the view
  // rises and turns to the door as he gives a small wave.
  passage: PASSAGE,
  entry: "sceneBar",
  sim: barSim(params),
};
