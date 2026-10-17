// GPU regressions for knob-keyed compile-time features (SceneDef.featuresFor, featuresAll), through
// the actual renderer. The countryside compiles its optional parts in only while their knobs are on
// (countryFeatures), the meadow its wildflowers and the shared world's parts (worldFeatures), the
// shore, the dunes and the bees the world's parts. The renderer is made to take its context for a
// hardware GPU's or a software rasteriser's (`watched`), whatever renders the check. Registered in
// verify-browser.ts.
//
// sceneFeatures: the default countryside compiles in none of the parts whose knobs are off (flower
// fields, herds, walkers and carts, birds, rain, snow, fog) and its all-features program every one
// (src/shaders/index.test.ts checks that each scene's covers every knob's turn). On a software
// rasteriser nothing is built ahead; a gated knob builds the setting's own program in the
// background (the old frame holding meanwhile, nothing waiting on the build) and switches to it;
// turning it back finds the old program kept; several gated knobs at once build once; past four
// sets the least recently drawn program is freed. The countryside's sim builds its land over a few
// frames first (its terrain); every page here is run until it shows (`landed`), so a frame that
// changes is a program's doing, not the build's.
//
// featureToggles, on a GPU, for every scene with `featuresFor` (KNOB_KEYED; their library gates,
// the night sky's constellations and giant planet, among their gated turns; the scenes keyed by
// their library gates alone are proven structurally by src/shaders/index.test.ts): the plain page
// builds nothing but the program it entered with; no knob change waits for a build (a compile or
// link status or log, a uniform location or a use of a program before the renderer has seen it
// finish building); the first gated change builds the all-features program in the background and
// no change after it builds a program. With changes expected (the lab open) the all-features
// program is built ahead once the scene is at rest and draws one frame without changing it, and the
// first change switches to it at once.
//
// worldFeaturesAll (the shared world's adopters, the rest of KNOB_KEYED), on a GPU: the
// all-features program draws every gated setting, dithered and as source, byte for byte as that
// setting's own program does. The own program draws on a renderer taken for a software
// rasteriser's (which builds a changed setting's own program): it enters at the same starting
// setting as the all-features page, settles there and switches the same way, at the same frozen
// clocks, so the sims share their history (the meadow's clocks close in the rain) and only the
// program differs. The countryside's own check of that (`countryFeaturesAll`) draws over its land
// directly, without the renderer (src/scenes/country/features.verify.ts).
import { gatedTurns } from "./knob-turns.ts";
import { DitherRenderer, type RenderSettings, type ViewId } from "./renderer.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import { featureKey, sceneFeatures, sceneFeaturesAll, shaderValues } from "./shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "./state.ts";

const WIDTH = 160;
const HEIGHT = 100;
/** Real seconds a background build may take under software WebGL on a busy machine. */
const BUILD_SECONDS = 60;
const COMPLETION_STATUS_KHR = 0x91b1;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function settings(scene: SceneId, knobs: Params, view: ViewId = "source"): RenderSettings {
  return renderSettings(
    {
      ...defaultsFor(scene),
      pixel: 1,
      motion: 1,
      view,
      mouse: "still",
      transitions: "off",
    },
    { ...paramDefaults(scene), ...knobs },
  );
}

/**
 * Every scene with `featuresFor`, in lab order. A scene keyed by its library gates alone draws with
 * the same machinery; src/shaders/index.test.ts checks that its all-features set covers its gates.
 */
const KNOB_KEYED = sceneIds.filter((scene) => sceneDefs[scene].featuresFor !== undefined);

/**
 * Frames on demand: rAF is held, and each renderer started here (unpaced: every frame asked for
 * draws) draws a frame only when the function `start` returned for it is called, 16 ms of rAF time
 * after the previous one.
 */
function frameClock(): {
  start: (renderer: DitherRenderer) => () => void;
  restore: () => void;
} {
  const native = window.requestAnimationFrame;
  let requested: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    requested = callback;
    return 1;
  };
  let now = 1000;
  return {
    start(renderer) {
      renderer.start({ paced: false });
      let tick = requested;
      requested = undefined;
      return () => {
        if (!tick) throw new Error("No frame scheduled");
        const run = tick;
        run((now += 16));
        tick = requested;
        requested = undefined;
      };
    },
    restore() {
      window.requestAnimationFrame = native;
    },
  };
}

/**
 * The renderer's own context, on a canvas of its own, with its program builds watched: how many it
 * linked and freed, and (once `armed`) every call that waits for a build the renderer has not yet
 * seen finish, by KHR_parallel_shader_compile's COMPLETION_STATUS_KHR or a fence after the link:
 * its compile or link status or log, a uniform location, or using it.
 */
interface Watched {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  links: number;
  frees: number;
  armed: boolean;
  waits: string[];
  drawing: () => WebGLProgram | null;
  image: () => Uint8Array;
  dispose: () => void;
}

/**
 * A watched context that the renderer takes for a `gpu` of one kind, whatever renders it: its
 * renderer string stands in for a hardware GPU's or SwiftShader's. A hardware one also has
 * KHR_parallel_shader_compile, as GPU browsers do: where the browser lacks it, a stand-in reports
 * each program built only on its third poll, so the frames in between show what the renderer draws
 * while it waits. A software one keeps the browser's own (SwiftShader has none: fences).
 */
function watched(gpu: "hardware" | "software"): Watched {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.append(canvas);
  // The renderer asks for this same context.
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) throw new Error("Features context unavailable");
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const named = gpu === "hardware" ? "ANGLE (stand-in hardware GPU)" : "ANGLE (SwiftShader)";
  const parameter = gl.getParameter.bind(gl);
  gl.getParameter = (name: number): unknown =>
    name === UNMASKED_RENDERER_WEBGL || name === gl.RENDERER ? named : parameter(name);
  if (gpu === "hardware" && gl.getExtension("KHR_parallel_shader_compile") === null) {
    const extension = gl.getExtension.bind(gl);
    const programParameter = gl.getProgramParameter.bind(gl);
    const polls = new WeakMap<WebGLProgram, number>();
    gl.getExtension = ((name: string) =>
      name === "KHR_parallel_shader_compile"
        ? { COMPLETION_STATUS_KHR }
        : extension(name)) as typeof gl.getExtension;
    gl.getProgramParameter = (program: WebGLProgram, name: number): unknown => {
      if (name !== COMPLETION_STATUS_KHR) return programParameter(program, name);
      const poll = (polls.get(program) ?? 0) + 1;
      polls.set(program, poll);
      return poll >= 3;
    };
  }
  const state: Watched = {
    canvas,
    gl,
    links: 0,
    frees: 0,
    armed: false,
    waits: [],
    drawing: () => gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    image: () => {
      const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
      gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      return bytes;
    },
    dispose: () => {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
  const building = new Set<WebGLProgram>();
  const owner = new WeakMap<WebGLShader, WebGLProgram>();
  const fenced = new WeakMap<WebGLSync, WebGLProgram[]>();
  // A call that waits for a build leaves it done: only the first one counts.
  const wait = (call: string, program: WebGLProgram | null | undefined) => {
    if (!program || !building.has(program)) return;
    building.delete(program);
    if (state.armed) state.waits.push(call);
  };
  const link = gl.linkProgram.bind(gl);
  gl.linkProgram = (program) => {
    state.links++;
    building.add(program);
    link(program);
  };
  const free = gl.deleteProgram.bind(gl);
  gl.deleteProgram = (program) => {
    if (program !== null) {
      state.frees++;
      building.delete(program);
    }
    free(program);
  };
  const attach = gl.attachShader.bind(gl);
  gl.attachShader = (program, shader) => {
    owner.set(shader, program);
    attach(program, shader);
  };
  const fence = gl.fenceSync.bind(gl);
  gl.fenceSync = (condition, flags) => {
    const sync = fence(condition, flags);
    if (sync) fenced.set(sync, [...building]);
    return sync;
  };
  const syncParameter = gl.getSyncParameter.bind(gl);
  gl.getSyncParameter = (sync, name): unknown => {
    const value: unknown = syncParameter(sync, name);
    if (name === gl.SYNC_STATUS && value === gl.SIGNALED)
      for (const program of fenced.get(sync) ?? []) building.delete(program);
    return value;
  };
  const programParameter = gl.getProgramParameter.bind(gl);
  gl.getProgramParameter = (program, name): unknown => {
    const value: unknown = programParameter(program, name);
    if (name === COMPLETION_STATUS_KHR) {
      if (value === true) building.delete(program);
    } else wait(`getProgramParameter(0x${name.toString(16)})`, program);
    return value;
  };
  const shaderParameter = gl.getShaderParameter.bind(gl);
  gl.getShaderParameter = (shader, name): unknown => {
    if (name !== COMPLETION_STATUS_KHR)
      wait(`getShaderParameter(0x${name.toString(16)})`, owner.get(shader));
    return shaderParameter(shader, name);
  };
  const programLog = gl.getProgramInfoLog.bind(gl);
  gl.getProgramInfoLog = (program) => {
    wait("getProgramInfoLog", program);
    return programLog(program);
  };
  const location = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program, name) => {
    wait("getUniformLocation", program);
    return location(program, name);
  };
  const use = gl.useProgram.bind(gl);
  gl.useProgram = (program) => {
    wait("useProgram", program);
    use(program);
  };
  return state;
}

/** Cells whose colour differs between two frames, and their bounds (x, y from the bottom). */
function changed(a: Uint8Array, b: Uint8Array): { count: number; box: number[] } {
  let count = 0;
  const box = [WIDTH, HEIGHT, -1, -1];
  for (let at = 0; at < WIDTH * HEIGHT; at++) {
    const i = at * 4;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
    count++;
    const x = at % WIDTH;
    const y = Math.floor(at / WIDTH);
    box[0] = Math.min(box[0] ?? x, x);
    box[1] = Math.min(box[1] ?? y, y);
    box[2] = Math.max(box[2] ?? x, x);
    box[3] = Math.max(box[3] ?? y, y);
  }
  return { count, box };
}

/**
 * Frames, a little real time apart (a background build's status updates between tasks), until the
 * program drawing is no longer `from`; each must still show `held`. Returns how many held.
 */
async function switchFrom(
  frame: () => void,
  context: Watched,
  from: WebGLProgram | null,
  held: Uint8Array,
): Promise<number> {
  const start = performance.now();
  let heldFrames = 0;
  for (;;) {
    frame();
    if (context.drawing() !== from) return heldFrames;
    check(
      changed(context.image(), held).count === 0,
      "The frame changed while the new program was still building",
    );
    heldFrames++;
    check(
      performance.now() - start < BUILD_SECONDS * 1000,
      `No program switch within ${BUILD_SECONDS} s`,
    );
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 50);
    await pause.promise;
  }
}

/**
 * Frames, a little real time apart (a build's status updates between tasks), from the first one
 * until the scene the setup asks for is on screen: it enters once its program is built in the
 * background (the bare page showing meanwhile).
 */
async function arrive(frame: () => void, renderer: DitherRenderer): Promise<void> {
  const start = performance.now();
  frame();
  while (renderer.waiting) {
    check(
      performance.now() - start < BUILD_SECONDS * 1000,
      `No scene on screen within ${BUILD_SECONDS} s`,
    );
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 20);
    await pause.promise;
    frame();
  }
}

/** Scenes whose sim builds their picture over frames before it shows (the countryside's terrain). */
const BUILT_OVER_FRAMES: Partial<Record<SceneId, true>> = { country: true };

/**
 * Frames until a scene that builds its picture over frames (BUILT_OVER_FRAMES) shows it: the frame
 * changes from the first one drawn (the sky alone) and then holds still. A scene drawn whole from
 * its first frame returns at once.
 */
async function landed(scene: SceneId, frame: () => void, context: Watched): Promise<void> {
  if (BUILT_OVER_FRAMES[scene] !== true) return;
  const start = performance.now();
  frame();
  const first = context.image();
  let last = first;
  let moved = false;
  for (;;) {
    frame();
    const image = context.image();
    if (moved && changed(image, last).count === 0) return;
    moved ||= changed(image, first).count > 0;
    last = image;
    check(
      performance.now() - start < BUILD_SECONDS * 1000,
      `${scene}: its land did not show within ${BUILD_SECONDS} s`,
    );
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 10);
    await pause.promise;
  }
}

/** Frames a page draws at its starting setting before any change (see `settle`). */
const SETTLE_FRAMES = 24;

/**
 * Frames at the starting setting until the sims' budgeted pre-runs are done (the meadow's spreads
 * its pre-run over frames, up to 90 ms of it a frame, reading the knobs of each): at least
 * SETTLE_FRAMES, the last three unchanged. Two pages that settle so and then make the same change
 * at the same frozen clocks hold the same sim state, whatever setting each then draws.
 */
function settle(frame: () => void, context: Watched): void {
  let last = context.image();
  let still = 0;
  for (let n = 0; n < SETTLE_FRAMES || still < 3; n++) {
    check(n < 10 * SETTLE_FRAMES, "The picture did not settle at its starting setting");
    frame();
    const image = context.image();
    still = changed(image, last).count === 0 ? still + 1 : 0;
    last = image;
  }
}

export async function verifySceneFeatures(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const country = sceneDefs.country;
  const defaults = paramDefaults("country");
  // The default setting compiles in none of the parts whose knobs are off, the all-features program
  // every one.
  const off = [
    "COUNTRY_HAS_FIELDS",
    "COUNTRY_HAS_HERDS",
    "COUNTRY_HAS_AGENTS",
    "COUNTRY_HAS_BIRDS",
    "COUNTRY_HAS_RAIN",
    "COUNTRY_HAS_SNOW",
    "COUNTRY_HAS_FOG",
  ];
  const plainSet = sceneFeatures(country);
  check(
    off.every((name) => plainSet[name] === 0),
    `Default countryside compiles optional parts in: ${JSON.stringify(plainSet)}`,
  );
  const all = sceneFeaturesAll(country) ?? {};
  const gates = Object.keys(plainSet).filter((name) => name.startsWith("COUNTRY_HAS_"));
  check(
    gates.length >= off.length && gates.every((name) => all[name] === 1),
    `The countryside's all-features program leaves parts out: ${JSON.stringify(all)}`,
  );
  check(
    sceneFeatures(country, shaderValues(country, { pasture: 1 })).COUNTRY_HAS_HERDS === 1,
    "The pasture knob does not gate the herds in",
  );

  // A software rasteriser (SwiftShader's renderer string and its own build signals: fences).
  const clock = frameClock();
  const context = watched("software");
  try {
    // Reduced motion: the clocks stand still, so frames compare exactly.
    const renderer = new DitherRenderer(context.canvas, settings("country", defaults), true);
    const frame = clock.start(renderer);
    await arrive(frame, renderer);
    await landed("country", frame, context);
    check(
      renderer.failure === undefined && context.links === 1,
      `The default countryside built ${context.links} programs: ${JSON.stringify(renderer.failure)}`,
    );
    const plain = context.drawing();
    const before = context.image();
    context.armed = true;

    // Pasture on: its own program (the fences and herds) is built in the background and takes over,
    // the land model turning some parcels to pasture; until then the old frame holds.
    renderer.update(settings("country", { pasture: 1 }));
    const heldFrames = await switchFrom(frame, context, plain, before);
    check(
      heldFrames >= 1,
      "The pasture's program took over on the frame its build began: nothing was built in the background",
    );
    const pastured = context.drawing();
    const pasture = changed(before, context.image());
    check(
      renderer.failure === undefined && context.links === 2,
      `The pasture took ${context.links - 1} more programs to build`,
    );
    check(pasture.count >= 20, `The pasture drew ${pasture.count} changed cells`);

    // Off again: the default program is still kept, and draws the same frame at once.
    renderer.update(settings("country", {}));
    frame();
    check(
      context.drawing() === plain &&
        context.links === 2 &&
        changed(before, context.image()).count === 0,
      "Turning the pasture off did not return to the kept default program",
    );

    // A setup turning three gated parts on at once builds one program, which draws them all.
    renderer.update(settings("country", { pasture: 1, fog: 0.6, snow: 0.6 }));
    await switchFrom(frame, context, plain, before);
    check(
      renderer.failure === undefined && context.links === 3,
      `A setup turning three gated knobs on built ${context.links - 2} programs`,
    );
    check(context.drawing() !== pastured, "Three gated knobs drew with the pasture's program");
    const three = changed(before, context.image()).count;
    check(
      three > pasture.count,
      `Pasture, fog and snow changed ${three} cells, the pasture alone ${pasture.count}`,
    );

    // Past PROGRAMS_PER_SCENE (4) sets the least recently drawn program is freed, never the one
    // drawing; no change waited on a build.
    renderer.update(settings("country", { fog: 0.6 }));
    await switchFrom(frame, context, context.drawing(), context.image());
    renderer.update(settings("country", { snow: 0.6 }));
    await switchFrom(frame, context, context.drawing(), context.image());
    check(
      context.links === 5 && context.frees === 1,
      `Five sets built ${context.links} programs and freed ${context.frees}`,
    );
    renderer.update(settings("country", {}));
    frame();
    check(
      context.drawing() === plain && context.links === 5,
      "The default program was freed though it was drawn more recently than the pasture's",
    );

    // Changes expected (the lab open): nothing is built ahead.
    renderer.expectChanges(true);
    for (let i = 0; i < 3; i++) frame();
    check(
      context.links === 5 && context.drawing() === plain,
      `A software rasteriser built ${context.links - 5} programs ahead of any change`,
    );
    check(
      context.waits.length === 0,
      `Knob changes waited on a build: ${context.waits.join(", ")}`,
    );
    return {
      heldFrames,
      pastureCells: pasture.count,
      threeCells: three,
      links: context.links,
      frees: context.frees,
    };
  } finally {
    clock.restore();
    context.dispose();
  }
}

const VIEWS: readonly ViewId[] = ["source", "dithered"];

/** Contexts opened for a check, taken for a hardware GPU's unless asked (`watched`), each closed when done. */
function contextPool(): {
  open: (gpu?: "hardware" | "software") => Watched;
  close: (context: Watched) => void;
  closeAll: () => void;
} {
  const contexts = new Set<Watched>();
  const close = (context: Watched) => {
    context.dispose();
    contexts.delete(context);
  };
  return {
    open(gpu = "hardware") {
      const context = watched(gpu);
      contexts.add(context);
      return context;
    },
    close,
    closeAll() {
      for (const context of contexts) close(context);
    },
  };
}

/**
 * Each setting of `turns` in each of VIEWS, one frame each: every one must draw at once with
 * `full`. Returns the frames by `${view} ${index}`.
 */
function drawTurns(
  scene: SceneId,
  turns: readonly Params[],
  renderer: DitherRenderer,
  frame: () => void,
  context: Watched,
  full: WebGLProgram | null,
): Map<string, Uint8Array> {
  const drawn = new Map<string, Uint8Array>();
  for (const view of VIEWS)
    for (const [index, knobs] of turns.entries()) {
      const links = context.links;
      renderer.update(settings(scene, knobs, view));
      frame();
      check(
        context.links === links,
        `${scene}: ${JSON.stringify(knobs)} built a program of its own`,
      );
      check(
        renderer.failure === undefined && context.drawing() === full,
        `${scene}: ${JSON.stringify(knobs)} did not draw at once with the all-features program`,
      );
      drawn.set(`${view} ${index}`, context.image());
    }
  return drawn;
}

export async function verifyFeatureToggles(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const clock = frameClock();
  const pool = contextPool();
  const result: Record<string, unknown> = {};
  try {
    for (const scene of KNOB_KEYED) {
      const started = performance.now();
      const turns = gatedTurns(sceneDefs[scene]);
      const [first = {}] = turns;

      // The default page: entered with the program for its setting, it builds nothing more. It
      // settles first (the dunes' sand warms up over frames), so a frame that changes from here on
      // is a program's doing.
      const page = pool.open();
      const renderer = new DitherRenderer(page.canvas, settings(scene, {}), true);
      const frame = clock.start(renderer);
      await arrive(frame, renderer);
      for (let i = 0; i < 3; i++) frame();
      await landed(scene, frame, page);
      settle(frame, page);
      check(
        renderer.failure === undefined && page.links === 1,
        `${scene}: the default page built ${page.links} programs`,
      );
      const plain = page.drawing();
      const lean = page.image();

      // The first gated change builds the all-features program in the background (the old frame
      // holding), waiting on no build; every gated setting after it, in two views, draws at once
      // with that program and builds nothing; the default setting returns to the page's own.
      page.armed = true;
      renderer.update(settings(scene, first));
      const heldFrames = await switchFrom(frame, page, plain, lean);
      const full = page.drawing();
      check(
        renderer.failure === undefined && page.links === 2 && page.waits.length === 0,
        `${scene}: the first gated change built ${page.links - 1} programs and waited on builds: ${page.waits.join(", ")}`,
      );
      const drawn = drawTurns(scene, turns, renderer, frame, page, full);
      renderer.update(settings(scene, {}));
      frame();
      check(
        page.drawing() === plain && changed(lean, page.image()).count === 0,
        `${scene}: the default setting did not return to the program the page entered with`,
      );
      check(
        page.links === 2 && page.waits.length === 0,
        `${scene}: ${turns.length * VIEWS.length} gated changes built ${page.links - 2} programs and waited on builds: ${page.waits.join(", ")}`,
      );
      pool.close(page);

      // Changes expected (the lab open): the all-features program is built in the background,
      // waiting on no build, and draws one frame at the setting on screen, which must not change;
      // the program the scene entered with takes over again, and the first gated change then
      // draws at once with the all-features program.
      const ahead = pool.open();
      const expecting = new DitherRenderer(ahead.canvas, settings(scene, {}), true);
      const aheadFrame = clock.start(expecting);
      await arrive(aheadFrame, expecting);
      await landed(scene, aheadFrame, ahead);
      settle(aheadFrame, ahead);
      const entered = ahead.drawing();
      ahead.armed = true;
      expecting.expectChanges(true);
      let built: WebGLProgram | null = null;
      const waitStart = performance.now();
      while (built === null) {
        aheadFrame();
        check(
          changed(lean, ahead.image()).count === 0,
          `${scene}: the frame changed while the all-features program was built ahead`,
        );
        if (ahead.drawing() !== entered) built = ahead.drawing();
        check(
          performance.now() - waitStart < BUILD_SECONDS * 1000,
          `${scene}: the all-features program was not built ahead within ${BUILD_SECONDS} s`,
        );
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 50);
        await pause.promise;
      }
      aheadFrame();
      check(
        ahead.drawing() === entered && changed(lean, ahead.image()).count === 0,
        `${scene}: after drawing the all-features program once the page did not return to its own`,
      );
      expecting.update(settings(scene, first));
      aheadFrame();
      check(
        ahead.drawing() === built &&
          ahead.links === 2 &&
          changed(drawn.get("source 0") ?? new Uint8Array(), ahead.image()).count === 0,
        `${scene}: the first change after building ahead did not draw at once with the all-features program (${ahead.links} builds)`,
      );
      check(
        ahead.waits.length === 0,
        `${scene}: building ahead waited on a build: ${ahead.waits.join(", ")}`,
      );
      pool.close(ahead);
      // Seconds to a tenth: each scene's share of the check's time.
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      result[scene] = { settings: turns.length, heldFrames, seconds };
    }
    return result;
  } finally {
    clock.restore();
    pool.closeAll();
  }
}

/**
 * worldFeaturesAll: for each scene with `featuresFor` but the countryside (whose own check draws
 * over its land directly), the all-features program draws every gated setting as its own program
 * does (see the header).
 */
export async function verifyWorldFeaturesAll(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const clock = frameClock();
  const pool = contextPool();
  const result: Record<string, unknown> = {};
  try {
    for (const scene of KNOB_KEYED.filter((id) => id !== "country")) {
      const started = performance.now();
      const def = sceneDefs[scene];
      const turns = gatedTurns(def);
      const [first = {}] = turns;

      // Every gated setting, in two views, drawn with the all-features program, after the page has
      // settled at the starting setting.
      const page = pool.open();
      const renderer = new DitherRenderer(page.canvas, settings(scene, {}), true);
      const frame = clock.start(renderer);
      await arrive(frame, renderer);
      await landed(scene, frame, page);
      settle(frame, page);
      const plain = page.drawing();
      renderer.update(settings(scene, first));
      await switchFrom(frame, page, plain, page.image());
      const drawn = drawTurns(scene, turns, renderer, frame, page, page.drawing());
      pool.close(page);

      // Each setting's own program draws the same frames: on a renderer taken for a software
      // rasteriser's, which builds a changed setting's own program in the background and never the
      // all-features one. It enters at the same starting setting, settles there and switches from
      // setting to setting in the same order at the same frozen clocks, so its sim has the
      // all-features page's history and only the program differs.
      const byKey = new Map<string, number[]>();
      turns.forEach((knobs, index) => {
        const key = featureKey(sceneFeatures(def, shaderValues(def, knobs)));
        byKey.set(key, [...(byKey.get(key) ?? []), index]);
      });
      const mismatches: string[] = [];
      const reference = pool.open("software");
      const own = new DitherRenderer(reference.canvas, settings(scene, {}), true);
      const ownFrame = clock.start(own);
      await arrive(ownFrame, own);
      await landed(scene, ownFrame, reference);
      settle(ownFrame, reference);
      let current = featureKey(sceneFeatures(def));
      let builds = 1;
      for (const [key, indices] of byKey) {
        own.update(settings(scene, turns[indices[0] ?? 0] ?? {}));
        if (key !== current) {
          await switchFrom(ownFrame, reference, reference.drawing(), reference.image());
          current = key;
          builds++;
        }
        for (const view of VIEWS)
          for (const index of indices) {
            const knobs = turns[index] ?? {};
            own.update(settings(scene, knobs, view));
            ownFrame();
            const difference = changed(
              drawn.get(`${view} ${index}`) ?? new Uint8Array(),
              reference.image(),
            );
            if (difference.count > 0)
              mismatches.push(
                `${view} ${JSON.stringify(knobs)}: ${difference.count} cells in ${difference.box.join(",")}`,
              );
          }
      }
      check(
        own.failure === undefined && reference.links === builds,
        `${scene}: ${byKey.size} settings' own programs took ${reference.links - 1} builds: ${JSON.stringify(own.failure)}`,
      );
      pool.close(reference);
      check(
        mismatches.length === 0,
        `${scene}: the all-features program draws differently from each setting's own: ${mismatches.join("; ")}`,
      );
      // Seconds to a tenth: each scene's share of the check's time.
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      result[scene] = { settings: turns.length, programs: byKey.size, seconds };
    }
    return result;
  } finally {
    clock.restore();
    pool.closeAll();
  }
}
