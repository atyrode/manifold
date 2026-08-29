import { afterEach, describe, expect, test, vi } from "bun:test";
import { PROTOCOL_VERSION, type SceneElement, type ServerMessage } from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  Y,
  createSceneDoc,
  decodeUpdate,
  encodeUpdate,
  readElements,
  writeElement,
} from "@manifold/scene";
import { SessionClient } from "@manifold/sdk";
import { z } from "zod";

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
const DocUpdateFrameSchema = z.looseObject({
  type: z.literal("doc_update"),
  update: z.string(),
});

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((f) => SentFrameSchema.parse(JSON.parse(f)).type);
}

type DocUpdateFrame = z.infer<typeof DocUpdateFrameSchema>;

function docUpdateFrames(socket: FakeSocket): DocUpdateFrame[] {
  const updates: DocUpdateFrame[] = [];
  for (const frame of socket.sent) {
    const parsed = DocUpdateFrameSchema.safeParse(JSON.parse(frame));
    if (parsed.success) updates.push(parsed.data);
  }
  return updates;
}

function element(id: string): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
  };
}

function encodedDoc(...elements: SceneElement[]): string {
  const doc = createSceneDoc();
  for (const sceneElement of elements) writeElement(doc, sceneElement, LOCAL_ORIGIN);
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
}

const INIT: ServerMessage = {
  type: "init",
  protocolVersion: PROTOCOL_VERSION,
  epoch: "e1",
  rev: 5,
  doc: encodedDoc(element("srv")),
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
    expect(client.elements.get("srv")).toEqual(element("srv"));
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
    first.receive({ ...INIT, epoch: "stale", doc: encodedDoc(element("stale")) });
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
  test("a transaction updates the local projection and sends one Yjs update", () => {
    const { client, socket } = connected();
    client.transact((tx) => tx.create(element("a")));

    expect(client.elements.get("a")).toEqual(element("a"));
    const updates = docUpdateFrames(socket);
    expect(updates).toHaveLength(1);
    const replica = createSceneDoc();
    Y.applyUpdate(replica, decodeUpdate(updates[0]?.update ?? ""));
    expect(readElements(replica).get("a")).toEqual(element("a"));
  });

  test("first init merges offline edits and publishes a full converged state", () => {
    const { client, socket } = dialing();
    client.transact((tx) => tx.create(element("early")));
    expect(client.outboxSize()).toBe(1);

    socket.open();
    socket.receive(INIT);

    expect(client.elements.has("early")).toBe(true);
    expect(client.elements.has("srv")).toBe(true);
    expect(docUpdateFrames(socket)).toHaveLength(2);
    expect(client.outboxSize()).toBe(0);
  });

  test("one transaction batches many element creates into one update", () => {
    const { client, socket } = connected();
    client.transact((tx) => {
      for (let index = 0; index < 200; index += 1) {
        tx.create(element(`bulk-${index}`));
      }
    });

    expect(docUpdateFrames(socket)).toHaveLength(1);
    expect(client.elements.size).toBe(201);
    expect(client.elements.has("bulk-199")).toBe(true);
  });

  test("remote document updates refresh the validated projection", () => {
    const { client, socket } = connected();
    const changed: Array<{ ids: readonly string[]; origin: string }> = [];
    client.on("elements_changed", (ids, origin) => changed.push({ ids, origin }));

    socket.receive({
      type: "doc_update",
      update: encodedDoc(element("peer")),
      by: "peer",
    });

    expect(client.elements.get("peer")).toEqual(element("peer"));
    expect(changed).toContainEqual({ ids: ["peer"], origin: "remote" });
  });

  test("new-epoch resync replaces local history", () => {
    const { client, socket } = connected();
    client.transact((tx) => tx.create(element("mine")));
    const updatesBeforeResync = docUpdateFrames(socket).length;

    socket.receive({
      ...INIT,
      type: "resync",
      epoch: "e2",
      rev: 1,
      doc: encodedDoc(element("replacement")),
    });

    expect(client.epoch).toBe("e2");
    expect(client.elements.has("mine")).toBe(false);
    expect(client.elements.has("replacement")).toBe(true);
    expect(docUpdateFrames(socket)).toHaveLength(updatesBeforeResync + 1);
  });

  test("same-epoch resync replays an offline local edit", () => {
    const { client, socket } = connected();
    socket.readyState = 0;
    client.transact((tx) => tx.create(element("mine")));
    expect(client.outboxSize()).toBe(1);
    socket.readyState = 1;

    const updatesBeforeResync = docUpdateFrames(socket).length;
    socket.receive({ ...INIT, type: "resync", rev: 6 });

    expect(docUpdateFrames(socket)).toHaveLength(updatesBeforeResync + 2);
    expect(client.elements.has("mine")).toBe(true);
    expect(client.outboxSize()).toBe(0);
  });

  test("undo and redo track local edits without tracking remote state", () => {
    const { client } = connected();
    client.transact((tx) => tx.create(element("mine")));
    expect(client.elements.has("mine")).toBe(true);

    client.undo();
    expect(client.elements.has("mine")).toBe(false);

    client.redo();
    expect(client.elements.get("mine")).toEqual(element("mine"));
  });

  test("collaborative text is edited through the transaction text handle", () => {
    const { client } = connected();
    client.transact((tx) => {
      tx.create({
        id: "note",
        type: "text",
        text: "hello",
        x: 0,
        y: 0,
        width: 240,
        height: 48,
        zIndex: 1,
        fontSize: 20,
        color: "#f8f9fa",
      });
    });
    client.transact((tx) => tx.text("note")?.insert(5, " world"));

    expect(client.elementText("note")?.toString()).toBe("hello world");
    expect(client.elements.get("note")).toMatchObject({ text: "hello world" });
  });

  test("gesture payloads are sent without entering durable scene state", () => {
    const { client, socket } = connected();
    client.sendGesture({
      kind: "move",
      phase: "active",
      elementId: "srv",
      x: 20,
      y: 30,
    });
    expect(sentTypes(socket).at(-1)).toBe("gesture");
    expect(client.elements.get("srv")).toEqual(element("srv"));
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
    socket.receive({ type: "doc_update", update: "not base64", by: "peer" });
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
    socket.receive({ type: "doc_update", update: "not base64", by: "peer" });
    expect(socket.closedWith?.code).toBe(4002);
    expect(client.status).toBe("reconnecting");

    vi.runAllTimers();
    expect(FakeSocket.instances).toHaveLength(2);
    client.close();
  });

  test("server-stamped gesture frames are emitted", () => {
    const { client, socket } = connected();
    const seen: string[] = [];
    client.on("gesture", (message) => seen.push(`${message.principalId}:${message.elementId}`));
    socket.receive({
      type: "gesture",
      principalId: "peer",
      connId: "peer-conn",
      kind: "move",
      phase: "active",
      elementId: "srv",
      x: 1,
      y: 2,
    });
    expect(seen).toEqual(["peer:srv"]);
  });
});

describe("roster and presence", () => {
  test("roster join/leave and connection-stamped presence merge", () => {
    const { client, socket } = connected();
    const peer = {
      principal: { id: "p2", kind: "agent" as const, name: "pi", color: "#00ff00" },
      connections: 1,
      connIds: ["peer-connection"],
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
      // The projection layer subscribing to elements_changed must never lose a delta.
      const seen: string[] = [];
      client.on("elements_changed", () => {
        throw new Error("projection exploded");
      });
      client.on("elements_changed", (ids) => {
        seen.push(...ids);
      });
      socket.receive({
        type: "doc_update",
        update: encodedDoc(element("delta")),
        by: "other",
      });
      expect(seen).toEqual(["delta"]);
      expect(
        reported.mock.calls.some((call) =>
          call.some((arg) => arg instanceof Error && arg.message === "projection exploded"),
        ),
      ).toBe(true);
      // Subsequent events keep flowing after the throw.
      socket.receive({
        type: "doc_update",
        update: encodedDoc(element("delta2")),
        by: "other",
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
    name: null,
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

describe("session naming", () => {
  const NAMED_SESSION = {
    id: "s1",
    padId: "pad",
    name: null,
    elementId: "el1",
    machineId: "m1",
    status: "running" as const,
    exitCode: null,
    cols: 80,
    rows: 24,
    controllerId: "me",
    createdBy: "me",
  };

  test("a renamed event relabels the session in place and notifies listeners", () => {
    const { client, socket } = connected();
    socket.receive({ ...INIT, sessions: [NAMED_SESSION] });
    let changes = 0;
    client.on("sessions_changed", () => {
      changes += 1;
    });

    socket.receive({ type: "session_event", sessionId: "s1", kind: "renamed", name: "build" });

    expect(client.sessions.get("s1")?.name).toBe("build");
    // Everything else about the session is untouched by a rename.
    expect(client.sessions.get("s1")).toEqual({ ...NAMED_SESSION, name: "build" });
    expect(changes).toBe(1);
  });

  test("a renamed event with no label clears the name back to the default", () => {
    const { client, socket } = connected();
    socket.receive({ ...INIT, sessions: [{ ...NAMED_SESSION, name: "build" }] });

    socket.receive({ type: "session_event", sessionId: "s1", kind: "renamed" });

    expect(client.sessions.get("s1")?.name).toBeNull();
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
