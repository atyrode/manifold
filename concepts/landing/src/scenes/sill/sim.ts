// The cat's gaze, eased on the CPU and handed to the shader as the cat layer's record (see `catSim`).
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { easeFactor } from "../../sims/math.ts";

/** How far (in screen heights) the pointer must stray from where the cat is looking before it turns. */
const GAZE_SLACK = 0.05;
/** Seconds of a still pointer before the cat loses interest and goes back to watching the city. */
const INTEREST_SPAN = 4;
/** Time constant of the head's turn toward a new point of interest, in seconds. */
const TURN_TIME = 0.45;

/**
 * The cat's attention. A shader alone cannot ease toward a moving target or notice that the pointer
 * has stopped, so this runs on the CPU and hands the shader one texel of its row of the records atlas
 * (catRecord(0, 0)): where the head points (scene uv, eased), how interested the cat is (0..1), and
 * seconds since its gaze last jumped (to 60). It fixes on a point and holds it until the pointer
 * strays, then turns: still, then a quick move.
 */
export function catSim(): LayerSim {
  let fixX = 0.5;
  let fixY = 0.6;
  let gazeX = fixX;
  let gazeY = fixY;
  let attention = 0;
  let lastMove = Number.NEGATIVE_INFINITY;
  let lastShift = Number.NEGATIVE_INFINITY;
  let prevX = Number.NaN;
  let prevY = Number.NaN;
  return {
    frame(frame: LayerFrame) {
      const { pointer, time, aspect } = frame;
      // A scene clock that went backwards (the lab restarted it) forgets the old moments.
      if (time < lastMove) lastMove = Number.NEGATIVE_INFINITY;
      if (time < lastShift) lastShift = Number.NEGATIVE_INFINITY;
      if (
        pointer.inside &&
        (pointer.pressed || Math.abs(pointer.x - prevX) + Math.abs(pointer.y - prevY) > 1e-4)
      )
        lastMove = time;
      prevX = pointer.x;
      prevY = pointer.y;
      const interested = pointer.inside && time - lastMove < INTEREST_SPAN;
      const step = frame.dt * frame.motion;
      if (step > 0) {
        if (
          interested &&
          (pointer.pressed ||
            Math.hypot((pointer.x - fixX) * aspect, pointer.y - fixY) > GAZE_SLACK)
        ) {
          fixX = pointer.x;
          fixY = pointer.y;
          lastShift = time;
        }
        const turn = easeFactor(step, TURN_TIME);
        gazeX += (fixX - gazeX) * turn;
        gazeY += (fixY - gazeY) * turn;
        // Interest comes quickly and fades slowly.
        attention +=
          ((interested ? 1 : 0) - attention) * (1 - Math.exp(-step * (interested ? 2.5 : 0.5)));
      }
      const texel = frame.records.data;
      texel[0] = gazeX;
      texel[1] = gazeY;
      texel[2] = attention;
      texel[3] = Math.min(time - lastShift, 60);
      frame.records.touch();
    },
    dispose() {},
  };
}
