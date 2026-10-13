// Per-scene knobs. Each scene's list order is the index into the shader's `uParams` array, so
// reorder only together with the matching `uParams[i]` reads in shaders.ts.
//
// Kinds:
//   range    a slider
//   toggle   a switch; the shader reads 0/1
//   feature  a switch plus its amount (slider, or segments when `options` is set); the shader reads
//            the amount while on and 0 while off. URL keys: `key` (0/1) and `key-amount`.
//   choice   segmented buttons; the shader reads the chosen value
import type { SceneId } from "./renderer.ts";

interface Base {
  key: string;
  label: string;
  /** Shown on hover/focus of the control's "?". */
  help: string;
  /** Lab section heading. */
  group: string;
  /** Only shown while this toggle or feature (same scene) is on. */
  when?: string;
  /** Slot in the shader's `uTriggers`: adds a "now" button that fires one occurrence at once. */
  trigger?: number;
}

export interface Option {
  label: string;
  value: number;
}

export type ParamDef =
  | (Base & { kind: "range"; min: number; max: number; step: number; value: number })
  | (Base & { kind: "toggle"; value: number })
  | (Base & { kind: "feature"; on: boolean; amountLabel: string; min: number; max: number; step: number; value: number; options?: readonly Option[] })
  | (Base & { kind: "choice"; options: readonly Option[]; value: number });

/** Must match `MAX_PARAMS` / `MAX_TRIGGERS` in the fragment shader. */
export const MAX_PARAMS = 40;
export const MAX_TRIGGERS = 8;

interface Extra { when?: string; trigger?: number }
const extra = (options: Extra) => ({
  ...(options.when === undefined ? {} : { when: options.when }),
  ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
});

const range = (group: string, key: string, label: string, value: number, help: string, options: Extra & { min?: number; max?: number; step?: number } = {}): ParamDef => ({
  kind: "range", group, key, label, value, help,
  min: options.min ?? 0, max: options.max ?? 1, step: options.step ?? 0.05, ...extra(options),
});

const toggle = (group: string, key: string, label: string, on: boolean, help: string, options: Extra = {}): ParamDef => ({
  kind: "toggle", group, key, label, value: on ? 1 : 0, help, ...extra(options),
});

const feature = (
  group: string, key: string, label: string, on: boolean, amountLabel: string, value: number, help: string,
  options: Extra & { min?: number; max?: number; step?: number; options?: readonly Option[] } = {},
): ParamDef => ({
  kind: "feature", group, key, label, on, amountLabel, value, help,
  // Segmented amounts take their bounds from the choices, so counts like 8 survive URL parsing.
  min: options.options ? Math.min(...options.options.map((option) => option.value)) : options.min ?? 0.05,
  max: options.options ? Math.max(...options.options.map((option) => option.value)) : options.max ?? 1,
  step: options.step ?? 0.05,
  ...(options.options === undefined ? {} : { options: options.options }),
  ...extra(options),
});

const choice = (group: string, key: string, label: string, options: readonly Option[], value: number, help: string, more: Extra = {}): ParamDef => ({
  kind: "choice", group, key, label, options, value, help, ...extra(more),
});

const counts = (...values: number[]): Option[] => values.map((value) => ({ label: String(value), value }));

export const sceneParams: Record<SceneId, readonly ParamDef[]> = {
  wave: [
    feature("motion", "lean", "rock", true, "amount", 0.5, "The big wave rocks forward and back about its base."),
    feature("motion", "flow", "paint flow", true, "distance", 0.5, "Paint slides along the brushstrokes, then fades back before it smears."),
    toggle("motion", "spray", "spray", true, "Droplets thrown off the claws of the crest."),
    feature("motion", "depth", "parallax", true, "depth", 0.5, "Nearer water shifts against the horizon as the camera drifts."),
    range("look", "foam", "foam", 0.6, "Density of the white foam dots. Lower is more sober."),
    toggle("look", "paper", "ink on paper", false, "Light theme: dark ink and blue on the print's paper colour instead of night."),
    toggle("loading", "rise", "rise with loading", false, "On the loading page, the crest gathers as the bar fills and breaks when it completes."),
    toggle("manifold", "seal", "seal", false, "A hanko seal stamped with the Manifold M, where the print's title cartouche was."),
  ],
  starry: [
    feature("sky", "swirl", "swirl", true, "distance", 0.5, "The sky's paint travels along its strokes."),
    feature("sky", "pulse", "star pulse", true, "strength", 0.5, "Rings of light travel outward through each star's halo."),
    toggle("sky", "stir", "stir with mouse", false, "The paint twists around the pointer like a spoon in paint."),
    feature("land", "sway", "cypress sway", true, "amount", 0.5, "The cypress flickers like a flame."),
    feature("land", "windows", "village lights", false, "pace", 0.4, "Windows in the village switch on and off one by one."),
    toggle("manifold", "mstars", "M of stars", false, "Five haloed stars, painted into the sky in the shape of the Manifold M."),
  ],
  orbit: [
    range("stars", "stars", "density", 0.35, "How many background stars."),
    feature("stars", "twinkle", "twinkle", true, "speed", 0.3, "Stars dim briefly now and then."),
    range("stars", "scatter", "randomness", 0.8, "0: stars pulse together. 1: each keeps its own rhythm and dims only briefly.", { when: "twinkle" }),
    toggle("stars", "constellations", "constellations", false, "Real constellations: Orion, the Big Dipper, Cassiopeia, Cygnus, Leo and the Southern Cross."),
    toggle("stars", "lines", "figure lines", true, "Join each constellation's stars with dotted lines.", { when: "constellations" }),
    toggle("stars", "mark", "manifold in the stars", false, "An extra asterism tracing the Manifold M among the stars."),
    feature("stars", "meteors", "shooting stars", false, "frequency", 0.4, "Streaks crossing the upper sky.", { trigger: 0 }),
    feature("stars", "captures", "captured meteors", false, "frequency", 0.5, "Now and then a meteor is caught by the planet, spirals round it and burns up in the atmosphere.", { trigger: 1 }),
    feature("stars", "nebula", "nebula", true, "density", 1, "Faint dust behind the stars."),
    feature("stars", "drift", "sky drift", true, "speed", 0.5, "The starfield slides slowly sideways."),
    range("camera", "planetX", "across", 0.36, "Where the planet sits horizontally: -1 left edge, 1 right edge.", { min: -1, max: 1 }),
    range("camera", "planetY", "height", -1.32, "Height of the planet's centre: low values sink it below the frame, around 0 centres it.", { min: -1.8, max: 0.6 }),
    range("camera", "planet", "size", 1, "Planet radius.", { min: 0.15, max: 1.6 }),
    feature("planet", "clouds", "clouds", false, "cover", 0.6, "Cloud decks drifting over the day side."),
    feature("planet", "storms", "storms", false, "frequency", 0.5, "Lightning flashing in the night-side clouds.", { trigger: 2 }),
    feature("planet", "aurora", "aurora", false, "glow", 0.6, "An auroral oval drifting over the polar night side, rising into curtains where it meets the horizon."),
    feature("planet", "daycycle", "day cycle", false, "speed", 0.3, "The sun circles slowly: sunrise, day and night sweep across the planet."),
    feature("moons", "moons", "moons", false, "count", 2, "Moons on inclined orbits that rise from behind the planet.", { options: counts(1, 2, 3) }),
    toggle("moons", "eclipses", "shadows on planet", true, "Moons cast their shadow onto the planet.", { when: "moons" }),
    toggle("ring", "ring", "ring system", false, "Rings around the planet: they pass behind it, catch its shadow and shade its surface."),
    choice("ring", "ringCount", "bands", counts(1, 2, 3, 5, 8), 3, "How many separate ring bands.", { when: "ring" }),
    range("ring", "ringSpacing", "spacing", 0.25, "Gap between neighbouring bands, as a share of each band.", { max: 0.8, when: "ring" }),
    range("ring", "ringInner", "inner edge", 0.25, "Gap between the planet and the first band.", { when: "ring" }),
    range("ring", "ringWidth", "span", 0.55, "How far out the outermost band reaches.", { when: "ring" }),
    range("ring", "ringTilt", "tilt", 0.6, "0: edge-on, a thin line. 1: seen from above.", { when: "ring" }),
    range("ring", "ringRoll", "roll", -0.2, "Rotates the ring plane on screen.", { min: -1, max: 1, when: "ring" }),
    range("ring", "ringDensity", "density", 0.75, "How solid the rings look.", { when: "ring" }),
    choice("ring", "ringTone", "colour", [{ label: "accent", value: 0 }, { label: "ink", value: 1 }, { label: "both", value: 2 }], 0, "accent or ink rings; both alternates band by band.", { when: "ring" }),
    choice("ring", "ringTexture", "made of", [{ label: "dust", value: 0 }, { label: "ice", value: 1 }, { label: "rock", value: 2 }], 1, "dust: soft and smooth. ice: fine grooves. rock: separate boulders you can see orbiting.", { when: "ring" }),
    feature("ring", "ringSpin", "spin", true, "speed", 0.4, "The rings orbit the planet; inner bands go faster, as real rings do.", { when: "ring" }),
    toggle("manifold", "mlights", "M city lights", false, "Night-side city lights that trace the Manifold M."),
    range("planet", "auroraSize", "aurora oval", 0.4, "How far from the pole the auroral oval sits.", { when: "aurora" }),
    toggle("planet", "lights", "city lights", false, "Scattered lights on the night side of the planet."),
    range("planet", "lightsTwinkle", "twinkle", 0, "0 keeps the city lights steady; higher makes them flicker.", { when: "lights" }),
  ],
  swell: [
    range("sea", "height", "swell", 0.5, "Height of the long swells."),
    range("sea", "chop", "chop", 0.5, "Small, fast waves on top of the swell."),
    range("sky", "moon", "moon", 0.5, "Moon size."),
    range("sky", "stars", "stars", 0.35, "How many stars."),
    toggle("manifold", "mmoon", "M on the moon", false, "The moon's dark seas form the Manifold M."),
  ],
  pond: [
    feature("koi", "koi", "koi", true, "count", 5, "Koi gliding beneath the surface.", { options: counts(3, 5, 8) }),
    range("koi", "swim", "swim speed", 0.4, "How fast the koi swim.", { when: "koi" }),
    toggle("koi", "follow", "drawn to mouse", false, "The koi drift toward the pointer.", { when: "koi" }),
    feature("light", "caustics", "caustics", true, "strength", 0.6, "Light patterns rippling across the pond floor."),
    feature("light", "rays", "light shafts", true, "strength", 0.5, "Slanted sunbeams through the water."),
    feature("surface", "lilies", "lily pads", true, "amount", 0.5, "Floating pads, some with a flower."),
    feature("surface", "ripples", "ripples", true, "frequency", 0.35, "Rings spreading from drops landing on the surface.", { trigger: 0 }),
    range("floor", "depth", "depth", 0.5, "Deeper water dims the floor and pushes shadows further from the fish."),
    toggle("floor", "stones", "pebbles", true, "A pebble floor under the water."),
    toggle("manifold", "stepping", "stepping stones", false, "Flat stones on the floor, laid out as the Manifold M."),
    feature("manifold", "formation", "koi formation", false, "how often", 0.4, "Now and then the koi gather and swim the strokes of the M together.", { trigger: 1 }),
  ],
};

/** The value a knob hands to the shader. */
export function effective(def: ParamDef, params: Record<string, number>): number {
  const value = params[def.key] ?? (def.kind === "feature" ? (def.on ? 1 : 0) : def.value);
  if (def.kind !== "feature") return value;
  return value > 0.5 ? (params[`${def.key}-amount`] ?? def.value) : 0;
}
