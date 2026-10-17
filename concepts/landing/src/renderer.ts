import {
  climateCold,
  climateLying,
  fallingRain,
  fallingSnow,
  hasClimate,
  seasonKnob,
  yearAt,
  yearCycleKnob,
  yearNow,
} from "./climate.ts";
import type { SeasonKnob } from "./climate.ts";
import { StageBox, type Cells } from "./display.ts";
import {
  FrameGovernor,
  POINTER_SECONDS,
  RESPONSE_SECONDS,
  SETTLE_SECONDS,
  type Picture,
} from "./governor.ts";
import { MAX_PARAMS, MAX_TRIGGERS } from "./params.ts";
import {
  annotate,
  LEAVING_UNIT,
  ScenePrograms,
  SIM_SLOTS,
  type ProgramContext,
  type SceneProgram,
} from "./program-cache.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import type { PlanetUniforms } from "./scenes/planets.ts";
import type { PointerState, SceneSim } from "./scenes/types.ts";
import { vertexSource } from "./shaders/index.ts";
import { forgetSheets } from "./scenes/pond/sheet.ts";
import type { Params } from "./state.ts";

export const ditherIds = ["bayer8", "bayer4", "ign", "none"] as const;
export type DitherId = (typeof ditherIds)[number];
export const colorIds = ["accent", "mono", "full"] as const;
export type ColorId = (typeof colorIds)[number];
/** Order is the shader's `uView` index. */
export const viewIds = ["dithered", "source", "split"] as const;
export type ViewId = (typeof viewIds)[number];
/**
 * How the incoming scene takes the screen over from the outgoing one, cell by cell (the order is the
 * shader's `uDissolve.z`): the middle first, an even ordered-dither fade, a sweep from the left, or
 * coarse grain.
 */
export const blendIds = ["bloom", "fade", "sweep", "grain"] as const;
export type BlendId = (typeof blendIds)[number];

export interface RenderSettings {
  scene: SceneId;
  dither: DitherId;
  color: ColorId;
  /**
   * CSS pixels per dither cell, about: snapped to whole device pixels, and coarser past the cell
   * budget (src/display.ts).
   */
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
  /** The current scene's planets as skyGiant takes them (none for a scene without). */
  planets: PlanetUniforms;
  followPointer: boolean;
  view: ViewId;
  /** Scenes enter and leave with their own choreography and a dissolve, instead of cutting. */
  passage: boolean;
  /**
   * 0..1: how much of the outgoing scene's exit the incoming scene's entrance overlaps. 0 enters once
   * the exit has played; 1 enters as it begins. Both scenes draw while they overlap.
   */
  overlap: number;
  /** Seconds over which the incoming scene takes the screen over from the outgoing one. */
  weave: number;
  blend: BlendId;
  /** Passages play this many times slower than real time (1 = real time), to study them. */
  slowmo: number;
}

/** Passage-clock seconds a passage waits at most for the incoming sim to be ready (SceneSim.ready). */
const READY_WAIT = 3;
/** Scene-clock time of a trigger or press that has not happened. */
const NEVER = -1e4;
/**
 * Milliseconds a sim may block on budgeted work in a frame (SimFrame.budget): a share of the time
 * between frames, so a slow renderer (a software one draws a frame in a second) builds as fast in
 * frames as a fast one does in time, between a floor that keeps a fast page smooth and a cap that
 * keeps a slow one responsive.
 */
const SIM_BUDGET = { share: 0.25, least: 8, most: 120 } as const;
/** Parallax (-1..1 over the window) left to ease toward the pointer that still moves a frame. */
const EASED = 1e-3;
/** Share of the way left the parallax eases toward the pointer in a 60th of a second. */
const PARALLAX_EASE = 0.04;
/** Presses on these belong to the lab or the page's own controls, not to the scene. */
const CONTROLS = "#lab, #lab-open, a, button, input, select, textarea, label, [role=switch]";
/** Renderer strings of software rasterisers: SwiftShader, Mesa's llvmpipe and softpipe, WARP. */
const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|softpipe|Basic Render Driver|software/i;

/** Why the scene on screen is not drawing: the background shows instead and the frame loop goes on. */
export interface SceneFailure {
  scene: SceneId;
  /** build: its shader did not compile or link; start: its simulation threw while starting; frame: drawing it threw. */
  stage: "build" | "start" | "frame";
  /** The error's message (a build failure's carries the annotated info log). */
  message: string;
}

/**
 * A scene being drawn: the program it draws with (undefined when it failed to build; while the
 * all-features program for changed knobs builds, still the one on screen), its simulation, what
 * stopped it (see `DitherRenderer.failure`), where its `rain` and `snow` knobs sit in `params`
 * (-1 when it has none, which reads as 0), its season knob and where it sits when the season sets
 * its climate (src/climate.ts: it keeps a season and can snow), its `uWeather` (how wet its world is
 * and how much snow lies, 0..1 each, on the scene clock), its `SimFrame.passage` and `uPassage`,
 * rewritten in place each frame, and where its clocks count from.
 */
interface ActiveScene {
  id: SceneId;
  program: SceneProgram | undefined;
  sim: SceneSim | undefined;
  failure: SceneFailure | undefined;
  rain: number;
  snow: number;
  season: { def: SeasonKnob; at: number; cycle: number } | undefined;
  readonly weather: { wet: number; lying: number };
  readonly passage: { enter: number; exit: number };
  /**
   * The renderer's scene, motion and fall clocks when it was created (or, taking over the clocks
   * of the scene it replaced, that one's: see `DitherRenderer.update`): what it sees of them, and
   * so the float32 `uTime`, `uMotionTime` and `uFallTime`, counts from its own start, and stays
   * small however long the page has been open.
   */
  readonly origin: { readonly clock: number; readonly motion: number; readonly fall: number };
}

/**
 * A scene on its way out. It first idles on while the incoming scene is made ready (`start` NaN:
 * its program built and drawn once, see `#prime`), then stays on screen playing its exit with the
 * settings it was drawn with when it began to leave; once the incoming scene has entered (`woven`)
 * it goes on drawing off screen, into the frame the incoming one dissolves out of, until that has
 * taken the screen over. `woven.into`: the settings the incoming scene entered with.
 */
interface Leaving {
  settings: RenderSettings;
  /** Passage-clock time its exit began: NaN until the incoming scene is ready. */
  start: number;
  /** Seconds its exit takes: its own length, drawn out if need be to last until the blend is done. */
  length: number;
  /** The incoming program once drawn (see `#prime`). */
  primed: SceneProgram | undefined;
  /**
   * The incoming scene, created once its program is ready and run off screen while the exit plays
   * (its sim stepping, one cell drawn), so it enters already running: a sim that builds its world
   * over several frames has it ready rather than popping it in during the entrance.
   */
  next: ActiveScene | undefined;
  /** Passage-clock time `next` was created. */
  ahead: number;
  woven: { scene: ActiveScene; into: RenderSettings } | undefined;
}

/** One scene's draw this frame: what differs between the scene on screen and the one leaving. */
interface SceneDraw {
  /** null: the canvas. */
  target: WebGLFramebuffer | null;
  width: number;
  height: number;
  /** Entered this frame: its weather starts where it leads and it reports no presses. */
  fresh: boolean;
  /** Each slot's stamp on the scene's own clock (`uTriggers`). */
  triggers: readonly number[];
  /** The same presses' stamps on the scene's own motion clock (`uMotionTriggers`). */
  motionTriggers: readonly number[];
  fired: readonly boolean[];
  pressedAt: number;
  /** Draw one cell only: a scene run off screen before it enters (see `Leaving.next`). */
  oneCell: boolean;
  /** `uDissolve.x`: share of the outgoing frame still showing. */
  dissolve: number;
  /**
   * The outgoing frame it dissolves out of (`uLeaving`, `uDissolve.y` 1): the leaving scene's, or
   * the poster's (`DitherRenderer.setPoster`); undefined for the bare page (`uBg`).
   */
  from: WebGLTexture | undefined;
  blend: BlendId;
}

export class RendererError extends Error {}

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

/**
 * A texture for a whole frame, made and bound on the active unit: a texel a cell, nearest, clamped
 * (the leaving scene's frame, the poster).
 */
function frameTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * What the context holds for every scene's program, made at start and again once a lost context
 * is restored: what programs are built with (`ProgramContext`: the vertex shader they share,
 * KHR_parallel_shader_compile when the browser has it, whether the context renders in software),
 * the vertex array every draw uses (bound again after a failed frame, see `#fail`), a black texel
 * for unbound sim slots, the frame the leaving scene draws into while the incoming one dissolves
 * out of it and its framebuffer (sized in `#draw`), and the WebGL version and renderer, for
 * diagnosing remote reports.
 */
interface GlResources extends ProgramContext {
  vertexArray: WebGLVertexArrayObject;
  blank: WebGLTexture;
  leavingFrame: WebGLTexture;
  leavingTarget: WebGLFramebuffer;
  info: string;
}

function glResources(gl: WebGL2RenderingContext): GlResources {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource, "vertex");
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu: unknown = debug
    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);

  const blank = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, blank);
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
  const leavingFrame = frameTexture(gl);
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
  const leavingTarget = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, leavingTarget);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, leavingFrame, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    vertex,
    vertexArray,
    blank,
    leavingFrame,
    leavingTarget,
    parallel,
    software: SOFTWARE_RENDERER.test(String(gpu)),
    info: `${String(gl.getParameter(gl.VERSION))} · ${String(gpu)}`,
  };
}

export class DitherRenderer {
  readonly #gl: WebGL2RenderingContext;
  /** The canvas's box in device pixels and the cells laid over it (src/display.ts). */
  readonly #stage: StageBox;
  /**
   * Frames on every n-th refresh, at the full rate or at rest, and none while the picture stands
   * still (see `start`).
   */
  readonly #governor = new FrameGovernor();
  /** What the context holds for every program: made again once a lost context is restored. */
  #gpu: GlResources;
  /**
   * Each scene's programs, built in the background on first use and kept (src/program-cache.ts),
   * never one that draws or is about to (`#draws`).
   */
  readonly #programs: ScenePrograms;
  /** Knob changes are likely (see `expectChanges`). */
  #expecting = false;
  /** The settings the scene on screen last drew with: what it leaves with when the setup moves on. */
  #drawn: RenderSettings | undefined;
  #scene: ActiveScene | undefined;
  /** The scene whose frame is being drawn, for a frame that throws to stop (see `start`). */
  #drawing: ActiveScene | undefined;
  /** Set by `retry`: the next frame enters the current scene afresh. */
  #rebuild = false;
  /**
   * The scene the setup asks for is not on screen yet for want of its program, which builds in the
   * background meanwhile: the page's first frames, a cut, a retry, a restored context (`#draw`).
   */
  #waiting = false;
  /** The last frame moved something, or something was on its way (see `#still`). */
  #moving = false;
  /** The last frame played an entrance: the scene on screen still coming in, or dissolving. */
  #entering = false;
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
  /**
   * Scene clock in seconds; stands still while paused or frozen. Never reset: each scene counts it
   * from its own start (`ActiveScene.origin`), as it does the motion and fall clocks.
   */
  #clock = 0;
  /**
   * Interaction clock: what a press or a "now" trigger is stamped with. It stands still only while
   * paused, so it runs with the scene clock unless frozen. Stamps reach the shader (`uMouse.w`,
   * `uTriggers`) and sims (`SimFrame.triggers`) moved back by how far this clock has run ahead of
   * the scene clock, on the scene's own clock (`ActiveScene.origin`).
   *
   * Reduced-motion policy (frozen): what moves on its own holds still (the scene and motion clocks,
   * sim steps, weather approach, passages), and a discrete interaction plays its bounded response
   * and settles. A stamp lands as far behind the still scene clock as real time has run since, so
   * `t - uMouse.w` and `sinceTrigger` count real seconds: a press's fade or a trigger's event ends
   * instead of holding its first frame, and what is held only while the button is down ends at
   * release. Sims see the press and release edges and `fired` but no time (dt 0), so whatever they
   * do in response is one still step. Unfrozen, the two clocks run alike and a stamp reaches the
   * shader as the scene's clock read when it was made.
   */
  #interactionClock = 0;
  /**
   * Motion clock (`uMotionTime`, `SimFrame.motionTime`): each scene-clock step times the motion
   * amount, summed on the same origin as `#clock`, so it equals `#clock * motion` while motion holds
   * still and moving the slider changes the pace without jumping the phase.
   */
  #motionClock = 0;
  /**
   * Fall clock (`uFallTime`): each scene-clock step times min(1, 2.5 × motion), on the same origin,
   * for what gravity drives (falling rain, splashes, drips): real time once motion is above 0.4,
   * slower below and still at 0, and like the motion clock it never jumps when the slider moves.
   */
  #fallClock = 0;
  #lastFrame = 0;
  /** This frame's rAF timestamp and its sims' budget (SimFrame.now and .budget), milliseconds. */
  #frameNow = 0;
  #frameBudget: number = SIM_BUDGET.least;
  #paused = false;
  /** Smoothed frames per second, for the lab footer. */
  fps = 0;
  /** Reduced motion: see `#interactionClock`. */
  #frozen: boolean;
  readonly #params = new Float32Array(MAX_PARAMS);
  /** Interaction-clock time each trigger slot last fired; far in the past when idle. */
  readonly #triggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** The motion clock when each slot last fired; far in the past when idle. */
  readonly #motionTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `uTriggers` and `SimFrame.triggers`: the stamps on the scene clock, rewritten in place each frame. */
  readonly #shownTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `uMotionTriggers` and `SimFrame.motionTriggers`: the same on the scene's motion clock. */
  readonly #shownMotionTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** Each slot's stamp as the current scene's sim last saw it, to find the next frame's presses. */
  readonly #seenTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `SimFrame.fired`, rewritten in place each frame. */
  readonly #fired: boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  /** The scene the triggers and the last press belong to: both reset when it changes. */
  #triggerScene = "";
  /**
   * The scene the setup changed to while asking it to take over the clocks of the one on screen
   * (see `update`), until it enters.
   */
  #keepClocks: SceneId | undefined;
  /**
   * Scene passage, on the passage clock: real seconds (`requestAnimationFrame` time, so it plays
   * whatever the motion) slowed by `slowmo`. A scene leaves (`#leaving`, see `Leaving`) playing its
   * exit; the next scene, built in the background meanwhile, enters afresh (`#reenter`, even the
   * same one replayed) `overlap` of the way through that exit, once its program is ready, and
   * dissolves out of the outgoing scene, which goes on drawing into the leaving frame
   * (`GlResources.leavingFrame`) until the dissolve is done. `#arrival.start`: NaN on an
   * entrance's first frame (see `#draw`), -Infinity when arrived without one (a cut);
   * `#arrival.from`: the frame it dissolves out of (`SceneDraw.from`).
   */
  #passageClock = 0;
  #leaving: Leaving | undefined;
  readonly #arrival: { start: number; from: WebGLTexture | undefined } = {
    start: -Infinity,
    from: undefined,
  };
  /**
   * The thumbnail a scene entering from nothing dissolves out of (see `setPoster`), until one
   * enters, and the texture it was painted into while that scene dissolves out of it.
   */
  #poster: { scene: SceneId; image: HTMLImageElement } | undefined;
  #posterFrame: WebGLTexture | undefined;
  /** Called once a scene shows after the page opened or a lost context was restored (`shown`). */
  readonly #shown: (() => void) | undefined;
  /** This frame entered a scene from nothing: `#shown` is due once it is drawn. */
  #unveil = false;
  #reenter = false;
  readonly #leavingSize = { width: 0, height: 0 };
  /** What the leaving scene's sim and shader see of the triggers: none fire. */
  readonly #quietTriggers: readonly number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  readonly #quietFired: readonly boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  readonly #reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /**
   * `frozen`: reduced motion (see `#interactionClock`). `options.cellBudget`: the cells a frame is
   * budgeted (default CELL_BUDGET, src/display.ts; the GPU timing page lifts it to time larger
   * grids). `options.shown`: called once a scene shows, on the frame it first draws (or enters
   * failed) after the page opened or a lost context was restored: the page's poster then goes
   * (main.ts).
   */
  constructor(
    canvas: HTMLCanvasElement,
    settings: RenderSettings,
    frozen: boolean,
    options: { cellBudget?: number; shown?: () => void } = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new RendererError("WebGL2 unavailable");
    this.#gl = gl;
    this.#settings = settings;
    this.#frozen = frozen;
    this.#shown = options.shown;
    this.#gpu = glResources(gl);
    this.#programs = new ScenePrograms(
      gl,
      () => this.#gpu,
      (program) => this.#draws(program),
    );
    this.#stage = new StageBox(
      canvas,
      () => this.#governor.wake(SETTLE_SECONDS),
      options.cellBudget,
    );
    // A lost context (a GPU reset, a driver update, the browser reclaiming it) comes back only to a
    // page that asks for it (preventDefault). Until then nothing draws (see `start`); once it is
    // back, what it held is made again and the scene enters afresh, as on the page's first frame.
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.#lose();
    });
    canvas.addEventListener("webglcontextrestored", () => this.#restore());

    const mouse = this.#mouse;
    const governor = this.#governor;
    const track = (event: PointerEvent) => {
      mouse.clientX = event.clientX;
      mouse.clientY = event.clientY;
      mouse.inside = !(event.target instanceof Element) || event.target.closest(CONTROLS) === null;
    };
    const lift = () => {
      if (!mouse.down) return;
      mouse.down = false;
      mouse.released = true;
      this.#respond();
    };
    // Input, over the page or the lab alike, draws a moving picture at the full rate for a while
    // (see `start`), and wakes a still one: the pointer passing over it for a moment, long enough
    // to draw it where it is now (the parallax then eases on toward it while it moves, see
    // `#still`); a drag, a press and its release for longer, a press setting off a response that
    // plays out in real time.
    window.addEventListener("pointermove", (event) => {
      this.#pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.#pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
      track(event);
      governor.wake(mouse.down ? SETTLE_SECONDS : POINTER_SECONDS);
      governor.input(SETTLE_SECONDS);
    });
    window.addEventListener("pointerdown", (event) => {
      track(event);
      governor.wake(SETTLE_SECONDS);
      governor.input(SETTLE_SECONDS);
      // Only presses that start over the page count: the lab and page controls keep theirs.
      if (!event.isPrimary || event.button !== 0 || !mouse.inside) return;
      mouse.down = true;
      mouse.pressed = true;
      mouse.pressedAt = this.#interactionClock;
      this.#respond();
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
      governor.wake(mouse.down ? SETTLE_SECONDS : POINTER_SECONDS);
      governor.input(SETTLE_SECONDS);
    });
    // Keys and the wheel change nothing on a still picture by themselves (a change they make wakes
    // it, see `update`); caught before any control can keep them.
    for (const type of ["keydown", "wheel"] as const)
      window.addEventListener(type, () => governor.input(SETTLE_SECONDS), {
        capture: true,
        passive: true,
      });
  }

  /** Fire one occurrence of the current scene's occasional effect in `slot` right now. */
  trigger(slot: number): void {
    if (slot < 0 || slot >= MAX_TRIGGERS) return;
    this.#triggers[slot] = this.#interactionClock;
    this.#motionTriggers[slot] = this.#motionClock;
    this.#respond();
  }

  get paused(): boolean {
    return this.#paused;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#governor.wake(SETTLE_SECONDS);
    this.#governor.input(SETTLE_SECONDS);
  }

  /**
   * Reduced motion on or off, as the system's setting changes (see `#interactionClock`): the scene
   * and motion clocks stop or go on from where they stood, and stamps keep their real-time ages.
   */
  setFrozen(frozen: boolean): void {
    this.#frozen = frozen;
    this.#governor.wake(SETTLE_SECONDS);
  }

  /**
   * Whether knob changes are likely (the lab is open). A scene with knob-keyed features then builds
   * its all-features program in the background once it has arrived, so the first change that needs
   * it switches at once instead of waiting for a build; the plain page never builds it, and nor does
   * a software rasteriser (`ProgramContext.software`).
   */
  expectChanges(expect: boolean): void {
    if (expect !== this.#expecting) this.#governor.wake(SETTLE_SECONDS);
    this.#expecting = expect;
  }

  /**
   * The committed thumbnail of `scene` (thumbs/<id>.webp, dithered as the page draws it), which the
   * page shows in the canvas's place until a scene draws (main.ts). `scene` entering from nothing
   * (the page's first frame, a restored context) with passages on dissolves out of it, laid over
   * the stage as the page lays it (`background: center / cover`), instead of out of the bare page.
   * Taken by the next scene to enter from nothing, and shown only if that is `scene`.
   */
  setPoster(scene: SceneId, image: HTMLImageElement): void {
    this.#poster = { scene, image };
  }

  /** Play the current scene's exit, then its entrance with a fresh simulation, even with passages off. */
  replayPassage(): void {
    if (this.#scene === undefined || this.#leaving !== undefined || this.#frozen) return;
    this.#leaving = this.#leave(this.#settings);
  }

  /**
   * Draw with `settings` from the next frame. Pass a new object for every change: a program sends
   * its look and knobs again only when the object differs from the one it last drew with. A change
   * counts as input. Every scene's clocks count from its own start, unless `keepClocks`: the scene
   * it changes to then takes over those of the scene on screen, so a world kept across scenes (the
   * lab's "keep the world", an A/B flip) goes on where it stood: its hours under the day cycle, its
   * passing year, its turning stars.
   */
  update(settings: RenderSettings, options: { keepClocks?: boolean } = {}): void {
    this.#settings = settings;
    this.#governor.wake(SETTLE_SECONDS);
    this.#governor.input(SETTLE_SECONDS);
    if (settings.scene !== this.#triggerScene) {
      this.#triggerScene = settings.scene;
      this.#triggers.fill(NEVER);
      this.#motionTriggers.fill(NEVER);
      this.#mouse.pressedAt = NEVER;
      this.#keepClocks = options.keepClocks === true ? settings.scene : undefined;
    }
  }

  /** Whether scenes pass in and out at all: off when asked, frozen, still, or under reduced motion. */
  #passing(settings: RenderSettings): boolean {
    return settings.passage && !this.#frozen && settings.motion > 0 && !this.#reducedMotion.matches;
  }

  /**
   * Draw on requestAnimationFrame. Paced (the default), every n-th refresh of the display, n whole,
   * so every frame stays up as long: at the full rate (the divisor of the refresh rate nearest 60
   * frames a second) while input, a press's or a trigger's response, a passage or an entrance
   * lasts, at rest (half that) otherwise, and while the picture stands still (`#still`) none at all
   * once the last change or input has played out (see FrameGovernor); `paced: false` draws every
   * frame asked for, for checks that drive frames by hand and the GPU timing page (src/bench.ts),
   * which times every frame the display gives it. Nothing draws while the context is lost.
   */
  start(options: { paced?: boolean } = {}): void {
    const paced = options.paced ?? true;
    const tick = (now: number) => {
      // Asked for first, so a frame that throws cannot end the loop.
      requestAnimationFrame(tick);
      if (this.#gl.isContextLost() || (paced && !this.#governor.due(now, this.#picture()))) return;
      try {
        this.#draw(now);
      } catch (error: unknown) {
        const scene = this.#drawing;
        if (scene !== undefined && scene.failure === undefined) this.#fail(scene, "frame", error);
        else console.error("evt=landing.renderer.frame_failed", error);
      }
      if (this.#unveil) {
        this.#unveil = false;
        this.#shown?.();
      }
    };
    requestAnimationFrame(tick);
  }

  /**
   * A press over the page, its release or a trigger: its response plays out at the full rate and
   * on a still picture, for real seconds unless paused (ages hold).
   */
  #respond(): void {
    const seconds = this.#paused ? SETTLE_SECONDS : RESPONSE_SECONDS;
    this.#governor.wake(seconds);
    this.#governor.input(seconds);
  }

  /**
   * Whether the picture stands still: nothing moves on its own (paused, frozen or at motion 0) and
   * nothing is on its way: the last frame moved nothing (`#moving`: an entrance, a dissolve, a
   * passage, a sim still building what it shows, the parallax easing toward the pointer), and no
   * program builds, waits to enter or draws its first frame. A change or input wakes still frames
   * for a while (see `start`).
   */
  #still(): boolean {
    return (
      (this.#paused || this.#frozen || this.#settings.motion <= 0) &&
      !this.#moving &&
      !this.#waiting &&
      !this.#rebuild &&
      !this.#reenter &&
      this.#scene !== undefined &&
      this.#leaving === undefined &&
      !this.#programs.busy
    );
  }

  /**
   * What the picture does, for the frame governor: stands still (`#still`), plays a passage or an
   * entrance (`#entering`), at the full rate whatever the input, or moves on its own.
   */
  #picture(): Picture {
    if (this.#still()) return "still";
    return this.#leaving !== undefined || this.#reenter || this.#entering ? "passing" : "moving";
  }

  /** Why the scene on screen is not drawing (the background shows instead), or undefined while it draws. */
  get failure(): SceneFailure | undefined {
    return this.#scene?.failure;
  }

  /**
   * Whether the scene the setup asks for is not on screen yet for want of its program, which builds
   * in the background meanwhile: on the page's first frames (the bare page shows, under the page's
   * poster), after a cut or a retry (the scene on screen goes on as it last drew) and after a
   * restored context. A program that fails to build ends it too, the scene entering failed
   * (`failure`).
   */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** WebGL version and renderer, for diagnosing remote reports. */
  get glInfo(): string {
    return this.#gpu.info;
  }

  /**
   * Where a passage stands: "preparing" while the leaving scene idles for the incoming one to be
   * ready, "exiting" while it plays its exit before the incoming one enters, "blending" while both
   * draw; "settled" otherwise.
   */
  get passagePhase(): "settled" | "preparing" | "exiting" | "blending" {
    const leaving = this.#leaving;
    if (leaving === undefined) return "settled";
    if (leaving.woven !== undefined) return "blending";
    return Number.isNaN(leaving.start) ? "preparing" : "exiting";
  }

  /**
   * After a failure, enter the scene again from scratch (a cut), once its program is built again
   * in the background if that is what failed.
   */
  retry(): void {
    const failure = this.#scene?.failure;
    if (failure === undefined) return;
    this.#programs.retry(failure.stage === "build" ? failure.scene : undefined);
    this.#rebuild = true;
  }

  /**
   * Whether `program` draws or is about to, so the program cache never frees it: the scene on
   * screen's, the leaving scene's, or the incoming one's (run ahead or primed for a passage).
   */
  #draws(program: SceneProgram): boolean {
    const leaving = this.#leaving;
    return (
      program === this.#scene?.program ||
      program === leaving?.woven?.scene.program ||
      program === leaving?.next?.program ||
      program === leaving?.primed
    );
  }

  /**
   * A scene for `s` with `built`, the program for its features (or why it failed to build), and a
   * fresh simulation, its clocks counting from now, or from where those of the scene on screen
   * count when it takes them over (see `update`). A program that failed to build or a simulation
   * that throws while starting leaves it failed (see `failure`).
   */
  #create(s: RenderSettings, built: SceneProgram | SceneFailure): ActiveScene {
    const id = s.scene;
    const params = sceneDefs[id].params;
    const from = this.#keepClocks === id ? this.#scene : undefined;
    const scene: ActiveScene = {
      id,
      program: "program" in built ? built : undefined,
      sim: undefined,
      failure: "stage" in built ? built : undefined,
      rain: params.findIndex((def) => def.key === "rain"),
      snow: params.findIndex((def) => def.key === "snow"),
      season: (() => {
        const def = hasClimate(params) ? seasonKnob(params) : undefined;
        const cycle = yearCycleKnob(params);
        return def
          ? { def, at: params.indexOf(def), cycle: cycle ? params.indexOf(cycle) : -1 }
          : undefined;
      })(),
      weather: { wet: 0, lying: 0 },
      passage: { enter: 1, exit: 0 },
      origin: from?.origin ?? {
        clock: this.#clock,
        motion: this.#motionClock,
        fall: this.#fallClock,
      },
    };
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
   * Enter the scene `s` sets in place of `current`, disposing that unless it is leaving: the scene
   * run ahead for it during the exit (`Leaving.next`), else a new one once its program is built.
   * Undefined while that builds in the background (see `ScenePrograms.entryProgram`): `current`
   * goes on meanwhile.
   */
  #replace(current: ActiveScene | undefined, s: RenderSettings): ActiveScene | undefined {
    const leaving = this.#leaving;
    const next = leaving?.next;
    let scene = next !== undefined && next.id === s.scene ? next : undefined;
    let built: SceneProgram | SceneFailure | undefined;
    if (scene === undefined) {
      built = this.#programs.entryProgram(s);
      if (built === undefined) return undefined;
    }
    if (current !== leaving?.woven?.scene) this.#release(current);
    if (leaving !== undefined) leaving.next = undefined;
    if (built !== undefined) {
      this.#release(next);
      scene = this.#create(s, built);
    }
    this.#scene = scene;
    if (scene?.id === this.#keepClocks) this.#keepClocks = undefined;
    return scene;
  }

  /**
   * The context is lost: let go of every scene and program, which went with it, and of the sheets
   * the scenes' painters kept on it (src/sheet.ts), which a scene entered after the restore would
   * otherwise adopt dead.
   */
  #lose(): void {
    const leaving = this.#leaving;
    this.#release(this.#scene);
    this.#release(leaving?.woven?.scene);
    this.#release(leaving?.next);
    this.#scene = undefined;
    this.#leaving = undefined;
    this.#drawn = undefined;
    this.#reenter = false;
    this.#rebuild = false;
    this.#waiting = false;
    this.#entering = false;
    // The poster's texture went with the context too (the page hands the poster over again).
    this.#posterFrame = undefined;
    this.#arrival.from = undefined;
    this.#programs.lose();
    forgetSheets(this.#gl);
  }

  /** The context is back: make what it held again. The scene then enters as on the first frame. */
  #restore(): void {
    try {
      this.#gpu = glResources(this.#gl);
    } catch (error: unknown) {
      console.error("evt=landing.renderer.restore_failed", error);
      return;
    }
    this.#leavingSize.width = 0;
    this.#leavingSize.height = 0;
    this.#governor.wake(SETTLE_SECONDS);
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
    gl.bindVertexArray(this.#gpu.vertexArray);
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

  /**
   * The pointer over the `cells` on screen, in stage uv, for this frame; consumes the press and
   * release edges.
   */
  #pointerState(cells: Cells): PointerState {
    const mouse = this.#mouse;
    const state: PointerState = {
      x: this.#stage.across(mouse.clientX, cells),
      y: 1 - this.#stage.down(mouse.clientY, cells),
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
    this.#drawing = undefined;
    const elapsed = this.#lastFrame === 0 ? 0 : (now - this.#lastFrame) / 1000;
    const dt = Math.min(elapsed, 0.1);
    this.#lastFrame = now;
    this.#frameNow = now;
    this.#frameBudget = Math.min(
      SIM_BUDGET.most,
      Math.max(SIM_BUDGET.least, SIM_BUDGET.share * elapsed * 1000),
    );
    // Cap simulation catch-up, not the footer's measurement of actual frame delivery.
    if (elapsed > 0)
      this.fps = this.fps === 0 ? 1 / elapsed : this.fps * 0.92 + (1 / elapsed) * 0.08;
    // The interaction clock stands still only while paused; the scene clock also while frozen.
    const live = this.#paused ? 0 : dt;
    const step = this.#frozen ? 0 : live;
    this.#passageClock += elapsed / Math.max(1, this.#settings.slowmo);
    const seconds = this.#passageClock;
    if (this.#programs.settle()) this.#governor.wake(SETTLE_SECONDS);
    const leaving = this.#pass(seconds);
    const woven = leaving?.woven;
    // On screen: a leaving scene as it was set when it began to leave, until the next one enters;
    // then that one as set, or as it entered if the setup has moved on to yet another scene during
    // the blend (it leaves for that one once the blend is done).
    let s =
      leaving === undefined
        ? this.#settings
        : woven === undefined
          ? leaving.settings
          : this.#settings.scene === woven.into.scene
            ? this.#settings
            : woven.into;
    const motion = this.#frozen ? 0 : s.motion;
    this.#clock += step;
    this.#interactionClock += live;
    this.#motionClock += step * motion;
    this.#fallClock += step * Math.min(1, 2.5 * motion);
    // While the program of the scene the setup asks for builds in the background (the page's first
    // frames, a cut, a retry, a restored context), the scene on screen goes on as it last drew, or
    // the bare page shows before there is one.
    const current = this.#scene;
    const entering =
      current === undefined || current.id !== s.scene || this.#reenter || this.#rebuild;
    const scene = entering ? (this.#replace(current, s) ?? current) : current;
    this.#waiting = entering && scene === current;
    if (this.#waiting && this.#drawn !== undefined) s = this.#drawn;
    const cells = this.#stage.cells(s.pixel);
    this.#stage.present(cells);
    const { width, height } = cells;

    // The parallax follows the pointer, unless frozen (reduced motion): then it eases back to rest.
    // It eases by the time the frame stands for, so at the same pace at any frame rate.
    const p = this.#pointer;
    const follow = s.followPointer && !this.#frozen;
    const tx = follow ? p.tx : 0;
    const ty = follow ? p.ty : 0;
    const ease = 1 - (1 - PARALLAX_EASE) ** (dt * 60);
    p.x += (tx - p.x) * ease;
    p.y += (ty - p.y) * ease;
    const pointer = this.#pointerState(cells);
    if (scene === undefined) {
      const gl = this.#gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(...rgb(s.bg), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const entered = scene !== current;
    const arrival = this.#arrival;
    if (entered) {
      // After a passage it dissolves out of the leaving scene; entering from nothing (the page's
      // first frame, a restored context) out of its poster where the page handed that over (see
      // `setPoster`), else out of the bare page; after a cut it is simply there. A passing
      // entrance's clock starts on its second frame: the first one compiles the program on the GPU
      // (drivers do it at the first draw), which can take longer than the whole dissolve, so it is
      // shown as the dissolve's start.
      const passed = this.#reenter;
      const passing = passed || (current === undefined && this.#passing(s));
      arrival.start = passing ? Number.NaN : -Infinity;
      arrival.from = passed ? this.#gpu.leavingFrame : undefined;
      if (current === undefined) {
        if (passing) arrival.from = this.#paintPoster(scene.id, cells);
        this.#poster = undefined;
        this.#unveil = true;
      }
      this.#reenter = false;
      this.#rebuild = false;
    } else if (Number.isNaN(arrival.start)) {
      arrival.start = seconds;
    }
    const weave = Math.max(s.weave, 1e-3);
    const since = Number.isNaN(arrival.start) ? 0 : Math.max(0, seconds - arrival.start);
    const passage = scene.passage;
    const choreography = sceneDefs[scene.id].passage;
    passage.enter = Math.min(1, since / Math.max(choreography?.enter ?? weave, 1e-3));
    passage.exit =
      leaving !== undefined && woven === undefined
        ? this.#exitShare(scene.id, leaving, seconds)
        : 0;
    const dissolve = Math.max(0, 1 - since / weave);
    // Changes that change the program's compile-time features (SceneDef.featuresFor, the library
    // gates, the planets coming or going: `settingKeyed`): the scene draws the new setting with a
    // program it entered with for exactly that set, else with its all-features program
    // (`sceneFeaturesAll`), built once in the background and never waited for; a change never
    // builds a program of its own (but on a software rasteriser, see `ProgramContext.software`).
    // Until the program is built the one on screen goes on drawing the settings it drew last (the
    // old frame, moving on); one that fails to build, or features that cannot be worked out, stop
    // the scene as entering it would. With changes expected (`expectChanges`) the all-features
    // program is built ahead (`ScenePrograms.buildAside`), once the scene has arrived.
    if (scene.program !== undefined && scene.failure === undefined) {
      const wanted = this.#programs.want(s);
      const next =
        "stage" in wanted
          ? wanted
          : scene.program.key === wanted.key
            ? scene.program
            : this.#programs.programSoon(scene.id, wanted);
      if (next === undefined) {
        s = scene.program.sent.settings ?? s;
      } else if ("stage" in next) {
        scene.failure = next;
        this.#release(scene);
      } else {
        scene.program = next;
        const all = "stage" in wanted ? undefined : wanted.all;
        if (
          this.#expecting &&
          !this.#gpu.software &&
          !this.#waiting &&
          all !== undefined &&
          leaving === undefined &&
          passage.enter >= 1
        )
          this.#programs.buildAside(scene.id, all);
      }
    }
    this.#drawn = s;

    // The leaving scene goes on first, off screen, into the frame the incoming one dissolves out of,
    // at its own cell size (the dissolve maps it over the screen), playing the rest of its exit.
    // Before that, while it exits on screen, the incoming scene runs ahead of its entrance: its sim
    // steps and it draws one cell, which the leaving scene's frame then covers.
    if (leaving !== undefined && woven !== undefined) {
      const out = woven.scene;
      const os = leaving.settings;
      const oc = this.#stage.cells(os.pixel);
      this.#sizeLeaving(oc.width, oc.height);
      out.passage.enter = 1;
      out.passage.exit = this.#exitShare(out.id, leaving, seconds);
      this.#render(out, os, out.program, step, pointer, {
        target: this.#gpu.leavingTarget,
        width: oc.width,
        height: oc.height,
        oneCell: false,
        fresh: false,
        triggers: this.#quietTriggers,
        motionTriggers: this.#quietTriggers,
        fired: this.#quietFired,
        pressedAt: NEVER,
        dissolve: 0,
        from: undefined,
        blend: os.blend,
      });
    } else if (leaving?.next !== undefined) {
      // Running ahead it gets ready without playing: dt 0, entrance not begun (see SimFrame.passage).
      const next = leaving.next;
      const ns = this.#settings;
      const nc = this.#stage.cells(ns.pixel);
      next.passage.enter = 0;
      next.passage.exit = 0;
      this.#render(next, ns, next.program, 0, pointer, {
        target: null,
        width: nc.width,
        height: nc.height,
        oneCell: true,
        fresh: true,
        triggers: this.#quietTriggers,
        motionTriggers: this.#quietTriggers,
        fired: this.#quietFired,
        pressedAt: NEVER,
        dissolve: 0,
        from: undefined,
        blend: ns.blend,
      });
    }

    // A program just built in the background draws this one frame in the chosen one's place (the
    // same picture), so a driver that compiles a program at its first draw does it now rather than
    // when a change needs it.
    const warm = this.#programs.takeWarm();
    const program =
      warm !== undefined && warm.id === scene.id && scene.program !== undefined
        ? warm.program
        : scene.program;
    // A slot fired when its stamp moved to a real press since the sim's previous frame. A scene just
    // entered has a fresh sim with nothing to compare against: its first frame reports no presses
    // (stamps were reset to idle when the scene changed, so an earlier visit's never replay).
    // Stamps reach the shader and sims on the scene's own clocks: an interaction-clock stamp moved
    // back by `lag`, how far that clock has run ahead of the scene clock (0 unfrozen) and where the
    // scene's clock counts from; a motion-clock stamp by where its motion clock does.
    const lag = this.#interactionClock - this.#clock + scene.origin.clock;
    const shown = this.#shownTriggers;
    const shownMotion = this.#shownMotionTriggers;
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      const stamp = this.#triggers[slot] ?? NEVER;
      this.#fired[slot] = !entered && stamp > NEVER && stamp !== this.#seenTriggers[slot];
      this.#seenTriggers[slot] = stamp;
      shown[slot] = stamp > NEVER ? stamp - lag : NEVER;
      const motionStamp = this.#motionTriggers[slot] ?? NEVER;
      shownMotion[slot] = motionStamp > NEVER ? motionStamp - scene.origin.motion : NEVER;
    }
    const drew = this.#render(scene, s, program, step, pointer, {
      target: null,
      width,
      height,
      oneCell: false,
      fresh: entered,
      triggers: shown,
      motionTriggers: shownMotion,
      fired: this.#fired,
      pressedAt: this.#mouse.pressedAt > NEVER ? this.#mouse.pressedAt - lag : NEVER,
      dissolve,
      from: arrival.from,
      blend: s.blend,
    });
    // The blend is done once the incoming scene shows alone (at once if it cannot draw).
    if (leaving !== undefined && woven !== undefined && (!drew || dissolve <= 0)) {
      this.#release(woven.scene);
      this.#leaving = undefined;
    }
    // The poster's texture goes once nothing dissolves out of it any more.
    const posterFrame = this.#posterFrame;
    if (posterFrame !== undefined && (arrival.from !== posterFrame || dissolve <= 0)) {
      this.#gl.deleteTexture(posterFrame);
      this.#posterFrame = undefined;
      if (arrival.from === posterFrame) arrival.from = undefined;
    }
    // Whether this frame moved anything still on its way (see `#still`), and played an entrance.
    this.#entering = dissolve > 0 || passage.enter < 1;
    this.#moving =
      this.#entering ||
      leaving !== undefined ||
      scene.sim?.ready?.() === false ||
      Math.abs(tx - p.x) + Math.abs(ty - p.y) > EASED;
  }

  /**
   * Where the passage stands this frame. A scene starts leaving once the setup has moved on to
   * another scene (passages on; one moving on during a blend leaves when the blend is done). It
   * idles on until the next scene's program is built in the background and drawn once (`#prime`),
   * so whatever the driver still holds the GPU up for comes before anything moves; then it plays
   * its exit, and the next scene enters once `overlap` of that has played. A leaving scene that
   * cannot draw gives way as soon as the next scene's program is built.
   */
  #pass(seconds: number): Leaving | undefined {
    const scene = this.#scene;
    const drawn = this.#drawn;
    if (
      this.#leaving === undefined &&
      scene !== undefined &&
      drawn !== undefined &&
      this.#settings.scene !== scene.id &&
      this.#passing(this.#settings)
    )
      this.#leaving = this.#leave(drawn);
    const leaving = this.#leaving;
    if (leaving === undefined || leaving.woven !== undefined || scene === undefined) return leaving;
    const into = this.#settings;
    const exit = sceneDefs[scene.id].passage?.exit ?? 0;
    // The incoming program, built in the background (a build for a scene passed over, or for a
    // change of the one leaving, finishing aside rather than holding it up).
    const built = this.#programs.entryProgram(into);
    if (built === undefined) return leaving;
    if (scene.program !== undefined && scene.failure === undefined) {
      // The incoming program drawn once; then its scene, run ahead off screen until its sim has
      // what it shows (`SceneSim.ready`). Until all that is done the leaving scene idles if its
      // exit has not begun (so nothing moves until the passage can run through) and exits on if it
      // has; the incoming scene enters `overlap` of the way through.
      if ("program" in built && leaving.primed !== built) {
        this.#prime(scene.program, built, leaving.settings);
        leaving.primed = built;
        return leaving;
      }
      let next = leaving.next;
      const program = "program" in built ? built : undefined;
      if (next === undefined || next.id !== into.scene || next.program !== program) {
        this.#release(next);
        next = this.#create(into, built);
        leaving.next = next;
        leaving.ahead = seconds;
      }
      // A sim that never reports ready (a worker that never answers) holds the passage for at most
      // READY_WAIT seconds.
      if (next.sim?.ready?.() === false && seconds - leaving.ahead < READY_WAIT) return leaving;
      if (Number.isNaN(leaving.start)) this.#begin(leaving, exit, into, seconds);
      if (seconds - leaving.start < (1 - into.overlap) * exit) return leaving;
    } else if (Number.isNaN(leaving.start)) {
      this.#begin(leaving, exit, into, seconds);
    }
    leaving.woven = { scene, into };
    this.#reenter = true;
    return leaving;
  }

  /** A scene starting to leave with the settings `s`: it idles until the next one is ready. */
  #leave(s: RenderSettings): Leaving {
    return {
      settings: s,
      start: Number.NaN,
      length: 0,
      primed: undefined,
      next: undefined,
      ahead: 0,
      woven: undefined,
    };
  }

  /**
   * Start the exit (of `exit` seconds) toward `into`. The incoming scene enters `overlap` of the
   * way through it and the blend then takes `weave`; an exit that would end before the blend does
   * is drawn out to end with it, so the leaving scene never stands still under the incoming one.
   */
  #begin(leaving: Leaving, exit: number, into: RenderSettings, seconds: number): void {
    leaving.start = seconds;
    leaving.length = Math.max(exit, (1 - into.overlap) * exit + Math.max(into.weave, 1e-3));
  }

  /**
   * Draw the incoming program once on the canvas and the leaving one once into the leaving frame,
   * one cell each (this frame's own draw covers the first). Many drivers finish compiling a program
   * for a target at its first draw there, which can hold the GPU up for a moment; done before the
   * exit starts, that moment falls while the scene still idles instead of in the middle of the
   * passage.
   */
  #prime(leaving: SceneProgram, incoming: SceneProgram, os: RenderSettings): void {
    const gl = this.#gl;
    const cells = this.#stage.cells(os.pixel);
    this.#sizeLeaving(cells.width, cells.height);
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.#gpu.blank);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(incoming.program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#gpu.leavingTarget);
    gl.useProgram(leaving.program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** How far `id` has played its exit, 0..1 (1 at once for a scene without one, 0 before it starts). */
  #exitShare(id: SceneId, leaving: Leaving, seconds: number): number {
    const exit = sceneDefs[id].passage?.exit ?? 0;
    if (exit <= 0) return 1;
    return Number.isNaN(leaving.start)
      ? 0
      : Math.min(1, (seconds - leaving.start) / leaving.length);
  }

  /** Size the leaving scene's frame to its own cells. */
  #sizeLeaving(width: number, height: number): void {
    const size = this.#leavingSize;
    if (size.width === width && size.height === height) return;
    size.width = width;
    size.height = height;
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.#gpu.leavingFrame);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /**
   * The poster handed over for `scene` (see `setPoster`) painted over `cells` where the page lays
   * it, a texel a cell, into a texture of its own (`#posterFrame`) for the scene to dissolve out
   * of; undefined without one for `scene`.
   */
  #paintPoster(scene: SceneId, cells: Cells): WebGLTexture | undefined {
    const poster = this.#poster;
    if (poster?.scene !== scene) return undefined;
    const { image } = poster;
    const canvas = new OffscreenCanvas(cells.width, cells.height);
    const context = canvas.getContext("2d");
    if (context === null || image.naturalWidth === 0 || image.naturalHeight === 0) return undefined;
    // Nearest, as the page's `image-rendering: pixelated` shows it.
    context.imageSmoothingEnabled = false;
    const at = this.#stage.cover(cells, image.naturalWidth, image.naturalHeight);
    context.drawImage(image, at.x, at.y, at.width, at.height);
    const gl = this.#gl;
    if (this.#posterFrame !== undefined) gl.deleteTexture(this.#posterFrame);
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    const texture = frameTexture(gl);
    // The canvas's rows run top down, a texture's up from uv.y 0; every other upload expects the
    // flip off (src/sims/gpu.ts).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.#posterFrame = texture;
    return texture;
  }

  /**
   * Step `scene`'s simulation and draw it with `program` into `draw.target`; a scene that cannot draw
   * (no program, or failed) clears the target to its background instead. Whether it drew.
   */
  #render(
    scene: ActiveScene,
    s: RenderSettings,
    program: SceneProgram | undefined,
    step: number,
    pointer: PointerState,
    draw: SceneDraw,
  ): boolean {
    const gl = this.#gl;
    const { target, width, height } = draw;
    if (program === undefined || scene.failure !== undefined) {
      if (draw.oneCell) return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, width, height);
      gl.clearColor(...rgb(s.bg), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
    this.#drawing = scene;
    const motion = this.#frozen ? 0 : s.motion;
    // The clocks as this scene sees them: from its own start (`ActiveScene.origin`).
    const time = this.#clock - scene.origin.clock;
    const motionTime = this.#motionClock - scene.origin.motion;
    const fallTime = this.#fallClock - scene.origin.fall;
    // The world follows the scene's own rain and snow on the scene clock: where they lead (soaked in
    // steady rain, damp in drizzle; snow lying deeper the harder it snows, less in rain), approached
    // exponentially. Wetting takes 1.2 / rain s per e-fold (~9 s to soak in steady rain), drying 25 s
    // (~75 s); settling 3 / snow s (~18 s in steady snow; 10 s for winter's own), melting 30 s
    // (~90 s), faster in rain. Where the season sets the climate, the cold turns rain to snow and
    // deep winter lays snow of its own. A scene just entered, or a frozen frame, starts where its
    // weather leads.
    const weather = scene.weather;
    const season = scene.season;
    const cold = season
      ? climateCold(
          yearNow(
            yearAt(season.def, s.params[season.at] ?? 0),
            s.params[season.cycle] ?? 0,
            motionTime,
          ),
        )
      : 0;
    const rainKnob = s.params[scene.rain] ?? 0;
    const rain = fallingRain(rainKnob, cold);
    const snow = fallingSnow(rainKnob, s.params[scene.snow] ?? 0, cold);
    const wetTo = rain > 0 ? Math.min(1, 0.4 + 1.1 * rain) : 0;
    const lyingTo = Math.max(
      snow > 0 ? Math.min(1, 0.25 + snow) * (1 - 0.5 * rain) : 0,
      climateLying(cold),
    );
    if (draw.fresh || this.#frozen) {
      weather.wet = wetTo;
      weather.lying = lyingTo;
    } else {
      weather.wet =
        wetTo + (weather.wet - wetTo) * Math.exp(-step / (weather.wet < wetTo ? 1.2 / rain : 25));
      weather.lying =
        lyingTo +
        (weather.lying - lyingTo) *
          Math.exp(
            -step / (weather.lying < lyingTo ? (snow > 0 ? 3 / snow : 10) : 30 / (1 + 4 * rain)),
          );
    }
    const passage = scene.passage;
    // Simulations upload (and so bind) their textures: step them before binding this frame's units.
    const simTextures =
      scene.sim?.frame({
        dt: step,
        time,
        motionTime,
        motion,
        now: this.#frameNow,
        budget: this.#frameBudget,
        width,
        height,
        aspect: width / height,
        values: s.params,
        params: s.knobs,
        triggers: draw.triggers,
        motionTriggers: draw.motionTriggers,
        fired: draw.fired,
        pointer,
        parallax: this.#pointer,
        passage,
      }) ?? [];

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, draw.oneCell ? 1 : width, draw.oneCell ? 1 : height);
    gl.useProgram(program.program);
    const gpu = this.#gpu;
    for (let slot = 0; slot < SIM_SLOTS; slot++) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, simTextures[slot] ?? gpu.blank);
    }
    // The frame it dissolves out of, if any: never the frame being drawn into, which the leaving
    // scene's draw has none of (sampling it would be a feedback loop).
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, draw.from ?? gpu.blank);

    const u = program.uniforms;
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uMotionTime, motionTime);
    gl.uniform1f(u.uFallTime, fallTime);
    gl.uniform2f(u.uPointer, this.#pointer.x, this.#pointer.y);
    gl.uniform4f(u.uMouse, pointer.x, pointer.y, pointer.down ? 1 : 0, draw.pressedAt);
    gl.uniform2f(u.uWeather, weather.wet, weather.lying);
    gl.uniform2f(u.uPassage, passage.enter, passage.exit);
    gl.uniform3f(
      u.uDissolve,
      draw.dissolve,
      draw.from === undefined ? 0 : 1,
      blendIds.indexOf(draw.blend),
    );
    // The rest only when it changed since this program last drew (see SceneProgram).
    const sent = program.sent;
    if (sent.settings !== s) {
      sent.settings = s;
      const params = this.#params;
      for (let i = 0; i < MAX_PARAMS; i++) params[i] = s.params[i] ?? 0;
      gl.uniform1i(u.uDither, ditherIds.indexOf(s.dither));
      gl.uniform1i(u.uColor, colorIds.indexOf(s.color));
      gl.uniform1f(u.uLevels, s.levels);
      gl.uniform3f(u.uBg, ...rgb(s.bg));
      gl.uniform3f(u.uInk, ...rgb(s.ink));
      gl.uniform3f(u.uAccent, ...rgb(s.accent));
      gl.uniform1fv(u.uParams, params);
      gl.uniform4fv(u.uPlanets, s.planets.data);
      gl.uniform1i(u.uPlanetCount, s.planets.count);
      gl.uniform1i(u.uView, viewIds.indexOf(s.view));
    }
    if (sent.motion !== motion) {
      sent.motion = motion;
      gl.uniform1f(u.uMotion, motion);
    }
    let triggersChanged = false;
    let motionTriggersChanged = false;
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      const stamp = draw.triggers[slot] ?? NEVER;
      if (sent.triggers[slot] !== stamp) {
        sent.triggers[slot] = stamp;
        triggersChanged = true;
      }
      const motionStamp = draw.motionTriggers[slot] ?? NEVER;
      if (sent.motionTriggers[slot] !== motionStamp) {
        sent.motionTriggers[slot] = motionStamp;
        motionTriggersChanged = true;
      }
    }
    if (triggersChanged) gl.uniform1fv(u.uTriggers, draw.triggers);
    if (motionTriggersChanged) gl.uniform1fv(u.uMotionTriggers, draw.motionTriggers);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#drawing = undefined;
    return true;
  }
}
