// The campfire's fuel (the `fuel` knob): a FuelBed (sims/fuel.ts) of the three logs the shader draws
// (the back log, then the two crossed in front), stepped on the motion clock and handed to the
// campfire layer's GLSL (shader.ts) as CAMPFIRE_FUEL_TEXELS texels of its row of the records atlas,
// written by campfireFuelTexels:
//   0, 1, 2   log i: wood left (0 burnt away), char, slump 0..1, laid on 0..1
//   3         the bed: heat (flames, 1 a steady fire), embers, smoke 0..1, spark burst 0..1
// The bed steps FUEL_STEP (a twentieth of a second) at a time; the texels are drawn between its last
// two steps by the clock's alpha, so the fire changes smoothly at any frame rate.
// While the knob is off nothing is stepped or written and the shader draws the fire it always has.
// Each time it is switched on (and in every new sim that starts with it on) the fire opens under way
// (STEADY_FIRE: the back log 70% wood, the front ones 45 and 25%), so the same knobs show the same fire.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { FixedStep } from "../../sims/clock.ts";
import { FUEL_STEP, FuelBed, STEADY_FIRE } from "../../sims/fuel.ts";
import { CAMPFIRE_LOGS } from "./constants.ts";

/** The texels that carry the logs and the bed. */
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

class CampfireFuel implements LayerSim {
  readonly #knobs: KnobReader<CampfireKnob>;
  readonly #tendSlot: number;
  /** The texels after the step before last and after the last; written between them. */
  readonly #was = new Float32Array(CAMPFIRE_FUEL_TEXELS * 4);
  readonly #now = new Float32Array(CAMPFIRE_FUEL_TEXELS * 4);
  readonly #bed = new FuelBed(CAMPFIRE_LOGS, SEED);
  readonly #clock = new FixedStep(FUEL_STEP, 4);
  #on = false;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<CampfireKnob>("campfire", params, ["fuel", "tend"]);
    this.#tendSlot = this.#knobs.trigger("tend");
  }

  frame(frame: LayerFrame): void {
    const minutes = this.#knobs.value(frame, "fuel");
    const on = minutes > 0;
    if (on && !this.#on) {
      this.#bed.open(STEADY_FIRE);
      this.#clock.reset();
      campfireFuelTexels(this.#bed, this.#now);
      this.#was.set(this.#now);
    }
    this.#on = on;
    if (!on) return;
    const bed = this.#bed;
    if (frame.fired[this.#tendSlot]) bed.addLog();
    const tend = this.#knobs.value(frame, "tend") > 0.5;
    const steps = this.#clock.advance(Math.max(0, frame.dt) * Math.max(0, frame.motion));
    for (let i = 0; i < steps; i++) {
      this.#was.set(this.#now);
      bed.step(FUEL_STEP, minutes * 60, tend);
      campfireFuelTexels(bed, this.#now);
    }
    const alpha = this.#clock.alpha;
    const was = this.#was;
    const now = this.#now;
    const data = frame.records.data;
    for (let i = 0; i < CAMPFIRE_FUEL_TEXELS * 4; i++) {
      const a = was[i] ?? 0;
      data[i] = a + ((now[i] ?? 0) - a) * alpha;
    }
    frame.records.touch();
  }

  dispose(): void {}
}

/** The campfire layer's sim (LayerCode.sim), for a composition whose `params` carry `fuel` and `tend`. */
export function campfireSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new CampfireFuel(params);
}
