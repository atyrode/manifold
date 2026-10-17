// A small float render target read back to the CPU without stalling the frame: `request` copies it
// into a pixel buffer behind a fence, and a later frame's `poll` takes the copy once the GPU has
// finished it, so the CPU sees the field a frame or two late instead of waiting for it. For a sim
// whose CPU side answers a GPU field (the tide pool's plants and fish swaying in its water's flow).
// Needs what GpuCompute needs (float render targets); reads RGBA float.
//
// GL state: leaves the pixel-pack buffer and the framebuffer unbound.
//
// Usage:
//   const probe = gpu.target({ width: 64, height: 36, format: "rgba32f", filter: "nearest" });
//   const readback = new GpuReadback(gl, 64, 36);
//   const flow = new Float32Array(64 * 36 * 4);
//   // each frame, after drawing into probe:
//   if (readback.poll(flow)) useFlow(flow);   // the latest finished copy, rows bottom to top
//   readback.request(probe.framebuffer);       // starts one unless one is in flight
export class GpuReadback {
  readonly width: number;
  readonly height: number;
  readonly #gl: WebGL2RenderingContext;
  readonly #buffer: WebGLBuffer;
  #fence: WebGLSync | null = null;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.#gl = gl;
    this.width = width;
    this.height = height;
    this.#buffer = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  /** A copy is on its way. */
  get pending(): boolean {
    return this.#fence !== null;
  }

  /** Starts copying the RGBA float framebuffer (width × height from its corner), unless a copy is on its way. */
  request(framebuffer: WebGLFramebuffer): void {
    if (this.#fence !== null) return;
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#buffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /** Copies the finished copy into `out` (width · height · 4 floats) and returns true; false while none is ready. */
  poll(out: Float32Array): boolean {
    const gl = this.#gl;
    const fence = this.#fence;
    if (fence === null || gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.deleteSync(fence);
    this.#fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, this.width * this.height * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return true;
  }

  dispose(): void {
    const gl = this.#gl;
    if (this.#fence !== null) gl.deleteSync(this.#fence);
    this.#fence = null;
    gl.deleteBuffer(this.#buffer);
  }
}
