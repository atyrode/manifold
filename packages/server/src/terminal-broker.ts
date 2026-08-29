import {
  hasCap,
  type AdvertisedSession,
  type AgentMessage,
  type ClientMessageBody,
  type Pad,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type SessionInfo,
} from "@manifold/protocol";
import { tileIdForSurface } from "@manifold/scene";
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
  padId: string;
  /**
   * The opener's correlation token (`terminal_open.elementId`): every error and the
   * `terminal_opened.ref` echo carry it back. Under `placement: "element"` it is also
   * the placement id, because the opener authors the canvas element under that id.
   */
  ref: string;
  /**
   * Who authors the placement. `"element"`: the opener does, on its canvas, once this
   * resolves. `"tile"`: the container does — a view has no canvas, so the server writes
   * the tile leaf when the PTY lands and the tile id becomes the placement id.
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
    const grant = this.auth.mintSessionAgentToken(sessionId, peer.padId, peer.auth.principal.id);
    const pending: PendingOpen = {
      sessionId,
      padId: peer.padId,
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
        MANIFOLD_PAD: peer.padId,
        // A tiled birth has no placement id yet — the server writes the leaf when the PTY
        // lands — so the PTY learns its container and nothing more.
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

  /** Commits a created PTY, replies to its opener, and publishes durable lifecycle state. */
  onCreated(machineId: string, sessionId: string): void {
    const pending = this.pendingOpens.get(sessionId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(sessionId);
    pending.cancelDeadline?.();
    /*
      A tiled container authors its own placements, and it does so HERE: with the PTY in
      hand, at the same instant a canvas opener authors its element from this reply. The
      tile id it returns IS the placement id — the identity `bind` already publishes for
      a tiled destination. A tiled birth needs the room loaded (it holds the layout tree);
      a canvas birth only needs one to broadcast into.
     */
    const room =
      pending.placement === "tile" ? this.rooms.get(pending.padId) : this.rooms.live(pending.padId);
    const elementId =
      pending.placement === "tile"
        ? (room?.placeTerminalTile(sessionId, null, null) ?? null)
        : pending.ref;
    if (elementId === null || (pending.placement === "tile" && room === null)) {
      // Nothing durable exists yet, so the PTY is the only thing to undo.
      this.machines.get(machineId)?.send({ type: "kill", sessionId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "conflict",
        message: "this view could not place a new terminal",
        ref: pending.ref,
      });
      this.logger.warn("terminal_placement_failed", { padId: pending.padId, sessionId });
      this.rooms.evictIfIdle(pending.padId);
      return;
    }
    this.store.createSession({
      id: sessionId,
      machineId,
      padId: pending.padId,
      createdBy: pending.createdBy,
      agentPrincipalId: pending.agentPrincipalId,
      createdAt: pending.createdAt,
    });
    const info: SessionInfo = {
      id: sessionId,
      padId: pending.padId,
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
    // The opener never chose a tile id, so its reply carries the ref it did choose. Only
    // a `placement: "tile"` opener asked for the field: pre-v11 peers strict-parse this
    // union, so the canvas reply stays byte-identical.
    pending.opener.send({
      type: "terminal_opened",
      elementId,
      session: info,
      ...(pending.placement === "tile" ? { ref: pending.ref } : {}),
    });
    room?.broadcast({ type: "terminal_opened", elementId, session: info }, false, pending.opener);
    room?.broadcast({ type: "session_event", sessionId, kind: "opened" });
    // A second leaf is a composition, not a bubble: the same claim a dropped tile makes.
    if (pending.placement === "tile" && room !== null) {
      this.placement?.hardenIfComposed(pending.padId, room);
    }
    this.store.addEvent(pending.padId, this.runtime.now(), pending.createdBy, "session_opened", {
      sessionId,
      machineId,
      elementId,
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
   * Requests PTY termination from the current controller principal, or from any
   * holder of the wildcard capability (owner janitor: pruning an orphaned session
   * whose canvas element is gone must not require winning the controller lease).
   */
  kill(peer: SessionPeer, message: TerminalKill): void {
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
    const isController = session.info.controllerId === peer.auth.principal.id;
    if (!isController && !peer.auth.isRoot) {
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
    this.requestKill(session);
  }

  /**
   * Owner-authorized kill for HTTP callers (`DELETE /api/terminals/:id`), which hold no
   * session peer and therefore no controller lease to win. Parked sessions have no pad
   * room at all, so this is the only way to destroy one.
   */
  killById(sessionId: string): "ok" | "not_found" | "conflict" {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return "not_found";
    if (session.info.status !== "running") return "conflict";
    this.requestKill(session);
    return "ok";
  }

  private requestKill(session: RuntimeSession): void {
    const machine = this.machines.get(session.info.machineId);
    // A kill is durable even while the machine is offline or its socket refuses the frame.
    // Persisting the exit prevents this stale row from surviving forever; if the PTY later
    // reconnects, hello reconciliation sees the exited record and explicitly kills it.
    if (machine === undefined || !machine.send({ type: "kill", sessionId: session.info.id })) {
      this.onExited(session.info.machineId, session.info.id, null);
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
    // A parked session is bound to no pad: there is no room to notify and no pad whose
    // residency its exit could release. The pool janitor collects it instead.
    const padId = session.info.padId;
    if (padId !== null) {
      this.rooms.live(padId)?.broadcast({
        type: "session_event",
        sessionId,
        kind: "exited",
        exitCode,
      });
    }
    const stored = this.store.getSession(sessionId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, session.info.createdBy);
    }
    this.store.addEvent(padId, this.runtime.now(), session.info.createdBy, "session_exited", {
      sessionId,
      machineId,
      exitCode,
    });
    if (padId !== null) this.rooms.evictIfIdle(padId);
  }

  /** Appends to the pool: one past the highest explicit position any other entry holds. */
  private nextPoolSortOrder(exceptSessionId: string): number {
    let highest = -1;
    for (const parked of this.store.listParkedSessions()) {
      if (parked.id === exceptSessionId || parked.sortOrder === null) continue;
      if (parked.sortOrder > highest) highest = parked.sortOrder;
    }
    return highest + 1;
  }

  /**
   * Renames a terminal. Names are session state, not pad state, so this works while the
   * session is parked; bound sessions additionally publish the new label to their room so
   * every viewer's titlebar and session row re-render without a refetch.
   */
  rename(sessionId: string, name: string): "ok" | "not_found" {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return "not_found";
    session.info = { ...session.info, name };
    this.store.updateSessionName(sessionId, name);
    const padId = session.info.padId;
    if (padId !== null) {
      this.rooms
        .live(padId)
        ?.broadcast({ type: "session_event", sessionId, kind: "renamed", name });
    }
    this.store.addEvent(padId, this.runtime.now(), session.info.createdBy, "session_renamed", {
      sessionId,
      name,
    });
    return "ok";
  }

  /**
   * Reorders a parked terminal inside the workspace pool. Positions are rewritten
   * contiguously (0..n-1) over the canonical pool ordering, so the pool never depends on
   * sparse historical values. Bound sessions have no pool position to move.
   */
  movePooled(sessionId: string, index: number): "ok" | "not_found" | "conflict" {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return "not_found";
    if (session.info.padId !== null) return "conflict";
    const pool = this.store.listParkedSessions();
    const from = pool.findIndex((entry) => entry.id === sessionId);
    if (from === -1) return "not_found";
    const [moved] = pool.splice(from, 1);
    if (moved === undefined) return "not_found";
    pool.splice(Math.min(Math.max(index, 0), pool.length), 0, moved);
    for (const [position, entry] of pool.entries()) {
      if (entry.sortOrder === position) continue;
      this.store.updateSessionSortOrder(entry.id, position);
    }
    return "ok";
  }

  /**
   * `SessionPlacementPort`: the placement-relevant slice of live session state. Only the
   * container binding matters to placement — geometry, viewers and controller leases are
   * this class's business.
   */
  placedSession(sessionId: string): { readonly padId: string | null } | null {
    const session = this.sessions.get(sessionId);
    return session === undefined ? null : { padId: session.info.padId };
  }

  /**
   * `SessionPlacementPort`: publishes a session's move between containers. The executor
   * has already authored the new placement and disposed of the old one; this is the
   * fan-out, exactly as park and bind published it — the old room hears `parked` because
   * the session left it, the new room hears `terminal_opened` with the new placement id.
   */
  rebindSession(
    sessionId: string,
    fromPadId: string | null,
    toPadId: string,
    placementId: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.info = { ...session.info, padId: toPadId };
    this.store.updateSessionPad(sessionId, toPadId);
    if (fromPadId !== null && fromPadId !== toPadId) {
      // Viewers attached through the old room can no longer reach the session: the
      // broker gates every session message on the peer's pad.
      for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
      session.viewers.clear();
      this.rooms.live(fromPadId)?.broadcast({ type: "session_event", sessionId, kind: "parked" });
    }
    this.rooms
      .live(toPadId)
      ?.broadcast({ type: "terminal_opened", elementId: placementId, session: session.info });
    this.store.addEvent(toPadId, this.runtime.now(), session.info.createdBy, "session_bound", {
      sessionId,
      elementId: placementId,
    });
  }

  /**
   * `SessionPlacementPort`: unbinds a session into the workspace pool. Its placement is
   * already gone — the executor removed it — so this is the session half of a release.
   */
  releaseSessionToPool(sessionId: string, fromPadId: string, placementId: string | null): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.info = { ...session.info, padId: null };
    this.store.updateSessionPad(sessionId, null);
    this.store.updateSessionSortOrder(sessionId, this.nextPoolSortOrder(sessionId));
    for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
    session.viewers.clear();
    this.rooms.live(fromPadId)?.broadcast({ type: "session_event", sessionId, kind: "parked" });
    this.store.addEvent(fromPadId, this.runtime.now(), session.info.createdBy, "session_parked", {
      sessionId,
      elementId: placementId,
    });
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
   * Transmutes a terminal into a tiled view born around it. The session rebinds into the
   * view and its canvas element becomes a portal at the same spot, so collaborators watch
   * the terminal turn into a live view widget in place. The view starts transient: it is a
   * bubble until somebody splits, renames, or pins it.
   */
  expand(sessionId: string): { viewId: string } | "not_found" | "exited" {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return "not_found";
    if (session.info.status !== "running") return "exited";
    const originPadId = session.info.padId;
    const viewId = this.runtime.newId();
    const view: Pad = {
      id: viewId,
      name: this.terminalLabel(sessionId, "view"),
      createdAt: this.runtime.now(),
      layout: "tiled",
      transient: true,
    };
    this.store.createPad(view, originPadId);
    const room = this.rooms.get(viewId);
    const tileId = room?.placeTerminalTile(sessionId, null, null) ?? null;
    if (room === null || tileId === null) {
      // A freshly seeded tree always has an empty root leaf, so this is unreachable in
      // practice; rolling the row back keeps a failed expand from leaving a stray view.
      this.rooms.drop(viewId);
      this.store.deletePad(viewId);
      return "not_found";
    }
    const originRoom = originPadId === null ? null : this.rooms.get(originPadId);
    if (originRoom !== null) {
      // Multi-mirror sessions: the FIRST placement becomes the portal and the remaining
      // mirrors keep rendering; the session is view-bound and they read through its room.
      const elementId = originRoom.elementIdsForSession(sessionId)[0] ?? null;
      if (elementId !== null) {
        originRoom.swapElementToPortal(elementId, viewId);
      } else {
        // Expanding a tile: there is no canvas element to transmute, so the leaf it left
        // behind is removed rather than pointing at a session that now lives elsewhere.
        const leafId = tileIdForSurface(originRoom.tileLayout(), {
          kind: "terminal",
          sessionId,
        });
        if (leafId !== null) originRoom.removeTileLeafById(leafId);
      }
    }
    this.rebindSession(sessionId, originPadId, viewId, tileId);
    if (originPadId !== null) this.rooms.evictIfIdle(originPadId);
    return { viewId };
  }

  /**
   * Pool janitor: a parked session has no pad room to prove its canvas element is gone, so
   * exited pool entries are collected when the pool is listed.
   */
  pruneExitedParked(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.info.padId !== null || session.info.status !== "exited") continue;
      for (const viewer of session.viewers.values()) viewer.cancelSnapshotDeadline?.();
      session.viewers.clear();
      this.sessions.delete(sessionId);
      this.store.deleteSession(sessionId);
    }
  }

  /**
   * Deletes exited sessions whose canvas element no longer references them. This is
   * explicitly invoked at exit and before init/resync; ordinary roster reads stay pure.
   */
  pruneExitedUnreferencedForPad(padId: string): void {
    const room = this.rooms.live(padId);
    if (room === null) return;
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
