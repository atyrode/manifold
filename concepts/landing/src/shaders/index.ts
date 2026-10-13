// One full-screen pass per frame. The canvas backing store is one texel per dither cell and the
// browser upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
//
// Every scene compiles to its own fragment shader (see scenes/types.ts): the common preamble, the
// shared libraries, one `#define K_<key> uParams[i]` per knob, the scene's GLSL, then `main`, which
// calls the scene's entry and dithers the Shade it returns into the palette.

import { MAX_PARAMS } from "../params.ts";
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
    throw new SceneShaderError(`scene ${scene.id}: ${scene.params.length} knobs, at most ${MAX_PARAMS}`);
  }
  const seen = new Set<string>();
  return scene.params.map((def, index) => {
    if (!KNOB_KEY.test(def.key)) throw new SceneShaderError(`scene ${scene.id}: knob key "${def.key}" must match ${String(KNOB_KEY)}`);
    if (seen.has(def.key)) throw new SceneShaderError(`scene ${scene.id}: knob key "${def.key}" is declared twice`);
    seen.add(def.key);
    return `#define K_${def.key} uParams[${index}]\n`;
  }).join("");
}

export function fragmentSourceFor(scene: SceneDef): string {
  return common + libs + knobDefines(scene) + scene.glsl + main(scene.entry);
}
