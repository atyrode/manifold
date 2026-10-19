// A scene preset becomes a scene (README "Scene presets and keys", ADR 0062 D1): the scene id,
// card, thumbnail, tour step and links stay; its knobs, gates and layer metadata are generated from
// the composer's layers. `composeScene` gives the scene's metadata (`def`: everything a SceneDef
// holds but its code) and what its code is assembled from; the code itself (the GLSL per feature
// set and the composed sim, composer/code.ts) loads with the scene's `code.ts`, so the metadata
// carries none of it. A curated variant becomes its scene preset first (`variantPreset`): its
// differences over its composer's baseline (ADR 0062 "Baselines and variants").
//
//   params            the World's knobs, the gusts' (gusts, gustRate), the time of year (season,
//                     the first offered layer's that has one) and the arrangement (seed), each
//                     offered layer's switch (on for the preset's home layers; group "layers", a
//                     `layer` widget), then each offered layer's knobs hung on its switch (`when`).
//                     A key another knob holds already is qualified `<layerId><Key>` (D2). Trigger
//                     slots: meteors 0, lightning 1, gusts 2, then the layers' in canonical order
//                     (a layer listing its own id in `triggers` numbers its switch's "now" first).
//                     The preset's values set the defaults. A room (the `interior` composer)
//                     lists the World's knobs but its birds only while it offers a window, no
//                     gusts, season or seed; its layers' slots follow the World's two while it
//                     lists the World and start at 0 while it lists none (no slot is held for a
//                     knob the preset does not list). At most COMPOSER_CAPS.params knobs
//                     (`checkKnobCaps`).
//   knobsFor          the knobs a program reads: the composer's (the World's and its own) and
//                     the switch and knobs of each layer its LAYER_<ID> gates turn on; with any
//                     other knob its code names, only those take a slot in its `uParams`
//                     (shaders/index.ts `knobSlots`). The composer's and its COMPOSER_CAPS.layers
//                     largest offered layers' at most COMPOSER_CAPS.programParams (`checkKnobCaps`).
//   featuresFor       the World's gates (with the climate where the season sets it: a season knob
//                     beside the World's snow), LAYER_<ID> for every offered layer (1 where
//                     placed: in a room at the camera pose it is given), each placed layer's own
//                     gates (a gate another placed layer suppresses at 0), and every gate of an
//                     offered layer that is off at 0, so a chunk shared by several layers may test
//                     any of them with `#if`; a room's POSE_GATE (1 off the rest pose); TURNS_GATE
//                     at 0: a steady program, which plays no layer's own entrance or exit.
//   featuresAllFor    the same with every gate of the placed layers on, POSE_GATE in a room, and
//                     TURNS_GATE: a layer set's all-features program, which draws its layers' turns
//                     and any camera pose as well.
//   structural        the layer switches: turning one builds another program.
//   layers            what the lab's Layers section reads (SceneLayers).
//   camera            a room's (composer/camera.ts): the poses the shell and the layers placed
//                     hold, met (home layers that do not meet at the rest pose: a ComposeError).
// The overhead composer (overhead.ts) lists neither the whole World nor the gusts, season and seed:
// its presets list the World's rain and wind (worldPatchKnobs, the outdoor keys and meaning) while
// they offer a layer open to the sky (LayerDef.open), with WORLD_RAIN as their only World gate, then
// their layers' switches and knobs, their trigger slots from 0 (ADR 0062 "The World seen from every
// camera": the rest of the World over the patch is not built).
import { hasClimate } from "../climate.ts";
import { feature, range, seed, type Blurb, type ParamDef } from "../params.ts";
import type { SceneDef } from "../scenes/types.ts";
import {
  WORLD_ALL,
  worldFeatures,
  worldGroups,
  worldKnobs,
  worldPatchFeatures,
  worldPatchGroup,
  worldPatchKnobs,
} from "../scenes/world.ts";
import {
  AT_REST,
  atRest,
  clampPose,
  disjointAxis,
  layerPoseRange,
  meetRanges,
  shellPoseRange,
  type CameraPose,
  type PoseRange,
} from "./camera.ts";
import { COMPOSER_CAPS } from "./caps.ts";
import { checkElements, ElementError, LIGHT_CAP, roomListsWorld } from "./elements.ts";
import { admits, place, type Placement } from "./place.ts";
import type {
  AnyPreset,
  Baseline,
  ComposerId,
  LayerDef,
  Role,
  ScenePreset,
  Variant,
} from "./types.ts";

export class ComposeError extends Error {}

/** A scene's metadata: everything its SceneDef holds but its code module. */
export type SceneMeta = Omit<SceneDef, "code">;

/**
 * A composer: its id, its layers in canonical order (the order they are placed in and paint in) and
 * its baseline (ADR 0062 D13), which its variants are stored over: the interior's so far.
 */
export interface Composer {
  readonly id: ComposerId;
  readonly layers: readonly LayerDef[];
  readonly baseline?: Baseline;
}

/** A composed scene's layers, for the lab's Layers section (src/lab/layers-model.ts). */
export interface SceneLayers {
  /** Offered by the preset's rig, canonical order: each one's switch key is its id. */
  readonly offered: readonly { readonly id: string; readonly title: string; readonly role: Role }[];
  /** The preset's own, on by default. */
  readonly home: readonly string[];
  /**
   * What these raw knobs (keyed as in the URL) place at this camera pose (a room's: a guest out of
   * its range is refused): the layers kept, and why the others are not.
   */
  place(params: Readonly<Record<string, number>>, pose?: CameraPose): Placement;
  /** The knob of each layer's Manifold M, by layer id: the lab keeps one on. */
  readonly marks: Readonly<Record<string, string>>;
  /** Each layer's hosts (`requires`), by layer id. */
  readonly requires: Readonly<Record<string, readonly string[]>>;
  /** Each layer's exclusions, both ways, by layer id: the other layer and why. */
  readonly excludes: Readonly<
    Record<string, readonly { readonly layer: string; readonly why: string }[]>
  >;
}

/**
 * A composed scene: its metadata, and what composer/code.ts assembles its code from. `P`: its
 * preset's kind (an eye-level one, or one seen from above).
 */
export interface ComposedScene<P extends AnyPreset = AnyPreset> {
  readonly def: SceneMeta;
  readonly preset: P;
  /** The layers its rig offers, canonical order. */
  readonly offered: readonly LayerDef[];
  /** `LAYER_<ID>` gate names, and the layer id each turns on. */
  readonly gates: Readonly<Record<string, string>>;
  /** Every trigger slot by knob key: the World's, the gusts', each offered layer's. */
  readonly triggers: Readonly<Record<string, number>>;
  /**
   * Each offered layer's view of the knobs, for its sim: its own under their short keys, a knob of
   * another's that one of them shadows qualified by its holder, the rest under the scene's keys.
   */
  readonly shortParams: Readonly<Record<string, readonly ParamDef[]>>;
  /** The placement of the layers in `on` (ids switched on). */
  place(on: ReadonlySet<string>): Placement;
  /** The placement of the layers these raw knobs (keyed as in the URL) switch on, at a room's pose. */
  placed(params: Readonly<Record<string, number>>, pose?: CameraPose): Placement;
  /** Each layer's GLSL as a program of these layers (on, canonical order) takes it: keys and its M. */
  rewrite(on: readonly LayerDef[]): (layer: LayerDef, glsl: string) => string;
}

/** The trigger slots of the World's two "now" buttons and the gusts'. */
export const WORLD_TRIGGERS = { meteors: 0, lightning: 1, gusts: 2 } as const;

/** The gate a layer's code compiles under. */
export function layerGate(id: string): string {
  return `LAYER_${id.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/**
 * The gate of a program that plays its layers' own entrances and exits (composer/glsl.ts): 1 in the
 * program a layer turned on or off mid-scene plays its turn in (the composed sim asks the renderer
 * for it: SceneSim.turning) and in every all-features program, 0 in a steady one.
 */
export const TURNS_GATE = "COMPOSER_TURNS";

/**
 * The gate of a room's program drawn through a camera off its rest pose (composer/camera.ts): 1
 * where the pose (uCamera) moves, the shell drawn from the live ray and the painted layers pulled
 * back through it; 0 at rest, the room drawn from the rig as compiled. Moving the camera further
 * builds nothing; every all-features program holds it.
 */
export const POSE_GATE = "ROOM_POSE";

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

/**
 * A room's date (ADR 0062 D20): every room that lists the World lists it, at one anchor, the
 * interior baseline's (its default: SKY_DATE_ANCHOR stands the staged sky there), so the date moves
 * the sun through its windows; a variant pins its own through its values.
 */
const ROOM_DATE = range(
  "sky",
  "season",
  "date",
  0.62,
  "The day of the year, spring at the left end, then summer, autumn and winter: the sun stands higher and longer by summer, lower and shorter by winter, and its light through the room's windows moves with it.",
  { steady: true, widget: { kind: "sky", part: "season", year: { span: [0, 1] } } },
);

/**
 * The World's knobs a room without glass in frame lists (the light-only World): its clock, its moon,
 * the rain, the snow and the storm that close it over, the aurora's glow; neither its stars, its deck
 * nor its shooting stars, which no window shows.
 */
const LIGHT_ONLY_WORLD: Readonly<Record<string, true>> = {
  time: true,
  cycle: true,
  moon: true,
  rain: true,
  snow: true,
  lightning: true,
  aurora: true,
  wind: true,
};

/** The light-only World's gates: no shooting stars (no window shows them, no slot is held). */
const LIGHT_ONLY_GATES = { WORLD_METEORS: 0, WORLD_METEOR_RATE: 0 } as const;

/** The light-only World's all-features gates: every setting of its knobs, nothing else compiled. */
const LIGHT_ONLY_ALL = {
  ...worldFeatures(
    { time: 0, cycle: 1, aurora: 1, rain: 1, snow: 1, lightning: 1, moon: 0.5 },
    true,
  ),
  ...LIGHT_ONLY_GATES,
};

/**
 * A light-only room's values as its World reads them: the light-only World's knobs alone. A room
 * layer may hold a knob under a World key that is its own (the night line's `stars` and `fog`), and
 * that knob must not open the World's gate the light-only World never lists (LIGHT_ONLY_ALL).
 */
function lightOnlyValues(values: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => LIGHT_ONLY_WORLD[key]));
}

/**
 * The scene preset `variant` makes over `baseline` (ADR 0062 D14): the variant's identity; the
 * baseline's home layers less those it removes, then those it adds; the baseline's values under
 * its own; its camera's rest pose and its room for the baseline's; its grade key by key over the
 * baseline's; its light elements for the baseline's; the baseline's World, floor, meteors and
 * flyway. A variant over another composer's baseline is a ComposeError.
 */
export function variantPreset(baseline: Baseline, variant: Variant): ScenePreset {
  if (variant.base !== baseline.composer)
    throw new ComposeError(
      `variant ${variant.id} is over the ${variant.base} baseline, not the ${baseline.composer}`,
    );
  const remove = new Set(variant.layers?.remove);
  const room = variant.room ?? baseline.room;
  return {
    id: variant.id,
    title: variant.title,
    blurb: variant.blurb,
    accent: variant.accent,
    ...(variant.look === undefined ? {} : { look: variant.look }),
    ...(variant.theme === undefined ? {} : { theme: variant.theme }),
    ...(variant.passage === undefined ? {} : { passage: variant.passage }),
    ...(variant.planets === undefined ? {} : { planets: variant.planets }),
    ...(variant.groups === undefined ? {} : { groups: variant.groups }),
    composer: baseline.composer,
    rig: variant.camera ?? baseline.rig,
    ...(room === undefined ? {} : { room }),
    elements: variant.elements ?? baseline.elements,
    grade: { ...baseline.grade, ...variant.grade },
    world: baseline.world,
    meteors: baseline.meteors,
    flyway: baseline.flyway,
    floor: baseline.floor,
    ...(baseline.features === undefined ? {} : { features: baseline.features }),
    layers: [...baseline.layers.filter((id) => !remove.has(id)), ...(variant.layers?.add ?? [])],
    values: { ...baseline.values, ...variant.values },
  };
}

/**
 * The knob caps (ADR 0062 "Budgets and caps"): preset `preset` lists `listed` knobs, at most
 * COMPOSER_CAPS.params, and each of its programs reads the composer's `composer` knobs and those of
 * the layers it holds (`layers`: each offered layer's switch and knobs, by id), at most
 * COMPOSER_CAPS.layers of them: the composer's and its largest layers' bound every program, at
 * most COMPOSER_CAPS.programParams. Throws ComposeError past either.
 */
export function checkKnobCaps(
  preset: string,
  listed: number,
  composer: number,
  layers: Readonly<Record<string, number>>,
): void {
  if (listed > COMPOSER_CAPS.params)
    throw new ComposeError(`preset ${preset}: ${listed} knobs, at most ${COMPOSER_CAPS.params}`);
  const largest = Object.entries(layers)
    .sort(([, a], [, b]) => b - a)
    .slice(0, COMPOSER_CAPS.layers);
  const read = largest.reduce((sum, [, knobs]) => sum + knobs, composer);
  if (read > COMPOSER_CAPS.programParams)
    throw new ComposeError(
      `preset ${preset}: a program holding its layers ${largest.map(([id]) => id).join(", ")} reads ${read} knobs (the composer's ${composer} and theirs), at most ${COMPOSER_CAPS.programParams}`,
    );
}

/** Compose `preset` from `composer`'s layers (see the header). */
export function composeScene<P extends AnyPreset>(composer: Composer, preset: P): ComposedScene<P> {
  if (preset.composer !== composer.id)
    throw new ComposeError(
      `preset ${preset.id} is for the ${preset.composer} composer, not ${composer.id}`,
    );
  const admitted = composer.layers.filter(
    (layer) => layer.composers.includes(preset.composer) && admits(layer, preset.rig),
  );
  // A layer drawn on a window's glass is offered only where a window with glass is (roomGlass).
  const glazed = admitted.some(
    (layer) => layer.window === true && layer.passes.glass !== undefined,
  );
  const offered = admitted.filter((layer) => layer.glass !== true || glazed);
  for (const id of preset.layers)
    if (!offered.some((layer) => layer.id === id))
      throw new ComposeError(`preset ${preset.id}: home layer ${id} is not offered by its rig`);
  for (const layer of offered)
    if ((layer.featuresFor === undefined) !== (layer.featuresAll === undefined))
      throw new ComposeError(`layer ${layer.id}: featuresFor and featuresAll come together`);
  const home = new Set(preset.layers);
  /** An eye-level preset, under the World; undefined for one seen from above. */
  const kind: AnyPreset = preset;
  const level = kind.composer === "overhead" ? undefined : kind;
  // A room lists the World while a window looks out of it or a window element lets it in (the
  // light-only World where no glass is in frame), with its date; never the gusts nor the
  // arrangement: nothing in it sways in the gust field or stands where a seed puts it (README "The
  // interior composer").
  const indoors = composer.id === "interior";
  if (indoors && level?.room === undefined)
    throw new ComposeError(`preset ${preset.id}: an interior preset needs its room`);
  if (indoors) {
    const lights = offered
      .filter((layer) => home.has(layer.id))
      .reduce((sum, layer) => sum + (layer.lights?.length ?? 0), 0);
    try {
      checkElements(level?.elements ?? [], lights);
    } catch (error) {
      if (error instanceof ElementError)
        throw new ComposeError(`preset ${preset.id}: ${error.message}`);
      throw error;
    }
  }
  // A room's camera (composer/camera.ts, ADR 0062 D18): the shell's range and each offered layer's
  // over the rig. The home layers' must meet the shell's at the rest pose, which a link without the
  // camera's key shows; a guest's may lie elsewhere (refused until the camera is there: place.ts).
  const ranges = new Map<string, PoseRange>();
  let shell: PoseRange | undefined;
  if (indoors && level?.room !== undefined) {
    shell = shellPoseRange(level.rig, level.room);
    for (const layer of offered) ranges.set(layer.id, layerPoseRange(layer.camera, level.rig));
    const homes = offered.filter((layer) => home.has(layer.id));
    const axis = disjointAxis([
      AT_REST,
      shell,
      ...homes.flatMap((layer) => ranges.get(layer.id) ?? []),
    ]);
    if (axis !== undefined)
      throw new ComposeError(
        `preset ${preset.id}: its home layers' camera ranges (${homes.map((layer) => layer.id).join(", ")} and the shell's) do not meet at its rest pose in ${axis}`,
      );
  }
  const looksOut = offered.some((l) => l.window === true);

  // Trigger slots and keys: a room has no gusts, so its layers' slots follow the World's two while
  // it lists the World (the lightning's alone, at 0, while it lists the light-only World: no
  // shooting star crosses a room without glass), and start at 0 in a room without; a patch seen
  // from above has no World, so its layers' start at 0. No slot is held for a knob the preset does
  // not list.
  const listsWorld = level !== undefined && (!indoors || roomListsWorld(level, offered));
  const lightOnly = indoors && !looksOut;
  const lightning = lightOnly ? 0 : WORLD_TRIGGERS.lightning;
  const triggers: Record<string, number> = !listsWorld
    ? {}
    : lightOnly
      ? { lightning }
      : indoors
        ? { meteors: WORLD_TRIGGERS.meteors, lightning }
        : { ...WORLD_TRIGGERS };
  let slot = !listsWorld ? 0 : (indoors ? lightning : WORLD_TRIGGERS.gusts) + 1;
  // A room's window shows the World's sky and weather; its birds fly no window yet, so a room lists
  // none of their knobs, and a room with no glass in frame lists the light-only World's. A patch
  // seen from above shows the World's rain and wind where it is open to the sky.
  const open = level === undefined && offered.some((layer) => layer.open === true);
  const world =
    level === undefined
      ? open
        ? worldPatchKnobs()
        : []
      : !listsWorld
        ? []
        : worldKnobs({
            ...level.world,
            meteors: { trigger: WORLD_TRIGGERS.meteors },
            lightning,
            groups: { ...level.world.groups, ...(indoors ? {} : { wind: "wind" }) },
          }).filter(
            (def) =>
              !indoors ||
              (looksOut
                ? !["birds", "birdKind", "birdFormation"].includes(def.key)
                : LIGHT_ONLY_WORLD[def.key] === true),
          );
  const season = offered.find((layer) => layer.season !== undefined)?.season;
  if (season !== undefined && season.key !== "season")
    throw new ComposeError(`preset ${preset.id}: a layer's season knob is keyed ${season.key}`);
  const own =
    level === undefined
      ? []
      : indoors
        ? listsWorld
          ? [season ?? ROOM_DATE]
          : []
        : composerKnobs(season);
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
  checkKnobCaps(
    preset.id,
    params.length,
    world.length + own.length,
    Object.fromEntries(
      offered.map((layer) => [layer.id, 1 + Object.keys(keys[layer.id] ?? {}).length]),
    ),
  );
  for (const key of Object.keys(preset.values))
    if (!params.some((def) => def.key === key || `${def.key}-amount` === key))
      throw new ComposeError(`preset ${preset.id}: its value ${key} names no knob`);
  const climate = hasClimate(params);

  const gates: Record<string, string> = Object.fromEntries(
    offered.map((layer) => [layerGate(layer.id), layer.id]),
  );
  /** The knobs a program reads (`knobsFor`): the composer's always, each layer's while it is on. */
  const composerKeys = [...world, ...own].map((def) => def.key);
  const layerKeys = Object.fromEntries(
    offered.map((layer) => [layer.id, [layer.id, ...Object.values(keys[layer.id] ?? {})]]),
  );
  const placeOn = (on: ReadonlySet<string>, pose?: CameraPose) => place(offered, preset, on, pose);
  const switched = (values: Readonly<Record<string, number>>) =>
    new Set(offered.filter((layer) => (values[layer.id] ?? 0) > 0).map((layer) => layer.id));
  /**
   * A room's poses for these values: the shell's range met with every layer's the placement keeps
   * at `pose` (a guest whose range excludes it is refused), or with the home layers' alone without
   * one. Never empty: the home layers' meet (checked above), and a kept guest holds the pose.
   */
  const poseRange = (values: Readonly<Record<string, number>>, pose?: CameraPose): PoseRange => {
    const meet = (pose?: CameraPose) =>
      meetRanges([
        ...(shell === undefined ? [] : [shell]),
        ...placeOn(switched(values), pose).layers.flatMap(({ layer }) =>
          pose === undefined && !home.has(layer.id) ? [] : (ranges.get(layer.id) ?? []),
        ),
      ]);
    const homes = meet();
    if (homes === undefined)
      throw new ComposeError(`preset ${preset.id}: no pose holds its layers`);
    return pose === undefined ? homes : (meet(clampPose(pose, homes)) ?? homes);
  };
  /** The placement these values switch on; in a room at `pose`, held to its home layers' range. */
  const placed = (values: Readonly<Record<string, number>>, pose?: CameraPose) =>
    placeOn(
      switched(values),
      shell === undefined || pose === undefined ? undefined : clampPose(pose, poseRange(values)),
    );
  /** A layer's values under its own keys (its knobs' qualified keys read back). */
  const ownValues = (layer: LayerDef, values: Readonly<Record<string, number>>) => {
    const map = keys[layer.id] ?? {};
    const out: Record<string, number> = { ...values };
    for (const [short, key] of Object.entries(map)) out[short] = values[key] ?? 0;
    return out;
  };
  /**
   * The layer gates of the layers these values place (in a room, at `pose`), each placed layer's own
   * (`each`), the rest 0.
   */
  const gatesOf = (
    values: Readonly<Record<string, number>>,
    each: (
      layer: LayerDef,
      values: Readonly<Record<string, number>>,
    ) => Readonly<Record<string, number>>,
    pose?: CameraPose,
  ) => {
    const placement = placed(values, pose);
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

  // Each layer's view: its own knobs under their short keys, the rest under the scene's. A knob
  // another holds under one of the layer's short keys (the lava lamp's `mark` beside the frost
  // glass's `frostGlassMark`) is keyed there as its holder's, qualified (`lavaLampMark`; the World's,
  // the composer's and the switches' by `scene`), so a short key reads the layer's own knob and
  // never another's that comes first.
  const holders: Record<string, string> = {};
  for (const [layer, map] of Object.entries(keys))
    for (const key of Object.values(map)) holders[key] = layer;
  const shortParams: Record<string, readonly ParamDef[]> = {};
  for (const layer of offered) {
    const map = keys[layer.id] ?? {};
    const back = Object.fromEntries(Object.entries(map).map(([s, q]) => [q, s]));
    const view = params.map((def) => {
      const short = back[def.key];
      if (short !== undefined) return short === def.key ? def : { ...def, key: short };
      if (map[def.key] === undefined) return def;
      return { ...def, key: qualified(holders[def.key] ?? "scene", def.key) };
    });
    const seen = new Set<string>();
    for (const def of view) {
      if (seen.has(def.key))
        throw new ComposeError(`layer ${layer.id}: its sim's view holds two '${def.key}' knobs`);
      seen.add(def.key);
    }
    shortParams[layer.id] = view;
  }

  const groups: Record<string, Blurb> = {
    ...(level === undefined || indoors
      ? {}
      : {
          wind: {
            title: "Wind",
            shelf: "world",
            blurb:
              "Which way the wind blows, and the gusts it sends across the land: one wind for every layer.",
          },
        }),
    ...(world.length === 0
      ? {}
      : level === undefined
        ? { weather: worldPatchGroup }
        : {
            sky: worldGroups.sky,
            weather: worldGroups.weather,
            ...(indoors ? {} : { birds: worldGroups.birds }),
          }),
    layers: {
      title: "Layers",
      blurb:
        level === undefined
          ? "What lies in the patch seen from above, by role: one bed, at most one water over it, and what stands, floats, grows and swims there; add or take away any."
          : indoors
            ? "What the room holds, by role: the back wall's backdrop (a window, a papered wall), the ledge in front, and what stands on it; add or take away any."
            : "What stands in the view, by role: one backdrop, at most one ground, and dressings, covers and life over them; add or take away any, and re-seed the arrangement.",
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
    ...(level?.planets === undefined ? {} : { planets: level.planets }),
    ...(!indoors
      ? {}
      : {
          elements: {
            defaults: level?.elements ?? [],
            cap: LIGHT_CAP - offered.reduce((sum, layer) => sum + (layer.lights?.length ?? 0), 0),
          },
          ...(shell === undefined ? {} : { camera: { range: poseRange, reach: shell } }),
        }),
    ...(preset.passage === undefined ? {} : { passage: preset.passage }),
    ...(preset.theme === undefined ? {} : { theme: preset.theme(params) }),
    ...(preset.features === undefined ? {} : { features: preset.features }),
    featuresFor: (values, pose) => ({
      ...(level === undefined
        ? open
          ? worldPatchFeatures(values)
          : {}
        : lightOnly
          ? { ...worldFeatures(lightOnlyValues(values), climate), ...LIGHT_ONLY_GATES }
          : worldFeatures(values, climate)),
      ...gatesOf(values, (layer, v) => layer.featuresFor?.(v) ?? {}, pose),
      ...(indoors ? { [POSE_GATE]: pose === undefined || atRest(pose) ? 0 : 1 } : {}),
      [TURNS_GATE]: 0,
    }),
    featuresAllFor: (values, pose) => ({
      ...(level === undefined
        ? open
          ? worldPatchFeatures({ rain: 1 })
          : {}
        : indoors && !looksOut
          ? LIGHT_ONLY_ALL
          : WORLD_ALL),
      ...gatesOf(values, (layer) => layer.featuresAll ?? {}, pose),
      ...(indoors ? { [POSE_GATE]: 1 } : {}),
      [TURNS_GATE]: 1,
    }),
    knobsFor: (features) =>
      new Set([
        ...composerKeys,
        ...offered.flatMap((layer) =>
          features[layerGate(layer.id)] === 1 ? (layerKeys[layer.id] ?? []) : [],
        ),
      ]),
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
