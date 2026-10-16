// The pond's layout pass: where the lily pads, the koi on their loops and the petals are this frame,
// the same for every pixel, worked out once on the GPU into a small float texture (uSim3) instead
// of in every pixel. It runs the shader's own GLSL (pondLayoutGlsl, shader.ts) on the uniforms the
// scene's program gets (the motion clock, the frame's size, the passage, the knobs as the shader
// reads them), so scenePond draws byte for byte as it does working the layout out itself, which it
// still does where float targets are missing (no texture: uSimOn.w 0).
//
// Texture: rgba32f, POND_LAYOUT.petals x 4 texels, read with texelFetch:
//   row 0  pad i: centre xy, radius, 1 if it carries a flower (pondPads, pondPadFlower)
//   row 1  pad i: its stem's root xy
//   row 2  koi i on its loop: position xy, path step zw (pondKoiSwim)
//   row 3  petal i: position xy, turn (pondPetal)
import { KnobReader, type ParamDef } from "../../params.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { GpuCompute, type Pass, type RenderTarget } from "../../sims/gpu.ts";
import type { SimFrame } from "../types.ts";
import { POND_LAYOUT, pondLayoutGlsl } from "./shader.ts";

const KNOBS = [
  "lilies",
  "lilySeed",
  "lilyDrift",
  "tether",
  "current",
  "currentDir",
  "turbulence",
  "swim",
] as const;
type Knob = (typeof KNOBS)[number];

const LAYOUT_ROWS = 4;

/** The pass: the common helpers, the preamble's TAU and passage as the scene's program has them. */
const LAYOUT_GLSL = `${gpuCommonGlsl}
#define TAU 6.2831853
uniform vec2 uRes;
uniform float uMotionTime;
uniform vec2 uPassage;
uniform float uLilies;
uniform float uLilySeed;
uniform float uLilyDrift;
uniform float uTether;
uniform float uCurrent;
uniform float uCurrentDir;
uniform float uTurbulence;
uniform float uSwim;
float passageIn() {
  return uPassage.x;
}
float passageOut() {
  return uPassage.y;
}
${pondLayoutGlsl}
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
  } else if (at.y == 2) {
    value = pondKoiSwim(fi, tm * (0.6 + 2.4 * uSwim), aspect);
  } else {
    value = vec4(pondPetal(fi, vec2(aspect * 1.1, 1.1), flow, tm, uTurbulence), 0.0);
  }
  fragColor = value;
}
`;

/** The layout pass, or none where float render targets are missing (the shader then works it out). */
export class PondLayout {
  readonly #knobs: KnobReader<Knob>;
  readonly #gpu: GpuCompute | undefined;
  readonly #pass: Pass | undefined;
  readonly #target: RenderTarget | undefined;
  /** Rewritten in place each frame, so a frame allocates nothing. */
  readonly #uniforms = {
    uRes: new Float32Array(2),
    uPassage: new Float32Array(2),
    uMotionTime: 0,
    uLilies: 0,
    uLilySeed: 0,
    uLilyDrift: 0,
    uTether: 0,
    uCurrent: 0,
    uCurrentDir: 0,
    uTurbulence: 0,
    uSwim: 0,
  };

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<Knob>("pond", params, KNOBS);
    this.#gpu = GpuCompute.create(gl);
    this.#pass = this.#gpu?.pass(LAYOUT_GLSL, "pond layout");
    this.#target = this.#gpu?.target({
      width: Math.max(POND_LAYOUT.pads, POND_LAYOUT.koi, POND_LAYOUT.petals),
      height: LAYOUT_ROWS,
      format: "rgba32f",
      filter: "nearest",
    });
  }

  /** This frame's layout (uSim3), or undefined without float targets. */
  frame(frame: SimFrame): WebGLTexture | undefined {
    if (!this.#pass || !this.#target) return undefined;
    const knobs = this.#knobs;
    const uniforms = this.#uniforms;
    uniforms.uRes[0] = frame.width;
    uniforms.uRes[1] = frame.height;
    uniforms.uPassage[0] = frame.passage.enter;
    uniforms.uPassage[1] = frame.passage.exit;
    uniforms.uMotionTime = frame.motionTime;
    uniforms.uLilies = knobs.value(frame, "lilies");
    uniforms.uLilySeed = knobs.value(frame, "lilySeed");
    uniforms.uLilyDrift = knobs.value(frame, "lilyDrift");
    uniforms.uTether = knobs.value(frame, "tether");
    uniforms.uCurrent = knobs.value(frame, "current");
    uniforms.uCurrentDir = knobs.value(frame, "currentDir");
    uniforms.uTurbulence = knobs.value(frame, "turbulence");
    uniforms.uSwim = knobs.value(frame, "swim");
    this.#pass.run(this.#target, { uniforms });
    return this.#target.texture;
  }

  dispose(): void {
    this.#gpu?.dispose();
  }
}
