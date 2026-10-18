// GPU regression for the delta's hand (sim.ts deltaWaterSim), run by verify-browser.ts against real
// WebGL through the composed sim, as the page runs it: a hand dragged across the land with the `dig`
// tool cuts a ditch into the water's live view of the ground (its bed height, deltaWaterField0's r),
// one dragged with `bank` throws up a bank, and the ground away from both stays as it was. The time
// lapse stands still (motion 0), so only the hand moves the bed.
import { allocate } from "../../composer/sim.ts";
import { gridSize } from "../../sims/gpu.ts";
import { visitorAlone } from "../../principals.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import { loadScene } from "../index.ts";
import type { SimFrame } from "../types.ts";
import { deltaComposed } from "./index.ts";
import { DELTA_FIELDS } from "./layers.ts";

const deltaScene = await loadScene("delta");

/** Where the composed sim binds the water's live ground view at the delta's defaults. */
const GROUND_SLOT = allocate(
  deltaComposed.place(new Set(deltaComposed.preset.layers)).layers.map((placed) => placed.layer),
).fields["deltaWater"]?.[DELTA_FIELDS.ground];

/**
 * The frame's size, and the rows (uv) the two strokes run along and the one left alone: the dig's
 * across the valley, the bank's across the low delta plain (a bank works toward 1.7 cells over the
 * sea, so higher ground barely rises).
 */
const W = 320;
const H = 200;
const DIG_ROW = 0.8;
const BANK_ROW = 0.45;
const ALONE_ROW = 0.92;
/** The strokes' ends across the frame (uv). */
const FROM = 0.3;
const TO = 0.45;

function fail(message: string): never {
  throw new Error(`delta dig: ${message}`);
}

/** The bed height (cells, the r channel) of a view texture, `columns` × `rows`. */
function bedHeights(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  columns: number,
  rows: number,
): Float32Array {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const data = new Float32Array(columns * rows * 4);
  gl.readPixels(0, 0, columns, rows, gl.RGBA, gl.FLOAT, data);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  return data.filter((_, i) => i % 4 === 0);
}

export function verifyDeltaDig(gl: WebGL2RenderingContext): Record<string, unknown> {
  if (GROUND_SLOT === undefined) fail("the water has no ground field at the defaults");
  const sim = deltaScene.sim?.(gl);
  if (!sim) fail("simulation unavailable");
  const knobs = paramDefaults("delta");
  const hands = visitorAlone({ inside: true });
  const hand = hands.pointer;
  const frame: SimFrame = {
    dt: 1 / 60,
    time: 0,
    motionTime: 0,
    motion: 0,
    now: 0,
    budget: Infinity,
    width: W,
    height: H,
    aspect: W / H,
    params: knobs,
    values: renderSettings(defaultsFor("delta"), knobs).params,
    triggers: [],
    fired: [],
    passage: { enter: 1, exit: 0 },
    ...hands,
    parallax: { x: 0, y: 0 },
  };
  /** Run `count` frames, the hand at `x` on `row` as `at(i)` puts it; the live ground view after. */
  const run = (count: number, at?: (i: number) => number, row = 0): WebGLTexture => {
    let ground: WebGLTexture | undefined;
    for (let i = 0; i < count; i++) {
      hand.down = at !== undefined;
      if (at !== undefined) {
        hand.x = at(i);
        hand.y = row;
      }
      ground = sim.frame(frame)[GROUND_SLOT];
      frame.time += frame.dt;
      frame.now += frame.dt * 1000;
    }
    if (ground === undefined) fail("the water bound no ground view");
    return ground;
  };
  try {
    // The layout, its warm-up (all of it in the first frame, the budget unbounded) and the layers'
    // entrances, then the views settle.
    run(240);
    // The grid the sim lays out for the frame: 256 cells on its short side (sim.ts GRID_SHORT).
    const { width: columns, height: rows } = gridSize(W / H, 256);
    const before = bedHeights(gl, run(1), columns, rows);
    const stroke = (i: number): number => FROM + ((TO - FROM) * Math.min(i, 29)) / 29;
    run(40, stroke, DIG_ROW);
    run(60);
    knobs.tool = 1;
    frame.values = renderSettings(defaultsFor("delta"), knobs).params;
    run(40, stroke, BANK_ROW);
    run(60);
    const after = bedHeights(gl, run(1), columns, rows);
    // The mean change of the bed along a row's stroke (cells), and the most anywhere on a row.
    const along = (row: number): number => {
      const y = Math.floor(row * rows);
      let sum = 0;
      let n = 0;
      for (let x = Math.ceil(FROM * columns) + 2; x < Math.floor(TO * columns) - 2; x++, n++)
        sum += (after[y * columns + x] ?? 0) - (before[y * columns + x] ?? 0);
      return sum / n;
    };
    const most = (row: number): number => {
      const y = Math.floor(row * rows);
      let largest = 0;
      for (let x = 0; x < columns; x++)
        largest = Math.max(
          largest,
          Math.abs((after[y * columns + x] ?? 0) - (before[y * columns + x] ?? 0)),
        );
      return largest;
    };
    const dug = along(DIG_ROW);
    const banked = along(BANK_ROW);
    const alone = most(ALONE_ROW);
    if (!(dug < -0.3)) fail(`dragging with "dig" left the ground ${dug.toFixed(3)} cells lower`);
    if (!(banked > 0.3)) fail(`dragging with "bank" left the ground ${banked.toFixed(3)} higher`);
    if (!(alone < 1e-3)) fail(`ground away from both strokes moved ${alone.toFixed(4)} cells`);
    return { dug, banked, alone, grid: [columns, rows] };
  } finally {
    sim.dispose();
  }
}
