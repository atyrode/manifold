import { describe, expect, test } from "bun:test";
import { adoptPrivateSocket } from "../src/job-files.ts";
import { dlopen, FFIType } from "bun:ffi";
import { JobContext } from "../src/job-context.ts";
import {
  AGENT_TOOL_CHUNK_CHARS,
  WorkerAgentRunResultSchema,
  type JobEvent,
  type WorkerAgentRunResult,
} from "@manifold/protocol";
import { FrameReader } from "../src/ipc-framing.ts";

function agentChannel(
  callbacks: Pick<
    ConstructorParameters<typeof JobContext>[1],
    "agentRun" | "serviceReady" | "progress"
  > = {},
) {
  const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
  const failed = Promise.withResolvers<string>();
  const context = new JobContext("signed-job", {
    invoke() {
      throw new Error("unexpected invocation");
    },
    async command() {
      throw new Error("unexpected command");
    },
    failure: failed.resolve,
    ...callbacks,
  });
  const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
  context.releaseChildFd();
  const reader = new FrameReader(128 * 1024);
  const frames: unknown[] = [];
  const waiters: ((frame: unknown) => void)[] = [];
  child.on("data", (bytes: Buffer) => {
    for (const line of reader.push(bytes)) {
      const frame: unknown = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  child.on("error", () => {});
  return {
    context,
    child,
    failed: failed.promise,
    send(frame: unknown) {
      child.write(`${JSON.stringify(frame)}\n`);
    },
    next(): Promise<unknown> {
      if (frames.length) return Promise.resolve(frames.shift());
      const frame = Promise.withResolvers<unknown>();
      waiters.push(frame.resolve);
      return frame.promise;
    },
    close() {
      context.close();
      child.destroy();
      native.close();
    },
  };
}

describe.skipIf(process.platform !== "linux")("parent-bound private invocation channel", () => {
  test("queued cancellation bypasses a blocked serial service request and never reaches the hub", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let forwarded = false;
    const c = agentChannel({
      serviceReady: async () => {
        entered.resolve();
        await release.promise;
      },
      agentRun: async () => {
        forwarded = true;
        throw new Error("cancelled call forwarded");
      },
      progress: () => cancelled.resolve(),
    });
    try {
      c.send({ type: "service_ready", requestId: "hold", port: 4321 });
      await entered.promise;
      c.send({ type: "agent_run", requestId: "queued", payload: { type: "describe" } });
      c.send({ type: "agent_run_cancel", requestId: "queued" });
      c.send({ type: "progress", stage: "cancelled" });
      await cancelled.promise;
      release.resolve();
      expect(await c.next()).toMatchObject({ type: "service_ready_result", ok: true });
      const reply = WorkerAgentRunResultSchema.parse(await c.next());
      expect(JSON.parse(reply.data)).toEqual({ type: "refused", code: "cancelled", traceId: null });
      expect(forwarded).toBe(false);
    } finally {
      release.resolve();
      c.close();
    }
  });

  test("in-flight cancellation aborts the relay immediately without claiming rollback", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const c = agentChannel({
      agentRun: async (_id, _payload, signal) => {
        entered.resolve(signal);
        return Promise.withResolvers<unknown>().promise;
      },
    });
    try {
      c.send({
        type: "agent_run",
        requestId: "running",
        payload: { type: "invoke", door: "fixture.write", args: {} },
      });
      const signal = await entered.promise;
      c.send({ type: "agent_run_cancel", requestId: "running" });
      const reply = WorkerAgentRunResultSchema.parse(await c.next());
      expect(signal.aborted).toBe(true);
      expect(JSON.parse(reply.data)).toEqual({
        type: "unknown",
        reason: "cancelled",
        traceId: null,
      });
    } finally {
      c.close();
    }
  });

  test("closed tool admission refuses subsequent requests while preserving service readiness", async () => {
    let forwarded = false;
    const c = agentChannel({
      agentRun: async () => {
        forwarded = true;
        return null;
      },
      serviceReady: async () => {},
    });
    try {
      c.context.abortAgentRuns();
      c.send({ type: "agent_run", requestId: "stale", payload: { type: "describe" } });
      const reply = WorkerAgentRunResultSchema.parse(await c.next());
      expect(JSON.parse(reply.data)).toEqual({ type: "refused", code: "cancelled", traceId: null });
      expect(forwarded).toBe(false);
      c.send({ type: "service_ready", requestId: "ready", port: 4321 });
      expect(await c.next()).toMatchObject({ type: "service_ready_result", ok: true });
    } finally {
      c.close();
    }
  });

  test("an unbound context cannot borrow a Run or accept a worker-supplied job identity", async () => {
    const c = agentChannel();
    try {
      c.send({ type: "agent_run", requestId: "unbound", payload: { type: "describe" } });
      const reply = WorkerAgentRunResultSchema.parse(await c.next());
      expect(JSON.parse(reply.data)).toEqual({
        type: "refused",
        code: "binding_unavailable",
        traceId: null,
      });
      c.send({
        type: "agent_run",
        requestId: "borrowed",
        jobId: "other-job",
        payload: { type: "describe" },
      });
      expect(await c.failed).toBe("context_protocol_error");
    } finally {
      c.close();
    }
  });

  test("large opaque replies flush sequenced chunks under real socket backpressure", async () => {
    const entered = Promise.withResolvers<void>();
    const data = JSON.stringify({ body: "界".repeat(500_000) });
    const c = agentChannel({
      agentRun: async () => {
        entered.resolve();
        return JSON.parse(data);
      },
    });
    try {
      c.child.pause();
      c.send({ type: "agent_run", requestId: "large", payload: { type: "policy" } });
      await entered.promise;
      // Let the socket fill while the consumer is paused; the owner must wait, not enqueue 1.5 MiB.
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
      c.child.resume();
      const chunks: string[] = [];
      let chunk: WorkerAgentRunResult;
      do {
        chunk = WorkerAgentRunResultSchema.parse(await c.next());
        expect(chunk.requestId).toBe("large");
        expect(chunk.seq).toBe(chunks.length);
        expect(chunk.data.length).toBeLessThanOrEqual(AGENT_TOOL_CHUNK_CHARS);
        chunks.push(chunk.data);
      } while (!chunk.end);
      expect(chunks.join("")).toBe(data);
      c.send({ type: "agent_run", requestId: "next", payload: { type: "describe" } });
      expect(WorkerAgentRunResultSchema.parse(await c.next()).requestId).toBe("next");
    } finally {
      c.close();
    }
  });

  test("peer exit with unread context is closure rather than an I/O failure", async () => {
    const closed = Promise.withResolvers<string>();
    const context = new JobContext("exiting-parent", {
      invoke: () => {
        throw new Error("unexpected invocation");
      },
      command: async () => {
        throw new Error("unexpected command");
      },
      failure: closed.resolve,
    });
    try {
      context.send({ type: "context", locations: [] });
      context.releaseChildFd();
      expect(await closed.promise).toBe("context_closed");
    } finally {
      context.close();
    }
  });

  test("intentional owner close does not turn queued context work into force cancellation", async () => {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const failures: string[] = [];
    const context = new JobContext("retiring-parent", {
      invoke() {
        throw new Error("unexpected invocation");
      },
      command: async () => {
        throw new Error("unexpected command");
      },
      serviceReady: async () => {
        entered.resolve();
        await complete.promise;
      },
      failure: (reason) => failures.push(reason),
    });
    const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
    context.releaseChildFd();
    child.on("error", () => {});
    try {
      // Both frames are already queued when readiness pauses on the launch barrier.
      child.write(
        '{"type":"service_ready","requestId":"first","port":4321}\n' +
          '{"type":"service_ready","requestId":"second","port":4321}\n',
      );
      await entered.promise;
      context.close();
      complete.resolve();
      // Drain the queued promise chain, not a guessed duration.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(failures).toEqual([]);
    } finally {
      complete.resolve();
      context.close();
      child.destroy();
      native.close();
    }
  });

  test("an unrelated child input receives a correlated rejection without closing the parent's context", async () => {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const rejected = Promise.withResolvers<unknown>();
    const invoked = Promise.withResolvers<Extract<JobEvent, { type: "invocation" }>>();
    const failures: string[] = [];
    const context = new JobContext("real-parent", {
      invoke: invoked.resolve,
      command: async () => {
        throw new Error("unrelated child must not reach owner");
      },
      failure: (reason) => failures.push(reason),
    });
    const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
    context.releaseChildFd();
    let bytes = "";
    child.on("data", (chunk) => {
      bytes += chunk.toString();
      const end = bytes.indexOf("\n");
      if (end >= 0) rejected.resolve(JSON.parse(bytes.slice(0, end)));
    });
    child.on("error", () => {});
    try {
      child.write(
        `${JSON.stringify({
          type: "input",
          jobId: "unrelated",
          requestId: "input-one",
          seq: 0,
          data: "",
          eof: false,
        })}\n`,
      );
      expect(await rejected.promise).toEqual({
        type: "input_result",
        jobId: "unrelated",
        requestId: "input-one",
        seq: 0,
        accepted: false,
        reason: "context_child_mismatch",
        nextInputSeq: null,
        stdinClosed: true,
      });
      child.write(
        `${JSON.stringify({ type: "invoke", operationId: "fixture.op", input: {}, outputs: [] })}\n`,
      );
      expect((await invoked.promise).parentJobId).toBe("real-parent");
      expect(failures).toEqual([]);
    } finally {
      context.close();
      child.destroy();
      native.close();
    }
  });

  test("caller cannot supply a parent identity, or address an unrelated child", async () => {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const refused = Promise.withResolvers<string>();
    const invoked: JobEvent[] = [];
    const context = new JobContext("real-parent", {
      invoke: (event) => invoked.push(event),
      command: async () => {
        throw new Error("unexpected_command");
      },
      failure: refused.resolve,
    });
    const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
    context.releaseChildFd();
    child.on("error", () => {});
    try {
      child.write(
        `${JSON.stringify({ type: "invoke", parentJobId: "forged-parent", operationId: "fixture.op", input: {}, outputs: [] })}\n`,
      );
      expect(await refused.promise).toBe("context_protocol_error");
      expect(invoked).toEqual([]);
    } finally {
      context.close();
      child.destroy();
      native.close();
    }
  });

  test("owner binds invocation once; closing private fd requests workload cancellation", async () => {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const invoked = Promise.withResolvers<Extract<JobEvent, { type: "invocation" }>>();
    const cancelled = Promise.withResolvers<string>();
    const context = new JobContext("real-parent", {
      invoke: invoked.resolve,
      command: async () => {},
      failure: cancelled.resolve,
    });
    const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
    context.releaseChildFd();
    child.on("data", () => {});
    child.on("error", () => {});
    try {
      child.write(
        `${JSON.stringify({ type: "invoke", operationId: "fixture.op", input: { request: "value" }, outputs: [] })}\n`,
      );
      const event = await invoked.promise;
      expect(event.parentJobId).toBe("real-parent");
      expect(event.input).toEqual({ request: "value" });
      context.bind(event.invocationId, "real-child");
      expect(() => context.bind(event.invocationId, "other-child")).toThrow("invocation_replayed");
      child.end();
      expect(await cancelled.promise).toBe("context_closed");
    } finally {
      context.close();
      child.destroy();
      native.close();
    }
  });
});
