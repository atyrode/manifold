// The shore's layer sims (layers.ts), on the composed sim's frame (composer/sim.ts):
//   sea     hands' wakes: wherever a principal (the visitor, an agent) moves over the page it stirs
//           the water and the wet sand, leaving a fading trail (its field 0, r8, linear) that the
//           shader turns into swirls of plankton light. Noctiluca flashes only while it is being
//           disturbed, so the trail fades within a couple of seconds, on the motion clock. Its
//           affordance (SeaSurf) is the surf as it draws it, for what the swash acts on.
//   cairns  the agents' chore (cairns.ts): their stones and the pebbles they carry (its rows of the
//           records atlas, while there are any), on the motion clock, toppled by the sea's swash;
//           its sites are where the cast's agents go to work.
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { ScenePoint } from "../types.ts";
import { ShoreCairns, type CairnFrame } from "./cairns.ts";

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
/** How far the camera steps along the beach (m) for the pointer's parallax: the shader's camX. */
const STEP_ALONG = 0.35;
/** No hands: what the cairns are told of the principals while the scene comes or goes. */
const NO_HANDS: readonly never[] = [];

/**
 * What the sea lets the layers on its beach read (LayerSim.affordances): the surf's knobs as it last
 * drew them, its wave size (0..1) and period (s), which beach.ts's swashAt takes.
 */
export class SeaSurf {
  size = 0.5;
  period = 8;
}

/** The sea's wake (field 0) and its surf (see the header). */
class SeaSim implements LayerSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #knobs: KnobReader<"size" | "period">;
  readonly affordances = new SeaSurf();
  #field: TrailField | undefined;
  #texture: DataTexture | undefined;
  #uploaded = -1;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#gl = gl;
    this.#knobs = new KnobReader("shore sea", params, ["size", "period"]);
  }

  frame(frame: LayerFrame): void {
    this.affordances.size = this.#knobs.value(frame, "size");
    this.affordances.period = this.#knobs.value(frame, "period");
    const columns = Math.min(512, Math.max(16, Math.round(ROWS * frame.aspect)));
    if (this.#field === undefined || this.#field.width !== columns) {
      // A new aspect starts a fresh trail: the old one would land in the wrong place.
      this.#field = new TrailField(columns, ROWS);
      this.#uploaded = -1;
    }
    const field = this.#field;
    this.#texture ??= new DataTexture(this.#gl, { width: columns, height: ROWS, format: "r8" });
    const texture = this.#texture;
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

    if (field.version !== this.#uploaded) {
      texture.upload(field.data);
      this.#uploaded = field.version;
    }
    const slot = frame.fields[0];
    if (slot) slot.texture = texture.texture;
  }

  dispose(): void {
    this.#texture?.dispose();
    this.#texture = undefined;
    this.#field = undefined;
  }
}

/** The agents' cairns (see the header), into the cairns' rows. */
class CairnsSim implements LayerSim {
  readonly #knobs: KnobReader<"cairns">;
  readonly #cairns = new ShoreCairns();
  /** The camera's step along the beach, as last seen. */
  #camX = 0;
  /** Whether the rows held any stone or pebble last frame (they go up once more as they empty). */
  #held = false;
  /** What the cairns are told each frame, rewritten in place. */
  readonly #at: CairnFrame = {
    aspect: 16 / 9,
    camX: 0,
    tm: 0,
    dt: 0,
    period: 8,
    size: 0.5,
    stones: 5,
  };

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("shore cairns", params, ["cairns"]);
  }

  frame(frame: LayerFrame): void {
    this.#camX = (frame.parallax?.x ?? 0) * STEP_ALONG * frame.motion;
    // The surf that topples them is the sea's (the beach's host, always on with it).
    const sea = frame.host("sea");
    if (!(sea instanceof SeaSurf)) return;
    // On the motion clock; the agents work at them only at rest (a passage moves the camera).
    const still = frame.passage.enter >= 1 && frame.passage.exit <= 0;
    const at = this.#at;
    at.aspect = frame.aspect;
    at.camX = this.#camX;
    at.tm = frame.motionTime;
    at.dt = frame.dt * frame.motion;
    at.period = sea.period;
    at.size = sea.size;
    at.stones = this.#knobs.value(frame, "cairns");
    this.#cairns.frame(still ? frame.principals : NO_HANDS, at);
    const held = this.#cairns.pack(frame.records.data, ATLAS_WIDTH);
    if (held || this.#held) frame.records.touch();
    this.#held = held;
  }

  /** The cairns' sites to work at. */
  interest(aspect: number): readonly ScenePoint[] {
    return this.#cairns.interest(aspect, this.#camX);
  }

  dispose(): void {}
}

/** The sea layer's sim (LayerCode.sim). */
export function seaSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new SeaSim(gl, params);
}

/** The cairns layer's sim (LayerCode.sim): records only, no texture of its own. */
export function cairnsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new CairnsSim(params);
}
