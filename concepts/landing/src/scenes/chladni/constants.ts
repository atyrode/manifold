// The constants Chladni plate's definition (index.ts) shares with its code (shader.ts, sim.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).

export interface ChladniColor {
  label: string;
  color: string;
}

export interface ChladniMetal {
  label: string;
  /** The bare metal in the dim room. */
  base: string;
  /** What the metal does to the lamp's reflection. */
  sheen: string;
}

/** In `sand` knob order. */
export const chladniSands: readonly ChladniColor[] = [
  { label: "quartz", color: "#d6c093" },
  { label: "desert", color: "#d9964f" },
  { label: "salt", color: "#e4ebf2" },
  { label: "coral", color: "#eda89c" },
];

/** In `lampHue` knob order. */
export const chladniLamps: readonly ChladniColor[] = [
  { label: "amber", color: "#ff9440" },
  { label: "sea", color: "#38c9d6" },
  { label: "violet", color: "#9a6cff" },
  { label: "moon", color: "#b8cbff" },
];

/** In `tone` knob order. */
export const chladniMetals: readonly ChladniMetal[] = [
  { label: "black", base: "#08090b", sheen: "#7d8594" },
  { label: "steel", base: "#17181a", sheen: "#d6dce8" },
  { label: "brass", base: "#1c140a", sheen: "#ffcf86" },
];

/** The `grains` choice. */
export const CHLADNI_GRAINS = [15000, 25000, 40000] as const;

// The scene's passage (index.ts `passage`).
/** Seconds the entrance and the exit take. */
export const CHLADNI_ENTER = 3;

export const CHLADNI_EXIT = 1.6;
