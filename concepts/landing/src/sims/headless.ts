// Scene simulations outside the renderer, the one harness for sim regressions. `HeadlessGl` is a
// stand-in WebGL2 context for `bun test` (or a browser check that wants a sim's data rather than its
// picture): it takes the texture calls a sim makes through DataTexture (texture.ts), or the same
// calls by hand, and keeps each texture's size and its data as uploaded (a whole upload replaces
// it, a sub-rectangle, `uploadRegion`, lands in it; half-float bits are kept as the floats they
// stand for), so a test reads back exactly what the shader would sample. A canvas uploaded as an
// image (`uploadImage`) keeps its size, not its pixels; the pixel-store flags for images (flip,
// premultiplied alpha) are taken and ignored. It draws nothing: any other member (GpuCompute's, a
// program's) throws HeadlessError naming it. `HeadlessSim` drives a registered scene's real sim
// frame by frame, its code loaded first (src/scenes/index.ts `loadScene`), on a HeadlessGl or on a
// real context, each frame built the way the renderer builds it. On a HeadlessGl, where the runtime
// has no OffscreenCanvas (bun), it stands in a `HeadlessCanvas` for a sim that paints with Canvas
// 2D (marble's ink): it keeps its size and takes the paths, fills and transforms drawn on it,
// drawing nothing.
//
//   new HeadlessGl()              `.gl`, the context to build a sim on
//     upload(texture)             { width, height, data }: the texture's size and a copy of its data
//                                 as uploaded, the same array until the next upload; throws
//                                 HeadlessError for no texture, or one never uploaded from data
//   new HeadlessSim(scene, gl?)   the loaded scene's sim on a fresh HeadlessGl, unless a real context
//                                 is given
//     frame(frame?)               one frame: the textures the sim returns, in slot order (uSim0..uSim3)
//     step(frame?)                the same frame, on the HeadlessGl; returns the HeadlessSim
//     upload(slot)                that slot's texture after the latest frame, as `HeadlessGl.upload`
//     uploaded(slot)              whether it holds data yet (a sim warming up may hand over textures
//                                 it has not filled)
//     time, motionTime            the scene and motion clocks, summed as the renderer sums them
//     phases                      the rate knobs' phases (SimFrame.phases), integrated as the renderer
//                                 integrates them
//     now                         the wall clock handed over as SimFrame.now, milliseconds
//     dispose()                   the sim's
//     interest(aspect)            the sim's points of interest (SceneSim.interest; none without it),
//                                 for a test that runs the cast (src/principals.ts) against the sim
//
// A HeadlessFrame is all optional: dt 1/60 s, motion 1, aspect 16 / 9 at 540 cells high, the visitor
// over the page at its centre with no button and no agents beside it, no parallax, a dry world with
// nothing falling (`weather`), arrived and not leaving. Each principal moves at what it moved since
// the previous frame over the frame's wall time, unless its velocity is given. The wall clock
// (SimFrame.now) moves on by `elapsed` milliseconds a frame, by default dt's (a sixtieth of a second
// while dt is 0, as a paused page goes on drawing), and the budget is Infinity, so a warm-up ends in
// the first frame (give a finite `budget` to test one spread over frames). `knobs` are keyed as in
// the URL (features also `<key>-amount`) and handed over as given, unclamped, so a test may go past
// a slider's end; the rest are at their defaults, as the lab fills them, so `params` and `values` are
// what the renderer would hand over. `now` presses those knobs' "now" buttons just before the frame:
// each slot is stamped on the clock as it stood and keeps its stamp, as the lab's, and the frame
// reports it fired; a sim's first frame, as in the renderer, reports no presses.
//
// Usage (a drag held still while the screen turns portrait must not move the plane):
//   const sim = new HeadlessSim(await loadScene("hyperbolic"));
//   const at = { x: 0.6, y: 0.55, inside: true, down: true };
//   sim.step({ pointer: { ...at, pressed: true } });
//   const before = sim.step({ pointer: at }).upload(0).data;
//   const after = sim.step({ pointer: at, aspect: 9 / 16 }).upload(0).data;
//
// Rows run bottom to top, as DataTexture uploads them.
import { effective, knobDef, MAX_TRIGGERS } from "../params.ts";
import { principal } from "../principals.ts";
import { RatePhases } from "../rate-phase.ts";
import { sceneIds } from "../scenes/index.ts";
import type {
  LoadedScene,
  PrincipalState,
  ScenePassageProgress,
  ScenePoint,
  SceneSim,
} from "../scenes/types.ts";
import { paramDefaults } from "../state.ts";
import { halfValue } from "./half.ts";

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
  /** `data` has been handed out (`upload`): the next sub-rectangle writes into a copy, not into it. */
  shared = false;
}

export class HeadlessGl {
  readonly gl: WebGL2RenderingContext;
  #bound: HeadlessTexture | undefined;
  /** UNPACK_ROW_LENGTH: texels between the starts of two rows of a sub-rectangle's source (0: its width). */
  #rowLength = 0;

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
      UNPACK_ROW_LENGTH: 0x0cf2,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      UNSIGNED_BYTE: 0x1401,
      FLOAT: 0x1406,
      HALF_FLOAT: 0x140b,
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
      pixelStorei: (name: number, value: number): void => {
        if (name === 0x0cf2) this.#rowLength = value;
      },
      // (target, level, internal, width, height, border, format, type, pixels), or from an image
      // (target, level, internal, format, type, source): its size is kept, its pixels are not.
      texImage2D: (...args: unknown[]): void => {
        const texture = this.#texture();
        const source =
          args.length === 6 ? (args[5] as { width: number; height: number }) : undefined;
        const pixels = args[8];
        texture.width = source ? source.width : (args[3] as number);
        texture.height = source ? source.height : (args[4] as number);
        texture.data =
          pixels instanceof Float32Array || pixels instanceof Uint8Array
            ? pixels.slice()
            : undefined;
        texture.shared = false;
      },
      // (target, level, x, y, width, height, format, type, data, srcOffset?): the whole texture
      // replaces the kept copy; a sub-rectangle lands in it (on zeros if the texture had none, as
      // texImage2D(null) leaves it), its rows read from srcOffset UNPACK_ROW_LENGTH texels apart. A
      // copy already handed out stays as it was: the first sub-rectangle after that writes a new one.
      // Half-float bits (a Uint16Array, sent as HALF_FLOAT) are kept as the floats they hold.
      texSubImage2D: (
        _target: number,
        _level: number,
        x: number,
        y: number,
        width: number,
        height: number,
        format: number,
        type: number,
        data: Float32Array | Uint8Array | Uint16Array,
        srcOffset = 0,
      ): void => {
        const texture = this.#texture();
        const half = data instanceof Uint16Array;
        if (half !== (type === 0x140b))
          throw new HeadlessError("headless: half-float bits go up as HALF_FLOAT, and only they");
        const channels = format === 0x1903 ? 1 : format === 0x8227 ? 2 : 4;
        const stride = (this.#rowLength > 0 ? this.#rowLength : width) * channels;
        if (
          x < 0 ||
          y < 0 ||
          x + width > texture.width ||
          y + height > texture.height ||
          srcOffset + (height - 1) * stride + width * channels > data.length
        )
          throw new HeadlessError("headless: texSubImage2D outside the texture or its data");
        const whole = width === texture.width && height === texture.height;
        const shared = texture.shared;
        texture.shared = false;
        if (whole && srcOffset === 0 && stride === width * channels) {
          texture.data =
            data instanceof Uint16Array ? Float32Array.from(data, halfValue) : data.slice();
          return;
        }
        const size = texture.width * texture.height * channels;
        const kept =
          texture.data === undefined
            ? data instanceof Uint8Array
              ? new Uint8Array(size)
              : new Float32Array(size)
            : shared
              ? texture.data.slice()
              : texture.data;
        if (kept.length !== size)
          throw new HeadlessError("headless: a sub-rectangle in another format than the texture's");
        for (let row = 0; row < height; row++) {
          const from = srcOffset + row * stride;
          const to = ((y + row) * texture.width + x) * channels;
          const source = data.subarray(from, from + width * channels);
          if (source instanceof Uint16Array)
            for (let i = 0; i < source.length; i++) kept[to + i] = halfValue(source[i] ?? 0);
          else kept.set(source, to);
        }
        texture.data = kept;
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

  /** The texture's size and its data as uploaded (a copy); throws if there is none. */
  upload(texture: WebGLTexture | undefined): HeadlessUpload {
    if (!(texture instanceof HeadlessTexture) || texture.data === undefined)
      throw new HeadlessError("headless: that texture has not been uploaded");
    texture.shared = true;
    return { width: texture.width, height: texture.height, data: texture.data };
  }

  #texture(): HeadlessTexture {
    if (!this.#bound) throw new HeadlessError("headless: no texture bound");
    return this.#bound;
  }
}

/**
 * A stand-in OffscreenCanvas for a sim that paints with Canvas 2D (marble's ink): it keeps its size,
 * and its "2d" context takes the paths, fills, clears and transforms such a sim draws and draws
 * nothing. Any other member throws HeadlessError naming it, as HeadlessGl's do.
 */
export class HeadlessCanvas {
  width: number;
  height: number;
  readonly #context: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const ignore = (): void => undefined;
    const context: Record<string, unknown> = {
      globalCompositeOperation: "source-over",
      fillStyle: "#000000",
      setTransform: ignore,
      clearRect: ignore,
      beginPath: ignore,
      moveTo: ignore,
      lineTo: ignore,
      closePath: ignore,
      fill: ignore,
    };
    this.#context = new Proxy(context, {
      get(target, name) {
        if (typeof name !== "string") return undefined;
        if (Object.hasOwn(target, name)) return target[name];
        throw new HeadlessError(`headless: canvas context.${name} is not stood in for`);
      },
      set(target, name, value: unknown) {
        if (typeof name !== "string" || !Object.hasOwn(target, name))
          throw new HeadlessError(`headless: canvas context.${String(name)} is not stood in for`);
        target[name] = value;
        return true;
      },
    }) as unknown as OffscreenCanvasRenderingContext2D;
  }

  getContext(kind: string): OffscreenCanvasRenderingContext2D {
    if (kind !== "2d")
      throw new HeadlessError(`headless: a canvas's "${kind}" context is not stood in for`);
    return this.#context;
  }
}

/** One frame for HeadlessSim; everything is optional. */
export interface HeadlessFrame {
  /** Seconds on the scene clock (default 1/60). */
  dt?: number;
  /**
   * Wall-clock milliseconds since the previous frame, added to SimFrame.now (default dt × 1000, or
   * 1000 / 60 while dt is 0).
   */
  elapsed?: number;
  /** SimFrame.budget, milliseconds (default Infinity). */
  budget?: number;
  /** The lab's motion 0..1 (default 1). */
  motion?: number;
  /** width / height (default 16 / 9) and the height in cells (default 540). */
  aspect?: number;
  height?: number;
  /** Knobs keyed as in the URL (features also `<key>-amount`), as given; the rest at their defaults. */
  knobs?: Readonly<Record<string, number>>;
  /** The visitor (principal 0, SimFrame.pointer): over the page at its centre, no button, unless given. */
  pointer?: Partial<PrincipalState>;
  /** The principals after the visitor, in order: agents over the page, unless given (default none). */
  agents?: readonly Partial<PrincipalState>[];
  /** The smoothed pointer parallax, -1..1 each way (default 0, 0). */
  parallax?: Partial<{ x: number; y: number }>;
  /** SimFrame.weather: how wet the world is, how much snow lies, the rain falling (default all 0). */
  weather?: Partial<{ wet: number; lying: number; rain: number }>;
  /** Knobs whose "now" was pressed since the previous frame. */
  now?: readonly string[];
  /** Default: arrived, not leaving. */
  passage?: Partial<ScenePassageProgress>;
}

const NEVER = -1e4;

export class HeadlessSim {
  readonly #scene: LoadedScene;
  readonly #defaults: Readonly<Record<string, number>>;
  readonly #headless: HeadlessGl | undefined;
  readonly #sim: SceneSim;
  readonly #triggers = new Array<number>(MAX_TRIGGERS).fill(NEVER);
  readonly #seen = new Array<number>(MAX_TRIGGERS).fill(NEVER);
  readonly #fired = new Array<boolean>(MAX_TRIGGERS).fill(false);
  #entered = true;
  #textures: readonly (WebGLTexture | undefined)[] = [];
  #time = 0;
  #motionTime = 0;
  #now = 0;
  readonly #phases: RatePhases;
  /** The previous frame's principals, for their velocities. */
  #principals: readonly PrincipalState[] = [];

  constructor(scene: LoadedScene, gl?: WebGL2RenderingContext) {
    const id = sceneIds.find((candidate) => candidate === scene.id);
    if (id === undefined)
      throw new HeadlessError(`headless: '${scene.id}' is not a registered scene`);
    if (scene.sim === undefined) throw new HeadlessError(`headless: '${scene.id}' has no sim`);
    this.#scene = scene;
    this.#defaults = paramDefaults(id);
    this.#phases = new RatePhases(scene.params);
    if (gl === undefined) {
      // bun has no OffscreenCanvas; a sim that paints with Canvas 2D (marble) gets the stand-in.
      if (typeof OffscreenCanvas === "undefined")
        Object.assign(globalThis, { OffscreenCanvas: HeadlessCanvas });
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

  get now(): number {
    return this.#now;
  }

  get phases(): Readonly<Record<string, number>> {
    return this.#phases.byKey;
  }

  frame(options: HeadlessFrame = {}): readonly (WebGLTexture | undefined)[] {
    const dt = options.dt ?? 1 / 60;
    const motion = options.motion ?? 1;
    const aspect = options.aspect ?? 16 / 9;
    const height = options.height ?? 540;
    const params = { ...this.#defaults, ...options.knobs };
    for (const key of options.now ?? []) {
      const slot = knobDef("headless", this.#scene.params, key).trigger;
      if (slot === undefined) throw new HeadlessError(`headless: the '${key}' knob has no "now"`);
      this.#triggers[slot] = this.#time;
    }
    const values = this.#scene.params.map((def) => effective(def, params));
    this.#time += dt;
    this.#motionTime += dt * motion;
    this.#phases.step(values, dt * motion);
    const elapsed = options.elapsed ?? (dt > 0 ? dt * 1000 : 1000 / 60);
    this.#now += elapsed;
    const seconds = Math.min(elapsed / 1000, 0.1);
    const visitor = this.#principal(0, { inside: true, ...options.pointer }, seconds);
    const principals = [
      visitor,
      ...(options.agents ?? []).map((agent, i) =>
        this.#principal(i + 1, { inside: true, kind: "agent", ...agent }, seconds),
      ),
    ];
    this.#principals = principals;
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
      now: this.#now,
      budget: options.budget ?? Infinity,
      width: Math.round(height * aspect),
      height,
      aspect,
      values,
      params,
      phases: this.#phases.byKey,
      triggers: this.#triggers,
      fired: this.#fired,
      pointer: visitor,
      principals,
      parallax: { x: 0, y: 0, ...options.parallax },
      weather: { wet: 0, lying: 0, rain: 0, ...options.weather },
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
    if (texture === undefined)
      throw new HeadlessError(`headless: '${this.#scene.id}' left slot ${slot} empty`);
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

  interest(aspect: number): readonly ScenePoint[] {
    return this.#sim.interest?.(aspect) ?? [];
  }

  /**
   * Principal `index` as given (`at` over a principal at rest, see `principal`), moving at what it
   * moved since the previous frame over `seconds`, unless its velocity is given.
   */
  #principal(index: number, at: Partial<PrincipalState>, seconds: number): PrincipalState {
    const p = principal(at);
    const was = this.#principals[index];
    if (at.vx === undefined) p.vx = was !== undefined && seconds > 0 ? (p.x - was.x) / seconds : 0;
    if (at.vy === undefined) p.vy = was !== undefined && seconds > 0 ? (p.y - was.y) / seconds : 0;
    return p;
  }

  #standIn(): HeadlessGl {
    if (this.#headless === undefined)
      throw new HeadlessError(
        "headless: a sim on a real context keeps its uploads there; use frame",
      );
    return this.#headless;
  }
}
