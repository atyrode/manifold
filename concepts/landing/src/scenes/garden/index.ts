// A dry stone garden (karesansui): white gravel raked into lines and rings around islands of
// weathered stones and moss, always being re-raked by an unseen hand, under a maple letting go of
// its leaves, the temple woods swaying over its wall. A variant of the `outdoor` composer's
// baseline (src/composer, README "The outdoor composer"): for the baseline's downs, the temple wall
// behind (the haze over it, the wall, the veranda's boards), the raked gravel, the temple woods,
// the maple's boughs and their leaves, the border along the wall's foot and the raking chore
// (layers.ts), all seen from the veranda. The weather is the World's, the gusts and the arrangement
// the composer's.
//
// The view from straight above (the gravel's `gravelCamera` knob at 1) is not the composer's yet: it
// is a program of the garden's own (shader.ts gardenAboveGlsl, code.ts) until the overhead composer
// takes it as the scene `gardenabove` (ADR 0062 Phase 4). The knob is steady and structural here: at
// 1 (with the gravel on) the setting's features hold GARDEN_OVERHEAD, so its own and its
// all-features programs are that one, and turning it builds the other program, as a layer turn does.
import { climateCold, fallingRain, seasonKnob, yearAt } from "../../climate.ts";
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { effective, knobDef } from "../../params.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import {
  GARDEN_FLYWAY,
  GARDEN_GRADE,
  GARDEN_OVERHEAD,
  GARDEN_PAPER,
  GARDEN_PASSAGE,
  GARDEN_RIG,
} from "./constants.ts";

/** The stone garden over the outdoor's baseline: its wall, gravel, woods and maple, its veranda. */
export const gardenVariant: Variant = {
  id: "garden",
  base: "outdoor",
  title: "Stone garden",
  blurb:
    "Raked gravel, stones and moss, always being tended, under a maple letting go of its leaves. Drag to rake.",
  accent: "#c8321e",
  look: { color: "full", levels: 4 },
  // Entrance: the maple's boughs sway in from the top of the frame and a few leaves drift down and
  // land. Exit: a gust, rising over the whole exit, blows a flurry of leaves across the gravel while
  // the boughs sway up out of the frame.
  passage: GARDEN_PASSAGE,
  // White gravel in daylight is a light page, golden hour included: the copy goes dark on it from
  // just after sunrise to just before sunset, on a still clock, unless steady rain greys it (rain
  // that falls as rain: winter's snow leaves it white). The shader follows the page (pagePaper in
  // inkOf).
  theme: (params) => {
    const season = seasonKnob(params);
    const rain = knobDef("garden", params, "rain");
    return skyTheme(params, {
      from: GARDEN_PAPER.from,
      to: GARDEN_PAPER.to,
      when: (values) => {
        const cold = season ? climateCold(yearAt(season, effective(season, values))) : 0;
        return fallingRain(effective(rain, values), cold) < GARDEN_PAPER.rain;
      },
    });
  },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, the season, whether the days pass, and the moon's phase, which keys the garden's light at night; the horizon is the top of the view, so no stars show.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain greys the sky and soaks the garden: wet gravel darkens, stones and tiles shine, water stands in the grooves and the eaves and maple drip; a downpour closes the garden in. In winter the rain comes down as snow. Snow settles, crests and stone tops first. Wind sways the maple and the woods over the wall and carries the leaves.",
    },
  },
  layers: { remove: ["downs"], add: ["templeWall", "gravel", "templeWoods", "boughs", "raking"] },
  camera: GARDEN_RIG,
  grade: GARDEN_GRADE,
  floor: "gravel",
  // Golden hour, the sun low on the left behind the wall, raking across the grooves; the full moon
  // keys the garden's light at night (no stars: the horizon is the frame's top edge); no birds pass
  // in view.
  world: {
    time: 0.735,
    birds: {
      kind: "rooks",
      on: false,
      help: "Birds crossing over the temple woods by day, rooks by default; they fly above the top of the view (the horizon), so none is seen from the veranda.",
    },
  },
  // Shooting stars would set out over the woods, above the frame's top edge.
  meteors: [-0.5, 0.2, 1.0, 0.1],
  flyway: GARDEN_FLYWAY,
  // No gusts of their own over the garden until switched on ('now' still sends one).
  values: { gusts: 0 },
  // The moon takes a phase (K_moon) in the shared sky: it keys the garden's light at night, compiled
  // in at every setting, a full moon's too, as the garden always drew it.
  features: { SKY_MOON_PHASE: 1 },
};

/** The garden composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const gardenComposed = composeScene(outdoor, variantPreset(outdoor.baseline, gardenVariant));

/** Whether these knobs (as the shader reads them) look down from straight above: the gravel's camera at 1. */
function overhead(values: Readonly<Record<string, number>>): boolean {
  return (
    (values["gravelCamera"] ?? 0) >= 0.5 &&
    gardenComposed.placed(values).layers.some((placed) => placed.layer.id === "gravel")
  );
}

const { featuresFor, featuresAllFor, structural } = gardenComposed.def;

export const gardenScene: SceneDef = {
  ...gardenComposed.def,
  featuresFor: (values) => ({
    ...featuresFor?.(values),
    [GARDEN_OVERHEAD]: overhead(values) ? 1 : 0,
  }),
  featuresAllFor: (values) => ({
    ...featuresAllFor?.(values),
    [GARDEN_OVERHEAD]: overhead(values) ? 1 : 0,
  }),
  structural: [...(structural ?? []), "gravelCamera"],
  code: () => import("./code.ts"),
};
