// Countryside: overlooking rolling hills from a vantage point, a patchwork of fields with a village
// in the middle distance and woods beyond, under the shared sky and weather. Lying snow is the one
// piece of state: a tiny sim lets it build up while it snows and melt after, as one texel (uSim0).
import { choice, feature, range, toggle } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef, SimFactory } from "../types.ts";
import { countryGlsl } from "./shader.ts";

const params = [
  ...skyKnobs({ time: 0.7 }),
  range("clouds", "clouds", "cloud cover", 0.4, "How much of the sky the cloud deck covers; rain and snow thicken it."),
  feature("clouds", "shadows", "cloud shadows", true, "darkness", 0.6, "Shadows of the clouds sweeping across the fields and hills."),
  choice(
    "fields", "season", "season",
    [{ label: "summer", value: 0 }, { label: "harvest", value: 1 }, { label: "autumn", value: 2 }],
    1,
    "Summer: green wheat and yellow rapeseed. Harvest: golden wheat, stubble and bales. Autumn: ploughed earth and the trees on the turn.",
  ),
  feature("village", "lights", "village lights", true, "windows lit", 0.7, "Windows light up one by one as dusk falls, and most go dark late at night."),
  feature("village", "smoke", "chimney smoke", true, "amount", 0.5, "Smoke curling up from the chimneys and leaning with the wind."),
  ...weatherKnobs({ rain: true, snow: true, fog: true, wind: true, lightning: 0 }),
  toggle("manifold", "chalk", "chalk M", false, "A giant M cut into the turf of a far hillside, in the manner of the Uffington White Horse."),
];

const SNOW = params.findIndex((def) => def.key === "snow");
const RAIN = params.findIndex((def) => def.key === "rain");
/**
 * Snow settles fast at first and then thickens slowly (an exponential approach to full cover): at
 * the default amount the land is mostly white within about ten seconds. It melts in about a
 * minute, faster in rain.
 */
const SETTLE_RATE = 0.08;
const SETTLE_PER_AMOUNT = 0.16;
const MELT_PER_SECOND = 0.018;

/** How much snow lies on the land, 0..1, as a single r16f texel. */
const lyingSnow: SimFactory = (gl) => {
  const texture = new DataTexture(gl, { width: 1, height: 1, format: "r16f", filter: "nearest" });
  const texel = new Float32Array(1);
  let lying = 0;
  let uploaded = Number.NaN;
  return {
    frame({ dt, values }) {
      const snow = values[SNOW] ?? 0;
      const rain = values[RAIN] ?? 0;
      lying = snow > 0
        ? lying + (1 - lying) * (1 - Math.exp(-dt * (SETTLE_RATE + SETTLE_PER_AMOUNT * snow)))
        : Math.max(0, lying - dt * MELT_PER_SECOND * (1 + 2 * rain));
      if (lying !== uploaded) {
        texel[0] = lying;
        texture.upload(texel);
        uploaded = lying;
      }
      return [texture.texture];
    },
    dispose() {
      texture.dispose();
    },
  };
};

export const countryScene: SceneDef = {
  id: "country",
  title: "Countryside",
  blurb: "Rolling hills and patchwork fields, a village with its church in the valley.",
  // Lamplight in the village windows.
  accent: "#ffb547",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sky: atmosphereGroups.sky,
    clouds: { title: "Clouds", blurb: "How much cloud drifts over, and the shadows it sweeps across the fields." },
    fields: { title: "Fields", blurb: "The patchwork through the farming year." },
    village: { title: "Village", blurb: "Signs of life: windows lighting up at dusk, smoke from the chimneys." },
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A chalk figure of the M, cut into the turf of a far hillside." },
  },
  glsl: countryGlsl,
  entry: "sceneCountry",
  sim: lyingSnow,
};
