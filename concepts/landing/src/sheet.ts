// Data textures painted on the CPU: the pond's plant and canopy sheets. Painting runs on a worker
// thread so it never competes with the frame loop; if the worker is unavailable, it runs on the
// page in small steps between frames instead. The last finished sheet stays bound meanwhile, and
// outlives its painter for a while, so a scene entered again shows its sheets at once. A painter
// keeps one sheet at a time on the worker: requests that come while it paints (a slider dragged
// through many values) wait, each replacing the last, so only the newest is painted next.

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

/** A sheet as requested: what to paint, at what size, for which key. */
interface Order {
  key: string;
  width: number;
  height: number;
  job: SheetJob;
}

interface LocalJob {
  key: string;
  sheet: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  steps: Generator<void, void>;
}

/**
 * Finished sheets of disposed painters by key, oldest first, so a scene entered afresh (a replayed
 * entrance, a quick return) adopts them instead of repainting while it comes in. Bounded: the
 * oldest beyond KEPT_SHEETS is freed.
 */
const kept = new Map<string, WebGLTexture>();
const KEPT_SHEETS = 2;

export class SheetPainter {
  readonly #gl: WebGL2RenderingContext;
  #texture: WebGLTexture | undefined;
  /** The key `#texture` was painted for (the requested `#key` may be newer, still painting). */
  #textureKey = "";
  #key = "";
  #local: LocalJob | undefined;
  /** The key of this painter's sheet on the worker, "" while none is. */
  #sent = "";
  /** The newest request that came while that sheet was painting, sent once it is back. */
  #waiting: Order | undefined;

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
    this.#waiting = undefined;
    const ready = kept.get(key);
    if (ready !== undefined) {
      kept.delete(key);
      if (this.#texture !== undefined) this.#gl.deleteTexture(this.#texture);
      this.#texture = ready;
      this.#textureKey = key;
      return;
    }
    this.#send({ key, width, height, job });
  }

  /** Paint on the worker, after this painter's sheet already there if any; on the page without one. */
  #send(order: Order): void {
    const worker = sheetWorker();
    if (!worker) {
      this.#paintHere(order);
      return;
    }
    if (this.#sent !== "") {
      // Superseded requests are never painted; asking again for the sheet out there needs nothing more.
      this.#waiting = order.key === this.#sent ? undefined : order;
      return;
    }
    this.#sent = order.key;
    worker.paint(order.job, order.width, order.height).then(
      (reply) => {
        this.#returned();
        if (this.#key === order.key) this.#upload(order.key, reply.width, reply.height, new Uint8Array(reply.pixels));
      },
      () => {
        this.#returned();
        if (this.#key === order.key) this.#paintHere(order);
      },
    );
  }

  /** This painter's sheet is back from the worker: send the request that waited for it. */
  #returned(): void {
    this.#sent = "";
    const next = this.#waiting;
    this.#waiting = undefined;
    if (next !== undefined) this.#send(next);
  }

  /**
   * Drop any painting in progress and hand the finished sheet to `kept` (freeing the oldest kept).
   * Back to the unrequested key, so a worker reply still in flight no longer matches and never
   * uploads into a texture this painter no longer owns.
   */
  dispose(): void {
    this.#key = "";
    this.#local = undefined;
    this.#waiting = undefined;
    const texture = this.#texture;
    this.#texture = undefined;
    if (texture === undefined) return;
    const previous = kept.get(this.#textureKey);
    if (previous !== undefined) this.#gl.deleteTexture(previous);
    kept.delete(this.#textureKey);
    kept.set(this.#textureKey, texture);
    for (const [key, old] of kept) {
      if (kept.size <= KEPT_SHEETS) break;
      this.#gl.deleteTexture(old);
      kept.delete(key);
    }
  }

  /** Paint on the page for up to `budget` milliseconds, when the worker could not. */
  advance(budget: number): void {
    const job = this.#local;
    if (!job) return;
    const start = performance.now();
    while (performance.now() - start < budget) {
      if (job.steps.next().done) {
        this.#local = undefined;
        this.#upload(job.key, job.sheet.width, job.sheet.height, new Uint8Array(job.ctx.getImageData(0, 0, job.sheet.width, job.sheet.height).data.buffer));
        return;
      }
    }
  }

  #paintHere(order: Order): void {
    const sheet = new OffscreenCanvas(order.width, order.height);
    const ctx = sheet.getContext("2d");
    if (!ctx) throw new Error("landing: 2d canvas unavailable");
    this.#local = { key: order.key, sheet, ctx, steps: paintJob(ctx, order.width, order.height, order.job) };
  }

  #upload(key: string, width: number, height: number, pixels: Uint8Array): void {
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
    this.#textureKey = key;
  }
}
