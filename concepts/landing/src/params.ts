// Per-scene knobs. Each scene's list order is the index into the shader's `uParams` array, so
// reorder only together with the matching `uParams[i]` reads in the scene's shader module.
//
// Kinds:
//   range    a slider
//   toggle   a switch; the shader reads 0/1
//   feature  a switch plus its amount (slider, or segments when `options` is set); the shader reads
//            the amount while on and 0 while off. URL keys: `key` (0/1) and `key-amount`.
//   choice   segmented buttons; the shader reads the chosen value
//   seed     an arrangement number with a "re-seed" button; the shader reads it
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
  /** Shuffle leaves this knob alone (framing that would otherwise lose the subject). */
  steady?: boolean;
}

export interface Option {
  label: string;
  value: number;
}

export type ParamDef =
  | (Base & { kind: "range"; min: number; max: number; step: number; value: number })
  | (Base & { kind: "toggle"; value: number })
  | (Base & { kind: "feature"; on: boolean; amountLabel: string; min: number; max: number; step: number; value: number; options?: readonly Option[] })
  | (Base & { kind: "choice"; options: readonly Option[]; value: number })
  | (Base & { kind: "seed"; value: number });

/** Largest arrangement number a seed knob can hold. */
export const MAX_SEED = 999;

/** Must match `MAX_PARAMS` / `MAX_TRIGGERS` in the fragment shader. */
export const MAX_PARAMS = 48;
export const MAX_TRIGGERS = 8;

interface Extra { when?: string; trigger?: number; steady?: boolean }
const extra = (options: Extra) => ({
  ...(options.when === undefined ? {} : { when: options.when }),
  ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
  ...(options.steady === undefined ? {} : { steady: options.steady }),
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

const seed = (group: string, key: string, label: string, help: string, more: Extra = {}): ParamDef => ({
  kind: "seed", group, key, label, value: 0, help, ...extra(more),
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
    range("camera", "planetX", "across", 0.36, "Where the planet sits horizontally: -1 left edge, 1 right edge.", { min: -1, max: 1, steady: true }),
    range("camera", "planetY", "height", -1.32, "Height of the planet's centre: low values sink it below the frame, around 0 centres it.", { min: -1.8, max: 0.6, steady: true }),
    range("camera", "planet", "size", 1, "Planet radius.", { min: 0.15, max: 1.6, steady: true }),
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
    feature("light", "rays", "god rays", true, "strength", 0.5, "Beams of light from the sun; leaves and canopy break them into shafts."),
    range("light", "sunPower", "intensity", 0.4, "How strong the sunlight is: brighter water and caustics, stronger rays and glare."),
    range("light", "sunX", "sun across", 0.15, "Where the sun is, left to right; beyond the edges puts it off screen.", { min: -0.5, max: 1.5, steady: true }),
    range("light", "sunY", "sun height", 1.15, "Where the sun is, bottom to top; beyond the edges puts it off screen.", { min: -0.5, max: 1.5, steady: true }),
    feature("surface", "lilies", "lily pads", true, "amount", 0.5, "Floating pads, some with a flower."),
    feature("surface", "ripples", "ripples", true, "frequency", 0.35, "Rings spreading from drops landing on the surface.", { trigger: 0 }),
    feature("surface", "lilyDrift", "pads wander", false, "speed", 0.4, "Pads wander around their anchor (or across the pond when untethered)."),
    seed("surface", "lilySeed", "pad placement", "Where the lily pads are anchored; re-seed to scatter them anew."),
    toggle("surface", "tether", "tethered", true, "Each pad hangs on a stem rooted in the floor: it leans with the current but cannot drift away. Off: pads are carried along and come back round."),
    range("floor", "depth", "depth", 0.5, "Deeper water dims the floor and pushes shadows further from the fish."),
    choice("floor", "floorType", "bed", [{ label: "pebbles", value: 0 }, { label: "river", value: 1 }, { label: "sand", value: 2 }, { label: "slate", value: 3 }, { label: "moss", value: 4 }], 0, "What the pond floor is made of: small pebbles, big smooth river stones, rippled sand, laid slate, or a soft moss bed."),
    range("floor", "grain", "grain", 0.5, "Size of the stones, tiles or sand ripples."),
    range("floor", "floorMoss", "moss", 0.5, "How much moss grows between and over the stones."),
    range("floor", "floorTint", "tint", 0, "Cooler grey-blue stone to the left, warmer ochre to the right.", { min: -1, max: 1 }),
    feature("floor", "weeds", "water weeds", true, "amount", 0.5, "Clumps of weed on the floor, swaying and bending with the current."),
    feature("plants", "plants", "border plants", true, "reach", 0.45, "Plants around the pond's edges, each grown its own way: monstera climbing on stalked leaves, ferns and banana fanning from crowns."),
    choice("plants", "plantStyle", "show", [{ label: "both", value: 0 }, { label: "leaves", value: 1 }, { label: "shadows", value: 2 }], 0, "Leaves: the plants themselves. Shadows: only the shade they cast. Both: leaves with their shadows on the water.", { when: "plants" }),
    range("plants", "lushTop", "top", 0.6, "How lush the top edge is; 0 leaves it bare.", { when: "plants" }),
    range("plants", "lushRight", "right", 0.6, "How lush the right edge is; 0 leaves it bare.", { when: "plants" }),
    range("plants", "lushBottom", "bottom", 0.6, "How lush the bottom edge is; 0 leaves it bare.", { when: "plants" }),
    range("plants", "lushLeft", "left", 0.6, "How lush the left edge is; 0 leaves it bare.", { when: "plants" }),
    toggle("plants", "monstera", "monstera", true, "Split leaves on long stalks along a climbing stem.", { when: "plants" }),
    toggle("plants", "ferns", "ferns", true, "Arching fronds of small leaflets, fanning from a crown.", { when: "plants" }),
    toggle("plants", "banana", "banana leaves", true, "Long blades torn by the wind, fanning from the top of the stem.", { when: "plants" }),
    feature("plants", "vines", "vines", true, "amount", 0.4, "Pothos vines trailing in from the edges, heart-shaped leaves along them, curling at the tips.", { when: "plants" }),
    feature("plants", "flowers", "flowers", true, "amount", 0.35, "Hibiscus and frangipani blooming among the leaves.", { when: "plants" }),
    feature("plants", "grass", "grass", true, "amount", 0.4, "Tufts of grass along the waterline, blades arching every way.", { when: "plants" }),
    seed("plants", "plantSeed", "arrangement", "Which arrangement of plants; re-seed for another.", { when: "plants" }),
    feature("canopy", "canopy", "canopy overhead", false, "coverage", 0.45, "Foliage above the camera, never seen directly: only its dappled shadow falls across the pond."),
    range("canopy", "canopySoft", "softness", 0.5, "How soft the canopy's shadow is: higher means leaves further above the water.", { when: "canopy" }),
    seed("canopy", "canopySeed", "arrangement", "Which canopy; re-seed for another.", { when: "canopy" }),
    range("air", "wind", "wind", 0.4, "How much the plants and canopy stir in the breeze; nearer leaves move most."),
    feature("current", "current", "current", false, "strength", 0.35, "A flow through the pond: pads lean or travel, weeds bend, light and ripples drift, petals float by."),
    range("current", "currentDir", "direction", 0.1, "Which way the water flows, as a turn of the compass.", { when: "current" }),
    range("current", "turbulence", "turbulence", 0.4, "Eddies that jostle the pads and petals.", { when: "current" }),
    feature("current", "petals", "floating petals", true, "amount", 0.5, "Petals drifting on the surface, showing how the water moves.", { when: "current" }),
    feature("manifold", "stone", "manifold stone", false, "size", 0.45, "A carved stone M rising from the water, with moss on top and water lapping at its edges."),
    range("manifold", "stoneX", "across", 0.45, "Where the stone stands, left to right.", { min: -1, max: 1, when: "stone", steady: true }),
    range("manifold", "stoneY", "height", -0.2, "Where the stone stands, bottom to top.", { min: -1, max: 1, when: "stone", steady: true }),
    range("manifold", "moss", "moss", 0.5, "How much moss has grown over the stone.", { when: "stone" }),
  ],
};

/** The value a knob hands to the shader. */
export function effective(def: ParamDef, params: Record<string, number>): number {
  const value = params[def.key] ?? (def.kind === "feature" ? (def.on ? 1 : 0) : def.value);
  if (def.kind !== "feature") return value;
  return value > 0.5 ? (params[`${def.key}-amount`] ?? def.value) : 0;
}

export interface Blurb {
  title: string;
  blurb: string;
}

export const sceneInfo: Record<SceneId, Blurb> = {
  wave: { title: "Wave", blurb: "Hokusai's Great Wave, moving along its own brushstrokes." },
  starry: { title: "Starry", blurb: "Van Gogh's sky swirling, stars pulsing with light." },
  orbit: { title: "Orbit", blurb: "A planet in space: rings, moons, aurora, meteors." },
  swell: { title: "Swell", blurb: "A moonlit sea rolling toward the horizon." },
  pond: { title: "Pond", blurb: "A koi pond from above, light through clear water." },
};

/** Section headings and what each group of knobs is for. */
export const groupInfo: Record<SceneId, Record<string, Blurb>> = {
  wave: {
    motion: { title: "Movement", blurb: "How the print comes alive: rocking, flowing paint, spray and depth." },
    look: { title: "Print", blurb: "Foam density, and night versus ink-on-paper." },
    loading: { title: "Loading page", blurb: "Behaviour when the loading page is on top." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live inside the print." },
  },
  starry: {
    sky: { title: "Sky", blurb: "The painted sky in motion, and the pointer's stir." },
    land: { title: "Land", blurb: "The cypress and the sleeping village." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live inside the painting." },
  },
  orbit: {
    stars: { title: "Sky & events", blurb: "Background stars, constellations and what streaks across them." },
    camera: { title: "Camera", blurb: "Frame the planet: where it sits and how big it is." },
    planet: { title: "Planet", blurb: "Surface, weather, aurora and the sun's path." },
    moons: { title: "Moons", blurb: "Satellites on inclined orbits, and their eclipses." },
    ring: { title: "Rings", blurb: "A ring system: its shape, what it's made of, and how it moves." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this sky." },
  },
  swell: {
    sea: { title: "Sea", blurb: "The swell and its surface chop." },
    sky: { title: "Sky", blurb: "Moon and stars." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this night." },
  },
  pond: {
    koi: { title: "Koi", blurb: "How many fish, how they swim, and whether they follow you." },
    light: { title: "Light", blurb: "Move the sun, turn it up, and let its rays fall through the leaves." },
    surface: { title: "Surface", blurb: "What floats and what falls on the water." },
    floor: { title: "Floor", blurb: "Depth and the bed of the pond." },
    plants: { title: "Border plants", blurb: "Hand-drawn foliage around the edges, each side as lush as you like, with vines and flowers." },
    canopy: { title: "Canopy", blurb: "Leaves above the camera, out of sight, casting dappled shade over everything." },
    air: { title: "Breeze", blurb: "Wind through the plants and the canopy." },
    current: { title: "Water current", blurb: "Make the water flow and watch everything respond to it." },
    manifold: { title: "Manifold stone", blurb: "A landmark of its own: a carved stone M standing in the water." },
  },
};

/** How a knob's value reads in the lab. */
export function formatValue(def: ParamDef, value: number): string {
  if (def.kind === "toggle") return value > 0.5 ? "on" : "off";
  if (def.kind === "seed") return `#${Math.round(value)}`;
  const step = def.kind === "range" || def.kind === "feature" ? def.step : 1;
  if (step >= 1) return String(Math.round(value));
  const min = def.kind === "range" || def.kind === "feature" ? def.min : 0;
  const max = def.kind === "range" || def.kind === "feature" ? def.max : 1;
  if (min >= 0 && max <= 1) return `${Math.round(value * 100)}%`;
  return value.toFixed(2);
}
