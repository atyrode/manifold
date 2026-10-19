// The lab's GPU timing page (bench.html), opened by hand on a real GPU. Each scene at its defaults is
// drawn by the page's own renderer, unpaced (every frame the display gives it), on a canvas of a
// fixed number of cells, one per device pixel, and the page measures how long the scene's program
// takes to compile and to link, how long its frames take on the GPU
// (EXT_disjoint_timer_query_webgl2, when the browser has it) and from one drawn frame to the next
// (requestAnimationFrame), next to the context's renderer and limits. The report is JSON to copy
// or save; nothing leaves the page.
//
//   bench.html?scenes=a,b&cells=960x540&frames=120&warmup=30&budget=off&auto=1
//
// Dev-only options for the engine and software rasterisers (scripts/engine-bench.ts drives them):
// a scene `canvas:<doc>` is the canvas showing a starter document (src/engine/docs.ts, its title
// in kebab case: `canvas:lava-room`; `canvas:*` every one) with its World; `sync=1` waits for each
// frame's draw (it reads a pixel back: WebGL's finish only flushes), so a frame's main-thread time
// is its draw's where there is no timer; `hold=<s>` keeps each scene drawing at least that many
// seconds once warm, every frame kept; a lost context fails the scene it happens in; `still=1`
// stands the motion clock and `view=source` shows the source, to compare a picture across builds.
import { canvasDocs, exampleDocs } from "./engine/docs.ts";
import { engineStage } from "./engine/stage.ts";
import type { EngineDoc } from "./engine/types.ts";
import { CELL_BUDGET, stageCells } from "./display.ts";
import { DitherRenderer, type RenderSettings } from "./renderer.ts";
import { loadScene, sceneIds, type SceneId } from "./scenes/index.ts";
import type { SceneDef } from "./scenes/types.ts";
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  shaderValues,
  vertexSource,
} from "./shaders/index.ts";
import { defaults, defaultsFor, paramDefaults, renderSettings, type Params } from "./state.ts";

/** The budget the README sets: one full-screen pass at ~960×540 cells holds 60 fps. */
const BUDGET_CELLS = "960x540";
/** How long a scene may take to compile, to reach the screen, and to give its frames. */
const SCENE_SECONDS = 60;
/** The canvas scene, whose entries `canvas:<doc>` show a starter document. */
const CANVAS: SceneId = "canvas";

/** What one bench entry draws: a scene at its defaults, or the canvas showing a starter document. */
interface Entry {
  readonly name: string;
  readonly scene: SceneId;
  readonly doc?: EngineDoc;
}

/** The starter documents' entries: `canvas:` and the title in kebab case. */
const docEntries: readonly Entry[] = [...canvasDocs, ...exampleDocs].map((doc) => ({
  name: `${CANVAS}:${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  scene: CANVAS,
  doc,
}));

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
/** Whether each frame waits for its draw (a pixel read back), so `cpuMs` holds it (see the header). */
const synced = query.get("sync") === "1";
const syncPixel = new Uint8Array(4);
/** Seconds each scene keeps drawing once warm, every frame kept (see the header). */
const hold = Math.max(0, Number(query.get("hold") ?? 0) || 0);
/** Whether the motion clock stands (motion 0), so a picture can be compared across builds. */
const still = query.get("still") === "1";
/** Whether the source shows rather than its dither (`view=source`), for comparing pictures. */
const source = query.get("view") === "source";
/** Whether the renderer bounds its draws in strips (src/strips.ts); `strips=off` times whole pictures. */
const stripped = query.get("strips") !== "off";

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
  /** The entry: a scene id, or `canvas:<doc>` (see the header). */
  readonly scene: string;
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
  /**
   * GPU time of each draw of the picture (the renderer's timer query): a strip of it while it is
   * drawn in strips (src/strips.ts); null without the extension.
   */
  readonly gpuMs: Spread | null;
  /** The strips the picture was drawn in at the end (1: whole). */
  readonly strips: number | null;
  /** A whole picture's GPU time: the timed draws' mean time a row, times the rows. */
  readonly pictureMs: number | null;
  /** Time from one drawn frame to the next: what the display got, capped by its refresh rate. */
  readonly intervalMs: Spread | null;
  /**
   * Main-thread time of each frame: the scene's simulation and the renderer's calls (with `sync=1`,
   * its draw too).
   */
  readonly cpuMs: Spread | null;
  /** The median picture's time per million cells: the GPU timer's, else `cpuMs` (sync=1), else rAF's. */
  readonly msPerMegacell: number | null;
  readonly error?: string;
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

/**
 * Waits for `done`, a task at a time (shader completion status only changes between tasks), at most
 * `seconds`.
 */
async function until(done: () => boolean, what: string, seconds = SCENE_SECONDS): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (!done()) {
    if (performance.now() > deadline) throw new BenchError(`${what} took over ${seconds} s`);
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 0);
    await next.promise;
  }
}

/** One tick of the renderer's loop, as the page measured it. */
interface Frame {
  /** Its rAF time. */
  readonly at: number;
  /** The program that drew to the screen this frame, or null when nothing did. */
  readonly shown: WebGLProgram | null;
  readonly cpuMs: number;
  /** Time since the last frame that drew to the screen. */
  readonly intervalMs: number;
}

/** One draw of the picture on screen as the renderer's GPU timer measured it (when it came in). */
interface Timed {
  readonly at: number;
  readonly ms: number;
  /** The rows it drew (a strip, src/strips.ts, or the whole picture) of how many. */
  readonly rows: number;
  readonly height: number;
}

/**
 * The renderer and the meters around it: one context for the whole run, each scene entered by a
 * cut. The renderer draws unpaced, every tick of its loop (it asks requestAnimationFrame for each),
 * so frames come as fast as the display takes them rather than at the landing's 60 a second; each
 * is timed on the main thread and, with the extension, on the GPU by the renderer itself (its own
 * timer queries bound its draws, src/strips.ts: one of the page's around a frame would nest in
 * them). The context's draws and blits to the screen say which program a frame showed, so frames
 * that still show the previous scene, or nothing, are not counted.
 */
class Bench {
  readonly renderer: DitherRenderer;
  readonly gl: WebGL2RenderingContext;
  /** Whether the context has EXT_disjoint_timer_query_webgl2. */
  readonly timer: boolean;
  readonly parallel: KHR_parallel_shader_compile | null;
  /** The frames of the scene being measured, from its cut on. */
  #frames: Frame[] | undefined;
  /** The draws the GPU timed meanwhile. */
  #timed: Timed[] | undefined;
  /** rAF time of the last frame that drew to the screen. */
  #lastDrawn = Number.NaN;
  /** The program the last measured scene showed. */
  #lastShown: WebGLProgram | null = null;
  /** The features key of the last measured entry. */
  #lastKey = "";
  /** How many times the context has been lost. */
  #lost = 0;

  constructor(settings: RenderSettings) {
    this.renderer = new DitherRenderer(canvas, settings, false, {
      cellBudget: budgeted ? CELL_BUDGET : Number.POSITIVE_INFINITY,
      strips: stripped,
      timed: (ms, rows, height) => this.#timed?.push({ at: performance.now(), ms, rows, height }),
    });
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new BenchError("WebGL2 unavailable");
    this.gl = gl;
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null;
    this.parallel = gl.getExtension("KHR_parallel_shader_compile");
    canvas.addEventListener("webglcontextlost", () => {
      this.#lost += 1;
    });

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
    // A picture drawn through the renderer's frame of strips reaches the screen by a blit.
    const blitFramebuffer = gl.blitFramebuffer.bind(gl);
    gl.blitFramebuffer = (...args) => {
      if (target === null) shown = program;
      blitFramebuffer(...args);
    };

    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      nativeFrame((now) => {
        shown = null;
        const started = performance.now();
        try {
          callback(now);
        } finally {
          if (synced) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
          const frame: Frame = {
            at: now,
            shown,
            cpuMs: performance.now() - started,
            intervalMs: now - this.#lastDrawn,
          };
          if (shown !== null) this.#lastDrawn = now;
          this.#frames?.push(frame);
        }
      });
    this.renderer.start({ paced: false });
  }

  /** Compiles and links `entry`'s program at its defaults beside the renderer, timing each step. */
  async build(
    entry: Entry,
  ): Promise<Pick<SceneReport, "compileMs" | "linkMs" | "uniformVectors" | "samplers">> {
    const { gl, parallel } = this;
    const scene = await loadScene(entry.scene);
    const program = gl.createProgram();
    const shaders: WebGLShader[] = [];
    try {
      const compiling = performance.now();
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSourceFor(scene, featuresOf(entry, scene))],
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
   * Cuts to `entry` and returns `count` of its frames (every one drawn over `hold` seconds, if
   * longer): from the first frame that shows a program other than the previous entry's (any, if
   * it draws with the same), `warmup` frames are let go, then the rest are kept; and the draws the
   * GPU timed from the first kept frame on, as many at least where it times them. A context lost
   * meanwhile fails it.
   */
  async sample(
    entry: Entry,
    count: number,
    key: string,
  ): Promise<{ frames: Frame[]; timed: Timed[] }> {
    const frames: Frame[] = [];
    const timed: Timed[] = [];
    const before = key === this.#lastKey ? null : this.#lastShown;
    const lost = this.#lost;
    // The frames shown from the cut on, up to the last one kept: `warmup` + `count` of them, or as
    // many as reach `hold` seconds past the first one kept; undefined until there are as many.
    const kept = (): Frame[] | undefined => {
      const entered = frames.findIndex((frame) => frame.shown !== null && frame.shown !== before);
      const shown =
        entered === -1 ? [] : frames.slice(entered).filter((frame) => frame.shown !== null);
      const warm = shown[warmup];
      if (warm === undefined) return undefined;
      const held = shown.findIndex((frame) => frame.at - warm.at >= hold * 1000);
      const end = Math.max(warmup + count, held + 1);
      return held === -1 || shown.length < end ? undefined : shown.slice(0, end);
    };
    const timedSince = (at: number): Timed[] => timed.filter((draw) => draw.at >= at);
    this.#frames = frames;
    this.#timed = timed;
    let shown: Frame[] | undefined;
    try {
      this.renderer.update(settingsFor(entry));
      await until(
        () => {
          if (this.#lost !== lost) throw new BenchError("the context was lost");
          const failure = this.renderer.failure;
          if (failure?.scene === entry.scene)
            throw new BenchError(`${failure.stage}: ${failure.message}`);
          shown = kept();
          const warm = shown?.[warmup];
          return warm !== undefined && (!this.timer || timedSince(warm.at).length >= count);
        },
        "drawing",
        SCENE_SECONDS + hold,
      );
    } finally {
      this.#frames = undefined;
      this.#timed = undefined;
    }
    this.#lastShown = shown?.at(-1)?.shown ?? before;
    this.#lastKey = key;
    const warm = shown?.[warmup];
    return {
      frames: shown?.slice(warmup) ?? [],
      timed: warm === undefined ? [] : timedSince(warm.at),
    };
  }
}

/** `entry`'s knob values: its scene's defaults, and a starter document's World over them. */
function paramsOf(entry: Entry): Params {
  return { ...paramDefaults(entry.scene), ...entry.doc?.world };
}

/** The features `entry` draws with: its scene's at its defaults, or a document's with its World. */
function featuresOf(entry: Entry, scene: SceneDef): Readonly<Record<string, number>> {
  return entry.doc === undefined
    ? sceneFeatures(scene)
    : sceneFeatures(scene, shaderValues(scene, paramsOf(entry)));
}

/**
 * Shows `entry`'s document on the engine's stage once the code of its kinds has loaded: the canvas
 * scene's features and its sim follow the stage.
 */
async function stage(entry: Entry): Promise<void> {
  if (entry.doc === undefined) return;
  let shown = false;
  engineStage.show(entry.doc, () => {
    shown = true;
  });
  await until(() => shown, "loading its kinds' code");
}

/** `entry` at its defaults (a document's World over them), one cell per device pixel. */
function settingsFor(entry: Entry): RenderSettings {
  const state = defaultsFor(entry.scene);
  return renderSettings(
    {
      ...state,
      pixel: 1 / devicePixelRatio,
      transitions: "off",
      mouse: "still",
      motion: still ? 0 : state.motion,
      view: source ? "source" : state.view,
    },
    paramsOf(entry),
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
    timerQuery: bench.timer,
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
  const entryOf = (name: string): readonly Entry[] =>
    name === `${CANVAS}:*`
      ? docEntries
      : [
          ...docEntries.filter((entry) => entry.name === name),
          ...sceneIds.filter((scene) => scene === name).map((scene) => ({ name, scene })),
        ];
  const unknown = asked.filter((name) => entryOf(name).length === 0);
  if (unknown.length > 0)
    throw new BenchError(
      `unknown scenes: ${unknown.join(", ")} (documents: ${docEntries.map((entry) => entry.name).join(", ")}, ${CANVAS}:*)`,
    );
  const entries: Entry[] =
    asked.length === 0 ? sceneIds.map((scene) => ({ name: scene, scene })) : asked.flatMap(entryOf);
  const [width = 0, height = 0] = cellsInput.value.split("x").map(Number);
  if (!(width >= 1 && height >= 1)) throw new BenchError("cells takes WxH, as 960x540");
  const frames = Math.max(10, Math.round(Number(framesInput.value)) || 120);
  const first = entries[0];
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
      sync: synced,
      hold,
      cellBudget: budgeted ? CELL_BUDGET : null,
    },
    scenes: results,
  };
  const show = (): void => {
    reportBox.value = JSON.stringify(report, null, 2);
  };
  show();
  for (const [index, entry] of entries.entries()) {
    status.textContent = `${index + 1}/${entries.length}: ${entry.name}`;
    let result: SceneReport;
    try {
      await stage(entry);
      const built = await bench.build(entry);
      const key = featureKey(featuresOf(entry, await loadScene(entry.scene)));
      const kept = await bench.sample(entry, frames, key);
      const gpuMs = spread(kept.timed.map((draw) => draw.ms));
      // The draws' mean time a row: over whole passes, a whole picture's time a row.
      const timedRows = kept.timed.reduce((sum, draw) => sum + draw.rows, 0);
      const rate =
        timedRows === 0
          ? undefined
          : kept.timed.reduce((sum, draw) => sum + draw.ms, 0) / timedRows;
      const pictureMs =
        rate === undefined ? null : Math.round(rate * (kept.timed[0]?.height ?? 0) * 10) / 10;
      const intervalMs = spread(kept.frames.map((frame) => frame.intervalMs));
      const cpuMs = spread(kept.frames.map((frame) => frame.cpuMs));
      const median = pictureMs ?? (synced ? cpuMs : intervalMs)?.median;
      result = {
        scene: entry.name,
        cells: `${canvas.width}x${canvas.height}`,
        ...built,
        frames: kept.frames.length,
        gpuMs,
        strips: bench.renderer.strips,
        pictureMs,
        intervalMs,
        cpuMs,
        msPerMegacell:
          median === undefined
            ? null
            : Math.round((median / (canvas.width * canvas.height)) * 1e9) / 1000,
      };
    } catch (error: unknown) {
      result = {
        scene: entry.name,
        cells: `${canvas.width}x${canvas.height}`,
        compileMs: null,
        linkMs: null,
        uniformVectors: null,
        samplers: null,
        frames: 0,
        gpuMs: null,
        strips: null,
        pictureMs: null,
        intervalMs: null,
        cpuMs: null,
        msPerMegacell: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    const frameMs = result.gpuMs ?? (synced ? result.cpuMs : result.intervalMs);
    const row = document.createElement("tr");
    row.append(
      cell(entry.name),
      cell(result.compileMs),
      cell(result.linkMs),
      cell(result.uniformVectors),
      cell(frameMs?.median),
      cell(frameMs?.p95),
      cell(result.error ?? (result.gpuMs === null ? (synced ? "read back" : "rAF") : "GPU timer")),
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
