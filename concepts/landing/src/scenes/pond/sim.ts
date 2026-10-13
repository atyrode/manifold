// The pond's foliage sheets: the border plants (uSim0) and the overhead canopy (uSim1), painted on
// the CPU by botany.ts/decor.ts into data textures (see sheet.ts). A sheet is repainted whenever its
// knobs or the frame's shape change; the last finished one stays bound meanwhile.
import { CANOPY_MARGIN, canopyKey, decorKey, type CanopyConfig, type ClumpSpecies, type DecorConfig } from "../../decor.ts";
import { SheetPainter } from "../../sheet.ts";
import type { SimFactory } from "../types.ts";

/** Milliseconds per frame a sheet may spend painting on the page: more while nothing is shown yet. */
const SHEET_BUDGET_MS = 6;
const FIRST_SHEET_BUDGET_MS = 24;

type Knobs = Readonly<Record<string, number>>;

/** How lush each edge of the pond is: top, right, bottom, left. */
function edgeLushness(params: Knobs): [number, number, number, number] {
  return [params.lushTop ?? 0.6, params.lushRight ?? 0.6, params.lushBottom ?? 0.6, params.lushLeft ?? 0.6];
}

/** The border plants, as the sheet paints them; undefined when absent. */
function decorConfig(params: Knobs): DecorConfig | undefined {
  if ((params.plants ?? 0) < 0.5) return undefined;
  const toggles: Record<ClumpSpecies, string> = { monstera: "monstera", fern: "ferns", banana: "banana" };
  const on = (key: string) => (params[key] ?? 0) > 0.5;
  return {
    reach: params["plants-amount"] ?? 0.45,
    sides: edgeLushness(params),
    kinds: (Object.keys(toggles) as ClumpSpecies[]).filter((species) => (params[toggles[species]] ?? 1) > 0.5),
    vines: on("vines") ? params["vines-amount"] ?? 0.4 : 0,
    flowers: on("flowers") ? params["flowers-amount"] ?? 0.35 : 0,
    grass: on("grass") ? params["grass-amount"] ?? 0.4 : 0,
    bushiness: params.bushiness ?? 0.55,
    seed: params.plantSeed ?? 0,
  };
}

/** The overhead canopy; undefined when absent. */
function canopyConfig(params: Knobs): CanopyConfig | undefined {
  if ((params.canopy ?? 0) < 0.5) return undefined;
  return { coverage: params["canopy-amount"] ?? 0.45, sides: edgeLushness(params), seed: params.canopySeed ?? 0 };
}

export const pondSim: SimFactory = (gl) => {
  const decor = new SheetPainter(gl);
  const canopy = new SheetPainter(gl);
  return {
    frame({ params, aspect }) {
      const shape = aspect.toFixed(2);
      const plants = decorConfig(params);
      const leaves = canopyConfig(params);
      if (plants) {
        const width = 2048;
        decor.request(`${decorKey(plants)}|${shape}`, width, Math.max(1, Math.round(width / aspect)), { kind: "decor", config: plants });
        decor.advance(decor.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
      }
      if (leaves) {
        const width = 768;
        // Leaves are sized against the visible frame, which is 1/span of this sheet.
        const span = 1 + 2 * CANOPY_MARGIN;
        canopy.request(`${canopyKey(leaves)}|${shape}`, width, Math.max(1, Math.round(width / aspect)), { kind: "canopy", config: leaves, span });
        canopy.advance(canopy.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
      }
      return [plants ? decor.texture : undefined, leaves ? canopy.texture : undefined];
    },
    dispose() {
      decor.dispose();
      canopy.dispose();
    },
  };
};
