// Grass: a patch of blades over whatever land lies under it (the document's ground, followed hill
// and hollow; a level floor where there is none), `width` by `depth`, its blades `height` tall, as
// thick as its `density`, a sprinkle of wildflowers through it and a share gone to straw. They bend
// with the World's wind and paler where a gust presses them, so gusts cross it in waves. The code
// (code.ts) draws each blade near the eye and a textured carpet beyond; the lab picks the patch by
// its floor, so what is dragged over it settles on the land, not on the tips of the blades.
import { range } from "../../../params.ts";
import type { KindDef } from "../../types.ts";

/** How far any land under a patch may rise or fall from its origin, per metre from it. */
const GRASS_LIFT = 0.2;
/** And at least this, metres. */
const GRASS_LIFT_MIN = 0.15;
/** The land under a patch is sampled at most this far apart, metres, for its bounds. */
const GRASS_SAMPLE = 0.5;
/** Metres of bounds past the land's sampled extremes, over what the slope between samples allows. */
const GRASS_LAND_MARGIN = 0.05;
/** The tallest blade, flower and all, over the patch's `height`. */
export const GRASS_TOP = 1.12;

const size = (key: string, label: string, value: number, help: string) =>
  range("grass", key, label, value, help, { min: 0.5, max: 40, step: 0.25 });

export const grassKind: KindDef = {
  id: "grass",
  title: "Grass",
  blurb:
    "A patch of grass over the land, its blades swaying in the wind and paling as gusts cross it, with wildflowers through it.",
  family: "plant",
  options: [
    size("width", "width", 6, "Across, metres."),
    size("depth", "depth", 6, "Front to back, metres."),
    range("grass", "height", "height", 0.4, "How tall the blades stand, metres.", {
      min: 0.05,
      max: 1.2,
      step: 0.01,
    }),
    range("grass", "density", "density", 0.75, "How thick the blades grow: sparse to a sward."),
    range("grass", "flowers", "flowers", 0.15, "The wildflowers through it: none to a meadow's."),
    range("grass", "dry", "dry", 0.15, "How much of it has gone to straw."),
  ],
  bounds(options, land) {
    const w = (options["width"] ?? 6) / 2;
    const d = (options["depth"] ?? 6) / 2;
    const top = (options["height"] ?? 0.4) * GRASS_TOP;
    if (land === undefined) {
      const lift = GRASS_LIFT * Math.hypot(w, d) + GRASS_LIFT_MIN;
      return { min: [-w, -lift, -d], max: [w, top + lift, d] };
    }
    // The land under it, on a grid, and past its extremes what its steepest step between samples
    // could hide.
    const nx = Math.max(2, Math.ceil((2 * w) / GRASS_SAMPLE));
    const nz = Math.max(2, Math.ceil((2 * d) / GRASS_SAMPLE));
    const dx = (2 * w) / nx;
    const dz = (2 * d) / nz;
    let lo = Infinity;
    let hi = -Infinity;
    let rise = 0;
    const row: number[] = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const y = land(-w + i * dx, -d + j * dz);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
        if (i > 0) rise = Math.max(rise, Math.abs(y - (row[i - 1] ?? y)));
        if (j > 0) rise = Math.max(rise, Math.abs(y - (row[i] ?? y)));
        row[i] = y;
      }
    }
    const margin = rise + GRASS_LAND_MARGIN;
    return { min: [-w, lo - margin, -d], max: [w, hi + top + margin, d] };
  },
  max: 16,
  rests: "surface",
  cast(options, ro, rd, span) {
    // Its floor, the plane through its origin.
    if (Math.abs(rd[1]) < 1e-9) return undefined;
    const t = -ro[1] / rd[1];
    if (t < span[0] || t > span[1]) return undefined;
    const x = ro[0] + rd[0] * t;
    const z = ro[2] + rd[2] * t;
    if (Math.abs(x) > (options["width"] ?? 6) / 2 || Math.abs(z) > (options["depth"] ?? 6) / 2)
      return undefined;
    return { t, normal: [0, 1, 0] };
  },
  code: () => import("./code.ts"),
};
