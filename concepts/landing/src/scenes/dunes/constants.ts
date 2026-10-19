// What the dunes' preset and layer manifests (index.ts, layers.ts) share with their GLSL and sim
// (shader.ts, sim.ts), without loading them: the passage, the aerial camera and the rig made of it,
// the sand sea's scale for the World, and the gate of the overhead view.
import type { Grade, Rig } from "../../composer/types.ts";

/**
 * Seconds of the dunes' entrance and exit (SceneDef.passage). Arriving, the camera glides in low
 * over the crests and settles while a veil of blown sand streams away downwind and clears; leaving,
 * the wind rises and a veil of sand streams in across the picture.
 */
export const DUNES_PASSAGE = { enter: 2.6, exit: 1.5 } as const;

/**
 * The aerial camera in grid space (the sim's cells, sim.ts): where it stands, its eye `height` plus
 * `rise` times the mean sand depth above the bed (more sand, taller dunes), viewRay's horizon and
 * fov, and `turn`, how far grid xz is turned from view xz (grid.xz = rotate(view.xz, turn)), so the
 * wind blows left to right and toward the viewer and the ridges run slantwise across the view, one
 * behind the other to the horizon. `look` turns the sky the same way (sky.xz = rotate(view.xz,
 * look)): the camera faces 29° left of the sky library's "ahead", so the setting sun stands in the
 * picture and its light rakes across the dunes rather than straight into the lens. `parallax` is how
 * far (radians) the view turns toward the pointer's side at full parallax (view.xz turned by
 * -uPointer.x times it).
 */
export const DUNES_CAMERA = {
  x: 186,
  z: 88,
  height: 14,
  rise: 1.6,
  horizon: 0.66,
  fov: 0.8,
  turn: 0.7,
  look: 0.5,
  parallax: 0.035,
} as const;

/**
 * The sand sea's scale for the World and the composer (WorldView.unit): grid cells per metre. A cell
 * is about 5 m, so the dunes stand 10-50 m high a few hundred metres apart, the eye flies some 80 m
 * over the sand and the M is a butte 40-75 m tall.
 */
export const DUNES_UNIT = 0.2;

/**
 * The dunes' rig: the aerial camera as the outdoor composer takes it, in metres. The horizon and the
 * focal length of viewRay at the camera's field, turned by its `look` into the sky's frame, the eye
 * at the camera's height over the bare bed; the dune field's own begin raises it with the sand
 * supply and glides it in through the passage (shader.ts dunesCell, dunesBegin). No stage: nothing
 * is laid out across the frame's width.
 */
export const DUNES_RIG: Rig = {
  horizon: DUNES_CAMERA.horizon,
  focal: 0.5 / Math.tan(0.5 * DUNES_CAMERA.fov),
  eye: DUNES_CAMERA.height / DUNES_UNIT,
  turn: DUNES_CAMERA.look,
  pitch: 0,
  minAspect: 1,
};

/**
 * The dunes' grade: their own light over the World's sky (shader.ts dunesLight) stands in for the
 * composer's tints; an exposure of 1 clamps the picture before the ink, as the scene always did.
 */
export const DUNES_GRADE: Grade = { exposure: 1, ink: { gain: 1.1, gamma: 0.85 } };

/**
 * The gate of the view from straight above (the dune field's `camera` knob at 1): a program of the
 * dunes' own, not the composer's, until the overhead composer takes it as `dunesabove` (ADR 0062
 * Phase 4; index.ts, code.ts).
 */
export const DUNES_OVERHEAD = "DUNES_OVERHEAD";
