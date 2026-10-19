// The greenery layer's sim (`greenery`, a cover): the near bank's ferns, grown with the shared plant
// component (sims/plants.ts). Up to FALLS_CLUMPS clumps toward the bottom corners (more with more
// greenery), FALLS_FRONDS fronds each, rooted where the shader always drew them and shaped as it did
// (the same hashes: lengths, lift and droop). Each frond bends on its own spring: the wind across the
// bank, the eddies the fall's air stirs even when it is still, and the composer's one gust field
// (composer/gust.ts, ADR 0062 D4): the gust at the clump's root on the bank (FALLS_FERN_Z metres off,
// FALLS_FERN_M metres to a screen height there), pushing it along the gusts' heading across the view,
// the 'now' gust included. With the season the year turns and sheds them, and growth replaces them
// frond by frond. The shader (greeneryFront) draws them with plantFrond and keeps the rest: wet beads,
// light and the entrance's spring up.
//
// The water dripping off them is the composer's falling things (composer/falling.ts, README "Falling
// things"): each frame the sim names the drip points under the leaflets of every frond's outer,
// drooping part (FERN_LANES at most, about FERN_DRIP_SPACING apart along it), where the shader draws
// the frond (the entrance's spring up and the sway included), and the bank each clump grows from as
// the ledge their drops land on, splash and wet.
//
// Records: the layer's FALLS_ROWS rows of the composer's records atlas (writePlantRecords at
// ATLAS_WIDTH), clump c's frond j at record c · FALLS_FRONDS + j (hidden: no such clump, or shed).
// Units: the near bank's screen heights from the frame's bottom centre (the shader's qb); a record's
// a and b are the frond's lift and droop, its variant the shader's frond key.
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { gustAt, gustWind, newGustWind } from "../../composer/gust.ts";
import type { FallSurface, LayerFrame, LayerSim } from "../../composer/types.ts";
import type { LevelCamera } from "../../sims/camera.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { fract, glslFbm3, glslHash12, smoothstep } from "../../sims/math.ts";
import {
  PLANT_SUMMER,
  PlantHabit,
  PlantRole,
  plantClimate,
  RootedPlants,
  writePlantRecords,
  type PlantSpecies,
} from "../../sims/plants.ts";
import {
  FALLS_CLUMPS,
  FALLS_FERN_M,
  FALLS_FERN_Z,
  FALLS_FRONDS,
  fallsSpring,
} from "./constants.ts";

const KNOBS = ["greenery", "wind", "season", "growth"] as const;
type Knob = (typeof KNOBS)[number];

/** The gust's push across a clump per unit of the gust load (as the meadow's wildflowers take it). */
const GUST_PUSH = 1;

/** Drip points a frond holds at most, and metres between them along its drooping part (rainDrips' lanes'). */
const FERN_LANES = 4;
const FERN_DRIP_SPACING = 0.07;
/** Screen heights the bank the drops land on reaches past a side's clumps, and its steps across. */
const BANK_REACH = 0.25;
const BANK_STEP = 0.02;

/** poolFront's crowns along the near bank's top (shader.ts fallsCrowns), line for line. */
function bankCrowns(x: number, size: number, seed: number): number {
  const c = Math.floor(x / size);
  let h = 0;
  for (let k = -1; k <= 1; k++) {
    const id = c + k;
    const r = size * (0.5 + 0.5 * glslHash12(id, seed));
    const dx = Math.abs(x - (id + 0.5 + (glslHash12(id, seed + 1) - 0.5) * 0.6) * size);
    const crown =
      glslHash12(id, seed + 2) < 0.3
        ? Math.max(2.2 * r - dx * 4.5, 0)
        : Math.sqrt(Math.max(r * r - dx * dx, 0));
    h = Math.max(h, crown);
  }
  return h;
}

/**
 * The near bank's top (poolFront's bankTop: its boulders along the frame's bottom, drawn below
 * 0.3), screen heights up from the frame's bottom at qb.x across a frame of `aspect`: the ground the
 * drops off the ferns land on.
 */
function bankTop(x: number, aspect: number): number {
  const edgeness = smoothstep(0.15, 1, Math.abs(x) / Math.max(0.5 * aspect, 0.3));
  const top =
    0.018 +
    0.025 * glslFbm3(x * 4, 2) +
    0.1 * edgeness * edgeness +
    bankCrowns(x + 0.37, 0.11, 13) * (0.12 + 0.5 * edgeness);
  return Math.min(top, 0.3);
}

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
  /** Each clump's root across the bank (screen heights) and its gust's push this frame. */
  readonly #rootX = new Float64Array(FALLS_CLUMPS);
  readonly #push = new Float64Array(FALLS_CLUMPS);
  /** Clumps grown on this frame. */
  #clumps = 0;
  /** The near bank's top under each side's clumps (see #drip), laid out with them. */
  readonly #banks: FallSurface[] = [];
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
      this.#grow(green, frame.aspect, frame.rig);
      plants.settle(climate);
    } else {
      plants.step(climate);
    }
    const data = frame.records.data;
    data.fill(0);
    writePlantRecords(plants, data, ATLAS_WIDTH, 0, FALLS_CLUMPS * FALLS_FRONDS);
    frame.records.touch();
    this.#drip(frame);
  }

  /**
   * The water off the fronds this frame (see the header): drip points under the leaflets' mean hang
   * along each shown frond's outer part (u 0.4..0.95 of it), as greeneryFront draws the frond, those
   * above the near bank's top; and the bank's top under each side's clumps, BANK_STEP-wide ledges,
   * as the ground their drops land on: at the ferns' depth (FALLS_FERN_Z), where the boulders' top
   * meets them on the screen, through the rig at rest.
   */
  #drip(frame: LayerFrame): void {
    const plants = this.#plants;
    const rig = frame.rig;
    const z = FALLS_FERN_Z;
    // The entrance's spring up (greeneryFront's fernGrow): nothing drips before the ferns are up.
    const grow = fallsSpring((frame.passage.enter - 0.5) / 0.4);
    if (grow <= 0.01 || this.#clumps === 0) return;
    const g = Math.min(1, grow);
    const metres = z / rig.focal;
    const aspect = frame.aspect;
    for (let i = 0; i < plants.count; i++) {
      if ((plants.tier[i] ?? 0) <= 0) continue;
      const len = (plants.grown[i] ?? 0) * grow;
      if (len <= 0) continue;
      const at = plants.x[i] ?? 0;
      const rootX = at + Math.sign(at) * 0.08 * (1 - g);
      const side = plants.side[i] ?? 1;
      const lift = plants.a[i] ?? 0;
      const droop = plants.b[i] ?? 0;
      const bend = side * (plants.theta[i] ?? 0) * Math.hypot(1, lift - droop);
      const curve = droop * (1 - 0.6 * (1 - g)) - bend;
      const lanes = Math.max(
        1,
        Math.min(FERN_LANES, Math.round((0.65 * len * metres) / FERN_DRIP_SPACING)),
      );
      const record = plants.slot[i] ?? i;
      for (let k = 0; k < lanes; k++) {
        const u = 0.4 + (0.55 * (k + 0.5)) / lanes;
        // The spine (plantFrond's parabola), less the leaflets' mean hang below it there.
        const qx = rootX + side * u * len;
        const qy = (plants.y[i] ?? 0) + len * (lift * u - curve * u * u);
        const tip = qy - (len * 0.17 * (1 - u) * 0.7456 + 0.0011);
        if (tip <= bankTop(qx, aspect)) continue;
        frame.falling.drip(record * FERN_LANES + k, rig.worldX(qx, z), rig.worldY(tip, z), z);
      }
    }
    for (const bank of this.#banks) frame.falling.surface(bank);
  }

  // Records and the falling things' declarations only: nothing of its own to release.
  dispose(): void {}

  /**
   * The clumps the greenery grows on a frame of this aspect (see the header), and the bank's top
   * under each side's (even clumps on the left, odd on the right), BANK_STEP-wide ledges reaching
   * BANK_REACH past their roots: their drops' ground (#drip).
   */
  #grow(green: number, aspect: number, rig: LevelCamera): void {
    const plants = this.#plants;
    plants.clear();
    this.#clumps = 0;
    for (let c = 0; c < FALLS_CLUMPS; c++) {
      if ((c + 1) * 0.22 > green + 0.12) break;
      const side = c % 2 === 0 ? -1 : 1;
      const inward = Math.floor(c / 2);
      const x = side * (0.47 * aspect - 0.04 - 0.2 * inward - 0.06 * glslHash12(c, 81));
      this.#rootX[c] = x;
      this.#clumps = c + 1;
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
    const z = FALLS_FERN_Z;
    this.#banks.length = 0;
    for (let s = 0; s < 2; s++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let c = s; c < this.#clumps; c += 2) {
        lo = Math.min(lo, (this.#rootX[c] ?? 0) - BANK_REACH);
        hi = Math.max(hi, (this.#rootX[c] ?? 0) + BANK_REACH);
      }
      for (let x0 = Math.max(lo, -0.5 * aspect); x0 < Math.min(hi, 0.5 * aspect); x0 += BANK_STEP)
        this.#banks.push({
          kind: "ledge",
          y: rig.worldY(bankTop(x0 + 0.5 * BANK_STEP, aspect), z),
          from: [rig.worldX(x0, z), z],
          to: [rig.worldX(x0 + BANK_STEP, z), z],
          depth: 0.6,
        });
    }
  }
}

/** The greenery layer's sim (LayerCode.sim): its records, and its drip points and banks. */
export function greenerySim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new BankFernsSim(params);
}
