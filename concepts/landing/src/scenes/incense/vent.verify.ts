// GPU check (verify-browser.ts): the incense's ceiling vent. The real smoke fluid runs laminar
// (turbulence, doors and the hand off) three ways: the defaults, the vent drawing hard, and the
// room's draft turned up instead. The velocity is read back: the vent must speed the layer under the
// ceiling along while leaving the air the fresh thread rises through as it was, where a draft that
// moves the ceiling layer at all bends the thread with it.
import { effective } from "../../params.ts";
import { visitorAlone } from "../../principals.ts";
import { GpuCompute } from "../../sims/gpu.ts";
import type { SimFrame } from "../types.ts";
import { incenseScene } from "./index.ts";

/** The fields sampled on a COLUMNS × ROWS grid of texel centres over the frame. */
const COLUMNS = 96;
const ROWS = 54;
const ASPECT = 16 / 9;

/** One run's air: horizontal velocity per sample, and the fresh smoke (where the thread is). */
interface Air {
  vx: Float32Array;
  fresh: Float32Array;
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

export function incenseVentVerify(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  const target = gpu.target({ width: COLUMNS, height: ROWS, format: "rgba32f", filter: "nearest" });
  const sample = gpu.pass(
    "uniform sampler2D uField; void main() { fragColor = texture(uField, vUv); }",
    "incense vent sample",
  );
  const pixels = new Float32Array(COLUMNS * ROWS * 4);
  const read = (texture: WebGLTexture | undefined, channel: number): Float32Array => {
    if (texture === undefined) throw new Error("Incense fluid missing");
    sample.run(target, { textures: { uField: texture } });
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, COLUMNS, ROWS, gl.RGBA, gl.FLOAT, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return Float32Array.from({ length: COLUMNS * ROWS }, (_, k) => pixels[4 * k + channel] ?? 0);
  };

  /** The room with these knobs over the laminar defaults, after its prewarm and three seconds. */
  const room = (knobs: Record<string, number>): Air => {
    const sim = incenseScene.sim?.(gl);
    if (!sim) throw new Error("Incense simulation unavailable");
    const raw: Record<string, number> = { turbulence: 0, door: 0, hand: 0, dust: 0, ...knobs };
    const frame: SimFrame = {
      dt: 0,
      time: 0,
      motionTime: 0,
      motion: 1,
      now: 0,
      budget: Infinity,
      width: 320,
      height: 180,
      aspect: ASPECT,
      values: incenseScene.params.map((def) => effective(def, raw)),
      params: raw,
      triggers: Array.from({ length: 8 }, () => -1e4),
      fired: Array.from({ length: 8 }, () => false),
      ...visitorAlone(),
      passage: { enter: 1, exit: 0 },
    };
    // The prewarm takes at least a step a frame, however slow the machine, and holds still at dt 0
    // once done; then three seconds of live air.
    let textures = sim.frame(frame);
    for (let i = 0; i < 48; i++) textures = sim.frame(frame);
    frame.dt = 0.05;
    for (let i = 0; i < 60; i++) {
      frame.time += frame.dt;
      frame.motionTime += frame.dt;
      textures = sim.frame(frame);
    }
    const air = { vx: read(textures[1], 0), fresh: read(textures[0], 2) };
    sim.dispose();
    return air;
  };

  /**
   * How a run moved the air from `base`: the mean rightward change in the layer under the ceiling,
   * and the mean size of the change where the fresh thread rises (weighted by its fresh smoke).
   */
  const shift = (base: Air, run: Air): { ceiling: number; thread: number } => {
    let ceiling = 0;
    let layer = 0;
    let thread = 0;
    let smoke = 0;
    for (let j = 0; j < ROWS; j++) {
      const y = (j + 0.5) / ROWS;
      for (let i = 0; i < COLUMNS; i++) {
        const k = j * COLUMNS + i;
        const dvx = (run.vx[k] ?? 0) - (base.vx[k] ?? 0);
        if (y > 0.86 && y < 0.97) {
          ceiling += dvx;
          layer++;
        } else if (y < 0.6) {
          const fresh = base.fresh[k] ?? 0;
          thread += Math.abs(dvx) * fresh;
          smoke += fresh;
        }
      }
    }
    return { ceiling: ceiling / Math.max(1, layer), thread: thread / Math.max(1e-6, smoke) };
  };

  const still = room({});
  const vent = shift(still, room({ vent: 1, "vent-amount": 1 }));
  const draft = shift(still, room({ draft: 1 }));
  gpu.dispose();
  // Measured in software WebGL (frame heights per second): the vent moves the ceiling layer 0.077 and
  // the thread's air 0.0003; the draft from 0.4 to 1 moves the layer 0.024 and the thread 0.0045.
  check(
    vent.ceiling > 0.04,
    `The ceiling vent did not draw the layer under the ceiling along: ${vent.ceiling}`,
  );
  check(
    vent.thread < 0.05 * vent.ceiling,
    `The ceiling vent bent the thread: ${vent.thread} against ${vent.ceiling} under the ceiling`,
  );
  check(
    vent.thread / vent.ceiling < 0.1 * (draft.thread / draft.ceiling),
    `The vent bent the thread nearly as a draft does: ${vent.thread / vent.ceiling} vs ${draft.thread / draft.ceiling}`,
  );
  return {
    ventCeiling: vent.ceiling,
    ventThread: vent.thread,
    draftCeiling: draft.ceiling,
    draftThread: draft.thread,
  };
}
