import {
  DIAL_PING_INTERVAL_MS,
  GUEST_MESSAGE_TYPES,
  GuestMessageSchema,
  HostToGuestMessageSchema,
  INSTANCE_PROTOCOL_COMPAT_VERSIONS,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  normalizeInstanceOrigin,
  type GuestMessage,
  type HostToGuestMessage,
  type Principal,
} from "@manifold/protocol";
import { ServiceError, type AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { RoomTimers } from "./room.ts";
import type { RawSocket } from "./session-channel.ts";
import type { ServerStore } from "./stores.ts";

type ClassifiedFrame =
  | { kind: "message"; message: GuestMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

const KNOWN_GUEST_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  GUEST_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

const HELLO_DEADLINE_MS = 10_000;

interface InstanceConnection {
  socket: RawSocket;
  /** The share this socket is authenticated as. Null until `hello` succeeds. */
  shareId: string | null;
  cancelHelloTimeout: (() => void) | null;
  cancelPing: (() => void) | null;
  awaitingPong: boolean;
  closed: boolean;
}

function classifyGuestFrame(data: unknown): ClassifiedFrame {
  if (typeof data !== "string") return { kind: "malformed", detail: "non-text frame" };
  if (Buffer.byteLength(data) > MAX_SESSION_FRAME_BYTES) {
    return { kind: "malformed", detail: "frame exceeds 1 MiB" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  if (raw === null || typeof raw !== "object") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  const frameType = Reflect.get(raw, "type");
  if (typeof frameType !== "string") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  if (KNOWN_GUEST_TYPES[frameType] !== true) return { kind: "unknown_type", frameType };
  const parsed = GuestMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${frameType} frame` };
  return { kind: "message", message: parsed.data };
}

/**
 * Authenticates, fences and dispatches every `/ws/instance` connection: the HOST half of a
 * dial, and the generalization AXIOMS A4 names when it calls the machine channel "the
 * shipped precedent it generalizes".
 *
 * It is the same shape as `MachineGateway`, deliberately and almost line for line — a
 * bounded hello deadline, a compat-version set rather than strict equality because the peer
 * is long-lived and survives deploys, a supersession fence on re-dial, a ping the peer must
 * answer before the next one fires, and a revocation fence that closes the socket. There is
 * one liveness discipline in this codebase and this file does not get a second one.
 *
 * What it is NOT is a data path. No scene bytes, no presence, no terminal output ever cross
 * this socket. The guest's own lens dials the host's `/ws/session` with a ticket minted
 * here, so a shared container projects through the SAME room, the same sync, the same doors
 * a local viewer uses (invariant 14). This channel exists to answer one question — "may this
 * principal from that instance have a pipe, and is the grant still alive?" — and it carries
 * exactly the frames that question needs.
 */
export class InstanceGateway {
  private readonly connections = new Map<string, InstanceConnection>();
  private readonly activeByShare = new Map<string, InstanceConnection>();
  private readonly removeShareRevocationListener: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly store: ServerStore,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly serverEpoch: string,
    /**
     * Read LATE, never captured. `finalizePublicUrl` cannot run until Bun reports the bound
     * port, so a port-0 instance does not know its own origin at construction — and the
     * origin is what every welcome tells the guest to address this instance by.
     */
    private readonly origin: () => string,
  ) {
    this.removeShareRevocationListener = auth.onShareRevoked((shareId) => {
      this.revokeShare(shareId);
    });
  }

  /** Starts a bounded hello deadline for a newly upgraded instance socket. */
  open(id: string, socket: RawSocket): void {
    const connection: InstanceConnection = {
      socket,
      shareId: null,
      cancelHelloTimeout: null,
      cancelPing: null,
      awaitingPong: false,
      closed: false,
    };
    connection.cancelHelloTimeout = this.timers.schedule(() => {
      connection.cancelHelloTimeout = null;
      if (connection.shareId === null) {
        this.logger.warn("instance_hello_timeout");
        socket.close(4002, "hello timeout");
      }
    }, HELLO_DEADLINE_MS);
    this.connections.set(id, connection);
  }

  /** Classifies and validates one guest frame before handshake or dispatch. */
  message(id: string, data: unknown): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    const classified = classifyGuestFrame(data);
    switch (classified.kind) {
      case "unknown_type":
        this.logger.warn("instance_unknown_frame");
        return;
      case "malformed":
        this.logger.warn("instance_malformed_frame", { detail: classified.detail });
        connection.socket.close(4002, "malformed guest frame");
        return;
      case "message":
        if (connection.shareId === null) {
          this.hello(connection, classified.message);
          return;
        }
        if (this.activeByShare.get(connection.shareId) !== connection) return;
        this.dispatch(connection, classified.message);
        return;
      default: {
        const exhaustive: never = classified;
        void exhaustive;
      }
    }
  }

  private send(connection: InstanceConnection, message: HostToGuestMessage): boolean {
    if (connection.closed) return false;
    return connection.socket.send(JSON.stringify(HostToGuestMessageSchema.parse(message))) > 0;
  }

  private hello(connection: InstanceConnection, message: GuestMessage): void {
    if (message.type !== "hello") {
      this.logger.warn("instance_rejected", { code: 4002, reason: "first frame must be hello" });
      connection.socket.close(4002, "first frame must be hello");
      return;
    }
    if (!INSTANCE_PROTOCOL_COMPAT_VERSIONS.has(message.protocolVersion)) {
      // Say so out loud, for the reason the machine channel says it out loud: a dialed
      // instance is long-lived, and a silent version lockout is a partnership that goes
      // dark with nothing in either operator's log to explain it.
      this.logger.warn("instance_version_rejected", {
        guestProtocolVersion: message.protocolVersion,
        serverProtocolVersion: PROTOCOL_VERSION,
        guestOrigin: message.origin,
      });
      connection.socket.close(4409, "protocol version mismatch");
      return;
    }

    let share;
    try {
      share = this.auth.authenticateShare(message.token);
    } catch (error) {
      const revoked = error instanceof ServiceError && error.code === "forbidden";
      this.logger.warn("instance_rejected", {
        code: revoked ? 4403 : 4401,
        reason: revoked ? "revoked" : "unauthorized",
        guestOrigin: message.origin,
      });
      connection.socket.close(revoked ? 4403 : 4401, revoked ? "revoked" : "unauthorized");
      return;
    }

    /*
      The declared origin is CHECKED against the recorded one rather than believed. A share
      is minted for a named instance (ADR 0014), so this comparison is what turns the
      guest's `origin` from a claim into the datum every ticket principal carries — and
      invariant 11 needs it to be a datum, because nothing downstream of arbitration is
      allowed to re-decide it. 4401 rather than 4403: the credential is not valid AS
      PRESENTED, which is unauthorized; 4403 stays the revocation code it is on every other
      channel.
    */
    const declared = normalizeInstanceOrigin(message.origin);
    if (declared === null || declared !== share.origin) {
      this.logger.warn("instance_rejected", {
        code: 4401,
        reason: "origin mismatch",
        guestOrigin: message.origin,
      });
      connection.socket.close(4401, "origin mismatch");
      return;
    }

    connection.shareId = share.id;
    connection.cancelHelloTimeout?.();
    connection.cancelHelloTimeout = null;

    /*
      RESUME. The guest advertises the host-side ticket principals it still believes it
      holds, exactly as an agent's hello advertises its retained PTYs, and the welcome
      answers with the subset that survived. Anything missing from the answer is a
      projection the guest must drop — which is the whole of resume, with no second frame
      and no offsets, because catch-up is reading state.
    */
    const held = new Set(this.store.shareTicketPrincipals(share.id));
    const tickets = (message.tickets ?? []).filter((principalId) => held.has(principalId));
    const container = this.store.getContainer(share.containerId);

    const older = this.activeByShare.get(share.id);
    this.activeByShare.set(share.id, connection);
    if (
      !this.send(connection, {
        type: "welcome",
        origin: this.origin(),
        serverEpoch: this.serverEpoch,
        shareId: share.id,
        ref: { kind: "container", containerId: share.containerId },
        caps: [...share.caps],
        title: container?.name ?? null,
        tickets,
      })
    ) {
      connection.socket.close(1011, "welcome frame dropped");
      return;
    }
    if (older !== undefined && older !== connection) {
      this.logger.info("instance_superseded", { shareId: share.id });
      older.socket.close(4001, "superseded");
    }
    this.logger.info("instance_dialed", { shareId: share.id, guestOrigin: declared });
    this.schedulePing(connection);
  }

  /** Arms the next liveness ping; an unanswered previous ping closes the socket. */
  private schedulePing(connection: InstanceConnection): void {
    connection.cancelPing = this.timers.schedule(() => {
      connection.cancelPing = null;
      if (connection.shareId === null || connection.closed) return;
      if (connection.awaitingPong) {
        this.logger.warn("instance_liveness_timeout", { shareId: connection.shareId });
        connection.socket.close(4008, "liveness timeout");
        return;
      }
      connection.awaitingPong = true;
      if (!this.send(connection, { type: "ping" })) {
        connection.socket.close(1011, "ping frame dropped");
        return;
      }
      this.schedulePing(connection);
    }, DIAL_PING_INTERVAL_MS);
  }

  private dispatch(connection: InstanceConnection, message: GuestMessage): void {
    switch (message.type) {
      case "hello":
        connection.socket.close(4002, "duplicate hello");
        return;
      case "pong":
        connection.awaitingPong = false;
        return;
      case "ticket_request":
        this.ticket(connection, message.requestId, message.principal);
        return;
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  /**
   * THE ticket hop. A guest principal asks its own instance for a pipe, its instance asks
   * here, and what comes back is an ordinary attenuated token for an ordinary principal —
   * so the projection that follows is an ordinary session join, arriving at the host's
   * doors with the share's capabilities and nothing else. The ladder is the ladder.
   */
  private ticket(connection: InstanceConnection, requestId: string, principal: Principal): void {
    const shareId = connection.shareId;
    if (shareId === null) return;
    const share = this.store.getShare(shareId);
    if (share === null || share.revokedAt !== null) {
      this.send(connection, { type: "ticket_error", requestId, reason: "share_revoked" });
      return;
    }
    let grant;
    try {
      grant = this.auth.mintShareTicket(share, principal);
    } catch (error) {
      const reason = error instanceof ServiceError ? "invalid_principal" : "unavailable";
      this.logger.warn("instance_ticket_refused", { shareId, reason });
      this.send(connection, { type: "ticket_error", requestId, reason });
      return;
    }
    this.logger.info("instance_ticket_issued", {
      shareId,
      principalId: grant.principal.id,
    });
    this.send(connection, {
      type: "ticket",
      requestId,
      token: grant.token,
      principal: grant.principal,
    });
  }

  /** Whether a share currently holds a live control link. */
  isLive(shareId: string): boolean {
    return this.activeByShare.has(shareId);
  }

  /**
   * Cuts the control link for a revoked share. The PROJECTIONS it minted are cut by the
   * principal fence in `SessionGateway` — two credentials, two fences, and this one only
   * owes the socket authenticated by the share's own secret.
   */
  revokeShare(shareId: string): void {
    for (const [id, connection] of [...this.connections]) {
      if (connection.shareId !== shareId) continue;
      connection.socket.close(4403, "revoked");
      this.close(id);
    }
  }

  /** Cleans per-socket state after an instance socket closes. */
  close(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    connection.closed = true;
    connection.cancelHelloTimeout?.();
    connection.cancelPing?.();
    connection.cancelPing = null;
    const shareId = connection.shareId;
    if (shareId === null) return;
    if (this.activeByShare.get(shareId) === connection) this.activeByShare.delete(shareId);
  }

  /** Closes every instance channel and unregisters the share fence at shutdown. */
  shutdown(): void {
    this.removeShareRevocationListener();
    for (const [id, connection] of [...this.connections]) {
      connection.socket.close(1001, "server shutting down");
      this.close(id);
    }
  }
}
