// What the lab's browser checks share (verify-browser.ts and the checks it registers): an assertion,
// a program from a fragment source, read-backs into bytes and floats, a canvas for a renderer of its
// own, the page's animation frames held for frames run by hand, real-time waits, a renderer's
// settings as a check draws them, and the scene scope a run hands the checks that walk the scenes.
import type { RenderSettings } from "../renderer.ts";
import type { SceneId } from "../scenes/index.ts";
import { vertexSource } from "../shaders/index.ts";
import {
  defaultsFor,
  paramDefaults,
  renderSettings,
  type LabState,
  type Params,
} from "../state.ts";

/** A check's regression, or a check that cannot run here. */
export class VerifyError extends Error {}

/**
 * Throws `message` unless `ok`. Not an assertion signature: checks read live renderer state that the
 * next frame changes, which a narrowing would wrongly freeze.
 */
export function check(ok: boolean, message: string): void {
  if (!ok) throw new VerifyError(message);
}

/** `fragment` (a whole fragment source) linked with the lab's vertex stage; throws its log. */
export function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const shaders = [vertexSource, fragment].map((source, index) => {
    const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new VerifyError("Shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    check(
      Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS)),
      gl.getShaderInfoLog(shader) ?? "compile failed",
    );
    return shader;
  });
  const linked = gl.createProgram();
  for (const shader of shaders) gl.attachShader(linked, shader);
  gl.linkProgram(linked);
  check(
    Boolean(gl.getProgramParameter(linked, gl.LINK_STATUS)),
    gl.getProgramInfoLog(linked) ?? "link failed",
  );
  for (const shader of shaders) gl.deleteShader(shader);
  return linked;
}

/** The bottom-left `width` × `height` RGBA bytes of what `gl` reads from, rows bottom up. */
export function readBytes(gl: WebGL2RenderingContext, width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  check(gl.getError() === gl.NO_ERROR, "readPixels GL error");
  return bytes;
}

/**
 * What `draw` draws into a float target of `width` × `height` (bound, the viewport on it, no
 * texture unit holding it): RGBA floats, rows bottom up. Needs EXT_color_buffer_float.
 */
export function drawFloats(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  draw: () => void,
): Float32Array {
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  try {
    check(
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
      "float target incomplete",
    );
    gl.viewport(0, 0, width, height);
    draw();
    const out = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
    check(gl.getError() === gl.NO_ERROR, "float readPixels GL error");
    return out;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(target);
  }
}

/**
 * A canvas of its own, `width` × `height` CSS px at the page's top left, and its context as the
 * renderer asks for it (a renderer made on the canvas takes this same context).
 */
export function stage(
  width: number,
  height: number,
): { readonly canvas: HTMLCanvasElement; readonly gl: WebGL2RenderingContext } {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px`;
  document.body.append(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) {
    canvas.remove();
    throw new VerifyError("WebGL2 context unavailable");
  }
  return { canvas, gl };
}

/** The page's animation frames, held for a check that runs a renderer's frames by hand. */
export interface HeldFrames {
  /** The frame last asked for, handed over once: undefined when none was asked for since. */
  take(): FrameRequestCallback | undefined;
  /** Runs the frame last asked for at rAF time `now` (none is an error); whether it asked for another. */
  run(now: number): boolean;
  /** Whether a frame is asked for. */
  pending(): boolean;
  /** Settles in a task after the page's next rendering update, where a canvas's resize is observed. */
  rendered(): Promise<void>;
  /** Gives the page its own requestAnimationFrame back. */
  restore(): void;
}

/** Holds the page's animation frames: one asked for runs only when the check runs it. */
export function holdFrames(): HeldFrames {
  const native = window.requestAnimationFrame;
  let asked: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    asked = callback;
    return 1;
  };
  const take = (): FrameRequestCallback | undefined => {
    const callback = asked;
    asked = undefined;
    return callback;
  };
  return {
    take,
    run(now) {
      const callback = take();
      if (!callback) throw new VerifyError("No frame scheduled");
      callback(now);
      return asked !== undefined;
    },
    pending: () => asked !== undefined,
    rendered() {
      const done = Promise.withResolvers<void>();
      native(() => setTimeout(done.resolve, 0));
      return done.promise;
    },
    restore() {
      window.requestAnimationFrame = native;
    },
  };
}

/** Settles after `ms` of real time, the page's tasks (a background build's status) running meanwhile. */
export function pause(ms: number): Promise<void> {
  const paused = Promise.withResolvers<void>();
  setTimeout(paused.resolve, ms);
  return paused.promise;
}

/**
 * Calls `step` until it returns true, `ms` of real time apart; after `seconds` of them it fails,
 * saying `what` did not happen within them.
 */
export async function until(
  step: () => boolean,
  seconds: number,
  what: string,
  ms = 20,
): Promise<void> {
  const started = performance.now();
  while (!step()) {
    check(performance.now() - started < seconds * 1000, `${what} within ${seconds} s`);
    await pause(ms);
  }
}

/**
 * The renderer's settings for `scene` as a check draws it: cells of 1 px, full motion, the source
 * view, the pointer still, no transitions, `look` over those; `knobs` over the scene's defaults.
 */
export function labSettings(
  scene: SceneId,
  knobs: Params = {},
  look: Partial<LabState> = {},
): RenderSettings {
  return renderSettings(
    {
      ...defaultsFor(scene),
      pixel: 1,
      motion: 1,
      view: "source",
      mouse: "still",
      transitions: "off",
      ...look,
    },
    { ...paramDefaults(scene), ...knobs },
  );
}

/** Set by verify.ts from LANDING_SCENES: the comma list of scenes a run is scoped to, or "" for all. */
declare const LANDING_SCENES: string;

/** A check that walks scenes one by one (`walk`). */
export interface SceneWalk {
  (gl: WebGL2RenderingContext): unknown;
  /**
   * Every scene it walks in a run of every scene: verify.ts weighs its recorded seconds by the
   * share of them a scoped run keeps.
   */
  readonly scenes: readonly string[];
}

/**
 * A check that walks `scenes`: `run` gets those a run keeps, all of them, or under LANDING_SCENES
 * those in its scope (a pull request confined to some scenes' directories proves those scenes).
 */
export function walk<Id extends string>(
  scenes: readonly Id[],
  run: (gl: WebGL2RenderingContext, scenes: readonly Id[]) => unknown,
): SceneWalk {
  return Object.assign(
    (gl: WebGL2RenderingContext) => {
      const scope = LANDING_SCENES === "" ? undefined : LANDING_SCENES.split(",");
      return run(gl, scope === undefined ? scenes : scenes.filter((id) => scope.includes(id)));
    },
    { scenes },
  );
}
