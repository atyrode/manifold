// GPU check (verify-browser.ts): the ripple tank's edge absorption. The real wave sim runs the
// interference experiment twice, beaches full and bare walls, and its view texture (the surface's
// slope) is read back: bare walls must send waves back into the tank, while the open water away from
// the edges starts out the same either way (the knob is not a second damping). It is read at the
// water layer's first field, where the composed sim binds it (composer/sim.ts allocate).
import { allocate } from "../../composer/sim.ts";
import { effective } from "../../params.ts";
import { visitorAlone } from "../../principals.ts";
import { GpuCompute } from "../../sims/gpu.ts";
import { loadScene } from "../index.ts";
import type { SimFrame } from "../types.ts";
import { rippleComposed } from "./index.ts";

const rippleScene = await loadScene("ripple");

/** The texture slot of the water's view (its first field) with the tank and its water on. */
const VIEW_SLOT =
  allocate(
    rippleComposed.place(new Set(["tank", "tankWater"])).layers.map((placed) => placed.layer),
  ).fields["tankWater"]?.[0] ?? 2;

/** The view sampled on a COLUMNS × ROWS grid of texel centres over the frame. */
const COLUMNS = 64;
const ROWS = 36;
const ASPECT = 16 / 9;

/** RMS of the surface's slope in a band of distances from the frame's nearest edge (short sides). */
interface Bands {
  edge: number;
  middle: number;
}

/** One readback of the view: the slope at each sample (x, y pairs) and its bands. */
interface View {
  slopes: Float32Array;
  bands: Bands;
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

export function rippleEdgesVerify(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  const target = gpu.target({ width: COLUMNS, height: ROWS, format: "rgba32f", filter: "nearest" });
  const sample = gpu.pass(
    "uniform sampler2D uView; void main() { fragColor = texture(uView, vUv); }",
    "ripple edges sample",
  );
  const view = new Float32Array(COLUMNS * ROWS * 4);

  /** The slope at each sample, and its RMS near the edges (0.06..0.14) and in the middle (over 0.35). */
  const read = (texture: WebGLTexture | undefined): View => {
    if (texture === undefined) throw new Error("Ripple view missing");
    sample.run(target, { textures: { uView: texture } });
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, COLUMNS, ROWS, gl.RGBA, gl.FLOAT, view);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const slopes = new Float32Array(COLUMNS * ROWS * 2);
    const sums = { edge: [0, 0], middle: [0, 0] };
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLUMNS; i++) {
        const k = j * COLUMNS + i;
        const sx = view[4 * k + 2] ?? 0;
        const sy = view[4 * k + 3] ?? 0;
        slopes[2 * k] = sx;
        slopes[2 * k + 1] = sy;
        const x = ((i + 0.5) / COLUMNS) * ASPECT;
        const y = (j + 0.5) / ROWS;
        const edge = Math.min(x, ASPECT - x, y, 1 - y);
        const band =
          edge >= 0.06 && edge <= 0.14 ? sums.edge : edge > 0.35 ? sums.middle : undefined;
        if (!band) continue;
        band[0] = (band[0] ?? 0) + sx * sx + sy * sy;
        band[1] = (band[1] ?? 0) + 1;
      }
    }
    const rms = (band: number[]): number => Math.sqrt((band[0] ?? 0) / Math.max(1, band[1] ?? 0));
    return { slopes, bands: { edge: rms(sums.edge), middle: rms(sums.middle) } };
  };

  /** The middle's RMS slope difference between two runs. */
  const middleDifference = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLUMNS; i++) {
        const x = ((i + 0.5) / COLUMNS) * ASPECT;
        const y = (j + 0.5) / ROWS;
        if (Math.min(x, ASPECT - x, y, 1 - y) <= 0.35) continue;
        const k = j * COLUMNS + i;
        sum +=
          ((a[2 * k] ?? 0) - (b[2 * k] ?? 0)) ** 2 +
          ((a[2 * k + 1] ?? 0) - (b[2 * k + 1] ?? 0)) ** 2;
        count++;
      }
    }
    return Math.sqrt(sum / Math.max(1, count));
  };

  /** The interference experiment, drips off, at this edge absorption: its view on the first frame and after `seconds`. */
  const tank = (edges: number, seconds: number): { first: View; later: View } => {
    const sim = rippleScene.sim?.(gl);
    if (!sim) throw new Error("Ripple simulation unavailable");
    const raw: Record<string, number> = { tank: 1, tankWater: 1, experiment: 1, drips: 0, edges };
    const frame: SimFrame = {
      dt: 0,
      time: 0,
      motionTime: 0,
      motion: 1,
      now: 0,
      budget: Infinity,
      width: 320,
      height: 180,
      aspect: ASPECT,
      values: rippleScene.params.map((def) => effective(def, raw)),
      params: raw,
      triggers: Array.from({ length: 8 }, () => -1e4),
      fired: Array.from({ length: 8 }, () => false),
      ...visitorAlone(),
      passage: { enter: 1, exit: 0 },
    };
    const first = read(sim.frame(frame)[VIEW_SLOT]);
    frame.dt = 0.2;
    let textures = sim.frame(frame);
    for (let t = 0.2; t < seconds; t += frame.dt) {
      frame.time += frame.dt;
      frame.motionTime += frame.dt;
      textures = sim.frame(frame);
    }
    const later = read(textures[VIEW_SLOT]);
    sim.dispose();
    return { first, later };
  };

  const beaches = tank(1, 40);
  const walls = tank(0, 40);
  gpu.dispose();
  const result = {
    edgeBeaches: beaches.later.bands.edge,
    edgeWalls: walls.later.bands.edge,
    middle: beaches.later.bands.middle,
    reflected: middleDifference(beaches.later.slopes, walls.later.slopes),
    firstDifference: middleDifference(beaches.first.slopes, walls.first.slopes),
    firstMiddle: beaches.first.bands.middle,
  };
  // Measured in software WebGL: edge band 0.163 (beaches) / 0.221 (walls), middle 0.390, reflected
  // 0.100, first-frame difference 0.
  check(
    result.firstDifference <= 0.01 * result.firstMiddle,
    `Edge absorption changed the open water at once: ${result.firstDifference}`,
  );
  check(
    result.edgeWalls > 1.2 * result.edgeBeaches,
    `Bare walls did not raise the waves along the edges: ${result.edgeWalls} vs ${result.edgeBeaches}`,
  );
  check(
    result.reflected > 0.15 * result.middle,
    `Bare walls sent no reflections into the tank: ${result.reflected} vs ${result.middle}`,
  );
  return result;
}
