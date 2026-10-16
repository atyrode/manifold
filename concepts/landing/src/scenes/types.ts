// The contract every scene module implements. A scene is one self-contained module under
// src/scenes/<id>/ exporting a SceneDef; the registry (src/scenes/index.ts) lists them in lab order.
//
// Shader: each scene compiles to its own WebGL2 program:
//   common preamble (uniforms, noise, dithering helpers, Shade)   — src/shaders/common.ts
//   + one `#define <NAME> <n>` per compile-time feature, from `features` and `featuresFor(knobs)`
//   + one `#define K_<key> uParams[i]` per knob, generated from `params`, and `SKY_YEAR`, the
//     scene's year position for the climate (src/climate.ts; -1.0 without a season)
//   + shared libraries (sky, weather, surface, water, lightning, aurora, meteors) — src/shaders/lib/
//   + the scene's `glsl`, which defines `Shade <entry>(vec2 uv, vec2 cell, float t)`
//   + the dithering `main`, which calls the entry.
// `uv` is 0..1 with y up, `cell` is the dither cell (gl_FragCoord.xy), `t` the scene clock.
import type { Blurb, ParamDef } from "../params.ts";

/** Lab palette modes and quantisation a scene starts from. */
export interface SceneLook {
  color?: "accent" | "mono" | "full";
  /** Quantisation levels per channel, 2..6. */
  levels?: number;
}

/** The pointer, in scene uv (0..1, y up). */
export interface PointerState {
  x: number;
  y: number;
  /** Over the page (not over the lab or a page control). */
  inside: boolean;
  /** Primary button held. */
  down: boolean;
  /** Went down since the previous frame. */
  pressed: boolean;
  /** Went up since the previous frame. */
  released: boolean;
}

/** What a simulation sees each frame. */
export interface SimFrame {
  /** Seconds since the previous frame on the scene clock; 0 while paused or frozen. */
  dt: number;
  /** The scene clock (the shader's `uTime`). */
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
  /** Frame size in dither cells. */
  width: number;
  height: number;
  /** width / height. */
  aspect: number;
  /** The scene's knobs as the shader sees them, in `params` order (uParams). */
  values: readonly number[];
  /** The scene's raw knobs, keyed as in the URL (features also carry `<key>-amount`). */
  params: Readonly<Record<string, number>>;
  /** Scene-clock time each trigger slot last fired; -1e4 while idle. */
  triggers: readonly number[];
  /**
   * Per trigger slot (MAX_TRIGGERS long): true on the one frame after the slot was stamped by a
   * "now" press, i.e. `triggers[slot]` moved to a new time since this sim's previous frame (several
   * presses between two frames fire once; a second press while paused, at the same stamp, does not
   * fire again, matching the shader's `sinceTrigger`). Always false on a sim's first frame. Leaving a
   * scene resets its stamps to idle and re-entering builds a fresh sim, so presses from an earlier
   * visit never replay. The renderer rewrites this array in place each frame: read it, don't keep it.
   */
  fired: readonly boolean[];
  pointer: PointerState;
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
  /** Release GL resources; called when the lab leaves the scene. */
  dispose(): void;
}

export type SimFactory = (gl: WebGL2RenderingContext) => SceneSim;

export interface SceneDef {
  /** URL and registry id: lowercase letters only. */
  id: string;
  /** Lab card. */
  title: string;
  blurb: string;
  /** Lab dot and the default accent colour for the 'accent' palette. */
  accent: string;
  /** Attribution shown on the page, if the scene is after an existing work. */
  credit?: string;
  look?: SceneLook;
  /** Knobs, in uParams order. At most MAX_PARAMS. */
  params: readonly ParamDef[];
  /** Lab section headings, keyed by ParamDef.group. */
  groups: Readonly<Record<string, Blurb>>;
  /** GLSL defining the entry function (and any helpers, prefixed with the scene id). */
  glsl: string;
  /** Name of `Shade <entry>(vec2 uv, vec2 cell, float t)`. */
  entry: string;
  sim?: SimFactory;
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
}

export type PageTheme = "night" | "paper";

/**
 * Picks the page theme from the scene's raw knobs (keyed as in the URL). Build it with `skyTheme` or
 * `paletteTheme` (atmosphere.ts); the shader reads the outcome with `pagePaper()`, never a copy of
 * the test.
 */
export type SceneTheme = (params: Readonly<Record<string, number>>) => PageTheme;
