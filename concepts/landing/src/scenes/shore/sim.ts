// Hands' wakes on the shore: wherever a principal (the visitor, an agent) moves over the page it
// stirs the water and the wet sand, leaving a fading trail (uSim0.r) that the shader turns into
// swirls of plankton light. Noctiluca flashes only while it is being disturbed, so the trail fades
// within a couple of seconds. And the agents' cairns (knob `cairns`, cairns.ts): their stones and
// the pebbles they carry (uSim1, while there are any), on the motion clock.
import { KnobReader, type ParamDef } from "../../params.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { ScenePoint, SceneSim, SimFactory, SimFrame } from "../types.ts";
import { CAIRN_ROW, CAIRN_SITES, ShoreCairns, type CairnFrame } from "./cairns.ts";

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

type Knob = "cairns" | "size" | "period";
const KNOBS: readonly Knob[] = ["cairns", "size", "period"];
const NO_POINTS: readonly ScenePoint[] = [];
/** No hands: what the cairns are told of the principals while the scene comes or goes. */
const NO_HANDS: readonly never[] = [];

class ShoreSim implements SceneSim {
  readonly #gl: WebGL2RenderingContext;
  readonly #knobs: KnobReader<Knob>;
  #field: TrailField | undefined;
  #texture: DataTexture | undefined;
  #uploaded = -1;
  readonly #cairns = new ShoreCairns();
  readonly #stones: DataTexture;
  readonly #stoneData = new Float32Array(CAIRN_ROW * (CAIRN_SITES + 1) * 4);
  readonly #textures: (WebGLTexture | undefined)[] = [];
  /** The cairns knob, and the camera's step along the beach, as last seen. */
  #on: boolean;
  #camX = 0;
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

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<Knob>) {
    this.#gl = gl;
    this.#knobs = knobs;
    this.#on = knobs.initial("cairns") > 0;
    this.#stones = new DataTexture(gl, {
      width: CAIRN_ROW,
      height: CAIRN_SITES + 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
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
    this.#textures.length = 0;
    this.#textures.push(texture.texture);

    // The cairns, on the motion clock; the agents work at them only at rest (a passage moves the
    // camera).
    const knobs = this.#knobs;
    this.#on = knobs.value(frame, "cairns") > 0;
    this.#camX = (frame.parallax?.x ?? 0) * STEP_ALONG * frame.motion;
    if (this.#on) {
      const still = frame.passage.enter >= 1 && frame.passage.exit <= 0;
      const at = this.#at;
      at.aspect = frame.aspect;
      at.camX = this.#camX;
      at.tm = frame.motionTime;
      at.dt = frame.dt * frame.motion;
      at.period = knobs.value(frame, "period");
      at.size = knobs.value(frame, "size");
      at.stones = knobs.value(frame, "cairns");
      this.#cairns.frame(still ? frame.principals : NO_HANDS, at);
      if (this.#cairns.pack(this.#stoneData)) {
        this.#stones.upload(this.#stoneData);
        this.#textures.push(this.#stones.texture);
      }
    }
    return this.#textures;
  }

  /** The cairns' sites to work at, while the knob is on. */
  interest(aspect: number): readonly ScenePoint[] {
    return this.#on ? this.#cairns.interest(aspect, this.#camX) : NO_POINTS;
  }

  dispose(): void {
    this.#texture?.dispose();
    this.#texture = undefined;
    this.#field = undefined;
    this.#stones.dispose();
  }
}

/** The shore's sim, for a scene whose `params` carry the knobs `Knob` names. */
export function shoreSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<Knob>("shore", params, KNOBS);
  return (gl) => new ShoreSim(gl, knobs);
}
