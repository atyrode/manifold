// Runtime regressions in real WebGL, run by verify-browser.ts on one frozen (reduced-motion)
// renderer whose frames run only when called: the reduced-motion interaction policy (Dunes' pouring
// streak ends after release while the scene holds still), a failing scene that keeps the frame loop
// alive and recovers by retry or by another scene, uniforms sent only when they change and always
// when they do, and a Lab that never applies while it is being built (main.ts declares `const lab`
// after `apply`, which reads it). One renderer, two scenes: every program compiled costs seconds
// under software WebGL. A scene enters once its program is built in the background (`arrive`).
import { REST_POSE } from "./composer/camera.ts";
import { Lab } from "./lab.ts";
import { DitherRenderer } from "./renderer.ts";
import { loadScene } from "./scenes/index.ts";
import { defaultsFor, paramDefaults } from "./state.ts";
import { check, holdFrames, labSettings, pause, stage } from "./verify/kit.ts";

const dunesScene = await loadScene("dunes");
const lakeScene = await loadScene("lake");

export async function verifyRuntime(_gl: WebGL2RenderingContext): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const frames = holdFrames();
  // The renderer asks for this same context. Count what is sent to each uniform a program reads
  // (one it does not read has no location), from before the first program is built.
  const { canvas, gl } = stage(320, 200);
  const sends: Record<string, number> = {};
  const names = new WeakMap<WebGLUniformLocation, string>();
  const locate = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program, name) => {
    const location = locate(program, name);
    if (location) names.set(location, name);
    return location;
  };
  const methods = gl as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of [
    "uniform1i",
    "uniform1f",
    "uniform2f",
    "uniform3f",
    "uniform4f",
    "uniform1fv",
    "uniform4fv",
  ]) {
    const send = methods[method]?.bind(gl);
    if (!send) throw new Error(`Missing ${method}`);
    methods[method] = (location: unknown, ...args: unknown[]) => {
      const name = location instanceof WebGLUniformLocation ? names.get(location) : undefined;
      if (name) sends[name] = (sends[name] ?? 0) + 1;
      send(location, ...args);
    };
  }
  const frame = frames.run;
  const uniform = (name: string): unknown => {
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const location = gl.getUniformLocation(program, name);
    if (location === null) throw new Error(`Missing uniform ${name}`);
    return gl.getUniform(program, location);
  };
  const pixels = (x: number, y: number, width: number, height: number): Uint8Array => {
    const bytes = new Uint8Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  };
  const same = (a: Uint8Array, b: Uint8Array): boolean =>
    a.every((value, index) => value === b[index]);

  // Dunes with a stand-in sim: it supplies no texture (the shader draws flat sand, so only its
  // response to the press shows), records what it is given, and throws on demand.
  const dunes = dunesScene;
  const dunesSim = dunes.sim;
  const lake = lakeScene;
  // The lake is composed: its programs come from glslFor (shaders/index.ts fragmentSourceFor).
  const lakeGlslFor = lake.glslFor;
  if (lakeGlslFor === undefined) throw new Error("The lake is not composed");
  const errorLog = console.error;
  const seen = { time: Number.NaN, trigger: Number.NaN, fired: false };
  let fault: Error | undefined;
  let built = 0;
  let disposed = 0;
  const standIn = () => {
    built++;
    return {
      frame(simFrame: { time: number; triggers: readonly number[]; fired: readonly boolean[] }) {
        if (fault) throw fault;
        seen.time = simFrame.time;
        seen.trigger = simFrame.triggers[0] ?? Number.NaN;
        seen.fired = simFrame.fired[0] ?? false;
        return [];
      },
      dispose() {
        disposed++;
      },
    };
  };
  dunes.sim = standIn;
  try {
    const renderer = new DitherRenderer(canvas, labSettings("dunes"), true);
    renderer.start({ paced: false });
    let now = 1000;
    /**
     * Frames, a little real time apart (a build's status changes only between tasks), until the
     * scene the setup asks for is on screen: it enters once its program is built.
     */
    const arrive = async (): Promise<void> => {
      const started = performance.now();
      while (renderer.waiting) {
        check(performance.now() - started < 120_000, "No scene on screen within 120 s");
        await pause(20);
        frame((now += 16));
      }
    };

    // F3: frozen (reduced motion), a press still ends. Dunes draws a pouring streak while the button
    // is held and fades it over 0.6 s from the press; the press's age used to stay 0 forever, so the
    // streak never left.
    frame(now);
    await arrive();
    frame((now += 16));
    // The streak runs up from the pointer (uv 0.5, 0.3): a band of it above the pointer.
    const band = () => pixels(157, 64, 6, 20);
    const before = band();
    const time = uniform("uTime");
    const motionTime = uniform("uMotionTime");
    const rect = canvas.getBoundingClientRect();
    const at = {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.7,
      isPrimary: true,
      button: 0,
      bubbles: true,
    };
    canvas.dispatchEvent(new PointerEvent("pointermove", at));
    canvas.dispatchEvent(new PointerEvent("pointerdown", at));
    frame((now += 16));
    check(
      (uniform("uPrincipals") as Float32Array)[2] === 1 && !same(band(), before),
      "Dunes drew no pouring streak while the button was held",
    );
    canvas.dispatchEvent(new PointerEvent("pointerup", at));
    for (let i = 0; i < 7; i++) frame((now += 100));
    const age =
      (uniform("uTime") as number) - ((uniform("uPrincipals") as Float32Array)[3] ?? Number.NaN);
    check(
      uniform("uTime") === time && uniform("uMotionTime") === motionTime,
      "Reduced motion let the scene or motion clock run",
    );
    check(
      age > 0.65 && age < 0.8,
      `Press age ${age} s, not the ~0.72 s since the press, under reduced motion`,
    );
    check(
      same(band(), before),
      "Dunes' pouring streak persisted after release under reduced motion",
    );
    // Paused, every age holds.
    renderer.setPaused(true);
    for (let i = 0; i < 2; i++) frame((now += 100));
    const pausedAge =
      (uniform("uTime") as number) - ((uniform("uPrincipals") as Float32Array)[3] ?? Number.NaN);
    check(Math.abs(pausedAge - age) < 1e-6, `A paused frame let the press age: ${pausedAge} s`);
    renderer.setPaused(false);
    // A "now" trigger ages the same way for sims, and each press fires once even though the scene
    // clock has not moved between them.
    const fires: boolean[] = [];
    for (let press = 0; press < 2; press++) {
      renderer.trigger(0);
      for (let i = 0; i < 3; i++) {
        frame((now += 100));
        fires.push(seen.fired);
      }
    }
    const triggerAge = seen.time - seen.trigger;
    check(
      fires.join() === "true,false,false,true,false,false",
      `Trigger presses fired ${fires.join()} under reduced motion`,
    );
    check(
      triggerAge > 0.25 && triggerAge < 0.35,
      `Trigger age ${triggerAge} s, not 0.3 s, under reduced motion`,
    );
    result.reducedMotion = { pressAge: age, triggerAge, streakCleared: true };

    // F7: a scene that throws keeps the frame loop alive, says why, and recovers. Small from here,
    // once the canvas's observer has reported its new size (a rendering update).
    canvas.style.width = "64px";
    canvas.style.height = "40px";
    await frames.rendered();
    const image = () => pixels(0, 0, 64, 40);
    const drawn = () => {
      const bytes = image();
      return bytes.some((value, index) => index % 4 !== 3 && value !== bytes[index % 4]);
    };
    const n = Number.parseInt(labSettings("dunes").bg.slice(1), 16);
    const background = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const blank = () =>
      image().every(
        (value, index) => index % 4 === 3 || Math.abs(value - (background[index % 4] ?? -9)) <= 1,
      );
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(String(args[0]));
    };
    frame((now += 16));
    check(renderer.failure === undefined && drawn(), "Dunes did not draw before the fault");
    fault = new Error("injected sim fault");
    let escaped: unknown;
    let next = false;
    try {
      next = frame((now += 16));
    } catch (error: unknown) {
      escaped = error;
    }
    check(escaped === undefined, `A simulation fault escaped the frame loop: ${String(escaped)}`);
    check(next, "No next frame was scheduled after a simulation fault");
    const failure = renderer.failure;
    check(
      failure?.scene === "dunes" &&
        failure.stage === "frame" &&
        failure.message === "injected sim fault",
      `Wrong failure state: ${JSON.stringify(failure)}`,
    );
    check(
      logged.includes("evt=landing.renderer.scene_failed scene=dunes stage=frame"),
      `Fault not logged as an event: ${logged.join(" | ")}`,
    );
    check(disposed === 1, `The failed simulation was disposed ${disposed} times`);
    check(frame((now += 16)) && blank(), "The failed scene did not leave the background drawing");
    fault = undefined;
    renderer.retry();
    frame((now += 16));
    check(
      renderer.failure === undefined && built === 2 && drawn(),
      "Retry did not bring the scene back",
    );
    // A shader that does not build is reported too (its program built in the background meanwhile,
    // the scene on screen going on), and retry builds it again once it is fixed.
    lake.glslFor = (features) => `${lakeGlslFor(features)}\n#error injected build fault\n`;
    renderer.update(labSettings("lake"));
    check(frame((now += 16)), "No next frame was scheduled after a shader failed to build");
    await arrive();
    check(
      renderer.failure?.stage === "build",
      `Build fault not reported: ${JSON.stringify(renderer.failure)}`,
    );
    lake.glslFor = lakeGlslFor;
    renderer.retry();
    frame((now += 16));
    await arrive();
    check(renderer.failure === undefined && drawn(), "Retry did not rebuild a fixed shader");
    // Another scene recovers from a failure too.
    renderer.update(labSettings("dunes"));
    fault = new Error("injected sim fault");
    frame((now += 16));
    check(renderer.failure?.stage === "frame", "The second fault was not reported");
    fault = undefined;
    renderer.update(labSettings("lake"));
    frame((now += 16));
    check(
      renderer.failure === undefined && drawn(),
      "Switching scene did not recover from a failure",
    );
    // A simulation that throws while starting.
    dunes.sim = () => {
      throw new Error("injected start fault");
    };
    renderer.update(labSettings("dunes"));
    check(frame((now += 16)), "No next frame was scheduled after a simulation failed to start");
    check(
      renderer.failure?.stage === "start",
      `Start fault not reported: ${JSON.stringify(renderer.failure)}`,
    );
    dunes.sim = standIn;
    renderer.retry();
    frame((now += 16));
    check(renderer.failure === undefined && drawn(), "Retry did not recover from a start fault");
    console.error = errorLog;
    result.recovery = { events: logged.length, built };

    // S8: per-program uniforms are sent when they change and only then.
    renderer.update(labSettings("lake"));
    frame((now += 16));
    const base = { ...sends };
    for (let i = 0; i < 4; i++) frame((now += 16));
    const steady = Object.fromEntries(
      Object.entries(sends).map(([name, count]) => [name, count - (base[name] ?? 0)]),
    );
    check(
      steady.uTime === 4 &&
        steady.uParams === 0 &&
        steady.uLevels === 0 &&
        steady.uDither === 0 &&
        steady.uTriggers === 0,
      `Unchanged state was sent again: ${JSON.stringify(steady)}`,
    );
    const knobs = paramDefaults("lake");
    // The ice's ripples: a plain uniform. (The hour would not do: it sets the World's daylight gate,
    // so a change can build another program.)
    const index = lake.params.findIndex((def) => def.kind === "range" && def.key === "ripples");
    const knob = lake.params[index];
    if (!knob) throw new Error("The lake has no ripples knob");
    const original = labSettings("lake", knobs).params[index];
    knobs[knob.key] = (knobs[knob.key] ?? 0) + 0.125;
    const changed = labSettings("lake", knobs);
    check(changed.params[index] !== original, "The knob change was a no-op");
    renderer.update(changed);
    frame((now += 16));
    // uParams packs four knobs a row (shaders/index.ts packParams).
    const row = uniform(`uParams[${index >> 2}]`) as Float32Array;
    check(
      sends.uParams === (base.uParams ?? 0) + 1 &&
        row[index & 3] === Math.fround(changed.params[index] ?? Number.NaN),
      "A changed knob did not reach the shader",
    );
    // A look change made while another program draws reaches this one when it draws again.
    renderer.update(labSettings("dunes", paramDefaults("dunes"), { levels: 5 }));
    frame((now += 16));
    renderer.update(labSettings("lake", knobs, { levels: 5 }));
    frame((now += 16));
    check(
      uniform("uLevels") === 5,
      "A look change made on another scene left this scene's program stale",
    );
    // A trigger's stamp reaches the shader as it moves (the lake reads its slots through sinceTrigger).
    renderer.trigger(0);
    for (let i = 0; i < 3; i++) frame((now += 100));
    const sinceTrigger = (uniform("uTime") as number) - (uniform("uTriggers[0]") as number);
    check(
      sinceTrigger > 0.25 && sinceTrigger < 0.35,
      `Shader trigger age ${sinceTrigger} s, not 0.3 s, under reduced motion`,
    );
    result.uniformSends = { steadyFrames: 4, steady };

    // Q2: main.ts reads `lab` inside `apply`, declared `const` after it; applying while the Lab is
    // being built would throw (temporal dead zone), so the Lab must not.
    let applied = 0;
    new Lab(document.createElement("aside"), document.createElement("button"), {
      current: () => ({
        state: defaultsFor("pond"),
        params: paramDefaults("pond"),
        planets: [],
        elements: [],
        camera: REST_POSE,
      }),
      apply: () => {
        applied++;
      },
      renderer: () => undefined,
      build: "",
    });
    check(applied === 0, "The Lab applied a setup while being built");
    result.labBuiltWithoutApply = true;
  } finally {
    console.error = errorLog;
    if (dunesSim !== undefined) dunes.sim = dunesSim;
    lake.glslFor = lakeGlslFor;
    frames.restore();
    canvas.remove();
  }
  return result;
}
