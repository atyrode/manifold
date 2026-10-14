// The campfire's fuel (the `fuel` knob): a FuelBed (sims/fuel.ts) of the three logs the shader draws
// (the back log, then the two crossed in front), stepped on the motion clock and handed to the
// shader as CAMPFIRE_FUEL_TEXELS texels of uSim0 (rgba16f, nearest), written by campfireFuelTexels:
//   0, 1, 2   log i: wood left (0 burnt away), char, slump 0..1, laid on 0..1
//   3         the bed: heat (flames, 1 a steady fire), embers, smoke 0..1, spark burst 0..1
// While the knob is off nothing is stepped or uploaded and the shader draws the fire it always has.
// Each time it is switched on (and in every new sim that starts with it on) the fire opens under way
// (STEADY_FIRE: the back log 70% wood, the front ones 45 and 25%), so the same knobs show the same fire.
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { FUEL_STEP, FuelBed, STEADY_FIRE } from "../../sims/fuel.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Log slots (the shader draws three logs) and the texels that carry them and the bed. */
export const CAMPFIRE_LOGS = 3;
const CAMPFIRE_FUEL_TEXELS = CAMPFIRE_LOGS + 1;
const SEED = 0xf1e;

/** The bed as the shader reads it (the layout above), into `out` (CAMPFIRE_FUEL_TEXELS × 4 floats). */
function campfireFuelTexels(bed: FuelBed, out: Float32Array): void {
  for (const [i, log] of bed.logs.entries()) {
    out[i * 4] = log.mass;
    out[i * 4 + 1] = log.char;
    out[i * 4 + 2] = log.settle;
    out[i * 4 + 3] = log.placed;
  }
  const at = CAMPFIRE_LOGS * 4;
  out[at] = bed.heat;
  out[at + 1] = bed.embers;
  out[at + 2] = bed.smoke;
  out[at + 3] = bed.burst;
}

type CampfireKnob = "fuel" | "tend";

class CampfireFuel implements SceneSim {
  readonly #knobs: KnobReader<CampfireKnob>;
  readonly #tendSlot: number;
  readonly #texture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #data = new Float32Array(CAMPFIRE_FUEL_TEXELS * 4);
  readonly #bed = new FuelBed(CAMPFIRE_LOGS, SEED);
  readonly #clock = new FixedStep(FUEL_STEP, 4);
  #on = false;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<CampfireKnob>("campfire", params, ["fuel", "tend"]);
    this.#tendSlot = this.#knobs.trigger("tend");
    this.#texture = new DataTexture(gl, { width: CAMPFIRE_FUEL_TEXELS, height: 1, format: "rgba16f", filter: "nearest" });
    this.#textures = [this.#texture.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const minutes = this.#knobs.value(frame, "fuel");
    const on = minutes > 0;
    if (on && !this.#on) {
      this.#bed.open(STEADY_FIRE);
      this.#clock.reset();
    }
    this.#on = on;
    if (!on) return this.#textures;
    const bed = this.#bed;
    if (frame.fired[this.#tendSlot]) bed.addLog();
    const tend = this.#knobs.value(frame, "tend") > 0.5;
    const steps = this.#clock.advance(Math.max(0, frame.dt) * Math.max(0, frame.motion));
    for (let i = 0; i < steps; i++) bed.step(FUEL_STEP, minutes * 60, tend);
    campfireFuelTexels(bed, this.#data);
    this.#texture.upload(this.#data);
    return this.#textures;
  }

  dispose(): void {
    this.#texture.dispose();
  }
}

/** The fuel's simulation, for a scene whose `params` carry the `fuel` and `tend` knobs. */
export function campfireSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new CampfireFuel(gl, params);
}
