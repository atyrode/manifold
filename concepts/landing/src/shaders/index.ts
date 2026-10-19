// One full-screen pass per frame. The canvas backing store is one texel per dither cell and the
// browser upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
//
// Every scene compiles to its own fragment shader (see scenes/types.ts): the common preamble, the
// scene's compile-time features (fixed, and keyed by its setting: one program per distinct set, the
// library gates of its night parts and of its planets among them, and the gate of the other
// principals' cursors), the program's `uParams` and one `#define K_<key>` per knob it reads (its
// component of `uParams`, `knobSlots`), one `#define PHASE_<key>` per rate knob, SKY_YEAR (and a
// dated sky's SKY_DATE_ANCHOR), the shared libraries, the scene's GLSL, then `main`, which calls the
// scene's entry, dithers the Shade it returns into the palette and draws the cursors over it
// (`assembleFragment`). The driver gets that program shaken (shaders/shake.ts): its conditionals
// resolved with its features, its comments gone and only what `main` reaches, line for line
// (`fragmentSourceFor`).

import { seasonKnob, yearCycleKnob, yearNowGlsl } from "../climate.ts";
import type { CameraPose } from "../composer/camera.ts";
import { elementFeatures } from "../composer/elements.ts";
import type { LightElement } from "../composer/types.ts";
import { effective, MAX_PARAMS, MAX_PROGRAM_PARAMS, type Widget } from "../params.ts";
import { phaseDefines } from "../rate-phase.ts";
import { openingPlanets, planetUniforms, type PlanetUniforms } from "../scenes/planets.ts";
import type { LoadedScene, SceneDef } from "../scenes/types.ts";
import { skyAnchor } from "../world-clock.ts";
import { common } from "./common.ts";
import { glslFloat } from "./glsl.ts";
import { libs } from "./lib/index.ts";
import { PLANET_BODY_GATES_ALL } from "./lib/planet.ts";
import { main } from "./main.ts";
import { shakeGlsl } from "./shake.ts";

export const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** A scene whose knobs cannot become shader defines. */
export class SceneShaderError extends Error {}

/** Knob keys double as URL keys and GLSL identifiers (`K_<key>`). */
const KNOB_KEY = /^[a-z][A-Za-z0-9]*$/;

/**
 * The program's slot map: the index in `scene.params` of each knob a program of these compile-time
 * features reads, in params order, so slot s holds knob `knobSlots(...)[s]`. A composed scene's
 * program reads its composer's knobs and its on layers' (`SceneDef.knobsFor`), and any other knob
 * its code names: a chunk shared by several layers names a knob of one that is off (the night
 * line's lamp in its tea glass), the year (`SKY_YEAR`) a layer's season or year cycle, a library an
 * opt-in knob it tests with `#ifdef`; every other scene's reads them all. At most
 * MAX_PROGRAM_PARAMS.
 */
export function knobSlots(
  scene: LoadedScene,
  features: Readonly<Record<string, number>>,
  glsl: string = scene.glslFor?.(features) ?? scene.glsl,
): readonly number[] {
  const read = scene.knobsFor?.(features);
  const named =
    read === undefined
      ? undefined
      : new Set(
          [...`${yearDefine(scene)}${libs}${glsl}`.matchAll(/\bK_(\w+)/g)].map(([, key]) => key),
        );
  const slots = scene.params.flatMap((def, index) =>
    read === undefined || read.has(def.key) || named?.has(def.key) === true ? [index] : [],
  );
  if (slots.length > MAX_PROGRAM_PARAMS)
    throw new SceneShaderError(
      `scene ${scene.id}: a program reads ${slots.length} knobs, at most ${MAX_PROGRAM_PARAMS}`,
    );
  return slots;
}

/** `uParams` rows for a program reading `knobs` knobs: four a row, one at least. */
function paramRows(knobs: number): number {
  return Math.max(1, Math.ceil(knobs / 4));
}

/**
 * The program's `uParams`, sized to the knobs it reads (`knobSlots`), and `K_<key>` for each: the
 * knob in slot s is component s % 4 of row s / 4, a constant swizzle (slot 13 is `uParams[3].y`).
 * Every knob of the scene is checked (keyed for GLSL, declared once), whether or not this program
 * reads it.
 */
function knobDefines(
  scene: LoadedScene,
  features: Readonly<Record<string, number>>,
  glsl: string,
): string {
  if (scene.params.length > MAX_PARAMS) {
    throw new SceneShaderError(
      `scene ${scene.id}: ${scene.params.length} knobs, at most ${MAX_PARAMS}`,
    );
  }
  const seen = new Set<string>();
  for (const def of scene.params) {
    if (!KNOB_KEY.test(def.key))
      throw new SceneShaderError(
        `scene ${scene.id}: knob key "${def.key}" must match ${String(KNOB_KEY)}`,
      );
    if (seen.has(def.key))
      throw new SceneShaderError(`scene ${scene.id}: knob key "${def.key}" is declared twice`);
    seen.add(def.key);
  }
  const slots = knobSlots(scene, features, glsl);
  return (
    `uniform vec4 uParams[${paramRows(slots.length)}]; // the knobs this program reads, four a row: read knob <key> as K_<key>\n` +
    slots
      .map(
        (index, slot) =>
          `#define K_${scene.params[index]?.key ?? ""} uParams[${slot >> 2}].${"xyzw".charAt(slot & 3)}\n`,
      )
      .join("")
  );
}

/**
 * Knob values in `params` order as a program's `uParams` takes them (`uniform4fv`), through its slot
 * map (`knobSlots`): slot s holds `values[slots[s]]`, four a row, zeros past the last. Written into
 * `into` (the renderer's buffer for the program, as long as its rows) when given.
 */
export function packParams(
  values: ArrayLike<number>,
  slots: readonly number[],
  into: Float32Array = new Float32Array(paramRows(slots.length) * 4),
): Float32Array {
  let slot = 0;
  for (const index of slots) into[slot++] = values[index] ?? 0;
  return into;
}

/**
 * `#define SKY_YEAR <expr>`: the scene's year position now (src/climate.ts `yearAt`, carried round
 * by its year cycle, `yearNow`) from its knobs' defines, for the climate; -1.0 without a season. A
 * dated sky (src/world-clock.ts `skyAnchor`: the season sets the scene's climate) also gets
 * `#define SKY_DATE_ANCHOR <year>`, the date it is staged at, which dates its sky (skyAt).
 */
function yearDefine(scene: SceneDef): string {
  const season = seasonKnob(scene.params);
  const year = season ? yearNowGlsl(season, yearCycleKnob(scene.params)) : "-1.0";
  const anchor = skyAnchor(scene.params);
  const dated = anchor === undefined ? "" : `#define SKY_DATE_ANCHOR ${glslFloat(anchor)}\n`;
  return `#define SKY_YEAR ${year}\n${dated}`;
}

/** Library feature names: macros the libraries test with `#ifdef` / `#if`. */
const FEATURE_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Every knob of `scene` as its shader reads it (`K_<key>`), keyed by knob key: `knobs` (raw, keyed as
 * in the URL) over the defaults. What `SceneDef.featuresFor` is given.
 */
export function shaderValues(
  scene: SceneDef,
  knobs: Record<string, number> = {},
): Record<string, number> {
  return Object.fromEntries(scene.params.map((def) => [def.key, effective(def, knobs)]));
}

/** A part of the Night sky section (Widget `night`). */
type NightPartName = Extract<Widget, { kind: "night" }>["part"];

/**
 * Library gates: the shared code a library compiles in only while it shows (`#if NAME`; the library
 * defines it 0 where a scene lacks it). The constellations in skyStars (SKY_FIGURES) come with their
 * night part's knob: a scene holding it gets the gate in every feature set it compiles, 1 while the
 * knob is above 0 and 0 while not. The planets of skyGiant (PLANETS_GATE) come with a scene's list
 * (SceneDef.planets): 1 while it holds any, and with it SEVERAL_PLANETS_GATE, 1 while it holds more
 * than one (one is drawn straight, several in a loop), and the body tier's gates
 * (PlanetUniforms.gates: PLANET_KIND_GATES, a bit per palette of that kind the list holds, and
 * PLANET_DRESS_GATES in shaders/lib/planet.ts), so changing a planet's kind or palette, putting on
 * a piece of dress or adding a second planet builds another program as turning a gated knob does.
 * They are in shaders/lib/sky.ts and planet.ts, and all are on in the all-features set, so a scene
 * with the constellations' knob or planets is setting-keyed (`settingKeyed`) like a scene with
 * `featuresFor`, whether or not it has gates of its own.
 */
export const LIBRARY_GATES: Readonly<Partial<Record<NightPartName, string>>> = {
  constellations: "SKY_FIGURES",
};
export const PLANETS_GATE = "SKY_PLANETS";
export const SEVERAL_PLANETS_GATE = "SKY_PLANETS_SEVERAL";
/** Every planet gate open: the all-features set's. */
const PLANET_GATES_ALL: Readonly<Record<string, number>> = {
  [PLANETS_GATE]: 1,
  [SEVERAL_PLANETS_GATE]: 1,
  ...PLANET_BODY_GATES_ALL,
};
/**
 * The renderer's gate for the other principals' cursors (shaders/main.ts), drawn over every scene
 * while the cast has agents (RenderSettings.agents): in a scene's feature set only then, tested
 * with `#ifdef`, and in every all-features set, whose program draws none while there are none.
 */
export const CURSORS_GATE = "PRINCIPAL_CURSORS";

/** The library gates `scene`'s knobs hold (LIBRARY_GATES): each knob's key and its gate. */
function libraryGates(scene: SceneDef): (readonly [key: string, gate: string])[] {
  return scene.params.flatMap((def) => {
    const gate = def.widget?.kind === "night" ? LIBRARY_GATES[def.widget.part] : undefined;
    return gate === undefined ? [] : [[def.key, gate] as const];
  });
}

/**
 * Whether `scene`'s program depends on its setting (SceneDef.featuresFor, a knob's library gate, or
 * its planets): the renderer then works out the feature set of each setting and keeps an
 * all-features program.
 */
export function settingKeyed(scene: SceneDef): boolean {
  return (
    scene.featuresFor !== undefined || libraryGates(scene).length > 0 || scene.planets !== undefined
  );
}

/**
 * The compile-time features of `scene`'s program for knob values as its shader reads them (keyed by
 * knob key; default: the scene's defaults), the planets it holds as skyGiant takes them (default:
 * those it opens with), whether other principals' cursors are drawn over it (`cursors`), a room's
 * light elements (default: those it opens with) and its camera pose (default: the rest pose):
 * `features`, its library gates and `featuresFor(values, pose)` over them, CURSORS_GATE while
 * `cursors`, and the elements' count and kinds (composer/elements.ts `elementFeatures`).
 */
export function sceneFeatures(
  scene: SceneDef,
  values?: Readonly<Record<string, number>>,
  planets?: PlanetUniforms,
  cursors = false,
  elements?: readonly LightElement[],
  pose?: CameraPose,
): Readonly<Record<string, number>> {
  const own = settingKeyed(scene)
    ? keyedFeatures(
        scene,
        values ?? shaderValues(scene),
        planets ?? planetUniforms(scene.planets === undefined ? [] : openingPlanets(scene.planets)),
        elements,
        pose,
      )
    : (scene.features ?? {});
  return cursors ? { ...own, [CURSORS_GATE]: 1 } : own;
}

/** A setting-keyed scene's features for these knob values, planets, elements and pose (see `sceneFeatures`). */
function keyedFeatures(
  scene: SceneDef,
  knobs: Readonly<Record<string, number>>,
  planets: PlanetUniforms,
  elements: readonly LightElement[] | undefined,
  pose: CameraPose | undefined,
): Readonly<Record<string, number>> {
  return {
    ...scene.features,
    ...Object.fromEntries(
      libraryGates(scene).map(([key, gate]) => [gate, (knobs[key] ?? 0) > 0 ? 1 : 0]),
    ),
    ...(scene.planets === undefined
      ? {}
      : {
          [PLANETS_GATE]: planets.count > 0 ? 1 : 0,
          [SEVERAL_PLANETS_GATE]: planets.count > 1 ? 1 : 0,
          ...planets.gates,
        }),
    ...(scene.elements === undefined ? {} : elementFeatures(elements ?? scene.elements.defaults)),
    ...scene.featuresFor?.(knobs, pose),
  };
}

/**
 * The compile-time features of `scene`'s all-features program: `features`, every library gate and
 * CURSORS_GATE on and `featuresAll` over them, a program that draws every setting of its knobs and
 * planets, with or without cursors, as that setting's own (`sceneFeatures`) program does. A
 * composed scene's (`featuresAllFor`) is its layer set's, for knob values as its shader reads them
 * (default: its defaults) at a room's camera pose (default: the rest pose): every setting of the
 * same layers. Undefined for a scene whose program does not depend on its setting
 * (`settingKeyed`); throws for one with `featuresFor` but neither `featuresAll` nor
 * `featuresAllFor`.
 */
export function sceneFeaturesAll(
  scene: SceneDef,
  values?: Readonly<Record<string, number>>,
  pose?: CameraPose,
): Readonly<Record<string, number>> | undefined {
  if (!settingKeyed(scene)) return undefined;
  if (
    scene.featuresFor !== undefined &&
    scene.featuresAll === undefined &&
    scene.featuresAllFor === undefined
  )
    throw new SceneShaderError(`scene ${scene.id}: featuresFor needs featuresAll`);
  return {
    ...scene.features,
    ...Object.fromEntries(libraryGates(scene).map(([, gate]) => [gate, 1])),
    ...(scene.planets === undefined ? {} : PLANET_GATES_ALL),
    // A room's elements are compiled in by count and kind: its all-features program draws those
    // it opens with, and another list builds its own program.
    ...(scene.elements === undefined ? {} : elementFeatures(scene.elements.defaults)),
    ...(scene.featuresAllFor?.(values ?? shaderValues(scene), pose) ?? scene.featuresAll),
    [CURSORS_GATE]: 1,
  };
}

/** A feature set's identity, its defines in name order: the renderer builds one program per key. */
export function featureKey(features: Readonly<Record<string, number>>): string {
  return Object.keys(features)
    .sort()
    .map((name) => `${name}=${features[name]}`)
    .join(" ");
}

/** `#define NAME n` per compile-time library or scene feature (see `sceneFeatures`). */
function featureDefines(scene: SceneDef, features: Readonly<Record<string, number>>): string {
  return Object.entries(features)
    .map(([name, value]) => {
      if (!FEATURE_NAME.test(name))
        throw new SceneShaderError(
          `scene ${scene.id}: feature "${name}" must match ${String(FEATURE_NAME)}`,
        );
      if (!Number.isInteger(value))
        throw new SceneShaderError(
          `scene ${scene.id}: feature ${name} must be an integer, not ${value}`,
        );
      return `#define ${name} ${value}\n`;
    })
    .join("");
}

/**
 * The scene's whole fragment program with these compile-time features (default: its features at
 * its default knobs), as written: every library, comments and conditionals. The driver gets it
 * shaken (`fragmentSourceFor`).
 */
export function assembleFragment(
  scene: LoadedScene,
  features: Readonly<Record<string, number>> = sceneFeatures(scene),
): string {
  // Knob defines come ahead of the libraries so that a library may test for an opt-in shared knob
  // with `#ifdef K_<key>`; the libraries read no other knob.
  const glsl = scene.glslFor?.(features) ?? scene.glsl;
  return (
    common +
    featureDefines(scene, features) +
    knobDefines(scene, features, glsl) +
    phaseDefines(scene) +
    yearDefine(scene) +
    libs +
    glsl +
    main(scene.entry)
  );
}

/**
 * The scene's fragment shader with these compile-time features (default: its features at its
 * default knobs), as the driver gets it: `assembleFragment` shaken (shaders/shake.ts), so line n
 * holds what line n of the assembled program holds, or nothing.
 */
export function fragmentSourceFor(
  scene: LoadedScene,
  features: Readonly<Record<string, number>> = sceneFeatures(scene),
): string {
  return shakeGlsl(assembleFragment(scene, features));
}
