// The lab's state and its URL encoding. Global settings live in `LabState`; the current scene's
// knobs live in `Params` (a feature also stores `<key>-amount`). URLs carry only non-defaults.
import { effective, MAX_SEED } from "./params.ts";
import {
  colorIds,
  ditherIds,
  viewIds,
  type ColorId,
  type DitherId,
  type RenderSettings,
  type ViewId,
} from "./renderer.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";

export const modeIds = ["landing", "loading", "instance", "bare"] as const;
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
  view: ViewId;
  /** 0..1: darken the scene behind the page, to judge the copy's legibility. */
  dim: number;
  /** 0..1: soften the scene behind the page. */
  blur: number;
  /** Whether scenes enter and leave with their passages, or cut. */
  transitions: PassageId;
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
  view: "dithered",
  dim: 0,
  blur: 0,
  transitions: "on",
};

export class KnobKeyError extends Error {}

/**
 * URL keys of the lab's session tools, kept beside the setup and never inside it, so presets and
 * undo steps stay setups: an A/B comparison (`compare.ts`, which also prefixes the hidden slot's
 * keys with `a.` or `b.`) and a scene tour (`tour.ts`). The page's URL and "copy link" carry both.
 */
export const sessionKeys = { compare: "compare", tour: "tour", dwell: "dwell" } as const;
const reservedKeys: readonly string[] = [...Object.keys(defaults), ...Object.values(sessionKeys)];

// Scene knobs share the URL with the lab's own settings, so no knob may take one of their names.
for (const id of sceneIds) {
  for (const def of sceneDefs[id].params) {
    if (reservedKeys.includes(def.key) || reservedKeys.includes(`${def.key}-amount`)) {
      throw new KnobKeyError(
        `landing: ${id}'s knob "${def.key}" collides with the lab setting of that name`,
      );
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

function readNumber(value: string | null, min: number, max: number, fallback: number): number {
  const n = value === null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readState(q: URLSearchParams): LabState {
  const accent = q.get("accent") ?? "";
  const scene = pick(sceneIds, q.get("scene"), defaults.scene);
  const base = defaultsFor(scene);
  return {
    scene,
    mode: pick(modeIds, q.get("mode"), defaults.mode),
    dither: pick(ditherIds, q.get("dither"), defaults.dither),
    color: pick(colorIds, q.get("color"), base.color),
    pixel: readNumber(q.get("pixel"), 1, 8, defaults.pixel),
    levels: readNumber(q.get("levels"), 2, 6, base.levels),
    motion: readNumber(q.get("motion"), 0, 1, defaults.motion),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : "",
    instance: (q.get("instance") ?? "").trim().slice(0, 40) || defaults.instance,
    mouse: pick(mouseIds, q.get("mouse"), defaults.mouse),
    view: pick(viewIds, q.get("view"), defaults.view),
    dim: readNumber(q.get("dim"), 0, 1, defaults.dim),
    blur: readNumber(q.get("blur"), 0, 1, defaults.blur),
    transitions: pick(passageIds, q.get("transitions"), defaults.transitions),
  };
}

export function readParams(scene: SceneId, q: URLSearchParams): Params {
  const out: Params = {};
  for (const def of sceneDefs[scene].params) {
    switch (def.kind) {
      case "range":
        out[def.key] = readNumber(q.get(def.key), def.min, def.max, def.value);
        break;
      case "toggle":
        out[def.key] = Math.round(readNumber(q.get(def.key), 0, 1, def.value));
        break;
      case "feature": {
        out[def.key] = Math.round(readNumber(q.get(def.key), 0, 1, def.on ? 1 : 0));
        const amount = readNumber(q.get(`${def.key}-amount`), def.min, def.max, def.value);
        out[`${def.key}-amount`] =
          def.options?.some((option) => option.value === amount) === false ? def.value : amount;
        break;
      }
      case "choice": {
        const raw = q.get(def.key);
        const value = raw === null || raw === "" ? Number.NaN : Number(raw);
        out[def.key] = def.options.some((option) => option.value === value) ? value : def.value;
        break;
      }
      case "seed":
        out[def.key] = Math.round(readNumber(q.get(def.key), 0, MAX_SEED, def.value));
        break;
      default: {
        const unreachable: never = def;
        throw new Error(`landing: unknown knob ${String(unreachable)}`);
      }
    }
  }
  // Migrate previously saved countryside selector URLs on read; serialization writes only weights.
  // Explicit new weights win, even when all zero. Pinned historical builds keep the old renderer.
  if (
    scene === "country" &&
    q.has("fieldType") &&
    !["crops", "wildflowers", "lavender", "sunflowers"].some((key) => q.has(key))
  ) {
    const type = q.get("fieldType");
    if (type === "1" || type === "2" || type === "3") {
      out.crops = 0;
      const key = type === "1" ? "wildflowers" : type === "2" ? "lavender" : "sunflowers";
      out[key] = 100;
    } else if (type === "4") {
      Object.assign(out, { crops: 30, wildflowers: 28, lavender: 22, sunflowers: 20 });
    }
  }
  return out;
}

/** Each knob's default, keyed as readParams keys them. */
export function paramDefaults(scene: SceneId): Params {
  return readParams(scene, new URLSearchParams());
}

/** Minimal query: only values that differ from their defaults. */
export function serialise(state: LabState, params: Params): URLSearchParams {
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
  return q;
}

export function renderSettings(state: LabState, params: Params): RenderSettings {
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
    followPointer: state.mouse === "follow",
    view: state.view,
    passage: state.transitions === "on",
  };
}
