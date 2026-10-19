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
import { skyJoinAway } from "./constellations.ts";
import { StageBox, type Cells } from "./display.ts";
import {
  FrameGovernor,
  POINTER_SECONDS,
  RESPONSE_SECONDS,
  SETTLE_SECONDS,
  type Picture,
  type RestId,
} from "./governor.ts";
import { MAX_TRIGGERS, type ParamDef } from "./params.ts";
import { Cast, Presence, principal } from "./principals.ts";
import { RatePhases } from "./rate-phase.ts";
import {
  annotate,
  LEAVING_UNIT,
  ScenePrograms,
  SIM_SLOTS,
  type FeatureSet,
  type ProgramContext,
  type SceneProgram,
  type Wanted,
} from "./program-cache.ts";
import { loadedScene, sceneDefs, SceneLoadError, type SceneId } from "./scenes/index.ts";
import type { CameraPose } from "./composer/camera.ts";
import type { LightElement } from "./composer/types.ts";
import type { PlanetUniforms } from "./scenes/planets.ts";
import type { PrincipalState, SceneSim, SceneTurn } from "./scenes/types.ts";
import { featureKey, packParams, vertexSource } from "./shaders/index.ts";
import { forgetSheets } from "./scenes/pond/sheet.ts";
import type { Params } from "./state.ts";
import { STRIPS, StripScheduler } from "./strips.ts";

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
  /**
   * An eye-level composed scene's light elements, and as uElements takes them
   * (composer/elements.ts); none elsewhere.
   */
  elements: { readonly list: readonly LightElement[]; readonly data: Float32Array };
  /** A room's camera pose, and as uCamera takes it (composer/camera.ts); the rest pose elsewhere. */
  camera: { readonly pose: CameraPose; readonly data: Float32Array };
  followPointer: boolean;
  /** Agents of the cast present beside the visitor, 0..MAX_AGENTS (src/principals.ts). */
  agents: number;
  /** The rate frames draw at while nothing is touched (src/governor.ts): `full`, or `half` of it. */
  rest: RestId;
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

/**
 * Passage-clock seconds a passage, or a scene entering from nothing, waits at most for the incoming
 * sim to be ready (SceneSim.ready).
 */
const READY_WAIT = 3;
/**
 * How a scene entering from nothing (the page's first frame, a restored context) appears out of the
 * bare page: cell by cell at full resolution, each cell at its own ordered-dither threshold (the
 * "fade" blend's order), over this many passage-clock seconds.
 */
export const REVEAL = { blend: "fade", seconds: 0.8 } as const satisfies {
  blend: BlendId;
  seconds: number;
};
/**
 * How a scene takes the screen over in a crossfade (`update`'s `crossfade`: the lab moving between
 * two scenes of one baseline, which share their world): neither plays its exit or entrance, and
 * the incoming scene, entered already, comes in out of the leaving scene's frame, both still moving,
 * cell by cell at full resolution, each cell at its own ordered-dither threshold (the "fade" blend's
 * order), over this many passage-clock seconds whatever the blend's length and pattern.
 */
export const CROSSFADE = { blend: "fade", seconds: 0.8 } as const satisfies {
  blend: BlendId;
  seconds: number;
};
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
 * (-1 when it has none, which reads as 0), its season knob, where it sits and its year cycle's key
 * when the season sets its climate (src/climate.ts: it keeps a season and can snow), its rate knobs'
 * phases (`uPhases`, `SimFrame.phases`: src/rate-phase.ts, all 0 as it enters), its `uWeather` (how
 * wet its world is and how much snow lies, 0..1 each, on the scene clock), its `SimFrame.passage`
 * and `uPassage`, rewritten in place each frame, and where its clocks count from.
 */
interface ActiveScene {
  id: SceneId;
  program: SceneProgram | undefined;
  sim: SceneSim | undefined;
  failure: SceneFailure | undefined;
  rain: number;
  snow: number;
  season: { def: SeasonKnob; at: number; cycle: string | undefined } | undefined;
  readonly phases: RatePhases;
  readonly weather: { wet: number; lying: number; rain: number };
  readonly passage: { enter: number; exit: number };
  /**
   * The renderer's scene, motion and fall clocks when it was created (or, taking over the clocks
   * of the scene it replaced, that one's: see `DitherRenderer.update`): what it sees of them, and
   * so the float32 `uTime`, `uMotionTime` and `uFallTime`, counts from its own start, and stays
   * small however long the page has been open.
   */
  readonly origin: { readonly clock: number; readonly motion: number; readonly fall: number };
  /** Who is present in it beside the visitor: see `ScenePresence`. */
  readonly presence: ScenePresence;
}

/**
 * A scene's principals (src/principals.ts): what its sim and shader see of them each frame, and the
 * cast that places its agents, from the scene's seed knob (where `seed` sits in `params`, -1
 * without one; the cast is drawn afresh when that knob turns) and its motion clock.
 */
interface ScenePresence {
  readonly frame: Presence;
  cast: Cast;
  readonly seed: number;
}

function scenePresence(params: readonly ParamDef[]): ScenePresence {
  return {
    frame: new Presence(),
    cast: new Cast(0),
    seed: params.findIndex((def) => def.kind === "seed"),
  };
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
  /**
   * It gives way in a crossfade (`CROSSFADE`, `update`): no exit, and the incoming scene entered
   * already, its run ahead too. Settled anew each frame until `woven`, as the scene the setup asks
   * for may change while it idles.
   */
  crossfade: boolean;
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
   * The outgoing frame it dissolves out of (`uLeaving`, `uDissolve.y` 1): the leaving scene's;
   * undefined for the bare page (`uBg`).
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

/** EXT_disjoint_timer_query_webgl2: elapsed-time queries on the GPU, and whether they were upset. */
interface TimerQuery {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * What the context holds for every scene's program, made at start and again once a lost context
 * is restored: what programs are built with (`ProgramContext`: the vertex shader they share,
 * KHR_parallel_shader_compile when the browser has it, whether the context renders in software),
 * the vertex array every draw uses (bound again after a failed frame, see `#fail`), a black texel
 * for unbound sim slots, the frame the leaving scene draws into while the incoming one dissolves
 * out of it and its framebuffer (sized in `#draw`), the frame a picture drawn in strips is drawn
 * into and its framebuffer (src/strips.ts, sized in `#render`), the GPU's timer for the draws, and
 * the WebGL version and renderer, for diagnosing remote reports.
 */
interface GlResources extends ProgramContext {
  vertexArray: WebGLVertexArrayObject;
  blank: WebGLTexture;
  leavingFrame: WebGLTexture;
  leavingTarget: WebGLFramebuffer;
  stripFrame: WebGLTexture;
  stripTarget: WebGLFramebuffer;
  timer: TimerQuery | null;
  info: string;
}

/** A frame of nearest-sampled RGBA (one texel until sized) and a framebuffer drawing into it. */
function frameTarget(gl: WebGL2RenderingContext): [WebGLTexture, WebGLFramebuffer] {
  const frame = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, frame);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
  const target = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frame, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return [frame, target];
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
  const [leavingFrame, leavingTarget] = frameTarget(gl);
  const [stripFrame, stripTarget] = frameTarget(gl);
  // The renderer's alone: a query of the page's own around a frame would nest in its draw's.
  const timer: TimerQuery | null = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  return {
    vertex,
    vertexArray,
    blank,
    leavingFrame,
    leavingTarget,
    stripFrame,
    stripTarget,
    timer,
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
   * Frames on every n-th refresh, at the full rate or, by `rest`, at half of it at rest, and none
   * while the picture stands still (see `start`).
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
  /** What `#turned` last made of a layer turn, and the setting it was for. */
  #turn: { turn: SceneTurn; asked: Wanted; wanted: Wanted } | undefined;
  /**
   * What `#leavesThrough` last made of the program a layer switched off would leave through, and
   * the sim and program on screen it was for.
   */
  #through: { sim: SceneSim; drawn: string; set: FeatureSet | undefined } | undefined;
  /** The last frame played an entrance: the scene on screen still coming in, or dissolving. */
  #entering = false;
  /** Smoothed parallax (-1..1 over the window), eased toward the target `tx`, `ty`. */
  readonly #pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  /** The visitor's pointer as the page reports it; mapped to stage uv once per frame (`#visitor`). */
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
  /**
   * The visitor, principal 0 (`SimFrame.pointer`, `uPrincipals[0]`), rewritten in place once a
   * frame by `#visitorState`.
   */
  readonly #visitor: PrincipalState = principal();
  /** This frame's real seconds since the previous one (0.1 at most): what velocities are over. */
  #frameSeconds = 0;
  #settings: RenderSettings;
  /**
   * Scene clock in seconds; stands still while paused or frozen. Never reset: each scene counts it
   * from its own start (`ActiveScene.origin`), as it does the motion and fall clocks.
   */
  #clock = 0;
  /**
   * Interaction clock: what a press or a "now" trigger is stamped with. It stands still only while
   * paused, so it runs with the scene clock unless frozen. Stamps reach the shader
   * (`uPrincipals[0].w`, `uTriggers`) and sims (`SimFrame.triggers`) moved back by how far this
   * clock has run ahead of the scene clock, on the scene's own clock (`ActiveScene.origin`).
   *
   * Reduced-motion policy (frozen): what moves on its own holds still (the scene and motion clocks,
   * sim steps, weather approach, passages, the cast's agents), and a discrete interaction plays its
   * bounded response and settles. A stamp lands as far behind the still scene clock as real time has
   * run since, so `t - uPrincipals[0].w` and `sinceTrigger` count real seconds: a press's fade or a
   * trigger's event ends instead of holding its first frame, and what is held only while the button
   * is down ends at release. Sims see the press and release edges and `fired` but no time (dt 0), so
   * whatever they do in response is one still step. Unfrozen, the two clocks run alike and a stamp
   * reaches the shader as the scene's clock read when it was made.
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
   * The change of scene the setup asked to crossfade (see `update`): from the scene it showed to the
   * one it changed to, until that one enters. Only the scene on screen being `from` crossfades.
   */
  #crossfade: { from: string; to: SceneId } | undefined;
  /**
   * Scene passage, on the passage clock: real seconds (`requestAnimationFrame` time, so it plays
   * whatever the motion) slowed by `slowmo`. A scene leaves (`#leaving`, see `Leaving`) playing its
   * exit; the next scene, built in the background meanwhile, enters afresh (`#reenter`, even the
   * same one replayed) `overlap` of the way through that exit, once its program is ready, and
   * dissolves out of the outgoing scene, which goes on drawing into the leaving frame
   * (`GlResources.leavingFrame`) until the dissolve is done. `#arrival.start`: NaN on an
   * entrance's first frame (see `#draw`), -Infinity when arrived without one (a cut);
   * `#arrival.entered`: when it entered; `#arrival.from`: the frame it dissolves out of
   * (`SceneDraw.from`); `#arrival.reveal`: it entered from nothing and appears out of the bare page
   * (`REVEAL`); `#arrival.crossfade`: it entered in a crossfade (`CROSSFADE`).
   */
  #passageClock = 0;
  #leaving: Leaving | undefined;
  readonly #arrival: {
    start: number;
    entered: number;
    from: WebGLTexture | undefined;
    reveal: boolean;
    crossfade: boolean;
  } = { start: -Infinity, entered: 0, from: undefined, reveal: false, crossfade: false };
  #reenter = false;
  readonly #leavingSize = { width: 0, height: 0 };
  /**
   * The strips the picture on screen is drawn in (src/strips.ts), unless off (`options.strips`):
   * how many, and the one each frame draws, from the GPU's time for its draws.
   */
  readonly #strips = new StripScheduler();
  readonly #stripping: boolean;
  /** The program the strips were last set for: a new one starts them afresh. */
  #stripsFor: SceneProgram | undefined;
  readonly #stripSize = { width: 0, height: 0 };
  /** The on-screen draws the GPU has not timed yet: each one's query, the rows it drew, of how many. */
  #timings: { query: WebGLQuery; rows: number; height: number }[] = [];
  /** Told each on-screen draw's GPU time (`options.timed`). */
  readonly #timed: ((ms: number, rows: number, height: number) => void) | undefined;
  /** What the leaving scene's sim and shader see of the triggers: none fire. */
  readonly #quietTriggers: readonly number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  readonly #quietFired: readonly boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  readonly #reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /**
   * `frozen`: reduced motion (see `#interactionClock`). `options.cellBudget`: the cells a frame is
   * budgeted (default CELL_BUDGET, src/display.ts; the GPU timing page lifts it to time larger
   * grids). `options.strips` false draws every picture whole however long it takes (the GPU timing
   * page, to time a whole picture); `options.timed` is told the GPU's time for each draw of the
   * picture on screen, the rows it drew and of how many.
   */
  constructor(
    canvas: HTMLCanvasElement,
    settings: RenderSettings,
    frozen: boolean,
    options: {
      cellBudget?: number;
      strips?: boolean;
      timed?: (ms: number, rows: number, height: number) => void;
    } = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new RendererError("WebGL2 unavailable");
    this.#gl = gl;
    this.#settings = settings;
    this.#governor.rest = settings.rest;
    this.#frozen = frozen;
    this.#gpu = glResources(gl);
    this.#stripping = options.strips ?? true;
    this.#timed = options.timed;
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

  /** Play the current scene's exit, then its entrance with a fresh simulation, even with passages off. */
  replayPassage(): void {
    if (this.#scene === undefined || this.#leaving !== undefined || this.#frozen) return;
    this.#leaving = this.#leave(this.#settings);
  }

  /**
   * Draw with `settings` from the next frame. Pass a new object for every change: a program sends
   * its look and knobs again only when the object differs from the one it last drew with. A change
   * counts as input. Every scene's clocks count from its own start, unless `keepClocks`: the scene
   * it changes to then takes over those of the scene on screen, and its rate knobs' phases (src/
   * rate-phase.ts `adopt`), so a world kept across scenes (the lab's "keep the world", an A/B flip)
   * goes on where it stood: its hours under the day cycle, its passing year, its turning stars.
   * `crossfade`: the scene it changes to takes the screen over from the one the setup showed in a
   * crossfade (`CROSSFADE`) instead of their exit and entrance; where scenes pass at all (`#passing`:
   * else it is a cut, as any change is), and only from that scene: one on screen still on its way
   * out to another plays the passage.
   */
  update(
    settings: RenderSettings,
    options: { keepClocks?: boolean; crossfade?: boolean } = {},
  ): void {
    this.#settings = settings;
    this.#governor.rest = settings.rest;
    this.#governor.wake(SETTLE_SECONDS);
    this.#governor.input(SETTLE_SECONDS);
    if (settings.scene !== this.#triggerScene) {
      this.#crossfade =
        options.crossfade === true ? { from: this.#triggerScene, to: settings.scene } : undefined;
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
   * frames a second), or, where the setting `rest` is `half`, while input, a press's or a trigger's
   * response, a passage or an entrance lasts only, at half that otherwise; and while the picture
   * stands still (`#still`) none at all once the last change or input has played out (see
   * FrameGovernor); `paced: false` draws every frame asked for, for checks that drive frames by
   * hand and the GPU timing page (src/bench.ts), which times every frame the display gives it.
   * Nothing draws while the context is lost.
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
   * in the background meanwhile: on the page's first frames (the bare page shows), after a cut or
   * a retry (the scene on screen goes on as it last drew) and after a restored context. A program
   * that fails to build ends it too, the scene entering failed (`failure`).
   */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** WebGL version and renderer, for diagnosing remote reports. */
  get glInfo(): string {
    return this.#gpu.info;
  }

  /** How many strips the picture on screen is drawn in (src/strips.ts): 1 draws it whole. */
  get strips(): number {
    return this.#stripping ? this.#strips.strips : 1;
  }

  /** The cell grid the scene on screen draws at (src/display.ts `stageCells`). */
  get grid(): { readonly width: number; readonly height: number } {
    const cells = this.#stage.cells(this.#settings.pixel);
    return { width: cells.width, height: cells.height };
  }

  /**
   * The cell point under a point of the page (client pixels), as `gl_FragCoord` has it: x right, y
   * up from the bottom left of the grid, cell i's centre at i + 0.5; undefined off the picture.
   */
  cellAt(clientX: number, clientY: number): readonly [number, number] | undefined {
    const cells = this.#stage.cells(this.#settings.pixel);
    const across = this.#stage.across(clientX, cells);
    const down = this.#stage.down(clientY, cells);
    if (across < 0 || across > 1 || down < 0 || down > 1) return undefined;
    return [across * cells.width, (1 - down) * cells.height];
  }

  /** The feature key of the program the scene on screen draws with, once it has one. */
  get programKey(): string | undefined {
    return this.#scene?.program?.key;
  }

  /**
   * Something the scene draws from outside its settings changed (the engine's document,
   * src/engine/view.ts): work its program's features out again, as for a new setting, and draw.
   */
  refresh(): void {
    this.update({ ...this.#settings });
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
   * that throws while starting leaves it failed (see `failure`). A built program means the scene's
   * code has loaded (ScenePrograms builds from it alone), sim and all.
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
        return def ? { def, at: params.indexOf(def), cycle: cycle?.key } : undefined;
      })(),
      phases: new RatePhases(params),
      weather: { wet: 0, lying: 0, rain: 0 },
      passage: { enter: 1, exit: 0 },
      presence: scenePresence(params),
      origin: from?.origin ?? {
        clock: this.#clock,
        motion: this.#motionClock,
        fall: this.#fallClock,
      },
    };
    if (scene.program !== undefined) {
      try {
        const code = loadedScene(id);
        if (code === undefined)
          throw new SceneLoadError(`scene ${id}: built before its code loaded`);
        scene.sim = code.sim?.(this.#gl);
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
    if (scene !== undefined && scene.id === this.#keepClocks) {
      // Its rate knobs' phases go on from those of the scene it replaces, taken over as it enters
      // (a run ahead holds them still), as its clocks do (`#create`).
      if (current !== undefined && current !== scene) scene.phases.adopt(current.phases);
      this.#keepClocks = undefined;
    }
    if (scene !== undefined && scene.id === this.#crossfade?.to) this.#crossfade = undefined;
    return scene;
  }

  /**
   * The context is lost: let go of every scene and program, which went with it, of the sheets the
   * scenes' painters kept on it (src/sheet.ts), which a scene entered after the restore would
   * otherwise adopt dead, and of the draws' timer queries.
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
    this.#timings = [];
    this.#stripsFor = undefined;
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
    this.#stripSize.width = 0;
    this.#stripSize.height = 0;
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
   * The visitor over the `cells` on screen, in stage uv, for this frame (`#visitor`, rewritten in
   * place): where it is and how fast it moved there over the frame's `dt` real seconds; consumes
   * the press and release edges.
   */
  #visitorState(cells: Cells, dt: number): PrincipalState {
    const mouse = this.#mouse;
    const visitor = this.#visitor;
    const x = this.#stage.across(mouse.clientX, cells);
    const y = 1 - this.#stage.down(mouse.clientY, cells);
    visitor.vx = dt > 0 ? (x - visitor.x) / dt : 0;
    visitor.vy = dt > 0 ? (y - visitor.y) / dt : 0;
    visitor.x = x;
    visitor.y = y;
    visitor.inside = mouse.inside;
    visitor.down = mouse.down;
    visitor.pressed = mouse.pressed;
    visitor.released = mouse.released;
    mouse.pressed = false;
    mouse.released = false;
    return visitor;
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
    this.#frameSeconds = dt;
    const visitor = this.#visitorState(cells, dt);
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
      // first frame, a restored context) it appears out of the bare page (`REVEAL`); after a cut
      // it is simply there; in a crossfade it is there already and dissolves out of the leaving
      // scene (`CROSSFADE`). A passing entrance's clock starts on its second frame: the first one
      // compiles the program on the GPU (drivers do it at the first draw), which can take longer
      // than the whole dissolve, so it is shown as the dissolve's start. A scene entering from
      // nothing starts it only once its sim has what it shows (`SceneSim.ready`, at most READY_WAIT
      // seconds), as a passage runs the incoming scene ahead until then: the bare page shows
      // meanwhile, so the reveal assembles the scene's whole world.
      const passed = this.#reenter;
      arrival.reveal = !passed && current === undefined && this.#passing(s);
      arrival.crossfade = passed && leaving?.crossfade === true;
      arrival.start = passed || arrival.reveal ? Number.NaN : -Infinity;
      arrival.entered = seconds;
      arrival.from = passed ? this.#gpu.leavingFrame : undefined;
      this.#reenter = false;
      this.#rebuild = false;
    } else if (
      Number.isNaN(arrival.start) &&
      !(arrival.reveal && scene.sim?.ready?.() === false && seconds - arrival.entered < READY_WAIT)
    ) {
      arrival.start = seconds;
    }
    const weave = arrival.reveal
      ? REVEAL.seconds
      : arrival.crossfade
        ? CROSSFADE.seconds
        : Math.max(s.weave, 1e-3);
    const since = Number.isNaN(arrival.start) ? 0 : Math.max(0, seconds - arrival.start);
    const passage = scene.passage;
    const choreography = sceneDefs[scene.id].passage;
    passage.enter = arrival.crossfade
      ? 1
      : Math.min(1, since / Math.max(choreography?.enter ?? weave, 1e-3));
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
    // A composed scene's layer turned on or off plays its own entrance or exit in a program that
    // draws it, which its steady programs leave out (its sim says which: `#turned`; the layer set's
    // all-features program draws it too): one switched off leaves through the layer set on screen,
    // which goes on drawing the new setting until the exit has played, and only then is the
    // setting's own program asked for. With changes expected that program is built ahead as well,
    // so that a switch-off starts its exit at once: on a GPU the all-features program above is it;
    // on a software rasteriser it is the steady program's own layer set drawing turns, built once
    // nothing else builds (`#leavesThrough`). The page itself, where no layer turns, builds nothing
    // ahead.
    // A program just built ahead draws one frame in the chosen one's place (below) only where it
    // draws the setting at rest, no layer turn under way: the setting's all-features program, or the
    // one a switch-off would leave through (at rest it draws the steady program's picture).
    let warmable: string | undefined;
    if (scene.program !== undefined && scene.failure === undefined) {
      const asked = this.#programs.want(s);
      const wanted = "stage" in asked ? asked : this.#turned(scene.sim, scene.program, asked);
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
        if (!("stage" in asked) && wanted === asked) {
          const ahead =
            !this.#expecting || this.#waiting || leaving !== undefined || passage.enter < 1
              ? undefined
              : this.#gpu.software
                ? this.#leavesThrough(scene.sim, next.key)
                : asked.all;
          if (ahead !== undefined && !(this.#gpu.software && this.#programs.busy))
            this.#programs.buildAside(scene.id, ahead);
          warmable = ahead?.key ?? asked.all?.key;
        }
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
      this.#render(out, os, out.program, step, visitor, {
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
      // Running ahead it gets ready without playing: dt 0, entrance not begun (see
      // SimFrame.passage), or, ahead of a crossfade, entered already.
      const next = leaving.next;
      const ns = this.#settings;
      const nc = this.#stage.cells(ns.pixel);
      next.passage.enter = leaving.crossfade ? 1 : 0;
      next.passage.exit = 0;
      this.#render(next, ns, next.program, 0, visitor, {
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

    // A program just built in the background draws this one frame in the chosen one's place, so a
    // driver that compiles a program at its first draw does it now rather than when a change needs
    // it: where it draws the same picture (`warmable`), so never while a composed scene's layer turn
    // is under way, whose sim would take it for the program it plays the turn in.
    const warm = this.#programs.takeWarm();
    const program =
      warm !== undefined && warm.id === scene.id && warm.program.key === warmable
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
    const drew = this.#render(scene, s, program, step, visitor, {
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
      blend: arrival.reveal ? REVEAL.blend : arrival.crossfade ? CROSSFADE.blend : s.blend,
    });
    // The blend is done once the incoming scene shows alone (at once if it cannot draw).
    if (leaving !== undefined && woven !== undefined && (!drew || dissolve <= 0)) {
      this.#release(woven.scene);
      this.#leaving = undefined;
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
   * its exit, and the next scene enters once `overlap` of that has played; in a crossfade it plays
   * none, and the next scene enters as soon as it is ready. A leaving scene that cannot draw gives
   * way as soon as the next scene's program is built.
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
    // A crossfade asked for from the scene on screen to the one the setup asks for plays no exit.
    const fade = this.#crossfade;
    leaving.crossfade = fade !== undefined && fade.from === scene.id && fade.to === into.scene;
    const exit = leaving.crossfade ? 0 : (sceneDefs[scene.id].passage?.exit ?? 0);
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
      crossfade: false,
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

  /**
   * How far `id` has played its exit, 0..1 (1 at once for a scene without one, 0 before it starts,
   * and throughout a crossfade, which plays none).
   */
  #exitShare(id: SceneId, leaving: Leaving, seconds: number): number {
    if (leaving.crossfade) return 0;
    const exit = sceneDefs[id].passage?.exit ?? 0;
    if (exit <= 0) return 1;
    return Number.isNaN(leaving.start)
      ? 0
      : Math.min(1, (seconds - leaving.start) / leaving.length);
  }

  /**
   * What a scene draws the setting `asked` with, the program on screen being `drawn`: while a
   * composed scene's layer turned on or off plays or is on its way, the program its sim says the
   * turn plays in (SceneSim.turning), with the all-features program of its layer set, which draws
   * turns too, standing in for it: the setting's for one switched on; for one switched off, that of
   * the setting `drawn` last drew, its own layer set's while it is steady (once it draws turns it is
   * the turn's program itself); else the setting's own.
   */
  #turned(sim: SceneSim | undefined, drawn: SceneProgram, asked: Wanted): Wanted {
    const turn = sim?.turning?.(drawn.key, asked.features);
    if (turn === undefined) return asked;
    const last = this.#turn;
    if (last?.turn === turn && last.asked === asked) return last.wanted;
    const sent = drawn.sent.settings;
    const was = turn.setting || sent === undefined ? undefined : this.#programs.want(sent);
    const wanted: Wanted = {
      features: turn.features,
      key: featureKey(turn.features),
      all: turn.setting ? asked.all : was === undefined || "stage" in was ? undefined : was.all,
    };
    this.#turn = { turn, asked, wanted };
    return wanted;
  }

  /**
   * The program a layer switched off from the program on screen (`drawn`, its key) would leave
   * through (SceneSim.leavesThrough), worked out once for each program on screen.
   */
  #leavesThrough(sim: SceneSim | undefined, drawn: string): FeatureSet | undefined {
    if (sim?.leavesThrough === undefined) return undefined;
    let through = this.#through;
    if (through?.sim !== sim || through.drawn !== drawn) {
      const features = sim.leavesThrough(drawn);
      through = {
        sim,
        drawn,
        set: features === undefined ? undefined : { features, key: featureKey(features) },
      };
      this.#through = through;
    }
    return through.set;
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

  /** Size the frame the picture on screen is drawn into in strips to its cells, `bg` until drawn. */
  #sizeStrips(width: number, height: number, bg: string): void {
    const size = this.#stripSize;
    if (size.width === width && size.height === height) return;
    size.width = width;
    size.height = height;
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + LEAVING_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.#gpu.stripFrame);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#gpu.stripTarget);
    gl.clearColor(...rgb(bg), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Hand the strips (and `options.timed`) the GPU's time for each on-screen draw it has timed, in
   * the order they were drawn; a disjoint event (the GPU's clock upset) voids every one in flight.
   */
  #timeDraws(): void {
    const gl = this.#gl;
    const timer = this.#gpu.timer;
    if (timer === null || this.#timings.length === 0) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) === true;
    let done = 0;
    for (const { query, rows, height } of this.#timings) {
      if (!disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) break;
      if (!disjoint) {
        const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        this.#strips.measured(ms, rows, height);
        this.#timed?.(ms, rows, height);
      }
      gl.deleteQuery(query);
      done += 1;
    }
    this.#timings.splice(0, done);
  }

  /**
   * Step `scene`'s simulation and draw it with `program` into `draw.target`, with `visitor` and the
   * cast's agents present; a scene that cannot draw (no program, or failed) clears the target to
   * its background instead. Whether it drew.
   */
  #render(
    scene: ActiveScene,
    s: RenderSettings,
    program: SceneProgram | undefined,
    step: number,
    visitor: PrincipalState,
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
    // The rate knobs' phases run on with this step of the motion clock, each at its knob's pace now.
    scene.phases.step(s.params, step * motion);
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
            season.cycle === undefined ? 0 : (scene.phases.byKey[season.cycle] ?? 0),
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
    weather.rain = rain;
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
    // Who is present: the visitor, then the cast's agents on the scene's motion clock, drawn from
    // its seed knob (a cast drawn afresh when the knob turns) and going where its sim points.
    const aspect = width / height;
    const presence = scene.presence;
    const seed = s.params[presence.seed] ?? 0;
    if (presence.cast.seed !== seed) presence.cast = new Cast(seed);
    const others = presence.cast.poses(motionTime, aspect, s.agents, scene.sim);
    skyJoinAway(others, sceneDefs[scene.id].params, s.params, scene.phases.byKey, motionTime);
    presence.frame.update(visitor, draw.pressedAt, others, this.#frameSeconds, time);
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
        aspect,
        values: s.params,
        params: s.knobs,
        phases: scene.phases.byKey,
        triggers: draw.triggers,
        motionTriggers: draw.motionTriggers,
        fired: draw.fired,
        pointer: visitor,
        principals: presence.frame.principals,
        parallax: this.#pointer,
        weather,
        passage,
        features: program.key,
      }) ?? [];

    // The picture on screen of a scene that asks for it (SceneDef.strips, the engine's canvas) is
    // bounded (src/strips.ts): drawn a strip at a time into a frame of its own, shown whole every
    // frame, while a whole one draws too slowly, and on a software rasteriser always through that
    // frame, so a pass that begins finds the last picture in it. A program's first draw is not
    // timed: it builds the program on the GPU too.
    const gpu = this.#gpu;
    const onScreen = target === null && !draw.oneCell;
    const stripped = this.#stripping && sceneDefs[scene.id].strips === true;
    const first = onScreen && program !== this.#stripsFor;
    let rows: readonly [number, number] = [0, height];
    let framed = false;
    if (onScreen) {
      this.#timeDraws();
      if (first) {
        this.#stripsFor = program;
        this.#strips.reset(stripped && gpu.software ? STRIPS.start : 1);
      }
      if (stripped) rows = this.#strips.rows(height);
      framed = stripped && (gpu.software || this.#strips.strips > 1);
      if (framed) this.#sizeStrips(width, height, s.bg);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framed ? gpu.stripTarget : target);
    gl.viewport(0, 0, draw.oneCell ? 1 : width, draw.oneCell ? 1 : height);
    gl.useProgram(program.program);
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
    gl.uniform4fv(u.uPhases, scene.phases.upload);
    gl.uniform2f(u.uPointer, this.#pointer.x, this.#pointer.y);
    gl.uniform4fv(u.uPrincipals, presence.frame.upload);
    gl.uniform1i(u.uPrincipalCount, presence.frame.principals.length);
    gl.uniform4fv(u.uPrincipalMotion, presence.frame.motion);
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
      // The knobs this program reads, packed through its slot map (shaders/index.ts knobSlots).
      const params = packParams(s.params, program.knobs, program.params);
      gl.uniform1i(u.uDither, ditherIds.indexOf(s.dither));
      gl.uniform1i(u.uColor, colorIds.indexOf(s.color));
      gl.uniform1f(u.uLevels, s.levels);
      gl.uniform3f(u.uBg, ...rgb(s.bg));
      gl.uniform3f(u.uInk, ...rgb(s.ink));
      gl.uniform3f(u.uAccent, ...rgb(s.accent));
      gl.uniform4fv(u.uParams, params);
      gl.uniform4fv(u.uPlanets, s.planets.data);
      gl.uniform1i(u.uPlanetCount, s.planets.count);
      gl.uniform4fv(u.uElements, s.elements.data);
      gl.uniform4fv(u.uCamera, s.camera.data);
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
    let simOn = 0;
    for (let slot = 0; slot < SIM_SLOTS; slot++) if (simTextures[slot]) simOn |= 1 << slot;
    if (sent.simOn !== simOn) {
      sent.simOn = simOn;
      gl.uniform4f(u.uSimOn, simOn & 1, (simOn >> 1) & 1, (simOn >> 2) & 1, (simOn >> 3) & 1);
      gl.uniform4f(
        u.uSimOn2,
        (simOn >> 4) & 1,
        (simOn >> 5) & 1,
        (simOn >> 6) & 1,
        (simOn >> 7) & 1,
      );
    }
    const timer = onScreen && !first ? gpu.timer : null;
    const query = timer === null ? null : gl.createQuery();
    if (timer !== null && query !== null) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    const strip = rows[0] > 0 || rows[1] < height;
    if (strip) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, rows[0], width, rows[1] - rows[0]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (strip) gl.disable(gl.SCISSOR_TEST);
    if (timer !== null && query !== null) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.#timings.push({ query, rows: rows[1] - rows[0], height });
    }
    if (framed) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.stripTarget);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#drawing = undefined;
    return true;
  }
}
