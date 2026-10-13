// Data textures painted on the CPU: the pond's plant and canopy sheets. Painting runs on a worker
// thread so it never competes with the frame loop; if the worker is unavailable, it runs on the
// page in small steps between frames instead. The last finished sheet stays bound meanwhile.

import { paintCanopy, paintDecor, type CanopyConfig, type DecorConfig } from "./decor.ts";

/** What to paint: the plant sheet, or the canopy sheet spanning `span` frames. */
export type SheetJob = { kind: "decor"; config: DecorConfig } | { kind: "canopy"; config: CanopyConfig; span: number };

export function paintJob(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, job: SheetJob): Generator<void, void> {
  switch (job.kind) {
    case "decor":
      return paintDecor(ctx, width, height, job.config);
    case "canopy":
      return paintCanopy(ctx, width, height, job.config, job.span);
    default: {
      const unreachable: never = job;
      throw new Error(`landing: unknown sheet ${String(unreachable)}`);
    }
  }
}

/** Page → worker. */
export interface SheetRequest {
  id: number;
  job: SheetJob;
  width: number;
  height: number;
}

/** Worker → page: the finished sheet as RGBA rows, top row first. */
export interface SheetReply {
  id: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

class SheetWorkerError extends Error {}

/** The one worker both sheets share, started on first use. */
class SheetWorker {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (reply: SheetReply) => void; reject: (error: Error) => void }>();
  #next = 1;
  #failed = false;

  constructor() {
    // Served next to the page: a pinned build gets its own worker.
    this.#worker = new Worker(new URL("sheet-worker.js", document.baseURI), { type: "module" });
    this.#worker.onmessage = (event: MessageEvent<SheetReply>) => {
      const reply = event.data;
      this.#pending.get(reply.id)?.resolve(reply);
      this.#pending.delete(reply.id);
    };
    this.#worker.onerror = (event) => {
      event.preventDefault();
      console.error("evt=landing.sheet_worker.failed", event.message);
      this.#failed = true;
      for (const { reject } of this.#pending.values()) reject(new SheetWorkerError(event.message || "sheet worker failed"));
      this.#pending.clear();
    };
  }

  get failed(): boolean {
    return this.#failed;
  }

  paint(job: SheetJob, width: number, height: number): Promise<SheetReply> {
    const id = this.#next++;
    const { promise, resolve, reject } = Promise.withResolvers<SheetReply>();
    this.#pending.set(id, { resolve, reject });
    const request: SheetRequest = { id, job, width, height };
    this.#worker.postMessage(request);
    return promise;
  }
}

let shared: SheetWorker | undefined;
let unavailable = false;

function sheetWorker(): SheetWorker | undefined {
  if (unavailable) return undefined;
  if (!shared) {
    try {
      shared = new SheetWorker();
    } catch (error: unknown) {
      console.error("evt=landing.sheet_worker.unavailable", error);
      unavailable = true;
      return undefined;
    }
  }
  return shared.failed ? undefined : shared;
}

interface LocalJob {
  sheet: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  steps: Generator<void, void>;
}

export class SheetPainter {
  readonly #gl: WebGL2RenderingContext;
  #texture: WebGLTexture | undefined;
  #key = "";
  #local: LocalJob | undefined;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
  }

  /** The last finished sheet, if any. */
  get texture(): WebGLTexture | undefined {
    return this.#texture;
  }

  /** Start painting anew when `key` changes; a newer request supersedes one still in progress. */
  request(key: string, width: number, height: number, job: SheetJob): void {
    if (key === this.#key) return;
    this.#key = key;
    this.#local = undefined;
    const worker = sheetWorker();
    if (!worker) {
      this.#paintHere(width, height, job);
      return;
    }
    worker.paint(job, width, height).then(
      (reply) => {
        if (this.#key === key) this.#upload(reply.width, reply.height, new Uint8Array(reply.pixels));
      },
      () => {
        if (this.#key === key) this.#paintHere(width, height, job);
      },
    );
  }

  /** Paint on the page for up to `budget` milliseconds, when the worker could not. */
  advance(budget: number): void {
    const job = this.#local;
    if (!job) return;
    const start = performance.now();
    while (performance.now() - start < budget) {
      if (job.steps.next().done) {
        this.#local = undefined;
        this.#upload(job.sheet.width, job.sheet.height, new Uint8Array(job.ctx.getImageData(0, 0, job.sheet.width, job.sheet.height).data.buffer));
        return;
      }
    }
  }

  #paintHere(width: number, height: number, job: SheetJob): void {
    const sheet = new OffscreenCanvas(width, height);
    const ctx = sheet.getContext("2d");
    if (!ctx) throw new Error("landing: 2d canvas unavailable");
    this.#local = { sheet, ctx, steps: paintJob(ctx, width, height, job) };
  }

  #upload(width: number, height: number, pixels: Uint8Array): void {
    const gl = this.#gl;
    const texture = this.#texture ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#texture = texture;
  }
}
