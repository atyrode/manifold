import {
  hasCap,
  MachinePathSchema,
  canonicalJobJson,
  TERMINAL_RESTART_PROTOCOL_VERSION,
  TERMINAL_GEOMETRY_PROTOCOL_VERSION,
  MAX_TERMINAL_DELIVERY_PENDING_BYTES,
  MAX_TERMINAL_DELIVERY_PENDING_FRAMES,
  MAX_TERMINAL_DELIVERY_UNACKED_BYTES,
  MAX_TERMINAL_DELIVERY_UNACKED_FRAMES,
  MAX_TERMINAL_VIEWPORTS,
  TERMINAL_VIEWPORT_LEASE_MS,
  MANIFOLD_ROOT_URI,
  ServerMessageBodySchema,
  formatManifoldUri,
  terminalDeliveryCharge,
  type LaunchRunRequest,
  type LaunchRunResult,
  type TerminalRuntime,
  type AdvertisedTerminal,
  type AgentMessage,
  type ClientMessageBody,
  type EventKind,
  type ErrorCode,
  type EventPayload,
  type MachineDrainStatus,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type TerminalInfo,
  type TerminalDeliveryFrame,
  type TerminalDeliveryRefusal,
  type TerminalDeliveryState,
  type TerminalGeometry,
  type TerminalReadiness,
  type TerminalExecution,
  type TerminalExitReason,
  type TerminalSizing,
  type TokenGrant,
} from "@manifold/protocol";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
} from "./auth.ts";
import { createHash } from "node:crypto";
import type { EventHub } from "./event-hub.ts";
import type { Logger } from "./log.ts";
import type { PlaceExecutor, TerminalPlacementPort } from "./placement.ts";
import type { RoomManager, RoomTimers, TileTreeDisciplines } from "./room.ts";
import type { SerializedServerMessage, SessionChannel } from "./session-channel.ts";
import type { ServerStore, TerminalLaunchRecipe } from "./stores.ts";
import type { JobService } from "./job-service.ts";
import {
  ActionAuthorityFence,
  type ActionAuthorityRequirement,
  type TerminalOwnerBinding,
} from "./action-authority-fence.ts";
import { requireActionEffects } from "./action-preparation-phase.ts";

/**
 * The broker answers a CHANNEL, and a channel IS one room view, so its payload types are
 * the channel-agnostic bodies: routing was already consumed by the gateway.
 */
type TerminalOpen = Extract<ClientMessageBody, { type: "terminal_open" }>;
type TerminalAttach = Extract<ClientMessageBody, { type: "terminal_attach" }>;
type TerminalDetach = Extract<ClientMessageBody, { type: "terminal_detach" }>;
type TerminalAck = Extract<ClientMessageBody, { type: "terminal_ack" }>;
type TerminalInput = Extract<ClientMessageBody, { type: "terminal_input" }>;
type TerminalResize = Extract<ClientMessageBody, { type: "terminal_resize" }>;
type TerminalTake = Extract<ClientMessageBody, { type: "terminal_take" }>;
type OutputFrame = Extract<AgentMessage, { type: "output" }>;
type SnapshotFrame = Extract<AgentMessage, { type: "snapshot" | "geometry_snapshot" }>;
type OwnerGeometryFrame = Extract<AgentMessage, { type: "terminal_geometry" }>;
/** The view-independent part of a delivery frame; each view stamps its own delivery fields. */
type Unstamped<T extends TerminalDeliveryFrame["type"]> = Omit<
  Extract<TerminalDeliveryFrame, { type: T }>,
  "viewportId" | "deliveryId" | "deliverySeq" | "skipped"
>;
type StreamFrame = Unstamped<"terminal_output"> | Unstamped<"terminal_geometry">;
type DeliveryStamp = Pick<TerminalDeliveryFrame, "viewportId" | "deliveryId" | "deliverySeq"> & {
  readonly skipped?: boolean;
};

const CREATE_DEADLINE_MS = 10_000;
const SNAPSHOT_DEADLINE_MS = 10_000;
const DRAIN_DEADLINE_MS = 10_000;

/** Online agent connection used by the broker without depending on Bun WebSocket types. */
export interface MachineChannel {
  readonly machineId: string;
  /**
   * The identity of the process that owns this connection's PTYs (`hello.terminalHostId`,
   * #278), or null for an agent that is its own owner. Null is also the CAPABILITY gate: an
   * agent that named no owner parses `drain` as a malformed frame, so it is never sent one.
   */
  readonly terminalHostId: string | null;
  readonly terminalExecution: TerminalExecution | null;
  readonly protocolVersion?: number;
  readonly terminalRestart?: boolean;
  readonly terminalGeometry?: boolean;
  send(message: ServerToAgentMessage): boolean;
}

/**
 * The owner's answer to one drain request, or why there is none. Every `ok: false` leaves the
 * hub's admission exactly as the caller set it: an owner that cannot answer is not a safe one,
 * and the caller cancels explicitly if it wants admission back.
 */
export type DrainOutcome =
  | { readonly ok: true; readonly status: MachineDrainStatus }
  | { readonly ok: false; readonly reason: string };

interface PendingDrain {
  machineId: string;
  draining: boolean;
  terminalHostId: string;
  resolve: (outcome: DrainOutcome) => void;
  cancelDeadline: (() => void) | null;
}

/**
 * One incarnation of a view's delivery, minted with its snapshot. `unacked` holds the charge of
 * every sent, unacknowledged frame in ordinal order, so entry 0 is ordinal
 * `nextSeq - unacked.length`; that bounded list is all a cumulative acknowledgement needs.
 */
interface Delivery {
  readonly id: string;
  nextSeq: number;
  readonly unacked: number[];
  unackedBytes: number;
  /** The last state this view was told; a snapshot itself announces `live`. */
  notice: Exclude<TerminalDeliveryState, "refused">;
}

/**
 * One attached view: `(channel, viewportId)`. Views of one terminal on one channel are
 * independent deliveries, so a parser that stalls one never holds back its sibling.
 *
 * PENDING awaits a snapshot generation and queues the post-request tail. LIVE sends its
 * ordered lane under completed-parse credit and holds the rest in `queue`. RECOVERING has
 * discarded that held output and waits for every frame already sent to complete before it
 * asks for a fresh snapshot, so a new snapshot can never be used to evade outstanding credit.
 */
interface Viewer {
  readonly viewportId: string;
  state: "PENDING" | "LIVE" | "RECOVERING";
  /** Ordered unsent frames, bounded by the pending window in charge units and frames. */
  queue: StreamFrame[];
  queuedBytes: number;
  cancelSnapshotDeadline: (() => void) | null;
  snapshotGeneration: number;
  /** Source watermarks already admitted to this view's lane, sent or held. */
  lastDeliveredSeq: number;
  lastDeliveredGeometryRevision: number;
  credential: CredentialReference;
  /** This view's desired-geometry lease; null while unmeasured or withdrawn. */
  viewport: { cols: number; rows: number; expiresAt: number } | null;
  /** Null until this attachment's first snapshot; a replaced incarnation is never credited. */
  delivery: Delivery | null;
  /** Held output was discarded since this view's last snapshot, which must say so. */
  skipped: boolean;
}

interface RuntimeTerminal {
  info: TerminalInfo;
  viewers: Map<SessionChannel, Map<string, Viewer>>;
  lastReceivedOutputSeq: number;
  /** -1 means the adopted or restarted owner's current revision has not been observed yet. */
  lastReceivedGeometryRevision: number;
  /** Desired admission is separate from the asynchronously applied owner grid. */
  lastRequestedGrid: Pick<TerminalGeometry, "cols" | "rows"> | null;
  snapshotGeneration: number;
  snapshotRequestOutstanding: boolean;
  sizing: TerminalSizing;
  viewportExpiryAt: number | null;
  cancelViewportExpiry: (() => void) | null;
  arbitratingViewports: boolean;
  viewportArbitrationPending: boolean;
}
type TerminalCreateOutcome =
  | { readonly ok: true; readonly terminal: TerminalInfo }
  | { readonly ok: false; readonly reason: string };

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
  cols: number | null;
  rows: number | null;
  opener: SessionChannel | null;
  resolve: (outcome: TerminalCreateOutcome) => void;
  auth: AuthContext;
  message: TerminalOpen;
  traceId?: number;
  agentPrincipalId: string | null;
  cancelDeadline: (() => void) | null;
  launchRecipe: TerminalLaunchRecipe | null;
  placementId: string | null;
  dispatched: boolean;
  sent: boolean;
  runId?: string;
  fence: ActionAuthorityFence;
  terminalHostId: string | null;
}

interface PendingRestart {
  machineId: string;
  principalId: string;
  agentPrincipalId: string | null;
  jobId: string | null;
  runLaunch: { bindingId: string; runId: string; token: string } | null;
  ordinary: boolean;
  dispatched: boolean;
  fence: ActionAuthorityFence;
  terminalHostId: string | null;
  resolve: (outcome: string) => void;
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
  private readonly pendingRestarts = new Map<string, PendingRestart>();
  /**
   * THE admission latch (#278), one per drained machine, mirrored from the `machines` row it
   * is persisted on. In memory so `open` can refuse without a read per gesture; loaded at
   * construction so a hub restart comes back with every drained machine still drained.
   */
  private readonly draining = new Set<string>();
  private readonly pendingDrains = new Map<string, PendingDrain>();
  /**
   * Each source delivery frame's validated JSON without view fields, kept only while some
   * view still holds the frame: N views cost N string splices, never N serializations.
   */
  private readonly deliveryBodies = new WeakMap<
    object,
    { readonly type: TerminalDeliveryFrame["type"]; readonly body: string; readonly bytes: number }
  >();
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
  private jobs: JobService | null = null;
  /** Secrets live only until native admission, expiry, or revocation, never in a descriptor. */
  private readonly runLaunches = new Map<
    string,
    {
      runId: string;
      digest: string;
      containerId: string | undefined;
      terminalId: string | undefined;
      creator: CredentialReference;
      token: string;
      expiresAt: number;
      cancelExpiry: () => void;
    }
  >();

  bindRunLaunch(
    runtime: TerminalRuntime,
    run: { readonly id: string; readonly expiresAt: number },
    token: string,
    actor: AuthContext,
    containerId?: string,
    terminalId?: string,
  ): TerminalRuntime {
    const bound = { ...runtime, launchBinding: this.runtime.newId() };
    const expiresAt = Math.min(run.expiresAt, this.runtime.now() + 60_000);
    if (!this.auth.runLaunchCredentialValid(run.id, token) || expiresAt <= this.runtime.now())
      throw new ServiceError("forbidden", "run launch credential unavailable");
    const creator = this.auth.credentialReference(actor);
    if (!this.auth.restoreCredential(creator))
      throw new ServiceError("forbidden", "run launch creator unavailable");
    const cancelExpiry = this.timers.schedule(
      () => this.runLaunches.delete(bound.launchBinding),
      expiresAt - this.runtime.now(),
    );
    this.runLaunches.set(bound.launchBinding, {
      runId: run.id,
      digest: createHash("sha256").update(canonicalJobJson(bound)).digest("hex"),
      containerId,
      terminalId,
      creator,
      token,
      expiresAt,
      cancelExpiry,
    });
    return bound;
  }

  clearRunLaunches(): void {
    for (const binding of this.runLaunches.values()) binding.cancelExpiry();
    this.runLaunches.clear();
  }

  private boundRunLaunch(
    runtime: TerminalRuntime,
    actor: AuthContext,
    containerId: string,
    terminalId?: string,
  ) {
    if (runtime.launchBinding === undefined) return undefined;
    const binding = this.runLaunches.get(runtime.launchBinding);
    if (
      !binding ||
      binding.creator.tokenId !== actor.tokenId ||
      binding.creator.principalId !== actor.principal.id ||
      (binding.containerId !== undefined && binding.containerId !== containerId) ||
      binding.terminalId !== terminalId ||
      binding.digest !== createHash("sha256").update(canonicalJobJson(runtime)).digest("hex")
    )
      throw new ServiceError("forbidden", "run launch binding refused");
    return binding;
  }

  private consumeRunLaunch(
    runtime: TerminalRuntime,
    actor: AuthContext,
    containerId: string,
    terminalId?: string,
  ) {
    const binding = this.boundRunLaunch(runtime, actor, containerId, terminalId);
    if (binding === undefined) return undefined;
    this.runLaunches.delete(runtime.launchBinding!);
    binding.cancelExpiry();
    if (
      binding.expiresAt <= this.runtime.now() ||
      !this.auth.restoreCredential(binding.creator) ||
      !this.auth.runLaunchCredentialValid(binding.runId, binding.token)
    )
      throw new ServiceError("forbidden", "run launch binding expired or revoked");
    return {
      MANIFOLD_RUN_TOKEN: binding.token,
      MANIFOLD_RUN_ID: binding.runId,
      MANIFOLD_ORIGIN: this.publicUrl(),
    };
  }

  private retireRestartRunLaunch(pending: PendingRestart): void {
    const launch = pending.runLaunch;
    if (launch === null) return;
    pending.runLaunch = null;
    const binding = this.runLaunches.get(launch.bindingId);
    if (binding?.token === launch.token) {
      binding.cancelExpiry();
      this.runLaunches.delete(launch.bindingId);
    }
    this.auth.revokeRunLaunchCredential(launch.runId, launch.token, pending.principalId);
  }

  setJobs(jobs: JobService): void {
    this.jobs = jobs;
  }

  private killPendingOpen(pending: PendingOpen): void {
    const machine = this.machines.get(pending.machineId);
    if (pending.sent && machine?.terminalHostId === pending.terminalHostId)
      machine.send({ type: "kill", terminalId: pending.terminalId });
  }

  private abandonOpen(pending: PendingOpen): void {
    pending.fence.close();
    if (pending.agentPrincipalId !== null)
      this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.createdBy);
    this.jobs?.cancelTerminal(pending.terminalId);
    if (pending.placementId !== null)
      this.rooms.get(pending.homeId)?.removeTileLeafById(pending.placementId);
  }

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
    this.auth.onRevoked(() => {
      for (const [id, binding] of this.runLaunches) {
        if (
          this.auth.restoreCredential(binding.creator) &&
          this.auth.runLaunchCredentialValid(binding.runId, binding.token)
        )
          continue;
        binding.cancelExpiry();
        this.runLaunches.delete(id);
      }
      for (const terminal of this.terminals.values()) this.arbitrateViewports(terminal);
    });
    this.auth.onAuthorityChanged(() => {
      for (const terminal of this.terminals.values()) this.arbitrateViewports(terminal);
    });
    for (const machine of store.listMachines()) {
      if (machine.draining) this.draining.add(machine.id);
    }
    for (const row of store.listTerminals()) {
      const info: TerminalInfo = {
        id: row.id,
        containerId: row.containerId,
        name: row.name,
        machineId: row.machineId,
        status: row.status,
        exitCode: row.exitCode,
        exitReason: row.exitReason,
        readiness: null,
        cols: 80,
        rows: 24,
        controllerId: row.status === "running" ? row.createdBy : null,
        createdBy: row.createdBy,
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.session === undefined ? {} : { session: row.session }),
      };
      this.terminals.set(row.id, {
        info,
        viewers: new Map(),
        lastReceivedOutputSeq: 0,
        lastReceivedGeometryRevision: -1,
        lastRequestedGrid: null,
        snapshotGeneration: 0,
        snapshotRequestOutstanding: false,
        sizing: { mode: "retained", columns: [], rows: [] },
        viewportExpiryAt: null,
        cancelViewportExpiry: null,
        arbitratingViewports: false,
        viewportArbitrationPending: false,
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
   *
   * An owner that named itself is told the hub's admission state on every hello (#278), true
   * or false, so its own latch converges to the persisted one: a drain that outlived a
   * transport restart is re-latched, and a cancel issued while the machine was offline reaches
   * it the moment it is back. A drain request in flight on the superseded socket cannot be
   * trusted to be answered on this one, so it fails closed here rather than waiting out its
   * deadline.
   */
  setMachineOnline(channel: MachineChannel): void {
    const wasOnline = this.machines.has(channel.machineId);
    this.machines.set(channel.machineId, channel);
    if (wasOnline) this.failPendingDrains(channel.machineId, "machine reconnected mid-drain");
    if (wasOnline) this.failPendingRestarts(channel.machineId, "machine_reconnected");
    if (channel.terminalHostId !== null) {
      channel.send({
        type: "drain",
        requestId: this.runtime.newId(),
        draining: this.draining.has(channel.machineId),
      });
    }
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
    this.failPendingDrains(channel.machineId, "machine disconnected mid-drain");
    this.failPendingRestarts(channel.machineId, "machine_offline");
    for (const [terminalId, pending] of this.pendingOpens) {
      if (pending.machineId !== channel.machineId) continue;
      pending.cancelDeadline?.();
      this.answerOpen(
        pending.opener,
        pending.resolve,
        "no_machine",
        "machine disconnected while opening terminal",
        pending.ref,
      );
      this.abandonOpen(pending);
      this.pendingOpens.delete(terminalId);
      this.rooms.evictIfIdle(pending.containerId);
    }
    for (const terminal of this.terminals.values()) {
      if (terminal.info.machineId !== channel.machineId || terminal.info.status !== "running") {
        continue;
      }
      terminal.snapshotRequestOutstanding = false;
      terminal.lastRequestedGrid = null;
      // Every attached view belongs to its room, including a cold PENDING view.
      // Adoption will heal both with a fresh snapshot; an offline owner has no
      // snapshot deadline, and transport withdrawal must not erase attachment.
      this.clearViewportIntents(terminal);
      for (const [, viewer] of this.viewersOf(terminal)) {
        viewer.cancelSnapshotDeadline?.();
        viewer.cancelSnapshotDeadline = null;
      }
      this.arbitrateViewports(terminal);
    }
  }

  /** Reports whether the persisted machine currently has an authenticated socket. */
  isMachineOnline(machineId: string): boolean {
    return this.machines.has(machineId);
  }

  /** Whether `core.machines.drain` has closed this machine's terminal admission. */
  isMachineDraining(machineId: string): boolean {
    return this.draining.has(machineId);
  }

  /**
   * THE ADMISSION CONTRACT (#278): closes or reopens new-terminal admission on a machine and
   * asks the machine's PTY owner to do the same and say what it holds.
   *
   * ORDER IS THE WHOLE GUARANTEE. The latch is persisted and mirrored FIRST, so from this
   * statement on no `open` reaches this machine — a hub restart before the owner answers
   * comes back drained, not open. Only then is the owner asked, on the same ordered socket
   * every `create` before it travelled on: its `drain_status` is therefore behind every
   * create the hub had sent, and the ids it reports are the complete set a replacement would
   * destroy, in-flight creates included. Nothing a viewer does between the latch and the
   * answer can add to that set.
   *
   * Every way the owner CANNOT answer — offline, an agent that named no owner and so cannot
   * be asked, a dropped frame, a deadline, a reply naming a different owner or the wrong
   * state — is `ok: false`, and leaves the latch where the caller put it. Unknown is not safe;
   * a caller that wanted admission back says so with `draining: false`, which is the ONLY
   * thing that reopens it. A cancel that finds no owner to tell still reopens the hub's half,
   * and the owner's half converges at its next hello (`setMachineOnline`).
   */
  drain(machineId: string, draining: boolean): Promise<DrainOutcome> {
    const changed = this.draining.has(machineId) !== draining;
    this.store.setMachineDraining(machineId, draining);
    if (draining) this.draining.add(machineId);
    else this.draining.delete(machineId);
    if (changed) {
      this.events?.emitCollection("machines", "machine_inventory_changed", null, {
        machineId,
        draining,
      });
    }
    // A request still waiting is now answering a question the caller has since changed.
    this.failPendingDrains(machineId, "superseded by a later drain request");
    const machine = this.machines.get(machineId);
    if (machine === undefined) {
      return Promise.resolve({
        ok: false,
        reason: "machine is offline: its terminals are unknown",
      });
    }
    if (machine.terminalHostId === null) {
      return Promise.resolve({
        ok: false,
        reason: "machine agent names no terminal owner: it cannot be drained",
      });
    }
    const terminalHostId = machine.terminalHostId;
    const requestId = this.runtime.newId();
    return new Promise<DrainOutcome>((resolve) => {
      const pending: PendingDrain = {
        machineId,
        draining,
        terminalHostId,
        resolve,
        cancelDeadline: null,
      };
      this.pendingDrains.set(requestId, pending);
      if (!machine.send({ type: "drain", requestId, draining })) {
        this.pendingDrains.delete(requestId);
        resolve({ ok: false, reason: "machine connection unavailable" });
        return;
      }
      pending.cancelDeadline = this.timers.schedule(() => {
        pending.cancelDeadline = null;
        if (this.pendingDrains.get(requestId) !== pending) return;
        this.pendingDrains.delete(requestId);
        this.logger.warn("machine_drain_timeout", { machineId, draining });
        resolve({ ok: false, reason: "terminal owner did not acknowledge in time" });
      }, DRAIN_DEADLINE_MS);
    });
  }

  /**
   * The owner's answer. Matched by request id AND by the machine it arrived from, then held to
   * the identity and state the request was made against: a reply from a different owner, or
   * one that did not apply the state it was asked for, is a failed drain rather than a
   * report, because the number it carries would describe a process nobody is about to replace.
   */
  onDrainStatus(machineId: string, status: Extract<AgentMessage, { type: "drain_status" }>): void {
    const pending = this.pendingDrains.get(status.requestId);
    if (pending === undefined || pending.machineId !== machineId) {
      // The hello-time sync (`setMachineOnline`) is answered here too; it has no waiter.
      this.logger.info("machine_drain_status", {
        machineId,
        terminalHostId: status.terminalHostId,
        draining: status.draining,
        terminals: status.terminalIds.length,
      });
      return;
    }
    this.pendingDrains.delete(status.requestId);
    pending.cancelDeadline?.();
    if (status.terminalHostId !== pending.terminalHostId) {
      pending.resolve({
        ok: false,
        reason: "terminal owner identity changed while draining",
      });
      return;
    }
    if (status.draining !== pending.draining) {
      pending.resolve({ ok: false, reason: "terminal owner did not apply the requested state" });
      return;
    }
    pending.resolve({
      ok: true,
      status: {
        terminalHostId: status.terminalHostId,
        draining: status.draining,
        terminalIds: status.terminalIds,
      },
    });
  }

  private failPendingDrains(machineId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingDrains) {
      if (pending.machineId !== machineId) continue;
      pending.cancelDeadline?.();
      this.pendingDrains.delete(requestId);
      pending.resolve({ ok: false, reason });
    }
  }

  /** Whether an agent create is still in flight for this container. */
  hasPendingOpenForContainer(containerId: string): boolean {
    for (const pending of this.pendingOpens.values()) {
      if (pending.containerId === containerId) return true;
    }
    return false;
  }

  private viewportAuthority(
    channel: SessionChannel,
    homeId: string,
    credential: CredentialReference,
  ): boolean {
    if (channel.isClosed || channel.spectator || channel.containerId !== homeId) return false;
    const current = this.auth.restoreCredential(credential);
    return current !== null && this.auth.allows(current, "terminals:write", homeId);
  }

  /** Every attached view of a terminal with its channel; removal while iterating is safe. */
  private *viewersOf(terminal: RuntimeTerminal): Generator<[SessionChannel, Viewer]> {
    for (const [channel, views] of terminal.viewers) {
      for (const viewer of views.values()) yield [channel, viewer];
    }
  }

  private isCurrentViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
  ): boolean {
    return terminal.viewers.get(channel)?.get(viewer.viewportId) === viewer;
  }

  /** Retire stale authority as well as expired measurements before deriving a shared grid. */
  private pruneViewports(terminal: RuntimeTerminal): { count: number; expiresAt: number | null } {
    const now = this.runtime.now();
    let count = 0;
    let expiresAt: number | null = null;
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      const viewport = viewer.viewport;
      if (viewport === null) continue;
      if (
        terminal.info.status !== "running" ||
        terminal.info.controllerId !== channel.auth.principal.id ||
        !this.viewportAuthority(channel, terminal.info.containerId, viewer.credential) ||
        viewport.expiresAt <= now
      ) {
        viewer.viewport = null;
        continue;
      }
      count += 1;
      expiresAt = expiresAt === null ? viewport.expiresAt : Math.min(expiresAt, viewport.expiresAt);
    }
    return { count, expiresAt };
  }

  private arbitrateViewports(terminal: RuntimeTerminal, requester?: SessionChannel): void {
    // Reliable sends can synchronously close a room channel and retire its measurements.
    if (terminal.arbitratingViewports) {
      terminal.viewportArbitrationPending = true;
      return;
    }
    terminal.arbitratingViewports = true;
    try {
      do {
        terminal.viewportArbitrationPending = false;
        this.applyViewportArbitration(terminal, requester);
      } while (terminal.viewportArbitrationPending);
    } finally {
      terminal.arbitratingViewports = false;
    }
  }

  private applyViewportArbitration(terminal: RuntimeTerminal, requester?: SessionChannel): void {
    const { expiresAt } = this.pruneViewports(terminal);
    if (terminal.viewportExpiryAt !== expiresAt) {
      terminal.cancelViewportExpiry?.();
      terminal.cancelViewportExpiry = null;
      terminal.viewportExpiryAt = expiresAt;
      if (expiresAt !== null) {
        terminal.cancelViewportExpiry = this.timers.schedule(() => {
          terminal.cancelViewportExpiry = null;
          terminal.viewportExpiryAt = null;
          if (this.terminals.get(terminal.info.id) === terminal) this.arbitrateViewports(terminal);
        }, expiresAt - this.runtime.now());
      }
    }
    let cols: number | null = null;
    let rows: number | null = null;
    const columns: TerminalSizing["columns"] = [];
    const rowLimiters: TerminalSizing["rows"] = [];
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      // A view contributes once it painted a snapshot of this attachment. Parser lag does not
      // withdraw it: a delayed view's box is still the box it shows.
      const viewport = viewer.viewport;
      if (viewer.delivery === null || viewport === null) continue;
      const viewportId = viewer.viewportId;
      if (cols === null || viewport.cols < cols) {
        cols = viewport.cols;
        columns.length = 0;
      }
      if (viewport.cols === cols) columns.push({ connId: channel.id, viewportId });
      if (rows === null || viewport.rows < rows) {
        rows = viewport.rows;
        rowLimiters.length = 0;
      }
      if (viewport.rows === rows) rowLimiters.push({ connId: channel.id, viewportId });
    }
    const requestedGrid = terminal.lastRequestedGrid ?? terminal.info;
    if (
      cols !== null &&
      rows !== null &&
      (cols !== requestedGrid.cols || rows !== requestedGrid.rows)
    ) {
      const machine = this.machines.get(terminal.info.machineId);
      if (machine?.send({ type: "resize", terminalId: terminal.info.id, cols, rows })) {
        terminal.lastRequestedGrid = { cols, rows };
        if (!this.supportsTerminalGeometry(machine)) {
          this.publishGeometryState(terminal, cols, rows);
          // Retained owners have no source-relative resize ordering to offer a cold view.
          this.relayStreamFrame(
            terminal,
            {
              type: "terminal_geometry",
              terminalId: terminal.info.id,
              seq: terminal.lastReceivedOutputSeq,
              geometry: { cols, rows, revision: null },
            },
            false,
          );
        }
      } else {
        // The owner admitted no new grid. Retire participation before the reliable refusal
        // can re-enter through viewer cleanup, then derive retained attribution.
        this.clearViewportIntents(terminal);
        terminal.viewportArbitrationPending = true;
        requester?.send({ type: "error", code: "no_machine", ref: terminal.info.id });
      }
    }
    if (terminal.viewportArbitrationPending) return;
    const sizing: TerminalSizing = {
      mode: cols === null ? "retained" : "smallest",
      columns,
      rows: rowLimiters,
    };
    const sameReferences = (left: TerminalSizing["columns"], right: TerminalSizing["columns"]) => {
      if (left.length !== right.length) return false;
      return left.every(
        (ref, index) =>
          ref.connId === right[index]?.connId && ref.viewportId === right[index]?.viewportId,
      );
    };
    if (
      terminal.sizing.mode === sizing.mode &&
      sameReferences(terminal.sizing.columns, sizing.columns) &&
      sameReferences(terminal.sizing.rows, sizing.rows)
    )
      return;
    terminal.sizing = sizing;
    this.rooms.live(terminal.info.containerId)?.broadcast({
      type: "terminal_sizing",
      terminalId: terminal.info.id,
      sizing,
    });
  }

  /** Retires exactly one view, fencing its incarnation and any credit it still held. */
  private removeViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    arbitrate = true,
  ): void {
    const views = terminal.viewers.get(channel);
    if (views?.get(viewer.viewportId) !== viewer) return;
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = null;
    viewer.viewport = null;
    viewer.queue = [];
    viewer.queuedBytes = 0;
    views.delete(viewer.viewportId);
    if (views.size === 0) terminal.viewers.delete(channel);
    if (arbitrate) this.arbitrateViewports(terminal);
  }

  private clearViewportIntents(terminal: RuntimeTerminal): void {
    terminal.cancelViewportExpiry?.();
    terminal.cancelViewportExpiry = null;
    terminal.viewportExpiryAt = null;
    for (const [, viewer] of this.viewersOf(terminal)) viewer.viewport = null;
  }

  private clearViewers(terminal: RuntimeTerminal): void {
    this.clearViewportIntents(terminal);
    for (const [, viewer] of this.viewersOf(terminal)) viewer.cancelSnapshotDeadline?.();
    terminal.viewers.clear();
  }

  /**
   * The scoped half of every refusal that retires or refuses a view: its own `refused` notice,
   * so a reader learns which view stopped and why without matching any error wording.
   */
  private sendRefusal(
    channel: SessionChannel,
    terminalId: string,
    viewportId: string,
    deliveryId: string | null,
    skipped: boolean,
    reason: TerminalDeliveryRefusal,
  ): void {
    channel.send({
      type: "terminal_delivery",
      terminalId,
      viewportId,
      deliveryId,
      state: "refused",
      skipped,
      reason,
    });
  }

  /** Refuses one attached view: its scoped notice, its retirement, then the generic error. */
  private failViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    reason: TerminalDeliveryRefusal,
    code: "conflict" | "no_machine",
    message: string,
    arbitrate = true,
  ): void {
    if (!this.isCurrentViewer(terminal, channel, viewer)) return;
    this.sendRefusal(
      channel,
      terminal.info.id,
      viewer.viewportId,
      viewer.delivery?.id ?? null,
      viewer.skipped,
      reason,
    );
    this.removeViewer(terminal, channel, viewer, arbitrate);
    channel.send({ type: "error", code, message, ref: terminal.info.id });
  }

  private armSnapshotDeadline(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
  ): void {
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = null;
    if (!this.machines.has(terminal.info.machineId)) return;
    viewer.cancelSnapshotDeadline = this.timers.schedule(() => {
      viewer.cancelSnapshotDeadline = null;
      if (!this.isCurrentViewer(terminal, channel, viewer) || viewer.state !== "PENDING") return;
      const requestTimedOut = terminal.snapshotRequestOutstanding;
      if (requestTimedOut) terminal.snapshotRequestOutstanding = false;
      this.failViewer(
        terminal,
        channel,
        viewer,
        "snapshot_timeout",
        "conflict",
        "terminal snapshot timed out",
      );
      this.logger.warn("terminal_snapshot_timeout", {
        terminalId: terminal.info.id,
        machineId: terminal.info.machineId,
      });
      if (requestTimedOut) this.requestSnapshotForPending(terminal);
    }, SNAPSHOT_DEADLINE_MS);
  }

  /** Joins the next snapshot generation under the one finite snapshot deadline. */
  private awaitSnapshot(terminal: RuntimeTerminal, channel: SessionChannel, viewer: Viewer): void {
    viewer.state = "PENDING";
    viewer.snapshotGeneration = terminal.snapshotGeneration + 1;
    this.armSnapshotDeadline(terminal, channel, viewer);
  }

  /**
   * Supersedes a view's incarnation with a fresh authoritative snapshot, but never ahead of
   * its parser: while any frame already sent is unacknowledged the view is RECOVERING, and
   * only the last completion asks for the snapshot. Held output is discarded rather than fed
   * to a parser after a gap; `skipped` records that it was. The caller requests the snapshot.
   * Returns whether the view is still attached.
   */
  private recoverViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    skipped: boolean,
  ): boolean {
    viewer.skipped ||= skipped || viewer.queue.some((frame) => frame.type === "terminal_output");
    viewer.queue = [];
    viewer.queuedBytes = 0;
    viewer.lastDeliveredSeq = 0;
    viewer.lastDeliveredGeometryRevision = -1;
    const delivery = viewer.delivery;
    if (delivery === null || delivery.unacked.length === 0) {
      this.awaitSnapshot(terminal, channel, viewer);
      return true;
    }
    viewer.state = "RECOVERING";
    viewer.cancelSnapshotDeadline?.();
    viewer.cancelSnapshotDeadline = null;
    return (
      delivery.notice === "recovering" ||
      this.announceDelivery(terminal, channel, viewer, delivery, "recovering")
    );
  }

  /** One state transition, sent once; returns whether the view is still attached. */
  private announceDelivery(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    delivery: Delivery,
    state: Exclude<TerminalDeliveryState, "refused">,
  ): boolean {
    delivery.notice = state;
    if (
      !channel.send({
        type: "terminal_delivery",
        terminalId: terminal.info.id,
        viewportId: viewer.viewportId,
        deliveryId: delivery.id,
        state,
        skipped: state === "recovering" && viewer.skipped,
        reason: null,
      })
    ) {
      this.removeViewer(terminal, channel, viewer, false);
      return false;
    }
    return this.isCurrentViewer(terminal, channel, viewer);
  }

  /** Sends at most one snapshot request and binds its generation to current PENDING viewers. */
  private requestSnapshotForPending(terminal: RuntimeTerminal): void {
    if (terminal.snapshotRequestOutstanding || terminal.info.status !== "running") return;
    let hasPending = false;
    for (const [, viewer] of this.viewersOf(terminal)) {
      if (viewer.state === "PENDING") {
        hasPending = true;
        break;
      }
    }
    if (!hasPending) return;

    const machine = this.machines.get(terminal.info.machineId);
    if (machine === undefined) return;

    terminal.snapshotGeneration += 1;
    const generation = terminal.snapshotGeneration;
    for (const [, viewer] of this.viewersOf(terminal)) {
      if (viewer.state === "PENDING") viewer.snapshotGeneration = generation;
    }
    terminal.snapshotRequestOutstanding = true;
    if (
      machine.send({
        type: this.supportsTerminalGeometry(machine)
          ? "geometry_snapshot_request"
          : "snapshot_request",
        terminalId: terminal.info.id,
      })
    )
      return;

    terminal.snapshotRequestOutstanding = false;
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      if (viewer.state === "PENDING" && viewer.snapshotGeneration === generation) {
        this.failViewer(
          terminal,
          channel,
          viewer,
          "owner_unavailable",
          "no_machine",
          "terminal machine is unavailable",
        );
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
        exitReason: stored.exitReason,
        readiness: null,
        cols: 80,
        rows: 24,
        controllerId: stored.status === "running" ? stored.createdBy : null,
        createdBy: stored.createdBy,
        ...(stored.cwd === undefined ? {} : { cwd: stored.cwd }),
        ...(stored.session === undefined ? {} : { session: stored.session }),
      };
      terminal = {
        info,
        viewers: new Map(),
        lastReceivedOutputSeq: 0,
        lastReceivedGeometryRevision: -1,
        lastRequestedGrid: null,
        snapshotGeneration: 0,
        snapshotRequestOutstanding: false,
        sizing: { mode: "retained", columns: [], rows: [] },
        arbitratingViewports: false,
        viewportArbitrationPending: false,
        viewportExpiryAt: null,
        cancelViewportExpiry: null,
      };
      this.terminals.set(stored.id, terminal);
    }
    if (advertised.cwd !== undefined) this.onCwd(machineId, stored.id, advertised.cwd);
    if (!advertised.alive) {
      if (terminal.info.status === "running") {
        this.onExited(machineId, advertised.terminalId, advertised.exitCode ?? null);
      }
      return false;
    }
    if (stored.status !== "running") return false;
    this.clearViewportIntents(terminal);
    terminal.info = {
      ...terminal.info,
      status: "running",
      exitCode: null,
      exitReason: null,
      readiness: advertised.readiness ?? null,
      cols: advertised.cols,
      rows: advertised.rows,
    };
    terminal.lastReceivedOutputSeq = advertised.seq;
    terminal.lastReceivedGeometryRevision = -1;
    terminal.lastRequestedGrid = null;
    terminal.snapshotRequestOutstanding = false;
    const adoptedContainerId = terminal.info.containerId;
    if (adoptedContainerId !== null) {
      this.rooms.live(adoptedContainerId)?.broadcast({
        type: "terminal_event",
        terminalId: terminal.info.id,
        kind: "controller_changed",
        controllerId: terminal.info.controllerId,
      });
      if (advertised.readiness !== undefined) {
        this.rooms.live(adoptedContainerId)?.broadcast({
          type: "terminal_event",
          terminalId: terminal.info.id,
          kind: "ready",
          readiness: advertised.readiness,
        });
      }
    }
    // The adopted owner re-anchors every view, but only after work already sent completes.
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      this.recoverViewer(terminal, channel, viewer, false);
    }
    this.requestSnapshotForPending(terminal);
    this.arbitrateViewports(terminal);
    return true;
  }

  /**
   * Reconciles the complete hello inventory: missing durable PTYs are exited, while
   * unadoptable agent PTYs are explicitly killed instead of becoming unmanaged orphans.
   *
   * Both inferences are DESTRUCTIVE, and both are safe here for one reason only: the gateway
   * admits a hello exclusively from the machine's OWNER OF RECORD (`decideAdmission`, #278),
   * so absence is the owner saying a PTY is gone and an unknown PTY is the owner's own,
   * outliving a row a kill already deleted. A claimant that cannot prove that is refused
   * before this method runs; it never gets to say anything about the machine's terminals.
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
      if (!advertisedIds.has(stored.id)) this.onMissing(machineId, stored.id);
    }
  }

  /**
   * A newly admitted replacement owner proves the old seat's processes are unavailable. Its
   * predecessor's terminals are retained as exited with `owner_lost`: the hub, not any owner,
   * is the only party that can know why they ended.
   */
  onOwnerLost(machineId: string): void {
    for (const stored of this.store.listRunningTerminalsForMachine(machineId))
      this.retainExited(machineId, stored.id, null, "owner_lost");
  }

  private selectMachine(requested: string | undefined): MachineChannel | null {
    if (requested !== undefined) return this.machines.get(requested) ?? null;
    if (this.machines.size !== 1) return null;
    return this.machines.values().next().value ?? null;
  }

  /** Pure resolution, once, before authorization. An explicit endpoint is never replaced. */
  resolveTerminalMachine(
    machineId?: string,
    runtimeMachineId?: string,
  ): Pick<MachineChannel, "machineId" | "terminalHostId" | "terminalExecution"> {
    if (machineId !== undefined && runtimeMachineId !== undefined && machineId !== runtimeMachineId)
      throw new ServiceError("conflict", "terminal_runtime_destination_changed");
    const exact = machineId ?? runtimeMachineId;
    const machine = this.selectMachine(exact);
    if (machine === null)
      throw new ServiceError(
        "not_found",
        exact === undefined ? "no unambiguous online machine" : "machine_offline",
      );
    const enrolled = this.store.getMachine(machine.machineId);
    if (enrolled === null || this.store.revokedMachineIds().has(machine.machineId))
      throw new ServiceError("forbidden", "machine_unavailable");
    if (this.draining.has(machine.machineId))
      throw new ServiceError("conflict", "machine_draining");
    return {
      machineId: machine.machineId,
      terminalHostId: machine.terminalHostId,
      terminalExecution: machine.terminalExecution,
    };
  }

  /** Retained-owner continuity survives a transport disconnect or same-owner replacement. */
  terminalOwnerBindingCurrent(binding: TerminalOwnerBinding): boolean {
    const enrolled = this.store.getMachine(binding.machineId);
    if (enrolled === null || this.store.revokedMachineIds().has(binding.machineId)) return false;
    const machine = this.machines.get(binding.machineId);
    return (
      (machine === undefined ? enrolled.ownerHostId : machine.terminalHostId) ===
      binding.terminalHostId
    );
  }

  terminalPlacement(containerId: string): "element" | "tile" {
    const container = this.store.getContainer(containerId);
    if (container === null) throw new ServiceError("not_found", "terminal placement unavailable");
    return this.holdsTileTree(container.discipline) ? "tile" : "element";
  }

  /** ActionCtx lends this dispatch's private authority only to broker birth effects. */
  withAuthorityFence(fence: ActionAuthorityFence): TerminalBroker {
    return new Proxy(this, {
      get: (broker, key) => {
        if (key === "create")
          return (
            credential: CredentialReference,
            containerId: string,
            message: TerminalOpen,
            traceId?: number,
          ) => {
            requireActionEffects();
            return broker.create(credential, containerId, message, traceId, fence);
          };
        if (key === "restartById")
          return (
            terminalId: string,
            principalId: string,
            credential?: CredentialReference,
            traceId?: number,
            launchRun?: Parameters<TerminalBroker["restartById"]>[4],
          ) => {
            requireActionEffects();
            return broker.restartById(
              terminalId,
              principalId,
              credential,
              traceId,
              launchRun,
              fence,
            );
          };
        const value: unknown = Reflect.get(broker, key);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              // The published terminal context includes this pure lifecycle-state read.
              if (key !== "liveTerminal") requireActionEffects();
              return Reflect.apply(value, broker, args);
            }
          : value;
      },
    });
  }
  private answerOpen(
    opener: SessionChannel | null,
    resolve: (outcome: TerminalCreateOutcome) => void,
    code: ErrorCode,
    message: string,
    ref: string,
  ): void {
    opener?.send({ type: "error", code, message, ref });
    resolve({ ok: false, reason: message });
  }

  /**
   * Starts a PTY create request after the caller has passed `core.terminals.open` or
   * `core.terminals.create`. Policy remains in the plugin; this is the one mechanism for
   * placement, machine selection, acknowledgement, durable commit and compensation.
   */
  open(
    channel: SessionChannel,
    message: TerminalOpen,
    traceId?: number,
    fence?: ActionAuthorityFence,
  ): void {
    this.beginOpen(channel.auth, channel.containerId, channel, message, () => {}, traceId, fence);
  }

  /**
   * The HTTP action's broker boundary. It has no session channel to own a reply, so the
   * completion resolves only after the machine acknowledgement and durable terminal commit.
   * A stale credential is refused before any id, token, job or machine request is created.
   */
  create(
    credential: CredentialReference,
    containerId: string,
    message: TerminalOpen,
    traceId?: number,
    fence?: ActionAuthorityFence,
  ): Promise<TerminalCreateOutcome> {
    const auth = this.auth.restoreCredential(credential);
    if (auth === null)
      return Promise.resolve({ ok: false, reason: "credential expired or revoked" });
    const completion = Promise.withResolvers<TerminalCreateOutcome>();
    this.beginOpen(auth, containerId, null, message, completion.resolve, traceId, fence);
    return completion.promise;
  }

  private beginOpen(
    auth: AuthContext,
    containerId: string,
    opener: SessionChannel | null,
    message: TerminalOpen,
    resolve: (outcome: TerminalCreateOutcome) => void,
    traceId?: number,
    admittedFence?: ActionAuthorityFence,
  ): void {
    const refuse = (code: ErrorCode, reason: string): void =>
      this.answerOpen(opener, resolve, code, reason, message.elementId);
    if (
      message.runtime &&
      (message.program !== undefined || message.env !== undefined || message.cwd !== undefined)
    ) {
      refuse("forbidden", "runtime excludes program, cwd and environment overrides");
      return;
    }
    /*
      Discipline decides who authors the placement, and it decides it from its DECLARATION
      (#125): a container that holds a tile tree is placed into server-side by naming a leaf,
      any other container by the opener authoring an element. A mismatch is refused rather
      than spawning a PTY nothing would ever render.
    */
    const container = this.store.getContainer(containerId);
    const placement = message.placement ?? "element";
    const tileTree = container !== null && this.holdsTileTree(container.discipline);
    if (tileTree !== (placement === "tile")) {
      refuse(
        "conflict",
        placement === "tile"
          ? 'placement "tile" requires a container that holds a tile tree'
          : 'this container places terminals server-side: send placement "tile"',
      );
      return;
    }
    const hasCols = message.cols !== undefined;
    const hasRows = message.rows !== undefined;
    if (hasCols !== hasRows) {
      refuse("forbidden", "cols and rows must be supplied together");
      return;
    }
    if (placement === "element" && !hasCols) {
      refuse("forbidden", "element placement requires cols and rows");
      return;
    }
    let machine: MachineChannel;
    try {
      const resolved = this.resolveTerminalMachine(message.machineId, message.runtime?.machineId);
      machine = this.machines.get(resolved.machineId)!;
      message = { ...message, machineId: resolved.machineId };
    } catch (error) {
      refuse("no_machine", error instanceof Error ? error.message : "machine unavailable");
      admittedFence?.close();
      return;
    }
    if (this.draining.has(machine.machineId)) {
      refuse(
        "conflict",
        "machine is draining: new terminals are refused until the drain is cancelled",
      );
      return;
    }
    if (!message.runtime && machine.terminalExecution !== "unconfined") {
      refuse(
        machine.terminalExecution === "governed" ? "forbidden" : "unsupported",
        machine.terminalExecution === "governed"
          ? "machine requires a declared terminal runtime"
          : "terminal owner has not declared unconfined terminal support",
      );
      return;
    }

    let fence: ActionAuthorityFence;
    try {
      if (admittedFence !== undefined) {
        fence = admittedFence.retain();
      } else {
        // Legacy internal callers still pass the same live resource requirements.
        fence = new ActionAuthorityFence(this.auth, auth, () => true, containerId);
        const requirements: ActionAuthorityRequirement[] = [
          {
            cap: "terminals:spawn",
            node: formatManifoldUri({ kind: "container", containerId }),
            reach: "node",
          },
          ...(message.runtime
            ? []
            : [
                {
                  cap: "machines:shell" as const,
                  node: formatManifoldUri({ kind: "machine", machineId: machine.machineId }),
                  reach: "node" as const,
                },
              ]),
        ];
        if (placement === "element")
          for (const cap of [
            "containers:write",
            "containers:read",
            "scenes:write",
            "terminals:spawn",
            "terminals:write",
          ] as const)
            requirements.push({ cap, node: MANIFOLD_ROOT_URI, reach: "subtree" });
        fence.admit(requirements);
      }
      fence.guard(() => {
        if (this.store.revokedMachineIds().has(machine.machineId))
          throw new ServiceError("forbidden", "terminal destination unavailable");
      });
      fence.guard(() => {
        if (
          this.machines.get(machine.machineId) !== machine ||
          this.draining.has(machine.machineId)
        )
          throw new ServiceError("forbidden", "terminal destination unavailable");
        if (this.terminalPlacement(containerId) !== placement)
          throw new ServiceError("conflict", "terminal placement changed");
      }, "admission");
      fence.checkCurrent();
    } catch (error) {
      refuse(
        "forbidden",
        placement === "element"
          ? "Independent terminal homes require workspace-subtree working authority. Open the approved composition instead."
          : error instanceof Error
            ? error.message
            : "terminal authority unavailable",
      );
      return;
    }
    const terminalId = this.runtime.newId();
    /*
      The home is decided before the PTY exists because both its credential and
      `MANIFOLD_CONTAINER` must name the composition it lives in from the first byte.
      A tiled home also receives its leaf now: that is the measurable object whose first
      real viewer supplies the dimensions required to create the PTY.
    */
    const homeId = placement === "tile" ? containerId : this.runtime.newId();
    try {
      if (placement === "element")
        fence.extend(
          (
            [
              "containers:write",
              "containers:read",
              "scenes:write",
              "terminals:spawn",
              "terminals:write",
            ] as const
          ).map((cap) => ({
            cap,
            node: formatManifoldUri({ kind: "container", containerId: homeId }),
            reach: "node" as const,
          })),
        );
      // Keep the policy preparer's source container. A generated element home rebinds its
      // native demand only after this fence has admitted authority to work in that home.
      fence.bind({ ...fence.snapshot(), machineId: machine.machineId });
      fence.checkCurrent();
    } catch (error) {
      fence.close();
      refuse(
        "forbidden",
        error instanceof Error ? error.message : "terminal home authority unavailable",
      );
      return;
    }
    const placementId =
      placement === "tile"
        ? (this.rooms.get(homeId)?.placeTerminalTile(terminalId, null, null) ?? null)
        : null;
    if (placement === "tile" && placementId === null) {
      refuse("conflict", "terminal home could not be placed");
      return;
    }
    const pending: PendingOpen = {
      terminalId,
      fence,
      terminalHostId: machine.terminalHostId,
      containerId,
      homeId,
      ref: message.elementId,
      placement,
      machineId: machine.machineId,
      createdBy: auth.principal.id,
      createdAt: this.runtime.now(),
      cols: null,
      rows: null,
      opener,
      resolve,
      auth,
      message,
      ...(traceId === undefined ? {} : { traceId }),
      agentPrincipalId: null,
      cancelDeadline: null,
      launchRecipe: null,
      placementId,
      dispatched: false,
      sent: false,
    };
    this.pendingOpens.set(terminalId, pending);
    pending.cancelDeadline = this.timers.schedule(() => {
      pending.cancelDeadline = null;
      if (this.pendingOpens.get(terminalId) !== pending) return;
      this.pendingOpens.delete(terminalId);
      this.killPendingOpen(pending);
      this.abandonOpen(pending);
      this.answerOpen(
        pending.opener,
        pending.resolve,
        "no_machine",
        pending.dispatched ? "terminal creation timed out" : "terminal fit timed out",
        pending.ref,
      );
      this.logger.warn("terminal_create_timeout", {
        machineId: pending.machineId,
        terminalId,
        awaitingFit: !pending.dispatched,
      });
      this.rooms.evictIfIdle(pending.containerId);
    }, CREATE_DEADLINE_MS);
    if (hasCols) {
      this.dispatchOpen(pending, message.cols!, message.rows!);
    }
  }

  private rejectPendingOpen(pending: PendingOpen, code: ErrorCode, reason: string): void {
    if (this.pendingOpens.get(pending.terminalId) !== pending) return;
    pending.cancelDeadline?.();
    this.pendingOpens.delete(pending.terminalId);
    this.killPendingOpen(pending);
    this.abandonOpen(pending);
    this.answerOpen(pending.opener, pending.resolve, code, reason, pending.ref);
    this.rooms.evictIfIdle(pending.containerId);
  }

  /**
   * Latches a pending terminal's first measured geometry and only then admits and creates
   * its PTY. JavaScript's serialized message handling makes the `dispatched` flip the
   * deterministic winner when several viewers race; later measurements are ignored until
   * the running terminal's normal controller-owned resize lifecycle begins.
   */
  private dispatchOpen(pending: PendingOpen, cols: number, rows: number): void {
    if (pending.dispatched || this.pendingOpens.get(pending.terminalId) !== pending) return;
    try {
      pending.auth = pending.fence.checkCurrent();
    } catch (error) {
      this.rejectPendingOpen(
        pending,
        "forbidden",
        error instanceof Error ? error.message : "terminal authority unavailable",
      );
      return;
    }
    pending.dispatched = true;
    const machine = this.machines.get(pending.machineId);
    if (
      machine === undefined ||
      machine.terminalHostId !== pending.terminalHostId ||
      this.draining.has(pending.machineId)
    ) {
      this.rejectPendingOpen(pending, "no_machine", "machine connection unavailable");
      return;
    }
    const { message } = pending;
    let runtime: Extract<ServerToAgentMessage, { type: "create" }>["runtime"];
    if (message.runtime) {
      try {
        if (!this.jobs || !machine.terminalHostId || pending.traceId === undefined)
          throw new Error("terminal_runtime_unsupported");
        if (message.runtime.launchBinding !== undefined) {
          if ((machine.protocolVersion ?? 0) < 32)
            throw new ServiceError("forbidden", "run_launch_protocol_unsupported");
          this.jobs.assertRunLaunchSupported(machine.machineId);
        }
        const privateEnv = this.consumeRunLaunch(
          message.runtime,
          pending.auth,
          pending.containerId,
        );
        runtime = this.jobs.admitTerminal(
          pending.auth,
          message.runtime,
          machine.machineId,
          {
            terminalId: pending.terminalId,
            terminalHostId: machine.terminalHostId,
            containerId: pending.homeId,
            ...(privateEnv ? { runId: privateEnv.MANIFOLD_RUN_ID } : {}),
          },
          pending.traceId,
          privateEnv,
          pending.fence,
        );
      } catch (error) {
        this.rejectPendingOpen(
          pending,
          "forbidden",
          error instanceof Error ? error.message : "terminal runtime admission refused",
        );
        return;
      }
    }
    try {
      pending.auth = pending.fence.checkCurrent();
    } catch (error) {
      this.rejectPendingOpen(
        pending,
        "forbidden",
        error instanceof Error ? error.message : "terminal authority unavailable",
      );
      return;
    }
    let grant: TokenGrant | null = null;
    if (!runtime) {
      try {
        grant = this.auth.mintTerminalLifecycleToken(
          pending.terminalId,
          pending.homeId,
          pending.auth.principal.id,
          pending.auth.tokenId,
        );
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        this.rejectPendingOpen(pending, error.code, error.message);
        return;
      }
    }
    pending.cols = cols;
    pending.rows = rows;
    pending.agentPrincipalId = grant?.principal.id ?? null;
    try {
      pending.auth = pending.fence.checkCurrent();
    } catch (error) {
      this.rejectPendingOpen(
        pending,
        "forbidden",
        error instanceof Error ? error.message : "terminal authority unavailable",
      );
      return;
    }
    pending.launchRecipe = {
      cols,
      rows,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      env: message.env ?? {},
      ...(message.program === undefined ? {} : { program: message.program }),
      ...(message.runtime === undefined ? {} : { runtime: message.runtime }),
      ...(pending.placement === "tile" ? {} : { elementId: message.elementId }),
    };
    if (runtime?.request.terminal?.runId !== undefined)
      pending.runId = runtime.request.terminal.runId;
    pending.sent = true;
    const sent = machine.send({
      type: "create",
      terminalId: pending.terminalId,
      cols,
      rows,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      env: runtime
        ? {}
        : {
            ...message.env,
            MANIFOLD_URL: this.publicUrl(),
            MANIFOLD_CONTAINER: pending.homeId,
            ...(pending.placement === "tile" ? {} : { MANIFOLD_ELEMENT: message.elementId }),
            MANIFOLD_TOKEN: grant!.token,
          },
      ...(message.program === undefined ? {} : { program: message.program }),
      ...(runtime ? { runtime } : {}),
    });
    if (!sent) {
      pending.sent = false;
      this.rejectPendingOpen(pending, "no_machine", "machine connection unavailable");
    }
  }

  /**
   * Commits a created PTY, replies to its opener, and publishes durable lifecycle state.
   *
   * This is where `homed: "eager"` is actually paid for. A composition opener's leaf was
   * written before PTY birth so a viewer could measure it; this commit verifies that leaf
   * still exists. A canvas opener gets a whole solo composition, and its own portal element
   * — authored client-side under the ref it chose — points at the id this reply hands back.
   */
  onCreated(machineId: string, terminalId: string): void {
    const pending = this.pendingOpens.get(terminalId);
    if (pending === undefined || pending.machineId !== machineId) return;
    if (this.machines.get(machineId)?.terminalHostId !== pending.terminalHostId) {
      this.rejectPendingOpen(pending, "forbidden", "terminal owner changed");
      return;
    }
    // The owner has committed this ordinary birth. Drain cannot invalidate a create
    // already sent before its latch; credential, code and continuation guards stay live.
    if (pending.sent && pending.message.runtime === undefined) pending.fence.commit();
    try {
      pending.auth = pending.fence.checkCurrent();
    } catch (error) {
      this.rejectPendingOpen(
        pending,
        "forbidden",
        error instanceof Error ? error.message : "terminal authority withdrawn",
      );
      return;
    }
    this.pendingOpens.delete(terminalId);
    pending.cancelDeadline?.();
    const cols = pending.cols;
    const rows = pending.rows;
    const launchRecipe = pending.launchRecipe;
    const home =
      cols === null || rows === null || launchRecipe === null
        ? null
        : pending.placement === "tile"
          ? pending.placementId !== null &&
            this.rooms.get(pending.homeId)?.homesTerminal(terminalId)
            ? pending.placementId
            : null
          : (this.placement?.createHome(pending.homeId, terminalId, this.bornLabel(machineId)) ??
            null);
    if (home === null || cols === null || rows === null || launchRecipe === null) {
      // Nothing durable exists yet, so the PTY is the only thing to undo.
      this.killPendingOpen(pending);
      this.abandonOpen(pending);
      this.answerOpen(
        pending.opener,
        pending.resolve,
        "conflict",
        "this terminal could not be given a home",
        pending.ref,
      );
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
      ...(launchRecipe.cwd === undefined ? {} : { cwd: launchRecipe.cwd }),
      launchRecipe,
      ...(launchRecipe.runtime?.session === undefined
        ? {}
        : { session: launchRecipe.runtime.session }),
      ...(pending.runId === undefined ? {} : { runId: pending.runId }),
      ...(pending.auth.agentRunId === undefined ? {} : { createdByRunId: pending.auth.agentRunId }),
    });
    const info: TerminalInfo = {
      id: terminalId,
      containerId: pending.homeId,
      name: null,
      machineId,
      status: "running",
      exitCode: null,
      exitReason: null,
      readiness: null,
      cols,
      rows,
      controllerId: pending.createdBy,
      createdBy: pending.createdBy,
      ...(launchRecipe.cwd === undefined ? {} : { cwd: launchRecipe.cwd }),
      ...(launchRecipe.runtime?.session === undefined
        ? {}
        : { session: launchRecipe.runtime.session }),
    };
    this.terminals.set(terminalId, {
      info,
      viewers: new Map(),
      lastReceivedOutputSeq: 0,
      lastReceivedGeometryRevision: 0,
      lastRequestedGrid: null,
      snapshotGeneration: 0,
      snapshotRequestOutstanding: false,
      sizing: { mode: "retained", columns: [], rows: [] },
      viewportExpiryAt: null,
      cancelViewportExpiry: null,
      arbitratingViewports: false,
      viewportArbitrationPending: false,
    });
    if (pending.message.runtime !== undefined) pending.fence.commit();
    /*
      The reply carries the home LEAF for a composition opener and the opener's own ref for a
      canvas one, because those are the ids each of them will render under;
      `terminal.containerId` carries the home either way, which is what a canvas opener
      portals onto.

      The fan-out goes to the HOME's room, not the opener's: after this cutover nothing
      about a terminal is canvas state. A canvas learns about the new terminal the same way
      it learns about anything else on it — the portal element arriving in its document.
     */
    pending.opener?.send({
      type: "terminal_opened",
      elementId: pending.placement === "tile" ? home : pending.ref,
      terminal: info,
      ...(pending.placement === "tile" ? { ref: pending.ref } : {}),
    });
    const homeRoom = this.rooms.live(pending.homeId);
    homeRoom?.broadcast(
      { type: "terminal_opened", elementId: home, terminal: info },
      false,
      pending.opener ?? undefined,
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
    pending.fence.close();
    pending.resolve({ ok: true, terminal: info });
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
    this.abandonOpen(pending);
    this.answerOpen(
      pending.opener,
      pending.resolve,
      "conflict",
      "terminal creation failed",
      pending.ref,
    );
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

  /**
   * Begins one view's PENDING attachment before requesting the agent's ordered snapshot
   * watermark. Re-attaching the same view retires its previous incarnation and credit; a
   * sibling view of the terminal on this channel is untouched.
   */
  attach(channel: SessionChannel, message: TerminalAttach): void {
    const terminal = this.terminals.get(message.terminalId);
    // Each refusal is scoped to the view that asked, then answered with the generic error.
    if (terminal === undefined || terminal.info.containerId !== channel.containerId) {
      this.sendRefusal(channel, message.terminalId, message.viewportId, null, false, "not_found");
      channel.send({
        type: "error",
        code: "not_found",
        message: "terminal not found",
        ref: message.terminalId,
      });
      return;
    }
    if (terminal.info.status !== "running") {
      this.sendRefusal(channel, message.terminalId, message.viewportId, null, false, "exited");
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal has exited",
        ref: message.terminalId,
      });
      return;
    }
    const previous = terminal.viewers.get(channel)?.get(message.viewportId);
    if (previous !== undefined) {
      this.removeViewer(terminal, channel, previous, false);
    } else if ((terminal.viewers.get(channel)?.size ?? 0) >= MAX_TERMINAL_VIEWPORTS) {
      // Views fan out per frame, so one channel's attachments to one terminal are bounded.
      this.sendRefusal(channel, message.terminalId, message.viewportId, null, false, "view_limit");
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal view limit reached",
        ref: message.terminalId,
      });
      return;
    }
    const viewer: Viewer = {
      viewportId: message.viewportId,
      state: "PENDING",
      queue: [],
      queuedBytes: 0,
      cancelSnapshotDeadline: null,
      snapshotGeneration: terminal.snapshotGeneration + 1,
      lastDeliveredSeq: 0,
      lastDeliveredGeometryRevision: -1,
      credential: this.auth.credentialReference(channel.auth),
      viewport: null,
      delivery: null,
      skipped: false,
    };
    let views = terminal.viewers.get(channel);
    if (views === undefined) {
      views = new Map();
      terminal.viewers.set(channel, views);
    }
    views.set(viewer.viewportId, viewer);
    this.arbitrateViewports(terminal);
    if (
      !channel.send({
        type: "terminal_sizing",
        terminalId: terminal.info.id,
        sizing: terminal.sizing,
      })
    ) {
      this.removeViewer(terminal, channel, viewer);
      return;
    }
    this.armSnapshotDeadline(terminal, channel, viewer);
    this.requestSnapshotForPending(terminal);
  }

  /** Stops routing one terminal's bytes to exactly one view of this channel. */
  detach(channel: SessionChannel, message: TerminalDetach): void {
    const terminal = this.terminals.get(message.terminalId);
    const viewer = terminal?.viewers.get(channel)?.get(message.viewportId);
    if (terminal !== undefined && viewer !== undefined)
      this.removeViewer(terminal, channel, viewer);
  }

  /** Removes a closing socket from every terminal's viewer registry. */
  detachAll(channel: SessionChannel): void {
    for (const terminal of this.terminals.values()) {
      const views = terminal.viewers.get(channel);
      if (views === undefined) continue;
      for (const viewer of views.values()) this.removeViewer(terminal, channel, viewer, false);
      this.arbitrateViewports(terminal);
    }
  }

  /**
   * Credits one view's COMPLETED parsing, cumulatively through `deliverySeq`. Only ordinals
   * actually sent in the view's current incarnation count: a stale incarnation, a duplicate
   * and an ordinal never sent are each ignored without reply, because each is either an
   * ordinary race with a newer snapshot or a client defect, and neither may grant credit or
   * reach any other view. Freed credit drains held frames in order; a recovering view whose
   * last sent frame completed asks for its fresh snapshot.
   */
  ack(channel: SessionChannel, message: TerminalAck): void {
    const terminal = this.terminals.get(message.terminalId);
    if (terminal === undefined || terminal.info.containerId !== channel.containerId) return;
    const viewer = terminal.viewers.get(channel)?.get(message.viewportId);
    if (viewer === undefined) return;
    const delivery = viewer.delivery;
    if (delivery === null || delivery.id !== message.deliveryId) return;
    const credited = message.deliverySeq - (delivery.nextSeq - delivery.unacked.length) + 1;
    if (credited <= 0 || message.deliverySeq >= delivery.nextSeq) return;
    for (const charge of delivery.unacked.splice(0, credited)) delivery.unackedBytes -= charge;
    if (viewer.state === "LIVE") {
      if (!this.drainViewer(terminal, channel, viewer, delivery)) this.arbitrateViewports(terminal);
      return;
    }
    if (viewer.state === "RECOVERING" && delivery.unacked.length === 0) {
      this.awaitSnapshot(terminal, channel, viewer);
      this.requestSnapshotForPending(terminal);
    }
  }

  /** Whether one more frame of `charge` fits this incarnation's completed-parse credit. */
  private hasCredit(delivery: Delivery, charge: number): boolean {
    return (
      delivery.unacked.length < MAX_TERMINAL_DELIVERY_UNACKED_FRAMES &&
      delivery.unackedBytes + charge <= MAX_TERMINAL_DELIVERY_UNACKED_BYTES
    );
  }

  /**
   * Sends a LIVE view's held frames in order while its credit allows, then announces `live`
   * once the hold is empty and at most half of either window is outstanding. The hysteresis
   * bounds notices to one pair per half window of completed work, never one per frame.
   */
  private drainViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    delivery: Delivery,
  ): boolean {
    for (let frame = viewer.queue[0]; frame !== undefined; frame = viewer.queue[0]) {
      const charge = terminalDeliveryCharge(frame);
      if (!this.hasCredit(delivery, charge)) return true;
      viewer.queue.shift();
      viewer.queuedBytes -= charge;
      if (!this.sendDeliveryFrame(terminal, channel, viewer, delivery, frame, charge)) return false;
    }
    if (
      delivery.notice !== "waiting" ||
      delivery.unackedBytes * 2 > MAX_TERMINAL_DELIVERY_UNACKED_BYTES ||
      delivery.unacked.length * 2 > MAX_TERMINAL_DELIVERY_UNACKED_FRAMES
    )
      return true;
    return this.announceDelivery(terminal, channel, viewer, delivery, "live");
  }

  /**
   * One source frame into a LIVE view's ordered lane: sent under credit, else held behind the
   * frames already held, else — the pending window being full — discarded with that hold for
   * a sequenced snapshot. Never sorted, never coalesced. Returns whether the view is attached.
   */
  private admitLive(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    delivery: Delivery,
    frame: StreamFrame,
  ): boolean {
    if (frame.type === "terminal_output") {
      if (frame.seq <= viewer.lastDeliveredSeq) return true;
      viewer.lastDeliveredSeq = frame.seq;
    } else {
      const revision = frame.geometry.revision;
      if (revision !== null && revision <= viewer.lastDeliveredGeometryRevision) return true;
      viewer.lastDeliveredGeometryRevision = revision ?? -1;
    }
    const charge = terminalDeliveryCharge(frame);
    if (viewer.queue.length === 0 && this.hasCredit(delivery, charge))
      return this.sendDeliveryFrame(terminal, channel, viewer, delivery, frame, charge);
    if (
      viewer.queue.length >= MAX_TERMINAL_DELIVERY_PENDING_FRAMES ||
      viewer.queuedBytes + charge > MAX_TERMINAL_DELIVERY_PENDING_BYTES
    )
      return this.recoverViewer(terminal, channel, viewer, true);
    viewer.queue.push(frame);
    viewer.queuedBytes += charge;
    return (
      delivery.notice !== "live" ||
      this.announceDelivery(terminal, channel, viewer, delivery, "waiting")
    );
  }

  /** Stamps one frame with the view's next ordinal and charges it; false once it is gone. */
  private sendDeliveryFrame(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    delivery: Delivery,
    frame: StreamFrame,
    charge: number,
  ): boolean {
    const deliverySeq = delivery.nextSeq;
    const stamped = this.stampDeliveryFrame(frame, {
      viewportId: viewer.viewportId,
      deliveryId: delivery.id,
      deliverySeq,
    });
    if (!channel.sendSerialized(stamped)) {
      this.removeViewer(terminal, channel, viewer, false);
      return false;
    }
    delivery.nextSeq = deliverySeq + 1;
    delivery.unacked.push(charge);
    delivery.unackedBytes += charge;
    return this.isCurrentViewer(terminal, channel, viewer);
  }

  /**
   * Validates a source frame once, with its first view's stamp, and caches its JSON without
   * view fields; each view then splices its own delivery head in front — the same prefix
   * splice a channel applies for routing. Every spliced field was validated on its way in:
   * `viewportId` by the attach frame, the rest minted here.
   */
  private stampDeliveryFrame(
    frame: StreamFrame | Unstamped<"terminal_snapshot">,
    stamp: DeliveryStamp,
  ): SerializedServerMessage {
    let shared = this.deliveryBodies.get(frame);
    if (shared === undefined) {
      ServerMessageBodySchema.parse({ ...frame, ...stamp });
      const body = JSON.stringify(frame);
      shared = { type: frame.type, body, bytes: Buffer.byteLength(body) };
      this.deliveryBodies.set(frame, shared);
    }
    const head =
      `{"viewportId":${JSON.stringify(stamp.viewportId)},` +
      `"deliveryId":${JSON.stringify(stamp.deliveryId)},"deliverySeq":${stamp.deliverySeq},` +
      (stamp.skipped === undefined ? "" : `"skipped":${stamp.skipped},`);
    return {
      type: shared.type,
      body: head + shared.body.slice(1),
      bytes: Buffer.byteLength(head) - 1 + shared.bytes,
      authoritative: false,
    };
  }

  private supportsTerminalGeometry(machine: MachineChannel | undefined): boolean {
    return (
      machine?.terminalGeometry === true &&
      (machine.protocolVersion ?? 0) >= TERMINAL_GEOMETRY_PROTOCOL_VERSION
    );
  }

  private publishGeometryState(terminal: RuntimeTerminal, cols: number, rows: number): void {
    terminal.info = { ...terminal.info, cols, rows };
    this.rooms.live(terminal.info.containerId)?.broadcast({
      type: "terminal_event",
      terminalId: terminal.info.id,
      kind: "resized",
      cols,
      rows,
    });
  }

  /**
   * One arrival-ordered source lane fanned out to every view; output and geometry keep
   * independent watermarks. A PENDING view queues the post-request tail under the pending
   * bound and is refused on overflow as before; a LIVE view admits under its own credit; a
   * RECOVERING view takes nothing, because its fresh snapshot will cover this frame.
   */
  private relayStreamFrame(
    terminal: RuntimeTerminal,
    frame: StreamFrame,
    queuePending = true,
  ): void {
    const charge = terminalDeliveryCharge(frame);
    let retiredViewer = false;
    let awaitsSnapshot = false;
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      const state = viewer.state;
      if (state === "RECOVERING") {
        // Owner re-adoption can start recovery without a gap. Its first omitted byte frame
        // changes that truth: disclose once, then keep this lane silent until re-anchored.
        if (frame.type === "terminal_output" && !viewer.skipped) {
          viewer.skipped = true;
          const delivery = viewer.delivery;
          if (
            delivery !== null &&
            !this.announceDelivery(terminal, channel, viewer, delivery, "recovering")
          )
            retiredViewer = true;
        }
        continue;
      }
      if (state === "LIVE") {
        const delivery = viewer.delivery;
        if (delivery === null) continue;
        if (!this.admitLive(terminal, channel, viewer, delivery, frame)) retiredViewer = true;
        else if (viewer.state === "PENDING") awaitsSnapshot = true;
        continue;
      }
      if (!queuePending) continue;
      if (
        viewer.queue.length >= MAX_TERMINAL_DELIVERY_PENDING_FRAMES ||
        viewer.queuedBytes + charge > MAX_TERMINAL_DELIVERY_PENDING_BYTES
      ) {
        // The snapshot request has a finite deadline and no retry: a tail that outgrew the
        // bound before its snapshot arrived would leave a gap, so the attachment is refused.
        this.failViewer(
          terminal,
          channel,
          viewer,
          "pending_overflow",
          "conflict",
          "terminal attach queue overflow",
          false,
        );
        retiredViewer = true;
        continue;
      }
      viewer.queue.push(frame);
      viewer.queuedBytes += charge;
    }
    if (awaitsSnapshot) this.requestSnapshotForPending(terminal);
    if (retiredViewer) this.arbitrateViewports(terminal);
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
    this.relayStreamFrame(terminal, {
      type: "terminal_output",
      terminalId: output.terminalId,
      seq: output.seq,
      data: output.data,
    });
  }

  /** Only the capable owner publishes applied geometry, never resize command admission. */
  onGeometry(machineId: string, frame: OwnerGeometryFrame): void {
    const terminal = this.terminals.get(frame.terminalId);
    if (
      terminal === undefined ||
      terminal.info.machineId !== machineId ||
      terminal.info.status !== "running" ||
      !this.supportsTerminalGeometry(this.machines.get(machineId)) ||
      frame.geometry.revision <= terminal.lastReceivedGeometryRevision
    )
      return;
    terminal.lastReceivedGeometryRevision = frame.geometry.revision;
    this.publishGeometryState(terminal, frame.geometry.cols, frame.geometry.rows);
    this.relayStreamFrame(terminal, {
      type: "terminal_geometry",
      terminalId: frame.terminalId,
      seq: frame.seq,
      geometry: frame.geometry,
    });
  }

  private isCurrentSnapshotViewer(
    terminal: RuntimeTerminal,
    channel: SessionChannel,
    viewer: Viewer,
    generation: number,
  ): boolean {
    return (
      this.isCurrentViewer(terminal, channel, viewer) &&
      viewer.state === "PENDING" &&
      viewer.snapshotGeneration === generation
    );
  }

  /**
   * Snapshot(S,G) opens a fresh incarnation for every view of its generation, then outputs > S
   * and geometry > G in their source arrival order under that view's own credit.
   */
  onSnapshot(machineId: string, snapshot: SnapshotFrame): void {
    const terminal = this.terminals.get(snapshot.terminalId);
    if (terminal === undefined || terminal.info.machineId !== machineId) return;
    if (terminal.info.status !== "running") return;
    if (!terminal.snapshotRequestOutstanding) return;
    if (
      this.supportsTerminalGeometry(this.machines.get(machineId)) !==
      (snapshot.type === "geometry_snapshot")
    )
      return;
    const generation = terminal.snapshotGeneration;
    terminal.snapshotRequestOutstanding = false;
    const geometry =
      snapshot.type === "geometry_snapshot"
        ? snapshot.geometry
        : { cols: terminal.info.cols, rows: terminal.info.rows, revision: null };
    if (
      snapshot.type === "geometry_snapshot" &&
      snapshot.geometry.revision > terminal.lastReceivedGeometryRevision
    ) {
      terminal.lastReceivedGeometryRevision = snapshot.geometry.revision;
      if (
        terminal.info.cols !== snapshot.geometry.cols ||
        terminal.info.rows !== snapshot.geometry.rows
      )
        this.publishGeometryState(terminal, snapshot.geometry.cols, snapshot.geometry.rows);
    }
    const source: Unstamped<"terminal_snapshot"> = {
      type: "terminal_snapshot",
      terminalId: snapshot.terminalId,
      seq: snapshot.seq,
      data: snapshot.data,
      geometry,
    };
    const charge = terminalDeliveryCharge(source);
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      if (!this.isCurrentSnapshotViewer(terminal, channel, viewer, generation)) continue;
      viewer.cancelSnapshotDeadline?.();
      viewer.cancelSnapshotDeadline = null;
      const delivery: Delivery = {
        id: this.runtime.newId(),
        nextSeq: 1,
        unacked: [charge],
        unackedBytes: charge,
        notice: "live",
      };
      const stamped = this.stampDeliveryFrame(source, {
        viewportId: viewer.viewportId,
        deliveryId: delivery.id,
        deliverySeq: 0,
        skipped: viewer.skipped,
      });
      if (!channel.sendSerialized(stamped)) {
        this.removeViewer(terminal, channel, viewer, false);
        continue;
      }
      if (!this.isCurrentSnapshotViewer(terminal, channel, viewer, generation)) continue;
      const tail = viewer.queue;
      viewer.queue = [];
      viewer.queuedBytes = 0;
      viewer.state = "LIVE";
      viewer.delivery = delivery;
      viewer.skipped = false;
      viewer.lastDeliveredSeq = snapshot.seq;
      viewer.lastDeliveredGeometryRevision = geometry.revision ?? -1;
      // The tail already fits the pending bound, so admitting it can hold but never overflow.
      for (const frame of tail) {
        if (!this.admitLive(terminal, channel, viewer, delivery, frame)) break;
      }
    }
    this.requestSnapshotForPending(terminal);
    this.arbitrateViewports(terminal);
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

  /**
   * The first writable home viewport births a tiled PTY. Attached views then lease their
   * independent measurements; only LIVE views under current controller authority contribute.
   */
  resize(channel: SessionChannel, message: TerminalResize): void {
    const pending = this.pendingOpens.get(message.terminalId);
    if (
      pending !== undefined &&
      pending.placement === "tile" &&
      pending.homeId === channel.containerId
    ) {
      if (message.viewport === null) return;
      if (
        !this.viewportAuthority(
          channel,
          pending.homeId,
          this.auth.credentialReference(channel.auth),
        )
      ) {
        channel.send({ type: "error", code: "forbidden", ref: message.terminalId });
        return;
      }
      if (!pending.dispatched)
        this.dispatchOpen(pending, message.viewport.cols, message.viewport.rows);
      return;
    }
    if (message.viewport === null) {
      const terminal = this.terminalFor(channel, message.terminalId);
      if (terminal === null) return;
      const viewer = terminal.viewers.get(channel)?.get(message.viewportId);
      if (viewer !== undefined) viewer.viewport = null;
      this.arbitrateViewports(terminal);
      return;
    }
    const terminal = this.terminalFor(channel, message.terminalId);
    if (terminal === null) return;
    if (
      terminal.info.status !== "running" ||
      terminal.info.controllerId !== channel.auth.principal.id
    ) {
      this.arbitrateViewports(terminal);
      channel.send({
        type: "error",
        code: terminal.info.status !== "running" ? "conflict" : "not_controller",
        ref: message.terminalId,
      });
      return;
    }
    // A measurement belongs to exactly the attached view it names on this channel.
    const viewer = terminal.viewers.get(channel)?.get(message.viewportId);
    const credential = viewer?.credential ?? this.auth.credentialReference(channel.auth);
    if (!this.viewportAuthority(channel, terminal.info.containerId, credential)) {
      this.arbitrateViewports(terminal);
      channel.send({ type: "error", code: "forbidden", ref: message.terminalId });
      return;
    }
    if (viewer === undefined) {
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal viewport requires an attached viewer",
        ref: message.terminalId,
      });
      return;
    }
    const { count } = this.pruneViewports(terminal);
    if (viewer.viewport === null && count >= MAX_TERMINAL_VIEWPORTS) {
      this.arbitrateViewports(terminal);
      channel.send({
        type: "error",
        code: "conflict",
        message: "terminal viewport registration limit reached",
        ref: message.terminalId,
      });
      return;
    }
    viewer.viewport = {
      ...message.viewport,
      expiresAt: this.runtime.now() + TERMINAL_VIEWPORT_LEASE_MS,
    };
    this.arbitrateViewports(terminal, channel);
  }

  /**
   * Transfers controller authority to an authorized principal and announces the lease.
   *
   * AUTHORITY IS NOT DECIDED HERE. `terminal_take` dispatches `core.terminals.take` before
   * this runs, so the caps rung, the scope rung and the plugin-enabled rung have all been
   * answered in the published denial vocabulary by the time the transfer happens — and the
   * `terminals:write` check this method used to carry was the second door onto that question
   * (docs/CONTRACTS.md §One authoritative implementation). What is left is the transport's own work: resolve the terminal in THIS
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
    this.arbitrateViewports(terminal);
  }

  /**
   * Explicit removal and clean root PTY exit share one canonical sweep.
   * Removed terminals are absent from `this.terminals`, so duplicate or late exit
   * frames cannot resurrect them. Missing-owner inventory evidence remains dismissable.
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

  /** Restarts the process, not its placement. The terminal door has already judged authority. */
  restartById(
    terminalId: string,
    principalId: string,
    credential?: CredentialReference,
    traceId?: number,
    launchRun?: (
      input: LaunchRunRequest,
    ) => Promise<
      | { readonly ok: true; readonly value: LaunchRunResult }
      | { readonly ok: false; readonly message: string }
    >,
    admittedFence?: ActionAuthorityFence,
  ): Promise<string> {
    const terminal = this.terminals.get(terminalId);
    const stored = this.store.getTerminal(terminalId);
    if (terminal === undefined || stored === null) return Promise.resolve("not_found");
    if (this.pendingRestarts.has(terminalId)) return Promise.resolve("restart_pending");
    const machine = this.machines.get(terminal.info.machineId);
    if (machine === undefined) return Promise.resolve("machine_offline");
    if (this.draining.has(machine.machineId)) return Promise.resolve("machine_draining");
    if (
      machine.terminalRestart !== true ||
      (machine.protocolVersion ?? 0) < TERMINAL_RESTART_PROTOCOL_VERSION
    )
      return Promise.resolve("unsupported");
    const recipe = stored.launchRecipe;
    if (stored.runId !== undefined && !launchRun) return Promise.resolve("run_launch_unavailable");
    if (stored.runId === undefined) {
      if (recipe === undefined && machine.terminalExecution !== "unconfined")
        return Promise.resolve("no_recipe");
      if (recipe !== undefined && !recipe.runtime && machine.terminalExecution !== "unconfined")
        return Promise.resolve("terminal_runtime_required");
    }
    let fence: ActionAuthorityFence;
    try {
      if (admittedFence !== undefined) fence = admittedFence.retain();
      else {
        const current = credential === undefined ? null : this.auth.restoreCredential(credential);
        if (current === null)
          throw new ServiceError("forbidden", "terminal restart authority unavailable");
        fence = new ActionAuthorityFence(this.auth, current, () => true, stored.containerId);
        const requirements: ActionAuthorityRequirement[] = [
          {
            cap: "terminals:write",
            node: formatManifoldUri({ kind: "container", containerId: stored.containerId }),
            reach: "node",
          },
        ];
        if (!recipe?.runtime && stored.runId === undefined)
          requirements.push(
            {
              cap: "terminals:spawn",
              node: formatManifoldUri({ kind: "container", containerId: stored.containerId }),
              reach: "node",
            },
            {
              cap: "machines:shell",
              node: formatManifoldUri({ kind: "machine", machineId: stored.machineId }),
              reach: "node",
            },
          );
        fence.admit(requirements);
      }
      const recipeDigest = createHash("sha256")
        .update(canonicalJobJson(recipe ?? null))
        .digest("hex");
      fence.guard(() => {
        if (this.store.revokedMachineIds().has(machine.machineId))
          throw new ServiceError("forbidden", "terminal destination unavailable");
      });
      fence.guard(() => {
        const current = this.store.getTerminal(terminalId);
        if (
          this.terminals.get(terminalId) !== terminal ||
          current === null ||
          current.machineId !== stored.machineId ||
          current.containerId !== stored.containerId ||
          current.runId !== stored.runId ||
          createHash("sha256")
            .update(canonicalJobJson(current.launchRecipe ?? null))
            .digest("hex") !== recipeDigest ||
          this.machines.get(machine.machineId) !== machine ||
          this.draining.has(machine.machineId)
        )
          throw new ServiceError("forbidden", "terminal restart binding changed");
        const live = this.auth.restoreCredential(fence.credentialReference());
        if (
          live === null ||
          (terminal.info.status === "running" &&
            terminal.info.controllerId !== live.principal.id &&
            !this.auth.holdsRoot(live))
        )
          throw new ServiceError("forbidden", "terminal control changed during restart");
      }, "admission");
      fence.checkCurrent();
    } catch (error) {
      return Promise.resolve(
        error instanceof Error ? error.message : "terminal restart authority unavailable",
      );
    }
    const completion = Promise.withResolvers<string>();
    const pending: PendingRestart = {
      fence,
      terminalHostId: machine.terminalHostId,
      machineId: machine.machineId,
      principalId,
      agentPrincipalId: null,
      jobId: null,
      runLaunch: null,
      ordinary: false,
      dispatched: false,
      resolve: completion.resolve,
      cancelDeadline: null,
    };
    this.pendingRestarts.set(terminalId, pending);
    pending.cancelDeadline = this.timers.schedule(() => {
      this.finishRestart(terminalId, "restart_timeout");
    }, CREATE_DEADLINE_MS);
    const prepare = async () => {
      pending.fence.checkCurrent();
      let runtime: Extract<ServerToAgentMessage, { type: "create" }>["runtime"];
      let auth = credential === undefined ? null : this.auth.restoreCredential(credential);
      if (credential !== undefined && (!auth || auth.principal.id !== principalId))
        throw new Error("terminal_runtime_admission_refused");
      if (recipe?.runtime || stored.runId !== undefined) {
        if (!this.jobs || !machine.terminalHostId || !credential || !auth || traceId === undefined)
          throw new Error("terminal_runtime_unsupported");
        let descriptor = recipe?.runtime;
        let privateEnv;
        if (stored.runId !== undefined) {
          const session = this.store.getAgentRun(stored.runId)?.session;
          if (session == null) throw new Error("run_launch_unavailable");
          const prior = this.jobs.storedTerminalDemandBinding(terminalId);
          if (prior === null) throw new Error("terminal_restart_recipe_changed");
          const admitted = pending.fence.snapshot().requirements;
          const missing = prior.requirements.filter(
            (required) =>
              !admitted.some(
                (held) =>
                  held.cap === required.cap &&
                  held.node === required.node &&
                  (held.reach ?? "node") === required.reach,
              ),
          );
          if (missing.length > 0) pending.fence.extendPrepared(missing);
          const launched = await launchRun!({
            runId: stored.runId,
            target: { machineId: machine.machineId, containerId: stored.containerId },
          });
          if (launched.ok) {
            const binding = this.boundRunLaunch(
              launched.value.runtime,
              auth,
              stored.containerId,
              terminalId,
            );
            if (binding === undefined || binding.runId !== stored.runId)
              throw new Error("run_launch_unavailable");
            pending.runLaunch = {
              bindingId: launched.value.runtime.launchBinding!,
              runId: binding.runId,
              token: binding.token,
            };
          }
          if (this.pendingRestarts.get(terminalId) !== pending) {
            this.retireRestartRunLaunch(pending);
            return;
          }
          pending.fence.checkCurrent();
          if (!launched.ok) throw new ServiceError("forbidden", launched.message);
          auth = this.auth.restoreCredential(credential);
          const current = this.store.getTerminal(terminalId);
          if (
            this.terminals.get(terminalId) !== terminal ||
            current?.runId !== stored.runId ||
            current.machineId !== stored.machineId ||
            current.containerId !== stored.containerId
          )
            throw new Error("terminal_changed");
          if (
            !auth ||
            auth.principal.id !== principalId ||
            !this.auth.allows(auth, "terminals:write", stored.containerId) ||
            (terminal.info.status === "running" &&
              terminal.info.controllerId !== principalId &&
              !this.auth.holdsRoot(auth))
          )
            throw new Error("terminal_runtime_admission_refused");
          if (this.machines.get(machine.machineId) !== machine)
            throw new Error("machine_unavailable");
          if (this.draining.has(machine.machineId)) throw new Error("machine_draining");
          if (
            machine.terminalRestart !== true ||
            (machine.protocolVersion ?? 0) < TERMINAL_RESTART_PROTOCOL_VERSION
          )
            throw new Error("unsupported");
          descriptor = launched.value.runtime;
          if (
            canonicalJobJson(launched.value.session) !== canonicalJobJson(session) ||
            (descriptor.session !== undefined &&
              canonicalJobJson(descriptor.session) !== canonicalJobJson(session))
          )
            throw new Error("terminal_restart_recipe_changed");
          privateEnv = this.consumeRunLaunch(descriptor, auth, stored.containerId, terminalId);
          if (privateEnv?.MANIFOLD_RUN_ID !== stored.runId)
            throw new Error("run_launch_unavailable");
          this.jobs.refreshTerminalDemand(
            descriptor,
            machine.machineId,
            {
              terminalId,
              terminalHostId: machine.terminalHostId,
              containerId: stored.containerId,
              runId: stored.runId,
            },
            pending.fence,
          );
        }
        if (descriptor === undefined) throw new Error("terminal_runtime_required");
        runtime = this.jobs.admitTerminal(
          auth,
          descriptor,
          machine.machineId,
          {
            terminalId,
            terminalHostId: machine.terminalHostId,
            containerId: stored.containerId,
            ...(stored.runId === undefined ? {} : { runId: stored.runId }),
          },
          traceId,
          privateEnv,
          pending.fence,
        );
        pending.jobId = runtime.request.jobId;
      }
      pending.fence.checkCurrent();
      const grant = runtime
        ? null
        : this.auth.mintTerminalLifecycleToken(
            terminalId,
            stored.containerId,
            principalId,
            auth?.tokenId,
          );
      pending.agentPrincipalId = grant?.principal.id ?? null;
      pending.fence.checkCurrent();
      pending.ordinary = runtime === undefined;
      pending.dispatched = true;
      // A relative launch cwd belongs in the restart recipe. Only an observed absolute cwd
      // may occupy the precedence field older agents already parse as MachinePathSchema.
      const restartCwd =
        terminal.info.cwd !== undefined && MachinePathSchema.safeParse(terminal.info.cwd).success
          ? terminal.info.cwd
          : undefined;
      const sent = machine.send({
        type: "terminal_restart",
        terminalId,
        ...(recipe === undefined && stored.runId === undefined ? { noRecipe: true } : {}),
        ...(restartCwd === undefined ? {} : { cwd: restartCwd }),
        create: {
          cols: terminal.info.cols,
          rows: terminal.info.rows,
          ...(recipe?.cwd === undefined ? {} : { cwd: recipe.cwd }),
          env: runtime
            ? {}
            : {
                ...recipe?.env,
                MANIFOLD_URL: this.publicUrl(),
                MANIFOLD_CONTAINER: stored.containerId,
                ...(recipe?.elementId === undefined ? {} : { MANIFOLD_ELEMENT: recipe.elementId }),
                MANIFOLD_TOKEN: grant!.token,
              },
          ...(recipe?.program === undefined ? {} : { program: recipe.program }),
          ...(runtime === undefined ? {} : { runtime }),
        },
      });
      if (!sent) this.finishRestart(terminalId, "machine_unavailable");
    };
    void prepare().catch((error: unknown) => {
      if (this.pendingRestarts.get(terminalId) === pending)
        this.finishRestart(
          terminalId,
          error instanceof Error ? error.message : "terminal_runtime_admission_refused",
        );
    });
    return completion.promise;
  }

  private finishRestart(terminalId: string, outcome: string): void {
    const pending = this.pendingRestarts.get(terminalId);
    if (pending === undefined) return;
    this.pendingRestarts.delete(terminalId);
    pending.cancelDeadline?.();
    pending.fence.close();
    if (outcome !== "ok") {
      this.retireRestartRunLaunch(pending);
      if (pending.agentPrincipalId !== null)
        this.auth.revokeIssuedPrincipal(pending.agentPrincipalId, pending.principalId);
      if (pending.jobId !== null) this.jobs?.cancelTerminal(terminalId, pending.jobId);
    }
    pending.resolve(outcome);
  }

  private failPendingRestarts(machineId: string, reason: string): void {
    for (const [terminalId, pending] of this.pendingRestarts)
      if (pending.machineId === machineId) this.finishRestart(terminalId, reason);
  }

  onRestartError(machineId: string, terminalId: string, reason: string): void {
    const pending = this.pendingRestarts.get(terminalId);
    if (pending?.machineId !== machineId || !pending.dispatched) return;
    this.finishRestart(terminalId, reason);
  }

  onCwd(machineId: string, terminalId: string, cwd: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.info.machineId !== machineId || terminal.info.cwd === cwd) return;
    terminal.info = { ...terminal.info, cwd };
    this.store.updateTerminalCwd(terminalId, cwd);
    this.rooms.live(terminal.info.containerId)?.broadcast({
      type: "terminal_event",
      terminalId,
      kind: "cwd",
      cwd,
    });
    this.announce(terminal.info.containerId, "terminal_cwd", null, { terminalId, cwd });
  }

  onReady(machineId: string, terminalId: string, readiness: TerminalReadiness): void {
    const terminal = this.terminals.get(terminalId);
    if (
      !terminal ||
      terminal.info.machineId !== machineId ||
      terminal.info.status !== "running" ||
      terminal.info.readiness !== null
    )
      return;
    terminal.info = { ...terminal.info, readiness };
    this.rooms.live(terminal.info.containerId)?.broadcast({
      type: "terminal_event",
      terminalId,
      kind: "ready",
      readiness,
    });
  }

  onRestarted(
    machineId: string,
    message: Extract<AgentMessage, { type: "terminal_restarted" }>,
  ): void {
    const terminal = this.terminals.get(message.terminalId);
    const pending = this.pendingRestarts.get(message.terminalId);
    if (
      !terminal ||
      terminal.info.machineId !== machineId ||
      pending?.machineId !== machineId ||
      !pending.dispatched
    )
      return;
    if (this.machines.get(machineId)?.terminalHostId !== pending.terminalHostId) {
      this.finishRestart(message.terminalId, "terminal owner changed");
      return;
    }
    // Drain closes new admission, not an ordinary PTY already accepted by this exact owner.
    // Continuing credential and implementation guards remain live after commit.
    if (pending.ordinary) pending.fence.commit();
    try {
      pending.fence.checkCurrent();
    } catch (error) {
      // The acknowledgement proves this is the newly restarted effect, not the incumbent.
      if (this.machines.get(machineId)?.terminalHostId === pending.terminalHostId)
        this.machines.get(machineId)?.send({ type: "kill", terminalId: message.terminalId });
      this.finishRestart(
        message.terminalId,
        error instanceof Error ? error.message : "terminal restart authority withdrawn",
      );
      return;
    }
    const stored = this.store.getTerminal(message.terminalId);
    if (stored?.agentPrincipalId && pending.agentPrincipalId !== null)
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, pending.principalId);
    this.store.markTerminalRunning(
      message.terminalId,
      pending.agentPrincipalId ?? stored?.agentPrincipalId ?? null,
    );
    if (message.cwd !== undefined) this.store.updateTerminalCwd(message.terminalId, message.cwd);
    this.clearViewportIntents(terminal);
    terminal.info = {
      ...terminal.info,
      status: "running",
      exitCode: null,
      exitReason: null,
      readiness: null,
      controllerId: pending.principalId,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
    };
    pending.fence.commit();
    terminal.lastReceivedOutputSeq = 0;
    terminal.lastReceivedGeometryRevision = -1;
    terminal.lastRequestedGrid = null;
    terminal.snapshotRequestOutstanding = false;
    for (const [channel, viewer] of this.viewersOf(terminal)) {
      // A restart is a new byte stream: the old incarnation and its credit end with the old
      // process, so no late acknowledgement of it can credit the new one.
      viewer.delivery = null;
      viewer.skipped = false;
      this.recoverViewer(terminal, channel, viewer, false);
    }
    const event = {
      type: "terminal_event" as const,
      terminalId: message.terminalId,
      kind: "restarted" as const,
      controllerId: pending.principalId,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      ...(message.fallback === undefined ? {} : { fallback: message.fallback }),
    };
    this.rooms.live(terminal.info.containerId)?.broadcast(event);
    this.announce(terminal.info.containerId, "terminal_restarted", pending.principalId, {
      terminalId: message.terminalId,
      machineId,
      ...(message.cwd === undefined ? {} : { cwd: message.cwd }),
      ...(message.fallback === undefined ? {} : { fallback: message.fallback }),
    });
    this.finishRestart(message.terminalId, "ok");
    this.requestSnapshotForPending(terminal);
    this.arbitrateViewports(terminal);
  }

  /**
   * The shared removal path. Containers are `placement.ts`'s business and a
   * home IS a container, so the removal is authored there: pulling the terminal's leaves is
   * what empties its home, and an emptied home takes every portal onto it along. The PTY and
   * the row come back through `reapTerminal`, so the two halves cannot drift apart.
   */
  private destroyTerminal(terminalId: string, reason: "killed" | "exited" = "killed"): void {
    if (this.placement !== null) {
      this.placement.killTerminal(terminalId, reason);
      return;
    }
    // Only reachable before startup wiring completes. A kill must still not leave the
    // terminal behind, even if its home outlives it by a moment.
    this.reapTerminal(terminalId, reason);
  }

  /**
   * Asks a machine to stop a PTY. Best effort by design: every kill deletes the terminal
   * row, so a PTY that outlives the request is killed by hello reconciliation the moment its
   * machine reconnects and finds no row for it.
   */
  private sendPtyStop(terminal: RuntimeTerminal): void {
    this.machines
      .get(terminal.info.machineId)
      ?.send({ type: "kill", terminalId: terminal.info.id });
  }

  /**
   * Error and unknown exits retain their placement; clean exits keep canonical removal. An
   * exit the owner caused is never a clean completion, whatever its code: it is retained with
   * its reason. Nested processes produce no such frame while the root remains alive.
   */
  onExited(
    machineId: string,
    terminalId: string,
    exitCode: number | null,
    exitReason: TerminalExitReason | null = null,
  ): void {
    if (exitCode === 0 && exitReason === null) {
      const terminal = this.terminals.get(terminalId);
      if (!terminal || terminal.info.machineId !== machineId || terminal.info.status === "exited")
        return;
      terminal.info = { ...terminal.info, status: "exited", exitCode, controllerId: null };
      // Home-scoped clients need the outcome before removal makes the terminal unavailable.
      this.rooms.live(terminal.info.containerId)?.broadcast({
        type: "terminal_event",
        terminalId,
        kind: "exited",
        exitCode,
      });
      this.destroyTerminal(terminalId, "exited");
      this.announce(terminal.info.containerId, "terminal_exited", terminal.info.createdBy, {
        terminalId,
        machineId,
        exitCode,
      });
      return;
    }
    this.retainExited(machineId, terminalId, exitCode, exitReason);
  }

  /** An admitted owner's inventory lost a PTY without observing its exit. Retain evidence. */
  private onMissing(machineId: string, terminalId: string): void {
    this.retainExited(machineId, terminalId, null, null);
  }

  private retainExited(
    machineId: string,
    terminalId: string,
    exitCode: number | null,
    exitReason: TerminalExitReason | null,
  ): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined || terminal.info.machineId !== machineId) return;
    if (terminal.info.status === "exited") return;
    this.clearViewers(terminal);
    terminal.info = {
      ...terminal.info,
      status: "exited",
      exitCode,
      exitReason,
      controllerId: null,
    };
    this.arbitrateViewports(terminal);
    this.store.markTerminalExited(terminalId, exitCode, exitReason);
    // The exit is announced in the terminal's HOME, the room every viewer of it is joined
    // to. Missing-owner evidence stays visible until somebody deliberately dismisses it.
    const containerId = terminal.info.containerId;
    this.rooms.live(containerId)?.broadcast({
      type: "terminal_event",
      terminalId,
      kind: "exited",
      exitCode,
      ...(exitReason === null ? {} : { exitReason }),
    });
    const stored = this.store.getTerminal(terminalId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, terminal.info.createdBy);
    }
    this.announce(containerId, "terminal_exited", terminal.info.createdBy, {
      terminalId,
      machineId,
      exitCode,
      ...(exitReason === null ? {} : { exitReason }),
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
    this.clearViewers(terminal);
    this.arbitrateViewports(terminal);
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
   * `TerminalPlacementPort`: the terminal half of removal — a running PTY is asked to
   * stop and the row is forgotten. Closing its tile, killing it by id, clean root PTY
   * exit and deleting the composition it lived in all use this sweep.
   *
   * No exit is persisted on the way out. The row is being deleted, so an exit record would
   * exist for the length of one statement and, worse, would broadcast an `exited` event for
   * a terminal the operator asked to be RID of — the one thing the killed half of the
   * lifecycle predicate promises never to show. What the home hears instead is `parked`,
   * which already means exactly "this terminal left THIS room" and is what makes every
   * viewer's terminal listing drop the row at once instead of at its next resync.
   */
  reapTerminal(terminalId: string, reason: "killed" | "exited" = "killed"): void {
    const pending = this.pendingOpens.get(terminalId);
    if (pending !== undefined) {
      pending.cancelDeadline?.();
      this.pendingOpens.delete(terminalId);
      if (pending.sent) this.machines.get(pending.machineId)?.send({ type: "kill", terminalId });
      this.abandonOpen(pending);
      this.answerOpen(
        pending.opener,
        pending.resolve,
        "conflict",
        "terminal creation cancelled",
        pending.ref,
      );
      return;
    }
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return;
    this.finishRestart(terminalId, "not_found");
    if (terminal.info.status === "running") this.sendPtyStop(terminal);
    this.clearViewers(terminal);
    this.terminals.delete(terminalId);
    this.rooms
      .live(terminal.info.containerId)
      ?.broadcast({ type: "terminal_event", terminalId, kind: "parked" });
    // The injected agent token dies with the terminal, regardless of exit status.
    const stored = this.store.getTerminal(terminalId);
    if (stored !== null && stored.agentPrincipalId !== null) {
      this.auth.revokeIssuedPrincipal(stored.agentPrincipalId, terminal.info.createdBy);
    }
    this.store.deleteTerminal(terminalId);
    // Natural exit is announced after placement retires the empty home (which clears its
    // history). Do not also record a kill for that same root-process outcome.
    if (reason === "killed") {
      this.announce(terminal.info.containerId, "terminal_killed", terminal.info.createdBy, {
        terminalId,
        machineId: terminal.info.machineId,
      });
    }
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
      this.clearViewers(terminal);
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
      this.abandonOpen(pending);
      this.answerOpen(
        pending.opener,
        pending.resolve,
        "not_found",
        "container deleted while opening terminal",
        pending.ref,
      );
      this.pendingOpens.delete(terminalId);
    }
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.info.containerId !== containerId) continue;
      this.finishRestart(terminalId, "not_found");
      if (terminal.info.status === "running") {
        this.machines
          .get(terminal.info.machineId)
          ?.send({ type: "kill", terminalId: terminal.info.id });
      }
      this.clearViewers(terminal);
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
