import { expect, test } from "bun:test";
import { assembleRoster, type PluginDef } from "@manifold/plugin";
import { StreamServerMessageSchema, type StreamServerMessage } from "@manifold/protocol";
import { StreamService, type StreamSubscriber } from "../src/stream-service.ts";
import { SessionSender } from "../src/session-channel.ts";
import { FakeSocket } from "./helpers.ts";

const node = { kind: "plugin", pluginId: "example.frames" } as const;
const kind = "example.frames.output";
const plugin: PluginDef = {
  manifest: {
    id: node.pluginId,
    version: "1.0.0",
    title: "Frames",
    description: "",
    capabilities: ["containers:read"],
    contributes: {
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: [],
      streams: [
        {
          id: "output",
          title: "Output",
          body: { type: "integer", minimum: 0, maximum: 10000 },
          readCapability: "containers:read",
          nodeKinds: ["plugin"],
          maxFrameBytes: 128,
          maxRingBytes: 1024,
          maxRingFrames: 4,
          maxInstances: 1,
        },
      ],
    },
  },
  actions: [],
};

function fixture() {
  let assembly = assembleRoster([plugin], new Set());
  let allowed = true;
  const frames: StreamServerMessage[] = [];
  const closed: string[] = [];
  const lifecycle: string[] = [];
  const service = new StreamService(
    () => assembly,
    (owner, ref) => owner === node.pluginId && ref.kind === "plugin" && ref.pluginId === owner,
  );
  const subscriber: StreamSubscriber = {
    allows: () => allowed,
    send: (message, authorized) => {
      if (authorized !== undefined && !authorized()) return false;
      frames.push(StreamServerMessageSchema.parse(message));
      return true;
    },
    close: (reason) => closed.push(reason),
  };
  return {
    service,
    frames,
    closed,
    lifecycle,
    subscriber,
    open: () => service.open(node.pluginId, kind, node, (phase) => lifecycle.push(phase)),
    deny: () => {
      allowed = false;
    },
    reassemble: (disabled: boolean) => {
      assembly = assembleRoster([plugin], new Set(disabled ? [node.pluginId] : []));
      service.reconcile();
    },
  };
}

test("retained watermark, lost range, immutable publication and new epochs stay explicit", () => {
  const f = fixture();
  const producer = f.open();
  expect(() => f.open()).toThrow("already open");
  expect(() => producer.publish("wrong shape")).toThrow();
  for (let seq = 1; seq <= 1200; seq++) producer.publish(seq);
  const release = f.service.subscribe(
    {
      type: "stream_open",
      subscriptionId: "viewer",
      kind,
      node,
      cursor: { epoch: producer.epoch, seq: 1 },
    },
    f.subscriber,
  );
  expect(f.frames[0]).toMatchObject({ type: "stream_gap", fromSeq: 2, toSeq: 1196 });
  expect(f.frames[1]).toMatchObject({
    type: "stream_snapshot",
    firstSeq: 1197,
    lastSeq: 1200,
    frames: [1197, 1198, 1199, 1200].map((seq) => ({ seq, body: seq })),
  });
  f.reassemble(false);
  producer.publish(1201);
  expect(f.frames.at(-1)).toMatchObject({ type: "stream_frame", seq: 1201 });
  f.reassemble(true);
  expect(producer.closed).toBe(true);
  expect(f.frames.at(-1)).toMatchObject({ type: "stream_closed" });
  expect(() => producer.publish(1202)).toThrow("closed");
  expect(() => f.open()).toThrow("refused");
  f.reassemble(false);
  const replacement = f.open();
  expect(replacement.epoch).not.toBe(producer.epoch);
  f.service.subscribe(
    {
      type: "stream_open",
      subscriptionId: "reconnect",
      kind,
      node,
      cursor: { epoch: producer.epoch, seq: 1201 },
    },
    f.subscriber,
  );
  expect(f.frames.at(-2)).toMatchObject({ type: "stream_reset", epoch: replacement.epoch });
  expect(f.frames.at(-1)).toMatchObject({
    type: "stream_snapshot",
    firstSeq: 1,
    lastSeq: 0,
    frames: [],
  });
  release();
  replacement.close();
  expect(f.lifecycle).toEqual(["open", "close", "open", "close"]);
});

test("queued snapshot and frames are reauthorized when the actual sender drains", () => {
  const f = fixture();
  const producer = f.open();
  const socket = new FakeSocket();
  socket.bufferedAmount = 1;
  const sender = new SessionSender(
    socket,
    (body) => body,
    0,
    (code, reason) => socket.close(code, reason),
    (code, reason) => socket.close(code, reason),
    "drop",
  );
  const subscriber: StreamSubscriber = {
    ...f.subscriber,
    send: (message, authorized) => {
      const body = JSON.stringify(message);
      return sender.sendSerialized(
        { type: message.type, body, bytes: Buffer.byteLength(body), authoritative: false },
        false,
        authorized,
      );
    },
  };
  f.service.subscribe({ type: "stream_open", subscriptionId: "viewer", kind, node }, subscriber);
  producer.publish(1);
  f.deny();
  socket.bufferedAmount = 0;
  sender.drain();
  expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(["stream_refused"]);
  producer.publish(2);
  expect(socket.sent).toHaveLength(1);
});

test("a bounded slow subscriber is explicitly closed instead of silently losing continuity", () => {
  const f = fixture();
  const producer = f.open();
  const socket = new FakeSocket();
  socket.bufferedAmount = 1;
  const sender = new SessionSender(
    socket,
    (body) => body,
    0,
    (code, reason) => socket.close(code, reason),
    (code, reason) => socket.close(code, reason),
    "drop",
  );
  f.service.subscribe(
    { type: "stream_open", subscriptionId: "slow", kind, node },
    {
      ...f.subscriber,
      send: (message, authorized) => {
        const body = JSON.stringify(message);
        return sender.sendSerialized(
          { type: message.type, body, bytes: Buffer.byteLength(body), authoritative: false },
          false,
          authorized,
        );
      },
    },
  );
  for (let seq = 1; seq <= 300; seq++) producer.publish(seq);
  expect(f.closed).toEqual(["stream resync required"]);
  socket.bufferedAmount = 0;
  sender.drain();
  expect(socket.sent).toEqual([]);
});
