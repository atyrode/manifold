import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ServerMessageSchema, type Principal } from "@manifold/protocol";
import type { AuthContext } from "../src/auth.ts";
import { SessionChannel, type RawSocket } from "../src/session-channel.ts";

class StatusSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(private readonly statuses: number[]) {}

  send(data: string): number {
    this.sent.push(data);
    return this.statuses.shift() ?? Buffer.byteLength(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

function peerFor(socket: RawSocket): SessionChannel {
  const principal: Principal = {
    id: "principal",
    kind: "human",
    name: "tester",
    color: "#2563eb",
  };
  const auth: AuthContext = {
    principal,
    caps: ["*"],
    containerScope: null,
    isRoot: true,
    tokenId: null,
    grantId: null,
  };
  return new SessionChannel("peer", socket, auth, "container", "c1");
}

describe("SessionChannel Bun send status handling", () => {
  test("-1 is successful backpressure and keeps the peer live", () => {
    const socket = new StatusSocket([-1, 8]);
    const peer = peerFor(socket);

    expect(peer.send({ type: "saved", rev: 1, at: 0 })).toBe(true);
    expect(peer.send({ type: "saved", rev: 2, at: 0 })).toBe(true);
    expect(socket.sent).toHaveLength(2);
    expect(socket.closed).toBeNull();
  });

  test("0 is a dropped reliable frame and fails the peer", () => {
    const socket = new StatusSocket([0]);
    const peer = peerFor(socket);

    expect(peer.send({ type: "saved", rev: 1, at: 0 })).toBe(false);
    expect(peer.send({ type: "saved", rev: 2, at: 0 })).toBe(false);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toMatchObject({ code: 1013 });
  });
});

describe("SessionChannel authoritative queue collapse", () => {
  test("hundreds of queued resyncs collapse to the newest single frame", () => {
    const socket = new StatusSocket([]);
    socket.bufferedAmount = 1;
    const peer = peerFor(socket);
    for (let rev = 0; rev < 300; rev += 1) {
      expect(
        peer.send({
          type: "resync",
          protocolVersion: PROTOCOL_VERSION,
          epoch: "epoch",
          rev,
          doc: "AAA=",
          self: peer.auth.principal,
          selfConnId: peer.id,
          selfCaps: ["*"],
          attendance: [],
          terminals: [],
        }),
      ).toBe(true);
    }
    expect(socket.closed).toBeNull();
    expect(socket.sent).toEqual([]);

    socket.bufferedAmount = 0;
    peer.drain();
    expect(socket.sent).toHaveLength(1);
    const frame = socket.sent[0];
    if (frame === undefined) throw new Error("missing drained resync");
    expect(ServerMessageSchema.parse(JSON.parse(frame))).toMatchObject({
      type: "resync",
      rev: 299,
    });
  });
});

describe("SessionChannel channel scope", () => {
  test("every frame is tagged with the channel that owns it", () => {
    const socket = new StatusSocket([]);
    const peer = peerFor(socket);

    peer.send({ type: "saved", rev: 3, at: 7 });

    const frame = socket.sent[0];
    if (frame === undefined) throw new Error("missing frame");
    expect(ServerMessageSchema.parse(JSON.parse(frame))).toEqual({
      type: "saved",
      ch: "c1",
      rev: 3,
      at: 7,
    });
  });

  test("closing a channel announces it and leaves the socket carrying its siblings", () => {
    const socket = new StatusSocket([]);
    const peer = peerFor(socket);

    peer.close(4404, "container deleted");

    expect(socket.closed).toBeNull();
    const frame = socket.sent.at(-1);
    if (frame === undefined) throw new Error("missing channel_closed");
    expect(ServerMessageSchema.parse(JSON.parse(frame))).toEqual({
      type: "channel_closed",
      ch: "c1",
      code: 4404,
      reason: "container deleted",
    });
    // A dead channel accepts nothing more.
    expect(peer.send({ type: "saved", rev: 1, at: 0 })).toBe(false);
    expect(peer.isClosed).toBe(true);
  });

  test("an overflowing channel is dropped alone; a failed transport takes the socket", () => {
    const overflowing = new StatusSocket([]);
    overflowing.bufferedAmount = 1;
    const peer = peerFor(overflowing);
    let queued = 0;
    while (peer.send({ type: "doc_update", update: "A".repeat(8_000), by: "peer" })) {
      queued += 1;
      if (queued > 1_000) throw new Error("queue never overflowed");
    }
    expect(overflowing.closed).toBeNull();
    expect(overflowing.sent.at(-1)).toContain('"channel_closed"');

    const failing = new StatusSocket([0]);
    const dropped = peerFor(failing);
    expect(dropped.send({ type: "saved", rev: 1, at: 0 })).toBe(false);
    expect(failing.closed).toMatchObject({ code: 1013 });
  });

  test("a peer whose channel is retired reports it exactly once", () => {
    const socket = new StatusSocket([]);
    const principal: Principal = {
      id: "principal",
      kind: "human",
      name: "tester",
      color: "#2563eb",
    };
    const auth: AuthContext = {
      principal,
      caps: ["*"],
      containerScope: null,
      isRoot: true,
      tokenId: null,
      grantId: null,
    };
    const retired: string[] = [];
    const peer = new SessionChannel("peer", socket, auth, "container", "c1", false, (closing) => {
      retired.push(closing.channel);
    });

    peer.close(1013, "outbound queue overflow");
    peer.close(1013, "outbound queue overflow");
    peer.closeConnection(1001, "server shutting down");

    expect(retired).toEqual(["c1"]);
  });
});
