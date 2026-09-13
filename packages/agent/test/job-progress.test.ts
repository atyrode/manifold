import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import {
  JOB_PROGRESS_INTERVAL_MS,
  type ServiceReply,
  type WorkerProgress,
} from "@manifold/protocol";
import { adoptPrivateSocket } from "../src/job-files.ts";
import { JobContext } from "../src/job-context.ts";
import {
  JobProgressCoalescer,
  type ObservedProgress,
  type ProgressClock,
} from "../src/job-progress.ts";

interface TestClock extends ProgressClock {
  advance(ms: number): void;
}

/** Drives the five-second window by hand; nothing here waits on a real one. */
function testClock(start = 1_700_000_000_000): TestClock {
  let now = start;
  // Runtime insertion and cancellation of object-identified timers, iterated in due order.
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance: (ms) => {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at))
        if (timer.at <= now && timers.delete(timer)) timer.fn();
    },
  };
}

test("flush releases the held line and close drops whatever follows it", () => {
  const clock = testClock();
  const published: ObservedProgress[] = [];
  const coalescer = new JobProgressCoalescer((progress) => published.push(progress), { clock });
  coalescer.report({ type: "progress", stage: "preparing" });
  clock.advance(0);
  coalescer.report({ type: "progress", stage: "at the model" });
  expect(published.map((progress) => progress.stage)).toEqual(["preparing"]);
  // A run that dies mid-window still owes an operator the word it died on.
  coalescer.flush();
  expect(published.map((progress) => progress.stage)).toEqual(["preparing", "at the model"]);
  coalescer.flush();
  expect(published).toHaveLength(2);
  coalescer.close();
  coalescer.report({ type: "progress", stage: "submitting" });
  clock.advance(JOB_PROGRESS_INTERVAL_MS);
  expect(published).toHaveLength(2);
});

describe.skipIf(process.platform !== "linux")("a workload's progress through its owner", () => {
  /** A real private owner channel with a workload end that writes newline-delimited JSON. */
  function channel(clock: TestClock) {
    const native = dlopen("libc.so.6", { dup: { args: [FFIType.i32], returns: FFIType.i32 } });
    const published: ObservedProgress[] = [];
    const frames: WorkerProgress[] = [];
    const failed = Promise.withResolvers<string>();
    const failures: string[] = [];
    const coalescer = new JobProgressCoalescer((progress) => published.push(progress), { clock });
    let awaited = 0;
    let notify: (() => void) | null = null;
    // A service call the test opens and closes by hand: in the brokered lane this callback is
    // the model call, and its duration is exactly what a stage must not queue behind.
    const calling = Promise.withResolvers<void>();
    const held = Promise.withResolvers<ServiceReply>();
    const context = new JobContext("drain-job", {
      invoke: () => {
        throw new Error("a stage is not an invocation");
      },
      command: async () => {
        throw new Error("a stage is not a command");
      },
      service: (request) => {
        calling.resolve();
        return held.promise.then((reply) => ({ ...reply, requestId: request.requestId }));
      },
      progress: (frame) => {
        frames.push(frame);
        coalescer.report(frame);
        if (frames.length >= awaited) {
          notify?.();
          notify = null;
        }
      },
      failure: (reason) => {
        failures.push(reason);
        failed.resolve(reason);
      },
    });
    const workload = adoptPrivateSocket(native.symbols.dup(context.childFd));
    context.releaseChildFd();
    workload.on("error", () => {});
    void failed.promise.catch(() => undefined);
    const replied = Promise.withResolvers<unknown>();
    let pendingText = "";
    workload.on("data", (chunk: Buffer) => {
      pendingText += chunk.toString();
      for (let end = pendingText.indexOf("\n"); end >= 0; end = pendingText.indexOf("\n")) {
        const parsed: unknown = JSON.parse(pendingText.slice(0, end));
        pendingText = pendingText.slice(end + 1);
        replied.resolve(parsed);
      }
    });
    return {
      published,
      frames,
      failures,
      failed: failed.promise,
      /** Resolves once the owner has entered the service callback and not yet left it. */
      calling: calling.promise,
      releaseService: () =>
        held.resolve({ type: "service_result", requestId: "held", ok: true, result: "done" }),
      replied: replied.promise,
      write: (line: unknown) => workload.write(`${JSON.stringify(line)}\n`),
      /** Resolves on the owner's own observation of the nth line, never on a duration. */
      observed: (count: number) => {
        if (frames.length >= count) return Promise.resolve();
        awaited = count;
        return new Promise<void>((resolve) => {
          notify = resolve;
        });
      },
      close: () => {
        context.close();
        workload.destroy();
        native.close();
      },
    };
  }

  test("twenty lines inside one window become one event carrying the newest stage", async () => {
    const clock = testClock();
    const start = clock.now();
    const owner = channel(clock);
    try {
      for (let line = 1; line <= 20; line++)
        owner.write({ type: "progress", stage: `preparing ${line}` });
      await owner.observed(20);
      // Nothing escapes while newer lines are still arriving: a queue of stale phases is
      // worse than one true one.
      expect(owner.published).toEqual([]);
      clock.advance(0);
      expect(owner.published).toEqual([{ stage: "preparing 20", at: start }]);

      clock.advance(1000);
      owner.write({
        type: "progress",
        stage: "at the model",
        message: "drawing evr_85c8994c",
        fraction: 0.25,
      });
      await owner.observed(21);
      clock.advance(JOB_PROGRESS_INTERVAL_MS - 1001);
      expect(owner.published).toHaveLength(1);
      clock.advance(1);
      expect(owner.published[1]).toEqual({
        stage: "at the model",
        message: "drawing evr_85c8994c",
        fraction: 0.25,
        // The owner's observation, not the release of the window it waited out.
        at: start + 1000,
      });
      expect(owner.failures).toEqual([]);
    } finally {
      owner.close();
    }
  });

  test("a stage is observed during an open service call, and a flood of them cannot fail it", async () => {
    const clock = testClock();
    const start = clock.now();
    const owner = channel(clock);
    try {
      owner.write({
        type: "service",
        requestId: "call-one",
        serviceId: "inference",
        operationId: "messages",
        input: {},
      });
      await owner.calling;
      // The owner is inside the model call now. A stage reported here is the whole point of
      // the feature, and it must not wait for the call it announces to finish.
      owner.write({ type: "progress", stage: "at the model" });
      await owner.observed(1);
      // Far more lines than the channel's 256 KiB input budget would retain: a run that
      // reports often must not have its channel failed and its job cancelled underneath it.
      const message = "d".repeat(256);
      for (let line = 0; line < 1000; line++)
        owner.write({ type: "progress", stage: "at the model", message });
      await owner.observed(1001);
      expect(owner.failures).toEqual([]);

      clock.advance(60000);
      expect(owner.published).toEqual([{ stage: "at the model", message, at: start }]);
      owner.releaseService();
      expect(await owner.replied).toEqual({
        type: "service_result",
        requestId: "call-one",
        ok: true,
        result: "done",
      });
      expect(owner.failures).toEqual([]);
    } finally {
      owner.close();
    }
  });

  test("a stage outside the schema fails the channel instead of reaching the hub", async () => {
    const clock = testClock();
    const owner = channel(clock);
    try {
      owner.write({ type: "progress", stage: "AT THE MODEL" });
      expect(await owner.failed).toBe("context_protocol_error");
      clock.advance(JOB_PROGRESS_INTERVAL_MS);
      expect(owner.published).toEqual([]);
    } finally {
      owner.close();
    }
  });
});
