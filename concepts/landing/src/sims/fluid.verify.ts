// GPU check (verify-browser.ts): the fluid's pressure solve makes the flow divergence free at the
// scale of the picture, not only in small eddies. Fields that are mostly divergence are projected by
// the real FluidSim and read back, and the divergence left is taken as the solver's own divergence
// pass takes it (central differences, nothing through a wall or the obstacle), over the fluid:
//   - from rest, one step removes most of it at the longest wavelengths the frame holds, between
//     walls, with open sides over a floor, and inside a round obstacle;
//   - the next step, starting from the pressure the first one left, removes nearly all of it;
//   - a steady source of divergence (what buoyancy and stirring add every step) does not pile up,
//     neither a pure one (the gradient of a frame-wide potential, which the flow cannot keep) nor a
//     buoyant updraft that sets the tank circulating.
import { FluidSim, type FluidBoundary } from "./fluid.ts";
import { GpuCompute, type Pass } from "./gpu.ts";

const WIDTH = 1600;
const HEIGHT = 900;
const ASPECT = WIDTH / HEIGHT;
/** Velocity texels on the short side: the default grid, 228 × 128. */
const RESOLUTION = 128;
/** Frame heights per second: the projected fields' speed. */
const SPEED = 0.05;
/** The steady sources' strength (frame heights per second²) and how long they run. */
const SOURCE = 0.3;
const STEPS = 120;

type Kind = "box" | "updraft";

interface Layout {
  readonly name: string;
  readonly boundary: FluidBoundary;
  readonly obstacle?: string;
  readonly kind: Kind;
  /** Most of the divergence one step may leave, from rest and started from the last pressure. */
  readonly rest: number;
  readonly warm: number;
}

// Measured in software WebGL, divergence left from rest / warm: walls 0.118 / 0.017, open sides
// 0.19 / 0.046, round 0.29 / 0.175 (most of it the collocated grid's own floor along the curved
// wall, which no solve removes). The Jacobi solve this replaced left 0.94–1.0 of it either way.
const LAYOUTS: readonly Layout[] = [
  { name: "walls", boundary: {}, kind: "box", rest: 0.2, warm: 0.05 },
  {
    name: "open sides over a floor",
    boundary: { left: "open", right: "open" },
    obstacle: "float fluidObstacle(vec2 p) { return p.y - 0.1; }",
    kind: "updraft",
    rest: 0.3,
    warm: 0.1,
  },
  {
    name: "inside a round obstacle",
    boundary: {},
    obstacle: "float fluidObstacle(vec2 p) { return 0.39 - length(p - 0.5 * uDomain); }",
    kind: "updraft",
    rest: 0.4,
    warm: 0.3,
  },
];

/**
 * Most of the divergence a steady source may leave after STEPS, as a share of what one step of it
 * adds. Measured: box 0.004 (the flow keeps none of it), updraft 0.34 (the circulation it sets up
 * carries the grid's floor along); the Jacobi solve let it pile up to 52 and 12 times a step's.
 */
const STEADY: Readonly<Record<Kind, number>> = { box: 0.02, updraft: 1 };

/**
 * The fields, as force snippets (frame heights per second² per unit of uSource). "box": minus the
 * gradient of (cos(pi u) cos(pi v) + cos(pi v)) / pi, the frame's longest wall modes, so no flow
 * through the walls and nothing but divergence. "updraft": warm air rising from a patch a tenth of
 * a frame height wide, below the middle.
 */
const FORCES: Readonly<Record<Kind, string>> = {
  box: `
uniform float uSource;
vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
  const float PI = 3.14159265;
  return uSource * vec2(sin(PI * uv.x) * cos(PI * uv.y) / uDomain.x,
                        cos(PI * uv.x) * sin(PI * uv.y) + sin(PI * uv.y));
}`,
  updraft: `
uniform float uSource;
vec2 fluidForce(vec2 uv, vec2 p, vec2 velocity, vec4 dye) {
  vec2 d = p - vec2(0.5 * uDomain.x, 0.4);
  return vec2(0.0, uSource * exp(-dot(d, d) / (2.0 * 0.1 * 0.1)));
}`,
};

/** The grid the divergence is taken on: its size, edges and which cells are solid. */
interface Grid {
  readonly width: number;
  readonly height: number;
  readonly boundary: FluidBoundary;
  readonly solid: Uint8Array;
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}

/** FORCES[kind] times `scale` at every cell centre, as rgba (0 in the obstacle). */
function sample(kind: Kind, grid: Grid, scale: number): Float32Array {
  const { width, height, solid } = grid;
  const out = new Float32Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (solid[k] === 1) continue;
      const u = (i + 0.5) / width;
      const v = (j + 0.5) / height;
      if (kind === "box") {
        const x = Math.PI * u;
        const y = Math.PI * v;
        out[4 * k] = (scale * Math.sin(x) * Math.cos(y)) / ASPECT;
        out[4 * k + 1] = scale * (Math.cos(x) * Math.sin(y) + Math.sin(y));
      } else {
        const dx = (u - 0.5) * ASPECT;
        const dy = v - 0.4;
        out[4 * k + 1] = scale * Math.exp(-(dx * dx + dy * dy) / (2 * 0.1 * 0.1));
      }
    }
  }
  return out;
}

/**
 * Root mean square of the divergence over the fluid cells (rgba velocity), as the solver's
 * divergence pass takes it: velocity past a wall or inside the obstacle is the cell's own,
 * mirrored; past an open edge the cell's own.
 */
function divergence(grid: Grid, velocity: Float32Array): number {
  const { width, height, boundary, solid } = grid;
  const ratio = width / (height * ASPECT);
  const across = (i: number, j: number, channel: 0 | 1, own: number): number => {
    if (i < 0 || i >= width || j < 0 || j >= height) {
      const edge =
        i < 0
          ? boundary.left
          : i >= width
            ? boundary.right
            : j < 0
              ? boundary.bottom
              : boundary.top;
      return edge === "open" ? own : -own;
    }
    const k = j * width + i;
    return solid[k] === 1 ? -own : (velocity[4 * k + channel] ?? 0);
  };
  let sum = 0;
  let cells = 0;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      if (solid[k] === 1) continue;
      const u = velocity[4 * k] ?? 0;
      const v = velocity[4 * k + 1] ?? 0;
      const du = across(i + 1, j, 0, u) - across(i - 1, j, 0, u);
      const dv = across(i, j + 1, 1, v) - across(i, j - 1, 1, v);
      const d = 0.5 * (du * ratio + dv);
      sum += d * d;
      cells++;
    }
  }
  return Math.sqrt(sum / Math.max(1, cells));
}

/** Reads fields back through an rgba32f copy. */
class Reader {
  readonly #gl: WebGL2RenderingContext;
  readonly #gpu: GpuCompute;
  readonly #copy: Pass;

  constructor(gl: WebGL2RenderingContext, gpu: GpuCompute) {
    this.#gl = gl;
    this.#gpu = gpu;
    this.#copy = gpu.pass(
      "uniform sampler2D uField; void main() { fragColor = texelFetch(uField, ivec2(gl_FragCoord.xy), 0); }",
      "fluid check copy",
    );
  }

  read(texture: WebGLTexture, width: number, height: number): Float32Array {
    const target = this.#gpu.target({ width, height, format: "rgba32f", filter: "nearest" });
    this.#copy.run(target, { textures: { uField: texture } });
    const out = new Float32Array(width * height * 4);
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.dispose();
    return out;
  }
}

/** A layout's fluid (with its field as the force), the solid laid out by a first step, then emptied. */
function build(
  gpu: GpuCompute,
  reader: Reader,
  layout: Pick<Layout, "boundary" | "obstacle" | "kind">,
): { fluid: FluidSim; grid: Grid } {
  const fluid = new FluidSim(gpu, {
    width: WIDTH,
    height: HEIGHT,
    velocityResolution: RESOLUTION,
    dyeResolution: 64,
    dyeFormat: "r16f",
    dyeScheme: "linear",
    boundary: layout.boundary,
    force: FORCES[layout.kind],
    ...(layout.obstacle === undefined ? {} : { obstacle: layout.obstacle }),
  });
  fluid.step({ dt: 1e-6, uniforms: { uSource: 0 } });
  fluid.clear();
  const width = fluid.velocity.width;
  const height = fluid.velocity.height;
  const solid = new Uint8Array(width * height);
  if (fluid.solid) {
    const coverage = reader.read(fluid.solid.texture, width, height);
    for (let k = 0; k < width * height; k++) solid[k] = (coverage[4 * k] ?? 0) > 0.5 ? 1 : 0;
  }
  return { fluid, grid: { width, height, boundary: layout.boundary, solid } };
}

/** Divergence left (a share) by a projection from rest, and by the next started from its pressure. */
function project(gpu: GpuCompute, reader: Reader, layout: Layout): { rest: number; warm: number } {
  const { fluid, grid } = build(gpu, reader, layout);
  const start = sample(layout.kind, grid, SPEED);
  const seed = start.filter((_, k) => k % 4 < 2);
  const before = divergence(grid, start);
  const left = (): number => {
    fluid.velocity.seed(seed);
    // A step this short only projects: the velocity carries itself a few billionths of a texel.
    fluid.step({ dt: 1e-6 });
    return divergence(grid, reader.read(fluid.velocity.texture, grid.width, grid.height)) / before;
  };
  const rest = left();
  const warm = left();
  fluid.dispose();
  return { rest, warm };
}

/** Divergence left after STEPS of a steady source between walls, as a share of what one step adds. */
function steady(gpu: GpuCompute, reader: Reader, kind: Kind): number {
  const { fluid, grid } = build(gpu, reader, { boundary: {}, kind });
  const dt = 1 / 60;
  for (let i = 0; i < STEPS; i++) fluid.step({ dt, uniforms: { uSource: SOURCE } });
  const left = divergence(grid, reader.read(fluid.velocity.texture, grid.width, grid.height));
  fluid.dispose();
  return left / divergence(grid, sample(kind, grid, SOURCE * dt));
}

export function verifyFluidPressure(gl: WebGL2RenderingContext): Record<string, unknown> {
  const gpu = GpuCompute.create(gl);
  if (!gpu) throw new Error("Float GPU targets unavailable");
  const reader = new Reader(gl, gpu);
  const results: Record<string, number> = {};
  try {
    for (const layout of LAYOUTS) {
      const { rest, warm } = project(gpu, reader, layout);
      results[`${layout.name}, from rest`] = rest;
      results[`${layout.name}, warm`] = warm;
      check(rest < layout.rest, `A step from rest left ${rest} of the divergence (${layout.name})`);
      check(
        warm < layout.warm,
        `A warm-started step left ${warm} of the divergence (${layout.name})`,
      );
    }
    for (const kind of ["box", "updraft"] as const) {
      const left = steady(gpu, reader, kind);
      results[`steady ${kind}`] = left;
      check(left < STEADY[kind], `A steady ${kind} source piled up ${left} steps' divergence`);
    }
  } finally {
    gpu.dispose();
  }
  return results;
}
