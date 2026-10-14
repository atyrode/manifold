// A stand-in WebGL2 context for running a CPU simulation under `bun test`: it takes what
// DataTexture (texture.ts) asks of a context and keeps each texture's size and last upload, so a
// test can build a scene's real sim, step it with SimFrames and read back exactly what the shader
// would get. It draws nothing, and anything beyond DataTexture (GpuCompute, programs) throws.
//
//   const headless = new HeadlessGl();
//   const sim = sceneDefs.dew.sim?.(headless.gl);
//   const textures = sim.frame(frame);
//   const lists = headless.upload(textures[1]);   // { width, height, data } as last uploaded
//
// Rows run bottom to top, as DataTexture uploads them.

export class HeadlessGlError extends Error {}

/** A texture as its sim last uploaded it. */
export interface HeadlessUpload {
  width: number;
  height: number;
  data: Float32Array | Uint8Array;
}

class HeadlessTexture {
  width = 0;
  height = 0;
  data: Float32Array | Uint8Array | undefined;
}

export class HeadlessGl {
  readonly gl: WebGL2RenderingContext;
  #bound: HeadlessTexture | undefined;

  constructor() {
    const context = {
      TEXTURE_2D: 0x0de1,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      NEAREST: 0x2600,
      LINEAR: 0x2601,
      CLAMP_TO_EDGE: 0x812f,
      REPEAT: 0x2901,
      UNPACK_ALIGNMENT: 0x0cf5,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNSIGNED_BYTE: 0x1401,
      FLOAT: 0x1406,
      RED: 0x1903,
      RG: 0x8227,
      RGBA: 0x1908,
      R8: 0x8229,
      RG8: 0x822b,
      RGBA8: 0x8058,
      R16F: 0x822d,
      RG16F: 0x822f,
      RGBA16F: 0x881a,
      createTexture: (): HeadlessTexture => new HeadlessTexture(),
      bindTexture: (_target: number, texture: HeadlessTexture | null): void => {
        this.#bound = texture ?? undefined;
      },
      deleteTexture: (): void => undefined,
      texParameteri: (): void => undefined,
      pixelStorei: (): void => undefined,
      texImage2D: (_target: number, _level: number, _internal: number, width: number, height: number): void => {
        const texture = this.#texture();
        texture.width = width;
        texture.height = height;
        texture.data = undefined;
      },
      texSubImage2D: (_target: number, _level: number, x: number, y: number, width: number, height: number, _format: number, _type: number, data: Float32Array | Uint8Array): void => {
        const texture = this.#texture();
        if (x !== 0 || y !== 0 || width !== texture.width || height !== texture.height) throw new HeadlessGlError("headless: only whole-texture uploads are kept");
        texture.data = data.slice();
      },
    };
    // DataTexture uses only the members above; anything else is missing and throws when called.
    this.gl = context as unknown as WebGL2RenderingContext;
  }

  /** The texture's size and its last upload (a copy); throws if it was never uploaded. */
  upload(texture: WebGLTexture | undefined): HeadlessUpload {
    if (!(texture instanceof HeadlessTexture) || texture.data === undefined) throw new HeadlessGlError("headless: that texture has not been uploaded");
    return { width: texture.width, height: texture.height, data: texture.data };
  }

  #texture(): HeadlessTexture {
    if (!this.#bound) throw new HeadlessGlError("headless: no texture bound");
    return this.#bound;
  }
}
