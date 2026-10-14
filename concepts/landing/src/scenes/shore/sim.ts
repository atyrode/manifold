// The pointer's wake on the shore: wherever the pointer moves over the page it stirs the water and
// the wet sand, leaving a fading trail (uSim0.r) that the shader turns into swirls of plankton light.
// Noctiluca flashes only while it is being disturbed, so the trail fades within a couple of seconds.
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Trail grid height in texels; the width follows the frame's aspect. Linear filtering smooths it. */
const ROWS = 96;
/** Seconds for a stir to fade to half its light. */
const HALF_LIFE = 1.4;
/** Radius of the stirred patch, in uv heights; a held button stirs a wider patch. */
const RADIUS = 0.035;
const HELD_RADIUS = 0.05;
/** Light per uv height of pointer travel, so a quick sweep glows brighter than a slow drift. */
const PER_TRAVEL = 9;
/** Light added each frame while the button is held, moving or not: poking the water. */
const HELD = 0.12;
/** Cap on one frame's deposit, so a jump of the pointer cannot flood the trail. */
const MAX_STROKE = 0.7;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Both are played by the shader alone
 * (shader.ts: the surf runs in from out at sea on a decelerating curve under a camera that settles,
 * and is drawn back out to sea on the way out), so this sim has nothing to do for them.
 */
export const SHORE_PASSAGE = { enter: 3, exit: 1.7 } as const;

export const shoreSim: SimFactory = (gl) => {
  let field: TrailField | undefined;
  let texture: DataTexture | undefined;
  let uploaded = -1;
  let hasLast = false;
  let lastX = 0;
  let lastY = 0;

  const sim: SceneSim = {
    frame(frame: SimFrame) {
      const columns = Math.min(512, Math.max(16, Math.round(ROWS * frame.aspect)));
      if (field === undefined || field.width !== columns) {
        // A new aspect starts a fresh trail: the old one would land in the wrong place.
        field = new TrailField(columns, ROWS);
        uploaded = -1;
        hasLast = false;
      }
      if (texture === undefined) texture = new DataTexture(gl, { width: columns, height: ROWS, format: "r8" });
      texture.resize(columns, ROWS);

      const pointer = frame.pointer;
      if (pointer.inside) {
        const travel = hasLast ? Math.hypot((pointer.x - lastX) * frame.aspect, pointer.y - lastY) : 0;
        const strength = Math.min(MAX_STROKE, travel * PER_TRAVEL + (pointer.down ? HELD : 0));
        if (strength > 0.001) field.stroke(pointer.x, pointer.y, pointer.down ? HELD_RADIUS : RADIUS, strength, frame.aspect);
        lastX = pointer.x;
        lastY = pointer.y;
        hasLast = true;
      } else {
        field.lift();
        hasLast = false;
      }
      // The glow fades on the scene's own clock, so a paused or frozen scene keeps its swirls.
      field.decay(frame.dt * frame.motion, HALF_LIFE);

      if (field.version !== uploaded) {
        texture.upload(field.data);
        uploaded = field.version;
      }
      return [texture.texture];
    },
    dispose() {
      texture?.dispose();
      texture = undefined;
      field = undefined;
    },
  };
  return sim;
};
