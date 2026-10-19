// A lava lamp late at night: a dark room, a teak sideboard, papered wall, and the lamp glowing on it.
// Wax heats on the coil, swells, draws out a neck and tears free, rises, cools under the cap, pools
// and sinks back to the heap (sim.ts: CPU parcels with temperature, buoyancy, drag and bonds that
// stretch and snap). A variant of the `interior` composer's baseline (src/composer, README "The
// interior composer"): the papered wall behind (layers.ts) and the sideboard in front for the
// baseline's window and sill, the lamp on it. The lamp is drawn from the room's rig, so it stands on
// any room's ledge (the sill's too).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { LAVA_PASSAGE, LAVA_RIG, LAVA_ROOM } from "./constants.ts";

/** The lava lamp over the interior's baseline: its own shell, rig and room, the lamp, its ink. */
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
  // The room shows no window, so it lists no World (compose.ts).
  layers: { remove: ["cityWindow", "sill"], add: ["papered", "sideboard", "lavaLamp"] },
  camera: LAVA_RIG,
  room: LAVA_ROOM,
  grade: { ink: { gain: 1.3, gamma: 1 } },
};

/** The lava lamp composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const lavaComposed = composeScene(interior, variantPreset(interior.baseline, lavaVariant));

export const lavaScene: SceneDef = { ...lavaComposed.def, code: () => import("./code.ts") };
