// One full-screen pass per frame. The canvas backing store is one texel per dither cell and the
// browser upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
//
// Every scene compiles to its own fragment shader (see scenes/types.ts): the common preamble, the
// scene's compile-time features (fixed, and keyed by its knobs: one program per distinct set), the
// shared libraries, one `#define K_<key> uParams[i]` per knob, the scene's GLSL, then `main`, which
// calls the scene's entry and dithers the Shade it returns into the palette.

import { effective, MAX_PARAMS } from "../params.ts";
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

/**
 * The compile-time features of `scene`'s program for knob values as its shader reads them (keyed by
 * knob key; default: the scene's defaults): `features`, with `featuresFor(values)` over them.
 */
export function sceneFeatures(
  scene: SceneDef,
  values?: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  if (scene.featuresFor === undefined) return scene.features ?? {};
  return { ...scene.features, ...scene.featuresFor(values ?? shaderValues(scene)) };
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
  return (
    common +
    featureDefines(scene, features) +
    libs +
    knobDefines(scene) +
    scene.glsl +
    main(scene.entry)
  );
}
