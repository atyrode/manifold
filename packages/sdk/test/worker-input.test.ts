import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { attachWorkerInput, JsonFrameReader, type WorkerError } from "../src/worker.ts";

const parseString = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("private application validation details");
  return value;
};

test("typed stdin frames preserve fragmented UTF-8 and process coalesced frames without accumulating the chunk", () => {
  const frames: string[] = [];
  const reader = new JsonFrameReader({
    parse: parseString,
    receive: (frame) => frames.push(frame),
    maxFrameBytes: 8,
  });
  const encoded = Buffer.from('"界"\n');
  reader.push(encoded.subarray(0, 2));
  reader.push(encoded.subarray(2, 3));
  expect(frames).toEqual([]);
  reader.push(Buffer.concat([encoded.subarray(3), Buffer.from('"a"\n"b"\n"c"\n')]));
  reader.end();
  expect(frames).toEqual(["界", "a", "b", "c"]);
});

test("frame ceilings include the newline and reject a fragmented oversized line before JSON parsing", () => {
  const frames: unknown[] = [];
  const exact = new JsonFrameReader({
    parse: (value) => value,
    receive: (value) => frames.push(value),
    maxFrameBytes: 6,
  });
  exact.push(Buffer.from('"abc"\n'));
  expect(frames).toEqual(["abc"]);
  const overflow = new JsonFrameReader({
    parse: (value) => value,
    receive: (value) => frames.push(value),
    maxFrameBytes: 6,
  });
  overflow.push(Buffer.from('"abc'));
  expect(() => overflow.push(Buffer.from('d"'))).toThrow("worker_frame_limit");
  expect(() => overflow.push(Buffer.from("\n"))).toThrow("worker_closed");
  expect(frames).toEqual(["abc"]);
});

test("invalid UTF-8, invalid domain frames and truncated EOF fail without leaking payloads", () => {
  for (const bytes of [
    Buffer.from([34, 0xc0, 0xaf, 34, 10]),
    Buffer.from('{"private":"secret"}\n'),
    Buffer.from("\n"),
  ]) {
    const reader = new JsonFrameReader({
      parse: parseString,
      receive: () => {
        throw new Error("must not deliver");
      },
    });
    expect(() => reader.push(bytes)).toThrow("worker_input_invalid");
  }
  const partial = new JsonFrameReader({
    parse: parseString,
    receive: () => {
      throw new Error("must not deliver");
    },
  });
  partial.push(Buffer.from('"unterminated'));
  expect(() => partial.end()).toThrow("worker_input_invalid");
});

test("stdin EOF closes exactly once after delivering complete typed frames", async () => {
  const input = new PassThrough();
  const frames: string[] = [];
  const ended = Promise.withResolvers<WorkerError>();
  let closes = 0;
  const detach = attachWorkerInput({
    input,
    parse: parseString,
    receive: (frame) => frames.push(frame),
    onClose: (error) => {
      closes++;
      ended.resolve(error);
    },
  });
  try {
    input.end('"start"\n');
    expect((await ended.promise).code).toBe("worker_input_closed");
    input.emit("close");
    expect(frames).toEqual(["start"]);
    expect(closes).toBe(1);
  } finally {
    detach();
    input.destroy();
  }
});

test("stdin cancellation detaches promptly and does not deliver subsequent frames", () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const frames: string[] = [];
  const errors: string[] = [];
  const detach = attachWorkerInput({
    input,
    signal: controller.signal,
    parse: parseString,
    receive: (frame) => frames.push(frame),
    onClose: (error) => errors.push(error.code),
  });
  try {
    input.write('"start"\n');
    controller.abort(new Error("private cancellation detail"));
    input.write('"ignored"\n');
    detach();
    expect(frames).toEqual(["start"]);
    expect(errors).toEqual(["worker_cancelled"]);
    expect(input.listenerCount("data")).toBe(0);
  } finally {
    detach();
    input.destroy();
  }
});

test("stdin EOF with a partial control frame is a refusal, not a successful final frame", async () => {
  const input = new PassThrough();
  const ended = Promise.withResolvers<WorkerError>();
  const detach = attachWorkerInput({
    input,
    parse: parseString,
    receive: () => {
      throw new Error("must not deliver");
    },
    onClose: ended.resolve,
  });
  try {
    input.end('"partial"');
    expect((await ended.promise).code).toBe("worker_input_invalid");
  } finally {
    detach();
    input.destroy();
  }
});
