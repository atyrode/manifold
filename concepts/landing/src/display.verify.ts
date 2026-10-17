// The renderer's display in real WebGL (src/display.ts, src/governor.ts), each check on a renderer
// of its own, its frames run by hand at chosen rAF times. Registered in verify-browser.ts.
//
// contextRestore: on the pond, the default scene, passages on, the canvas shows nothing but the
// page's background until the scene's first frame, which shows nothing else either, its clock at
// 0, nor until the pond's world is in place (its plant atlas painted); the scene then appears out
// of the bare page cell by cell (`REVEAL`): on every frame the cells whose ordered-dither threshold
// the reveal has not reached are the background exactly and the rest are the scene, out of nothing
// but the blank texel on the uLeaving unit, until within the reveal's seconds none is held back. A
// lost context draws nothing (the frame loop goes on) and, once restored, the scene appears again
// the same way and draws, its plant atlas painted again: nothing binds a texture made before the
// loss (the sheets a painter keeps, src/sheet.ts, go with their context). frameGovernor: a moving
// scene on a 120 Hz display draws 60 frames a second at rest by default and, with the lab's `rest`
// at half, 30, and 60 from the first frame after input; paused, and then at motion 0, the picture stands still and stops issuing draws once the
// change has played out (SETTLE_SECONDS); input wakes it, a pointer that only moves for a moment
// (POINTER_SECONDS).
import { stageCells } from "./display.ts";
import { LEAVING_UNIT } from "./program-cache.ts";
import { PLANT_ATLAS_SIZE } from "./scenes/pond/atlas.ts";
import { POINTER_SECONDS, SETTLE_SECONDS } from "./governor.ts";
import { DitherRenderer, REVEAL, type RenderSettings } from "./renderer.ts";
import { defaultsFor, paramDefaults, renderSettings } from "./state.ts";
import { check, holdFrames, LAKE_FJORD, stage, until as poll } from "./verify/kit.ts";

const WIDTH = 64;
const HEIGHT = 40;
/** Real seconds a program may take to build, or a sheet to paint, under software WebGL. */
const BUILD_SECONDS = 120;
/** Real seconds the browser may take to lose or restore a context. */
const EVENT_SECONDS = 20;
/** rAF milliseconds between the frames of a 120 Hz display. */
const HZ_120 = 1000 / 120;

/** The lake's fjord under the slow drapes: a moving night. */
function settings(motion = 1): RenderSettings {
  return renderSettings(
    { ...defaultsFor("lake"), pixel: 1, motion, view: "source", transitions: "off" },
    LAKE_FJORD,
  );
}

/**
 * The pond at its defaults, passages on: the default scene, its border plants drawn from a painted
 * atlas, appearing out of the bare page. In the source view its picture has no cell of the page's
 * background colour, so on screen the background shows exactly where the reveal holds cells back.
 */
function pond(): RenderSettings {
  return renderSettings(
    { ...defaultsFor("pond"), pixel: 1, view: "source", transitions: "on" },
    paramDefaults("pond"),
  );
}

/**
 * The shader's `bayer8` at cell `x`, `y` (rows bottom up, as gl_FragCoord counts them): the
 * threshold at which the reveal shows the cell, the "fade" blend's order (`REVEAL.blend`).
 */
function bayer8(x: number, y: number): number {
  const bayer2 = (u: number, v: number) => ((u % 2) * 0.5 + (v % 2) * 0.75) % 1;
  return (bayer2(x >> 2, y >> 2) * 0.25 + bayer2(x >> 1, y >> 1)) * 0.25 + bayer2(x, y);
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
   * The last draw on the canvas: the `uDissolve` it was sent, and the size of the texture on the
   * uLeaving unit it drew with ("1x1" the blank texel; "image" uploaded from a picture).
   */
  screen: () => { dissolve: readonly number[]; leaving: string };
  /** The scene clock (`uTime`) the last draw sent. */
  sceneTime: () => number;
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
  // The renderer asks for this same context.
  const { canvas, gl } = stage(WIDTH, HEIGHT);
  let issued = 0;
  // The size each texture was last given (see `screen`), and that of the one on the uLeaving unit
  // when the canvas was last drawn on.
  const sizes = new WeakMap<WebGLTexture, string>();
  let leaving = "";
  const drawArrays = gl.drawArrays.bind(gl);
  gl.drawArrays = (mode, first, count) => {
    issued++;
    if (gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) {
      const unit = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
      gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
      const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
      gl.activeTexture(unit);
      leaving = texture === null ? "none" : (sizes.get(texture) ?? "unsized");
    }
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
    // Nine arguments give the size; six, a picture to take it from.
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    if (texture !== null)
      sizes.set(texture, args.length > 6 ? `${String(args[3])}x${String(args[4])}` : "image");
    texImage2D(...args);
  }) as typeof gl.texImage2D;
  // The scene clock each draw sends (`uTime`) and the dissolve each draw on the canvas is sent
  // (`uDissolve`), at the locations programs look up for them.
  const timeLocations = new Set<WebGLUniformLocation>();
  const dissolveLocations = new Set<WebGLUniformLocation>();
  const getUniformLocation = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program, name) => {
    const location = getUniformLocation(program, name);
    if (name === "uTime" && location !== null) timeLocations.add(location);
    if (name === "uDissolve" && location !== null) dissolveLocations.add(location);
    return location;
  };
  let sceneTime = Number.NaN;
  const uniform1f = gl.uniform1f.bind(gl);
  gl.uniform1f = (location, x) => {
    if (location !== null && timeLocations.has(location)) sceneTime = x;
    uniform1f(location, x);
  };
  let dissolve: readonly number[] = [];
  const uniform3f = gl.uniform3f.bind(gl);
  gl.uniform3f = (location, x, y, z) => {
    if (
      location !== null &&
      dissolveLocations.has(location) &&
      gl.getParameter(gl.FRAMEBUFFER_BINDING) === null
    )
      dissolve = [x, y, z];
    uniform3f(location, x, y, z);
  };
  const renderer = new DitherRenderer(canvas, initial, false);
  const frames = holdFrames();
  renderer.start({ paced });
  const frame = (now: number): number => {
    const before = issued;
    frames.run(now);
    return issued - before;
  };
  const until = async (
    now: number,
    step: number,
    done: () => boolean,
    what: string,
  ): Promise<number> => {
    // The first frame at `now`, then one every `step` ms.
    let at = now - step;
    await poll(
      () => {
        frame((at += step));
        return done();
      },
      BUILD_SECONDS,
      what,
    );
    return at;
  };
  return {
    renderer,
    gl,
    frame,
    scheduled: frames.pending,
    drawn: () => {
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes.some((value, index) => index % 4 !== 3 && value !== bytes[index % 4]);
    },
    until,
    arrive: (now, step) => until(now, step, () => !renderer.waiting, "No scene on screen"),
    atlases: () => atlases,
    staleBinds: () => stale,
    screen: () => ({ dissolve, leaving }),
    sceneTime: () => sceneTime,
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
      frames.restore();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

export async function verifyContextRestore(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const settings = pond();
  const {
    renderer,
    gl,
    frame,
    scheduled,
    drawn,
    until,
    atlases,
    staleBinds,
    screen,
    sceneTime,
    next,
    dispose,
  } = page(false, settings);
  const dpr = window.devicePixelRatio;
  const { width, height } = stageCells(Math.round(WIDTH * dpr), Math.round(HEIGHT * dpr), dpr, 1);
  const bg = Number.parseInt(settings.bg.slice(1), 16);
  const pixels = new Uint8Array(width * height * 4);
  /** Whether each cell on the canvas shows the page's background exactly, rows bottom up. */
  const background = (): boolean[] => {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return Array.from(
      { length: width * height },
      (_, cell) =>
        pixels[cell * 4] === bg >> 16 &&
        pixels[cell * 4 + 1] === ((bg >> 8) & 255) &&
        pixels[cell * 4 + 2] === (bg & 255),
    );
  };
  /**
   * Frames from `from`, 17 ms apart and a little real time apart (the pond paints its plant atlas
   * meanwhile), until the pond has appeared: nothing but the background until it is on screen,
   * then from its first frame (its clock at 0) on the reveal. On every frame it dissolves out of the
   * bare page (`uDissolve.y` 0, the blank texel on the uLeaving unit), the cells it holds back
   * (`bayer8` under its share) are the background and the others the pond, and it holds back no
   * more cells than on the frame before. It begins (holds back fewer than all) only once the
   * pond's world is in place, its plant atlas painted since `painted` uploads, and within
   * REVEAL.seconds of that holds back none. The last frame's time, and how many frames it took.
   */
  const appear = async (from: number, painted: number): Promise<{ at: number; frames: number }> => {
    let at = await until(
      from,
      17,
      () => {
        const shown = background().filter((cell) => !cell).length;
        check(shown === 0, `Before the scene was on screen ${shown} cells showed something else`);
        return !renderer.waiting;
      },
      "No scene on screen",
    );
    check(sceneTime() === 0, `The scene's clock started at ${sceneTime()} s, not at 0`);
    /** The frame at which the reveal's clock started: the last one it held every cell back. */
    let start = Number.NaN;
    let held = width * height;
    let frames = 0;
    /** The frame at `at` as the reveal has it; whether it holds no cell back any more. */
    const shows = (): boolean => {
      frames++;
      const { dissolve, leaving } = screen();
      check(
        dissolve[1] === 0 && leaving === "1x1",
        `The scene appeared out of a frame (uDissolve ${dissolve.join(", ")}, ${leaving} on ` +
          "uLeaving), not out of the bare page",
      );
      const share = Math.fround(dissolve[0] ?? Number.NaN);
      const cells = background();
      let holds = 0;
      let wrong = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const hold = bayer8(x, y) < share;
          if (hold) holds++;
          if (cells[y * width + x] !== hold) wrong++;
        }
      if (Number.isNaN(start) && holds < width * height) {
        start = at - 17;
        check(atlases() > painted, "The reveal began before the pond's plant atlas was painted");
      }
      const when = Number.isNaN(start) ? "Before the reveal began" : `${at - start} ms into it`;
      check(
        wrong === 0,
        `${when}, ${wrong} cells were not as the reveal had them (the background where it held ` +
          "them back, else the pond)",
      );
      check(holds <= held, `${when}, the reveal held back ${holds} cells, after ${held}`);
      held = holds;
      check(
        held === 0 || Number.isNaN(start) || at - start < REVEAL.seconds * 1000,
        `${when}, the reveal still held back ${held} cells`,
      );
      return held === 0;
    };
    if (!shows())
      await until(
        at + 17,
        17,
        () => {
          at += 17;
          return shows();
        },
        "The pond did not appear",
      );
    return { at, frames };
  };
  try {
    const opened = await appear(1000, 0);
    let now = opened.at;
    // The pond painted its plant atlas before it appeared (here on the page: the check's server
    // has no build worker), and keeps it once disposed, for its next visit.
    const painted = atlases();
    check(frame((now += 17)) > 0 && drawn(), "The scene did not draw before the context was lost");
    const ranFor = sceneTime();
    check(ranFor > 0, "The pond's clock stood still before the context was lost");
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
    const reopened = await appear(now + 17, painted);
    now = reopened.at;
    // Appeared again, the pond painted its atlas anew (`appear`): the one kept from before the
    // loss is dead, and no frame since the restore bound it (nor any other texture made before it).
    const after = frame((now += 17));
    check(
      renderer.failure === undefined && after > 0 && drawn() && staleBinds() === 0,
      `The restored context did not draw the scene again: ${JSON.stringify(renderer.failure)}, ` +
        `${staleBinds()} stale texture binds`,
    );
    return {
      revealFrames: opened.frames,
      revealFramesAfterRestore: reopened.frames,
      whileLost,
      drawsAfterRestore: after,
      atlasesPainted: atlases(),
    };
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
    // A moving scene at rest, nothing touched since it arrived, at the default: every second frame
    // of a 120 Hz display, 60 a second, as with input.
    const full = run(now, 1);
    check(
      full.drew >= 59 && full.drew <= 61,
      `At rest by default, a 120 Hz display drew ${full.drew} frames in a second`,
    );
    now = full.at;
    // With the setting at half rate, every fourth frame, 30 a second, once the change has played out.
    renderer.update({ ...settings(), rest: "half" });
    const settled = run(now, SETTLE_SECONDS);
    const resting = run(settled.at, 1);
    check(
      resting.drew >= 29 && resting.drew <= 31,
      `At half rate, a 120 Hz display drew ${resting.drew} frames in a second at rest`,
    );
    now = resting.at;
    // Input just after a frame brings the full rate back at once: the frame after next draws
    // (two refreshes on, where at rest it would be four), and every other one while input lasts.
    let waited = 0;
    while (frame((now += HZ_120)) === 0)
      check(++waited < 4, "A scene at rest drew no frame in four refreshes");
    // In the corner, so the parallax has somewhere to go when the pointer moves on below.
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, clientY: 0 }));
    check(
      frame((now += HZ_120)) === 0 && frame((now += HZ_120)) > 0,
      "Input did not bring a moving scene back to the full rate at once",
    );
    const lively = run(now, SETTLE_SECONDS - 1);
    check(
      lively.drew === (SETTLE_SECONDS - 1) * 60,
      `After input, a 120 Hz display drew ${lively.drew} frames in ${SETTLE_SECONDS - 1} s`,
    );
    now = lively.at;
    // Back at rest once the input has played out.
    const rested = run(now, 2);
    check(
      rested.last >= 29 && rested.last <= 31,
      `Input kept a 120 Hz display at ${rested.last} frames a second after ${SETTLE_SECONDS} s`,
    );
    now = rested.at;
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
    // The parallax eases toward the pointer (a second or two), and the picture stands still again.
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
      restAt120Hz: full.drew,
      halfRestAt120Hz: resting.drew,
      inputAt120Hz: lively.drew / (SETTLE_SECONDS - 1),
      paused: paused.drew,
      pointerMove: hover.drew,
      motion0: still.drew,
    };
  } finally {
    dispose();
  }
}
