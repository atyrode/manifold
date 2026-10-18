// A northern night under the aurora, in one of two places. A frozen lake: black ice swept clear by
// the wind, white methane bubbles frozen in layers beneath it, long pressure cracks hanging their
// fracture planes down into it and now and then a new one singing across with a flash, snow lying in
// wind-carved patches and streaming over the ice, and on the far shore a cabin with a lit window. Or
// a fjord (`setting`): still open water under snowy mountains going straight into it, freezing over
// with the `ice` knob and ruffled by the wind with `ripples`, a red cabin with birches on the far
// shore and birches on the near bank. Over both, one night: the hour, the moon, the stars and the
// Milky Way, and the aurora, the shared arcs surging overhead every few minutes or the slow drapes
// (`drapes`) with their corona, both on the substorm clock, mirrored in the ice or the water.
//
// A preset of the `outdoor` composer (src/composer, README "Composers"): the far shore (the night,
// the land across the water, its view in a mirror) and the lake (the ice or the fjord's water) as
// layers (layers.ts). The night is the lake's own (ADR 0062 D10): the far shore draws it from its
// hour and the World's sky knobs and stages it on the World, so the World's rain, snow and fog fall
// through it at the composed depth, lit by its moon and aurora. On the lake it comes in with the
// camera tilting down from the aurora onto the ice as a crack sings across, and goes out as a gust of
// snow streams over the ice and the camera tilts back up; on the fjord the camera comes down from the
// stars as the chimney's smoke climbs and lifts to them again (LAKE_RIG), and the drapes unfurl
// coming in and roll up going out.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { CLOUD_TIERS } from "../../shaders/lib/clouds.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { LAKE_FLYWAY, LAKE_GRADE, LAKE_METEORS, LAKE_PASSAGE, LAKE_RIG } from "./constants.ts";

const preset: ScenePreset = {
  id: "lake",
  composer: "outdoor",
  title: "Frozen lake",
  blurb:
    "Black ice under the aurora: bubbles frozen deep, cracks that sing, snow drifting across; or an open fjord under slow drapes.",
  accent: "#4cf08c",
  look: { color: "full", levels: 4 },
  passage: LAKE_PASSAGE,
  planets: { group: "sky", across: [-45, -22, 45], up: [2, 21, 38] },
  rig: LAKE_RIG,
  grade: LAKE_GRADE,
  // The night as the lake opens it: the World's clock at the lake's default hour (it reaches the
  // lake's own layers not at all, a backdrop of another scene over the ice in full), a dark northern
  // sky of stars, the Milky Way, a crescent moon, the aurora on, no fair-weather cloud; geese, off.
  world: {
    time: 0.78 + 0.075 * 0.75 * 0.75,
    stars: 0.7,
    moon: 0.3,
    clouds: 0,
    on: { aurora: true },
    birds: {
      kind: "geese",
      on: false,
      often: 0.5,
      help: "Birds crossing the night over the lake, geese by default, a skein migrating under the aurora: dark against the sky, mirrored in the black ice, behind the cabin and the trees on the point; few fly in snow or rain.",
    },
  },
  meteors: LAKE_METEORS,
  flyway: LAKE_FLYWAY,
  floor: "ice",
  layers: ["farShore", "lake"],
  values: {},
  // The moon's and the window's paths down the ice and over the fjord: the water's glint
  // (waterGlint, its mirror tier); the ice's own mirror, bubbles and cracks are the lake's. The
  // fjord's open water: the breeze's cat's-paws breaking up its mirror and widening the paths
  // (windRipples, windMirror: the ripples tier, which the mirror tier includes).
  features: { WATER_TIER: WATER_TIERS.mirror },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "The night sky over the lake or the fjord: the moon's phase, the stars and the Milky Way, the odd shooting star and the aurora, all mirrored in the ice or the water. The lake's night is its own: its hour is the far shore's.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Snow falls from a closing sky, hiding the aurora and slowly burying the ice; rain greys it; mist settles on the lake or the fjord; the wind drives the drifting snow, ruffles the fjord's open water and leans the cabin's smoke.",
    },
  },
};

/** The frozen lake composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const lakeComposed = composeScene(outdoor, preset);

/**
 * The World's gates while the far shore stands (its night is its own): the parts of the World's sky
 * it draws its own way (the stars and the Milky Way, the shooting stars, the aurora, the birds) and
 * those it has no part for (the painted cumulus, the cloud shadows, lightning) are left out, the
 * cloud deck at the lit tier and the moon's phase the lake's (SKY_MOON_PHASE out); the World's cloud
 * cover, rain, snow and fog stay in.
 */
function lakeNight(
  features: Readonly<Record<string, number>>,
  values: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...features };
  if (!lakeComposed.placed(values).layers.some((placed) => placed.layer.id === "farShore"))
    return out;
  delete out["SKY_MOON_PHASE"];
  return {
    ...out,
    WORLD_STARS: 0,
    WORLD_MILKYWAY: 0,
    WORLD_METEORS: 0,
    WORLD_AURORA: 0,
    WORLD_BIRDS: 0,
    WORLD_CUMULUS: 0,
    WORLD_SHADOWS: 0,
    WORLD_LIGHTNING: 0,
    CLOUD_TIER: CLOUD_TIERS.lit,
  };
}

const { featuresFor, featuresAllFor } = lakeComposed.def;

export const lakeScene: SceneDef = {
  ...lakeComposed.def,
  featuresFor: (values) => lakeNight(featuresFor?.(values) ?? {}, values),
  featuresAllFor: (values) => lakeNight(featuresAllFor?.(values) ?? {}, values),
  code: () => import("./code.ts"),
};
