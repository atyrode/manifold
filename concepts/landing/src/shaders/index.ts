// One full-screen pass per frame. The canvas backing store is one texel per dither cell and the
// browser upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
//
// Every scene compiles to its own fragment shader (see scenes/types.ts): the common preamble, the
// scene's compile-time features (fixed, and keyed by its knobs: one program per distinct set, the
// library gates of its night parts among them), one `#define K_<key> uParams[i]` per knob and
// SKY_YEAR, the shared libraries, the scene's GLSL, then `main`, which calls the scene's entry and
// dithers the Shade it returns into the palette.

import { seasonKnob, yearCycleKnob, yearNowGlsl } from "../climate.ts";
import { effective, MAX_PARAMS, type Widget } from "../params.ts";
import type { SceneDef } from "../scenes/types.ts";
import { common } from "./common.ts";
import { libs } from "./lib/index.ts";
import { main } from "./main.ts";

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

/** `K_<key>` reads knob `key`: its index in `scene.params` is its slot in `uParams`. */
function knobDefines(scene: SceneDef): string {
  if (scene.params.length > MAX_PARAMS) {
    throw new SceneShaderError(
      `scene ${scene.id}: ${scene.params.length} knobs, at most ${MAX_PARAMS}`,
    );
  }
  const seen = new Set<string>();
  return scene.params
    .map((def, index) => {
      if (!KNOB_KEY.test(def.key))
        throw new SceneShaderError(
          `scene ${scene.id}: knob key "${def.key}" must match ${String(KNOB_KEY)}`,
        );
      if (seen.has(def.key))
        throw new SceneShaderError(`scene ${scene.id}: knob key "${def.key}" is declared twice`);
      seen.add(def.key);
      return `#define K_${def.key} uParams[${index}]\n`;
    })
    .join("");
}

/**
 * `#define SKY_YEAR <expr>`: the scene's year position now (src/climate.ts `yearAt`, carried round
 * by its year cycle, `yearNow`) from its knobs' defines, for the climate; -1.0 without a season.
 */
function yearDefine(scene: SceneDef): string {
  const season = seasonKnob(scene.params);
  const year = season ? yearNowGlsl(season, yearCycleKnob(scene.params)) : "-1.0";
  return `#define SKY_YEAR ${year}\n`;
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
 * Library gates: the night parts whose shared code a library compiles in only while the part's knob
 * is on (`#if NAME`; the library defines it 0 where a scene lacks the knob): the constellations in
 * skyStars (SKY_FIGURES) and the giant planet, skyGiant (SKY_GIANT), both in shaders/lib/sky.ts. A
 * scene holding such a knob gets the gate in every feature set it compiles, 1 while the knob is above
 * 0 and 0 while not, and 1 in its all-features set, so it is knob-keyed (`knobKeyed`) like a scene
 * with `featuresFor`, whether or not it has gates of its own.
 */
export const LIBRARY_GATES: Readonly<Partial<Record<NightPartName, string>>> = {
  constellations: "SKY_FIGURES",
  giant: "SKY_GIANT",
};

/** The library gates `scene` holds (LIBRARY_GATES): each knob's key and its gate. */
function libraryGates(scene: SceneDef): (readonly [key: string, gate: string])[] {
  return scene.params.flatMap((def) => {
    const gate = def.widget?.kind === "night" ? LIBRARY_GATES[def.widget.part] : undefined;
    return gate === undefined ? [] : [[def.key, gate] as const];
  });
}

/**
 * Whether `scene`'s program depends on its knobs' values (SceneDef.featuresFor, or a library gate):
 * the renderer then works out the feature set of each setting and keeps an all-features program.
 */
export function knobKeyed(scene: SceneDef): boolean {
  return scene.featuresFor !== undefined || libraryGates(scene).length > 0;
}

/**
 * The compile-time features of `scene`'s program for knob values as its shader reads them (keyed by
 * knob key; default: the scene's defaults): `features`, its library gates (LIBRARY_GATES) and
 * `featuresFor(values)` over them.
 */
export function sceneFeatures(
  scene: SceneDef,
  values?: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  if (!knobKeyed(scene)) return scene.features ?? {};
  const knobs = values ?? shaderValues(scene);
  return {
    ...scene.features,
    ...Object.fromEntries(
      libraryGates(scene).map(([key, gate]) => [gate, (knobs[key] ?? 0) > 0 ? 1 : 0]),
    ),
    ...scene.featuresFor?.(knobs),
  };
}

/**
 * The compile-time features of `scene`'s all-features program: `features`, every library gate on
 * and `featuresAll` over them, a program that draws every setting of its knobs as that setting's own
 * (`sceneFeatures`) program does. Undefined for a scene whose program does not depend on its knobs
 * (`knobKeyed`); throws for one with `featuresFor` but no `featuresAll`.
 */
export function sceneFeaturesAll(scene: SceneDef): Readonly<Record<string, number>> | undefined {
  if (!knobKeyed(scene)) return undefined;
  if (scene.featuresFor !== undefined && scene.featuresAll === undefined)
    throw new SceneShaderError(`scene ${scene.id}: featuresFor needs featuresAll`);
  return {
    ...scene.features,
    ...Object.fromEntries(libraryGates(scene).map(([, gate]) => [gate, 1])),
    ...scene.featuresAll,
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

/** The scene's fragment shader with these compile-time features (default: its features at its default knobs). */
export function fragmentSourceFor(
  scene: SceneDef,
  features: Readonly<Record<string, number>> = sceneFeatures(scene),
): string {
  // Knob defines come ahead of the libraries so that a library may test for an opt-in shared knob
  // with `#ifdef K_<key>`; the libraries read no other knob.
  return (
    common +
    featureDefines(scene, features) +
    knobDefines(scene) +
    yearDefine(scene) +
    libs +
    scene.glsl +
    main(scene.entry)
  );
}
