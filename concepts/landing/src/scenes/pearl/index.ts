// A tank of rheoscopic (pearl) fluid: flakes suspended in it line up with the shear, so every
// current shows as satin bands, spirals and filaments. The flow and the flakes are simulated on the
// GPU in sim.ts (stable fluids, Jeffery's equation for the flakes) and lit by a lamp in shader.ts.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { pearlGlsl, pearlPalettes } from "./shader.ts";
import { pearlForcings, pearlSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("tank", "forcing", "currents", pearlForcings.map((label, value) => ({ label, value })), 0, "What keeps the fluid moving. Turntable: the tank slowly turns an eighth of a turn, rests and turns back; the fluid lags behind the glass and curls off its walls. Convection: the tank stands upright over a gentle heater; warm fluid rises in plumes and rolls over. Rods: three glass rods trade places in a slow braid, folding the fluid like taffy."),
  range("tank", "speed", "speed", 0.6, "How quickly everything moves: the currents, the turntable, the heater's plumes, the rods and the drifting eddies.", { min: 0.2, max: 2 }),
  range("tank", "drift", "drifting eddies", 0.5, "Slow eddies that wander through the tank on their own, as the room's warmth stirs it: they swell, fade and turn about, winding the satin into spirals and long ribbons at many sizes.", { min: 0, max: 1 }),
  range("tank", "vorticity", "eddies hold", 1.5, "How long small whirls hold together. Low: they melt into broad currents. High: they keep spinning, tight and curly.", { min: 0, max: 8, step: 0.5 }),
  feature("tank", "swirl", "centre swirl", true, "strength", 0.5, "Now and then a slow swirl wells up from the middle of the tank, turning one way then the other, and winds the sheen into a spiral.", { trigger: 0 }),
  seed("tank", "pour", "pour", "How the fluid was poured: its first currents and the flakes' first sheen. Re-seed for a fresh pour."),
  choice("light", "palette", "fluid", pearlPalettes.map((palette, value) => ({ label: palette.label, value })), 0, "Midnight: silver flakes in blue-black. Gold: gilt flakes in dark amber. Jade: pale flakes in deep green. Pearl: mother-of-pearl, white on dove grey (a light page)."),
  range("light", "lamp", "lamp", 120, "Where the lamp stands around the tank, in degrees. The flakes turned toward it glint and those edge-on to it go dark, so turning it swaps the bright and dark bands.", { min: 0, max: 180, step: 5 }),
  range("light", "contrast", "flake contrast", 0.35, "Left: soft, milky satin. Right: crisp bright and dark bands with a glint along their crests."),
  range("light", "nacre", "nacre", 0.5, "The rose and sea-green of mother-of-pearl along the flanks of each bright band."),
  feature("light", "pigment", "pigment", false, "flow", 0.5, "A fine glass nozzle drips pigment into the tank; the currents draw it out into a winding thread that slowly fades."),
  feature("manifold", "mark", "M stirring rod", false, "size", 0.5, "A glass rod writes the Manifold M through the fluid. The flakes keep it as a satin ribbon that the currents slowly unwind; while on, it is written again every couple of minutes.", { trigger: 1 }),
];

export const pearlScene: SceneDef = {
  id: "pearl",
  title: "Pearl",
  blurb: "A tank of pearlescent fluid: every current shows as satin.",
  accent: "#e0583a",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    tank: { title: "Tank", blurb: "What keeps the fluid moving, and how briskly. Drag across the page to stir it." },
    light: { title: "Flakes and light", blurb: "The fluid's colour and how its flakes catch the lamp." },
    manifold: { title: "Manifold M", blurb: "An M written through the fluid with a glass rod." },
  },
  glsl: pearlGlsl,
  entry: "scenePearl",
  sim: pearlSim(params),
  // Pearl is a light fluid: the page copy goes dark on it.
  theme: (values) => {
    const palette = values.palette ?? params.find((def) => def.key === "palette")?.value ?? 0;
    return pearlPalettes[Math.round(palette)]?.paper === true ? "paper" : "night";
  },
};
