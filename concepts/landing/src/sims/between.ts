// A GPU field drawn between its last two steps, as a CPU sim draws between them by FixedStep.alpha
// (sims/clock.ts), for a solver whose state lives in a PingPong (the incense's smoke, the pearl
// tank's flakes and dye). Before a frame's last step `keep` copies the field as it stands; `show`
// mixes that copy and the field after the step, `alpha` of the way, into a target of its own and
// hands over its texture. Stepped at a fixed h, the field then moves as smoothly at 144 Hz, or on a
// 60 Hz display whose frames come a little early or late, as when every frame stepped its own dt.
// Until the first `keep`, after `settle` (a fresh pour, a field reseeded) and for the frame the
// field is resized, the field is shown as it stands.
//
// Cost: a copy of the field per frame that steps, and a mix per frame shown (one and two reads a
// texel); two targets the field's size. They are freed with the GpuCompute.
//
// Usage:
//   const clock = new FixedStep(1 / 60, 3);
//   const smoke = new FieldBetween(gpu, fluid.dye, "smoke");
//   // each frame:
//   const steps = clock.advance(frame.dt * frame.motion);
//   for (let i = 0; i < steps; i++) {
//     if (i === steps - 1) smoke.keep();
//     fluid.step(step);
//   }
//   return [smoke.show(clock.alpha)];
import type { GpuCompute, Pass, PingPong, RenderTarget } from "./gpu.ts";
import { clamp } from "./math.ts";

const COPY_GLSL = `
uniform sampler2D uField;
void main() {
  fragColor = texture(uField, vUv);
}
`;

const MIX_GLSL = `
uniform sampler2D uWas;
uniform sampler2D uNow;
uniform float uAlpha;
void main() {
  fragColor = mix(texture(uWas, vUv), texture(uNow, vUv), uAlpha);
}
`;

/** A PingPong field shown between its last two steps (see the header). */
export class FieldBetween {
  readonly #field: PingPong;
  readonly #was: RenderTarget;
  readonly #shown: RenderTarget;
  readonly #copy: Pass;
  readonly #mix: Pass;
  readonly #uniforms = { uAlpha: 0 };
  /** Whether #was holds the field as it stood before its last step. */
  #kept = false;

  constructor(gpu: GpuCompute, field: PingPong, name: string) {
    this.#field = field;
    // Texel centres sample exactly under any filter; the field's own lets the shader read the mix as
    // it read the field.
    const like = {
      width: field.width,
      height: field.height,
      format: field.format,
      filter: field.read.filter,
      wrap: field.read.wrap,
    };
    this.#was = gpu.target(like);
    this.#shown = gpu.target(like);
    this.#copy = gpu.pass(COPY_GLSL, `${name} kept`).bind({ uField: field });
    this.#mix = gpu.pass(MIX_GLSL, `${name} between`).bind({ uWas: this.#was, uNow: field });
  }

  /** The field as it stands becomes the step before: call it before the frame's last step. */
  keep(): void {
    const field = this.#field;
    this.#was.resize(field.width, field.height);
    this.#copy.run(this.#was);
    this.#kept = true;
  }

  /** No step before: the field is shown as it stands until the next keep(). */
  settle(): void {
    this.#kept = false;
  }

  /** The texture to hand the shader: `alpha` (FixedStep.alpha) of the way from the kept field to the field. */
  show(alpha: number): WebGLTexture {
    const field = this.#field;
    const was = this.#was;
    if (!this.#kept || was.width !== field.width || was.height !== field.height)
      return field.texture;
    this.#shown.resize(field.width, field.height);
    this.#uniforms.uAlpha = clamp(alpha, 0, 1);
    this.#mix.set(this.#uniforms).run(this.#shown);
    return this.#shown.texture;
  }
}
