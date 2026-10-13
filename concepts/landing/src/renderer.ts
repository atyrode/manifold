import { artworks, floodBackdrop, flowField, raster, type Artwork, type Raster } from "./artwork.ts";
import { constellationUniforms } from "./constellations.ts";
import { MAX_PARAMS, MAX_TRIGGERS } from "./params.ts";
import { fragmentSource, vertexSource } from "./shaders.ts";

/** Order is the shader's `uScene` index. */
export const sceneIds = ["wave", "starry", "orbit", "swell", "pond"] as const;
export type SceneId = (typeof sceneIds)[number];
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
  /** The current scene's knobs, in `sceneParams` order. */
  params: readonly number[];
  followPointer: boolean;
  view: ViewId;
}

/** Must match `MAX_STARS` in the fragment shader. */
const MAX_STARS = 16;

const uniformNames = [
  "uRes", "uTime", "uScene", "uDither", "uColor", "uLevels", "uMotion", "uPointer",
  "uBg", "uInk", "uAccent", "uImage", "uBackdrop", "uFlow", "uImageSize", "uFocus", "uReveal",
  "uStars", "uStarCount", "uParams", "uView",
  "uConStars", "uConBright", "uConLines", "uConStarCount", "uConLineCount", "uConMarkStar", "uConMarkLine",
  "uProgress", "uTriggers",
] as const;
type UniformName = (typeof uniformNames)[number];

interface LoadedArt {
  texture: WebGLTexture;
  backdrop: WebGLTexture | undefined;
  flow: WebGLTexture;
  size: [number, number];
  loadedAt: number;
}

export class RendererError extends Error {}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new RendererError("could not allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new RendererError(gl.getShaderInfoLog(shader) ?? "shader compile failed");
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
  readonly #uniforms: Record<UniformName, WebGLUniformLocation | null>;
  readonly #textures = new Map<string, LoadedArt>();
  readonly #blank: WebGLTexture;
  readonly #pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  #settings: RenderSettings;
  #start = performance.now();
  #frozen: boolean;
  readonly #params = new Float32Array(MAX_PARAMS);
  /** Shader time each trigger slot last fired; far in the past when idle. */
  readonly #triggers = new Float32Array(MAX_TRIGGERS).fill(-1e4);
  #triggerScene = "";
  /** Loading-page progress 0..1, or -1 off the loading page. */
  #progress = -1;
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

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new RendererError(gl.getProgramInfoLog(program) ?? "program link failed");
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());

    this.#uniforms = Object.fromEntries(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<UniformName, WebGLUniformLocation | null>;

    const u = this.#uniforms;
    const figures = constellationUniforms;
    gl.uniform4fv(u.uConStars, figures.stars);
    gl.uniform1fv(u.uConBright, figures.brightness);
    gl.uniform2fv(u.uConLines, figures.lines);
    gl.uniform1i(u.uConStarCount, figures.starCount);
    gl.uniform1i(u.uConLineCount, figures.lineCount);
    gl.uniform1i(u.uConMarkStar, figures.markStar);
    gl.uniform1i(u.uConMarkLine, figures.markLine);
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu: unknown = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.glInfo = `${String(gl.getParameter(gl.VERSION))} · ${String(gpu)}`;

    this.#blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    window.addEventListener("pointermove", (event) => {
      this.#pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.#pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
    });
    for (const art of Object.values(artworks)) this.#load(art);
  }

  /** Fire one occurrence of the current scene's occasional effect in `slot` right now. */
  trigger(slot: number): void {
    if (slot >= 0 && slot < MAX_TRIGGERS) this.#triggers[slot] = (performance.now() - this.#start) / 1000;
  }

  setProgress(progress: number): void {
    this.#progress = progress;
  }

  update(settings: RenderSettings): void {
    this.#settings = settings;
    if (settings.scene !== this.#triggerScene) {
      this.#triggerScene = settings.scene;
      this.#triggers.fill(-1e4);
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

  #draw(now: number): void {
    const gl = this.#gl;
    const s = this.#settings;
    const width = Math.max(1, Math.ceil(this.#canvas.clientWidth / s.pixel));
    const height = Math.max(1, Math.ceil(this.#canvas.clientHeight / s.pixel));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    const p = this.#pointer;
    const tx = s.followPointer ? p.tx : 0;
    const ty = s.followPointer ? p.ty : 0;
    p.x += (tx - p.x) * 0.04;
    p.y += (ty - p.y) * 0.04;

    const art = artworks[s.scene];
    const loaded = art ? this.#textures.get(art.url) : undefined;
    const textures = [loaded?.texture, loaded?.backdrop, loaded?.flow];
    textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture ?? this.#blank);
    });
    const stars = starsByScene[s.scene] ?? noStars;

    const u = this.#uniforms;
    gl.uniform2f(u.uRes, width, height);
    gl.uniform1f(u.uTime, this.#frozen ? 0 : (now - this.#start) / 1000);
    gl.uniform1i(u.uScene, sceneIds.indexOf(s.scene));
    gl.uniform1i(u.uDither, ditherIds.indexOf(s.dither));
    gl.uniform1i(u.uColor, colorIds.indexOf(s.color));
    gl.uniform1f(u.uLevels, s.levels);
    gl.uniform1f(u.uMotion, this.#frozen ? 0 : s.motion);
    gl.uniform2f(u.uPointer, p.x, p.y);
    gl.uniform3f(u.uBg, ...rgb(s.bg));
    gl.uniform3f(u.uInk, ...rgb(s.ink));
    gl.uniform3f(u.uAccent, ...rgb(s.accent));
    gl.uniform1i(u.uImage, 0);
    gl.uniform1i(u.uBackdrop, 1);
    gl.uniform1i(u.uFlow, 2);
    gl.uniform2f(u.uImageSize, loaded?.size[0] ?? 1, loaded?.size[1] ?? 1);
    gl.uniform2f(u.uFocus, art?.focus[0] ?? 0.5, art?.focus[1] ?? 0.5);
    gl.uniform1f(u.uReveal, !art ? 1 : loaded ? Math.min(1, (now - loaded.loadedAt) / 1400) : 0);
    gl.uniform4fv(u.uStars, stars.data);
    gl.uniform1i(u.uStarCount, stars.count);
    gl.uniform1fv(u.uParams, this.#params);
    gl.uniform1i(u.uView, viewIds.indexOf(s.view));
    gl.uniform1f(u.uProgress, this.#progress);
    gl.uniform1fv(u.uTriggers, this.#triggers);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
