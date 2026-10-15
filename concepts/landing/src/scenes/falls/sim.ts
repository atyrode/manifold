// The waterfall's near-bank ferns, grown with the shared plant component (sims/plants.ts): up to
// FALLS_CLUMPS clumps toward the bottom corners (more with more greenery), FALLS_FRONDS fronds each,
// rooted where the shader always drew them and shaped as it did (the same hashes: lengths, lift and
// droop). Each frond now bends on its own spring with the wind, eddies stirred by the fall's air and
// gusts crossing the bank; with the plant knobs the year turns and sheds them and growth replaces
// them frond by frond. The shader draws them with plantFrond (shaders/lib/plants.ts) and keeps the
// rest: wet beads, drips, light and the entrance's spring up.
//
// Texture: uSim0, a PlantTexture of FALLS_CLUMPS × FALLS_FRONDS records, clump c's frond j at record
// c · FALLS_FRONDS + j (hidden: no such clump, or shed). Units: the near bank's screen heights from
// the frame's bottom centre (the shader's qb); the record's a and b are the frond's lift and droop,
// its variant the shader's frond key.
import { KnobReader, type ParamDef } from "../../params.ts";
import { fract, glslHash12 } from "../../sims/math.ts";
import { PLANT_SUMMER, PlantHabit, PlantRole, PlantTexture, plantClimate, RootedPlants, type PlantSpecies } from "../../sims/plants.ts";
import type { SceneSim } from "../types.ts";

export const FALLS_CLUMPS = 4;
export const FALLS_FRONDS = 5;
/** Screen heights a second a gust's front crosses the bank. */
const GUST_FRONT = 0.5;

const KNOBS = ["greenery", "wind", "gusts", "season", "growth"] as const;
type Knob = (typeof KNOBS)[number];

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

/** The near bank's fern clumps for the greenery and the frame's shape, as the shader placed them. */
function growBank(plants: RootedPlants, green: number, aspect: number): void {
  plants.clear();
  for (let c = 0; c < FALLS_CLUMPS; c++) {
    if ((c + 1) * 0.22 > green + 0.12) break;
    const side = c % 2 === 0 ? -1 : 1;
    const inward = Math.floor(c / 2);
    const x = side * (0.47 * aspect - 0.04 - 0.2 * inward - 0.06 * glslHash12(c, 81));
    plants.add(BANK_FERN, { x, y: 0.07 + 0.08 * (1 - inward), heading: Math.PI / 2, moisture: 0.8, kind: c, slot: c * FALLS_FRONDS }, () => 0);
  }
}

/** The waterfall's sim, for a scene whose `params` carry KNOBS. */
export function fallsSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): SceneSim {
  const knobs = new KnobReader<Knob>("falls", params, KNOBS);
  const gustSlot = knobs.trigger("gusts");
  const plants = new RootedPlants(FALLS_CLUMPS * FALLS_FRONDS, 0);
  const records = new PlantTexture(gl, FALLS_CLUMPS * FALLS_FRONDS);
  const climate = plantClimate();
  const textures: (WebGLTexture | undefined)[] = [records.texture];
  let green = Number.NaN;
  let aspect = Number.NaN;
  return {
    frame(frame) {
      climate.dt = frame.dt * frame.motion;
      climate.time = frame.motionTime;
      climate.season = knobs.on(frame, "season") ? knobs.amount(frame, "season") : PLANT_SUMMER;
      climate.growth = knobs.value(frame, "growth");
      // The wind across the bank, and the stir of the fall's own air even when it is still.
      climate.air.x = knobs.value(frame, "wind");
      climate.air.eddy = 0.5;
      climate.air.calm = 0.3;
      climate.air.gusts = knobs.value(frame, "gusts");
      climate.air.gustNow = frame.fired[gustSlot] === true;
      climate.air.front = GUST_FRONT;
      plants.cells = frame.height;
      const g = knobs.value(frame, "greenery");
      if (g !== green || frame.aspect !== aspect) {
        green = g;
        aspect = frame.aspect;
        growBank(plants, green, aspect);
        plants.settle(climate);
      } else {
        plants.step(climate);
      }
      records.pack(plants);
      records.upload();
      return textures;
    },
    dispose() {
      records.dispose();
    },
  };
}
