// The lab's state and its URL encoding. Global settings live in `LabState`; the current scene's
// knobs live in `Params` (a feature also stores `<key>-amount`), and a scene that takes planets
// (SceneDef.planets) keeps its list of them beside its knobs, under one URL key (`PLANETS_KEY`).
// URLs carry only non-defaults, and the version of the URL schema they are written in (`v`) only
// where they need it. Every setup enters through readSetup (a link, the lab's history, a preset, a
// comparison's other slot), which first brings an older link up to this build's schema
// (MIGRATIONS: outgrown keys set on what replaced them, a retired scene's links opened on its
// successor) and reports a scene the link names that this build does not have.
import { effective, readKnobs, readNumber } from "./params.ts";
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
import { COUNTRY_SEASONS } from "./scenes/country/season.ts";
import { sceneDefs, sceneIds, type SceneId } from "./scenes/index.ts";
import {
  decodePlanets,
  encodePlanets,
  GIANT_KEYS,
  GIANT_SWITCH,
  PLANETS_KEY,
  planetUniforms,
  readPlanet,
  type SkyPlanet,
} from "./scenes/planets.ts";

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
/** The URL key naming the schema a setup's keys are written in; a link without it is schema 1. */
export const VERSION_KEY = "v";
const reservedKeys: readonly string[] = [
  ...Object.keys(defaults),
  ...Object.values(sessionKeys),
  VERSION_KEY,
];

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

/** The lab's settings from a query in this build's URL schema (a link goes through readSetup). */
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

/** The scene's knobs from a query in this build's URL schema (a link goes through readSetup). */
export function readParams(scene: SceneId, query: URLSearchParams): Params {
  return readKnobs(sceneDefs[scene].params, (key) => query.get(key));
}

/**
 * The scene's planets (none for a scene without SceneDef.planets), from its PLANETS_KEY in a query
 * in this build's URL schema (a link goes through readSetup).
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
   * The scene the link names when this build has no scene of that id, nor one that took over its
   * links: the setup is then the default scene's, and the lab says so.
   */
  unknownScene: string | undefined;
}

/**
 * The setup a link holds (or a preset, a comparison's other slot, a step of the lab's history):
 * brought up to this build's URL schema from the one it names (`migrate`), then read.
 */
export function readSetup(
  query: URLSearchParams,
  chain: readonly Migration[] = MIGRATIONS,
): LinkSetup {
  const q = migrate(query, chain);
  const state = readState(q);
  const named = q.get("scene");
  return {
    state,
    params: readParams(state.scene, q),
    planets: readPlanets(state.scene, q),
    unknownScene: named === null || named === "" || named === state.scene ? undefined : named,
  };
}

// ---- the URL schema ---------------------------------------------------------------------------

/**
 * One change to the URL schema, as MIGRATIONS applies it to the links written before it. `since` is
 * the schema version the change made: a link of an earlier version needs the step, a link of that
 * one or a later one skips it. A step rewrites the link in place, as the steps before it left it.
 */
export type Migration =
  | {
      kind: "keys";
      since: number;
      /**
       * Rewrite outgrown keys; `scene` is the scene the link names at this point of the chain (the
       * default scene when it names none).
       */
      migrate: (q: URLSearchParams, scene: string) => void;
    }
  | {
      kind: "alias";
      since: number;
      /** A scene id this version retired: renamed, merged into another scene or removed. */
      from: string;
      /** The scene that opens its links: one of this build's, or one a later alias retired in turn. */
      to: string;
      /**
       * Move the retired scene's keys onto its successor's, before the scene key changes: rename
       * them, and set the successor's knobs whose defaults differ from what the retired scene
       * showed (a link leaves defaults out). Keys it leaves alone carry over as they are.
       */
      keys?: (q: URLSearchParams) => void;
    };

/**
 * Rename the outgrown key `old` to `key`, mapping its values (old value to new): a value the map
 * lists sets `key` unless the query sets it already, and `old` goes either way (so a value the map
 * does not list leaves the new knob at its default).
 */
export function renameKey(
  q: URLSearchParams,
  old: string,
  key: string,
  values: Readonly<Record<number, number>>,
): void {
  const raw = q.get(old);
  if (raw === null) return;
  q.delete(old);
  const value = raw === "" ? undefined : values[Number(raw)];
  if (value !== undefined && !q.has(key)) q.set(key, String(value));
}

/**
 * The night sky's one giant planet (GIANT_SWITCH and GIANT_KEYS, the knobs the sky scenes had
 * before their list), in a scene that takes planets: a link without a list whose giant is on gets
 * that giant as its one planet, its old keys read into the planet's; the old keys go either way.
 */
function giantToPlanets(q: URLSearchParams, scene: string): void {
  const id = sceneIds.find((candidate) => candidate === scene);
  const spec = id === undefined ? undefined : sceneDefs[id].planets;
  if (spec === undefined) return;
  if (!q.has(PLANETS_KEY) && Math.round(readNumber(q.get(GIANT_SWITCH), 0, 1, 0)) === 1) {
    const values: Record<string, number> = {};
    for (const [old, key] of Object.entries(GIANT_KEYS)) {
      const raw = q.get(old);
      const value = raw === null || raw === "" ? Number.NaN : Number(raw);
      if (Number.isFinite(value)) values[key] = value;
    }
    q.set(PLANETS_KEY, encodePlanets(spec, [readPlanet(spec, values)]));
  }
  q.delete(GIANT_SWITCH);
  for (const old of Object.keys(GIANT_KEYS)) q.delete(old);
}

/**
 * The URL schema's history, in order. A link without a version is schema 1: every link written
 * before versions, which may still use what schema 2 renamed. A change that would misread a link
 * already out is appended as a step of the next version; a shipped step is never edited, moved or
 * dropped, since links rely on it. See "Links and the URL schema" in src/scenes/README.md.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    kind: "keys",
    since: 2,
    // The countryside's season choice (0 summer, 1 harvest, 2 autumn) became the date of its year.
    migrate: (q, scene) => {
      if (scene !== "country") return;
      renameKey(q, "season", "date", {
        0: COUNTRY_SEASONS.summer,
        1: COUNTRY_SEASONS.harvest,
        2: COUNTRY_SEASONS.autumn,
      });
    },
  },
  // The night skies' one giant planet became the first of their planets.
  { kind: "keys", since: 2, migrate: giantToPlanets },
];

export class UrlSchemaError extends Error {}

/**
 * The URL schema this build reads and writes: its last step's version (steps run in version order,
 * checkMigrations), 1 without steps.
 */
export const URL_VERSION = MIGRATIONS.at(-1)?.since ?? 1;

/** The schema a query names: its VERSION_KEY as a whole number from 1, and 1 without one. */
function linkVersion(q: URLSearchParams): number {
  const raw = q.get(VERSION_KEY);
  const version = raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(version) && version >= 1 ? version : 1;
}

/**
 * A query brought up to the schema of `chain` from the one it names (its VERSION_KEY, dropped):
 * each step since that version, in order. A query of a later schema than the chain knows (a newer
 * build's link) passes as it is.
 */
export function migrate(
  query: URLSearchParams,
  chain: readonly Migration[] = MIGRATIONS,
): URLSearchParams {
  const from = linkVersion(query);
  const q = new URLSearchParams(query);
  q.delete(VERSION_KEY);
  for (const step of chain) {
    if (step.since <= from) continue;
    const scene = q.get("scene") ?? defaults.scene;
    switch (step.kind) {
      case "keys":
        step.migrate(q, scene);
        break;
      case "alias":
        if (scene !== step.from) break;
        step.keys?.(q);
        q.set("scene", step.to);
        break;
      default: {
        const unreachable: never = step;
        throw new UrlSchemaError(`landing: unknown URL migration ${String(unreachable)}`);
      }
    }
  }
  return q;
}

/**
 * The scene of this build that opens links naming `id`: that scene, or the one the aliases of
 * `chain` lead to from a retired id, whatever the link's schema (a retired id never names a scene
 * again). Undefined for an id that is neither.
 */
export function resolveScene(
  id: string,
  chain: readonly Migration[] = MIGRATIONS,
): SceneId | undefined {
  let named = id;
  for (const step of chain) if (step.kind === "alias" && step.from === named) named = step.to;
  return sceneIds.find((scene) => scene === named);
}

/**
 * Throws UrlSchemaError unless `chain` runs in version order from 2 and each alias retires, once, an
 * id that names no scene of this build, for a successor that leads to one.
 */
export function checkMigrations(chain: readonly Migration[]): void {
  let since = 2;
  for (const step of chain) {
    if (!Number.isInteger(step.since) || step.since < since) {
      throw new UrlSchemaError(
        `landing: a URL migration of schema ${step.since} after ${since}: steps run in order from 2`,
      );
    }
    since = step.since;
    if (step.kind !== "alias") continue;
    const { from, to } = step;
    if (sceneIds.some((id) => id === from))
      throw new UrlSchemaError(`landing: "${from}" names a scene, so no alias may retire it`);
    if (chain.filter((other) => other.kind === "alias" && other.from === from).length > 1)
      throw new UrlSchemaError(`landing: "${from}" is retired twice`);
    if (resolveScene(to, chain) === undefined)
      throw new UrlSchemaError(`landing: the alias retiring "${from}" leads to no scene ("${to}")`);
  }
}

checkMigrations(MIGRATIONS);

/**
 * A query in the schema of `chain` (without a version), with its version where it needs one: a
 * query that a reader taking it for schema 1, as it takes every link without a version, would
 * rewrite (`migrate`) leads with VERSION_KEY; any other goes without, so a link stays as it was
 * written before versions until a change of schema touches what it holds.
 */
export function withVersion(
  query: URLSearchParams,
  chain: readonly Migration[] = MIGRATIONS,
): URLSearchParams {
  if (migrate(query, chain).toString() === query.toString()) return query;
  return new URLSearchParams([[VERSION_KEY, String(chain.at(-1)?.since ?? 1)], ...query]);
}

/**
 * Minimal query: only values that differ from their defaults, the scene's planets (when it has any)
 * last, packed under PLANETS_KEY, and the schema's version first where the setup needs it
 * (withVersion).
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
  return withVersion(q);
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
    view: state.view,
    passage: state.transitions === "on",
    overlap: state.overlap,
    weave: state.weave,
    blend: state.blend,
    slowmo: state.slowmo,
  };
}
