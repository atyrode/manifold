// The constants Incense's definition (index.ts, layers.ts) shares with its code (sim.ts, shader.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/** What burns, in `stick` knob order. */
export const incenseKinds = ["stick", "cone", "coil", "waterfall"] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage), both played by the simulation.
 * Entrance: the room starts empty, the ember takes light, and the smoke thread climbs out of it
 * (Plume.#rise draws its head up, the fluid carries it on) until it frays into the veils under the
 * ceiling. Exit: a draught sweeps through the room from the left (Plume.#blow), shears the thread
 * through above the ember and carries the veils off to the right.
 */
export const INCENSE_PASSAGE: { enter: number; exit: number } = { enter: 3, exit: 1.5 };

/**
 * The room's rig (README "The interior composer"): a level eye 0.3 m over the low table and 1 m
 * from where the incense stands, so the table's seat line lies at uv 0.1 (the incense's floor,
 * sim.ts FLOOR) and the room is drawn at 1.2 screen heights a metre: the 0.26 frame-height stick
 * 22 cm long. The incense's layers are laid out on the frame (the incense at 0.58 of its width), so
 * they are locked to this rig.
 */
export const INCENSE_RIG: Rig = {
  horizon: 0.46,
  focal: 1.2,
  eye: 0.3,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: no wall of its own shows (the shaft wall covers it), no lamp out of frame and no light
 * all round of its own (the shaft wall's dark room keeps its own); a guest's light reaches the wall
 * and the table through roomLight.
 */
export const INCENSE_ROOM: Room = {
  distance: 1,
  wall: [0.022, 0.028, 0.052],
  ambient: [0, 0, 0],
};

/** The incense's layers are drawn on its frame, through this rig alone. */
export const ON_THE_TABLE = {
  eye: [INCENSE_RIG.eye, INCENSE_RIG.eye],
  horizon: [INCENSE_RIG.horizon, INCENSE_RIG.horizon],
  focal: [INCENSE_RIG.focal, INCENSE_RIG.focal],
} as const;
