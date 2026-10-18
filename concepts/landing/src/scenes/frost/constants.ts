// The constants Frost's definition (index.ts, layers.ts) shares with its code (shader.ts, sim.ts),
// kept apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the glass opens clear
 * and the frost grows in from the frame (the growth clock is run up from FROST_EMERGE_FROM to the
 * opening state, FROST_START, in these seconds, quickly at first and settling). Exit: a warm breath
 * clears a small patch that spreads over the whole pane.
 */
export const FROST_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.6 };

/**
 * The room's rig (README "The interior composer"): the pane fills the frame, its window frame round
 * the edges; a level eye 0.15 m over the window's bottom rail and half a metre from the pane, so the
 * rail's top (FROST_FRAME, uv 0.035) is the seat line, with the view's horizon and focal (its street
 * seen level, one radian high). The view is drawn through a camera of its own (the window's, 1.8 m
 * over the street), so the view is locked to this rig; the frost glass is drawn on any window's glass.
 */
export const FROST_RIG: Rig = {
  horizon: 0.3,
  focal: 0.5 / Math.tan(0.5),
  eye: 0.15,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: no wall shows (the view fills the frame), no lamp; its dim light on the frost on this
 * side of the glass (the night's light coming in is the view's daylight).
 */
export const FROST_ROOM: Room = {
  distance: (0.15 * (0.5 / Math.tan(0.5))) / 0.265,
  wall: [0.17, 0.155, 0.14],
  ambient: [0.3, 0.31, 0.34],
};

/** The frost's view is drawn through this rig alone. */
export const AT_THE_PANE = {
  eye: [FROST_RIG.eye, FROST_RIG.eye],
  horizon: [FROST_RIG.horizon, FROST_RIG.horizon],
  focal: [FROST_RIG.focal, FROST_RIG.focal],
} as const;
