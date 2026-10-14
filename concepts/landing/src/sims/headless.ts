// A stand-in WebGL2 context for running a CPU simulation under `bun test`: it takes what
// DataTexture (texture.ts) asks of a context and keeps each texture's size and last upload, so a
// test can build a scene's real sim, step it with SimFrames and read back exactly what the shader
// would get. It draws nothing, and anything beyond DataTexture (GpuCompute, programs) throws.
//
//   const headless = new HeadlessGl();
//   const sim = sceneDefs.dew.sim?.(headless.gl);
//   const textures = sim.frame(frame);
//   const lists = headless.upload(textures[1]);   // { width, height, data } as last uploaded
//
// Rows run bottom to top, as DataTexture uploads them.

export class HeadlessGlError extends Error {}

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
    const context = {
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
      createTexture: (): HeadlessTexture => new HeadlessTexture(),
      bindTexture: (_target: number, texture: HeadlessTexture | null): void => {
        this.#bound = texture ?? undefined;
      },
      deleteTexture: (): void => undefined,
      texParameteri: (): void => undefined,
      pixelStorei: (): void => undefined,
      texImage2D: (_target: number, _level: number, _internal: number, width: number, height: number): void => {
        const texture = this.#texture();
        texture.width = width;
        texture.height = height;
        texture.data = undefined;
      },
      texSubImage2D: (_target: number, _level: number, x: number, y: number, width: number, height: number, _format: number, _type: number, data: Float32Array | Uint8Array): void => {
        const texture = this.#texture();
        if (x !== 0 || y !== 0 || width !== texture.width || height !== texture.height) throw new HeadlessGlError("headless: only whole-texture uploads are kept");
        texture.data = data.slice();
      },
    };
    // DataTexture uses only the members above; anything else is missing and throws when called.
    this.gl = context as unknown as WebGL2RenderingContext;
  }

  /** The texture's size and its last upload (a copy); throws if it was never uploaded. */
  upload(texture: WebGLTexture | undefined): HeadlessUpload {
    if (!(texture instanceof HeadlessTexture) || texture.data === undefined) throw new HeadlessGlError("headless: that texture has not been uploaded");
    return { width: texture.width, height: texture.height, data: texture.data };
  }

  #texture(): HeadlessTexture {
    if (!this.#bound) throw new HeadlessGlError("headless: no texture bound");
    return this.#bound;
  }
}
// A scene's simulation driven frame by frame outside the renderer: in `bun test` regressions on
// what a sim hands its shader (with a stand-in WebGL2 context that accepts every call and keeps each
// texture's last data upload), or in a browser check on a real context, feeding the scene's real
// program. Frames are built from knobs, a pointer and a frame size the way the renderer builds
// them (knobs keyed as in the URL, read through `effective`; missing knobs at their defaults).
//   headlessGl()          { gl, data(texture) }: `data` is a copy of the typed array last uploaded to
//                         that texture (texImage2D or texSubImage2D), undefined before any upload.
//                         Every other call is a no-op; constants read as 1, createTexture as a token.
//   new HeadlessSim(scene, gl?)   on the stand-in context unless a real one is given
//     frame(frame)        one renderer frame (dt 1/60 s, motion 1, 960 × 540 cells unless given): the
//                         textures the sim returns, in slot order, to bind as uSim0..uSim3
//     step(frame)         the same frame, answering the data those textures hold (stand-in only)
//     time, motionTime    the scene and motion clocks, as the renderer sums them
// Usage (a drag held still while the screen turns portrait must not move the plane):
//   const sim = new HeadlessSim(hyperbolicScene);
//   const at = { x: 0.6, y: 0.55, inside: true, down: true };
//   sim.step({ pointer: { ...at, pressed: true } });
//   const before = sim.step({ pointer: at })[0];
//   const after = sim.step({ pointer: at, aspect: 9 / 16 })[0];
import { effective, MAX_TRIGGERS } from "../params.ts";
import type { PointerState, ScenePassageProgress, SceneDef, SceneSim } from "../scenes/types.ts";
type Upload = Float32Array | Uint16Array | Uint8Array;
export interface HeadlessGl {
  data(texture: WebGLTexture | undefined): Upload | undefined;
export function headlessGl(): HeadlessGl {
  const uploads = new Map<unknown, Upload>();
  let bound: unknown;
  const keep = (data: unknown): void => {
    if (data instanceof Float32Array) uploads.set(bound, Float32Array.from(data));
    else if (data instanceof Uint16Array) uploads.set(bound, Uint16Array.from(data));
    else if (data instanceof Uint8Array) uploads.set(bound, Uint8Array.from(data));
  };
  const calls: Record<string, (...args: unknown[]) => unknown> = {
    createTexture: () => ({}),
    bindTexture: (_target, texture) => {
      bound = texture;
    },
    texImage2D: (...args) => keep(args.at(-1)),
    texSubImage2D: (...args) => keep(args.at(-1)),
  };
  const gl = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) return 1;
        return calls[name] ?? (() => undefined);
    },
  ) as WebGL2RenderingContext;
  return { gl, data: (texture) => uploads.get(texture) };
/** One frame for HeadlessSim.step; everything is optional. */
export interface HeadlessFrame {
  /** Seconds on the scene clock (default 1/60). */
  dt?: number;
  /** The lab's motion 0..1 (default 1). */
  motion?: number;
  /** width / height (default 16 / 9) and the height in cells (default 540). */
  aspect?: number;
  height?: number;
  /** Raw knobs keyed as in the URL (features also `<key>-amount`); missing ones at their defaults. */
  knobs?: Readonly<Record<string, number>>;
  /** Over the page at its centre, no button, unless given. */
  pointer?: Partial<PointerState>;
  /** Trigger slots whose "now" fired on this frame. */
  fired?: readonly number[];
  /** Default: arrived, not leaving. */
  passage?: Partial<ScenePassageProgress>;
export class HeadlessSim {
  readonly #scene: SceneDef;
  readonly #standIn: HeadlessGl | undefined;
  readonly #sim: SceneSim;
  time = 0;
  motionTime = 0;
  constructor(scene: SceneDef, gl?: WebGL2RenderingContext) {
    if (scene.sim === undefined) throw new Error(`headless: ${scene.id} has no sim`);
    this.#scene = scene;
    if (gl === undefined) {
      const standIn = headlessGl();
      this.#standIn = standIn;
      this.#sim = scene.sim(standIn.gl);
    } else {
      this.#standIn = undefined;
      this.#sim = scene.sim(gl);
    }
  frame(options: HeadlessFrame = {}): readonly (WebGLTexture | undefined)[] {
    const dt = options.dt ?? 1 / 60;
    const motion = options.motion ?? 1;
    const aspect = options.aspect ?? 16 / 9;
    const height = options.height ?? 540;
    const knobs = options.knobs ?? {};
    this.time += dt;
    this.motionTime += dt * motion;
    return this.#sim.frame({
      dt,
      time: this.time,
      motionTime: this.motionTime,
      motion,
      width: Math.round(height * aspect),
      height,
      aspect,
      values: this.#scene.params.map((def) => effective(def, knobs)),
      params: knobs,
      triggers: Array.from({ length: MAX_TRIGGERS }, (_, slot) => (options.fired?.includes(slot) ? this.time : -1e4)),
      fired: Array.from({ length: MAX_TRIGGERS }, (_, slot) => options.fired?.includes(slot) === true),
      pointer: { x: 0.5, y: 0.5, inside: true, down: false, pressed: false, released: false, ...options.pointer },
      passage: { enter: 1, exit: 0, ...options.passage },
    });
  step(options: HeadlessFrame = {}): (Upload | undefined)[] {
    const standIn = this.#standIn;
    if (standIn === undefined) throw new Error("headless: step reads uploads from the stand-in context; use frame on a real one");
    return this.frame(options).map((texture) => standIn.data(texture));
  dispose(): void {
    this.#sim.dispose();
