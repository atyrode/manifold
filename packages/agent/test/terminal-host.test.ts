import { expect, test } from "bun:test";
import type { TerminalHostEvent } from "@manifold/protocol";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  matching(predicate: (event: TerminalHostEvent) => boolean): Promise<TerminalHostEvent>;
}

/** One synchronous in-memory connection; `next` resolves on the next event of a type. */
function openPeer(host: TerminalHost): Peer {
  const events: TerminalHostEvent[] = [];
  const waiters: Array<{
    predicate: (event: TerminalHostEvent) => boolean;
    resolve: (event: TerminalHostEvent) => void;
  }> = [];
  const peer: Peer = {
    events,
    closed: false,
    session: host.open({
      write(event) {
        events.push(event);
        const index = waiters.findIndex((waiter) => waiter.predicate(event));
        if (index !== -1) waiters.splice(index, 1)[0]?.resolve(event);
        return true;
      },
      close() {
        peer.closed = true;
      },
    }),
    next(type) {
      return peer.matching((event) => event.type === type);
    },
    matching(predicate) {
      const seen = events.find(predicate);
      if (seen !== undefined) return Promise.resolve(seen);
      const { promise, resolve } = Promise.withResolvers<TerminalHostEvent>();
      waiters.push({ predicate, resolve });
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

async function terminalEvent(
  peer: Peer,
  predicate: (event: TerminalHostEvent) => boolean,
  timeoutMs = 5_000,
): Promise<TerminalHostEvent> {
  // These integration deadlines exercise real procfs/PTY timer behavior, not guessed sleeps.
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      peer.matching(predicate),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("terminal event deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.platform !== "linux")(
  "Linux cwd sampling follows output-idle and silent cd; retained restart preserves launch and resets snapshot",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-terminal-cwd-"));
    const idle = join(root, "idle");
    const quiet = join(root, "quiet");
    mkdirSync(idle);
    mkdirSync(quiet);
    const host = new TerminalHost({
      shellCommand: [
        BASH,
        "--norc",
        "-c",
        'stty -echo; while IFS= read -r line; do eval "$line"; done',
      ],
    });
    const peer = openPeer(host);
    const input = (text: string) =>
      peer.session.deliver({
        type: "input",
        terminalId: "cwd",
        data: Buffer.from(`${text}\n`).toString("base64"),
      });
    try {
      peer.session.deliver({ type: "attach" });
      peer.session.deliver({
        type: "create",
        terminalId: "cwd",
        cols: 80,
        rows: 24,
        cwd: root,
        env: { ORIGINAL_VALUE: "kept", MANIFOLD_TOKEN: "old-test-grant" },
      });
      await terminalEvent(peer, (event) => event.type === "terminal_cwd" && event.cwd === root);
      input(`cd '${idle}'; printf 'OLD_SCREEN\\n'`);
      await terminalEvent(
        peer,
        (event) => event.type === "terminal_cwd" && event.cwd === idle,
        2_000,
      );
      input(`cd '${quiet}'`);
      await terminalEvent(peer, (event) => event.type === "terminal_cwd" && event.cwd === quiet);
      expect(host.status().terminals).toMatchObject([{ terminalId: "cwd", cwd: quiet }]);
      input("exit 7");
      await peer.next("exited");
      peer.events.length = 0;
      peer.session.deliver({
        type: "terminal_restart",
        terminalId: "cwd",
        cwd: root,
        create: {
          cols: 10,
          rows: 10,
          env: { ORIGINAL_VALUE: "altered", MANIFOLD_TOKEN: "fresh-test-grant" },
          program: { argv: ["/not/the/original/program"] },
        },
      });
      expect(await peer.next("terminal_restarted")).toEqual({
        type: "terminal_restarted",
        terminalId: "cwd",
        cwd: quiet,
      });
      expect(host.status().terminals).toMatchObject([
        { terminalId: "cwd", cols: 80, rows: 24, alive: true, cwd: quiet },
      ]);
      input('printf "NEW_SCREEN:%s:%s:%s\\n" "$PWD" "$ORIGINAL_VALUE" "$MANIFOLD_TOKEN"');
      await terminalEvent(
        peer,
        (event) =>
          event.type === "output" &&
          Buffer.from(event.data, "base64")
            .toString()
            .includes(`NEW_SCREEN:${quiet}:kept:fresh-test-grant`),
      );
      peer.session.deliver({ type: "snapshot_request", terminalId: "cwd" });
      const snapshot = await peer.next("snapshot");
      if (snapshot.type !== "snapshot") throw new Error("snapshot required");
      const screen = Buffer.from(snapshot.data, "base64").toString();
      expect(screen).toContain(`NEW_SCREEN:${quiet}:kept:fresh-test-grant`);
      expect(screen).not.toContain("OLD_SCREEN");
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "running restart escalates without publishing the old exit, then falls back through original cwd and HOME",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "manifold-terminal-restart-"));
    const original = join(root, "original");
    const current = join(root, "current");
    mkdirSync(original);
    mkdirSync(current);
    const host = new TerminalHost({
      shutdownGraceMs: 25,
      shellCommand: [
        BASH,
        "--norc",
        "-c",
        'trap "" TERM HUP; stty -echo; printf "READY\\n"; while :; do IFS= read -r line && eval "$line"; done',
      ],
    });
    const peer = openPeer(host);
    try {
      peer.session.deliver({ type: "attach" });
      peer.session.deliver({
        type: "create",
        terminalId: "running",
        cols: 80,
        rows: 24,
        cwd: original,
        env: { HOME: root },
      });
      await terminalEvent(
        peer,
        (event) =>
          event.type === "output" && Buffer.from(event.data, "base64").toString().includes("READY"),
      );
      peer.session.deliver({
        type: "input",
        terminalId: "running",
        data: Buffer.from(`cd '${current}'; printf 'MOVED\\n'\n`).toString("base64"),
      });
      await terminalEvent(peer, (event) => event.type === "terminal_cwd" && event.cwd === current);
      rmSync(current, { recursive: true });
      peer.events.length = 0;
      peer.session.deliver({ type: "snapshot_request", terminalId: "running" });
      peer.session.deliver({ type: "terminal_restart", terminalId: "running" });
      expect(
        await terminalEvent(peer, (event) => event.type === "terminal_restarted", 2_000),
      ).toEqual({
        type: "terminal_restarted",
        terminalId: "running",
        cwd: original,
        fallback: "original",
      });
      expect(peer.events.some((event) => event.type === "exited")).toBe(false);
      expect(peer.events.some((event) => event.type === "snapshot")).toBe(false);
      await terminalEvent(
        peer,
        (event) =>
          event.type === "output" && Buffer.from(event.data, "base64").toString().includes("READY"),
      );
      rmSync(original, { recursive: true });
      peer.events.length = 0;
      peer.session.deliver({ type: "terminal_restart", terminalId: "running" });
      expect(
        await terminalEvent(peer, (event) => event.type === "terminal_restarted", 2_000),
      ).toEqual({
        type: "terminal_restarted",
        terminalId: "running",
        cwd: root,
        fallback: "home",
      });
      expect(peer.events.some((event) => event.type === "exited")).toBe(false);
      expect(host.terminalCount).toBe(1);
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("replacement owner restores original program; explicit legacy restoration uses only the default shell", async () => {
  const host = new TerminalHost({
    shellCommand: [BASH, "--norc", "-c", "printf 'DEFAULT_SHELL\\n'; exec cat"],
  });
  const peer = openPeer(host);
  try {
    peer.session.deliver({ type: "attach" });
    peer.session.deliver({
      type: "terminal_restart",
      terminalId: "recovered",
      cwd: tmpdir(),
      create: {
        cols: 90,
        rows: 30,
        env: {},
        program: { argv: [BASH, "-c", "printf 'ORIGINAL_PROGRAM\\n'; exec cat"] },
      },
    });
    expect(await peer.next("terminal_restarted")).toMatchObject({
      terminalId: "recovered",
      cwd: tmpdir(),
    });
    await terminalEvent(
      peer,
      (event) =>
        event.type === "output" &&
        Buffer.from(event.data, "base64").toString().includes("ORIGINAL_PROGRAM"),
    );
    peer.session.deliver({
      type: "terminal_restart",
      terminalId: "legacy",
      cwd: tmpdir(),
      noRecipe: true,
      create: { cols: 80, rows: 24, env: {}, program: { argv: ["/should/not/run"] } },
    });
    expect(
      await terminalEvent(
        peer,
        (event) => event.type === "terminal_restarted" && event.terminalId === "legacy",
      ),
    ).toEqual({
      type: "terminal_restarted",
      terminalId: "legacy",
      cwd: tmpdir(),
      fallback: "no_recipe",
    });
    await terminalEvent(
      peer,
      (event) =>
        event.type === "output" &&
        event.terminalId === "legacy" &&
        Buffer.from(event.data, "base64").toString().includes("DEFAULT_SHELL"),
    );
  } finally {
    await host.shutdown();
  }
}, 10_000);
