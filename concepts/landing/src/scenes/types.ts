// The contract every scene module implements. A scene is one self-contained module under
// src/scenes/<id>/ exporting a SceneDef; the registry (src/scenes/index.ts) lists them in lab order.
//
// Shader: each scene compiles to its own WebGL2 program:
//   common preamble (uniforms, noise, dithering helpers, Shade)  — src/shaders/common.ts
//   + shared libraries (sky, weather, lightning, aurora)          — src/shaders/lib/
//   + one `#define K_<key> uParams[i]` per knob, generated from `params`
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
  pointer: PointerState;
}

/**
 * A CPU-side simulation or data source feeding the scene's shader through up to four textures,
 * bound as `uSim0`..`uSim3` (with `uSimOn.x`..`.w` set to 1 for each texture returned).
 */
export interface SceneSim {
  /** Advance and (re)upload; return the textures to bind this frame, in slot order. */
  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[];
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
  theme?: (params: Readonly<Record<string, number>>) => "night" | "paper";
}
