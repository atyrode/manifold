import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ServerMessageSchema, type Principal } from "@manifold/protocol";
import type { AuthContext } from "../src/auth.ts";
import { SessionPeer, type RawSocket } from "../src/session-peer.ts";

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

function peerFor(socket: RawSocket): SessionPeer {
  const principal: Principal = {
    id: "principal",
    kind: "human",
    name: "tester",
    color: "#2563eb",
  };
  const auth: AuthContext = {
    principal,
    caps: ["*"],
    padScope: null,
    isRoot: true,
    tokenId: null,
  };
  return new SessionPeer("peer", socket, auth, "pad");
}

describe("SessionPeer Bun send status handling", () => {
  test("-1 is successful backpressure and keeps the peer live", () => {
    const socket = new StatusSocket([-1, 8]);
    const peer = peerFor(socket);

    expect(peer.send({ type: "pong" })).toBe(true);
    expect(peer.send({ type: "pong" })).toBe(true);
    expect(socket.sent).toHaveLength(2);
    expect(socket.closed).toBeNull();
  });

  test("0 is a dropped reliable frame and fails the peer", () => {
    const socket = new StatusSocket([0]);
    const peer = peerFor(socket);

    expect(peer.send({ type: "pong" })).toBe(false);
    expect(peer.send({ type: "pong" })).toBe(false);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toMatchObject({ code: 1013 });
  });
});

describe("SessionPeer authoritative queue collapse", () => {
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
          roster: [],
          sessions: [],
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
