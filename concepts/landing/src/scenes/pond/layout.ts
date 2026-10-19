// The pond's layout passes: where the lily pads and the petals are this frame (the water's), and the
// koi on their loops (the koi's), the same for every pixel, worked out once on the GPU into a small
// float texture of each layer's (a field: pondWaterField0, koiField1) instead of in every pixel.
// Each runs the shader's own GLSL (pondLayoutGlsl, shader.ts) on the uniforms the scene's program
// gets (the motion clock, the frame's size, the passage, the knobs as the shader reads them), so the
// layers draw byte for byte as they do working the layout out themselves, which they still do where
// float targets are missing (no texture: the field off).
//
// Textures: rgba32f, read with texelFetch.
//   the water's, POND_LAYOUT.petals x 3:
//     row 0  pad i: centre xy, radius, 1 if it carries a flower (pondPads, pondPadFlower)
//     row 1  pad i: its stem's root xy
//     row 2  petal i: position xy, turn (pondPetal)
//   the koi's, POND_LAYOUT.koi x 1:
//     row 0  koi i on its loop: position xy, path step zw (pondKoiSwim)
import { KnobReader, type ParamDef } from "../../params.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { GpuCompute, type Pass, type RenderTarget } from "../../sims/gpu.ts";
import type { SimFrame } from "../types.ts";
import { POND_LAYOUT, pondLayoutGlsl } from "./shader.ts";

/** What a pass lays out: the water's pads and petals, or the koi's loops. */
export type PondLayoutOf = "surface" | "koi";

const KNOBS = {
  surface: ["lilies", "lilySeed", "lilyDrift", "tether", "current", "currentDir", "turbulence"],
  koi: ["swim"],
} as const satisfies Record<PondLayoutOf, readonly string[]>;
type Knob = (typeof KNOBS)[PondLayoutOf][number];

/** The pass's common head: the helpers, the preamble's TAU and passage as the scene's program has them. */
const HEAD = `${gpuCommonGlsl}
#define TAU 6.2831853
uniform vec2 uRes;
uniform float uMotionTime;
uniform vec2 uPassage;
float passageIn() {
  return uPassage.x;
}
float passageOut() {
  return uPassage.y;
}
${pondLayoutGlsl}`;

const SURFACE_GLSL = `${HEAD}
uniform float uLilies;
uniform float uLilySeed;
uniform float uLilyDrift;
uniform float uTether;
uniform float uCurrent;
uniform float uCurrentDir;
uniform float uTurbulence;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  float fi = float(at.x);
  float tm = uMotionTime;
  float aspect = uRes.x / uRes.y;
  vec2 flow = vec2(cos(uCurrentDir * TAU), sin(uCurrentDir * TAU)) * uCurrent;
  vec4 value = vec4(0.0);
  if (at.y < 2) {
    int pads = int(uLilies * ${POND_LAYOUT.pads}.0 + 0.5);
    vec3 padAt[${POND_LAYOUT.pads}];
    vec2 padRoot[${POND_LAYOUT.pads}];
    pondPads(pads, aspect, tm, flow, uTurbulence, uLilySeed, uLilyDrift, uTether > 0.5, padAt, padRoot);
    if (at.x < pads) {
      value = at.y == 0
        ? vec4(padAt[at.x], pondPadFlower(fi, uLilySeed) ? 1.0 : 0.0)
        : vec4(padRoot[at.x], 0.0, 0.0);
    }
  } else {
    value = vec4(pondPetal(fi, vec2(aspect * 1.1, 1.1), flow, tm, uTurbulence), 0.0);
  }
  fragColor = value;
}
`;

const KOI_GLSL = `${HEAD}
uniform float uSwim;
void main() {
  float fi = float(int(gl_FragCoord.x));
  fragColor = pondKoiSwim(fi, uMotionTime * (0.6 + 2.4 * uSwim), uRes.x / uRes.y);
}
`;

const SHAPE = {
  surface: { glsl: SURFACE_GLSL, width: Math.max(POND_LAYOUT.pads, POND_LAYOUT.petals), rows: 3 },
  koi: { glsl: KOI_GLSL, width: POND_LAYOUT.koi, rows: 1 },
} as const;

/** A layout pass, or none where float render targets are missing (the shader then works it out). */
export class PondLayout {
  readonly #keys: readonly Knob[];
  /** Each knob's uniform, `u<Key>`, in #keys' order. */
  readonly #names: readonly string[];
  readonly #knobs: KnobReader<Knob>;
  readonly #gpu: GpuCompute | undefined;
  readonly #pass: Pass | undefined;
  readonly #target: RenderTarget | undefined;
  readonly #res = new Float32Array(2);
  readonly #passage = new Float32Array(2);
  /** Rewritten in place each frame, so a frame allocates nothing. */
  readonly #uniforms: Record<string, number | Float32Array>;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[], of: PondLayoutOf) {
    this.#keys = KNOBS[of];
    this.#names = this.#keys.map((key) => `u${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    this.#knobs = new KnobReader<Knob>("pond", params, this.#keys);
    this.#uniforms = { uRes: this.#res, uPassage: this.#passage, uMotionTime: 0 };
    for (const name of this.#names) this.#uniforms[name] = 0;
    const shape = SHAPE[of];
    this.#gpu = GpuCompute.create(gl);
    this.#pass = this.#gpu?.pass(shape.glsl, `pond ${of} layout`);
    this.#target = this.#gpu?.target({
      width: shape.width,
      height: shape.rows,
      format: "rgba32f",
      filter: "nearest",
    });
  }

  /** This frame's layout, or undefined without float targets. */
  frame(frame: SimFrame): WebGLTexture | undefined {
    if (!this.#pass || !this.#target) return undefined;
    const uniforms = this.#uniforms;
    this.#res[0] = frame.width;
    this.#res[1] = frame.height;
    this.#passage[0] = frame.passage.enter;
    this.#passage[1] = frame.passage.exit;
    uniforms["uMotionTime"] = frame.motionTime;
    for (let k = 0; k < this.#keys.length; k++) {
      const key = this.#keys[k];
      const name = this.#names[k];
      if (key !== undefined && name !== undefined) uniforms[name] = this.#knobs.value(frame, key);
    }
    this.#pass.run(this.#target, { uniforms });
    return this.#target.texture;
  }

  dispose(): void {
    this.#gpu?.dispose();
  }
}
