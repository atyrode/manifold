// A window pane on a winter night, frosting over: fern frost grown on the CPU (sim.ts: the
// branches and their fur in uSim0 and uSim3; the shader adds their feathery barbs, the rime along
// the frame and the glints), melted by a warm fingertip and refreezing (uSim1), on a growth clock
// (uSim2) that opens on a pane already frosted along its bottom. Behind the glass, out of focus:
// a snowy street or a cabin in the woods, under the shared sky and snowfall.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { frostGlsl } from "./shader.ts";
import { frostSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("frost", "speed", "growth speed", 1, "How fast the frost creeps over the glass: fern fronds first, then the finer frost between them.", { min: 0.2, max: 4, step: 0.1 }),
  range("frost", "style", "ferns or fur", 0.35, "Left: clean fern fronds on clear glass. Right: a fine fur of frost soon filling in between them."),
  range("frost", "sparkle", "sparkle", 0.5, "How much the crystals glint where the light behind them catches their facets."),
  range("frost", "condensation", "condensation", 0.35, "A milky film of moisture on the glass, heaviest low down, softening the lights outside."),
  seed("frost", "pattern", "pattern", "Where the frost takes hold; re-seed and a fresh pane frosts over from the start."),
  feature("touch", "warmth", "warm touch", true, "warmth", 0.5, "Hold and drag to warm the glass: your fingertip melts clear lines through the frost, which slowly grows back in from their edges. Warmer melts wider."),
  choice("outside", "outside", "outside", [{ label: "street", value: 0 }, { label: "cabin", value: 1 }], 0, "What lies beyond the glass: a snowy street with lit windows and a street lamp, or a log cabin among snowy spruces."),
  ...skyKnobs({ time: 0.9 }),
  ...weatherKnobs({ snow: true, wind: true, on: { snow: true } }),
  feature("manifold", "mark", "traced M", false, "size", 0.5, "An M written in the frost by a fingertip, frosting slowly over again; while on, it is traced afresh now and then.", { trigger: 0 }),
];

export const frostScene: SceneDef = {
  id: "frost",
  title: "Frost",
  blurb: "A window on a winter night, slowly frosting over.",
  accent: "#8fd8ff",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    frost: { title: "Frost", blurb: "How the frost grows across the glass and how it catches the light." },
    touch: { title: "Touch", blurb: "Warm the glass with your fingertip and draw through the frost." },
    outside: { title: "Outside", blurb: "The winter night beyond the glass, out of focus behind the frost." },
    sky: atmosphereGroups.sky,
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold M", blurb: "A landmark of its own: an M traced in the frost with a fingertip." },
  },
  glsl: frostGlsl,
  entry: "sceneFrost",
  sim: frostSim(params),
};
