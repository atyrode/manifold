// A GL texture fed from typed arrays or a canvas, for scene simulations (see scenes/types.ts).
// Rows run bottom to top: row 0 is uv.y = 0, the way the shader samples it.

export type DataFormat = "r8" | "rg8" | "rgba8" | "r16f" | "rg16f" | "rgba16f";

export interface DataTextureOptions {
  width: number;
  height: number;
  format: DataFormat;
  /** Default "linear". 16-bit float formats filter linearly in WebGL2; 32-bit would not. */
  filter?: "linear" | "nearest";
  /** Default "clamp". */
  wrap?: "clamp" | "repeat";
}

interface FormatInfo {
  internal: number;
  format: number;
  type: number;
  channels: number;
  float: boolean;
}

function formatInfo(gl: WebGL2RenderingContext, format: DataFormat): FormatInfo {
  switch (format) {
    case "r8":
      return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, channels: 1, float: false };
    case "rg8":
      return { internal: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE, channels: 2, float: false };
    case "rgba8":
      return {
        internal: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        channels: 4,
        float: false,
      };
    case "r16f":
      return { internal: gl.R16F, format: gl.RED, type: gl.FLOAT, channels: 1, float: true };
    case "rg16f":
      return { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, channels: 2, float: true };
    case "rgba16f":
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT, channels: 4, float: true };
    default: {
      const unreachable: never = format;
      throw new Error(`landing: unknown texture format ${String(unreachable)}`);
    }
  }
}

export class DataTextureError extends Error {}

export class DataTexture {
  readonly texture: WebGLTexture;
  readonly #gl: WebGL2RenderingContext;
  readonly #info: FormatInfo;
  #width: number;
  #height: number;

  constructor(gl: WebGL2RenderingContext, options: DataTextureOptions) {
    this.#gl = gl;
    this.#info = formatInfo(gl, options.format);
    this.#width = options.width;
    this.#height = options.height;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const filter = options.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    const wrap = options.wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.#allocate();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** Change the size (contents become undefined until the next upload). */
  resize(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#allocate();
  }

  /** Upload the whole image: Uint8Array for 8-bit formats, Float32Array for float formats. */
  upload(data: Uint8Array | Float32Array): void {
    const info = this.#info;
    const expected = this.#width * this.#height * info.channels;
    if (data.length !== expected)
      throw new DataTextureError(`texture data has ${data.length} values, expected ${expected}`);
    if (info.float !== data instanceof Float32Array)
      throw new DataTextureError("texture data type does not match its format");
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.#width,
      this.#height,
      info.format,
      info.type,
      data,
    );
  }

  /**
   * Upload a canvas (or image) as RGBA8, resizing to it. The canvas's top row lands at uv.y = 1,
   * so a scene can draw with ordinary canvas coordinates.
   */
  uploadImage(source: TexImageSource & { width: number; height: number }): void {
    if (this.#info.internal !== this.#gl.RGBA8)
      throw new DataTextureError("uploadImage needs an rgba8 texture");
    const gl = this.#gl;
    this.#width = source.width;
    this.#height = source.height;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  dispose(): void {
    this.#gl.deleteTexture(this.texture);
  }

  #allocate(): void {
    const gl = this.#gl;
    const info = this.#info;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      info.internal,
      this.#width,
      this.#height,
      0,
      info.format,
      info.type,
      null,
    );
  }
}
