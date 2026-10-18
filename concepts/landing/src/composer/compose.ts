// A scene preset becomes a scene (README "Scene presets and keys", ADR 0062 D1): the scene id,
// card, thumbnail, tour step and links stay; its knobs, gates and layer metadata are generated from
// the composer's layers. `composeScene` gives the scene's metadata (`def`: everything a SceneDef
// holds but its code) and what its code is assembled from; the code itself (the GLSL per feature
// set and the composed sim, composer/code.ts) loads with the scene's `code.ts`, so the metadata
// carries none of it.
//
//   params            the World's knobs, the gusts' (gusts, gustRate), the time of year (season,
//                     the first offered layer's that has one) and the arrangement (seed), each
//                     offered layer's switch (on for the preset's home layers; group "layers", a
//                     `layer` widget), then each offered layer's knobs hung on its switch (`when`).
//                     A key another knob holds already is qualified `<layerId><Key>` (D2). Trigger
//                     slots: meteors 0, lightning 1, gusts 2, then the layers' in canonical order
//                     (a layer listing its own id in `triggers` numbers its switch's "now" first).
//                     The preset's values set the defaults.
//   featuresFor       the World's gates (with the climate where the season sets it: a season knob
//                     beside the World's snow), LAYER_<ID> for every offered layer (1 where
//                     placed), each placed layer's own gates (a gate another placed layer
//                     suppresses at 0), and every gate of an offered layer that is off at 0, so a
//                     chunk shared by several layers may test any of them with `#if`.
//   featuresAllFor    the same with every gate of the placed layers on: a layer set's all-features
//                     program.
//   structural        the layer switches: turning one builds another program.
//   layers            what the lab's Layers section reads (SceneLayers).
import { hasClimate } from "../climate.ts";
import { feature, range, seed, type Blurb, type ParamDef } from "../params.ts";
import type { SceneDef } from "../scenes/types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../scenes/world.ts";
import { COMPOSER_CAPS } from "./caps.ts";
import { admits, place, type Placement } from "./place.ts";
import type { ComposerId, LayerDef, Role, ScenePreset } from "./types.ts";

export class ComposeError extends Error {}

/** A scene's metadata: everything its SceneDef holds but its code module. */
export type SceneMeta = Omit<SceneDef, "code">;

/** A composer: its id and its layers in canonical order (the order they are placed in and paint in). */
export interface Composer {
  readonly id: ComposerId;
  readonly layers: readonly LayerDef[];
}

/** A composed scene's layers, for the lab's Layers section (src/lab/layers-model.ts). */
export interface SceneLayers {
  /** Offered by the preset's rig, canonical order: each one's switch key is its id. */
  readonly offered: readonly { readonly id: string; readonly title: string; readonly role: Role }[];
  /** The preset's own, on by default. */
  readonly home: readonly string[];
  /** What these raw knobs (keyed as in the URL) place: the layers kept, and why the others are not. */
  place(params: Readonly<Record<string, number>>): Placement;
  /** The knob of each layer's Manifold M, by layer id: the lab keeps one on. */
  readonly marks: Readonly<Record<string, string>>;
  /** Each layer's hosts (`requires`), by layer id. */
  readonly requires: Readonly<Record<string, readonly string[]>>;
  /** Each layer's exclusions, both ways, by layer id: the other layer and why. */
  readonly excludes: Readonly<
    Record<string, readonly { readonly layer: string; readonly why: string }[]>
  >;
}

/** A composed scene: its metadata, and what composer/code.ts assembles its code from. */
export interface ComposedScene {
  readonly def: SceneMeta;
  readonly preset: ScenePreset;
  /** The layers its rig offers, canonical order. */
  readonly offered: readonly LayerDef[];
  /** `LAYER_<ID>` gate names, and the layer id each turns on. */
  readonly gates: Readonly<Record<string, string>>;
  /** Every trigger slot by knob key: the World's, the gusts', each offered layer's. */
  readonly triggers: Readonly<Record<string, number>>;
  /** Each offered layer's view of the knobs: its own under their short keys, for its sim. */
  readonly shortParams: Readonly<Record<string, readonly ParamDef[]>>;
  /** The placement of the layers in `on` (ids switched on). */
  place(on: ReadonlySet<string>): Placement;
  /** The placement of the layers these raw knobs (keyed as in the URL) switch on. */
  placed(params: Readonly<Record<string, number>>): Placement;
  /** Each layer's GLSL as a program of these layers (on, canonical order) takes it: keys and its M. */
  rewrite(on: readonly LayerDef[]): (layer: LayerDef, glsl: string) => string;
}

/** The trigger slots of the World's two "now" buttons and the gusts'. */
export const WORLD_TRIGGERS = { meteors: 0, lightning: 1, gusts: 2 } as const;

/** The gate a layer's code compiles under. */
export function layerGate(id: string): string {
  return `LAYER_${id.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** The group every layer's Manifold M knob stands in: one section, whose M the composer keeps to one. */
export const MARK_GROUP = "manifold";

/** `key` qualified for `layer`: `<layerId><Key>` (README "Keys"). */
const qualified = (layer: string, key: string) =>
  `${layer}${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/** `def` with the preset's values (keyed as in the URL) as its defaults. */
function withValues(def: ParamDef, values: Readonly<Record<string, number>>): ParamDef {
  const value = values[def.key];
  const amount = values[`${def.key}-amount`];
  if (def.kind === "feature")
    return {
      ...def,
      ...(value === undefined ? {} : { on: value > 0.5 }),
      ...(amount === undefined ? {} : { value: amount }),
    };
  return value === undefined ? def : { ...def, value };
}

/**
 * The composer's own knobs beside the World's: the gusts, the time of year where a layer has one
 * (its `season`, keyed `season`), and the arrangement.
 */
function composerKnobs(season: ParamDef | undefined): ParamDef[] {
  return [
    feature(
      "wind",
      "gusts",
      "gusts",
      true,
      "strength",
      0.7,
      "Gusts sweeping across the land, one wind for everything in it: grass bows and shows its paler side, so each gust travels as a broad wave of light, and flowers, stalks and crowns sway as it reaches them. 'Now' sends a big one across the whole view.",
      { trigger: WORLD_TRIGGERS.gusts, widget: { kind: "gusts" } },
    ),
    range(
      "wind",
      "gustRate",
      "gust frequency",
      0.45,
      "How often a gust comes through: now and then to the left, one after another to the right.",
    ),
    ...(season === undefined ? [] : [season]),
    seed(
      "layers",
      "seed",
      "arrangement",
      "Where everything stands and grows, the lie of the land and the shapes of its clouds; re-seed for another view.",
    ),
  ];
}

/** Compose `preset` from `composer`'s layers (see the header). */
export function composeScene(composer: Composer, preset: ScenePreset): ComposedScene {
  if (preset.composer !== composer.id)
    throw new ComposeError(
      `preset ${preset.id} is for the ${preset.composer} composer, not ${composer.id}`,
    );
  const offered = composer.layers.filter(
    (layer) => layer.composers.includes(preset.composer) && admits(layer, preset.rig),
  );
  for (const id of preset.layers)
    if (!offered.some((layer) => layer.id === id))
      throw new ComposeError(`preset ${preset.id}: home layer ${id} is not offered by its rig`);
  for (const layer of offered)
    if ((layer.featuresFor === undefined) !== (layer.featuresAll === undefined))
      throw new ComposeError(`layer ${layer.id}: featuresFor and featuresAll come together`);
  const home = new Set(preset.layers);

  // Trigger slots and keys.
  const triggers: Record<string, number> = { ...WORLD_TRIGGERS };
  let slot = WORLD_TRIGGERS.gusts + 1;
  const world = worldKnobs({
    ...preset.world,
    meteors: { trigger: WORLD_TRIGGERS.meteors },
    lightning: WORLD_TRIGGERS.lightning,
    groups: { ...preset.world.groups, wind: "wind" },
  });
  const season = offered.find((layer) => layer.season !== undefined)?.season;
  if (season !== undefined && season.key !== "season")
    throw new ComposeError(`preset ${preset.id}: a layer's season knob is keyed ${season.key}`);
  const own = composerKnobs(season);
  const taken = new Set([...world, ...own].map((def) => def.key));
  const keys: Record<string, Record<string, string>> = {};
  const switches: ParamDef[] = [];
  const knobs: ParamDef[] = [];
  for (const layer of offered) {
    if (layer.switch.key !== layer.id)
      throw new ComposeError(`layer ${layer.id}: its switch must be keyed by its id`);
    if (taken.has(layer.id)) throw new ComposeError(`layer ${layer.id}: its id is a knob already`);
    taken.add(layer.id);
    const on = home.has(layer.id);
    const sw = layer.switch;
    const own = layer.triggers?.includes(layer.id) === true ? slot++ : undefined;
    if (own !== undefined) triggers[layer.id] = own;
    switches.push({
      ...(sw.kind === "feature" ? { ...sw, on } : { ...sw, value: on ? 1 : 0 }),
      group: "layers",
      steady: true,
      widget: { kind: "layer", role: layer.role },
      ...(own === undefined ? {} : { trigger: own }),
    });
    const map: Record<string, string> = {};
    for (const def of layer.params) {
      const key = taken.has(def.key) ? qualified(layer.id, def.key) : def.key;
      taken.add(key);
      map[def.key] = key;
      const trigger = layer.triggers?.includes(def.key) === true ? slot++ : undefined;
      if (trigger !== undefined) triggers[key] = trigger;
      knobs.push({
        ...def,
        key,
        when: def.when === undefined ? layer.id : (map[def.when] ?? def.when),
        ...(trigger === undefined ? {} : { trigger }),
      });
    }
    keys[layer.id] = map;
  }
  if (slot > COMPOSER_CAPS.triggers)
    throw new ComposeError(
      `preset ${preset.id}: ${slot} trigger slots, at most ${COMPOSER_CAPS.triggers}`,
    );
  const params = [...world, ...own, ...switches, ...knobs].map((def) =>
    withValues(def, preset.values),
  );
  if (params.length > COMPOSER_CAPS.params)
    throw new ComposeError(
      `preset ${preset.id}: ${params.length} knobs, at most ${COMPOSER_CAPS.params}`,
    );
  for (const key of Object.keys(preset.values))
    if (!params.some((def) => def.key === key || `${def.key}-amount` === key))
      throw new ComposeError(`preset ${preset.id}: its value ${key} names no knob`);
  const climate = hasClimate(params);

  const gates: Record<string, string> = Object.fromEntries(
    offered.map((layer) => [layerGate(layer.id), layer.id]),
  );
  const placeOn = (on: ReadonlySet<string>) => place(offered, preset, on);
  const placed = (values: Readonly<Record<string, number>>) =>
    placeOn(
      new Set(offered.filter((layer) => (values[layer.id] ?? 0) > 0).map((layer) => layer.id)),
    );
  /** A layer's values under its own keys (its knobs' qualified keys read back). */
  const ownValues = (layer: LayerDef, values: Readonly<Record<string, number>>) => {
    const map = keys[layer.id] ?? {};
    const out: Record<string, number> = { ...values };
    for (const [short, key] of Object.entries(map)) out[short] = values[key] ?? 0;
    return out;
  };
  /** The layer gates of the layers these values place, each placed layer's own (`each`), the rest 0. */
  const gatesOf = (
    values: Readonly<Record<string, number>>,
    each: (
      layer: LayerDef,
      values: Readonly<Record<string, number>>,
    ) => Readonly<Record<string, number>>,
  ) => {
    const placement = placed(values);
    const on = new Set(placement.layers.map((p) => p.layer.id));
    const out: Record<string, number> = {};
    for (const layer of offered) {
      out[layerGate(layer.id)] = on.has(layer.id) ? 1 : 0;
      if (on.has(layer.id)) Object.assign(out, each(layer, ownValues(layer, values)));
      else for (const gate of Object.keys(layer.featuresAll ?? {})) out[gate] = 0;
    }
    for (const { layer } of placement.layers)
      for (const rule of layer.suppresses ?? []) if (on.has(rule.layer)) out[rule.gate] = 0;
    return out;
  };

  const shortParams: Record<string, readonly ParamDef[]> = {};
  for (const layer of offered) {
    const back = Object.fromEntries(Object.entries(keys[layer.id] ?? {}).map(([s, q]) => [q, s]));
    shortParams[layer.id] = params.map((def) => {
      const short = back[def.key];
      return short === undefined ? def : { ...def, key: short };
    });
  }

  const groups: Record<string, Blurb> = {
    wind: {
      title: "Wind",
      shelf: "world",
      blurb:
        "Which way the wind blows, and the gusts it sends across the land: one wind for every layer.",
    },
    sky: worldGroups.sky,
    weather: worldGroups.weather,
    birds: worldGroups.birds,
    layers: {
      title: "Layers",
      blurb:
        "What stands in the view, by role: one backdrop, at most one ground, and dressings, covers and life over them; add or take away any, and re-seed the arrangement.",
      icon: "layers",
    },
    ...Object.fromEntries(
      // The Manifold M's group is every layer's (one M at a time): it stands under none of them.
      offered.flatMap((layer) =>
        Object.entries(layer.groups).map(([key, blurb]) => [
          key,
          key === MARK_GROUP ? blurb : { ...blurb, layer: layer.id },
        ]),
      ),
    ),
    ...preset.groups,
  };

  const marks: Record<string, string> = Object.fromEntries(
    offered.flatMap((layer) =>
      layer.mark === undefined ? [] : [[layer.id, keys[layer.id]?.[layer.mark] ?? layer.mark]],
    ),
  );

  /** A layer's GLSL in a program: its qualified keys, and its M off while an earlier layer's is on. */
  const rewrite = (on: readonly LayerDef[]) => (layer: LayerDef, glsl: string) => {
    let out = glsl;
    for (const [short, key] of Object.entries(keys[layer.id] ?? {}))
      if (short !== key)
        out = out
          .replace(new RegExp(`\\bK_${short}\\b`, "g"), `K_${key}`)
          .replace(new RegExp(`\\bTRIGGER_${short}\\b`, "g"), `TRIGGER_${key}`);
    const mark = marks[layer.id];
    const earlier = on
      .slice(0, on.indexOf(layer))
      .flatMap((other) => (marks[other.id] === undefined ? [] : [`K_${marks[other.id]} > 0.0`]));
    if (mark !== undefined && earlier.length > 0)
      out = out.replace(
        new RegExp(`\\bK_${mark}\\b`, "g"),
        `(${earlier.join(" || ")} ? 0.0 : K_${mark})`,
      );
    return out;
  };

  const excludes: Record<string, { layer: string; why: string }[]> = {};
  for (const layer of offered)
    for (const rule of layer.excludes ?? []) {
      (excludes[layer.id] ??= []).push(rule);
      (excludes[rule.layer] ??= []).push({ layer: layer.id, why: rule.why });
    }
  const layers: SceneLayers = {
    offered: offered.map((layer) => ({ id: layer.id, title: layer.title, role: layer.role })),
    home: preset.layers,
    place: placed,
    marks,
    requires: Object.fromEntries(offered.map((layer) => [layer.id, layer.requires ?? []])),
    excludes,
  };

  const def: SceneMeta = {
    id: preset.id,
    title: preset.title,
    blurb: preset.blurb,
    accent: preset.accent,
    ...(preset.look === undefined ? {} : { look: preset.look }),
    params,
    groups,
    ...(preset.planets === undefined ? {} : { planets: preset.planets }),
    ...(preset.passage === undefined ? {} : { passage: preset.passage }),
    ...(preset.theme === undefined ? {} : { theme: preset.theme(params) }),
    ...(preset.features === undefined ? {} : { features: preset.features }),
    featuresFor: (values) => ({
      ...worldFeatures(values, climate),
      ...gatesOf(values, (layer, v) => layer.featuresFor?.(v) ?? {}),
    }),
    featuresAllFor: (values) => ({
      ...WORLD_ALL,
      ...gatesOf(values, (layer) => layer.featuresAll ?? {}),
    }),
    structural: offered.map((layer) => layer.id),
    layers,
  };

  return {
    def,
    preset,
    offered,
    gates,
    triggers,
    shortParams,
    place: placeOn,
    placed,
    rewrite,
  };
}
