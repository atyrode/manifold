// The constants Pearl's definition (index.ts) shares with its code (shader.ts, sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

/** A fluid: its flakes edge-on, at random and turned to the lamp, and the pigment dripped into it. */
export interface PearlPalette {
  label: string;
  /** Flakes edge-on to the lamp: the liquid's own colour. */
  deep: string;
  /** Flakes in a jumble: the milky mid-tone. */
  milk: string;
  /** Flakes turned to the lamp: the satin's glint. */
  sheen: string;
  pigment: string;
  /** A light fluid: the page goes dark on it. */
  paper: boolean;
}

/** In `palette` knob order. */
export const pearlPalettes: readonly PearlPalette[] = [
  // Silver flakes in blue-black, with a vermilion thread. (The deeps stay just off black, so a
  // band turned edge-on reads as dark fluid, not a hole.)
  {
    label: "midnight",
    deep: "#070c1a",
    milk: "#1a2440",
    sheen: "#b3c1dd",
    pigment: "#e0583a",
    paper: false,
  },
  // Gilt flakes in dark amber, with ultramarine.
  {
    label: "gold",
    deep: "#0e0905",
    milk: "#3b2711",
    sheen: "#f2d08a",
    pigment: "#2f4fc4",
    paper: false,
  },
  // Pale flakes in deep green, with coral.
  {
    label: "jade",
    deep: "#05100e",
    milk: "#123129",
    sheen: "#b0ead0",
    pigment: "#e8644c",
    paper: false,
  },
  // Mother-of-pearl, white on dove grey, with indigo.
  {
    label: "pearl",
    deep: "#76737e",
    milk: "#c3c0c6",
    sheen: "#fdfaf4",
    pigment: "#2c3f94",
    paper: true,
  },
];

export const pearlForcings = ["turntable", "convection", "rods"] as const;

/** Seconds the scene's entrance and exit take (SceneDef.passage in index.ts). */
export const PEARL_ENTER = 3;

export const PEARL_EXIT = 1.5;
