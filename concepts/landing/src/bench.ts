// The lab's GPU timing page (bench.html), opened by hand on a real GPU. Each scene at its defaults is
// drawn by the page's own renderer, unpaced (every frame the display gives it), on a canvas of a
// fixed number of cells, one per device pixel, and the page measures how long the scene's program
// takes to compile and to link, how long its frames take on the GPU
// (EXT_disjoint_timer_query_webgl2, when the browser has it) and from one drawn frame to the next
// (requestAnimationFrame), next to the context's renderer and limits. The report is JSON to copy
// or save; nothing leaves the page.
//
//   bench.html?scenes=a,b&cells=960x540&frames=120&warmup=30&budget=off&auto=1
import { CELL_BUDGET, stageCells } from "./display.ts";
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { loadScene, sceneIds, type SceneId } from "./scenes/index.ts";
import { fragmentSourceFor, vertexSource } from "./shaders/index.ts";
import { defaults, defaultsFor, paramDefaults, renderSettings } from "./state.ts";

/** The budget the README sets: one full-screen pass at ~960×540 cells holds 60 fps. */
const BUDGET_CELLS = "960x540";
/** How long a scene may take to compile, to reach the screen, and to give its frames. */
const SCENE_SECONDS = 60;

class BenchError extends Error {}

function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new BenchError(`bench.html lacks ${selector}`);
  return found;
}

const form = element("#setup", HTMLFormElement);
const scenesInput = element("#scenes", HTMLInputElement);
const cellsInput = element("#cells", HTMLInputElement);
const framesInput = element("#frames", HTMLInputElement);
const runButton = element("#run", HTMLButtonElement);
const status = element("#status", HTMLElement);
const rows = element("#results tbody", HTMLElement);
const reportBox = element("#report", HTMLTextAreaElement);
const canvas = element("#stage", HTMLCanvasElement);

const query = new URLSearchParams(location.search);
scenesInput.value = query.get("scenes") ?? "";
cellsInput.value = query.get("cells") ?? BUDGET_CELLS;
framesInput.value = query.get("frames") ?? "120";
const warmup = Math.max(1, Number(query.get("warmup") ?? 30) || 30);
/**
 * Whether the renderer holds the canvas to the landing's cell budget (CELL_BUDGET), coarsening a
 * larger grid as the landing does; `budget=off` draws the cells asked for, to time grids past it.
 */
const budgeted = query.get("budget") !== "off";

/** The middle and the 95th percentile of some frame measurements, in ms. */
interface Spread {
  readonly median: number;
  readonly p95: number;
}

function spread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number): number => {
    const value = sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
    return Math.round(value * 1000) / 1000;
  };
  return { median: at(0.5), p95: at(0.95) };
}

interface SceneReport {
  readonly scene: SceneId;
  /** The canvas's cells as the renderer sized it for this scene. */
  readonly cells: string;
  /** Compiling the scene's two shaders at its defaults, then linking its program. */
  readonly compileMs: number | null;
  readonly linkMs: number | null;
  /**
   * Its program's uniforms, each scalar, vector and matrix row counted as one vector: an upper bound
   * of what packing needs, beside the context's MAX_FRAGMENT_UNIFORM_VECTORS.
   */
  readonly uniformVectors: number | null;
  readonly samplers: number | null;
  /** Frames kept once the scene was on screen and warm. */
  readonly frames: number;
  /** GPU time per frame (a timer query around each frame); null without the extension. */
  readonly gpuMs: Spread | null;
  /** Time from one drawn frame to the next: what the display got, capped by its refresh rate. */
  readonly intervalMs: Spread | null;
  /** Main-thread time of each frame: the scene's simulation and the renderer's calls. */
  readonly cpuMs: Spread | null;
  /** The median frame time per million cells: from the GPU timer when there is one, else rAF. */
  readonly msPerMegacell: number | null;
  readonly error?: string;
}

/** EXT_disjoint_timer_query_webgl2: elapsed-time queries on the GPU, and whether they were upset. */
interface TimerQuery {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const SAMPLERS = new Set<number>([
  WebGL2RenderingContext.SAMPLER_2D,
  WebGL2RenderingContext.SAMPLER_3D,
  WebGL2RenderingContext.SAMPLER_CUBE,
  WebGL2RenderingContext.SAMPLER_2D_SHADOW,
  WebGL2RenderingContext.SAMPLER_2D_ARRAY,
  WebGL2RenderingContext.SAMPLER_2D_ARRAY_SHADOW,
  WebGL2RenderingContext.SAMPLER_CUBE_SHADOW,
  WebGL2RenderingContext.INT_SAMPLER_2D,
  WebGL2RenderingContext.INT_SAMPLER_3D,
  WebGL2RenderingContext.INT_SAMPLER_CUBE,
  WebGL2RenderingContext.INT_SAMPLER_2D_ARRAY,
  WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_2D,
  WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_3D,
  WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_CUBE,
  WebGL2RenderingContext.UNSIGNED_INT_SAMPLER_2D_ARRAY,
]);
/** Vector rows of each matrix uniform type (the columns of `matCxR`); any other type is one. */
const MATRIX_ROWS = new Map<number, number>([
  [WebGL2RenderingContext.FLOAT_MAT2, 2],
  [WebGL2RenderingContext.FLOAT_MAT3, 3],
  [WebGL2RenderingContext.FLOAT_MAT4, 4],
  [WebGL2RenderingContext.FLOAT_MAT2x3, 2],
  [WebGL2RenderingContext.FLOAT_MAT2x4, 2],
  [WebGL2RenderingContext.FLOAT_MAT3x2, 3],
  [WebGL2RenderingContext.FLOAT_MAT3x4, 3],
  [WebGL2RenderingContext.FLOAT_MAT4x2, 4],
  [WebGL2RenderingContext.FLOAT_MAT4x3, 4],
]);

/** Waits for `done`, a task at a time (shader completion status only changes between tasks). */
async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + SCENE_SECONDS * 1000;
  while (!done()) {
    if (performance.now() > deadline) throw new BenchError(`${what} took over ${SCENE_SECONDS} s`);
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 0);
    await next.promise;
  }
}

/** One tick of the renderer's loop, as the page measured it. */
interface Frame {
  /** The program that drew to the screen this frame, or null when nothing did. */
  readonly shown: WebGLProgram | null;
  readonly cpuMs: number;
  /** Time since the last frame that drew to the screen. */
  readonly intervalMs: number;
  /** The frame's timer query until the GPU answers it. */
  query: WebGLQuery | null;
  gpuMs: number | null;
}

/**
 * The renderer and the meters around it: one context for the whole run, each scene entered by a
 * cut. The renderer draws unpaced, every tick of its loop (it asks requestAnimationFrame for each),
 * so frames come as fast as the display takes them rather than at the landing's 60 a second; each
 * is timed on the main thread and, with the extension and while a scene is measured, on the GPU.
 * The context's draws to the screen say which program a frame showed, so frames that still show
 * the previous scene, or nothing, are not counted.
 */
class Bench {
  readonly renderer: DitherRenderer;
  readonly gl: WebGL2RenderingContext;
  readonly timer: TimerQuery | null;
  readonly parallel: KHR_parallel_shader_compile | null;
  /** The frames of the scene being measured, from its cut on. */
  #frames: Frame[] | undefined;
  /** Frames whose timer query the GPU has not answered yet. */
  #pending: Frame[] = [];
  /** rAF time of the last frame that drew to the screen. */
  #lastDrawn = Number.NaN;
  /** The program the last measured scene showed. */
  #lastShown: WebGLProgram | null = null;

  constructor(settings: RenderSettings) {
    this.renderer = new DitherRenderer(canvas, settings, false, {
      cellBudget: budgeted ? CELL_BUDGET : Number.POSITIVE_INFINITY,
    });
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new BenchError("WebGL2 unavailable");
    this.gl = gl;
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");

    let target: WebGLFramebuffer | null = null;
    let program: WebGLProgram | null = null;
    let shown: WebGLProgram | null = null;
    const bindFramebuffer = gl.bindFramebuffer.bind(gl);
    gl.bindFramebuffer = (kind, framebuffer) => {
      if (kind !== gl.READ_FRAMEBUFFER) target = framebuffer;
      bindFramebuffer(kind, framebuffer);
    };
    const useProgram = gl.useProgram.bind(gl);
    gl.useProgram = (next) => {
      program = next;
      useProgram(next);
    };
    const drawArrays = gl.drawArrays.bind(gl);
    gl.drawArrays = (mode, first, count) => {
      if (target === null) shown = program;
      drawArrays(mode, first, count);
    };

    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      nativeFrame((now) => {
        this.#collect();
        const timer = this.#frames === undefined ? null : this.timer;
        const query = timer === null ? null : gl.createQuery();
        if (timer !== null && query !== null) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        shown = null;
        const started = performance.now();
        try {
          callback(now);
        } finally {
          if (timer !== null && query !== null) gl.endQuery(timer.TIME_ELAPSED_EXT);
          const frame: Frame = {
            shown,
            cpuMs: performance.now() - started,
            intervalMs: now - this.#lastDrawn,
            query,
            gpuMs: null,
          };
          if (shown !== null) this.#lastDrawn = now;
          this.#frames?.push(frame);
          if (query !== null) this.#pending.push(frame);
        }
      });
    this.renderer.start({ paced: false });
  }

  /** Reads the timer queries the GPU has answered; a disjoint event voids every one in flight. */
  #collect(): void {
    const { gl, timer } = this;
    if (timer === null || this.#pending.length === 0) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) === true;
    const waiting: Frame[] = [];
    for (const frame of this.#pending) {
      const query = frame.query;
      if (query === null) continue;
      if (!disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) {
        waiting.push(frame);
        continue;
      }
      if (!disjoint) frame.gpuMs = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
      gl.deleteQuery(query);
      frame.query = null;
    }
    this.#pending = waiting;
  }

  /** Compiles and links `id`'s program at its defaults beside the renderer, timing each step. */
  async build(
    id: SceneId,
  ): Promise<Pick<SceneReport, "compileMs" | "linkMs" | "uniformVectors" | "samplers">> {
    const { gl, parallel } = this;
    const scene = await loadScene(id);
    const program = gl.createProgram();
    const shaders: WebGLShader[] = [];
    try {
      const compiling = performance.now();
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSourceFor(scene)],
      ] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new BenchError("shader allocation failed");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
      }
      for (const shader of shaders) {
        await until(
          () =>
            parallel === null ||
            gl.getShaderParameter(shader, parallel.COMPLETION_STATUS_KHR) === true,
          "compiling",
        );
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true)
          throw new BenchError(gl.getShaderInfoLog(shader) ?? "compile failed");
      }
      const compileMs = performance.now() - compiling;
      for (const shader of shaders) gl.attachShader(program, shader);
      const linking = performance.now();
      gl.linkProgram(program);
      await until(
        () =>
          parallel === null ||
          gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true,
        "linking",
      );
      if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true)
        throw new BenchError(gl.getProgramInfoLog(program) ?? "link failed");
      const linkMs = performance.now() - linking;
      let uniformVectors = 0;
      let samplers = 0;
      const count = Number(gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS));
      for (let index = 0; index < count; index += 1) {
        const uniform = gl.getActiveUniform(program, index);
        if (uniform === null) continue;
        if (SAMPLERS.has(uniform.type)) samplers += uniform.size;
        else uniformVectors += (MATRIX_ROWS.get(uniform.type) ?? 1) * uniform.size;
      }
      return {
        compileMs: Math.round(compileMs * 10) / 10,
        linkMs: Math.round(linkMs * 10) / 10,
        uniformVectors,
        samplers,
      };
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteProgram(program);
    }
  }

  /**
   * Cuts to `id` and returns `count` of its frames: from the first frame that shows a program other
   * than the previous scene's, `warmup` frames are let go, then `count` are kept, each with its GPU
   * time once the GPU has answered.
   */
  async sample(id: SceneId, count: number): Promise<Frame[]> {
    const frames: Frame[] = [];
    const before = this.#lastShown;
    const kept = (): Frame[] => {
      const entered = frames.findIndex((frame) => frame.shown !== null && frame.shown !== before);
      return entered === -1 ? [] : frames.slice(entered).filter((frame) => frame.shown !== null);
    };
    this.#frames = frames;
    try {
      this.renderer.update(settingsFor(id));
      await until(() => {
        const failure = this.renderer.failure;
        if (failure?.scene === id) throw new BenchError(`${failure.stage}: ${failure.message}`);
        const shown = kept().slice(0, warmup + count);
        return shown.length === warmup + count && shown.every((frame) => frame.query === null);
      }, "drawing");
    } finally {
      this.#frames = undefined;
    }
    const shown = kept();
    this.#lastShown = shown.at(-1)?.shown ?? before;
    return shown.slice(warmup, warmup + count);
  }
}

/** `id` at its defaults, one cell per device pixel. */
function settingsFor(id: SceneId): RenderSettings {
  return renderSettings(
    { ...defaultsFor(id), pixel: 1 / devicePixelRatio, transitions: "off", mouse: "still" },
    paramDefaults(id),
  );
}

/** The context's renderer, version, extensions and limits. */
function contextReport(bench: Bench): Record<string, unknown> {
  const { gl } = bench;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const precision = (kind: number): Record<string, number> | null => {
    const format = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, kind);
    return format === null
      ? null
      : { rangeMin: format.rangeMin, rangeMax: format.rangeMax, precision: format.precision };
  };
  const limits = [
    "MAX_FRAGMENT_UNIFORM_VECTORS",
    "MAX_VERTEX_UNIFORM_VECTORS",
    "MAX_FRAGMENT_UNIFORM_COMPONENTS",
    "MAX_UNIFORM_BLOCK_SIZE",
    "MAX_FRAGMENT_UNIFORM_BLOCKS",
    "MAX_TEXTURE_SIZE",
    "MAX_TEXTURE_IMAGE_UNITS",
    "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
    "MAX_DRAW_BUFFERS",
    "MAX_COLOR_ATTACHMENTS",
    "MAX_RENDERBUFFER_SIZE",
  ] as const;
  return {
    version: String(gl.getParameter(gl.VERSION)),
    shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    vendor: String(gl.getParameter(gl.VENDOR)),
    renderer: String(gl.getParameter(gl.RENDERER)),
    unmaskedVendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null,
    unmaskedRenderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
    timerQuery: bench.timer !== null,
    parallelCompile: bench.parallel !== null,
    limits: Object.fromEntries(limits.map((name) => [name, Number(gl.getParameter(gl[name]))])),
    fragmentPrecision: {
      highFloat: precision(gl.HIGH_FLOAT),
      mediumFloat: precision(gl.MEDIUM_FLOAT),
      lowFloat: precision(gl.LOW_FLOAT),
      highInt: precision(gl.HIGH_INT),
    },
    extensions: gl.getSupportedExtensions() ?? [],
  };
}

function cell(text: string | number | null | undefined): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text === null || text === undefined ? "" : String(text);
  return td;
}

let bench: Bench | undefined;

async function run(): Promise<void> {
  const asked = scenesInput.value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unknown = asked.filter((id) => !sceneIds.some((scene) => scene === id));
  if (unknown.length > 0) throw new BenchError(`unknown scenes: ${unknown.join(", ")}`);
  const scenes =
    asked.length === 0 ? sceneIds : asked.flatMap((id) => sceneIds.filter((scene) => scene === id));
  const [width = 0, height = 0] = cellsInput.value.split("x").map(Number);
  if (!(width >= 1 && height >= 1)) throw new BenchError("cells takes WxH, as 960x540");
  const frames = Math.max(10, Math.round(Number(framesInput.value)) || 120);
  const first = scenes[0];
  if (first === undefined) throw new BenchError("no scene to time");

  // One cell per device pixel (settingsFor), so the canvas's CSS size is its cells over the ratio.
  canvas.style.width = `${width / devicePixelRatio}px`;
  canvas.style.height = `${height / devicePixelRatio}px`;
  bench ??= new Bench(settingsFor(first));
  rows.replaceChildren();
  const results: SceneReport[] = [];
  // The cells the landing itself draws in this window (its stage fills it), at the default pixel
  // size and within the cell budget, as src/display.ts lays them out.
  const landing = stageCells(
    innerWidth * devicePixelRatio,
    innerHeight * devicePixelRatio,
    devicePixelRatio,
    defaults.pixel,
  );
  const report = {
    page: "manifold-landing-gpu-timing",
    version: 2,
    build:
      document.querySelector<HTMLMetaElement>('meta[name="landing-build"]')?.content ||
      "working tree",
    at: new Date().toISOString(),
    userAgent: navigator.userAgent,
    devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    window: `${innerWidth}x${innerHeight}`,
    landingCells: `${landing.width}x${landing.height}`,
    context: contextReport(bench),
    settings: {
      cells: `${width}x${height}`,
      frames,
      warmup,
      cellBudget: budgeted ? CELL_BUDGET : null,
    },
    scenes: results,
  };
  const show = (): void => {
    reportBox.value = JSON.stringify(report, null, 2);
  };
  show();
  for (const [index, id] of scenes.entries()) {
    status.textContent = `${index + 1}/${scenes.length}: ${id}`;
    let result: SceneReport;
    try {
      const built = await bench.build(id);
      const kept = await bench.sample(id, frames);
      const gpuMs = spread(kept.flatMap((frame) => (frame.gpuMs === null ? [] : [frame.gpuMs])));
      const intervalMs = spread(kept.map((frame) => frame.intervalMs));
      const median = gpuMs?.median ?? intervalMs?.median;
      result = {
        scene: id,
        cells: `${canvas.width}x${canvas.height}`,
        ...built,
        frames: kept.length,
        gpuMs,
        intervalMs,
        cpuMs: spread(kept.map((frame) => frame.cpuMs)),
        msPerMegacell:
          median === undefined
            ? null
            : Math.round((median / (canvas.width * canvas.height)) * 1e9) / 1000,
      };
    } catch (error: unknown) {
      result = {
        scene: id,
        cells: `${canvas.width}x${canvas.height}`,
        compileMs: null,
        linkMs: null,
        uniformVectors: null,
        samplers: null,
        frames: 0,
        gpuMs: null,
        intervalMs: null,
        cpuMs: null,
        msPerMegacell: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    const frameMs = result.gpuMs ?? result.intervalMs;
    const row = document.createElement("tr");
    row.append(
      cell(id),
      cell(result.compileMs),
      cell(result.linkMs),
      cell(result.uniformVectors),
      cell(frameMs?.median),
      cell(frameMs?.p95),
      cell(result.error ?? (result.gpuMs === null ? "rAF" : "GPU timer")),
      cell(result.msPerMegacell),
    );
    rows.append(row);
    show();
  }
  status.textContent = `done: ${results.length} scenes; copy or download the report below`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runButton.disabled = true;
  run()
    .catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      runButton.disabled = false;
    });
});
element("#copy", HTMLButtonElement).addEventListener("click", () => {
  navigator.clipboard.writeText(reportBox.value).then(
    () => {
      status.textContent = "report copied";
    },
    () => {
      reportBox.select();
      status.textContent = "the browser refused the clipboard: the report is selected to copy";
    },
  );
});
element("#save", HTMLButtonElement).addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([reportBox.value], { type: "application/json" }));
  link.download = `landing-gpu-timing-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});
if (query.get("auto") === "1") form.requestSubmit();
