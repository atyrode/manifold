import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CanopyConfig } from "./decor.ts";
import { SheetPainter, type SheetJob, type SheetReply, type SheetRequest } from "./sheet.ts";

// The real SheetPainter against a stand-in worker and GL context: what is posted to the worker is
// the painting done, and what reaches texImage2D is the sheet the pond shows. A reply carries its
// job's seed as its one pixel, so an upload tells which request it painted.

/** Requests posted to the worker, in order. */
const posted: SheetRequest[] = [];
let worker: FakeWorker | undefined;

class FakeWorker {
  onmessage: ((event: { data: SheetReply }) => void) | null = null;
  onerror: ((event: { preventDefault(): void; message: string }) => void) | null = null;

  constructor() {
    worker = this;
  }

  postMessage(request: SheetRequest): void {
    posted.push(request);
  }
}

function seedOf(request: SheetRequest): number {
  if (request.job.kind !== "canopy") throw new Error("expected a canopy job");
  return request.job.config.seed;
}

/** The worker finishes `request`; the painter's reply callback, queued first, runs before this resolves. */
async function paint(request: SheetRequest | undefined): Promise<void> {
  if (!request || !worker?.onmessage) throw new Error("no such request on the worker");
  worker.onmessage({ data: { id: request.id, width: 1, height: 1, pixels: new Uint8Array([seedOf(request), 0, 0, 255]).buffer } });
  await Promise.resolve();
}

/** The seeds of the sheets uploaded through this context, in order. */
function context(): { gl: WebGL2RenderingContext; uploads: number[] } {
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
  // A stand-in: SheetPainter only creates, fills and frees textures (its constants are left undefined).
  const gl = calls as unknown as WebGL2RenderingContext;
  return { gl, uploads };
}

function canopy(seed: number): SheetJob {
  const config: CanopyConfig = { coverage: 0.45, sides: [0.6, 0.6, 0.6, 0.6], seed };
  return { kind: "canopy", config, span: 1.5 };
}

const globals = ["document", "Worker"] as const;
const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));

beforeAll(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI: "http://lab.test/" } });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
});

afterAll(() => {
  globals.forEach((name, index) => {
    const descriptor = saved[index];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});

test("a burst of requests paints the sheet in progress and the newest only, and shows the newest", async () => {
  const { gl, uploads } = context();
  const painter = new SheetPainter(gl);
  const from = posted.length;
  for (let seed = 10; seed <= 15; seed++) painter.request(`burst-${seed}`, 1, 1, canopy(seed));
  expect(posted.slice(from).map(seedOf)).toEqual([10]);
  await paint(posted[from]);
  // The superseded sheet is not shown; the newest request goes out as soon as the worker is free.
  expect(uploads).toEqual([]);
  expect(posted.slice(from).map(seedOf)).toEqual([10, 15]);
  await paint(posted[from + 1]);
  expect(uploads).toEqual([15]);
  expect(painter.texture).toBeDefined();
  expect(posted.length - from).toBe(2);
});

test("asking again for the sheet being painted takes it as it comes, without painting it twice", async () => {
  const { gl, uploads } = context();
  const painter = new SheetPainter(gl);
  const from = posted.length;
  painter.request("again-20", 1, 1, canopy(20));
  painter.request("again-21", 1, 1, canopy(21));
  painter.request("again-20", 1, 1, canopy(20));
  await paint(posted[from]);
  expect(uploads).toEqual([20]);
  expect(posted.slice(from).map(seedOf)).toEqual([20]);
});

test("a disposed painter sends no waiting request and shows nothing that comes back", async () => {
  const { gl, uploads } = context();
  const painter = new SheetPainter(gl);
  const from = posted.length;
  painter.request("gone-30", 1, 1, canopy(30));
  painter.request("gone-31", 1, 1, canopy(31));
  painter.dispose();
  await paint(posted[from]);
  expect(uploads).toEqual([]);
  expect(posted.slice(from).map(seedOf)).toEqual([30]);
  expect(painter.texture).toBeUndefined();
});
