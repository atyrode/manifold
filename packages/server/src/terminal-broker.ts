import {
  hasCap,
  type AdvertisedTerminal,
  type AgentMessage,
  type ClientMessageBody,
  type EventKind,
  type EventPayload,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type TerminalInfo,
} from "@manifold/protocol";
import type { AuthService } from "./auth.ts";
import type { EventHub } from "./event-hub.ts";
import type { Logger } from "./log.ts";
import type { PlaceExecutor, TerminalPlacementPort } from "./placement.ts";
import type { RoomManager, RoomTimers, TileTreeDisciplines } from "./room.ts";
import {
  serializeServerMessage,
  type SerializedServerMessage,
  type SessionChannel,
} from "./session-channel.ts";
import type { ServerStore } from "./stores.ts";

/**
 * The broker answers a CHANNEL, and a channel IS one room view, so its payload types are
 * the channel-agnostic bodies: routing was already consumed by the gateway.
 */
type TerminalOpen = Extract<ClientMessageBody, { type: "terminal_open" }>;
type TerminalAttach = Extract<ClientMessageBody, { type: "terminal_attach" }>;
type TerminalDetach = Extract<ClientMessageBody, { type: "terminal_detach" }>;
type TerminalInput = Extract<ClientMessageBody, { type: "terminal_input" }>;
type TerminalResize = Extract<ClientMessageBody, { type: "terminal_resize" }>;
type TerminalTake = Extract<ClientMessageBody, { type: "terminal_take" }>;
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

interface RuntimeTerminal {
  info: TerminalInfo;
  viewers: Map<SessionChannel, Viewer>;
  lastReceivedOutputSeq: number;
  snapshotGeneration: number;
  snapshotRequestOutstanding: boolean;
}

interface PendingOpen {
  terminalId: string;
  /** The container the gesture happened in: where the reply goes and residency is held. */
  containerId: string;
  /**
   * The composition this terminal will LIVE in, minted before the PTY so the agent's token
   * and `MANIFOLD_CONTAINER` are scoped to it from the first byte. For a composition opener
   * that is the composition it was opened in; for a canvas opener it is a solo composition
   * born with the terminal, and the canvas gets a portal onto it.
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
  opener: SessionChannel;
  agentPrincipalId: string;
  cancelDeadline: (() => void) | null;
}

/**
 * Routes terminal lifecycle/control while preserving the snapshot-plus-tail attach
 * invariant. PLACEMENT is not here: `placement.ts` owns where items live, and this class
 * implements `TerminalPlacementPort` for it — terminals, PTYs and their fan-out.
 */
export class TerminalBroker implements TerminalPlacementPort {
  private readonly machines = new Map<string, MachineChannel>();
  private readonly terminals = new Map<string, RuntimeTerminal>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  /**
   * Circular startup wiring, same shape as `RoomManager`'s providers: a terminal born
   * directly into a composition hardens the container it composed, and that rule lives
   * with the rest of container lifecycle.
   */
  private placement: PlaceExecutor | null = null;
  /**
   * The event plane, installed on the same circular-wiring pattern as `placement` above: the
   * hub reads the assembly and the assembly is built after this class. Null-tolerant for the
   * same reason — a terminal restored at construction time has no lifecycle to announce, and a
   * test that drives the PTY mechanism alone should not have to own a hub.
   */
  private events: EventHub | null = null;

  constructor(
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly publicUrl: () => string,
    /**
     * The declared tile-tree question (`TileTreeDisciplines`), which is what decides who
     * authors a terminal's placement: a container with a tree is placed into server-side by
     * naming a leaf, a container without one is placed into by the opener authoring an
     * element. A constructor dependency for the reason `RoomManager`'s is — the roster
     * arrives as a thunk, and there is no honest default for "does this hold a tile tree".
     */
    private readonly holdsTileTree: TileTreeDisciplines,
  ) {
    for (const row of store.listTerminals()) {
      const info: TerminalInfo = {
        id: row.id,
        containerId: row.containerId,
        name: row.name,
        machineId: row.machineId,
        status: row.status,
        exitCode: row.exitCode,
        cols: 80,
        rows: 24,
        controllerId: row.status === "running" ? row.createdBy : null,
        createdBy: row.createdBy,
      };
      this.terminals.set(row.id, {
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

  /** Installs the event plane after circular startup wiring completes. */
  setEvents(events: EventHub): void {
    this.events = events;
  }

  /**
   * ONE terminal-lifecycle announcement — the durable row and the fan-out, from one call.
   *
   * `store.addEvent` stays the one writer of history either way. When the plane is installed
   * the hub calls it, so the row and the notification cannot disagree about what happened
   * (ADR 0012 §5: durable history is that table, read as a table). When it is not — a focused
   * PTY test, or the moment before startup wiring completes — the row still has to land,
   * because the audit trail is not a subscriber and a terminal's birth is not less true for
   * having nobody watching.
   *
   * The TOPIC is the terminals COLLECTION, not the terminal, and that follows from the matching
   * rule rather than from taste. A terminal is a root of the addressing grammar (it can be
   * rehomed and keeps its identity), so no container subscription can reach it — and the two
   * surfaces that need this news, the workspace terminal index and the per-container one, both
   * live OUTSIDE the rooms they report on and neither can know a newborn terminal's id in
   * advance. The in-room half of the same news already rides the session channel as
   * `terminal_event`, which is why addressing the collection loses nothing and turns a polled
   * feed into exactly one subscription.
   *
   * `containerId` still travels, as the AUDIT TRAIL's container — a different question from the
   * topic, and the one that keeps `core.events.list({ containerId })` answering exactly what it
   * answered before. It is passed rather than resolved because a kill has already unhomed its
   * terminal by the time the announcement is due, and the trail must still say where it lived.
   */
  private announce(
    containerId: string,
    kind: EventKind,
    actor: string | null,
    payload: EventPayload,
  ): void {
    if (this.events === null) {
      this.store.addEvent(containerId, this.runtime.now(), actor, kind, payload);
      return;
    }
    this.events.emitCollection("terminals", kind, actor, payload, containerId);
  }

  /**
   * Registers the currently fenced socket for a machine id.
   *
   * The emission is gated on a genuine TRANSITION: a machine reconnecting supersedes its own
   * socket (`machine-ws.ts`) without ever having gone offline, and an `online` for a machine
   * that never stopped being online would be news about a socket rather than about the
   * machine. `actor` is null because nobody asked for this — a machine dialling in is the
   * world moving, not a principal acting.
   */
  setMachineOnline(channel: MachineChannel): void {
    const wasOnline = this.machines.has(channel.machineId);
    this.machines.set(channel.machineId, channel);
    if (wasOnline) return;
    this.events?.emitCollection("machines", "machine_online", null, {
      machineId: channel.machineId,
    });
  }

  /** Removes a socket only if it remains the active fenced channel. */
  setMachineOffline(channel: MachineChannel): void {
    if (this.machines.get(channel.machineId) !== channel) return;
    this.machines.delete(channel.machineId);
    // The delete IS the transition; the pending-open reaping below is consequence, not commit.
    this.events?.emitCollection("machines", "machine_offline", null, {
      machineId: channel.machineId,
    });
    for (const [terminalId, pending] of this.pendingOpens) {
      if (pending.machineId !== channel.machineId) continue;
      pending.cancelDeadline?.();
      pending.opener.send({
        type: "error",
        code: "no_machine",
        message: "machine disconnected while opening terminal",
        ref: pending.ref,
      });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      this.pendingOpens.delete(terminalId);
      this.rooms.evictIfIdle(pending.containerId);
    }
    for (const terminal of this.terminals.values()) {
      if (terminal.info.machineId !== channel.machineId || terminal.info.status !== "running") {
        continue;
      }
      terminal.snapshotRequestOutstanding = false;
      for (const [viewerChannel, viewer] of terminal.viewers) {
        this.failViewer(
          terminal,
          viewerChannel,
          viewer,
          "no_machine",
          "terminal machine disconnected",
        );
      }
    }
  }

  /** Reports whether the persisted machine currently has an authenticated socket. */
  isMachineOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** Whether an agent create is still in flight for this container. */
  hasPendingOpenForContainer(containerId: string): boolean {
    for (const pending of this.pendingOpens.values()) {
      if (pending.containerId === containerId) return true;
    }
    return false;
  }

  private failViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    code: "conflict" | "no_machine",
    message: string,
  ): void {
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = null;
    if (terminal.viewers.get(channel) !== viewer) return;
    terminal.viewers.delete(channel);
    channel.send({ type: "error", code, message, ref: terminal.info.id });
  }

  private armSnapshotDeadline(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
  ): void {
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = this.timers.schedule(() => {
      viewer.cancelSnapshotDeadline = null;
      if (terminal.viewers.get(channel) !== viewer || viewer.state !== "PENDING") return;
      const requestTimedOut = terminal.snapshotRequestOutstanding;
      if (requestTimedOut) terminal.snapshotRequestOutstanding = false;
      terminal.viewers.delete(channel);
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal snapshot timed out",
        ref: terminal.info.id,
      });
      this.logger.warn("terminal_snapshot_timeout", {
        terminalId: terminal.info.id,
        machineId: terminal.info.machineId,
      });
      if (requestTimedOut) this.requestSnapshotForPending(terminal);
    }, SNAPSHOT_DEADLINE_MS);
  }

  /** Sends at most one snapshot request and binds its generation to current PENDING viewers. */
  private requestSnapshotForPending(terminal: RuntimeTerminal): void {
    if (terminal.snapshotRequestOutstanding || terminal.info.status !== "running") return;
    let hasPending = false;
    for (const viewer of terminal.viewers.values()) {
      if (viewer.state === "PENDING") {
        hasPending = true;
        break;
      }
    }
    if (!hasPending) return;

    const machine = this.machines.get(terminal.info.machineId);
    if (machine === undefined) {
      for (const [channel, viewer] of terminal.viewers) {
        if (viewer.state === "PENDING") {
          this.failViewer(terminal, channel, viewer, "no_machine", "terminal machine is offline");
        }
      }
      return;
    }

    terminal.snapshotGeneration += 1;
    const generation = terminal.snapshotGeneration;
    for (const viewer of terminal.viewers.values()) {
      if (viewer.state === "PENDING") viewer.snapshotGeneration = generation;
    }
    terminal.snapshotRequestOutstanding = true;
    if (machine.send({ type: "snapshot_request", terminalId: terminal.info.id })) return;

    terminal.snapshotRequestOutstanding = false;
    for (const [channel, viewer] of terminal.viewers) {
      if (viewer.state === "PENDING" && viewer.snapshotGeneration === generation) {
        this.failViewer(terminal, channel, viewer, "no_machine", "terminal machine is unavailable");
      }
    }
  }

  /** Re-registers a surviving PTY only against its persisted container binding. */
  adoptTerminal(machineId: string, advertised: AdvertisedTerminal): boolean {
    const stored = this.store.getTerminal(advertised.terminalId);
    if (stored === null || stored.machineId !== machineId) return false;
    let terminal = this.terminals.get(stored.id);
    if (terminal === undefined) {
      const info: TerminalInfo = {
        id: stored.id,
        containerId: stored.containerId,
        name: stored.name,
        machineId: stored.machineId,
        status: stored.status,
        exitCode: stored.exitCode,
        cols: 80,
        rows: 24,
        controllerId: stored.status === "running" ? stored.createdBy : null,
        createdBy: stored.createdBy,
      };
      terminal = {
        info,
        viewers: new Map(),
        lastReceivedOutputSeq: 0,
        snapshotGeneration: 0,
        snapshotRequestOutstanding: false,
      };
      this.terminals.set(stored.id, terminal);
    }
    if (!advertised.alive) {
      if (terminal.info.status === "running") {
        this.onExited(machineId, advertised.terminalId, advertised.exitCode ?? null);
      }
      return false;
    }
    if (stored.status !== "running") return false;
    terminal.info = {
      ...terminal.info,
      status: "running",
      exitCode: null,
      cols: advertised.cols,
      rows: advertised.rows,
    };
    terminal.snapshotRequestOutstanding = false;
    const adoptedContainerId = terminal.info.containerId;
    if (adoptedContainerId !== null) {
      this.rooms.live(adoptedContainerId)?.broadcast({
        type: "terminal_event",
        terminalId: terminal.info.id,
        kind: "controller_changed",
        controllerId: terminal.info.controllerId,
      });
    }
    if (terminal.viewers.size > 0) {
      for (const [channel, viewer] of terminal.viewers) {
        viewer.state = "PENDING";
        viewer.queue = [];
        viewer.queuedBytes = 0;
        viewer.lastDeliveredSeq = 0;
        viewer.snapshotGeneration = terminal.snapshotGeneration + 1;
        this.armSnapshotDeadline(terminal, channel, viewer);
      }
      this.requestSnapshotForPending(terminal);
    }
    return true;
  }

  /**
   * Reconciles the complete hello inventory: missing durable PTYs are exited, while
   * unadoptable agent PTYs are explicitly killed instead of becoming unmanaged orphans.
   */
  reconcileMachineHello(machineId: string, advertised: readonly AdvertisedTerminal[]): void {
    const advertisedIds = new Set<string>();
    const channel = this.machines.get(machineId);
    for (const candidate of advertised) {
      advertisedIds.add(candidate.terminalId);
      if (!this.adoptTerminal(machineId, candidate)) {
        channel?.send({ type: "kill", terminalId: candidate.terminalId });
      }
    }
    for (const stored of this.store.listRunningTerminalsForMachine(machineId)) {
      if (!advertisedIds.has(stored.id)) this.onExited(machineId, stored.id, null);
    }
  }

  private selectMachine(requested: string | undefined): MachineChannel | null {
    if (requested !== undefined) return this.machines.get(requested) ?? null;
    if (this.machines.size !== 1) return null;
    return this.machines.values().next().value ?? null;
  }

  /**
   * Starts a PTY create request. Spawn AUTHORITY is not asked here any more: the session
   * gateway dispatches `core.terminals.open` before it calls this, and that door carries
   * `terminals:spawn` at the container's scope (ADR 0013 — terminal policy is a plugin,
   * terminal bytes are floor). What remains is mechanism: placement discipline, machine
   * selection, and the create round trip.
   */
  open(channel: SessionChannel, message: TerminalOpen): void {
    /*
      Discipline decides who authors the placement, and it decides it from its DECLARATION
      (#125): a container that holds a tile tree is placed into server-side by naming a leaf,
      any other container by the opener authoring an element. A mismatch is refused rather
      than spawning a PTY nothing would ever render — an opener that forgot its element, or a
      tile-tree opener that thinks it authors one.
    */
    const container = this.store.getContainer(channel.containerId);
    const placement = message.placement ?? "element";
    const tileTree = container !== null && this.holdsTileTree(container.discipline);
    if (tileTree !== (placement === "tile")) {
      channel.send({
        type: "error",
        code: "conflict",
        message:
          placement === "tile"
            ? 'placement "tile" requires a container that holds a tile tree'
            : 'this container places terminals server-side: send placement "tile"',
        ref: message.elementId,
      });
      return;
    }
    const machine = this.selectMachine(message.machineId);
    if (machine === null) {
      channel.send({
        type: "error",
        code: "no_machine",
        message: "no unambiguous online machine",
        ref: message.elementId,
      });
      return;
    }

    const terminalId = this.runtime.newId();
    /*
      The home is decided here, before the PTY exists, because the agent token and the
      `MANIFOLD_CONTAINER` a program inside the terminal reads both have to name the container
      the terminal LIVES in — and a canvas is never that. A composition opener already is the
      home; a canvas opener gets a solo composition, whose ROW is created when the PTY lands
      so a create that fails leaves nothing behind to clean up.
     */
    const homeId = placement === "tile" ? channel.containerId : this.runtime.newId();
    const grant = this.auth.mintSessionAgentToken(terminalId, homeId, channel.auth.principal.id);
    const pending: PendingOpen = {
      terminalId,
      containerId: channel.containerId,
      homeId,
      ref: message.elementId,
      placement,
      machineId: machine.machineId,
      createdBy: channel.auth.principal.id,
      createdAt: this.runtime.now(),
      cols: message.cols,
      rows: message.rows,
      opener: channel,
      agentPrincipalId: grant.principal.id,
      cancelDeadline: null,
    };
    this.pendingOpens.set(terminalId, pending);
    pending.cancelDeadline = this.timers.schedule(() => {
      pending.cancelDeadline = null;
      if (this.pendingOpens.get(terminalId) !== pending) return;
      this.pendingOpens.delete(terminalId);
      this.machines.get(machine.machineId)?.send({ type: "kill", terminalId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "no_machine",
        message: "terminal creation timed out",
        ref: pending.ref,
      });
      this.logger.warn("terminal_create_timeout", {
        machineId: machine.machineId,
        terminalId,
      });
      this.rooms.evictIfIdle(pending.containerId);
    }, CREATE_DEADLINE_MS);
    const sent = machine.send({
      type: "create",
      terminalId,
      cols: message.cols,
      rows: message.rows,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      env: {
        MANIFOLD_URL: this.publicUrl(),
        // The container the terminal LIVES in, which is what a program inside it should see
        // when it asks where it is. `MANIFOLD_ELEMENT` is only meaningful for a canvas
        // opener, which authors its portal under exactly that id.
        MANIFOLD_CONTAINER: homeId,
        ...(placement === "tile" ? {} : { MANIFOLD_ELEMENT: message.elementId }),
        MANIFOLD_TOKEN: grant.token,
      },
    });
    if (!sent) {
      pending.cancelDeadline?.();
      this.pendingOpens.delete(terminalId);
      this.auth.revokeIssuedPrincipal(grant.principal.id, channel.auth.principal.id);
      channel.send({
        type: "error",
        code: "no_machine",
        message: "machine connection unavailable",
        ref: message.elementId,
      });
      this.rooms.evictIfIdle(pending.containerId);
    }
  }

  /**
   * Commits a created PTY, replies to its opener, and publishes durable lifecycle state.
   *
   * This is where `homed: "eager"` is actually paid for: with the PTY in hand, the terminal's
   * home leaf is written before its terminal row exists, so there is no instant at which a
   * live terminal has nowhere to live. A composition opener IS the home and only needs a
   * leaf; a canvas opener gets a whole solo composition, and its own portal element —
   * authored client-side under the ref it chose — points at the id this reply hands back.
   */
  onCreated(machineId: string, terminalId: string): void {
    const pending = this.pendingOpens.get(terminalId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(terminalId);
    pending.cancelDeadline?.();
    const home =
      pending.placement === "tile"
        ? (this.rooms.get(pending.homeId)?.placeTerminalTile(terminalId, null, null) ?? null)
        : (this.placement?.createHome(pending.homeId, terminalId, this.bornLabel(machineId)) ??
          null);
    if (home === null) {
      // Nothing durable exists yet, so the PTY is the only thing to undo.
      this.machines.get(machineId)?.send({ type: "kill", terminalId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "conflict",
        message: "this terminal could not be given a home",
        ref: pending.ref,
      });
      this.logger.warn("terminal_home_failed", {
        containerId: pending.containerId,
        terminalId,
      });
      this.rooms.evictIfIdle(pending.containerId);
      return;
    }
    this.store.createTerminal({
      id: terminalId,
      machineId,
      containerId: pending.homeId,
      createdBy: pending.createdBy,
      agentPrincipalId: pending.agentPrincipalId,
      createdAt: pending.createdAt,
    });
    const info: TerminalInfo = {
      id: terminalId,
      containerId: pending.homeId,
      name: null,
      machineId,
      status: "running",
      exitCode: null,
      cols: pending.cols,
      rows: pending.rows,
      controllerId: pending.createdBy,
      createdBy: pending.createdBy,
    };
    this.terminals.set(terminalId, {
      info,
      viewers: new Map(),
      lastReceivedOutputSeq: 0,
      snapshotGeneration: 0,
      snapshotRequestOutstanding: false,
    });
    /*
      The reply carries the home LEAF for a composition opener and the opener's own ref for a
      canvas one, because those are the ids each of them will render under;
      `terminal.containerId` carries the home either way, which is what a canvas opener
      portals onto.

      The fan-out goes to the HOME's room, not the opener's: after this cutover nothing
      about a terminal is canvas state. A canvas learns about the new terminal the same way
      it learns about anything else on it — the portal element arriving in its document.
     */
    pending.opener.send({
      type: "terminal_opened",
      elementId: pending.placement === "tile" ? home : pending.ref,
      terminal: info,
      ...(pending.placement === "tile" ? { ref: pending.ref } : {}),
    });
    const homeRoom = this.rooms.live(pending.homeId);
    homeRoom?.broadcast(
      { type: "terminal_opened", elementId: home, terminal: info },
      false,
      pending.opener,
    );
    homeRoom?.broadcast({ type: "terminal_event", terminalId, kind: "opened" });
    // THE BIRTH, announced once, on the terminals collection: nobody could have subscribed to a
    // terminal that did not exist a statement ago, so the collection is the only address a
    // watcher of the terminal index could have named.
    this.announce(pending.homeId, "terminal_opened", pending.createdBy, {
      terminalId,
      machineId,
      elementId: home,
    });
    this.rooms.evictIfIdle(pending.containerId);
    if (pending.homeId !== pending.containerId) this.rooms.evictIfIdle(pending.homeId);
  }

  /** The label a newborn terminal's home takes: its machine's name, else a plain noun. */
  private bornLabel(machineId: string): string {
    return this.store.getMachine(machineId)?.name ?? "terminal";
  }

  /** Resolves a rejected PTY create without exposing agent diagnostics to clients. */
  onCreateError(machineId: string, terminalId: string): void {
    const pending = this.pendingOpens.get(terminalId);
    if (pending === undefined || pending.machineId !== machineId) return;
    this.pendingOpens.delete(terminalId);
    pending.cancelDeadline?.();
    this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
    pending.opener.send({
      type: "error",
      code: "conflict",
      message: "terminal creation failed",
      ref: pending.ref,
    });
    this.logger.warn("terminal_create_failed", { machineId, terminalId });
    this.rooms.evictIfIdle(pending.containerId);
  }

  private terminalFor(channel: SessionChannel, terminalId: string): RuntimeTerminal | null {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.info.containerId !== channel.containerId) {
      channel.send({
        type: "error",
        code: "not_found",
        message: "terminal not found",
        ref: terminalId,
      });
      return null;
    }
    return terminal;
  }

  /** Begins PENDING attachment before requesting the agent's ordered snapshot watermark. */
  attach(channel: SessionChannel, message: TerminalAttach): void {
    const terminal = this.terminalFor(channel, message.terminalId);
    if (terminal === null) return;
    if (terminal.info.status !== "running") {
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal has exited",
        ref: message.terminalId,
      });
      return;
    }
    const machine = this.machines.get(terminal.info.machineId);
    if (machine === undefined) {
      channel.send({
        type: "error",
        code: "no_machine",
        message: "terminal machine is offline",
        ref: message.terminalId,
      });
      return;
    }
    const previous = terminal.viewers.get(channel);
    previous?.cancelSnapshotDeadline?.();
    const viewer: Viewer = {
      state: "PENDING",
      queue: [],
      queuedBytes: 0,
      cancelSnapshotDeadline: null,
      snapshotGeneration: terminal.snapshotGeneration + 1,
      lastDeliveredSeq: 0,
    };
    terminal.viewers.set(channel, viewer);
    this.armSnapshotDeadline(terminal, channel, viewer);
    this.requestSnapshotForPending(terminal);
  }

  /** Stops routing one terminal's bytes to a viewer. */
  detach(channel: SessionChannel, message: TerminalDetach): void {
    const viewer = this.terminals.get(message.terminalId)?.viewers.get(channel);
    viewer?.cancelSnapshotDeadline?.();
    this.terminals.get(message.terminalId)?.viewers.delete(channel);
  }

  /** Removes a closing socket from every terminal's viewer registry. */
  detachAll(channel: SessionChannel): void {
    for (const terminal of this.terminals.values()) {
      terminal.viewers.get(channel)?.cancelSnapshotDeadline?.();
      terminal.viewers.delete(channel);
    }
  }

  /** Queues output for PENDING viewers and relays it directly only after handoff is LIVE. */
  onOutput(machineId: string, output: OutputFrame): void {
    const terminal = this.terminals.get(output.terminalId);
    if (
      terminal === undefined ||
      terminal.info.machineId !== machineId ||
      terminal.info.status !== "running"
    ) {
      return;
    }
    if (output.seq <= terminal.lastReceivedOutputSeq) return;
    terminal.lastReceivedOutputSeq = output.seq;
    let serialized: SerializedServerMessage | null = null;
    for (const [channel, viewer] of terminal.viewers) {
      if (viewer.state === "LIVE") {
        if (output.seq <= viewer.lastDeliveredSeq) continue;
        serialized ??= serializeServerMessage({
          type: "terminal_output",
          terminalId: output.terminalId,
          seq: output.seq,
          data: output.data,
        });
        if (!channel.sendSerialized(serialized)) {
          viewer.cancelSnapshotDeadline?.();
          terminal.viewers.delete(channel);
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
        this.failViewer(terminal, channel, viewer, "conflict", "terminal attach queue overflow");
        continue;
      }
      viewer.queue.push(output);
      viewer.queuedBytes += bytes;
    }
  }

  /** Completes PENDING attach as snapshot(S) followed exactly by unique queued seq > S. */
  onSnapshot(machineId: string, snapshot: SnapshotFrame): void {
    const terminal = this.terminals.get(snapshot.terminalId);
    if (terminal === undefined || terminal.info.machineId !== machineId) return;
    if (terminal.info.status !== "running") return;
    if (!terminal.snapshotRequestOutstanding) return;
    const generation = terminal.snapshotGeneration;
    terminal.snapshotRequestOutstanding = false;
    const snapshotFrame = serializeServerMessage({
      type: "terminal_snapshot",
      terminalId: snapshot.terminalId,
      seq: snapshot.seq,
      data: snapshot.data,
    });
    const outputFrames = new Map<number, SerializedServerMessage>();
    for (const [channel, viewer] of terminal.viewers) {
      if (viewer.state !== "PENDING" || viewer.snapshotGeneration !== generation) continue;
      viewer.cancelSnapshotDeadline?.();
      viewer.cancelSnapshotDeadline = null;
      if (!channel.sendSerialized(snapshotFrame)) {
        terminal.viewers.delete(channel);
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
            terminalId: output.terminalId,
            seq: output.seq,
            data: output.data,
          });
          outputFrames.set(output.seq, outputFrame);
        }
        if (!channel.sendSerialized(outputFrame)) {
          live = false;
          break;
        }
        lastSeq = output.seq;
      }
      if (!live) {
        terminal.viewers.delete(channel);
        continue;
      }
      viewer.queue = [];
      viewer.queuedBytes = 0;
      viewer.lastDeliveredSeq = lastSeq;
      viewer.state = "LIVE";
    }
    this.requestSnapshotForPending(terminal);
  }

  private controllerTerminal(channel: SessionChannel, terminalId: string): RuntimeTerminal | null {
    const terminal = this.terminalFor(channel, terminalId);
    if (terminal === null) return null;
    if (terminal.info.status !== "running") {
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal has exited",
        ref: terminalId,
      });
      return null;
    }
    if (terminal.info.controllerId !== channel.auth.principal.id) {
      channel.send({
        type: "error",
        code: "not_controller",
        message: "terminal controller lease required",
        ref: terminalId,
      });
      return null;
    }
    if (!hasCap(channel.auth.caps, "terminals:write")) {
      channel.send({
        type: "error",
        code: "forbidden",
        message: "terminals:write capability required",
        ref: terminalId,
      });
      return null;
    }
    return terminal;
  }

  /** Forwards base64 input only from the current controller principal. */
  input(channel: SessionChannel, message: TerminalInput): void {
    const terminal = this.controllerTerminal(channel, message.terminalId);
    if (terminal === null) return;
    const machine = this.machines.get(terminal.info.machineId);
    if (
      machine === undefined ||
      !machine.send({
        type: "input",
        terminalId: message.terminalId,
        data: message.data,
      })
    ) {
      channel.send({ type: "error", code: "no_machine", ref: message.terminalId });
    }
  }

  /** Forwards resize from the controller and broadcasts the new shared geometry. */
  resize(channel: SessionChannel, message: TerminalResize): void {
    const terminal = this.controllerTerminal(channel, message.terminalId);
    if (terminal === null) return;
    const machine = this.machines.get(terminal.info.machineId);
    if (machine === undefined) {
      channel.send({ type: "error", code: "no_machine", ref: message.terminalId });
      return;
    }
    if (
      !machine.send({
        type: "resize",
        terminalId: message.terminalId,
        cols: message.cols,
        rows: message.rows,
      })
    ) {
      channel.send({ type: "error", code: "no_machine", ref: message.terminalId });
      return;
    }
    terminal.info = { ...terminal.info, cols: message.cols, rows: message.rows };
    this.rooms.live(channel.containerId)?.broadcast({
      type: "terminal_event",
      terminalId: message.terminalId,
      kind: "resized",
      cols: message.cols,
      rows: message.rows,
    });
  }

  /**
   * Transfers controller authority to an authorized principal and announces the lease.
   *
   * AUTHORITY IS NOT DECIDED HERE. `terminal_take` dispatches `core.terminals.take` before
   * this runs, so the caps rung, the scope rung and the plugin-enabled rung have all been
   * answered in the published denial vocabulary by the time the transfer happens — and the
   * `terminals:write` check this method used to carry was the second door onto that question
   * (invariant 14). What is left is the transport's own work: resolve the terminal in THIS
   * channel's container, refuse the race where it exited between the dispatch and the write,
   * move the lease, and tell the room.
   */
  take(channel: SessionChannel, message: TerminalTake): void {
    const terminal = this.terminalFor(channel, message.terminalId);
    if (terminal === null) return;
    if (terminal.info.status !== "running") {
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal has exited",
        ref: message.terminalId,
      });
      return;
    }
    terminal.info = { ...terminal.info, controllerId: channel.auth.principal.id };
    this.rooms.live(channel.containerId)?.broadcast({
      type: "terminal_event",
      terminalId: message.terminalId,
      kind: "controller_changed",
      controllerId: channel.auth.principal.id,
    });
  }

  /**
   * A terminal stops in exactly one of two ways, and the whole difference is INTENT.
   *
   *   KILLED — somebody ASKED for it to stop: `terminal_kill`, `core.terminals.kill`,
   *     or closing its last tile. The request is the intent, so the terminal leaves the
   *     world: the PTY, the terminal row, its home composition and every portal onto that
   *     home go together and at once. Afterwards there is no exited row to find and no exit
   *     code to report, because nothing is left to report it on.
   *   EXITED — the PTY stopped on its own (`onExited`). That is INFORMATION the operator may
   *     want, so NOTHING is deleted: the row keeps its real exit code, its home keeps its
   *     leaf, and every portal onto that home keeps rendering it until somebody kills it.
   *
   * The predicate is structural rather than a flag: a killed terminal is out of
   * `this.terminals` before the machine's `exit` frame can arrive, so `onExited` finds
   * nothing and is a no-op for it. Nothing has to remember which door was used, and no third
   * status exists to propagate — a terminal is running, exited on its own, or gone.
   *
   * THE kill: `core.terminals.kill` is the only door, for the session channel's
   * `terminal_kill` frame as much as for the workspace index, so the lease rule and the
   * capability a kill needs live in the plugin that owns terminal policy and this class is
   * left with the mechanism — which is all a plane transport should ever have known. It
   * takes no channel and holds no lease to win, and an already-exited terminal is no
   * conflict: sweeping it is precisely what the caller asked for.
   */
  killById(terminalId: string): "ok" | "not_found" {
    if (!this.terminals.has(terminalId)) return "not_found";
    this.destroyTerminal(terminalId);
    return "ok";
  }

  /**
   * The KILLED half of the predicate above. Containers are `placement.ts`'s business and a
   * home IS a container, so the removal is authored there: pulling the terminal's leaves is
   * what empties its home, and an emptied home takes every portal onto it along. The PTY and
   * the row come back through `reapTerminal`, so the two halves cannot drift apart.
   */
  private destroyTerminal(terminalId: string): void {
    if (this.placement !== null) {
      this.placement.killTerminal(terminalId);
      return;
    }
    // Only reachable before startup wiring completes. A kill must still not leave the
    // terminal behind, even if its home outlives it by a moment.
    this.reapTerminal(terminalId);
  }

  /**
   * Asks a machine to stop a PTY. Best effort by design: every kill deletes the terminal
   * row, so a PTY that outlives the request is killed by hello reconciliation the moment its
   * machine reconnects and finds no row for it. Persisting an exit to keep a stale row
   * honest is the OTHER path's business, and this path has no row left to keep honest.
   */
  private sendPtyStop(terminal: RuntimeTerminal): void {
    this.machines
      .get(terminal.info.machineId)
      ?.send({ type: "kill", terminalId: terminal.info.id });
  }

  /**
   * The EXITED half of the predicate: a PTY that stopped on its own. Persists and broadcasts
   * it without storing terminal bytes, and deletes nothing.
   */
  onExited(machineId: string, terminalId: string, exitCode: number | null): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.info.machineId !== machineId) return;
    if (terminal.info.status === "exited") return;
    for (const viewer of terminal.viewers.values()) viewer.cancelSnapshotDeadline?.();
    terminal.viewers.clear();
    terminal.info = { ...terminal.info, status: "exited", exitCode, controllerId: null };
    this.store.markTerminalExited(terminalId, exitCode);
    // The exit is announced in the terminal's HOME, the room every viewer of it is joined
    // to. Nothing is deleted: the leaf stays, the portals onto the home stay, and the exit
    // code stays visible until somebody deliberately kills the terminal.
    const containerId = terminal.info.containerId;
    this.rooms.live(containerId)?.broadcast({
      type: "terminal_event",
      terminalId,
      kind: "exited",
      exitCode,
    });
    const stored = this.store.getTerminal(terminalId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, terminal.info.createdBy);
    }
    this.announce(containerId, "terminal_exited", terminal.info.createdBy, {
      terminalId,
      machineId,
      exitCode,
    });
    this.rooms.evictIfIdle(containerId);
  }

  /**
   * Renames a terminal. Names are terminal state, not container state, so the new label is
   * published into the terminal's home, where every viewer's titlebar and terminal row picks
   * it up without a refetch.
   */
  rename(terminalId: string, name: string): "ok" | "not_found" {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return "not_found";
    terminal.info = { ...terminal.info, name };
    this.store.updateTerminalName(terminalId, name);
    const containerId = terminal.info.containerId;
    this.rooms
      .live(containerId)
      ?.broadcast({ type: "terminal_event", terminalId, kind: "renamed", name });
    this.announce(containerId, "terminal_renamed", terminal.info.createdBy, {
      terminalId,
      name,
    });
    return "ok";
  }

  /**
   * `TerminalPlacementPort`: the placement-relevant slice of live terminal state. Only the
   * home matters to placement — geometry, viewers and controller leases are this class's
   * business.
   */
  placedTerminal(terminalId: string): { readonly containerId: string } | null {
    const terminal = this.terminals.get(terminalId);
    return terminal === undefined ? null : { containerId: terminal.info.containerId };
  }

  /**
   * The live facts `core.terminals` judges a rename or a kill by: which composition the
   * terminal lives in, whether its PTY is still running, and who holds its lease. Narrower
   * than `TerminalInfo` on purpose — a policy door has no business with geometry or the
   * viewer registry, and the plugin declares exactly this slice as its own contract.
   */
  liveTerminal(terminalId: string): {
    readonly containerId: string;
    readonly status: "running" | "exited";
    readonly controllerId: string | null;
  } | null {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return null;
    const { containerId, status, controllerId } = terminal.info;
    return { containerId, status, controllerId };
  }

  /**
   * `TerminalPlacementPort`: publishes a terminal's move from one composition to another. The
   * executor has already written the new leaf and removed the old one; this is the fan-out.
   * The old room hears `parked` — the terminal genuinely left it — and the new room hears
   * `terminal_opened` with the leaf that now holds it.
   */
  rebindTerminal(
    terminalId: string,
    fromContainerId: string,
    toContainerId: string,
    placementId: string,
  ): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || fromContainerId === toContainerId) return;
    terminal.info = { ...terminal.info, containerId: toContainerId };
    this.store.updateTerminalContainer(terminalId, toContainerId);
    // Viewers attached through the old room can no longer reach the terminal: every terminal
    // message is gated on the channel's own container.
    for (const viewer of terminal.viewers.values()) viewer.cancelSnapshotDeadline?.();
    terminal.viewers.clear();
    this.rooms
      .live(fromContainerId)
      ?.broadcast({ type: "terminal_event", terminalId, kind: "parked" });
    this.rooms
      .live(toContainerId)
      ?.broadcast({ type: "terminal_opened", elementId: placementId, terminal: terminal.info });
    this.announce(toContainerId, "terminal_bound", terminal.info.createdBy, {
      terminalId,
      elementId: placementId,
    });
  }

  /**
   * `TerminalPlacementPort`: the terminal half of a deliberate kill — the PTY is asked to
   * stop and the row is forgotten. Called for a terminal whose last home leaf is gone, which
   * is the same event however it was addressed: closing its tile, killing it by id, or
   * deleting the composition it lived in.
   *
   * No exit is persisted on the way out. The row is being deleted, so an exit record would
   * exist for the length of one statement and, worse, would broadcast an `exited` event for
   * a terminal the operator asked to be RID of — the one thing the killed half of the
   * lifecycle predicate promises never to show. What the home hears instead is `parked`,
   * which already means exactly "this terminal left THIS room" and is what makes every
   * viewer's terminal listing drop the row at once instead of at its next resync.
   */
  reapTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return;
    if (terminal.info.status === "running") this.sendPtyStop(terminal);
    for (const viewer of terminal.viewers.values()) viewer.cancelSnapshotDeadline?.();
    terminal.viewers.clear();
    this.terminals.delete(terminalId);
    this.rooms
      .live(terminal.info.containerId)
      ?.broadcast({ type: "terminal_event", terminalId, kind: "parked" });
    // The injected agent token is scoped to this terminal, so it dies with it. A natural exit
    // revokes in `onExited`; a kill never goes through there, and a live token for a terminal
    // that no longer exists would be the one piece of it left in the world.
    const stored = this.store.getTerminal(terminalId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, terminal.info.createdBy);
    }
    this.store.deleteTerminal(terminalId);
    /*
      THE KILL, announced here rather than at `killById`, because this is the one place every
      kill passes through: closing the last tile, killing by id, and deleting the composition
      the terminal lived in all arrive at this method, and announcing at each door instead
      would be three chances to disagree about one event (invariant 14).

      The topic is the HOME CONTAINER, not the terminal. A killed terminal has no node left to
      be a topic — its address stops resolving the instant the row is gone, and `/api/resolve`
      would answer `exists: false` for it — so the event is addressed to the nearest node that
      still exists, which is also the node every watcher of that terminal was already reached
      through under the hierarchy rule. Nobody watching the home loses the news.
     */
    this.announce(terminal.info.containerId, "terminal_killed", terminal.info.createdBy, {
      terminalId,
      machineId: terminal.info.machineId,
    });
  }

  /**
   * `TerminalPlacementPort`: a terminal's operator-visible label — its own name, else its
   * machine's, else `fallback`. Placement names a terminal's home composition from it.
   */
  terminalLabel(terminalId: string, fallback: string): string {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return fallback;
    return terminal.info.name ?? this.store.getMachine(terminal.info.machineId)?.name ?? fallback;
  }

  /**
   * Collects exited terminals their composition no longer holds a leaf for, and retires the
   * composition when the terminal was the last thing in it. Invoked at exit and before
   * init/resync; ordinary census reads stay pure.
   *
   * This replaces the two janitors the pool needed. There is one rule now — a terminal
   * exists as long as some composition holds a leaf for it — and it needs no unbound state
   * to sweep, because there is no unbound state.
   */
  pruneExitedUnhomedForContainer(containerId: string): void {
    const room = this.rooms.live(containerId);
    if (room === null) return;
    for (const [terminalId, terminal] of this.terminals) {
      if (
        terminal.info.containerId !== containerId ||
        terminal.info.status !== "exited" ||
        room.homesTerminal(terminalId)
      ) {
        continue;
      }
      for (const viewer of terminal.viewers.values()) viewer.cancelSnapshotDeadline?.();
      terminal.viewers.clear();
      this.terminals.delete(terminalId);
      this.store.deleteTerminal(terminalId);
      this.placement?.retireHome(containerId);
    }
  }

  /** Purely lists protocol terminal state for room state and residency reads. */
  listForContainer(containerId: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .map((terminal) => terminal.info)
      .filter((info) => info.containerId === containerId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Kills and forgets every PTY bound to a container before its durable rows are purged. */
  dropContainer(containerId: string): void {
    for (const [terminalId, pending] of this.pendingOpens) {
      if (pending.containerId !== containerId) continue;
      pending.cancelDeadline?.();
      this.machines.get(pending.machineId)?.send({ type: "kill", terminalId });
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
      pending.opener.send({
        type: "error",
        code: "not_found",
        message: "container deleted while opening terminal",
        ref: pending.ref,
      });
      this.pendingOpens.delete(terminalId);
    }
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.info.containerId !== containerId) continue;
      if (terminal.info.status === "running") {
        this.machines
          .get(terminal.info.machineId)
          ?.send({ type: "kill", terminalId: terminal.info.id });
      }
      for (const viewer of terminal.viewers.values()) viewer.cancelSnapshotDeadline?.();
      const stored = this.store.getTerminal(terminalId);
      if (stored !== null && stored.agentPrincipalId !== null) {
        this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, terminal.info.createdBy);
      }
      this.terminals.delete(terminalId);
    }
  }

  /** Returns all secret-free broker terminal state for root introspection. */
  introspect(): TerminalInfo[] {
    return [...this.terminals.values()]
      .map((terminal) => terminal.info)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
