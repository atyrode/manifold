import { afterEach, describe, expect, test, vi } from "bun:test";
import { z } from "zod";
import {
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  type SceneElement,
  type ServerMessage,
} from "@manifold/protocol";
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
  return { id, version, versionNonce, isDeleted: false, index: null };
}

const INIT: ServerMessage = {
  type: "init",
  protocolVersion: PROTOCOL_VERSION,
  epoch: "e1",
  rev: 5,
  elements: [element("srv", 3)],
  self: { id: "me", kind: "human", name: "alex", color: "#112233" },
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

  test("init adopts epoch, rev, and scene wholesale", () => {
    const { client } = connected();
    expect(client.epoch).toBe("e1");
    expect(client.rev).toBe(5);
    expect(client.scene.get("srv")?.version).toBe(3);
    expect(client.status).toBe("open");
  });
});

describe("connection lifecycle", () => {
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

  test("updateScene splits two 600 KiB elements into sub-1 MiB frames", () => {
    const { client, socket } = connected();
    const first: SceneElement = {
      ...element("fat-a", 1),
      payload: "a".repeat(600 * 1024),
    };
    const second: SceneElement = {
      ...element("fat-b", 1),
      payload: "b".repeat(600 * 1024),
    };

    const updateIds = client.updateScene([first, second]);

    const updates = sceneUpdateFrames(socket);
    const wireFrames = socket.sent.filter(
      (frame) => SentFrameSchema.parse(JSON.parse(frame)).type === "scene_update",
    );
    expect(updates).toHaveLength(2);
    expect(updates.map((frame) => frame.elements.length)).toEqual([1, 1]);
    expect(updateIds).toEqual(updates.map((frame) => frame.updateId));
    for (const frame of wireFrames) {
      expect(new TextEncoder().encode(frame).byteLength).toBeLessThan(MAX_SESSION_FRAME_BYTES);
    }
    expect(client.scene.has("fat-a")).toBe(true);
    expect(client.scene.has("fat-b")).toBe(true);
  });

  test("an over-budget element is reported, never applied, and never rebased", () => {
    vi.useFakeTimers();
    const { client, socket } = connected({ reconnect: true, backoffCapMs: 0 });
    const rejections: SceneUpdateRejection[] = [];
    client.on("scene_rejected", (reported) => {
      rejections.push(...reported);
    });
    const tooLarge: SceneElement = {
      ...element("too-fat", 1),
      payload: "x".repeat(800 * 1024),
    };
    const sentBefore = socket.sent.length;

    const updateIds = client.updateScene([tooLarge]);

    expect(updateIds).toBeNull();
    expect(client.scene.has("too-fat")).toBe(false);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.element.id).toBe("too-fat");
    expect(rejections[0]?.reason).toBe("element_too_large");

    socket.close(1006, "abnormal");
    vi.runAllTimers();
    const replacement = FakeSocket.instances.at(-1);
    if (!replacement || replacement === socket) throw new Error("no replacement socket");
    replacement.open();
    replacement.receive({ ...INIT, type: "resync" });

    expect(sceneUpdateFrames(replacement)).toHaveLength(0);
    expect(client.scene.has("too-fat")).toBe(false);
    client.close();
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
});

describe("frame policy", () => {
  test("unknown server message types are ignored (forward compatibility)", () => {
    const { client, socket } = connected();
    socket.receive({ type: "hologram", data: 42 });
    expect(client.status).toBe("open");
    expect(socket.closedWith).toBeNull();
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
  test("roster join/leave and presence merge", () => {
    const { client, socket } = connected();
    const peer = {
      principal: { id: "p2", kind: "agent" as const, name: "pi", color: "#00ff00" },
      connections: 1,
      payload: {},
    };
    socket.receive({ type: "roster", joined: peer });
    expect(client.roster.get("p2")?.principal.name).toBe("pi");
    socket.receive({ type: "presence", principalId: "p2", payload: { status: "working" } });
    expect(client.roster.get("p2")?.payload.status).toBe("working");
    socket.receive({ type: "roster", left: { principalId: "p2" } });
    expect(client.roster.has("p2")).toBe(false);
  });
});
