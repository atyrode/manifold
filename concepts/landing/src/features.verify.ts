// GPU regression for knob-keyed compile-time features (SceneDef.featuresFor), through the actual
// renderer on the countryside, whose optional parts are compiled in only while their knobs are on
// (countryFeatures): turning a gated knob on builds the program with it and switches to it once
// built, the old frame holding until then; the new program draws the part; turning the knob back
// finds the old program kept; a setup turning several gated knobs on at once builds once; and past
// PROGRAMS_PER_SCENE sets the least recently drawn program is freed. Registered in verify-browser.ts.
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { sceneDefs } from "./scenes/index.ts";
import { sceneFeatures, shaderValues } from "./shaders/index.ts";
import { defaultsFor, paramDefaults, renderSettings, type Params } from "./state.ts";

const WIDTH = 160;
const HEIGHT = 100;
/** Real seconds a background build may take under software WebGL on a busy machine. */
const BUILD_SECONDS = 60;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

function settings(knobs: Params): RenderSettings {
  return renderSettings(
    {
      ...defaultsFor("country"),
      pixel: 1,
      motion: 1,
      view: "source",
      mouse: "still",
      transitions: "off",
    },
    knobs,
  );
}

export async function verifySceneFeatures(
  _gl: WebGL2RenderingContext,
): Promise<Record<string, unknown>> {
  const country = sceneDefs.country;
  const defaults = paramDefaults("country");
  // The default setting compiles no optional part in.
  const gates = Object.entries(sceneFeatures(country)).filter(([name]) =>
    name.startsWith("COUNTRY_HAS_"),
  );
  check(
    gates.length > 0 && gates.every(([, value]) => value === 0),
    `Default countryside compiles optional parts in: ${JSON.stringify(gates)}`,
  );
  check(
    sceneFeatures(country, shaderValues(country, { castle: 1 })).COUNTRY_HAS_SETTLEMENTS === 1,
    "The castle knob does not gate the settlements in",
  );

  const nativeRaf = window.requestAnimationFrame;
  let scheduled: FrameRequestCallback | undefined;
  window.requestAnimationFrame = (callback) => {
    scheduled = callback;
    return 1;
  };
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.append(canvas);
  // The renderer asks for this same context: count the programs it links and frees.
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) throw new Error("Features context unavailable");
  let links = 0;
  let frees = 0;
  const link = gl.linkProgram.bind(gl);
  const free = gl.deleteProgram.bind(gl);
  gl.linkProgram = (program) => {
    links++;
    link(program);
  };
  gl.deleteProgram = (program) => {
    if (program !== null) frees++;
    free(program);
  };
  // Background builds: the browser's own, or (software WebGL without KHR_parallel_shader_compile)
  // a stand-in reporting each program built only on its third poll, so the frames in between show
  // what the renderer draws while it waits.
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  if (parallel === null) {
    const COMPLETION_STATUS_KHR = 0x91b1;
    const extension = gl.getExtension.bind(gl);
    const parameter = gl.getProgramParameter.bind(gl);
    const polls = new WeakMap<WebGLProgram, number>();
    gl.getExtension = ((name: string) =>
      name === "KHR_parallel_shader_compile"
        ? { COMPLETION_STATUS_KHR }
        : extension(name)) as typeof gl.getExtension;
    gl.getProgramParameter = (program: WebGLProgram, name: number): unknown => {
      if (name !== COMPLETION_STATUS_KHR) return parameter(program, name);
      const poll = (polls.get(program) ?? 0) + 1;
      polls.set(program, poll);
      return poll >= 3;
    };
  }
  let now = 1000;
  const frame = () => {
    const tick = scheduled;
    if (!tick) throw new Error("No frame scheduled");
    scheduled = undefined;
    tick((now += 16));
  };
  const drawing = () => gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const image = () => {
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  /** Pixels (x, y from the bottom) whose colour differs between two frames, and their bounds. */
  const changed = (a: Uint8Array, b: Uint8Array) => {
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
  };
  /** Frames, a little real time apart, until the program on screen is no longer `from`. */
  const switchFrom = async (from: WebGLProgram | null, held: Uint8Array): Promise<number> => {
    const start = performance.now();
    let heldFrames = 0;
    for (;;) {
      frame();
      if (drawing() !== from) return heldFrames;
      check(
        changed(image(), held).count === 0,
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
  };

  try {
    // Reduced motion: the clocks stand still, so frames compare exactly.
    const renderer = new DitherRenderer(canvas, settings(defaults), true);
    renderer.start();
    frame();
    check(
      renderer.failure === undefined && links === 1,
      `The default countryside built ${links} programs: ${JSON.stringify(renderer.failure)}`,
    );
    const plain = drawing();
    const before = image();

    // The castle on: its program is built and takes over, drawing the castle on the chalk down
    // (right of the middle, its hill's woods cleared around it); until then the old frame holds.
    renderer.update(settings({ ...defaults, castle: 1 }));
    const heldFrames = await switchFrom(plain, before);
    check(
      heldFrames >= 1,
      "The castle's program took over on the frame its build began: nothing was built in the background",
    );
    const castled = drawing();
    const castle = changed(before, image());
    check(
      renderer.failure === undefined && links === 2,
      `The castle took ${links - 1} more programs to build`,
    );
    check(
      castle.count >= 6 && (castle.box[0] ?? 0) > WIDTH * 0.55,
      `The castle program drew ${castle.count} changed cells at ${castle.box.join(",")}, not the castle right of the middle`,
    );

    // Off again: the default program is still kept, and draws the same frame at once.
    renderer.update(settings(defaults));
    frame();
    check(
      drawing() === plain && links === 2 && changed(before, image()).count === 0,
      "Turning the castle off did not return to the kept default program",
    );

    // A setup turning three gated parts on at once builds one program, which draws them all.
    renderer.update(settings({ ...defaults, castle: 1, chalk: 1, fog: 0.6 }));
    await switchFrom(plain, before);
    check(
      renderer.failure === undefined && links === 3,
      `A setup turning three gated knobs on built ${links - 2} programs`,
    );
    check(drawing() !== castled, "Three gated knobs drew with the castle's program");
    const three = changed(before, image()).count;
    check(
      three > castle.count,
      `Castle, chalk figure and fog changed ${three} cells, the castle alone ${castle.count}`,
    );

    // Past PROGRAMS_PER_SCENE (4) sets the least recently drawn program is freed, never the one drawing.
    renderer.update(settings({ ...defaults, chalk: 1 }));
    await switchFrom(drawing(), image());
    renderer.update(settings({ ...defaults, fog: 0.6 }));
    await switchFrom(drawing(), image());
    check(links === 5 && frees === 1, `Five sets built ${links} programs and freed ${frees}`);
    renderer.update(settings(defaults));
    frame();
    check(
      drawing() === plain && links === 5,
      "The default program was freed though it was drawn more recently than the castle's",
    );
    return {
      parallelCompile: parallel !== null,
      heldFrames,
      castleCells: castle.count,
      threeCells: three,
      links,
      frees,
    };
  } finally {
    window.requestAnimationFrame = nativeRaf;
    canvas.remove();
  }
}
