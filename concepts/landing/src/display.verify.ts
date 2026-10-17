// The renderer's display in real WebGL (src/display.ts, src/governor.ts), each check on a renderer
// of its own, its frames run by hand at chosen rAF times. Registered in verify-browser.ts.
//
// contextRestore: on the pond, the default scene, its poster (the page's loading state) stands in
// until the scene draws: its first frame is the poster exactly as the page lays it, which the
// scene then dissolves out of, its clock starting at 0, and only then is the page told it shows. A
// lost context draws nothing (the frame loop goes on) and, once restored, the scene enters again
// the same way and draws, its plant atlas painted again: nothing binds a texture made before the
// loss (the sheets a painter keeps, src/sheet.ts, go with their context). frameGovernor: a moving
// scene on a 120 Hz display draws 30 frames a second at rest and 60 from the first frame after
// input; paused, and then at motion 0, the picture stands still and stops issuing draws once the
// change has played out (SETTLE_SECONDS); input wakes it, a pointer that only moves for a moment
// (POINTER_SECONDS).
import { stageCells } from "./display.ts";
import { PLANT_ATLAS_SIZE } from "./scenes/pond/atlas.ts";
import { POINTER_SECONDS, SETTLE_SECONDS } from "./governor.ts";
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { defaultsFor, paramDefaults, readSetup, renderSettings } from "./state.ts";
import { check, holdFrames, stage, until as poll } from "./verify/kit.ts";

const WIDTH = 64;
const HEIGHT = 40;
/** Real seconds a program may take to build, or a sheet to paint, under software WebGL. */
const BUILD_SECONDS = 120;
/** Real seconds the browser may take to lose or restore a context. */
const EVENT_SECONDS = 20;
/** rAF milliseconds between the frames of a 120 Hz display. */
const HZ_120 = 1000 / 120;

/** The lake as Aurora over a fjord drew it (an old `scene=aurora` link): a moving night. */
function settings(motion = 1): RenderSettings {
  return renderSettings(
    { ...defaultsFor("lake"), pixel: 1, motion, view: "source", transitions: "off" },
    readSetup(new URLSearchParams("scene=aurora")).params,
  );
}

/**
 * The pond at its defaults, passages on: the default scene, its border plants drawn from a painted
 * atlas, entering out of its poster.
 */
function pond(): RenderSettings {
  return renderSettings(
    { ...defaultsFor("pond"), pixel: 1, view: "source", transitions: "on" },
    paramDefaults("pond"),
  );
}

/** The test poster's side in px: square, so the page's 16:10 box crops it top and bottom. */
const POSTER = 20;

/** The colour of the test poster's pixel `u`, `v` (from its top left): each one its own. */
function posterColour(u: number, v: number): readonly [number, number, number] {
  return [u * 12, v * 12, (u + v) % 2 === 0 ? 40 : 220];
}

/** The test poster as a decoded image, as the page hands a scene's thumbnail over. */
async function posterImage(): Promise<HTMLImageElement> {
  const canvas = document.createElement("canvas");
  canvas.width = POSTER;
  canvas.height = POSTER;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Poster canvas unavailable");
  const pixels = context.createImageData(POSTER, POSTER);
  for (let v = 0; v < POSTER; v++)
    for (let u = 0; u < POSTER; u++)
      pixels.data.set([...posterColour(u, v), 255], (v * POSTER + u) * 4);
  context.putImageData(pixels, 0, 0);
  const image = new Image();
  image.src = canvas.toDataURL("image/png");
  await image.decode();
  return image;
}

/**
 * Cells on the canvas that differ from the test poster as the page lays it over the canvas's box
 * (styles.css, `background: center / cover`): scaled to the least size that covers the box, centred,
 * each cell showing the poster pixel under its centre. Only cells wholly inside the box count.
 */
function posterMisses(gl: WebGL2RenderingContext): number {
  const dpr = window.devicePixelRatio;
  const boxWidth = Math.round(WIDTH * dpr);
  const boxHeight = Math.round(HEIGHT * dpr);
  const { cell, width, height } = stageCells(boxWidth, boxHeight, dpr, 1);
  const scale = Math.max(boxWidth / POSTER, boxHeight / POSTER);
  const left = (boxWidth - POSTER * scale) / 2;
  const top = (boxHeight - POSTER * scale) / 2;
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  let misses = 0;
  for (let y = 0; y < Math.floor(boxHeight / cell); y++)
    for (let x = 0; x < Math.floor(boxWidth / cell); x++) {
      const colour = posterColour(
        Math.floor(((x + 0.5) * cell - left) / scale),
        Math.floor(((y + 0.5) * cell - top) / scale),
      );
      // readPixels rows run bottom up.
      const at = ((height - 1 - y) * width + x) * 4;
      if (colour.some((value, channel) => bytes[at + channel] !== value)) misses++;
    }
  return misses;
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
  /** How often the renderer has told the page a scene shows (`shown`: the poster goes then). */
  shown: () => number;
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
  // The scene clock each draw sends: `uTime` at the locations programs look up for it.
  const timeLocations = new Set<WebGLUniformLocation>();
  const getUniformLocation = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program, name) => {
    const location = getUniformLocation(program, name);
    if (name === "uTime" && location !== null) timeLocations.add(location);
    return location;
  };
  let sceneTime = Number.NaN;
  const uniform1f = gl.uniform1f.bind(gl);
  gl.uniform1f = (location, x) => {
    if (location !== null && timeLocations.has(location)) sceneTime = x;
    uniform1f(location, x);
  };
  let shown = 0;
  const renderer = new DitherRenderer(canvas, initial, false, {
    shown: () => {
      shown++;
    },
  });
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
    shown: () => shown,
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
  const poster = await posterImage();
  const {
    renderer,
    gl,
    frame,
    scheduled,
    drawn,
    until,
    atlases,
    staleBinds,
    shown,
    sceneTime,
    next,
    dispose,
  } = page(false, pond());
  /**
   * Frames until the pond enters out of its poster: the page is not told it shows while it waits,
   * and is told once it has drawn, its frame then the poster exactly as the page lays it and its
   * clock at 0 (the page's own has run on through every frame).
   */
  const enter = async (from: number, told: number): Promise<number> => {
    const at = await until(
      from,
      17,
      () => {
        check(
          shown() === (renderer.waiting ? told : told + 1),
          `The page was told the scene shows ${shown() - told} times while it was ` +
            `${renderer.waiting ? "" : "not "}waiting`,
        );
        return !renderer.waiting;
      },
      "No scene on screen",
    );
    const misses = posterMisses(gl);
    check(misses === 0, `The scene's first frame was not its poster: ${misses} cells differ`);
    check(sceneTime() === 0, `The scene's clock started at ${sceneTime()} s, not at 0`);
    return at;
  };
  try {
    renderer.setPoster("pond", poster);
    let now = await enter(1000, 0);
    // The pond paints its plant atlas over its first frames (here on the page: the check's server
    // has no build worker), and keeps it once disposed, for its next visit.
    now = await until(now + 17, 17, () => atlases() > 0, "The pond's plant atlas was not painted");
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
    check(shown() === 1, "The page was told a scene shows while the context was lost");
    // The page hands the poster over again as the context goes (main.ts).
    renderer.setPoster("pond", poster);
    const restored = next("webglcontextrestored");
    lose.restoreContext();
    await restored;
    now = await enter(now + 17, 1);
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
    return {
      whileLost,
      drawsAfterRestore: after,
      atlasesPainted: atlases(),
      toldShown: shown(),
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
    // A moving scene at rest, nothing touched since it arrived: every fourth frame of a 120 Hz
    // display, 30 a second.
    const resting = run(now, 1);
    check(
      resting.drew >= 29 && resting.drew <= 31,
      `At rest, a 120 Hz display drew ${resting.drew} frames in a second`,
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
      restAt120Hz: resting.drew,
      inputAt120Hz: lively.drew / (SETTLE_SECONDS - 1),
      paused: paused.drew,
      pointerMove: hover.drew,
      motion0: still.drew,
    };
  } finally {
    dispose();
  }
}
