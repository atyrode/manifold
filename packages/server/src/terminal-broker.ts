import {
  hasCap,
  type AdvertisedSession,
  type AgentMessage,
  type ClientMessageBody,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type SessionInfo,
} from "@manifold/protocol";
import type { AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { PlaceExecutor, SessionPlacementPort } from "./placement.ts";
import type { RoomManager, RoomTimers } from "./room.ts";
import {
  serializeServerMessage,
  type SerializedServerMessage,
  type SessionPeer,
} from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

/**
 * The broker answers a PEER, and a peer IS one channel, so its payload types are the
 * channel-agnostic bodies: routing was already consumed by the gateway.
 */
type TerminalOpen = Extract<ClientMessageBody, { type: "terminal_open" }>;
type TerminalAttach = Extract<ClientMessageBody, { type: "terminal_attach" }>;
type TerminalDetach = Extract<ClientMessageBody, { type: "terminal_detach" }>;
type TerminalInput = Extract<ClientMessageBody, { type: "terminal_input" }>;
type TerminalResize = Extract<ClientMessageBody, { type: "terminal_resize" }>;
type TerminalTake = Extract<ClientMessageBody, { type: "terminal_take" }>;
type TerminalKill = Extract<ClientMessageBody, { type: "terminal_kill" }>;
type OutputFrame = Extract<AgentMessage, { type: "output" }>;
type SnapshotFrame = Extract<AgentMessage, { type: "snapshot" }>;

const PENDING_OUTPUT_FRAMES = 256;
const PENDING_OUTPUT_BYTES = 1_048_576;
const CREATE_DEADLINE_MS = 10_000;
const SNAPSHOT_DEADLINE_MS = 10_000;

/** Online agent connection used by the broker without depending on Bun WebSocket types. */
export interface MachineChannel {
  readonly machineId: string;
  send(message: ServerToAgentMessage): boolean;
}

interface Viewer {
  state: "PENDING" | "LIVE";
  queue: OutputFrame[];
  queuedBytes: number;
  cancelSnapshotDeadline: (() => void) | null;
  snapshotGeneration: number;
  lastDeliveredSeq: number;
}

interface RuntimeSession {
  info: SessionInfo;
  viewers: Map<SessionPeer, Viewer>;
  lastReceivedOutputSeq: number;
  snapshotGeneration: number;
  snapshotRequestOutstanding: boolean;
}

interface PendingOpen {
  sessionId: string;
  /** The container the gesture happened in: where the reply goes and residency is held. */
  padId: string;
  /**
   * The composition this terminal will LIVE in, minted before the PTY so the agent's token
   * and `MANIFOLD_PAD` are scoped to it from the first byte. For a tiled opener that is the
   * composition it was opened in; for a canvas opener it is a solo composition born with
   * the terminal, and the canvas gets a portal onto it.
   */
  homeId: string;
  /**
   * The opener's correlation token (`terminal_open.elementId`): every error and the
   * `terminal_opened.ref` echo carry it back. Under `placement: "element"` it is also
   * the id the opener authors its canvas portal under.
   */
  ref: string;
  /**
   * Who authors the canvas reference. `"element"`: the opener does, on its canvas, once
   * this resolves — it portals onto `homeId`, which the reply hands it. `"tile"`: nobody
   * does, because the opener IS the composition the terminal lives in.
   */
  placement: "element" | "tile";
  machineId: string;
  createdBy: string;
  createdAt: number;
  cols: number;
  rows: number;
  opener: SessionPeer;
  agentPrincipalId: string;
  cancelDeadline: (() => void) | null;
}

/**
 * Routes terminal lifecycle/control while preserving the snapshot-plus-tail attach
 * invariant. PLACEMENT is not here: `placement.ts` owns where items live, and this class
 * implements `SessionPlacementPort` for it — sessions, PTYs and their fan-out.
 */
export class TerminalBroker implements SessionPlacementPort {
  private readonly machines = new Map<string, MachineChannel>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  /**
   * Circular startup wiring, same shape as `RoomManager`'s providers: a terminal born
   * directly into a tiled container hardens the container it composed, and that rule lives
   * with the rest of container lifecycle.
   */
  private placement: PlaceExecutor | null = null;

  constructor(
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly publicUrl: () => string,
  ) {
    for (const row of store.listSessions()) {
      const info: SessionInfo = {
        id: row.id,
        padId: row.padId,
        name: row.name,
        machineId: row.machineId,
        status: row.status,
        exitCode: row.exitCode,
        cols: 80,
        rows: 24,
        controllerId: row.status === "running" ? row.createdBy : null,
        createdBy: row.createdBy,
      };
      this.sessions.set(row.id, {
        info,
        viewers: new Map(),
        lastReceivedOutputSeq: 0,
        snapshotGeneration: 0,
        snapshotRequestOutstanding: false,
      });
    }
  }

  /** Installs the placement executor after circular startup wiring completes. */
  setPlacement(placement: PlaceExecutor): void {
    this.placement = placement;
  }

  /** Registers the currently fenced socket for a machine id. */
  setMachineOnline(channel: MachineChannel): void {
    this.machines.set(channel.machineId, channel);
  }

  /** Removes a socket only if it remains the active fenced channel. */
  setMachineOffline(channel: MachineChannel): void {
    if (this.machines.get(channel.machineId) !== channel) return;
    this.machines.delete(channel.machineId);
    for (const [sessionId, pending] of this.pendingOpens) {
      if (pending.machineId !== channel.machineId) continue;
      pending.cancelDeadline?.();
      pending.opener.send({
        type: "error",
        code: "no_machine",
        message: "machine disconnected while opening terminal",
        ref: pending.ref,
      });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      this.pendingOpens.delete(sessionId);
      this.rooms.evictIfIdle(pending.padId);
    }
    for (const session of this.sessions.values()) {
      if (session.info.machineId !== channel.machineId || session.info.status !== "running") {
        continue;
      }
      session.snapshotRequestOutstanding = false;
      for (const [peer, viewer] of session.viewers) {
        this.failViewer(session, peer, viewer, "no_machine", "session machine disconnected");
      }
    }
  }

  /** Reports whether the persisted machine currently has an authenticated socket. */
  isMachineOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** Whether an agent create is still in flight for this pad. */
  hasPendingOpenForPad(padId: string): boolean {
    for (const pending of this.pendingOpens.values()) {
      if (pending.padId === padId) return true;
    }
    return false;
  }

  private failViewer(
    session: RuntimeSession,
    peer: SessionPeer,
    viewer: Viewer,
    code: "conflict" | "no_machine",
    message: string,
  ): void {
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = null;
    if (session.viewers.get(peer) !== viewer) return;
    session.viewers.delete(peer);
    peer.send({ type: "error", code, message, ref: session.info.id });
  }

  private armSnapshotDeadline(session: RuntimeSession, peer: SessionPeer, viewer: Viewer): void {
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = this.timers.schedule(() => {
      viewer.cancelSnapshotDeadline = null;
      if (session.viewers.get(peer) !== viewer || viewer.state !== "PENDING") return;
      const requestTimedOut = session.snapshotRequestOutstanding;
      if (requestTimedOut) session.snapshotRequestOutstanding = false;
      session.viewers.delete(peer);
      peer.send({
        type: "error",
        code: "conflict",
        message: "terminal snapshot timed out",
        ref: session.info.id,
      });
      this.logger.warn("terminal_snapshot_timeout", {
        sessionId: session.info.id,
        machineId: session.info.machineId,
      });
      if (requestTimedOut) this.requestSnapshotForPending(session);
    }, SNAPSHOT_DEADLINE_MS);
  }

  /** Sends at most one snapshot request and binds its generation to current PENDING viewers. */
  private requestSnapshotForPending(session: RuntimeSession): void {
    if (session.snapshotRequestOutstanding || session.info.status !== "running") return;
    let hasPending = false;
    for (const viewer of session.viewers.values()) {
      if (viewer.state === "PENDING") {
        hasPending = true;
        break;
      }
    }
    if (!hasPending) return;

    const machine = this.machines.get(session.info.machineId);
    if (machine === undefined) {
      for (const [peer, viewer] of session.viewers) {
        if (viewer.state === "PENDING") {
          this.failViewer(session, peer, viewer, "no_machine", "session machine is offline");
        }
      }
      return;
    }

    session.snapshotGeneration += 1;
    const generation = session.snapshotGeneration;
    for (const viewer of session.viewers.values()) {
      if (viewer.state === "PENDING") viewer.snapshotGeneration = generation;
    }
    session.snapshotRequestOutstanding = true;
    if (machine.send({ type: "snapshot_request", sessionId: session.info.id })) return;

    session.snapshotRequestOutstanding = false;
    for (const [peer, viewer] of session.viewers) {
      if (viewer.state === "PENDING" && viewer.snapshotGeneration === generation) {
        this.failViewer(session, peer, viewer, "no_machine", "session machine is unavailable");
      }
    }
  }

  /** Re-registers a surviving PTY only against its persisted pad binding. */
  adoptSession(machineId: string, advertised: AdvertisedSession): boolean {
    const stored = this.store.getSession(advertised.sessionId);
    if (stored === null || stored.machineId !== machineId) return false;
    let session = this.sessions.get(stored.id);
    if (session === undefined) {
      const info: SessionInfo = {
        id: stored.id,
        padId: stored.padId,
        name: stored.name,
        machineId: stored.machineId,
        status: stored.status,
        exitCode: stored.exitCode,
        cols: 80,
        rows: 24,
        controllerId: stored.status === "running" ? stored.createdBy : null,
        createdBy: stored.createdBy,
      };
      session = {
        info,
        viewers: new Map(),
        lastReceivedOutputSeq: 0,
        snapshotGeneration: 0,
        snapshotRequestOutstanding: false,
      };
      this.sessions.set(stored.id, session);
    }
    if (!advertised.alive) {
      if (session.info.status === "running") {
        this.onExited(machineId, advertised.sessionId, advertised.exitCode ?? null);
      }
      return false;
    }
    if (stored.status !== "running") return false;
    session.info = {
      ...session.info,
      status: "running",
      exitCode: null,
      cols: advertised.cols,
      rows: advertised.rows,
    };
    session.snapshotRequestOutstanding = false;
    const adoptedPadId = session.info.padId;
    if (adoptedPadId !== null) {
      this.rooms.live(adoptedPadId)?.broadcast({
        type: "session_event",
        sessionId: session.info.id,
        kind: "controller_changed",
        controllerId: session.info.controllerId,
      });
    }
    if (session.viewers.size > 0) {
      for (const [peer, viewer] of session.viewers) {
        viewer.state = "PENDING";
        viewer.queue = [];
        viewer.queuedBytes = 0;
        viewer.lastDeliveredSeq = 0;
        viewer.snapshotGeneration = session.snapshotGeneration + 1;
        this.armSnapshotDeadline(session, peer, viewer);
      }
      this.requestSnapshotForPending(session);
    }
    return true;
  }

  /**
   * Reconciles the complete hello inventory: missing durable PTYs are exited, while
   * unadoptable agent PTYs are explicitly killed instead of becoming unmanaged orphans.
   */
  reconcileMachineHello(machineId: string, advertised: readonly AdvertisedSession[]): void {
    const advertisedIds = new Set<string>();
    const channel = this.machines.get(machineId);
    for (const candidate of advertised) {
      advertisedIds.add(candidate.sessionId);
      if (!this.adoptSession(machineId, candidate)) {
        channel?.send({ type: "kill", sessionId: candidate.sessionId });
      }
    }
    for (const stored of this.store.listRunningSessionsForMachine(machineId)) {
      if (!advertisedIds.has(stored.id)) this.onExited(machineId, stored.id, null);
    }
  }

  private selectMachine(requested: string | undefined): MachineChannel | null {
    if (requested !== undefined) return this.machines.get(requested) ?? null;
    if (this.machines.size !== 1) return null;
    return this.machines.values().next().value ?? null;
  }

  /** Starts a PTY create request after checking spawn authority and machine selection. */
  open(peer: SessionPeer, message: TerminalOpen): void {
    if (!this.auth.allows(peer.auth, "terminal:spawn", peer.padId)) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "terminal:spawn capability required",
        ref: message.elementId,
      });
      return;
    }
    // Discipline decides who authors the placement, so a mismatch is refused instead of
    // spawning a PTY no surface would ever show: a canvas opener that forgot to author an
    // element, or a tiled opener that thinks it can.
    const pad = this.store.getPad(peer.padId);
    const placement = message.placement ?? "element";
    if ((pad?.layout === "tiled") !== (placement === "tile")) {
      peer.send({
        type: "error",
        code: "conflict",
        message:
          placement === "tile"
            ? 'placement "tile" requires a tiled container'
            : 'a tiled container places terminals server-side: send placement "tile"',
        ref: message.elementId,
      });
      return;
    }
    const machine = this.selectMachine(message.machineId);
    if (machine === null) {
      peer.send({
        type: "error",
        code: "no_machine",
        message: "no unambiguous online machine",
        ref: message.elementId,
      });
      return;
    }

    const sessionId = this.runtime.newId();
    /*
      The home is decided here, before the PTY exists, because the agent token and the
      `MANIFOLD_PAD` a program inside the terminal reads both have to name the container the
      terminal LIVES in — and a canvas is never that. A tiled opener already is the home; a
      canvas opener gets a solo composition, whose ROW is created when the PTY lands so a
      create that fails leaves nothing behind to clean up.
     */
    const homeId = placement === "tile" ? peer.padId : this.runtime.newId();
    const grant = this.auth.mintSessionAgentToken(sessionId, homeId, peer.auth.principal.id);
    const pending: PendingOpen = {
      sessionId,
      padId: peer.padId,
      homeId,
      ref: message.elementId,
      placement,
      machineId: machine.machineId,
      createdBy: peer.auth.principal.id,
      createdAt: this.runtime.now(),
      cols: message.cols,
      rows: message.rows,
      opener: peer,
      agentPrincipalId: grant.principal.id,
      cancelDeadline: null,
    };
    this.pendingOpens.set(sessionId, pending);
    pending.cancelDeadline = this.timers.schedule(() => {
      pending.cancelDeadline = null;
      if (this.pendingOpens.get(sessionId) !== pending) return;
      this.pendingOpens.delete(sessionId);
      this.machines.get(machine.machineId)?.send({ type: "kill", sessionId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "no_machine",
        message: "terminal creation timed out",
        ref: pending.ref,
      });
      this.logger.warn("terminal_create_timeout", {
        machineId: machine.machineId,
        sessionId,
      });
      this.rooms.evictIfIdle(pending.padId);
    }, CREATE_DEADLINE_MS);
    const sent = machine.send({
      type: "create",
      sessionId,
      cols: message.cols,
      rows: message.rows,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      env: {
        MANIFOLD_URL: this.publicUrl(),
        // The container the terminal LIVES in, which is what a program inside it should see
        // when it asks where it is. `MANIFOLD_ELEMENT` is only meaningful for a canvas
        // opener, which authors its portal under exactly that id.
        MANIFOLD_PAD: homeId,
        ...(placement === "tile" ? {} : { MANIFOLD_ELEMENT: message.elementId }),
        MANIFOLD_TOKEN: grant.token,
      },
    });
    if (!sent) {
      pending.cancelDeadline?.();
      this.pendingOpens.delete(sessionId);
      this.auth.revokeIssuedPrincipal(grant.principal.id, peer.auth.principal.id);
      peer.send({
        type: "error",
        code: "no_machine",
        message: "machine connection unavailable",
        ref: message.elementId,
      });
      this.rooms.evictIfIdle(pending.padId);
    }
  }

  /**
   * Commits a created PTY, replies to its opener, and publishes durable lifecycle state.
   *
   * This is where `homed: "eager"` is actually paid for: with the PTY in hand, the terminal's
   * home leaf is written before its session row exists, so there is no instant at which a
   * live terminal has nowhere to live. A tiled opener IS the home and only needs a leaf; a
   * canvas opener gets a whole solo composition, and its own portal element — authored
   * client-side under the ref it chose — points at the id this reply hands back.
   */
  onCreated(machineId: string, sessionId: string): void {
    const pending = this.pendingOpens.get(sessionId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(sessionId);
    pending.cancelDeadline?.();
    const home =
      pending.placement === "tile"
        ? (this.rooms.get(pending.homeId)?.placeTerminalTile(sessionId, null, null) ?? null)
        : (this.placement?.createHome(pending.homeId, sessionId, this.bornLabel(machineId)) ??
          null);
    if (home === null) {
      // Nothing durable exists yet, so the PTY is the only thing to undo.
      this.machines.get(machineId)?.send({ type: "kill", sessionId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "conflict",
        message: "this terminal could not be given a home",
        ref: pending.ref,
      });
      this.logger.warn("terminal_home_failed", { padId: pending.padId, sessionId });
      this.rooms.evictIfIdle(pending.padId);
      return;
    }
    this.store.createSession({
      id: sessionId,
      machineId,
      padId: pending.homeId,
      createdBy: pending.createdBy,
      agentPrincipalId: pending.agentPrincipalId,
      createdAt: pending.createdAt,
    });
    const info: SessionInfo = {
      id: sessionId,
      padId: pending.homeId,
      name: null,
      machineId,
      status: "running",
      exitCode: null,
      cols: pending.cols,
      rows: pending.rows,
      controllerId: pending.createdBy,
      createdBy: pending.createdBy,
    };
    this.sessions.set(sessionId, {
      info,
      viewers: new Map(),
      lastReceivedOutputSeq: 0,
      snapshotGeneration: 0,
      snapshotRequestOutstanding: false,
    });
    /*
      The reply carries the home LEAF for a tiled opener and the opener's own ref for a
      canvas one, because those are the ids each of them will render under; `session.padId`
      carries the home either way, which is what a canvas opener portals onto.

      The fan-out goes to the HOME's room, not the opener's: after this cutover nothing
      about a session is canvas state. A canvas learns about the new terminal the same way
      it learns about anything else on it — the portal element arriving in its document.
     */
    pending.opener.send({
      type: "terminal_opened",
      elementId: pending.placement === "tile" ? home : pending.ref,
      session: info,
      ...(pending.placement === "tile" ? { ref: pending.ref } : {}),
    });
    const homeRoom = this.rooms.live(pending.homeId);
    homeRoom?.broadcast(
      { type: "terminal_opened", elementId: home, session: info },
      false,
      pending.opener,
    );
    homeRoom?.broadcast({ type: "session_event", sessionId, kind: "opened" });
    this.store.addEvent(pending.homeId, this.runtime.now(), pending.createdBy, "session_opened", {
      sessionId,
      machineId,
      elementId: home,
    });
    this.rooms.evictIfIdle(pending.padId);
    if (pending.homeId !== pending.padId) this.rooms.evictIfIdle(pending.homeId);
  }

  /** The label a newborn terminal's home takes: its machine's name, else a plain noun. */
  private bornLabel(machineId: string): string {
    return this.store.getMachine(machineId)?.name ?? "terminal";
  }

  /** Resolves a rejected PTY create without exposing agent diagnostics to clients. */
  onCreateError(machineId: string, sessionId: string): void {
    const pending = this.pendingOpens.get(sessionId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(sessionId);
    pending.cancelDeadline?.();
    this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
    pending.opener.send({
      type: "error",
      code: "conflict",
      message: "terminal creation failed",
      ref: pending.ref,
    });
    this.logger.warn("terminal_create_failed", { machineId, sessionId });
    this.rooms.evictIfIdle(pending.padId);
  }

  private sessionFor(peer: SessionPeer, sessionId: string): RuntimeSession | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.info.padId !== peer.padId) {
      peer.send({ type: "error", code: "not_found", message: "session not found", ref: sessionId });
      return null;
    }
    return session;
  }

  /** Begins PENDING attachment before requesting the agent's ordered snapshot watermark. */
  attach(peer: SessionPeer, message: TerminalAttach): void {
    const session = this.sessionFor(peer, message.sessionId);
    if (session === null) return;
    if (session.info.status !== "running") {
      peer.send({
        type: "error",
        code: "conflict",
        message: "session has exited",
        ref: message.sessionId,
      });
      return;
    }
    const machine = this.machines.get(session.info.machineId);
    if (machine === undefined) {
      peer.send({
        type: "error",
        code: "no_machine",
        message: "session machine is offline",
        ref: message.sessionId,
      });
      return;
    }
    const previous = session.viewers.get(peer);
    previous?.cancelSnapshotDeadline?.();
    const viewer: Viewer = {
      state: "PENDING",
      queue: [],
      queuedBytes: 0,
      cancelSnapshotDeadline: null,
      snapshotGeneration: session.snapshotGeneration + 1,
      lastDeliveredSeq: 0,
    };
    session.viewers.set(peer, viewer);
    this.armSnapshotDeadline(session, peer, viewer);
    this.requestSnapshotForPending(session);
  }

  /** Stops routing one session's terminal bytes to a viewer. */
  detach(peer: SessionPeer, message: TerminalDetach): void {
    const viewer = this.sessions.get(message.sessionId)?.viewers.get(peer);
    viewer?.cancelSnapshotDeadline?.();
    this.sessions.get(message.sessionId)?.viewers.delete(peer);
  }

  /** Removes a closing socket from every session viewer registry. */
  detachAll(peer: SessionPeer): void {
    for (const session of this.sessions.values()) {
      session.viewers.get(peer)?.cancelSnapshotDeadline?.();
      session.viewers.delete(peer);
    }
  }

  /** Queues output for PENDING viewers and relays it directly only after handoff is LIVE. */
  onOutput(machineId: string, output: OutputFrame): void {
    const session = this.sessions.get(output.sessionId);
    if (
      session === undefined ||
      session.info.machineId !== machineId ||
      session.info.status !== "running"
    ) {
      return;
    }
    if (output.seq <= session.lastReceivedOutputSeq) return;
    session.lastReceivedOutputSeq = output.seq;
    let serialized: SerializedServerMessage | null = null;
    for (const [peer, viewer] of session.viewers) {
      if (viewer.state === "LIVE") {
        if (output.seq <= viewer.lastDeliveredSeq) continue;
        serialized ??= serializeServerMessage({
          type: "terminal_output",
          sessionId: output.sessionId,
          seq: output.seq,
          data: output.data,
        });
        if (!peer.sendSerialized(serialized)) {
          viewer.cancelSnapshotDeadline?.();
          session.viewers.delete(peer);
          continue;
        }
        viewer.lastDeliveredSeq = output.seq;
        continue;
      }
      const bytes = Buffer.byteLength(output.data);
      if (
        viewer.queue.length >= PENDING_OUTPUT_FRAMES ||
        viewer.queuedBytes + bytes > PENDING_OUTPUT_BYTES
      ) {
        this.failViewer(session, peer, viewer, "conflict", "terminal attach queue overflow");
        continue;
      }
      viewer.queue.push(output);
      viewer.queuedBytes += bytes;
    }
  }

  /** Completes PENDING attach as snapshot(S) followed exactly by unique queued seq > S. */
  onSnapshot(machineId: string, snapshot: SnapshotFrame): void {
    const session = this.sessions.get(snapshot.sessionId);
    if (session === undefined || session.info.machineId !== machineId) return;
    if (session.info.status !== "running") return;
    if (!session.snapshotRequestOutstanding) return;
    const generation = session.snapshotGeneration;
    session.snapshotRequestOutstanding = false;
    const snapshotFrame = serializeServerMessage({
      type: "terminal_snapshot",
      sessionId: snapshot.sessionId,
      seq: snapshot.seq,
      data: snapshot.data,
    });
    const outputFrames = new Map<number, SerializedServerMessage>();
    for (const [peer, viewer] of session.viewers) {
      if (viewer.state !== "PENDING" || viewer.snapshotGeneration !== generation) continue;
      viewer.cancelSnapshotDeadline?.();
      viewer.cancelSnapshotDeadline = null;
      if (!peer.sendSerialized(snapshotFrame)) {
        session.viewers.delete(peer);
        continue;
      }
      viewer.queue.sort((left, right) => left.seq - right.seq);
      let lastSeq = snapshot.seq;
      let live = true;
      for (const output of viewer.queue) {
        if (output.seq <= lastSeq) continue;
        let outputFrame = outputFrames.get(output.seq);
        if (outputFrame === undefined) {
          outputFrame = serializeServerMessage({
            type: "terminal_output",
            sessionId: output.sessionId,
            seq: output.seq,
            data: output.data,
          });
          outputFrames.set(output.seq, outputFrame);
        }
        if (!peer.sendSerialized(outputFrame)) {
          live = false;
          break;
        }
        lastSeq = output.seq;
      }
      if (!live) {
        session.viewers.delete(peer);
        continue;
      }
      viewer.queue = [];
      viewer.queuedBytes = 0;
      viewer.lastDeliveredSeq = lastSeq;
      viewer.state = "LIVE";
    }
    this.requestSnapshotForPending(session);
  }

  private controllerSession(peer: SessionPeer, sessionId: string): RuntimeSession | null {
    const session = this.sessionFor(peer, sessionId);
    if (session === null) return null;
    if (session.info.status !== "running") {
      peer.send({
        type: "error",
        code: "conflict",
        message: "session has exited",
        ref: sessionId,
      });
      return null;
    }
    if (session.info.controllerId !== peer.auth.principal.id) {
      peer.send({
        type: "error",
        code: "not_controller",
        message: "terminal controller lease required",
        ref: sessionId,
      });
      return null;
    }
    if (!hasCap(peer.auth.caps, "terminal:write")) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "terminal:write capability required",
        ref: sessionId,
      });
      return null;
    }
    return session;
  }

  /** Forwards base64 input only from the current controller principal. */
  input(peer: SessionPeer, message: TerminalInput): void {
    const session = this.controllerSession(peer, message.sessionId);
    if (session === null) return;
    const machine = this.machines.get(session.info.machineId);
    if (
      machine === undefined ||
      !machine.send({
        type: "input",
        sessionId: message.sessionId,
        data: message.data,
      })
    ) {
      peer.send({ type: "error", code: "no_machine", ref: message.sessionId });
    }
  }

  /** Forwards resize from the controller and broadcasts the new shared geometry. */
  resize(peer: SessionPeer, message: TerminalResize): void {
    const session = this.controllerSession(peer, message.sessionId);
    if (session === null) return;
    const machine = this.machines.get(session.info.machineId);
    if (machine === undefined) {
      peer.send({ type: "error", code: "no_machine", ref: message.sessionId });
      return;
    }
    if (
      !machine.send({
        type: "resize",
        sessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows,
      })
    ) {
      peer.send({ type: "error", code: "no_machine", ref: message.sessionId });
      return;
    }
    session.info = { ...session.info, cols: message.cols, rows: message.rows };
    this.rooms.live(peer.padId)?.broadcast({
      type: "session_event",
      sessionId: message.sessionId,
      kind: "resized",
      cols: message.cols,
      rows: message.rows,
    });
  }

  /** Transfers controller authority to an authorized principal and announces the lease. */
  take(peer: SessionPeer, message: TerminalTake): void {
    const session = this.sessionFor(peer, message.sessionId);
    if (session === null) return;
    if (session.info.status !== "running") {
      peer.send({
        type: "error",
        code: "conflict",
        message: "session has exited",
        ref: message.sessionId,
      });
      return;
    }
    if (!this.auth.allows(peer.auth, "terminal:write", peer.padId)) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "terminal:write capability required",
        ref: message.sessionId,
      });
      return;
    }
    session.info = { ...session.info, controllerId: peer.auth.principal.id };
    this.rooms.live(peer.padId)?.broadcast({
      type: "session_event",
      sessionId: message.sessionId,
      kind: "controller_changed",
      controllerId: peer.auth.principal.id,
    });
  }

  /**
   * A terminal stops in exactly one of two ways, and the whole difference is INTENT.
   *
   *   KILLED — somebody ASKED for it to stop: `terminal_kill`, `DELETE /api/terminals/:id`,
   *     or closing its last tile. The request is the intent, so the terminal leaves the
   *     world: the PTY, the session row, its home composition and every portal onto that
   *     home go together and at once. Afterwards there is no exited row to find and no exit
   *     code to report, because nothing is left to report it on.
   *   EXITED — the PTY stopped on its own (`onExited`). That is INFORMATION the operator may
   *     want, so NOTHING is deleted: the row keeps its real exit code, its home keeps its
   *     leaf, and every portal onto that home keeps rendering it until somebody kills it.
   *
   * The predicate is structural rather than a flag: a killed session is out of
   * `this.sessions` before the machine's `exit` frame can arrive, so `onExited` finds nothing
   * and is a no-op for it. Nothing has to remember which door was used, and no third status
   * exists to propagate — a terminal is running, exited on its own, or gone.
   *
   * This door additionally needs the controller principal, or any holder of the wildcard
   * capability (owner janitor: sweeping a terminal whose widget is already gone must not
   * require winning the lease).
   */
  kill(peer: SessionPeer, message: TerminalKill): void {
    const session = this.sessionFor(peer, message.sessionId);
    if (session === null) return;
    // A lease is a claim on a LIVE PTY. An exited terminal has no controller, so there is
    // nothing to win and no reason to make dismissing it harder than closing its tile.
    const isController = session.info.controllerId === peer.auth.principal.id;
    if (session.info.status === "running" && !isController && !peer.auth.isRoot) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "controller lease or owner capability required",
        ref: message.sessionId,
      });
      return;
    }
    if (!hasCap(peer.auth.caps, "terminal:write")) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "terminal:write capability required",
        ref: message.sessionId,
      });
      return;
    }
    this.destroyTerminal(message.sessionId);
  }

  /**
   * Owner-authorized kill for HTTP callers (`DELETE /api/terminals/:id`), which hold no
   * session peer and therefore no controller lease to win. An already-exited terminal is no
   * conflict here: sweeping it is precisely what the caller asked for.
   */
  killById(sessionId: string): "ok" | "not_found" {
    if (!this.sessions.has(sessionId)) return "not_found";
    this.destroyTerminal(sessionId);
    return "ok";
  }

  /**
   * The KILLED half of the predicate above. Containers are `placement.ts`'s business and a
   * home IS a container, so the removal is authored there: pulling the terminal's leaves is
   * what empties its home, and an emptied home takes every portal onto it along. The PTY and
   * the row come back through `reapSession`, so the two halves cannot drift apart.
   */
  private destroyTerminal(sessionId: string): void {
    if (this.placement !== null) {
      this.placement.killTerminal(sessionId);
      return;
    }
    // Only reachable before startup wiring completes. A kill must still not leave the
    // session behind, even if its home outlives it by a moment.
    this.reapSession(sessionId);
  }

  /**
   * Asks a machine to stop a PTY. Best effort by design: every kill deletes the session row,
   * so a PTY that outlives the request is killed by hello reconciliation the moment its
   * machine reconnects and finds no row for it. Persisting an exit to keep a stale row
   * honest is the OTHER path's business, and this path has no row left to keep honest.
   */
  private sendPtyStop(session: RuntimeSession): void {
    this.machines.get(session.info.machineId)?.send({ type: "kill", sessionId: session.info.id });
  }

  /**
   * The EXITED half of the predicate: a PTY that stopped on its own. Persists and broadcasts
   * it without storing terminal bytes, and deletes nothing.
   */
  onExited(machineId: string, sessionId: string, exitCode: number | null): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.info.machineId !== machineId) return;
    if (session.info.status === "exited") return;
    for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
    session.viewers.clear();
    session.info = { ...session.info, status: "exited", exitCode, controllerId: null };
    this.store.markSessionExited(sessionId, exitCode);
    // The exit is announced in the terminal's HOME, the room every viewer of it is joined
    // to. Nothing is deleted: the leaf stays, the portals onto the home stay, and the exit
    // code stays visible until somebody deliberately kills the terminal.
    const padId = session.info.padId;
    this.rooms.live(padId)?.broadcast({
      type: "session_event",
      sessionId,
      kind: "exited",
      exitCode,
    });
    const stored = this.store.getSession(sessionId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, session.info.createdBy);
    }
    this.store.addEvent(padId, this.runtime.now(), session.info.createdBy, "session_exited", {
      sessionId,
      machineId,
      exitCode,
    });
    this.rooms.evictIfIdle(padId);
  }

  /**
   * Renames a terminal. Names are session state, not container state, so the new label is
   * published into the terminal's home, where every viewer's titlebar and session row picks
   * it up without a refetch.
   */
  rename(sessionId: string, name: string): "ok" | "not_found" {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return "not_found";
    session.info = { ...session.info, name };
    this.store.updateSessionName(sessionId, name);
    const padId = session.info.padId;
    this.rooms.live(padId)?.broadcast({ type: "session_event", sessionId, kind: "renamed", name });
    this.store.addEvent(padId, this.runtime.now(), session.info.createdBy, "session_renamed", {
      sessionId,
      name,
    });
    return "ok";
  }

  /**
   * `SessionPlacementPort`: the placement-relevant slice of live session state. Only the
   * home matters to placement — geometry, viewers and controller leases are this class's
   * business.
   */
  placedSession(sessionId: string): { readonly padId: string } | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : { padId: session.info.padId };
  }

  /**
   * `SessionPlacementPort`: publishes a session's move from one composition to another. The
   * executor has already written the new leaf and removed the old one; this is the fan-out.
   * The old room hears `parked` — the session genuinely left it — and the new room hears
   * `terminal_opened` with the leaf that now holds it.
   */
  rebindSession(sessionId: string, fromPadId: string, toPadId: string, placementId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || fromPadId === toPadId) return;
    session.info = { ...session.info, padId: toPadId };
    this.store.updateSessionPad(sessionId, toPadId);
    // Viewers attached through the old room can no longer reach the session: every session
    // message is gated on the peer's own container.
    for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
    session.viewers.clear();
    this.rooms.live(fromPadId)?.broadcast({ type: "session_event", sessionId, kind: "parked" });
    this.rooms
      .live(toPadId)
      ?.broadcast({ type: "terminal_opened", elementId: placementId, session: session.info });
    this.store.addEvent(toPadId, this.runtime.now(), session.info.createdBy, "session_bound", {
      sessionId,
      elementId: placementId,
    });
  }

  /**
   * `SessionPlacementPort`: the session half of a deliberate kill — the PTY is asked to stop
   * and the row is forgotten. Called for a terminal whose last home leaf is gone, which is
   * the same event however it was addressed: closing its tile, killing it by id, or deleting
   * the composition it lived in.
   *
   * No exit is persisted on the way out. The row is being deleted, so an exit record would
   * exist for the length of one statement and, worse, would broadcast an `exited` event for
   * a terminal the operator asked to be RID of — the one thing the killed half of the
   * lifecycle predicate promises never to show. What the home hears instead is `parked`,
   * which already means exactly "this session left THIS room" and is what makes every
   * viewer's session listing drop the row at once instead of at its next resync.
   */
  reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.info.status === "running") this.sendPtyStop(session);
    for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
    session.viewers.clear();
    this.sessions.delete(sessionId);
    this.rooms
      .live(session.info.padId)
      ?.broadcast({ type: "session_event", sessionId, kind: "parked" });
    // The injected agent token is scoped to this session, so it dies with it. A natural exit
    // revokes in `onExited`; a kill never goes through there, and a live token for a terminal
    // that no longer exists would be the one piece of it left in the world.
    const stored = this.store.getSession(sessionId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, session.info.createdBy);
    }
    this.store.deleteSession(sessionId);
  }

  /**
   * `SessionPlacementPort`: a terminal's operator-visible label — its own name, else its
   * machine's, else `fallback`. Composition names views from it.
   */
  terminalLabel(sessionId: string, fallback: string): string {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return fallback;
    return session.info.name ?? this.store.getMachine(session.info.machineId)?.name ?? fallback;
  }

  /**
   * Collects exited terminals their composition no longer holds a leaf for, and retires the
   * composition when the terminal was the last thing in it. Invoked at exit and before
   * init/resync; ordinary roster reads stay pure.
   *
   * This replaces the two janitors the pool needed. There is one rule now — a terminal
   * exists as long as some composition holds a leaf for it — and it needs no unbound state
   * to sweep, because there is no unbound state.
   */
  pruneExitedUnhomedForPad(padId: string): void {
    const room = this.rooms.live(padId);
    if (room === null) return;
    for (const [sessionId, session] of this.sessions) {
      if (
        session.info.padId !== padId ||
        session.info.status !== "exited" ||
        room.homesSession(sessionId)
      ) {
        continue;
      }
      for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
      session.viewers.clear();
      this.sessions.delete(sessionId);
      this.store.deleteSession(sessionId);
      this.placement?.retireHome(padId);
    }
  }

  /** Purely lists protocol session state for room state and residency reads. */
  listForPad(padId: string): SessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => session.info)
      .filter((session) => session.padId === padId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Kills and forgets every PTY bound to a pad before its durable rows are purged. */
  dropPad(padId: string): void {
    for (const [sessionId, pending] of this.pendingOpens) {
      if (pending.padId !== padId) continue;
      pending.cancelDeadline?.();
      this.machines.get(pending.machineId)?.send({ type: "kill", sessionId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "not_found",
        message: "pad deleted while opening terminal",
        ref: pending.ref,
      });
      this.pendingOpens.delete(sessionId);
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.info.padId !== padId) continue;
      if (session.info.status === "running") {
        this.machines
          .get(session.info.machineId)
          ?.send({ type: "kill", sessionId: session.info.id });
      }
      for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
      const stored = this.store.getSession(sessionId);
      if (stored !== null && stored.agentPrincipalId !== null) {
        this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, session.info.createdBy);
      }
      this.sessions.delete(sessionId);
    }
  }

  /** Returns all secret-free broker session state for root introspection. */
  introspect(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => session.info)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
