import { describe, expect, test } from "bun:test";
import type { Gesture } from "@manifold/protocol";
import { createGestureStream } from "../src/presence/gesture-stream.ts";

function move(x: number, phase: "active" | "end" = "active"): Gesture {
  return { kind: "move", phase, elementId: "element", x, y: 0 };
}

describe("gesture stream", () => {
  test("sends the leading frame and coalesces the newest trailing frame", () => {
    let time = 0;
    const callbacks: Array<() => void> = [];
    let delay = -1;
    const sent: Gesture[] = [];
    const stream = createGestureStream({
      intervalMs: 30,
      now: () => time,
      schedule: (next, delayMs) => {
        callbacks.push(next);
        delay = delayMs;
        return 1;
      },
      cancel: () => undefined,
      send: (gesture) => sent.push(gesture),
    });

    stream.push(move(1));
    time = 5;
    stream.push(move(2));
    time = 10;
    stream.push(move(3));

    expect(sent).toEqual([move(1)]);
    expect(delay).toBe(25);
    time = 30;
    const flush = callbacks[0];
    if (flush === undefined) throw new Error("trailing flush was not scheduled");
    flush();
    expect(sent).toEqual([move(1), move(3)]);
  });

  test("end cancels a pending frame and sends immediately", () => {
    let time = 0;
    let cancelled = false;
    const sent: Gesture[] = [];
    const stream = createGestureStream({
      intervalMs: 30,
      now: () => time,
      schedule: () => 7,
      cancel: (handle) => {
        expect(handle).toBe(7);
        cancelled = true;
      },
      send: (gesture) => sent.push(gesture),
    });

    stream.push(move(1));
    time = 10;
    stream.push(move(2));
    stream.end(move(3, "end"));

    expect(cancelled).toBe(true);
    expect(sent).toEqual([move(1), move(3, "end")]);
  });

  test("cancel drops a pending trailing frame", () => {
    const sent: Gesture[] = [];
    const callbacks: Array<() => void> = [];
    const stream = createGestureStream({
      intervalMs: 30,
      now: () => 0,
      schedule: (next) => {
        callbacks.push(next);
        return 1;
      },
      cancel: () => undefined,
      send: (gesture) => sent.push(gesture),
    });

    stream.push(move(1));
    stream.push(move(2));
    stream.cancel();
    callbacks[0]?.();
    expect(sent).toEqual([move(1)]);
  });
});
