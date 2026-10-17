// A GL texture fed from typed arrays or a canvas, for scene simulations (see scenes/types.ts).
// Rows run bottom to top: row 0 is uv.y = 0, the way the shader samples it. 8-bit formats take a
// Uint8Array. 16-bit float formats take float32 values (a Float32Array, sent as FLOAT for the
// driver to round) or the half floats' own bits (a Uint16Array, `halfBits` in half.ts, sent as
// HALF_FLOAT: half the bytes, and nothing left for the driver to convert).
//
// DirtyRegion keeps what changed of a texture's image since its last upload, as a rectangle per
// tile of a grid (by default one tile, the whole image), and sends only that, by uploadRegion:
//   new DirtyRegion(width, height, tileWidth?, tileHeight?)   everything changed, as at first
//   resize(width, height)    a new size: everything changed
//   all()                    everything changed (the image rewritten)
//   mark(x, y)               texel (x, y) changed
//   touch(x0, y0, x1, y1)    texels x0 ≤ x < x1, y0 ≤ y < y1 changed (an empty rectangle: none)
//   flush(texture, data)     upload what changed of `data` (the whole image, as `upload` takes
//                            it) and forget it: everything by `upload`; else, along each row of
//                            tiles, each run of changed tiles as one rectangle over their changes
// One tile suits changes that cluster (a pen's strokes); bands of rows (tileHeight 16) or small
// squares suit changes scattered over the image (grains, specks).
// Usage (a sheet a pen inks a few texels a frame):
//   readonly #ink = new Uint8Array(SIZE * SIZE * 2);
//   readonly #dirty = new DirtyRegion(SIZE, SIZE);
//   stroke(...) { ...ink texels...; this.#dirty.touch(minX, minY, maxX + 1, maxY + 1); }
//   frame() { ...; this.#dirty.flush(this.#texture, this.#ink); }

export type DataFormat = "r8" | "rg8" | "rgba8" | "r16f" | "rg16f" | "rgba16f";

/** A texture's whole image: Uint8Array for 8-bit formats, Float32Array or half bits for 16f. */
export type TextureData = Uint8Array | Float32Array | Uint16Array;

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

  /** Upload the whole image (TextureData: Uint8Array for 8-bit formats, float32 or half bits). */
  upload(data: TextureData): void {
    this.#check(data);
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
      this.#info.format,
      data instanceof Uint16Array ? gl.HALF_FLOAT : this.#info.type,
      data,
    );
  }

  /**
   * Upload the rectangle x, y, width, height (texels, rows bottom to top) of the whole image `data`
   * (as `upload` takes it); the rest of the texture keeps what it holds. Nothing is copied: the
   * rows are read in place (UNPACK_ROW_LENGTH). An empty rectangle uploads nothing.
   */
  uploadRegion(data: TextureData, x: number, y: number, width: number, height: number): void {
    this.#check(data);
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0 ||
      x + width > this.#width ||
      y + height > this.#height
    )
      throw new DataTextureError(
        `region ${x}, ${y}, ${width} x ${height} is not inside the ${this.#width} x ${this.#height} texture`,
      );
    if (width === 0 || height === 0) return;
    const gl = this.#gl;
    const info = this.#info;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.#width);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      width,
      height,
      info.format,
      data instanceof Uint16Array ? gl.HALF_FLOAT : info.type,
      data,
      (y * this.#width + x) * info.channels,
    );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
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

  /** Throws unless `data` is a whole image of this texture's size and format. */
  #check(data: TextureData): void {
    const info = this.#info;
    const expected = this.#width * this.#height * info.channels;
    if (data.length !== expected)
      throw new DataTextureError(`texture data has ${data.length} values, expected ${expected}`);
    if (info.float === data instanceof Uint8Array)
      throw new DataTextureError("texture data type does not match its format");
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

/** What changed of a texture's image since its last upload, by tiles (see the header). */
export class DirtyRegion {
  /** The tiles asked for, texels (Infinity: the image's own width or height). */
  readonly #askWidth: number;
  readonly #askHeight: number;
  /** The tiles in effect at the image's size, and how many run across (rows of them upward). */
  #tileWidth = 1;
  #tileHeight = 1;
  #across = 1;
  /** Per tile, its changed texels: columns x0..x1 by rows y0..y1, ends excluded (none if x1 ≤ x0). */
  #x0 = new Int32Array(1);
  #y0 = new Int32Array(1);
  #x1 = new Int32Array(1);
  #y1 = new Int32Array(1);
  /** Everything changed: the texture holds nothing of the image yet, or the image was rewritten. */
  #whole = true;

  /** Tiles of tileWidth × tileHeight texels; by default, or past the image's size, the whole. */
  constructor(width: number, height: number, tileWidth = Infinity, tileHeight = Infinity) {
    if (!(tileWidth >= 1 && tileHeight >= 1))
      throw new DataTextureError(`tiles of ${tileWidth} x ${tileHeight} texels hold no texel`);
    this.#askWidth = tileWidth;
    this.#askHeight = tileHeight;
    this.resize(width, height);
  }

  /** A new size: the tiles start over, and everything has changed. */
  resize(width: number, height: number): void {
    this.#tileWidth = Math.min(this.#askWidth, Math.max(1, width));
    this.#tileHeight = Math.min(this.#askHeight, Math.max(1, height));
    this.#across = Math.ceil(Math.max(1, width) / this.#tileWidth);
    const tiles = this.#across * Math.ceil(Math.max(1, height) / this.#tileHeight);
    this.#x0 = new Int32Array(tiles);
    this.#y0 = new Int32Array(tiles);
    this.#x1 = new Int32Array(tiles);
    this.#y1 = new Int32Array(tiles);
    this.#whole = true;
  }

  /** Everything changed: the next flush sends the whole image. */
  all(): void {
    this.#whole = true;
  }

  /** Texel (x, y) changed. */
  mark(x: number, y: number): void {
    if (this.#whole) return;
    const tile = Math.floor(y / this.#tileHeight) * this.#across + Math.floor(x / this.#tileWidth);
    this.#grow(tile, x, y, x + 1, y + 1);
  }

  /** Texels x0 ≤ x < x1, y0 ≤ y < y1 changed; an empty rectangle changes none. */
  touch(x0: number, y0: number, x1: number, y1: number): void {
    if (this.#whole || x1 <= x0 || y1 <= y0) return;
    const tw = this.#tileWidth;
    const th = this.#tileHeight;
    const right = Math.floor((x1 - 1) / tw);
    const top = Math.floor((y1 - 1) / th);
    for (let ty = Math.floor(y0 / th); ty <= top; ty++) {
      const from = Math.max(y0, ty * th);
      const to = Math.min(y1, (ty + 1) * th);
      for (let tx = Math.floor(x0 / tw); tx <= right; tx++) {
        const tile = ty * this.#across + tx;
        this.#grow(tile, Math.max(x0, tx * tw), from, Math.min(x1, (tx + 1) * tw), to);
      }
    }
  }

  /**
   * Upload what changed of `data` (the whole image, as DataTexture.upload takes it) to `texture`,
   * the image's size, and forget it: everything with `upload`; else, along each row of tiles, each
   * run of changed tiles as one rectangle spanning their changed texels.
   */
  flush(texture: DataTexture, data: TextureData): void {
    const x0 = this.#x0;
    const y0 = this.#y0;
    const x1 = this.#x1;
    const y1 = this.#y1;
    if (this.#whole) {
      texture.upload(data);
      this.#whole = false;
      x0.fill(0);
      y0.fill(0);
      x1.fill(0);
      y1.fill(0);
      return;
    }
    const across = this.#across;
    for (let row = 0; row < x0.length; row += across) {
      for (let k = row, end = row + across; k < end; k++) {
        if ((x1[k] ?? 0) <= (x0[k] ?? 0)) continue;
        let left = Infinity;
        let bottom = Infinity;
        let right = -Infinity;
        let top = -Infinity;
        for (; k < end && (x1[k] ?? 0) > (x0[k] ?? 0); k++) {
          left = Math.min(left, x0[k] ?? 0);
          bottom = Math.min(bottom, y0[k] ?? 0);
          right = Math.max(right, x1[k] ?? 0);
          top = Math.max(top, y1[k] ?? 0);
          x0[k] = 0;
          x1[k] = 0;
        }
        texture.uploadRegion(data, left, bottom, right - left, top - bottom);
      }
    }
  }

  /** Widen `tile`'s changed rectangle over x0..x1 by y0..y1 (ends excluded). */
  #grow(tile: number, x0: number, y0: number, x1: number, y1: number): void {
    if ((this.#x1[tile] ?? 0) <= (this.#x0[tile] ?? 0)) {
      this.#x0[tile] = x0;
      this.#y0[tile] = y0;
      this.#x1[tile] = x1;
      this.#y1[tile] = y1;
      return;
    }
    if (x0 < (this.#x0[tile] ?? 0)) this.#x0[tile] = x0;
    if (y0 < (this.#y0[tile] ?? 0)) this.#y0[tile] = y0;
    if (x1 > (this.#x1[tile] ?? 0)) this.#x1[tile] = x1;
    if (y1 > (this.#y1[tile] ?? 0)) this.#y1[tile] = y1;
  }
}
