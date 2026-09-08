import { afterEach, expect, test, vi } from "bun:test";
import { type ManifoldRef, type StreamServerMessage } from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import { StreamState } from "../src/stream.ts";

const node: ManifoldRef = { kind: "container", containerId: "room" };
const options = { kind: "example.capture.output", node };
const snapshot = (subscriptionId: string, epoch: string, seq: number): StreamServerMessage => ({
  type: "stream_snapshot",
  subscriptionId,
  kind: options.kind,
  node,
  epoch,
  firstSeq: seq,
  lastSeq: seq,
  frames: [{ seq, body: { text: "retained" } }],
});

afterEach(() => vi.useRealTimers());

test("duplicates are discarded, missing sequences are explicit, and epochs require a new snapshot", () => {
  const state = new StreamState("s1", options);
  const handle = state.handle(() => {});
  const messages: StreamServerMessage[] = [];
  handle.on((message) => messages.push(message));
  state.receive(snapshot("s1", "one", 1));
  state.receive({
    type: "stream_frame",
    subscriptionId: "s1",
    epoch: "one",
    seq: 1,
    body: "duplicate",
  });
  expect(messages.map((message) => message.type)).toEqual(["stream_snapshot"]);
  state.receive({
    type: "stream_frame",
    subscriptionId: "s1",
    epoch: "one",
    seq: 3,
    body: "later",
  });
  expect(messages.slice(1)).toEqual([
    { type: "stream_gap", subscriptionId: "s1", epoch: "one", fromSeq: 2, toSeq: 2 },
    { type: "stream_frame", subscriptionId: "s1", epoch: "one", seq: 3, body: "later" },
  ]);
  expect(handle.status).toBe("gap");
  state.receive({
    type: "stream_frame",
    subscriptionId: "s1",
    epoch: "two",
    seq: 1,
    body: "unproven",
  });
  expect(handle.status).toBe("reset");
  expect(handle.cursor).toBeUndefined();
  expect(handle.snapshot).toBeNull();
  state.receive({ type: "stream_frame", subscriptionId: "s1", epoch: "one", seq: 4, body: "late" });
  expect(handle.cursor).toBeUndefined();
  state.receive(snapshot("s1", "two", 1));
  expect(handle.cursor).toEqual({ epoch: "two", seq: 1 });
  expect(handle.status).toBe("open");
  handle.close();
});

class StreamSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: StreamServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

test("pooled sessions share stream holds and reconnect only live subscriptions at their cursor", () => {
  vi.useFakeTimers();
  const sockets: StreamSocket[] = [];
  const webSocketFactory = () => {
    const socket = new StreamSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  const clientOptions = {
    url: "ws://streams.test/session",
    token: "token",
    containerId: "room",
    webSocketFactory,
  };
  const first = new SessionClient(clientOptions);
  const second = new SessionClient(clientOptions);
  try {
    const a = first.openStream(options);
    const b = second.openStream(options);
    const discarded = first.openStream({ ...options, kind: "example.capture.discarded" });
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.open();
    const opens = socket.sent.filter((frame) => frame.type === "stream_open");
    expect(opens).toHaveLength(2);
    const subscriptionId = opens[0]!.subscriptionId as string;
    expect(opens[0]).not.toHaveProperty("ch");
    socket.receive(snapshot(subscriptionId, "epoch", 5));
    expect(a.cursor).toEqual({ epoch: "epoch", seq: 5 });
    expect(b.cursor).toEqual(a.cursor);
    a.close();
    expect(socket.sent.filter((frame) => frame.type === "stream_close")).toEqual([]);
    discarded.close();
    socket.close(1006);
    expect(b.status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    const reconnected = sockets[1]!;
    reconnected.open();
    expect(reconnected.sent.filter((frame) => frame.type === "stream_open")).toEqual([
      { type: "stream_open", subscriptionId, ...options, cursor: { epoch: "epoch", seq: 5 } },
    ]);
    b.close();
    b.close();
    expect(reconnected.sent.filter((frame) => frame.type === "stream_close")).toEqual([
      { type: "stream_close", subscriptionId },
    ]);
  } finally {
    first.close();
    second.close();
  }
});

test("late handles receive a fresh replay without cancelling an earlier holder", () => {
  const socket = new StreamSocket();
  const client = new SessionClient({
    url: "ws://streams.test/late",
    token: "token",
    containerId: "room",
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  try {
    const early = client.openStream(options);
    socket.open();
    const firstId = socket.sent.find((frame) => frame.type === "stream_open")!
      .subscriptionId as string;
    socket.receive(snapshot(firstId, "epoch", 1));
    const sharing = client.openStream(options);
    const replay: StreamServerMessage[] = [];
    sharing.on((message) => replay.push(message));
    expect(replay).toEqual([snapshot(firstId, "epoch", 1)]);
    socket.receive({
      type: "stream_frame",
      subscriptionId: firstId,
      epoch: "epoch",
      seq: 2,
      body: "live",
    });
    const late = client.openStream(options);
    const opens = socket.sent.filter((frame) => frame.type === "stream_open");
    expect(opens).toHaveLength(2);
    const lateId = opens[1]!.subscriptionId as string;
    expect(lateId).not.toBe(firstId);
    expect(late.snapshot).toBeNull();
    socket.receive(snapshot(lateId, "epoch", 2));
    const catchup: StreamServerMessage[] = [];
    late.on((message) => catchup.push(message));
    expect(catchup).toEqual([snapshot(lateId, "epoch", 2)]);
    early.close();
    sharing.close();
    expect(socket.sent.filter((frame) => frame.type === "stream_close")).toEqual([
      { type: "stream_close", subscriptionId: firstId },
    ]);
    const stillShared = client.openStream(options);
    expect(socket.sent.filter((frame) => frame.type === "stream_open")).toHaveLength(2);
    late.close();
    expect(stillShared.status).toBe("open");
    stillShared.close();
    expect(socket.sent.filter((frame) => frame.type === "stream_close")).toEqual([
      { type: "stream_close", subscriptionId: firstId },
      { type: "stream_close", subscriptionId: lateId },
    ]);
  } finally {
    client.close();
  }
});
