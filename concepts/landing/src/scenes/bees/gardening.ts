// The gardening chore's sim (ADR 0062 "Principals and chores"; #1082 J1, agents at work): the plan
// and the tool of the garden chores, on the apiary's beds (beds.ts, the host's state and nature's
// undo, reached through LayerFrame.host). It acts only through the cast's agents (SimFrame.principals
// of kind `agent`), and there are beds only while some are about: when the last agent goes, the beds
// go back to the lawn with it, as the program drawn without agents has none (shader.ts
// gardeningGlsl, behind PRINCIPAL_CURSORS). So without agents its records hold nothing and a page
// draws as it did.
//
// The plan (`interest`, where the cast sends its agents): the beds waiting on their next step (dug
// and not yet sown, or weedy), then a fresh bed for each agent beyond them (one at least), in an order
// the seed knob shuffles, then the planted beds with the most weeds, as long as there are agents to
// send; never a bed being worked, nor one whose middle is out of the frame. The tool: an agent's press
// on a bed (within REACH of its row on screen) sets the bed's next job going, which spreads from the
// row's middle, where the agent stands, out to its ends: a bed of lawn is dug (DIG_SECONDS), a dug
// one sown (BED_SOW_SECONDS: the host's pace, by which the shader times each seedling), a planted
// one weeded (PULL_SECONDS). Jobs run on the motion clock, so the chore stands still at motion 0, and
// a press counts only at rest (not through the scene's passage, nor the layer's own entrance or exit).
// It draws on no chance: the same seed and the same presses give the same beds.
//
// Records (its row of the atlas, which gardeningGlsl reads): texel 0 x how many beds are dug; texel
// 1 + 2k bed k's dug, sown, age (s) and weeds, texel 2 + 2k x the most its weeds have been (beds.ts
// BedRow). Turning the chore off gives its beds back to the lawn (`dispose`).
import type { LayerFrame, LayerSim, RecordRows } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { CAST_MARGIN } from "../../principals.ts";
import { hash31 } from "../../sims/math.ts";
import type { ScenePoint } from "../types.ts";
import { BED_SOW_SECONDS, GardenBeds } from "./beds.ts";
import { BEES_BED_ROWS, BEES_BED_SPACING, BEES_CAM, BEES_YH, beesStage } from "./layout.ts";

/** Seconds a bed takes to dig from its middle to its ends, and to weed. */
const DIG_SECONDS = 2.6;
const PULL_SECONDS = 1.8;
/** Weeds from which a planted bed is waiting to be weeded. */
const WEEDY = 0.2;
/** How far (screen heights) from a bed's row on screen a press still counts on it. */
const REACH = 0.035;

type Job = "dig" | "sow" | "weed";

/** The tool at work on a bed: its job (none: idle), seconds into it, and the weeds it began from. */
interface Work {
  job: Job | undefined;
  t: number;
  from: number;
}

/** Each bed's depth (m) and half its row's length (m). */
const BEDS = BEES_BED_ROWS.map((row) => ({
  ...row,
  z: BEES_CAM / (BEES_YH - row.y),
  half: 0.5 * row.plants * BEES_BED_SPACING,
}));

class GardeningSim implements LayerSim {
  readonly #knobs: KnobReader<"seed">;
  #beds: GardenBeds | undefined;
  readonly #work: readonly Work[] = BEDS.map(() => ({ job: undefined, t: 0, from: 0 }));
  /** Agents present last frame: how many fresh beds the plan holds. */
  #agents = 0;
  /** The seed the fresh beds' order was shuffled by, and the order. */
  #seed = Number.NaN;
  readonly #order: number[] = BEDS.map((_, k) => k);
  readonly #interest: ScenePoint[] = [];
  readonly #points: { x: number; y: number }[] = BEDS.map(() => ({ x: 0, y: 0 }));
  readonly #listed = new Uint8Array(BEDS.length);
  /** Some bed was dug when the records were last written. */
  #packed = false;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("gardening", params, ["seed"]);
  }

  frame(frame: LayerFrame): void {
    const host = frame.host("apiary");
    const beds = host instanceof GardenBeds ? host : undefined;
    this.#beds = beds;
    const seed = this.#knobs.value(frame, "seed");
    if (seed !== this.#seed) {
      this.#seed = seed;
      const rank = BEDS.map((_, k) => hash31(Math.round(seed), k, 0x6a7d));
      this.#order.sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0) || a - b);
    }
    let agents = 0;
    for (const hand of frame.principals) if (hand.kind === "agent") agents++;
    this.#agents = agents;
    if (beds !== undefined && agents === 0) {
      beds.clear();
      for (const work of this.#work) work.job = undefined;
    } else if (beds !== undefined) {
      if (frame.passage.enter >= 1 && frame.passage.exit <= 0) this.#presses(frame, beds);
      this.#tend(beds, Math.max(0, frame.dt) * Math.max(0, frame.motion));
    }
    this.#pack(frame.records, beds);
  }

  /** The beds waiting on their next step, a fresh one for each agent beyond them, then the weediest (see the header). */
  interest(aspect: number): readonly ScenePoint[] {
    const points = this.#interest;
    points.length = 0;
    const beds = this.#beds;
    if (beds === undefined) return points;
    const listed = this.#listed;
    listed.fill(0);
    const stage = beesStage(aspect);
    const want = Math.max(1, this.#agents);
    const list = (k: number): void => {
      const point = this.#points[k];
      const bed = BEDS[k];
      if (point === undefined || bed === undefined) return;
      point.x = 0.5 + (bed.f * stage) / aspect;
      point.y = bed.y;
      listed[k] = 1;
      points.push(point);
    };
    const open = (k: number): boolean => {
      const bed = BEDS[k];
      const x = 0.5 + ((bed?.f ?? 0) * stage) / aspect;
      return this.#work[k]?.job === undefined && x >= CAST_MARGIN && x <= 1 - CAST_MARGIN;
    };
    beds.rows.forEach((r, k) => {
      if (open(k) && ((r.dug >= 1 && r.sown <= 0) || (r.sown > 0 && r.weeds >= WEEDY))) list(k);
    });
    for (const k of this.#order)
      if (points.length < want && open(k) && (beds.rows[k]?.dug ?? 1) <= 0) list(k);
    while (points.length < want) {
      let weediest = -1;
      beds.rows.forEach((r, k) => {
        if (listed[k] === 0 && open(k) && r.sown > 0 && r.weeds > 0)
          if (weediest < 0 || r.weeds > (beds.rows[weediest]?.weeds ?? 0)) weediest = k;
      });
      if (weediest < 0) break;
      list(weediest);
    }
    return points;
  }

  dispose(): void {
    this.#beds?.clear();
  }

  /** Each agent's press on a bed sets its next job going, where none is under way. */
  #presses(frame: LayerFrame, beds: GardenBeds): void {
    const stage = beesStage(frame.aspect);
    for (const hand of frame.principals) {
      if (hand.kind !== "agent" || !hand.inside || !hand.pressed) continue;
      const sx = (hand.x - 0.5) * frame.aspect;
      let pick = -1;
      let best = Infinity;
      BEDS.forEach((bed, k) => {
        const off = Math.max(0, Math.abs(sx - bed.f * stage) - bed.half / bed.z);
        const near = Math.hypot(off, hand.y - bed.y);
        if (near <= REACH && near < best) {
          best = near;
          pick = k;
        }
      });
      const work = this.#work[pick];
      const r = beds.rows[pick];
      if (work === undefined || r === undefined || work.job !== undefined) continue;
      work.t = 0;
      work.from = r.weeds;
      if (r.dug <= 0) work.job = "dig";
      else if (r.dug >= 1 && r.sown <= 0) work.job = "sow";
      else if (r.sown > 0 && r.weeds > 0) work.job = "weed";
    }
  }

  /** The jobs under way, `dt` seconds of the motion clock on, each spreading out from its bed's middle. */
  #tend(beds: GardenBeds, dt: number): void {
    if (!(dt > 0)) return;
    this.#work.forEach((work, k) => {
      if (work.job === undefined) return;
      work.t += dt;
      if (work.job === "dig") beds.dig(k, work.t / DIG_SECONDS);
      else if (work.job === "sow") beds.plant(k, work.t / BED_SOW_SECONDS);
      else beds.weed(k, work.from * (1 - work.t / PULL_SECONDS));
      const length =
        work.job === "dig" ? DIG_SECONDS : work.job === "sow" ? BED_SOW_SECONDS : PULL_SECONDS;
      if (work.t >= length) work.job = undefined;
    });
  }

  /** The beds into the records (see the header), going up while any is dug and once after the last. */
  #pack(records: RecordRows, beds: GardenBeds | undefined): void {
    const data = records.data;
    let dug = 0;
    BEDS.forEach((_, k) => {
      const r = beds?.rows[k];
      const at = (1 + 2 * k) * 4;
      data[at] = r?.dug ?? 0;
      data[at + 1] = r?.sown ?? 0;
      data[at + 2] = r?.age ?? 0;
      data[at + 3] = r?.weeds ?? 0;
      data[at + 4] = r?.lost ?? 0;
      if ((r?.dug ?? 0) > 0) dug++;
    });
    data[0] = dug;
    if (dug > 0 || this.#packed) records.touch();
    this.#packed = dug > 0;
  }
}

/** The gardening chore's sim, for a composition whose `params` carry the composer's `seed`. */
export function gardeningSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new GardeningSim(params);
}
