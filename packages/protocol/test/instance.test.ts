import { describe, expect, test } from "bun:test";
import {
  DIAL_LIVENESS_TIMEOUT_MS,
  DIAL_PING_INTERVAL_MS,
  GUEST_MESSAGE_TYPES,
  GuestMessageSchema,
  HOST_TO_GUEST_MESSAGE_TYPES,
  HostToGuestMessageSchema,
  INSTANCE_CHANNEL_PATH,
  INSTANCE_PROTOCOL_COMPAT_VERSIONS,
  MAX_ADVERTISED_TICKETS,
  MintShareRequestSchema,
  PROTOCOL_VERSION,
  PrincipalSchema,
  ShareGrantSchema,
  ShareSchema,
  TICKET_REFUSALS,
  buildProtocolJsonSchema,
  normalizeInstanceOrigin,
  type GuestMessage,
  type HostToGuestMessage,
} from "@manifold/protocol";

const ORIGIN = "https://guest.example";
const HOST_ORIGIN = "https://host.example";

const principal = {
  id: "p1",
  kind: "human" as const,
  name: "Ada",
  color: "#1971c2",
};

const hello = (over: Record<string, unknown> = {}) => ({
  type: "hello" as const,
  protocolVersion: PROTOCOL_VERSION,
  origin: ORIGIN,
  instanceVersion: "0.6.0",
  token: "share-secret",
  ...over,
});

const welcome = (over: Record<string, unknown> = {}) => ({
  type: "welcome" as const,
  origin: HOST_ORIGIN,
  serverEpoch: "epoch-1",
  shareId: "s1",
  ref: { kind: "container" as const, containerId: "c1" },
  caps: ["containers:read" as const],
  title: "Shared canvas",
  tickets: [],
  ...over,
});

describe("instance origin", () => {
  test("normalization is total and canonical, because an origin two instances spell differently never matches", () => {
    /*
      The host compares the origin a guest DECLARES on its hello against the origin its share
      row RECORDED (ADR 0014 §2). That comparison is string equality, so every accepted value
      has to already be in one form — otherwise `http://Host:80/` and `http://host` are the
      same instance to a human and two instances to the check, which is a lockout nobody can
      diagnose from a log line.
    */
    const cases: Record<string, string> = {
      "http://localhost:7777": "http://localhost:7777",
      "http://localhost:7777/": "http://localhost:7777",
      "HTTP://LocalHost:7777/": "http://localhost:7777",
      "https://Host.Example:443/": "https://host.example",
      "http://host.example:80": "http://host.example",
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(normalizeInstanceOrigin(input)).toBe(expected);
    }
  });

  test("anything that is not a bare http(s) base URL is refused rather than trimmed into one", () => {
    /*
      Each refusal is a wrong ANSWER avoided, not a strictness preference. A path-mounted URL
      trimmed to its origin would address a different instance; a credentialed URL would put a
      secret in a field that lands in every attendance row; a `ws://` origin would be the
      transport, not the identity.
    */
    for (const bad of [
      "https://example.com/manifold",
      "https://user:pw@example.com",
      "ws://example.com",
      "example.com",
      "",
      "https://example.com/?q=1",
      "https://example.com/#frag",
    ]) {
      expect(normalizeInstanceOrigin(bad)).toBeNull();
    }
  });
});

describe("Principal.origin (ADR 0014 §4)", () => {
  test("absent means local, so every pre-v18 principal payload still parses", () => {
    expect(PrincipalSchema.parse(principal)).toEqual(principal);
  });

  test("a remote principal carries its origin as one normalized datum", () => {
    const remote = { ...principal, origin: ORIGIN };
    expect(PrincipalSchema.parse(remote)).toEqual(remote);
  });

  test("null is not a second spelling of local, and an unnormalized origin is refused", () => {
    /*
      One representation of "local" (omission) and one representation of an instance (its
      canonical origin). Admitting `null` too would give the local case two spellings that
      every consumer has to handle, and admitting `https://Host/` would let the mismatch check
      pass or fail depending on who typed the URL.
    */
    expect(PrincipalSchema.safeParse({ ...principal, origin: null }).success).toBe(false);
    expect(
      PrincipalSchema.safeParse({ ...principal, origin: "https://Host.Example/" }).success,
    ).toBe(false);
  });
});

describe("the instance channel handshake", () => {
  test("a hello carries the credential, the claim and the version", () => {
    const frame = hello();
    expect(GuestMessageSchema.parse(frame)).toEqual(frame);
  });

  test("resume rides the hello: advertised tickets in, the still-live subset back", () => {
    /*
      The machine channel's discipline generalized rather than a second reconnection mechanism
      (ADR 0014 §8): an agent's hello advertises retained TERMINALS and the welcome adopts
      them; a guest's hello advertises retained TICKET principals and the welcome answers with
      the ones still valid, so a guest whose ticket was revoked while it was disconnected drops
      that projection instead of discovering it one refused socket at a time.
    */
    const resumed = GuestMessageSchema.parse(hello({ tickets: ["hp1", "hp2"] }));
    if (resumed.type !== "hello") throw new Error("unreachable");
    expect(resumed.tickets).toEqual(["hp1", "hp2"]);

    const answered = HostToGuestMessageSchema.parse(welcome({ tickets: ["hp1"] }));
    if (answered.type !== "welcome") throw new Error("unreachable");
    expect(answered.tickets).toEqual(["hp1"]);

    const overflowing = hello({
      tickets: Array.from({ length: MAX_ADVERTISED_TICKETS + 1 }, (_, i) => `p${i}`),
    });
    expect(GuestMessageSchema.safeParse(overflowing).success).toBe(false);
  });

  test("the welcome names the node by (origin, ref) — the cross-instance reference form", () => {
    /*
      `manifold://` gains no authority component this wave (ADR 0014 §6), so a remote node is
      addressed by the PAIR. The ref is an address in the host's space and the origin says
      whose space that is.
    */
    const frame = welcome();
    expect(HostToGuestMessageSchema.parse(frame)).toEqual(frame);
    expect(HostToGuestMessageSchema.safeParse(welcome({ origin: "host.example" })).success).toBe(
      false,
    );
  });

  test("a ticket is an ordinary token whose principal carries the guest's origin", () => {
    /*
      The property the whole design rests on (ADR 0014 §3): nothing on this frame is a new
      credential kind. A host mints it through the ladder it already has, so the host's doors,
      its revocation fence and its attendance roster all work on a remote guest with no special
      case — and `origin` travels on the PRINCIPAL, not beside it.
    */
    const frame = {
      type: "ticket" as const,
      requestId: "r1",
      token: "ticket-secret",
      principal: { ...principal, id: "host-mirror-1", origin: ORIGIN },
    };
    const parsed = HostToGuestMessageSchema.parse(frame);
    if (parsed.type !== "ticket") throw new Error("unreachable");
    expect(parsed.principal.origin).toBe(ORIGIN);
  });

  test("a ticket refusal names a closed class, so a guest knows whether to ask again", () => {
    for (const reason of TICKET_REFUSALS) {
      const frame = { type: "ticket_error" as const, requestId: "r1", reason };
      expect(HostToGuestMessageSchema.parse(frame)).toEqual(frame);
    }
    expect(
      HostToGuestMessageSchema.safeParse({ type: "ticket_error", requestId: "r1", reason: "nope" })
        .success,
    ).toBe(false);
  });

  test("the frame inventories match their unions in both directions", () => {
    /*
      The same compile-time-plus-runtime pair machine.ts keeps: a classifier reads the
      inventory to tell an unknown type (forward-compat ignore) from a malformed known one (a
      protocol error), so an inventory that has drifted from its union turns a protocol error
      into silence.
    */
    const guestTypes = new Set<GuestMessage["type"]>(GUEST_MESSAGE_TYPES);
    const hostTypes = new Set<HostToGuestMessage["type"]>(HOST_TO_GUEST_MESSAGE_TYPES);
    expect(guestTypes.size).toBe(GUEST_MESSAGE_TYPES.length);
    expect(hostTypes.size).toBe(HOST_TO_GUEST_MESSAGE_TYPES.length);
    expect(GuestMessageSchema.safeParse({ type: "welcome" }).success).toBe(false);
    expect(HostToGuestMessageSchema.safeParse({ type: "hello" }).success).toBe(false);
  });

  test("liveness is ONE scheme: the instance channel and the machine channel share the constants", () => {
    /*
      ADR 0014 §7. The pair used to be named for the machine channel because it was the only
      dial; naming them for the discipline is what keeps the second dial from growing a second
      cadence, and the deadline stays two intervals plus grace on both.
    */
    expect(DIAL_PING_INTERVAL_MS).toBe(30_000);
    expect(DIAL_LIVENESS_TIMEOUT_MS).toBe(DIAL_PING_INTERVAL_MS * 2 + 15_000);
  });

  test("the instance wire has its OWN acceptance set", () => {
    /*
      Two wires, two sets, one discipline (invariant 10 applied per wire): sharing the machine
      set would mean an agent-wire reset locking out federated instances that never spoke that
      wire, and an instance-frame change restarting a fleet of PTY agents that never spoke this
      one. The set GROWS by the same first clause the machine set grows by — v19 moved a
      session frame pair, which a guest instance never sees — so a v18 dial survives the
      deploy.
    */
    expect(INSTANCE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION)).toBe(true);
    expect([...INSTANCE_PROTOCOL_COMPAT_VERSIONS]).toEqual([
      PROTOCOL_VERSION - 1,
      PROTOCOL_VERSION,
    ]);
  });
});

describe("share vocabulary", () => {
  test("a share record cannot carry a secret", () => {
    /*
      Secrets discipline (invariant 6) enforced by the SHAPE rather than by a redaction rule
      somebody has to remember: the raw token exists in exactly one schema — the grant handed
      to the caller who just minted it — so a list door, a log line or an audit view physically
      cannot publish one.
    */
    const share = {
      id: "s1",
      ref: { kind: "container" as const, containerId: "c1" },
      caps: ["containers:read" as const],
      origin: ORIGIN,
      createdAt: 1_700_000_000_000,
      createdBy: "p0",
      revokedAt: null,
      tickets: 2,
    };
    expect(ShareSchema.parse(share)).toEqual(share);
    expect(ShareSchema.safeParse({ ...share, token: "leak" }).success).toBe(false);
    expect(ShareSchema.safeParse({ ...share, hash: "leak" }).success).toBe(false);
    expect(ShareGrantSchema.parse({ share, token: "raw" })).toEqual({ share, token: "raw" });
  });

  test("minting addresses the node by manifold:// reference, never by a bare id", () => {
    /*
      Invariant 13: `manifold://` is the canonical reference form for anything addressable, and
      a grant naming a container by bare id would be the second address system it forbids. The
      wave's container-only rule is the DOOR's refusal, not the schema's, because ADR 0011
      widens this field to subtree grants without reshaping it.
    */
    const request = {
      node: { kind: "container" as const, containerId: "c1" },
      caps: ["containers:read" as const, "scenes:write" as const],
      origin: ORIGIN,
    };
    expect(MintShareRequestSchema.parse(request)).toEqual(request);
    expect(MintShareRequestSchema.safeParse({ ...request, caps: [] }).success).toBe(false);
    expect(
      MintShareRequestSchema.safeParse({
        containerId: "c1",
        caps: ["containers:read"],
        origin: ORIGIN,
      }).success,
    ).toBe(false);
  });
});

describe("published vocabulary", () => {
  test("the instance channel is described at /api/protocol, like the other two wires", () => {
    /*
      A3 applied to a stranger's INSTANCE rather than a stranger's agent: it has to learn the
      handshake, the ticket exchange and the closed refusal set from a published document, not
      from this source tree.
    */
    const schema = buildProtocolJsonSchema();
    const instance = schema["instance"] as Record<string, unknown>;
    expect(instance["path"]).toBe(INSTANCE_CHANNEL_PATH);
    expect(instance["ticketRefusals"]).toEqual([...TICKET_REFUSALS]);
    expect(instance["guest"]).toBeDefined();
    expect(instance["host"]).toBeDefined();
    expect(instance["share"]).toBeDefined();
  });
});
