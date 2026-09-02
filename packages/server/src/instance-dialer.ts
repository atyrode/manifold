import {
  formatManifoldUri,
  normalizeInstanceOrigin,
  parseManifoldUri,
  type Dial,
  type EventKind,
  type DialShareRequest,
  type DialStatus,
  type DialTicket,
  type Principal,
  type RuntimeDeps,
} from "@manifold/protocol";
import { dialInstance, type InstanceDial } from "@manifold/sdk";
import { ServiceError } from "./auth.ts";
import type { EventHub } from "./event-hub.ts";
import type { Logger } from "./log.ts";
import type { DialRecord, ServerStore } from "./stores.ts";

/**
 * How long `dialShare` waits for the host's `welcome` before refusing.
 *
 * The door blocks on the handshake ON PURPOSE, and this constant is the cost of that
 * decision. The alternative — record the row, answer immediately, dial in the background —
 * turns every rejection the host can issue (bad token, wrong origin, already revoked, not
 * running) into the same silent zombie row, and "your share is offline, indefinitely, for
 * no stated reason" is precisely the deferral-shaped bug AXIOMS §Change control forbids.
 * Waiting means a refusal is a refusal, and it means a dial row never exists without the
 * host's own word on what it names.
 */
const DIAL_WELCOME_TIMEOUT_MS = 10_000;

/** `http(s)://host` → `ws(s)://host/ws/instance`. The one place the endpoint is spelled. */
function instanceEndpoint(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/instance";
  return url.toString();
}

/**
 * The word for each transition, spelled out rather than composed from the status, because
 * an event kind is a published vocabulary term (`core.access`'s `contributes.events`) and a
 * term assembled at runtime from a template is a term no grep finds and no manifest can be
 * checked against.
 */
const DIAL_EVENT_KINDS: Record<DialStatus, EventKind> = {
  live: "dial_online",
  offline: "dial_offline",
  revoked: "dial_revoked",
};

/**
 * The GUEST half of a dial: the rows this instance holds, the sockets that keep them live,
 * and the one door that turns a row into a ticket its own principals may project with.
 *
 * It owns no transport. `dialInstance` from the SDK owns the socket, the jittered backoff
 * and the liveness deadline, because the agent already has one implementation of that and
 * the SDK already has another — a third here would be the second convention invariant 14
 * forbids, and D14 says a pattern this generic gets a named evaluation before it is
 * hand-rolled. What this service owns is what the SDK cannot: durable rows, the plane
 * events an operator watches, and the door where THIS instance decides which of its
 * principals may use a grant its host addressed to the instance as a whole.
 *
 * It is deliberately not an authority. `caps` and `ref` on a dial row are the host's last
 * word, cached so a row can be drawn while the socket is down; every real decision about
 * what a ticket may do happens at the host's doors, where a ticket is an ordinary token.
 */
export class InstanceDialer {
  private readonly live = new Map<string, InstanceDial>();
  private events: EventHub | null = null;

  constructor(
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
    private readonly origin: () => string,
  ) {}

  /**
   * Installed rather than constructed, for the reason every other floor emitter is: the hub
   * validates an emission against the assembly, and the assembly is downstream of this
   * service. Until this runs a dial changes status silently, which is correct during boot —
   * nobody can be subscribed yet.
   */
  setEvents(events: EventHub): void {
    this.events = events;
  }

  /** Re-opens every live dial row, so a restart resumes this instance's partnerships. */
  start(): void {
    for (const record of this.store.listDials()) {
      if (record.revokedAt !== null) continue;
      this.connect(record);
    }
  }

  private connect(record: DialRecord): InstanceDial {
    const existing = this.live.get(record.id);
    if (existing !== undefined) return existing;
    const dial = dialInstance({
      url: instanceEndpoint(record.origin),
      token: record.secret,
      origin: this.origin(),
      reconnect: true,
    });
    this.live.set(record.id, dial);
    dial.onStatus((status) => {
      const welcomed = dial.share;
      if (status === "live" && welcomed !== null) {
        this.store.updateDialGrant(
          record.id,
          formatManifoldUri(welcomed.ref),
          welcomed.caps,
          welcomed.title,
        );
      }
      this.announce(record.id, record.origin, status);
    });
    dial.onRevoked(() => {
      this.sever(record.id, record.origin);
    });
    return dial;
  }

  /**
   * The host cut the pipe. A4: "when an owner cuts the pipe, the projection dies
   * everywhere" — so the row goes durably dead, the socket stops re-dialling, and the
   * status the guest's own UI reads says `revoked` rather than the `offline` it would
   * otherwise show, which is the difference between "try again later" and "you were cut".
   */
  private sever(dialId: string, origin: string): void {
    this.store.revokeDial(dialId, this.runtime.now());
    this.live.get(dialId)?.close();
    this.live.delete(dialId);
    this.announce(dialId, origin, "revoked");
  }

  private announce(dialId: string, origin: string, status: DialStatus): void {
    this.logger.info("dial_status", { dialId, origin, status });
    /*
      Emitted by CONCEPT, never by plugin name: this file is floor and may not know that
      `core.access` exists (`FloorEventOwners`, AXIOMS §Foundation law neutrality). The
      concept is `shares`, and the honest reason the FLOOR emits this at all rather than the
      action door doing it is that a socket coming up or going down is not a commit point
      any action owns — it is the machine-liveness shape exactly, and `machine_online` is
      its precedent.
    */
    this.events?.emitCollection("shares", DIAL_EVENT_KINDS[status], null, {
      dialId,
      origin,
      status,
    });
  }

  /**
   * Records a grant this instance was handed and holds the door open until the host
   * answers. Idempotent on `(origin, token)`: re-running the same invitation re-opens the
   * row it already has rather than accumulating a second partnership with the same host.
   */
  async dial(input: DialShareRequest): Promise<Dial> {
    const origin = normalizeInstanceOrigin(input.origin);
    if (origin === null) throw new ServiceError("conflict", "invalid instance origin");
    if (origin === normalizeInstanceOrigin(this.origin())) {
      throw new ServiceError("conflict", "cannot dial this instance");
    }
    const existing = this.store.getDialByOriginSecret(origin, input.token);
    if (existing !== null) {
      if (existing.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
      await this.settle(this.connect(existing), existing);
      return this.settled(existing.id);
    }
    /*
      The row is written BEFORE the socket, and it carries the host's node as unknown for
      exactly as long as the handshake takes. Writing after the welcome would need the
      socket to outlive a row that does not exist yet, which is a second lifetime to reason
      about; writing first and deleting on refusal keeps one.
    */
    const record: DialRecord = {
      id: this.runtime.newId(),
      origin,
      secret: input.token,
      ref: null,
      caps: [],
      title: null,
      dialedAt: this.runtime.now(),
      revokedAt: null,
    };
    this.store.createDial(record);
    try {
      await this.settle(this.connect(record), record);
    } catch (error) {
      this.live.get(record.id)?.close();
      this.live.delete(record.id);
      this.store.deleteDial(record.id);
      throw error;
    }
    return this.settled(record.id);
  }

  /**
   * The row as it stands once the host has spoken. A welcomed dial always names a node and
   * carries at least one capability — that is what the welcome IS — so a null here is a
   * broken invariant rather than a state a caller could handle, and it says so.
   */
  private settled(dialId: string): Dial {
    const record = this.store.getDial(dialId);
    const dial = record === null ? null : this.toDial(record);
    if (dial === null) throw new Error(`dial ${dialId} welcomed without naming a node`);
    return dial;
  }

  /**
   * Resolves when the host has welcomed the dial, or refuses with why it did not.
   *
   * Only `live` and `revoked` end the wait. An `offline` in between is a retry the dialer is
   * already handling — refusing on the first one would turn a host that is merely slow to
   * accept into a partnership the operator is told does not exist. So the budget is a clock
   * rather than an attempt count, and the two answers a host can actually GIVE arrive as
   * fast as it gives them.
   */
  private async settle(dial: InstanceDial, record: DialRecord): Promise<void> {
    if (dial.status === "live") return;
    const { promise, resolve } = Promise.withResolvers<DialStatus>();
    const stop = dial.onStatus((status) => {
      if (status !== "offline") resolve(status);
    });
    try {
      const status = await Promise.race([
        promise,
        Bun.sleep(DIAL_WELCOME_TIMEOUT_MS).then((): DialStatus => "offline"),
      ]);
      if (status === "live") return;
      if (status === "revoked") throw new ServiceError("forbidden", "revoked");
      this.logger.warn("dial_unanswered", { origin: record.origin });
      throw new ServiceError("conflict", "host did not answer");
    } finally {
      stop();
    }
  }

  /**
   * THIS instance's own door onto a share its host addressed to the instance as a whole.
   *
   * The guest decides HERE whether a given local principal may use the grant, which is what
   * makes the projection that follows "opening a shared node through your own instance"
   * rather than passing a credential around. What crosses to the caller is a ticket minted
   * by the HOST for a host-side principal carrying this instance's origin; the share secret
   * itself never leaves this process.
   */
  async open(dialId: string, principal: Principal): Promise<DialTicket> {
    const record = this.store.getDial(dialId);
    if (record === null) throw new ServiceError("not_found", "dial not found");
    if (record.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    const dial = this.live.get(dialId);
    if (dial === undefined || dial.status !== "live") {
      throw new ServiceError("conflict", "dial is offline");
    }
    const issued = await dial.requestTicket(principal);
    if (!issued.ok) {
      if (issued.reason === "share_revoked") {
        this.sever(dialId, record.origin);
        throw new ServiceError("forbidden", "revoked");
      }
      throw new ServiceError("conflict", issued.reason);
    }
    const current = this.store.getDial(dialId) ?? record;
    const ref = current.ref === null ? null : parseManifoldUri(current.ref);
    if (ref === null || ref.kind !== "container") {
      throw new ServiceError("conflict", "dial names no container");
    }
    this.logger.info("dial_opened", { dialId, principalId: issued.principal.id });
    return { origin: current.origin, ref, caps: [...current.caps], token: issued.token };
  }

  /**
   * Every dial this instance holds, live status included.
   *
   * A row still inside its handshake is SKIPPED rather than reported with an empty node,
   * and that is the schema's ruling rather than a preference: `Dial.ref` is a required
   * `ManifoldRef` because a dial IS a reference to somebody else's node, so "a dial whose
   * node is unknown" is not a Dial. Such a row exists for at most one handshake and is
   * deleted if the host never answers.
   */
  list(): Dial[] {
    const dials: Dial[] = [];
    for (const record of this.store.listDials()) {
      const dial = this.toDial(record);
      if (dial !== null) dials.push(dial);
    }
    return dials;
  }

  private toDial(record: DialRecord): Dial | null {
    const ref = record.ref === null ? null : parseManifoldUri(record.ref);
    if (ref === null || record.caps.length === 0) return null;
    return {
      id: record.id,
      origin: record.origin,
      ref,
      caps: [...record.caps],
      title: record.title,
      status:
        record.revokedAt !== null ? "revoked" : (this.live.get(record.id)?.status ?? "offline"),
      dialedAt: record.dialedAt,
    };
  }

  /** Closes every outbound instance channel at shutdown. */
  shutdown(): void {
    for (const dial of this.live.values()) dial.close();
    this.live.clear();
  }
}
