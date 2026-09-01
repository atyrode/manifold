import {
  DIAL_LIVENESS_TIMEOUT_MS,
  HOST_TO_GUEST_MESSAGE_TYPES,
  HostToGuestMessageSchema,
  MAX_ADVERTISED_TICKETS,
  PROTOCOL_VERSION,
  type Cap,
  type DialStatus,
  type GuestMessage,
  type HostToGuestMessage,
  type ManifoldRef,
  type Principal,
  type TicketRefusal,
} from "@manifold/protocol";
import {
  LivenessWatchdog,
  MALFORMED_FRAME_CLOSE_CODE,
  ReconnectBackoff,
  classifyEnvelope,
} from "./dial-loop.ts";

/**
 * THE guest half of the instance channel (ADR 0014): one long-lived control link from this
 * instance to a host it holds a share on.
 *
 * It lives in the SDK for the reason invariant 3 states outright — "no second WebSocket state
 * machine; extend `@manifold/sdk`". The agent owns the machine channel's dialing half and this
 * owns the instance channel's, and both are the same discipline: dial out, hello, answer pings,
 * treat silence as a phantom transport, reconnect with jittered backoff, and classify frames so
 * an unknown type is ignored while a malformed known one is a protocol error.
 *
 * What it deliberately does NOT do is carry a projection. A shared container is rendered by
 * pointing an ordinary {@link SessionClient} at the HOST with a ticket this link obtained —
 * one client, one room machinery, no relay (`AXIOMS.md` §The portable lens).
 */

/** Reported in `hello`; bump on breaking guest-side behavior. */
const INSTANCE_VERSION = "0.1.0";

/** How long a ticket request waits before answering `unavailable` rather than hanging. */
const DEFAULT_TICKET_TIMEOUT_MS = 10_000;

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_CAP_MS = 15_000;

/** Close code the host uses for a revoked share: the fence, not a network blip. */
const REVOKED_CLOSE_CODE = 4403;

const KNOWN_HOST_TYPES: Record<string, true> = Object.fromEntries(
  HOST_TO_GUEST_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

type ClassifiedFrame =
  | { readonly kind: "message"; readonly message: HostToGuestMessage }
  | { readonly kind: "unknown_type" }
  | { readonly kind: "malformed" };

/**
 * Frame policy, identical to the agent's and the pool's: an unknown `type` is ignored for
 * forward compatibility (a newer host may say things this guest has no opinion about), while a
 * malformed frame of a KNOWN type means the two ends disagree about a shape they both claim to
 * speak — close and heal through the reconnect path. The envelope half is the dial skeleton's
 * (`./dial-loop.ts`); what a valid host frame IS stays here, with the schema that says so.
 */
function classifyHostFrame(data: unknown): ClassifiedFrame {
  const envelope = classifyEnvelope(data, (type) => KNOWN_HOST_TYPES[type] === true);
  if (envelope.kind === "unknown_type") return envelope;
  if (envelope.kind === "malformed") return { kind: "malformed" };
  const parsed = HostToGuestMessageSchema.safeParse(envelope.raw);
  return parsed.success ? { kind: "message", message: parsed.data } : { kind: "malformed" };
}

/** The share as the host last described it; null until the first `welcome` of this process. */
export interface DialedShare {
  readonly shareId: string;
  /** The node's address in the HOST's space; with {@link InstanceDial.hostOrigin}, the reference. */
  readonly ref: ManifoldRef;
  readonly caps: readonly Cap[];
  readonly title: string | null;
}

/**
 * What a ticket request answers. A refusal is DATA, exactly as it is at every door: the caller
 * renders or relays it, and a promise that rejected would make a named refusal into an
 * exception nobody can classify. `unavailable` also covers a dropped socket and a request that
 * outlived its deadline, so this never hangs and never throws for an expected outcome.
 */
export type TicketOutcome =
  | { readonly ok: true; readonly token: string; readonly principal: Principal }
  | { readonly ok: false; readonly reason: TicketRefusal };

export interface InstanceDialOptions {
  /** The host's `/ws/instance` URL, dialled verbatim — this module guesses no URLs. */
  readonly url: string;
  /** The share secret. Held by the guest INSTANCE and never handed to a guest user. */
  readonly token: string;
  /** THIS instance's own origin, declared in the hello; a mismatch closes 4401 at the host. */
  readonly origin: string;
  /** Reconnect on unexpected close (default true). A revoked share never reconnects. */
  readonly reconnect?: boolean;
  readonly backoffCapMs?: number;
  /** Deadline for one ticket request before it answers `unavailable` (default 10s). */
  readonly ticketTimeoutMs?: number;
  /** Silence deadline before the transport is declared a phantom (default 75s, protocol). */
  readonly livenessTimeoutMs?: number;
  /** DI seam for tests, mirroring `SessionClientOptions.webSocketFactory`. */
  readonly webSocketFactory?: (url: string) => WebSocket;
}

interface PendingTicket {
  readonly settle: (outcome: TicketOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class InstanceDial {
  private readonly url: string;
  private readonly token: string;
  private readonly selfOrigin: string;
  private readonly shouldReconnect: boolean;
  private readonly ticketTimeoutMs: number;
  private readonly createSocket: (url: string) => WebSocket;

  private socket: WebSocket | null = null;
  private readonly backoff: ReconnectBackoff;
  private readonly liveness: LivenessWatchdog;
  private closed = false;
  private statusValue: DialStatus = "offline";
  private hostOriginValue: string | null = null;
  private serverEpochValue: string | null = null;
  private shareValue: DialedShare | null = null;
  private nextRequest = 0;

  /**
   * Host-side principal ids this guest holds tickets for. Advertised on every hello and pruned
   * to the subset the welcome confirms — the resume mechanism, carried by the handshake exactly
   * as the machine channel carries its retained terminals (ADR 0014 §8).
   */
  private readonly ticketPrincipals = new Set<string>();
  private readonly pending = new Map<string, PendingTicket>();
  private readonly statusListeners = new Set<(status: DialStatus) => void>();
  private readonly revokedListeners = new Set<() => void>();
  private welcomeWaiters: Array<(dial: InstanceDial) => void> = [];

  constructor(options: InstanceDialOptions) {
    this.url = options.url;
    this.token = options.token;
    this.selfOrigin = options.origin;
    this.shouldReconnect = options.reconnect ?? true;
    this.ticketTimeoutMs = options.ticketTimeoutMs ?? DEFAULT_TICKET_TIMEOUT_MS;
    this.createSocket = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    this.liveness = new LivenessWatchdog({
      timeoutMs: options.livenessTimeoutMs ?? DIAL_LIVENESS_TIMEOUT_MS,
      reason: "host silent past deadline",
      current: () => this.socket,
    });
    this.backoff = new ReconnectBackoff({
      baseMs: DEFAULT_BACKOFF_BASE_MS,
      capMs: options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
      dial: () => this.dial(),
    });
    this.dial();
  }

  /** `live` once a welcome lands, `offline` while the transport is down, `revoked` once fenced. */
  get status(): DialStatus {
    return this.statusValue;
  }

  /** The host's own origin, learned from `welcome`; with `share.ref`, the node's reference. */
  get hostOrigin(): string | null {
    return this.hostOriginValue;
  }

  /** The host's boot epoch, learned from `welcome`; null while disconnected. */
  get serverEpoch(): string | null {
    return this.serverEpochValue;
  }

  get share(): DialedShare | null {
    return this.shareValue;
  }

  /** Host-side principals this dial currently holds tickets for. */
  get tickets(): readonly string[] {
    return [...this.ticketPrincipals];
  }

  /** Resolves on the next successful handshake; a revoked dial resolves nothing. */
  ready(): Promise<InstanceDial> {
    if (this.statusValue === "live") return Promise.resolve(this);
    const { promise, resolve } = Promise.withResolvers<InstanceDial>();
    this.welcomeWaiters.push(resolve);
    return promise;
  }

  onStatus(listener: (status: DialStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires once the host fences this share: the projection is dead and re-dialing is noise. */
  onRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  /**
   * Asks the host for a ticket for one of THIS instance's principals — the second step of the
   * three (ADR 0014 §3), after the guest's own door decided this principal may use the share.
   * The answer is an ordinary attenuated token whose principal carries this instance's origin.
   */
  requestTicket(principal: Principal): Promise<TicketOutcome> {
    if (this.closed) throw new Error("instance dial is closed");
    const socket = this.socket;
    if (this.statusValue !== "live" || socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, reason: "unavailable" });
    }
    this.nextRequest += 1;
    const requestId = `t${this.nextRequest}`;
    const { promise, resolve } = Promise.withResolvers<TicketOutcome>();
    const pending: PendingTicket = {
      settle: (outcome) => {
        const record = this.pending.get(requestId);
        if (record === undefined) return;
        this.pending.delete(requestId);
        if (record.timer !== null) clearTimeout(record.timer);
        resolve(outcome);
      },
      timer: null,
    };
    this.pending.set(requestId, pending);
    pending.timer = setTimeout(
      () => pending.settle({ ok: false, reason: "unavailable" }),
      this.ticketTimeoutMs,
    );
    this.send(socket, { type: "ticket_request", requestId, principal });
    return promise;
  }

  /** Stops reconnecting and drops the socket. Pending ticket requests answer `unavailable`. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "closed");
    this.failPending();
    this.setStatus(this.statusValue === "revoked" ? "revoked" : "offline");
  }

  private dial(): void {
    if (this.closed) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.liveness.arm(socket);
      this.send(socket, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        origin: this.selfOrigin,
        instanceVersion: INSTANCE_VERSION,
        token: this.token,
        tickets: [...this.ticketPrincipals].slice(0, MAX_ADVERTISED_TICKETS),
      });
    };
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.liveness.arm(socket);
      this.onFrame(socket, event.data);
    };
    socket.onerror = () => this.onDisconnect(socket);
    socket.onclose = (event: CloseEvent) => this.onDisconnect(socket, event.code);
  }

  private onFrame(socket: WebSocket, data: unknown): void {
    const classified = classifyHostFrame(data);
    switch (classified.kind) {
      case "unknown_type":
        return;
      case "malformed":
        socket.close(MALFORMED_FRAME_CLOSE_CODE, "malformed frame");
        return;
      case "message":
        this.handle(socket, classified.message);
        return;
      default: {
        const exhaustive: never = classified;
        void exhaustive;
      }
    }
  }

  private handle(socket: WebSocket, message: HostToGuestMessage): void {
    switch (message.type) {
      case "welcome": {
        this.backoff.reset();
        this.hostOriginValue = message.origin;
        this.serverEpochValue = message.serverEpoch;
        this.shareValue = {
          shareId: message.shareId,
          ref: message.ref,
          caps: message.caps,
          title: message.title,
        };
        /*
          The resume answer. Tickets the host no longer honours are dropped HERE rather than
          when a projection using one is refused: a guest that keeps advertising a dead ticket
          would re-learn the same answer on every reconnect, and a lens still pointed at it
          would discover the death as an unexplained 4403.
        */
        const live = new Set(message.tickets);
        for (const principalId of [...this.ticketPrincipals]) {
          if (!live.has(principalId)) this.ticketPrincipals.delete(principalId);
        }
        this.setStatus("live");
        const waiters = this.welcomeWaiters;
        this.welcomeWaiters = [];
        for (const resolve of waiters) resolve(this);
        return;
      }
      case "ping":
        this.send(socket, { type: "pong" });
        return;
      case "ticket":
        this.ticketPrincipals.add(message.principal.id);
        this.pending
          .get(message.requestId)
          ?.settle({ ok: true, token: message.token, principal: message.principal });
        return;
      case "ticket_error":
        this.pending.get(message.requestId)?.settle({ ok: false, reason: message.reason });
        return;
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  private send(socket: WebSocket, message: GuestMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private onDisconnect(socket: WebSocket, code?: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.serverEpochValue = null;
    this.liveness.clear();
    this.failPending();
    if (code === REVOKED_CLOSE_CODE) {
      /*
        The share is gone, not the network. Re-dialing a revoked share forever is noise a host
        has to refuse over and over, and the guest already knows the answer: park in `revoked`
        and let the owner of this dial decide what to do with the row.
      */
      this.setStatus("revoked");
      for (const listener of [...this.revokedListeners]) listener();
      return;
    }
    this.setStatus("offline");
    if (this.closed || !this.shouldReconnect) return;
    this.backoff.schedule();
  }

  private failPending(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.pending.get(requestId)?.settle({ ok: false, reason: "unavailable" });
    }
  }

  private clearTimers(): void {
    this.backoff.cancel();
    this.liveness.clear();
  }

  private setStatus(status: DialStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }
}

/**
 * Dials a host instance over the instance channel. The returned handle is live immediately and
 * connects in the background; `ready()` awaits the first welcome.
 *
 * The PROJECTION half needs nothing from this module: a shared container is rendered by
 * constructing a `SessionClient` against the host's session URL with a ticket from
 * {@link InstanceDial.requestTicket}. That is the portable-lens rule discharged in code — the
 * pool already keys connections by (factory, url, token), which IS the `(origin, containerId)`
 * keying wave 1 reserved for this wave to supply real origins to.
 */
export function dialInstance(options: InstanceDialOptions): InstanceDial {
  return new InstanceDial(options);
}
