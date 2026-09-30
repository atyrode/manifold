import { describe, expect, test } from "bun:test";
import type { Principal } from "@manifold/protocol";
import { AuthService, INTERACTIVE_TOKEN_TTL_MS, ServiceError } from "../src/auth.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { InstanceGateway } from "../src/instance-ws.ts";
import { silentLogger } from "../src/log.ts";
import { FakeClock, FakeRuntime, testStore } from "./helpers.ts";

const GUEST_ORIGIN = "https://guest.example";
const visitor: Principal = { id: "guest-human", kind: "human", name: "Visitor", color: "#3355cc" };

/** Actual host gateway and guest SDK transport, with separate durable identity namespaces. */
function peers() {
  const runtime = new FakeRuntime();
  runtime.time = 1_700_000_000_000;
  const hostStore = testStore();
  const guestStore = testStore();
  const auth = new AuthService(hostStore, "a".repeat(64), runtime);
  const owner = auth.authenticate("a".repeat(64));
  const containerId = runtime.newId();
  hostStore.createContainer({
    id: containerId,
    name: "Host canvas",
    createdAt: runtime.now(),
    discipline: "canvas",
  });
  const grant = auth.mintShare(
    {
      node: { kind: "container", containerId },
      caps: ["containers:read", "scenes:write", "terminals:write"],
      origin: GUEST_ORIGIN,
    },
    owner,
  );
  let origin = "";
  const gateway = new InstanceGateway(
    auth,
    hostStore,
    new FakeClock(runtime),
    silentLogger,
    "host-epoch",
    () => origin,
  );
  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ws/instance") {
        if (server.upgrade(request, { data: { id: runtime.newId() } })) return;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        gateway.open(socket.data.id, {
          get bufferedAmount() {
            return socket.getBufferedAmount();
          },
          send(data) {
            return socket.send(data);
          },
          close(code, reason) {
            socket.close(code, reason);
          },
        });
      },
      message(socket, data) {
        gateway.message(socket.data.id, data);
      },
      close(socket) {
        gateway.close(socket.data.id);
      },
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const revoked = Promise.withResolvers<void>();
  const dialer = new InstanceDialer(
    guestStore,
    runtime,
    {
      ...silentLogger,
      info(event, fields) {
        if (event === "dial_status" && fields?.["status"] === "revoked") revoked.resolve();
      },
    },
    () => GUEST_ORIGIN,
  );
  return {
    runtime,
    auth,
    owner,
    grant,
    guestStore,
    dialer,
    origin,
    revoked: revoked.promise,
    async close() {
      dialer.shutdown();
      gateway.shutdown();
      await server.stop(true);
      guestStore.close();
      hostStore.close();
    },
  };
}

async function refusal(work: Promise<unknown>): Promise<ServiceError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error("expected an admission refusal");
}

describe("guest dial admission", () => {
  test("unapproved and wider requests stay truthful refusals without severing a live dial", async () => {
    const f = peers();
    try {
      const dial = await f.dialer.dial({ origin: f.origin, token: f.grant.token });
      const pending = await refusal(f.dialer.open(dial.id, visitor));
      expect(pending.code).toBe("forbidden");
      expect(pending.message).toBe("recipient_unapproved");
      expect(f.auth.listShareRecipients(f.grant.share.id, f.owner)[0]?.requestedCaps).toEqual(
        f.grant.share.caps,
      );
      f.auth.approveShareRecipient(
        { shareId: f.grant.share.id, guestPrincipalId: visitor.id, caps: ["containers:read"] },
        f.owner,
      );

      const ticket = await f.dialer.open(dial.id, visitor);
      expect(ticket.caps).toEqual(["containers:read"]);
      expect(ticket.expiresAt).toBe(f.runtime.now() + INTERACTIVE_TOKEN_TTL_MS);
      expect(f.auth.authenticate(ticket.token).principal.origin).toBe(GUEST_ORIGIN);
      expect(f.auth.authenticate(ticket.token).principal.id).not.toBe(visitor.id);
      const wider = await refusal(f.dialer.open(dial.id, visitor, ["scenes:write"]));
      expect(wider.code).toBe("forbidden");
      expect(wider.message).toBe("recipient_caps_refused");
      const other = await refusal(f.dialer.open(dial.id, { ...visitor, id: "other-guest" }));
      expect(other.message).toBe("recipient_unapproved");
      expect(f.dialer.list()[0]?.status).toBe("live");
      expect(f.guestStore.getDial(dial.id)?.revokedAt).toBeNull();
      expect(f.auth.authenticate(ticket.token).caps).toEqual(["containers:read"]);
    } finally {
      await f.close();
    }
  });

  test("explicit attenuation and finite expiry use issued bounds, not the dial's cached ceiling", async () => {
    const f = peers();
    try {
      const dial = await f.dialer.dial({ origin: f.origin, token: f.grant.token });
      await refusal(f.dialer.open(dial.id, visitor));
      f.auth.approveShareRecipient(
        {
          shareId: f.grant.share.id,
          guestPrincipalId: visitor.id,
          caps: ["containers:read", "scenes:write"],
        },
        f.owner,
      );
      const attenuated = await f.dialer.open(dial.id, visitor, ["containers:read"]);
      expect(attenuated.caps).toEqual(["containers:read"]);
      expect(f.auth.authenticate(attenuated.token).caps).toEqual(["containers:read"]);
      f.runtime.time = attenuated.expiresAt - 1;
      expect(f.auth.authenticate(attenuated.token).principal.origin).toBe(GUEST_ORIGIN);
      f.runtime.time = attenuated.expiresAt;
      expect(() => f.auth.authenticate(attenuated.token)).toThrow("expired");

      const renewed = await f.dialer.open(dial.id, visitor);
      expect(renewed.caps).toEqual(["containers:read", "scenes:write"]);
      expect(renewed.expiresAt).toBe(f.runtime.now() + INTERACTIVE_TOKEN_TTL_MS);
      f.auth.revokeShare(f.grant.share.id, f.owner);
      expect(() => f.auth.authenticate(renewed.token)).toThrow("revoked");
      await f.revoked;
      const revoked = await refusal(f.dialer.open(dial.id, visitor));
      expect(revoked.code).toBe("forbidden");
      expect(revoked.message).toBe("revoked");
      expect(f.dialer.list()[0]?.status).toBe("revoked");
    } finally {
      await f.close();
    }
  });
});
