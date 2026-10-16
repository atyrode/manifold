// GPU regression for the shared shallow water (sims/shallow.ts), against exact solutions: a dam
// break's bore runs at Stoker's speed and stands at his depth, a lake at rest over a bumpy bed with
// islands stays at rest, and a surge released in a closed basin over dry ground neither makes nor
// loses water. Small grids: float read-back is slow on software WebGL.
import { GpuCompute } from "./gpu.ts";
import { ShallowWater } from "./shallow.ts";

/** Depth, velocity xy and w of every cell, row 0 at the bottom. */
function readWater(gl: WebGL2RenderingContext, water: ShallowWater): Float32Array {
  gl.finish();
  const data = new Float32Array(water.width * water.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, water.water.read.framebuffer);
  gl.readPixels(0, 0, water.width, water.height, gl.RGBA, gl.FLOAT, data);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return data;
}

/** Stoker's wet-bed dam break: the depth between the rarefaction and the bore, and the bore's speed. */
function stoker(h0: number, h1: number, g: number): { depth: number; speed: number } {
  const bore = (h: number): number => Math.sqrt((g * h * (h + h1)) / (2 * h1));
  // The plateau's depth: the bore's jump conditions meet the rarefaction's Riemann invariant.
  let lo = h1;
  let hi = h0;
  for (let i = 0; i < 100; i++) {
    const h = 0.5 * (lo + hi);
    if (bore(h) * (1 - h1 / h) > 2 * (Math.sqrt(g * h0) - Math.sqrt(g * h))) hi = h;
    else lo = h;
  }
  const depth = 0.5 * (lo + hi);
  return { depth, speed: bore(depth) };
}

export function verifyShallowWater(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  try {
    const gravity = 242;

    // Dam breaks down a channel 3 cells wide: 8 cells deep behind the dam at x = 150, shallower ahead.
    // Over 3 s the bore runs some 125 cells; the rarefaction does not reach the wall behind.
    const W = 400;
    const H = 3;
    const dam = 150;
    const seconds = 3;
    const dt = 1 / 240;
    const dams: Record<string, unknown>[] = [];
    for (const ahead of [0.8, 4]) {
      const exact = stoker(8, ahead, gravity);
      const water = new ShallowWater(gpu, { width: W, height: H, gravity, friction: 0 });
      water.setBed(new Float32Array(W * H));
      water.reset(Float32Array.from({ length: W * H }, (_, i) => (i % W < dam ? 8 : ahead)));
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) water.step({ dt });
      const data = readWater(gl, water);
      water.dispose();
      const row = Float64Array.from({ length: W }, (_, x) => data[(W + x) * 4] ?? 0);
      // The bore: where the depth last falls through halfway from the plateau to the still water.
      const half = 0.5 * (exact.depth + ahead);
      let front = dam;
      for (let x = W - 2; x > dam; x--) {
        const here = row[x] ?? 0;
        const next = row[x + 1] ?? 0;
        if (here > half && next <= half) {
          front = x + 0.5 + (here - half) / (here - next);
          break;
        }
      }
      // The plateau: the median depth over 55..85 % of the way from the dam to the bore.
      const span = Array.from(
        row.subarray(
          Math.round(dam + 0.55 * (front - dam)),
          Math.round(dam + 0.85 * (front - dam)),
        ),
      ).sort((a, b) => a - b);
      const plateau = span[Math.floor(span.length / 2)] ?? 0;
      const speed = (front - dam) / (steps * dt);
      const result = { ahead, speed, exactSpeed: exact.speed, plateau, exactPlateau: exact.depth };
      if (Math.abs(speed / exact.speed - 1) > 0.03 || Math.abs(plateau / exact.depth - 1) > 0.03)
        throw new Error(`A dam break strayed from Stoker's: ${JSON.stringify(result)}`);
      dams.push(result);
    }

    // A lake at rest at level 0.3 over a smooth bed of bumps, some 70 cells of them islands.
    const LW = 48;
    const LH = 32;
    const bed = Float32Array.from({ length: LW * LH }, (_, i) => {
      const x = i % LW;
      const y = Math.floor(i / LW);
      return -1.1 + 1.3 * Math.sin(x * 0.41) * Math.cos(y * 0.33) + 0.9 * Math.sin((x + y) * 0.17);
    });
    const lake = new ShallowWater(gpu, { width: LW, height: LH, gravity, friction: 0 });
    lake.setBed(bed);
    lake.reset(bed.map((b) => Math.max(0.3 - b, 0)));
    for (let i = 0; i < 600; i++) lake.step({ dt: 1 / 120 });
    const still = readWater(gl, lake);
    lake.dispose();
    let fastest = 0;
    let stray = 0;
    let islands = 0;
    for (let i = 0; i < LW * LH; i++) {
      const depth = still[i * 4] ?? 0;
      const b = bed[i] ?? 0;
      if (b >= 0.3) {
        islands++;
        stray = Math.max(stray, depth);
        continue;
      }
      fastest = Math.max(fastest, Math.hypot(still[i * 4 + 1] ?? 0, still[i * 4 + 2] ?? 0));
      stray = Math.max(stray, Math.abs(b + depth - 0.3));
    }
    if (islands === 0) throw new Error("The bumpy bed raised no islands");
    if (fastest > 1e-3 || stray > 1e-4)
      throw new Error(
        `A lake at rest stirred: speed ${fastest} cells/s, level off by ${stray} cells`,
      );

    // A wall of water 2 cells above the level released in a closed basin of bumps: it surges over
    // the islands and sloshes; the water it holds stays the same.
    const basin = new ShallowWater(gpu, { width: LW, height: LH, gravity, friction: 0.02 });
    basin.setBed(bed);
    basin.reset(bed.map((b, i) => Math.max((i % LW < 12 ? 2.3 : 0.3) - b, 0)));
    const sum = (data: Float32Array): number => {
      let total = 0;
      for (let i = 0; i < LW * LH; i++) total += data[i * 4] ?? 0;
      return total;
    };
    const before = sum(readWater(gl, basin));
    for (let i = 0; i < 600; i++) basin.step({ dt: 1 / 240 });
    const surged = readWater(gl, basin);
    basin.dispose();
    const after = sum(surged);
    // Float32 rounds each cell's update; anything past that is water made or lost.
    if (Math.abs(after - before) > 1e-5 * before)
      throw new Error(`The basin made or lost water: ${before} -> ${after}`);
    return { dams, lake: { fastest, stray, islands }, mass: [before, after] };
  } finally {
    gpu.dispose();
  }
}
