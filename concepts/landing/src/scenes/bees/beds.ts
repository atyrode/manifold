// The apiary's beds (ADR 0062 "Principals and chores": the host of the garden chores). Rows on the
// lawn (layout.ts BEES_BED_ROWS), which the gardening chore (gardening.ts) works through these
// affordances, the host's own state:
//   dig(row, to)    the lawn turned to soil from the row's middle out to `to` (0..1) of its half length;
//   plant(row, to)  seeds sown along it as far out: a seed comes up the moment the sowing passes it,
//                   the sowing taking BED_SOW_SECONDS from the middle to the ends, so a row greens
//                   from its middle outward;
//   weed(row, to)   its weeds pulled down to `to` (0..1).
// Nature's undo, on the growth clock (the motion clock: still at motion 0, `grow`): each seedling
// grows into a bloom over a minute or so (BED_GROW_SECONDS, each plant at its own rate), and weeds
// creep back over a dug row (BED_WEED_SECONDS to cover it), choking its plants one by one, each at
// its own share of weeds (a plant once choked stays gone: `lost` keeps the most the weeds reached),
// until the lawn has the row back and it is free to dig again.
//
// Each plant's place along its row, its height, its rate and its choking share are hashed per plant
// with the shader's hash22 and hash12 (sims/math.ts twins them in float32), so the bees land on the
// flowers the shader opens (garden.ts reads `open` and `head`). The apiary's sim (`apiarySim`) holds
// the beds and grows them, and lends them as its affordances; it draws nothing: the gardening layer
// draws them (shader.ts gardeningGlsl) from what its sim mirrors of them into its records.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { clamp, glslHash12, glslHash22 } from "../../sims/math.ts";
import {
  BEES_BED_ROWS,
  BEES_BED_SPACING,
  BEES_COSMOS,
  BEES_DAISY,
  BEES_POPPY,
  BEES_WILD,
} from "./layout.ts";

/** Seconds the sowing takes from a row's middle to its ends. */
export const BED_SOW_SECONDS = 2.2;
/** Seconds a seedling takes to open into a bloom at the rate of 1 (each plant's 0.85..1.15). */
export const BED_GROW_SECONDS = 60;
/** Seconds weeds take to cover a row once dug or weeded, and the lawn takes it back. */
export const BED_WEED_SECONDS = 360;
/** A plant's growth from which it is in flower (the shader opens its head over 0.6..0.95). */
export const BED_OPEN = 0.92;
/** Seconds of a row's clock past which nothing grows on: kept small enough for a half float. */
const BED_AGE_MOST = 600;

/** The height (m) a plant of each drift kind grows to, and its flower head's radius (m). */
export const BED_TALL: Readonly<Record<number, number>> = {
  [BEES_POPPY]: 0.42,
  [BEES_DAISY]: 0.3,
  [BEES_WILD]: 0.32,
  [BEES_COSMOS]: 0.55,
};
export const BED_HEAD: Readonly<Record<number, number>> = {
  [BEES_POPPY]: 0.055,
  [BEES_DAISY]: 0.04,
  [BEES_WILD]: 0.035,
  [BEES_COSMOS]: 0.05,
};

export class BedsError extends Error {}

/** One plant of a row, as the shader hashes it (gardeningGlsl's gardeningPlant). */
export interface BedPlant {
  /** Where it stands along its row: -1 at one end .. 1 at the other, its middle at 0. */
  readonly u: number;
  /** Metres right of the row's middle its stem stands. */
  readonly x: number;
  /** Its full height (m), its rate of growth, and the share of weeds that chokes it. */
  readonly tall: number;
  readonly rate: number;
  readonly choke: number;
}

/** Row `k`'s plants: the shader's `hash22(vec2(i, 7k + 3))` and `hash12(vec2(i + 17 | 41, 7k + 3))`. */
function plantsOf(k: number): readonly BedPlant[] {
  const row = BEES_BED_ROWS[k];
  if (row === undefined) throw new BedsError(`no bed ${k}`);
  const h = new Float64Array(2);
  const key = 7 * k + 3;
  return Array.from({ length: row.plants }, (_, i): BedPlant => {
    glslHash22(i, key, h);
    const [jitter = 0, size = 0] = h;
    return {
      u: (2 * i + 1) / row.plants - 1,
      x: (i + 0.5 - 0.5 * row.plants + 0.35 * (jitter - 0.5)) * BEES_BED_SPACING,
      tall: (BED_TALL[row.kind] ?? 0.3) * (0.8 + 0.4 * size),
      rate: 0.85 + 0.3 * glslHash12(i + 17, key),
      choke: 0.45 + 0.5 * glslHash12(i + 41, key),
    };
  });
}

/** Every row's plants, BEES_BED_ROWS order. */
export const BED_PLANTS: readonly (readonly BedPlant[])[] = BEES_BED_ROWS.map((_, k) =>
  plantsOf(k),
);

/**
 * A row's state, as the gardening layer's records hand it to the shader: how far out it is dug and
 * sown (0..1 of its half length from its middle), the seconds since its first seed went in, how
 * thick its weeds are and the most they have been since it was dug (0..1).
 */
export interface BedRow {
  dug: number;
  sown: number;
  age: number;
  weeds: number;
  lost: number;
}

/** The beds, the apiary's affordances (see the header). */
export class GardenBeds {
  readonly rows: readonly BedRow[] = BEES_BED_ROWS.map(() => ({
    dug: 0,
    sown: 0,
    age: 0,
    weeds: 0,
    lost: 0,
  }));

  /** Dig row `row` out to `to` of its half length from its middle. */
  dig(row: number, to: number): void {
    const r = this.#row(row);
    r.dug = Math.max(r.dug, clamp(to, 0, 1));
  }

  /** Sow dug row `row` out to `to` from its middle: its clock starts with the first seed. */
  plant(row: number, to: number): void {
    const r = this.#row(row);
    if (r.dug < 1 || !(to > r.sown)) return;
    if (r.sown <= 0) r.age = 0;
    r.sown = Math.min(1, to);
  }

  /** Pull row `row`'s weeds down to `to`. */
  weed(row: number, to: number): void {
    const r = this.#row(row);
    r.weeds = Math.min(r.weeds, Math.max(0, to));
  }

  /** `dt` seconds on the growth clock: the seedlings grow, the weeds creep, the lawn takes back a row they cover. */
  grow(dt: number): void {
    if (!(dt > 0)) return;
    for (const r of this.rows) {
      if (r.dug <= 0) continue;
      if (r.sown > 0) r.age = Math.min(BED_AGE_MOST, r.age + dt);
      r.weeds = Math.min(1, r.weeds + dt / BED_WEED_SECONDS);
      r.lost = Math.max(r.lost, r.weeds);
      if (r.weeds >= 1) GardenBeds.#lawn(r);
    }
  }

  /** Every row given back to the lawn (the gardening chore has gone). */
  clear(): void {
    for (const r of this.rows) GardenBeds.#lawn(r);
  }

  /** Plant `i` of row `row`'s growth now, 0 (not up yet, or choked) .. 1 (full grown). */
  growth(row: number, i: number): number {
    const r = this.#row(row);
    const plant = BED_PLANTS[row]?.[i];
    if (plant === undefined) throw new BedsError(`no plant ${i} in bed ${row}`);
    if (Math.abs(plant.u) > r.sown || plant.choke <= r.lost) return 0;
    const age = r.age - Math.abs(plant.u) * BED_SOW_SECONDS;
    return clamp((age * plant.rate) / BED_GROW_SECONDS, 0, 1);
  }

  /** How many of row `row`'s plants are in flower. */
  open(row: number): number {
    let n = 0;
    const plants = BED_PLANTS[row] ?? [];
    for (let i = 0; i < plants.length; i++) if (this.growth(row, i) >= BED_OPEN) n++;
    return n;
  }

  #row(row: number): BedRow {
    const r = this.rows[row];
    if (r === undefined) throw new BedsError(`no bed ${row}`);
    return r;
  }

  static #lawn(r: BedRow): void {
    r.dug = 0;
    r.sown = 0;
    r.age = 0;
    r.weeds = 0;
    r.lost = 0;
  }
}

/** The apiary's sim: its beds, grown on the motion clock and lent to the layers that tend or follow them. */
class ApiarySim implements LayerSim {
  readonly affordances = new GardenBeds();

  frame(frame: LayerFrame): void {
    this.affordances.grow(Math.max(0, frame.dt) * Math.max(0, frame.motion));
  }

  dispose(): void {}
}

export function apiarySim(): LayerSim {
  return new ApiarySim();
}
