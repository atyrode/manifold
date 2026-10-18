// layerToggles: a composed scene's layer turned on or off mid-scene plays its own entrance or exit,
// in a program that draws turns (compose.ts TURNS_GATE), while the steady programs the scene rests
// in carry none of that (no cut per cell, no plain floor under the ground layer); a switch-off
// never waits for a build. Through the actual renderer with the lab open
// (DitherRenderer.expectChanges), on a software rasteriser (which builds each setting's own
// program), in the fireflies' creek (their ground layer), the clocks frozen so frames compare
// exactly (a layer's turn plays on wall time all the same):
//   - at rest: the steady program draws, unchanged, while the program a switch-off would leave
//     through (its layer set drawing turns) is built in the background, once; built, it draws one
//     frame in the steady one's place, the same picture, so that the driver compiles it then;
//   - off: that program takes over on the very next frame, drawing it as the steady one did, then
//     gives a growing share of the creek's cells to the plain floor until none is left; the
//     setting's own steady program (without the creek) is asked for and takes over only then, and
//     the program to leave it through is built ahead (and drawn once) in its turn;
//   - on again: the program the exit played in is the one the entrance plays in, still kept, so it
//     takes over at once and gives a growing share of the cells back to the creek; once it has, the
//     steady program the scene entered with is still kept and takes over, drawing the entrance's
//     last frame exactly, and nothing more is built.
// Four programs are built in all, each in the background. Registered in verify-browser.ts.
import { DitherRenderer } from "../renderer.ts";
import { check, holdFrames, labSettings, pause, stage, until } from "../verify/kit.ts";

const WIDTH = 160;
const HEIGHT = 100;
/** Real seconds a background build may take under software WebGL on a busy machine. */
const BUILD_SECONDS = 60;
/** Frames a turn may take: LAYER_ENTER and LAYER_EXIT at 16 ms a frame, with room. */
const TURN_FRAMES = 200;
/** Frames, a little real time apart, that show nothing more is built once the scene is at rest. */
const IDLE_FRAMES = 20;

/** Cells whose colour differs between two frames. */
function changed(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
  return count;
}

export async function verifyLayerToggles(): Promise<Record<string, unknown>> {
  const { canvas, gl } = stage(WIDTH, HEIGHT);
  // Every program the renderer builds, in the order it links them, the fragment source each was
  // linked from, and those it has seen finish building (it asks their link status then).
  const sources = new Map<WebGLShader, string>();
  const fragments = new Map<WebGLProgram, string>();
  const linked: WebGLProgram[] = [];
  const finished = new Set<WebGLProgram>();
  const shaderSource = gl.shaderSource.bind(gl);
  gl.shaderSource = (shader, source) => {
    sources.set(shader, source);
    shaderSource(shader, source);
  };
  const attach = gl.attachShader.bind(gl);
  gl.attachShader = (program, shader) => {
    const source = sources.get(shader);
    if (source?.includes("composerEntry") === true) fragments.set(program, source);
    attach(program, shader);
  };
  const link = gl.linkProgram.bind(gl);
  gl.linkProgram = (program) => {
    linked.push(program);
    link(program);
  };
  const programParameter = gl.getProgramParameter.bind(gl);
  gl.getProgramParameter = (program, name): unknown => {
    if (name === gl.LINK_STATUS) finished.add(program);
    return programParameter(program, name);
  };
  // The renderer takes the context for a software rasteriser's, whatever renders the check.
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const parameter = gl.getParameter.bind(gl);
  gl.getParameter = (name: number): unknown =>
    name === UNMASKED_RENDERER_WEBGL || name === gl.RENDERER
      ? "ANGLE (SwiftShader)"
      : parameter(name);
  const drawing = () => gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const image = (): Uint8Array => {
    const bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  /** What a program's fragment source compiles in: a turn's cut per cell, the plain floor's call, the creek. */
  const kind = (program: WebGLProgram | null | undefined) => {
    const source = (program == null ? undefined : fragments.get(program)) ?? "";
    return {
      turns: source.includes("bool shows["),
      floor: source.includes("composerFloor(x, c);"),
      creek: source.includes("creekGround(x, c)"),
    };
  };

  const frames = holdFrames();
  let now = 1000;
  // Reduced motion: the clocks stand still, so frames compare exactly.
  const renderer = new DitherRenderer(canvas, labSettings("fireflies"), true);
  renderer.expectChanges(true);
  renderer.start({ paced: false });
  let tick = frames.take();
  const frame = (): void => {
    if (!tick) throw new Error("No frame scheduled");
    const run = tick;
    run((now += 16));
    tick = frames.take();
  };
  /**
   * Frames, a little real time apart, until the `count`th program built has been built in the
   * background and has drawn its one warm frame in `program`'s place (a driver compiles it then),
   * `program` drawing again after it; the frame holds `held` throughout. How many frames it drew.
   */
  const builtAhead = async (count: number, program: WebGLProgram | null, held: Uint8Array) => {
    let warm = 0;
    await until(
      () => {
        frame();
        check(changed(image(), held) === 0, "The frame changed while a program was built ahead");
        const ahead = linked[count - 1];
        if (ahead !== undefined && drawing() === ahead) warm++;
        else check(drawing() === program, "Another program drew while one was built ahead");
        return warm > 0 && drawing() === program;
      },
      BUILD_SECONDS,
      `No program built ahead (${linked.length} built)`,
      50,
    );
    return warm;
  };
  try {
    await until(
      () => {
        frame();
        return !renderer.waiting;
      },
      BUILD_SECONDS,
      "No scene on screen",
    );
    for (let i = 0; i < 8; i++) frame();
    const steady = drawing();
    const rest = image();
    const steadyKind = kind(steady);
    check(
      renderer.failure === undefined && steady === linked[0],
      `The fireflies did not enter with the first program built: ${JSON.stringify(renderer.failure)}`,
    );
    check(
      !steadyKind.turns && !steadyKind.floor && steadyKind.creek,
      `The fireflies' steady program compiles in ${JSON.stringify(steadyKind)}, not the creek alone`,
    );

    // At rest: the program a switch-off leaves through is built ahead, the steady frame holding.
    const warmFrames = await builtAhead(2, steady, rest);
    const turning = linked[1] ?? null;
    const turningKind = kind(turning);
    check(
      linked.length === 2 &&
        warmFrames === 1 &&
        turningKind.turns &&
        turningKind.floor &&
        turningKind.creek,
      `Built ahead at rest: ${linked.length - 1} programs, drawn ${warmFrames} frames, the last compiling in ${JSON.stringify(turningKind)}`,
    );

    // Off: the exit's program takes over on the next frame, drawing it as the steady one did.
    renderer.update(labSettings("fireflies", { creek: 0 }));
    const switched = performance.now();
    frame();
    const exitDelayMs = performance.now() - switched;
    check(drawing() === turning, "The creek's exit waited for a build");
    // The exit: a growing share of the creek's cells goes to the plain floor, to the last one; that
    // frame holds until the setting's own program, built in the background, takes over. Each frame
    // is read in the task that drew it (the canvas keeps no frame once the page has shown it).
    const exit = [changed(image(), rest)];
    check(exit[0] === 0, "The exit's program did not draw its first frame as the steady one did");
    await until(
      () => {
        frame();
        if (drawing() !== turning) return true;
        exit.push(changed(image(), rest));
        return false;
      },
      BUILD_SECONDS,
      "No program without the creek after its exit",
      5,
    );
    const gone = exit[exit.length - 1] ?? 0;
    const playing = exit.filter((count) => count > 0 && count < gone).length;
    // The frame the exit first shows in, counted from the switch: the second or third (the first
    // draws its start, no cell gone yet).
    const exitShows = exit.findIndex((count) => count > 0) + 1;
    check(gone >= 50, `The creek's exit changed ${gone} cells`);
    check(
      playing >= 10 &&
        playing < TURN_FRAMES &&
        exitShows >= 2 &&
        exitShows <= 3 &&
        exit.every((count, i) => i === 0 || count >= (exit[i - 1] ?? 0)),
      `The creek's exit did not play as a growing share of its cells: ${exit.join(",")}`,
    );
    const without = drawing();
    const withoutKind = kind(without);
    check(
      without === linked[2] && !withoutKind.turns && withoutKind.floor && !withoutKind.creek,
      `Without the creek the fireflies draw with a program compiling in ${JSON.stringify(withoutKind)}`,
    );
    // Its own program to leave through, built ahead in turn.
    const warmWithout = await builtAhead(4, without, image());
    const leaveWithout = kind(linked[3]);
    check(
      linked.length === 4 &&
        warmWithout === 1 &&
        leaveWithout.turns &&
        leaveWithout.floor &&
        !leaveWithout.creek,
      `Without the creek ${linked.length - 2} programs were built ahead, drawn ${warmWithout} frames, the last compiling in ${JSON.stringify(leaveWithout)}`,
    );

    // On again: the program the exit played in plays the entrance and is kept, so it takes over at
    // once (the creek at none of its cells yet); then, the entrance played, the kept steady program
    // draws its last frame exactly.
    renderer.update(labSettings("fireflies"));
    frame();
    check(drawing() === turning, "The creek's entrance did not take the kept program at once");
    const coming = image();
    const entrance: number[] = [];
    let last = coming;
    for (let n = 0; drawing() === turning; n++) {
      check(n < TURN_FRAMES, "The creek's entrance never ended");
      last = image();
      entrance.push(changed(last, coming));
      frame();
    }
    const back = entrance[entrance.length - 1] ?? 0;
    const entering = entrance.filter((count) => count > 0 && count < back).length;
    check(
      entering >= 10 &&
        back >= 50 &&
        entrance.every((count, i) => i === 0 || count >= (entrance[i - 1] ?? 0)),
      `The creek's entrance did not play as a growing share of its cells: ${entrance.join(",")}`,
    );
    check(drawing() === steady, "After the entrance the kept steady program did not take over");
    check(
      changed(image(), last) === 0,
      "The steady program did not draw the entrance's last frame exactly",
    );
    // Back at rest the program to leave through is kept already: nothing more is built.
    for (let i = 0; i < IDLE_FRAMES; i++) {
      frame();
      await pause(50);
    }
    check(linked.length === 4, `Turning the creek on again built ${linked.length - 4} programs`);
    return {
      exitDelayMs: Math.round(exitDelayMs),
      exitShowsAtFrame: exitShows,
      exitPartialFrames: playing,
      exitCells: gone,
      entrancePartialFrames: entering,
      entranceCells: back,
      links: linked.length,
    };
  } finally {
    frames.restore();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  }
}
