import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  DIAL_LIVENESS_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type GuestMessage,
  type HostToGuestMessage,
  type Principal,
} from "@manifold/protocol";
import { SessionClient, dialInstance } from "@manifold/sdk";

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

function dial(options: { reconnect?: boolean } = {}) {
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
  test("a ticket answers with an ordinary token whose principal carries the guest origin", async () => {
    const { handle, socket } = dial();
    socket.open();
    socket.deliver(welcome());
    await handle.ready();

    const pending = handle.requestTicket(guestPrincipal);
    const request = socket.frames().at(-1);
    if (request?.type !== "ticket_request") throw new Error("expected a ticket_request");
    expect(request.principal).toEqual(guestPrincipal);

    socket.deliver({
      type: "ticket",
      requestId: request.requestId,
      token: "ticket-secret",
      principal: { ...guestPrincipal, id: "hp1", origin: GUEST_ORIGIN },
    });
    const outcome = await pending;
    expect(outcome).toEqual({
      ok: true,
      token: "ticket-secret",
      principal: { ...guestPrincipal, id: "hp1", origin: GUEST_ORIGIN },
    });
    expect(handle.tickets).toEqual(["hp1"]);
    handle.close();
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

describe("the projection half needs no new client (invariant 3)", () => {
  test("a ticket opens an ORDINARY SessionClient against the host, keyed by (origin, container)", () => {
    /*
      This is the whole reason there is no remote-session class: the pool keys a connection by
      (factory, url, token), so pointing a client at a second instance with a ticket IS the
      `(origin, containerId)` keying wave 1 reserved. A relay or a second renderer would be the
      second sync path A4 and invariant 14 both forbid.
    */
    const remote = new SessionClient({
      url: "wss://host.example/ws/session",
      containerId: "c1",
      token: "ticket-secret",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    const local = new SessionClient({
      url: "ws://localhost:7777/ws/session",
      containerId: "c1",
      token: "local-token",
      webSocketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    });
    // Neither client is answered with an `init` here: this asserts the pool's KEYING, not a
    // handshake, so the close below rejects both connects and the rejection is the expected
    // outcome rather than a failure.
    const connects = Promise.allSettled([remote.connect(), local.connect()]);

    const urls = FakeSocket.instances.map((socket) => socket.url);
    expect(urls).toContain("wss://host.example/ws/session");
    expect(urls).toContain("ws://localhost:7777/ws/session");
    expect(new Set(urls).size).toBe(urls.length);
    remote.close();
    local.close();
    return connects;
  });
});
