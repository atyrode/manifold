import { describe, expect, test } from "bun:test";
import {
  MAX_SESSION_FRAME_BYTES, PROTOCOL_VERSION, type Container, type HostToGuestMessage,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { InstanceGateway } from "../src/instance-ws.ts";
import { silentLogger } from "../src/log.ts";
import type { RawSocket } from "../src/session-channel.ts";
import { FakeClock, FakeRuntime, testStore } from "./helpers.ts";

const OWNER_KEY = "b".repeat(64);
const GUEST_ORIGIN = "https://guest.example";

/** A socket whose send status and buffer depth the test chooses, as `machine-ws.test.ts` does. */
class StatusSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(private readonly status: number) {}

  send(data: string): number {
    this.sent.push(data);
    return this.status;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

/** A gateway with one live share, and the guest hello that dials it. */
function dial(status: number, protocolVersion = PROTOCOL_VERSION) {
  const runtime = new FakeRuntime();
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
  const container: Container = {
    id: runtime.newId(),
    name: "shared canvas",
    createdAt: runtime.now(),
    discipline: "canvas",
  };
  store.createContainer(container);
  const share = auth.mintShare(
    {
      node: { kind: "container", containerId: container.id },
      caps: ["containers:read", "scenes:write"],
      origin: GUEST_ORIGIN,
    },
    root,
  );
  const gateway = new InstanceGateway(
    auth,
    store,
    new FakeClock(runtime),
    silentLogger,
    "epoch",
    () => "https://host.example",
  );
  const socket = new StatusSocket(status);
  return {
    socket,
    gateway, auth, store, runtime, root, share, container,
    open: () => {
      gateway.open("connection", socket);
      gateway.message(
        "connection",
        JSON.stringify({
          type: "hello",
          protocolVersion,
          origin: GUEST_ORIGIN,
          instanceVersion: "0.0.0",
          token: share.token,
        }),
      );
    },
    close: () => {
      gateway.shutdown();
      store.close();
    },
  };
}

describe("instance channel send status", () => {
  test("an enqueued welcome keeps the authenticated link open", () => {
    // Bun returns -1 for "buffered, backpressure applied". Reading that as a lost frame closed
    // a live control link the first time the kernel buffer filled.
    const dialed = dial(-1);
    dialed.open();

    expect(dialed.socket.sent).toHaveLength(1);
    expect(JSON.parse(dialed.socket.sent[0]!).type).toBe("welcome");
    expect(dialed.socket.closed).toBeNull();
  });

  test("a dropped welcome still closes the link", () => {
    const dialed = dial(0);
    dialed.open();

    expect(dialed.socket.closed?.code).toBe(1011);
    expect(dialed.socket.closed?.reason).toBe("welcome frame dropped");
  });

  test("an outbound queue past the frame ceiling sheds the link instead of growing", () => {
    const dialed = dial(-1);
    dialed.socket.bufferedAmount = MAX_SESSION_FRAME_BYTES;
    dialed.open();

    expect(dialed.socket.sent).toHaveLength(0);
    expect(dialed.socket.closed?.code).toBe(1013);
    expect(dialed.socket.closed?.reason).toBe("outbound queue overflow");
  });
});

describe("instance protocol admission", () => {
  test("the current instance revision can authenticate its share", () => {
    const dialed = dial(1);
    try {
      dialed.open();
      expect(dialed.socket.closed).toBeNull();
      expect(JSON.parse(dialed.socket.sent[0]!).type).toBe("welcome");
    } finally {
      dialed.close();
    }
  });

  test.each([26, 27, 48, 49, 50, 51, PROTOCOL_VERSION + 1])(
    "pre-recipient and unsupported instance revision %s is refused before welcome",
    (protocolVersion) => {
      const dialed = dial(1, protocolVersion);
      try {
        dialed.open();
        expect(dialed.socket.closed?.code).toBe(4409);
        expect(dialed.socket.sent).toEqual([]);
      } finally {
        dialed.close();
      }
    },
  );
});

const GUEST = { id: "local-guest", kind: "human" as const, name: "guest", color: "#3355cc" };

function lastHostMessage(socket: StatusSocket): HostToGuestMessage {
  return JSON.parse(socket.sent.at(-1)!);
}

describe("host peer recipient admission", () => {
  test("pending and over-request refusals issue no bearer; tickets expose actual caps and expiry", () => {
    const fix = dial(1);
    try {
      fix.open();
      const request = (caps?: string[]) => fix.gateway.message("connection", JSON.stringify({
        type: "ticket_request", requestId: "request", principal: GUEST,
        ...(caps === undefined ? {} : { caps }),
      }));
      request();
      expect(lastHostMessage(fix.socket)).toEqual({
        type: "ticket_error", requestId: "request", reason: "recipient_unapproved",
      });
      expect(fix.store.shareTicketPrincipals(fix.share.share.id)).toEqual([]);
      fix.auth.approveShareRecipient({
        shareId: fix.share.share.id, guestPrincipalId: GUEST.id, caps: ["containers:read"],
      }, fix.root);
      request(["scenes:write"]);
      expect(lastHostMessage(fix.socket)).toEqual({
        type: "ticket_error", requestId: "request", reason: "recipient_caps_refused",
      });
      expect(fix.store.shareTicketPrincipals(fix.share.share.id)).toEqual([]);
      request();
      const ticket = lastHostMessage(fix.socket);
      if (ticket.type !== "ticket") throw new Error("approved recipient was refused");
      expect(ticket.caps).toEqual(["containers:read"]);
      expect(ticket.expiresAt).toBeGreaterThan(fix.runtime.now());
      const actor = fix.auth.authenticate(ticket.token);
      expect(actor.expiresAt).toBe(ticket.expiresAt);
      expect(fix.auth.allows(actor, "containers:read", fix.container.id)).toBe(true);
      expect(fix.auth.allows(actor, "scenes:write", fix.container.id)).toBe(false);
      fix.runtime.time = ticket.expiresAt;
      expect(() => fix.auth.authenticate(ticket.token)).toThrow("expired");
      expect(fix.auth.resumableShareTicketPrincipals(fix.share.share.id)).toEqual([]);
    } finally {
      fix.close();
    }
  });

  test("resume drops withdrawn ticket principals and share revocation closes the control link", () => {
    const fix = dial(1);
    try {
      fix.open();
      const request = () => fix.gateway.message("connection", JSON.stringify({
        type: "ticket_request", requestId: "request", principal: GUEST,
      }));
      request();
      const input = { shareId: fix.share.share.id, guestPrincipalId: GUEST.id };
      fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, fix.root);
      request();
      const issued = lastHostMessage(fix.socket);
      if (issued.type !== "ticket") throw new Error("approved recipient was refused");
      // Even another ordinary bearer of that same principal cannot authorize ticket resume.
      const unrelated = fix.auth.mintToken({
        principalId: issued.principal.id, caps: ["containers:read"],
        containerId: fix.container.id,
      }, fix.root);
      fix.auth.removeShareRecipient(input, fix.root);
      const resumed = new StatusSocket(1);
      fix.gateway.open("resumed", resumed);
      fix.gateway.message("resumed", JSON.stringify({
        type: "hello", protocolVersion: PROTOCOL_VERSION, origin: GUEST_ORIGIN,
        instanceVersion: "0.0.0", token: fix.share.token, tickets: [issued.principal.id],
      }));
      const welcome = lastHostMessage(resumed);
      if (welcome.type !== "welcome") throw new Error("control resume was refused");
      expect(welcome.tickets).toEqual([]);
      expect(fix.auth.authenticate(unrelated.token).principal.id).toBe(issued.principal.id);
      expect(() => fix.auth.authenticate(issued.token)).toThrow("revoked");
      expect(fix.auth.revokeShare(input.shareId, fix.root)).toBe(0);
      expect(resumed.closed?.code).toBe(4403);
      expect(fix.gateway.isLive(input.shareId)).toBe(false);
    } finally {
      fix.close();
    }
  });
});
