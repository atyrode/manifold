// A lava lamp late at night: a dark room, a teak sideboard, papered wall, and the lamp glowing on it.
// Wax heats on the coil, swells, draws out a neck and tears free, rises, cools under the cap, pools
// and sinks back to the heap (sim.ts: CPU parcels with temperature, buoyancy, drag and bonds that
// stretch and snap). A variant of the `interior` composer's baseline (src/composer, README "The
// interior composer"): the shell's papered wall and sideboard (LAVA_ROOM), its shelf and the
// record on the sideboard (layers.ts), the lamp on it; a window off to the left letting the World's
// moon in, the hour pinned at midnight. The lamp is drawn from the room's rig, so it stands on any
// room's ledge (the sill's too).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { LAVA_PASSAGE, LAVA_RIG, LAVA_ROOM, LAVA_WINDOW } from "./constants.ts";

/** The lava lamp over the interior's baseline: its rig and room, the lamp, its window, its ink. */
export const lavaVariant: Variant = {
  id: "lava",
  base: "interior",
  title: "Lava lamp",
  blurb: "Wax rising and falling in a glowing lamp on a sideboard, late at night.",
  accent: "#ff4a26",
  look: { color: "full", levels: 4 },
  // Entrance: the wax lies pooled and pale at the bottom, warms, and the first blob tears free and
  // rises. Exit: the coil lets go and the blobs cool, sink and merge back into the pool.
  passage: LAVA_PASSAGE,
  // No glass in frame: the window off to the left lists the light-only World (compose.ts).
  layers: { remove: ["cityWindow"], add: ["papered", "sideboard", "lavaLamp"] },
  camera: LAVA_RIG,
  room: LAVA_ROOM,
  elements: [LAVA_WINDOW],
  // Midnight, the full moon up and in at the window.
  values: { time: 0 },
  grade: { ink: { gain: 1.3, gamma: 1 } },
};

/** The lava lamp composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const lavaComposed = composeScene(interior, variantPreset(interior.baseline, lavaVariant));

export const lavaScene: SceneDef = { ...lavaComposed.def, code: () => import("./code.ts") };
