// One full-screen pass. The canvas backing store is one texel per dither cell and the browser
// upscales it with `image-rendering: pixelated`, so `gl_FragCoord` is already the cell index.
// Scene functions return coverage for ink and accent; `main` dithers them into the palette.
// Each scene reads its knobs from `uParams` in the order declared in params.ts.
//
// Each scene's GLSL lives in its own module; this assembles the fragment shader in order.

import { common } from "./common.ts";
import { main } from "./main.ts";
import { orbit } from "./orbit.ts";
import { paintings } from "./paintings.ts";
import { pond } from "./pond.ts";
import { swell } from "./swell.ts";

export const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const fragmentSource = common + paintings + orbit + swell + pond + main;
