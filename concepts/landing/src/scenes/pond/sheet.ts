// Data textures painted on the CPU: the pond's plant atlas (the sprites its simulated border plants
// are drawn from, see atlas.ts and sims/plantsheet.ts) and its canopy sheet. Painting is a build
// (sims/build.ts): on the build worker, so it never competes with the frame loop, or on the page in
// small steps between frames where there is none. The last finished sheet stays bound meanwhile,
// and outlives its painter for a while on its context (until that is lost), so a scene entered
// again shows its sheets at once. A newer request (a slider dragged through many values)
// supersedes the sheet in progress: only the newest is painted to the end and shown.

import { BuildSlot, type BuildKind, type BuildWorker } from "../../sims/build.ts";
import { paintAtlas, paintCanopy, type CanopyConfig } from "./atlas.ts";

/** What to paint: the plant atlas, or the canopy sheet spanning `span` frames. */
export type SheetJob = { kind: "atlas" } | { kind: "canopy"; config: CanopyConfig; span: number };

export function paintJob(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  job: SheetJob,
): Generator<void, void> {
  switch (job.kind) {
    case "atlas":
      return paintAtlas(ctx, width, height);
    case "canopy":
      return paintCanopy(ctx, width, height, job.config, job.span);
    default: {
      const unreachable: never = job;
      throw new Error(`landing: unknown sheet ${String(unreachable)}`);
    }
  }
}

/** A sheet to paint: what, at what size. */
export interface SheetRequest {
  job: SheetJob;
  width: number;
  height: number;
}

/** A painted sheet as RGBA rows, top row first. */
export interface SheetResult {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Painting a sheet, as a build. */
export const sheetPaint: BuildKind<SheetRequest, SheetResult> = {
  name: "sheet",
  builder: () => ({
    *build({ job, width, height }) {
      const sheet = new OffscreenCanvas(width, height);
      const ctx = sheet.getContext("2d");
      if (!ctx) throw new Error("landing: 2d canvas unavailable");
      const steps = paintJob(ctx, width, height, job);
      while (!steps.next().done) yield undefined;
      return {
        width,
        height,
        pixels: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer),
      };
    },
  }),
};

/**
 * Finished sheets of disposed painters, per context by key, oldest first, so a scene entered afresh
 * (a replayed entrance, a quick return) adopts them instead of repainting while it comes in.
 * Bounded: the oldest beyond KEPT_SHEETS is freed. A lost context's go with it (`forgetSheets`).
 */
const kept = new WeakMap<WebGL2RenderingContext, Map<string, WebGLTexture>>();
const KEPT_SHEETS = 2;

/**
 * The context `gl` is lost: forget the sheets kept on it. Its textures are dead once it is
 * restored, so a scene entered then paints its sheets again rather than adopting them.
 */
export function forgetSheets(gl: WebGL2RenderingContext): void {
  kept.delete(gl);
}

export class SheetPainter {
  readonly #gl: WebGL2RenderingContext;
  readonly #paint: BuildSlot<SheetRequest, SheetResult>;
  #texture: WebGLTexture | undefined;
  /** The key `#texture` was painted for (the requested `#key` may be newer, still painting). */
  #textureKey = "";
  #key = "";

  /** `worker`: the build worker to paint on (default the page's, sims/build.ts). */
  constructor(gl: WebGL2RenderingContext, worker?: BuildWorker) {
    this.#gl = gl;
    this.#paint = new BuildSlot(sheetPaint, worker);
  }

  /** The last finished sheet, if any. */
  get texture(): WebGLTexture | undefined {
    return this.#texture;
  }

  /** Start painting anew when `key` changes; a newer request supersedes one still in progress. */
  request(key: string, width: number, height: number, job: SheetJob): void {
    if (key === this.#key) return;
    this.#key = key;
    const sheets = kept.get(this.#gl);
    const ready = sheets?.get(key);
    if (sheets !== undefined && ready !== undefined) {
      sheets.delete(key);
      this.#paint.cancel();
      if (this.#texture !== undefined) this.#gl.deleteTexture(this.#texture);
      this.#texture = ready;
      this.#textureKey = key;
      return;
    }
    this.#paint.request(key, { job, width, height });
  }

  /**
   * Once a frame: send the sheet to the worker, or paint it here for up to `budget` milliseconds
   * (the frame's, SimFrame.budget, or a floor it raises: Infinity paints the whole sheet now); a
   * finished sheet is uploaded.
   */
  advance(budget: number): void {
    const landed = this.#paint.advance(budget);
    if (landed) this.#upload(landed.key, landed.result);
  }

  /**
   * Drop any painting in progress and hand the finished sheet to `kept` (freeing the oldest kept).
   * Back to the unrequested key, so a sheet still in flight never uploads into a texture this
   * painter no longer owns.
   */
  dispose(): void {
    this.#key = "";
    this.#paint.dispose();
    const texture = this.#texture;
    this.#texture = undefined;
    if (texture === undefined) return;
    let sheets = kept.get(this.#gl);
    if (sheets === undefined) {
      sheets = new Map();
      kept.set(this.#gl, sheets);
    }
    const previous = sheets.get(this.#textureKey);
    if (previous !== undefined) this.#gl.deleteTexture(previous);
    sheets.delete(this.#textureKey);
    sheets.set(this.#textureKey, texture);
    for (const [key, old] of sheets) {
      if (sheets.size <= KEPT_SHEETS) break;
      this.#gl.deleteTexture(old);
      sheets.delete(key);
    }
  }

  #upload(key: string, { width, height, pixels }: SheetResult): void {
    const gl = this.#gl;
    const texture = this.#texture ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Rows come top row first; the pixel store goes back to what every other upload expects.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#texture = texture;
    this.#textureKey = key;
  }
}
