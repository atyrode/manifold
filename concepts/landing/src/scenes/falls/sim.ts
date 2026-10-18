// The greenery layer's sim (`greenery`, a cover): the near bank's ferns, grown with the shared plant
// component (sims/plants.ts). Up to FALLS_CLUMPS clumps toward the bottom corners (more with more
// greenery), FALLS_FRONDS fronds each, rooted where the shader always drew them and shaped as it did
// (the same hashes: lengths, lift and droop). Each frond bends on its own spring: the wind across the
// bank, the eddies the fall's air stirs even when it is still, and the composer's one gust field
// (composer/gust.ts, ADR 0062 D4): the gust at the clump's root on the bank (FALLS_FERN_Z metres off,
// FALLS_FERN_M metres to a screen height there), pushing it along the gusts' heading across the view,
// the 'now' gust included. With the season the year turns and sheds them, and growth replaces them
// frond by frond. The shader (greeneryFront) draws them with plantFrond and keeps the rest: wet beads,
// drips, light and the entrance's spring up.
//
// Records: the layer's FALLS_ROWS rows of the composer's records atlas (writePlantRecords at
// ATLAS_WIDTH), clump c's frond j at record c · FALLS_FRONDS + j (hidden: no such clump, or shed).
// Units: the near bank's screen heights from the frame's bottom centre (the shader's qb); a record's
// a and b are the frond's lift and droop, its variant the shader's frond key.
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { gustAt, gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { fract, glslHash12 } from "../../sims/math.ts";
import {
  PLANT_SUMMER,
  PlantHabit,
  PlantRole,
  plantClimate,
  RootedPlants,
  writePlantRecords,
  type PlantSpecies,
} from "../../sims/plants.ts";
import { FALLS_CLUMPS, FALLS_FERN_M, FALLS_FERN_Z, FALLS_FRONDS } from "./constants.ts";

const KNOBS = ["greenery", "wind", "season", "growth"] as const;
type Knob = (typeof KNOBS)[number];

/** The gust's push across a clump per unit of the gust load (as the meadow's wildflowers take it). */
const GUST_PUSH = 1;

/** Boston-type ferns on wet ground: rigid fronds (the shader bends them) from a crown. */
const BANK_FERN: PlantSpecies = {
  id: "bank fern",
  moisture: [0.5, 1],
  sway: { hz: 0.55, damping: 0.4, give: 0.12, limit: 0.5 },
  year: { shed: 0.7, turn: 0.55, bloom: [0, 0] },
  life: { unfold: 10, span: 90 },
  detail: { simple: 6, min: 1.5 },
  build(plant) {
    const clump = plant.site.kind ?? 0;
    const inward = Math.floor(clump / 2);
    for (let j = 0; j < FALLS_FRONDS; j++) {
      const id = clump * 7 + j;
      const h = glslHash12(id, 83);
      const lift = 1.4 + 1.4 * h;
      const droop = 1.3 + 0.8 * fract(h * 7.3);
      const side = j % 2 === 0 ? -1 : 1;
      plant.organ({
        angle: Math.atan2(lift - droop, side),
        length: (0.07 + 0.08 * h) * (1 - 0.3 * inward),
        a: lift,
        b: droop,
        form: 0,
        variant: id,
        side,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
        slot: j,
      });
    }
  },
};

/** The bank's fern clumps and each one's root across the bank (screen heights), as the shader placed them. */
class BankFernsSim implements LayerSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #plants = new RootedPlants(FALLS_CLUMPS * FALLS_FRONDS, 0);
  readonly #climate = plantClimate();
  readonly #wind = newGustWind();
  /** Each clump's root x and its gust's push this frame. */
  readonly #rootX = new Float64Array(FALLS_CLUMPS);
  readonly #push = new Float64Array(FALLS_CLUMPS);
  #green = Number.NaN;
  #aspect = Number.NaN;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("falls greenery", params, KNOBS);
    this.#climate.wind = (_x, _y, out, plant) => {
      out[0] = (out[0] ?? 0) + (this.#push[plant] ?? 0);
    };
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const climate = this.#climate;
    const plants = this.#plants;
    climate.dt = frame.dt * frame.motion;
    climate.time = frame.motionTime;
    climate.season = knobs.on(frame, "season") ? knobs.amount(frame, "season") : PLANT_SUMMER;
    climate.growth = knobs.value(frame, "growth");
    // The wind across the bank, and the stir of the fall's own air even when it is still; the gusts
    // are the composer's (#push), none of the plants' own.
    climate.air.x = knobs.value(frame, "wind");
    climate.air.eddy = 0.5;
    climate.air.calm = 0.3;
    const gusts = frame.gusts;
    const wind = gustWind(
      this.#wind,
      gusts.wind,
      gusts.gusts,
      gusts.rate,
      gusts.nowAge,
      gusts.pass,
      gusts.shape,
    );
    for (let c = 0; c < FALLS_CLUMPS; c++)
      this.#push[c] =
        GUST_PUSH *
        wind.dirX *
        gustAt(wind, (this.#rootX[c] ?? 0) * FALLS_FERN_M, FALLS_FERN_Z, frame.motionTime, 0);
    plants.cells = frame.height;
    const green = knobs.value(frame, "greenery");
    if (green !== this.#green || frame.aspect !== this.#aspect) {
      this.#green = green;
      this.#aspect = frame.aspect;
      this.#grow(green, frame.aspect);
      plants.settle(climate);
    } else {
      plants.step(climate);
    }
    const data = frame.records.data;
    data.fill(0);
    writePlantRecords(plants, data, ATLAS_WIDTH, 0, FALLS_CLUMPS * FALLS_FRONDS);
    frame.records.touch();
  }

  // Records only: nothing of its own to release.
  dispose(): void {}

  /** The clumps the greenery grows on a frame of this aspect (see the header). */
  #grow(green: number, aspect: number): void {
    const plants = this.#plants;
    plants.clear();
    for (let c = 0; c < FALLS_CLUMPS; c++) {
      if ((c + 1) * 0.22 > green + 0.12) break;
      const side = c % 2 === 0 ? -1 : 1;
      const inward = Math.floor(c / 2);
      const x = side * (0.47 * aspect - 0.04 - 0.2 * inward - 0.06 * glslHash12(c, 81));
      this.#rootX[c] = x;
      plants.add(
        BANK_FERN,
        {
          x,
          y: 0.07 + 0.08 * (1 - inward),
          heading: Math.PI / 2,
          moisture: 0.8,
          kind: c,
          slot: c * FALLS_FRONDS,
        },
        () => 0,
      );
    }
  }
}

/** The greenery layer's sim (LayerCode.sim): its records only. */
export function greenerySim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new BankFernsSim(params);
}
