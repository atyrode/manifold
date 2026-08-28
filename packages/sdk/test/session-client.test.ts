import { afterEach, describe, expect, test, vi } from "bun:test";
import { z } from "zod";
import { PROTOCOL_VERSION, type SceneElement, type ServerMessage } from "@manifold/protocol";
import { SessionClient, type SceneUpdateRejection } from "@manifold/sdk";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Minimal in-memory WebSocket double implementing exactly the surface SessionClient
 * uses. Lets unit tests drive the full state machine without a server process.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  closedWith: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** Boundary-validated views of frames the fake socket captured. */
const SentFrameSchema = z.looseObject({ type: z.string() });
const SceneUpdateFrameSchema = z.looseObject({
  type: z.literal("scene_update"),
  updateId: z.string(),
  epoch: z.string(),
  baseRev: z.number(),
  elements: z.array(z.looseObject({ id: z.string() })),
});

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((f) => SentFrameSchema.parse(JSON.parse(f)).type);
}

type SceneUpdateFrame = z.infer<typeof SceneUpdateFrameSchema>;

function sceneUpdateFrames(socket: FakeSocket): SceneUpdateFrame[] {
  const updates: SceneUpdateFrame[] = [];
  for (const frame of socket.sent) {
    const parsed = SceneUpdateFrameSchema.safeParse(JSON.parse(frame));
    if (parsed.success) updates.push(parsed.data);
  }
  return updates;
}

function element(id: string, version: number, versionNonce = 0): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    version,
    versionNonce,
    isDeleted: false,
  };
}

const INIT: ServerMessage = {
  type: "init",
  protocolVersion: PROTOCOL_VERSION,
  epoch: "e1",
  rev: 5,
  elements: [element("srv", 3)],
  self: { id: "me", kind: "human", name: "alex", color: "#112233" },
  selfConnId: "conn-me",
  selfCaps: ["*"],
  roster: [],
  sessions: [],
};

interface ClientHarnessOptions {
  reconnect?: boolean;
  backoffCapMs?: number;
}

interface ClientHarness {
  client: SessionClient;
  socket: FakeSocket;
  connection: Promise<void>;
}

function dialing(options: ClientHarnessOptions = {}): ClientHarness {
  FakeSocket.instances = [];
  const client = new SessionClient({
    url: "ws://test/ws/session",
    padId: "pad1",
    token: "tok",
    reconnect: options.reconnect ?? false,
    ...(options.backoffCapMs !== undefined ? { backoffCapMs: options.backoffCapMs } : {}),
    // Test double implements the full surface SessionClient touches; a runtime check is
    // meaningless here, hence the deliberate unchecked cast.
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  const connection = client.connect();
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket dialed");
  return { client, socket, connection };
}

function connected(options: ClientHarnessOptions = {}): ClientHarness {
  const harness = dialing(options);
  harness.socket.open();
  harness.socket.receive(INIT);
  return harness;
}

describe("handshake", () => {
  test("first frame is a valid join carrying the protocol version", () => {
    const { socket } = connected();
    const JoinSchema = z.looseObject({ type: z.string(), protocolVersion: z.number() });
    const first = JoinSchema.parse(JSON.parse(socket.sent[0] ?? "{}"));
    expect(first.type).toBe("join");
    expect(first.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("init adopts epoch, rev, scene, and the assigned connection id", () => {
    const { client } = connected();
    expect(client.epoch).toBe("e1");
    expect(client.rev).toBe(5);
    expect(client.scene.get("srv")?.version).toBe(3);
    expect(client.selfConnId).toBe("conn-me");
    expect(client.status).toBe("open");
  });
});

describe("connection lifecycle", () => {
  test("sends a keepalive ping every 45 seconds while open", () => {
    vi.useFakeTimers();
    const { client, socket } = connected();

    vi.advanceTimersByTime(45_000);
    expect(sentTypes(socket)).toEqual(["join", "ping"]);

    vi.advanceTimersByTime(90_000);
    expect(sentTypes(socket)).toEqual(["join", "ping", "ping", "ping"]);
    client.close();
  });

  test("stops keepalive pings after client or socket close", () => {
    vi.useFakeTimers();
    const first = connected();
    vi.advanceTimersByTime(45_000);
    first.client.close();
    vi.advanceTimersByTime(90_000);
    expect(sentTypes(first.socket)).toEqual(["join", "ping"]);

    const second = connected();
    vi.advanceTimersByTime(45_000);
    second.socket.close();
    vi.advanceTimersByTime(90_000);
    expect(sentTypes(second.socket)).toEqual(["join", "ping"]);
  });

  test("4403 is terminal, rejects connect with the reason, and does not redial", async () => {
    vi.useFakeTimers();
    const { client, socket, connection } = dialing({ reconnect: true, backoffCapMs: 0 });
    socket.open();
    socket.close(4403, "revoked");

    await expect(connection).rejects.toThrow("revoked");
    vi.runAllTimers();
    expect(client.status).toBe("closed");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("1006 remains reconnectable", async () => {
    vi.useFakeTimers();
    const { client, socket, connection } = dialing({ reconnect: true, backoffCapMs: 0 });
    socket.open();
    socket.close(1006, "abnormal");
    expect(client.status).toBe("reconnecting");

    vi.runAllTimers();
    expect(FakeSocket.instances).toHaveLength(2);
    const replacement = FakeSocket.instances.at(-1);
    if (!replacement || replacement === socket) throw new Error("no replacement socket");
    replacement.open();
    replacement.receive(INIT);
    await connection;
    expect(client.status).toBe("open");
    client.close();
  });

  test("close then immediate connect fences the already-scheduled reconnect callback", async () => {
    vi.useFakeTimers();
    const { client, socket } = connected({ reconnect: true, backoffCapMs: 0 });
    socket.close(1006, "abnormal");
    client.close();
    const connection = client.connect();

    // Deterministically run anything left in the obsolete timer queue.
    vi.runAllTimers();
    const liveSockets = FakeSocket.instances.filter((candidate) => candidate.readyState !== 3);
    expect(liveSockets).toHaveLength(1);
    const replacement = liveSockets[0];
    if (!replacement) throw new Error("no live replacement socket");
    replacement.open();
    replacement.receive(INIT);
    await connection;
    client.close();
  });

  test("dial closes the prior socket and ignores its late open and message callbacks", async () => {
    const { client, socket: first, connection: firstConnection } = dialing();
    const secondConnection = client.connect();
    const second = FakeSocket.instances.at(-1);
    if (!second || second === first) throw new Error("no superseding socket");

    expect(first.closedWith?.code).toBe(1000);
    first.onopen?.();
    first.receive({ ...INIT, epoch: "stale", elements: [element("stale", 1)] });
    expect(first.sent).toHaveLength(0);
    expect(client.epoch).toBe("");

    second.open();
    second.receive(INIT);
    await Promise.all([firstConnection, secondConnection]);
    expect(client.epoch).toBe("e1");
    client.close();
  });
});

describe("scene flow", () => {
  test("updateScene applies optimistically and stamps the epoch fence", () => {
    const { client, socket } = connected();
    client.updateScene([element("a", 1)]);
    expect(client.scene.has("a")).toBe(true);
    const last = socket.sent.at(-1);
    if (last === undefined) throw new Error("nothing sent");
    const sent = SceneUpdateFrameSchema.parse(JSON.parse(last));
    expect(sent.epoch).toBe("e1");
    expect(sent.baseRev).toBe(5);
  });

  test("first init rebases an optimistic edit into the adopted epoch", () => {
    const { client, socket } = dialing();
    client.updateScene([element("early", 1)]);

    socket.open();
    socket.receive(INIT);

    expect(client.scene.has("early")).toBe(true);
    const updates = sceneUpdateFrames(socket);
    expect(updates.some((frame) => frame.epoch === "e1" && frame.elements[0]?.id === "early")).toBe(
      true,
    );
  });

  test("updateScene chunks by count and returns every frame's updateId", () => {
    const { client, socket } = connected();
    const elements = Array.from({ length: 200 }, (_, index) => element(`bulk-${index}`, 1));

    const updateIds = client.updateScene(elements);

    const updates = sceneUpdateFrames(socket);
    expect(updates).toHaveLength(2);
    expect(updates.map((frame) => frame.elements.length)).toEqual([128, 72]);
    expect(updateIds).toEqual(updates.map((frame) => frame.updateId));
    expect(client.scene.size).toBe(201);
    expect(client.scene.has("bulk-199")).toBe(true);
  });

  test("losing update is not sent (local reconcile rejects it)", () => {
    const { client, socket } = connected();
    const before = socket.sent.length;
    const result = client.updateScene([element("srv", 2)]); // older than server's v3
    expect(result).toBeNull();
    expect(socket.sent.length).toBe(before);
  });

  test("scene_applied reconciles and advances rev", () => {
    const { client, socket } = connected();
    socket.receive({ type: "scene_applied", rev: 6, elements: [element("peer", 1)], by: "peer" });
    expect(client.scene.has("peer")).toBe(true);
    expect(client.rev).toBe(6);
  });

  test("rev gap triggers resync_request", () => {
    const { socket } = connected();
    socket.receive({ type: "scene_applied", rev: 9, elements: [element("x", 1)], by: "peer" });
    expect(sentTypes(socket)).toContain("resync_request");
  });

  test("new-epoch resync drops optimistic history instead of resubmitting it", () => {
    const { client, socket } = connected();
    client.updateScene([element("mine", 10)]);
    const updatesBeforeResync = sceneUpdateFrames(socket).length;

    socket.receive({ ...INIT, type: "resync", epoch: "e2", rev: 1, elements: [element("srv", 3)] });

    expect(client.epoch).toBe("e2");
    expect(client.scene.has("mine")).toBe(false);
    expect(sceneUpdateFrames(socket)).toHaveLength(updatesBeforeResync);
  });

  test("same-epoch resync rebases an unsent optimistic edit", () => {
    const { client, socket } = connected();
    socket.readyState = 0;
    client.updateScene([element("mine", 10)]);
    expect(sceneUpdateFrames(socket)).toHaveLength(0);
    socket.readyState = 1;

    socket.receive({ ...INIT, type: "resync", rev: 6, elements: [element("srv", 3)] });

    const resent = sceneUpdateFrames(socket);
    expect(resent).toHaveLength(2);
    expect(resent.every((frame) => frame.elements[0]?.id === "mine")).toBe(true);
    expect(client.scene.has("mine")).toBe(true);
  });
  test("server rejection requests resync, reports the rejected update, and filters its exact stamp from rebase", () => {
    const { client, socket } = connected();
    const rejections: SceneUpdateRejection[] = [];
    client.on("scene_rejected", (reported) => {
      rejections.push(...reported);
    });
    const rejected = element("rejected", 1, 41);
    const retained = element("retained", 1, 42);
    const rejectedUpdateId = client.updateScene([rejected])?.[0];
    client.updateScene([retained]);
    if (rejectedUpdateId === undefined) throw new Error("rejected update was not sent");

    socket.receive({ type: "error", code: "invalid", ref: rejectedUpdateId });

    expect(sentTypes(socket).at(-1)).toBe("resync_request");
    expect(rejections).toEqual([
      expect.objectContaining({
        element: rejected,
        reason: "server_rejected",
        serializedBytes: null,
      }),
    ]);

    const updatesBeforeResync = sceneUpdateFrames(socket).length;
    socket.receive({ ...INIT, type: "resync", rev: 6 });
    const rebased = sceneUpdateFrames(socket).slice(updatesBeforeResync);

    expect(rebased).toHaveLength(1);
    expect(rebased[0]?.elements.map(({ id }) => id)).toEqual(["retained"]);
    expect(client.scene.has("rejected")).toBe(false);
    expect(client.scene.has("retained")).toBe(true);
  });

  test("scene_ack clears inflight tracking so a later error with its ref is ignored", () => {
    const { client, socket } = connected();
    const rejections: SceneUpdateRejection[] = [];
    client.on("scene_rejected", (reported) => {
      rejections.push(...reported);
    });
    const updateId = client.updateScene([element("accepted", 1)])?.[0];
    if (updateId === undefined) throw new Error("accepted update was not sent");
    socket.receive({ type: "scene_ack", updateId, rev: 6, acceptedIds: ["accepted"] });
    const sentBeforeError = socket.sent.length;

    socket.receive({ type: "error", code: "invalid", ref: updateId });

    expect(socket.sent).toHaveLength(sentBeforeError);
    expect(rejections).toHaveLength(0);
  });
});

describe("frame policy", () => {
  test("unknown server message types are ignored (forward compatibility)", () => {
    const { client, socket } = connected();
    socket.receive({ type: "hologram", data: 42 });
    expect(client.status).toBe("open");
    expect(socket.closedWith).toBeNull();
  });

  test("terminal data fast-path accepts structurally valid frames without base64 rescanning", () => {
    const { client, socket } = connected();
    const seen: string[] = [];
    client.on("terminal_snapshot", (msg) => seen.push(`${msg.type}:${msg.seq}:${msg.data}`));
    client.on("terminal_output", (msg) => seen.push(`${msg.type}:${msg.seq}:${msg.data}`));

    // "%" is deliberately outside the base64 alphabet: the trusted-server fast path
    // validates the frame shape and bounded payload rather than rescanning its contents.
    socket.receive({ type: "terminal_snapshot", sessionId: "s1", seq: 0, data: "%" });
    socket.receive({ type: "terminal_output", sessionId: "s1", seq: 0, data: "%" });

    expect(seen).toEqual(["terminal_snapshot:0:%", "terminal_output:0:%"]);
    expect(socket.closedWith).toBeNull();
  });

  test("malformed terminal data frame still closes 4002", () => {
    const { socket } = connected();
    socket.receive({ type: "terminal_output", sessionId: "s1", data: "" });
    expect(socket.closedWith?.code).toBe(4002);
  });

  test("malformed KNOWN frame closes 4002", () => {
    const { socket } = connected();
    socket.receive({ type: "scene_applied", rev: "not a number" });
    expect(socket.closedWith?.code).toBe(4002);
  });

  test("non-JSON frame closes 4002", () => {
    const { socket } = connected();
    socket.receive("{{{{");
    expect(socket.closedWith?.code).toBe(4002);
  });

  test("the SDK's malformed-frame 4002 close still reconnects", () => {
    vi.useFakeTimers();
    const { client, socket } = connected({ reconnect: true, backoffCapMs: 0 });
    socket.receive({ type: "scene_applied", rev: "not a number" });
    expect(socket.closedWith?.code).toBe(4002);
    expect(client.status).toBe("reconnecting");

    vi.runAllTimers();
    expect(FakeSocket.instances).toHaveLength(2);
    client.close();
  });

  test("epoch_mismatch error auto-requests resync", () => {
    const { socket } = connected();
    socket.receive({ type: "error", code: "epoch_mismatch" });
    expect(sentTypes(socket)).toContain("resync_request");
  });
});

describe("roster and presence", () => {
  test("roster join/leave and connection-stamped presence merge", () => {
    const { client, socket } = connected();
    const peer = {
      principal: { id: "p2", kind: "agent" as const, name: "pi", color: "#00ff00" },
      connections: 1,
      payload: {},
    };
    const observedConnIds: string[] = [];
    client.on("presence", (message) => {
      observedConnIds.push(message.connId);
    });
    socket.receive({ type: "roster", joined: peer });
    expect(client.roster.get("p2")?.principal.name).toBe("pi");
    socket.receive({
      type: "presence",
      principalId: "p2",
      connId: "peer-connection",
      payload: { status: "working" },
    });
    expect(client.roster.get("p2")?.payload.status).toBe("working");
    expect(observedConnIds).toEqual(["peer-connection"]);
    socket.receive({ type: "roster", left: { principalId: "p2" } });
    expect(client.roster.has("p2")).toBe(false);
  });
});

describe("listener isolation", () => {
  test("a throwing listener does not starve later listeners or drop the event", () => {
    const { client, socket } = connected();
    // Never-swallow rule: the throw must stay observable even though siblings still run.
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The projection layer subscribing to scene_changed is exactly the consumer that must
      // never lose a delta: the SDK advances scene+rev BEFORE emitting, and a duplicate echo
      // reconciles to zero accepted, so a swallowed emission is unrecoverable without resync.
      const seen: string[] = [];
      client.on("scene_changed", () => {
        throw new Error("projection exploded");
      });
      client.on("scene_changed", (accepted) => {
        seen.push(...accepted.map((el) => el.id));
      });
      socket.receive({
        type: "scene_applied",
        rev: 6,
        by: "other",
        elements: [element("delta", 1)],
      });
      expect(seen).toEqual(["delta"]);
      expect(client.rev).toBe(6);
      expect(
        reported.mock.calls.some((call) =>
          call.some((arg) => arg instanceof Error && arg.message === "projection exploded"),
        ),
      ).toBe(true);
      // Subsequent events keep flowing after the throw.
      socket.receive({
        type: "scene_applied",
        rev: 7,
        by: "other",
        elements: [element("delta2", 1)],
      });
      expect(seen).toEqual(["delta", "delta2"]);
    } finally {
      reported.mockRestore();
    }
  });
});

describe("terminal attach refcounting", () => {
  const SESSION = {
    id: "s1",
    padId: "pad",
    elementId: "el1",
    machineId: "m1",
    status: "running" as const,
    exitCode: null,
    cols: 80,
    rows: 24,
    controllerId: "me",
    createdBy: "me",
  };
  const INIT_WITH_SESSION: ServerMessage = { ...INIT, sessions: [SESSION] };

  test("every view-attach re-subscribes on the wire; only the last detach unsubscribes", () => {
    const { client, socket } = connected();
    client.attachTerminal("s1");
    // A late view (cloned terminal element) MUST trigger a fresh server
    // snapshot, or it renders nothing: attach always sends on the wire.
    client.attachTerminal("s1");
    expect(sentTypes(socket).filter((t) => t === "terminal_attach")).toHaveLength(2);
    client.detachTerminal("s1"); // closing one view must NOT starve the other
    expect(sentTypes(socket).filter((t) => t === "terminal_detach")).toHaveLength(0);
    client.detachTerminal("s1"); // last view gone -> unsubscribe on the wire
    expect(sentTypes(socket).filter((t) => t === "terminal_detach")).toHaveLength(1);
    client.detachTerminal("s1"); // over-detach stays a no-op
    expect(sentTypes(socket).filter((t) => t === "terminal_detach")).toHaveLength(1);
  });

  test("a late view attaching mid-stream receives the re-snapshot; no duplicates", () => {
    const { client, socket } = connected();
    socket.receive(INIT_WITH_SESSION);
    const seenA: string[] = [];
    const seenB: string[] = [];
    client.on("terminal_snapshot", (m) => seenA.push(`snap:${m.seq}`));
    client.on("terminal_output", (m) => seenA.push(`out:${m.seq}`));
    client.attachTerminal("s1");
    // A is live mid-stream before B even exists.
    socket.receive({ type: "terminal_snapshot", sessionId: "s1", seq: 3, data: "" });
    socket.receive({ type: "terminal_output", sessionId: "s1", seq: 4, data: "" });
    expect(seenA).toEqual(["snap:3", "out:4"]);
    // B (cloned element) subscribes late and attaches: the wire re-attach makes
    // the server emit a fresh snapshot, which is B's ONLY path to screen state.
    client.on("terminal_snapshot", (m) => seenB.push(`snap:${m.seq}`));
    client.on("terminal_output", (m) => seenB.push(`out:${m.seq}`));
    client.attachTerminal("s1");
    expect(sentTypes(socket).filter((t) => t === "terminal_attach")).toHaveLength(2);
    socket.receive({ type: "terminal_snapshot", sessionId: "s1", seq: 7, data: "" });
    socket.receive({ type: "terminal_output", sessionId: "s1", seq: 8, data: "" });
    // B renders from the re-snapshot; A sees exactly one reset snapshot and no
    // duplicated output frames.
    expect(seenB).toEqual(["snap:7", "out:8"]);
    expect(seenA).toEqual(["snap:3", "out:4", "snap:7", "out:8"]);
    // Detaching one view keeps the shared wire viewer alive: outputs still flow.
    client.detachTerminal("s1");
    socket.receive({ type: "terminal_output", sessionId: "s1", seq: 9, data: "" });
    expect(seenA.at(-1)).toBe("out:9");
    expect(seenB.at(-1)).toBe("out:9");
    expect(sentTypes(socket).filter((t) => t === "terminal_detach")).toHaveLength(0);
    // The last view leaving is what unsubscribes on the wire.
    client.detachTerminal("s1");
    expect(sentTypes(socket).filter((t) => t === "terminal_detach")).toHaveLength(1);
  });

  test("same-connection resync preserves the existing wire subscription", () => {
    const { client, socket } = connected();
    socket.receive(INIT_WITH_SESSION);
    client.attachTerminal("s1");
    const attachesBeforeResync = sentTypes(socket).filter(
      (type) => type === "terminal_attach",
    ).length;

    socket.receive({ ...INIT_WITH_SESSION, type: "resync" });

    expect(sentTypes(socket).filter((type) => type === "terminal_attach")).toHaveLength(
      attachesBeforeResync,
    );
  });

  test("reconnect re-subscribes running sessions views still hold, without double-counting", () => {
    const { client } = dialing({ reconnect: true });
    const first = FakeSocket.instances.at(-1);
    if (first === undefined) throw new Error("no socket");
    first.open();
    first.receive(INIT_WITH_SESSION);
    client.attachTerminal("s1");
    expect(sentTypes(first).filter((t) => t === "terminal_attach")).toHaveLength(1);

    vi.useFakeTimers();
    try {
      first.close(1006, "network");
      vi.advanceTimersByTime(5_000);
      const second = FakeSocket.instances.at(-1);
      if (second === undefined || second === first) throw new Error("no reconnect socket");
      second.open();
      second.receive({ ...INIT_WITH_SESSION, selfConnId: "conn-reconnected" });
      // server viewer registry is connection-scoped: SDK must re-attach exactly once
      expect(sentTypes(second).filter((t) => t === "terminal_attach")).toHaveLength(1);
      // a single detach still fully unsubscribes (refcount untouched by reconnect)
      client.detachTerminal("s1");
      expect(sentTypes(second).filter((t) => t === "terminal_detach")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminal opening", () => {
  test("rejects immediately when the client closes", async () => {
    const { client } = connected();
    const opening = client.openTerminal({ elementId: "el1", cols: 80, rows: 24 });

    client.close();

    await expect(opening).rejects.toThrow("session closed before terminal opened");
  });
});
