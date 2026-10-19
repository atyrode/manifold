// Where the cast's agents go at sea (LayerSim.interest): the boats riding at anchor, as many as the
// boats layer's switch brings in, and the lighthouse's lamp on the headland while it stands. Nothing
// here moves the picture: the shader draws the boats on its own clock, so a frame only notes the
// knob and writes nothing.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import type { ScenePoint } from "../types.ts";
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

/** The boats layer's sim (LayerCode.sim), for a composition whose `params` carry `boats`. */
export function boatsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  const knobs = new KnobReader<"boats">("boats", params, ["boats"]);
  let boats = knobs.initial("boats");
  return {
    frame(frame: LayerFrame) {
      boats = knobs.value(frame, "boats");
    },
    interest(aspect) {
      return swellInterest(aspect, boats, false);
    },
    dispose() {},
  };
}

/** The lighthouse layer's sim (LayerCode.sim): its lamp, while it stands. */
export function lighthouseSim(): LayerSim {
  return {
    frame() {},
    interest(aspect) {
      return swellInterest(aspect, 0, true);
    },
    dispose() {},
  };
}
