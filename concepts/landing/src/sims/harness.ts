// Driving a scene's CPU sim without a browser, for bun:test regressions: the frames the renderer
// would hand it, from a URL query of knobs, and a WebGL2 stand-in that keeps what was last uploaded
// to each texture, so a test reads exactly what the shader would sample.
//
//   new SimHarness(def, query, { motion, width, height })   knobs parsed as the lab parses the URL
//   step(dt)       one frame of dt seconds on the scene clock; returns each texture the sim bound
//                  this frame (slot order, uSim0..uSim3) as the data last uploaded to it
//   press(key)     the knob's "now" button: stamped at the current time, felt on the next step
//   pointer        the PointerState the next step hands over (mutate it to drag or click)
//   passage        the next step's passage progress, at rest by default
//   time           the scene clock so far
//
// Only DataTexture's calls are stood in for: a sim that calls anything else on its context (a GPU
// sim) throws SimHarnessError naming the call.
//
// Usage:
//   const run = new SimHarness(prismScene, "second=1&second-amount=0.05");
//   run.press("eclipse");
//   const [fans, state] = run.step(1 / 30);
import { effective, knobDef, MAX_TRIGGERS } from "../params.ts";
import { sceneIds } from "../scenes/index.ts";
import type { PointerState, SceneDef, ScenePassageProgress, SceneSim } from "../scenes/types.ts";
import { readParams } from "../state.ts";

export class SimHarnessError extends Error {}

type Upload = Float32Array | Uint8Array;

/** A WebGL2 stand-in for DataTexture: textures are plain objects, uploads are copied and kept. */
function recordingGl(uploads: Map<object, Upload>): WebGL2RenderingContext {
  let bound: object | undefined;
  let constant = 0;
  const constants = new Map<string, number>();
  const calls: Record<string, (...args: never[]) => unknown> = {
    createTexture: () => ({}),
    bindTexture: (_target: number, texture: object) => {
      bound = texture;
    },
    texSubImage2D: (...args: unknown[]) => {
      const data = args[8];
      if (bound === undefined || !(data instanceof Float32Array || data instanceof Uint8Array)) throw new SimHarnessError("harness: texSubImage2D with no texture bound or no data");
      uploads.set(bound, data.slice());
    },
    texImage2D: () => undefined,
    texParameteri: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
  };
  const stand = new Proxy(calls, {
    get(target, name) {
      if (typeof name !== "string") return undefined;
      const call = target[name];
      if (call !== undefined) return call;
      // GL enums: any distinct number does.
      if (/^[A-Z0-9_]+$/.test(name)) {
        const known = constants.get(name) ?? ++constant;
        constants.set(name, known);
        return known;
      }
      throw new SimHarnessError(`harness: gl.${name} is not stood in for`);
    },
  });
  // The stand-in has only DataTexture's surface; anything else throws above rather than type-checks.
  return stand as unknown as WebGL2RenderingContext;
}

export class SimHarness {
  readonly pointer: PointerState = { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false };
  passage: ScenePassageProgress = { enter: 1, exit: 0 };
  readonly #def: SceneDef;
  readonly #sim: SceneSim;
  readonly #uploads = new Map<object, Upload>();
  readonly #params: Readonly<Record<string, number>>;
  readonly #values: readonly number[];
  readonly #triggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => -1e4);
  readonly #fired: boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  readonly #motion: number;
  readonly #width: number;
  readonly #height: number;
  #time = 0;
  #motionTime = 0;

  constructor(def: SceneDef, query = "", options: { motion?: number; width?: number; height?: number } = {}) {
    const id = sceneIds.find((candidate) => candidate === def.id);
    if (id === undefined) throw new SimHarnessError(`harness: '${def.id}' is not a registered scene`);
    if (def.sim === undefined) throw new SimHarnessError(`harness: '${def.id}' has no sim`);
    this.#def = def;
    this.#params = readParams(id, new URLSearchParams(query));
    this.#values = def.params.map((knob) => effective(knob, this.#params));
    this.#motion = options.motion ?? 0.6;
    this.#width = options.width ?? 960;
    this.#height = options.height ?? 540;
    this.#sim = def.sim(recordingGl(this.#uploads));
  }

  get time(): number {
    return this.#time;
  }

  press(key: string): void {
    const slot = knobDef("harness", this.#def.params, key).trigger;
    if (slot === undefined) throw new SimHarnessError(`harness: the '${key}' knob has no trigger slot`);
    this.#triggers[slot] = this.#time;
    this.#fired[slot] = true;
  }

  step(dt: number): readonly (Upload | undefined)[] {
    this.#time += dt;
    this.#motionTime += dt * this.#motion;
    const textures = this.#sim.frame({
      dt,
      time: this.#time,
      motionTime: this.#motionTime,
      motion: this.#motion,
      width: this.#width,
      height: this.#height,
      aspect: this.#width / this.#height,
      values: this.#values,
      params: this.#params,
      triggers: this.#triggers,
      fired: this.#fired,
      pointer: this.pointer,
      passage: this.passage,
    });
    this.#fired.fill(false);
    this.pointer.pressed = false;
    this.pointer.released = false;
    return textures.map((texture) => (texture === undefined ? undefined : this.#uploads.get(texture)));
  }

  dispose(): void {
    this.#sim.dispose();
  }
}
