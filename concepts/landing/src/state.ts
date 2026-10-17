// The lab's state and its URL encoding. Global settings live in `LabState`; the current scene's
// knobs live in `Params` (a feature also stores `<key>-amount`), and a scene that takes planets
// (SceneDef.planets) keeps its list of them beside its knobs, under one URL key (`PLANETS_KEY`).
// URLs carry only non-defaults. Every setup enters through readSetup (a link, the lab's history, a
// preset, a comparison's other slot), which reads this build's keys, ignores any other and reports
// a scene the link names that this build does not have.
import { effective, readKnobs, readNumber } from "./params.ts";
import { MAX_AGENTS } from "./principals.ts";
import {
  blendIds,
  colorIds,
  ditherIds,
  viewIds,
  type BlendId,
  type ColorId,
  type DitherId,
  type RenderSettings,
  type ViewId,
} from "./renderer.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import {
  decodePlanets,
  encodePlanets,
  PLANETS_KEY,
  planetUniforms,
  type SkyPlanet,
} from "./scenes/planets.ts";

export const modeIds = ["landing", "loading", "instance"] as const;
export type ModeId = (typeof modeIds)[number];
export const mouseIds = ["follow", "still"] as const;
export type MouseId = (typeof mouseIds)[number];
export const passageIds = ["on", "off"] as const;
export type PassageId = (typeof passageIds)[number];

export type Params = Record<string, number>;

export interface LabState {
  scene: SceneId;
  mode: ModeId;
  dither: DitherId;
  color: ColorId;
  pixel: number;
  levels: number;
  motion: number;
  /** Empty means the scene's own accent. */
  accent: string;
  instance: string;
  /** Whether the scene parallaxes toward the pointer. */
  mouse: MouseId;
  /** Agents of the cast present beside the visitor, 0..MAX_AGENTS (src/principals.ts). */
  agents: number;
  view: ViewId;
  /** 0..1: darken the scene behind the page, to judge the copy's legibility. */
  dim: number;
  /** 0..1: soften the scene behind the page. */
  blur: number;
  /** Whether scenes enter and leave with their passages, or cut. */
  transitions: PassageId;
  /** 0..1: how much of the outgoing scene's exit the incoming scene's entrance overlaps. */
  overlap: number;
  /** Seconds over which the incoming scene takes over from the outgoing one. */
  weave: number;
  /** The order in which cells change over to the incoming scene. */
  blend: BlendId;
  /** How many times slower than real time passages play, to study them. */
  slowmo: number;
}

export const defaults: LabState = {
  scene: "pond",
  mode: "landing",
  dither: "bayer8",
  color: "accent",
  pixel: 2,
  levels: 2,
  motion: 0.6,
  accent: "",
  instance: "tyrode",
  mouse: "follow",
  agents: 0,
  view: "dithered",
  dim: 0,
  blur: 0,
  transitions: "on",
  overlap: 0.5,
  weave: 1.5,
  blend: "bloom",
  slowmo: 1,
};

export class KnobKeyError extends Error {}

/**
 * URL keys of the lab's session tools, kept beside the setup and never inside it, so presets and
 * undo steps stay setups: an A/B comparison (`compare.ts`, which also prefixes the hidden slot's
 * keys with `a.` or `b.`) and a scene tour (`tour.ts`). The page's URL and "copy link" carry both.
 */
export const sessionKeys = { compare: "compare", tour: "tour", dwell: "dwell" } as const;
const reservedKeys: readonly string[] = [...Object.keys(defaults), ...Object.values(sessionKeys)];

// Scene knobs share the URL with the lab's own keys, so no knob may take one of their names; nor, in
// a scene that takes planets, the planets' key.
for (const id of sceneIds) {
  const scene = sceneDefs[id];
  for (const def of scene.params) {
    if (reservedKeys.includes(def.key) || reservedKeys.includes(`${def.key}-amount`)) {
      throw new KnobKeyError(
        `landing: ${id}'s knob "${def.key}" collides with the lab's URL key of that name`,
      );
    }
    if (scene.planets !== undefined && def.key === PLANETS_KEY) {
      throw new KnobKeyError(`landing: ${id}'s knob "${def.key}" collides with its planets`);
    }
  }
}

/** The defaults that apply to a scene: the global ones with its own look on top. */
export function defaultsFor(scene: SceneId): LabState {
  const look = sceneDefs[scene].look;
  return {
    ...defaults,
    scene,
    color: look?.color ?? defaults.color,
    levels: look?.levels ?? defaults.levels,
  };
}

/** Keep a look knob following the scene's own default unless it was deliberately changed. */
export function carryLook(state: LabState, scene: SceneId): LabState {
  const from = defaultsFor(state.scene);
  const to = defaultsFor(scene);
  return {
    ...state,
    scene,
    color: state.color === from.color ? to.color : state.color,
    levels: state.levels === from.levels ? to.levels : state.levels,
  };
}

export interface Palette {
  bg: string;
  ink: string;
  muted: string;
  line: string;
}

const NIGHT: Palette = {
  bg: "#07080b",
  ink: "#e8e6df",
  muted: "#8b8a85",
  line: "rgb(232 230 223 / 0.14)",
};
/** The "paper" theme, for scenes in daylight or drawn on paper: a warm paper page with dark ink. */
const PAPER: Palette = {
  bg: "#ebe2cc",
  ink: "#1b2235",
  muted: "#5d5a52",
  line: "rgb(27 34 53 / 0.18)",
};

export function palette(state: LabState, params: Params): Palette {
  return sceneDefs[state.scene].theme?.(params) === "paper" ? PAPER : NIGHT;
}

export function accentOf(state: LabState): string {
  return state.accent || sceneDefs[state.scene].accent;
}

function pick<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

/** The lab's settings from a query. */
export function readState(q: URLSearchParams): LabState {
  const accent = q.get("accent") ?? "";
  const scene = pick(sceneIds, q.get("scene"), defaults.scene);
  const base = defaultsFor(scene);
  return {
    scene,
    mode: pick(modeIds, q.get("mode"), defaults.mode),
    dither: pick(ditherIds, q.get("dither"), defaults.dither),
    color: pick(colorIds, q.get("color"), base.color),
    // A fraction of a CSS px still means something: the display rounds `pixel` times the device
    // pixel ratio to whole device pixels (display.ts `stageCells`).
    pixel: readNumber(q.get("pixel"), 1, 8, defaults.pixel),
    // Tones are a count: between two, the nearer.
    levels: Math.round(readNumber(q.get("levels"), 2, 6, base.levels)),
    motion: readNumber(q.get("motion"), 0, 1, defaults.motion),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : "",
    instance: (q.get("instance") ?? "").trim().slice(0, 40) || defaults.instance,
    mouse: pick(mouseIds, q.get("mouse"), defaults.mouse),
    // A count: between two, the nearer.
    agents: Math.round(readNumber(q.get("agents"), 0, MAX_AGENTS, defaults.agents)),
    view: pick(viewIds, q.get("view"), defaults.view),
    dim: readNumber(q.get("dim"), 0, 1, defaults.dim),
    blur: readNumber(q.get("blur"), 0, 1, defaults.blur),
    transitions: pick(passageIds, q.get("transitions"), defaults.transitions),
    overlap: readNumber(q.get("overlap"), 0, 1, defaults.overlap),
    weave: readNumber(q.get("weave"), 0.3, 4, defaults.weave),
    blend: pick(blendIds, q.get("blend"), defaults.blend),
    slowmo: readNumber(q.get("slowmo"), 1, 8, defaults.slowmo),
  };
}

/** The scene's knobs from a query. */
export function readParams(scene: SceneId, query: URLSearchParams): Params {
  return readKnobs(sceneDefs[scene].params, (key) => query.get(key));
}

/**
 * The scene's planets (none for a scene without SceneDef.planets), from its PLANETS_KEY in a query.
 */
export function readPlanets(scene: SceneId, query: URLSearchParams): SkyPlanet[] {
  const spec = sceneDefs[scene].planets;
  return spec === undefined ? [] : decodePlanets(spec, query.get(PLANETS_KEY) ?? "");
}

/** Each knob's default, keyed as readParams keys them. */
export function paramDefaults(scene: SceneId): Params {
  return readParams(scene, new URLSearchParams());
}

/** A setup: the lab's settings, the scene's knobs and its planets. */
export interface Setup {
  state: LabState;
  params: Params;
  planets: SkyPlanet[];
}

/** A setup as a link holds it (readSetup). */
export interface LinkSetup extends Setup {
  /**
   * The scene the link names when this build has no scene of that id: the setup is then the
   * default scene's, and the lab says so.
   */
  unknownScene: string | undefined;
}

/**
 * The setup a link holds (or a preset, a comparison's other slot, a step of the lab's history), in
 * this build's keys: any other key is ignored, and a scene this build lacks opens the default one.
 */
export function readSetup(query: URLSearchParams): LinkSetup {
  const state = readState(query);
  const named = query.get("scene");
  return {
    state,
    params: readParams(state.scene, query),
    planets: readPlanets(state.scene, query),
    unknownScene: named === null || named === "" || named === state.scene ? undefined : named,
  };
}

/**
 * Minimal query: only values that differ from their defaults, the scene's planets (when it has any)
 * last, packed under PLANETS_KEY.
 */
export function serialise(
  state: LabState,
  params: Params,
  planets: readonly SkyPlanet[],
): URLSearchParams {
  const q = new URLSearchParams();
  const base = defaultsFor(state.scene);
  // The scene leads, so readers know which scene's defaults the rest is relative to.
  if (state.scene !== defaults.scene) q.set("scene", state.scene);
  for (const key of Object.keys(defaults) as (keyof LabState)[]) {
    if (key !== "scene" && state[key] !== base[key]) q.set(key, String(state[key]));
  }
  const fallback = paramDefaults(state.scene);
  for (const [key, value] of Object.entries(params)) {
    if (value !== fallback[key]) q.set(key, String(value));
  }
  const spec = sceneDefs[state.scene].planets;
  if (spec !== undefined && planets.length > 0) q.set(PLANETS_KEY, encodePlanets(spec, planets));
  return q;
}

/** What the renderer draws for a setup; a sky without planets unless `planets` names some. */
export function renderSettings(
  state: LabState,
  params: Params,
  planets: readonly SkyPlanet[] = [],
): RenderSettings {
  const colours = palette(state, params);
  return {
    scene: state.scene,
    dither: state.dither,
    color: state.color,
    pixel: state.pixel,
    levels: state.levels,
    motion: state.motion,
    bg: colours.bg,
    ink: colours.ink,
    accent: accentOf(state),
    params: sceneDefs[state.scene].params.map((def) => effective(def, params)),
    knobs: params,
    planets: planetUniforms(planets),
    followPointer: state.mouse === "follow",
    agents: state.agents,
    view: state.view,
    passage: state.transitions === "on",
    overlap: state.overlap,
    weave: state.weave,
    blend: state.blend,
    slowmo: state.slowmo,
  };
}
