// The pond's sim: the border plants (uSim0), grown and swayed by the shared plant component
// (plants.ts, sims/plants.ts) and drawn every frame on the GPU into the plant sheet
// (sims/plantsheet.ts) from the botany atlas, painted once on the worker (sheet.ts, decor.ts); the
// overhead canopy (uSim1), a sheet painted on the worker whenever its knobs or the frame's shape
// change; and the koi while they are drawn to the pointer (uSim2, koi.ts). The last finished canopy
// stays bound while a new one paints; the plants show as soon as the atlas is ready.
import {
  canopyKey,
  CANOPY_MARGIN,
  PLANT_ATLAS_SIZE,
  plantAtlasFamilies,
  type CanopyConfig,
} from "../../decor.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { SheetPainter } from "../../sheet.ts";
import { PlantSheet } from "../../sims/plantsheet.ts";
import { PLANT_SUMMER, plantClimate, RootedPlants } from "../../sims/plants.ts";
import { windNoise } from "../../sims/wind.ts";
import type { SceneSim } from "../types.ts";
import { PondKoi } from "./koi.ts";
import {
  growPondPlants,
  POND_ORGANS,
  pondPlantKey,
  type ClumpSpecies,
  type PondPlantConfig,
} from "./plants.ts";

/** Milliseconds per frame a sheet may spend painting on the page: more while nothing is shown yet. */
const SHEET_BUDGET_MS = 6;
const FIRST_SHEET_BUDGET_MS = 24;

/**
 * The plant sheet's width: two pixels a cell up to the old painted sheet's 2048 (its height follows
 * the frame's shape). The shader's shadow and ray lookups scale their blur by it (pondSheetLod).
 */
const PLANT_SHEET_WIDTH = 2048;
const SHEET_PER_CELL = 2;
const CANOPY_WIDTH = 768;
/** The atlas never changes: one key, kept across visits. */
const ATLAS_KEY = "plant-atlas";

/** Frame heights a second a gust's front crosses the pond. */
const GUST_FRONT = 0.3;

const KNOBS = [
  "plants",
  "monstera",
  "ferns",
  "banana",
  "vines",
  "flowers",
  "grass",
  "bushiness",
  "plantSeed",
  "lushTop",
  "lushRight",
  "lushBottom",
  "lushLeft",
  "canopy",
  "canopySeed",
  "wind",
  "gusts",
  "season",
  "growth",
] as const;
type Knob = (typeof KNOBS)[number];
/** How many of KNOBS (the first) the canopy sheet and the plants' layout depend on; the rest only move the plants. */
const LAYOUT_KNOBS = 15;

/** Which toggle grows which clump species, in the order the layout lays them out. */
const SPECIES: readonly (readonly [ClumpSpecies, Knob])[] = [
  ["monstera", "monstera"],
  ["fern", "ferns"],
  ["banana", "banana"],
];

export function pondSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): SceneSim {
  const knobs = new KnobReader<Knob>("pond", params, KNOBS);
  const atlas = new SheetPainter(gl);
  const canopy = new SheetPainter(gl);
  const families = plantAtlasFamilies();
  const plants = new RootedPlants(POND_ORGANS, 0);
  const climate = plantClimate();
  const gustSlot = knobs.trigger("gusts");
  let sheet: PlantSheet | undefined;
  const maxSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
  const textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined];
  const koi = new PondKoi(params, gl);
  // The knobs as last seen, then the frame's aspect: the layout is rebuilt only when one of its
  // inputs moves, so a steady frame allocates nothing.
  const seen = new Float64Array(KNOBS.length + 1).fill(Number.NaN);
  let plantsOn = false;
  let leaves = false;
  let layoutKey = "";
  let order: Int32Array = new Int32Array(0);
  let drawn = false;

  /** Rebuild the plants and the canopy's request from this frame's knobs. */
  function request(read: (key: Knob) => number, aspect: number): void {
    const shape = aspect.toFixed(2);
    const sides = [
      read("lushTop"),
      read("lushRight"),
      read("lushBottom"),
      read("lushLeft"),
    ] as const;
    plantsOn = read("plants") > 0;
    if (plantsOn) {
      atlas.request(ATLAS_KEY, PLANT_ATLAS_SIZE, PLANT_ATLAS_SIZE, { kind: "atlas" });
      const config: PondPlantConfig = {
        reach: read("plants"),
        sides,
        kinds: SPECIES.filter(([, toggle]) => read(toggle) > 0.5).map(([species]) => species),
        vines: read("vines"),
        flowers: read("flowers"),
        grass: read("grass"),
        bushiness: read("bushiness"),
        seed: read("plantSeed"),
      };
      const key = pondPlantKey(config, aspect);
      if (key !== layoutKey) {
        layoutKey = key;
        order = growPondPlants(plants, config, aspect);
        drawn = false;
      }
    }
    leaves = read("canopy") > 0;
    if (leaves) {
      const config: CanopyConfig = { coverage: read("canopy"), sides, seed: read("canopySeed") };
      // Leaves are sized against the visible frame, which is 1/span of this sheet.
      const span = 1 + 2 * CANOPY_MARGIN;
      canopy.request(
        `${canopyKey(config)}|${shape}`,
        CANOPY_WIDTH,
        Math.max(1, Math.round(CANOPY_WIDTH / aspect)),
        { kind: "canopy", config, span },
      );
    }
  }

  return {
    frame(frame) {
      let moved = false;
      let relayout = false;
      for (let slot = 0; slot < KNOBS.length; slot++) {
        const value = knobs.value(frame, KNOBS[slot] ?? "plants");
        if (seen[slot] === value) continue;
        seen[slot] = value;
        moved = true;
        if (slot < LAYOUT_KNOBS) relayout = true;
      }
      if (seen[KNOBS.length] !== frame.aspect) {
        seen[KNOBS.length] = frame.aspect;
        moved = true;
        relayout = true;
      }
      const fresh = layoutKey;
      if (relayout) request((key) => knobs.value(frame, key), frame.aspect);
      if (plantsOn) {
        atlas.advance(atlas.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
        // The breeze wanders slowly about its heading; the wind knob is its strength.
        const wind = knobs.value(frame, "wind");
        const heading = 0.35 + 0.6 * windNoise(frame.motionTime * 0.015, 7);
        climate.dt = frame.dt * frame.motion;
        climate.time = frame.motionTime;
        climate.season = knobs.on(frame, "season") ? knobs.amount(frame, "season") : PLANT_SUMMER;
        climate.growth = knobs.value(frame, "growth");
        climate.air.x = wind * Math.cos(heading);
        climate.air.y = wind * Math.sin(heading);
        climate.air.eddy = 0.6;
        climate.air.gusts = knobs.value(frame, "gusts");
        climate.air.gustNow = frame.fired[gustSlot] === true;
        climate.air.front = GUST_FRONT;
        plants.cells = frame.height;
        if (fresh !== layoutKey) plants.settle(climate);
        else plants.step(climate);
        const texture = atlas.texture;
        if (texture && (!drawn || climate.dt > 0 || climate.air.gustNow || moved)) {
          sheet ??= new PlantSheet(gl);
          let width = Math.min(
            PLANT_SHEET_WIDTH,
            Math.max(256, Math.round(frame.width * SHEET_PER_CELL)),
          );
          let height = Math.max(1, Math.round(width / frame.aspect));
          const over = Math.max(width, height) / maxSize;
          if (over > 1) {
            width = Math.max(1, Math.floor(width / over));
            height = Math.max(1, Math.floor(height / over));
          }
          sheet.draw(plants, order, families, texture, { width, height, scale: height });
          drawn = true;
        }
      }
      if (leaves) canopy.advance(canopy.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
      textures[0] = plantsOn && drawn ? sheet?.texture : undefined;
      textures[1] = leaves ? canopy.texture : undefined;
      textures[2] = koi.frame(frame);
      return textures;
    },
    dispose() {
      atlas.dispose();
      canopy.dispose();
      sheet?.dispose();
      koi.dispose();
    },
  };
}
