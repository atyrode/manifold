// The renderer's display in real WebGL (src/display.ts, src/governor.ts), each check on a renderer
// of its own, its frames run by hand at chosen rAF times. Registered in verify-browser.ts.
//
// contextRestore: on the pond, the default scene, a lost context draws nothing (the frame loop goes
// on) and, once restored, the scene enters again and draws, its plant atlas painted again: nothing
// binds a texture made before the loss (the sheets a painter keeps, src/sheet.ts, go with their
// context). frameGovernor: a moving scene on a 120 Hz display draws at most 60 frames a second;
// paused, and then at motion 0, the picture stands still and stops issuing draws once the change
// has played out (SETTLE_SECONDS); input wakes it, a pointer that only moves for a moment
// (POINTER_SECONDS).
import { PLANT_ATLAS_SIZE } from "./scenes/pond/atlas.ts";
import { POINTER_SECONDS, SETTLE_SECONDS } from "./governor.ts";
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { defaultsFor, paramDefaults, readSetup, renderSettings } from "./state.ts";

const WIDTH = 64;
const HEIGHT = 40;
/** Real seconds a program may take to build, or a sheet to paint, under software WebGL. */
const BUILD_SECONDS = 120;
/** Real seconds the browser may take to lose or restore a context. */
const EVENT_SECONDS = 20;
/** rAF milliseconds between the frames of a 120 Hz display. */
const HZ_120 = 1000 / 120;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

/** The lake as Aurora over a fjord drew it (an old `scene=aurora` link): a moving night. */
function settings(motion = 1): RenderSettings {
  return renderSettings(
    { ...defaultsFor("lake"), pixel: 1, motion, view: "source", transitions: "off" },
    readSetup(new URLSearchParams("scene=aurora")).params,
  );
}

/** The pond at its defaults: the default scene, its border plants drawn from a painted atlas. */
function pond(): RenderSettings {
  return renderSettings(
    { ...defaultsFor("pond"), pixel: 1, view: "source", transitions: "off" },
    paramDefaults("pond"),
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
   * Frames from `now`, `step` ms apart and a little real time apart, until `done` (asked after
   * each) within BUILD_SECONDS, else an error saying `what` did not happen; the last frame's time.
   */
  until: (now: number, step: number, done: () => boolean, what: string) => Promise<number>;
  /** Frames as `until` runs them, until the scene is on screen. */
  arrive: (now: number, step: number) => Promise<number>;
  /** Uploads so far of the pond's plant atlas (a sheet PLANT_ATLAS_SIZE square, src/sheet.ts). */
  atlases: () => number;
  /** Binds, since the context was last lost, of a texture made before that: one the loss killed. */
  staleBinds: () => number;
  /**
   * The next `name` event on the canvas, in a task after its dispatch, within EVENT_SECONDS. The
   * browser reads whether a listener prevented a lost context's default (the renderer does, so it
   * may be restored) only once every listener has run, and a promise settled in a listener resumes
   * its awaiter before that: a restore asked for then is refused and the context stays lost.
   */
  next: (name: "webglcontextlost" | "webglcontextrestored") => Promise<void>;
  dispose: () => void;
}

function page(paced: boolean, initial: RenderSettings): Page {
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
  // Textures made while the context lives; a loss kills them all, and a bind of one after it is
  // stale.
  let living = new Set<WebGLTexture>();
  let dead = new Set<WebGLTexture>();
  let stale = 0;
  const createTexture = gl.createTexture.bind(gl);
  gl.createTexture = () => {
    const texture = createTexture();
    living.add(texture);
    return texture;
  };
  const bindTexture = gl.bindTexture.bind(gl);
  gl.bindTexture = (target, texture) => {
    if (texture !== null && dead.has(texture)) stale++;
    bindTexture(target, texture);
  };
  canvas.addEventListener("webglcontextlost", () => {
    dead = living;
    living = new Set();
  });
  let atlases = 0;
  const texImage2D = gl.texImage2D.bind(gl) as (...args: unknown[]) => void;
  gl.texImage2D = ((...args: unknown[]) => {
    if (args[3] === PLANT_ATLAS_SIZE && args[4] === PLANT_ATLAS_SIZE) atlases++;
    texImage2D(...args);
  }) as typeof gl.texImage2D;
  const renderer = new DitherRenderer(canvas, initial, false);
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
  const until = async (
    now: number,
    step: number,
    done: () => boolean,
    what: string,
  ): Promise<number> => {
    const started = performance.now();
    let at = now;
    frame(at);
    while (!done()) {
      check(
        performance.now() - started < BUILD_SECONDS * 1000,
        `${what} within ${BUILD_SECONDS} s`,
      );
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 20);
      await pause.promise;
      frame((at += step));
    }
    return at;
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
    until,
    arrive: (now, step) => until(now, step, () => !renderer.waiting, "No scene on screen"),
    atlases: () => atlases,
    staleBinds: () => stale,
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
  const {
    renderer,
    gl,
    frame,
    scheduled,
    drawn,
    until,
    arrive,
    atlases,
    staleBinds,
    next,
    dispose,
  } = page(false, pond());
  try {
    let now = await arrive(1000, 17);
    // The pond paints its plant atlas over its first frames (here on the page: the check's server
    // has no build worker), and keeps it once disposed, for its next visit.
    now = await until(now + 17, 17, () => atlases() > 0, "The pond's plant atlas was not painted");
    const painted = atlases();
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
    // Entered again, the pond paints its atlas anew: the one kept from before the loss is dead, and
    // no frame binds it (nor any other texture made before the loss).
    now = await until(
      now + 17,
      17,
      () => {
        check(
          staleBinds() === 0,
          `After the restore, ${staleBinds()} binds took textures made before the loss`,
        );
        return atlases() > painted;
      },
      "The pond's plant atlas was not painted again after the restore",
    );
    const after = frame((now += 17));
    check(
      renderer.failure === undefined && after > 0 && drawn() && staleBinds() === 0,
      `The restored context did not draw the scene again: ${JSON.stringify(renderer.failure)}, ` +
        `${staleBinds()} stale texture binds`,
    );
    return { whileLost, drawsAfterRestore: after, atlasesPainted: atlases() };
  } finally {
    dispose();
  }
}

export async function verifyFrameGovernor(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const { renderer, frame, arrive, dispose } = page(true, settings());
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
    const pointer = { clientX: WIDTH / 2, clientY: 8 };
    window.dispatchEvent(new PointerEvent("pointermove", pointer));
    const woken = frame((now += HZ_120));
    check(woken > 0, "A pointer move did not wake a still picture");
    // The parallax eases toward the pointer (some 3 s), and the picture stands still again.
    const eased = run(now, 5);
    check(eased.last === 0, `After a pointer move, ${eased.last} frames drew in the fifth second`);
    now = eased.at;
    // A pointer that moves nothing (the parallax is there already) wakes it for a moment only.
    window.dispatchEvent(new PointerEvent("pointermove", pointer));
    const hover = run(now, 1);
    check(
      hover.drew > 0 && hover.drew <= POINTER_SECONDS * 60 + 2,
      `A pointer move kept a still picture drawing for ${hover.drew} frames`,
    );
    now = hover.at;
    // At motion 0 the same.
    renderer.setPaused(false);
    renderer.update(settings(0));
    const still = run(now, SETTLE_SECONDS + 2);
    check(
      still.drew > 0 && still.last === 0,
      `At motion 0, ${still.drew} frames drew, ${still.last} of them in the last second`,
    );
    return {
      movingAt120Hz: moving.drew,
      paused: paused.drew,
      pointerMove: hover.drew,
      motion0: still.drew,
    };
  } finally {
    dispose();
  }
}
