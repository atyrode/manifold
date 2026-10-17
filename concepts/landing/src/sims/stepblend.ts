// GPU fields drawn between their last two steps (sims/gpu.ts, sims/clock.ts): a solver stepping a
// fixed h on a FixedStep updates its fields on some frames and not others, so handing the renderer
// the fields themselves would stutter. StepBlend keeps a copy of each field as it stood before the
// frame's last step and mixes it into the field by the clock's alpha, into a texture of its own:
// what is drawn moves smoothly, a step behind the newest, as a CPU sim's state blended by alpha.
//
//   new StepBlend(gpu, fields, name)   one held copy and one shown texture per ping-pong field, in
//                                      the field's format, filter and wrap
//   hold()                             copy every field as it stands: call it just before the
//                                      frame's last step, and after any change that must not be
//                                      drawn blended across (a reseed, a pour, a finished warm-up)
//   show(alpha)                        mix each held copy into its field by alpha (0: as held, 1:
//                                      the field), at the field's size; a field resized since it
//                                      was held is held again first, so it shows as it stands
//   texture(field)                     that field as last shown, to hand the renderer (read it
//                                      every frame)
//   dispose()
//
// Cost: hold reads one texel per texel of each field, show two, in one draw per field each; the
// extra memory is twice the fields'.
//
// Usage (a fluid's dye and velocity, stepped 1/60 s at a time):
//   const blend = new StepBlend(gpu, [fluid.dye, fluid.velocity], "smoke");
//   const n = clock.advance(Math.max(0, frame.dt) * frame.motion);
//   for (let i = 0; i < n; i++) {
//     if (i === n - 1) blend.hold();
//     fluid.step({ dt: clock.step, time, ... });
//   }
//   blend.show(clock.alpha);
//   return [blend.texture(fluid.dye), blend.texture(fluid.velocity)];
import { GpuError, type GpuCompute, type Pass, type PingPong, type RenderTarget } from "./gpu.ts";

const HOLD_GLSL = `
uniform sampler2D uField;
void main() {
  fragColor = texelFetch(uField, ivec2(gl_FragCoord.xy), 0);
}
`;

const SHOW_GLSL = `
uniform sampler2D uHeld;
uniform sampler2D uField;
uniform float uAlpha;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  fragColor = mix(texelFetch(uHeld, c, 0), texelFetch(uField, c, 0), uAlpha);
}
`;

interface View {
  readonly held: RenderTarget;
  readonly shown: RenderTarget;
}

/** Ping-pong fields drawn between their last two steps (see the header). */
export class StepBlend {
  readonly #views = new Map<PingPong, View>();
  readonly #hold: Pass;
  readonly #show: Pass;

  /** Throws GpuError when a pass does not compile or a target cannot be made. */
  constructor(gpu: GpuCompute, fields: readonly PingPong[], name: string) {
    this.#hold = gpu.pass(HOLD_GLSL, `${name} hold`);
    this.#show = gpu.pass(SHOW_GLSL, `${name} show`);
    for (const field of fields) {
      const like = {
        width: field.width,
        height: field.height,
        format: field.format,
        filter: field.read.filter,
        wrap: field.read.wrap,
      };
      this.#views.set(field, { held: gpu.target(like), shown: gpu.target(like) });
    }
  }

  /** Keep every field as it stands, to be shown blended from (see the header). */
  hold(): void {
    for (const [field, view] of this.#views) this.#keep(field, view.held);
  }

  /** Mix each held copy into its field by `alpha`, 0..1 (FixedStep.alpha). */
  show(alpha: number): void {
    const show = this.#show;
    for (const [field, view] of this.#views) {
      if (view.held.width !== field.width || view.held.height !== field.height)
        this.#keep(field, view.held);
      view.shown.resize(field.width, field.height);
      show.run(view.shown, {
        textures: { uHeld: view.held, uField: field },
        uniforms: { uAlpha: alpha },
      });
    }
  }

  /** `field` as last shown. */
  texture(field: PingPong): WebGLTexture {
    const view = this.#views.get(field);
    if (!view) throw new GpuError("StepBlend: that field is not one of its fields");
    return view.shown.texture;
  }

  dispose(): void {
    for (const view of this.#views.values()) {
      view.held.dispose();
      view.shown.dispose();
    }
    this.#hold.dispose();
    this.#show.dispose();
  }

  #keep(field: PingPong, held: RenderTarget): void {
    held.resize(field.width, field.height);
    this.#hold.run(held, { textures: { uField: field } });
  }
}
