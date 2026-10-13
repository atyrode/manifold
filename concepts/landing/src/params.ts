// Per-scene knobs. Each scene's list order is the index into the shader's `uParams` array, so
// reorder only together with the matching `uParams[i]` reads in shaders.ts.
import type { SceneId } from "./renderer.ts";

export interface ParamDef {
  key: string;
  label: string;
  kind: "range" | "toggle";
  min: number;
  max: number;
  step: number;
  value: number;
  /** Shown on hover/focus of the control's "?". */
  help: string;
  /** Lab section heading. */
  group: string;
  /** Only shown while this toggle (same scene) is on. */
  when?: string;
}

/** Must match `MAX_PARAMS` in the fragment shader. */
export const MAX_PARAMS = 16;

interface RangeOptions { min?: number; max?: number; step?: number; when?: string }

const range = (group: string, key: string, label: string, value: number, help: string, options: RangeOptions = {}): ParamDef => ({
  key, label, kind: "range", value, help, group,
  min: options.min ?? 0, max: options.max ?? 1, step: options.step ?? 0.05,
  ...(options.when === undefined ? {} : { when: options.when }),
});

const toggle = (group: string, key: string, label: string, on: boolean, help: string, when?: string): ParamDef => ({
  key, label, kind: "toggle", value: on ? 1 : 0, help, group, min: 0, max: 1, step: 1,
  ...(when === undefined ? {} : { when }),
});

export const sceneParams: Record<SceneId, readonly ParamDef[]> = {
  wave: [
    range("wave", "lean", "lean", 0.5, "How far the big wave rocks forward and back about its base."),
    range("wave", "flow", "flow", 0.5, "How far the paint slides along the brushstrokes before it fades back."),
    toggle("wave", "spray", "spray", true, "Droplets thrown off the claws of the crest."),
    range("camera", "depth", "parallax", 0.5, "How much nearer water shifts against the horizon as the camera drifts."),
    range("wave", "foam", "foam", 0.6, "Density of the white foam dots. Lower is more sober."),
  ],
  starry: [
    range("sky", "swirl", "swirl", 0.5, "How far the sky's paint travels along its strokes."),
    range("sky", "pulse", "star pulse", 0.5, "Strength of the light rings travelling out through each star's halo."),
    range("land", "sway", "cypress", 0.5, "How much the cypress flickers like a flame."),
  ],
  orbit: [
    range("stars", "stars", "density", 0.35, "How many background stars."),
    range("stars", "twinkle", "twinkle", 0.3, "How fast stars dim and recover. 0 keeps them steady."),
    range("stars", "scatter", "randomness", 0.8, "0: stars pulse together. 1: each star keeps its own rhythm and dims only briefly."),
    toggle("stars", "constellations", "constellations", false, "Real constellations (Orion, the Big Dipper, Cassiopeia, Cygnus, Leo, Crux)."),
    toggle("stars", "lines", "lines", true, "Join each constellation's stars with dotted lines.", "constellations"),
    range("stars", "meteors", "meteors", 0, "How often shooting stars cross the sky."),
    range("stars", "nebula", "nebula", 1, "Faint dust clouds behind the stars."),
    range("stars", "drift", "drift", 0.5, "How fast the starfield drifts sideways."),
    range("planet", "planet", "size", 1, "Planet radius; smaller lifts it out of the bottom of the frame.", { min: 0.4, max: 1.6 }),
    range("planet", "clouds", "clouds", 0, "Cloud decks drifting over the day side."),
    range("planet", "storms", "storms", 0, "Lightning flashing inside the night-side clouds."),
    range("moons", "moons", "moons", 0, "Small moons on inclined orbits that rise from behind the limb.", { max: 3, step: 1 }),
    toggle("ring", "ring", "ring", false, "A ring system around the planet, hidden where it passes behind it."),
    range("ring", "ringTilt", "tilt", 0.3, "0: the ring barely clears the planet's edge. 1: seen from above, arcing across the sky.", { when: "ring" }),
    range("ring", "ringWidth", "width", 0.35, "How far out the ring extends.", { when: "ring" }),
  ],
  swell: [
    range("sea", "height", "swell", 0.5, "Height of the long swells."),
    range("sea", "chop", "chop", 0.5, "Small, fast waves on top of the swell."),
    range("sky", "moon", "moon", 0.5, "Moon size."),
    range("sky", "stars", "stars", 0.35, "How many stars."),
  ],
};
