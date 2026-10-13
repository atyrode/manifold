import { artworks, floodBackdrop, flowField, raster, type Artwork, type Raster } from "./artwork.ts";
import { constellationUniforms } from "./constellations.ts";
import { MAX_PARAMS, MAX_TRIGGERS } from "./params.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import type { PointerState, SceneSim } from "./scenes/types.ts";
import { fragmentSourceFor, vertexSource } from "./shaders/index.ts";
import type { Params } from "./state.ts";

export const ditherIds = ["bayer8", "bayer4", "ign", "none"] as const;
export type DitherId = (typeof ditherIds)[number];
export const colorIds = ["accent", "mono", "full"] as const;
export type ColorId = (typeof colorIds)[number];
/** Order is the shader's `uView` index. */
export const viewIds = ["dithered", "source", "split"] as const;
export type ViewId = (typeof viewIds)[number];

export interface RenderSettings {
  scene: SceneId;
  dither: DitherId;
  color: ColorId;
  /** CSS pixels per dither cell. */
  pixel: number;
  levels: number;
  motion: number;
  bg: string;
  ink: string;
  accent: string;
  /** The current scene's knobs as the shader reads them, in the scene's `params` order. */
  params: readonly number[];
  /** The current scene's raw knobs, keyed as in the URL, for its simulation. */
  knobs: Params;
  followPointer: boolean;
  view: ViewId;
}

/** Must match `MAX_STARS` in the fragment shader. */
const MAX_STARS = 16;
/** Texture units: 0..2 the artwork (image, backdrop, flow), then `uSim0..uSim3`. */
const SIM_UNIT = 3;
const SIM_SLOTS = 4;
/** Scene-clock time of a trigger or press that has not happened. */
const NEVER = -1e4;
/** Presses on these belong to the lab or the page's own controls, not to the scene. */
const CONTROLS = "#lab, #lab-open, a, button, input, select, textarea, label, [role=switch]";

const uniformNames = [
  "uRes", "uTime", "uMotionTime", "uDither", "uColor", "uLevels", "uMotion", "uPointer", "uMouse",
  "uBg", "uInk", "uAccent", "uImage", "uBackdrop", "uFlow", "uImageSize", "uFocus", "uReveal",
  "uStars", "uStarCount", "uParams", "uView",
  "uConStars", "uConBright", "uConLines", "uConStarCount", "uConLineCount", "uConMarkStar", "uConMarkLine",
  "uProgress", "uTriggers", "uSim0", "uSim1", "uSim2", "uSim3", "uSimOn", "uWeather",
] as const;
type UniformName = (typeof uniformNames)[number];

/** One scene's linked program and where its uniforms live. */
interface SceneProgram {
  program: WebGLProgram;
  uniforms: Record<UniformName, WebGLUniformLocation | null>;
}

/**
 * The scene being drawn: its program (undefined when it failed to build), its simulation, and where
 * its `rain` and `snow` knobs sit in `params` (-1 when it has none, which reads as 0).
 */
interface ActiveScene {
  id: SceneId;
  program: SceneProgram | undefined;
  sim: SceneSim | undefined;
  rain: number;
  snow: number;
}

interface LoadedArt {
  texture: WebGLTexture;
  backdrop: WebGLTexture | undefined;
  flow: WebGLTexture;
  size: [number, number];
  loadedAt: number;
}

export class RendererError extends Error {}

/**
 * The info log with the offending source line under each `ERROR: 0:<line>:`, since the scene's
 * fragment source is generated and otherwise never seen.
 */
function annotate(log: string, source: string): string {
  const lines = source.split("\n");
  return log.split("\n").map((entry) => {
    const line = /^ERROR: \d+:(\d+):/.exec(entry)?.[1];
    return line === undefined ? entry : `${entry}\n    > ${(lines[Number(line) - 1] ?? "").trim()}`;
  }).join("\n");
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, what: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new RendererError(`${what}: could not allocate shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new RendererError(`${what}: shader compile failed\n${annotate(log, source)}`);
  }
  return shader;
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Pulsing vortices as shader uniforms: image uv with y up, radius in image heights. */
function starUniform(art: Artwork | undefined): { data: Float32Array; count: number } {
  const stars = (art?.vortices ?? []).filter((v) => v.pulse).slice(0, MAX_STARS);
  const data = new Float32Array(MAX_STARS * 4);
  stars.forEach((star, i) => data.set([star.x, 1 - star.y, star.r, star.spin], i * 4));
  return { data, count: stars.length };
}

const noStars = starUniform(undefined);
const starsByScene: Readonly<Record<string, { data: Float32Array; count: number }>> = Object.fromEntries(
  Object.entries(artworks).map(([scene, art]) => [scene, starUniform(art)]),
);

export class DitherRenderer {
  readonly #gl: WebGL2RenderingContext;
  readonly #canvas: HTMLCanvasElement;
  /** Shared by every scene's program. */
  readonly #vertex: WebGLShader;
  /** Each scene's program, built on first use; undefined once it has failed (logged). */
  readonly #programs = new Map<SceneId, SceneProgram | undefined>();
  #scene: ActiveScene | undefined;
  readonly #textures = new Map<string, LoadedArt>();
  readonly #blank: WebGLTexture;
  /** Smoothed parallax (-1..1 over the window), eased toward the target `tx`, `ty`. */
  readonly #pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  /** The raw pointer for `uMouse` and simulations; mapped to stage uv once per frame. */
  readonly #mouse = {
    clientX: window.innerWidth / 2,
    clientY: window.innerHeight / 2,
    inside: false,
    down: false,
    /** Edges since the previous frame. */
    pressed: false,
    released: false,
    /** Scene-clock time of the last press that started over the page. */
    pressedAt: NEVER,
  };
  #settings: RenderSettings;
  /** Scene clock in seconds; stands still while paused. Never reset: scenes share it. */
  #clock = 0;
  /**
   * Motion clock (`uMotionTime`, `SimFrame.motionTime`): each scene-clock step times the motion
   * amount, summed on the same origin as `#clock`, so it equals `#clock * motion` while motion holds
   * still and moving the slider changes the pace without jumping the phase.
   */
  #motionClock = 0;
  #lastFrame = 0;
  #paused = false;
  /** Smoothed frames per second, for the lab footer. */
  fps = 0;
  #frozen: boolean;
  readonly #params = new Float32Array(MAX_PARAMS);
  /** Shader time each trigger slot last fired; far in the past when idle. */
  readonly #triggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** Each slot's stamp as the current scene's sim last saw it, to find the next frame's presses. */
  readonly #seenTriggers: number[] = Array.from({ length: MAX_TRIGGERS }, () => NEVER);
  /** `SimFrame.fired`, rewritten in place each frame. */
  readonly #fired: boolean[] = Array.from({ length: MAX_TRIGGERS }, () => false);
  /** The scene the triggers and the last press belong to: both reset when it changes. */
  #triggerScene = "";
  /** Loading-page progress 0..1, or -1 off the loading page. */
  #progress = -1;
  /** `uWeather`: how wet the world is and how much snow lies, 0..1 each, on the scene clock. */
  readonly #weather = { wet: 0, lying: 0 };
  /** WebGL version and renderer, for diagnosing remote reports. */
  glInfo = "";

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings, frozen: boolean) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new RendererError("WebGL2 unavailable");
    this.#gl = gl;
    this.#canvas = canvas;
    this.#settings = settings;
    this.#frozen = frozen;
    this.#params.set(settings.params.slice(0, MAX_PARAMS));

    this.#vertex = compile(gl, gl.VERTEX_SHADER, vertexSource, "vertex");
    gl.bindVertexArray(gl.createVertexArray());
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu: unknown = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.glInfo = `${String(gl.getParameter(gl.VERSION))} · ${String(gpu)}`;

    this.#blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    const mouse = this.#mouse;
    const track = (event: PointerEvent) => {
      mouse.clientX = event.clientX;
      mouse.clientY = event.clientY;
      mouse.inside = !(event.target instanceof Element) || event.target.closest(CONTROLS) === null;
    };
    const lift = () => {
      if (!mouse.down) return;
      mouse.down = false;
      mouse.released = true;
    };
    window.addEventListener("pointermove", (event) => {
      this.#pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.#pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
      track(event);
    });
    window.addEventListener("pointerdown", (event) => {
      track(event);
      // Only presses that start over the page count: the lab and page controls keep theirs.
      if (!event.isPrimary || event.button !== 0 || !mouse.inside) return;
      mouse.down = true;
      mouse.pressed = true;
      mouse.pressedAt = this.#clock;
    });
    window.addEventListener("pointerup", (event) => {
      if (event.isPrimary && event.button === 0) lift();
    });
    window.addEventListener("pointercancel", (event) => {
      if (event.isPrimary) lift();
    });
    // Leaving the window (no related target) leaves the page too.
    window.addEventListener("pointerout", (event) => {
      if (event.relatedTarget === null) mouse.inside = false;
    });
    for (const art of Object.values(artworks)) this.#load(art);
  }

  /** Fire one occurrence of the current scene's occasional effect in `slot` right now. */
  trigger(slot: number): void {
    if (slot >= 0 && slot < MAX_TRIGGERS) this.#triggers[slot] = this.#clock;
  }

  get paused(): boolean {
    return this.#paused;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  setProgress(progress: number): void {
    this.#progress = progress;
  }

  update(settings: RenderSettings): void {
    this.#settings = settings;
    if (settings.scene !== this.#triggerScene) {
      this.#triggerScene = settings.scene;
      this.#triggers.fill(NEVER);
      this.#mouse.pressedAt = NEVER;
    }
    this.#params.fill(0);
    this.#params.set(settings.params.slice(0, MAX_PARAMS));
  }

  start(): void {
    const tick = (now: number) => {
      this.#draw(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #upload(source: TexImageSource | Raster): WebGLTexture {
    const gl = this.#gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (!("data" in source)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else if (source.data instanceof Float32Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, source.width, source.height, 0, gl.RG, gl.FLOAT, source.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, source.width, source.height, 0, gl.RED, gl.UNSIGNED_BYTE, source.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  #load(art: Artwork): void {
    const image = new Image();
    image.decoding = "async";
    image.src = art.url;
    image.decode().then(() => {
      const started = performance.now();
      const px = raster(image, 480);
      const backdrop = art.backdrop ? floodBackdrop(px, art.clear) : undefined;
      const flow = flowField(px, art, backdrop);
      console.info(`evt=landing.artwork.analysed url=${art.url} ms=${Math.round(performance.now() - started)}`);
      this.#textures.set(art.url, {
        texture: this.#upload(image),
        backdrop: backdrop ? this.#upload(backdrop) : undefined,
        flow: this.#upload(flow),
        size: [image.naturalWidth, image.naturalHeight],
        loadedAt: performance.now(),
      });
    }, (error: unknown) => {
      console.error("evt=landing.artwork.load_failed", art.url, error);
    });
  }

  /** Compile and link a scene's program; throws RendererError (with the info log) on failure. */
  #link(id: SceneId): SceneProgram {
    const gl = this.#gl;
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSourceFor(sceneDefs[id]), `scene ${id}`);
    const program = gl.createProgram();
    gl.attachShader(program, this.#vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // Only flagged while attached: freed together with the program.
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "";
      gl.deleteProgram(program);
      throw new RendererError(`scene ${id}: program link failed\n${log}`);
    }
    gl.useProgram(program);
    const uniforms = Object.fromEntries(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>;
    // Constant for the program's lifetime: the constellation figures (only orbit reads them; the
    // other programs drop the uniforms) and the texture unit of every sampler.
    const figures = constellationUniforms;
    gl.uniform4fv(uniforms.uConStars, figures.stars);
    gl.uniform1fv(uniforms.uConBright, figures.brightness);
    gl.uniform2fv(uniforms.uConLines, figures.lines);
    gl.uniform1i(uniforms.uConStarCount, figures.starCount);
    gl.uniform1i(uniforms.uConLineCount, figures.lineCount);
    gl.uniform1i(uniforms.uConMarkStar, figures.markStar);
    gl.uniform1i(uniforms.uConMarkLine, figures.markLine);
    gl.uniform1i(uniforms.uImage, 0);
    gl.uniform1i(uniforms.uBackdrop, 1);
    gl.uniform1i(uniforms.uFlow, 2);
    [uniforms.uSim0, uniforms.uSim1, uniforms.uSim2, uniforms.uSim3].forEach((location, slot) => gl.uniform1i(location, SIM_UNIT + slot));
    return { program, uniforms };
  }

  /** Leave the current scene (disposing its simulation) and enter `id`, building its program once. */
  #enter(id: SceneId): ActiveScene {
    this.#scene?.sim?.dispose();
    if (!this.#programs.has(id)) {
      let built: SceneProgram | undefined;
      try {
        built = this.#link(id);
      } catch (error: unknown) {
        console.error(`evt=landing.renderer.scene_failed scene=${id}`, error);
      }
      this.#programs.set(id, built);
    }
    const program = this.#programs.get(id);
    const params = sceneDefs[id].params;
    this.#scene = {
      id,
      program,
      sim: program ? sceneDefs[id].sim?.(this.#gl) : undefined,
      rain: params.findIndex((def) => def.key === "rain"),
      snow: params.findIndex((def) => def.key === "snow"),
    };
    return this.#scene;
  }

  /** The pointer in stage uv for this frame; consumes the press and release edges. */
  #pointerState(): PointerState {
    const mouse = this.#mouse;
    const rect = this.#canvas.getBoundingClientRect();
    const state: PointerState = {
      x: (mouse.clientX - rect.left) / Math.max(rect.width, 1),
      y: 1 - (mouse.clientY - rect.top) / Math.max(rect.height, 1),
      inside: mouse.inside,
      down: mouse.down,
      pressed: mouse.pressed,
      released: mouse.released,
    };
    mouse.pressed = false;
    mouse.released = false;
    return state;
  }

  #draw(now: number): void {
    const gl = this.#gl;
    const dt = this.#lastFrame === 0 ? 0 : Math.min((now - this.#lastFrame) / 1000, 0.1);
    this.#lastFrame = now;
    if (dt > 0) this.fps = this.fps === 0 ? 1 / dt : this.fps * 0.92 + (1 / dt) * 0.08;
    const step = this.#paused || this.#frozen ? 0 : dt;
    const s = this.#settings;
    const motion = this.#frozen ? 0 : s.motion;
    this.#clock += step;
    this.#motionClock += step * motion;
    const width = Math.max(1, Math.ceil(this.#canvas.clientWidth / s.pixel));
    const height = Math.max(1, Math.ceil(this.#canvas.clientHeight / s.pixel));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }

    const p = this.#pointer;
    const tx = s.followPointer ? p.tx : 0;
    const ty = s.followPointer ? p.ty : 0;
    p.x += (tx - p.x) * 0.04;
    p.y += (ty - p.y) * 0.04;
    const pointer = this.#pointerState();

    const current = this.#scene;
    const scene = current && current.id === s.scene ? current : this.#enter(s.scene);
    const entered = scene !== current;
    const program = scene.program;
    if (!program) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(...rgb(s.bg), 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    // The world follows the scene's own rain and snow on the scene clock: where they lead (soaked in
    // steady rain, damp in drizzle; snow lying deeper the harder it snows, less in rain), approached
    // exponentially. Wetting takes 1.2 / rain s per e-fold (~9 s to soak in steady rain), drying 25 s
    // (~75 s); settling 3 / snow s (~18 s in steady snow), melting 30 s (~90 s), faster in rain.
    // A scene just entered, or a frozen frame, starts where its weather leads.
    const weather = this.#weather;
    const rain = s.params[scene.rain] ?? 0;
    const snow = s.params[scene.snow] ?? 0;
    const wetTo = rain > 0 ? Math.min(1, 0.4 + 1.1 * rain) : 0;
    const lyingTo = snow > 0 ? Math.min(1, 0.25 + snow) * (1 - 0.5 * rain) : 0;
    if (entered || this.#frozen) {
      weather.wet = wetTo;
      weather.lying = lyingTo;
    } else {
      weather.wet = wetTo + (weather.wet - wetTo) * Math.exp(-step / (weather.wet < wetTo ? 1.2 / rain : 25));
      weather.lying = lyingTo + (weather.lying - lyingTo) * Math.exp(-step / (weather.lying < lyingTo ? 3 / snow : 30 / (1 + 4 * rain)));
    }
    // A slot fired when its stamp moved to a real press since the sim's previous frame. A scene just
    // entered has a fresh sim with nothing to compare against: its first frame reports no presses
    // (stamps were reset to idle when the scene changed, so an earlier visit's never replay).
    for (let slot = 0; slot < MAX_TRIGGERS; slot++) {
      const stamp = this.#triggers[slot] ?? NEVER;
      this.#fired[slot] = !entered && stamp > NEVER && stamp !== this.#seenTriggers[slot];
      this.#seenTriggers[slot] = stamp;
    }
    // Simulations upload (and so bind) their textures: step them before binding this frame's units.
    const simTextures = scene.sim?.frame({
      dt: step,
      time: this.#clock,
      motionTime: this.#motionClock,
      motion,
      width,
      height,
      aspect: width / height,
      values: s.params,
      params: s.knobs,
      triggers: this.#triggers,
      fired: this.#fired,
      pointer,
    }) ?? [];

    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    const art = artworks[s.scene];
    const loaded = art ? this.#textures.get(art.url) : undefined;
    const textures = [loaded?.texture, loaded?.backdrop, loaded?.flow];
    textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture ?? this.#blank);
    });
    for (let slot = 0; slot < SIM_SLOTS; slot++) {
      gl.activeTexture(gl.TEXTURE0 + SIM_UNIT + slot);
      gl.bindTexture(gl.TEXTURE_2D, simTextures[slot] ?? this.#blank);
    }
    const stars = starsByScene[s.scene] ?? noStars;

    const u = program.uniforms;
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uTime, this.#clock);
    gl.uniform1f(u.uMotionTime, this.#motionClock);
    gl.uniform1i(u.uDither, ditherIds.indexOf(s.dither));
    gl.uniform1i(u.uColor, colorIds.indexOf(s.color));
    gl.uniform1f(u.uLevels, s.levels);
    gl.uniform1f(u.uMotion, motion);
    gl.uniform2f(u.uPointer, p.x, p.y);
    gl.uniform4f(u.uMouse, pointer.x, pointer.y, pointer.down ? 1 : 0, this.#mouse.pressedAt);
    gl.uniform3f(u.uBg, ...rgb(s.bg));
    gl.uniform3f(u.uInk, ...rgb(s.ink));
    gl.uniform3f(u.uAccent, ...rgb(s.accent));
    gl.uniform2f(u.uImageSize, loaded?.size[0] ?? 1, loaded?.size[1] ?? 1);
    gl.uniform2f(u.uFocus, art?.focus[0] ?? 0.5, art?.focus[1] ?? 0.5);
    gl.uniform1f(u.uReveal, !art ? 1 : loaded ? Math.min(1, (now - loaded.loadedAt) / 1400) : 0);
    gl.uniform4fv(u.uStars, stars.data);
    gl.uniform1i(u.uStarCount, stars.count);
    gl.uniform1fv(u.uParams, this.#params);
    gl.uniform1i(u.uView, viewIds.indexOf(s.view));
    gl.uniform1f(u.uProgress, this.#progress);
    gl.uniform1fv(u.uTriggers, this.#triggers);
    gl.uniform4f(u.uSimOn, simTextures[0] ? 1 : 0, simTextures[1] ? 1 : 0, simTextures[2] ? 1 : 0, simTextures[3] ? 1 : 0);
    gl.uniform2f(u.uWeather, weather.wet, weather.lying);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
