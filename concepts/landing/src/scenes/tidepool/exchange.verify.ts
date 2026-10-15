// GPU regression for the tide pool's water (sims/shallow.ts): a walled box keeps its water, a sea
// below a basin's rim leaves the basin alone, a sea above it pours in, and the basin keeps what came
// over once the sea falls back. Small grids: float read-back is slow on software WebGL.
import { GpuCompute } from "../../sims/gpu.ts";
import { ShallowWater } from "../../sims/shallow.ts";

const W = 24;
const H = 16;
/** The basin: columns 8..15, rows 3..8, floor -2 inside a rim at 1; the sea in the top four rows. */
const inBasin = (x: number, y: number): boolean => x >= 8 && x <= 15 && y >= 3 && y <= 8;
const onRim = (x: number, y: number): boolean =>
  x >= 7 && x <= 16 && y >= 2 && y <= 9 && !inBasin(x, y);

function volume(gl: WebGL2RenderingContext, water: ShallowWater, basin: boolean): number {
  gl.finish();
  const data = new Float32Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, water.water.read.framebuffer);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, data);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let sum = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (!basin || inBasin(x, y)) sum += data[(y * W + x) * 4] ?? 0;
  return sum;
}

export function verifyTidepoolExchange(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  try {
    const bed = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        bed[y * W + x] = y >= H - 4 ? -3 : inBasin(x, y) ? -2 : onRim(x, y) ? 1 : 0;
    const run = (water: ShallowWater, steps: number, sea: number): void => {
      for (let i = 0; i < steps; i++)
        water.step({ dt: 1 / 40, time: i / 40, uniforms: { uSea: sea } });
    };

    // Closed and unforced: a hump of water spreads and sloshes, and none is made or lost.
    const box = new ShallowWater(gpu, {
      width: W,
      height: H,
      gravity: 40,
      friction: 0.05,
      viscosity: 0.1,
    });
    box.setBed(new Float32Array(W * H).fill(-2));
    box.reset(
      Float32Array.from({ length: W * H }, (_, i) => 2 + (Math.abs((i % W) - 12) < 3 ? 1.5 : 0)),
    );
    const before = volume(gl, box, false);
    for (let i = 0; i < 60; i++) box.step({ dt: 1 / 30 });
    const after = volume(gl, box, false);
    if (Math.abs(after - before) > 1e-3 * before)
      throw new Error(`Shallow water lost or made water: ${before} -> ${after}`);
    box.dispose();

    // The sea is the forced top rows, held at uSea and still.
    const water = new ShallowWater(gpu, {
      width: W,
      height: H,
      gravity: 120,
      friction: 0.05,
      forcing: `
uniform float uSea;
vec4 shallowForcing(vec2 uv, float bed) {
  return gl_FragCoord.y > uSize.y - 4.0 ? vec4(uSea, 0.0, 0.0, 30.0) : vec4(0.0);
}`,
    });
    water.setBed(bed);
    // Only the sea holds water at first: the basin opens dry.
    water.reset(bed.map((b, i) => (i >= (H - 4) * W ? Math.max(-1 - b, 0) : 0)));
    const start = volume(gl, water, true);
    if (start !== 0) throw new Error(`The basin opened with water below its rim: ${start}`);
    run(water, 80, 0.5);
    const below = volume(gl, water, true);
    if (below > 1e-3) throw new Error(`A sea below the rim reached the basin: ${below}`);
    run(water, 400, 2);
    const flooded = volume(gl, water, true);
    // Over the rim, the basin fills toward the sea, well past its rim: 48 cells × 4 deep.
    if (flooded < 0.8 * 48 * 4)
      throw new Error(`A sea above the rim left the basin short: ${flooded}`);
    run(water, 300, -1);
    const kept = volume(gl, water, true);
    // Once the sea falls back the basin spills down toward its rim (3 deep, 144) and keeps the rest:
    // its seiche spills a little more over the rim, but a leak would empty it and no step may make
    // water.
    if (kept < 0.6 * 48 * 3 || kept > 1.02 * 48 * 3)
      throw new Error(`The basin did not keep its water below the rim: ${kept}`);
    return { conserved: [before, after], basin: { start, below, flooded, kept } };
  } finally {
    gpu.dispose();
  }
}
