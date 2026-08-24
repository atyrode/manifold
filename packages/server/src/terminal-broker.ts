import {
  hasCap,
  type AdvertisedSession,
  type AgentMessage,
  type ClientMessage,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type SessionInfo,
} from "@manifold/protocol";
import type { AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { RoomManager, RoomTimers } from "./room.ts";
import type { SessionPeer } from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

type TerminalOpen = Extract<ClientMessage, { type: "terminal_open" }>;
type TerminalAttach = Extract<ClientMessage, { type: "terminal_attach" }>;
type TerminalDetach = Extract<ClientMessage, { type: "terminal_detach" }>;
type TerminalInput = Extract<ClientMessage, { type: "terminal_input" }>;
type TerminalResize = Extract<ClientMessage, { type: "terminal_resize" }>;
type TerminalTake = Extract<ClientMessage, { type: "terminal_take" }>;
type TerminalKill = Extract<ClientMessage, { type: "terminal_kill" }>;
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
  padId: string;
  elementId: string;
  machineId: string;
  createdBy: string;
  createdAt: number;
  cols: number;
  rows: number;
  opener: SessionPeer;
  agentPrincipalId: string;
  cancelDeadline: (() => void) | null;
}

/** Routes terminal lifecycle/control while preserving the snapshot-plus-tail attach invariant. */
export class TerminalBroker {
  private readonly machines = new Map<string, MachineChannel>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly pendingOpens = new Map<string, PendingOpen>();

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
        elementId: row.elementId,
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
        ref: pending.elementId,
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

  /** Re-registers a surviving PTY only against its persisted pad/element binding. */
  adoptSession(machineId: string, advertised: AdvertisedSession): boolean {
    const stored = this.store.getSession(advertised.sessionId);
    if (stored === null || stored.machineId !== machineId) return false;
    let session = this.sessions.get(stored.id);
    if (session === undefined) {
      const info: SessionInfo = {
        id: stored.id,
        padId: stored.padId,
        elementId: stored.elementId,
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
      if (session.info.status === "running") this.onExited(machineId, advertised.sessionId, null);
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
    const grant = this.auth.mintSessionAgentToken(sessionId, peer.padId, peer.auth.principal.id);
    const pending: PendingOpen = {
      sessionId,
      padId: peer.padId,
      elementId: message.elementId,
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
        ref: pending.elementId,
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
        MANIFOLD_PAD: peer.padId,
        MANIFOLD_ELEMENT: message.elementId,
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

  /** Commits a created PTY, replies to its opener, and publishes durable lifecycle state. */
  onCreated(machineId: string, sessionId: string): void {
    const pending = this.pendingOpens.get(sessionId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(sessionId);
    pending.cancelDeadline?.();
    this.store.createSession({
      id: sessionId,
      machineId,
      padId: pending.padId,
      elementId: pending.elementId,
      createdBy: pending.createdBy,
      agentPrincipalId: pending.agentPrincipalId,
      createdAt: pending.createdAt,
    });
    const info: SessionInfo = {
      id: sessionId,
      padId: pending.padId,
      elementId: pending.elementId,
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
    pending.opener.send({ type: "terminal_opened", elementId: pending.elementId, session: info });
    const room = this.rooms.live(pending.padId);
    room?.broadcast(
      { type: "terminal_opened", elementId: pending.elementId, session: info },
      false,
      pending.opener,
    );
    room?.broadcast({ type: "session_event", sessionId, kind: "opened" });
    this.store.addEvent(pending.padId, this.runtime.now(), pending.createdBy, "session_opened", {
      sessionId,
      machineId,
      elementId: pending.elementId,
    });
    this.rooms.evictIfIdle(pending.padId);
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
      ref: pending.elementId,
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
    for (const [peer, viewer] of session.viewers) {
      if (viewer.state === "LIVE") {
        if (output.seq <= viewer.lastDeliveredSeq) continue;
        const delivered = peer.send({
          type: "terminal_output",
          sessionId: output.sessionId,
          seq: output.seq,
          data: output.data,
        });
        if (!delivered) {
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
    for (const [peer, viewer] of session.viewers) {
      if (viewer.state !== "PENDING" || viewer.snapshotGeneration !== generation) continue;
      viewer.cancelSnapshotDeadline?.();
      viewer.cancelSnapshotDeadline = null;
      if (
        !peer.send({
          type: "terminal_snapshot",
          sessionId: snapshot.sessionId,
          seq: snapshot.seq,
          data: snapshot.data,
        })
      ) {
        session.viewers.delete(peer);
        continue;
      }
      viewer.queue.sort((left, right) => left.seq - right.seq);
      let lastSeq = snapshot.seq;
      let live = true;
      for (const output of viewer.queue) {
        if (output.seq <= lastSeq) continue;
        if (
          !peer.send({
            type: "terminal_output",
            sessionId: output.sessionId,
            seq: output.seq,
            data: output.data,
          })
        ) {
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

  /** Requests PTY termination only from the current controller principal. */
  kill(peer: SessionPeer, message: TerminalKill): void {
    const session = this.controllerSession(peer, message.sessionId);
    if (session === null) return;
    const machine = this.machines.get(session.info.machineId);
    if (
      machine === undefined ||
      !machine.send({
        type: "kill",
        sessionId: message.sessionId,
      })
    ) {
      peer.send({ type: "error", code: "no_machine", ref: message.sessionId });
    }
  }

  /** Persists and broadcasts terminal exit without storing terminal bytes. */
  onExited(machineId: string, sessionId: string, exitCode: number | null): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.info.machineId !== machineId) return;
    if (session.info.status === "exited") return;
    for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
    session.viewers.clear();
    session.info = { ...session.info, status: "exited", exitCode, controllerId: null };
    this.store.markSessionExited(sessionId, exitCode);
    this.rooms.live(session.info.padId)?.broadcast({
      type: "session_event",
      sessionId,
      kind: "exited",
      exitCode,
    });
    const stored = this.store.getSession(sessionId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, session.info.createdBy);
    }
    this.store.addEvent(
      session.info.padId,
      this.runtime.now(),
      session.info.createdBy,
      "session_exited",
      { sessionId, machineId, exitCode },
    );
    this.rooms.evictIfIdle(session.info.padId);
  }

  /** Lists protocol session state for one room's init/resync payload. */
  listForPad(padId: string): SessionInfo[] {
    const room = this.rooms.live(padId);
    if (room !== null) {
      for (const [sessionId, session] of this.sessions) {
        if (
          session.info.padId !== padId ||
          session.info.status !== "exited" ||
          room.referencesSession(sessionId)
        ) {
          continue;
        }
        for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
        session.viewers.clear();
        this.sessions.delete(sessionId);
        this.store.deleteSession(sessionId);
      }
    }
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
        ref: pending.elementId,
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
