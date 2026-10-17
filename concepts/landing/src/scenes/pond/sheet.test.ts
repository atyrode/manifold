import { expect, test } from "bun:test";
import { type BuildMessage, type BuildReply, BuildWorker } from "../../sims/build.ts";
import type { CanopyConfig } from "./atlas.ts";
import { SheetPainter, type SheetJob, type SheetRequest } from "./sheet.ts";

// The real SheetPainter on the real build slot, against a stand-in worker and GL context: what is
// posted to the worker is the painting done, and what reaches texImage2D is the sheet the pond
// shows. A reply carries its job's seed as its one pixel, so an upload tells which request it
// painted.

class FakeWorker {
  readonly posted: BuildMessage[] = [];
  onmessage: ((event: { data: BuildReply }) => void) | null = null;
  onerror: ((event: { preventDefault(): void; message: string }) => void) | null = null;

  postMessage(message: BuildMessage): void {
    this.posted.push(message);
  }

  /** The builds asked for, as their canopies' seeds. */
  get seeds(): number[] {
    return this.posted.flatMap((message) =>
      message.type === "build" ? [seedOf(message.request as SheetRequest)] : [],
    );
  }

  /** The worker finishes the `index`th build asked for. */
  paint(index: number): void {
    const message = this.posted.filter((posted) => posted.type === "build")[index];
    if (message?.type !== "build") throw new Error(`no build ${index} on the worker`);
    const seed = seedOf(message.request as SheetRequest);
    const result = { width: 1, height: 1, pixels: new Uint8Array([seed, 0, 0, 255]) };
    this.onmessage?.({ data: { slot: message.slot, id: message.id, result, done: true } });
  }
}

function seedOf(request: SheetRequest): number {
  if (request.job.kind !== "canopy") throw new Error("expected a canopy job");
  return request.job.config.seed;
}

/** A painter on a fresh stand-in worker, and the seeds of the sheets it uploads, in order. */
function painter(): { painter: SheetPainter; worker: FakeWorker; uploads: number[] } {
  const uploads: number[] = [];
  const calls = {
    createTexture: () => ({}),
    deleteTexture: () => undefined,
    bindTexture: () => undefined,
    pixelStorei: () => undefined,
    generateMipmap: () => undefined,
    texParameteri: () => undefined,
    texImage2D: (...args: unknown[]) => {
      const pixels = args[8];
      if (pixels instanceof Uint8Array) uploads.push(pixels[0] ?? -1);
    },
  };
  // Stand-ins: SheetPainter only creates, fills and frees textures (its constants are left
  // undefined), and BuildWorker only posts to its worker and listens to it.
  const gl = calls as unknown as WebGL2RenderingContext;
  const worker = new FakeWorker();
  return {
    painter: new SheetPainter(gl, new BuildWorker(worker as unknown as Worker)),
    worker,
    uploads,
  };
}

function canopy(seed: number): SheetJob {
  const config: CanopyConfig = { coverage: 0.45, sides: [0.6, 0.6, 0.6, 0.6], seed };
  return { kind: "canopy", config, span: 1.5 };
}

const FRAME_MS = 16;

test("a burst of requests within a frame paints only the newest, and shows it", () => {
  const { painter: sheets, worker, uploads } = painter();
  for (let seed = 10; seed <= 15; seed++) sheets.request(`burst-${seed}`, 1, 1, canopy(seed));
  sheets.advance(FRAME_MS);
  expect(worker.seeds).toEqual([15]);
  worker.paint(0);
  sheets.advance(FRAME_MS);
  expect(uploads).toEqual([15]);
  expect(sheets.texture).toBeDefined();
});

test("a sheet superseded while it paints is dropped on the worker and never shown", () => {
  const { painter: sheets, worker, uploads } = painter();
  sheets.request("drag-20", 1, 1, canopy(20));
  sheets.advance(FRAME_MS);
  sheets.request("drag-21", 1, 1, canopy(21));
  sheets.advance(FRAME_MS);
  expect(worker.posted.map((message) => message.type)).toEqual(["build", "cancel", "build"]);
  // The superseded sheet comes back anyway (it was finished before the cancel arrived).
  worker.paint(0);
  sheets.advance(FRAME_MS);
  expect(uploads).toEqual([]);
  worker.paint(1);
  sheets.advance(FRAME_MS);
  expect(uploads).toEqual([21]);
});

test("a disposed painter shows nothing that comes back, and the worker drops its slot", () => {
  const { painter: sheets, worker, uploads } = painter();
  sheets.request("gone-30", 1, 1, canopy(30));
  sheets.advance(FRAME_MS);
  sheets.dispose();
  worker.paint(0);
  sheets.advance(FRAME_MS);
  expect(uploads).toEqual([]);
  expect(sheets.texture).toBeUndefined();
  expect(worker.posted.at(-1)?.type).toBe("release");
});
