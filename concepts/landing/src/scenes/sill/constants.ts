// The constants the sill's definition (index.ts, layers.ts) shares with its code (shader.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).
import { PAINTED } from "../../composer/camera.ts";
import type { CameraRange, LightElement, Rig, Room } from "../../composer/types.ts";
import type { SkyPlanets } from "../planets.ts";

/**
 * Seconds the entrance and the exit take (SceneDef.passage; the shader reads the same). In: the cat
 * hops up onto the sill and settles, its tail curling round. Out: it stretches and hops down out of
 * frame. At rest the cat is exactly as it always was.
 */
export const SILL_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Where the night's planets hang in the city window's sky: the sill's and the interior baseline's. */
export const CITY_PLANETS: SkyPlanets = { group: "sky", across: [-38, -18, 38], up: [4, 20, 32] };

/**
 * The room's rig (README "The interior composer"), the interior baseline's rest pose
 * (composer/interior.ts): a level eye 0.35 m over the sill, its horizon where the city's is (uv 0.47)
 * and the city view's focal (one radian high), so the window's own rig is the same camera 10 m over
 * the street (shader.ts SILL_FOCAL, SILL_EYE).
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
 * The room, the interior baseline's: the sill's seat line 0.28 screen heights under the horizon
 * (shader.ts SILL_SEAT), at 0.8 screen heights a metre; the back wall 1.36 m ahead, where the sill
 * meets the window; facing the staged sky's ahead, so the sun comes in through the back window at
 * noon and slants across it morning and evening; the plum plaster wall, a little light all round;
 * the sill's painted wooden top 0.39 m deep, its nosing 2.5 cm, the radiator under it.
 */
export const SILL_ROOM: Room = {
  distance: (SILL_RIG.eye * SILL_RIG.focal) / 0.28,
  back: (SILL_RIG.eye * SILL_RIG.focal) / 0.235,
  facing: 0,
  wall: [0.27, 0.24, 0.29],
  material: "plaster",
  ambient: [0.05, 0.045, 0.06],
  ledge: {
    kind: "sill",
    front: (SILL_RIG.eye * SILL_RIG.focal) / 0.33,
    half: 1.16,
    thick: 0.025,
    albedo: [0.46, 0.29, 0.165],
  },
};

/**
 * The baseline's window: a sash window 2.1 m wide across the back wall from the sill up out of
 * frame, raised (its bottom rail 0.63 m over the sill), three panes across and two up above it,
 * letting the World in from the way the room faces (composer/shell.ts).
 */
export const SILL_WINDOW: LightElement = {
  kind: "window",
  at: [0.02, 0.75, SILL_ROOM.back],
  colour: [1, 1, 1],
  power: 1,
  reach: 1.2,
  flicker: 0,
  shadow: true,
  window: { wall: "back", size: [2.1, 1.5], bars: [3, 2], sash: 0.625 },
};

/**
 * The reading lamp out of frame to the right, a little above the sill: its warm light at the gain
 * the sill's lamp always had, its power 1 so `roomLamp` (its reach, which the painted highlights
 * take) runs 0 .. 1.
 */
export const READING_LAMP: LightElement = {
  kind: "lamp",
  at: [1.15, 0.14, 1.05],
  colour: [1.35, 0.89, 0.46],
  power: 1,
  reach: 0.65,
  flicker: 0,
  shadow: false,
};

/**
 * The sill's painted layers are drawn on its frame, through this rig alone (README "Rigs, locking
 * and offering"); a live camera moves them only within the painted tolerance, as parallax
 * (composer/camera.ts).
 */
export const ON_THE_SILL: CameraRange = {
  eye: [SILL_RIG.eye, SILL_RIG.eye],
  horizon: [SILL_RIG.horizon, SILL_RIG.horizon],
  focal: [SILL_RIG.focal, SILL_RIG.focal],
  tolerance: PAINTED,
};

/**
 * The city through the shell's window: offered at the sill's rig (its horizon is no other room's)
 * and drawn from the cell's direction (the city is far) inside the window the shell draws in metres,
 * so it holds any pose the room does.
 */
export const THROUGH_THE_SILL: CameraRange = {
  horizon: [SILL_RIG.horizon, SILL_RIG.horizon],
};
