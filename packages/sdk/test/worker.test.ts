import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import {
  AGENT_TOOL_CHUNK_CHARS,
  AGENT_TOOL_MAX_REPLY_BYTES,
  AGENT_RUN_MAX_POLICY_BUNDLES,
  AGENT_RUN_MAX_POLICY_BODY_BYTES,
  WorkerAgentRunCallSchema,
  SERVICE_FRAME_BYTES,
  WORKER_MAX_PENDING,
  ServiceCallSchema,
  ServiceReadySchema,
  type AgentToolReply,
} from "@manifold/protocol";
import { openWorkerContext, type WorkerContextOptions } from "../src/worker.ts";

function channel(options: Omit<WorkerContextOptions, "fd"> = {}) {
  const native = dlopen("libc.so.6", {
    socketpair: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
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
    owner,
    worker,
    send(value: unknown) {
      owner.write(`${JSON.stringify(value)}\n`);
    },
    next(): Promise<unknown> {
      if (received.length) return Promise.resolve(received.shift());
      const result = Promise.withResolvers<unknown>();
      waiting.push(result.resolve);
      return result.promise;
    },
    close() {
      worker.close();
      owner.destroy();
      native.close();
    },
  };
}

const service = { serviceId: "inventory", operationId: "read", input: {} };
const context = {
  type: "context",
  locations: [{ locationId: "workspace", guestPath: "/locations/workspace", access: "write" }],
} as const;

describe.skipIf(process.platform !== "linux")("native worker context socket", () => {
  test("agent requests reject caller-selected Run identity before any native admission", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const selected = { type: "describe" as const, runId: "another-run", actorId: "operator" };
      expect(await c.worker.callAgent(selected)).toEqual({
        type: "refused",
        code: "malformed_request",
        traceId: null,
      });
      const serviceCall = c.worker.callService(service);
      const request = ServiceCallSchema.parse(await c.next());
      c.send({
        type: "service_result",
        requestId: request.requestId,
        ok: true,
        result: "unchanged",
      });
      expect(await serviceCall).toBe("unchanged");
    } finally {
      c.close();
    }
  });

  test("agent cancellation before readiness never forwards, and in-flight disconnect stays unknown", async () => {
    const c = channel();
    try {
      const signal = new AbortController();
      const queued = c.worker.callAgent({ type: "describe" }, { signal: signal.signal });
      signal.abort();
      expect(await queued).toEqual({ type: "refused", code: "cancelled", traceId: null });
      c.send(context);
      await c.worker.ready;
      const inflight = c.worker.callAgent({ type: "invoke", door: "fixture.write", args: {} });
      const request = WorkerAgentRunCallSchema.parse(await c.next());
      expect(request.payload).toEqual({ type: "invoke", door: "fixture.write", args: {} });
      c.owner.destroy();
      expect(await inflight).toEqual({ type: "unknown", reason: "disconnected", traceId: null });
      expect(await c.worker.callAgent({ type: "describe" })).toEqual({
        type: "refused",
        code: "authority_unavailable",
        traceId: null,
      });
    } finally {
      c.close();
    }
  });

  test("cancelled agent replies are sequenced and discarded only until their final chunk", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const signal = new AbortController();
      const call = c.worker.callAgent({ type: "describe" }, { signal: signal.signal });
      const request = WorkerAgentRunCallSchema.parse(await c.next());
      signal.abort();
      expect(await call).toEqual({ type: "unknown", reason: "cancelled", traceId: null });
      expect(await c.next()).toEqual({ type: "agent_run_cancel", requestId: request.requestId });
      const data = JSON.stringify({ type: "refused", code: "cancelled", traceId: null });
      c.send({
        type: "agent_run_result",
        requestId: request.requestId,
        seq: 0,
        end: false,
        data: data.slice(0, 8),
      });
      c.send({
        type: "agent_run_result",
        requestId: request.requestId,
        seq: 1,
        end: true,
        data: data.slice(8),
      });
      const serviceCall = c.worker.callService(service);
      const next = ServiceCallSchema.parse(await c.next());
      c.send({ type: "service_result", requestId: next.requestId, ok: true, result: "alive" });
      expect(await serviceCall).toBe("alive");
      const remaining = c.worker.callAgent({ type: "describe" });
      await c.next();
      c.send({ type: "agent_run_result", requestId: request.requestId, seq: 2, end: true, data });
      expect(await remaining).toEqual({ type: "unknown", reason: "protocol_error", traceId: null });
      expect(c.worker.signal.aborted).toBe(true);
    } finally {
      c.close();
    }
  });

  test("agent replies reject wrong request identity, result door and chunk sequence", async () => {
    for (const mismatch of ["request", "door", "sequence"] as const) {
      const c = channel();
      try {
        c.send(context);
        await c.worker.ready;
        const call = c.worker.callAgent({ type: "invoke", door: "fixture.write", args: {} });
        const request = WorkerAgentRunCallSchema.parse(await c.next());
        c.send({
          type: "agent_run_result",
          requestId: mismatch === "request" ? "other-job-request" : request.requestId,
          seq: mismatch === "sequence" ? 1 : 0,
          end: true,
          data: JSON.stringify({
            type: "result",
            door: mismatch === "door" ? "fixture.other" : "fixture.write",
            traceId: 7,
            outcome: { ok: true },
          }),
        });
        expect(await call).toEqual({ type: "unknown", reason: "protocol_error", traceId: null });
        expect(c.worker.signal.aborted).toBe(true);
      } finally {
        c.close();
      }
    }
  });

  test("agent policy bodies reassemble beyond the service frame without dropping exact bytes", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const call = c.worker.callAgent({ type: "policy" });
      const request = WorkerAgentRunCallSchema.parse(await c.next());
      const reply: AgentToolReply = {
        type: "policy",
        policy: {
          runId: "trusted-run",
          revision: "a".repeat(64),
          issuedAt: 1,
          required: Array.from({ length: AGENT_RUN_MAX_POLICY_BUNDLES }, (_, index) => ({
            id: `policy-${index}`,
            source: "operator",
            digest: "b".repeat(64),
            body: "x".repeat(AGENT_RUN_MAX_POLICY_BODY_BYTES),
          })),
        },
      };
      const data = JSON.stringify(reply);
      expect(Buffer.byteLength(data)).toBeGreaterThan(SERVICE_FRAME_BYTES);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(AGENT_TOOL_MAX_REPLY_BYTES);
      for (let offset = 0, seq = 0; offset < data.length; offset += AGENT_TOOL_CHUNK_CHARS, seq++) {
        c.send({
          type: "agent_run_result",
          requestId: request.requestId,
          seq,
          end: offset + AGENT_TOOL_CHUNK_CHARS >= data.length,
          data: data.slice(offset, offset + AGENT_TOOL_CHUNK_CHARS),
        });
      }
      expect(await call).toEqual(reply);
      expect(c.worker.signal.aborted).toBe(false);
    } finally {
      c.close();
    }
  });

  test("agent chunk byte ceiling ends an oversized response with uncertainty, not success", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const call = c.worker.callAgent({ type: "policy" });
      const request = WorkerAgentRunCallSchema.parse(await c.next());
      // Multibyte data crosses the byte ceiling well before the sequenced chunk count.
      const data = "界".repeat(AGENT_TOOL_CHUNK_CHARS);
      for (
        let seq = 0;
        seq < Math.ceil(AGENT_TOOL_MAX_REPLY_BYTES / Buffer.byteLength(data)) + 1;
        seq++
      )
        c.send({ type: "agent_run_result", requestId: request.requestId, seq, end: false, data });
      expect(await call).toEqual({ type: "unknown", reason: "protocol_error", traceId: null });
      expect(c.worker.signal.aborted).toBe(true);
    } finally {
      c.close();
    }
  });

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
      c.send({
        type: "service_result",
        requestId: b.requestId,
        ok: true,
        result: { items: [{ id: "second" }] },
      });
      c.send({
        type: "service_result",
        requestId: a.requestId,
        ok: true,
        result: { items: [{ id: "first" }] },
      });
      expect(await first).toEqual({ items: [{ id: "first" }] });
      expect(await second).toEqual({ items: [{ id: "second" }] });
    } finally {
      c.close();
    }
  });

  test("a burst of stages is dropped rather than rejecting the call that follows it", async () => {
    const c = channel();
    try {
      c.send(context);
      expect(await c.worker.ready).toEqual(context.locations);
      const message = "d".repeat(256);
      for (let line = 0; line < 1200; line++)
        c.worker.reportProgress({ stage: "at the model", message });
      // A full reply queue ends the whole context, so bytes a disposable stage put on the
      // wire must not be able to reject a call the application is awaiting.
      const call = c.worker.callService(service);
      let stages = 0;
      let frame: unknown = await c.next();
      while (
        frame !== null &&
        typeof frame === "object" &&
        Reflect.get(frame, "type") === "progress"
      ) {
        stages++;
        frame = await c.next();
      }
      const request = ServiceCallSchema.parse(frame);
      c.send({ type: "service_result", requestId: request.requestId, ok: true, result: "ok" });
      expect(await call).toBe("ok");
      expect(c.worker.signal.aborted).toBe(false);
      // Some reached the owner and the rest were dropped, which is what coalescing would
      // have done to them anyway.
      expect(stages).toBeGreaterThan(0);
      expect(stages).toBeLessThan(1200);
    } finally {
      c.close();
    }
  });

  test("an invalid stage is refused before it is written, never by failing the run", async () => {
    const c = channel();
    try {
      c.send(context);
      expect(await c.worker.ready).toEqual(context.locations);
      for (const invalid of [
        { stage: "AT THE MODEL" },
        { stage: "" },
        { stage: "a".repeat(65) },
        { stage: " preparing" },
        { stage: "preparing", message: "carriage\rreturn" },
        { stage: "preparing", fraction: 1.5 },
      ])
        expect(() => c.worker.reportProgress(invalid)).toThrow("worker_progress_invalid");
      expect(c.worker.signal.aborted).toBe(false);
      c.worker.reportProgress({ stage: "at the model" });
      expect(await c.next()).toEqual({ type: "progress", stage: "at the model" });
    } finally {
      c.close();
    }
  });

  test("denials are safe named errors and do not close the authorized service channel", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      const refused = c.worker.callService(service);
      const rejection = Promise.allSettled([refused]);
      const request = ServiceCallSchema.parse(await c.next());
      c.send({
        type: "service_result",
        requestId: request.requestId,
        ok: false,
        refusal: "service_unauthorized",
      });
      expect((await rejection)[0]).toMatchObject({
        status: "rejected",
        reason: {
          name: "WorkerError",
          code: "service_unauthorized",
          message: "service_unauthorized",
        },
      });
      expect(c.worker.signal.aborted).toBe(false);
    } finally {
      c.close();
    }
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
          c.send({
            type: "service_result",
            requestId: request.requestId,
            ok: true,
            result: "accepted",
          });
          expect(await first).toBe("accepted");
        }
        const remaining = c.worker.callService(service);
        const rejected = Promise.allSettled([remaining]);
        await c.next();
        c.send(
          kind === "wrong-kind"
            ? { type: "service_ready_result", requestId: request.requestId, ok: true }
            : {
                type: "service_result",
                requestId: kind === "unknown" ? "unknown" : request.requestId,
                ok: true,
                result: "ignored",
              },
        );
        expect((await rejected)[0]).toMatchObject({
          status: "rejected",
          reason: { code: "worker_protocol_error" },
        });
        expect(c.worker.signal.aborted).toBe(true);
        expect(c.worker.signal.reason.code).toBe("worker_protocol_error");
        expect((await outcome)[0]!.status).toBe(kind === "duplicate" ? "fulfilled" : "rejected");
      } finally {
        c.close();
      }
    }
  });

  test("pending call count is bounded even while waiting for the first context", async () => {
    const c = channel();
    try {
      const pending = Array.from({ length: WORKER_MAX_PENDING }, () =>
        c.worker.callService(service),
      );
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
      c.send({
        type: "service_result",
        requestId: request.requestId,
        ok: true,
        result: "capacity released",
      });
      expect(await next).toBe("capacity released");
    } finally {
      c.close();
    }
  });

  test("queued request bytes are bounded independently of the pending count", async () => {
    const c = channel();
    try {
      const large = { ...service, input: { text: "x".repeat(60000) } };
      const outcomes = Promise.allSettled(
        Array.from({ length: 4 }, () => c.worker.callService(large)),
      );
      await expect(c.worker.callService(large)).rejects.toMatchObject({ code: "worker_busy" });
      c.worker.close();
      for (const result of await outcomes) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.code).toBe("worker_closed");
      }
    } finally {
      c.close();
    }
  });

  test("EOF before context and cancellation with pending work settle readiness and calls", async () => {
    const disconnected = channel();
    try {
      const ready = Promise.allSettled([disconnected.worker.ready]);
      disconnected.owner.end();
      expect((await ready)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "worker_disconnected" },
      });
      expect(disconnected.worker.signal.aborted).toBe(true);
    } finally {
      disconnected.close();
    }
    const controller = new AbortController();
    const cancelled = channel({ signal: controller.signal });
    try {
      const call = cancelled.worker.callService(service);
      const outcomes = Promise.allSettled([call, cancelled.worker.ready]);
      controller.abort(new Error("private reason"));
      for (const result of await outcomes)
        expect(result).toMatchObject({ status: "rejected", reason: { code: "worker_cancelled" } });
      await expect(cancelled.worker.callService(service)).rejects.toMatchObject({
        code: "worker_cancelled",
      });
    } finally {
      cancelled.close();
    }
  });

  test("strict context and fragmented oversized input cannot make the worker ready", async () => {
    for (const invalid of [
      { ...context, owner: "injected" },
      { type: "context", locations: [{ ...context.locations[0], access: "owner" }] },
      { type: "context", locations: [context.locations[0], context.locations[0]] },
    ]) {
      const c = channel();
      try {
        const ready = Promise.allSettled([c.worker.ready]);
        c.send(invalid);
        expect((await ready)[0]).toMatchObject({
          status: "rejected",
          reason: { code: "worker_protocol_error" },
        });
      } finally {
        c.close();
      }
    }
    const oversized = channel();
    try {
      const ready = Promise.allSettled([oversized.worker.ready]);
      oversized.owner.write(Buffer.alloc(SERVICE_FRAME_BYTES / 2, 32));
      oversized.owner.write(Buffer.alloc(SERVICE_FRAME_BYTES / 2, 32));
      expect((await ready)[0]).toMatchObject({
        status: "rejected",
        reason: { code: "worker_frame_limit" },
      });
    } finally {
      oversized.close();
    }
  });

  test("service readiness waits for a positive owner ACK, not socket write completion", async () => {
    const c = channel();
    try {
      c.send(context);
      await c.worker.ready;
      let announced = false;
      const ready = c.worker.announceServiceReady(4321).then(() => {
        announced = true;
      });
      const request = ServiceReadySchema.parse(await c.next());
      const barrier = c.worker.callService(service);
      const probe = ServiceCallSchema.parse(await c.next());
      c.send({
        type: "service_result",
        requestId: probe.requestId,
        ok: true,
        result: "owner still deciding",
      });
      await barrier;
      expect(announced).toBe(false);
      c.send({ type: "service_ready_result", requestId: request.requestId, ok: true });
      await ready;
      expect(announced).toBe(true);
      await expect(c.worker.announceServiceReady(4322)).rejects.toMatchObject({
        code: "service_ready_duplicate",
      });
    } finally {
      c.close();
    }
  });

  test("negative readiness ACK and disconnect while awaiting ACK never report readiness", async () => {
    for (const action of ["refuse", "disconnect"] as const) {
      const c = channel();
      try {
        c.send(context);
        await c.worker.ready;
        const ready = c.worker.announceServiceReady(4321);
        const rejected = Promise.allSettled([ready]);
        const request = ServiceReadySchema.parse(await c.next());
        if (action === "refuse")
          c.send({
            type: "service_ready_result",
            requestId: request.requestId,
            ok: false,
            refusal: "service_unavailable",
          });
        else c.owner.end();
        expect((await rejected)[0]).toMatchObject({
          status: "rejected",
          reason: { code: action === "refuse" ? "service_unavailable" : "worker_disconnected" },
        });
      } finally {
        c.close();
      }
    }
  });
});

test("FD validation rejects stdin, noncanonical descriptors and non-socket files without closing them", () => {
  for (const fd of [0, 2, -1, 3.5, "3garbage", "", "999999999999", NaN])
    expect(() => openWorkerContext({ fd })).toThrow("worker_invalid_fd");
  const fd = openSync("/dev/null", "r");
  try {
    expect(() => openWorkerContext({ fd })).toThrow("worker_invalid_fd");
  } finally {
    closeSync(fd);
  }
});
