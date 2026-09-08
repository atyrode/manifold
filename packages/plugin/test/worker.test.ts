import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import {
  SERVICE_FRAME_BYTES, WORKER_MAX_PENDING,
  ServiceCallSchema, ServiceReadySchema,
} from "@manifold/protocol";
import { openWorkerContext, type WorkerContextOptions } from "../src/worker.ts";

function channel(options: Omit<WorkerContextOptions, "fd"> = {}) {
  const native = dlopen("libc.so.6", {
    socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  const fds = new Int32Array(2);
  if (native.symbols.socketpair(1, 1 | 0x80000, 0, ptr(fds)) !== 0) {
    native.close();
    throw new Error("socketpair failed");
  }
  const connectFd = connect as unknown as (options: { fd: number }) => Socket;
  const owner = connectFd({ fd: fds[0]! });
  const worker = openWorkerContext({ ...options, fd: fds[1]! });
  const received: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  let pending = "";
  owner.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const value: unknown = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else received.push(value);
    }
  });
  owner.on("error", () => {});
  return {
    owner, worker,
    send(value: unknown) { owner.write(`${JSON.stringify(value)}\n`); },
    next(): Promise<unknown> {
      if (received.length) return Promise.resolve(received.shift());
      const result = Promise.withResolvers<unknown>();
      waiting.push(result.resolve);
      return result.promise;
    },
    close() { worker.close(); owner.destroy(); native.close(); },
  };
}

const service = { serviceId: "inventory", operationId: "read", input: {} };
const context = { type: "context", locations: [{ locationId: "workspace", guestPath: "/locations/workspace", access: "write" }] };

describe.skipIf(process.platform !== "linux")("native worker context socket", () => {
  test("adopts a socket FD, accepts fragmented context and correlates out-of-order projected service results", async () => {
    const c = channel();
    try {
      const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
      c.owner.write(bytes.subarray(0, 7));
      c.owner.write(bytes.subarray(7));
      expect(await c.worker.ready).toEqual(context.locations);
      const first = c.worker.callService(service);
      const second = c.worker.callService(service);
      const a = ServiceCallSchema.parse(await c.next());
      const b = ServiceCallSchema.parse(await c.next());
      expect(a.requestId).not.toBe(b.requestId);
      c.send({ type: "service_result", requestId: b.requestId, ok: true, result: { items: [{ id: "second" }] } });
      c.send({ type: "service_result", requestId: a.requestId, ok: true, result: { items: [{ id: "first" }] } });
      expect(await first).toEqual({ items: [{ id: "first" }] });
      expect(await second).toEqual({ items: [{ id: "second" }] });
    } finally { c.close(); }
  });

  test("denials are safe named errors and do not close the authorized service channel", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const refused = c.worker.callService(service);
      const rejection = expect(refused).rejects.toMatchObject({ name: "WorkerError", code: "service_unauthorized", message: "service_unauthorized" });
      const request = ServiceCallSchema.parse(await c.next());
      c.send({ type: "service_result", requestId: request.requestId, ok: false, refusal: "service_unauthorized" });
      await rejection;
      expect(c.worker.signal.aborted).toBe(false);
    } finally { c.close(); }
  });

  test("unknown, wrong-kind and duplicate replies abort lifetime and reject outstanding work", async () => {
    for (const kind of ["unknown", "wrong-kind", "duplicate"] as const) {
      const c = channel();
      try {
        c.send(context);
        await c.worker.ready;
        const first = c.worker.callService(service);
        const outcome = Promise.allSettled([first]);
        const request = ServiceCallSchema.parse(await c.next());
        if (kind === "duplicate") {
          c.send({ type: "service_result", requestId: request.requestId, ok: true, result: "accepted" });
          expect(await first).toBe("accepted");
        }
        const remaining = c.worker.callService(service);
        const rejected = expect(remaining).rejects.toMatchObject({ code: "worker_protocol_error" });
        await c.next();
        c.send(kind === "wrong-kind"
          ? { type: "service_ready_result", requestId: request.requestId, ok: true }
          : { type: "service_result", requestId: kind === "unknown" ? "unknown" : request.requestId, ok: true, result: "ignored" });
        await rejected;
        expect(c.worker.signal.aborted).toBe(true);
        expect(c.worker.signal.reason.code).toBe("worker_protocol_error");
        expect((await outcome)[0]!.status).toBe(kind === "duplicate" ? "fulfilled" : "rejected");
      } finally { c.close(); }
    }
  });

  test("pending call count is bounded even while waiting for the first context", async () => {
    const c = channel();
    try {
      const pending = Array.from({ length: WORKER_MAX_PENDING }, () => c.worker.callService(service));
      const outcomes = Promise.allSettled(pending);
      await expect(c.worker.callService(service)).rejects.toMatchObject({ code: "worker_busy" });
      c.send(context);
      await c.worker.ready;
      for (let i = 0; i < WORKER_MAX_PENDING; i++) {
        const request = ServiceCallSchema.parse(await c.next());
        c.send({ type: "service_result", requestId: request.requestId, ok: true, result: i });
      }
      expect((await outcomes).every((value) => value.status === "fulfilled")).toBe(true);
      const next = c.worker.callService(service);
      const request = ServiceCallSchema.parse(await c.next());
      c.send({ type: "service_result", requestId: request.requestId, ok: true, result: "capacity released" });
      expect(await next).toBe("capacity released");
    } finally { c.close(); }
  });

  test("queued request bytes are bounded independently of the pending count", async () => {
    const c = channel();
    try {
      const large = { ...service, input: { text: "x".repeat(60000) } };
      const outcomes = Promise.allSettled(Array.from({ length: 4 }, () => c.worker.callService(large)));
      await expect(c.worker.callService(large)).rejects.toMatchObject({ code: "worker_busy" });
      c.worker.close();
      for (const result of await outcomes) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.code).toBe("worker_closed");
      }
    } finally { c.close(); }
  });

  test("EOF before context and cancellation with pending work settle readiness and calls", async () => {
    const disconnected = channel();
    try {
      const ready = expect(disconnected.worker.ready).rejects.toMatchObject({ code: "worker_disconnected" });
      disconnected.owner.end();
      await ready;
      expect(disconnected.worker.signal.aborted).toBe(true);
    } finally { disconnected.close(); }
    const controller = new AbortController();
    const cancelled = channel({ signal: controller.signal });
    try {
      const call = cancelled.worker.callService(service);
      const rejected = expect(call).rejects.toMatchObject({ code: "worker_cancelled" });
      const ready = expect(cancelled.worker.ready).rejects.toMatchObject({ code: "worker_cancelled" });
      controller.abort(new Error("private reason"));
      await rejected;
      await ready;
      await expect(cancelled.worker.callService(service)).rejects.toMatchObject({ code: "worker_cancelled" });
    } finally { cancelled.close(); }
  });

  test("strict context and fragmented oversized input cannot make the worker ready", async () => {
    for (const invalid of [
      { ...context, owner: "injected" },
      { type: "context", locations: [{ ...context.locations[0], access: "owner" }] },
      { type: "context", locations: [context.locations[0], context.locations[0]] },
    ]) {
      const c = channel();
      try {
        const ready = expect(c.worker.ready).rejects.toMatchObject({ code: "worker_protocol_error" });
        c.send(invalid);
        await ready;
      } finally { c.close(); }
    }
    const oversized = channel();
    try {
      const ready = expect(oversized.worker.ready).rejects.toMatchObject({ code: "worker_frame_limit" });
      oversized.owner.write(Buffer.alloc(SERVICE_FRAME_BYTES / 2, 32));
      oversized.owner.write(Buffer.alloc(SERVICE_FRAME_BYTES / 2, 32));
      await ready;
    } finally { oversized.close(); }
  });

  test("service readiness waits for a positive owner ACK, not socket write completion", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      let announced = false;
      const ready = c.worker.announceServiceReady(4321).then(() => { announced = true; });
      const request = ServiceReadySchema.parse(await c.next());
      const barrier = c.worker.callService(service);
      const probe = ServiceCallSchema.parse(await c.next());
      c.send({ type: "service_result", requestId: probe.requestId, ok: true, result: "owner still deciding" });
      await barrier;
      expect(announced).toBe(false);
      c.send({ type: "service_ready_result", requestId: request.requestId, ok: true });
      await ready;
      expect(announced).toBe(true);
      await expect(c.worker.announceServiceReady(4322)).rejects.toMatchObject({ code: "service_ready_duplicate" });
    } finally { c.close(); }
  });

  test("negative readiness ACK and disconnect while awaiting ACK never report readiness", async () => {
    for (const action of ["refuse", "disconnect"] as const) {
      const c = channel();
      try {
        c.send(context);
        await c.worker.ready;
        const ready = c.worker.announceServiceReady(4321);
        const rejected = expect(ready).rejects.toMatchObject({ code: action === "refuse" ? "service_unavailable" : "worker_disconnected" });
        const request = ServiceReadySchema.parse(await c.next());
        if (action === "refuse") c.send({ type: "service_ready_result", requestId: request.requestId, ok: false, refusal: "service_unavailable" });
        else c.owner.end();
        await rejected;
      } finally { c.close(); }
    }
  });
});

test("FD validation rejects stdin, noncanonical descriptors and non-socket files without closing them", () => {
  for (const fd of [0, 2, -1, 3.5, "3garbage", "", "999999999999", NaN])
    expect(() => openWorkerContext({ fd })).toThrow("worker_invalid_fd");
  const fd = openSync("/dev/null", "r");
  try { expect(() => openWorkerContext({ fd })).toThrow("worker_invalid_fd"); }
  finally { closeSync(fd); }
});
