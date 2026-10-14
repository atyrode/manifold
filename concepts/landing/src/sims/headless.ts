// A scene's simulation run without a browser, for `bun test` regressions on what a sim hands its
// shader: a stand-in WebGL2 context that accepts every call and keeps each texture's last data
// upload, and a driver that builds SimFrames from knobs, a pointer and a frame size the way the
// renderer does (knobs keyed as in the URL, read through `effective`; missing knobs at defaults).
//
//   headlessGl()          { gl, data(texture) }: `data` is a copy of the typed array last uploaded to
//                         that texture (texImage2D or texSubImage2D), undefined before any upload.
//                         Every other call is a no-op; constants read as 1, createTexture as a token.
//   new HeadlessSim(scene)
//     step(frame)         one renderer frame (dt 1/60 s, motion 1, 960 × 540 cells unless given) and
//                         the data the sim's returned textures hold, in slot order
//     time, motionTime    the scene and motion clocks, as the renderer sums them
//
// Usage (a drag held still while the screen turns portrait must not move the plane):
//   const sim = new HeadlessSim(hyperbolicScene);
//   const at = { x: 0.6, y: 0.55, inside: true, down: true };
//   sim.step({ pointer: { ...at, pressed: true } });
//   const before = sim.step({ pointer: at })[0];
//   const after = sim.step({ pointer: at, aspect: 9 / 16 })[0];
import { effective, MAX_TRIGGERS } from "../params.ts";
import type { PointerState, ScenePassageProgress, SceneDef, SimFrame } from "../scenes/types.ts";

type Upload = Float32Array | Uint16Array | Uint8Array;

export interface HeadlessGl {
  readonly gl: WebGL2RenderingContext;
  data(texture: WebGLTexture | undefined): Upload | undefined;
}

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
    },
  ) as WebGL2RenderingContext;
  return { gl, data: (texture) => uploads.get(texture) };
}

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
}

export class HeadlessSim {
  readonly #scene: SceneDef;
  readonly #gl: HeadlessGl;
  readonly #sim;
  time = 0;
  motionTime = 0;

  constructor(scene: SceneDef) {
    if (scene.sim === undefined) throw new Error(`headless: ${scene.id} has no sim`);
    this.#scene = scene;
    this.#gl = headlessGl();
    this.#sim = scene.sim(this.#gl.gl);
  }

  step(options: HeadlessFrame = {}): (Upload | undefined)[] {
    const dt = options.dt ?? 1 / 60;
    const motion = options.motion ?? 1;
    const aspect = options.aspect ?? 16 / 9;
    const height = options.height ?? 540;
    const knobs = options.knobs ?? {};
    this.time += dt;
    this.motionTime += dt * motion;
    const frame: SimFrame = {
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
    };
    return this.#sim.frame(frame).map((texture) => this.#gl.data(texture));
  }

  dispose(): void {
    this.#sim.dispose();
  }
}
