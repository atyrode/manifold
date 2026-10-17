// Hands' wakes on the shore: wherever a principal (the visitor, an agent) moves over the page it
// stirs the water and the wet sand, leaving a fading trail (uSim0.r) that the shader turns into
// swirls of plankton light. Noctiluca flashes only while it is being disturbed, so the trail fades
// within a couple of seconds.
import { MAX_PRINCIPALS } from "../../principals.ts";
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
/** Light one pass of a hand leaves along its middle, however fast it goes. */
const PASS = 0.33;
/** Light per second while the button is held, moving or not: poking the water. */
const HELD = 7.2;

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

  const sim: SceneSim = {
    frame(frame: SimFrame) {
      const columns = Math.min(512, Math.max(16, Math.round(ROWS * frame.aspect)));
      if (field === undefined || field.width !== columns) {
        // A new aspect starts a fresh trail: the old one would land in the wrong place.
        field = new TrailField(columns, ROWS);
        uploaded = -1;
      }
      if (texture === undefined)
        texture = new DataTexture(gl, { width: columns, height: ROWS, format: "r8" });
      texture.resize(columns, ROWS);

      for (let i = 0; i < MAX_PRINCIPALS; i++) {
        const hand = frame.principals[i];
        if (hand === undefined || !hand.inside) {
          field.lift(i);
          continue;
        }
        const radius = hand.down ? HELD_RADIUS : RADIUS;
        field.stroke(hand.x, hand.y, radius, PASS, frame.aspect, i);
        if (hand.down) field.hold(hand.x, hand.y, radius, HELD * frame.dt, frame.aspect);
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
