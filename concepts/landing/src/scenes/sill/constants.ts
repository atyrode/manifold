// The constants the sill's definition (index.ts, layers.ts) shares with its code (shader.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).
import type { Rig, Room } from "../../composer/types.ts";

/**
 * Seconds the entrance and the exit take (SceneDef.passage; the shader reads the same). In: the cat
 * hops up onto the sill and settles, its tail curling round. Out: it stretches and hops down out of
 * frame. At rest the cat is exactly as it always was.
 */
export const SILL_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/**
 * The room's rig (README "The interior composer"): a level eye 0.35 m over the sill, its horizon
 * where the city's is (uv 0.47) and the city view's focal (one radian high), so the window's own rig
 * is the same camera 10 m over the street (shader.ts SILL_FOCAL, SILL_EYE).
 */
export const SILL_RIG: Rig = {
  horizon: 0.47,
  focal: 0.5 / Math.tan(0.5),
  eye: 0.35,
  turn: 0,
  pitch: 0,
  minAspect: 1,
};

/**
 * The room: the sill's seat line 0.28 screen heights under the horizon (shader.ts SILL_SEAT), at
 * 0.8 screen heights a metre; the plum wall; the reading lamp out of frame to the right a little above
 * the sill, its light squashed so it spreads along the sill; a little light all round.
 */
export const SILL_ROOM: Room = {
  distance: (SILL_RIG.eye * SILL_RIG.focal) / 0.28,
  wall: [0.27, 0.24, 0.29],
  ambient: [0.05, 0.045, 0.06],
  lamp: { at: [0.1, -0.2], squash: 1.5, color: [1, 0.66, 0.34], gain: 1.35 },
};

/** The sill's layers are drawn on its frame, through this rig alone (README "Rigs, locking and offering"). */
export const ON_THE_SILL = {
  eye: [SILL_RIG.eye, SILL_RIG.eye],
  horizon: [SILL_RIG.horizon, SILL_RIG.horizon],
  focal: [SILL_RIG.focal, SILL_RIG.focal],
} as const;
