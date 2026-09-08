import { expect, test } from "bun:test";
import { assembleRoster, type PluginDef } from "@manifold/plugin";
import { StreamService } from "../src/stream-service.ts";
import { SessionSender } from "../src/session-channel.ts";
import { FakeSocket } from "./helpers.ts";

test("normal producer close drains accepted frames before terminal control without bypassing sender authorization", () => {
  const plugin: PluginDef = {
    manifest: {
      id: "example.close",
      version: "1.0.0",
      title: "Close",
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
            id: "frames",
            title: "Frames",
            body: { type: "integer" },
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
  const assembly = assembleRoster([plugin], new Set());
  const service = new StreamService(
    () => assembly,
    () => true,
  );
  const producer = service.open(
    "example.close",
    "example.close.frames",
    { kind: "plugin", pluginId: "example.close" },
    () => {},
  );
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
  let release = () => {};
  release = service.subscribe(
    {
      type: "stream_open",
      subscriptionId: "viewer",
      kind: "example.close.frames",
      node: { kind: "plugin", pluginId: "example.close" },
    },
    {
      allows: () => true,
      close: (reason) => socket.close(1013, reason),
      send: (message, authorized) => {
        const body = JSON.stringify(message);
        return sender.sendSerialized(
          { type: message.type, body, bytes: Buffer.byteLength(body), authoritative: false },
          false,
          authorized,
          () => {
            if (message.type === "stream_closed") release();
          },
        );
      },
    },
  );
  producer.publish(1);
  producer.publish(2);
  producer.close();
  expect(socket.sent).toEqual([]);
  socket.bufferedAmount = 0;
  sender.drain();
  expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual([
    "stream_snapshot",
    "stream_frame",
    "stream_frame",
    "stream_closed",
  ]);
  expect(socket.sent.slice(1, 3).map((raw) => JSON.parse(raw).seq)).toEqual([1, 2]);
});
