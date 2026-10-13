// Worker entry: paints the pond's sheets off the page's thread (see sheet.ts).

import { paintJob, type SheetReply, type SheetRequest } from "./sheet.ts";

/** The parts of the worker scope this entry uses (the page's DOM lib has no worker types). */
interface Scope {
  onmessage: ((event: MessageEvent<SheetRequest>) => void) | null;
  postMessage(message: SheetReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as Scope;

scope.onmessage = (event) => {
  const { id, job, width, height } = event.data;
  const sheet = new OffscreenCanvas(width, height);
  const ctx = sheet.getContext("2d");
  if (!ctx) throw new Error("landing: 2d canvas unavailable in worker");
  const steps = paintJob(ctx, width, height, job);
  while (!steps.next().done) {
    // Painting straight through: this thread has nothing else to do.
  }
  const pixels = ctx.getImageData(0, 0, width, height).data.buffer;
  scope.postMessage({ id, width, height, pixels }, [pixels]);
};
