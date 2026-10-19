// The garden's rooted plants (the shared plant component, sims/plants.ts), on their layers' records:
// the temple woods over the wall (`templeWoods`) and the border along its foot (`border`).
//
// Every crown of the woods' two rows is a tree: one stem from where its trunk stands behind the wall
// up to the row's crown tops, its crown drawn by the shader where the stem's tip carries it. The
// border is clumps of fern and mondo grass rooted in the gutter, following the season and, with its
// growth, replacing their fronds and blades. Both sway with the wind knob and its eddies, and the
// gusts cross them where they stand: the composer's one field (ADR 0062 D4, its 'now' included) and
// the exit's own gust, a front from the garden's upwind end (sim.ts). In still air, once they have
// swung out, they are set exactly at rest: the woods then stand exactly as the shader always drew
// them.
//
// Records (writePlantRecords at ATLAS_WIDTH): the woods' stems, the far row's crown k at k and the
// near row's at GARDEN_WOODS.crowns + k, in the frame (x screen heights from its left edge, y uv
// height); the border's organs, bin b's at GARDEN_BORDER.organs · b + 0..organs - 1, in its plane
// (garden X, height above the gutter).
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { clamp, fract, hash31 } from "../../sims/math.ts";
import {
  PLANT_SUMMER,
  PlantHabit,
  PlantRole,
  plantClimate,
  RootedPlants,
  writePlantRecords,
  type PlantClimate,
  type PlantSpecies,
} from "../../sims/plants.ts";
import { windSign } from "../../sims/wind.ts";
import { OX } from "./build.ts";
import { GARDEN, gardenSeasons, type GardenSeason } from "./constants.ts";
import { Gravel } from "./gravel.ts";
import {
  GARDEN_BORDER,
  GARDEN_BORDER_FORM,
  GARDEN_WOODS,
  exitFront,
  fieldPush,
  gustAbout,
  metresAcross,
  metresAhead,
} from "./sim.ts";

/** The breeze's eddies on the woods and the border, as a share of it; in still air they stand still. */
const PLANT_EDDY = 0.6;
/** Seconds of still air (no wind, no gust about) after which the plants are set exactly at rest. */
const PLANT_SETTLE = 6;
/** The plant component's year (0..1 from the start of spring) for the season knob: mid-spring, high summer, mid-autumn, deep winter. */
const PLANT_SEASON: Readonly<Record<GardenSeason, number>> = {
  spring: 0.15,
  summer: PLANT_SUMMER,
  autumn: 0.66,
  winter: 0.88,
};
/** The plants' builds draw no randomness of their own (the layout and hashes place everything). */
const NO_DRAWS = (): number => 0;

/** A tree of the temple woods (cedar, camphor): one stem carrying its crown, which the shader draws; evergreen. */
const WOODS_TREE: PlantSpecies = {
  id: "temple tree",
  moisture: [0, 1],
  sway: { hz: 0.45, damping: 0.25, give: 0.12, limit: 0.3 },
  year: { shed: 0, turn: 2, bloom: [0, 0] },
  life: { unfold: 10, span: 600 },
  detail: { simple: 2, min: 0.5 },
  build(plant) {
    const row = plant.site.kind === 1 ? GARDEN_WOODS.near : GARDEN_WOODS.far;
    plant.organ({ angle: Math.PI / 2, length: row.length, form: 0, slot: 0 });
  },
};

/**
 * A shield fern in the gutter (Dryopteris): five to seven rigid fronds from its crown, in pairs from
 * the outside in, the inner ones shorter and more upright; half of them die back over winter. Its
 * record's a and b are a frond's lift and droop (plantFrond).
 */
const BORDER_FERN: PlantSpecies = {
  id: "shield fern",
  moisture: [0.5, 1],
  sway: { hz: 0.6, damping: 0.4, give: 0.14, limit: 0.5 },
  year: { shed: 0.5, turn: 0.58, bloom: [0, 0] },
  life: { unfold: 10, span: 120 },
  detail: { simple: 6, min: 1.5 },
  build(plant) {
    const bin = plant.site.kind ?? 0;
    const fronds = 5 + Math.floor(3 * hash31(bin, 0, 0x6665));
    const scale = 0.6 + 0.4 * plant.vigour;
    for (let j = 0; j < fronds; j++) {
      const h = hash31(bin, j + 1, 0x6665);
      const inner = Math.floor(j / 2);
      const lift = 1.4 + 0.35 * inner + 0.6 * h;
      const droop = 1.3 + 0.7 * fract(h * 7.3);
      const side = j % 2 === 0 ? -1 : 1;
      plant.organ({
        angle: Math.atan2(lift - droop, side),
        length: (0.036 + 0.014 * fract(h * 3.1)) * (1 - 0.14 * inner) * scale,
        a: lift,
        b: droop,
        form: GARDEN_BORDER_FORM.fern,
        variant: j,
        side,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
        slot: j,
      });
    }
  },
};

/**
 * A tuft of mondo grass (Ophiopogon): seven narrow evergreen blades fanning out of the root and
 * arching over, the outer ones furthest. Its record's a is a blade's curl (its turn at rest).
 */
const BORDER_MONDO: PlantSpecies = {
  id: "mondo grass",
  moisture: [0.3, 1],
  sway: { hz: 0.8, damping: 0.35, give: 0.2, limit: 0.6 },
  year: { shed: 0, turn: 0.7, bloom: [0, 0] },
  life: { unfold: 8, span: 90 },
  detail: { simple: 4, min: 1 },
  build(plant) {
    const bin = plant.site.kind ?? 0;
    const scale = 0.7 + 0.3 * plant.vigour;
    for (let j = 0; j < GARDEN_BORDER.organs; j++) {
      const h = hash31(bin, j, 0x6d6f);
      // Across the tuft: -1 leaning left .. 1 leaning right.
      const lean = (j - 3) / 3 + 0.25 * (h - 0.5);
      plant.organ({
        angle: Math.PI / 2 - 0.6 * lean,
        length: (0.017 + 0.009 * fract(h * 5.1)) * scale,
        width: 0.0016,
        curl: -1.5 * lean,
        a: -1.5 * lean,
        form: GARDEN_BORDER_FORM.mondo,
        variant: j,
        role: PlantRole.leaf,
        slot: j,
      });
    }
  },
};

/**
 * The woods' trees: a stem for every crown of both rows, rooted under the middle of its crown as the
 * shader's phase places it on average (its noise moves a crown by under a twelfth of a screen height,
 * which only shifts when a gust's front reaches it).
 */
function growWoods(woods: RootedPlants): void {
  woods.clear();
  for (const [kind, row] of [GARDEN_WOODS.far, GARDEN_WOODS.near].entries()) {
    for (let k = 0; k < GARDEN_WOODS.crowns; k++) {
      const x = (k + 0.5 - 0.5 * row.wobble) / row.rate;
      woods.add(
        WOODS_TREE,
        { x, y: row.foot, heading: Math.PI / 2, kind, slot: kind * GARDEN_WOODS.crowns + k },
        NO_DRAWS,
      );
    }
  }
}

/**
 * The border for its fullness (0: nothing planted): a clump in each bin the fullness plants (the
 * bins' own hashes decide which, so a fuller border keeps the clumps of a sparser one), a fern in two
 * bins of five, mondo grass in the rest, rooted off the bin's middle.
 */
function growBorder(border: RootedPlants, fullness: number): void {
  border.clear();
  if (!(fullness > 0)) return;
  for (let bin = 0; bin < GARDEN_BORDER.bins; bin++) {
    if (hash31(bin, 1, 0x626f) >= fullness) continue;
    const species = hash31(bin, 2, 0x626f) < 0.4 ? BORDER_FERN : BORDER_MONDO;
    const x = (bin + 0.5 + 0.5 * (hash31(bin, 3, 0x626f) - 0.5)) * GARDEN_BORDER.pitch;
    const site = {
      x,
      y: 0,
      heading: Math.PI / 2,
      moisture: 0.8,
      lush: 0.7 + 0.3 * hash31(bin, 4, 0x626f),
      kind: bin,
      slot: GARDEN_BORDER.organs * bin,
    };
    border.add(species, site, NO_DRAWS);
  }
}

/**
 * The air one of the garden's plant systems stands in: the wind knob's breeze with its eddies, and
 * the gusts where each plant stands (the field at `ahead` metres, the exit's front at its garden X,
 * `gardenX` of its x in its own frame). The plants swing while the air moves them; once the air is
 * still (no wind, no gust about) they are set exactly at rest, after PLANT_SETTLE seconds of swinging
 * out or at once while time stands still, and stepping then keeps them there. On the first frame,
 * and with time standing still when the wind or the season changes, they are set at rest in the air
 * as it is (a still step).
 */
class PlantAir {
  readonly climate: PlantClimate = plantClimate();
  readonly #wind = newGustWind();
  #time = 0;
  #exit = 0;
  #sign = 1;
  #stillFor = 0;
  #rested = false;
  /** The wind and season the plants last moved in; undefined before the first frame. */
  #lastWind: number | undefined = undefined;
  #lastSeason = -1;

  constructor(gardenX: (x: number) => number, ahead: number) {
    this.climate.wind = (x, _y, out) => {
      const gx = gardenX(x);
      out[0] =
        (out[0] ?? 0) +
        fieldPush(this.#wind, metresAcross(gx), ahead, this.#time) +
        exitFront(this.#exit, this.#sign, gx);
    };
  }

  /**
   * The air for this frame (the wind knob, the season choice, the growth's pace): the seconds the
   * plants move, the motion's (the exit's gust plays in real time whatever the motion).
   */
  update(frame: LayerFrame, wind: number, season: number, growth: number): number {
    const g = frame.gusts;
    gustWind(this.#wind, g.wind, g.gusts, g.rate, g.nowAge, g.pass, g.shape);
    this.#time = frame.motionTime;
    const exit = frame.passage.exit;
    if (exit > 0 && !(this.#exit > 0)) this.#sign = windSign(wind);
    this.#exit = exit;
    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const h = dt * Math.max(frame.motion, exit > 0 ? 1 : 0);
    const climate = this.climate;
    climate.dt = h;
    climate.time = frame.motionTime;
    climate.season = PLANT_SEASON[gardenSeasons[season] ?? "autumn"];
    climate.growth = growth;
    climate.air.x = wind;
    climate.air.eddy = PLANT_EDDY;
    return h;
  }

  /** `plants` moved `h` seconds in this frame's air (see the class); `retier`: their cells changed. */
  sway(plants: RootedPlants, frame: LayerFrame, h: number, retier: boolean): void {
    const wind = this.climate.air.x;
    const season = this.climate.season;
    const still = wind === 0 && !gustAbout(frame.gusts, this.#exit);
    this.#stillFor = still ? this.#stillFor + h : 0;
    if (!still) this.#rested = false;
    let settle =
      this.#lastWind === undefined ||
      (h === 0 && (wind !== this.#lastWind || season !== this.#lastSeason));
    if (!settle && h > 0) {
      plants.step(this.climate);
      settle = still && !this.#rested && this.#stillFor >= PLANT_SETTLE;
    } else if (!settle) {
      settle = still && !this.#rested;
    }
    if (settle) {
      plants.settle(this.climate);
      this.#rested = still;
    } else if (h === 0 && retier) {
      plants.pose();
    }
    this.#lastWind = wind;
    this.#lastSeason = season;
  }
}

/** `plants`' records into the layer's rows, `records` of them. */
function writeRecords(frame: LayerFrame, plants: RootedPlants, records: number): void {
  const data = frame.records.data;
  data.fill(0);
  writePlantRecords(plants, data, ATLAS_WIDTH, 0, records);
  frame.records.touch();
}

const WOODS_RECORDS = 2 * GARDEN_WOODS.crowns;
const BORDER_RECORDS = GARDEN_BORDER.bins * GARDEN_BORDER.organs;

/** The temple woods' trees (see the header): their gusts at the wall, across the frame. */
class WoodsSim implements LayerSim {
  readonly #knobs: KnobReader<"season" | "wind">;
  readonly #woods = new RootedPlants(WOODS_RECORDS, 0);
  #aspect = 16 / 9;
  // A crown's x across the frame is taken at the wall: garden X there.
  readonly #air = new PlantAir(
    (x) => OX + ((x - 0.5 * this.#aspect) * (GARDEN.wallY - GARDEN.eyeY)) / GARDEN.focal,
    metresAhead(GARDEN.wallY),
  );

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden woods", params, ["season", "wind"]);
    growWoods(this.#woods);
  }

  frame(frame: LayerFrame): void {
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.#aspect = frame.aspect;
    const wind = clamp(this.#knobs.value(frame, "wind"), -1, 1);
    const season = Math.round(this.#knobs.value(frame, "season"));
    const h = this.#air.update(frame, wind, season, 0);
    // Dither cells per unit: the woods' unit is a screen height.
    const woods = this.#woods;
    const cells = frame.height > 0 ? frame.height : woods.cells;
    const retier = cells !== woods.cells;
    woods.cells = cells;
    this.#air.sway(woods, frame, h, retier);
    writeRecords(frame, woods, WOODS_RECORDS);
  }

  // Records only: nothing of its own to release.
  dispose(): void {}
}

/** The border planting (see the header), planted afresh when its fullness changes. */
class BorderSim implements LayerSim {
  readonly #knobs: KnobReader<"season" | "wind" | "border" | "borderGrowth">;
  readonly #border = new RootedPlants(BORDER_RECORDS, 0);
  readonly #air = new PlantAir((x) => x, metresAhead(GARDEN_BORDER.y));
  /** The fullness it was planted for (0: nothing planted). */
  #fullness = 0;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden border", params, [
      "season",
      "wind",
      "border",
      "borderGrowth",
    ]);
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const wind = clamp(knobs.value(frame, "wind"), -1, 1);
    const season = Math.round(knobs.value(frame, "season"));
    const h = this.#air.update(frame, wind, season, knobs.value(frame, "borderGrowth"));
    // Dither cells per garden depth, seen across the garden from the veranda or from above.
    const gravel = frame.host("gravel");
    const overhead = gravel instanceof Gravel && gravel.view.overhead;
    const border = this.#border;
    const cells =
      frame.height > 0
        ? frame.height *
          (overhead ? 1 / GARDEN.span : GARDEN.focal / (GARDEN_BORDER.y - GARDEN.eyeY))
        : border.cells;
    const retier = cells !== border.cells;
    border.cells = cells;
    const fullness = knobs.value(frame, "border");
    if (fullness !== this.#fullness) {
      this.#fullness = fullness;
      growBorder(border, fullness);
      border.settle(this.#air.climate);
    }
    this.#air.sway(border, frame, h, retier);
    writeRecords(frame, border, BORDER_RECORDS);
  }

  // Records only: nothing of its own to release.
  dispose(): void {}
}

/** The temple woods layer's sim (LayerCode.sim): its stems on its records. */
export function templeWoodsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new WoodsSim(params);
}

/** The border layer's sim (LayerCode.sim): its clumps on its records. */
export function borderSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new BorderSim(params);
}
