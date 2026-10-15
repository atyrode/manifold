import { constellationUniforms } from "./constellations.ts";
import { MAX_PARAMS, MAX_TRIGGERS } from "./params.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import type { PointerState, SceneSim } from "./scenes/types.ts";
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  vertexSource,
} from "./shaders/index.ts";
import type { Params } from "./state.ts";

export const ditherIds = ["bayer8", "bayer4", "ign", "none"] as const;
export type DitherId = (typeof ditherIds)[number];
export const colorIds = ["accent", "mono", "full"] as const;
export type ColorId = (typeof colorIds)[number];
/** Order is the shader's `uView` index. */
export const viewIds = ["dithered", "source", "split"] as const;
export type ViewId = (typeof viewIds)[number];

export interface RenderSettings {
  scene: SceneId;
  dither: DitherId;
  color: ColorId;
  /** CSS pixels per dither cell. */
  pixel: number;
  levels: number;
  motion: number;
  bg: string;
  ink: string;
  accent: string;
  /** The current scene's knobs as the shader reads them, in the scene's `params` order. */
  params: readonly number[];
  /** The current scene's raw knobs, keyed as in the URL, for its simulation. */
  knobs: Params;
  followPointer: boolean;
  view: ViewId;
  /** Scenes enter and leave with their own choreography and a dissolve, instead of cutting. */
  passage: boolean;
}

/** Texture units: `uSim0..uSim3`, one per sim slot, then `uLeaving`. */
const SIM_SLOTS = 4;
const LEAVING_UNIT = SIM_SLOTS;
/** Seconds over which the outgoing scene's last frame dissolves into the incoming scene. */
export const PASSAGE_DISSOLVE = 0.9;
/** Scene-clock time of a trigger or press that has not happened. */
const NEVER = -1e4;
/**
 * Programs kept per scene: those it entered with, one per compile-time feature set
 * (`SceneDef.featuresFor`), and its all-features program (`SceneDef.featuresAll`); past this many
 * the least recently drawn one is freed.
 */
const PROGRAMS_PER_SCENE = 4;
/** Presses on these belong to the lab or the page's own controls, not to the scene. */
const CONTROLS = "#lab, #lab-open, a, button, input, select, textarea, label, [role=switch]";
/** Renderer strings of software rasterisers: SwiftShader, Mesa's llvmpipe and softpipe, WARP. */
const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|softpipe|Basic Render Driver|software/i;

const uniformNames = [
  "uRes",
  "uTime",
  "uMotionTime",
  "uDither",
  "uColor",
  "uLevels",
  "uMotion",
  "uPointer",
  "uMouse",
  "uBg",
  "uInk",
  "uAccent",
  "uParams",
  "uView",
  "uConStars",
  "uConBright",
  "uConLines",
  "uConStarCount",
  "uConLineCount",
  "uConMarkStar",
  "uConMarkLine",
  "uProgress",
  "uTriggers",
  "uSim0",
  "uSim1",
  "uSim2",
  "uSim3",
  "uSimOn",
  "uWeather",
  "uPassage",
  "uDissolve",
  "uLeaving",
] as const;
type UniformName = (typeof uniformNames)[number];

/**
 * One scene's linked program for one feature set (`key`, see `featureKey`), where its uniforms live,
 * and what they hold. Uniforms keep their values per program, so a frame sends again only what
 * changed since this program last drew: `settings` is the settings object its look and knobs were
 * sent from (`update` installs a new object for every change, so identity is the version), then the
 * loading progress, the trigger stamps as the shader reads them, and which sim slots are bound (bit
 * per slot).
 */
interface SceneProgram {
  key: string;
  program: WebGLProgram;
  uniforms: Record<UniformName, WebGLUniformLocation | null>;
  sent: {
    settings: RenderSettings | undefined;
    progress: number;
    triggers: number[];
    simOn: number;
  };
}

/** A compile-time feature set and its key (`featureKey`). */
interface FeatureSet {
  features: Readonly<Record<string, number>>;
  key: string;
}

/**
 * A program compiling and linking. One built in the background is done once the driver says so
 * (KHR_parallel_shader_compile) or, without that extension, once `fence`, set after the link, has
 * signalled; until then nothing may ask about it, which would wait for the driver.
 */
interface Building {
  id: SceneId;
  key: string;
  program: WebGLProgram;
  fragment: WebGLShader;
  source: string;
  fence: WebGLSync | null;
}

/**
 * The feature set a settings object asks of its scene's program, and the scene's all-features set
 * (undefined for a scene without knob-keyed features).
 */
interface Wanted extends FeatureSet {
  settings: RenderSettings | undefined;
  all: FeatureSet | undefined;
}

/** Why the scene on screen is not drawing: the background shows instead and the frame loop goes on. */
export interface SceneFailure {
  scene: SceneId;
  /** build: its shader did not compile or link; start: its simulation threw while starting; frame: drawing it threw. */
  stage: "build" | "start" | "frame";
  /** The error's message (a build failure's carries the annotated info log). */
  message: string;
}

/**
 * The scene being drawn: the program it draws with (undefined when it failed to build; while the
 * all-features program for changed knobs builds, still the one on screen), its simulation, what
 * stopped it (see `DitherRenderer.failure`), and where its `rain` and `snow` knobs sit in `params`
 * (-1 when it has none, which reads as 0).
 */
interface ActiveScene {
  id: SceneId;
  program: SceneProgram | undefined;
  sim: SceneSim | undefined;
  failure: SceneFailure | undefined;
  rain: number;
  snow: number;
}

export class RendererError extends Error {}

/**
 * The info log with the offending source line under each `ERROR: 0:<line>:`, since the scene's
 * fragment source is generated and otherwise never seen.
 */
function annotate(log: string, source: string): string {
  const lines = source.split("\n");
  return log
    .split("\n")
    .map((entry) => {
      const line = /^ERROR: \d+:(\d+):/.exec(entry)?.[1];
      return line === undefined
        ? entry
        : `${entry}\n    > ${(lines[Number(line) - 1] ?? "").trim()}`;
    })
    .join("\n");
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  what: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new RendererError(`${what}: could not allocate shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new RendererError(`${what}: shader compile failed\n${annotate(log, source)}`);
  }
  return shader;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class DitherRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #canvas: HTMLCanvasElement;
  /** Shared by every scene's program. */
  readonly #vertex: WebGLShader;
  /** The vertex array every draw uses; bound again after a failed frame (see `#fail`). */
  readonly #vertexArray: WebGLVertexArrayObject;
  /**
   * Each scene's programs by feature key (`featureKey`), built on first use, or why one failed to
   * build (logged); oldest drawn first, at most PROGRAMS_PER_SCENE each.
   */
  readonly #programs = new Map<SceneId, Map<string, SceneProgram | SceneFailure>>();
  /** KHR_parallel_shader_compile, when the browser has it: programs then build off the main thread. */
  readonly #parallel: { readonly COMPLETION_STATUS_KHR: number } | null;
  /** The one program building in the background, if any. */
  #building: Building | undefined;
  /**
   * A scene's all-features program just built in the background that the scene does not draw with
   * yet: the next frame of that scene draws with it once (see `#draw`).
   */
  #warm: { id: SceneId; program: SceneProgram } | undefined;
  /** Knob changes are likely (see `expectChanges`). */
  #expecting = false;
  /**
   * The context renders in software: it runs every line of a program whatever branch a pixel
   * takes, and compiling the countryside's all-features program takes it some 20 s (its own
   * programs 2-5 s), so a knob change builds the setting's own program instead (`#programSoon`).
   */
  readonly #software: boolean;
  /** The feature set the latest settings ask for (see `#want`). */
  readonly #wanted: Wanted = { settings: undefined, features: {}, key: "", all: undefined };
  #scene: ActiveScene | undefined;
  /** Set by `retry`: the next frame enters the current scene afresh. */
  #rebuild = false;
  readonly #blank: WebGLTexture;
  /** Smoothed parallax (-1..1 over the window), eased toward the target `tx`, `ty`. */
  readonly #pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  /** The raw pointer for `uMouse` and simulations; mapped to stage uv once per frame. */
  readonly #mouse = {
    clientX: window.innerWidth / 2,
    clientY: window.innerHeight / 2,
    inside: false,
    down: false,
    /** Edges since the previous frame. */
    pressed: false,
    released: false,
    /** Interaction-clock time of the last press that started over the page. */
    pressedAt: NEVER,
  };
  #settings: RenderSettings;
  /** Scene clock in seconds; stands still while paused or frozen. Never reset: scenes share it. */
  #clock = 0;
  /**
   * Interaction clock: what a press or a "now" trigger is stamped with. It stands still only while
   * paused, so it is the scene clock unless frozen. Stamps reach the shader (`uMouse.w`,
   * `uTriggers`) and sims (`SimFrame.triggers`) moved back by how far this clock has run ahead of
   * the scene clock.
   *
   * Reduced-motion policy (frozen): what moves on its own holds still (the scene and motion clocks,
   * sim steps, weather approach, passages), and a discrete interaction plays its bounded response
   * and settles. A stamp lands as far behind the still scene clock as real time has run since, so
   * `t - uMouse.w` and `sinceTrigger` count real seconds: a press's fade or a trigger's event ends
   * instead of holding its first frame, and what is held only while the button is down ends at
   * release. Sims see the press and release edges and `fired` but no time (dt 0), so whatever they
   * do in response is one still step. Unfrozen, the two clocks are equal and stamps reach the
   * shader exactly as stamped.
   */
  #interactionClock = 0;
  /**
   * Motion clock (`uMotionTime`, `SimFrame.motionTime`): each scene-clock step times the motion
   * amount, summed on the same origin as `#clock`, so it equals `#clock * motion` while motion holds
   * still and moving the slider changes the pace without jumping the phase.
   */
  #motionClock = 0;
  #lastFrame = 0;
  #paused = false;
  /** Smoothed frames per second, for the lab footer. */
  fps = 0;
  /** Reduced motion: see `#interactionClock`. */
  readonly #frozen: boolean;
  readonly #params = new Float32Array(MAX_PARAMS);
  /** Interaction-clock time each trigger slot last fired; far in the past when idle. */
  readonly #triggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `uTriggers` and `SimFrame.triggers`: the stamps on the scene clock, rewritten in place each frame. */
  readonly #shownTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** Each slot's stamp as the current scene's sim last saw it, to find the next frame's presses. */
  readonly #seenTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `SimFrame.fired`, rewritten in place each frame. */
  readonly #fired: boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  /** The scene the triggers and the last press belong to: both reset when it changes. */
  #triggerScene = "";
  /** Loading-page progress 0..1, or -1 off the loading page. */
  #progress = -1;
  /** `uWeather`: how wet the world is and how much snow lies, 0..1 each, on the scene clock. */
  readonly #weather = { wet: 0, lying: 0 };
  /**
   * Scene passage, in real seconds (`requestAnimationFrame` time) so it plays whatever the motion:
   * while `#leaving` is set the outgoing scene keeps drawing with its own settings, playing its exit
   * (its `start` is NaN until the first frame stamps it); its last frame is then kept in
   * `#leavingFrame` and the next scene, built afresh (`#reenter`, even the same one replayed),
   * enters, dissolving out of that frame. `#arrival.start`: NaN on an entrance's first frame (see
   * `#draw`), -Infinity when arrived without one (a cut).
   */
  #leaving: { settings: RenderSettings; start: number } | undefined;
  readonly #arrival = { start: -Infinity, fromFrame: false };
  #reenter = false;
  readonly #leavingFrame: WebGLTexture;
  /** `SimFrame.passage` and `uPassage`, rewritten in place each frame. */
  readonly #passage = { enter: 1, exit: 0 };
  readonly #reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** WebGL version and renderer, for diagnosing remote reports. */
  glInfo = "";

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings, frozen: boolean) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new RendererError("WebGL2 unavailable");
    this.#gl = gl;
    this.#canvas = canvas;
    this.#settings = settings;
    this.#frozen = frozen;

    this.#vertex = compile(gl, gl.VERTEX_SHADER, vertexSource, "vertex");
    this.#vertexArray = gl.createVertexArray();
    gl.bindVertexArray(this.#vertexArray);
    this.#parallel = gl.getExtension("KHR_parallel_shader_compile");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu: unknown = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    this.glInfo = `${String(gl.getParameter(gl.VERSION))} · ${String(gpu)}`;
    this.#software = SOFTWARE_RENDERER.test(String(gpu));

    this.#blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#blank);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    // The outgoing scene's last frame, copied from the canvas when its exit ends.
    this.#leavingFrame = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#leavingFrame);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      1,
      1,
      0,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0]),
    );

    const mouse = this.#mouse;
    const track = (event: PointerEvent) => {
      mouse.clientX = event.clientX;
      mouse.clientY = event.clientY;
      mouse.inside = !(event.target instanceof Element) || event.target.closest(CONTROLS) === null;
    };
    const lift = () => {
      if (!mouse.down) return;
      mouse.down = false;
      mouse.released = true;
    };
    window.addEventListener("pointermove", (event) => {
      this.#pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.#pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
      track(event);
    });
    window.addEventListener("pointerdown", (event) => {
      track(event);
      // Only presses that start over the page count: the lab and page controls keep theirs.
      if (!event.isPrimary || event.button !== 0 || !mouse.inside) return;
      mouse.down = true;
      mouse.pressed = true;
      mouse.pressedAt = this.#interactionClock;
    });
    window.addEventListener("pointerup", (event) => {
      if (event.isPrimary && event.button === 0) lift();
    });
    window.addEventListener("pointercancel", (event) => {
      if (event.isPrimary) lift();
    });
    // Leaving the window (no related target) leaves the page too.
    window.addEventListener("pointerout", (event) => {
      if (event.relatedTarget === null) mouse.inside = false;
    });
  }

  /** Fire one occurrence of the current scene's occasional effect in `slot` right now. */
  trigger(slot: number): void {
    if (slot >= 0 && slot < MAX_TRIGGERS) this.#triggers[slot] = this.#interactionClock;
  }

  get paused(): boolean {
    return this.#paused;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  setProgress(progress: number): void {
    this.#progress = progress;
  }

  /**
   * Whether knob changes are likely (the lab is open). A scene with knob-keyed features then builds
   * its all-features program in the background once it has arrived, so the first change that needs
   * it switches at once instead of waiting for a build; the plain page never builds it, and nor does
   * a software rasteriser (`#software`).
   */
  expectChanges(expect: boolean): void {
    this.#expecting = expect;
  }

  /** Play the current scene's exit, then its entrance with a fresh simulation, even with passages off. */
  replayPassage(): void {
    if (this.#scene === undefined || this.#leaving !== undefined || this.#frozen) return;
    this.#leaving = { settings: this.#settings, start: Number.NaN };
  }

  /**
   * Draw with `settings` from the next frame. Pass a new object for every change: a program sends
   * its look and knobs again only when the object differs from the one it last drew with.
   */
  update(settings: RenderSettings): void {
    const previous = this.#settings;
    this.#settings = settings;
    // A new scene: the one on screen leaves first, with the settings it was drawn with. A switch
    // while it is already leaving only changes where it goes.
    if (
      settings.scene !== previous.scene &&
      this.#scene !== undefined &&
      this.#leaving === undefined &&
      this.#passing(settings)
    ) {
      this.#leaving = { settings: previous, start: Number.NaN };
    }
    if (settings.scene !== this.#triggerScene) {
      this.#triggerScene = settings.scene;
      this.#triggers.fill(NEVER);
      this.#mouse.pressedAt = NEVER;
    }
  }

  /** Whether scenes pass in and out at all: off when asked, frozen, still, or under reduced motion. */
  #passing(settings: RenderSettings): boolean {
    return settings.passage && !this.#frozen && settings.motion > 0 && !this.#reducedMotion.matches;
  }

  start(): void {
    const tick = (now: number) => {
      // Asked for first, so a frame that throws cannot end the loop.
      requestAnimationFrame(tick);
      try {
        this.#draw(now);
      } catch (error: unknown) {
        const scene = this.#scene;
        if (scene !== undefined && scene.failure === undefined) this.#fail(scene, "frame", error);
        else console.error("evt=landing.renderer.frame_failed", error);
      }
    };
    requestAnimationFrame(tick);
  }

  /** Why the scene on screen is not drawing (the background shows instead), or undefined while it draws. */
  get failure(): SceneFailure | undefined {
    return this.#scene?.failure;
  }

  /** After a failure, enter the scene again from scratch on the next frame (a cut), rebuilding its program if that failed. */
  retry(): void {
    const failure = this.#scene?.failure;
    if (failure === undefined) return;
    if (failure.stage === "build") {
      const kept = this.#programs.get(failure.scene);
      for (const [key, entry] of kept ?? []) if ("stage" in entry) kept?.delete(key);
    }
    this.#rebuild = true;
  }

  /**
   * The compile-time features `s` asks of its scene's program (see `sceneFeatures`) and the scene's
   * all-features set (`sceneFeaturesAll`), worked out once per settings object.
   */
  #want(s: RenderSettings): Wanted {
    const wanted = this.#wanted;
    if (wanted.settings !== s) {
      const def = sceneDefs[s.scene];
      const values =
        def.featuresFor === undefined
          ? undefined
          : Object.fromEntries(def.params.map((knob, index) => [knob.key, s.params[index] ?? 0]));
      wanted.features = sceneFeatures(def, values);
      wanted.key = featureKey(wanted.features);
      const all = sceneFeaturesAll(def);
      wanted.all = all === undefined ? undefined : { features: all, key: featureKey(all) };
      wanted.settings = s;
    }
    return wanted;
  }

  /**
   * Start building `id`'s program with a feature set: compile and link, without waiting for either.
   * A build `ahead` (in the background) gets a fence after the link where the browser lacks
   * KHR_parallel_shader_compile, to learn without waiting when the driver is done.
   */
  #build(id: SceneId, set: FeatureSet, ahead: boolean): Building | SceneFailure {
    const gl = this.#gl;
    const source = fragmentSourceFor(sceneDefs[id], set.features);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragment)
      return this.#failed(id, set.key, new RendererError(`scene ${id}: could not allocate shader`));
    gl.shaderSource(fragment, source);
    gl.compileShader(fragment);
    const program = gl.createProgram();
    gl.attachShader(program, this.#vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    const fence =
      ahead && this.#parallel === null ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    if (ahead) gl.flush();
    return { id, key: set.key, program, fragment, source, fence };
  }

  /**
   * A built program, its constant uniforms set (waits for the driver unless the build is done);
   * throws RendererError (with the info log) on failure.
   */
  #link(building: Building): SceneProgram {
    const gl = this.#gl;
    const { id, program, fragment } = building;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const compiled = gl.getShaderParameter(fragment, gl.COMPILE_STATUS) === true;
      const log = (compiled ? gl.getProgramInfoLog(program) : gl.getShaderInfoLog(fragment)) ?? "";
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
      throw new RendererError(
        compiled
          ? `scene ${id}: program link failed\n${log}`
          : `scene ${id}: shader compile failed\n${annotate(log, building.source)}`,
      );
    }
    // Only flagged while attached: freed together with the program.
    gl.deleteShader(fragment);
    gl.useProgram(program);
    const uniforms = Object.fromEntries(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>;
    // Constant for the program's lifetime: the constellation figures (only orbit reads them; the
    // other programs drop the uniforms) and the texture unit of every sampler.
    const figures = constellationUniforms;
    gl.uniform4fv(uniforms.uConStars, figures.stars);
    gl.uniform1fv(uniforms.uConBright, figures.brightness);
    gl.uniform2fv(uniforms.uConLines, figures.lines);
    gl.uniform1i(uniforms.uConStarCount, figures.starCount);
    gl.uniform1i(uniforms.uConLineCount, figures.lineCount);
    gl.uniform1i(uniforms.uConMarkStar, figures.markStar);
    gl.uniform1i(uniforms.uConMarkLine, figures.markLine);
    [uniforms.uSim0, uniforms.uSim1, uniforms.uSim2, uniforms.uSim3].forEach((location, slot) =>
      gl.uniform1i(location, slot),
    );
    gl.uniform1i(uniforms.uLeaving, LEAVING_UNIT);
    // Nothing sent yet: NaN and -1 differ from every value the first frame sends.
    const triggers = Array.from({ length: MAX_TRIGGERS }, () => Number.NaN);
    return {
      key: building.key,
      program,
      uniforms,
      sent: { settings: undefined, progress: Number.NaN, triggers, simOn: -1 },
    };
  }

  /** Finish a build and keep what came of it: the program, or why it failed to build. */
  #finish(building: Building | SceneFailure): SceneProgram | SceneFailure {
    if ("stage" in building) return building;
    if (building.fence !== null) this.#gl.deleteSync(building.fence);
    try {
      const built = this.#link(building);
      this.#keep(building.id, building.key, built);
      return built;
    } catch (error: unknown) {
      return this.#failed(building.id, building.key, error);
    }
  }

  /** Log and keep why a scene's program failed to build. */
  #failed(id: SceneId, key: string, error: unknown): SceneFailure {
    console.error(`evt=landing.renderer.scene_failed scene=${id} stage=build`, error);
    const failure: SceneFailure = {
      scene: id,
      stage: "build",
      message: error instanceof Error ? error.message : String(error),
    };
    this.#keep(id, key, failure);
    return failure;
  }

  /**
   * Keep a scene's program (or failure) under its feature key as the most recently drawn, freeing the
   * least recently drawn past PROGRAMS_PER_SCENE (never the one on screen).
   */
  #keep(id: SceneId, key: string, built: SceneProgram | SceneFailure): void {
    let kept = this.#programs.get(id);
    if (kept === undefined) {
      kept = new Map();
      this.#programs.set(id, kept);
    }
    kept.delete(key);
    kept.set(key, built);
    const drawing = this.#scene?.program;
    for (const [old, entry] of kept) {
      if (kept.size <= PROGRAMS_PER_SCENE) break;
      if (entry === drawing) continue;
      kept.delete(old);
      if ("program" in entry) this.#gl.deleteProgram(entry.program);
    }
  }

  /** A kept program (or failure) for `id` under `key`, marked as the most recently drawn. */
  #kept(id: SceneId, key: string): SceneProgram | SceneFailure | undefined {
    const entry = this.#programs.get(id)?.get(key);
    if (entry !== undefined) this.#keep(id, key, entry);
    return entry;
  }

  /** A kept program (or failure) that draws `wanted`: its own set's, else the all-features one. */
  #keptFor(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure | undefined {
    return (
      this.#kept(id, wanted.key) ??
      (wanted.all === undefined ? undefined : this.#kept(id, wanted.all.key))
    );
  }

  /**
   * Keep the background build once the driver has finished it, asked without waiting (the
   * completion status, or the fence after the link). A scene's all-features program then draws
   * one frame of it at once (`#warm`).
   */
  #settle(): void {
    const building = this.#building;
    if (building === undefined) return;
    const gl = this.#gl;
    const done =
      this.#parallel !== null
        ? gl.getProgramParameter(building.program, this.#parallel.COMPLETION_STATUS_KHR) === true
        : building.fence === null ||
          gl.getSyncParameter(building.fence, gl.SYNC_STATUS) === gl.SIGNALED;
    if (!done) return;
    this.#building = undefined;
    const built = this.#finish(building);
    const all = sceneFeaturesAll(sceneDefs[building.id]);
    if ("program" in built && all !== undefined && featureKey(all) === building.key)
      this.#warm = { id: building.id, program: built };
  }

  /**
   * `id`'s program (or failure) for the wanted features, on entering the scene: the set's own or
   * the all-features one if kept, else the set's own built now (finishing a background build of
   * either if that is the one).
   */
  #programNow(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure {
    const kept = this.#keptFor(id, wanted);
    if (kept !== undefined) return kept;
    const building = this.#building;
    if (
      building !== undefined &&
      building.id === id &&
      (building.key === wanted.key || building.key === wanted.all?.key)
    ) {
      this.#building = undefined;
      return this.#finish(building);
    }
    return this.#finish(this.#build(id, wanted, false));
  }

  /**
   * The same for a knob change, never waiting: undefined while a program for it builds in the
   * background, started here if need be. That is the scene's all-features program, so a change
   * never builds one for its own set, except on a software rasteriser (`#software`), where it is
   * the set's own. One build at a time: one started for another set or scene finishes first.
   */
  #programSoon(id: SceneId, wanted: Wanted): SceneProgram | SceneFailure | undefined {
    return (
      this.#keptFor(id, wanted) ??
      this.#buildAhead(id, this.#software ? wanted : (wanted.all ?? wanted))
    );
  }

  /** Start building `id`'s program for `set` in the background unless a build is under way. */
  #buildAhead(id: SceneId, set: FeatureSet): SceneFailure | undefined {
    if (this.#building !== undefined) return undefined;
    const started = this.#build(id, set, true);
    if ("stage" in started) return started;
    this.#building = started;
    return undefined;
  }

  /**
   * Leave the current scene (disposing its simulation) and enter the one `s` sets, with the program
   * for its features (built now if need be). A program that fails to build or a simulation that
   * throws while starting leaves the scene entered but failed (see `failure`).
   */
  #enter(s: RenderSettings): ActiveScene {
    this.#release(this.#scene);
    const id = s.scene;
    const built = this.#programNow(id, this.#want(s));
    const params = sceneDefs[id].params;
    const scene: ActiveScene = {
      id,
      program: "program" in built ? built : undefined,
      sim: undefined,
      failure: "stage" in built ? built : undefined,
      rain: params.findIndex((def) => def.key === "rain"),
      snow: params.findIndex((def) => def.key === "snow"),
    };
    this.#scene = scene;
    if (scene.program !== undefined) {
      try {
        scene.sim = sceneDefs[id].sim?.(this.#gl);
      } catch (error: unknown) {
        this.#fail(scene, "start", error);
      }
    }
    return scene;
  }

  /**
   * Stop drawing `scene` after its simulation (or its frame) threw: log it, release the simulation
   * and put back the GL state a half-run sim may have left (framebuffer, blending, vertex array), so
   * the loop goes on drawing the background until `retry` or another scene.
   */
  #fail(scene: ActiveScene, stage: "start" | "frame", error: unknown): void {
    console.error(`evt=landing.renderer.scene_failed scene=${scene.id} stage=${stage}`, error);
    scene.failure = {
      scene: scene.id,
      stage,
      message: error instanceof Error ? error.message : String(error),
    };
    this.#release(scene);
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.#vertexArray);
  }

  /** Dispose `scene`'s simulation, once; a dispose that throws is logged, not passed on. */
  #release(scene: ActiveScene | undefined): void {
    const sim = scene?.sim;
    if (scene === undefined || sim === undefined) return;
    scene.sim = undefined;
    try {
      sim.dispose();
    } catch (error: unknown) {
      console.error(`evt=landing.renderer.sim_dispose_failed scene=${scene.id}`, error);
    }
  }

  /** The pointer in stage uv for this frame; consumes the press and release edges. */
  #pointerState(): PointerState {
    const mouse = this.#mouse;
    const rect = this.#canvas.getBoundingClientRect();
    const state: PointerState = {
      x: (mouse.clientX - rect.left) / Math.max(rect.width, 1),
      y: 1 - (mouse.clientY - rect.top) / Math.max(rect.height, 1),
      inside: mouse.inside,
      down: mouse.down,
      pressed: mouse.pressed,
      released: mouse.released,
    };
    mouse.pressed = false;
    mouse.released = false;
    return state;
  }

  #draw(now: number): void {
    const gl = this.#gl;
    const elapsed = this.#lastFrame === 0 ? 0 : (now - this.#lastFrame) / 1000;
    const dt = Math.min(elapsed, 0.1);
    this.#lastFrame = now;
    // Cap simulation catch-up, not the footer's measurement of actual frame delivery.
    if (elapsed > 0)
      this.fps = this.fps === 0 ? 1 / elapsed : this.fps * 0.92 + (1 / elapsed) * 0.08;
    // The interaction clock stands still only while paused; the scene clock also while frozen.
    const live = this.#paused ? 0 : dt;
    const step = this.#frozen ? 0 : live;
    const seconds = now / 1000;
    const leaving = this.#leaving;
    if (leaving !== undefined && Number.isNaN(leaving.start)) leaving.start = seconds;
    // A leaving scene draws as it was set when it began to leave.
    let s = leaving?.settings ?? this.#settings;
    const motion = this.#frozen ? 0 : s.motion;
    this.#clock += step;
    this.#interactionClock += live;
    this.#motionClock += step * motion;
    const width = Math.max(1, Math.ceil(this.#canvas.clientWidth / s.pixel));
    const height = Math.max(1, Math.ceil(this.#canvas.clientHeight / s.pixel));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }

    const p = this.#pointer;
    const tx = s.followPointer ? p.tx : 0;
    const ty = s.followPointer ? p.ty : 0;
    p.x += (tx - p.x) * 0.04;
    p.y += (ty - p.y) * 0.04;
    const pointer = this.#pointerState();

    const current = this.#scene;
    const scene =
      current && current.id === s.scene && !this.#reenter && !this.#rebuild
        ? current
        : this.#enter(s);
    const entered = scene !== current;
    const arrival = this.#arrival;
    if (entered) {
      // After a passage it dissolves out of the kept frame; on the page's first frame out of the bare
      // page; after a cut it is simply there. A passing entrance's clock starts on its second frame:
      // the first one compiles the program on the GPU (drivers do it at the first draw), which can take
      // longer than the whole dissolve, so it is shown as the dissolve's start, the old frame.
      const passed = this.#reenter;
      arrival.start =
        passed || (current === undefined && this.#passing(s)) ? Number.NaN : -Infinity;
      arrival.fromFrame = passed;
      this.#reenter = false;
      this.#rebuild = false;
    } else if (Number.isNaN(arrival.start)) {
      arrival.start = seconds;
    }
    const choreography = sceneDefs[scene.id].passage;
    const since = Number.isNaN(arrival.start) ? 0 : Math.max(0, seconds - arrival.start);
    const passage = this.#passage;
    passage.enter = Math.min(1, since / Math.max(choreography?.enter ?? PASSAGE_DISSOLVE, 1e-3));
    passage.exit =
      leaving === undefined
        ? 0
        : (choreography?.exit ?? 0) <= 0
          ? 1
          : Math.min(1, (seconds - leaving.start) / (choreography?.exit ?? 1));
    const dissolve = Math.max(0, 1 - since / PASSAGE_DISSOLVE);
    // Knobs that change the program's compile-time features (SceneDef.featuresFor): the scene draws
    // the new setting with a program it entered with for exactly that set, else with its
    // all-features program (SceneDef.featuresAll), built once in the background and never waited
    // for; a change never builds a program of its own (but on a software rasteriser, see
    // `#software`). Until the program is built the one on screen goes on drawing the settings it
    // drew last (the old frame, moving on); one that fails to build stops the scene as entering it
    // would. With changes expected (`expectChanges`) the all-features program is built ahead,
    // once the scene has arrived.
    this.#settle();
    if (scene.program !== undefined && scene.failure === undefined) {
      const wanted = this.#want(s);
      const next =
        scene.program.key === wanted.key ? scene.program : this.#programSoon(scene.id, wanted);
      if (next === undefined) {
        s = scene.program.sent.settings ?? s;
      } else if ("stage" in next) {
        scene.failure = next;
        this.#release(scene);
      } else {
        scene.program = next;
        const all = wanted.all;
        if (
          this.#expecting &&
          !this.#software &&
          all !== undefined &&
          leaving === undefined &&
          passage.enter >= 1 &&
          this.#programs.get(scene.id)?.has(all.key) !== true
        )
          this.#buildAhead(scene.id, all);
      }
    }
    const chosen = scene.program;
    if (chosen === undefined || scene.failure !== undefined) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(...rgb(s.bg), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (leaving !== undefined) this.#left(width, height);
      return;
    }
    // A program just built in the background draws this one frame in the chosen one's place (the
    // same picture), so a driver that compiles a program at its first draw does it now rather than
    // when a change needs it.
    const warm = this.#warm;
    this.#warm = undefined;
    const program = warm !== undefined && warm.id === scene.id ? warm.program : chosen;
    // The world follows the scene's own rain and snow on the scene clock: where they lead (soaked in
    // steady rain, damp in drizzle; snow lying deeper the harder it snows, less in rain), approached
    // exponentially. Wetting takes 1.2 / rain s per e-fold (~9 s to soak in steady rain), drying 25 s
    // (~75 s); settling 3 / snow s (~18 s in steady snow), melting 30 s (~90 s), faster in rain.
    // A scene just entered, or a frozen frame, starts where its weather leads.
    const weather = this.#weather;
    const rain = s.params[scene.rain] ?? 0;
    const snow = s.params[scene.snow] ?? 0;
    const wetTo = rain > 0 ? Math.min(1, 0.4 + 1.1 * rain) : 0;
    const lyingTo = snow > 0 ? Math.min(1, 0.25 + snow) * (1 - 0.5 * rain) : 0;
    if (entered || this.#frozen) {
      weather.wet = wetTo;
      weather.lying = lyingTo;
    } else {
      weather.wet =
        wetTo + (weather.wet - wetTo) * Math.exp(-step / (weather.wet < wetTo ? 1.2 / rain : 25));
      weather.lying =
        lyingTo +
        (weather.lying - lyingTo) *
          Math.exp(-step / (weather.lying < lyingTo ? 3 / snow : 30 / (1 + 4 * rain)));
    }
    // A slot fired when its stamp moved to a real press since the sim's previous frame. A scene just
    // entered has a fresh sim with nothing to compare against: its first frame reports no presses
    // (stamps were reset to idle when the scene changed, so an earlier visit's never replay).
    // Stamps reach the shader and sims on the scene clock (`#interactionClock`); `lag` is 0 unfrozen.
    const lag = this.#interactionClock - this.#clock;
    const shown = this.#shownTriggers;
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      const stamp = this.#triggers[slot] ?? NEVER;
      this.#fired[slot] = !entered && stamp > NEVER && stamp !== this.#seenTriggers[slot];
      this.#seenTriggers[slot] = stamp;
      shown[slot] = stamp > NEVER ? stamp - lag : NEVER;
    }
    const pressedAt = this.#mouse.pressedAt > NEVER ? this.#mouse.pressedAt - lag : NEVER;
    // Simulations upload (and so bind) their textures: step them before binding this frame's units.
    const simTextures =
      scene.sim?.frame({
        dt: step,
        time: this.#clock,
        motionTime: this.#motionClock,
        motion,
        width,
        height,
        aspect: width / height,
        values: s.params,
        params: s.knobs,
        triggers: shown,
        fired: this.#fired,
        pointer,
        parallax: p,
        passage,
      }) ?? [];

    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    for (let slot = 0; slot < SIM_SLOTS; slot++) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, simTextures[slot] ?? this.#blank);
    }
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.#leavingFrame);

    const u = program.uniforms;
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uTime, this.#clock);
    gl.uniform1f(u.uMotionTime, this.#motionClock);
    gl.uniform2f(u.uPointer, p.x, p.y);
    gl.uniform4f(u.uMouse, pointer.x, pointer.y, pointer.down ? 1 : 0, pressedAt);
    gl.uniform2f(u.uWeather, weather.wet, weather.lying);
    gl.uniform2f(u.uPassage, passage.enter, passage.exit);
    gl.uniform2f(u.uDissolve, dissolve, arrival.fromFrame ? 1 : 0);
    // The rest only when it changed since this program last drew (see SceneProgram).
    const sent = program.sent;
    if (sent.settings !== s) {
      sent.settings = s;
      const params = this.#params;
      for (let i = 0; i < MAX_PARAMS; i++) params[i] = s.params[i] ?? 0;
      gl.uniform1i(u.uDither, ditherIds.indexOf(s.dither));
      gl.uniform1i(u.uColor, colorIds.indexOf(s.color));
      gl.uniform1f(u.uLevels, s.levels);
      gl.uniform1f(u.uMotion, motion);
      gl.uniform3f(u.uBg, ...rgb(s.bg));
      gl.uniform3f(u.uInk, ...rgb(s.ink));
      gl.uniform3f(u.uAccent, ...rgb(s.accent));
      gl.uniform1fv(u.uParams, params);
      gl.uniform1i(u.uView, viewIds.indexOf(s.view));
    }
    if (sent.progress !== this.#progress) {
      sent.progress = this.#progress;
      gl.uniform1f(u.uProgress, this.#progress);
    }
    let triggersChanged = false;
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      if (sent.triggers[slot] === shown[slot]) continue;
      sent.triggers[slot] = shown[slot] ?? NEVER;
      triggersChanged = true;
    }
    if (triggersChanged) gl.uniform1fv(u.uTriggers, shown);
    const simOn =
      (simTextures[0] ? 1 : 0) |
      (simTextures[1] ? 2 : 0) |
      (simTextures[2] ? 4 : 0) |
      (simTextures[3] ? 8 : 0);
    if (sent.simOn !== simOn) {
      sent.simOn = simOn;
      gl.uniform4f(u.uSimOn, simOn & 1, (simOn >> 1) & 1, (simOn >> 2) & 1, (simOn >> 3) & 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (leaving !== undefined && passage.exit >= 1) this.#left(width, height);
  }

  /** The exit has played: keep its last frame to dissolve out of, and enter the scene now set. */
  #left(width: number, height: number): void {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.#leavingFrame);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, width, height, 0);
    this.#leaving = undefined;
    this.#reenter = true;
  }
}
