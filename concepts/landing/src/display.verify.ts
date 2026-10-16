// The renderer's display in real WebGL (src/display.ts, src/governor.ts), each check on a renderer
// of its own, its frames run by hand at chosen rAF times. Registered in verify-browser.ts.
//
// contextRestore: a lost context draws nothing (the frame loop goes on) and, once restored, the
// scene enters again and draws. frameGovernor: a moving scene on a 120 Hz display draws at most 60
// frames a second; paused, and then at motion 0, the picture stands still and stops issuing draws
// once the change has played out (SETTLE_SECONDS); input wakes it.
import { SETTLE_SECONDS } from "./governor.ts";
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./state.ts";

const WIDTH = 64;
const HEIGHT = 40;
/** Real seconds a program may take to build under software WebGL on a busy machine. */
const BUILD_SECONDS = 120;
/** Real seconds the browser may take to lose or restore a context. */
const EVENT_SECONDS = 20;
/** rAF milliseconds between the frames of a 120 Hz display. */
const HZ_120 = 1000 / 120;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function settings(motion = 1): RenderSettings {
  return renderSettings(
    { ...defaultsFor("aurora"), pixel: 1, motion, view: "source", transitions: "off" },
    paramDefaults("aurora"),
  );
}

/** A renderer on a canvas of its own, its frames run by hand. */
interface Page {
  renderer: DitherRenderer;
  gl: WebGL2RenderingContext;
  /** Run the frame the renderer asked for at rAF time `now`: the draws and clears it issued. */
  frame: (now: number) => number;
  /** A next frame is asked for. */
  scheduled: () => boolean;
  /** The canvas shows a picture, not one colour. */
  drawn: () => boolean;
  /**
   * Frames from `now`, `step` ms apart and a little real time apart, until the scene is on
   * screen; the last frame's time.
   */
  arrive: (now: number, step: number) => Promise<number>;
  /**
   * The next `name` event on the canvas, in a task after its dispatch, within EVENT_SECONDS. The
   * browser reads whether a listener prevented a lost context's default (the renderer does, so it
   * may be restored) only once every listener has run, and a promise settled in a listener resumes
   * its awaiter before that: a restore asked for then is refused and the context stays lost.
   */
  next: (name: "webglcontextlost" | "webglcontextrestored") => Promise<void>;
  dispose: () => void;
}

function page(paced: boolean): Page {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.append(canvas);
  // The renderer asks for this same context.
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) throw new Error("Display context unavailable");
  let issued = 0;
  const drawArrays = gl.drawArrays.bind(gl);
  gl.drawArrays = (mode, first, count) => {
    issued++;
    drawArrays(mode, first, count);
  };
  const clear = gl.clear.bind(gl);
  gl.clear = (mask) => {
    issued++;
    clear(mask);
  };
  const renderer = new DitherRenderer(canvas, settings(), false);
  const native = window.requestAnimationFrame;
  let requested: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    requested = callback;
    return 1;
  };
  renderer.start({ paced });
  const frame = (now: number): number => {
    const tick = requested;
    if (!tick) throw new Error("No frame scheduled");
    requested = undefined;
    const before = issued;
    tick(now);
    return issued - before;
  };
  return {
    renderer,
    gl,
    frame,
    scheduled: () => requested !== undefined,
    drawn: () => {
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes.some((value, index) => index % 4 !== 3 && value !== bytes[index % 4]);
    },
    async arrive(now, step) {
      const started = performance.now();
      let at = now;
      frame(at);
      while (renderer.waiting) {
        check(
          performance.now() - started < BUILD_SECONDS * 1000,
          `No scene on screen within ${BUILD_SECONDS} s`,
        );
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 20);
        await pause.promise;
        frame((at += step));
      }
      return at;
    },
    next(name) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const timeout = setTimeout(() => {
        canvas.removeEventListener(name, dispatched);
        reject(new Error(`No ${name} event within ${EVENT_SECONDS} s`));
      }, EVENT_SECONDS * 1000);
      const dispatched = () => {
        clearTimeout(timeout);
        setTimeout(resolve);
      };
      canvas.addEventListener(name, dispatched, { once: true });
      return promise;
    },
    dispose() {
      window.requestAnimationFrame = native;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

export async function verifyContextRestore(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const { renderer, gl, frame, scheduled, drawn, arrive, next, dispose } = page(false);
  try {
    let now = await arrive(1000, 17);
    check(frame((now += 17)) > 0 && drawn(), "The scene did not draw before the context was lost");
    const lose = gl.getExtension("WEBGL_lose_context");
    if (!lose) throw new Error("WEBGL_lose_context unavailable");
    const lost = next("webglcontextlost");
    lose.loseContext();
    await lost;
    let whileLost = 0;
    for (let i = 0; i < 3; i++) whileLost += frame((now += 17));
    check(whileLost === 0, `A lost context issued ${whileLost} draws`);
    check(scheduled(), "No frame was asked for while the context was lost");
    const restored = next("webglcontextrestored");
    lose.restoreContext();
    await restored;
    now = await arrive(now + 17, 17);
    const after = frame((now += 17));
    check(
      renderer.failure === undefined && after > 0 && drawn(),
      `The restored context did not draw the scene again: ${JSON.stringify(renderer.failure)}`,
    );
    return { whileLost, drawsAfterRestore: after };
  } finally {
    dispose();
  }
}

export async function verifyFrameGovernor(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const { renderer, frame, arrive, dispose } = page(true);
  /** A 120 Hz display's frames for `seconds` after `from`: how many drew, and in the last second. */
  const run = (from: number, seconds: number): { at: number; drew: number; last: number } => {
    let at = from;
    let drew = 0;
    let last = 0;
    for (let i = 0; i < seconds * 120; i++) {
      if (frame((at += HZ_120)) === 0) continue;
      drew++;
      if (i >= (seconds - 1) * 120) last++;
    }
    return { at, drew, last };
  };
  try {
    let now = await arrive(1000, HZ_120);
    // A moving scene: at most every other frame of a 120 Hz display.
    const moving = run(now, 1);
    check(
      moving.drew <= 60 && moving.drew >= 55,
      `A 120 Hz display drew ${moving.drew} frames in a second`,
    );
    now = moving.at;
    // Paused, the picture stands still: it draws while the pause plays out, then stops.
    renderer.setPaused(true);
    const paused = run(now, SETTLE_SECONDS + 2);
    check(
      paused.drew > 0 && paused.last === 0,
      `Paused, ${paused.drew} frames drew, ${paused.last} of them in the last second`,
    );
    now = paused.at;
    // Input wakes it.
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: WIDTH / 2, clientY: 8 }));
    const woken = frame((now += HZ_120));
    check(woken > 0, "A pointer move did not wake a still picture");
    // At motion 0 the same.
    renderer.setPaused(false);
    renderer.update(settings(0));
    const still = run(now, SETTLE_SECONDS + 2);
    check(
      still.drew > 0 && still.last === 0,
      `At motion 0, ${still.drew} frames drew, ${still.last} of them in the last second`,
    );
    return { movingAt120Hz: moving.drew, paused: paused.drew, motion0: still.drew };
  } finally {
    dispose();
  }
}
