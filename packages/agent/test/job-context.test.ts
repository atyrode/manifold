import { describe, expect, test } from "bun:test";
import { adoptPrivateSocket } from "../src/job-files.ts";
import { dlopen, FFIType } from "bun:ffi";
import { JobContext } from "../src/job-context.ts";
import type { JobEvent } from "@manifold/protocol";

describe.skipIf(process.platform !== "linux")("parent-bound private invocation channel", () => {
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

  test("an unrelated child input receives a correlated rejection without closing the parent's context", async () => {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const rejected = Promise.withResolvers<unknown>();
    const invoked = Promise.withResolvers<Extract<JobEvent, { type: "invocation" }>>();
    const failures: string[] = [];
    const context = new JobContext("real-parent", {
      invoke: invoked.resolve,
      command: async () => { throw new Error("unrelated child must not reach owner"); },
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
      child.write(`${JSON.stringify({
        type: "input", jobId: "unrelated", requestId: "input-one", seq: 0, data: "", eof: false,
      })}\n`);
      expect(await rejected.promise).toEqual({
        type: "input_result", jobId: "unrelated", requestId: "input-one", seq: 0,
        accepted: false, reason: "context_child_mismatch", nextInputSeq: null, stdinClosed: true,
      });
      child.write(`${JSON.stringify({ type: "invoke", operationId: "fixture.op", input: {}, outputs: [] })}\n`);
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
