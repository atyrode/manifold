import { expect, test } from "bun:test";
import type { TerminalHostEvent } from "@manifold/protocol";
import { FrameReader, FrameTooLargeError, FrameWriter } from "../src/ipc-framing.ts";
import { TerminalHost, type TerminalHostSession } from "../src/terminal-host.ts";

/**
 * The PTY owner's own contracts (issue #278), exercised directly on the seam: which
 * connection may mutate, when a maintenance stop is legal, what a destructive stop still
 * guarantees, and the bounds every peer is parsed under.
 */

const BASH = Bun.which("bash") ?? "/bin/sh";

interface Peer {
  readonly events: TerminalHostEvent[];
  readonly session: TerminalHostSession;
  closed: boolean;
  next(type: TerminalHostEvent["type"]): Promise<TerminalHostEvent>;
}

/** One synchronous in-memory connection; `next` resolves on the next event of a type. */
function openPeer(host: TerminalHost): Peer {
  const events: TerminalHostEvent[] = [];
  const waiters: Array<{ type: string; resolve: (event: TerminalHostEvent) => void }> = [];
  const peer: Peer = {
    events,
    closed: false,
    session: host.open({
      write(event) {
        events.push(event);
        const index = waiters.findIndex((waiter) => waiter.type === event.type);
        if (index !== -1) waiters.splice(index, 1)[0]?.resolve(event);
        return true;
      },
      close() {
        peer.closed = true;
      },
    }),
    next(type) {
      const seen = events.find((event) => event.type === type);
      if (seen !== undefined) return Promise.resolve(seen);
      const { promise, resolve } = Promise.withResolvers<TerminalHostEvent>();
      waiters.push({ type, resolve });
      return promise;
    },
  };
  return peer;
}

test("only the seat holder mutates; observers read status and are cut on a mutation", async () => {
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  try {
    const transport = openPeer(host);
    transport.session.deliver({ type: "attach" });
    expect(transport.events[0]).toMatchObject({
      type: "attached",
      terminalHostId: host.terminalHostId,
    });
    transport.session.deliver({ type: "create", terminalId: "t", cols: 80, rows: 24, env: {} });
    expect(transport.events[1]).toEqual({ type: "created", terminalId: "t" });

    const observer = openPeer(host);
    observer.session.deliver({ type: "status_request" });
    expect(observer.events[0]).toMatchObject({
      type: "status",
      transportAttached: true,
      draining: false,
      terminals: [expect.objectContaining({ terminalId: "t", alive: true })],
    });
    expect(observer.closed).toBe(false);

    observer.session.deliver({ type: "attach" });
    expect(observer.events[1]).toEqual({ type: "attach_refused", reason: "transport_attached" });
    expect(observer.closed).toBe(false); // refused, but still a welcome observer

    observer.session.deliver({ type: "kill", terminalId: "t" });
    expect(observer.events[2]).toMatchObject({ type: "error", code: "not_attached" });
    expect(observer.closed).toBe(true);
    expect(host.terminalCount).toBe(1);

    // Releasing the seat hands it to the next claimant; the PTY is untouched by either.
    transport.session.detach();
    const successor = openPeer(host);
    successor.session.deliver({ type: "attach" });
    expect(successor.events[0]).toMatchObject({
      type: "attached",
      terminals: [expect.objectContaining({ terminalId: "t", alive: true })],
    });
  } finally {
    await host.shutdown();
  }
});

test("maintenance shutdown is refused by name until drained AND empty, then accepted", async () => {
  let accepted = 0;
  const host = new TerminalHost({
    shellCommand: [BASH, "--norc", "-c", "read -r _; exit 3"],
    onMaintenanceShutdown: () => {
      accepted += 1;
    },
  });
  const transport = openPeer(host);
  transport.session.deliver({ type: "attach" });
  transport.session.deliver({ type: "create", terminalId: "held", cols: 80, rows: 24, env: {} });
  const maintenance = openPeer(host);

  maintenance.session.deliver({ type: "shutdown_request" });
  expect(maintenance.events.at(-1)).toEqual({
    type: "shutdown_refused",
    reason: "not_draining",
    terminalIds: [],
  });

  transport.session.deliver({ type: "drain", requestId: "d", draining: true });
  maintenance.session.deliver({ type: "shutdown_request" });
  expect(maintenance.events.at(-1)).toEqual({
    type: "shutdown_refused",
    reason: "terminals_retained",
    terminalIds: ["held"],
  });

  // The PTY exits; its record is RETAINED until the transport acknowledges — still a refusal.
  transport.session.deliver({
    type: "input",
    terminalId: "held",
    data: Buffer.from("go\n").toString("base64"),
  });
  const exited = await transport.next("exited");
  expect(exited).toEqual({ type: "exited", terminalId: "held", exitCode: 3 });
  maintenance.session.deliver({ type: "shutdown_request" });
  expect(maintenance.events.at(-1)).toMatchObject({
    reason: "terminals_retained",
    terminalIds: ["held"],
  });

  transport.session.deliver({ type: "kill", terminalId: "held" }); // acknowledge the exit
  expect(host.terminalCount).toBe(0);
  maintenance.session.deliver({ type: "shutdown_request" });
  expect(maintenance.events.at(-1)).toEqual({
    type: "shutting_down",
    terminalHostId: host.terminalHostId,
  });
  expect(accepted).toBe(1);
  expect(transport.closed).toBe(true);
  expect(maintenance.closed).toBe(true);
}, 10000);

test("an exit with no transport is retained and reported to the next seat holder", async () => {
  const exited = Promise.withResolvers<void>();
  const host = new TerminalHost({
    shellCommand: [BASH, "--norc", "-c", "exit 9"],
    sink(record) {
      if (record.evt === "exited") exited.resolve();
    },
  });
  try {
    const first = openPeer(host);
    first.session.deliver({ type: "attach" });
    first.session.deliver({ type: "create", terminalId: "gone", cols: 80, rows: 24, env: {} });
    first.session.detach(); // the transport dies before the PTY does
    await exited.promise;
    expect(first.events.some((event) => event.type === "exited")).toBe(false);
    expect(host.terminalCount).toBe(1);

    const second = openPeer(host);
    second.session.deliver({ type: "attach" });
    expect(second.events[0]).toMatchObject({
      type: "attached",
      terminals: [{ terminalId: "gone", cols: 80, rows: 24, alive: false, exitCode: 9 }],
    });
  } finally {
    await host.shutdown();
  }
}, 10000);

test("destructive shutdown escalates a signal-trapping PTY after its grace window", async () => {
  const host = new TerminalHost({
    shutdownGraceMs: 25,
    shellCommand: [BASH, "--norc", "-c", "trap '' TERM HUP; while :; do sleep 1; done"],
  });
  const transport = openPeer(host);
  transport.session.deliver({ type: "attach" });
  transport.session.deliver({
    type: "create",
    terminalId: "trap-signals",
    cols: 80,
    rows: 24,
    env: {},
  });
  expect(transport.events.at(-1)).toEqual({ type: "created", terminalId: "trap-signals" });

  const startedAt = performance.now();
  await host.shutdown();
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  expect(host.terminalCount).toBe(0);
  expect(transport.closed).toBe(true);
}, 5000);

test("frames are bounded: a partial line accumulates, an oversize line is refused, a stalled peer overflows", () => {
  const reader = new FrameReader(16);
  expect(reader.push(new TextEncoder().encode('{"a":1'))).toEqual([]);
  expect(reader.push(new TextEncoder().encode('}\n{"b"'))).toEqual(['{"a":1}']);
  expect(reader.push(new TextEncoder().encode(":2}\n"))).toEqual(['{"b":2}']);
  expect(() => reader.push(new TextEncoder().encode("x".repeat(17)))).toThrow(FrameTooLargeError);

  let overflowed = 0;
  const accepted: number[] = [];
  const writer = new FrameWriter(
    {
      write(data) {
        accepted.push(data.byteLength);
        return 0; // the kernel takes nothing: the peer is not reading
      },
      end() {},
    },
    () => {
      overflowed += 1;
    },
    32,
  );
  expect(writer.send({ type: "ping" })).toBe(true);
  expect(writer.backlog).toBe(16);
  expect(writer.send({ type: "ping" })).toBe(true);
  expect(writer.send({ type: "ping" })).toBe(false); // 48 > 32: sick peer
  expect(overflowed).toBe(1);
  expect(writer.send({ type: "ping" })).toBe(false); // stays refused after overflow
});
