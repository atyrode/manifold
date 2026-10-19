// Wind over a sand sea. A variant of the `outdoor` composer's baseline (src/composer, README "The
// outdoor composer"): for the baseline's downs, the desert behind (the dune sea out to the horizon
// under its dust, the heat shimmer, the sandstorm) and the dune field (layers.ts), a live
// simulation (sim.ts: Werner's slab model on a toroidal grid, in the field's two field slots), so
// the dunes really form, march downwind and heal around a heap you drop on them, seen from some
// 80 m up low across the field toward the horizon. The sky, the weather and the birds are the
// World's; its fog is the desert's dust, which turns into a sandstorm in a hard wind.
//
// The view from straight above (the dune field's `camera` knob at 1) is not the composer's yet: it is
// a program of the dunes' own (shader.ts dunesAboveGlsl, code.ts) until the overhead composer takes
// it as the scene `dunesabove` (ADR 0062 Phase 4). The knob is steady and structural here: at 1 (with
// the dune field on) the setting's features hold DUNES_OVERHEAD, so its own and its all-features
// programs are that one, and turning it builds the other program, as a layer turn does.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { DUNES_GRADE, DUNES_OVERHEAD, DUNES_PASSAGE, DUNES_RIG, DUNES_UNIT } from "./constants.ts";

/** The dunes over the outdoor's baseline: its desert and dune field, its eye high, its sunset. */
export const dunesVariant: Variant = {
  id: "dunes",
  base: "outdoor",
  title: "Dunes",
  blurb:
    "Wind over a sand sea: real dunes, slowly marching downwind. Click to drop a heap of sand.",
  accent: "#d4913a",
  look: { color: "full", levels: 4 },
  passage: DUNES_PASSAGE,
  planets: { group: "sky", across: [-62, -40, 5], up: [0, 7, 14] },
  groups: {
    // The shared heading, with what the weather means out here.
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows on the sand, rain, snow, fog and lightning: one weather, shared by every outdoor scene. The fog is desert dust, and with a hard wind it becomes a sandstorm; rain darkens the sand and stills it, snow lies on the slopes.",
    },
  },
  layers: { remove: ["downs"], add: ["desert", "dunes"] },
  camera: DUNES_RIG,
  grade: DUNES_GRADE,
  floor: "sand",
  // Sunset over the sand, every star of a dark desert sky by night, a buzzard on the thermals by day.
  world: {
    time: 0.74,
    stars: 1,
    birds: {
      kind: "buzzard",
      help: "Birds over the dune sea by day, a buzzard by default circling on the thermals the hot sand sends up; any dune or the M nearer hides them, the dust hazes them, and few fly in rain or snow. Not seen from overhead.",
    },
  },
  // Shooting stars set out over the strip of sky above the dune sea.
  meteors: [-0.5, 0.17, 1.0, 0.08],
  // Flights cross 150-1500 m out (30-300 cells), cruising above the horizon; a swooping party comes
  // down to skim the crests; the dust hazes them as it does the sand.
  flyway: {
    depth: [30 / DUNES_UNIT, 300 / DUNES_UNIT],
    above: 0.03,
    top: 0.94,
    seed: 3.3,
    skim: 12 / DUNES_UNIT,
    spread: 1.5,
    ext: 0,
    dust: 1,
  },
};

/** The dunes composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const dunesComposed = composeScene(outdoor, variantPreset(outdoor.baseline, dunesVariant));

/** Whether these knobs (as the shader reads them) look down from straight above: the dune field's camera at 1. */
function overhead(values: Readonly<Record<string, number>>): boolean {
  return (
    (values["camera"] ?? 0) >= 0.5 &&
    dunesComposed.placed(values).layers.some((placed) => placed.layer.id === "dunes")
  );
}

const { featuresFor, featuresAllFor, structural } = dunesComposed.def;

export const dunesScene: SceneDef = {
  ...dunesComposed.def,
  featuresFor: (values) => ({
    ...featuresFor?.(values),
    [DUNES_OVERHEAD]: overhead(values) ? 1 : 0,
  }),
  featuresAllFor: (values) => ({
    ...featuresAllFor?.(values),
    [DUNES_OVERHEAD]: overhead(values) ? 1 : 0,
  }),
  structural: [...(structural ?? []), "camera"],
  code: () => import("./code.ts"),
};
