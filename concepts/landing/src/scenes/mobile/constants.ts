// The constants Mobile's definition (index.ts, layers.ts) shares with its code (layout.ts,
// shader.ts), kept apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/** Seconds of the entrance (lowered from above, the Sun lighting up) and the exit (the motor winding down, the Sun cooling, hoisted away). */
export const MOBILE_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The Sun's gold: the accent. */
export const MOBILE_SUN = "#f2a52c";

/**
 * The room's rig (README "The interior composer"): the floor is the ledge, the wall's foot the seat
 * line, 4.4 m ahead of the eye 3.3 m over the floor (layout.ts MOBILE_EYE, the wall at z = -1.4);
 * the eye looks down 0.448 rad (about 26°) at the mobile, the focal 1.41 screen heights the camera's
 * on a 16:9 frame (layout.ts mobileFocal), the level horizon above the frame. The room's level
 * formula (room.ts roomFrame) puts the seat at -0.38 screen heights, under the pitched camera's foot
 * of the wall at about -0.28: nothing in this room is drawn from the rig. The mobile's layers are
 * drawn through its own pinhole (shader.ts mobileBegin), so they are locked to this rig.
 */
export const MOBILE_RIG: Rig = {
  horizon: 1.176,
  focal: 1.41,
  eye: 3.3,
  turn: 0,
  pitch: 0.448,
  minAspect: 1,
};

/**
 * The room: its shell is the quiet room's (layers.ts), drawn in the mobile's metres, so the room's
 * own wall shows nowhere; it has no lamp out of frame and no light all round of its own (the night
 * room's ambient is the quiet room's).
 */
export const MOBILE_ROOM: Room = {
  distance: 4.4,
  wall: [0.58, 0.53, 0.48],
  ambient: [0, 0, 0],
};

/** The mobile's layers are drawn through the mobile's own camera, by this rig alone. */
export const UNDER_THE_SUN = {
  eye: [MOBILE_RIG.eye, MOBILE_RIG.eye],
  horizon: [MOBILE_RIG.horizon, MOBILE_RIG.horizon],
  focal: [MOBILE_RIG.focal, MOBILE_RIG.focal],
  pitch: [MOBILE_RIG.pitch, MOBILE_RIG.pitch],
} as const;
