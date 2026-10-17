// Where the cast's agents go in the swell (SceneSim.interest): the boats riding at anchor, as many
// as the `boats` knob brings in, and the lighthouse's lamp on the headland while it stands. Nothing
// here moves the picture: the shader draws the boats on its own clock, so a sim frame only notes
// the knobs and uploads nothing.
import type { ScenePoint, SceneSim, SimFactory } from "../types.ts";
import {
  SWELL_BOAT_MIDDLE,
  SWELL_BOATS,
  SWELL_CAPE,
  SWELL_FOCAL,
  SWELL_HORIZON,
} from "./constants.ts";

/** Where a point at (across, height, ahead), in camera heights, shows at rest, in uv for `aspect`. */
function seen(across: number, height: number, ahead: number, aspect: number): ScenePoint {
  return {
    x: 0.5 + (across / ahead) * (SWELL_FOCAL / aspect),
    y: SWELL_HORIZON + ((height - 1) / ahead) * SWELL_FOCAL,
  };
}

/** The points of interest for `boats` boats and the lighthouse if `lighthouse`, those in frame. */
export function swellInterest(aspect: number, boats: number, lighthouse: boolean): ScenePoint[] {
  const points = SWELL_BOATS.slice(0, Math.max(0, Math.round(boats))).map(
    ([across, ahead, length]) => seen(across, SWELL_BOAT_MIDDLE * length, ahead, aspect),
  );
  if (lighthouse) {
    const [across, height] = SWELL_CAPE.lamp;
    points.push(seen(across, height, SWELL_CAPE.ahead, aspect));
  }
  return points.filter((point) => point.x > 0 && point.x < 1 && point.y > 0 && point.y < 1);
}

export const swellSim: SimFactory = () => {
  let boats = 0;
  let lighthouse = false;
  const sim: SceneSim = {
    frame(frame) {
      boats = (frame.params["boats"] ?? 0) > 0 ? (frame.params["boats-amount"] ?? 0) : 0;
      lighthouse = (frame.params["lighthouse"] ?? 0) > 0;
      return [];
    },
    interest(aspect) {
      return swellInterest(aspect, boats, lighthouse);
    },
    dispose() {},
  };
  return sim;
};
