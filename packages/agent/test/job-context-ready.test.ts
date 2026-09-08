import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { ServiceReadyResultSchema, type ServiceReadyResult } from "@manifold/protocol";
import { JobContext } from "../src/job-context.ts";
import { adoptPrivateSocket } from "../src/job-files.ts";
import { FrameReader } from "../src/ipc-framing.ts";

function channel(callbacks: Pick<ConstructorParameters<typeof JobContext>[1], "serviceReady"> = {}) {
  const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
  const failed = Promise.withResolvers<string>();
  const context = new JobContext("runtime-child", {
    invoke: () => { throw new Error("readiness must not invoke a child"); },
    command: async () => { throw new Error("readiness must not issue a job command"); },
    failure: failed.resolve,
    ...callbacks,
  });
  const child = adoptPrivateSocket(native.symbols.dup(context.childFd));
  context.releaseChildFd();
  const reader = new FrameReader();
  const results: ServiceReadyResult[] = [];
  const waiters: ((value: ServiceReadyResult) => void)[] = [];
  child.on("data", (bytes: Buffer) => {
    for (const line of reader.push(bytes)) {
      const value = ServiceReadyResultSchema.parse(JSON.parse(line));
      const resolve = waiters.shift();
      if (resolve) resolve(value);
      else results.push(value);
    }
  });
  child.on("error", () => {});
  return {
    context, child, failed: failed.promise,
    send(value: unknown) { child.write(`${JSON.stringify(value)}\n`); },
    next(): Promise<ServiceReadyResult> {
      const value = results.shift();
      if (value) return Promise.resolve(value);
      const result = Promise.withResolvers<ServiceReadyResult>();
      waiters.push(result.resolve);
      return result.promise;
    },
    close() { context.close(); child.destroy(); native.close(); },
  };
}

describe.skipIf(process.platform !== "linux")("owner-acknowledged native service readiness", () => {
  test("an ordinary job cannot claim runtime-service authority; missing admission callback refuses", async () => {
    const c = channel();
    try {
      c.send({ type: "service_ready", requestId: "ready-1", port: 4321 });
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "service_unavailable" });
      c.send({ type: "service_ready", requestId: "ready-2", port: 4322 });
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-2", ok: false, refusal: "service_ready_duplicate" });
      expect(c.context.invocations.size).toBe(0);
    } finally { c.close(); }
  });

  test("readiness success follows the owner callback and only one queued attempt reaches that callback", async () => {
    const entered = Promise.withResolvers<number>();
    const allow = Promise.withResolvers<void>();
    const ports: number[] = [];
    const c = channel({ serviceReady: async (port) => {
      ports.push(port);
      entered.resolve(port);
      await allow.promise;
    } });
    try {
      c.send({ type: "service_ready", requestId: "ready-1", port: 4321 });
      c.send({ type: "service_ready", requestId: "ready-2", port: 4322 });
      expect(await entered.promise).toBe(4321);
      allow.resolve();
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-1", ok: true });
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-2", ok: false, refusal: "service_ready_duplicate" });
      expect(ports).toEqual([4321]);
    } finally { allow.resolve(); c.close(); }
  });

  test("owner callback failure returns a safe negative acknowledgment, never raw exception data", async () => {
    const c = channel({ serviceReady: async () => { throw new Error("private owner detail"); } });
    try {
      c.send({ type: "service_ready", requestId: "ready-1", port: 4321 });
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "service_unavailable" });
    } finally { c.close(); }
  });

  test("cancellation while the owner is admitting readiness prevents a late positive acknowledgment", async () => {
    const entered = Promise.withResolvers<void>();
    const allow = Promise.withResolvers<void>();
    const c = channel({ serviceReady: async () => { entered.resolve(); await allow.promise; } });
    try {
      c.send({ type: "service_ready", requestId: "ready-1", port: 4321 });
      await entered.promise;
      c.context.abortServices();
      allow.resolve();
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "service_closed" });
    } finally { allow.resolve(); c.close(); }
  });

  test("already-cancelled owner cannot invoke the admission callback", async () => {
    let called = false;
    const c = channel({ serviceReady: async () => { called = true; } });
    try {
      c.context.abortServices();
      c.send({ type: "service_ready", requestId: "ready-1", port: 4321 });
      expect(await c.next()).toEqual({ type: "service_ready_result", requestId: "ready-1", ok: false, refusal: "service_closed" });
      expect(called).toBe(false);
    } finally { c.close(); }
  });

  test("injected identities and invalid ports are protocol failures before owner admission", async () => {
    for (const request of [
      { type: "service_ready", requestId: "ready-1", port: 4321, serviceId: "unrelated" },
      { type: "service_ready", requestId: "ready-1", port: 0 },
    ]) {
      let called = false;
      const c = channel({ serviceReady: async () => { called = true; } });
      try {
        c.send(request);
        expect(await c.failed).toBe("context_protocol_error");
        expect(called).toBe(false);
      } finally { c.close(); }
    }
  });
});
