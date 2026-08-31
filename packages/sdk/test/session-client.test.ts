import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  PROTOCOL_VERSION,
  ROOT_TILE_ID,
  type SceneElement,
  type ServerMessageBody,
  type TileSurface,
} from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  SERVER_PLACE_ORIGIN,
  Y,
  createSceneDoc,
  decodeUpdate,
  encodeUpdate,
  initTiledLayout,
  readElements,
  readTileLayout,
  writeElement,
  writeTileLeaf,
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

  /**
   * Tests that are not about routing drive one room, so an untagged frame is stamped with
   * this socket's channel: v12 made routing mandatory on the wire, not interesting here.
   */
  channel = "c1";

  receive(frame: unknown): void {
    const tagged =
      typeof frame === "object" &&
      frame !== null &&
      !("ch" in frame) &&
      Reflect.get(frame, "type") !== "pong"
        ? { ch: this.channel, ...frame }
        : frame;
    const data = typeof tagged === "string" ? tagged : JSON.stringify(tagged);
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

/** A canvas element the doc tests can move around; a portal is the plainest reference. */
function element(id: string): SceneElement {
  return {
    id,
    type: "portal",
    containerId: `pad-${id}`,
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

/**
 * A tiled container as the server seeds it: the first surface fills the root leaf,
 * every later one splits it to the right.
 */
function encodedTiledDoc(...surfaces: TileSurface[]): string {
  const doc = createSceneDoc();
  initTiledLayout(doc, SERVER_PLACE_ORIGIN);
  for (const [index, surface] of surfaces.entries()) {
    writeTileLeaf(
      doc,
      surface,
      ROOT_TILE_ID,
      index === 0 ? "center" : "right",
      SERVER_PLACE_ORIGIN,
    );
  }
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
}

/** The one frame every harness starts from; naming its member type keeps spreads exact. */
type InitFrame = Extract<ServerMessageBody, { type: "init" }>;

const INIT: InitFrame = {
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

/** A client's channel id once it holds one; a missing id is a harness bug, not a case. */
function channelOf(client: SessionClient): string {
  const id = client.channelId;
  if (id === null) throw new Error("client holds no channel");
  return id;
}

interface ClientHarnessOptions {
  reconnect?: boolean;
  backoffCapMs?: number;
  spectator?: boolean;
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
    ...(options.spectator === true ? { spectator: true } : {}),
    ...(options.backoffCapMs !== undefined ? { backoffCapMs: options.backoffCapMs } : {}),
    // Test double implements the full surface SessionClient touches; a runtime check is
    // meaningless here, hence the deliberate unchecked cast.
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  const connection = client.connect();
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket dialed");
  socket.channel = client.channelId ?? "c1";
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

  test("a spectator declares the flag in its join; an occupant omits it entirely", () => {
    const JoinSchema = z.looseObject({ type: z.string(), spectator: z.boolean().optional() });
    const watching = JoinSchema.parse(
      JSON.parse(connected({ spectator: true }).socket.sent[0] ?? "{}"),
    );
    expect(watching.spectator).toBe(true);

    // Undefined, never `false`: absence IS the occupant case on the wire.
    const occupying = JoinSchema.parse(JSON.parse(connected().socket.sent[0] ?? "{}"));
    expect(occupying.spectator).toBeUndefined();
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

describe("shared transport", () => {
  interface MultiplexHarness {
    readonly first: SessionClient;
    readonly second: SessionClient;
    readonly socket: FakeSocket;
    /** Each room's own connect promise: one may fail while the other lives. */
    readonly firstConnect: Promise<void>;
    readonly secondConnect: Promise<void>;
  }

  /**
   * Two rooms of one tab: same url, same token, same socket factory — which is exactly
   * what a canvas plus a portal widget looks like in the browser.
   */
  function twoRooms(options: { reconnect?: boolean } = {}): MultiplexHarness {
    FakeSocket.instances = [];
    const factory = (url: string): WebSocket => new FakeSocket(url) as unknown as WebSocket;
    const build = (padId: string): SessionClient =>
      new SessionClient({
        url: "ws://test/ws/session",
        padId,
        token: "tok",
        reconnect: options.reconnect ?? false,
        webSocketFactory: factory,
      });
    const first = build("pad1");
    const second = build("pad2");
    const firstConnect = first.connect();
    const secondConnect = second.connect();
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error("no socket dialed");
    return { first, second, socket, firstConnect, secondConnect };
  }

  function initFor(client: SessionClient, epoch: string, elementId: string): InitFrame {
    return {
      ...INIT,
      epoch,
      doc: encodedDoc(element(elementId)),
      selfConnId: `conn-${channelOf(client)}`,
    };
  }

  function receiveOn(socket: FakeSocket, client: SessionClient, body: ServerMessageBody): void {
    socket.receive({ ch: channelOf(client), ...body });
  }

  test("two rooms share ONE connection and each joins its own channel", async () => {
    const { first, second, socket, firstConnect, secondConnect } = twoRooms();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(first.transportId).toBe(second.transportId);
    expect(first.channelId).not.toBe(second.channelId);

    socket.open();
    const JoinSchema = z.looseObject({ type: z.string(), ch: z.string(), padId: z.string() });
    const joins = socket.sent.map((frame) => JoinSchema.parse(JSON.parse(frame)));
    expect(joins.map((join) => [join.padId, join.ch])).toEqual([
      ["pad1", channelOf(first)],
      ["pad2", channelOf(second)],
    ]);

    receiveOn(socket, first, initFor(first, "e-a", "in-a"));
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));
    await Promise.all([firstConnect, secondConnect]);
    first.close();
    second.close();
  });

  test("state, doc updates, and resync stay per channel on the shared socket", async () => {
    const { first, second, socket, firstConnect, secondConnect } = twoRooms();
    socket.open();
    receiveOn(socket, first, initFor(first, "e-a", "in-a"));
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));
    await Promise.all([firstConnect, secondConnect]);

    expect(first.epoch).toBe("e-a");
    expect(second.epoch).toBe("e-b");
    expect(first.elements.has("in-a")).toBe(true);
    expect(first.elements.has("in-b")).toBe(false);
    expect(second.elements.has("in-b")).toBe(true);

    // A remote write on one channel never reaches the other room's projection.
    socket.receive({
      ch: channelOf(second),
      type: "doc_update",
      update: encodedDoc(element("later-b")),
      by: "peer",
    });
    expect(second.elements.has("later-b")).toBe(true);
    expect(first.elements.has("later-b")).toBe(false);

    // A resync replaces exactly one room's lineage.
    receiveOn(socket, second, {
      ...INIT,
      type: "resync",
      epoch: "e-b2",
      doc: encodedDoc(element("fresh-b")),
    });
    expect(second.epoch).toBe("e-b2");
    expect(second.elements.has("fresh-b")).toBe(true);
    expect(second.elements.has("later-b")).toBe(false);
    expect(first.epoch).toBe("e-a");
    expect(first.elements.has("in-a")).toBe(true);

    // Writes are tagged with the room that made them.
    const before = socket.sent.length;
    first.sendCursor(4, 5);
    const cursor = z
      .looseObject({ type: z.string(), ch: z.string() })
      .parse(JSON.parse(socket.sent[before] ?? "{}"));
    expect(cursor).toMatchObject({ type: "cursor", ch: first.channelId });

    first.close();
    second.close();
  });

  test("a reconnect redials once and rejoins every channel", () => {
    vi.useFakeTimers();
    const { first, second, socket } = twoRooms({ reconnect: true });
    socket.open();
    receiveOn(socket, first, initFor(first, "e-a", "in-a"));
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));

    socket.close(1006, "abnormal");
    expect(first.status).toBe("reconnecting");
    expect(second.status).toBe("reconnecting");

    vi.runAllTimers();
    // ONE new socket for both rooms — the whole point of v12.
    expect(FakeSocket.instances).toHaveLength(2);
    const replacement = FakeSocket.instances.at(-1);
    if (!replacement || replacement === socket) throw new Error("no replacement socket");
    replacement.open();

    const JoinSchema = z.looseObject({
      type: z.string(),
      ch: z.string(),
      padId: z.string(),
      lastEpoch: z.string().optional(),
    });
    const joins = replacement.sent.map((frame) => JoinSchema.parse(JSON.parse(frame)));
    // Both rooms rejoined, each carrying its OWN resume hints.
    expect(joins.map((join) => [join.padId, join.ch, join.lastEpoch])).toEqual([
      ["pad1", channelOf(first), "e-a"],
      ["pad2", channelOf(second), "e-b"],
    ]);

    first.close();
    second.close();
    vi.useRealTimers();
  });

  test("closing one room leaves it on the wire; the last close ends the socket", () => {
    const { first, second, socket } = twoRooms();
    socket.open();
    receiveOn(socket, first, initFor(first, "e-a", "in-a"));
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));
    const firstChannel = channelOf(first);

    first.close();

    expect(sentTypes(socket).at(-1)).toBe("leave");
    expect(
      z
        .looseObject({ type: z.string(), ch: z.string() })
        .parse(JSON.parse(socket.sent.at(-1) ?? "{}")).ch,
    ).toBe(firstChannel);
    expect(socket.closedWith).toBeNull();
    expect(first.status).toBe("closed");
    expect(second.status).toBe("open");

    // The last room leaving IS the socket closing, so no second `leave` is spent.
    const before = socket.sent.length;
    second.close();
    expect(socket.sent).toHaveLength(before);
    expect(socket.closedWith?.code).toBe(1000);
  });

  test("a terminal channel refusal kills one room and spares its sibling", async () => {
    const { first, second, socket, firstConnect, secondConnect } = twoRooms();
    socket.open();
    receiveOn(socket, first, initFor(first, "e-a", "in-a"));
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));
    await Promise.all([firstConnect, secondConnect]);

    socket.receive({
      ch: channelOf(first),
      type: "channel_closed",
      code: 4404,
      reason: "pad deleted",
    });

    // The dead room reports closed and holds no channel; the socket never went anywhere.
    expect(first.status).toBe("closed");
    expect(first.channelId).toBeNull();
    expect(second.status).toBe("open");
    expect(socket.closedWith).toBeNull();

    // The surviving room keeps streaming on the same socket.
    socket.receive({
      ch: channelOf(second),
      type: "doc_update",
      update: encodedDoc(element("still-live")),
      by: "peer",
    });
    expect(second.elements.has("still-live")).toBe(true);

    second.close();
  });

  test("a refusal before init rejects connect with the code and reason", async () => {
    const { first, second, socket, firstConnect, secondConnect } = twoRooms();
    socket.open();
    socket.receive({
      ch: channelOf(first),
      type: "channel_closed",
      code: 4404,
      reason: "pad not found",
    });

    // Identical shape to the socket-level rejection this replaced: a room that cannot be
    // joined reports its close code, and the tab's other rooms never notice.
    await expect(firstConnect).rejects.toThrow(
      "session rejected with close code 4404: pad not found",
    );
    receiveOn(socket, second, initFor(second, "e-b", "in-b"));
    await secondConnect;
    expect(second.status).toBe("open");

    second.close();
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

describe("tiled layout", () => {
  test("a canvas container has no layout tree", () => {
    const { client } = connected();
    expect(client.layout()).toBeNull();
  });

  test("init adopts a tiled room's tree, which the epoch swap replaces", () => {
    const { client, socket } = dialing();
    const origins: string[] = [];
    client.on("layout_changed", (origin) => origins.push(origin));

    socket.open();
    socket.receive({ ...INIT, doc: encodedTiledDoc({ kind: "terminal", sessionId: "s1" }) });

    expect(origins).toEqual(["remote"]);
    expect(client.layout()?.[ROOT_TILE_ID]?.surface).toEqual({
      kind: "terminal",
      sessionId: "s1",
    });

    socket.receive({ ...INIT, type: "resync", epoch: "e2", doc: encodedDoc(element("srv")) });
    expect(client.layout()).toBeNull();
  });

  test("a remote layout write projects the tree and reports its provenance", () => {
    const { client, socket } = connected();
    const origins: string[] = [];
    client.on("layout_changed", (origin) => origins.push(origin));

    socket.receive({
      type: "doc_update",
      update: encodedTiledDoc(
        { kind: "terminal", sessionId: "s1" },
        { kind: "terminal", sessionId: "s2" },
      ),
      by: "peer",
    });

    expect(origins).toEqual(["remote"]);
    const layout = client.layout();
    expect(layout?.[ROOT_TILE_ID]?.dir).toBe("row");
    expect(layout?.[ROOT_TILE_ID]?.children).toHaveLength(2);
  });

  test("element traffic never wakes layout subscribers", () => {
    const { client, socket } = connected();
    let fired = 0;
    client.on("layout_changed", () => {
      fired += 1;
    });

    socket.receive({ type: "doc_update", update: encodedDoc(element("peer")), by: "peer" });
    client.transact((tx) => tx.create(element("mine")));

    expect(client.elements.has("peer")).toBe(true);
    expect(client.elements.has("mine")).toBe(true);
    expect(fired).toBe(0);
  });

  test("a ratio drag publishes one local update a replica converges on", () => {
    const { client, socket } = connected();
    const base = encodedTiledDoc(
      { kind: "terminal", sessionId: "s1" },
      { kind: "terminal", sessionId: "s2" },
    );
    socket.receive({ type: "doc_update", update: base, by: "peer" });
    const origins: string[] = [];
    client.on("layout_changed", (origin) => origins.push(origin));
    const before = docUpdateFrames(socket).length;

    client.setTileRatios(ROOT_TILE_ID, [0.3, 0.7]);

    const updates = docUpdateFrames(socket);
    expect(updates).toHaveLength(before + 1);
    expect(origins).toEqual(["local"]);
    expect(client.layout()?.[ROOT_TILE_ID]?.ratios).toEqual([0.3, 0.7]);
    const replica = createSceneDoc();
    Y.applyUpdate(replica, decodeUpdate(base));
    Y.applyUpdate(replica, decodeUpdate(updates.at(-1)?.update ?? ""));
    expect(readTileLayout(replica)?.[ROOT_TILE_ID]?.ratios).toEqual([0.3, 0.7]);
  });

  test("a rejected ratio drag touches neither the tree nor the wire", () => {
    const { client, socket } = connected();
    socket.receive({
      type: "doc_update",
      update: encodedTiledDoc(
        { kind: "terminal", sessionId: "s1" },
        { kind: "terminal", sessionId: "s2" },
      ),
      by: "peer",
    });
    const before = docUpdateFrames(socket).length;
    let fired = 0;
    client.on("layout_changed", () => {
      fired += 1;
    });

    // Ratios must stay parallel to the split's children, and leaves never carry them.
    client.setTileRatios(ROOT_TILE_ID, [1]);
    client.setTileRatios("missing", [0.5, 0.5]);

    expect(docUpdateFrames(socket)).toHaveLength(before);
    expect(fired).toBe(0);
    expect(client.layout()?.[ROOT_TILE_ID]?.ratios).toEqual([0.5, 0.5]);
  });

  test("a container that tiles itself reads as unusable", () => {
    const { client, socket } = connected();
    socket.receive({
      type: "doc_update",
      update: encodedTiledDoc({ kind: "pad", padId: "pad1" }),
      by: "peer",
    });
    expect(client.layout()).toBeNull();
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
    machineId: "m1",
    status: "running" as const,
    exitCode: null,
    cols: 80,
    rows: 24,
    controllerId: "me",
    createdBy: "me",
  };
  const INIT_WITH_SESSION: InitFrame = { ...INIT, sessions: [SESSION] };

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

/**
 * THE CONNECTION-LEVEL ROSTER FRAME (D3).
 *
 * Every other server frame is channelized, and the pool drops frames whose channel it does
 * not recognise — which is exactly what a `ch`-less roster frame would look like to it. This
 * suite pins the one exception: registration is workspace-global shared state, so it addresses
 * the SOCKET, reaches every handle riding it, and never masquerades as room traffic.
 *
 * The frames below are handed over as raw JSON text, deliberately: the harness stamps a
 * channel onto object frames, and stamping this one would test the opposite of the contract.
 */
describe("the plugin roster frame", () => {
  /** A one-plugin roster, the smallest thing that proves the frame arrived intact. */
  const roster = (id: string, enabled: boolean) => [
    {
      manifest: {
        id,
        version: "0.1.0",
        title: id,
        description: "",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      enabled,
      source: "builtin",
      actions: [],
    },
  ];

  test("a roster frame carrying no channel is delivered, not dropped", () => {
    const { client, socket } = connected();
    const seen: unknown[] = [];
    client.onPlugins((next) => {
      seen.push(next);
    });

    socket.receive(JSON.stringify({ type: "plugins", roster: roster("core.draw", true) }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(roster("core.draw", true));

    // A disable arrives the same way, which is what makes hot enablement reload-free (D4).
    socket.receive(JSON.stringify({ type: "plugins", roster: roster("core.draw", false) }));
    expect(seen).toHaveLength(2);
  });

  test("a late subscriber is replayed the last roster, so a plugin mounting late composes", () => {
    const { client, socket } = connected();
    socket.receive(JSON.stringify({ type: "plugins", roster: roster("core.draw", false) }));

    const seen: unknown[] = [];
    const off = client.onPlugins((next) => {
      seen.push(next);
    });

    // The frame lands on socket open, long before a panel deep in the tree subscribes. With
    // no replay that panel would render placeholders until the next enable/disable.
    expect(seen).toEqual([roster("core.draw", false)]);

    off();
    socket.receive(JSON.stringify({ type: "plugins", roster: roster("core.draw", true) }));
    expect(seen).toHaveLength(1);
  });

  test("the roster is not room traffic: it never reaches `message`, and moves no revision", () => {
    const { client, socket } = connected();
    const messages: string[] = [];
    client.on("message", (msg) => {
      messages.push(msg.type);
    });
    const revBefore = client.rev;

    socket.receive(JSON.stringify({ type: "plugins", roster: roster("core.draw", true) }));

    // A room's frame stream is its document's history; injecting workspace news into it
    // would make every consumer that switches on frame type handle a frame about no room.
    expect(messages).toEqual([]);
    expect(client.rev).toBe(revBefore);
    expect(client.status).toBe("open");
  });
});
