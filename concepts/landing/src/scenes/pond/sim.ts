// The pond's foliage sheets: the border plants (uSim0) and the overhead canopy (uSim1), painted on
// the CPU by botany.ts/decor.ts into data textures (see sheet.ts). A sheet is repainted whenever its
// knobs or the frame's shape change; the last finished one stays bound meanwhile.
import { CANOPY_MARGIN, canopyKey, decorKey, type CanopyConfig, type ClumpSpecies, type DecorConfig } from "../../decor.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { SheetPainter } from "../../sheet.ts";
import type { SceneSim } from "../types.ts";

/** Milliseconds per frame a sheet may spend painting on the page: more while nothing is shown yet. */
const SHEET_BUDGET_MS = 6;
const FIRST_SHEET_BUDGET_MS = 24;

const DECOR_WIDTH = 2048;
const CANOPY_WIDTH = 768;

const KNOBS = [
  "plants", "monstera", "ferns", "banana", "vines", "flowers", "grass", "bushiness", "plantSeed",
  "lushTop", "lushRight", "lushBottom", "lushLeft", "canopy", "canopySeed",
] as const;
type Knob = (typeof KNOBS)[number];

/** Which toggle grows which clump species, in the order the sheet lays them out. */
const SPECIES: readonly (readonly [ClumpSpecies, Knob])[] = [["monstera", "monstera"], ["fern", "ferns"], ["banana", "banana"]];

export function pondSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): SceneSim {
  const knobs = new KnobReader<Knob>("pond", params, KNOBS);
  const decor = new SheetPainter(gl);
  const canopy = new SheetPainter(gl);
  const textures: (WebGLTexture | undefined)[] = [undefined, undefined];
  // The sheets' inputs as last seen (every knob, then the frame's aspect): configs, keys and sizes
  // are rebuilt only when one moves, so a steady frame allocates nothing.
  const seen = new Float64Array(KNOBS.length + 1).fill(Number.NaN);
  let plants = false;
  let leaves = false;

  /** Rebuild both sheets' requests from this frame's knobs. */
  function request(read: (key: Knob) => number, aspect: number): void {
    const shape = aspect.toFixed(2);
    const sides = [read("lushTop"), read("lushRight"), read("lushBottom"), read("lushLeft")] as const;
    plants = read("plants") > 0;
    if (plants) {
      const config: DecorConfig = {
        reach: read("plants"),
        sides,
        kinds: SPECIES.filter(([, toggle]) => read(toggle) > 0.5).map(([species]) => species),
        vines: read("vines"),
        flowers: read("flowers"),
        grass: read("grass"),
        bushiness: read("bushiness"),
        seed: read("plantSeed"),
      };
      decor.request(`${decorKey(config)}|${shape}`, DECOR_WIDTH, Math.max(1, Math.round(DECOR_WIDTH / aspect)), { kind: "decor", config });
    }
    leaves = read("canopy") > 0;
    if (leaves) {
      const config: CanopyConfig = { coverage: read("canopy"), sides, seed: read("canopySeed") };
      // Leaves are sized against the visible frame, which is 1/span of this sheet.
      const span = 1 + 2 * CANOPY_MARGIN;
      canopy.request(`${canopyKey(config)}|${shape}`, CANOPY_WIDTH, Math.max(1, Math.round(CANOPY_WIDTH / aspect)), { kind: "canopy", config, span });
    }
  }

  return {
    frame(frame) {
      let moved = false;
      let slot = 0;
      for (const key of KNOBS) {
        const value = knobs.value(frame, key);
        if (seen[slot] !== value) {
          seen[slot] = value;
          moved = true;
        }
        slot++;
      }
      if (seen[slot] !== frame.aspect) {
        seen[slot] = frame.aspect;
        moved = true;
      }
      if (moved) request((key) => knobs.value(frame, key), frame.aspect);
      if (plants) decor.advance(decor.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
      if (leaves) canopy.advance(canopy.texture ? SHEET_BUDGET_MS : FIRST_SHEET_BUDGET_MS);
      textures[0] = plants ? decor.texture : undefined;
      textures[1] = leaves ? canopy.texture : undefined;
      return textures;
    },
    dispose() {
      decor.dispose();
      canopy.dispose();
    },
  };
}
