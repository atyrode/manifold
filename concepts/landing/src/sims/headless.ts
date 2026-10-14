// Scene simulations outside the renderer, the one harness for sim regressions. `HeadlessGl` is a
// stand-in WebGL2 context for `bun test` (or a browser check that wants a sim's data rather than its
// picture): it takes the texture calls a sim makes through DataTexture (texture.ts), or the same
// calls by hand, and keeps each texture's size and last data upload, so a test reads back exactly
// what the shader would sample. It draws nothing: any other member (GpuCompute's, a program's)
// throws HeadlessError naming it. `HeadlessSim` drives a registered scene's real sim frame by frame,
// on a HeadlessGl or on a real context, each frame built the way the renderer builds it.
//
//   new HeadlessGl()              `.gl`, the context to build a sim on
//     upload(texture)             { width, height, data }: the texture's size and a copy of its last
//                                 upload, the same array until the next one; throws HeadlessError for
//                                 no texture, or one never uploaded from data
//   new HeadlessSim(scene, gl?)   the scene's sim on a fresh HeadlessGl, unless a real context is given
//     frame(frame?)               one frame: the textures the sim returns, in slot order (uSim0..uSim3)
//     step(frame?)                the same frame, on the HeadlessGl; returns the HeadlessSim
//     upload(slot)                that slot's texture after the latest frame, as `HeadlessGl.upload`
//     uploaded(slot)              whether it holds data yet (a sim warming up may hand over textures
//                                 it has not filled)
//     time, motionTime            the scene and motion clocks, summed as the renderer sums them
//     dispose()                   the sim's
//
// A HeadlessFrame is all optional: dt 1/60 s, motion 1, aspect 16 / 9 at 540 cells high, the pointer
// over the page at its centre with no button, no parallax, arrived and not leaving. `knobs` are read
// as the lab reads them from a URL (keys as in the URL, features also `<key>-amount`; missing ones at
// their defaults, values clamped to their knobs), so `params` and `values` are what the renderer
// would hand over. `now` presses those knobs' "now" buttons just before the frame: each slot is
// stamped on the clock as it stood and keeps its stamp, as the lab's, and the frame reports it fired;
// a sim's first frame, as in the renderer, reports no presses.
//
// Usage (a drag held still while the screen turns portrait must not move the plane):
//   const sim = new HeadlessSim(hyperbolicScene);
//   const at = { x: 0.6, y: 0.55, inside: true, down: true };
//   sim.step({ pointer: { ...at, pressed: true } });
//   const before = sim.step({ pointer: at }).upload(0).data;
//   const after = sim.step({ pointer: at, aspect: 9 / 16 }).upload(0).data;
//
// Rows run bottom to top, as DataTexture uploads them.
import { effective, knobDef, MAX_TRIGGERS } from "../params.ts";
import { sceneIds, type SceneId } from "../scenes/index.ts";
import type { PointerState, ScenePassageProgress, SceneDef, SceneSim } from "../scenes/types.ts";
import { readParams } from "../state.ts";

export class HeadlessError extends Error {}

/** A texture as its sim last uploaded it. */
export interface HeadlessUpload {
  width: number;
  height: number;
  data: Float32Array | Uint8Array;
}

class HeadlessTexture {
  width = 0;
  height = 0;
  data: Float32Array | Uint8Array | undefined;
}

export class HeadlessGl {
  readonly gl: WebGL2RenderingContext;
  #bound: HeadlessTexture | undefined;

  constructor() {
    const context: Record<string, unknown> = {
      TEXTURE_2D: 0x0de1,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      NEAREST: 0x2600,
      LINEAR: 0x2601,
      CLAMP_TO_EDGE: 0x812f,
      REPEAT: 0x2901,
      UNPACK_ALIGNMENT: 0x0cf5,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNSIGNED_BYTE: 0x1401,
      FLOAT: 0x1406,
      RED: 0x1903,
      RG: 0x8227,
      RGBA: 0x1908,
      R8: 0x8229,
      RG8: 0x822b,
      RGBA8: 0x8058,
      R16F: 0x822d,
      RG16F: 0x822f,
      RGBA16F: 0x881a,
      RGBA32F: 0x8814,
      createTexture: (): HeadlessTexture => new HeadlessTexture(),
      bindTexture: (_target: number, texture: HeadlessTexture | null): void => {
        this.#bound = texture ?? undefined;
      },
      deleteTexture: (): void => undefined,
      texParameteri: (): void => undefined,
      pixelStorei: (): void => undefined,
      // (target, level, internal, width, height, border, format, type, pixels), or from an image
      // (target, level, internal, format, type, source): its size is kept, its pixels are not.
      texImage2D: (...args: unknown[]): void => {
        const texture = this.#texture();
        const source = args.length === 6 ? (args[5] as { width: number; height: number }) : undefined;
        const pixels = args[8];
        texture.width = source ? source.width : (args[3] as number);
        texture.height = source ? source.height : (args[4] as number);
        texture.data = pixels instanceof Float32Array || pixels instanceof Uint8Array ? pixels.slice() : undefined;
      },
      texSubImage2D: (_target: number, _level: number, x: number, y: number, width: number, height: number, _format: number, _type: number, data: Float32Array | Uint8Array): void => {
        const texture = this.#texture();
        if (x !== 0 || y !== 0 || width !== texture.width || height !== texture.height) throw new HeadlessError("headless: only whole-texture uploads are kept");
        texture.data = data.slice();
      },
    };
    // DataTexture's surface and nothing more: any other member throws rather than quietly misleads.
    this.gl = new Proxy(context, {
      get(target, name) {
        if (typeof name !== "string") return undefined;
        if (Object.hasOwn(target, name)) return target[name];
        throw new HeadlessError(`headless: gl.${name} is not stood in for`);
      },
    }) as unknown as WebGL2RenderingContext;
  }

  /** The texture's size and its last upload (a copy); throws if there is none. */
  upload(texture: WebGLTexture | undefined): HeadlessUpload {
    if (!(texture instanceof HeadlessTexture) || texture.data === undefined) throw new HeadlessError("headless: that texture has not been uploaded");
    return { width: texture.width, height: texture.height, data: texture.data };
  }

  #texture(): HeadlessTexture {
    if (!this.#bound) throw new HeadlessError("headless: no texture bound");
    return this.#bound;
  }
}

/** One frame for HeadlessSim; everything is optional. */
export interface HeadlessFrame {
  /** Seconds on the scene clock (default 1/60). */
  dt?: number;
  /** The lab's motion 0..1 (default 1). */
  motion?: number;
  /** width / height (default 16 / 9) and the height in cells (default 540). */
  aspect?: number;
  height?: number;
  /** Knobs keyed as in the URL (features also `<key>-amount`), read as the lab reads a URL. */
  knobs?: Readonly<Record<string, number>>;
  /** Over the page at its centre, no button, unless given. */
  pointer?: Partial<PointerState>;
  /** The smoothed pointer parallax, -1..1 each way (default 0, 0). */
  parallax?: Partial<{ x: number; y: number }>;
  /** Knobs whose "now" was pressed since the previous frame. */
  now?: readonly string[];
  /** Default: arrived, not leaving. */
  passage?: Partial<ScenePassageProgress>;
}

const NEVER = -1e4;

export class HeadlessSim {
  readonly #scene: SceneDef;
  readonly #id: SceneId;
  readonly #headless: HeadlessGl | undefined;
  readonly #sim: SceneSim;
  readonly #triggers = new Array<number>(MAX_TRIGGERS).fill(NEVER);
  readonly #seen = new Array<number>(MAX_TRIGGERS).fill(NEVER);
  readonly #fired = new Array<boolean>(MAX_TRIGGERS).fill(false);
  #entered = true;
  #textures: readonly (WebGLTexture | undefined)[] = [];
  #time = 0;
  #motionTime = 0;

  constructor(scene: SceneDef, gl?: WebGL2RenderingContext) {
    const id = sceneIds.find((candidate) => candidate === scene.id);
    if (id === undefined) throw new HeadlessError(`headless: '${scene.id}' is not a registered scene`);
    if (scene.sim === undefined) throw new HeadlessError(`headless: '${scene.id}' has no sim`);
    this.#scene = scene;
    this.#id = id;
    if (gl === undefined) {
      const headless = new HeadlessGl();
      this.#headless = headless;
      this.#sim = scene.sim(headless.gl);
    } else {
      this.#headless = undefined;
      this.#sim = scene.sim(gl);
    }
  }

  get time(): number {
    return this.#time;
  }

  get motionTime(): number {
    return this.#motionTime;
  }

  frame(options: HeadlessFrame = {}): readonly (WebGLTexture | undefined)[] {
    const dt = options.dt ?? 1 / 60;
    const motion = options.motion ?? 1;
    const aspect = options.aspect ?? 16 / 9;
    const height = options.height ?? 540;
    const params = readParams(this.#id, new URLSearchParams(Object.entries(options.knobs ?? {}).map(([key, value]) => [key, String(value)])));
    for (const key of options.now ?? []) {
      const slot = knobDef("headless", this.#scene.params, key).trigger;
      if (slot === undefined) throw new HeadlessError(`headless: the '${key}' knob has no "now"`);
      this.#triggers[slot] = this.#time;
    }
    this.#time += dt;
    this.#motionTime += dt * motion;
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      const stamp = this.#triggers[slot] ?? NEVER;
      this.#fired[slot] = !this.#entered && stamp > NEVER && stamp !== this.#seen[slot];
      this.#seen[slot] = stamp;
    }
    this.#entered = false;
    this.#textures = this.#sim.frame({
      dt,
      time: this.#time,
      motionTime: this.#motionTime,
      motion,
      width: Math.round(height * aspect),
      height,
      aspect,
      values: this.#scene.params.map((def) => effective(def, params)),
      params,
      triggers: this.#triggers,
      fired: this.#fired,
      pointer: { x: 0.5, y: 0.5, inside: true, down: false, pressed: false, released: false, ...options.pointer },
      parallax: { x: 0, y: 0, ...options.parallax },
      passage: { enter: 1, exit: 0, ...options.passage },
    });
    return this.#textures;
  }

  step(options: HeadlessFrame = {}): this {
    this.#standIn();
    this.frame(options);
    return this;
  }

  upload(slot: number): HeadlessUpload {
    const texture = this.#textures[slot];
    if (texture === undefined) throw new HeadlessError(`headless: '${this.#scene.id}' left slot ${slot} empty`);
    return this.#standIn().upload(texture);
  }

  uploaded(slot: number): boolean {
    this.#standIn();
    const texture = this.#textures[slot];
    return texture instanceof HeadlessTexture && texture.data !== undefined;
  }

  dispose(): void {
    this.#sim.dispose();
  }

  #standIn(): HeadlessGl {
    if (this.#headless === undefined) throw new HeadlessError("headless: a sim on a real context keeps its uploads there; use frame");
    return this.#headless;
  }
}
