// Drawing the insects into the speck map (the composer's shared one, LayerFrame.specks; a SpeckMap,
// sims/specks.ts, in a test), shared by every kind: where a flier is drawn (`project`: between its
// last two steps by the clock's alpha, in the cell its projection falls in, changing cell only once
// it has clearly left it), the depth byte the shader compares with the scenery's, and lines of cells.
import type { SpeckWriter } from "../../composer/types.ts";
import { followCell } from "../../sims/specks.ts";
import { CAMERA, type Flier } from "./garden.ts";
import { BEES_DEPTH_STEP } from "./layout.ts";

/** The map's depth byte for a thing at depth z (m). */
export function depthByte(z: number): number {
  return Math.min(255, Math.round(z * BEES_DEPTH_STEP));
}

export class Painter {
  /** The map painted into this frame. */
  specks: SpeckWriter;
  /** Where the last thing projected is drawn from (m), `alpha` of the way through its step. */
  readonly at = { x: 0, z: 0, h: 0 };

  constructor(specks: SpeckWriter) {
    this.specks = specks;
  }

  /**
   * Where `t` is drawn, `alpha` of the way from its last step: its cell (hysteretic) into t.cx, t.cy,
   * its position into `at`. Returns its depth (m), or 0 for a thing too near the lens to draw.
   */
  project(t: Flier, alpha: number): number {
    const z = t.pz + (t.z - t.pz) * alpha;
    if (z < 0.8) return 0;
    const x = t.px + (t.x - t.px) * alpha;
    const lift = t.ph + (t.h - t.ph) * alpha;
    const h = this.specks.height;
    // Its projection (the shader's own ground mapping) in cells.
    t.cx = followCell(t.cx, CAMERA.screenX(x, z) * h + 0.5 * this.specks.width);
    t.cy = followCell(t.cy, CAMERA.screenY(lift, z) * h);
    this.at.x = x;
    this.at.z = z;
    this.at.h = lift;
    return z;
  }

  /** The cells from (x0, y0) to (x1, y1), both ends included. */
  line(x0: number, y0: number, x1: number, y1: number, code: number, depth: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const u = n === 0 ? 0 : i / n;
      this.specks.plot(Math.round(x0 + (x1 - x0) * u), Math.round(y0 + (y1 - y0) * u), code, depth);
    }
  }
}
