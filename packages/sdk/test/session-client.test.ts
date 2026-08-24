import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { PROTOCOL_VERSION, type SceneElement, type ServerMessage } from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";

/**
 * Minimal in-memory WebSocket double implementing exactly the surface SessionClient
 * uses. Lets unit tests drive the full state machine without a server process.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  closedWith: { code?: number } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closedWith = code !== undefined ? { code } : {};
    this.readyState = 3;
    this.onclose?.();
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
  epoch: z.string(),
  baseRev: z.number(),
  elements: z.array(z.looseObject({ id: z.string() })),
});

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.map((f) => SentFrameSchema.parse(JSON.parse(f)).type);
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

function connected(): { client: SessionClient; socket: FakeSocket } {
  FakeSocket.instances = [];
  const client = new SessionClient({
    url: "ws://test/ws/session",
    padId: "pad1",
    token: "tok",
    reconnect: false,
    // Test double implements the full surface SessionClient touches; a runtime check is
    // meaningless here, hence the deliberate unchecked cast.
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  void client.connect();
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket dialed");
  socket.open();
  socket.receive(INIT);
  return { client, socket };
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

  test("resync rebases local edits that beat server state", () => {
    const { client, socket } = connected();
    client.updateScene([element("mine", 10)]);
    socket.receive({ ...INIT, type: "resync", epoch: "e2", rev: 1, elements: [element("srv", 3)] });
    expect(client.epoch).toBe("e2");
    const resent = socket.sent
      .map((f) => SceneUpdateFrameSchema.safeParse(JSON.parse(f)))
      .flatMap((r) => (r.success && r.data.epoch === "e2" ? [r.data] : []));
    expect(resent).toHaveLength(1);
    expect(resent[0]?.elements[0]?.id).toBe("mine");
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
