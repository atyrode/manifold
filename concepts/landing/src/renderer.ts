import { fragmentSource, vertexSource } from "./shaders.ts";

export const sceneIds = ["wave", "starry", "orbit", "swell"] as const;
export type SceneId = (typeof sceneIds)[number];
export const ditherIds = ["bayer8", "bayer4", "ign", "none"] as const;
export type DitherId = (typeof ditherIds)[number];
export const colorIds = ["accent", "mono", "full"] as const;
export type ColorId = (typeof colorIds)[number];

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
}

interface Artwork {
  url: string;
  focus: readonly [number, number];
  /** Flood the unpainted paper from the top-right so the scene can drop it to black. */
  backdrop: boolean;
  /** Extra image-space rectangles [x0, y0, x1, y1] forced into the backdrop (title cartouche). */
  clear: readonly (readonly [number, number, number, number])[];
}

const artwork: Partial<Record<SceneId, Artwork>> = {
  wave: { url: "/art/great-wave.jpg", focus: [0.4, 0.52], backdrop: true, clear: [[0, 0.04, 0.1, 0.31]] },
  starry: { url: "/art/starry-night.jpg", focus: [0.5, 0.6], backdrop: false, clear: [] },
};

const uniformNames = [
  "uRes", "uTime", "uScene", "uDither", "uColor", "uLevels", "uMotion", "uPointer",
  "uBg", "uInk", "uAccent", "uImage", "uBackdrop", "uImageSize", "uFocus", "uReveal",
] as const;
type UniformName = (typeof uniformNames)[number];

interface LoadedArt {
  texture: WebGLTexture;
  backdrop: WebGLTexture | undefined;
  size: [number, number];
  loadedAt: number;
}

/**
 * Paper/sky mask: light, non-blue pixels reachable from the top-right edge without crossing a
 * (one-cell dilated) line or ink. Woodblock outlines are closed enough that foam stays separate
 * from the identically coloured paper.
 */
function floodBackdrop(image: HTMLImageElement, clear: Artwork["clear"]): { data: Uint8Array; width: number; height: number } {
  const width = 480;
  const height = Math.round((width * image.naturalHeight) / image.naturalWidth);
  const context = new OffscreenCanvas(width, height).getContext("2d");
  if (!context) throw new RendererError("2d canvas unavailable");
  context.drawImage(image, 0, 0, width, height);
  const px = context.getImageData(0, 0, width, height).data;
  const blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = px[i] ?? 0, g = px[i + 1] ?? 0, b = px[i + 2] ?? 0;
      if (0.299 * r + 0.587 * g + 0.114 * b >= 175 && b - r <= 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < width && Y < height) blocked[Y * width + X] = 1;
        }
      }
    }
  }
  const mask = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = Math.round(width * 0.45); x < width; x++) stack.push(x);
  for (let y = 0; y < height * 0.4; y++) stack.push(y * width + width - 1);
  while (stack.length > 0) {
    const i = stack.pop() ?? 0;
    if (mask[i] || blocked[i]) continue;
    mask[i] = 255;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
  // Paper flecks become islands after dilation; fold islands of at most 24 cells back into the sky.
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    const island: number[] = [];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop() ?? 0;
      island.push(i);
      const x = i % width;
      for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
        if (n >= 0 && n < mask.length && !mask[n] && !seen[n]) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
    if (island.length <= 24) for (const i of island) mask[i] = 255;
  }
  for (const [x0, y0, x1, y1] of clear) {
    for (let y = Math.round(y0 * height); y < Math.round(y1 * height); y++) {
      mask.fill(255, y * width + Math.round(x0 * width), y * width + Math.round(x1 * width));
    }
  }
  return { data: mask, width, height };
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

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings, frozen: boolean) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new RendererError("WebGL2 unavailable");
    this.#gl = gl;
    this.#canvas = canvas;
    this.#settings = settings;
    this.#frozen = frozen;

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

    this.#blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    window.addEventListener("pointermove", (event) => {
      this.#pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      this.#pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
    });
    for (const art of Object.values(artwork)) this.#load(art);
  }

  update(settings: RenderSettings): void {
    this.#settings = settings;
  }

  start(): void {
    const tick = (now: number) => {
      this.#draw(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #upload(source: TexImageSource | { data: Uint8Array; width: number; height: number }): WebGLTexture {
    const gl = this.#gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if ("data" in source) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, source.width, source.height, 0, gl.RED, gl.UNSIGNED_BYTE, source.data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
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
      this.#textures.set(art.url, {
        texture: this.#upload(image),
        backdrop: art.backdrop ? this.#upload(floodBackdrop(image, art.clear)) : undefined,
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
    const cssWidth = this.#canvas.clientWidth;
    const cssHeight = this.#canvas.clientHeight;
    const width = Math.max(1, Math.ceil(cssWidth / s.pixel));
    const height = Math.max(1, Math.ceil(cssHeight / s.pixel));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    const p = this.#pointer;
    p.x += (p.tx - p.x) * 0.04;
    p.y += (p.ty - p.y) * 0.04;

    const art = artwork[s.scene];
    const loaded = art ? this.#textures.get(art.url) : undefined;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, loaded?.texture ?? this.#blank);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, loaded?.backdrop ?? this.#blank);

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
    gl.uniform2f(u.uImageSize, loaded?.size[0] ?? 1, loaded?.size[1] ?? 1);
    gl.uniform2f(u.uFocus, art?.focus[0] ?? 0.5, art?.focus[1] ?? 0.5);
    gl.uniform1f(u.uReveal, loaded ? Math.min(1, (now - loaded.loadedAt) / 1400) : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
