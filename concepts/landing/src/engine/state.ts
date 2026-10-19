// The state texture (RGBA32F, the canvas scene's sim slot 1): the sim state of every instance of a
// kind that keeps one (KindDef.state, stepped by KindCode.sim), which the kind's GLSL reads back per
// instance as `<id>State(o, x, y)` (src/engine/glsl.ts). An instance's sim is keyed by its object's
// id: it lives through the object's moves and option edits, a new object's sim runs its warm-up
// (a step count, within the frame's budget: src/sims/clock.ts) before it shows, and a removed
// object's sim is dropped. Every sim of a kind steps on one FixedStep of motion time, so a seed plays
// the same at 60 and at 144 Hz (state.test.ts); the picture shows the state of the last whole step.
//
//   kind k with a state of w × h texels: rows stateRow(k) .. stateRow(k) + h - 1, its instance i
//   (its index among the document's objects of its kind, as the instance texture counts them) from
//   texel i * w. The layout is the same for every document; a slot without an instance, or with one
//   still warming up, holds zeros.
import { FixedStep, runBudgeted } from "../sims/clock.ts";
import { floatTexture } from "./instances.ts";
import { kindById, kindCode, kindRow, kinds, optionValues } from "./kinds/index.ts";
import type { EngineDoc, InstanceSim, KindDef, KindSim, Placed } from "./types.ts";

/** Most steps of a kind's sims one frame runs; motion time owed past them is dropped. */
const MAX_STEPS = 8;
/** Warm-up steps between two looks at the clock. */
const WARM_CHUNK = 64;
/** WebGL 2's guaranteed MAX_TEXTURE_SIZE. */
const TEXTURE_LIMIT = 2048;

/** The kinds that keep state, each with its state's size, and the first row of each. */
const blocks = kinds.flatMap((kind) => (kind.state === undefined ? [] : [{ kind, ...kind.state }]));
const firstRows = new Map<KindDef, number>();
let rows = 0;
for (const block of blocks) {
  firstRows.set(block.kind, rows);
  rows += block.height;
}

/** The texture's size: every stateful kind's rows, each as wide as its `max` instances' blocks. */
export const STATE_WIDTH = Math.max(1, ...blocks.map((block) => block.width * block.kind.max));
export const STATE_HEIGHT = Math.max(1, rows);
if (STATE_WIDTH > TEXTURE_LIMIT || STATE_HEIGHT > TEXTURE_LIMIT)
  throw new RangeError(`engine: a state texture of ${STATE_WIDTH} x ${STATE_HEIGHT} texels`);

/** The first row of `kind`'s states; throws for a kind that keeps none. */
export function stateRow(kind: KindDef): number {
  const row = firstRows.get(kind);
  if (row === undefined) throw new RangeError(`engine: kind ${kind.id} keeps no state`);
  return row;
}

/** A stable seed for an object's id (FNV-1a): the same object starts the same way every time. */
function seedOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** One object's sim as it runs. */
interface Running {
  readonly kind: KindDef;
  readonly def: KindSim;
  readonly sim: InstanceSim;
  /** Its object as last seen, and that object's option values. */
  placed: Placed;
  options: Readonly<Record<string, number>>;
  /** Warm-up steps run (def.warmSteps: done). */
  warmed: number;
  /** The last advance() that found its object in the document. */
  seen: number;
}

/** The sims of a document's stateful objects, and their states as the texture holds them. */
export class InstanceStates {
  /** The texture's image, STATE_WIDTH × STATE_HEIGHT RGBA (the header). */
  readonly data = new Float32Array(STATE_WIDTH * STATE_HEIGHT * 4);
  readonly #running = new Map<string, Running>();
  readonly #clocks = new Map<KindDef, FixedStep>();
  /** A block of each stateful kind's size, each instance's written into it first. */
  readonly #scratch = new Map(
    blocks.map((block) => [block.kind, new Float32Array(block.width * block.height * 4)]),
  );
  /** Instances of each kind row counted so far while writing. */
  readonly #counts = new Int32Array(kinds.length + 1);
  #doc: EngineDoc | undefined;
  #advances = 0;

  /**
   * Run `doc`'s sims on by `seconds` of motion time (each kind's whole steps, MAX_STEPS at most), a
   * new object's warm-up first within `budgetMs`; true when `data` changed.
   */
  advance(doc: EngineDoc, seconds: number, budgetMs: number): boolean {
    let changed = doc !== this.#doc;
    this.#doc = doc;
    const now = ++this.#advances;
    for (const placed of doc.objects) {
      const kind = kindById(placed.kind);
      const def = kind?.state === undefined ? undefined : kindCode(kind.id)?.sim;
      if (kind === undefined || def === undefined) continue;
      const run = this.#running.get(placed.id);
      if (run === undefined || run.kind !== kind) {
        const options = optionValues(kind, placed);
        const sim = def.create(seedOf(placed.id), options);
        this.#running.set(placed.id, { kind, def, sim, placed, options, warmed: 0, seen: now });
        changed = true;
        continue;
      }
      if (run.placed !== placed) {
        run.placed = placed;
        run.options = optionValues(kind, placed);
      }
      run.seen = now;
    }
    for (const [id, run] of this.#running) {
      if (run.seen === now) continue;
      this.#running.delete(id);
      changed = true;
    }
    for (const run of this.#running.values()) {
      if (run.warmed >= run.def.warmSteps) continue;
      run.warmed = runBudgeted(
        (i) => run.sim.warm(i, run.options),
        budgetMs,
        run.def.warmSteps,
        run.warmed,
        WARM_CHUNK,
      );
      if (run.warmed >= run.def.warmSteps) changed = true;
    }
    for (const { kind } of blocks) {
      let steps = -1;
      for (const run of this.#running.values()) {
        if (run.kind !== kind || run.warmed < run.def.warmSteps) continue;
        if (steps < 0) steps = this.#clock(kind, run.def).advance(seconds);
        for (let k = 0; k < steps; k++) run.sim.step(run.options);
      }
      // A kind with nothing running owes nothing: its next instance starts on a fresh clock.
      if (steps < 0) this.#clocks.get(kind)?.reset();
      if (steps > 0) changed = true;
    }
    if (changed) this.#write(doc);
    return changed;
  }

  #clock(kind: KindDef, def: KindSim): FixedStep {
    let clock = this.#clocks.get(kind);
    if (clock === undefined) {
      clock = new FixedStep(def.step, MAX_STEPS);
      this.#clocks.set(kind, clock);
    }
    return clock;
  }

  /** Every warmed instance's state into its block of `data`; zeros elsewhere. */
  #write(doc: EngineDoc): void {
    const data = this.data;
    data.fill(0);
    this.#counts.fill(0);
    for (const placed of doc.objects) {
      const kind = kindById(placed.kind);
      const block = kind === undefined ? undefined : this.#scratch.get(kind);
      if (kind?.state === undefined || block === undefined) continue;
      const row = kindRow(kind);
      const i = this.#counts[row] ?? 0;
      this.#counts[row] = i + 1;
      const run = this.#running.get(placed.id);
      if (run === undefined || run.warmed < run.def.warmSteps || i >= kind.max) continue;
      block.fill(0);
      run.sim.write(block);
      const { width, height } = kind.state;
      const first = stateRow(kind);
      for (let y = 0; y < height; y++) {
        const from = y * width * 4;
        const to = ((first + y) * STATE_WIDTH + i * width) * 4;
        for (let k = 0; k < width * 4; k++) data[to + k] = block[from + k] ?? 0;
      }
    }
  }
}

/** The state texture on the GPU: the document's sims run on each frame, uploaded when they change. */
export class StateTexture {
  readonly #gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly states = new InstanceStates();

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.texture = floatTexture(gl, STATE_WIDTH, STATE_HEIGHT);
  }

  /** Run `doc`'s sims on by `seconds` of motion time (InstanceStates.advance) and upload them. */
  show(doc: EngineDoc, seconds: number, budgetMs: number): void {
    if (!this.states.advance(doc, seconds, budgetMs)) return;
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      STATE_WIDTH,
      STATE_HEIGHT,
      gl.RGBA,
      gl.FLOAT,
      this.states.data,
    );
  }

  dispose(): void {
    this.#gl.deleteTexture(this.texture);
  }
}
