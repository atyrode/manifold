// The contract every scene module implements. A scene is one self-contained module under
// src/scenes/<id>/ in two halves: its `index.ts` exports a SceneDef, what the registry
// (src/scenes/index.ts) lists in lab order and the page reads at once (title, knobs, groups,
// passage, features); its `code.ts` exports its SceneCode (GLSL, entry, sim), which the page loads
// only once the scene is needed (`SceneDef.code`, the registry's `loadScene`).
//
// Shader: each scene compiles to its own WebGL2 program:
//   common preamble (uniforms, noise, dithering helpers, Shade)   — src/shaders/common.ts
//   + one `#define <NAME> <n>` per compile-time feature, from `features` and `featuresFor(knobs)`
//   + one `#define K_<key> uParams[i / 4].<xyzw>` per knob (uParams packs four knobs a row),
//     generated from `params`, and `SKY_YEAR`, the scene's year position for the climate
//     (src/climate.ts; -1.0 without a season)
//   + shared libraries (sky, clouds, weather, surface, water, lightning, aurora, meteors, canopy)
//     — src/shaders/lib/
//   + the scene's `glsl`, which defines `Shade <entry>(vec2 uv, vec2 cell, float t)`
//   + the dithering `main`, which calls the entry;
//   shaken (src/shaders/shake.ts) to what `main` reaches before it reaches the driver.
// `uv` is 0..1 with y up, `cell` is the dither cell (gl_FragCoord.xy), `t` the scene clock.
import type { Blurb, ParamDef } from "../params.ts";
import type { SkyPlanets } from "./planets.ts";

/** Lab palette modes and quantisation a scene starts from. */
export interface SceneLook {
  color?: "accent" | "mono" | "full";
  /** Quantisation levels per channel, 2..6. */
  levels?: number;
}

/** Who a principal is: the visitor or another person, or an agent. */
export type PrincipalKind = "human" | "agent";

/**
 * Someone present in the scene (AXIOMS A2: humans and agents are principals alike), as a pointer
 * in scene uv (0..1, y up): the visitor, or an agent of the cast (src/principals.ts). What a hand
 * does is the same whoever's it is; `kind` says whose, for what is drawn of them, never for what
 * the scene does with them.
 */
export interface PrincipalState {
  x: number;
  y: number;
  /** Over the page (not over the lab or a page control); an agent always is. */
  inside: boolean;
  /** Primary button held (an agent's: while it acts). */
  down: boolean;
  /** Went down since the previous frame. */
  pressed: boolean;
  /** Went up since the previous frame. */
  released: boolean;
  /** Uv per second: how far it moved since the previous frame, over the time between the two. */
  vx: number;
  vy: number;
  kind: PrincipalKind;
}

/** A place in the scene, in uv (0..1, y up). */
export interface ScenePoint {
  readonly x: number;
  readonly y: number;
}

/** What a simulation sees each frame. */
export interface SimFrame {
  /** Seconds since the previous frame on the scene clock; 0 while paused or frozen. */
  dt: number;
  /**
   * The scene clock (the shader's `uTime`), counted from the scene's start (or, where it took the
   * clocks of the scene it replaced over, from that one's: DitherRenderer.update).
   */
  time: number;
  /**
   * The motion clock (the shader's `uMotionTime`): every step of the scene clock times the motion
   * amount, summed on the same origin as `time`. It equals `time * motion` while motion holds still,
   * and moving the slider changes the pace without jumping the phase: drive motion with it, never
   * with `time * motion`.
   */
  motionTime: number;
  /** The lab's motion amount 0..1 (the shader's `uMotion`). */
  motion: number;
  /**
   * Wall time of this frame in milliseconds, on performance.now()'s origin: the renderer's
   * requestAnimationFrame timestamp (a check's held clock under test, HeadlessSim's own). It runs on
   * while the scene is paused or frozen. Pace real-time work by it (the time between frames, a knob
   * resting before a relayout, an upload rate), never by performance.now(), so a held clock holds
   * the sim too.
   */
  now: number;
  /**
   * Milliseconds this frame may block on budgeted work (warm-ups, builds, paints: hand it to
   * `runBudgeted`, sims/clock.ts). The renderer grants a share of the time between frames, from 8 ms
   * on a fast display to 120 ms on a slow one; HeadlessSim grants Infinity, so every warm-up ends in
   * its first frame. A scene may raise it for a first build (`Math.max(floor, frame.budget)`).
   */
  budget: number;
  /** Frame size in dither cells. */
  width: number;
  height: number;
  /** width / height. */
  aspect: number;
  /** The scene's knobs as the shader sees them, in `params` order (uParams). */
  values: readonly number[];
  /** The scene's raw knobs, keyed as in the URL (features also carry `<key>-amount`). */
  params: Readonly<Record<string, number>>;
  /**
   * The phases of the scene's rate knobs (ParamDef.rate, src/rate-phase.ts) by knob key, as the
   * shader's `PHASE_<key>`: `phases.cycle` the days its day cycle has run, say. Drive a rate knob's
   * motion with its phase, never with `value × motionTime`. The renderer rewrites it in place each
   * frame: read it, don't keep it. Absent (hand-built frames in tests) means every phase is 0.
   */
  phases?: Readonly<Record<string, number>>;
  /** Scene-clock time each trigger slot last fired; -1e4 while idle. */
  triggers: readonly number[];
  /**
   * The motion clock (`motionTime`) when each trigger slot last fired (the shader's
   * `uMotionTriggers`), for a response that plays at the motion's pace: its age is `motionTime -
   * motionTriggers[slot]` while `triggers[slot]` is not idle. The renderer rewrites it in place each
   * frame: read it, don't keep it. Absent (hand-built frames in tests) means every slot is idle.
   */
  motionTriggers?: readonly number[];
  /**
   * Per trigger slot (MAX_TRIGGERS long): true on the one frame after the slot was stamped by a
   * "now" press, i.e. `triggers[slot]` moved to a new time since this sim's previous frame (several
   * presses between two frames fire once; a second press while paused, at the same stamp, does not
   * fire again, matching the shader's `sinceTrigger`). Always false on a sim's first frame. Leaving a
   * scene resets its stamps to idle and re-entering builds a fresh sim, so presses from an earlier
   * visit never replay. The renderer rewrites this array in place each frame: read it, don't keep it.
   */
  fired: readonly boolean[];
  /** The visitor: principal 0, `principals[0]`, for what follows one hand only (a drag, a gaze). */
  pointer: PrincipalState;
  /**
   * Everyone present, at most MAX_PRINCIPALS (src/principals.ts): the visitor first (`pointer`),
   * then the agents of the cast, as the shader's `uPrincipals` holds them. React to every one of
   * them where many hands are natural (each a wave source, a lantern, a breath on the glass); keep
   * to `pointer` where the scene follows one hand (a drag of the view, a magnet, a gaze). The
   * renderer rewrites the list and its principals in place each frame: read them, don't keep them.
   */
  principals: readonly PrincipalState[];
  /**
   * The smoothed pointer parallax, as the shader's `uPointer`: -1..1 across the window each way,
   * easing toward the pointer, 0 while the lab does not follow it. A sim that casts the pointer
   * through a camera the shader turns or shifts with `uPointer` does the same with this. The
   * renderer rewrites it in place each frame: read it, don't keep it. Absent (hand-built frames in
   * tests) means no parallax.
   */
  parallax?: Readonly<{ x: number; y: number }>;
  /**
   * How far the scene has come in (`enter`, 0→1 over `SceneDef.passage.enter` seconds of real time,
   * then 1; always 1 when passages are off) and gone out (`exit`, 0 until it leaves, then 0→1), as
   * the shader's `passageIn()` and `passageOut()`. A sim is built afresh for every entrance, and
   * during a passage it runs ahead off screen while the leaving scene exits: those frames have
   * `enter` 0 and `dt` 0, for building and prewarming without starting any clock. A clock keyed to
   * `time` or wall time should start once `enter` is above 0.
   */
  passage: Readonly<ScenePassageProgress>;
}

export interface ScenePassageProgress {
  enter: number;
  exit: number;
}

/**
 * A CPU-side simulation or data source feeding the scene's shader through up to four textures,
 * bound as `uSim0`..`uSim3` (with `uSimOn.x`..`.w` set to 1 for each texture returned).
 */
export interface SceneSim {
  /** Advance and (re)upload; return the textures to bind this frame, in slot order. */
  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[];
  /**
   * False while the sim is still building what it shows (over several frames, showing nothing of
   * it until done). A passage runs the incoming sim ahead until it is true before its exit starts,
   * so the scene enters with its world in place. Absent: always ready.
   */
  ready?(): boolean;
  /**
   * Where a press does something here, in scene uv for a frame of `aspect`: the points the cast's
   * agents go to and act at (src/principals.ts), asked as one sets off for its next. Absent or
   * empty: they wander the middle of the frame and act wherever they stop.
   */
  interest?(aspect: number): readonly ScenePoint[];
  /** Release GL resources; called when the lab leaves the scene. */
  dispose(): void;
}

export type SimFactory = (gl: WebGL2RenderingContext) => SceneSim;

/**
 * A scene's code: its `code.ts`, loaded the first time the scene is needed (shown, the next step of
 * a tour, a passage's incoming scene, or fetched ahead at idle) through `SceneDef.code`.
 */
export interface SceneCode {
  /** GLSL defining the entry function (and any helpers, prefixed with the scene id). */
  glsl: string;
  /** Name of `Shade <entry>(vec2 uv, vec2 cell, float t)`. */
  entry: string;
  /**
   * A composed scene's GLSL for one feature set (its layer set): replaces `glsl` when present
   * (src/composer/compose.ts).
   */
  glslFor?: (features: Readonly<Record<string, number>>) => string;
  sim?: SimFactory;
}

/** What the registry knows of a scene before its code is loaded; see the header. */
export interface SceneDef {
  /** URL and registry id: lowercase letters only. */
  id: string;
  /** Lab card. */
  title: string;
  blurb: string;
  /** Lab dot and the default accent colour for the 'accent' palette. */
  accent: string;
  look?: SceneLook;
  /** Knobs, in uParams order. At most MAX_PARAMS. */
  params: readonly ParamDef[];
  /** Lab section headings, keyed by ParamDef.group. */
  groups: Readonly<Record<string, Blurb>>;
  /** The scene's code, loaded on first need: `() => import("./code.ts")`. */
  code: () => Promise<SceneCode>;
  /** Page theme behind the copy; night unless the scene says otherwise. */
  theme?: SceneTheme;
  /**
   * Seconds the scene's own entrance and exit take, when it choreographs them (read through
   * `passageIn()` / `passageOut()` or `SimFrame.passage`). Every entrance also takes the screen over
   * from the leaving scene, still playing its exit, over the lab's blend length (1.5 s by default);
   * without this the blend is the whole entrance and there is no exit.
   */
  passage?: { enter: number; exit: number };
  /**
   * Compile-time capabilities of the shared libraries this scene composes, as `NAME: integer`
   * (`#define NAME n` ahead of the libraries): a capability no scene selects is not compiled at all.
   * Names and meanings: the "Composing components" section of src/scenes/README.md.
   */
  features?: Readonly<Record<string, number>>;
  /**
   * Compile-time features keyed by the knobs (merged over `features`): from every knob as the shader
   * reads it (`K_<key>`, keyed by knob key), the defines this setting needs, so code behind a knob
   * that is off is not in the program at all (a software rasteriser runs every line of a program,
   * taken or not). The program a scene enters with is built for its setting; on a GPU a knob
   * change that needs another set draws with the scene's one all-features program (`featuresAll`),
   * built once in the background, instead of building a program per set (a software rasteriser
   * builds the set's own, in the background). A gate holds wherever its knobs can show the part
   * (`K_x > 0.0` in GLSL: `x > 0` here), and the shader keeps its own runtime test of the knobs
   * inside it. Name each gate and define it 0 or 1 every time, tested with `#if`; a library feature
   * tested with `#ifdef` is left out instead. See "Composing components" in src/scenes/README.md.
   */
  featuresFor?: (values: Readonly<Record<string, number>>) => Readonly<Record<string, number>>;
  /**
   * Required with `featuresFor` (merged over `features`): every gate it can turn on, on, and each
   * tier at the highest it can select. Its program must draw every setting byte for byte as that
   * setting's own program does: the shader's runtime tests of the knobs inside the gates decide.
   */
  featuresAll?: Readonly<Record<string, number>>;
  /**
   * The planets its night sky can hang among its stars (src/scenes/planets.ts, drawn by the sky's
   * skyGiant, which the scene calls): an open list, empty to start, under one URL key, edited in the
   * Night sky section of this group, placed on a pad over this stretch of its sky. The list is
   * compiled in only while it holds a planet (the library gate SKY_PLANETS).
   */
  planets?: SkyPlanets;
}

/** A scene with its code loaded (the registry's `loadScene`): what its program and sim are built from. */
export type LoadedScene = SceneDef & SceneCode;

export type PageTheme = "night" | "paper";

/**
 * Picks the page theme from the scene's raw knobs (keyed as in the URL). Build it with `skyTheme` or
 * `paletteTheme` (atmosphere.ts); the shader reads the outcome with `pagePaper()`, never a copy of
 * the test.
 */
export type SceneTheme = (params: Readonly<Record<string, number>>) => PageTheme;
