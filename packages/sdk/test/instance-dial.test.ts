import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  DIAL_LIVENESS_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type GuestMessage,
  type HostToGuestMessage,
  type Principal,
} from "@manifold/protocol";
import { dialInstance } from "@manifold/sdk";

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.instances = [];
});

/**
 * The same in-memory WebSocket double `session-client.test.ts` uses, driving the OTHER dialing
 * state machine. Two wires, one test seam.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  closedWith: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

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

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(message: HostToGuestMessage | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  frames(): GuestMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as GuestMessage);
  }
}

const GUEST_ORIGIN = "https://guest.example";
const HOST_ORIGIN = "https://host.example";
const HOST_URL = "wss://host.example/ws/instance";

const guestPrincipal: Principal = { id: "gp1", kind: "human", name: "Ada", color: "#1971c2" };

const welcome = (over: Partial<Extract<HostToGuestMessage, { type: "welcome" }>> = {}) =>
  ({
    type: "welcome",
    origin: HOST_ORIGIN,
    serverEpoch: "epoch-1",
    shareId: "s1",
    ref: { kind: "container", containerId: "c1" },
    caps: ["containers:read"],
    title: "Shared canvas",
    tickets: [],
    ...over,
  }) satisfies HostToGuestMessage;

function dial(options: { reconnect?: boolean; ticketTimeoutMs?: number } = {}) {
  const handle = dialInstance({
    url: HOST_URL,
    token: "share-secret",
    origin: GUEST_ORIGIN,
    webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...options,
  });
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) throw new Error("no socket");
  return { handle, socket };
}

describe("the instance dial handshake", () => {
  test("the first frame is a hello declaring THIS instance's origin and the share secret", async () => {
    /*
      The origin on the hello is a claim the host CHECKS against the share row it minted
      (ADR 0014 §2, close 4401 on mismatch), which is what makes `Principal.origin` trustworthy
      data downstream rather than a string somebody typed.
    */
    const { handle, socket } = dial();
    socket.open();
    const [first] = socket.frames();
    expect(first).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      origin: GUEST_ORIGIN,
      instanceVersion: expect.any(String),
      token: "share-secret",
      tickets: [],
    });

    socket.deliver(welcome());
    await handle.ready();
    expect(handle.status).toBe("live");
    expect(handle.hostOrigin).toBe(HOST_ORIGIN);
    expect(handle.share).toEqual({
      shareId: "s1",
      ref: { kind: "container", containerId: "c1" },
      caps: ["containers:read"],
      title: "Shared canvas",
    });
    handle.close();
  });

  test("a host ping is answered, because liveness is one scheme with one answer", () => {
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());
    socket.deliver({ type: "ping" });
    expect(socket.frames().at(-1)).toEqual({ type: "pong" });
    handle.close();
  });

  test("silence past the deadline closes the phantom transport and re-dials", () => {
    /*
      The dialing side of the machine channel's watchdog, unchanged in meaning: a healthy link
      carries pings even when idle, so total silence is dead TCP nobody RST rather than a quiet
      host.
    */
    vi.useFakeTimers();
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());

    vi.advanceTimersByTime(DIAL_LIVENESS_TIMEOUT_MS + 1);
    expect(socket.closedWith?.code).toBe(4008);
    expect(handle.status).toBe("offline");

    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances).toHaveLength(2);
    handle.close();
  });

  test("a malformed frame of a KNOWN type is a protocol error; an unknown type is ignored", () => {
    const { handle, socket } = dial();
    socket.open();
    socket.deliver({ type: "gossip", about: "nothing" });
    expect(socket.closedWith).toBeNull();

    socket.deliver({ type: "welcome", origin: HOST_ORIGIN });
    expect(socket.closedWith?.code).toBe(4002);
    handle.close();
  });
});

describe("tickets", () => {

  test.each(["caps", "expiresAt"] as const)(
    "a ticket missing its %s bound closes as malformed without retaining a resume identity",
    async (missing) => {
      const { handle, socket } = dial({ reconnect: false });
      socket.open();
      socket.deliver(welcome());
      const pending = handle.requestTicket(guestPrincipal);
      const request = socket.frames().at(-1);
      if (request?.type !== "ticket_request") throw new Error("expected a ticket_request");
      const frame: Record<string, unknown> = {
        type: "ticket",
        requestId: request.requestId,
        token: "ticket-secret",
        principal: { ...guestPrincipal, id: "hp1", origin: GUEST_ORIGIN },
        caps: ["containers:read"],
        expiresAt: 1_900_000_000_000,
      };
      delete frame[missing];
      socket.deliver(frame);
      expect(socket.closedWith?.code).toBe(4002);
      expect(await pending).toEqual({ ok: false, reason: "unavailable" });
      expect(handle.tickets).toEqual([]);
      handle.close();
    },
  );

  test("host admission refusals leave the dial live, without retrying or retaining tickets", async () => {
    vi.useFakeTimers();
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());
    for (const reason of ["recipient_unapproved", "recipient_caps_refused"] as const) {
      const pending = handle.requestTicket(guestPrincipal, ["containers:read"]);
      const request = socket.frames().at(-1);
      if (request?.type !== "ticket_request") throw new Error("expected a ticket_request");
      socket.deliver({ type: "ticket_error", requestId: request.requestId, reason });
      expect(await pending).toEqual({ ok: false, reason });
      const sent = socket.sent.length;
      vi.advanceTimersByTime(10_001);
      expect(socket.sent.length).toBe(sent);
      expect(handle.status).toBe("live");
      expect(handle.tickets).toEqual([]);
      expect(FakeSocket.instances).toHaveLength(1);
    }
    handle.close();
  });

  test("deadline and local cancellation discard late tickets instead of resuming abandoned authority", async () => {
    vi.useFakeTimers();
    const { handle, socket } = dial({ ticketTimeoutMs: 50 });
    socket.open();
    socket.deliver(welcome());
    const expired = handle.requestTicket(guestPrincipal);
    const first = socket.frames().at(-1);
    if (first?.type !== "ticket_request") throw new Error("expected a ticket_request");
    vi.advanceTimersByTime(50);
    expect(await expired).toEqual({ ok: false, reason: "unavailable" });
    socket.deliver({
      type: "ticket",
      requestId: first.requestId,
      token: "abandoned-ticket",
      principal: { ...guestPrincipal, id: "hp-late", origin: GUEST_ORIGIN },
      caps: ["containers:read"],
      expiresAt: 1_900_000_000_000,
    });
    expect(handle.tickets).toEqual([]);
    const cancelled = handle.requestTicket(guestPrincipal);
    handle.close();
    expect(await cancelled).toEqual({ ok: false, reason: "unavailable" });
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("a refusal is DATA, and so is a dropped socket — the caller never sees an exception", async () => {
    /*
      Every door in the tree answers a refusal as data (PlaceOutcome, AccessOutcome). A rejected
      promise here would turn a named, classifiable refusal into an exception a caller has to
      re-classify from a message string, and a socket that dropped mid-request would hang the
      guest's own door until somebody added a timer beside this one.
    */
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());
    await handle.ready();

    const refused = handle.requestTicket(guestPrincipal);
    const first = socket.frames().at(-1);
    if (first?.type !== "ticket_request") throw new Error("expected a ticket_request");
    socket.deliver({ type: "ticket_error", requestId: first.requestId, reason: "share_revoked" });
    expect(await refused).toEqual({ ok: false, reason: "share_revoked" });

    const orphaned = handle.requestTicket(guestPrincipal);
    socket.close(1006, "network");
    expect(await orphaned).toEqual({ ok: false, reason: "unavailable" });

    expect(await handle.requestTicket(guestPrincipal)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    handle.close();
  });

  test("resume: tickets ride the next hello and are pruned to the ones the host still honours", async () => {
    /*
      ADR 0014 §8 — the machine channel's adoption shape, generalized. A guest that keeps
      advertising a dead ticket would re-learn the same answer forever, and a lens still pointed
      at one would meet the death as an unexplained 4403.
    */
    vi.useFakeTimers();
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());

    for (const id of ["hp1", "hp2"]) {
      const pending = handle.requestTicket(guestPrincipal);
      const request = socket.frames().at(-1);
      if (request?.type !== "ticket_request") throw new Error("expected a ticket_request");
      socket.deliver({
        type: "ticket",
        requestId: request.requestId,
        token: `t-${id}`,
        principal: { ...guestPrincipal, id, origin: GUEST_ORIGIN },
        caps: ["containers:read"],
        expiresAt: 1_900_000_000_000,
      });
      await pending;
    }
    expect(handle.tickets).toEqual(["hp1", "hp2"]);

    socket.close(1006, "network");
    vi.advanceTimersByTime(30_000);
    const redial = FakeSocket.instances.at(-1);
    if (redial === undefined || redial === socket) throw new Error("expected a re-dial");
    redial.open();
    const hello = redial.frames()[0];
    if (hello?.type !== "hello") throw new Error("expected a hello");
    expect(hello.tickets).toEqual(["hp1", "hp2"]);

    redial.deliver(welcome({ tickets: ["hp1"] }));
    expect(handle.tickets).toEqual(["hp1"]);
    handle.close();
  });
});

describe("revocation", () => {
  test("4403 parks the dial as revoked and stops re-dialing; any other close retries", () => {
    /*
      The two closes mean different things and the status is not a boolean for exactly that
      reason: an unreachable host is a transport problem worth retrying forever, a revoked share
      is a decision, and re-dialing a decision is noise the host has to refuse over and over.
    */
    vi.useFakeTimers();
    const revoked = dial();
    revoked.socket.open();
    revoked.socket.deliver(welcome());
    let revocations = 0;
    revoked.handle.onRevoked(() => {
      revocations += 1;
    });

    revoked.socket.close(4403, "revoked");
    expect(revoked.handle.status).toBe("revoked");
    expect(revocations).toBe(1);
    const socketsAfterRevoke = FakeSocket.instances.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(socketsAfterRevoke);

    const dropped = dial();
    dropped.socket.open();
    dropped.socket.deliver(welcome());
    dropped.socket.close(1006, "network");
    expect(dropped.handle.status).toBe("offline");
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(socketsAfterRevoke + 1);
    dropped.handle.close();
  });
});
