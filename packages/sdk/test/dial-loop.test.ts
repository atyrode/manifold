import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  LIVENESS_CLOSE_CODE,
  LivenessWatchdog,
  ReconnectBackoff,
  classifyEnvelope,
} from "../src/dial-loop.ts";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * THE SKELETON'S OWN CONTRACT, asserted where it is one thing rather than twice through the two
 * loops that use it (`instance-dial.test.ts`, `session-client.test.ts` cover it end to end).
 *
 * Both properties below were fixed once per copy back when there were two copies, which is the
 * whole reason this module exists: an envelope that discriminates "ignore" from "close" wrongly
 * breaks forward compatibility on both wires at once, and a timer that fires without re-checking
 * that it is still the live one closes a socket that is perfectly healthy.
 */

const KNOWN = (type: string): boolean => type === "welcome" || type === "ping";

describe("classifyEnvelope", () => {
  test("an unknown type is IGNORED and a known one is handed on", () => {
    // The forward-compatibility half: a newer peer saying things this end has no opinion about
    // must not be a protocol error, or every additive wire change becomes a dropped socket.
    expect(classifyEnvelope(JSON.stringify({ type: "gossip" }), KNOWN)).toEqual({
      kind: "unknown_type",
    });

    const envelope = classifyEnvelope(JSON.stringify({ type: "ping", extra: 1 }), KNOWN);
    expect(envelope).toEqual({ kind: "envelope", type: "ping", raw: { type: "ping", extra: 1 } });
  });

  test("anything without a readable type discriminator is MALFORMED, with its reason", () => {
    // Each detail is a distinct diagnosis, because "malformed" alone cannot tell a corrupt
    // socket from a peer that answered with a binary frame.
    expect(classifyEnvelope(new Uint8Array([1]), KNOWN)).toEqual({
      kind: "malformed",
      detail: "non-text frame",
    });
    expect(classifyEnvelope("{not json", KNOWN)).toEqual({
      kind: "malformed",
      detail: "invalid JSON",
    });
    for (const data of ["null", "42", '"welcome"', "[]", '{"type":7}', "{}"]) {
      expect(classifyEnvelope(data, KNOWN)).toEqual({
        kind: "malformed",
        detail: "missing type discriminator",
      });
    }
  });

  test("the vocabulary is the CALLER's: this module knows no types of its own", () => {
    // Which is what lets one skeleton serve two wires whose type tables share nothing.
    expect(classifyEnvelope(JSON.stringify({ type: "welcome" }), () => false)).toEqual({
      kind: "unknown_type",
    });
    expect(classifyEnvelope(JSON.stringify({ type: "gossip" }), () => true)).toEqual({
      kind: "envelope",
      type: "gossip",
      raw: { type: "gossip" },
    });
  });
});

/** Only the half of a socket a watchdog touches: it closes it, and nothing else. */
interface SocketDouble {
  closedWith: { code: number; reason: string } | null;
  close(code: number, reason: string): void;
}

function socketDouble(): SocketDouble & WebSocket {
  const double: SocketDouble = {
    closedWith: null,
    close(code, reason) {
      double.closedWith = { code, reason };
    },
  };
  return double as unknown as SocketDouble & WebSocket;
}

describe("LivenessWatchdog", () => {
  test("silence past the deadline closes the socket locally", () => {
    vi.useFakeTimers();
    const socket = socketDouble();
    const watchdog = new LivenessWatchdog({
      timeoutMs: 1_000,
      reason: "peer silent past deadline",
      current: () => socket,
    });

    watchdog.arm(socket);
    vi.advanceTimersByTime(999);
    expect(socket.closedWith).toBeNull();
    vi.advanceTimersByTime(2);
    expect(socket.closedWith).toEqual({
      code: LIVENESS_CLOSE_CODE,
      reason: "peer silent past deadline",
    });
  });

  test("a rearm and a supersede both fence the timer they leave behind", () => {
    /*
      clearTimeout cannot retract a callback the event loop has already queued, so both checks
      are load-bearing: proof of life on a live socket must not close it a beat later, and a
      socket the loop has already replaced must not be closed by the timer of its predecessor.
    */
    vi.useFakeTimers();
    const first = socketDouble();
    let live: WebSocket | null = first;
    const watchdog = new LivenessWatchdog({
      timeoutMs: 1_000,
      reason: "peer silent past deadline",
      current: () => live,
    });

    watchdog.arm(first);
    vi.advanceTimersByTime(900);
    watchdog.arm(first); // a frame arrived: the deadline restarts, it does not stack
    vi.advanceTimersByTime(900);
    expect(first.closedWith).toBeNull();

    const second = socketDouble();
    live = second;
    watchdog.arm(second);
    vi.advanceTimersByTime(1_001);
    expect(first.closedWith).toBeNull();
    expect(second.closedWith?.code).toBe(LIVENESS_CLOSE_CODE);

    watchdog.arm(second);
    watchdog.clear();
    vi.advanceTimersByTime(10_000);
    expect(second.closedWith?.code).toBe(LIVENESS_CLOSE_CODE); // the cleared timer added nothing
  });
});

describe("ReconnectBackoff", () => {
  test("attempts count the retries, and a working link resets the series", () => {
    // `attempts === 0` is what the pool reads to decide whether a channel is `connecting` or
    // `reconnecting`, so the counter is a contract rather than an implementation detail.
    vi.useFakeTimers();
    let dials = 0;
    const backoff = new ReconnectBackoff({
      baseMs: 100,
      capMs: 400,
      dial: () => {
        dials += 1;
      },
    });

    expect(backoff.attempts).toBe(0);
    expect(backoff.pending).toBe(false);

    backoff.schedule();
    expect(backoff.attempts).toBe(1);
    expect(backoff.pending).toBe(true);
    vi.advanceTimersByTime(400);
    expect(dials).toBe(1);
    expect(backoff.pending).toBe(false);

    backoff.schedule();
    vi.advanceTimersByTime(400);
    expect(backoff.attempts).toBe(2);
    expect(dials).toBe(2);

    backoff.reset();
    expect(backoff.attempts).toBe(0);
  });

  test("each delay lands inside its attempt's half-jitter window, and under the cap", () => {
    vi.useFakeTimers();
    let dials = 0;
    const backoff = new ReconnectBackoff({
      baseMs: 100,
      capMs: 400,
      dial: () => {
        dials += 1;
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // The window is [0.5, 1.0] × min(cap, base·2^attempt): nothing may fire before half the
      // ceiling, and everything must have fired by the ceiling — which is also the assertion
      // that the cap holds, since attempts 2 and up would otherwise run past 400ms.
      const ceiling = Math.min(400, 100 * 2 ** attempt);
      backoff.schedule();
      vi.advanceTimersByTime(ceiling / 2 - 1);
      expect(dials).toBe(attempt);
      vi.advanceTimersByTime(ceiling / 2 + 1);
      expect(dials).toBe(attempt + 1);
    }
  });

  test("a cancelled retry never dials, even once its delay has passed", () => {
    // The teardown path: a connection retired while a redial was owed must stay retired.
    vi.useFakeTimers();
    let dials = 0;
    const backoff = new ReconnectBackoff({
      baseMs: 100,
      capMs: 100,
      dial: () => {
        dials += 1;
      },
    });

    backoff.schedule();
    backoff.cancel();
    expect(backoff.pending).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(dials).toBe(0);
    // Cancelling does not forgive the attempt: the next delay carries on from where it was.
    expect(backoff.attempts).toBe(1);
  });
});
