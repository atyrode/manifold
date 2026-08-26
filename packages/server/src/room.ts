import {
  PROTOCOL_VERSION,
  TerminalCustomDataSchema,
  applyAccepted,
  compareElements,
  reconcile,
  type ClientMessage,
  type PresencePayload,
  type PresenceState,
  type RuntimeDeps,
  type PadPresence,
  type Principal,
  type SceneElement,
  type ServerMessage,
  type SessionInfo,
} from "@manifold/protocol";
import type { Logger } from "./log.ts";
import {
  SESSION_TRANSPORT_PAYLOAD_BYTES,
  serializeServerMessage,
  type SessionPeer,
} from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";

const QUIET_SAVE_MS = 1_500;
const MAX_SAVE_MS = 10_000;

/**
 * Leaves 4 MiB of the WebSocket transport ceiling for the init envelope, roster, and
 * sessions while allowing canonical scenes substantially larger than the client frame cap.
 */
export const SCENE_BYTES_LIMIT = 12 * 1_048_576;

type SceneUpdate = Extract<ClientMessage, { type: "scene_update" }>;
type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;

/** Timer seam whose returned cancellation closures avoid platform-specific handle types. */
export interface RoomTimers {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** Production wall-clock scheduler for room snapshot debounce. */
export const defaultRoomTimers: RoomTimers = {
  schedule(callback, delayMs): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** Canonical in-memory scene and ephemeral membership for one persisted pad. */
export class Room {
  readonly scene = new Map<string, SceneElement>();
  readonly epoch: string;
  rev: number;

  private readonly connections = new Map<string, Set<SessionPeer>>();
  private readonly presences = new Map<string, PresencePayload>();
  private dirty = false;
  private cancelQuiet: (() => void) | null = null;
  private cancelMax: (() => void) | null = null;
  private readonly elementBytes = new Map<string, number>();
  private sceneBytes = 2;

  constructor(
    readonly padId: string,
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly sessions: () => readonly SessionInfo[],
    private readonly onEmpty: (room: Room) => void,
  ) {
    const snapshot = store.latestSnapshot(padId, (error, invalid) => {
      logger.error("snapshot_load_skipped", {
        padId,
        epoch: invalid.epoch,
        rev: invalid.rev,
        error: error.message,
      });
    });
    this.epoch = snapshot?.epoch ?? runtime.newId();
    this.rev = snapshot?.rev ?? 0;
    if (snapshot !== null) {
      for (const element of snapshot.elements) {
        this.scene.set(element.id, element);
        const bytes = Buffer.byteLength(JSON.stringify(element));
        this.elementBytes.set(element.id, bytes);
        this.sceneBytes += bytes + (this.scene.size === 1 ? 0 : 1);
      }
    }
  }

  private roster(): PresenceState[] {
    const result: PresenceState[] = [];
    for (const [principalId, peers] of this.connections) {
      const first = peers.values().next().value;
      if (first === undefined) continue;
      result.push({
        principal: first.auth.principal,
        connections: peers.size,
        payload: this.presences.get(principalId) ?? {},
      });
    }
    return result.sort((left, right) => left.principal.id.localeCompare(right.principal.id));
  }

  private stateMessage(type: "init" | "resync", peer: SessionPeer): ServerMessage {
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      epoch: this.epoch,
      rev: this.rev,
      elements: [...this.scene.values()].sort(compareElements),
      self: peer.auth.principal,
      selfCaps: [...peer.auth.caps],
      selfConnId: peer.id,
      roster: this.roster(),
      sessions: [...this.sessions()],
    };
  }

  private sendState(type: "init" | "resync", peer: SessionPeer): boolean {
    const frame = serializeServerMessage(this.stateMessage(type, peer));
    if (frame.bytes > SESSION_TRANSPORT_PAYLOAD_BYTES) {
      this.logger.error("scene_state_exceeds_transport", {
        padId: this.padId,
        type,
        bytes: frame.bytes,
        limit: SESSION_TRANSPORT_PAYLOAD_BYTES,
      });
      peer.send({
        type: "error",
        code: "invalid",
        message: "scene too large to initialize",
      });
      peer.close(1009, "initial state exceeds transport limit");
      return false;
    }
    return peer.sendSerialized(frame);
  }

  /** Registers a tab, sends init first, then publishes principal-level roster deltas. */
  join(peer: SessionPeer): boolean {
    const principalId = peer.auth.principal.id;
    let peers = this.connections.get(principalId);
    const firstConnection = peers === undefined;
    if (peers === undefined) {
      peers = new Set();
      this.connections.set(principalId, peers);
      this.presences.set(principalId, {});
    }
    peers.add(peer);
    if (!this.sendState("init", peer)) {
      peers.delete(peer);
      if (peers.size === 0) {
        this.connections.delete(principalId);
        this.presences.delete(principalId);
      }
      return false;
    }
    const joined: PresenceState = {
      principal: peer.auth.principal,
      connections: peers.size,
      payload: this.presences.get(principalId) ?? {},
    };
    this.broadcast({ type: "roster", joined }, false, peer);
    if (firstConnection) {
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_joined", {});
    }
    return true;
  }

  /** Removes a tab and expires principal presence only after its final connection leaves. */
  leave(peer: SessionPeer): void {
    const principalId = peer.auth.principal.id;
    const peers = this.connections.get(principalId);
    if (peers === undefined || !peers.delete(peer)) return;
    if (peers.size === 0) {
      this.connections.delete(principalId);
      this.presences.delete(principalId);
      this.broadcast({ type: "roster", left: { principalId } });
      this.store.addEvent(this.padId, this.runtime.now(), principalId, "principal_left", {});
      if (this.connections.size === 0) this.onEmpty(this);
      return;
    }
    const first = peers.values().next().value;
    if (first !== undefined) {
      this.broadcast({
        type: "roster",
        joined: {
          principal: first.auth.principal,
          connections: peers.size,
          payload: this.presences.get(principalId) ?? {},
        },
      });
    }
  }

  /** Emits a full state replacement to one connection. */
  sendResync(peer: SessionPeer): void {
    this.sendState("resync", peer);
  }

  /** Applies epoch-fenced reconciliation, increments rev only for winners, and acks once. */
  applyUpdate(peer: SessionPeer, update: SceneUpdate): boolean {
    if (update.epoch !== this.epoch) {
      peer.send({
        type: "error",
        code: "epoch_mismatch",
        message: "scene epoch changed",
        ref: update.updateId,
      });
      return false;
    }

    const result = reconcile(this.scene, update.elements);
    const acceptedBytes = new Map<string, number>();
    let candidateBytes = this.sceneBytes;
    let candidateCount = this.scene.size;
    for (const element of result.accepted) {
      const bytes = Buffer.byteLength(JSON.stringify(element));
      acceptedBytes.set(element.id, bytes);
      const previous = this.elementBytes.get(element.id);
      if (previous === undefined) {
        candidateBytes += bytes + (candidateCount === 0 ? 0 : 1);
        candidateCount += 1;
      } else {
        candidateBytes += bytes - previous;
      }
    }
    if (candidateBytes > SCENE_BYTES_LIMIT) {
      this.logger.warn("scene_update_rejected_size", {
        padId: this.padId,
        bytes: candidateBytes,
        limit: SCENE_BYTES_LIMIT,
      });
      peer.send({
        type: "error",
        code: "invalid",
        message: "scene too large",
        ref: update.updateId,
      });
      peer.send({
        type: "scene_ack",
        updateId: update.updateId,
        rev: this.rev,
        acceptedIds: [],
      });
      return true;
    }

    if (result.accepted.length > 0) {
      applyAccepted(this.scene, result.accepted);
      for (const [id, bytes] of acceptedBytes) this.elementBytes.set(id, bytes);
      this.sceneBytes = candidateBytes;
      this.rev += 1;
      this.broadcast({
        type: "scene_applied",
        rev: this.rev,
        elements: result.accepted,
        by: peer.auth.principal.id,
      });
      this.scheduleSnapshot();
    }
    peer.send({
      type: "scene_ack",
      updateId: update.updateId,
      rev: this.rev,
      acceptedIds: result.accepted.map((element) => element.id),
    });
    return true;
  }

  /** Merges ephemeral presence while stamping the authenticated principal id. */
  updatePresence(peer: SessionPeer, payload: PresencePayload): void {
    const principalId = peer.auth.principal.id;
    const current = this.presences.get(principalId) ?? {};
    this.presences.set(principalId, { ...current, ...payload });
    this.broadcast({ type: "presence", principalId, connId: peer.id, payload });
  }

  /** Relays high-rate cursor motion with droppable delivery under socket pressure. */
  relayCursor(peer: SessionPeer, cursor: CursorUpdate): void {
    this.broadcast(
      {
        type: "cursor",
        principalId: peer.auth.principal.id,
        connId: peer.id,
        x: cursor.x,
        y: cursor.y,
        ...(cursor.tool === undefined ? {} : { tool: cursor.tool }),
      },
      true,
    );
  }

  /** Broadcasts one schema serialization to all current room members. */
  broadcast(message: ServerMessage, droppable = false, except?: SessionPeer): void {
    const frame = serializeServerMessage(message);
    for (const peers of this.connections.values()) {
      for (const peer of peers) {
        if (peer !== except) peer.sendSerialized(frame, droppable);
      }
    }
  }

  private scheduleSnapshot(): void {
    this.dirty = true;
    this.cancelQuiet?.();
    this.cancelQuiet = this.timers.schedule(() => {
      this.cancelQuiet = null;
      this.flushFromTimer("quiet");
    }, QUIET_SAVE_MS);
    if (this.cancelMax === null) {
      this.cancelMax = this.timers.schedule(() => {
        this.cancelMax = null;
        this.flushFromTimer("maximum");
      }, MAX_SAVE_MS);
    }
  }

  private flushFromTimer(cadence: "quiet" | "maximum"): void {
    try {
      this.flushSnapshot();
    } catch (error) {
      this.logger.error("snapshot_save_failed", {
        padId: this.padId,
        cadence,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      if (this.dirty) this.scheduleSnapshot();
    }
  }

  /** Persists dirty canonical state immediately and emits the durable revision watermark. */
  flushSnapshot(): boolean {
    if (!this.dirty) return false;
    const at = this.runtime.now();
    this.store.saveSnapshot(
      this.padId,
      this.epoch,
      this.rev,
      at,
      [...this.scene.values()].sort(compareElements),
    );
    this.dirty = false;
    this.cancelQuiet?.();
    this.cancelMax?.();
    this.cancelQuiet = null;
    this.cancelMax = null;
    this.broadcast({ type: "saved", rev: this.rev, at });
    return true;
  }

  /** Cancels persistence callbacks when the room can no longer safely touch its store. */
  cancelSnapshotTimers(): void {
    this.cancelQuiet?.();
    this.cancelMax?.();
    this.cancelQuiet = null;
    this.cancelMax = null;
  }

  /** Closes every member when a pad is deleted or the process shuts down. */
  closeAll(code: number, reason: string): void {
    this.cancelSnapshotTimers();
    for (const peers of this.connections.values()) {
      for (const peer of peers) peer.close(code, reason);
    }
    this.connections.clear();
    this.presences.clear();
  }

  /** Whether this room still has any joined sockets. */
  hasConnections(): boolean {
    return this.connections.size > 0;
  }

  /** Whether a live, non-deleted terminal element still points at a persisted session. */
  referencesSession(sessionId: string): boolean {
    for (const element of this.scene.values()) {
      if (element.isDeleted) continue;
      const parsed = TerminalCustomDataSchema.safeParse(element.customData);
      if (parsed.success && parsed.data.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Returns the principal-level live roster without cursor or viewport payloads. */
  livePrincipals(): Principal[] {
    const principals: Principal[] = [];
    for (const peers of this.connections.values()) {
      const first = peers.values().next().value;
      if (first !== undefined) principals.push(first.auth.principal);
    }
    return principals.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Safe live-room summary for root introspection; no presence payloads or secrets. */
  introspect(): Record<string, unknown> {
    let connectionCount = 0;
    for (const peers of this.connections.values()) connectionCount += peers.size;
    return {
      padId: this.padId,
      epoch: this.epoch,
      rev: this.rev,
      elements: this.scene.size,
      principals: this.connections.size,
      connections: connectionCount,
    };
  }
}

/** Lazily loads rooms and coordinates snapshot flush/delete across all active pads. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private sessionProvider: (padId: string) => readonly SessionInfo[] = () => [];
  private pendingOpenProvider: (padId: string) => boolean = () => false;

  constructor(
    private readonly store: ServerStore,
    private readonly runtime: RuntimeDeps,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
  ) {}

  /** Installs the broker's per-pad session view after circular startup wiring completes. */
  setSessionProvider(provider: (padId: string) => readonly SessionInfo[]): void {
    this.sessionProvider = provider;
  }

  /** Installs the broker's in-flight create view for residency decisions. */
  setPendingOpenProvider(provider: (padId: string) => boolean): void {
    this.pendingOpenProvider = provider;
  }

  /** Returns a canonical room only when its durable pad exists. */
  get(padId: string): Room | null {
    if (this.store.getPad(padId) === null) return null;
    let room = this.rooms.get(padId);
    if (room === undefined) {
      room = new Room(
        padId,
        this.store,
        this.runtime,
        this.timers,
        this.logger,
        () => {
          return this.sessionProvider(padId);
        },
        (idleRoom) => {
          this.evict(idleRoom);
        },
      );
      this.rooms.set(padId, room);
    }
    return room;
  }

  /** Returns only an already materialized room; broker events must never load one. */
  live(padId: string): Room | null {
    return this.rooms.get(padId) ?? null;
  }

  /** Summarizes presence from already-live rooms without materializing idle pads. */
  presence(): PadPresence[] {
    const pads: PadPresence[] = [];
    for (const room of this.rooms.values()) {
      const principals = room.livePrincipals();
      if (principals.length > 0) pads.push({ padId: room.padId, principals });
    }
    return pads.sort((left, right) => left.padId.localeCompare(right.padId));
  }

  /** Rechecks an idle resident after its last running terminal exits. */
  evictIfIdle(padId: string): boolean {
    const room = this.rooms.get(padId);
    if (room === undefined) return false;
    return this.evict(room);
  }

  private evict(room: Room): boolean {
    if (this.rooms.get(room.padId) !== room || room.hasConnections()) return false;
    if (this.pendingOpenProvider(room.padId)) return false;
    if (this.sessionProvider(room.padId).some((session) => session.status === "running")) {
      return false;
    }
    try {
      room.flushSnapshot();
    } catch (error) {
      this.logger.error("snapshot_final_flush_failed", {
        padId: room.padId,
        error: error instanceof Error ? error.message : "unknown failure",
      });
      return false;
    }
    this.rooms.delete(room.padId);
    return true;
  }

  /** Evicts and fences a deleted pad's live room. */
  drop(padId: string): void {
    const room = this.rooms.get(padId);
    if (room === undefined) return;
    room.closeAll(4404, "pad deleted");
    this.rooms.delete(padId);
  }

  /** Flushes every dirty scene for graceful shutdown. */
  flushAll(): void {
    for (const room of this.rooms.values()) {
      try {
        room.flushSnapshot();
      } catch (error) {
        this.logger.error("snapshot_shutdown_flush_failed", {
          padId: room.padId,
          error: error instanceof Error ? error.message : "unknown failure",
        });
        room.cancelSnapshotTimers();
      }
    }
  }

  /** Returns secret-free summaries of currently materialized rooms. */
  introspect(): Record<string, unknown>[] {
    return [...this.rooms.values()].map((room) => room.introspect());
  }
}
